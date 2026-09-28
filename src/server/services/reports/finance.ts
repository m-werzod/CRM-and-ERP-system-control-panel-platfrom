/**
 * Financial reports.
 *
 * EVERY FIGURE COMES FROM `LedgerEntry`, not from `Payment` or `Invoice` rows.
 *
 * That is not a stylistic preference. A reversed payment keeps its `Payment` row
 * (status REVERSED) because the receipt was printed and the history is real, so a
 * report that sums `Payment.amountMinor` either counts money that came back or
 * has to reimplement the reversal rules — and the moment it reimplements them it
 * can disagree with `Invoice.balanceMinor`. The ledger already carries the
 * compensating `PAYMENT_REVERSED` entry, so netting entry types is both simpler
 * and the only definition that cannot drift from the balances the database
 * CHECK constraint enforces.
 *
 * Outstanding debt is the one exception, and deliberately so: it reads
 * `Invoice.balanceMinor`, which is a derived cache recomputed from the ledger
 * inside the writing transaction and guarded by
 * `balanceMinor = totalMinor - paidTotalMinor - writtenOffMinor + refundedTotalMinor`.
 * The `invoices_outstanding` partial index exists for exactly this query;
 * re-deriving a balance per invoice from the ledger would be slower and could not
 * be more correct.
 *
 * ONE CURRENCY PER REPORT. Minor units of UZS and USD cannot be added — `@/lib/money`
 * throws rather than let them be — so a report resolves its currency through
 * `currencyFor()` and filters to it, then names any other currencies it found in
 * the window so the operator knows something was left out rather than
 * discovering it in a reconciliation.
 */

