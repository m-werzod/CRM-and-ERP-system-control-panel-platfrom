import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAYROLL_CALCULATOR_KEY,
  calculatePayrollItem,
  getPayrollCalculator,
  selectEffectiveComponents,
  type CalculatePayrollItemInput,
  type PayrollBreakdownLine,
  type SalaryComponentSpec,
} from '@/server/services/hr/payroll/calculator';
import { AppError } from '@/server/errors';

/**
 * The payroll engine decides what staff are actually paid, so these tests pin the
 * ORDER OF OPERATIONS as hard as the figures: a percentage taken of a running total
 * instead of the base, or a tax taken of the base instead of the gross, produces a
 * plausible-looking payslip that is wrong by a few per cent every month.
 *
 * Everything here is UZS tiyin (exponent 2), so 10_000_000n is 100 000 so'm.
 */

const BASE_MINOR = 10_000_000n;

function component(
  over: Partial<SalaryComponentSpec> & Pick<SalaryComponentSpec, 'name' | 'type' | 'calcType'>,
): SalaryComponentSpec {
  return { amountMinor: null, percentPpm: null, ...over };
}

const base = (amountMinor = BASE_MINOR, over: Partial<SalaryComponentSpec> = {}) =>
  component({ name: 'Base salary', type: 'BASE', calcType: 'FIXED', amountMinor, ...over });

function inputs(
  components: readonly SalaryComponentSpec[],
  over: Partial<CalculatePayrollItemInput> = {},
): CalculatePayrollItemInput {
  return {
    components,
    hoursWorked: 0,
    lessonsTaught: 0,
    daysPresent: 22,
    daysInPeriod: 22,
    currency: 'UZS',
    ...over,
  };
}

const lineNamed = (lines: readonly PayrollBreakdownLine[], name: string): PayrollBreakdownLine => {
  const line = lines.find((candidate) => candidate.name === name);
  if (!line) throw new Error(`No breakdown line called "${name}"`);
  return line;
};

describe('calculatePayrollItem: the base', () => {
  it('pays a fixed base and nothing else', () => {
    const result = calculatePayrollItem(inputs([base()]));

    expect(result.baseMinor).toBe(BASE_MINOR);
    expect(result.grossMinor).toBe(BASE_MINOR);
    expect(result.deductionMinor).toBe(0n);
    expect(result.netMinor).toBe(BASE_MINOR);
    expect(result.shortfallMinor).toBe(0n);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]?.effect).toBe('EARNING');
  });

  it('sums several base components rather than taking the first', () => {
    const result = calculatePayrollItem(
      inputs([
        base(8_000_000n),
        base(2_000_000n, { name: 'Regional supplement' }),
      ]),
    );

    expect(result.baseMinor).toBe(10_000_000n);
    expect(result.grossMinor).toBe(10_000_000n);
  });

  it('leaves a fixed base whole by default, and pro-rates only when asked', () => {
    const attended = { daysPresent: 11, daysInPeriod: 22 };

    expect(calculatePayrollItem(inputs([base()], attended)).grossMinor).toBe(BASE_MINOR);
    expect(
      calculatePayrollItem(inputs([base()], { ...attended, proRation: 'BY_DAYS_PRESENT' }))
        .grossMinor,
    ).toBe(5_000_000n);
  });

  it('rounds a pro-rated base half-up instead of truncating', () => {
    // 10 000 000 x 1/3 = 3 333 333.33 -> 3 333 333; x 2/3 = 6 666 666.67 -> 6 666 667.
    const third = calculatePayrollItem(
      inputs([base()], { daysPresent: 1, daysInPeriod: 3, proRation: 'BY_DAYS_PRESENT' }),
    );
    const twoThirds = calculatePayrollItem(
      inputs([base()], { daysPresent: 2, daysInPeriod: 3, proRation: 'BY_DAYS_PRESENT' }),
    );

    expect(third.grossMinor).toBe(3_333_333n);
    expect(twoThirds.grossMinor).toBe(6_666_667n);
  });
});

