/**
 * Leave: the types an institution offers, requests against them, and the decision.
 *
 * WORKING DAYS, NOT CALENDAR DAYS. A request from Friday to Monday costs two days
 * where Saturday is a working day and Sunday is not, and the count is stored on the
 * row (`LeaveRequest.days`) precisely so that a later change to the working-day
 * setting does not silently re-price leave somebody has already taken.
 *
 * FOUR EYES. The approver may not be the requester. Nothing else in this module is
 * as load-bearing: self-approved leave is the cheapest possible fraud, and the check
 * is here rather than in the UI because hiding the button is not a control.
 *
 * APPROVAL WRITES ATTENDANCE. On approval, an `EmployeeAttendance` row with status
 * ON_LEAVE is written for every working day covered, so the monthly report shows the
 * person on leave rather than absent — and so payroll, which reads those rows, does
 * not treat authorised leave as an unexplained absence.
 */

import type { LeaveRequestStatus, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  DuplicateError,
  ForbiddenError,
  LimitExceededError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  diffFields,
  record as recordAudit,
} from '@/server/audit';
import {
  assertBranchAccess,
  can,
  organizationFilter,
  requirePermission,
  restrictedToOwn,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import {
  dateOnlyOf,
  employeeBranchScope,
  employeeDisplayName,
  isUniqueViolation,
  loadScopedEmployee,
  toPage,
  workingDatesBetween,
  yearBounds,
  type PageInput,
  type Paginated,
  type ScopedEmployee,
} from '@/server/services/hr/shared';

/** Statuses that hold a claim on the calendar, so a new request may not overlap. */
const BLOCKING_STATUSES: readonly LeaveRequestStatus[] = ['PENDING', 'APPROVED'];

// ---------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------

export interface LeaveTypeInput {
  readonly name: string;
  readonly code: string;
  readonly isPaid?: boolean;
  readonly maxDaysPerYear?: number | null;
  readonly requiresApproval?: boolean;
  readonly requiresDocument?: boolean;
}

export interface LeaveTypeSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isPaid: boolean;
  readonly maxDaysPerYear: number | null;
  readonly requiresApproval: boolean;
  readonly requiresDocument: boolean;
  readonly isActive: boolean;
}

