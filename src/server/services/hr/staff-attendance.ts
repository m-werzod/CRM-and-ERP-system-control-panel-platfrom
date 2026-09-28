/**
 * Staff attendance: check-in, check-out, the administrator's manual entry, and the
 * monthly report payroll reads.
 *
 * ONE ROW PER EMPLOYEE PER DAY, enforced by the unique index
 * `(employeeId, workDate)` rather than by an application check — a terminal
 * retrying a request or a staff member double-tapping the kiosk cannot produce two
 * rows even if both requests pass a read-then-write test at the same instant. The
 * violation is translated here into a sentence rather than a constraint name.
 *
 * LATENESS AND OVERTIME need an expected working window, and the schema has no
 * office-hours field on `Branch` (see the note in the module report). Rather than
 * invent one, the window is resolved honestly, in this order:
 *
 *   1. the window the caller supplied — a kiosk or an HR screen that knows the shift;
 *   2. for a teacher, the earliest lesson start and latest lesson end on that date,
 *      which is a real, auditable expectation already in the database;
 *   3. nothing — in which case `minutesLate` and `overtimeMinutes` stay 0.
 *
 * Step 3 matters: reporting somebody late against a guessed 09:00 would be a
 * fabricated figure, and this is the sort of number that ends up in a disciplinary
 * conversation.
 */