import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import type { DateOnly } from '@/lib/dates';
import { currencyFor } from '@/server/services/finance/currency';
import { getDebtAgeingReport } from '@/server/services/finance/debts';
import {
  buildResult,
  capRows,
  moneySeries,
  REPORT_ROW_CAP,
  resolveReportScope,
  shareOfMoneyPpm,
  truncUnit,
  type ReportFilters,
  type ReportResult,
  type ReportScope,
} from './types';
import { exponentFor, moneyColumn, percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type RevenuePeriodRow = {
  readonly period: DateOnly;
  readonly currency: string;
  /** Invoices issued, net of voids and cancellations: accrued revenue. */
  readonly invoicedMinor: string;
  /** Payments received, net of reversals: money actually in. */
  readonly cashInMinor: string;
  readonly refundsMinor: string;
  /** cashIn - refunds. What the bank balance moved by. */
  readonly netCashMinor: string;
  readonly discountsMinor: string;
  readonly writeOffsMinor: string;
  readonly lateFeesMinor: string;
  /** Adjustments, signed: debits raise what is owed, credits reduce it. */
  readonly adjustmentsMinor: string;
  /** netCash as a share of invoiced, in parts-per-million. */
  readonly collectionRatePpm: number | null;
};

export type RevenueTotals = {
  readonly currency: string;
  readonly invoicedMinor: string;
  readonly cashInMinor: string;
  readonly refundsMinor: string;
  readonly netCashMinor: string;
  readonly discountsMinor: string;
  readonly writeOffsMinor: string;
  readonly lateFeesMinor: string;
  readonly adjustmentsMinor: string;
  readonly collectionRatePpm: number | null;
  /** ISO codes present in the window but not included, comma-separated, or null. */
  readonly otherCurrencies: string | null;
};

export type CollectionDimensionRow = {
  /** `branch`, `paymentMethod` or `program`. */
  readonly dimension: string;
  readonly key: string;
  readonly label: string | null;
  readonly currency: string;
  readonly invoicedMinor: string | null;
  readonly cashInMinor: string | null;
  readonly refundsMinor: string | null;
  readonly collectionRatePpm: number | null;
};

export type OutstandingRow = {
  /** `ageBand` or `branch`. */
  readonly dimension: string;
  readonly key: string;
  readonly label: string;
  readonly currency: string;
  readonly outstandingMinor: string;
  readonly invoices: number;
  readonly students: number;
  readonly sharePpm: number | null;
};

export type OutstandingTotals = {
  readonly currency: string;
  readonly asOf: DateOnly;
  readonly outstandingMinor: string;
  readonly overdueMinor: string;
  readonly notYetDueMinor: string;
  readonly studentsInDebt: number;
  /**
   * Whether the ageing bands cover exactly one branch or the caller's whole
   * scope. See the note on `financeOutstandingReport`.
   */
  readonly bandScope: string;
};

export type DiscountRow = {
  readonly period: DateOnly;
  readonly currency: string;
  readonly discountsMinor: string;
  readonly entries: number;
  readonly students: number;
  /** Discounts as a share of what was invoiced in the same period. */
  readonly sharePpm: number | null;
};

export type DiscountTotals = {
  readonly currency: string;
  readonly discountsMinor: string;
  readonly invoicedMinor: string;
  readonly entries: number;
  readonly sharePpm: number | null;
};

export type RefundRow = {
  readonly period: DateOnly;
  readonly currency: string;
  readonly refundsMinor: string;
  readonly refunds: number;
  readonly students: number;
  /** Refunds as a share of cash received in the same period. */
  readonly sharePpm: number | null;
};

export type RefundTotals = {
  readonly currency: string;
  readonly refundsMinor: string;
  readonly cashInMinor: string;
  readonly refunds: number;
  readonly sharePpm: number | null;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const REVENUE_COLUMNS: readonly ReportColumn<RevenuePeriodRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  moneyColumn<RevenuePeriodRow>('invoicedMinor', 'reports.columns.invoiced', 'currency'),
  moneyColumn<RevenuePeriodRow>('cashInMinor', 'reports.columns.cashIn', 'currency'),
  moneyColumn<RevenuePeriodRow>('refundsMinor', 'reports.columns.refunds', 'currency'),
  moneyColumn<RevenuePeriodRow>('netCashMinor', 'reports.columns.netCash', 'currency'),
  moneyColumn<RevenuePeriodRow>('discountsMinor', 'reports.columns.discounts', 'currency'),
  moneyColumn<RevenuePeriodRow>('writeOffsMinor', 'reports.columns.writeOffs', 'currency'),
  percentColumn<RevenuePeriodRow>('collectionRatePpm', 'reports.columns.collectionRate'),
];

export const COLLECTION_COLUMNS: readonly ReportColumn<CollectionDimensionRow>[] = [
  { key: 'dimension', labelKey: 'reports.columns.dimension' },
  { key: 'label', labelKey: 'reports.columns.name' },
  moneyColumn<CollectionDimensionRow>('invoicedMinor', 'reports.columns.invoiced', 'currency'),
  moneyColumn<CollectionDimensionRow>('cashInMinor', 'reports.columns.cashIn', 'currency'),
  moneyColumn<CollectionDimensionRow>('refundsMinor', 'reports.columns.refunds', 'currency'),
  percentColumn<CollectionDimensionRow>('collectionRatePpm', 'reports.columns.collectionRate'),
];

export const OUTSTANDING_COLUMNS: readonly ReportColumn<OutstandingRow>[] = [
  { key: 'dimension', labelKey: 'reports.columns.dimension' },
  { key: 'label', labelKey: 'reports.columns.name' },
  moneyColumn<OutstandingRow>('outstandingMinor', 'reports.columns.outstanding', 'currency'),
  { key: 'invoices', labelKey: 'reports.columns.invoices', kind: 'number' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<OutstandingRow>('sharePpm', 'reports.columns.share'),
];

export const DISCOUNT_COLUMNS: readonly ReportColumn<DiscountRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  moneyColumn<DiscountRow>('discountsMinor', 'reports.columns.discounts', 'currency'),
  { key: 'entries', labelKey: 'reports.columns.entries', kind: 'number' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<DiscountRow>('sharePpm', 'reports.columns.share'),
];

export const REFUND_COLUMNS: readonly ReportColumn<RefundRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  moneyColumn<RefundRow>('refundsMinor', 'reports.columns.refunds', 'currency'),
  { key: 'refunds', labelKey: 'reports.columns.refundCount', kind: 'number' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<RefundRow>('sharePpm', 'reports.columns.share'),
];

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * The currency this report is denominated in.
 *
 * Resolved through `currencyFor` -- never read from the `finance.currency`
 * setting directly, because a missing setting row means "nobody chose" and must
 * defer to the organisation rather than to a hard-coded guess.
 */
async function reportCurrency(scope: ReportScope, db: Db): Promise<string> {
  const onlyBranch = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;
  return currencyFor({ organizationId: scope.organizationId, branchId: onlyBranch }, db);
}

/**
 * A parent's or student's own figures only. Mirrors `selfStudentFilter`: a portal
 * account must never see the institution's aggregate revenue.
 */
function selfFinanceParams(scope: ReportScope): {
  restricted: boolean;
  studentId: string | null;
  guardianId: string | null;
} {
  return {
    restricted: scope.self.restricted,
    studentId: scope.self.studentId,
    guardianId: scope.self.guardianId,
  };
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/** `sum()` over a bigint column returns numeric, which arrives as a string; `::bigint` pins it. */
function big(value: bigint | string | null): bigint {
  return value === null ? 0n : BigInt(value);
}

// ---------------------------------------------------------------------------
// Revenue over time
// ---------------------------------------------------------------------------

interface RevenueRawRow {
  readonly period: Date;
  readonly currency: string;
  readonly invoiceIssued: bigint;
  readonly invoiceCancelled: bigint;
  readonly paymentReceived: bigint;
  readonly paymentReversed: bigint;
  readonly refundIssued: bigint;
  readonly discountApplied: bigint;
  readonly writeOff: bigint;
  readonly lateFee: bigint;
  readonly adjustmentDebit: bigint;
  readonly adjustmentCredit: bigint;
}

/**
 * Revenue, cash and the gap between them, per period.
 *
 * Bucketed on `LedgerEntry.occurredAt` -- the BUSINESS date, which an accountant
 * may back-date -- rather than `createdAt`. A payment entered on Monday for a
 * Friday receipt belongs in Friday's figures.
 */
export async function financeRevenueReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<RevenuePeriodRow, RevenueTotals>> {
  requirePermission(ctx, 'reports.viewFinancial');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const currency = await reportCurrency(scope, client);
  const self = selfFinanceParams(scope);
  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<RevenueRawRow[]>`
    select
      (date_trunc(
         ${unit}::text,
         (le."occurredAt" at time zone ${scope.timezone}::text)
           + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date            as "period",
      le."currency"                                                        as "currency",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'INVOICE_ISSUED'), 0)::bigint
                                                                           as "invoiceIssued",
      coalesce(sum(le."amountMinor") filter (
        where le."entryType" in ('INVOICE_VOIDED', 'INVOICE_CANCELLED')), 0)::bigint
                                                                           as "invoiceCancelled",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_RECEIVED'), 0)::bigint
                                                                           as "paymentReceived",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_REVERSED'), 0)::bigint
                                                                           as "paymentReversed",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'REFUND_ISSUED'), 0)::bigint
                                                                           as "refundIssued",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'DISCOUNT_APPLIED'), 0)::bigint
                                                                           as "discountApplied",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'WRITE_OFF'), 0)::bigint
                                                                           as "writeOff",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'LATE_FEE_CHARGED'), 0)::bigint
                                                                           as "lateFee",
      coalesce(sum(le."amountMinor") filter (
        where le."entryType" = 'ADJUSTMENT' and le."direction" = 'DEBIT'), 0)::bigint
                                                                           as "adjustmentDebit",
      coalesce(sum(le."amountMinor") filter (
        where le."entryType" = 'ADJUSTMENT' and le."direction" = 'CREDIT'), 0)::bigint
                                                                           as "adjustmentCredit"
    from "ledger_entries" le
    where le."organizationId" = ${scope.organizationId}
      and le."occurredAt" >= ${scope.fromInstant}
      and le."occurredAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
      and (not ${self.restricted}::boolean or (
            (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
            or (${self.guardianId}::text is not null and exists (
                  select 1 from "student_guardians" sg
                  where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
    group by 1, 2
    order by 1
  `;

  const inCurrency = rows.filter((row) => row.currency === currency);
  const otherCurrencies = [...new Set(rows.filter((r) => r.currency !== currency).map((r) => r.currency))]
    .sort()
    .join(', ');

  const mapped = inCurrency.map<RevenuePeriodRow>((row) => {
    const invoiced = big(row.invoiceIssued) - big(row.invoiceCancelled);
    const cashIn = big(row.paymentReceived) - big(row.paymentReversed);
    const refunds = big(row.refundIssued);
    const netCash = cashIn - refunds;
    return {
      period: toDateOnly(row.period),
      currency,
      invoicedMinor: invoiced.toString(),
      cashInMinor: cashIn.toString(),
      refundsMinor: refunds.toString(),
      netCashMinor: netCash.toString(),
      discountsMinor: big(row.discountApplied).toString(),
      writeOffsMinor: big(row.writeOff).toString(),
      lateFeesMinor: big(row.lateFee).toString(),
      adjustmentsMinor: (big(row.adjustmentDebit) - big(row.adjustmentCredit)).toString(),
      collectionRatePpm: shareOfMoneyPpm(netCash, invoiced),
    };
  });
  const capped = capRows(mapped);

  const sumOf = (pick: (row: RevenuePeriodRow) => string): bigint =>
    capped.rows.reduce((total, row) => total + BigInt(pick(row)), 0n);

  const invoicedTotal = sumOf((row) => row.invoicedMinor);
  const netCashTotal = sumOf((row) => row.netCashMinor);
  const exponent = exponentFor(currency);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      currency,
      invoicedMinor: invoicedTotal.toString(),
      cashInMinor: sumOf((row) => row.cashInMinor).toString(),
      refundsMinor: sumOf((row) => row.refundsMinor).toString(),
      netCashMinor: netCashTotal.toString(),
      discountsMinor: sumOf((row) => row.discountsMinor).toString(),
      writeOffsMinor: sumOf((row) => row.writeOffsMinor).toString(),
      lateFeesMinor: sumOf((row) => row.lateFeesMinor).toString(),
      adjustmentsMinor: sumOf((row) => row.adjustmentsMinor).toString(),
      collectionRatePpm: shareOfMoneyPpm(netCashTotal, invoicedTotal),
      otherCurrencies: otherCurrencies === '' ? null : otherCurrencies,
    },
    series: [
      moneySeries(
        'reports.series.invoiced',
        scope,
        currency,
        exponent,
        new Map(capped.rows.map((row) => [row.period, BigInt(row.invoicedMinor)])),
      ),
      moneySeries(
        'reports.series.cashIn',
        scope,
        currency,
        exponent,
        new Map(capped.rows.map((row) => [row.period, BigInt(row.netCashMinor)])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Collections by dimension
// ---------------------------------------------------------------------------

/**
 * Its own shape rather than `RevenueTotals`: this report computes invoiced and
 * collected but not discounts, write-offs or adjustments, and reporting those as
 * zero would be a lie about a financial figure. A field that is not computed is
 * absent.
 */
export type CollectionTotals = {
  readonly currency: string;
  readonly invoicedMinor: string;
  readonly cashInMinor: string;
  readonly refundsMinor: string;
  readonly netCashMinor: string;
  readonly collectionRatePpm: number | null;
};

/**
 * Invoiced versus collected, broken down three ways.
 *
 * `paymentMethod` joins the ledger to the `Payment` row it points at: the method
 * is a property of the payment, and taking it from there keeps the AMOUNT ledger-
 * derived while still answering "how much came in by card".
 *
 * `program` reports invoiced revenue only, and `cashInMinor` is null rather than
 * zero. A payment is received against an INVOICE, not against a line on it, so
 * splitting cash by programme would require inventing an allocation rule. A null
 * says "not attributable"; a zero would say "nothing was collected", which is
 * false.
 */
export async function financeCollectionsReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<CollectionDimensionRow, CollectionTotals>> {
  requirePermission(ctx, 'reports.viewFinancial');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const currency = await reportCurrency(scope, client);
  const self = selfFinanceParams(scope);

  const [byBranch, byMethod, byProgram] = await Promise.all([
    client.$queryRaw<
      Array<{
        key: string;
        label: string | null;
        invoiced: bigint;
        cashIn: bigint;
        refunds: bigint;
      }>
    >`
      select
        coalesce(le."branchId", 'UNASSIGNED')                             as "key",
        b."name"                                                         as "label",
        coalesce(sum(le."amountMinor") filter (where le."entryType" = 'INVOICE_ISSUED'), 0)::bigint
          - coalesce(sum(le."amountMinor") filter (
              where le."entryType" in ('INVOICE_VOIDED', 'INVOICE_CANCELLED')), 0)::bigint
                                                                         as "invoiced",
        coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_RECEIVED'), 0)::bigint
          - coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_REVERSED'), 0)::bigint
                                                                         as "cashIn",
        coalesce(sum(le."amountMinor") filter (where le."entryType" = 'REFUND_ISSUED'), 0)::bigint
                                                                         as "refunds"
      from "ledger_entries" le
      left join "branches" b on b."id" = le."branchId"
      where le."organizationId" = ${scope.organizationId}
        and le."currency" = ${currency}
        and le."occurredAt" >= ${scope.fromInstant}
        and le."occurredAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
        and (not ${self.restricted}::boolean or (
              (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
              or (${self.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
      group by 1, 2
      order by 3 desc
      limit ${REPORT_ROW_CAP + 1}
    `,
    client.$queryRaw<Array<{ key: string; cashIn: bigint; refunds: bigint }>>`
      select
        p."method"::text                                                 as "key",
        coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_RECEIVED'), 0)::bigint
          - coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_REVERSED'), 0)::bigint
                                                                         as "cashIn",
        coalesce(sum(le."amountMinor") filter (where le."entryType" = 'REFUND_ISSUED'), 0)::bigint
                                                                         as "refunds"
      from "ledger_entries" le
      join "payments" p on p."id" = le."paymentId"
      where le."organizationId" = ${scope.organizationId}
        and le."currency" = ${currency}
        and le."occurredAt" >= ${scope.fromInstant}
        and le."occurredAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
        and (not ${self.restricted}::boolean or (
              (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
              or (${self.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
      group by 1
      order by 2 desc
    `,
    client.$queryRaw<Array<{ key: string; label: string | null; invoiced: bigint }>>`
      select
        coalesce(ii."programId", 'UNASSIGNED')                            as "key",
        pr."name"                                                        as "label",
        coalesce(sum(ii."totalMinor"), 0)::bigint                        as "invoiced"
      from "ledger_entries" le
      join "invoice_items" ii on ii."invoiceId" = le."invoiceId"
      left join "programs" pr on pr."id" = ii."programId"
      where le."organizationId" = ${scope.organizationId}
        and le."entryType" = 'INVOICE_ISSUED'
        and le."currency" = ${currency}
        and le."occurredAt" >= ${scope.fromInstant}
        and le."occurredAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.programIds}::text[] is null or ii."programId" = any(${scope.programIds}::text[]))
        and (not ${self.restricted}::boolean or (
              (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
              or (${self.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
      group by 1, 2
      order by 3 desc
      limit ${REPORT_ROW_CAP + 1}
    `,
  ]);

  const rows: CollectionDimensionRow[] = [
    ...byBranch.map<CollectionDimensionRow>((row) => {
      const invoiced = big(row.invoiced);
      const net = big(row.cashIn) - big(row.refunds);
      return {
        dimension: 'branch',
        key: row.key,
        label: row.label,
        currency,
        invoicedMinor: invoiced.toString(),
        cashInMinor: big(row.cashIn).toString(),
        refundsMinor: big(row.refunds).toString(),
        collectionRatePpm: shareOfMoneyPpm(net, invoiced),
      };
    }),
    ...byMethod.map<CollectionDimensionRow>((row) => ({
      dimension: 'paymentMethod',
      key: row.key,
      label: null,
      currency,
      // A payment method raises no invoice, so there is nothing to collect
      // against and a collection rate would be a division by a non-fact.
      invoicedMinor: null,
      cashInMinor: big(row.cashIn).toString(),
      refundsMinor: big(row.refunds).toString(),
      collectionRatePpm: null,
    })),
    ...byProgram.map<CollectionDimensionRow>((row) => ({
      dimension: 'program',
      key: row.key,
      label: row.label,
      currency,
      invoicedMinor: big(row.invoiced).toString(),
      cashInMinor: null,
      refundsMinor: null,
      collectionRatePpm: null,
    })),
  ];

  const capped = capRows(rows);

  const branchRows = capped.rows.filter((row) => row.dimension === 'branch');
  const invoicedTotal = branchRows.reduce((total, row) => total + BigInt(row.invoicedMinor ?? '0'), 0n);
  const cashInTotal = branchRows.reduce((total, row) => total + BigInt(row.cashInMinor ?? '0'), 0n);
  const refundsTotal = branchRows.reduce((total, row) => total + BigInt(row.refundsMinor ?? '0'), 0n);
  const netCashTotal = cashInTotal - refundsTotal;

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    // Totalled from the branch axis alone: every ledger entry has exactly one
    // branch, so that axis sums to the true figure while the other two would
    // double-count or under-count it.
    totals: {
      currency,
      invoicedMinor: invoicedTotal.toString(),
      cashInMinor: cashInTotal.toString(),
      refundsMinor: refundsTotal.toString(),
      netCashMinor: netCashTotal.toString(),
      collectionRatePpm: shareOfMoneyPpm(netCashTotal, invoicedTotal),
    },
  });
}

// ---------------------------------------------------------------------------
// Outstanding debt
// ---------------------------------------------------------------------------

/**
 * Outstanding balances, aged, and split by branch.
 *
 * The ageing BANDS come from `getDebtAgeingReport` rather than being recomputed:
 * the non-overlapping boundary arithmetic ("an invoice exactly `previous` days
 * overdue must land in one bucket, not two") is a contract with one
 * implementation, and a second one here would be the worse outcome. That function
 * takes a single branch, so `totals.bandScope` says whether the bands describe
 * one branch or the caller's whole scope; the per-branch rows below always honour
 * the requested, intersected branch list exactly.
 */
export async function financeOutstandingReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<OutstandingRow, OutstandingTotals>> {
  requirePermission(ctx, 'reports.viewFinancial');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const currency = await reportCurrency(scope, client);
  const onlyBranch = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;

  const [ageing, byBranch] = await Promise.all([
    getDebtAgeingReport(ctx, { branchId: onlyBranch, currency, asOf: scope.to }, client),
    client.$queryRaw<
      Array<{ key: string; label: string | null; outstanding: bigint; invoices: number; students: number }>
    >`
      select
        i."branchId"                       as "key",
        b."name"                          as "label",
        coalesce(sum(i."balanceMinor"), 0)::bigint as "outstanding",
        count(*)::int                     as "invoices",
        count(distinct i."studentId")::int as "students"
      from "invoices" i
      join "branches" b on b."id" = i."branchId"
      join "students" s on s."id" = i."studentId"
      where i."organizationId" = ${scope.organizationId}
        and i."currency" = ${currency}
        and i."balanceMinor" > 0
        and i."status" not in ('DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF')
        and s."deletedAt" is null
        and (${scope.branchIds}::text[] is null or i."branchId" = any(${scope.branchIds}::text[]))
        and (not ${scope.self.restricted}::boolean or (
              (${scope.self.studentId}::text is not null and i."studentId" = ${scope.self.studentId})
              or (${scope.self.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = i."studentId"
                      and sg."guardianId" = ${scope.self.guardianId}))))
      group by 1, 2
      order by 3 desc
      limit ${REPORT_ROW_CAP + 1}
    `,
  ]);

  const outstandingTotal = ageing.totalOutstandingMinor;

  const rows: OutstandingRow[] = [
    ...ageing.buckets.map<OutstandingRow>((bucket) => ({
      dimension: 'ageBand',
      key: `${bucket.fromDays}-${bucket.toDays ?? 'plus'}`,
      label: bucket.label,
      currency,
      outstandingMinor: bucket.amountMinor.toString(),
      invoices: bucket.invoiceCount,
      students: bucket.studentCount,
      sharePpm: shareOfMoneyPpm(bucket.amountMinor, outstandingTotal),
    })),
    ...byBranch.map<OutstandingRow>((row) => ({
      dimension: 'branch',
      key: row.key,
      label: row.label ?? row.key,
      currency,
      outstandingMinor: big(row.outstanding).toString(),
      invoices: row.invoices,
      students: row.students,
      sharePpm: shareOfMoneyPpm(big(row.outstanding), outstandingTotal),
    })),
  ];

  const capped = capRows(rows);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      currency,
      asOf: ageing.asOf,
      outstandingMinor: outstandingTotal.toString(),
      overdueMinor: ageing.totalOverdueMinor.toString(),
      notYetDueMinor: ageing.notYetDue.amountMinor.toString(),
      studentsInDebt: ageing.studentsInDebt,
      bandScope: onlyBranch ? 'branch' : 'scope',
    },
  });
}

// ---------------------------------------------------------------------------
// Discounts granted
// ---------------------------------------------------------------------------

/**
 * Discounts granted per period, as a share of what was invoiced.
 *
 * The share is the figure that matters: 40 million so'm of discounts is alarming
 * against 100 million invoiced and unremarkable against four billion.
 */
export async function financeDiscountsReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<DiscountRow, DiscountTotals>> {
  requirePermission(ctx, 'reports.viewFinancial');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const currency = await reportCurrency(scope, client);
  const self = selfFinanceParams(scope);
  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{
      period: Date;
      discounts: bigint;
      invoiced: bigint;
      entries: number;
      students: number;
    }>
  >`
    select
      (date_trunc(
         ${unit}::text,
         (le."occurredAt" at time zone ${scope.timezone}::text)
           + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date          as "period",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'DISCOUNT_APPLIED'), 0)::bigint
                                                                         as "discounts",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'INVOICE_ISSUED'), 0)::bigint
                                                                         as "invoiced",
      count(*) filter (where le."entryType" = 'DISCOUNT_APPLIED')::int    as "entries",
      count(distinct le."studentId") filter (where le."entryType" = 'DISCOUNT_APPLIED')::int
                                                                         as "students"
    from "ledger_entries" le
    where le."organizationId" = ${scope.organizationId}
      and le."currency" = ${currency}
      and le."entryType" in ('DISCOUNT_APPLIED', 'INVOICE_ISSUED')
      and le."occurredAt" >= ${scope.fromInstant}
      and le."occurredAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
      and (not ${self.restricted}::boolean or (
            (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
            or (${self.guardianId}::text is not null and exists (
                  select 1 from "student_guardians" sg
                  where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
    group by 1
    order by 1
  `;

  const capped = capRows(
    rows.map<DiscountRow>((row) => ({
      period: toDateOnly(row.period),
      currency,
      discountsMinor: big(row.discounts).toString(),
      entries: row.entries,
      students: row.students,
      sharePpm: shareOfMoneyPpm(big(row.discounts), big(row.invoiced)),
    })),
  );

  const discountsTotal = capped.rows.reduce((total, row) => total + BigInt(row.discountsMinor), 0n);
  const invoicedTotal = rows.reduce((total, row) => total + big(row.invoiced), 0n);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      currency,
      discountsMinor: discountsTotal.toString(),
      invoicedMinor: invoicedTotal.toString(),
      entries: capped.rows.reduce((total, row) => total + row.entries, 0),
      sharePpm: shareOfMoneyPpm(discountsTotal, invoicedTotal),
    },
    series: [
      moneySeries(
        'reports.series.discounts',
        scope,
        currency,
        exponentFor(currency),
        new Map(capped.rows.map((row) => [row.period, BigInt(row.discountsMinor)])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Refunds issued
// ---------------------------------------------------------------------------

/** Refunds issued per period, against cash received in the same period. */
export async function financeRefundsReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<RefundRow, RefundTotals>> {
  requirePermission(ctx, 'reports.viewFinancial');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const currency = await reportCurrency(scope, client);
  const self = selfFinanceParams(scope);
  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{
      period: Date;
      refunds: bigint;
      received: bigint;
      reversed: bigint;
      refundCount: number;
      students: number;
    }>
  >`
    select
      (date_trunc(
         ${unit}::text,
         (le."occurredAt" at time zone ${scope.timezone}::text)
           + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date          as "period",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'REFUND_ISSUED'), 0)::bigint
                                                                         as "refunds",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_RECEIVED'), 0)::bigint
                                                                         as "received",
      coalesce(sum(le."amountMinor") filter (where le."entryType" = 'PAYMENT_REVERSED'), 0)::bigint
                                                                         as "reversed",
      count(distinct le."refundId")::int                                  as "refundCount",
      count(distinct le."studentId") filter (where le."entryType" = 'REFUND_ISSUED')::int
                                                                         as "students"
    from "ledger_entries" le
    where le."organizationId" = ${scope.organizationId}
      and le."currency" = ${currency}
      and le."entryType" in ('REFUND_ISSUED', 'PAYMENT_RECEIVED', 'PAYMENT_REVERSED')
      and le."occurredAt" >= ${scope.fromInstant}
      and le."occurredAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or le."branchId" = any(${scope.branchIds}::text[]))
      and (not ${self.restricted}::boolean or (
            (${self.studentId}::text is not null and le."studentId" = ${self.studentId})
            or (${self.guardianId}::text is not null and exists (
                  select 1 from "student_guardians" sg
                  where sg."studentId" = le."studentId" and sg."guardianId" = ${self.guardianId}))))
    group by 1
    order by 1
  `;

  const capped = capRows(
    rows.map<RefundRow>((row) => {
      const cashIn = big(row.received) - big(row.reversed);
      return {
        period: toDateOnly(row.period),
        currency,
        refundsMinor: big(row.refunds).toString(),
        refunds: row.refundCount,
        students: row.students,
        sharePpm: shareOfMoneyPpm(big(row.refunds), cashIn),
      };
    }),
  );

  const refundsTotal = capped.rows.reduce((total, row) => total + BigInt(row.refundsMinor), 0n);
  const cashInTotal = rows.reduce((total, row) => total + big(row.received) - big(row.reversed), 0n);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      currency,
      refundsMinor: refundsTotal.toString(),
      cashInMinor: cashInTotal.toString(),
      refunds: capped.rows.reduce((total, row) => total + row.refunds, 0),
      sharePpm: shareOfMoneyPpm(refundsTotal, cashInTotal),
    },
    series: [
      moneySeries(
        'reports.series.refunds',
        scope,
        currency,
        exponentFor(currency),
        new Map(capped.rows.map((row) => [row.period, BigInt(row.refundsMinor)])),
      ),
    ],
  });
}
