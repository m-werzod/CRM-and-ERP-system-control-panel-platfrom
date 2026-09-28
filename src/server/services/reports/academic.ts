/**
 * Academic performance reports: grades, exams, subjects, teachers, homework.
 *
 * SCORES ARE STORED WITH THE MAXIMUM THAT WAS IN FORCE. `Grade.score/maxScore` and
 * `ExamResult.score/maxScore` are snapshots, which is why a percentage here is
 * `sum(score) / sum(maxScore)` over the rows rather than `avg(score) / today's
 * maxScore`. Re-scaling an exam from 50 to 100 marks next term must not move last
 * term's averages.
 *
 * AN ABSENCE IS NOT A ZERO. `ExamResult.isAbsent` rows are excluded from averages
 * and from pass rates -- a student who did not sit the paper has no score, and
 * folding them in as zeros would make an exam look harder than it was. They are
 * counted separately so the absence itself stays visible.
 *
 * Percentages are integer parts-per-million throughout, the project's
 * representation, so a pass rate here is comparable with one computed anywhere
 * else.
 */

import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import type { DateOnly } from '@/lib/dates';
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
} from './types';
import { percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type GradeDistributionRow = {
  /** `band` for a grading-scale label, `decile` for the 10%-wide score buckets. */
  readonly dimension: string;
  readonly key: string;
  readonly label: string;
  readonly sequence: number;
  readonly grades: number;
  readonly sharePpm: number | null;
};

export type GradeDistributionTotals = {
  readonly grades: number;
  readonly students: number;
  readonly averagePercentPpm: number | null;
  readonly passRatePpm: number | null;
};

export type ExamPerformanceRow = {
  readonly examId: string;
  readonly title: string;
  readonly type: string;
  readonly scheduledOn: DateOnly;
  readonly groupName: string | null;
  readonly subjectName: string | null;
  readonly teacherName: string | null;
  readonly sat: number;
  readonly absent: number;
  readonly maxScore: number;
  readonly averageScore: number | null;
  readonly averagePercentPpm: number | null;
  readonly passed: number;
  readonly passRatePpm: number | null;
};

export type ExamPerformanceTotals = {
  readonly exams: number;
  readonly sat: number;
  readonly absent: number;
  readonly passed: number;
  readonly averagePercentPpm: number | null;
  readonly passRatePpm: number | null;
};

export type SubjectPerformanceRow = {
  readonly subjectId: string;
  readonly subjectName: string;
  readonly subjectCode: string;
  readonly grades: number;
  readonly students: number;
  readonly averagePercentPpm: number | null;
  readonly passRatePpm: number | null;
};

export type TeacherPerformanceRow = {
  readonly teacherId: string;
  readonly teacherName: string;
  readonly groups: number;
  readonly grades: number;
  readonly students: number;
  readonly averagePercentPpm: number | null;
  readonly passRatePpm: number | null;
};

export type PerformanceTotals = {
  readonly grades: number;
  readonly students: number;
  readonly averagePercentPpm: number | null;
  readonly passRatePpm: number | null;
};

export type HomeworkCompletionRow = {
  readonly period: DateOnly;
  readonly assignments: number;
  readonly expected: number;
  readonly submitted: number;
  readonly late: number;
  readonly graded: number;
  readonly notSubmitted: number;
  readonly submissionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
  readonly gradedRatePpm: number | null;
};

export type HomeworkCompletionTotals = {
  readonly assignments: number;
  readonly expected: number;
  readonly submitted: number;
  readonly late: number;
  readonly graded: number;
  readonly submissionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
  readonly gradedRatePpm: number | null;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const GRADE_DISTRIBUTION_COLUMNS: readonly ReportColumn<GradeDistributionRow>[] = [
  { key: 'dimension', labelKey: 'reports.columns.dimension' },
  { key: 'label', labelKey: 'reports.columns.grade' },
  { key: 'grades', labelKey: 'reports.columns.count', kind: 'number' },
  percentColumn<GradeDistributionRow>('sharePpm', 'reports.columns.share'),
];

export const EXAM_PERFORMANCE_COLUMNS: readonly ReportColumn<ExamPerformanceRow>[] = [
  { key: 'scheduledOn', labelKey: 'reports.columns.date', kind: 'date' },
  { key: 'title', labelKey: 'reports.columns.exam' },
  { key: 'groupName', labelKey: 'reports.columns.group' },
  { key: 'subjectName', labelKey: 'reports.columns.subject' },
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'sat', labelKey: 'reports.columns.sat', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  { key: 'averageScore', labelKey: 'reports.columns.averageScore', kind: 'number' },
  percentColumn<ExamPerformanceRow>('averagePercentPpm', 'reports.columns.averagePercent'),
  percentColumn<ExamPerformanceRow>('passRatePpm', 'reports.columns.passRate'),
];

export const SUBJECT_PERFORMANCE_COLUMNS: readonly ReportColumn<SubjectPerformanceRow>[] = [
  { key: 'subjectCode', labelKey: 'reports.columns.subjectCode' },
  { key: 'subjectName', labelKey: 'reports.columns.subject' },
  { key: 'grades', labelKey: 'reports.columns.grades', kind: 'number' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<SubjectPerformanceRow>('averagePercentPpm', 'reports.columns.averagePercent'),
  percentColumn<SubjectPerformanceRow>('passRatePpm', 'reports.columns.passRate'),
];

export const TEACHER_PERFORMANCE_COLUMNS: readonly ReportColumn<TeacherPerformanceRow>[] = [
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'groups', labelKey: 'reports.columns.groups', kind: 'number' },
  { key: 'grades', labelKey: 'reports.columns.grades', kind: 'number' },
  { key: 'students', labelKey: 'reports.columns.students', kind: 'number' },
  percentColumn<TeacherPerformanceRow>('averagePercentPpm', 'reports.columns.averagePercent'),
  percentColumn<TeacherPerformanceRow>('passRatePpm', 'reports.columns.passRate'),
];

export const HOMEWORK_COMPLETION_COLUMNS: readonly ReportColumn<HomeworkCompletionRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  { key: 'assignments', labelKey: 'reports.columns.assignments', kind: 'number' },
  { key: 'expected', labelKey: 'reports.columns.expected', kind: 'number' },
  { key: 'submitted', labelKey: 'reports.columns.submitted', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.lateSubmissions', kind: 'number' },
  { key: 'graded', labelKey: 'reports.columns.graded', kind: 'number' },
  percentColumn<HomeworkCompletionRow>('submissionRatePpm', 'reports.columns.submissionRate'),
  percentColumn<HomeworkCompletionRow>('onTimeRatePpm', 'reports.columns.onTimeRate'),
  percentColumn<HomeworkCompletionRow>('gradedRatePpm', 'reports.columns.gradedRate'),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/**
 * A percentage from two float sums, in parts-per-million.
 *
 * `Grade.score`/`maxScore` are `Float` in the schema (a grade of 8.5 out of 10 is
 * normal), so this one calculation is unavoidably floating point -- unlike money,
 * where it never is. Rounding to an integer ppm at the boundary keeps the reported
 * figure stable regardless of accumulation order.
 */
function percentOf(score: number | null, max: number | null): number | null {
  if (score === null || max === null || max <= 0) return null;
  return Math.round((score / max) * 1_000_000);
}

// ---------------------------------------------------------------------------
// Grade distribution
// ---------------------------------------------------------------------------

/**
 * How grades are distributed, by grading-scale band and by score decile.
 *
 * Both axes are returned because they answer different questions. The BAND axis is
 * what the institution reports ("eleven students got a Distinction") and depends
 * on whichever scale was in force; the DECILE axis is scale-independent and is the
 * one that shows a suspiciously flat or bimodal cohort. A band row exists only
 * where a grade carried a label, so a gradebook with no scale configured shows
 * deciles and no bands rather than a silent empty report.
 */
export async function academicGradeDistributionReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<GradeDistributionRow, GradeDistributionTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'grades.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, { grades: 0, students: 0, averagePercentPpm: null, passRatePpm: null });
  }

  const rows = await client.$queryRaw<
    Array<{
      dimension: string;
      key: string;
      label: string;
      sequence: number;
      grades: number;
      students: number;
      scoreSum: number | null;
      maxSum: number | null;
      passed: number;
    }>
  >`
    with scoped as (
      select
        gr."id", gr."studentId", gr."score", gr."maxScore", gr."gradeLabel", gr."isPass"
      from "grades" gr
      left join "groups" g on g."id" = gr."groupId"
      left join "students" st on st."id" = gr."studentId"
      where gr."organizationId" = ${scope.organizationId}
        and gr."gradedAt" >= ${scope.fromInstant}
        and gr."gradedAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null or st."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or gr."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or exists (
              select 1 from "group_teachers" gt
              where gt."groupId" = gr."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                and gt."endDate" is null))
    )
    select 'band'::text as "dimension", s."gradeLabel" as "key", s."gradeLabel" as "label",
           0 as "sequence",
           count(*)::int as "grades",
           count(distinct s."studentId")::int as "students",
           sum(s."score")::float8 as "scoreSum",
           sum(s."maxScore")::float8 as "maxSum",
           count(*) filter (where s."isPass")::int as "passed"
    from scoped s
    where s."gradeLabel" is not null
    group by 1, 2, 3, 4
    union all
    select 'decile',
           (least(floor(s."score" / s."maxScore" * 10)::int, 9))::text,
           (least(floor(s."score" / s."maxScore" * 10)::int, 9) * 10)::text || '-'
             || (least(floor(s."score" / s."maxScore" * 10)::int, 9) * 10 + 10)::text || '%',
           least(floor(s."score" / s."maxScore" * 10)::int, 9),
           count(*)::int,
           count(distinct s."studentId")::int,
           sum(s."score")::float8,
           sum(s."maxScore")::float8,
           count(*) filter (where s."isPass")::int
    from scoped s
    group by 1, 2, 3, 4
    order by 1, 4, 5 desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const dimensionTotals = new Map<string, number>();
  for (const row of rows) {
    dimensionTotals.set(row.dimension, (dimensionTotals.get(row.dimension) ?? 0) + row.grades);
  }

  const capped = capRows(
    rows.map<GradeDistributionRow>((row) => ({
      dimension: row.dimension,
      key: row.key,
      label: row.label,
      sequence: row.sequence,
      grades: row.grades,
      sharePpm: sharePpm(row.grades, dimensionTotals.get(row.dimension) ?? 0),
    })),
  );

  // Totals from the decile axis: every grade lands in exactly one decile, while a
  // grade with no label is absent from the band axis entirely.
  const deciles = rows.filter((row) => row.dimension === 'decile');
  const grades = deciles.reduce((sum, row) => sum + row.grades, 0);
  const scoreSum = deciles.reduce((sum, row) => sum + (row.scoreSum ?? 0), 0);
  const maxSum = deciles.reduce((sum, row) => sum + (row.maxSum ?? 0), 0);
  const passed = deciles.reduce((sum, row) => sum + row.passed, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      grades,
      // Distinct students cannot be summed across buckets without double-counting,
      // so the headline figure is the largest bucket's distinct count at minimum;
      // the exact organisation-wide figure is the graded-students count below.
      students: deciles.reduce((max, row) => Math.max(max, row.students), 0),
      averagePercentPpm: percentOf(scoreSum, maxSum),
      passRatePpm: sharePpm(passed, grades),
    },
  });
}

// ---------------------------------------------------------------------------
// Exam performance
// ---------------------------------------------------------------------------

/**
 * Per-exam averages, pass rates and absences.
 *
 * Only exams whose results exist are reported: a DRAFT or SCHEDULED exam has no
 * performance to describe, and listing it with a null average would put empty rows
 * at the top of the table.
 */
export async function academicExamPerformanceReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<ExamPerformanceRow, ExamPerformanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'grades.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, {
      exams: 0,
      sat: 0,
      absent: 0,
      passed: 0,
      averagePercentPpm: null,
      passRatePpm: null,
    });
  }

  const rows = await client.$queryRaw<
    Array<{
      examId: string;
      title: string;
      type: string;
      scheduledOn: Date;
      groupName: string | null;
      subjectName: string | null;
      teacherName: string | null;
      sat: number;
      absent: number;
      maxScore: number;
      scoreSum: number | null;
      maxSum: number | null;
      passed: number;
    }>
  >`
    select
      e."id"                                   as "examId",
      e."title"                                as "title",
      e."type"::text                           as "type",
      (e."scheduledAt" at time zone ${scope.timezone}::text)::date as "scheduledOn",
      g."name"                                 as "groupName",
      sub."name"                               as "subjectName",
      case when u."id" is null then null else (u."firstName" || ' ' || u."lastName") end
                                               as "teacherName",
      count(r."id") filter (where not r."isAbsent" and r."score" is not null)::int as "sat",
      count(r."id") filter (where r."isAbsent")::int                               as "absent",
      e."maxScore"                             as "maxScore",
      sum(r."score") filter (where not r."isAbsent")::float8                       as "scoreSum",
      sum(r."maxScore") filter (where not r."isAbsent" and r."score" is not null)::float8
                                               as "maxSum",
      count(r."id") filter (where r."isPass")::int                                 as "passed"
    from "exams" e
    join "exam_results" r on r."examId" = e."id"
    left join "groups" g on g."id" = e."groupId"
    left join "subjects" sub on sub."id" = e."subjectId"
    left join "teachers" te on te."id" = e."teacherId"
    left join "employees" emp on emp."id" = te."employeeId"
    left join "users" u on u."id" = emp."userId"
    where e."organizationId" = ${scope.organizationId}
      and e."deletedAt" is null
      and e."scheduledAt" >= ${scope.fromInstant}
      and e."scheduledAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or e."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.groupIds}::text[] is null or e."groupId" = any(${scope.groupIds}::text[]))
      and (${scope.teacherIds}::text[] is null or e."teacherId" = any(${scope.teacherIds}::text[]))
      and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
      and (${scope.ownTeacherId}::text is null or e."teacherId" = ${scope.ownTeacherId}
           or exists (select 1 from "group_teachers" gt
                      where gt."groupId" = e."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                        and gt."endDate" is null))
    group by e."id", e."title", e."type", e."scheduledAt", g."name", sub."name", u."id",
             u."firstName", u."lastName", e."maxScore"
    order by e."scheduledAt" desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<ExamPerformanceRow>((row) => ({
      examId: row.examId,
      title: row.title,
      type: row.type,
      scheduledOn: toDateOnly(row.scheduledOn),
      groupName: row.groupName,
      subjectName: row.subjectName,
      teacherName: row.teacherName,
      sat: row.sat,
      absent: row.absent,
      maxScore: row.maxScore,
      averageScore:
        row.sat > 0 && row.scoreSum !== null ? Math.round((row.scoreSum / row.sat) * 100) / 100 : null,
      averagePercentPpm: percentOf(row.scoreSum, row.maxSum),
      passed: row.passed,
      passRatePpm: sharePpm(row.passed, row.sat),
    })),
  );

  const sat = rows.reduce((sum, row) => sum + row.sat, 0);
  const scoreSum = rows.reduce((sum, row) => sum + (row.scoreSum ?? 0), 0);
  const maxSum = rows.reduce((sum, row) => sum + (row.maxSum ?? 0), 0);
  const passed = rows.reduce((sum, row) => sum + row.passed, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      exams: capped.rows.length,
      sat,
      absent: rows.reduce((sum, row) => sum + row.absent, 0),
      passed,
      averagePercentPpm: percentOf(scoreSum, maxSum),
      passRatePpm: sharePpm(passed, sat),
    },
  });
}