describe('calculatePayrollItem: percentage earnings are taken of the base', () => {
  it('computes a percentage allowance on the base', () => {
    const result = calculatePayrollItem(
      inputs([
        base(),
        component({
          name: 'Transport allowance',
          type: 'ALLOWANCE',
          calcType: 'PERCENT_OF_BASE',
          percentPpm: 100_000,
        }),
      ]),
    );

    const allowance = lineNamed(result.breakdown, 'Transport allowance');
    expect(allowance.amountMinor).toBe(1_000_000n);
    expect(allowance.basisMinor).toBe(BASE_MINOR);
    expect(result.grossMinor).toBe(11_000_000n);
  });

  it('does NOT compound two percentage allowances', () => {
    const result = calculatePayrollItem(
      inputs([
        base(),
        component({ name: 'A', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 100_000 }),
        component({ name: 'B', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 100_000 }),
      ]),
    );

    // 10% + 10% of the BASE is 2 000 000. Against a running total it would be
    // 1 000 000 + 1 100 000 = 2 100 000, i.e. the answer would depend on the order
    // the components happen to be listed in.
    expect(result.grossMinor).toBe(12_000_000n);
    expect(lineNamed(result.breakdown, 'B').amountMinor).toBe(1_000_000n);
  });

  it('ignores the order components are supplied in', () => {
    const percentFirst = calculatePayrollItem(
      inputs([
        component({ name: 'A', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 250_000 }),
        base(),
      ]),
    );
    const baseFirst = calculatePayrollItem(
      inputs([
        base(),
        component({ name: 'A', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 250_000 }),
      ]),
    );

    expect(percentFirst.grossMinor).toBe(12_500_000n);
    expect(percentFirst.grossMinor).toBe(baseFirst.grossMinor);
  });

  it('applies a percentage bonus to the base, not to the base plus allowances', () => {
    const result = calculatePayrollItem(
      inputs([
        base(),
        component({ name: 'Meal allowance', type: 'ALLOWANCE', calcType: 'FIXED', amountMinor: 4_000_000n }),
        component({ name: 'Bonus', type: 'BONUS', calcType: 'PERCENT_OF_BASE', percentPpm: 100_000 }),
      ]),
    );

    expect(lineNamed(result.breakdown, 'Bonus').amountMinor).toBe(1_000_000n);
    expect(result.grossMinor).toBe(15_000_000n);
  });

  it('rounds a percentage half-up', () => {
    // 5% of 100 501 is 5 025.05 -> 5 025; 5% of 100 510 is 5 025.5 -> 5 026.
    const of100501 = calculatePayrollItem(
      inputs([
        base(100_501n),
        component({ name: 'A', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 50_000 }),
      ]),
    );
    const of100510 = calculatePayrollItem(
      inputs([
        base(100_510n),
        component({ name: 'A', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 50_000 }),
      ]),
    );

    expect(lineNamed(of100501.breakdown, 'A').amountMinor).toBe(5_025n);
    expect(lineNamed(of100510.breakdown, 'A').amountMinor).toBe(5_026n);
  });
});

describe('calculatePayrollItem: hourly and per-lesson pay', () => {
  it('pays an hourly rate for the hours recorded', () => {
    const result = calculatePayrollItem(
      inputs(
        [component({ name: 'Teaching hours', type: 'BASE', calcType: 'PER_HOUR', amountMinor: 100_000n })],
        { hoursWorked: 37.5 },
      ),
    );

    // 100 000 per hour x 37.5 hours.
    expect(result.grossMinor).toBe(3_750_000n);
    const line = lineNamed(result.breakdown, 'Teaching hours');
    expect(line.rateMinor).toBe(100_000n);
    expect(line.quantity).toBe(37.5);
  });

  it('computes hourly pay from whole minutes, rounding half-up', () => {
    // 100 001 per hour for half an hour is 50 000.5 -> 50 001.
    const result = calculatePayrollItem(
      inputs(
        [component({ name: 'Cover', type: 'ALLOWANCE', calcType: 'PER_HOUR', amountMinor: 100_001n })],
        { hoursWorked: 0.5 },
      ),
    );

    expect(lineNamed(result.breakdown, 'Cover').amountMinor).toBe(50_001n);
  });

  it('pays a per-lesson rate for the lessons delivered', () => {
    const result = calculatePayrollItem(
      inputs(
        [component({ name: 'Lesson fee', type: 'BASE', calcType: 'PER_LESSON', amountMinor: 7_500n })],
        { lessonsTaught: 13 },
      ),
    );

    expect(result.grossMinor).toBe(97_500n);
    expect(lineNamed(result.breakdown, 'Lesson fee').quantity).toBe(13);
  });

  it('pays nothing for an hourly component when no hours were recorded', () => {
    const result = calculatePayrollItem(
      inputs([component({ name: 'Cover', type: 'ALLOWANCE', calcType: 'PER_HOUR', amountMinor: 100_000n })]),
    );

    expect(result.grossMinor).toBe(0n);
    expect(result.netMinor).toBe(0n);
  });

  it('combines a fixed base with per-lesson and hourly components', () => {
    const result = calculatePayrollItem(
      inputs(
        [
          base(5_000_000n),
          component({ name: 'Lesson fee', type: 'ALLOWANCE', calcType: 'PER_LESSON', amountMinor: 50_000n }),
          component({ name: 'Cover', type: 'ALLOWANCE', calcType: 'PER_HOUR', amountMinor: 60_000n }),
        ],
        { lessonsTaught: 20, hoursWorked: 2 },
      ),
    );

    // 5 000 000 + (50 000 x 20) + (60 000 x 2).
    expect(result.grossMinor).toBe(5_000_000n + 1_000_000n + 120_000n);
    // Only the fixed base counts as the percentage basis.
    expect(result.baseMinor).toBe(5_000_000n);
  });
});

