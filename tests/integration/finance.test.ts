import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createStudent,
  createWorld,
  ledgerSumFor,
  prisma,
  resetDatabase,
  uniqueSuffix,
  type WorldFixture,
} from '@tests/helpers/fixtures';
import {
  cancelInvoice,
  createInvoice,
  issueInvoice,
  writeOffInvoice,
} from '@/server/services/finance/invoices';
import { recordPayment, reversePayment } from '@/server/services/finance/payments';
import {
  approveRefund,
  processRefund,
  requestRefund,
} from '@/server/services/finance/refunds';
import { getStudentBalance, verifyLedgerConsistency } from '@/server/services/finance/ledger';
import { getDebtAgeingReport, listStudentsInDebt } from '@/server/services/finance/debts';
import { addDaysToDateOnly, todayIn } from '@/lib/dates';

/**
 * Finance integration tests against real PostgreSQL.
 *
 * These are the tests that matter most: they exercise the ledger, the derived
 * caches, the database CHECK constraints and the append-only triggers together.
 * A mocked Prisma client would pass all of them while the real database refused
 * the same writes.
 *
 * Covers specification FLOW 3 (create invoice -> receive payment -> verify
 * remaining balance) plus the reversal, refund, write-off and branch-isolation
 * paths.
 */

let world: WorldFixture;

