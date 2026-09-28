/**
 * Attendance reports.
 *
 * THE PERCENTAGE RULE IS NOT REIMPLEMENTED HERE. Whether a late arrival counts
 * as half a presence, and whether an authorised absence leaves the denominator,
 * are institution settings; `attendancePercentagePpm` in
 * @/server/services/attendance/statistics is the one function that applies them.
 * These reports aggregate COUNTS in SQL and hand them to that function, so the
 * branch dashboard, the group register, the at-risk sweep and this report cannot
 * disagree about what "87%" means. A `count(present)/count(*)` in a report query
 * would quietly be a different number from every other screen.
 *
 * Cancelled lessons are excluded everywhere: a lesson that did not happen must
 * not count against a student, a teacher or a group.
 */

import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import type { DateOnly } from '@/lib/dates';
import {
  attendancePercentagePpm,
  loadAttendanceRule,
  type AttendanceCounts,
} from '@/server/services/attendance/statistics';
import {
  buildResult,
  capRows,
  emptyResult,
  percentSeries,
  REPORT_ROW_CAP,
  resolveReportScope,
  sharePpm,
  truncUnit,
  type ReportFilters,
  type ReportResult,
  type ReportScope,
} from './types';
import { percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type AttendancePeriodRow = {
  readonly period: DateOnly;
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
  readonly records: number;
  readonly ratePpm: number | null;
};

export type AttendanceGroupRow = {
  readonly groupId: string;
  readonly groupName: string;
  readonly groupCode: string;
  readonly branchId: string;
  readonly teacherName: string | null;
  readonly lessons: number;
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
  readonly records: number;
  readonly ratePpm: number | null;
};

export type AttendanceTeacherRow = {
  readonly teacherId: string;
  readonly teacherName: string;
  readonly groups: number;
  readonly lessons: number;
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
  readonly records: number;
  readonly ratePpm: number | null;
};

export type AttendanceAtRiskRow = {
  readonly studentId: string;
  readonly studentCode: string;
  readonly fullName: string;
  readonly branchId: string;
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
  readonly records: number;
  readonly ratePpm: number | null;
  readonly consecutiveAbsences: number;
};

export type TeacherPunctualityRow = {
  readonly teacherId: string;
  readonly teacherName: string;
  readonly lessons: number;
  readonly submitted: number;
  readonly pending: number;
  /** Submitted before the lesson's own end time. */
  readonly onTime: number;
  readonly late: number;
  /** Median delay between a lesson ending and its register being submitted. */
  readonly medianDelayMinutes: number | null;
  readonly submissionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
};

export type AttendanceTotals = {
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
  readonly records: number;
  readonly ratePpm: number | null;
  readonly atRiskBelowPpm: number;
};

export type PunctualityTotals = {
  readonly lessons: number;
  readonly submitted: number;
  readonly pending: number;
  readonly onTime: number;
  readonly late: number;
  readonly submissionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const ATTENDANCE_PERIOD_COLUMNS: readonly ReportColumn<AttendancePeriodRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  { key: 'present', labelKey: 'reports.columns.present', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.late', kind: 'number' },
  { key: 'excused', labelKey: 'reports.columns.excused', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  { key: 'records', labelKey: 'reports.columns.records', kind: 'number' },
  percentColumn<AttendancePeriodRow>('ratePpm', 'reports.columns.attendanceRate'),
];

export const ATTENDANCE_GROUP_COLUMNS: readonly ReportColumn<AttendanceGroupRow>[] = [
  { key: 'groupCode', labelKey: 'reports.columns.groupCode' },
  { key: 'groupName', labelKey: 'reports.columns.group' },
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'lessons', labelKey: 'reports.columns.lessons', kind: 'number' },
  { key: 'present', labelKey: 'reports.columns.present', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.late', kind: 'number' },
  { key: 'excused', labelKey: 'reports.columns.excused', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  percentColumn<AttendanceGroupRow>('ratePpm', 'reports.columns.attendanceRate'),
];

export const ATTENDANCE_TEACHER_COLUMNS: readonly ReportColumn<AttendanceTeacherRow>[] = [
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'groups', labelKey: 'reports.columns.groups', kind: 'number' },
  { key: 'lessons', labelKey: 'reports.columns.lessons', kind: 'number' },
  { key: 'present', labelKey: 'reports.columns.present', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.late', kind: 'number' },
  { key: 'excused', labelKey: 'reports.columns.excused', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  percentColumn<AttendanceTeacherRow>('ratePpm', 'reports.columns.attendanceRate'),
];

export const ATTENDANCE_AT_RISK_COLUMNS: readonly ReportColumn<AttendanceAtRiskRow>[] = [
  { key: 'studentCode', labelKey: 'reports.columns.studentCode' },
  { key: 'fullName', labelKey: 'reports.columns.student' },
  { key: 'present', labelKey: 'reports.columns.present', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.late', kind: 'number' },
  { key: 'excused', labelKey: 'reports.columns.excused', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  percentColumn<AttendanceAtRiskRow>('ratePpm', 'reports.columns.attendanceRate'),
  {
    key: 'consecutiveAbsences',
    labelKey: 'reports.columns.consecutiveAbsences',
    kind: 'number',
  },
];

export const TEACHER_PUNCTUALITY_COLUMNS: readonly ReportColumn<TeacherPunctualityRow>[] = [
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'lessons', labelKey: 'reports.columns.lessons', kind: 'number' },
  { key: 'submitted', labelKey: 'reports.columns.submitted', kind: 'number' },
  { key: 'pending', labelKey: 'reports.columns.pending', kind: 'number' },
  { key: 'onTime', labelKey: 'reports.columns.onTime', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.lateSubmissions', kind: 'number' },
  {
    key: 'medianDelayMinutes',
    labelKey: 'reports.columns.medianDelayMinutes',
    kind: 'number',
  },
  percentColumn<TeacherPunctualityRow>('submissionRatePpm', 'reports.columns.submissionRate'),
  percentColumn<TeacherPunctualityRow>('onTimeRatePpm', 'reports.columns.onTimeRate'),
];

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface StatusTally {
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
}

function counts(row: StatusTally): AttendanceCounts {
  return { present: row.present, late: row.late, excused: row.excused, absent: row.absent };
}

function totalOf(row: StatusTally): number {
  return row.present + row.late + row.excused + row.absent;
}

type Rule = Awaited<ReturnType<typeof loadAttendanceRule>>;

/**
 * The attendance rule is loaded for the report's SINGLE branch when exactly one
 * is in scope, and for the organisation otherwise.
 *
 * A cross-branch report cannot honour per-branch overrides without computing a
 * different percentage per row, which would make the totals row meaningless. So
 * the organisation-level rule is used and the report is honest about being one
 * rule wide.
 */
async function ruleForScope(scope: ReportScope, db: Db): Promise<Rule> {
  const onlyBranch = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;
  return loadAttendanceRule({ organizationId: scope.organizationId, branchId: onlyBranch }, db);
}

function emptyTotals(rule: Rule): AttendanceTotals {
  return {
    present: 0,
    late: 0,
    excused: 0,
    absent: 0,
    records: 0,
    ratePpm: null,
    atRiskBelowPpm: rule.atRiskBelowPercentPpm,
  };
}

function tallyTotals(rows: readonly StatusTally[], rule: Rule): AttendanceTotals {
  const summed: AttendanceCounts = rows.reduce<AttendanceCounts>(
    (acc, row) => ({
      present: acc.present + row.present,
      late: acc.late + row.late,
      excused: acc.excused + row.excused,
      absent: acc.absent + row.absent,
    }),
    { present: 0, late: 0, excused: 0, absent: 0 },
  );
  return {
    ...summed,
    records: summed.present + summed.late + summed.excused + summed.absent,
    ratePpm: attendancePercentagePpm(summed, rule),
    atRiskBelowPpm: rule.atRiskBelowPercentPpm,
  };
}

/**
 * A `date` column comes back as midnight UTC, so the day is read in UTC. A zone
 * conversion here would move a bucket by a day.
 */
function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rates over time
// ---------------------------------------------------------------------------

/**
 * Attendance rate per day, week or month.
 *
 * Bucketed on `Lesson.lessonDate`, which is already the calendar day in the
 * branch's timezone -- a DATE column, so it is compared against date literals
 * rather than the instant range.
 */
export async function attendanceRatesReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<AttendancePeriodRow, AttendanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'attendance.viewAll',
  });
  const rule = await ruleForScope(scope, client);
  if (scope.selfWithoutIdentity) return emptyResult(scope, emptyTotals(rule));

  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{ period: Date; present: number; late: number; excused: number; absent: number }>
  >`
    select
      (date_trunc(
         ${unit}::text,
         l."lessonDate"::timestamp + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date     as "period",
      count(*) filter (where a."status" = 'PRESENT')::int            as "present",
      count(*) filter (where a."status" = 'LATE')::int               as "late",
      count(*) filter (where a."status" = 'EXCUSED')::int            as "excused",
      count(*) filter (where a."status" = 'ABSENT')::int             as "absent"
    from "attendance_records" a
    join "lessons" l on l."id" = a."lessonId"
    left join "groups" g on g."id" = l."groupId"
    where a."organizationId" = ${scope.organizationId}
      and l."status" <> 'CANCELLED'
      and l."lessonDate" >= ${scope.from}::date
      and l."lessonDate" <= ${scope.to}::date
      and (${scope.branchIds}::text[] is null or a."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
      and (${scope.teacherIds}::text[] is null or l."teacherId" = any(${scope.teacherIds}::text[]))
      and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
      and (${scope.ownTeacherId}::text is null or l."teacherId" = ${scope.ownTeacherId}
           or exists (select 1 from "group_teachers" gt
                      where gt."groupId" = l."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                        and gt."endDate" is null))
    group by 1
    order by 1
  `;

  const mapped = rows.map<AttendancePeriodRow>((row) => ({
    period: toDateOnly(row.period),
    ...counts(row),
    records: totalOf(row),
    ratePpm: attendancePercentagePpm(counts(row), rule),
  }));
  const capped = capRows(mapped);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: tallyTotals(capped.rows, rule),
    series: [
      percentSeries(
        'reports.series.attendanceRate',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.ratePpm])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// By group
// ---------------------------------------------------------------------------

/** Attendance by group, worst first: that is the list a head of studies acts on. */
export async function attendanceByGroupReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<AttendanceGroupRow, AttendanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'attendance.viewAll',
  });
  const rule = await ruleForScope(scope, client);
  if (scope.selfWithoutIdentity) return emptyResult(scope, emptyTotals(rule));

  const rows = await client.$queryRaw<
    Array<{
      groupId: string;
      groupName: string;
      groupCode: string;
      branchId: string;
      teacherName: string | null;
      lessons: number;
      present: number;
      late: number;
      excused: number;
      absent: number;
    }>
  >`
    with scoped_lessons as (
      select l."id", l."groupId", l."branchId"
      from "lessons" l
      left join "groups" g on g."id" = l."groupId"
      where l."organizationId" = ${scope.organizationId}
        and l."status" <> 'CANCELLED'
        and l."lessonDate" >= ${scope.from}::date
        and l."lessonDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or l."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.teacherIds}::text[] is null or l."teacherId" = any(${scope.teacherIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or l."teacherId" = ${scope.ownTeacherId}
             or exists (select 1 from "group_teachers" gt
                        where gt."groupId" = l."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                          and gt."endDate" is null))
    ),
    tally as (
      select
        sl."groupId",
        count(distinct sl."id")::int                                 as lessons,
        count(a."id") filter (where a."status" = 'PRESENT')::int      as present,
        count(a."id") filter (where a."status" = 'LATE')::int         as late,
        count(a."id") filter (where a."status" = 'EXCUSED')::int      as excused,
        count(a."id") filter (where a."status" = 'ABSENT')::int       as absent
      from scoped_lessons sl
      left join "attendance_records" a on a."lessonId" = sl."id"
      group by sl."groupId"
    )
    select
      g."id"       as "groupId",
      g."name"     as "groupName",
      g."code"     as "groupCode",
      g."branchId" as "branchId",
      case when u."id" is null then null else (u."firstName" || ' ' || u."lastName") end
                   as "teacherName",
      t.lessons, t.present, t.late, t.excused, t.absent
    from tally t
    join "groups" g on g."id" = t."groupId"
    left join "teachers" te on te."id" = g."primaryTeacherId"
    left join "employees" emp on emp."id" = te."employeeId"
    left join "users" u on u."id" = emp."userId"
    order by (t.present + t.late + t.excused + t.absent) desc, g."name" asc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const mapped = rows.map<AttendanceGroupRow>((row) => ({
    groupId: row.groupId,
    groupName: row.groupName,
    groupCode: row.groupCode,
    branchId: row.branchId,
    teacherName: row.teacherName,
    lessons: row.lessons,
    ...counts(row),
    records: totalOf(row),
    ratePpm: attendancePercentagePpm(counts(row), rule),
  }));
  const capped = capRows(mapped);

  // Sorted in JS by the derived percentage, which SQL cannot compute: the rule
  // that turns counts into a rate lives in TypeScript. The row set is already
  // capped, so this sorts at most REPORT_ROW_CAP entries.
  const ordered = [...capped.rows].sort(byWorstRate);

  return buildResult({
    scope,
    rows: ordered,
    truncated: capped.truncated,
    totals: tallyTotals(ordered, rule),
  });
}

/** Unknown rates sort last: no data is not a bad rate. */
function byWorstRate(
  a: { ratePpm: number | null },
  b: { ratePpm: number | null },
): number {
  return (a.ratePpm ?? Number.MAX_SAFE_INTEGER) - (b.ratePpm ?? Number.MAX_SAFE_INTEGER);
}

// ---------------------------------------------------------------------------
// By teacher
// ---------------------------------------------------------------------------

/**
 * Attendance in each teacher's own lessons.
 *
 * Attributed by `Lesson.teacherId` -- the teacher who actually took the class,
 * not the group's current primary teacher. A substitution must not move last
 * month's numbers onto whoever holds the group today.
 */
export async function attendanceByTeacherReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<AttendanceTeacherRow, AttendanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'attendance.viewAll',
  });
  const rule = await ruleForScope(scope, client);
  if (scope.selfWithoutIdentity) return emptyResult(scope, emptyTotals(rule));

  const rows = await client.$queryRaw<
    Array<{
      teacherId: string;
      teacherName: string;
      groups: number;
      lessons: number;
      present: number;
      late: number;
      excused: number;
      absent: number;
    }>
  >`
    with scoped_lessons as (
      select l."id", l."teacherId", l."groupId"
      from "lessons" l
      left join "groups" g on g."id" = l."groupId"
      where l."organizationId" = ${scope.organizationId}
        and l."status" <> 'CANCELLED'
        and l."teacherId" is not null
        and l."lessonDate" >= ${scope.from}::date
        and l."lessonDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or l."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.teacherIds}::text[] is null or l."teacherId" = any(${scope.teacherIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or l."teacherId" = ${scope.ownTeacherId})
    ),
    tally as (
      select
        sl."teacherId",
        count(distinct sl."groupId")::int                             as groups,
        count(distinct sl."id")::int                                  as lessons,
        count(a."id") filter (where a."status" = 'PRESENT')::int       as present,
        count(a."id") filter (where a."status" = 'LATE')::int          as late,
        count(a."id") filter (where a."status" = 'EXCUSED')::int       as excused,
        count(a."id") filter (where a."status" = 'ABSENT')::int        as absent
      from scoped_lessons sl
      left join "attendance_records" a on a."lessonId" = sl."id"
      group by sl."teacherId"
    )
    select
      t."teacherId"                            as "teacherId",
      (u."firstName" || ' ' || u."lastName")   as "teacherName",
      t.groups, t.lessons, t.present, t.late, t.excused, t.absent
    from tally t
    join "teachers" te on te."id" = t."teacherId"
    join "employees" emp on emp."id" = te."employeeId"
    join "users" u on u."id" = emp."userId"
    order by t.lessons desc, u."lastName" asc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const mapped = rows.map<AttendanceTeacherRow>((row) => ({
    teacherId: row.teacherId,
    teacherName: row.teacherName,
    groups: row.groups,
    lessons: row.lessons,
    ...counts(row),
    records: totalOf(row),
    ratePpm: attendancePercentagePpm(counts(row), rule),
  }));
  const capped = capRows(mapped);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: tallyTotals(capped.rows, rule),
  });
}

