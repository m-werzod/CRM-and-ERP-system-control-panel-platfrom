/**
 * The shape every report shares, and the one place a report's scope is resolved.
 *
 * Three rules hold for all nine reports, and they live here rather than being
 * re-derived per file:
 *
 *  1. SCOPE IS INTERSECTED, NEVER TRUSTED. A report takes `branchIds` from the
 *     caller, but the predicate that reaches SQL is that list INTERSECTED with
 *     `ctx.branchIds`. A reporting endpoint is the easiest place in a system to
 *     read another branch's figures -- the request names the branch, the answer
 *     is an aggregate, and no row-level filter is visible in the output. So the
 *     effective branch list is computed from `ctx` and the request can only ever
 *     narrow it. The same holds for groups, teachers and programs, which are
 *     narrowed transitively by the branch predicate in each query.
 *
 *  2. AGGREGATION HAPPENS IN THE DATABASE, AND IS BOUNDED. Every report either
 *     `groupBy`s or `$queryRaw`s, and every row-returning query asks for at most
 *     `REPORT_ROW_CAP + 1` rows so it can report `truncated` instead of pulling
 *     half a million rows into the request's heap. A report that folds rows in
 *     JavaScript works on seed data and dies on a real term.
 *
 *  3. CALENDAR DAYS COME FROM A TIMEZONE. `from`/`to` are calendar dates in the
 *     institution's zone, converted to a half-open instant range exactly once,
 *     here. A report bucketed on the server's local day would move when the
 *     deployment region changed.
 *
 * `rows` / `totals` / `series` exist because a report screen is a table AND a
 * chart, and computing the chart from the table in the client is how the two
 * come to disagree.
 */

import { prisma, type Db } from '@/server/db/client';
import { BadRequestError } from '@/server/errors';
import {
  assertBranchAccess,
  isSelfScoped,
  restrictedToOwn,
  type AccessContext,
} from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import { getSettings } from '@/server/settings';
import {
  addDaysToDateOnly,
  dayRangeToInstants,
  daysBetweenDateOnly,
  isDateOnly,
  todayIn,
  type DateOnly,
  type TimeZone,
} from '@/lib/dates';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on the rows a single report returns. A report is read by a human
 * on a screen or handed to the CSV exporter, and neither needs more than this at
 * once; beyond it the answer is a narrower filter, not a bigger response.
 */
export const REPORT_ROW_CAP = 5_000;

/**
 * Widest window a report will compute, in days. Three years covers "compare with
 * the same term two years ago" and stops a stray `from=1970-01-01` from asking
 * PostgreSQL to scan the whole history of the institution.
 */
export const MAX_REPORT_RANGE_DAYS = 1_100;

// ---------------------------------------------------------------------------
// The report catalogue
// ---------------------------------------------------------------------------

/**
 * Every report key the system knows.
 *
 * The keys live here, as data, while the functions they name live in the
 * registry in ./index.ts -- `SavedReport.type` and `ExportJob.type` are plain
 * strings in the database, so this list is what makes a stored key checkable,
 * and keeping it out of the barrel is what stops `export.ts` and `index.ts`
 * importing each other. ./index.ts asserts at compile time that the registry
 * covers exactly this list.
 */