beforeEach(async () => {
  await resetDatabase();
  world = await createWorld({ currency: 'USD' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TUITION = 10_000n; // $100.00

/**
 * Dates are derived from today rather than hard-coded, because a fixed 2026 date
 * silently flips an invoice from ISSUED to OVERDUE once the clock passes it —
 * a test that starts failing on a calendar boundary is worse than no test.
 */
const today = todayIn('Asia/Tashkent');
const FUTURE_DUE = addDaysToDateOnly(today, 30);
const PAST_ISSUE = addDaysToDateOnly(today, -60);
const PAST_DUE_21_DAYS = addDaysToDateOnly(today, -21);

async function issuedInvoice(
  overrides: {
    amountMinor?: bigint;
    dueDate?: string;
    issueDate?: string;
    studentId?: string;
  } = {},
) {
  const invoice = await createInvoice(world.admin.ctx, {
    studentId: overrides.studentId ?? world.student.studentId,
    items: [
      {
        description: 'Monthly tuition',
        kind: 'TUITION',
        quantity: 1,
        unitPriceMinor: overrides.amountMinor ?? TUITION,
      },
    ],
    issueDate: overrides.issueDate ?? PAST_ISSUE,
    dueDate: overrides.dueDate ?? PAST_DUE_21_DAYS,
    issueNow: true,
  });
  return invoice;
}

describe('FLOW 3 — invoice, payment, remaining balance', () => {
  it('reproduces the specification example: 100 charged, 10 discount, 50 paid, 40 remaining', async () => {
    const invoice = await createInvoice(world.admin.ctx, {
      studentId: world.student.studentId,
      items: [
        { description: 'Tuition', kind: 'TUITION', quantity: 1, unitPriceMinor: 10_000n },
      ],
      discounts: [{ label: 'Sibling discount', type: 'FIXED', amountMinor: 1_000n }],
      issueDate: today,
      // Not yet due, so the status reflects part-payment rather than lateness.
      dueDate: FUTURE_DUE,
      issueNow: true,
    });

    expect(invoice.totalMinor).toBe(9_000n);

    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 5_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]?.remainingBalanceMinor).toBe(4_000n);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: {
        subtotalMinor: true,
        discountTotalMinor: true,
        totalMinor: true,
        paidTotalMinor: true,
        balanceMinor: true,
        status: true,
      },
    });

    expect(stored).toMatchObject({
      subtotalMinor: 10_000n,
      discountTotalMinor: 1_000n,
      totalMinor: 9_000n,
      paidTotalMinor: 5_000n,
      balanceMinor: 4_000n,
      status: 'PARTIALLY_PAID',
    });
  });

  it('marks an invoice PAID and stamps paidAt when settled in full', async () => {
    const invoice = await issuedInvoice();
    await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CARD',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { status: true, balanceMinor: true, paidAt: true },
    });
    expect(stored.status).toBe('PAID');
    expect(stored.balanceMinor).toBe(0n);
    expect(stored.paidAt).toBeInstanceOf(Date);
  });

  it('a draft invoice raises no ledger entry until it is issued', async () => {
    const invoice = await createInvoice(world.admin.ctx, {
      studentId: world.student.studentId,
      items: [{ description: 'Tuition', kind: 'TUITION', quantity: 1, unitPriceMinor: TUITION }],
      issueDate: PAST_ISSUE,
      dueDate: PAST_DUE_21_DAYS,
    });

    expect(await ledgerSumFor(invoice.id)).toHaveLength(0);

    await issueInvoice(world.admin.ctx, invoice.id);

    const entries = await ledgerSumFor(invoice.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: 'INVOICE_ISSUED',
      direction: 'DEBIT',
      amountMinor: TUITION,
    });
  });

  it('allocates one payment across several invoices, oldest due first', async () => {
    const older = await issuedInvoice({ amountMinor: 3_000n, dueDate: addDaysToDateOnly(today, -40) });
    const newer = await issuedInvoice({ amountMinor: 4_000n, dueDate: addDaysToDateOnly(today, -10) });

    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 5_000n,
      method: 'BANK_TRANSFER',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    expect(payment.allocations.map((a) => a.invoiceId)).toEqual([older.id, newer.id]);
    expect(payment.allocations[0]?.amountMinor).toBe(3_000n);
    expect(payment.allocations[1]?.amountMinor).toBe(2_000n);

    const balances = await prisma.invoice.findMany({
      where: { id: { in: [older.id, newer.id] } },
      select: { id: true, balanceMinor: true, status: true },
    });
    expect(balances.find((i) => i.id === older.id)).toMatchObject({
      balanceMinor: 0n,
      status: 'PAID',
    });
    expect(balances.find((i) => i.id === newer.id)?.balanceMinor).toBe(2_000n);
  });

  it('honours an explicit invoice order when the payer nominates one', async () => {
    const older = await issuedInvoice({ amountMinor: 3_000n, dueDate: addDaysToDateOnly(today, -40) });
    const newer = await issuedInvoice({ amountMinor: 4_000n, dueDate: addDaysToDateOnly(today, -10) });

    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 4_000n,
      method: 'CASH',
      invoiceIds: [newer.id],
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]?.invoiceId).toBe(newer.id);

    const untouched = await prisma.invoice.findUniqueOrThrow({
      where: { id: older.id },
      select: { balanceMinor: true },
    });
    expect(untouched.balanceMinor).toBe(3_000n);
  });

  it('refuses to allocate to an invoice belonging to another student', async () => {
    const other = await createStudent({
      organizationId: world.organizationId,
      branchId: world.branchAId,
    });
    const theirInvoice = await issuedInvoice({ studentId: other.studentId });

    await expect(
      recordPayment(world.accountant.ctx, {
        studentId: world.student.studentId,
        amountMinor: 1_000n,
        method: 'CASH',
        invoiceIds: [theirInvoice.id],
        idempotencyKey: `pay-${uniqueSuffix()}`,
      }),
    ).rejects.toThrow(/does not belong to this student/i);
  });
});

describe('idempotency', () => {
  it('returns the original payment when the same key is replayed', async () => {
    await issuedInvoice();
    const key = `pay-${uniqueSuffix()}`;

    const first = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 4_000n,
      method: 'CASH',
      idempotencyKey: key,
    });
    const replay = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 4_000n,
      method: 'CASH',
      idempotencyKey: key,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.wasAlreadyRecorded).toBe(true);

    // The money must have moved exactly once.
    expect(await prisma.payment.count()).toBe(1);
    const invoice = await prisma.invoice.findFirstOrThrow({ select: { paidTotalMinor: true } });
    expect(invoice.paidTotalMinor).toBe(4_000n);
  });

  it('two concurrent submissions of the same key post the money once', async () => {
    await issuedInvoice();
    const key = `pay-${uniqueSuffix()}`;
    const submit = () =>
      recordPayment(world.accountant.ctx, {
        studentId: world.student.studentId,
        amountMinor: 2_500n,
        method: 'CASH',
        idempotencyKey: key,
      });

    // One may lose the race on the unique index and surface as a conflict; what
    // must never happen is two payments.
    await Promise.allSettled([submit(), submit()]);

    expect(await prisma.payment.count()).toBe(1);
    const invoice = await prisma.invoice.findFirstOrThrow({ select: { paidTotalMinor: true } });
    expect(invoice.paidTotalMinor).toBe(2_500n);
  });
});

