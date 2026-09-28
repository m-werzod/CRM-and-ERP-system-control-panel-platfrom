/**
 * Attendance percentages and statistics.
 *
 * The specification asks for the calculation to be CONFIGURABLE, and there is real
 * disagreement between institutions about it:
 *
 *   * does a late arrival count as a full attendance, a half, or nothing?
 *   * does an authorised absence count against the student, or come out of the
 *     denominator entirely?
 *
 * Both are settings (`attendance.statusWeightsPpm`,
 * `attendance.excusedCountsInDenominator`), and the arithmetic lives in the pure
 * `attendancePercentagePpm` below so the same rule is applied by the student
 * profile, the group report, the branch dashboard and the at-risk sweep. Anything
 * computing `present / total` inline would quietly disagree with all of them.
 */

import type { AttendanceStatus } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import {
  composeReadFilter,
  requirePermission,
  scopeFilter,
  selfStudentFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dayRangeToInstants, todayIn, type DateOnly } from '@/lib/dates';

/** Weight each status contributes, in parts-per-million of a full attendance. */
export interface StatusWeightsPpm {
  readonly PRESENT: number;
  readonly LATE: number;
  readonly EXCUSED: number;
  readonly ABSENT: number;
}

export interface AttendanceCounts {
  readonly present: number;
  readonly late: number;
  readonly excused: number;
  readonly absent: number;
}

export const EMPTY_COUNTS: AttendanceCounts = { present: 0, late: 0, excused: 0, absent: 0 };

export function totalRecords(counts: AttendanceCounts): number {
  return counts.present + counts.late + counts.excused + counts.absent;
}

/**
 * The single attendance-percentage calculation, in parts-per-million.
 *
 * Returns `null` rather than 0 when there is nothing to measure. That distinction
 * matters: a student with no lessons yet has an UNKNOWN attendance rate, and
 * reporting it as 0% would put every new joiner on the at-risk list.
 */
export function attendancePercentagePpm(
  counts: AttendanceCounts,
  options: {
    readonly weightsPpm: StatusWeightsPpm;
    /** When false, excused lessons leave both numerator and denominator. */
    readonly excusedCountsInDenominator: boolean;
  },
): number | null {
  const denominatorCount =
    counts.present +
    counts.late +
    counts.absent +
    (options.excusedCountsInDenominator ? counts.excused : 0);

  if (denominatorCount === 0) return null;

  // Integer arithmetic throughout: a percentage derived from floats drifts, and
  // these numbers decide whether a student is flagged or a certificate is issued.
  const weighted =
    counts.present * options.weightsPpm.PRESENT +
    counts.late * options.weightsPpm.LATE +
    counts.absent * options.weightsPpm.ABSENT +
    (options.excusedCountsInDenominator ? counts.excused * options.weightsPpm.EXCUSED : 0);

  return Math.round(weighted / denominatorCount);
}

/** Load the institution's configured rule once, for reuse across a report. */
export async function loadAttendanceRule(
  scope: { organizationId: string; branchId?: string | null },
  db: Db = prisma,
): Promise<{
  weightsPpm: StatusWeightsPpm;
  excusedCountsInDenominator: boolean;
  atRiskBelowPercentPpm: number;
}> {
  const settings = await getSettings(
    ['statusWeightsPpm', 'excusedCountsInDenominator', 'atRiskBelowPercentPpm'],
    scope,
    db,
  );
  return {
    weightsPpm: settings.statusWeightsPpm,
    excusedCountsInDenominator: settings.excusedCountsInDenominator,
    atRiskBelowPercentPpm: settings.atRiskBelowPercentPpm,
  };
}

function toCounts(rows: Array<{ status: AttendanceStatus; _count: { _all: number } }>): AttendanceCounts {
  const byStatus = new Map(rows.map((row) => [row.status, row._count._all]));
  return {
    present: byStatus.get('PRESENT') ?? 0,
    late: byStatus.get('LATE') ?? 0,
    excused: byStatus.get('EXCUSED') ?? 0,
    absent: byStatus.get('ABSENT') ?? 0,
  };
}