describe('calculatePayrollItem: deductions and tax', () => {
  it('takes tax on the gross, not on the base', () => {
    const result = calculatePayrollItem(
      inputs([
        base(),
        component({ name: 'Bonus', type: 'BONUS', calcType: 'FIXED', amountMinor: 2_000_000n }),
        component({ name: 'Income tax', type: 'TAX', calcType: 'PERCENT_OF_BASE', percentPpm: 120_000 }),
      ]),
    );

    const tax = lineNamed(result.breakdown, 'Income tax');
    expect(result.grossMinor).toBe(12_000_000n);
    // 12% of the 12 000 000 gross, NOT 12% of the 10 000 000 base.
    expect(tax.amountMinor).toBe(1_440_000n);
    expect(tax.basisMinor).toBe(12_000_000n);
    expect(tax.effect).toBe('DEDUCTION');
    expect(result.netMinor).toBe(10_560_000n);
  });

  it('adds fixed deductions and social contributions to the withheld total', () => {
    const result = calculatePayrollItem(
      inputs([
        base(),
        component({ name: 'Income tax', type: 'TAX', calcType: 'PERCENT_OF_BASE', percentPpm: 120_000 }),
        component({
          name: 'Pension',
          type: 'SOCIAL_CONTRIBUTION',
          calcType: 'PERCENT_OF_BASE',
          percentPpm: 10_000,
        }),
        component({ name: 'Canteen', type: 'DEDUCTION', calcType: 'FIXED', amountMinor: 250_000n }),
      ]),
    );

    // 12% + 1% of 10 000 000, plus 250 000.
    expect(result.deductionMinor).toBe(1_200_000n + 100_000n + 250_000n);
    expect(result.netMinor).toBe(BASE_MINOR - result.deductionMinor);
  });

  it('keeps net = gross - deduction exactly', () => {
    const result = calculatePayrollItem(
      inputs([
        base(7_777_777n),
        component({ name: 'Tax', type: 'TAX', calcType: 'PERCENT_OF_BASE', percentPpm: 133_333 }),
      ]),
    );

    expect(result.netMinor).toBe(result.grossMinor - result.deductionMinor);
  });
});