export async function createLeaveType(
  ctx: AccessContext,
  input: LeaveTypeInput,
  db?: Db,
): Promise<LeaveTypeSummary> {
  requirePermission(ctx, 'leave.manageTypes');

  if (input.maxDaysPerYear != null && input.maxDaysPerYear <= 0) {
    throw new BusinessRuleError(
      'leave_type.non_positive_allowance',
      'An annual allowance must be at least one day. Leave it empty for unlimited.',
    );
  }

  return withTransaction(
    async (tx) => {
      let leaveType: LeaveTypeSummary;
      try {
        leaveType = await tx.leaveType.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            code: input.code.trim().toUpperCase(),
            isPaid: input.isPaid ?? true,
            maxDaysPerYear: input.maxDaysPerYear ?? null,
            requiresApproval: input.requiresApproval ?? true,
            requiresDocument: input.requiresDocument ?? false,
          },
          select: SELECT_LEAVE_TYPE,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) {
          throw new DuplicateError(
            'leave type',
            ['code'],
            `A leave type with the code ${input.code.trim().toUpperCase()} already exists.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'leave_type.created',
          entityType: 'LeaveType',
          entityId: leaveType.id,
          summary: `Leave type ${leaveType.name} (${leaveType.code}) created`,
          metadata: { isPaid: leaveType.isPaid, maxDaysPerYear: leaveType.maxDaysPerYear },
        },
        tx,
      );

      return leaveType;
    },
    { existing: db },
  );
}

export interface UpdateLeaveTypeInput extends Partial<LeaveTypeInput> {
  readonly isActive?: boolean;
}

export async function updateLeaveType(
  ctx: AccessContext,
  leaveTypeId: string,
  input: UpdateLeaveTypeInput,
  db?: Db,
): Promise<LeaveTypeSummary> {
  requirePermission(ctx, 'leave.manageTypes');

  return withTransaction(
    async (tx) => {
      const existing = await tx.leaveType.findFirst({
        where: { id: leaveTypeId, ...organizationFilter(ctx) },
        select: SELECT_LEAVE_TYPE,
      });
      if (!existing) throw new NotFoundError('Leave type', leaveTypeId);

      const data: Prisma.LeaveTypeUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code.trim().toUpperCase();
      if (input.isPaid !== undefined) data.isPaid = input.isPaid;
      if (input.maxDaysPerYear !== undefined) data.maxDaysPerYear = input.maxDaysPerYear;
      if (input.requiresApproval !== undefined) data.requiresApproval = input.requiresApproval;
      if (input.requiresDocument !== undefined) data.requiresDocument = input.requiresDocument;
      if (input.isActive !== undefined) data.isActive = input.isActive;

      let updated: LeaveTypeSummary;
      try {
        updated = await tx.leaveType.update({
          where: { id: existing.id },
          data,
          select: SELECT_LEAVE_TYPE,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) {
          throw new DuplicateError('leave type', ['code']);
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'leave_type.updated',
          entityType: 'LeaveType',
          entityId: existing.id,
          summary: `Leave type ${updated.name} (${updated.code}) updated`,
          changes: diffFields(
            {
              name: existing.name,
              code: existing.code,
              isPaid: existing.isPaid,
              maxDaysPerYear: existing.maxDaysPerYear,
              requiresApproval: existing.requiresApproval,
              isActive: existing.isActive,
            },
            {
              name: input.name,
              code: input.code,
              isPaid: input.isPaid,
              maxDaysPerYear: input.maxDaysPerYear,
              requiresApproval: input.requiresApproval,
              isActive: input.isActive,
            },
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

export interface ListLeaveTypesInput extends PageInput {
  readonly includeInactive?: boolean;
  readonly q?: string;
}

export async function listLeaveTypes(
  ctx: AccessContext,
  input: ListLeaveTypesInput = {},
  db?: Db,
): Promise<Paginated<LeaveTypeSummary>> {
  requirePermission(ctx, 'leave.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const where: Prisma.LeaveTypeWhereInput = {
    ...organizationFilter(ctx),
    ...(input.includeInactive ? {} : { isActive: true }),
    ...(input.q ? { name: { contains: input.q, mode: 'insensitive' } } : {}),
  };

  const [items, total] = await Promise.all([
    client.leaveType.findMany({ where, orderBy: { name: 'asc' }, skip, take, select: SELECT_LEAVE_TYPE }),
    client.leaveType.count({ where }),
  ]);

  return { items, page, pageSize, total };
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

export interface RequestLeaveInput {
  /** Defaults to the caller's own employee record. */
  readonly employeeId?: string;
  readonly leaveTypeId: string;
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
  readonly reason?: string | null;
}

export interface LeaveRequestSummary {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly leaveTypeId: string;
  readonly leaveTypeName: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly days: number;
  readonly status: LeaveRequestStatus;
  readonly reason: string | null;
  readonly rejectionReason: string | null;
  readonly approvedById: string | null;
  readonly approvedAt: Date | null;
}

export async function requestLeave(
  ctx: AccessContext,
  input: RequestLeaveInput,
  db?: Db,
): Promise<LeaveRequestSummary> {
  requirePermission(ctx, 'leave.request');

  if (input.endDate < input.startDate) {
    throw new BusinessRuleError(
      'leave.end_before_start',
      'The last day of leave cannot be before the first.',
    );
  }

  return withTransaction(
    async (tx) => {
      const employee = await resolveLeaveSubject(ctx, tx, input.employeeId);

      const leaveType = await tx.leaveType.findFirst({
        where: { id: input.leaveTypeId, ...organizationFilter(ctx), isActive: true },
        select: {
          id: true,
          name: true,
          code: true,
          maxDaysPerYear: true,
          requiresApproval: true,
        },
      });
      if (!leaveType) throw new NotFoundError('Leave type', input.leaveTypeId);

      const { timezone, workingDays } = await getSettings(
        ['timezone', 'workingDays'],
        { organizationId: ctx.organizationId, branchId: employee.branchId },
        tx,
      );

      const dates = workingDatesBetween(input.startDate, input.endDate, workingDays, timezone);
      if (dates.length === 0) {
        throw new BusinessRuleError(
          'leave.no_working_days',
          'That range contains no working days, so there is no leave to take.',
          { details: { startDate: input.startDate, endDate: input.endDate } },
        );
      }
      const days = dates.length;

      // Overlap check covers PENDING as well as APPROVED: two pending requests for
      // the same week would both be approvable, and the second approval would then
      // double-book the same days.
      const overlapping = await tx.leaveRequest.findFirst({
        where: {
          employeeId: employee.id,
          status: { in: [...BLOCKING_STATUSES] },
          startDate: { lte: dateOnlyToPrismaDate(input.endDate) },
          endDate: { gte: dateOnlyToPrismaDate(input.startDate) },
        },
        select: { id: true, startDate: true, endDate: true, status: true },
      });
      if (overlapping) {
        throw new ConflictError(
          'This overlaps leave that is already requested or approved.',
          {
            details: {
              leaveRequestId: overlapping.id,
              status: overlapping.status,
            },
          },
        );
      }

      if (leaveType.maxDaysPerYear != null) {
        const year = Number(input.startDate.slice(0, 4));
        const { firstDay, lastDay } = yearBounds(year);
        // Counted against requests that START in the year, matching how the balance
        // report attributes them, so the two figures can never disagree.
        const taken = await tx.leaveRequest.aggregate({
          where: {
            employeeId: employee.id,
            leaveTypeId: leaveType.id,
            status: 'APPROVED',
            startDate: {
              gte: dateOnlyToPrismaDate(firstDay),
              lte: dateOnlyToPrismaDate(lastDay),
            },
          },
          _sum: { days: true },
        });
        const already = taken._sum.days ?? 0;
        if (already + days > leaveType.maxDaysPerYear) {
          throw new LimitExceededError(
            `${leaveType.name} allows ${leaveType.maxDaysPerYear} days a year; ${already} are already approved for ${year}.`,
            {
              leaveTypeId: leaveType.id,
              maxDaysPerYear: leaveType.maxDaysPerYear,
              alreadyApprovedDays: already,
              requestedDays: days,
            },
          );
        }
      }

      // A type that needs no approval is approved on submission, with no approver
      // recorded — nobody signed it off, and pretending otherwise would put a name
      // against a decision that was never made.
      const autoApproved = !leaveType.requiresApproval;
      const now = new Date();

      const created = await tx.leaveRequest.create({
        data: {
          organizationId: ctx.organizationId,
          employeeId: employee.id,
          leaveTypeId: leaveType.id,
          startDate: dateOnlyToPrismaDate(input.startDate),
          endDate: dateOnlyToPrismaDate(input.endDate),
          days,
          reason: input.reason ?? null,
          status: autoApproved ? 'APPROVED' : 'PENDING',
          approvedAt: autoApproved ? now : null,
        },
        select: SELECT_REQUEST,
      });

      if (autoApproved) {
        await writeOnLeaveAttendance(tx, ctx, { employee, dates });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAVE_REQUESTED,
          entityType: 'LeaveRequest',
          entityId: created.id,
          branchId: employee.branchId,
          summary: `${employeeDisplayName(employee)} requested ${days} day(s) of ${leaveType.name}`,
          reason: input.reason ?? null,
          metadata: {
            leaveTypeCode: leaveType.code,
            startDate: input.startDate,
            endDate: input.endDate,
            days,
            autoApproved,
          },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: employee.id,
            type: autoApproved ? 'leave.approved' : 'leave.requested',
            title: `${leaveType.name}: ${input.startDate} to ${input.endDate}`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return toRequestSummary(created);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export async function approveLeave(
  ctx: AccessContext,
  leaveRequestId: string,
  input: { readonly note?: string | null } = {},
  db?: Db,
): Promise<LeaveRequestSummary> {
  requirePermission(ctx, 'leave.approve');

  return withTransaction(
    async (tx) => {
      const request = await loadRequestForDecision(ctx, tx, leaveRequestId);
      assertNotOwnRequest(ctx, request, 'approve');

      const { timezone, workingDays } = await getSettings(
        ['timezone', 'workingDays'],
        { organizationId: ctx.organizationId, branchId: request.employee.branchId },
        tx,
      );
      const dates = workingDatesBetween(
        dateOnlyOf(request.startDate),
        dateOnlyOf(request.endDate),
        workingDays,
        timezone,
      );

      const updated = await tx.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          approvedById: ctx.isSystem ? null : ctx.userId,
          approvedAt: new Date(),
          rejectionReason: null,
        },
        select: SELECT_REQUEST,
      });

      await writeOnLeaveAttendance(tx, ctx, { employee: request.employee, dates });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAVE_DECIDED,
          entityType: 'LeaveRequest',
          entityId: request.id,
          branchId: request.employee.branchId,
          summary: `${request.leaveType.name} approved for ${employeeDisplayName(request.employee)}`,
          reason: input.note ?? null,
          severity: 'NOTICE',
          metadata: { decision: 'APPROVED', days: request.days, attendanceDays: dates.length },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: request.employeeId,
            type: 'leave.approved',
            title: `${request.leaveType.name} approved`,
            description: input.note ?? null,
          },
        },
        tx,
      );

      return toRequestSummary(updated);
    },
    { existing: db },
  );
}

export async function rejectLeave(
  ctx: AccessContext,
  leaveRequestId: string,
  input: { readonly reason: string },
  db?: Db,
): Promise<LeaveRequestSummary> {
  requirePermission(ctx, 'leave.approve');

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      'leave.rejection_without_reason',
      'A rejected leave request must say why.',
    );
  }

  return withTransaction(
    async (tx) => {
      const request = await loadRequestForDecision(ctx, tx, leaveRequestId);
      assertNotOwnRequest(ctx, request, 'reject');

      const updated = await tx.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          approvedById: ctx.isSystem ? null : ctx.userId,
          approvedAt: new Date(),
          rejectionReason: input.reason,
        },
        select: SELECT_REQUEST,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAVE_DECIDED,
          entityType: 'LeaveRequest',
          entityId: request.id,
          branchId: request.employee.branchId,
          summary: `${request.leaveType.name} rejected for ${employeeDisplayName(request.employee)}`,
          reason: input.reason,
          severity: 'NOTICE',
          metadata: { decision: 'REJECTED', days: request.days },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: request.employeeId,
            type: 'leave.rejected',
            title: `${request.leaveType.name} rejected`,
            description: input.reason,
          },
        },
        tx,
      );

      return toRequestSummary(updated);
    },
    { existing: db },
  );
}

/**
 * Withdraw a request, whether or not it was approved.
 *
 * Cancelling an approved request removes the ON_LEAVE attendance rows it wrote — but
 * only the ones that carry no check-in and are still ON_LEAVE. A day the person
 * actually turned up for, or that an administrator has since recorded differently,
 * is somebody else's record and is left alone.
 */
export async function cancelLeave(
  ctx: AccessContext,
  leaveRequestId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<LeaveRequestSummary> {
  requirePermission(ctx, 'leave.request');

  return withTransaction(
    async (tx) => {
      const request = await loadRequestForDecision(ctx, tx, leaveRequestId, {
        allowStatuses: ['PENDING', 'APPROVED'],
      });

      const isOwn = ctx.self.employeeId === request.employeeId;
      if (!isOwn && !can(ctx, 'leave.approve')) {
        throw new ForbiddenError('You can only cancel your own leave requests.');
      }

      const updated = await tx.leaveRequest.update({
        where: { id: request.id },
        data: { status: 'CANCELLED' },
        select: SELECT_REQUEST,
      });

      let attendanceRemoved = 0;
      if (request.status === 'APPROVED') {
        const removed = await tx.employeeAttendance.deleteMany({
          where: {
            employeeId: request.employeeId,
            organizationId: ctx.organizationId,
            status: 'ON_LEAVE',
            checkInAt: null,
            workDate: { gte: request.startDate, lte: request.endDate },
          },
        });
        attendanceRemoved = removed.count;
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAVE_DECIDED,
          entityType: 'LeaveRequest',
          entityId: request.id,
          branchId: request.employee.branchId,
          summary: `${request.leaveType.name} cancelled for ${employeeDisplayName(request.employee)}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: { decision: 'CANCELLED', days: request.days, attendanceRemoved },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: request.employeeId,
            type: 'leave.cancelled',
            title: `${request.leaveType.name} cancelled`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return toRequestSummary(updated);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListLeaveRequestsInput extends PageInput {
  readonly employeeId?: string;
  readonly leaveTypeId?: string;
  readonly status?: LeaveRequestStatus | readonly LeaveRequestStatus[];
  readonly branchId?: string;
  /** Requests overlapping this window. */
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly sortDir?: 'asc' | 'desc';
}

export async function listLeaveRequests(
  ctx: AccessContext,
  input: ListLeaveRequestsInput = {},
  db?: Db,
): Promise<Paginated<LeaveRequestSummary>> {
  requirePermission(ctx, 'leave.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'leave request');

  const statuses = input.status
    ? Array.isArray(input.status)
      ? [...input.status]
      : [input.status]
    : undefined;

  // LeaveRequest carries no branchId, so the branch narrowing goes through the
  // `employee` relation. A requested branch REPLACES the scope list rather than
  // widening it, which is safe only because `assertBranchAccess` above has already
  // verified the caller may see it.
  const employeeFilter: Prisma.EmployeeWhereInput = {
    ...(ctx.scope === 'ORGANIZATION' ? {} : { branchId: { in: [...ctx.branchIds] } }),
    ...(input.branchId ? { branchId: input.branchId } : {}),
  };

  // Fail closed: a SELF-scoped caller with no employee link matches nothing rather
  // than everything.
  const selfNarrowing: Prisma.LeaveRequestWhereInput | null = restrictedToOwn(ctx, 'leave.approve')
    ? { employeeId: { in: ctx.self.employeeId ? [ctx.self.employeeId] : [] } }
    : null;

  // Composed as an AND list rather than one merged object: the SELF narrowing and a
  // caller-supplied `employeeId` both key on `employeeId`, and a spread would let
  // the filter silently overwrite the narrowing.
  const where: Prisma.LeaveRequestWhereInput = {
    AND: [
      organizationFilter(ctx),
      ...(Object.keys(employeeFilter).length > 0 ? [{ employee: employeeFilter }] : []),
      ...(selfNarrowing ? [selfNarrowing] : []),
      {
        ...(input.employeeId ? { employeeId: input.employeeId } : {}),
        ...(input.leaveTypeId ? { leaveTypeId: input.leaveTypeId } : {}),
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(input.to ? { startDate: { lte: dateOnlyToPrismaDate(input.to) } } : {}),
        ...(input.from ? { endDate: { gte: dateOnlyToPrismaDate(input.from) } } : {}),
      },
    ],
  };

  const [rows, total] = await Promise.all([
    client.leaveRequest.findMany({
      where,
      orderBy: [{ startDate: input.sortDir ?? 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: SELECT_REQUEST,
    }),
    client.leaveRequest.count({ where }),
  ]);

  return { items: rows.map(toRequestSummary), page, pageSize, total };
}

export interface LeaveBalanceRow {
  readonly leaveTypeId: string;
  readonly name: string;
  readonly code: string;
  readonly isPaid: boolean;
  readonly maxDaysPerYear: number | null;
  readonly approvedDays: number;
  readonly pendingDays: number;
  /** Null when the type has no annual cap. */
  readonly remainingDays: number | null;
}

export interface LeaveBalance {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly year: number;
  readonly entitlements: readonly LeaveBalanceRow[];
}

/**
 * What an employee has taken and has left this year, per leave type.
 *
 * Attributed by the request's START date, exactly as the entitlement check in
 * `requestLeave` does — a request spanning New Year counts against the year it began
 * in, and the two figures must agree or a request is rejected against a balance the
 * employee cannot see.
 */
export async function getLeaveBalance(
  ctx: AccessContext,
  input: { readonly employeeId: string; readonly year?: number },
  db?: Db,
): Promise<LeaveBalance> {
  requirePermission(ctx, 'leave.view');
  const client = db ?? prisma;

  if (
    restrictedToOwn(ctx, 'leave.approve') &&
    input.employeeId !== ctx.self.employeeId
  ) {
    // No existence leak here: the caller already knows their own employee id, so
    // this cannot be used to probe for other people's.
    throw new ForbiddenError('You can only see your own leave balance.');
  }

  const employee = await loadScopedEmployee(ctx, client, input.employeeId);

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: employee.branchId },
    client,
  );
  const year = input.year ?? Number(todayIn(timezone).slice(0, 4));
  const { firstDay, lastDay } = yearBounds(year);

  const [types, tallies] = await Promise.all([
    client.leaveType.findMany({
      where: { ...organizationFilter(ctx), isActive: true },
      orderBy: { name: 'asc' },
      select: SELECT_LEAVE_TYPE,
    }),
    client.leaveRequest.groupBy({
      by: ['leaveTypeId', 'status'],
      where: {
        employeeId: employee.id,
        organizationId: ctx.organizationId,
        status: { in: [...BLOCKING_STATUSES] },
        startDate: {
          gte: dateOnlyToPrismaDate(firstDay),
          lte: dateOnlyToPrismaDate(lastDay),
        },
      },
      _sum: { days: true },
    }),
  ]);

  const approved = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const tally of tallies) {
    const target = tally.status === 'APPROVED' ? approved : pending;
    target.set(tally.leaveTypeId, (target.get(tally.leaveTypeId) ?? 0) + (tally._sum.days ?? 0));
  }

  return {
    employeeId: employee.id,
    employeeName: employeeDisplayName(employee),
    year,
    entitlements: types.map((type) => {
      const approvedDays = approved.get(type.id) ?? 0;
      return {
        leaveTypeId: type.id,
        name: type.name,
        code: type.code,
        isPaid: type.isPaid,
        maxDaysPerYear: type.maxDaysPerYear,
        approvedDays,
        pendingDays: pending.get(type.id) ?? 0,
        remainingDays:
          type.maxDaysPerYear == null ? null : Math.max(0, type.maxDaysPerYear - approvedDays),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SELECT_LEAVE_TYPE = {
  id: true,
  name: true,
  code: true,
  isPaid: true,
  maxDaysPerYear: true,
  requiresApproval: true,
  requiresDocument: true,
  isActive: true,
} as const;

const SELECT_REQUEST = {
  id: true,
  employeeId: true,
  leaveTypeId: true,
  startDate: true,
  endDate: true,
  days: true,
  status: true,
  reason: true,
  rejectionReason: true,
  approvedById: true,
  approvedAt: true,
  employee: { select: { user: { select: { firstName: true, lastName: true } } } },
  leaveType: { select: { name: true } },
} as const;

interface RequestRow {
  readonly id: string;
  readonly employeeId: string;
  readonly leaveTypeId: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly days: number;
  readonly status: LeaveRequestStatus;
  readonly reason: string | null;
  readonly rejectionReason: string | null;
  readonly approvedById: string | null;
  readonly approvedAt: Date | null;
  readonly employee: { readonly user: { readonly firstName: string; readonly lastName: string } };
  readonly leaveType: { readonly name: string };
}

function toRequestSummary(row: RequestRow): LeaveRequestSummary {
  return {
    id: row.id,
    employeeId: row.employeeId,
    employeeName: employeeDisplayName(row.employee),
    leaveTypeId: row.leaveTypeId,
    leaveTypeName: row.leaveType.name,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    status: row.status,
    reason: row.reason,
    rejectionReason: row.rejectionReason,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
  };
}

interface DecisionSubject {
  readonly id: string;
  readonly employeeId: string;
  readonly status: LeaveRequestStatus;
  readonly days: number;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly employee: ScopedEmployee;
  readonly leaveType: { readonly name: string };
}

async function loadRequestForDecision(
  ctx: AccessContext,
  tx: Tx,
  leaveRequestId: string,
  options: { readonly allowStatuses?: readonly LeaveRequestStatus[] } = {},
): Promise<DecisionSubject> {
  // Tenancy and the branch narrowing are in the same `where` as the id.
  const request = await tx.leaveRequest.findFirst({
    where: { id: leaveRequestId, ...organizationFilter(ctx), ...employeeBranchScope(ctx) },
    select: {
      id: true,
      employeeId: true,
      status: true,
      days: true,
      startDate: true,
      endDate: true,
      leaveType: { select: { name: true } },
    },
  });
  if (!request) throw new NotFoundError('Leave request', leaveRequestId);

  const allowed: readonly LeaveRequestStatus[] = options.allowStatuses ?? ['PENDING'];
  if (!allowed.includes(request.status)) {
    throw new StateInvalidError('leave request', request.status.toLowerCase(), 'decided');
  }

  const employee = await loadScopedEmployee(ctx, tx, request.employeeId);
  return { ...request, employee };
}

/**
 * Four eyes. Checked against the employee record AND the user account behind it, so
 * neither an administrator with two hats nor a self-filed request can slip through.
 */
function assertNotOwnRequest(
  ctx: AccessContext,
  request: DecisionSubject,
  action: string,
): void {
  if (ctx.isSystem) {
    throw new ForbiddenError('Leave decisions must be made by a person, not an automation.');
  }
  if (ctx.self.employeeId === request.employeeId || ctx.userId === request.employee.userId) {
    throw new ForbiddenError(`You cannot ${action} your own leave request.`);
  }
}

/** Filing leave for somebody else is a manager's act, not a self-service one. */
async function resolveLeaveSubject(
  ctx: AccessContext,
  tx: Tx,
  employeeId: string | undefined,
): Promise<ScopedEmployee> {
  const targetId = employeeId ?? ctx.self.employeeId;
  if (!targetId) {
    throw new BusinessRuleError(
      'leave.no_employee_record',
      'This account is not linked to an employee record, so it cannot request leave.',
    );
  }
  if (targetId !== ctx.self.employeeId) requirePermission(ctx, 'leave.approve');
  return loadScopedEmployee(ctx, tx, targetId);
}

/**
 * Write the ON_LEAVE attendance rows an approval implies.
 *
 * Two statements, both set-based: insert the days that have no row yet, then convert
 * any day already marked ABSENT — which is what retroactively approved sick leave
 * has to do. A day with a check-in is left as it is; the person worked.
 */
async function writeOnLeaveAttendance(
  tx: Tx,
  ctx: AccessContext,
  input: { readonly employee: ScopedEmployee; readonly dates: readonly DateOnly[] },
): Promise<void> {
  if (input.dates.length === 0) return;
  const workDates = input.dates.map(dateOnlyToPrismaDate);

  await tx.employeeAttendance.createMany({
    data: workDates.map((workDate) => ({
      organizationId: ctx.organizationId,
      branchId: input.employee.branchId,
      employeeId: input.employee.id,
      workDate,
      status: 'ON_LEAVE' as const,
      method: 'SYSTEM' as const,
      markedById: ctx.isSystem ? null : ctx.userId,
    })),
    // The unique index on (employeeId, workDate) is the authority; skipping lets
    // this run without a read-then-write race against a concurrent check-in.
    skipDuplicates: true,
  });

  await tx.employeeAttendance.updateMany({
    where: {
      employeeId: input.employee.id,
      organizationId: ctx.organizationId,
      workDate: { in: workDates },
      status: 'ABSENT',
    },
    data: { status: 'ON_LEAVE', method: 'SYSTEM' },
  });
}
