/**
 * The payroll engine. Pure: no database, no clock, no settings.
 *
 * Everything a payslip asserts is computed here, which is why this file is pure —
 * an approved payroll run must be reproducible from its stored inputs years later,
 * and a function that reaches for the current time or a live fee table cannot be
 * replayed.
 *
 * ORDER OF OPERATIONS, which is the whole point of the module:
 *
 *   1. BASE components, summed. This is the figure every percentage refers to.
 *   2. Percentage EARNINGS (ALLOWANCE / BONUS with PERCENT_OF_BASE), each applied
 *      to the base from step 1 — NEVER to a running total. Two 10% allowances must
 *      come to 20% of base, not 21%: compounding them would mean the order the
 *      components happen to be listed in changes the payslip.
 *   3. Additive earnings: fixed allowances and bonuses, per-hour and per-lesson pay.
 *   4. Gross = 1 + 2 + 3.
 *   5. DEDUCTION / TAX / SOCIAL_CONTRIBUTION, applied to the GROSS.
 *
 * Step 5 is deliberately asymmetric with step 2, and the asymmetry is real rather
 * than an oversight: an allowance expressed as a percentage is a percentage of the
 * base salary (that is what the enum member PERCENT_OF_BASE names), while income tax
 * and social contributions are levied on total remuneration. Applying tax to the
 * base alone would under-withhold every employee who earns a bonus.
 *
 * NET NEVER GOES NEGATIVE. When deductions exceed the gross, the deduction is
 * capped at the gross — so `net = gross - deduction` holds exactly, which is what
 * the PayrollItem columns and every report built on them assume — and the uncovered
 * remainder is recorded as a SHORTFALL line and returned as `shortfallMinor`. An
 * employer carries that forward or writes it off; a negative payslip is never a
 * legitimate output.
 *
 * All arithmetic is in BigInt minor units. The country ruleset is pluggable: a
 * `PayrollCalculator` is an object in `PAYROLL_CALCULATORS`, so an Uzbek or another
 * national ruleset is a new file that registers a key — not a schema migration and
 * not an `if (country === ...)` inside this function.
 */

import type { SalaryCalcType, SalaryComponentType } from '@/generated/prisma/client';
import { BusinessRuleError } from '@/server/errors';
import { applyPpm, assertCurrency, money, type CurrencyCode } from '@/lib/money';
import type { DateOnly } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One dated salary building block, in the shape the engine needs.
 *
 * A plain interface rather than the Prisma row type: the engine is also fed
 * snapshots read back out of `PayrollItem.breakdown` and figures typed into a
 * "what would this cost?" preview, neither of which is a database row.
 */
export interface SalaryComponentSpec {
  readonly id?: string | null;
  readonly name: string;
  readonly type: SalaryComponentType;
  readonly calcType: SalaryCalcType;
  /** Minor units. The amount for FIXED, the rate for PER_HOUR / PER_LESSON. */
  readonly amountMinor: bigint | null;
  /** Parts-per-million, e.g. 120_000 for 12%. Only for PERCENT_OF_BASE. */
  readonly percentPpm: number | null;
  readonly currency?: string | null;
  readonly effectiveFrom?: DateOnly;
  readonly effectiveTo?: DateOnly | null;
}

/** How a FIXED base responds to a period the employee did not work in full. */
export type ProRationMode = 'NONE' | 'BY_DAYS_PRESENT';