describe('calculatePayrollItem: net never goes negative', () => {
  it('clamps net at zero and records the shortfall', () => {
    const result = calculatePayrollItem(
      inputs([
        base(1_000_000n),
        component({ name: 'Advance repayment', type: 'DEDUCTION', calcType: 'FIXED', amountMinor: 1_500_000n }),
      ]),
    );

    expect(result.grossMinor).toBe(1_000_000n);
    // Withheld is capped at the gross so the stored columns stay consistent.
    expect(result.deductionMinor).toBe(1_000_000n);
    expect(result.netMinor).toBe(0n);
    expect(result.shortfallMinor).toBe(500_000n);

    const shortfall = lineNamed(result.breakdown, 'Uncollected deductions');
    expect(shortfall.effect).toBe('SHORTFALL');
    expect(shortfall.amountMinor).toBe(500_000n);
    // The deduction line still reports what was asked for, so the payslip explains
    // where the uncollected 500 000 came from.
    expect(lineNamed(result.breakdown, 'Advance repayment').amountMinor).toBe(1_500_000n);
  });

  it('records no shortfall line when deductions fit inside the gross', () => {
    const result = calculatePayrollItem(
      inputs([
        base(1_000_000n),
        component({ name: 'Advance repayment', type: 'DEDUCTION', calcType: 'FIXED', amountMinor: 1_000_000n }),
      ]),
    );

    expect(result.netMinor).toBe(0n);
    expect(result.shortfallMinor).toBe(0n);
    expect(result.breakdown.some((line) => line.effect === 'SHORTFALL')).toBe(false);
  });

  it('clamps a zero-gross payslip rather than producing a negative one', () => {
    const result = calculatePayrollItem(
      inputs([component({ name: 'Fine', type: 'DEDUCTION', calcType: 'FIXED', amountMinor: 900n })]),
    );

    expect(result.grossMinor).toBe(0n);
    expect(result.deductionMinor).toBe(0n);
    expect(result.netMinor).toBe(0n);
    expect(result.shortfallMinor).toBe(900n);
  });
});

describe('selectEffectiveComponents', () => {
  const dated: readonly SalaryComponentSpec[] = [
    base(9_000_000n, { name: 'Base salary', effectiveFrom: '2026-01-01', effectiveTo: '2026-05-31' }),
    base(10_000_000n, { name: 'Base salary', effectiveFrom: '2026-06-01', effectiveTo: null }),
    component({
      name: 'Project bonus',
      type: 'BONUS',
      calcType: 'FIXED',
      amountMinor: 500_000n,
      effectiveFrom: '2026-09-01',
    }),
  ];

  it('excludes a component whose window has closed', () => {
    const inForce = selectEffectiveComponents(dated, '2026-06-15');

    expect(inForce).toHaveLength(1);
    expect(inForce[0]?.amountMinor).toBe(10_000_000n);
  });

  it('excludes a component whose window has not started', () => {
    expect(selectEffectiveComponents(dated, '2026-08-31').map((c) => c.name)).toEqual([
      'Base salary',
    ]);
    expect(selectEffectiveComponents(dated, '2026-09-01').map((c) => c.name)).toEqual([
      'Base salary',
      'Project bonus',
    ]);
  });

  it('includes both boundary days, because a window is inclusive', () => {
    expect(selectEffectiveComponents(dated, '2026-05-31')[0]?.amountMinor).toBe(9_000_000n);
    expect(selectEffectiveComponents(dated, '2026-06-01')[0]?.amountMinor).toBe(10_000_000n);
  });

  it('treats a component with no window as always in force', () => {
    expect(selectEffectiveComponents([base()], '1999-01-01')).toHaveLength(1);
  });

  it('pays the figure that was in force, not the current one', () => {
    const june = calculatePayrollItem(inputs(selectEffectiveComponents(dated, '2026-05-31')));
    const july = calculatePayrollItem(inputs(selectEffectiveComponents(dated, '2026-07-31')));

    expect(june.grossMinor).toBe(9_000_000n);
    expect(july.grossMinor).toBe(10_000_000n);
  });
});

describe('calculatePayrollItem: exact integer arithmetic', () => {
  it('handles amounts beyond the safe range of a double', () => {
    // 2^53 + 1 cannot be represented as a JS number: a float implementation loses
    // the final 1 here, and half of a float 2^53+1 is wrong by 0.5.
    const huge = 9_007_199_254_740_993n;
    const result = calculatePayrollItem(
      inputs([
        base(huge),
        component({ name: 'Half', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 500_000 }),
      ]),
    );

    expect(result.baseMinor).toBe(huge);
    // 4 503 599 627 370 496.5 rounded half-up.
    expect(lineNamed(result.breakdown, 'Half').amountMinor).toBe(4_503_599_627_370_497n);
    expect(result.grossMinor).toBe(13_510_798_882_111_490n);
    expect(result.netMinor).toBe(result.grossMinor);
  });

  it('adds many one-tiyin components without drift', () => {
    const pennies = Array.from({ length: 10 }, (_unused, index) =>
      component({
        name: `Tiny ${index}`,
        type: 'ALLOWANCE',
        calcType: 'FIXED',
        amountMinor: 1n,
      }),
    );
    const result = calculatePayrollItem(inputs([base(0n), ...pennies]));

    expect(result.grossMinor).toBe(10n);
  });

  it('never loses a tiyin between gross, deduction and net', () => {
    const result = calculatePayrollItem(
      inputs([
        base(3_333_333n),
        component({ name: 'Allowance', type: 'ALLOWANCE', calcType: 'PERCENT_OF_BASE', percentPpm: 333_333 }),
        component({ name: 'Tax', type: 'TAX', calcType: 'PERCENT_OF_BASE', percentPpm: 123_456 }),
      ]),
    );

    const earnings = result.breakdown
      .filter((line) => line.effect === 'EARNING')
      .reduce((total, line) => total + line.amountMinor, 0n);
    const withheld = result.breakdown
      .filter((line) => line.effect === 'DEDUCTION')
      .reduce((total, line) => total + line.amountMinor, 0n);

    expect(earnings).toBe(result.grossMinor);
    expect(withheld).toBe(result.deductionMinor);
    expect(result.netMinor).toBe(earnings - withheld);
  });
});

