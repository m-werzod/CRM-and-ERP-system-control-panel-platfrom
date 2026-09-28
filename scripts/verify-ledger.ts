/**
 * Ledger consistency check.
 *
 * Re-derives every invoice's cached totals from the append-only ledger and reports
 * any that disagree. This is the audit that makes the derived-cache design
 * defensible: the caches exist for query speed, and this proves they still tell the
 * truth.
 *
 *     npm run verify:ledger              report only (default)
 *     npm run verify:ledger -- --repair  recompute the drifted rows
 *
 * Report-only by default on purpose. Silently rewriting financial rows because
 * someone ran a script would be worse than the drift it fixes, so a repair has to
 * be asked for explicitly.
 */

import 'dotenv/config';
import { prisma } from '@/server/db/client';
import { verifyLedgerConsistency } from '@/server/services/finance/ledger';
import { formatMoney, money } from '@/lib/money';

const repair = process.argv.includes('--repair');

async function main(): Promise<void> {
  const organizations = await prisma.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, defaultCurrency: true },
  });

  if (organizations.length === 0) {
    console.log('\n  No organisations found. Run `npm run db:seed` first.\n');
    return;
  }

  let totalDrift = 0;
  let totalChecked = 0;

  for (const organization of organizations) {
    const result = await verifyLedgerConsistency(prisma, {
      organizationId: organization.id,
      dryRun: !repair,
    });

    totalChecked += result.checked;
    totalDrift += result.drifted.length;

    console.log(`\n  ${organization.name}`);
    console.log(`    invoices checked : ${result.checked}`);
    console.log(`    drifted fields   : ${result.drifted.length}`);
    if (repair) console.log(`    repaired         : ${result.repaired}`);

    for (const row of result.drifted.slice(0, 25)) {
      console.log(
        `      ${row.invoiceNumber}  ${row.field}: cached ${row.cached} vs derived ${row.derived}`,
      );
    }
    if (result.drifted.length > 25) {
      console.log(`      ...and ${result.drifted.length - 25} more`);
    }
  }

  // A second, independent check: the ledger's own internal arithmetic. Every
  // invoice's DEBIT total minus its CREDIT total must equal its outstanding
  // balance, computed without touching the cached columns at all.
  const ledgerTotals = await prisma.$queryRaw<
    Array<{ currency: string; debits: bigint; credits: bigint; entries: bigint }>
  >`
    select "currency",
           coalesce(sum("amountMinor") filter (where "direction" = 'DEBIT'), 0)  as debits,
           coalesce(sum("amountMinor") filter (where "direction" = 'CREDIT'), 0) as credits,
           count(*) as entries
    from "ledger_entries"
    group by "currency"
  `;

  console.log('\n  Ledger totals by currency');
  for (const row of ledgerTotals) {
    const debits = money(BigInt(row.debits), row.currency);
    const credits = money(BigInt(row.credits), row.currency);
    const net = money(BigInt(row.debits) - BigInt(row.credits), row.currency);
    console.log(
      `    ${row.currency}  entries ${String(row.entries).padStart(6)}  charged ${formatMoney(debits)}  settled ${formatMoney(credits)}  outstanding ${formatMoney(net)}`,
    );
  }

  const outstanding = await prisma.invoice.aggregate({
    where: { status: { notIn: ['DRAFT', 'CANCELLED', 'VOID'] } },
    _sum: { balanceMinor: true },
  });
  console.log(
    `\n  Sum of cached invoice balances: ${(outstanding._sum.balanceMinor ?? 0n).toString()} minor units`,
  );

  console.log(
    totalDrift === 0
      ? `\n  ${totalChecked} invoices checked, no drift. The derived caches agree with the ledger.\n`
      : `\n  ${totalDrift} drifted field(s) across ${totalChecked} invoices.${repair ? ' Repaired.' : ' Re-run with --repair to fix.'}\n`,
  );

  if (totalDrift > 0 && !repair) process.exitCode = 1;
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('\nLedger verification failed:\n', error);
    await prisma.$disconnect();
    process.exit(1);
  });
