/**
 * HR reports: staff attendance, teacher workload, leave and payroll.
 *
 * Three judgements are encoded here rather than assumed, because each one changes
 * the number a manager acts on:
 *
 *   A STAFF ATTENDANCE RATE EXCLUDES HOLIDAYS AND APPROVED LEAVE. Someone on
 *   approved annual leave has not failed to attend, and a public holiday is not a
 *   day anyone was expected. Both leave the denominator entirely; only PRESENT,
 *   REMOTE, LATE, HALF_DAY and ABSENT are counted, with a half-day worth half.
 *   Counting leave as absence would make a well-run team look delinquent every
 *   August.
 *
 *   LEAVE DAYS ARE ATTRIBUTED TO THE REQUEST, NOT PRO-RATED. `LeaveRequest.days` is
 *   the working-day count that was agreed and stored, deliberately, so a later
 *   change to the holiday calendar cannot rewrite it. A request is therefore
 *   counted in the period its leave STARTS in; splitting it across a period
 *   boundary would mean re-deriving working days and producing a figure that
 *   disagrees with the one the employee was told.
 *
 *   PAYROLL IS REPORTED PER CURRENCY. `PayrollRun.currency` is per run, and minor
 *   units of two currencies cannot be added, so the report resolves one currency
 *   and names any others it found.
 */