describe('calculatePayrollItem: misconfiguration is refused, not guessed', () => {
  const expectAppError = (run: () => unknown, rule: string): void => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details?.['rule']).toBe(rule);
      return;
    }
    throw new Error(`Expected ${rule} to be thrown`);
  };

  it('refuses a fixed component with no amount', () => {
    expectAppError(
      () =>
        calculatePayrollItem(
          inputs([component({ name: 'Mystery', type: 'ALLOWANCE', calcType: 'FIXED' })]),
        ),
      'payroll.component_missing_amount',
    );
  });

  it('refuses a percentage component with no rate', () => {
    expectAppError(
      () =>
        calculatePayrollItem(
          inputs([base(), component({ name: 'Mystery', type: 'BONUS', calcType: 'PERCENT_OF_BASE' })]),
        ),
      'payroll.component_missing_percent',
    );
  });

  it('refuses a negative amount instead of inverting the component', () => {
    expectAppError(
      () =>
        calculatePayrollItem(
          inputs([
            component({ name: 'Odd', type: 'ALLOWANCE', calcType: 'FIXED', amountMinor: -5n }),
          ]),
        ),
      'payroll.component_negative_amount',
    );
  });

  it('refuses a base defined as a percentage of the base', () => {
    expectAppError(
      () =>
        calculatePayrollItem(
          inputs([
            component({ name: 'Circular', type: 'BASE', calcType: 'PERCENT_OF_BASE', percentPpm: 500_000 }),
          ]),
        ),
      'payroll.base_as_percentage',
    );
  });

  it('refuses to mix currencies', () => {
    expectAppError(
      () => calculatePayrollItem(inputs([base(BASE_MINOR, { currency: 'USD' })])),
      'payroll.currency_mismatch',
    );
  });

  it('refuses a rate outside 0-100%', () => {
    expectAppError(
      () =>
        calculatePayrollItem(
          inputs([
            base(),
            component({ name: 'Absurd', type: 'BONUS', calcType: 'PERCENT_OF_BASE', percentPpm: 1_500_000 }),
          ]),
        ),
      'payroll.component_invalid_percent',
    );
  });
});

describe('the calculator registry', () => {
  it('resolves the default ruleset by key and by omission', () => {
    expect(getPayrollCalculator().key).toBe(DEFAULT_PAYROLL_CALCULATOR_KEY);
    expect(getPayrollCalculator(null).key).toBe(DEFAULT_PAYROLL_CALCULATOR_KEY);
    expect(getPayrollCalculator(DEFAULT_PAYROLL_CALCULATOR_KEY).key).toBe(
      DEFAULT_PAYROLL_CALCULATOR_KEY,
    );
  });

  it('refuses an unknown ruleset rather than falling back silently', () => {
    // Falling back to the default would pay a whole institution under rules nobody
    // chose, which is exactly the kind of quiet substitution payroll cannot afford.
    expect(() => getPayrollCalculator('uz-2026')).toThrow(AppError);
  });

  it('produces the same figures through the registry as through the shortcut', () => {
    const request = inputs([
      base(),
      component({ name: 'Tax', type: 'TAX', calcType: 'PERCENT_OF_BASE', percentPpm: 120_000 }),
    ]);

    expect(getPayrollCalculator().calculate(request)).toEqual(calculatePayrollItem(request));
  });
});
