/**
 * Student-body reports: headcount, movement, composition and retention.
 *
 * Three things are worth stating before reading the SQL:
 *
 *   DATE COLUMNS ARE COMPARED AS DATES. `Student.enrolledAt` is a timestamptz and
 *   is bucketed by converting it to the institution's wall clock first;
 *   `Enrollment.startDate` is a `@db.Date` and is compared against date literals.
 *   Comparing a DATE column against a timestamptz instant range happens to work
 *   for a positive UTC offset and silently drops a day for a negative one, so the
 *   two kinds of column are handled differently on purpose.
 *
 *   A SELF-SCOPED CALLER IS NARROWED. A teacher holds `reports.view`, so nothing
 *   in the permission check stops them opening this report; the `self_visible`
 *   predicate reproduces `selfStudentFilter` in SQL so they see their own
 *   students' figures and not the branch's.
 *
 *   SHARES ARE WITHIN A DIMENSION. A student enrolled on two programmes is
 *   counted under both, so the denominator for a share is the dimension's own
 *   total rather than the headcount -- otherwise the programme column would add
 *   up to more than 100% and read as a bug.
 */

import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import type { DateOnly } from '@/lib/dates';
import {
  buildResult,
  capRows,
  countSeries,
  emptyResult,
  REPORT_ROW_CAP,
  resolveReportScope,
  selfHasNoIdentity,
  sharePpm,
  truncUnit,
  type ReportFilters,
  type ReportResult,
  type ReportScope,
} from './types';
import { percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Row and totals shapes
//
// Declared as type ALIASES, not interfaces, so they carry an implicit index
// signature and stay assignable to `ReportRow`. See the note in ./types.ts.
// ---------------------------------------------------------------------------

export type StudentMovementRow = {
  readonly period: DateOnly;
  readonly enrolled: number;
  readonly withdrawn: number;
  readonly graduated: number;
  readonly transferred: number;
  readonly netChange: number;
};

export type StudentOverviewTotals = {
  readonly total: number;
  readonly active: number;
  readonly inactive: number;
  readonly prospects: number;
  readonly onHold: number;
  readonly suspended: number;
  readonly enrolled: number;
  readonly withdrawn: number;
  readonly graduated: number;
  readonly transferred: number;
  readonly netChange: number;
};

export type StudentDistributionRow = {
  /** Which axis this row belongs to: `branch`, `program`, `level`, `gender`, `ageBand`. */
  readonly dimension: string;
  /** Stable identifier: a branch/program id, an enum value, or an age-band key. */
  readonly key: string;
  /** Human label where the database holds one (branch and programme names). */
  readonly label: string | null;
  readonly students: number;
  /** Share of this dimension's own total, in parts-per-million. */
  readonly sharePpm: number | null;
};

export type StudentRetentionRow = {
  readonly period: DateOnly;
  readonly cohort: number;
  readonly retained: number;
  readonly retentionPpm: number | null;
};

// ---------------------------------------------------------------------------
// Columns, for the table header and the CSV exporter
// ---------------------------------------------------------------------------

export const STUDENT_MOVEMENT_COLUMNS: readonly ReportColumn<StudentMovementRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  { key: 'enrolled', labelKey: 'reports.columns.enrolled', kind: 'number' },
  { key: 'withdrawn', labelKey: 'reports.columns.withdrawn', kind: 'number' },
  { key: 'graduated', labelKey: 'reports.columns.graduated', kind: 'number' },
  { key: 'transferred', labelKey: 'reports.columns.transferred', kind: 'number' },
  { key: 'netChange', labelKey: 'reports.columns.netChange', kind: 'number' },
];

export const STUDENT_DISTRIBUTION_COLUMNS: readonly ReportColumn<StudentDistributionRow>[] = [
  { key: 'dimension', labelKey: 'reports.columns.dimension' },
  { key: 'label', labelKey: 'reports.columns.name' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<StudentDistributionRow>('sharePpm', 'reports.columns.share'),
];

export const STUDENT_RETENTION_COLUMNS: readonly ReportColumn<StudentRetentionRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  { key: 'cohort', labelKey: 'reports.columns.cohort', kind: 'number' },
  { key: 'retained', labelKey: 'reports.columns.retained', kind: 'number' },
  percentColumn<StudentRetentionRow>('retentionPpm', 'reports.columns.retention'),
];