describe('overpayment becomes credit', () => {
  it('holds the excess as student credit and lets a later invoice consume it', async () => {
    await issuedInvoice({ amountMinor: 3_000n });

    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 5_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    expect(payment.creditedMinor).toBe(2_000n);
    expect(payment.creditId).not.toBeNull();

    const credit = await prisma.studentCredit.findUniqueOrThrow({
      where: { id: payment.creditId! },
      select: { amountMinor: true, balanceMinor: true, status: true, source: true },
    });
    expect(credit).toMatchObject({
      amountMinor: 2_000n,
      balanceMinor: 2_000n,
      status: 'AVAILABLE',
      source: 'OVERPAYMENT',
    });

    // Now spend it on a new invoice.
    const next = await issuedInvoice({ amountMinor: 2_000n, dueDate: FUTURE_DUE });
    await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 2_000n,
      method: 'CREDIT_NOTE',
      fromCreditId: payment.creditId!,
      invoiceIds: [next.id],
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const spent = await prisma.studentCredit.findUniqueOrThrow({
      where: { id: payment.creditId! },
      select: { balanceMinor: true, status: true },
    });
    expect(spent).toMatchObject({ balanceMinor: 0n, status: 'EXHAUSTED' });

    const settled = await prisma.invoice.findUniqueOrThrow({
      where: { id: next.id },
      select: { balanceMinor: true, status: true },
    });
    expect(settled).toMatchObject({ balanceMinor: 0n, status: 'PAID' });
  });

  it('rejects overpayment when the organisation disallows it', async () => {
    await prisma.setting.create({
      data: {
        organizationId: world.organizationId,
        key: 'finance.allowOverpayment',
        scope: 'ORGANIZATION',
        value: false,
      },
    });
    await issuedInvoice({ amountMinor: 3_000n });

    await expect(
      recordPayment(world.accountant.ctx, {
        studentId: world.student.studentId,
        amountMinor: 5_000n,
        method: 'CASH',
        idempotencyKey: `pay-${uniqueSuffix()}`,
      }),
    ).rejects.toThrow(/exceeds the outstanding balance/i);

    expect(await prisma.payment.count()).toBe(0);
  });
});

describe('reversal', () => {
  it('reverses a payment with a compensating entry and restores the balance', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CARD',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    await reversePayment(world.admin.ctx, payment.id, { reason: 'Card chargeback' });

    const restored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { paidTotalMinor: true, balanceMinor: true, status: true, paidAt: true },
    });
    expect(restored.paidTotalMinor).toBe(0n);
    expect(restored.balanceMinor).toBe(TUITION);
    // Past its due date, so it is overdue again rather than merely issued.
    expect(['ISSUED', 'OVERDUE']).toContain(restored.status);
    expect(restored.paidAt).toBeNull();

    // The original entry is still there; a compensating one sits beside it.
    const entries = await ledgerSumFor(invoice.id);
    expect(entries.map((e) => e.entryType)).toEqual([
      'INVOICE_ISSUED',
      'PAYMENT_RECEIVED',
      'PAYMENT_REVERSED',
    ]);

    const reversal = await prisma.ledgerEntry.findFirstOrThrow({
      where: { entryType: 'PAYMENT_REVERSED' },
      select: { reversalOfId: true, direction: true },
    });
    expect(reversal.reversalOfId).not.toBeNull();
    expect(reversal.direction).toBe('DEBIT');
  });

  it('refuses to reverse a payment whose credit has been partly spent', async () => {
    await issuedInvoice({ amountMinor: 1_000n });
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 3_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const next = await issuedInvoice({ amountMinor: 1_000n, dueDate: FUTURE_DUE });
    await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 1_000n,
      method: 'CREDIT_NOTE',
      fromCreditId: payment.creditId!,
      invoiceIds: [next.id],
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    await expect(
      reversePayment(world.admin.ctx, payment.id, { reason: 'Keying error' }),
    ).rejects.toThrow(/already been partly used/i);
  });
});