// ---------------------------------------------------------------------------
// By subject
// ---------------------------------------------------------------------------

/** Average attainment and pass rate per subject, weakest first. */
export async function academicBySubjectReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<SubjectPerformanceRow, PerformanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'grades.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, { grades: 0, students: 0, averagePercentPpm: null, passRatePpm: null });
  }

  const rows = await client.$queryRaw<
    Array<{
      subjectId: string;
      subjectName: string;
      subjectCode: string;
      grades: number;
      students: number;
      scoreSum: number | null;
      maxSum: number | null;
      passed: number;
      passJudged: number;
    }>
  >`
    select
      sub."id"                            as "subjectId",
      sub."name"                          as "subjectName",
      sub."code"                          as "subjectCode",
      count(gr."id")::int                 as "grades",
      count(distinct gr."studentId")::int  as "students",
      sum(gr."score")::float8             as "scoreSum",
      sum(gr."maxScore")::float8          as "maxSum",
      count(gr."id") filter (where gr."isPass")::int          as "passed",
      count(gr."id") filter (where gr."isPass" is not null)::int as "passJudged"
    from "grades" gr
    join "subjects" sub on sub."id" = gr."subjectId"
    left join "groups" g on g."id" = gr."groupId"
    left join "students" st on st."id" = gr."studentId"
    where gr."organizationId" = ${scope.organizationId}
      and gr."gradedAt" >= ${scope.fromInstant}
      and gr."gradedAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or st."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.groupIds}::text[] is null or gr."groupId" = any(${scope.groupIds}::text[]))
      and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
      and (${scope.ownTeacherId}::text is null or exists (
            select 1 from "group_teachers" gt
            where gt."groupId" = gr."groupId" and gt."teacherId" = ${scope.ownTeacherId}
              and gt."endDate" is null))
    group by sub."id", sub."name", sub."code"
    order by count(gr."id") desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<SubjectPerformanceRow>((row) => ({
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      subjectCode: row.subjectCode,
      grades: row.grades,
      students: row.students,
      averagePercentPpm: percentOf(row.scoreSum, row.maxSum),
      // Denominator is the grades that carry a pass judgement at all: a
      // participation grade with `isPass` null is not a failure.
      passRatePpm: sharePpm(row.passed, row.passJudged),
    })),
  );

  return buildResult({
    scope,
    rows: [...capped.rows].sort(byWeakestAverage),
    truncated: capped.truncated,
    totals: aggregatePerformance(rows),
  });
}

// ---------------------------------------------------------------------------
// By teacher
// ---------------------------------------------------------------------------

/**
 * Attainment in each teacher's groups.
 *
 * Attributed through the OPEN teacher assignment on the grade's group, not through
 * `Grade.gradedById`: the question is whose teaching produced the result, and a
 * head of studies entering a grade on a teacher's behalf must not become the
 * subject of the report.
 */
export async function academicByTeacherReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<TeacherPerformanceRow, PerformanceTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'grades.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, { grades: 0, students: 0, averagePercentPpm: null, passRatePpm: null });
  }

  const rows = await client.$queryRaw<
    Array<{
      teacherId: string;
      teacherName: string;
      groups: number;
      grades: number;
      students: number;
      scoreSum: number | null;
      maxSum: number | null;
      passed: number;
      passJudged: number;
    }>
  >`
    select
      te."id"                              as "teacherId",
      (u."firstName" || ' ' || u."lastName") as "teacherName",
      count(distinct gr."groupId")::int     as "groups",
      count(gr."id")::int                   as "grades",
      count(distinct gr."studentId")::int    as "students",
      sum(gr."score")::float8              as "scoreSum",
      sum(gr."maxScore")::float8           as "maxSum",
      count(gr."id") filter (where gr."isPass")::int           as "passed",
      count(gr."id") filter (where gr."isPass" is not null)::int as "passJudged"
    from "grades" gr
    join "group_teachers" gt on gt."groupId" = gr."groupId" and gt."endDate" is null
    join "teachers" te on te."id" = gt."teacherId"
    join "employees" emp on emp."id" = te."employeeId"
    join "users" u on u."id" = emp."userId"
    left join "groups" g on g."id" = gr."groupId"
    left join "students" st on st."id" = gr."studentId"
    where gr."organizationId" = ${scope.organizationId}
      and gr."gradedAt" >= ${scope.fromInstant}
      and gr."gradedAt" < ${scope.toExclusive}
      and (${scope.branchIds}::text[] is null or st."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.groupIds}::text[] is null or gr."groupId" = any(${scope.groupIds}::text[]))
      and (${scope.teacherIds}::text[] is null or te."id" = any(${scope.teacherIds}::text[]))
      and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
      and (${scope.ownTeacherId}::text is null or te."id" = ${scope.ownTeacherId})
    group by te."id", u."firstName", u."lastName"
    order by count(gr."id") desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<TeacherPerformanceRow>((row) => ({
      teacherId: row.teacherId,
      teacherName: row.teacherName,
      groups: row.groups,
      grades: row.grades,
      students: row.students,
      averagePercentPpm: percentOf(row.scoreSum, row.maxSum),
      passRatePpm: sharePpm(row.passed, row.passJudged),
    })),
  );

  return buildResult({
    scope,
    rows: [...capped.rows].sort(byWeakestAverage),
    truncated: capped.truncated,
    // A grade counted once per teacher would be double-counted for a group with a
    // primary and an assistant, so the totals come from the same rows and are
    // labelled as such rather than pretending to be an organisation-wide figure.
    totals: aggregatePerformance(rows),
  });
}

