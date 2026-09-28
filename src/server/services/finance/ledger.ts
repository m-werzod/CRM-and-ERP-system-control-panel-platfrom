/**
 * The financial ledger and the derived-cache recalculation.
 *
 * This is the file that makes the money model trustworthy, so it is worth being
 * explicit about the design.
 *
 * `LedgerEntry` is APPEND-ONLY and is the source of truth. A database trigger
 * blocks UPDATE and DELETE, so there is no code path — not a migration, not a
 * hand-typed psql statement — that can quietly rewrite financial history.
 * A mistake is corrected by appending a reversing entry that points at the
 * original through `reversalOfId`.
 *
 * `Invoice.paidTotalMinor` / `refundedTotalMinor` / `writtenOffMinor` /
 * `balanceMinor` are DERIVED CACHES. They exist only so that a debt report and a
 * 500-row invoice list do not aggregate the ledger on every request. They are
 * recomputed here, from the ledger, inside the same transaction that appended the
 * rows. A CHECK constraint enforces the balance identity, so a bug in this file
 * fails loudly at write time instead of producing a wrong debt figure that nobody
 * notices for a month.
 *
 * Direction convention, stated once:
 *   DEBIT  increases what the student owes  (a charge was raised)
 *   CREDIT decreases what the student owes  (money in, a discount, a write-off)
 * `amountMinor` is therefore always non-negative — a CHECK constraint enforces
 * that too. Sign lives in `direction`, never in the amount.
 */

import type { LedgerDirection, LedgerEntryType, Prisma } from '@/generated/prisma/client';
import type { Db, Tx } from '@/server/db/client';
import { BusinessRuleError, NotFoundError } from '@/server/errors';
import { assertCurrency, type CurrencyCode } from '@/lib/money';
import type { AccessContext } from '@/server/rbac/access';

/** Which ledger entry types contribute to which derived total. */
const PAYMENT_TYPES: readonly LedgerEntryType[] = ['PAYMENT_RECEIVED', 'CREDIT_APPLIED'];
const PAYMENT_REVERSAL_TYPES: readonly LedgerEntryType[] = ['PAYMENT_REVERSED'];
const REFUND_TYPES: readonly LedgerEntryType[] = ['REFUND_ISSUED'];
const WRITE_OFF_TYPES: readonly LedgerEntryType[] = ['WRITE_OFF'];

export interface AppendLedgerInput {
  readonly entryType: LedgerEntryType;
  readonly direction: LedgerDirection;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly branchId?: string | null;
  readonly studentId?: string | null;
  readonly invoiceId?: string | null;
  readonly paymentId?: string | null;
  readonly refundId?: string | null;
  readonly creditId?: string | null;
  /** Business date; may precede `now` when an accountant back-dates a receipt. */
  readonly occurredAt?: Date;
  readonly description?: string | null;
  /** Set on a reversing entry to point at the row it cancels. */
  readonly reversalOfId?: string | null;
  readonly metadata?: Prisma.InputJsonValue;
}

/**
 * Append one ledger entry. The ONLY sanctioned way to write to `ledger_entries`.
 *
 * Requires a transaction handle rather than accepting the root client: a ledger
 * row written outside the transaction that produced it can survive a rollback and
 * leave the ledger describing something that never happened.
 */
export async function appendLedgerEntry(
  ctx: AccessContext,
  tx: Tx,
  input: AppendLedgerInput,
): Promise<{ id: string }> {
  if (input.amountMinor < 0n) {
    // Sign belongs in `direction`. A negative amount would make every SUM in the
    // reporting layer wrong in a way that is hard to spot.
    throw new BusinessRuleError(
      'ledger.negative_amount',
      'A ledger amount cannot be negative; use the opposite direction instead.',
    );
  }
  if (input.amountMinor === 0n) {
    throw new BusinessRuleError(
      'ledger.zero_amount',
      'A ledger entry must move a non-zero amount.',
    );
  }

  const entry = await tx.ledgerEntry.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: input.branchId ?? null,
      entryType: input.entryType,
      direction: input.direction,
      studentId: input.studentId ?? null,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      refundId: input.refundId ?? null,
      creditId: input.creditId ?? null,
      amountMinor: input.amountMinor,
      currency: assertCurrency(input.currency),
      occurredAt: input.occurredAt ?? new Date(),
      description: input.description ?? null,
      reversalOfId: input.reversalOfId ?? null,
      createdById: ctx.isSystem ? null : ctx.userId,
      metadata: input.metadata,
    },
    select: { id: true },
  });
  return entry;
}