import type {
  AttendanceMethod,
  EmployeeAttendanceStatus,
  EmploymentStatus,
  Prisma,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  requirePermission,
  restrictedToOwn,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import {
  dateOnlyToPrismaDate,
  minutesBetween,
  toZonedDateOnly,
  zonedWallClockToInstant,
  type DateOnly,
  type TimeZone,
} from '@/lib/dates';
import {
  countWorkingDays,
  employeeDisplayName,
  isUniqueViolation,
  loadScopedEmployee,
  monthBounds,
  selfEmployeeFilter,
  toPage,
  type ScopedEmployee,
  type PageInput,
  type Paginated,
} from '@/server/services/hr/shared';

/** Employment states in which somebody can no longer record attendance. */
const ENDED_EMPLOYMENT: readonly EmploymentStatus[] = ['TERMINATED', 'RESIGNED'];

/** Statuses that mean the person was at work in some form. */
const PRESENT_STATUSES: readonly EmployeeAttendanceStatus[] = [
  'PRESENT',
  'LATE',
  'REMOTE',
  'HALF_DAY',
];

// ---------------------------------------------------------------------------
// The expected working window
// ---------------------------------------------------------------------------

export type ExpectedWindowSource = 'supplied' | 'timetable' | 'unknown';

export interface ExpectedWindow {
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly source: ExpectedWindowSource;
}

export interface ExpectedWindowOverride {
  /** Local wall-clock minutes from midnight, e.g. 540 for 09:00. */
  readonly expectedStartMinute?: number | null;
  readonly expectedEndMinute?: number | null;
}

async function resolveExpectedWindow(
  tx: Tx,
  input: {
    readonly employee: ScopedEmployee;
    readonly workDate: DateOnly;
    readonly timezone: TimeZone;
    readonly override?: ExpectedWindowOverride;
  },
): Promise<ExpectedWindow> {
  const { expectedStartMinute, expectedEndMinute } = input.override ?? {};
  if (expectedStartMinute != null || expectedEndMinute != null) {
    return {
      startsAt:
        expectedStartMinute == null
          ? null
          : zonedWallClockToInstant(input.workDate, expectedStartMinute, input.timezone),
      endsAt:
        expectedEndMinute == null
          ? null
          : zonedWallClockToInstant(input.workDate, expectedEndMinute, input.timezone),
      source: 'supplied',
    };
  }

  const teacherId = input.employee.teacher?.id;
  if (!teacherId) return { startsAt: null, endsAt: null, source: 'unknown' };

  // Aggregated in SQL: the first lesson the teacher is due to teach that day and the
  // last one they are due to finish. A cancelled lesson is not an obligation.
  const window = await tx.lesson.aggregate({
    where: {
      teacherId,
      lessonDate: dateOnlyToPrismaDate(input.workDate),
      status: { not: 'CANCELLED' },
    },
    _min: { startsAt: true },
    _max: { endsAt: true },
  });

  if (!window._min.startsAt) return { startsAt: null, endsAt: null, source: 'unknown' };
  return { startsAt: window._min.startsAt, endsAt: window._max.endsAt, source: 'timetable' };
}

export interface StaffTiming {
  readonly minutesLate: number;
  readonly overtimeMinutes: number;
  readonly workedMinutes: number | null;
  readonly status: EmployeeAttendanceStatus;
}

/**
 * Turn a pair of instants and an expected window into the stored figures.
 *
 * Pure and exported so the kiosk, the HR screen and the tests all agree on the
 * rule. With no expected start there is no lateness to report — see the module
 * header.
 */
export function computeStaffTiming(input: {
  readonly checkInAt: Date;
  readonly checkOutAt?: Date | null;
  readonly expectedStartAt?: Date | null;
  readonly expectedEndAt?: Date | null;
}): StaffTiming {
  const minutesLate = input.expectedStartAt
    ? Math.max(0, minutesBetween(input.expectedStartAt, input.checkInAt))
    : 0;
  const workedMinutes = input.checkOutAt
    ? Math.max(0, minutesBetween(input.checkInAt, input.checkOutAt))
    : null;
  const overtimeMinutes =
    input.checkOutAt && input.expectedEndAt
      ? Math.max(0, minutesBetween(input.expectedEndAt, input.checkOutAt))
      : 0;

  return {
    minutesLate,
    overtimeMinutes,
    workedMinutes,
    status: minutesLate > 0 ? 'LATE' : 'PRESENT',
  };
}

// ---------------------------------------------------------------------------
// Check in / check out
// ---------------------------------------------------------------------------

export interface CheckInInput extends ExpectedWindowOverride {
  /** Defaults to the caller's own employee record. */
  readonly employeeId?: string;
  /** The instant observed. Defaults to now; a terminal may post it late. */
  readonly at?: Date;
  readonly method?: AttendanceMethod;
  readonly deviceId?: string | null;
  readonly confidencePpm?: number | null;
  readonly note?: string | null;
}

export interface StaffAttendanceRecord {
  readonly id: string;
  readonly employeeId: string;
  readonly workDate: Date;
  readonly checkInAt: Date | null;
  readonly checkOutAt: Date | null;
  readonly status: EmployeeAttendanceStatus;
  readonly minutesLate: number;
  readonly overtimeMinutes: number;
  readonly workedMinutes: number | null;
  readonly expectedWindowSource: ExpectedWindowSource;
}

export async function checkIn(
  ctx: AccessContext,
  input: CheckInInput = {},
  db?: Db,
): Promise<StaffAttendanceRecord> {
  requirePermission(ctx, 'employeeAttendance.mark');

  return withTransaction(
    async (tx) => {
      const employee = await resolveSubject(ctx, tx, input.employeeId);
      const at = input.at ?? new Date();

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: employee.branchId },
        tx,
      );
      // The calendar day is the branch's, not the server's: a 00:30 shift start in
      // Tashkent belongs to that day even though it is still the previous day in UTC.
      const workDate = toZonedDateOnly(at, timezone);
      const expected = await resolveExpectedWindow(tx, {
        employee,
        workDate,
        timezone,
        override: input,
      });
      const timing = computeStaffTiming({ checkInAt: at, expectedStartAt: expected.startsAt });

      try {
        const row = await tx.employeeAttendance.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: employee.branchId,
            employeeId: employee.id,
            workDate: dateOnlyToPrismaDate(workDate),
            checkInAt: at,
            status: timing.status,
            minutesLate: timing.minutesLate,
            method: input.method ?? 'MANUAL',
            deviceId: input.deviceId ?? null,
            confidencePpm: input.confidencePpm ?? null,
            note: input.note ?? null,
            markedById: ctx.isSystem ? null : ctx.userId,
          },
          select: SELECT_RECORD,
        });
        return { ...row, expectedWindowSource: expected.source };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            `${employeeDisplayName(employee)} has already been checked in for ${workDate}.`,
            { details: { employeeId: employee.id, workDate } },
          );
        }
        throw error;
      }
    },
    { existing: db },
  );
}

