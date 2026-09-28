/**
 * Debt reporting: ageing buckets, per-student positions, collection worklists.
 *
 * Every figure here is read from the invoices' derived caches rather than
 * re-aggregated from the ledger, which is the whole reason those caches exist: an
 * ageing report over 100 000 invoices must be a few indexed scans, not a ledger
 * fold. The caches are recomputed inside the transactions that write the ledger
 * (see ./ledger.ts) and `npm run db:verify` re-derives them, so reading them here
 * is safe rather than a shortcut.
 *
 * The partial index `invoices_outstanding` (organizationId, dueDate)
 * WHERE balanceMinor > 0 AND status NOT IN (CANCELLED, VOID, WRITTEN_OFF) is what
 * makes these queries cheap regardless of how much settled history accumulates.
 */

import type { Prisma } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import {
  composeReadFilter,
  requirePermission,
  selfStudentFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import type { CurrencyCode } from '@/lib/money';
import { currencyFor } from '@/server/services/finance/currency';
import { todayIn, type DateOnly } from '@/lib/dates';

/** Statuses that represent a live receivable. */
const COLLECTABLE_STATUSES: Prisma.EnumInvoiceStatusFilter = {
  notIn: ['DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF'],
};

export interface AgeingBucket {
  /** Inclusive lower bound in days past due. */
  readonly fromDays: number;
  /** Inclusive upper bound, or null for the open-ended final bucket. */
  readonly toDays: number | null;
  readonly label: string;
  readonly amountMinor: bigint;
  readonly invoiceCount: number;
  readonly studentCount: number;
}

export interface DebtAgeingReport {
  readonly currency: CurrencyCode;
  readonly asOf: DateOnly;
  /** Not yet due. Kept separate so it is never confused with debt. */
  readonly notYetDue: { amountMinor: bigint; invoiceCount: number };
  readonly buckets: readonly AgeingBucket[];
  readonly totalOverdueMinor: bigint;
  readonly totalOutstandingMinor: bigint;
  readonly studentsInDebt: number;
}

/**
 * Ageing report with configurable buckets (`finance.debtAgingBuckets`, default
 * 0-7 / 8-30 / 31-60 / 60+).
 *
 * Boundaries are computed as dates rather than by subtracting days from `now` in
 * SQL, because "31 days overdue" must mean 31 calendar days in the branch's
 * timezone — an institution in Tashkent chasing debt at 09:00 local should not see
 * a different bucket than one computed in UTC.
 */
export async function getDebtAgeingReport(
  ctx: AccessContext,
  input: { branchId?: string | null; currency?: string; asOf?: DateOnly } = {},
  db: Db = prisma,
): Promise<DebtAgeingReport> {
  requirePermission(ctx, 'debts.view');

  const settings = await getSettings(['debtAgingBuckets', 'timezone'], {
    organizationId: ctx.organizationId,
    branchId: input.branchId ?? null,
  }, db);

  const currency = await currencyFor(
    {
      organizationId: ctx.organizationId,
      branchId: input.branchId ?? null,
      requested: input.currency,
    },
    db,
  );
  const asOf = input.asOf ?? todayIn(settings.timezone);
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  const scope = composeReadFilter(ctx, {
    selfFilter: selfStudentFilter(ctx),
    escapeHatch: 'debts.view',
  });

  const base: Prisma.InvoiceWhereInput = {
    ...(scope as Prisma.InvoiceWhereInput),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    currency,
    balanceMinor: { gt: 0 },
    status: COLLECTABLE_STATUSES,
  };

  // Upper bound of each bucket, in days past due. The final bucket is open-ended.
  const bounds = [...settings.debtAgingBuckets].sort((a, b) => a - b);

  /** Due-date window for "between `fromDays` and `toDays` past due". */
  const windowFor = (fromDays: number, toDays: number | null): Prisma.DateTimeFilter => {
    // More days overdue == an earlier due date, so the arithmetic inverts.
    const newest = new Date(asOfDate);
    newest.setUTCDate(newest.getUTCDate() - fromDays);
    if (toDays === null) return { lte: newest };
    const oldest = new Date(asOfDate);
    oldest.setUTCDate(oldest.getUTCDate() - toDays);
    return { gte: oldest, lte: newest };
  };

  // Buckets must not overlap. Taking `fromDays = previous` would put an invoice
  // exactly `previous` days overdue into BOTH the bucket ending on that day and
  // the one starting on it, double-counting the amount in the report totals.
  const ranges: Array<{ fromDays: number; toDays: number | null; label: string }> = [];
  let previous = 0;
  for (const bound of bounds) {
    const fromDays = previous === 0 ? 0 : previous + 1;
    // A duplicated or non-increasing bound would otherwise produce an inverted range.
    if (fromDays > bound) continue;
    ranges.push({
      fromDays,
      toDays: bound,
      label: `${fromDays}–${bound} days`,
    });
    previous = bound;
  }
  ranges.push({ fromDays: previous + 1, toDays: null, label: `${previous + 1}+ days` });

  const [notYetDueAgg, overallAgg, distinctDebtors, ...bucketResults] = await Promise.all([
    db.invoice.aggregate({
      where: { ...base, dueDate: { gt: asOfDate } },
      _sum: { balanceMinor: true },
      _count: { _all: true },
    }),
    db.invoice.aggregate({
      where: base,
      _sum: { balanceMinor: true },
      _count: { _all: true },
    }),
    db.invoice.findMany({
      where: { ...base, dueDate: { lte: asOfDate } },
      select: { studentId: true },
      distinct: ['studentId'],
    }),
    ...ranges.map(async (range) => {
      const where: Prisma.InvoiceWhereInput = {
        ...base,
        dueDate: windowFor(range.fromDays, range.toDays),
      };
      const [agg, students] = await Promise.all([
        db.invoice.aggregate({ where, _sum: { balanceMinor: true }, _count: { _all: true } }),
        db.invoice.findMany({ where, select: { studentId: true }, distinct: ['studentId'] }),
      ]);
      return {
        ...range,
        amountMinor: agg._sum.balanceMinor ?? 0n,
        invoiceCount: agg._count._all,
        studentCount: students.length,
      };
    }),
  ]);

  const buckets = bucketResults as AgeingBucket[];
  const totalOverdueMinor = buckets.reduce((total, bucket) => total + bucket.amountMinor, 0n);

  return {
    currency,
    asOf,
    notYetDue: {
      amountMinor: notYetDueAgg._sum.balanceMinor ?? 0n,
      invoiceCount: notYetDueAgg._count._all,
    },
    buckets,
    totalOverdueMinor,
    totalOutstandingMinor: overallAgg._sum.balanceMinor ?? 0n,
    studentsInDebt: distinctDebtors.length,
  };
}

export interface StudentDebtRow {
  readonly studentId: string;
  readonly studentCode: string;
  readonly fullName: string;
  readonly branchId: string;
  readonly phone: string | null;
  readonly currency: CurrencyCode;
  readonly outstandingMinor: bigint;
  readonly overdueMinor: bigint;
  readonly creditMinor: bigint;
  /** outstanding - credit, floored at zero: what would actually be collected. */
  readonly netDueMinor: bigint;
  readonly oldestDueDate: Date | null;
  readonly daysOverdue: number;
  readonly invoiceCount: number;
  readonly overdueInvoiceCount: number;
}

/**
 * The collection worklist: students with money outstanding, worst first.
 *
 * Deliberately paginated and aggregated in SQL. The obvious implementation —
 * fetch every student, then sum their invoices in JS — is an N+1 that becomes
 * unusable at a few thousand students, which is a realistic size for a
 * three-branch institution.
 */
export async function listStudentsInDebt(
  ctx: AccessContext,
  input: {
    branchId?: string | null;
    currency?: string;
    /** Only include students owing at least this much. */
    minAmountMinor?: bigint;
    /** Only include students at least this many days past due. */
    minDaysOverdue?: number;
    page?: number;
    pageSize?: number;
    asOf?: DateOnly;
  } = {},
  db: Db = prisma,
): Promise<{ rows: StudentDebtRow[]; total: number }> {
  requirePermission(ctx, 'debts.view');

  const settings = await getSettings(['timezone'], {
    organizationId: ctx.organizationId,
    branchId: input.branchId ?? null,
  }, db);

  const currency = await currencyFor(
    {
      organizationId: ctx.organizationId,
      branchId: input.branchId ?? null,
      requested: input.currency,
    },
    db,
  );
  const asOf = input.asOf ?? todayIn(settings.timezone);
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, input.pageSize ?? 50));
  const minAmount = input.minAmountMinor ?? 1n;
  const minDaysOverdue = input.minDaysOverdue ?? 0;

  // Branch scope is applied here as SQL rather than through scopeFilter, because
  // this is a raw aggregate. The predicate is built from ctx, never from input,
  // so a caller cannot widen their own scope.
  const branchIds = ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds];
  const requestedBranch = input.branchId ?? null;

  // A SELF-scoped caller (a parent) sees only their own children's debt.
  const guardianId = ctx.scope === 'SELF' ? ctx.self.guardianId : null;
  const selfStudentId = ctx.scope === 'SELF' ? ctx.self.studentId : null;
  if (ctx.scope === 'SELF' && !guardianId && !selfStudentId) {
    return { rows: [], total: 0 };
  }

  const rows = await db.$queryRaw<
    Array<{
      studentId: string;
      studentCode: string;
      fullName: string;
      branchId: string;
      phone: string | null;
      outstandingMinor: bigint;
      overdueMinor: bigint;
      creditMinor: bigint;
      oldestDueDate: Date | null;
      invoiceCount: bigint;
      overdueInvoiceCount: bigint;
      totalCount: bigint;
    }>
  >`
    with outstanding as (
      select
        i."studentId",
        sum(i."balanceMinor")                                              as outstanding_minor,
        sum(case when i."dueDate" <= ${asOfDate} then i."balanceMinor" else 0 end) as overdue_minor,
        min(case when i."dueDate" <= ${asOfDate} then i."dueDate" end)     as oldest_due_date,
        count(*)                                                           as invoice_count,
        count(*) filter (where i."dueDate" <= ${asOfDate})                 as overdue_invoice_count
      from "invoices" i
      where i."organizationId" = ${ctx.organizationId}
        and i."currency" = ${currency}
        and i."balanceMinor" > 0
        and i."status" not in ('DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF')
        and (${branchIds}::text[] is null or i."branchId" = any(${branchIds}::text[]))
        and (${requestedBranch}::text is null or i."branchId" = ${requestedBranch})
      group by i."studentId"
    ),
    credit as (
      select c."studentId", sum(c."balanceMinor") as credit_minor
      from "student_credits" c
      where c."organizationId" = ${ctx.organizationId}
        and c."currency" = ${currency}
        and c."status" in ('AVAILABLE', 'PARTIALLY_USED')
      group by c."studentId"
    )
    select
      s."id"                                  as "studentId",
      s."studentCode"                         as "studentCode",
      (s."firstName" || ' ' || s."lastName")  as "fullName",
      s."branchId"                            as "branchId",
      s."phone"                               as "phone",
      o.outstanding_minor                     as "outstandingMinor",
      o.overdue_minor                         as "overdueMinor",
      coalesce(cr.credit_minor, 0)            as "creditMinor",
      o.oldest_due_date                       as "oldestDueDate",
      o.invoice_count                         as "invoiceCount",
      o.overdue_invoice_count                 as "overdueInvoiceCount",
      count(*) over ()                        as "totalCount"
    from outstanding o
    join "students" s on s."id" = o."studentId"
    left join credit cr on cr."studentId" = o."studentId"
    where s."deletedAt" is null
      and o.outstanding_minor >= ${minAmount}
      and (
        ${minDaysOverdue}::int = 0
        or (o.oldest_due_date is not null
            and o.oldest_due_date <= ${asOfDate}::date - (${minDaysOverdue}::int))
      )
      and (${guardianId}::text is null or exists (
            select 1 from "student_guardians" sg
            where sg."studentId" = s."id" and sg."guardianId" = ${guardianId}))
      and (${selfStudentId}::text is null or s."id" = ${selfStudentId})
    order by o.overdue_minor desc, o.outstanding_minor desc, s."lastName" asc
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `;

  const total = rows.length > 0 ? Number(rows[0]!.totalCount) : 0;

  return {
    total,
    rows: rows.map((row) => {
      const outstanding = BigInt(row.outstandingMinor);
      const credit = BigInt(row.creditMinor);
      const net = outstanding - credit;
      const daysOverdue = row.oldestDueDate
        ? Math.max(
            0,
            Math.floor((asOfDate.getTime() - row.oldestDueDate.getTime()) / 86_400_000),
          )
        : 0;

      return {
        studentId: row.studentId,
        studentCode: row.studentCode,
        fullName: row.fullName,
        branchId: row.branchId,
        phone: row.phone,
        currency,
        outstandingMinor: outstanding,
        overdueMinor: BigInt(row.overdueMinor),
        creditMinor: credit,
        netDueMinor: net > 0n ? net : 0n,
        oldestDueDate: row.oldestDueDate,
        daysOverdue,
        invoiceCount: Number(row.invoiceCount),
        overdueInvoiceCount: Number(row.overdueInvoiceCount),
      };
    }),
  };
}