export interface CalculatePayrollItemInput {
  readonly components: readonly SalaryComponentSpec[];
  /** Hours from the staff-attendance record. Recorded to the minute. */
  readonly hoursWorked: number;
  readonly lessonsTaught: number;
  readonly daysPresent: number;
  /** Working days the period contains. The divisor for pro-ration. */
  readonly daysInPeriod: number;
  readonly currency: string;
  /**
   * Default NONE: a monthly salary is paid in full unless the institution has
   * decided otherwise. Docking pay for absence silently would be the worse
   * default of the two, so it has to be asked for.
   */
  readonly proRation?: ProRationMode;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type PayrollLineEffect = 'EARNING' | 'DEDUCTION' | 'SHORTFALL';

/** The synthetic line type used when deductions could not be taken in full. */
export const SHORTFALL_LINE_TYPE = 'SHORTFALL' as const;

/**
 * One line of a payslip. Carries not just the amount but what produced it — the
 * basis a percentage was taken of, the rate and quantity behind an hourly figure —
 * because "why is this 1 437 500?" is the question a payslip has to answer.
 */
export interface PayrollBreakdownLine {
  readonly componentId: string | null;
  readonly name: string;
  readonly type: SalaryComponentType | typeof SHORTFALL_LINE_TYPE;
  readonly calcType: SalaryCalcType | null;
  readonly effect: PayrollLineEffect;
  /** Always a positive magnitude; `effect` carries the sign. */
  readonly amountMinor: bigint;
  /** What a percentage was applied to: the base for earnings, the gross for tax. */
  readonly basisMinor: bigint | null;
  readonly percentPpm: number | null;
  readonly rateMinor: bigint | null;
  readonly quantity: number | null;
  readonly note: string | null;
}

export interface PayrollComputation {
  readonly currency: CurrencyCode;
  readonly baseMinor: bigint;
  readonly grossMinor: bigint;
  /** What was actually withheld. Never more than the gross. */
  readonly deductionMinor: bigint;
  readonly netMinor: bigint;
  /** Deductions that exceeded the gross and were therefore not taken. */
  readonly shortfallMinor: bigint;
  readonly breakdown: readonly PayrollBreakdownLine[];
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/**
 * Integer division rounded half-up, on magnitudes.
 *
 * Needed for pro-ration and hourly pay, where the divisor is a count of days or
 * minutes rather than a rate: expressing `daysPresent / daysInPeriod` as ppm and
 * going through `applyPpm` would quantise the ratio to six decimal places and lose
 * a few minor units of somebody's salary. Percentages, which are genuinely ppm,
 * still go through `applyPpm`.
 */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

const EARNING_TYPES: ReadonlySet<SalaryComponentType> = new Set<SalaryComponentType>([
  'BASE',
  'ALLOWANCE',
  'BONUS',
]);

const DEDUCTION_TYPES: ReadonlySet<SalaryComponentType> = new Set<SalaryComponentType>([
  'DEDUCTION',
  'TAX',
  'SOCIAL_CONTRIBUTION',
]);

function requireAmount(component: SalaryComponentSpec): bigint {
  if (component.amountMinor == null) {
    throw new BusinessRuleError(
      'payroll.component_missing_amount',
      `Salary component "${component.name}" is ${component.calcType} but has no amount. Set one before running payroll.`,
      { details: { componentId: component.id ?? null, calcType: component.calcType } },
    );
  }
  if (component.amountMinor < 0n) {
    // A negative amount would silently invert the component: a "deduction" of
    // -100 would pay the employee. Types carry the sign, values never do.
    throw new BusinessRuleError(
      'payroll.component_negative_amount',
      `Salary component "${component.name}" has a negative amount. Use a DEDUCTION component instead.`,
      { details: { componentId: component.id ?? null } },
    );
  }
  return component.amountMinor;
}

function requirePercentPpm(component: SalaryComponentSpec): number {
  const ppm = component.percentPpm;
  if (ppm == null) {
    throw new BusinessRuleError(
      'payroll.component_missing_percent',
      `Salary component "${component.name}" is a percentage but has no rate.`,
      { details: { componentId: component.id ?? null } },
    );
  }
  if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) {
    throw new BusinessRuleError(
      'payroll.component_invalid_percent',
      `Salary component "${component.name}" has a rate outside 0-100%.`,
      { details: { componentId: component.id ?? null, percentPpm: ppm } },
    );
  }
  return ppm;
}

function assertComponentCurrency(component: SalaryComponentSpec, currency: CurrencyCode): void {
  if (component.currency && component.currency !== currency) {
    // The same refusal `@/lib/money` makes: combining two currencies needs a
    // recorded exchange rate, which a payslip has no place inventing.
    throw new BusinessRuleError(
      'payroll.currency_mismatch',
      `Salary component "${component.name}" is in ${component.currency} but this payroll run is in ${currency}.`,
      { details: { componentId: component.id ?? null, componentCurrency: component.currency } },
    );
  }
}

/** Minutes, so an hourly rate multiplies an integer rather than a float. */
function hoursToMinutes(hoursWorked: number): bigint {
  if (!Number.isFinite(hoursWorked) || hoursWorked < 0) {
    throw new BusinessRuleError(
      'payroll.invalid_hours',
      'Hours worked must be a non-negative number.',
      { details: { hoursWorked } },
    );
  }
  return BigInt(Math.round(hoursWorked * 60));
}

function requireCount(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0) {
    throw new BusinessRuleError(
      'payroll.invalid_count',
      `${field} must be a whole number of at least zero.`,
      { details: { [field]: value } },
    );
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Effective-window resolution
// ---------------------------------------------------------------------------

/**
 * The components in force on a date.
 *
 * A component with no `effectiveFrom` is treated as always in force: a caller that
 * supplies no window is stating the component applies, which is what a preview or a
 * replayed snapshot means. Rows read from the database always carry theirs.
 */
export function selectEffectiveComponents<T extends SalaryComponentSpec>(
  components: readonly T[],
  onDate: DateOnly,
): T[] {
  return components.filter((component) => {
    if (component.effectiveFrom && component.effectiveFrom > onDate) return false;
    if (component.effectiveTo && component.effectiveTo < onDate) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// The default ruleset
// ---------------------------------------------------------------------------

export const DEFAULT_PAYROLL_CALCULATOR_KEY = 'default';

/**
 * A national or institutional ruleset. `calculate` must stay pure so that
 * re-running an approved payroll run reproduces it exactly.
 */
export interface PayrollCalculator {
  readonly key: string;
  readonly label: string;
  calculate(input: CalculatePayrollItemInput): PayrollComputation;
}

interface EarningLine {
  readonly line: PayrollBreakdownLine;
  readonly amountMinor: bigint;
}

/** Steps 1 and 3: the amount a component contributes, ignoring percentages. */
function absoluteAmount(
  component: SalaryComponentSpec,
  input: CalculatePayrollItemInput,
): { amountMinor: bigint; rateMinor: bigint | null; quantity: number | null; note: string | null } {
  switch (component.calcType) {
    case 'FIXED': {
      const amount = requireAmount(component);
      const proRate = (input.proRation ?? 'NONE') === 'BY_DAYS_PRESENT' && component.type === 'BASE';
      if (!proRate) {
        return { amountMinor: amount, rateMinor: null, quantity: null, note: null };
      }
      const daysInPeriod = requireCount(input.daysInPeriod, 'daysInPeriod');
      if (daysInPeriod === 0n) {
        throw new BusinessRuleError(
          'payroll.empty_period',
          'A payroll period with no working days cannot pro-rate a salary.',
        );
      }
      const daysPresent = requireCount(Math.min(input.daysPresent, input.daysInPeriod), 'daysPresent');
      return {
        amountMinor: divideHalfUp(amount * daysPresent, daysInPeriod),
        rateMinor: amount,
        quantity: Number(daysPresent),
        note: `Pro-rated over ${input.daysPresent} of ${input.daysInPeriod} working days`,
      };
    }
    case 'PER_HOUR': {
      const rate = requireAmount(component);
      const minutes = hoursToMinutes(input.hoursWorked);
      return {
        amountMinor: divideHalfUp(rate * minutes, 60n),
        rateMinor: rate,
        quantity: input.hoursWorked,
        note: null,
      };
    }
    case 'PER_LESSON': {
      const rate = requireAmount(component);
      const lessons = requireCount(input.lessonsTaught, 'lessonsTaught');
      return {
        amountMinor: rate * lessons,
        rateMinor: rate,
        quantity: input.lessonsTaught,
        note: null,
      };
    }
    case 'PERCENT_OF_BASE':
      // Handled by the caller, which knows the basis. Reaching here means a
      // percentage component was routed down the absolute path.
      throw new BusinessRuleError(
        'payroll.percent_without_basis',
        `Salary component "${component.name}" is a percentage and cannot be computed without a basis.`,
      );
  }
}

function calculateDefault(input: CalculatePayrollItemInput): PayrollComputation {
  const currency = assertCurrency(input.currency);
  for (const component of input.components) assertComponentCurrency(component, currency);

  // --- 1. BASE -----------------------------------------------------------
  // Summed rather than taking the first: a regional or seniority base alongside a
  // headline base is a real arrangement, and silently ignoring the second would
  // underpay.
  const baseLines: EarningLine[] = [];
  for (const component of input.components) {
    if (component.type !== 'BASE') continue;
    if (component.calcType === 'PERCENT_OF_BASE') {
      throw new BusinessRuleError(
        'payroll.base_as_percentage',
        `Salary component "${component.name}" is a BASE defined as a percentage of the base, which is circular.`,
        { details: { componentId: component.id ?? null } },
      );
    }
    const computed = absoluteAmount(component, input);
    baseLines.push({
      amountMinor: computed.amountMinor,
      line: {
        componentId: component.id ?? null,
        name: component.name,
        type: component.type,
        calcType: component.calcType,
        effect: 'EARNING',
        amountMinor: computed.amountMinor,
        basisMinor: null,
        percentPpm: null,
        rateMinor: computed.rateMinor,
        quantity: computed.quantity,
        note: computed.note,
      },
    });
  }
  const baseMinor = baseLines.reduce((total, entry) => total + entry.amountMinor, 0n);

  // --- 2. percentage earnings, all against the base from step 1 -----------
  const percentEarnings: EarningLine[] = [];
  for (const component of input.components) {
    if (component.type === 'BASE' || !EARNING_TYPES.has(component.type)) continue;
    if (component.calcType !== 'PERCENT_OF_BASE') continue;
    const ppm = requirePercentPpm(component);
    const amount = applyPpm(money(baseMinor, currency), ppm).amountMinor;
    percentEarnings.push({
      amountMinor: amount,
      line: {
        componentId: component.id ?? null,
        name: component.name,
        type: component.type,
        calcType: component.calcType,
        effect: 'EARNING',
        amountMinor: amount,
        basisMinor: baseMinor,
        percentPpm: ppm,
        rateMinor: null,
        quantity: null,
        note: null,
      },
    });
  }

  // --- 3. additive earnings ----------------------------------------------
  const additiveEarnings: EarningLine[] = [];
  for (const component of input.components) {
    if (component.type === 'BASE' || !EARNING_TYPES.has(component.type)) continue;
    if (component.calcType === 'PERCENT_OF_BASE') continue;
    const computed = absoluteAmount(component, input);
    additiveEarnings.push({
      amountMinor: computed.amountMinor,
      line: {
        componentId: component.id ?? null,
        name: component.name,
        type: component.type,
        calcType: component.calcType,
        effect: 'EARNING',
        amountMinor: computed.amountMinor,
        basisMinor: null,
        percentPpm: null,
        rateMinor: computed.rateMinor,
        quantity: computed.quantity,
        note: computed.note,
      },
    });
  }

  // --- 4. gross -----------------------------------------------------------
  const grossMinor =
    baseMinor +
    percentEarnings.reduce((total, entry) => total + entry.amountMinor, 0n) +
    additiveEarnings.reduce((total, entry) => total + entry.amountMinor, 0n);

  // --- 5. deductions and tax, against the gross ---------------------------
  const deductionLines: PayrollBreakdownLine[] = [];
  let requestedDeductionMinor = 0n;
  for (const component of input.components) {
    if (!DEDUCTION_TYPES.has(component.type)) continue;

    let amount: bigint;
    let basisMinor: bigint | null = null;
    let percentPpm: number | null = null;
    let rateMinor: bigint | null = null;
    let quantity: number | null = null;
    let note: string | null = null;

    if (component.calcType === 'PERCENT_OF_BASE') {
      percentPpm = requirePercentPpm(component);
      basisMinor = grossMinor;
      amount = applyPpm(money(grossMinor, currency), percentPpm).amountMinor;
    } else {
      const computed = absoluteAmount(component, input);
      amount = computed.amountMinor;
      rateMinor = computed.rateMinor;
      quantity = computed.quantity;
      note = computed.note;
    }

    requestedDeductionMinor += amount;
    deductionLines.push({
      componentId: component.id ?? null,
      name: component.name,
      type: component.type,
      calcType: component.calcType,
      effect: 'DEDUCTION',
      amountMinor: amount,
      basisMinor,
      percentPpm,
      rateMinor,
      quantity,
      note,
    });
  }

  const deductionMinor = requestedDeductionMinor > grossMinor ? grossMinor : requestedDeductionMinor;
  const shortfallMinor = requestedDeductionMinor - deductionMinor;
  const netMinor = grossMinor - deductionMinor;

  const breakdown: PayrollBreakdownLine[] = [
    ...baseLines.map((entry) => entry.line),
    ...percentEarnings.map((entry) => entry.line),
    ...additiveEarnings.map((entry) => entry.line),
    ...deductionLines,
  ];

  if (shortfallMinor > 0n) {
    breakdown.push({
      componentId: null,
      name: 'Uncollected deductions',
      type: SHORTFALL_LINE_TYPE,
      calcType: null,
      effect: 'SHORTFALL',
      amountMinor: shortfallMinor,
      basisMinor: grossMinor,
      percentPpm: null,
      rateMinor: null,
      quantity: null,
      note: 'Deductions exceeded the gross pay. Net was held at zero and this amount was not taken.',
    });
  }

  return {
    currency,
    baseMinor,
    grossMinor,
    deductionMinor,
    netMinor,
    shortfallMinor,
    breakdown,
  };
}

export const defaultPayrollCalculator: PayrollCalculator = {
  key: DEFAULT_PAYROLL_CALCULATOR_KEY,
  label: 'Default (no statutory rules)',
  calculate: calculateDefault,
};

/**
 * The available rulesets, by key. A national ruleset (Uzbek INPS and income tax,
 * say) is added as its own module that spreads this object and registers its key;
 * `PayrollRun.calculatorKey` records which one produced a run, so an old run stays
 * explicable after the rules change.
 */
export const PAYROLL_CALCULATORS: Readonly<Record<string, PayrollCalculator>> = {
  [DEFAULT_PAYROLL_CALCULATOR_KEY]: defaultPayrollCalculator,
};

export function getPayrollCalculator(key?: string | null): PayrollCalculator {
  const resolved = key ?? DEFAULT_PAYROLL_CALCULATOR_KEY;
  const calculator = PAYROLL_CALCULATORS[resolved];
  if (!calculator) {
    throw new BusinessRuleError(
      'payroll.unknown_calculator',
      `There is no payroll ruleset called "${resolved}".`,
      { details: { key: resolved, available: Object.keys(PAYROLL_CALCULATORS) } },
    );
  }
  return calculator;
}

/** Compute one payslip with the default ruleset. */
export function calculatePayrollItem(input: CalculatePayrollItemInput): PayrollComputation {
  return defaultPayrollCalculator.calculate(input);
}