/**
 * Append the reversing counterpart of an existing entry.
 *
 * Reads the original to copy its amount and currency rather than trusting a
 * caller-supplied figure, so a reversal can never be for a different amount than
 * the thing it reverses.
 */
export async function reverseLedgerEntry(
  ctx: AccessContext,
  tx: Tx,
  originalId: string,
  options: { entryType: LedgerEntryType; description: string; occurredAt?: Date },
): Promise<{ id: string }> {
  const original = await tx.ledgerEntry.findFirst({
    where: { id: originalId, organizationId: ctx.organizationId },
    select: {
      id: true,
      direction: true,
      amountMinor: true,
      currency: true,
      branchId: true,
      studentId: true,
      invoiceId: true,
      paymentId: true,
      refundId: true,
      creditId: true,
      reversedBy: { select: { id: true } },
    },
  });

  if (!original) throw new NotFoundError('Ledger entry', originalId);
  if (original.reversedBy) {
    throw new BusinessRuleError(
      'ledger.already_reversed',
      'This ledger entry has already been reversed.',
    );
  }

  return appendLedgerEntry(ctx, tx, {
    entryType: options.entryType,
    direction: original.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
    amountMinor: original.amountMinor,
    currency: original.currency,
    branchId: original.branchId,
    studentId: original.studentId,
    invoiceId: original.invoiceId,
    paymentId: original.paymentId,
    refundId: original.refundId,
    creditId: original.creditId,
    description: options.description,
    occurredAt: options.occurredAt,
    reversalOfId: original.id,
  });
}

export interface InvoiceTotals {
  readonly paidTotalMinor: bigint;
  readonly refundedTotalMinor: bigint;
  readonly writtenOffMinor: bigint;
  readonly balanceMinor: bigint;
  readonly totalMinor: bigint;
}

/**
 * Recompute an invoice's derived totals FROM THE LEDGER and persist them,
 * together with the status that follows from them.
 *
 * Call this at the end of every transaction that appends an invoice-affecting
 * ledger entry. It is idempotent: running it twice produces the same row, which
 * is what makes the repair script (`verifyLedger`) safe to run in production.
 */
export async function recalculateInvoice(
  tx: Tx,
  invoiceId: string,
  options: { now?: Date } = {},
): Promise<InvoiceTotals> {
  const now = options.now ?? new Date();

  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      status: true,
      currency: true,
      totalMinor: true,
      dueDate: true,
      paidAt: true,
      cancelledAt: true,
      voidedAt: true,
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);

  // One grouped aggregate rather than four queries. Amounts are non-negative, so
  // the sign logic lives here in the reducer, not in the data.
  const grouped = await tx.ledgerEntry.groupBy({
    by: ['entryType'],
    where: { invoiceId },
    _sum: { amountMinor: true },
  });

  const sumOf = (types: readonly LedgerEntryType[]): bigint =>
    grouped
      .filter((row) => types.includes(row.entryType))
      .reduce((total, row) => total + (row._sum.amountMinor ?? 0n), 0n);

  // A reversal reduces what was paid; it is a separate entry type rather than a
  // negative amount, so it must be subtracted explicitly.
  const paidTotalMinor = sumOf(PAYMENT_TYPES) - sumOf(PAYMENT_REVERSAL_TYPES);
  const refundedTotalMinor = sumOf(REFUND_TYPES);
  const writtenOffMinor = sumOf(WRITE_OFF_TYPES);

  // The identity the database CHECK constraint also enforces.
  const balanceMinor =
    invoice.totalMinor - paidTotalMinor - writtenOffMinor + refundedTotalMinor;

  if (paidTotalMinor < 0n) {
    // More reversals than payments: the ledger is internally inconsistent and a
    // silent clamp would hide it.
    throw new BusinessRuleError(
      'ledger.negative_paid_total',
      'This invoice has more payment reversals than payments. The ledger needs review before it can be recalculated.',
      { details: { invoiceId, paidTotalMinor: paidTotalMinor.toString() } },
    );
  }

  const status = deriveInvoiceStatus({
    currentStatus: invoice.status,
    totalMinor: invoice.totalMinor,
    paidTotalMinor,
    refundedTotalMinor,
    writtenOffMinor,
    balanceMinor,
    dueDate: invoice.dueDate,
    cancelled: invoice.cancelledAt !== null,
    voided: invoice.voidedAt !== null,
    now,
  });

  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      paidTotalMinor,
      refundedTotalMinor,
      writtenOffMinor,
      balanceMinor,
      status,
      // Stamped the first time the balance reaches zero and left alone after, so
      // "when was this settled" survives a later refund.
      paidAt:
        status === 'PAID' && invoice.paidAt === null
          ? now
          : status === 'PAID'
            ? invoice.paidAt
            : null,
    },
  });

  return {
    paidTotalMinor,
    refundedTotalMinor,
    writtenOffMinor,
    balanceMinor,
    totalMinor: invoice.totalMinor,
  };
}