export interface AttendanceSummary {
  readonly counts: AttendanceCounts;
  readonly totalRecords: number;
  readonly percentagePpm: number | null;
  readonly isAtRisk: boolean;
}

function summarise(
  counts: AttendanceCounts,
  rule: Awaited<ReturnType<typeof loadAttendanceRule>>,
): AttendanceSummary {
  const percentagePpm = attendancePercentagePpm(counts, rule);
  return {
    counts,
    totalRecords: totalRecords(counts),
    percentagePpm,
    // An unknown rate is never "at risk": absence of data is not evidence.
    isAtRisk: percentagePpm !== null && percentagePpm < rule.atRiskBelowPercentPpm,
  };
}

/** One student's attendance over a date range, optionally within one group. */
export async function getStudentAttendance(
  ctx: AccessContext,
  input: { studentId: string; from?: DateOnly; to?: DateOnly; groupId?: string },
  db: Db = prisma,
): Promise<AttendanceSummary & { from: DateOnly; to: DateOnly }> {
  requirePermission(ctx, 'attendance.view');

  const { timezone } = await getSettings(['timezone'], { organizationId: ctx.organizationId }, db);
  const to = input.to ?? todayIn(timezone);
  // A year back by default: long enough to be meaningful, bounded enough to stay
  // on the (organizationId, lessonDate) index.
  const from = input.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;
  const range = dayRangeToInstants(from, to, timezone);

  // Scoped through the student so a teacher sees only their own students and a
  // parent only their own children.
  const student = await db.student.findFirst({
    where: {
      id: input.studentId,
      ...(composeReadFilter(ctx, {
        selfFilter: selfStudentFilter(ctx),
        escapeHatch: 'attendance.viewAll',
      }) as object),
    },
    select: { id: true, branchId: true },
  });
  if (!student) {
    return { ...summarise(EMPTY_COUNTS, await loadAttendanceRule({ organizationId: ctx.organizationId }, db)), from, to };
  }

  const rule = await loadAttendanceRule(
    { organizationId: ctx.organizationId, branchId: student.branchId },
    db,
  );

  const rows = await db.attendanceRecord.groupBy({
    by: ['status'],
    where: {
      organizationId: ctx.organizationId,
      studentId: student.id,
      ...(input.groupId ? { lesson: { groupId: input.groupId } } : {}),
      lesson: {
        ...(input.groupId ? { groupId: input.groupId } : {}),
        lessonDate: { gte: range.from, lt: range.toExclusive },
        // A cancelled lesson must not count against anyone.
        status: { not: 'CANCELLED' },
      },
    },
    _count: { _all: true },
  });

  return { ...summarise(toCounts(rows), rule), from, to };
}