export interface CheckOutInput extends ExpectedWindowOverride {
  readonly employeeId?: string;
  readonly at?: Date;
  readonly note?: string | null;
}

export async function checkOut(
  ctx: AccessContext,
  input: CheckOutInput = {},
  db?: Db,
): Promise<StaffAttendanceRecord> {
  requirePermission(ctx, 'employeeAttendance.mark');

  return withTransaction(
    async (tx) => {
      const employee = await resolveSubject(ctx, tx, input.employeeId);
      const at = input.at ?? new Date();

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: employee.branchId },
        tx,
      );
      const workDate = toZonedDateOnly(at, timezone);

      // Scope is in the same `where` as the key, so a caller who cannot see the
      // branch gets "not found" rather than a check-out they are not entitled to.
      const existing = await tx.employeeAttendance.findFirst({
        where: {
          employeeId: employee.id,
          workDate: dateOnlyToPrismaDate(workDate),
          ...scopeFilter(ctx),
        },
        select: { id: true, checkInAt: true, checkOutAt: true, minutesLate: true, status: true },
      });
      if (!existing || !existing.checkInAt) {
        throw new NotFoundError(`Check-in for ${employeeDisplayName(employee)} on ${workDate}`);
      }
      if (existing.checkOutAt) {
        throw new StateInvalidError('staff attendance', 'already checked out', 'checked out again');
      }
      if (at < existing.checkInAt) {
        throw new BusinessRuleError(
          'staff_attendance.checkout_before_checkin',
          'The check-out time is before the check-in time.',
        );
      }

      const expected = await resolveExpectedWindow(tx, {
        employee,
        workDate,
        timezone,
        override: input,
      });
      const timing = computeStaffTiming({
        checkInAt: existing.checkInAt,
        checkOutAt: at,
        expectedStartAt: expected.startsAt,
        expectedEndAt: expected.endsAt,
      });

      const row = await tx.employeeAttendance.update({
        where: { id: existing.id },
        data: {
          checkOutAt: at,
          workedMinutes: timing.workedMinutes,
          overtimeMinutes: timing.overtimeMinutes,
          // `status` and `minutesLate` were settled at check-in and are left alone:
          // recomputing them here would let a late arrival be erased by a
          // check-out posted with a different expected window.
          ...(input.note ? { note: input.note } : {}),
        },
        select: SELECT_RECORD,
      });

      return { ...row, expectedWindowSource: expected.source };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

export interface RecordStaffAttendanceInput {
  readonly employeeId: string;
  readonly workDate: DateOnly;
  readonly status: EmployeeAttendanceStatus;
  readonly checkInAt?: Date | null;
  readonly checkOutAt?: Date | null;
  readonly minutesLate?: number;
  readonly overtimeMinutes?: number;
  readonly note?: string | null;
  readonly reason?: string | null;
}

/**
 * Record or amend one day for one employee, as an administrator.
 *
 * An upsert rather than a create: correcting a day that already has a row is the
 * common case (somebody forgot to check out, or a sick day needs recording after
 * the fact), and the unique index makes "insert or amend" the only honest shape.
 * Overwriting an existing row is audited at NOTICE, because changing somebody's
 * recorded attendance after the event feeds payroll.
 */
export async function recordStaffAttendance(
  ctx: AccessContext,
  input: RecordStaffAttendanceInput,
  db?: Db,
): Promise<StaffAttendanceRecord> {
  requirePermission(ctx, 'employeeAttendance.edit');

  if (input.checkInAt && input.checkOutAt && input.checkOutAt < input.checkInAt) {
    throw new BusinessRuleError(
      'staff_attendance.checkout_before_checkin',
      'The check-out time is before the check-in time.',
    );
  }

  return withTransaction(
    async (tx) => {
      const employee = await loadScopedEmployee(ctx, tx, input.employeeId);
      const workDate = dateOnlyToPrismaDate(input.workDate);

      const existing = await tx.employeeAttendance.findFirst({
        where: { employeeId: employee.id, workDate, ...scopeFilter(ctx) },
        select: { id: true, status: true, checkInAt: true, checkOutAt: true },
      });

      const workedMinutes =
        input.checkInAt && input.checkOutAt
          ? Math.max(0, minutesBetween(input.checkInAt, input.checkOutAt))
          : null;

      const data = {
        status: input.status,
        checkInAt: input.checkInAt ?? null,
        checkOutAt: input.checkOutAt ?? null,
        workedMinutes,
        minutesLate: input.minutesLate ?? 0,
        overtimeMinutes: input.overtimeMinutes ?? 0,
        note: input.note ?? null,
        method: 'MANUAL' as const,
        markedById: ctx.isSystem ? null : ctx.userId,
      };

      const row = existing
        ? await tx.employeeAttendance.update({
            where: { id: existing.id },
            data,
            select: SELECT_RECORD,
          })
        : await tx.employeeAttendance.create({
            data: {
              organizationId: ctx.organizationId,
              branchId: employee.branchId,
              employeeId: employee.id,
              workDate,
              ...data,
            },
            select: SELECT_RECORD,
          });

      await recordAudit(
        ctx,
        {
          // No AUDIT_ACTIONS member covers staff attendance; the student-attendance
          // keys are reserved for AttendanceRecord so the audit log stays filterable
          // by subject.
          action: existing ? 'employee_attendance.amended' : 'employee_attendance.recorded',
          entityType: 'EmployeeAttendance',
          entityId: row.id,
          branchId: employee.branchId,
          summary: `${employeeDisplayName(employee)} recorded ${input.status} on ${input.workDate}`,
          reason: input.reason ?? null,
          severity: existing ? 'NOTICE' : 'INFO',
          changes: existing
            ? { status: { from: existing.status, to: input.status } }
            : null,
          metadata: { employeeId: employee.id, workDate: input.workDate },
        },
        tx,
      );

      // The figures on a manual row are whatever the administrator entered, so the
      // window is "supplied" only when they actually supplied one.
      const suppliedTiming = input.minutesLate !== undefined || input.overtimeMinutes !== undefined;
      return { ...row, expectedWindowSource: suppliedTiming ? 'supplied' : 'unknown' };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const SELECT_RECORD = {
  id: true,
  employeeId: true,
  workDate: true,
  checkInAt: true,
  checkOutAt: true,
  status: true,
  minutesLate: true,
  overtimeMinutes: true,
  workedMinutes: true,
} as const;

/**
 * A listed day carries no `expectedWindowSource`: the window was resolved when the
 * row was written and is not re-derived for a list, so reporting one would be a
 * guess about how an old row came to say what it says.
 */
export interface StaffAttendanceListRow extends Omit<StaffAttendanceRecord, 'expectedWindowSource'> {
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string;
  readonly method: AttendanceMethod;
  readonly note: string | null;
}

export interface ListStaffAttendanceInput extends PageInput {
  readonly employeeId?: string;
  readonly branchId?: string;
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly status?: EmployeeAttendanceStatus | readonly EmployeeAttendanceStatus[];
  readonly sortDir?: 'asc' | 'desc';
}

export async function listStaffAttendance(
  ctx: AccessContext,
  input: ListStaffAttendanceInput = {},
  db?: Db,
): Promise<Paginated<StaffAttendanceListRow>> {
  requirePermission(ctx, 'employeeAttendance.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'staff attendance');

  const statuses = input.status
    ? Array.isArray(input.status)
      ? [...input.status]
      : [input.status]
    : undefined;

  const where: Prisma.EmployeeAttendanceWhereInput = {
    // A staff member sees their own days; a supervisor with `approve` sees everyone
    // in their branches.
    ...composeReadFilter(ctx, {
      selfFilter: selfEmployeeFilter(ctx),
      escapeHatch: 'employeeAttendance.approve',
    }),
    ...(input.employeeId ? { employeeId: input.employeeId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(input.from || input.to
      ? {
          workDate: {
            ...(input.from ? { gte: dateOnlyToPrismaDate(input.from) } : {}),
            ...(input.to ? { lte: dateOnlyToPrismaDate(input.to) } : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    client.employeeAttendance.findMany({
      where,
      orderBy: [{ workDate: input.sortDir ?? 'desc' }, { employeeId: 'asc' }],
      skip,
      take,
      select: {
        ...SELECT_RECORD,
        branchId: true,
        method: true,
        note: true,
        employee: {
          select: { employeeCode: true, user: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    client.employeeAttendance.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      workDate: row.workDate,
      checkInAt: row.checkInAt,
      checkOutAt: row.checkOutAt,
      status: row.status,
      minutesLate: row.minutesLate,
      overtimeMinutes: row.overtimeMinutes,
      workedMinutes: row.workedMinutes,
      employeeCode: row.employee.employeeCode,
      employeeName: employeeDisplayName(row.employee),
      branchId: row.branchId,
      method: row.method,
      note: row.note,
    })),
    page,
    pageSize,
    total,
  };
}

export interface StaffAttendanceSummaryRow {
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly branchId: string;
  readonly daysPresent: number;
  readonly daysAbsent: number;
  readonly daysLate: number;
  readonly daysOnLeave: number;
  readonly daysHoliday: number;
  readonly daysRemote: number;
  readonly daysHalf: number;
  readonly daysRecorded: number;
  readonly totalWorkedMinutes: number;
  readonly totalOvertimeMinutes: number;
  readonly totalMinutesLate: number;
}

export interface StaffAttendanceSummary extends Paginated<StaffAttendanceSummaryRow> {
  readonly month: string;
  readonly firstDay: DateOnly;
  readonly lastDay: DateOnly;
  /** Working days the month contains, per `academic.workingDays`. */
  readonly workingDaysInMonth: number;
}

export interface StaffAttendanceSummaryInput extends PageInput {
  /** `YYYY-MM`. Defaults to the current month in the organisation timezone. */
  readonly month?: string;
  readonly employeeId?: string;
  readonly branchId?: string;
  readonly includeEnded?: boolean;
}

/**
 * Per employee, per month: days present / absent / late / on leave and the minutes
 * actually worked.
 *
 * The employees come first and the tallies are aggregated over that page, so an
 * employee with no rows at all appears with zeros — which is the row an HR manager
 * is actually looking for. Counting is done by the database (`groupBy`), never by
 * pulling a month of rows into memory.
 */
export async function getStaffAttendanceSummary(
  ctx: AccessContext,
  input: StaffAttendanceSummaryInput = {},
  db?: Db,
): Promise<StaffAttendanceSummary> {
  requirePermission(ctx, 'employeeAttendance.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'staff attendance');

  const { timezone, workingDays } = await getSettings(
    ['timezone', 'workingDays'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? ctx.primaryBranchId },
    client,
  );
  const bounds = monthBounds(input.month ?? toZonedDateOnly(new Date(), timezone).slice(0, 7));

  const employeeWhere: Prisma.EmployeeWhereInput = {
    ...scopeFilter(ctx),
    deletedAt: null,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.employeeId ? { id: input.employeeId } : {}),
    ...(input.includeEnded ? {} : { status: { notIn: [...ENDED_EMPLOYMENT] } }),
    // A staff member without `employeeAttendance.approve` sees only their own line.
    ...(restrictedToOwn(ctx, 'employeeAttendance.approve')
      ? { id: ctx.self.employeeId ?? '' }
      : {}),
  };

  const [employees, total] = await Promise.all([
    client.employee.findMany({
      where: employeeWhere,
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
      skip,
      take,
      select: {
        id: true,
        employeeCode: true,
        branchId: true,
        user: { select: { firstName: true, lastName: true } },
      },
    }),
    client.employee.count({ where: employeeWhere }),
  ]);

  const employeeIds = employees.map((employee) => employee.id);
  const tallies =
    employeeIds.length === 0
      ? []
      : await client.employeeAttendance.groupBy({
          by: ['employeeId', 'status'],
          where: {
            employeeId: { in: employeeIds },
            organizationId: ctx.organizationId,
            workDate: {
              gte: dateOnlyToPrismaDate(bounds.firstDay),
              lte: dateOnlyToPrismaDate(bounds.lastDay),
            },
          },
          _count: { _all: true },
          _sum: { workedMinutes: true, overtimeMinutes: true, minutesLate: true },
        });

  const byEmployee = new Map<string, StaffAttendanceSummaryRow>(
    employees.map((employee) => [
      employee.id,
      {
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        employeeName: employeeDisplayName(employee),
        branchId: employee.branchId,
        daysPresent: 0,
        daysAbsent: 0,
        daysLate: 0,
        daysOnLeave: 0,
        daysHoliday: 0,
        daysRemote: 0,
        daysHalf: 0,
        daysRecorded: 0,
        totalWorkedMinutes: 0,
        totalOvertimeMinutes: 0,
        totalMinutesLate: 0,
      },
    ]),
  );

  for (const tally of tallies) {
    const current = byEmployee.get(tally.employeeId);
    if (!current) continue;
    const days = tally._count._all;
    byEmployee.set(tally.employeeId, {
      ...current,
      daysRecorded: current.daysRecorded + days,
      // PRESENT counts the days worked in full; LATE is counted both as a day
      // present and as a late day, because a late arrival is still attendance.
      daysPresent: current.daysPresent + (PRESENT_STATUSES.includes(tally.status) ? days : 0),
      daysAbsent: current.daysAbsent + (tally.status === 'ABSENT' ? days : 0),
      daysLate: current.daysLate + (tally.status === 'LATE' ? days : 0),
      daysOnLeave: current.daysOnLeave + (tally.status === 'ON_LEAVE' ? days : 0),
      daysHoliday: current.daysHoliday + (tally.status === 'HOLIDAY' ? days : 0),
      daysRemote: current.daysRemote + (tally.status === 'REMOTE' ? days : 0),
      daysHalf: current.daysHalf + (tally.status === 'HALF_DAY' ? days : 0),
      totalWorkedMinutes: current.totalWorkedMinutes + (tally._sum.workedMinutes ?? 0),
      totalOvertimeMinutes: current.totalOvertimeMinutes + (tally._sum.overtimeMinutes ?? 0),
      totalMinutesLate: current.totalMinutesLate + (tally._sum.minutesLate ?? 0),
    });
  }

  return {
    items: employeeIds.map((id) => byEmployee.get(id)).filter(isPresent),
    page,
    pageSize,
    total,
    month: bounds.month,
    firstDay: bounds.firstDay,
    lastDay: bounds.lastDay,
    workingDaysInMonth: countWorkingDays(bounds.firstDay, bounds.lastDay, workingDays, timezone),
  };
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Who this check-in is for. Defaults to the caller; marking somebody else needs
 * `employeeAttendance.edit`, because a kiosk operator recording a colleague's
 * arrival is editing a payroll input rather than clocking in.
 */
async function resolveSubject(
  ctx: AccessContext,
  tx: Tx,
  employeeId: string | undefined,
): Promise<ScopedEmployee> {
  const targetId = employeeId ?? ctx.self.employeeId;
  if (!targetId) {
    throw new BusinessRuleError(
      'staff_attendance.no_employee_record',
      'This account is not linked to an employee record, so it cannot record attendance.',
    );
  }
  if (targetId !== ctx.self.employeeId) requirePermission(ctx, 'employeeAttendance.edit');

  const employee = await loadScopedEmployee(ctx, tx, targetId);
  if (ENDED_EMPLOYMENT.includes(employee.status)) {
    throw new StateInvalidError('employee', employee.status.toLowerCase(), 'checked in');
  }
  return employee;
}