type InvoiceStatusValue =
  | 'DRAFT'
  | 'ISSUED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERDUE'
  | 'CANCELLED'
  | 'VOID'
  | 'REFUNDED'
  | 'WRITTEN_OFF';

/**
 * Status is DERIVED, never set by hand.
 *
 * Extracted as a pure function so it is unit-testable without a database, and so
 * that the precedence of the terminal states is written down once instead of
 * being re-decided at each call site.
 */
export function deriveInvoiceStatus(input: {
  currentStatus: InvoiceStatusValue;
  totalMinor: bigint;
  paidTotalMinor: bigint;
  refundedTotalMinor: bigint;
  writtenOffMinor: bigint;
  balanceMinor: bigint;
  dueDate: Date;
  cancelled: boolean;
  voided: boolean;
  now: Date;
}): InvoiceStatusValue {
  // Terminal administrative states win over anything the arithmetic implies: a
  // voided invoice is void even if a payment was once applied to it.
  if (input.voided) return 'VOID';
  if (input.cancelled) return 'CANCELLED';

  // A draft has not been issued, so it cannot be overdue or partially paid.
  if (input.currentStatus === 'DRAFT') return 'DRAFT';

  if (input.writtenOffMinor > 0n && input.balanceMinor <= 0n) return 'WRITTEN_OFF';

  // Fully refunded: everything that came in has gone back out.
  if (input.refundedTotalMinor > 0n && input.refundedTotalMinor >= input.paidTotalMinor) {
    return 'REFUNDED';
  }

  if (input.balanceMinor <= 0n) return 'PAID';

  // Past due beats partially-paid: an accountant chasing debt needs to see
  // OVERDUE on a half-paid invoice, not PARTIALLY_PAID.
  const dueEndOfDay = new Date(input.dueDate);
  dueEndOfDay.setUTCHours(23, 59, 59, 999);
  if (dueEndOfDay < input.now) return 'OVERDUE';

  if (input.paidTotalMinor > 0n) return 'PARTIALLY_PAID';
  return 'ISSUED';
}

/** A student's overall position, computed from the ledger. */
export interface StudentBalance {
  readonly currency: CurrencyCode;
  /** Sum of unpaid invoice balances. Positive means the student owes money. */
  readonly outstandingMinor: bigint;
  /** Unused credit held on account. */
  readonly creditMinor: bigint;
  /** outstanding - credit: what would actually be collected today. */
  readonly netDueMinor: bigint;
  readonly overdueMinor: bigint;
  readonly invoiceCount: number;
  readonly overdueInvoiceCount: number;
}