/**
 * Invoices due for a reminder on a given day, per the configured reminder
 * schedules. Drives the `overduePaymentReminders` cron job.
 *
 * Returns invoices, not notifications: deciding who to tell and on which channel
 * is the notification engine's job, and keeping that split means the reminder
 * schedule can be changed without touching delivery.
 */
export async function findInvoicesDueForReminder(
  ctx: AccessContext,
  input: { asOf?: DateOnly; branchId?: string | null } = {},
  db: Db = prisma,
): Promise<
  Array<{
    invoiceId: string;
    invoiceNumber: string;
    studentId: string;
    branchId: string;
    currency: CurrencyCode;
    balanceMinor: bigint;
    dueDate: Date;
    daysOverdue: number;
    kind: 'UPCOMING' | 'OVERDUE';
  }>
> {
  const settings = await getSettings(
    ['timezone', 'paymentReminderDaysBefore', 'overdueReminderDaysAfter'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );

  const currency = await currencyFor(
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const asOf = input.asOf ?? todayIn(settings.timezone);
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  const dateOffsetBy = (days: number): Date => {
    const date = new Date(asOfDate);
    date.setUTCDate(date.getUTCDate() + days);
    return date;
  };

  // Reminders fire on exact day offsets rather than ranges, so a parent gets one
  // message per configured milestone instead of one every day until they pay.
  const upcomingDueDates = settings.paymentReminderDaysBefore.map((days) => dateOffsetBy(days));
  const overdueDueDates = settings.overdueReminderDaysAfter.map((days) => dateOffsetBy(-days));

  if (upcomingDueDates.length === 0 && overdueDueDates.length === 0) return [];

  const invoices = await db.invoice.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      currency,
      balanceMinor: { gt: 0 },
      status: COLLECTABLE_STATUSES,
      dueDate: { in: [...upcomingDueDates, ...overdueDueDates] },
    },
    select: {
      id: true,
      invoiceNumber: true,
      studentId: true,
      branchId: true,
      balanceMinor: true,
      dueDate: true,
    },
    orderBy: { dueDate: 'asc' },
  });

  return invoices.map((invoice) => {
    const daysOverdue = Math.floor(
      (asOfDate.getTime() - invoice.dueDate.getTime()) / 86_400_000,
    );
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      studentId: invoice.studentId,
      branchId: invoice.branchId,
      currency,
      balanceMinor: invoice.balanceMinor,
      dueDate: invoice.dueDate,
      daysOverdue: Math.max(0, daysOverdue),
      kind: daysOverdue > 0 ? ('OVERDUE' as const) : ('UPCOMING' as const),
    };
  });
}
