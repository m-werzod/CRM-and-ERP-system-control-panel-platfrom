/**
 * Payroll runs: create a period, calculate it, approve it, pay it.
 *
 * A run is a DOCUMENT, not a query. `calculatePayrollRun` writes the computed
 * breakdown into `PayrollItem.breakdown` as a SNAPSHOT — the component amounts, the
 * rates, the hours and the resulting lines, all frozen — rather than a reference to
 * the live `SalaryComponent` rows. That is the whole point: an approved run must show
 * exactly what somebody was paid and why, and a payslip that re-derived itself from
 * today's salary table would change under you the moment anybody got a raise.
 *
 * FOUR EYES: the approver may not be the person who calculated the run. Payroll is
 * the largest single outflow most institutions have, and a single pair of hands
 * between "compute" and "pay" is how it goes missing.
 *
 * The state machine is DRAFT -> CALCULATED -> APPROVED -> PAID, with CANCELLED
 * available from anywhere before payment. Recalculating is allowed while a run is
 * DRAFT or CALCULATED and replaces its items; once APPROVED, the items are the
 * record and nothing here rewrites them.
 */

import type {
  PayrollRunStatus,
  Prisma,
} from '@/generated/prisma/client';
import {
  prisma,
  withSerializableRetry,
  withTransaction,
  type Db,
  type Tx,
} from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  requirePermission,
  scopeFilter,
  scopeFilterNullableBranch,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import { currencyFor } from '@/server/services/finance/currency';
import { dateOnlyToPrismaDate, type DateOnly } from '@/lib/dates';
import {
  countWorkingDays,
  dateOnlyOf,
  employeeDisplayName,
  isUniqueViolation,
  toPage,
  type PageInput,
  type Paginated,
} from '@/server/services/hr/shared';
import { toSpecs } from '@/server/services/hr/salary';
import {
  getPayrollCalculator,
  selectEffectiveComponents,
  type PayrollComputation,
  type ProRationMode,
} from '@/server/services/hr/payroll/calculator';

/** Statuses whose items may still be recomputed. */
const RECALCULABLE: readonly PayrollRunStatus[] = ['DRAFT', 'CALCULATED'];

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePayrollRunInput {
  readonly periodStart: DateOnly;
  readonly periodEnd: DateOnly;
  /** Null for an organisation-wide run; only an ORGANIZATION-scoped caller may. */
  readonly branchId?: string | null;
  readonly currency?: string;
  readonly calculatorKey?: string;
  readonly notes?: string | null;
}

export interface PayrollRunSummary {
  readonly id: string;
  readonly branchId: string | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: PayrollRunStatus;
  readonly currency: string;
  readonly totalGrossMinor: string;
  readonly totalDeductionMinor: string;
  readonly totalNetMinor: string;
  readonly calculatorKey: string | null;
  readonly calculatedById: string | null;
  readonly calculatedAt: Date | null;
  readonly approvedById: string | null;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly notes: string | null;
  readonly itemCount: number;
}

export async function createPayrollRun(
  ctx: AccessContext,
  input: CreatePayrollRunInput,
  db?: Db,
): Promise<PayrollRunSummary> {
  // There is no `payroll.create` in the catalogue; whoever may calculate a run is
  // who may open one, which is the same person in every institution we know of.
  requirePermission(ctx, 'payroll.calculate');

  if (input.periodEnd < input.periodStart) {
    throw new BusinessRuleError(
      'payroll.period_inverted',
      'The period end cannot be before the period start.',
    );
  }

  // An organisation-wide run (branchId null) aggregates every branch, so only a
  // caller who can see every branch may open one; a branch-scoped caller gets their
  // own branch rather than a silent cross-branch run.
  const branchId =
    input.branchId === undefined
      ? ctx.scope === 'ORGANIZATION'
        ? null
        : (ctx.primaryBranchId ?? null)
      : input.branchId;
  if (branchId) assertBranchAccess(ctx, branchId, 'payroll run');
  if (!branchId && ctx.scope !== 'ORGANIZATION') {
    throw new ForbiddenError(
      'An organisation-wide payroll run needs access to every branch. Choose your branch instead.',
    );
  }

  // Validated before anything is written: a stored key nothing can resolve would
  // leave a run that cannot be calculated.
  const calculator = getPayrollCalculator(input.calculatorKey);

  return withTransaction(
    async (tx) => {
      const currency = await currencyFor(
        { organizationId: ctx.organizationId, branchId, requested: input.currency },
        tx,
      );

      let run: PayrollRunRow;
      try {
        run = await tx.payrollRun.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            periodStart: dateOnlyToPrismaDate(input.periodStart),
            periodEnd: dateOnlyToPrismaDate(input.periodEnd),
            status: 'DRAFT',
            currency,
            calculatorKey: calculator.key,
            notes: input.notes ?? null,
          },
          select: SELECT_RUN,
        });
      } catch (error) {
        // The unique (organizationId, branchId, periodStart, periodEnd).
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            `A payroll run already exists for ${input.periodStart} to ${input.periodEnd}${
              branchId ? ' in this branch' : ''
            }. Open that run instead of creating a second one.`,
            { details: { periodStart: input.periodStart, periodEnd: input.periodEnd, branchId } },
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'payroll.run_created',
          entityType: 'PayrollRun',
          entityId: run.id,
          branchId,
          summary: `Payroll run opened for ${input.periodStart} to ${input.periodEnd}`,
          metadata: { currency, calculatorKey: calculator.key },
        },
        tx,
      );

      return toRunSummary(run, 0);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Calculate