describe('refunds', () => {
  it('runs request -> approve -> process and reduces the invoice paid total', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CARD',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    // The accountant requests; the threshold default of 0 forces approval.
    const refund = await requestRefund(world.accountant.ctx, {
      paymentId: payment.id,
      amountMinor: 4_000n,
      reason: 'Withdrew after two lessons',
      method: 'BANK_TRANSFER',
      idempotencyKey: `ref-${uniqueSuffix()}`,
    });
    expect(refund.status).toBe('PENDING_APPROVAL');

    // Separation of duties: the requester cannot approve their own refund.
    await expect(approveRefund(world.accountant.ctx, refund.id)).rejects.toThrow(
      /someone other than the person who requested/i,
    );

    await approveRefund(world.admin.ctx, refund.id);
    await processRefund(world.admin.ctx, refund.id);

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { paidTotalMinor: true, refundedTotalMinor: true, balanceMinor: true },
    });
    expect(stored.paidTotalMinor).toBe(TUITION);
    expect(stored.refundedTotalMinor).toBe(4_000n);
    // total - paid + refunded == 10000 - 10000 + 4000
    expect(stored.balanceMinor).toBe(4_000n);
  });

  it('issues a refund as account credit when the method is CREDIT_NOTE', async () => {
    await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CARD',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const refund = await requestRefund(world.accountant.ctx, {
      paymentId: payment.id,
      amountMinor: 2_500n,
      reason: 'Goodwill for cancelled lessons',
      method: 'CREDIT_NOTE',
      idempotencyKey: `ref-${uniqueSuffix()}`,
    });
    await approveRefund(world.admin.ctx, refund.id);
    const processed = await processRefund(world.admin.ctx, refund.id);

    expect(processed.creditId).not.toBeNull();
    const credit = await prisma.studentCredit.findUniqueOrThrow({
      where: { id: processed.creditId! },
      select: { amountMinor: true, balanceMinor: true, source: true },
    });
    expect(credit).toMatchObject({
      amountMinor: 2_500n,
      balanceMinor: 2_500n,
      source: 'REFUND_AS_CREDIT',
    });
  });

  it('never refunds more than the payment, across several requests', async () => {
    await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CARD',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const first = await requestRefund(world.accountant.ctx, {
      paymentId: payment.id,
      amountMinor: 6_000n,
      reason: 'Partial withdrawal',
      idempotencyKey: `ref-${uniqueSuffix()}`,
    });
    await approveRefund(world.admin.ctx, first.id);
    await processRefund(world.admin.ctx, first.id);

    await expect(
      requestRefund(world.accountant.ctx, {
        paymentId: payment.id,
        amountMinor: 5_000n,
        reason: 'Too much',
        idempotencyKey: `ref-${uniqueSuffix()}`,
      }),
    ).rejects.toThrow(/can still be refunded/i);
  });
});

describe('cancel and write-off', () => {
  it('cancels an unpaid invoice and reverses the charge', async () => {
    const invoice = await issuedInvoice();
    await cancelInvoice(world.admin.ctx, invoice.id, { reason: 'Raised in error' });

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { status: true, balanceMinor: true, cancelReason: true },
    });
    expect(stored.status).toBe('CANCELLED');
    expect(stored.cancelReason).toBe('Raised in error');

    const entries = await ledgerSumFor(invoice.id);
    expect(entries.map((e) => e.entryType)).toEqual(['INVOICE_ISSUED', 'INVOICE_CANCELLED']);
  });

  it('refuses to cancel an invoice that has received money', async () => {
    const invoice = await issuedInvoice();
    await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 1_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    await expect(
      cancelInvoice(world.admin.ctx, invoice.id, { reason: 'Changed my mind' }),
    ).rejects.toThrow(/payments against it/i);
  });

  it('writes off a balance and records an approved adjustment', async () => {
    const invoice = await issuedInvoice();
    await writeOffInvoice(world.admin.ctx, invoice.id, { reason: 'Student unreachable' });

    const stored = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      select: { status: true, writtenOffMinor: true, balanceMinor: true },
    });
    expect(stored).toMatchObject({
      status: 'WRITTEN_OFF',
      writtenOffMinor: TUITION,
      balanceMinor: 0n,
    });

    const adjustment = await prisma.financialAdjustment.findFirstOrThrow({
      select: { type: true, amountMinor: true, approvedById: true, ledgerEntryId: true },
    });
    expect(adjustment.type).toBe('WRITE_OFF');
    expect(adjustment.amountMinor).toBe(TUITION);
    // Never anonymous: a named approver and the ledger row it produced.
    expect(adjustment.approvedById).toBe(world.admin.ctx.userId);
    expect(adjustment.ledgerEntryId).not.toBeNull();
  });
});