export const REPORT_KEYS = [
  'students.overview',
  'students.distribution',
  'students.retention',
  'attendance.rates',
  'attendance.byGroup',
  'attendance.byTeacher',
  'attendance.atRisk',
  'attendance.teacherPunctuality',
  'finance.revenue',
  'finance.outstanding',
  'finance.collections',
  'finance.discounts',
  'finance.refunds',
  'crm.leads',
  'crm.funnel',
  'crm.lostReasons',
  'crm.followUpCompliance',
  'academic.gradeDistribution',
  'academic.examPerformance',
  'academic.bySubject',
  'academic.byTeacher',
  'academic.homeworkCompletion',
  'hr.staffAttendance',
  'hr.teacherWorkload',
  'hr.leave',
  'hr.payroll',
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

const REPORT_KEY_SET: ReadonlySet<string> = new Set<string>(REPORT_KEYS);

export function isReportKey(value: string): value is ReportKey {
  return REPORT_KEY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ReportGranularity = 'day' | 'week' | 'month';

/**
 * The filter set every report accepts. `from`, `to` and `granularity` are
 * optional at the boundary and resolved below: month-to-date in the
 * institution's timezone, with a granularity picked to suit the span, so a
 * dashboard tile can call a report with no arguments at all.
 */
export interface ReportFilters {
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly branchIds?: readonly string[];
  readonly groupIds?: readonly string[];
  readonly teacherIds?: readonly string[];
  readonly programIds?: readonly string[];
  readonly granularity?: ReportGranularity;
}

/** The filters actually applied, echoed back so an export is reproducible. */
export interface ResolvedReportFilters {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly granularity: ReportGranularity;
  /**
   * The branches actually queried: the caller's scope intersected with the
   * request. `null` means "no branch predicate" -- an organisation-scoped caller
   * who named no branch.
   */
  readonly branchIds: readonly string[] | null;
  readonly groupIds: readonly string[] | null;
  readonly teacherIds: readonly string[] | null;
  readonly programIds: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * What a cell may hold. Deliberately no `bigint`: a row travels to the client as
 * JSON and is handed to the CSV exporter, and money must survive both losslessly
 * -- so a monetary cell is the minor units as a decimal STRING plus a `currency`
 * column beside it, never a float and never a BigInt that `JSON.stringify`
 * refuses.
 */
export type ReportValue = string | number | boolean | null;

/**
 * Row and totals shapes are declared as type ALIASES rather than interfaces
 * throughout this module, on purpose: an object type alias gets an implicit
 * index signature, so a concrete row type is assignable to `ReportRow` and the
 * registry in ./index.ts can stay typed without `any`. An `interface` would not
 * be.
 */
export type ReportRow = { readonly [column: string]: ReportValue };

export type ReportSeriesKind = 'count' | 'money' | 'percentPpm';

export interface ReportSeriesPoint {
  /** First calendar day of the bucket, in the institution's timezone. */
  readonly period: DateOnly;
  /**
   * The number a chart plots. For a money series this is MAJOR units as a
   * float, which is correct for pixel geometry and wrong for arithmetic --
   * `amountMinor` beside it is the figure to add up, compare or print.
   */
  readonly value: number;
  readonly amountMinor?: string;
}

export interface ReportSeries {
  /** i18n key for the legend. Never a display string. */
  readonly key: string;
  readonly kind: ReportSeriesKind;
  /** Set when `kind` is `money`. */
  readonly currency?: string;
  readonly points: readonly ReportSeriesPoint[];
}

export interface ReportMeta {
  readonly generatedAt: Date;
  /** The EFFECTIVE filters, not the requested ones. See rule 1 above. */
  readonly filters: ResolvedReportFilters;
  readonly rowCount: number;
  /** True when the row cap clipped the result; `rows` is then a prefix. */
  readonly truncated: boolean;
}

export interface ReportResult<TRow extends ReportRow, TTotals extends ReportRow = ReportRow> {
  readonly rows: readonly TRow[];
  readonly totals: TTotals;
  readonly series: readonly ReportSeries[];
  readonly meta: ReportMeta;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export interface ReportScope {
  readonly organizationId: string;
  readonly timezone: TimeZone;
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Half-open `[fromInstant, toExclusive)`, so a midnight row cannot double-count. */
  readonly fromInstant: Date;
  readonly toExclusive: Date;
  readonly granularity: ReportGranularity;
  /** Days to shift before/after `date_trunc('week', …)`; see `weekShiftDays`. */
  readonly weekShiftDays: number;
  readonly branchIds: string[] | null;
  readonly groupIds: string[] | null;
  readonly teacherIds: string[] | null;
  readonly programIds: string[] | null;
  /**
   * Set when the caller is a teacher narrowed to their own classes. Reports add
   * it as an extra predicate rather than relying on the branch filter, which a
   * teacher's whole branch would otherwise satisfy.
   */
  readonly ownTeacherId: string | null;
  /**
   * True when the caller is narrowed to their own records but has no identity to
   * narrow BY -- a SELF-scoped user who is not a teacher. Such a caller must see
   * nothing, not everything, so the report short-circuits on this.
   */
  readonly selfWithoutIdentity: boolean;
  /**
   * The caller's identity links, for reports whose SELF narrowing is not about
   * teaching: a parent's own children, a student's own record. `restricted` is
   * false as soon as the caller is not SELF-scoped, which is what lets one SQL
   * predicate serve both cases.
   *
   * This mirrors `selfStudentFilter` in @/server/rbac/access -- the Prisma paths
   * use that, the raw aggregates below reproduce it, and the two must say the
   * same thing.
   */
  readonly self: {
    readonly restricted: boolean;
    readonly teacherId: string | null;
    readonly employeeId: string | null;
    readonly studentId: string | null;
    readonly guardianId: string | null;
  };
  readonly filters: ResolvedReportFilters;
}

/**
 * Intersect the requested branches with the caller's own.
 *
 * The explicit `assertBranchAccess` is not the security control -- the
 * intersection below is. It exists so a caller who names a branch they cannot
 * see gets an honest 403 instead of a report full of zeroes that looks like a
 * quiet month.
 */
function intersectBranches(
  ctx: AccessContext,
  requested: readonly string[] | undefined,
): string[] | null {
  const unrestricted = ctx.scope === 'ORGANIZATION' || ctx.isSystem;
  const wanted = requested && requested.length > 0 ? [...new Set(requested)] : null;

  if (wanted === null) {
    // An empty list for a branch-scoped caller with no branch assignment is the
    // correct, fail-closed answer: they see no data rather than all of it.
    return unrestricted ? null : [...ctx.branchIds];
  }

  for (const branchId of wanted) assertBranchAccess(ctx, branchId, 'report');
  if (unrestricted) return wanted;

  const allowed = new Set(ctx.branchIds);
  return wanted.filter((branchId) => allowed.has(branchId));
}

function normaliseIdList(values: readonly string[] | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  return [...new Set(values)];
}

/** Narrower windows deserve finer buckets; a three-year day-by-day chart is unreadable. */
function defaultGranularity(spanDays: number): ReportGranularity {
  if (spanDays <= 31) return 'day';
  if (spanDays <= 180) return 'week';
  return 'month';
}

export interface ResolveScopeOptions {
  /**
   * Permission that lifts the SELF narrowing for this report, e.g.
   * `attendance.viewAll`. Omitted for reports that carry no per-teacher view.
   */
  readonly selfEscapeHatch?: PermissionKey | string;
}

export async function resolveReportScope(
  ctx: AccessContext,
  filters: ReportFilters,
  db: Db = prisma,
  options: ResolveScopeOptions = {},
): Promise<ReportScope> {
  const { timezone, weekStartsOn } = await getSettings(
    ['timezone', 'weekStartsOn'],
    { organizationId: ctx.organizationId },
    db,
  );

  const to = filters.to ?? todayIn(timezone);
  // Month-to-date by default, in the institution's zone rather than the server's.
  const from = filters.from ?? `${to.slice(0, 8)}01`;

  if (!isDateOnly(from) || !isDateOnly(to)) {
    throw new BadRequestError('A report period must be two calendar dates (YYYY-MM-DD).');
  }
  const spanDays = daysBetweenDateOnly(from, to);
  if (spanDays < 0) {
    throw new BadRequestError('A report period cannot end before it starts.');
  }
  if (spanDays + 1 > MAX_REPORT_RANGE_DAYS) {
    throw new BadRequestError(
      `A report period may span at most ${MAX_REPORT_RANGE_DAYS} days.`,
      { details: { maxDays: MAX_REPORT_RANGE_DAYS, requestedDays: spanDays + 1 } },
    );
  }

  const range = dayRangeToInstants(from, to, timezone);
  const granularity = filters.granularity ?? defaultGranularity(spanDays);

  const narrowed = options.selfEscapeHatch
    ? restrictedToOwn(ctx, options.selfEscapeHatch)
    : false;
  const ownTeacherId = narrowed ? ctx.self.teacherId : null;

  const branchIds = intersectBranches(ctx, filters.branchIds);
  const groupIds = normaliseIdList(filters.groupIds);
  const teacherIds = normaliseIdList(filters.teacherIds);
  const programIds = normaliseIdList(filters.programIds);

  return {
    organizationId: ctx.organizationId,
    timezone,
    from,
    to,
    fromInstant: range.from,
    toExclusive: range.toExclusive,
    granularity,
    weekShiftDays: weekShiftDays(weekStartsOn),
    branchIds,
    groupIds,
    teacherIds,
    programIds,
    ownTeacherId,
    selfWithoutIdentity: narrowed && ownTeacherId === null,
    self: {
      restricted: isSelfScoped(ctx),
      teacherId: ctx.self.teacherId,
      employeeId: ctx.self.employeeId,
      studentId: ctx.self.studentId,
      guardianId: ctx.self.guardianId,
    },
    filters: { from, to, granularity, branchIds, groupIds, teacherIds, programIds },
  };
}

/**
 * True when a SELF-scoped caller has no identity that could narrow this report --
 * a portal account with no student, guardian or teacher link. They must see
 * nothing rather than everything, so reports short-circuit on this.
 */
export function selfHasNoIdentity(scope: ReportScope): boolean {
  if (!scope.self.restricted) return false;
  return (
    scope.self.studentId === null &&
    scope.self.guardianId === null &&
    scope.self.teacherId === null
  );
}

// ---------------------------------------------------------------------------
// Period buckets
// ---------------------------------------------------------------------------

/**
 * `date_trunc('week', …)` always starts a week on Monday. An institution that
 * reads its week as Sunday-first would otherwise see a chart whose buckets
 * disagree with its own calendar, so weekly buckets are shifted by this many
 * days on the way in and back out again.
 */
function weekShiftDays(weekStartsOn: 'MONDAY' | 'SUNDAY'): number {
  return weekStartsOn === 'SUNDAY' ? 1 : 0;
}

const TRUNC_UNIT: Record<ReportGranularity, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/**
 * The `date_trunc` unit for a granularity. Looked up from this map rather than
 * interpolated, so the value reaching SQL can only ever be one of three
 * literals even though it travels as a parameter.
 */
export function truncUnit(granularity: ReportGranularity): string {
  return TRUNC_UNIT[granularity];
}

/** The bucket a calendar date falls into. Mirrors the SQL expression exactly. */
export function bucketStart(date: DateOnly, scope: ReportScope): DateOnly {
  if (scope.granularity === 'day') return date;
  if (scope.granularity === 'month') return `${date.slice(0, 8)}01`;

  // Week: UTC arithmetic on the calendar date, matching addDaysToDateOnly, so no
  // zone can shift which week a date belongs to.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const startIndex = scope.weekShiftDays === 1 ? 0 : 1;
  const offset = (weekday - startIndex + 7) % 7;
  return addDaysToDateOnly(date, -offset);
}

/**
 * Every bucket in the report's window, in order.
 *
 * A chart needs a point per bucket including the empty ones: a month with no
 * enrolments must be a zero-height bar, not a missing one that makes the axis
 * lie about the period.
 */
export function bucketsIn(scope: ReportScope): DateOnly[] {
  const buckets: DateOnly[] = [];
  let cursor = bucketStart(scope.from, scope);
  const last = bucketStart(scope.to, scope);

  while (cursor <= last) {
    buckets.push(cursor);
    cursor =
      scope.granularity === 'day'
        ? addDaysToDateOnly(cursor, 1)
        : scope.granularity === 'week'
          ? addDaysToDateOnly(cursor, 7)
          : nextMonthStart(cursor);
  }
  return buckets;
}

function nextMonthStart(date: DateOnly): DateOnly {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Build a gap-free count series from sparse `period -> count` aggregate rows. */
export function countSeries(
  key: string,
  scope: ReportScope,
  byPeriod: ReadonlyMap<DateOnly, number>,
): ReportSeries {
  return {
    key,
    kind: 'count',
    points: bucketsIn(scope).map((period) => ({ period, value: byPeriod.get(period) ?? 0 })),
  };
}

/** Build a gap-free money series, carrying exact minor units beside the plot value. */
export function moneySeries(
  key: string,
  scope: ReportScope,
  currency: string,
  exponent: number,
  byPeriod: ReadonlyMap<DateOnly, bigint>,
): ReportSeries {
  const divisor = 10 ** exponent;
  return {
    key,
    kind: 'money',
    currency,
    points: bucketsIn(scope).map((period) => {
      const amountMinor = byPeriod.get(period) ?? 0n;
      return {
        period,
        value: Number(amountMinor) / divisor,
        amountMinor: amountMinor.toString(),
      };
    }),
  };
}

/** Build a gap-free percentage series. Null buckets plot as 0 but stay distinguishable in `rows`. */
export function percentSeries(
  key: string,
  scope: ReportScope,
  byPeriod: ReadonlyMap<DateOnly, number | null>,
): ReportSeries {
  return {
    key,
    kind: 'percentPpm',
    points: bucketsIn(scope).map((period) => ({ period, value: byPeriod.get(period) ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// Small shared arithmetic
// ---------------------------------------------------------------------------

/**
 * `part` as a share of `whole`, in integer parts-per-million -- the project's
 * percentage representation. Zero `whole` yields `null`, not 0: "no leads yet"
 * and "no leads converted" are different facts and a 0% conversion rate on an
 * empty pipeline is a lie.
 */
export function sharePpm(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part * 1_000_000) / whole);
}

/** Same, for money. Both sides must already be the same currency. */
export function shareOfMoneyPpm(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Number((part * 1_000_000n) / whole);
}

/**
 * Trim a page fetched with `limit = REPORT_ROW_CAP + 1` and report whether the
 * cap bit. Fetching one extra row is how a report knows it was clipped without a
 * second COUNT over the same aggregate.
 */
export function capRows<T>(rows: readonly T[], cap = REPORT_ROW_CAP): {
  rows: T[];
  truncated: boolean;
} {
  const truncated = rows.length > cap;
  return { rows: truncated ? rows.slice(0, cap) : [...rows], truncated };
}

/** Assemble the envelope, so no report hand-rolls `meta`. */
export function buildResult<TRow extends ReportRow, TTotals extends ReportRow>(input: {
  readonly scope: ReportScope;
  readonly rows: readonly TRow[];
  readonly totals: TTotals;
  readonly series?: readonly ReportSeries[];
  readonly truncated?: boolean;
}): ReportResult<TRow, TTotals> {
  return {
    rows: input.rows,
    totals: input.totals,
    series: input.series ?? [],
    meta: {
      generatedAt: new Date(),
      filters: input.scope.filters,
      rowCount: input.rows.length,
      truncated: input.truncated ?? false,
    },
  };
}

/**
 * The answer for a caller whose scope resolves to nothing at all. Returned
 * rather than throwing: a SELF-scoped user opening a report they have the
 * permission for should see an empty report, not an error.
 */
export function emptyResult<TRow extends ReportRow, TTotals extends ReportRow>(
  scope: ReportScope,
  totals: TTotals,
): ReportResult<TRow, TTotals> {
  return buildResult<TRow, TTotals>({ scope, rows: [], totals });
}