// ---------------------------------------------------------------------------

export interface CalculatePayrollRunInput {
  readonly proRation?: ProRationMode;
}

export interface SkippedEmployee {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly reason: string;
}

export interface CalculatePayrollRunResult {
  readonly run: PayrollRunSummary;
  readonly itemCount: number;
  /** Employees left out, with the reason. Never silently paid zero. */
  readonly skipped: readonly SkippedEmployee[];
  readonly daysInPeriod: number;
}

/**
 * Compute every payslip in the run and snapshot them.
 *
 * SERIALIZABLE, because this both reads the inputs (salary components, attendance,
 * lessons) and writes money figures derived from them: at a weaker level two
 * concurrent calculations of the same run can each delete the other's items and the
 * stored totals end up describing neither.
 *
 * An employee whose components are missing or misconfigured is SKIPPED with a reason
 * rather than given a zero payslip — a zero that looks like a decision is worse than
 * a name on a list of exceptions.
 */
export async function calculatePayrollRun(
  ctx: AccessContext,
  runId: string,
  input: CalculatePayrollRunInput = {},
  db?: Db,
): Promise<CalculatePayrollRunResult> {
  requirePermission(ctx, 'payroll.calculate');

  return withSerializableRetry(
    async (tx) => {
      const run = await loadRunForWrite(ctx, tx, runId);
      if (!RECALCULABLE.includes(run.status)) {
        throw new StateInvalidError('payroll run', run.status.toLowerCase(), 'calculated');
      }

      const periodStart = dateOnlyOf(run.periodStart);
      const periodEnd = dateOnlyOf(run.periodEnd);
      const { timezone, workingDays } = await getSettings(
        ['timezone', 'workingDays'],
        { organizationId: ctx.organizationId, branchId: run.branchId },
        tx,
      );
      const daysInPeriod = countWorkingDays(periodStart, periodEnd, workingDays, timezone);
      if (daysInPeriod === 0) {
        throw new BusinessRuleError(
          'payroll.no_working_days',
          'This period contains no working days, so there is nothing to pay.',
        );
      }

      // Everyone employed for any part of the period, including somebody who left
      // part-way through: they are owed the days they worked.
      const employees = await tx.employee.findMany({
        where: {
          ...scopeFilter(ctx),
          deletedAt: null,
          ...(run.branchId ? { branchId: run.branchId } : {}),
          hireDate: { lte: run.periodEnd },
          OR: [{ terminationDate: null }, { terminationDate: { gte: run.periodStart } }],
        },
        orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
        select: {
          id: true,
          employeeCode: true,
          user: { select: { firstName: true, lastName: true } },
          teacher: { select: { id: true } },
        },
      });

      if (employees.length === 0) {
        throw new BusinessRuleError(
          'payroll.no_employees',
          'No employees fall inside this payroll period.',
        );
      }

      const employeeIds = employees.map((employee) => employee.id);
      const teacherIds = employees
        .map((employee) => employee.teacher?.id)
        .filter((id): id is string => id !== undefined);

      // Three batched queries for the whole run, folded into Maps. One query per
      // employee would be 3N round trips on the slowest job in the product.
      const [componentRows, attendanceTallies, lessonTallies] = await Promise.all([
        tx.salaryComponent.findMany({
          where: {
            employeeId: { in: employeeIds },
            effectiveFrom: { lte: run.periodEnd },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: run.periodStart } }],
          },
          select: {
            id: true,
            employeeId: true,
            type: true,
            calcType: true,
            name: true,
            amountMinor: true,
            percentPpm: true,
            currency: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        }),
        tx.employeeAttendance.groupBy({
          by: ['employeeId', 'status'],
          where: {
            employeeId: { in: employeeIds },
            organizationId: ctx.organizationId,
            workDate: { gte: run.periodStart, lte: run.periodEnd },
          },
          _count: { _all: true },
          _sum: { workedMinutes: true },
        }),
        teacherIds.length === 0
          ? Promise.resolve([])
          : tx.lesson.groupBy({
              by: ['teacherId'],
              where: {
                teacherId: { in: teacherIds },
                organizationId: ctx.organizationId,
                lessonDate: { gte: run.periodStart, lte: run.periodEnd },
                // Only lessons actually delivered are payable work.
                status: 'COMPLETED',
              },
              _count: { _all: true },
            }),
      ]);

      const componentsByEmployee = new Map<string, typeof componentRows>();
      for (const row of componentRows) {
        const list = componentsByEmployee.get(row.employeeId) ?? [];
        list.push(row);
        componentsByEmployee.set(row.employeeId, list);
      }

      interface AttendanceTally {
        daysPresent: number;
        daysAbsent: number;
        daysOnLeave: number;
        workedMinutes: number;
      }
      const attendanceByEmployee = new Map<string, AttendanceTally>();
      for (const tally of attendanceTallies) {
        const current: AttendanceTally =
          attendanceByEmployee.get(tally.employeeId) ??
          { daysPresent: 0, daysAbsent: 0, daysOnLeave: 0, workedMinutes: 0 };
        const days = tally._count._all;
        if (tally.status === 'ABSENT') current.daysAbsent += days;
        else if (tally.status === 'ON_LEAVE') current.daysOnLeave += days;
        else if (tally.status !== 'HOLIDAY') current.daysPresent += days;
        current.workedMinutes += tally._sum.workedMinutes ?? 0;
        attendanceByEmployee.set(tally.employeeId, current);
      }

      const lessonsByTeacher = new Map<string, number>(
        lessonTallies.map((tally) => [tally.teacherId ?? '', tally._count._all]),
      );

      const calculator = getPayrollCalculator(run.calculatorKey);
      const skipped: SkippedEmployee[] = [];
      const items: Prisma.PayrollItemCreateManyInput[] = [];
      let totalGrossMinor = 0n;
      let totalDeductionMinor = 0n;
      let totalNetMinor = 0n;

      for (const employee of employees) {
        const name = employeeDisplayName(employee);
        const specs = selectEffectiveComponents(
          toSpecs(componentsByEmployee.get(employee.id) ?? []),
          periodEnd,
        );
        if (specs.length === 0) {
          skipped.push({
            employeeId: employee.id,
            employeeName: name,
            reason: 'No salary components are in force for this period.',
          });
          continue;
        }

        const attendance =
          attendanceByEmployee.get(employee.id) ??
          { daysPresent: 0, daysAbsent: 0, daysOnLeave: 0, workedMinutes: 0 };
        const lessonsTaught = employee.teacher
          ? (lessonsByTeacher.get(employee.teacher.id) ?? 0)
          : 0;
        const hoursWorked = attendance.workedMinutes / 60;

        let computation: PayrollComputation;
        try {
          computation = calculator.calculate({
            components: specs,
            hoursWorked,
            lessonsTaught,
            daysPresent: attendance.daysPresent,
            daysInPeriod,
            currency: run.currency,
            proRation: input.proRation,
          });
        } catch (error) {
          // A misconfigured component stops that one payslip, not the whole run: the
          // exception list is what the operator fixes and recalculates.
          if (error instanceof BusinessRuleError) {
            skipped.push({ employeeId: employee.id, employeeName: name, reason: error.publicMessage });
            logger.warn('payroll.employee_skipped', {
              requestId: ctx.requestId,
              organizationId: ctx.organizationId,
              payrollRunId: run.id,
              employeeId: employee.id,
              rule: error.details?.['rule'],
            });
            continue;
          }
          throw error;
        }

        totalGrossMinor += computation.grossMinor;
        totalDeductionMinor += computation.deductionMinor;
        totalNetMinor += computation.netMinor;

        items.push({
          payrollRunId: run.id,
          employeeId: employee.id,
          grossMinor: computation.grossMinor,
          deductionMinor: computation.deductionMinor,
          netMinor: computation.netMinor,
          currency: computation.currency,
          hoursWorked,
          lessonsTaught,
          daysPresent: attendance.daysPresent,
          daysAbsent: attendance.daysAbsent,
          daysOnLeave: attendance.daysOnLeave,
          breakdown: serializeComputation(computation, {
            calculatorKey: calculator.key,
            periodStart,
            periodEnd,
            daysInPeriod,
            hoursWorked,
            lessonsTaught,
            daysPresent: attendance.daysPresent,
            proRation: input.proRation ?? 'NONE',
          }),
          status: 'PENDING',
        });
      }

      // Recalculating replaces the previous attempt wholesale. Safe only because the
      // status guard above excludes APPROVED and PAID runs, whose items are the
      // record of what was paid.
      await tx.payrollItem.deleteMany({ where: { payrollRunId: run.id } });
      if (items.length > 0) await tx.payrollItem.createMany({ data: items });

      const updated = await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'CALCULATED',
          totalGrossMinor,
          totalDeductionMinor,
          totalNetMinor,
          calculatorKey: calculator.key,
          calculatedById: ctx.isSystem ? null : ctx.userId,
          calculatedAt: new Date(),
          // A recalculation invalidates an earlier approval; the guard above means we
          // can only get here from DRAFT or CALCULATED, so this is belt and braces.
          approvedById: null,
          approvedAt: null,
        },
        select: SELECT_RUN,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.PAYROLL_CALCULATED,
          entityType: 'PayrollRun',
          entityId: run.id,
          branchId: run.branchId,
          summary: `Payroll calculated for ${periodStart} to ${periodEnd}: ${items.length} payslip(s)`,
          severity: 'NOTICE',
          metadata: {
            itemCount: items.length,
            skippedCount: skipped.length,
            totalGrossMinor: totalGrossMinor.toString(),
            totalNetMinor: totalNetMinor.toString(),
            currency: run.currency,
            calculatorKey: calculator.key,
          },
        },
        tx,
      );

      return {
        run: toRunSummary(updated, items.length),
        itemCount: items.length,
        skipped,
        daysInPeriod,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Approve / pay
// ---------------------------------------------------------------------------

export async function approvePayrollRun(
  ctx: AccessContext,
  runId: string,
  input: { readonly note?: string | null } = {},
  db?: Db,
): Promise<PayrollRunSummary> {
  requirePermission(ctx, 'payroll.approve');

  return withTransaction(
    async (tx) => {
      const run = await loadRunForWrite(ctx, tx, runId);
      if (run.status !== 'CALCULATED') {
        throw new StateInvalidError('payroll run', run.status.toLowerCase(), 'approved');
      }
      if (ctx.isSystem) {
        throw new ForbiddenError('A payroll run must be approved by a person, not an automation.');
      }
      if (run.calculatedById && run.calculatedById === ctx.userId) {
        throw new ForbiddenError(
          'You calculated this payroll run, so somebody else must approve it.',
        );
      }

      const itemCount = await tx.payrollItem.count({ where: { payrollRunId: run.id } });
      if (itemCount === 0) {
        throw new BusinessRuleError(
          'payroll.nothing_to_approve',
          'This run has no payslips. Calculate it first.',
        );
      }

      const updated = await tx.payrollRun.update({
        where: { id: run.id },
        data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date() },
        select: SELECT_RUN,
      });
      await tx.payrollItem.updateMany({
        where: { payrollRunId: run.id, status: 'PENDING' },
        data: { status: 'APPROVED' },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.PAYROLL_APPROVED,
          entityType: 'PayrollRun',
          entityId: run.id,
          branchId: run.branchId,
          summary: `Payroll approved for ${dateOnlyOf(run.periodStart)} to ${dateOnlyOf(run.periodEnd)}`,
          reason: input.note ?? null,
          severity: 'WARNING',
          metadata: {
            itemCount,
            totalNetMinor: updated.totalNetMinor.toString(),
            currency: updated.currency,
            calculatedById: run.calculatedById,
          },
        },
        tx,
      );

      return toRunSummary(updated, itemCount);
    },
    { existing: db },
  );
}