function aggregatePerformance(
  rows: readonly {
    grades: number;
    students: number;
    scoreSum: number | null;
    maxSum: number | null;
    passed: number;
    passJudged: number;
  }[],
): PerformanceTotals {
  const grades = rows.reduce((sum, row) => sum + row.grades, 0);
  const scoreSum = rows.reduce((sum, row) => sum + (row.scoreSum ?? 0), 0);
  const maxSum = rows.reduce((sum, row) => sum + (row.maxSum ?? 0), 0);
  const passed = rows.reduce((sum, row) => sum + row.passed, 0);
  const judged = rows.reduce((sum, row) => sum + row.passJudged, 0);
  return {
    grades,
    // The largest single row's distinct count, not a sum: the same student appears
    // under several subjects and teachers.
    students: rows.reduce((max, row) => Math.max(max, row.students), 0),
    averagePercentPpm: percentOf(scoreSum, maxSum),
    passRatePpm: sharePpm(passed, judged),
  };
}

/** Unknown averages last: no grades yet is not weak performance. */
function byWeakestAverage(
  a: { averagePercentPpm: number | null },
  b: { averagePercentPpm: number | null },
): number {
  return (
    (a.averagePercentPpm ?? Number.MAX_SAFE_INTEGER) -
    (b.averagePercentPpm ?? Number.MAX_SAFE_INTEGER)
  );
}