const EMPTY_OVERVIEW_TOTALS: StudentOverviewTotals = {
  total: 0,
  active: 0,
  inactive: 0,
  prospects: 0,
  onHold: 0,
  suspended: 0,
  enrolled: 0,
  withdrawn: 0,
  graduated: 0,
  transferred: 0,
  netChange: 0,
};

// ---------------------------------------------------------------------------
// Overview: headcount now, movement over the period
// ---------------------------------------------------------------------------

interface HeadcountRow {
  readonly total: number;
  readonly active: number;
  readonly prospects: number;
  readonly onHold: number;
  readonly suspended: number;
  readonly enrolled: number;
  readonly withdrawn: number;
  readonly graduated: number;
}

interface MovementRawRow {
  readonly period: Date;
  readonly enrolled: number;
  readonly withdrawn: number;
  readonly graduated: number;
}

/**
 * Headcount, movement and an enrolment trend.
 *
 * `total`/`active` are as-of-now figures; `enrolled`/`withdrawn`/`graduated`/
 * `transferred` are movements inside the requested period. Mixing the two on one
 * screen is what a head of studies actually wants ("we have 412 students, 38
 * joined and 9 left this month"), but they answer different questions and the
 * field names say which.
 */
export async function studentsOverviewReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<StudentMovementRow, StudentOverviewTotals>> {
  requirePermission(ctx, 'reports.view');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  if (selfHasNoIdentity(scope)) return emptyResult(scope, EMPTY_OVERVIEW_TOTALS);

  const s = selfParams(scope);
  const unit = truncUnit(scope.granularity);

  const [headcount, movement, transferred] = await Promise.all([
    client.$queryRaw<HeadcountRow[]>`
      select
        count(*)::int                                                       as "total",
        count(*) filter (where s."status" = 'ACTIVE')::int                  as "active",
        count(*) filter (where s."status" = 'PROSPECT')::int                as "prospects",
        count(*) filter (where s."status" = 'ON_HOLD')::int                 as "onHold",
        count(*) filter (where s."status" = 'SUSPENDED')::int               as "suspended",
        count(*) filter (
          where s."enrolledAt" >= ${scope.fromInstant} and s."enrolledAt" < ${scope.toExclusive}
        )::int                                                              as "enrolled",
        count(*) filter (
          where s."withdrawnAt" >= ${scope.fromInstant} and s."withdrawnAt" < ${scope.toExclusive}
        )::int                                                              as "withdrawn",
        count(*) filter (
          where s."graduatedAt" >= ${scope.fromInstant} and s."graduatedAt" < ${scope.toExclusive}
        )::int                                                              as "graduated"
      from "students" s
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or exists (
              select 1 from "enrollments" e
              where e."studentId" = s."id" and e."groupId" = any(${scope.groupIds}::text[])))
        and (${scope.programIds}::text[] is null or exists (
              select 1 from "enrollments" e join "groups" g on g."id" = e."groupId"
              where e."studentId" = s."id" and g."programId" = any(${scope.programIds}::text[])))
        and (not ${s.restricted}::boolean or (
              (${s.studentId}::text is not null and s."id" = ${s.studentId})
              or (${s.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id" and sg."guardianId" = ${s.guardianId}))
              or (${s.teacherId}::text is not null and exists (
                    select 1 from "enrollments" e
                    join "group_teachers" gt on gt."groupId" = e."groupId"
                    where e."studentId" = s."id" and e."endDate" is null
                      and gt."teacherId" = ${s.teacherId} and gt."endDate" is null))))
    `,
    // Movement is bucketed on the institution's wall clock, not UTC: a student
    // enrolled at 23:30 Tashkent time belongs to that day's bucket.
    client.$queryRaw<MovementRawRow[]>`
      with moved as (
        select
          s."enrolledAt"  as enrolled_at,
          s."withdrawnAt" as withdrawn_at,
          s."graduatedAt" as graduated_at
        from "students" s
        where s."organizationId" = ${scope.organizationId}
          and s."deletedAt" is null
          and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
          and (not ${s.restricted}::boolean or (
                (${s.studentId}::text is not null and s."id" = ${s.studentId})
                or (${s.guardianId}::text is not null and exists (
                      select 1 from "student_guardians" sg
                      where sg."studentId" = s."id" and sg."guardianId" = ${s.guardianId}))
                or (${s.teacherId}::text is not null and exists (
                      select 1 from "enrollments" e
                      join "group_teachers" gt on gt."groupId" = e."groupId"
                      where e."studentId" = s."id" and e."endDate" is null
                        and gt."teacherId" = ${s.teacherId} and gt."endDate" is null))))
      ),
      events as (
        select 'enrolled'::text as kind, enrolled_at as at from moved where enrolled_at is not null
        union all
        select 'withdrawn', withdrawn_at from moved where withdrawn_at is not null
        union all
        select 'graduated', graduated_at from moved where graduated_at is not null
      )
      select
        (date_trunc(
           ${unit}::text,
           (at at time zone ${scope.timezone}::text) + ${scope.weekShiftDays}::int * interval '1 day'
         ) - ${scope.weekShiftDays}::int * interval '1 day')::date       as "period",
        count(*) filter (where kind = 'enrolled')::int                   as "enrolled",
        count(*) filter (where kind = 'withdrawn')::int                  as "withdrawn",
        count(*) filter (where kind = 'graduated')::int                  as "graduated"
      from events
      where at >= ${scope.fromInstant} and at < ${scope.toExclusive}
      group by 1
      order by 1
    `,
    // Transfers live on the enrollment, not the student: a transfer closes one
    // enrollment and opens another, and `endDate` is a DATE column.
    client.$queryRaw<Array<{ period: Date; transferred: number }>>`
      select
        (date_trunc(
           ${unit}::text,
           e."endDate"::timestamp + ${scope.weekShiftDays}::int * interval '1 day'
         ) - ${scope.weekShiftDays}::int * interval '1 day')::date       as "period",
        count(distinct e."studentId")::int                               as "transferred"
      from "enrollments" e
      join "students" s on s."id" = e."studentId"
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and e."endReason" = 'TRANSFERRED_OUT'
        and e."endDate" >= ${scope.from}::date
        and e."endDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
        and (not ${s.restricted}::boolean or (
              (${s.studentId}::text is not null and s."id" = ${s.studentId})
              or (${s.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id" and sg."guardianId" = ${s.guardianId}))
              or (${s.teacherId}::text is not null and exists (
                    select 1 from "group_teachers" gt
                    where gt."groupId" = e."groupId" and gt."teacherId" = ${s.teacherId}
                      and gt."endDate" is null))))
      group by 1
      order by 1
    `,
  ]);

  const transferredByPeriod = new Map<DateOnly, number>(
    transferred.map((row) => [toDateOnly(row.period), row.transferred]),
  );

  const byPeriod = new Map<DateOnly, StudentMovementRow>();
  for (const row of movement) {
    const period = toDateOnly(row.period);
    byPeriod.set(period, {
      period,
      enrolled: row.enrolled,
      withdrawn: row.withdrawn,
      graduated: row.graduated,
      transferred: transferredByPeriod.get(period) ?? 0,
      netChange: row.enrolled - row.withdrawn - row.graduated,
    });
  }
  // A period with transfers but no joins or leavers still deserves a row.
  for (const [period, count] of transferredByPeriod) {
    if (byPeriod.has(period)) continue;
    byPeriod.set(period, {
      period,
      enrolled: 0,
      withdrawn: 0,
      graduated: 0,
      transferred: count,
      netChange: 0,
    });
  }

  const ordered = [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  const capped = capRows(ordered);

  const head = headcount[0];
  const transferredTotal = [...transferredByPeriod.values()].reduce((a, b) => a + b, 0);
  const totals: StudentOverviewTotals = {
    total: head?.total ?? 0,
    active: head?.active ?? 0,
    inactive: (head?.total ?? 0) - (head?.active ?? 0),
    prospects: head?.prospects ?? 0,
    onHold: head?.onHold ?? 0,
    suspended: head?.suspended ?? 0,
    enrolled: head?.enrolled ?? 0,
    withdrawn: head?.withdrawn ?? 0,
    graduated: head?.graduated ?? 0,
    transferred: transferredTotal,
    netChange: (head?.enrolled ?? 0) - (head?.withdrawn ?? 0) - (head?.graduated ?? 0),
  };

  return buildResult({
    scope,
    rows: capped.rows,
    totals,
    truncated: capped.truncated,
    series: [
      countSeries(
        'reports.series.enrolled',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.enrolled])),
      ),
      countSeries(
        'reports.series.withdrawn',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.withdrawn])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

interface DistributionRawRow {
  readonly dimension: string;
  readonly key: string;
  readonly label: string | null;
  readonly students: number;
}

export type StudentDistributionTotals = {
  readonly students: number;
};

/**
 * Composition of the active student body across five axes in one round trip.
 *
 * A UNION ALL rather than five queries: the axes share the same scope predicate
 * and the same candidate set, and one plan means the five columns of a
 * composition screen cannot disagree about the headcount they are shares of.
 *
 * Age is computed as of the period's end date, not today, so a report re-run next
 * year reproduces the same bands.
 */
export async function studentsDistributionReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<StudentDistributionRow, StudentDistributionTotals>> {
  requirePermission(ctx, 'reports.view');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  if (selfHasNoIdentity(scope)) return emptyResult(scope, { students: 0 });

  const s = selfParams(scope);

  const rows = await client.$queryRaw<DistributionRawRow[]>`
    with visible as (
      select s."id", s."branchId", s."gender", s."dateOfBirth"
      from "students" s
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and s."status" in ('ACTIVE', 'ON_HOLD')
        and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
        and (not ${s.restricted}::boolean or (
              (${s.studentId}::text is not null and s."id" = ${s.studentId})
              or (${s.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id" and sg."guardianId" = ${s.guardianId}))
              or (${s.teacherId}::text is not null and exists (
                    select 1 from "enrollments" e
                    join "group_teachers" gt on gt."groupId" = e."groupId"
                    where e."studentId" = s."id" and e."endDate" is null
                      and gt."teacherId" = ${s.teacherId} and gt."endDate" is null))))
    ),
    placements as (
      select v."id" as student_id, g."programId", coalesce(g."level", p."level") as level
      from visible v
      join "enrollments" e on e."studentId" = v."id" and e."endDate" is null
      join "groups" g on g."id" = e."groupId"
      left join "programs" p on p."id" = g."programId"
      where (${scope.groupIds}::text[] is null or e."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
    )
    select 'branch'::text as "dimension", v."branchId" as "key", b."name" as "label",
           count(*)::int as "students"
    from visible v join "branches" b on b."id" = v."branchId"
    group by 1, 2, 3
    union all
    select 'program', pl."programId", pr."name", count(distinct pl.student_id)::int
    from placements pl join "programs" pr on pr."id" = pl."programId"
    where pl."programId" is not null
    group by 1, 2, 3
    union all
    select 'level', pl.level::text, null, count(distinct pl.student_id)::int
    from placements pl
    where pl.level is not null
    group by 1, 2, 3
    union all
    select 'gender', v."gender"::text, null, count(*)::int
    from visible v
    group by 1, 2, 3
    union all
    select 'ageBand',
           case
             when v."dateOfBirth" is null then 'UNKNOWN'
             when extract(year from age(${scope.to}::date, v."dateOfBirth")) < 7  then 'UNDER_7'
             when extract(year from age(${scope.to}::date, v."dateOfBirth")) < 13 then 'AGE_7_12'
             when extract(year from age(${scope.to}::date, v."dateOfBirth")) < 18 then 'AGE_13_17'
             when extract(year from age(${scope.to}::date, v."dateOfBirth")) < 25 then 'AGE_18_24'
             else 'AGE_25_PLUS'
           end,
           null,
           count(*)::int
    from visible v
    group by 1, 2, 3
    order by 1, 4 desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const dimensionTotals = new Map<string, number>();
  for (const row of rows) {
    dimensionTotals.set(row.dimension, (dimensionTotals.get(row.dimension) ?? 0) + row.students);
  }

  const capped = capRows(
    rows.map<StudentDistributionRow>((row) => ({
      dimension: row.dimension,
      key: row.key,
      label: row.label,
      students: row.students,
      sharePpm: sharePpm(row.students, dimensionTotals.get(row.dimension) ?? 0),
    })),
  );

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    // The headcount, taken from the branch axis: every visible student has
    // exactly one branch, so that axis alone sums to the true total.
    totals: { students: dimensionTotals.get('branch') ?? 0 },
  });
}


// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export type StudentRetentionTotals = {
  readonly cohort: number;
  readonly retained: number;
  readonly retentionPpm: number | null;
};

/**
 * Cohort retention: of the students who first enrolled in each period, how many
 * still hold an open enrollment at the end of the window.
 *
 * "First enrolled" is the minimum `Enrollment.startDate`, not `Student.createdAt`:
 * a prospect created in January who enrolled in September belongs to September's
 * cohort, and the enrolment date is the one the institution measures against.
 */
export async function studentsRetentionReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<StudentRetentionRow, StudentRetentionTotals>> {
  requirePermission(ctx, 'reports.view');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  if (selfHasNoIdentity(scope)) {
    return emptyResult(scope, { cohort: 0, retained: 0, retentionPpm: null });
  }

  const s = selfParams(scope);
  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{ period: Date; cohort: number; retained: number }>
  >`
    with visible as (
      select s."id"
      from "students" s
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
        and (not ${s.restricted}::boolean or (
              (${s.studentId}::text is not null and s."id" = ${s.studentId})
              or (${s.guardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id" and sg."guardianId" = ${s.guardianId}))
              or (${s.teacherId}::text is not null and exists (
                    select 1 from "enrollments" e
                    join "group_teachers" gt on gt."groupId" = e."groupId"
                    where e."studentId" = s."id" and e."endDate" is null
                      and gt."teacherId" = ${s.teacherId} and gt."endDate" is null))))
    ),
    cohorts as (
      select
        e."studentId",
        min(e."startDate") as started
      from "enrollments" e
      join visible v on v."id" = e."studentId"
      join "groups" g on g."id" = e."groupId"
      where (${scope.groupIds}::text[] is null or e."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
      group by e."studentId"
    )
    select
      (date_trunc(
         ${unit}::text,
         c.started::timestamp + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date         as "period",
      count(*)::int                                                      as "cohort",
      count(*) filter (where exists (
        select 1 from "enrollments" e2
        where e2."studentId" = c."studentId"
          and e2."startDate" <= ${scope.to}::date
          and (e2."endDate" is null or e2."endDate" >= ${scope.to}::date)
      ))::int                                                            as "retained"
    from cohorts c
    where c.started >= ${scope.from}::date and c.started <= ${scope.to}::date
    group by 1
    order by 1
  `;

  const capped = capRows(
    rows.map<StudentRetentionRow>((row) => ({
      period: toDateOnly(row.period),
      cohort: row.cohort,
      retained: row.retained,
      retentionPpm: sharePpm(row.retained, row.cohort),
    })),
  );

  const cohort = capped.rows.reduce((sum, row) => sum + row.cohort, 0);
  const retained = capped.rows.reduce((sum, row) => sum + row.retained, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: { cohort, retained, retentionPpm: sharePpm(retained, cohort) },
    series: [
      countSeries(
        'reports.series.cohort',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.cohort])),
      ),
      countSeries(
        'reports.series.retained',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.retained])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * The SELF narrowing as raw-SQL parameters.
 *
 * All four are passed on every query even when unused, because a parameter that
 * is sometimes absent means two different SQL strings and two different plans.
 * `restricted` false makes the whole predicate a no-op.
 */
function selfParams(scope: ReportScope): {
  restricted: boolean;
  studentId: string | null;
  guardianId: string | null;
  teacherId: string | null;
} {
  return {
    restricted: scope.self.restricted,
    studentId: scope.self.studentId,
    guardianId: scope.self.guardianId,
    teacherId: scope.self.teacherId,
  };
}

/**
 * A `date` column round-trips through the driver as midnight UTC, so UTC
 * extraction is the correct read and a zone conversion here would shift the day.
 * Same reasoning as `prismaDateToDateOnly` in @/lib/dates.
 */
function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}