import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import type { DateOnly } from '@/lib/dates';
import { currencyFor } from '@/server/services/finance/currency';
import {
  buildResult,
  capRows,
  emptyResult,
  moneySeries,
  percentSeries,
  REPORT_ROW_CAP,
  resolveReportScope,
  sharePpm,
  truncUnit,
  type ReportFilters,
  type ReportResult,
  type ReportScope,
} from './types';
import { exponentFor, moneyColumn, percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type StaffAttendanceRow = {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly fullName: string;
  readonly position: string;
  readonly departmentName: string | null;
  readonly branchId: string;
  readonly present: number;
  readonly remote: number;
  readonly late: number;
  readonly halfDay: number;
  readonly absent: number;
  readonly onLeave: number;
  readonly holiday: number;
  readonly minutesLate: number;
  readonly overtimeMinutes: number;
  /** Expected days: present + remote + late + halfDay + absent. */
  readonly expectedDays: number;
  readonly attendanceRatePpm: number | null;
  /** Of the days attended, the share that were not late. */
  readonly punctualityPpm: number | null;
};

export type StaffAttendanceTotals = {
  readonly employees: number;
  readonly present: number;
  readonly late: number;
  readonly absent: number;
  readonly onLeave: number;
  readonly expectedDays: number;
  readonly attendanceRatePpm: number | null;
  readonly punctualityPpm: number | null;
};

export type TeacherWorkloadRow = {
  readonly teacherId: string;
  readonly teacherName: string;
  readonly branchId: string;
  readonly groups: number;
  readonly slots: number;
  readonly scheduledMinutesPerWeek: number;
  readonly capacityMinutesPerWeek: number;
  readonly utilizationPpm: number | null;
  readonly isOverAllocated: boolean;
  readonly overAllocatedByMinutes: number;
  /** Actual sessions in the window, which a recurring pattern alone does not show. */
  readonly lessonsInWindow: number;
  readonly cancelledInWindow: number;
};

export type TeacherWorkloadTotals = {
  readonly teachers: number;
  readonly overAllocated: number;
  readonly scheduledMinutesPerWeek: number;
  readonly capacityMinutesPerWeek: number;
  readonly utilizationPpm: number | null;
};

export type LeaveRow = {
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly leaveTypeCode: string;
  readonly isPaid: boolean;
  readonly requests: number;
  readonly approved: number;
  readonly pending: number;
  readonly rejected: number;
  readonly cancelled: number;
  /** Days on APPROVED requests only: a pending request is not leave taken. */
  readonly approvedDays: number;
  readonly employees: number;
  readonly sharePpm: number | null;
};

export type LeaveTotals = {
  readonly requests: number;
  readonly approved: number;
  readonly pending: number;
  readonly approvedDays: number;
  readonly employees: number;
};

export type PayrollRow = {
  readonly period: DateOnly;
  readonly currency: string;
  readonly runs: number;
  readonly employees: number;
  readonly grossMinor: string;
  readonly deductionMinor: string;
  readonly netMinor: string;
  /** Deductions as a share of gross, in parts-per-million. */
  readonly deductionRatePpm: number | null;
};

export type PayrollTotals = {
  readonly currency: string;
  readonly runs: number;
  readonly grossMinor: string;
  readonly deductionMinor: string;
  readonly netMinor: string;
  readonly deductionRatePpm: number | null;
  readonly otherCurrencies: string | null;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const STAFF_ATTENDANCE_COLUMNS: readonly ReportColumn<StaffAttendanceRow>[] = [
  { key: 'employeeCode', labelKey: 'reports.columns.employeeCode' },
  { key: 'fullName', labelKey: 'reports.columns.employee' },
  { key: 'position', labelKey: 'reports.columns.position' },
  { key: 'departmentName', labelKey: 'reports.columns.department' },
  { key: 'present', labelKey: 'reports.columns.present', kind: 'number' },
  { key: 'late', labelKey: 'reports.columns.late', kind: 'number' },
  { key: 'absent', labelKey: 'reports.columns.absent', kind: 'number' },
  { key: 'onLeave', labelKey: 'reports.columns.onLeave', kind: 'number' },
  { key: 'minutesLate', labelKey: 'reports.columns.minutesLate', kind: 'number' },
  percentColumn<StaffAttendanceRow>('attendanceRatePpm', 'reports.columns.attendanceRate'),
  percentColumn<StaffAttendanceRow>('punctualityPpm', 'reports.columns.punctuality'),
];

export const TEACHER_WORKLOAD_COLUMNS: readonly ReportColumn<TeacherWorkloadRow>[] = [
  { key: 'teacherName', labelKey: 'reports.columns.teacher' },
  { key: 'groups', labelKey: 'reports.columns.groups', kind: 'number' },
  {
    key: 'scheduledMinutesPerWeek',
    labelKey: 'reports.columns.scheduledMinutes',
    kind: 'number',
  },
  {
    key: 'capacityMinutesPerWeek',
    labelKey: 'reports.columns.capacityMinutes',
    kind: 'number',
  },
  percentColumn<TeacherWorkloadRow>('utilizationPpm', 'reports.columns.utilization'),
  { key: 'isOverAllocated', labelKey: 'reports.columns.overAllocated', kind: 'boolean' },
  { key: 'lessonsInWindow', labelKey: 'reports.columns.lessons', kind: 'number' },
];

export const LEAVE_COLUMNS: readonly ReportColumn<LeaveRow>[] = [
  { key: 'leaveTypeCode', labelKey: 'reports.columns.leaveTypeCode' },
  { key: 'leaveTypeName', labelKey: 'reports.columns.leaveType' },
  { key: 'isPaid', labelKey: 'reports.columns.paid', kind: 'boolean' },
  { key: 'requests', labelKey: 'reports.columns.requests', kind: 'number' },
  { key: 'approved', labelKey: 'reports.columns.approved', kind: 'number' },
  { key: 'pending', labelKey: 'reports.columns.pending', kind: 'number' },
  { key: 'approvedDays', labelKey: 'reports.columns.days', kind: 'number' },
  { key: 'employees', labelKey: 'reports.columns.employees', kind: 'number' },
  percentColumn<LeaveRow>('sharePpm', 'reports.columns.share'),
];

export const PAYROLL_COLUMNS: readonly ReportColumn<PayrollRow>[] = [
  { key: 'period', labelKey: 'reports.columns.period', kind: 'date' },
  { key: 'runs', labelKey: 'reports.columns.runs', kind: 'number' },
  { key: 'employees', labelKey: 'reports.columns.employees', kind: 'number' },
  moneyColumn<PayrollRow>('grossMinor', 'reports.columns.gross', 'currency'),
  moneyColumn<PayrollRow>('deductionMinor', 'reports.columns.deductions', 'currency'),
  moneyColumn<PayrollRow>('netMinor', 'reports.columns.net', 'currency'),
  percentColumn<PayrollRow>('deductionRatePpm', 'reports.columns.deductionRate'),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function big(value: bigint | string | null): bigint {
  return value === null ? 0n : BigInt(value);
}

/**
 * A SELF-scoped caller sees only their own HR figures.
 *
 * No baseline role combines SELF scope with `reports.viewHr`, but a custom role
 * could, and a report that leaks the whole payroll to whoever is handed the
 * permission is not something to leave to role configuration.
 */
function ownEmployeeId(scope: ReportScope): string | null {
  return scope.self.restricted ? scope.self.employeeId : null;
}

/**
 * Attendance rate in HALF-day units so a HALF_DAY can count as half without a
 * float: numerator and denominator are both doubled, and the ratio is unaffected.
 */
function attendanceRate(row: {
  present: number;
  remote: number;
  late: number;
  halfDay: number;
  absent: number;
}): number | null {
  const attended = row.present + row.remote + row.late;
  const numerator = 2 * attended + row.halfDay;
  const denominator = 2 * (attended + row.halfDay + row.absent);
  if (denominator === 0) return null;
  return Math.round((numerator * 1_000_000) / denominator);
}

// ---------------------------------------------------------------------------
// Staff attendance
// ---------------------------------------------------------------------------

/**
 * Per-employee staff attendance over the period.
 *
 * `EmployeeAttendance.workDate` is a `@db.Date` holding the calendar day in the
 * branch timezone, so it is compared against date literals rather than the instant
 * range -- comparing a DATE column against a timestamptz silently drops a day in a
 * negative-offset zone.
 */
export async function hrStaffAttendanceReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<StaffAttendanceRow, StaffAttendanceTotals>> {
  requirePermission(ctx, 'reports.viewHr');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const ownId = ownEmployeeId(scope);
  const unit = truncUnit(scope.granularity);

  const [rows, trend] = await Promise.all([
    client.$queryRaw<
      Array<{
        employeeId: string;
        employeeCode: string;
        fullName: string;
        position: string;
        departmentName: string | null;
        branchId: string;
        present: number;
        remote: number;
        late: number;
        halfDay: number;
        absent: number;
        onLeave: number;
        holiday: number;
        minutesLate: number;
        overtimeMinutes: number;
      }>
    >`
      select
        e."id"                                 as "employeeId",
        e."employeeCode"                       as "employeeCode",
        (u."firstName" || ' ' || u."lastName")  as "fullName",
        e."position"                           as "position",
        d."name"                               as "departmentName",
        e."branchId"                           as "branchId",
        count(*) filter (where a."status" = 'PRESENT')::int    as "present",
        count(*) filter (where a."status" = 'REMOTE')::int     as "remote",
        count(*) filter (where a."status" = 'LATE')::int       as "late",
        count(*) filter (where a."status" = 'HALF_DAY')::int   as "halfDay",
        count(*) filter (where a."status" = 'ABSENT')::int     as "absent",
        count(*) filter (where a."status" = 'ON_LEAVE')::int   as "onLeave",
        count(*) filter (where a."status" = 'HOLIDAY')::int    as "holiday",
        coalesce(sum(a."minutesLate"), 0)::int                 as "minutesLate",
        coalesce(sum(a."overtimeMinutes"), 0)::int             as "overtimeMinutes"
      from "employee_attendances" a
      join "employees" e on e."id" = a."employeeId"
      join "users" u on u."id" = e."userId"
      left join "departments" d on d."id" = e."departmentId"
      where a."organizationId" = ${scope.organizationId}
        and e."deletedAt" is null
        and a."workDate" >= ${scope.from}::date
        and a."workDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or a."branchId" = any(${scope.branchIds}::text[]))
        and (${ownId}::text is null or e."id" = ${ownId})
      group by e."id", e."employeeCode", u."firstName", u."lastName", e."position",
               d."name", e."branchId"
      order by count(*) filter (where a."status" = 'ABSENT') desc, u."lastName" asc
      limit ${REPORT_ROW_CAP + 1}
    `,
    client.$queryRaw<
      Array<{
        period: Date;
        present: number;
        remote: number;
        late: number;
        halfDay: number;
        absent: number;
      }>
    >`
      select
        (date_trunc(
           ${unit}::text,
           a."workDate"::timestamp + ${scope.weekShiftDays}::int * interval '1 day'
         ) - ${scope.weekShiftDays}::int * interval '1 day')::date   as "period",
        count(*) filter (where a."status" = 'PRESENT')::int          as "present",
        count(*) filter (where a."status" = 'REMOTE')::int           as "remote",
        count(*) filter (where a."status" = 'LATE')::int             as "late",
        count(*) filter (where a."status" = 'HALF_DAY')::int         as "halfDay",
        count(*) filter (where a."status" = 'ABSENT')::int           as "absent"
      from "employee_attendances" a
      join "employees" e on e."id" = a."employeeId"
      where a."organizationId" = ${scope.organizationId}
        and e."deletedAt" is null
        and a."workDate" >= ${scope.from}::date
        and a."workDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or a."branchId" = any(${scope.branchIds}::text[]))
        and (${ownId}::text is null or e."id" = ${ownId})
      group by 1
      order by 1
    `,
  ]);

  const capped = capRows(
    rows.map<StaffAttendanceRow>((row) => {
      const attended = row.present + row.remote + row.late;
      return {
        ...row,
        expectedDays: attended + row.halfDay + row.absent,
        attendanceRatePpm: attendanceRate(row),
        punctualityPpm: sharePpm(row.present + row.remote, attended),
      };
    }),
  );

  const sum = (pick: (row: StaffAttendanceRow) => number): number =>
    capped.rows.reduce((total, row) => total + pick(row), 0);

  const attendedTotal = sum((row) => row.present) + sum((row) => row.remote) + sum((row) => row.late);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      employees: capped.rows.length,
      present: sum((row) => row.present),
      late: sum((row) => row.late),
      absent: sum((row) => row.absent),
      onLeave: sum((row) => row.onLeave),
      expectedDays: sum((row) => row.expectedDays),
      attendanceRatePpm: attendanceRate({
        present: sum((row) => row.present),
        remote: sum((row) => row.remote),
        late: sum((row) => row.late),
        halfDay: sum((row) => row.halfDay),
        absent: sum((row) => row.absent),
      }),
      punctualityPpm: sharePpm(sum((row) => row.present) + sum((row) => row.remote), attendedTotal),
    },
    series: [
      percentSeries(
        'reports.series.staffAttendanceRate',
        scope,
        new Map(trend.map((row) => [toDateOnly(row.period), attendanceRate(row)])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Teacher workload
// ---------------------------------------------------------------------------

/**
 * Every teacher's weekly load against their contractual ceiling.
 *
 * The definition matches `getTeacherWorkload` in
 * @/server/services/academics/teachers: minutes come from the ScheduleSlot rows
 * effective at the end of the window, measured against `Teacher.maxWeeklyHours`,
 * because the ceiling is a commitment about the recurring timetable -- counting a
 * week that happened to contain a public holiday would report a teacher as
 * under-allocated. `lessonsInWindow` is reported alongside it, never folded into
 * it, for the same reason: an institution with no ScheduleSlot rows at all still
 * has real lessons, and this report shows both figures rather than implying the
 * teacher is idle. It is
 * expressed once more here as a single aggregate because calling that function per
 * teacher would issue one query per member of staff. The per-teacher drill-down on
 * a profile page still uses that function; if the rule changes, both must change.
 */
export async function hrTeacherWorkloadReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<TeacherWorkloadRow, TeacherWorkloadTotals>> {
  requirePermission(ctx, 'reports.viewHr');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);

  const rows = await client.$queryRaw<
    Array<{
      teacherId: string;
      teacherName: string;
      branchId: string;
      groups: number;
      slots: number;
      scheduledMinutes: number;
      capacityMinutes: number;
      lessons: number;
      cancelled: number;
    }>
  >`
    with active_slots as (
      select
        s."teacherId",
        s."groupId",
        s."endMinute" - s."startMinute" as minutes
      from "schedule_slots" s
      join "groups" g on g."id" = s."groupId"
      where s."organizationId" = ${scope.organizationId}
        and s."isActive"
        and s."teacherId" is not null
        and g."deletedAt" is null
        and g."status" in ('ENROLLING', 'ACTIVE')
        -- Only slots in force at the END of the report window: a slot that ended
        -- last term is history and one starting afterwards is not yet a
        -- commitment. The window end rather than the wall clock, so re-running
        -- the same report reproduces the same figure; the default window ends
        -- today anyway.
        and s."effectiveFrom" <= ${scope.to}::date
        and (s."effectiveTo" is null or s."effectiveTo" >= ${scope.to}::date)
        and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or s."groupId" = any(${scope.groupIds}::text[]))
    ),
    slot_tally as (
      select
        "teacherId",
        count(*)::int                       as slots,
        count(distinct "groupId")::int      as groups,
        coalesce(sum(minutes), 0)::int      as scheduled_minutes
      from active_slots
      group by "teacherId"
    ),
    lesson_tally as (
      select
        l."teacherId",
        count(*) filter (where l."status" <> 'CANCELLED')::int as lessons,
        count(*) filter (where l."status" = 'CANCELLED')::int   as cancelled
      from "lessons" l
      where l."organizationId" = ${scope.organizationId}
        and l."teacherId" is not null
        and l."lessonDate" >= ${scope.from}::date
        and l."lessonDate" <= ${scope.to}::date
        and (${scope.branchIds}::text[] is null or l."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.groupIds}::text[] is null or l."groupId" = any(${scope.groupIds}::text[]))
      group by l."teacherId"
    )
    select
      te."id"                                 as "teacherId",
      (u."firstName" || ' ' || u."lastName")   as "teacherName",
      e."branchId"                            as "branchId",
      coalesce(st.groups, 0)                  as "groups",
      coalesce(st.slots, 0)                   as "slots",
      coalesce(st.scheduled_minutes, 0)       as "scheduledMinutes",
      (te."maxWeeklyHours" * 60)              as "capacityMinutes",
      coalesce(lt.lessons, 0)                 as "lessons",
      coalesce(lt.cancelled, 0)               as "cancelled"
    from "teachers" te
    join "employees" e on e."id" = te."employeeId"
    join "users" u on u."id" = e."userId"
    left join slot_tally st on st."teacherId" = te."id"
    left join lesson_tally lt on lt."teacherId" = te."id"
    where e."organizationId" = ${scope.organizationId}
      and te."deletedAt" is null
      and e."deletedAt" is null
      and e."status" in ('ACTIVE', 'PROBATION')
      and (${scope.branchIds}::text[] is null or e."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.teacherIds}::text[] is null or te."id" = any(${scope.teacherIds}::text[]))
    order by coalesce(st.scheduled_minutes, 0) desc, u."lastName" asc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<TeacherWorkloadRow>((row) => {
      const over = row.scheduledMinutes - row.capacityMinutes;
      return {
        teacherId: row.teacherId,
        teacherName: row.teacherName,
        branchId: row.branchId,
        groups: row.groups,
        slots: row.slots,
        scheduledMinutesPerWeek: row.scheduledMinutes,
        capacityMinutesPerWeek: row.capacityMinutes,
        utilizationPpm: sharePpm(row.scheduledMinutes, row.capacityMinutes),
        isOverAllocated: over > 0,
        overAllocatedByMinutes: Math.max(0, over),
        lessonsInWindow: row.lessons,
        cancelledInWindow: row.cancelled,
      };
    }),
  );

  const scheduled = capped.rows.reduce((sum, row) => sum + row.scheduledMinutesPerWeek, 0);
  const capacity = capped.rows.reduce((sum, row) => sum + row.capacityMinutesPerWeek, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      teachers: capped.rows.length,
      overAllocated: capped.rows.filter((row) => row.isOverAllocated).length,
      scheduledMinutesPerWeek: scheduled,
      capacityMinutesPerWeek: capacity,
      utilizationPpm: sharePpm(scheduled, capacity),
    },
  });
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

/** Leave requested and taken, by type. */
export async function hrLeaveReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<LeaveRow, LeaveTotals>> {
  requirePermission(ctx, 'reports.viewHr');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const ownId = ownEmployeeId(scope);

  const rows = await client.$queryRaw<
    Array<{
      leaveTypeId: string;
      leaveTypeName: string;
      leaveTypeCode: string;
      isPaid: boolean;
      requests: number;
      approved: number;
      pending: number;
      rejected: number;
      cancelled: number;
      approvedDays: number | null;
      employees: number;
    }>
  >`
    select
      lt."id"                                as "leaveTypeId",
      lt."name"                              as "leaveTypeName",
      lt."code"                              as "leaveTypeCode",
      lt."isPaid"                            as "isPaid",
      count(*)::int                          as "requests",
      count(*) filter (where lr."status" = 'APPROVED')::int   as "approved",
      count(*) filter (where lr."status" = 'PENDING')::int    as "pending",
      count(*) filter (where lr."status" = 'REJECTED')::int   as "rejected",
      count(*) filter (where lr."status" = 'CANCELLED')::int  as "cancelled",
      coalesce(sum(lr."days") filter (where lr."status" = 'APPROVED'), 0)::float8
                                             as "approvedDays",
      count(distinct lr."employeeId")::int    as "employees"
    from "leave_requests" lr
    join "leave_types" lt on lt."id" = lr."leaveTypeId"
    join "employees" e on e."id" = lr."employeeId"
    where lr."organizationId" = ${scope.organizationId}
      and e."deletedAt" is null
      -- Attributed by the day the leave starts; see the note at the top of the file.
      and lr."startDate" >= ${scope.from}::date
      and lr."startDate" <= ${scope.to}::date
      and (${scope.branchIds}::text[] is null or e."branchId" = any(${scope.branchIds}::text[]))
      and (${ownId}::text is null or e."id" = ${ownId})
    group by lt."id", lt."name", lt."code", lt."isPaid"
    order by coalesce(sum(lr."days") filter (where lr."status" = 'APPROVED'), 0) desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const totalDays = rows.reduce((sum, row) => sum + (row.approvedDays ?? 0), 0);

  const capped = capRows(
    rows.map<LeaveRow>((row) => ({
      leaveTypeId: row.leaveTypeId,
      leaveTypeName: row.leaveTypeName,
      leaveTypeCode: row.leaveTypeCode,
      isPaid: row.isPaid,
      requests: row.requests,
      approved: row.approved,
      pending: row.pending,
      rejected: row.rejected,
      cancelled: row.cancelled,
      approvedDays: Math.round((row.approvedDays ?? 0) * 100) / 100,
      employees: row.employees,
      sharePpm:
        totalDays > 0 ? Math.round((((row.approvedDays ?? 0) / totalDays) * 1_000_000)) : null,
    })),
  );

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      requests: capped.rows.reduce((sum, row) => sum + row.requests, 0),
      approved: capped.rows.reduce((sum, row) => sum + row.approved, 0),
      pending: capped.rows.reduce((sum, row) => sum + row.pending, 0),
      approvedDays: Math.round(totalDays * 100) / 100,
      // The largest single type's distinct count, not a sum: one employee may take
      // two kinds of leave in the same period.
      employees: capped.rows.reduce((max, row) => Math.max(max, row.employees), 0),
    },
  });
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

/**
 * Payroll totals per period.
 *
 * Read from `PayrollRun`, which holds the snapshot the run committed to, rather
 * than re-summing `SalaryComponent` rows: a dated salary change closes one row and
 * opens another precisely so an old run stays reproducible, and re-deriving it
 * would report today's pay against last quarter's period.
 *
 * Cancelled runs are excluded; DRAFT and CALCULATED runs are included so a manager
 * can see the month they are about to approve, and the run counts make the
 * distinction visible.
 */
export async function hrPayrollReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<PayrollRow, PayrollTotals>> {
  requirePermission(ctx, 'reports.viewHr');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const onlyBranch = scope.branchIds?.length === 1 ? scope.branchIds[0] : null;
  const currency = await currencyFor(
    { organizationId: scope.organizationId, branchId: onlyBranch },
    client,
  );

  // A SELF-scoped caller has no business reading organisation payroll totals, and
  // a per-period aggregate cannot be narrowed to one employee without becoming a
  // payslip, which is a different use-case on the HR profile.
  if (scope.self.restricted) {
    return emptyResult(scope, {
      currency,
      runs: 0,
      grossMinor: '0',
      deductionMinor: '0',
      netMinor: '0',
      deductionRatePpm: null,
      otherCurrencies: null,
    });
  }

  const unit = truncUnit(scope.granularity);

  const rows = await client.$queryRaw<
    Array<{
      period: Date;
      currency: string;
      runs: number;
      employees: number;
      gross: bigint;
      deduction: bigint;
      net: bigint;
    }>
  >`
    select
      (date_trunc(
         ${unit}::text,
         r."periodStart"::timestamp + ${scope.weekShiftDays}::int * interval '1 day'
       ) - ${scope.weekShiftDays}::int * interval '1 day')::date      as "period",
      r."currency"                                                   as "currency",
      count(distinct r."id")::int                                     as "runs",
      count(distinct i."employeeId")::int                              as "employees",
      coalesce(sum(i."grossMinor"), 0)::bigint                        as "gross",
      coalesce(sum(i."deductionMinor"), 0)::bigint                    as "deduction",
      coalesce(sum(i."netMinor"), 0)::bigint                          as "net"
    from "payroll_runs" r
    left join "payroll_items" i on i."payrollRunId" = r."id"
    where r."organizationId" = ${scope.organizationId}
      and r."status" <> 'CANCELLED'
      and r."periodStart" >= ${scope.from}::date
      and r."periodStart" <= ${scope.to}::date
      and (${scope.branchIds}::text[] is null
           or r."branchId" is null
           or r."branchId" = any(${scope.branchIds}::text[]))
    group by 1, 2
    order by 1
  `;

  const inCurrency = rows.filter((row) => row.currency === currency);
  const others = [...new Set(rows.filter((row) => row.currency !== currency).map((r) => r.currency))]
    .sort()
    .join(', ');

  const capped = capRows(
    inCurrency.map<PayrollRow>((row) => ({
      period: toDateOnly(row.period),
      currency,
      runs: row.runs,
      employees: row.employees,
      grossMinor: big(row.gross).toString(),
      deductionMinor: big(row.deduction).toString(),
      netMinor: big(row.net).toString(),
      deductionRatePpm:
        big(row.gross) > 0n
          ? Number((big(row.deduction) * 1_000_000n) / big(row.gross))
          : null,
    })),
  );

  const gross = capped.rows.reduce((total, row) => total + BigInt(row.grossMinor), 0n);
  const deduction = capped.rows.reduce((total, row) => total + BigInt(row.deductionMinor), 0n);
  const net = capped.rows.reduce((total, row) => total + BigInt(row.netMinor), 0n);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      currency,
      runs: capped.rows.reduce((total, row) => total + row.runs, 0),
      grossMinor: gross.toString(),
      deductionMinor: deduction.toString(),
      netMinor: net.toString(),
      deductionRatePpm: gross > 0n ? Number((deduction * 1_000_000n) / gross) : null,
      otherCurrencies: others === '' ? null : others,
    },
    series: [
      moneySeries(
        'reports.series.payrollNet',
        scope,
        currency,
        exponentFor(currency),
        new Map(capped.rows.map((row) => [row.period, BigInt(row.netMinor)])),
      ),
    ],
  });
}