// ---------------------------------------------------------------------------
// Homework completion
// ---------------------------------------------------------------------------

/**
 * Homework submission and marking rates per period.
 *
 * `expected` is the count of open enrollments in each assignment's group at the
 * time of the query, because a `HomeworkSubmission` row is only created when a
 * student engages -- so "not submitted" cannot be counted from submissions alone.
 * Rows with an explicit NOT_SUBMITTED or EXCUSED status are counted where they
 * exist; the expected headcount is what makes the rate honest when they do not.
 */
export async function academicHomeworkCompletionReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<HomeworkCompletionRow, HomeworkCompletionTotals>> {
  requirePermission(ctx, 'reports.viewAcademic');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client, {
    selfEscapeHatch: 'grades.viewAll',
  });
  if (scope.selfWithoutIdentity) {
    return emptyResult(scope, {
      assignments: 0,
      expected: 0,
      submitted: 0,
      late: 0,
      graded: 0,
      submissionRatePpm: null,
      onTimeRatePpm: null,
      gradedRatePpm: null,
    });
  }

  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{
      period: Date;
      assignments: number;
      expected: number;
      submitted: number;
      late: number;
      graded: number;
      notSubmitted: number;
    }>
  >`
    with scoped as (
      select
        h."id",
        h."dueAt",
        (select count(*) from "enrollments" e
         where e."groupId" = h."groupId" and e."endDate" is null)::int as expected
      from "homework" h
      left join "groups" g on g."id" = h."groupId"
      where h."organizationId" = ${scope.organizationId}
        and h."deletedAt" is null
        and h."status" <> 'DRAFT'
        and h."dueAt" >= ${scope.fromInstant}
        and h."dueAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null or h."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or h."groupId" = any(${scope.groupIds}::text[]))
        and (${scope.teacherIds}::text[] is null or h."teacherId" = any(${scope.teacherIds}::text[]))
        and (${scope.programIds}::text[] is null or g."programId" = any(${scope.programIds}::text[]))
        and (${scope.ownTeacherId}::text is null or h."teacherId" = ${scope.ownTeacherId}
             or exists (select 1 from "group_teachers" gt
                        where gt."groupId" = h."groupId" and gt."teacherId" = ${scope.ownTeacherId}
                          and gt."endDate" is null))
    )
    select
      (date_trunc(
         ${unit}::text,
         (s."dueAt" at time zone ${scope.timezone}::text)
           + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date         as "period",
      count(distinct s."id")::int                                        as "assignments",
      sum(s.expected)::int                                               as "expected",
      count(sm."id") filter (where sm."status" in ('SUBMITTED', 'LATE', 'GRADED'))::int
                                                                        as "submitted",
      count(sm."id") filter (where sm."status" = 'LATE')::int             as "late",
      count(sm."id") filter (where sm."status" = 'GRADED')::int           as "graded",
      count(sm."id") filter (where sm."status" = 'NOT_SUBMITTED')::int    as "notSubmitted"
    from scoped s
    left join "homework_submissions" sm on sm."homeworkId" = s."id"
    group by 1
    order by 1
  `;

  const capped = capRows(
    rows.map<HomeworkCompletionRow>((row) => ({
      period: toDateOnly(row.period),
      assignments: row.assignments,
      expected: row.expected,
      submitted: row.submitted,
      late: row.late,
      graded: row.graded,
      notSubmitted: row.notSubmitted,
      submissionRatePpm: sharePpm(row.submitted, row.expected),
      onTimeRatePpm: sharePpm(row.submitted - row.late, row.submitted),
      gradedRatePpm: sharePpm(row.graded, row.submitted),
    })),
  );

  const expected = capped.rows.reduce((sum, row) => sum + row.expected, 0);
  const submitted = capped.rows.reduce((sum, row) => sum + row.submitted, 0);
  const late = capped.rows.reduce((sum, row) => sum + row.late, 0);
  const graded = capped.rows.reduce((sum, row) => sum + row.graded, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      assignments: capped.rows.reduce((sum, row) => sum + row.assignments, 0),
      expected,
      submitted,
      late,
      graded,
      submissionRatePpm: sharePpm(submitted, expected),
      onTimeRatePpm: sharePpm(submitted - late, submitted),
      gradedRatePpm: sharePpm(graded, submitted),
    },
    series: [
      percentSeries(
        'reports.series.homeworkSubmissionRate',
        scope,
        new Map(capped.rows.map((row) => [row.period, row.submissionRatePpm])),
      ),
    ],
  });
}