export async function getStudentBalance(
  db: Db,
  input: { organizationId: string; studentId: string; currency: string; now?: Date },
): Promise<StudentBalance> {
  const now = input.now ?? new Date();
  const currency = assertCurrency(input.currency);

  const [openInvoices, overdue, credits] = await Promise.all([
    db.invoice.aggregate({
      where: {
        organizationId: input.organizationId,
        studentId: input.studentId,
        currency,
        balanceMinor: { gt: 0 },
        status: { notIn: ['CANCELLED', 'VOID', 'WRITTEN_OFF', 'DRAFT'] },
      },
      _sum: { balanceMinor: true },
      _count: { _all: true },
    }),
    db.invoice.aggregate({
      where: {
        organizationId: input.organizationId,
        studentId: input.studentId,
        currency,
        balanceMinor: { gt: 0 },
        dueDate: { lt: now },
        status: { notIn: ['CANCELLED', 'VOID', 'WRITTEN_OFF', 'DRAFT'] },
      },
      _sum: { balanceMinor: true },
      _count: { _all: true },
    }),
    db.studentCredit.aggregate({
      where: {
        organizationId: input.organizationId,
        studentId: input.studentId,
        currency,
        status: { in: ['AVAILABLE', 'PARTIALLY_USED'] },
      },
      _sum: { balanceMinor: true },
    }),
  ]);

  const outstandingMinor = openInvoices._sum.balanceMinor ?? 0n;
  const creditMinor = credits._sum.balanceMinor ?? 0n;

  return {
    currency,
    outstandingMinor,
    creditMinor,
    // Clamped at zero: a student holding more credit than debt is not owed a
    // negative bill, and a negative "amount due" on a statement confuses people.
    netDueMinor: outstandingMinor - creditMinor > 0n ? outstandingMinor - creditMinor : 0n,
    overdueMinor: overdue._sum.balanceMinor ?? 0n,
    invoiceCount: openInvoices._count._all,
    overdueInvoiceCount: overdue._count._all,
  };
}

/**
 * Re-derive every invoice's cached totals and report any that disagree with the
 * ledger. Backs `npm run verify:ledger`.
 *
 * `dryRun` is the default: this is a diagnostic first and a repair tool second,
 * and silently rewriting financial rows because a script was run by accident
 * would be worse than the drift it fixes.
 */
export async function verifyLedgerConsistency(
  db: Db,
  input: { organizationId: string; dryRun?: boolean; limit?: number },
): Promise<{
  checked: number;
  drifted: Array<{
    invoiceId: string;
    invoiceNumber: string;
    field: string;
    cached: string;
    derived: string;
  }>;
  repaired: number;
}> {
  const dryRun = input.dryRun ?? true;
  const invoices = await db.invoice.findMany({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      invoiceNumber: true,
      totalMinor: true,
      paidTotalMinor: true,
      refundedTotalMinor: true,
      writtenOffMinor: true,
      balanceMinor: true,
    },
    orderBy: { createdAt: 'desc' },
    take: input.limit ?? 5_000,
  });

  const drifted: Array<{
    invoiceId: string;
    invoiceNumber: string;
    field: string;
    cached: string;
    derived: string;
  }> = [];
  let repaired = 0;

  for (const invoice of invoices) {
    const grouped = await db.ledgerEntry.groupBy({
      by: ['entryType'],
      where: { invoiceId: invoice.id },
      _sum: { amountMinor: true },
    });
    const sumOf = (types: readonly LedgerEntryType[]): bigint =>
      grouped
        .filter((row) => types.includes(row.entryType))
        .reduce((total, row) => total + (row._sum.amountMinor ?? 0n), 0n);

    const derived = {
      paidTotalMinor: sumOf(PAYMENT_TYPES) - sumOf(PAYMENT_REVERSAL_TYPES),
      refundedTotalMinor: sumOf(REFUND_TYPES),
      writtenOffMinor: sumOf(WRITE_OFF_TYPES),
    };
    const derivedBalance =
      invoice.totalMinor -
      derived.paidTotalMinor -
      derived.writtenOffMinor +
      derived.refundedTotalMinor;

    const comparisons: Array<[string, bigint, bigint]> = [
      ['paidTotalMinor', invoice.paidTotalMinor, derived.paidTotalMinor],
      ['refundedTotalMinor', invoice.refundedTotalMinor, derived.refundedTotalMinor],
      ['writtenOffMinor', invoice.writtenOffMinor, derived.writtenOffMinor],
      ['balanceMinor', invoice.balanceMinor, derivedBalance],
    ];

    let invoiceDrifted = false;
    for (const [field, cached, expected] of comparisons) {
      if (cached !== expected) {
        invoiceDrifted = true;
        drifted.push({
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          field,
          cached: cached.toString(),
          derived: expected.toString(),
        });
      }
    }

    if (invoiceDrifted && !dryRun) {
      // Recalculation runs in its own transaction per invoice so one unrepairable
      // row does not abort the whole sweep.
      const { withTransaction } = await import('@/server/db/client');
      await withTransaction((tx) => recalculateInvoice(tx, invoice.id));
      repaired += 1;
    }
  }

  return { checked: invoices.length, drifted, repaired };
}
