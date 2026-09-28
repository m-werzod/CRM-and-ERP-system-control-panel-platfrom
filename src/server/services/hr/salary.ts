/**
 * Salary structure: the dated building blocks payroll is computed from.
 *
 * THE HISTORY RULE, which this file exists to enforce:
 * changing pay NEVER updates an amount in place. It CLOSES the current
 * `SalaryComponent` row with an `effectiveTo` and OPENS a new one. A payroll run
 * approved in March must still be reproducible in December — it is the document an
 * employee was paid against and a tax authority may ask about — and editing the
 * amount the March run read would silently rewrite that history. The same rule, for
 * the same reason, as enrollments and teacher assignments.
 *
 * `Employee.baseSalaryMinor` is a DENORMALISED HEADLINE for the HR profile and the
 * only writer is this module: payroll reads the dated component rows, never that
 * column, so the two can never disagree about what somebody is actually paid.
 */

import type { SalaryCalcType, SalaryComponentType } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import { BusinessRuleError } from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { currencyFor } from '@/server/services/finance/currency';
import { formatMoney, money, type CurrencyCode } from '@/lib/money';
import { addDaysToDateOnly, dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import {
  dateOnlyOf,
  employeeDisplayName,
  loadScopedEmployee,
} from '@/server/services/hr/shared';
import {
  selectEffectiveComponents,
  type SalaryComponentSpec,
} from '@/server/services/hr/payroll/calculator';

/** The salary period a BASE component implies for the HR headline. */
const PERIOD_FOR_CALC_TYPE = {
  FIXED: 'MONTHLY',
  PERCENT_OF_BASE: 'MONTHLY',
  PER_HOUR: 'HOURLY',
  PER_LESSON: 'PER_LESSON',
} as const satisfies Record<SalaryCalcType, 'MONTHLY' | 'HOURLY' | 'PER_LESSON'>;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SetSalaryComponentInput {
  readonly employeeId: string;
  readonly type: SalaryComponentType;
  readonly calcType?: SalaryCalcType;
  /** Identifies the component across its versions, e.g. "Base salary". */
  readonly name: string;
  /** Minor units: the amount for FIXED, the rate for PER_HOUR / PER_LESSON. */
  readonly amountMinor?: bigint | null;
  readonly percentPpm?: number | null;
  readonly currency?: string;
  /** The day the new figure takes effect. Defaults to today. */
  readonly effectiveFrom?: DateOnly;
  readonly reason?: string | null;
}

export interface SalaryComponentRow {
  readonly id: string;
  readonly employeeId: string;
  readonly type: SalaryComponentType;
  readonly calcType: SalaryCalcType;
  readonly name: string;
  readonly amountMinor: string | null;
  readonly percentPpm: number | null;
  readonly currency: string | null;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly isOpen: boolean;
}

export interface SetSalaryComponentResult {
  readonly component: SalaryComponentRow;
  /** The row that was closed, when this replaced an existing figure. */
  readonly closedComponentId: string | null;
  readonly previousAmountMinor: string | null;
}

/**
 * Set or change one salary component.
 *
 * Closing the old row one day BEFORE the new one opens is deliberate: the effective
 * window is inclusive at both ends, so closing it on the same day would leave two
 * rows in force simultaneously and payroll would pay both.
 */
export async function setSalaryComponent(
  ctx: AccessContext,
  input: SetSalaryComponentInput,
  db?: Db,
): Promise<SetSalaryComponentResult> {
  requirePermission(ctx, 'employees.manageSalary');

  const calcType: SalaryCalcType = input.calcType ?? 'FIXED';

  if (calcType === 'PERCENT_OF_BASE') {
    if (input.percentPpm == null) {
      throw new BusinessRuleError(
        'salary.missing_percent',
        'A percentage component needs a rate.',
      );
    }
    if (!Number.isInteger(input.percentPpm) || input.percentPpm < 0 || input.percentPpm > 1_000_000) {
      throw new BusinessRuleError(
        'salary.invalid_percent',
        'A percentage must be between 0 and 100%.',
      );
    }
    if (input.type === 'BASE') {
      throw new BusinessRuleError(
        'salary.base_as_percentage',
        'A base salary cannot be defined as a percentage of itself.',
      );
    }
  } else {
    if (input.amountMinor == null) {
      throw new BusinessRuleError('salary.missing_amount', 'This component needs an amount.');
    }
    if (input.amountMinor < 0n) {
      // The type carries the sign: a negative "allowance" would be a deduction
      // nobody can find on the payslip.
      throw new BusinessRuleError(
        'salary.negative_amount',
        'Use a DEDUCTION component rather than a negative amount.',
      );
    }
  }

  return withTransaction(
    async (tx) => {
      const employee = await loadScopedEmployee(ctx, tx, input.employeeId);

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: employee.branchId },
        tx,
      );
      const effectiveFrom = input.effectiveFrom ?? todayIn(timezone);
      const effectiveFromDate = dateOnlyToPrismaDate(effectiveFrom);

      if (effectiveFromDate < employee.hireDate) {
        throw new BusinessRuleError(
          'salary.before_hire_date',
          'A salary cannot take effect before the employee was hired.',
        );
      }

      const currency = await currencyFor(
        {
          organizationId: ctx.organizationId,
          branchId: employee.branchId,
          requested: input.currency ?? employee.salaryCurrency,
        },
        tx,
      );

      // The component's identity across versions is (employee, type, name); a row is
      // "current" when its window has not closed before the new one opens.
      const current = await tx.salaryComponent.findFirst({
        where: {
          employeeId: employee.id,
          type: input.type,
          name: input.name,
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFromDate } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        select: {
          id: true,
          amountMinor: true,
          percentPpm: true,
          effectiveFrom: true,
          currency: true,
        },
      });

      if (current) {
        if (current.effectiveFrom >= effectiveFromDate) {
          throw new BusinessRuleError(
            'salary.not_after_current',
            `The current figure already takes effect on ${dateOnlyOf(current.effectiveFrom)}. A change must start after that.`,
            { details: { currentEffectiveFrom: dateOnlyOf(current.effectiveFrom) } },
          );
        }
        await tx.salaryComponent.update({
          where: { id: current.id },
          data: { effectiveTo: dateOnlyToPrismaDate(addDaysToDateOnly(effectiveFrom, -1)) },
        });
      }

      const created = await tx.salaryComponent.create({
        data: {
          employeeId: employee.id,
          type: input.type,
          calcType,
          name: input.name,
          amountMinor: calcType === 'PERCENT_OF_BASE' ? null : (input.amountMinor ?? null),
          percentPpm: calcType === 'PERCENT_OF_BASE' ? (input.percentPpm ?? null) : null,
          currency: calcType === 'PERCENT_OF_BASE' ? null : currency,
          effectiveFrom: effectiveFromDate,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: SELECT_COMPONENT,
      });

      // Keep the HR profile headline in step with the dated rows it summarises.
      if (input.type === 'BASE') {
        await tx.employee.update({
          where: { id: employee.id },
          data: {
            baseSalaryMinor: input.amountMinor ?? null,
            salaryCurrency: currency,
            salaryPeriod: PERIOD_FOR_CALC_TYPE[calcType],
          },
        });
      }

      const previous = current?.amountMinor ?? null;
      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.SALARY_CHANGED,
          entityType: 'SalaryComponent',
          entityId: created.id,
          branchId: employee.branchId,
          summary: `${employeeDisplayName(employee)}: ${input.name} set to ${describeAmount(
            calcType,
            input.amountMinor ?? null,
            input.percentPpm ?? null,
            currency,
          )} from ${effectiveFrom}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          changes: {
            amountMinor: { from: previous?.toString() ?? null, to: input.amountMinor?.toString() ?? null },
            percentPpm: { from: current?.percentPpm ?? null, to: input.percentPpm ?? null },
          },
          metadata: {
            employeeId: employee.id,
            type: input.type,
            calcType,
            currency,
            effectiveFrom,
            closedComponentId: current?.id ?? null,
          },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: employee.id,
            type: 'employee.salary_changed',
            title: `${input.name} changed`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return {
        component: toComponentRow(created),
        closedComponentId: current?.id ?? null,
        previousAmountMinor: previous?.toString() ?? null,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ListSalaryComponentsInput {
  readonly employeeId: string;
  /** Include closed rows — the pay history. On by default. */
  readonly includeHistory?: boolean;
}

export async function listSalaryComponents(
  ctx: AccessContext,
  input: ListSalaryComponentsInput,
  db?: Db,
): Promise<readonly SalaryComponentRow[]> {
  requirePermission(ctx, 'employees.viewSalary');
  const client = db ?? prisma;

  // Scope is applied by resolving the employee first: SalaryComponent carries no
  // organizationId of its own, so there is no correct predicate on it alone.
  const employee = await loadScopedEmployee(ctx, client, input.employeeId);

  const rows = await client.salaryComponent.findMany({
    where: {
      employeeId: employee.id,
      ...(input.includeHistory === false ? { effectiveTo: null } : {}),
    },
    orderBy: [{ effectiveFrom: 'desc' }, { type: 'asc' }],
    select: SELECT_COMPONENT,
  });

  return rows.map(toComponentRow);
}

export interface EffectiveSalary {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly onDate: DateOnly;
  readonly currency: CurrencyCode;
  readonly baseMinor: string;
  readonly components: readonly SalaryComponentRow[];
  /** The engine's view of the same rows, ready for `calculatePayrollItem`. */
  readonly specs: readonly SalaryComponentSpec[];
}

/**
 * The components in force on a date.
 *
 * The date is explicit rather than "now" so that a payroll run, a back-dated
 * correction and a "what did we pay them in June?" question all resolve the same
 * way. Filtering happens in SQL; `selectEffectiveComponents` is applied to the
 * result as the single definition of "in force" that the pure engine also uses.
 */
export async function getEffectiveSalary(
  ctx: AccessContext,
  input: { readonly employeeId: string; readonly onDate?: DateOnly },
  db?: Db,
): Promise<EffectiveSalary> {
  requirePermission(ctx, 'employees.viewSalary');
  const client = db ?? prisma;

  const employee = await loadScopedEmployee(ctx, client, input.employeeId);
  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: employee.branchId },
    client,
  );
  const onDate = input.onDate ?? todayIn(timezone);
  const on = dateOnlyToPrismaDate(onDate);

  const rows = await client.salaryComponent.findMany({
    where: {
      employeeId: employee.id,
      effectiveFrom: { lte: on },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
    },
    orderBy: [{ type: 'asc' }, { effectiveFrom: 'desc' }],
    select: SELECT_COMPONENT,
  });

  const currency = await currencyFor(
    {
      organizationId: ctx.organizationId,
      branchId: employee.branchId,
      requested: rows.find((row) => row.currency)?.currency ?? employee.salaryCurrency,
    },
    client,
  );

  const specs = toSpecs(rows);
  const baseMinor = selectEffectiveComponents(specs, onDate)
    .filter((spec) => spec.type === 'BASE' && spec.calcType === 'FIXED')
    .reduce((total, spec) => total + (spec.amountMinor ?? 0n), 0n);

  return {
    employeeId: employee.id,
    employeeName: employeeDisplayName(employee),
    onDate,
    currency,
    baseMinor: baseMinor.toString(),
    components: rows.map(toComponentRow),
    specs,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const SELECT_COMPONENT = {
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
} as const;

interface ComponentRowShape {
  readonly id: string;
  readonly employeeId: string;
  readonly type: SalaryComponentType;
  readonly calcType: SalaryCalcType;
  readonly name: string;
  readonly amountMinor: bigint | null;
  readonly percentPpm: number | null;
  readonly currency: string | null;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
}

function toComponentRow(row: ComponentRowShape): SalaryComponentRow {
  return {
    id: row.id,
    employeeId: row.employeeId,
    type: row.type,
    calcType: row.calcType,
    name: row.name,
    // Minor units cross the service boundary as strings; BigInt does not survive
    // JSON.stringify.
    amountMinor: row.amountMinor?.toString() ?? null,
    percentPpm: row.percentPpm,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    isOpen: row.effectiveTo === null,
  };
}

/** Database rows in the shape the pure engine consumes. */
export function toSpecs(rows: readonly ComponentRowShape[]): SalaryComponentSpec[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    calcType: row.calcType,
    amountMinor: row.amountMinor,
    percentPpm: row.percentPpm,
    currency: row.currency,
    effectiveFrom: dateOnlyOf(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? dateOnlyOf(row.effectiveTo) : null,
  }));
}

function describeAmount(
  calcType: SalaryCalcType,
  amountMinor: bigint | null,
  percentPpm: number | null,
  currency: CurrencyCode,
): string {
  if (calcType === 'PERCENT_OF_BASE') return `${(percentPpm ?? 0) / 10_000}% of base`;
  const label = formatMoney(money(amountMinor ?? 0n, currency));
  if (calcType === 'PER_HOUR') return `${label} per hour`;
  if (calcType === 'PER_LESSON') return `${label} per lesson`;
  return label;
}