export async function markPayrollPaid(
  ctx: AccessContext,
  runId: string,
  input: { readonly paidAt?: Date; readonly note?: string | null } = {},
  db?: Db,
): Promise<PayrollRunSummary> {
  requirePermission(ctx, 'payroll.markPaid');

  return withTransaction(
    async (tx) => {
      const run = await loadRunForWrite(ctx, tx, runId);
      if (run.status !== 'APPROVED') {
        throw new StateInvalidError('payroll run', run.status.toLowerCase(), 'marked paid');
      }

      const paidAt = input.paidAt ?? new Date();
      const updated = await tx.payrollRun.update({
        where: { id: run.id },
        data: { status: 'PAID', paidAt },
        select: SELECT_RUN,
      });
      const paid = await tx.payrollItem.updateMany({
        where: { payrollRunId: run.id, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'PAID', paidAt },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.PAYROLL_PAID,
          entityType: 'PayrollRun',
          entityId: run.id,
          branchId: run.branchId,
          summary: `Payroll marked paid: ${updated.totalNetMinor.toString()} ${updated.currency} across ${paid.count} payslip(s)`,
          reason: input.note ?? null,
          severity: 'WARNING',
          metadata: {
            paidItems: paid.count,
            totalNetMinor: updated.totalNetMinor.toString(),
            currency: updated.currency,
          },
        },
        tx,
      );

      return toRunSummary(updated, paid.count);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListPayrollRunsInput extends PageInput {
  readonly branchId?: string;
  readonly status?: PayrollRunStatus | readonly PayrollRunStatus[];
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly sortDir?: 'asc' | 'desc';
}

export async function listPayrollRuns(
  ctx: AccessContext,
  input: ListPayrollRunsInput = {},
  db?: Db,
): Promise<Paginated<PayrollRunSummary>> {
  requirePermission(ctx, 'payroll.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'payroll run');

  const statuses = input.status
    ? Array.isArray(input.status)
      ? [...input.status]
      : [input.status]
    : undefined;

  const where: Prisma.PayrollRunWhereInput = {
    // An organisation-wide run has no branch, and is visible to anyone in the
    // organisation who may see payroll at all.
    ...scopeFilterNullableBranch(ctx),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(input.from ? { periodEnd: { gte: dateOnlyToPrismaDate(input.from) } } : {}),
    ...(input.to ? { periodStart: { lte: dateOnlyToPrismaDate(input.to) } } : {}),
  };

  const [rows, total] = await Promise.all([
    client.payrollRun.findMany({
      where,
      orderBy: [{ periodStart: input.sortDir ?? 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: { ...SELECT_RUN, _count: { select: { items: true } } },
    }),
    client.payrollRun.count({ where }),
  ]);

  return {
    items: rows.map((row) => toRunSummary(row, row._count.items)),
    page,
    pageSize,
    total,
  };
}

export interface PayrollItemRow {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly grossMinor: string;
  readonly deductionMinor: string;
  readonly netMinor: string;
  readonly currency: string;
  readonly hoursWorked: number | null;
  readonly lessonsTaught: number | null;
  readonly daysPresent: number | null;
  readonly daysAbsent: number | null;
  readonly daysOnLeave: number | null;
  readonly status: string;
  readonly paidAt: Date | null;
  /** The frozen snapshot written when the run was calculated. */
  readonly breakdown: Prisma.JsonValue;
}

export interface PayrollRunDetail {
  readonly run: PayrollRunSummary;
  readonly items: Paginated<PayrollItemRow>;
}

export async function getPayrollRun(
  ctx: AccessContext,
  runId: string,
  input: PageInput = {},
  db?: Db,
): Promise<PayrollRunDetail> {
  requirePermission(ctx, 'payroll.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const run = await client.payrollRun.findFirst({
    where: { id: runId, ...scopeFilterNullableBranch(ctx) },
    select: { ...SELECT_RUN, _count: { select: { items: true } } },
  });
  if (!run) throw new NotFoundError('Payroll run', runId);

  const rows = await client.payrollItem.findMany({
    where: { payrollRunId: run.id },
    orderBy: [{ employee: { user: { lastName: 'asc' } } }, { employee: { user: { firstName: 'asc' } } }],
    skip,
    take,
    select: {
      id: true,
      employeeId: true,
      grossMinor: true,
      deductionMinor: true,
      netMinor: true,
      currency: true,
      hoursWorked: true,
      lessonsTaught: true,
      daysPresent: true,
      daysAbsent: true,
      daysOnLeave: true,
      status: true,
      paidAt: true,
      breakdown: true,
      employee: {
        select: { employeeCode: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });

  return {
    run: toRunSummary(run, run._count.items),
    items: {
      items: rows.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        employeeCode: row.employee.employeeCode,
        employeeName: employeeDisplayName(row.employee),
        grossMinor: row.grossMinor.toString(),
        deductionMinor: row.deductionMinor.toString(),
        netMinor: row.netMinor.toString(),
        currency: row.currency,
        hoursWorked: row.hoursWorked,
        lessonsTaught: row.lessonsTaught,
        daysPresent: row.daysPresent,
        daysAbsent: row.daysAbsent,
        daysOnLeave: row.daysOnLeave,
        status: row.status,
        paidAt: row.paidAt,
        breakdown: row.breakdown,
      })),
      page,
      pageSize,
      total: run._count.items,
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SELECT_RUN = {
  id: true,
  branchId: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  currency: true,
  totalGrossMinor: true,
  totalDeductionMinor: true,
  totalNetMinor: true,
  calculatorKey: true,
  calculatedById: true,
  calculatedAt: true,
  approvedById: true,
  approvedAt: true,
  paidAt: true,
  notes: true,
} as const;

interface PayrollRunRow {
  readonly id: string;
  readonly branchId: string | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: PayrollRunStatus;
  readonly currency: string;
  readonly totalGrossMinor: bigint;
  readonly totalDeductionMinor: bigint;
  readonly totalNetMinor: bigint;
  readonly calculatorKey: string | null;
  readonly calculatedById: string | null;
  readonly calculatedAt: Date | null;
  readonly approvedById: string | null;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly notes: string | null;
}

function toRunSummary(run: PayrollRunRow, itemCount: number): PayrollRunSummary {
  return {
    id: run.id,
    branchId: run.branchId,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    status: run.status,
    currency: run.currency,
    totalGrossMinor: run.totalGrossMinor.toString(),
    totalDeductionMinor: run.totalDeductionMinor.toString(),
    totalNetMinor: run.totalNetMinor.toString(),
    calculatorKey: run.calculatorKey,
    calculatedById: run.calculatedById,
    calculatedAt: run.calculatedAt,
    approvedById: run.approvedById,
    approvedAt: run.approvedAt,
    paidAt: run.paidAt,
    notes: run.notes,
    itemCount,
  };
}

async function loadRunForWrite(
  ctx: AccessContext,
  tx: Tx,
  runId: string,
): Promise<PayrollRunRow> {
  // Scope in the same `where` as the id, so a run in another branch is "not found"
  // rather than "yours to look at but not to touch".
  const run = await tx.payrollRun.findFirst({
    where: { id: runId, ...scopeFilterNullableBranch(ctx) },
    select: SELECT_RUN,
  });
  if (!run) throw new NotFoundError('Payroll run', runId);
  return run;
}

interface SnapshotContext {
  readonly calculatorKey: string;
  readonly periodStart: DateOnly;
  readonly periodEnd: DateOnly;
  readonly daysInPeriod: number;
  readonly hoursWorked: number;
  readonly lessonsTaught: number;
  readonly daysPresent: number;
  readonly proRation: ProRationMode;
}

/**
 * The payslip as stored JSON.
 *
 * Self-contained on purpose: the inputs as well as the outputs, and the ruleset key,
 * so the row alone explains the figure without a join to anything that can change.
 * Minor units become decimal strings because JSON has no integer wide enough and
 * `JSON.stringify` throws on BigInt.
 */
function serializeComputation(
  computation: PayrollComputation,
  context: SnapshotContext,
): Prisma.InputJsonValue {
  return {
    version: 1,
    calculatorKey: context.calculatorKey,
    period: { start: context.periodStart, end: context.periodEnd, workingDays: context.daysInPeriod },
    inputs: {
      hoursWorked: context.hoursWorked,
      lessonsTaught: context.lessonsTaught,
      daysPresent: context.daysPresent,
      proRation: context.proRation,
    },
    currency: computation.currency,
    totals: {
      baseMinor: computation.baseMinor.toString(),
      grossMinor: computation.grossMinor.toString(),
      deductionMinor: computation.deductionMinor.toString(),
      netMinor: computation.netMinor.toString(),
      shortfallMinor: computation.shortfallMinor.toString(),
    },
    lines: computation.breakdown.map((line) => ({
      componentId: line.componentId,
      name: line.name,
      type: line.type,
      calcType: line.calcType,
      effect: line.effect,
      amountMinor: line.amountMinor.toString(),
      basisMinor: line.basisMinor?.toString() ?? null,
      percentPpm: line.percentPpm,
      rateMinor: line.rateMinor?.toString() ?? null,
      quantity: line.quantity,
      note: line.note,
    })),
  };
}