describe('ledger integrity', () => {
  it('derived caches agree with the ledger after a full lifecycle', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 7_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });
    const refund = await requestRefund(world.accountant.ctx, {
      paymentId: payment.id,
      amountMinor: 2_000n,
      reason: 'Partial',
      idempotencyKey: `ref-${uniqueSuffix()}`,
    });
    await approveRefund(world.admin.ctx, refund.id);
    await processRefund(world.admin.ctx, refund.id);
    await writeOffInvoice(world.admin.ctx, invoice.id, { reason: 'Remainder uncollectable' });

    const report = await verifyLedgerConsistency(prisma, {
      organizationId: world.organizationId,
    });
    expect(report.drifted).toEqual([]);
    expect(report.checked).toBeGreaterThan(0);
  });

  it('the database refuses to update a ledger entry', async () => {
    const invoice = await issuedInvoice();
    const entry = await prisma.ledgerEntry.findFirstOrThrow({
      where: { invoiceId: invoice.id },
      select: { id: true },
    });

    // Through Prisma the trigger surfaces as a rejected write; Prisma wraps the
    // driver message, so the substring is asserted against the raw SQL path below.
    await expect(
      prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(
        'update "ledger_entries" set "amountMinor" = 1 where id = $1',
        entry.id,
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.$executeRawUnsafe('delete from "ledger_entries" where id = $1', entry.id),
    ).rejects.toThrow(/append-only/i);
  });

  it('the database refuses an inconsistent balance written directly', async () => {
    const invoice = await issuedInvoice();
    // The CHECK constraint is the backstop that makes a recalculation bug loud.
    await expect(
      prisma.invoice.update({ where: { id: invoice.id }, data: { balanceMinor: 1n } }),
    ).rejects.toThrow();
  });
});

describe('balances and debt reporting', () => {
  it('computes a student position net of credit', async () => {
    await issuedInvoice({ amountMinor: 8_000n });
    await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: 10_000n,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });

    const balance = await getStudentBalance(prisma, {
      organizationId: world.organizationId,
      studentId: world.student.studentId,
      currency: 'USD',
    });

    expect(balance.outstandingMinor).toBe(0n);
    expect(balance.creditMinor).toBe(2_000n);
    // Never negative: holding credit is not a negative bill.
    expect(balance.netDueMinor).toBe(0n);
  });

  it('places an overdue invoice in the right ageing bucket', async () => {
    // 21 days overdue as of today, which belongs in the 8-30 day bucket.
    await issuedInvoice({ amountMinor: 6_000n, dueDate: PAST_DUE_21_DAYS });

    const report = await getDebtAgeingReport(world.accountant.ctx, { asOf: today });

    expect(report.totalOutstandingMinor).toBe(6_000n);
    expect(report.totalOverdueMinor).toBe(6_000n);
    expect(report.notYetDue.amountMinor).toBe(0n);

    const populated = report.buckets.filter((bucket) => bucket.amountMinor > 0n);
    expect(populated).toHaveLength(1);
    expect(populated[0]).toMatchObject({ fromDays: 8, toDays: 30, invoiceCount: 1 });
  });

  it('separates not-yet-due from overdue', async () => {
    await issuedInvoice({ amountMinor: 5_000n, dueDate: FUTURE_DUE });

    const report = await getDebtAgeingReport(world.accountant.ctx, { asOf: today });
    expect(report.notYetDue.amountMinor).toBe(5_000n);
    expect(report.totalOverdueMinor).toBe(0n);
  });

  it('lists students in debt with the aggregate computed in SQL', async () => {
    await issuedInvoice({ amountMinor: 6_000n, dueDate: PAST_DUE_21_DAYS });
    const other = await createStudent({
      organizationId: world.organizationId,
      branchId: world.branchAId,
    });
    await issuedInvoice({ amountMinor: 9_000n, dueDate: addDaysToDateOnly(today, -31), studentId: other.studentId });

    const { rows, total } = await listStudentsInDebt(world.accountant.ctx, {
      asOf: today,
    });

    expect(total).toBe(2);
    // Worst first.
    expect(rows[0]?.studentId).toBe(other.studentId);
    expect(rows[0]?.overdueMinor).toBe(9_000n);
    expect(rows[0]?.daysOverdue).toBe(31);
    expect(rows[1]?.overdueMinor).toBe(6_000n);
  });
});