/** Group-level attendance, with a per-student breakdown for the register view. */
export async function getGroupAttendance(
  ctx: AccessContext,
  input: { groupId: string; from?: DateOnly; to?: DateOnly },
  db: Db = prisma,
): Promise<{
  group: AttendanceSummary;
  students: Array<{ studentId: string; fullName: string; studentCode: string } & AttendanceSummary>;
  lessonCount: number;
  from: DateOnly;
  to: DateOnly;
}> {
  requirePermission(ctx, 'attendance.view');

  const group = await db.group.findFirst({
    where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, branchId: true },
  });
  if (!group) {
    const rule = await loadAttendanceRule({ organizationId: ctx.organizationId }, db);
    const empty = summarise(EMPTY_COUNTS, rule);
    return { group: empty, students: [], lessonCount: 0, from: input.from ?? '', to: input.to ?? '' };
  }

  const rule = await loadAttendanceRule(
    { organizationId: ctx.organizationId, branchId: group.branchId },
    db,
  );
  const { timezone } = await getSettings(['timezone'], { organizationId: ctx.organizationId }, db);
  const to = input.to ?? todayIn(timezone);
  const from = input.from ?? `${to.slice(0, 8)}01`;
  const range = dayRangeToInstants(from, to, timezone);

  const lessonWhere = {
    groupId: group.id,
    lessonDate: { gte: range.from, lt: range.toExclusive },
    status: { not: 'CANCELLED' as const },
  };

  const [byStatus, byStudent, lessonCount] = await Promise.all([
    db.attendanceRecord.groupBy({
      by: ['status'],
      where: { organizationId: ctx.organizationId, lesson: lessonWhere },
      _count: { _all: true },
    }),
    db.attendanceRecord.groupBy({
      by: ['studentId', 'status'],
      where: { organizationId: ctx.organizationId, lesson: lessonWhere },
      _count: { _all: true },
    }),
    db.lesson.count({ where: { ...lessonWhere, organizationId: ctx.organizationId } }),
  ]);

  // One query for the names rather than one per student.
  const studentIds = [...new Set(byStudent.map((row) => row.studentId))];
  const students = await db.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, firstName: true, lastName: true, studentCode: true },
  });
  const nameById = new Map(students.map((s) => [s.id, s]));

  const perStudent = new Map<string, AttendanceCounts>();
  for (const row of byStudent) {
    const current = perStudent.get(row.studentId) ?? EMPTY_COUNTS;
    const key = row.status.toLowerCase() as keyof AttendanceCounts;
    perStudent.set(row.studentId, { ...current, [key]: current[key] + row._count._all });
  }

  return {
    group: summarise(toCounts(byStatus), rule),
    students: [...perStudent.entries()]
      .map(([studentId, counts]) => {
        const student = nameById.get(studentId);
        return {
          studentId,
          fullName: student ? `${student.firstName} ${student.lastName}` : 'Unknown',
          studentCode: student?.studentCode ?? '',
          ...summarise(counts, rule),
        };
      })
      // Worst attendance first: that is the list a teacher acts on.
      .sort((a, b) => (a.percentagePpm ?? Number.MAX_SAFE_INTEGER) - (b.percentagePpm ?? Number.MAX_SAFE_INTEGER)),
    lessonCount,
    from,
    to,
  };
}

/** Today's attendance across a branch or the whole organisation, for dashboards. */
export async function getDailyAttendance(
  ctx: AccessContext,
  input: { date?: DateOnly; branchId?: string | null } = {},
  db: Db = prisma,
): Promise<{
  date: DateOnly;
  counts: AttendanceCounts;
  lessonsTotal: number;
  lessonsMarked: number;
  lessonsPending: number;
  studentsExpected: number;
}> {
  requirePermission(ctx, 'attendance.view');

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const date = input.date ?? todayIn(timezone);
  const range = dayRangeToInstants(date, date, timezone);

  const branchFilter =
    input.branchId
      ? { branchId: input.branchId }
      : ctx.scope === 'ORGANIZATION'
        ? {}
        : { branchId: { in: [...ctx.branchIds] } };

  const lessonWhere = {
    organizationId: ctx.organizationId,
    ...branchFilter,
    lessonDate: { gte: range.from, lt: range.toExclusive },
    status: { not: 'CANCELLED' as const },
  };

  const [byStatus, lessonsTotal, lessonsPending, expected] = await Promise.all([
    db.attendanceRecord.groupBy({
      by: ['status'],
      where: { organizationId: ctx.organizationId, ...branchFilter, lesson: lessonWhere },
      _count: { _all: true },
    }),
    db.lesson.count({ where: lessonWhere }),
    db.lesson.count({ where: { ...lessonWhere, attendanceStatus: 'PENDING' } }),
    // Expected headcount: open enrollments in the groups that have a lesson today.
    db.enrollment.count({
      where: {
        endDate: null,
        group: { lessons: { some: lessonWhere } },
      },
    }),
  ]);

  return {
    date,
    counts: toCounts(byStatus),
    lessonsTotal,
    lessonsMarked: lessonsTotal - lessonsPending,
    lessonsPending,
    studentsExpected: expected,
  };
}

/**
 * Students whose attendance has fallen below the configured threshold, and students
 * with a run of consecutive absences. Drives the at-risk panel and the alert job.
 */