// ---------------------------------------------------------------------------
// At risk
// ---------------------------------------------------------------------------

/**
 * Students below the configured threshold, or on a run of absences.
 *
 * The absence streak is a window function rather than a second pass in JS: it is
 * "how many of the most recent lessons, counting back, were absences", which
 * needs the rows in order and would otherwise mean fetching every record.
 *
 * The threshold test happens in TypeScript because the rule that turns counts
 * into a percentage does. The SQL therefore returns every student with a record
 * in the window, ordered by absences, and the cap is applied before filtering --
 * so `truncated` means "there may be further at-risk students below the cut",
 * which is the honest statement.
 */
export async function attendanceAtRiskReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<AttendanceAtRiskRow, AttendanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'attendance.viewAll',
  });
  const rule = await ruleForScope(scope, client);
  if (scope.selfWithoutIdentity) return emptyResult(scope, emptyTotals(rule));

  const { consecutiveAbsenceAlertThreshold } = await loadAlertThreshold(scope, client);

  const rows = await client.$queryRaw<
    Array<{
      studentId: string;
      studentCode: string;
      fullName: string;
      branchId: string;
      present: number;
      late: number;
      excused: number;
      absent: number;
      consecutiveAbsences: number;
    }>
  >`
    with scoped as (
      select
        a."studentId",
        a."status",
        row_number() over (partition by a."studentId" order by l."lessonDate" desc, l."startsAt" desc) as rn
      from "attendance_records" a
      join "lessons" l on l."id" = a."lessonId"
      left join "groups" g on g."id" = l."groupId"
      where a."organizationId" = ${scope.organizationId}
        and l."status" <> 'CANCELLED'
        and l."lessonDate" >= ${scope.from}::date
        and l."lessonDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or a."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.teacherIds}::text[] is null or l."teacherId" = any(${scope.teacherIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or l."teacherId" = ${scope.ownTeacherId}
             or exists (select 1 from "group_teachers" gt
                        where gt."groupId" = l."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                          and gt."endDate" is null))
    ),
    tally as (
      select
        "studentId",
        count(*) filter (where "status" = 'PRESENT')::int as present,
        count(*) filter (where "status" = 'LATE')::int    as late,
        count(*) filter (where "status" = 'EXCUSED')::int as excused,
        count(*) filter (where "status" = 'ABSENT')::int  as absent,
        -- The current streak: rows before the first non-absence, or all of them.
        greatest(
          coalesce(min(rn) filter (where "status" <> 'ABSENT') - 1, max(rn)),
          0
        )::int                                           as consecutive_absences
      from scoped
      group by "studentId"
    )
    select
      s."id"                                 as "studentId",
      s."studentCode"                        as "studentCode",
      (s."firstName" || ' ' || s."lastName") as "fullName",
      s."branchId"                           as "branchId",
      t.present, t.late, t.excused, t.absent,
      t.consecutive_absences                 as "consecutiveAbsences"
    from tally t
    join "students" s on s."id" = t."studentId"
    where s."deletedAt" is null and s."status" = 'ACTIVE'
    order by t.absent desc, t.consecutive_absences desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(rows);
  const atRisk = capped.rows
    .map<AttendanceAtRiskRow>((row) => ({
      studentId: row.studentId,
      studentCode: row.studentCode,
      fullName: row.fullName,
      branchId: row.branchId,
      ...counts(row),
      records: totalOf(row),
      ratePpm: attendancePercentagePpm(counts(row), rule),
      consecutiveAbsences: row.consecutiveAbsences,
    }))
    .filter(
      (row) =>
        // An unknown rate is never at risk: absence of data is not evidence.
        (row.ratePpm !== null && row.ratePpm < rule.atRiskBelowPercentPpm) ||
        row.consecutiveAbsences >= consecutiveAbsenceAlertThreshold,
    )
    .sort(byWorstRate);

  return buildResult({
    scope,
    rows: atRisk,
    truncated: capped.truncated,
    totals: tallyTotals(atRisk, rule),
  });
}

async function loadAlertThreshold(
  scope: ReportScope,
  db: Db,
): Promise<{ consecutiveAbsenceAlertThreshold: number }> {
  const onlyBranch = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;
  return getSettings(
    ['consecutiveAbsenceAlertThreshold'],
    { organizationId: scope.organizationId, branchId: onlyBranch },
    db,
  );
}

// ---------------------------------------------------------------------------
// Teacher submission punctuality
// ---------------------------------------------------------------------------

/**
 * How promptly each teacher submits their register.
 *
 * "On time" means submitted before the lesson's own `endsAt`. That is a stricter
 * bar than the institution's edit window and the right one for this report: the
 * question is whether the register was taken in the room, not whether it was
 * still legal to change it.
 *
 * The median delay is `percentile_cont` in SQL rather than a mean, because one
 * register submitted a fortnight late would drag an average into meaninglessness
 * while the median still describes the habit.
 */
export async function teacherPunctualityReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<TeacherPunctualityRow, PunctualityTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'attendance.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, {
      lessons: 0,
      submitted: 0,
      pending: 0,
      onTime: 0,
      late: 0,
      submissionRatePpm: null,
      onTimeRatePpm: null,
    });
  }

  const rows = await client.$queryRaw<
    Array<{
      teacherId: string;
      teacherName: string;
      lessons: number;
      submitted: number;
      pending: number;
      onTime: number;
      late: number;
      medianDelayMinutes: number | null;
    }>
  >`
    with scoped_lessons as (
      select
        l."teacherId",
        l."attendanceStatus",
        l."attendanceSubmittedAt",
        l."endsAt"
      from "lessons" l
      left join "groups" g on g."id" = l."groupId"
      where l."organizationId" = ${scope.organizationId}
        and l."status" <> 'CANCELLED'
        and l."attendanceStatus" <> 'NOT_REQUIRED'
        and l."teacherId" is not null
        and l."lessonDate" >= ${scope.from}::date
        and l."lessonDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or l."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.teacherIds}::text[] is null or l."teacherId" = any(${scope.teacherIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or l."teacherId" = ${scope.ownTeacherId})
    ),
    tally as (
      select
        "teacherId",
        count(*)::int                                                         as lessons,
        count(*) filter (where "attendanceSubmittedAt" is not null)::int       as submitted,
        count(*) filter (where "attendanceStatus" = 'PENDING')::int            as pending,
        count(*) filter (
          where "attendanceSubmittedAt" is not null and "attendanceSubmittedAt" <= "endsAt"
        )::int                                                                as on_time,
        count(*) filter (
          where "attendanceSubmittedAt" is not null and "attendanceSubmittedAt" > "endsAt"
        )::int                                                                as late,
        percentile_cont(0.5) within group (
          order by extract(epoch from ("attendanceSubmittedAt" - "endsAt")) / 60
        ) filter (where "attendanceSubmittedAt" is not null)                   as median_delay_minutes
      from scoped_lessons
      group by "teacherId"
    )
    select
      t."teacherId"                          as "teacherId",
      (u."firstName" || ' ' || u."lastName") as "teacherName",
      t.lessons, t.submitted, t.pending, t.on_time as "onTime", t.late,
      round(t.median_delay_minutes)::int      as "medianDelayMinutes"
    from tally t
    join "teachers" te on te."id" = t."teacherId"
    join "employees" emp on emp."id" = te."employeeId"
    join "users" u on u."id" = emp."userId"
    order by t.pending desc, t.late desc, u."lastName" asc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<TeacherPunctualityRow>((row) => ({
      teacherId: row.teacherId,
      teacherName: row.teacherName,
      lessons: row.lessons,
      submitted: row.submitted,
      pending: row.pending,
      onTime: row.onTime,
      late: row.late,
      medianDelayMinutes: row.medianDelayMinutes,
      submissionRatePpm: sharePpm(row.submitted, row.lessons),
      onTimeRatePpm: sharePpm(row.onTime, row.submitted),
    })),
  );

  const lessons = capped.rows.reduce((sum, row) => sum + row.lessons, 0);
  const submitted = capped.rows.reduce((sum, row) => sum + row.submitted, 0);
  const onTime = capped.rows.reduce((sum, row) => sum + row.onTime, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      lessons,
      submitted,
      pending: capped.rows.reduce((sum, row) => sum + row.pending, 0),
      onTime,
      late: capped.rows.reduce((sum, row) => sum + row.late, 0),
      submissionRatePpm: sharePpm(submitted, lessons),
      onTimeRatePpm: sharePpm(onTime, submitted),
    },
  });
}