describe('branch isolation', () => {
  it('a branch-scoped accountant cannot invoice a student in another branch', async () => {
    const elsewhere = await createStudent({
      organizationId: world.organizationId,
      branchId: world.branchBId,
    });

    // The accountant is granted branch A only. The student is real but invisible,
    // so this must read as "not found" rather than confirming it exists.
    await expect(
      createInvoice(world.accountant.ctx, {
        studentId: elsewhere.studentId,
        items: [
          { description: 'Tuition', kind: 'TUITION', quantity: 1, unitPriceMinor: TUITION },
        ],
        issueDate: PAST_ISSUE,
        dueDate: PAST_DUE_21_DAYS,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('the debt report excludes other branches for a branch-scoped user', async () => {
    await issuedInvoice({ amountMinor: 6_000n, dueDate: PAST_DUE_21_DAYS });

    const elsewhere = await createStudent({
      organizationId: world.organizationId,
      branchId: world.branchBId,
    });
    await createInvoice(world.admin.ctx, {
      studentId: elsewhere.studentId,
      branchId: world.branchBId,
      items: [{ description: 'Tuition', kind: 'TUITION', quantity: 1, unitPriceMinor: 20_000n }],
      issueDate: PAST_ISSUE,
      dueDate: PAST_DUE_21_DAYS,
      issueNow: true,
    });

    const scoped = await getDebtAgeingReport(world.accountant.ctx, { asOf: today });
    expect(scoped.totalOutstandingMinor).toBe(6_000n);

    const orgWide = await getDebtAgeingReport(world.admin.ctx, { asOf: today });
    expect(orgWide.totalOutstandingMinor).toBe(26_000n);
  });

  it('a teacher may not record a payment at all', async () => {
    await issuedInvoice();
    await expect(
      recordPayment(world.teacher.ctx, {
        studentId: world.student.studentId,
        amountMinor: 1_000n,
        method: 'CASH',
        idempotencyKey: `pay-${uniqueSuffix()}`,
      }),
    ).rejects.toThrow(/permission/i);
  });
});

describe('audit trail', () => {
  it('records every financial action with an actor and a reason where required', async () => {
    const invoice = await issuedInvoice();
    const payment = await recordPayment(world.accountant.ctx, {
      studentId: world.student.studentId,
      amountMinor: TUITION,
      method: 'CASH',
      idempotencyKey: `pay-${uniqueSuffix()}`,
    });
    await reversePayment(world.admin.ctx, payment.id, { reason: 'Cheque bounced' });

    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorUserId: true, entityType: true, reason: true, severity: true },
    });

    const actions = logs.map((log) => log.action);
    expect(actions).toContain('invoice.created');
    expect(actions).toContain('invoice.issued');
    expect(actions).toContain('payment.recorded');
    expect(actions).toContain('payment.reversed');

    const reversal = logs.find((log) => log.action === 'payment.reversed');
    expect(reversal?.reason).toBe('Cheque bounced');
    expect(reversal?.actorUserId).toBe(world.admin.ctx.userId);
    // Reversals are elevated so the audit write is not best-effort.
    expect(reversal?.severity).toBe('WARNING');

    // And the student's operational timeline shows it too.
    const timeline = await prisma.activityEvent.findMany({
      where: { subjectType: 'STUDENT', subjectId: world.student.studentId },
      select: { type: true },
    });
    expect(timeline.map((event) => event.type)).toContain('payment.received');
    expect(timeline.map((event) => event.type)).toContain('payment.reversed');

    expect(invoice.id).toBeTruthy();
  });
});