export async function findAtRiskStudents(
  ctx: AccessContext,
  input: { from?: DateOnly; to?: DateOnly; branchId?: string | null; limit?: number } = {},
  db: Db = prisma,
): Promise<
  Array<{
    studentId: string;
    fullName: string;
    studentCode: string;
    branchId: string;
    counts: AttendanceCounts;
    percentagePpm: number | null;
    consecutiveAbsences: number;
  }>
> {
  requirePermission(ctx, 'attendance.view');

  const rule = await loadAttendanceRule(
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const { timezone, consecutiveAbsenceAlertThreshold } = await getSettings(
    ['timezone', 'consecutiveAbsenceAlertThreshold'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );

  const to = input.to ?? todayIn(timezone);
  const from = input.from ?? `${to.slice(0, 8)}01`;
  const range = dayRangeToInstants(from, to, timezone);

  const branchIds = ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds];
  const requestedBranch = input.branchId ?? null;

  // Aggregated in SQL with the consecutive-absence run computed by a window
  // function. Fetching every record and folding in JS would move megabytes for a
  // dashboard panel.
  const rows = await db.$queryRaw<
    Array<{
      studentId: string;
      fullName: string;
      studentCode: string;
      branchId: string;
      present: bigint;
      late: bigint;
      excused: bigint;
      absent: bigint;
      consecutiveAbsences: bigint;
    }>
  >`
    with scoped as (
      select a."studentId", a."status", l."lessonDate",
             row_number() over (partition by a."studentId" order by l."lessonDate" desc) as rn
      from "attendance_records" a
      join "lessons" l on l."id" = a."lessonId"
      where a."organizationId" = ${ctx.organizationId}
        and l."lessonDate" >= ${range.from} and l."lessonDate" < ${range.toExclusive}
        and l."status" <> 'CANCELLED'
        and (${branchIds}::text[] is null or a."branchId" = any(${branchIds}::text[]))
        and (${requestedBranch}::text is null or a."branchId" = ${requestedBranch})
    ),
    tally as (
      select "studentId",
             count(*) filter (where "status" = 'PRESENT') as present,
             count(*) filter (where "status" = 'LATE')    as late,
             count(*) filter (where "status" = 'EXCUSED') as excused,
             count(*) filter (where "status" = 'ABSENT')  as absent
      from scoped group by "studentId"
    ),
    -- The current absence streak: how many of the most recent lessons, counting
    -- back from the latest, were absences before the first non-absence.
    streak as (
      select "studentId",
             coalesce(min(rn) filter (where "status" <> 'ABSENT') - 1,
                      max(rn)) as consecutive_absences
      from scoped group by "studentId"
    )
    select s."id"                                 as "studentId",
           (s."firstName" || ' ' || s."lastName") as "fullName",
           s."studentCode"                        as "studentCode",
           s."branchId"                           as "branchId",
           t.present, t.late, t.excused, t.absent,
           greatest(st.consecutive_absences, 0)   as "consecutiveAbsences"
    from tally t
    join streak st on st."studentId" = t."studentId"
    join "students" s on s."id" = t."studentId"
    where s."deletedAt" is null and s."status" = 'ACTIVE'
    order by t.absent desc
    limit ${input.limit ?? 100}
  `;

  return rows
    .map((row) => {
      const counts: AttendanceCounts = {
        present: Number(row.present),
        late: Number(row.late),
        excused: Number(row.excused),
        absent: Number(row.absent),
      };
      return {
        studentId: row.studentId,
        fullName: row.fullName,
        studentCode: row.studentCode,
        branchId: row.branchId,
        counts,
        percentagePpm: attendancePercentagePpm(counts, rule),
        consecutiveAbsences: Number(row.consecutiveAbsences),
      };
    })
    .filter(
      (row) =>
        (row.percentagePpm !== null && row.percentagePpm < rule.atRiskBelowPercentPpm) ||
        row.consecutiveAbsences >= consecutiveAbsenceAlertThreshold,
    );
}
