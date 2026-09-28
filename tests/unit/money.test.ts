import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  allocateByWeights,
  applyPpm,
  compare,
  deserializeMoney,
  formatMoney,
  money,
  parseMoneyInput,
  percentToPpm,
  ratioPpm,
  serializeMoney,
  subtract,
  sum,
  toMajorString,
  zero,
} from '@/lib/money';

describe('money construction', () => {
  it('rejects a non-integer number of minor units', () => {
    // The whole point of minor units is that they are integers; accepting 10.5
    // tiyin would reintroduce the float rounding we are avoiding.
    expect(() => money(10.5, 'UZS')).toThrow(/integer/i);
  });

  it('rejects an unsupported currency', () => {
    expect(() => money(100n, 'XYZ')).toThrow(/Unsupported currency/);
  });

  it('accepts bigint and integer number input', () => {
    expect(money(150n, 'USD').amountMinor).toBe(150n);
    expect(money(150, 'USD').amountMinor).toBe(150n);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within one currency', () => {
    expect(add(money(150n, 'USD'), money(250n, 'USD')).amountMinor).toBe(400n);
    expect(subtract(money(150n, 'USD'), money(250n, 'USD')).amountMinor).toBe(-100n);
  });

  it('refuses to mix currencies', () => {
    // Silently treating 100 USD as 100 UZS is the kind of bug that produces a
    // plausible-looking but catastrophically wrong invoice.
    expect(() => add(money(100n, 'USD'), money(100n, 'UZS'))).toThrow(/Refusing to combine/);
    expect(() => subtract(money(100n, 'EUR'), money(1n, 'USD'))).toThrow(/Refusing to combine/);
  });

  it('sums an empty list to zero in the stated currency', () => {
    expect(sum([], 'UZS')).toEqual(zero('UZS'));
  });

  it('rejects a sum whose members disagree with the stated currency', () => {
    expect(() => sum([money(1n, 'USD')], 'UZS')).toThrow(/while accumulating/);
  });

  it('orders amounts', () => {
    expect(compare(money(1n, 'USD'), money(2n, 'USD'))).toBe(-1);
    expect(compare(money(2n, 'USD'), money(2n, 'USD'))).toBe(0);
    expect(compare(money(3n, 'USD'), money(2n, 'USD'))).toBe(1);
  });
});

describe('percentages', () => {
  it('converts a human percentage to ppm exactly', () => {
    expect(percentToPpm(10)).toBe(100_000);
    expect(percentToPpm(12.5)).toBe(125_000);
    expect(percentToPpm(0.01)).toBe(100);
  });

  it('applies a rate with half-up rounding', () => {
    // 10% of 1005 is 100.5 minor units, which must round to 101, not 100.
    expect(applyPpm(money(1005n, 'USD'), 100_000).amountMinor).toBe(101n);
  });

  it('supports explicit rounding modes', () => {
    expect(applyPpm(money(1005n, 'USD'), 100_000, 'down').amountMinor).toBe(100n);
    expect(applyPpm(money(1005n, 'USD'), 100_000, 'up').amountMinor).toBe(101n);
    // Banker's rounding sends an exact .5 to the even neighbour.
    expect(applyPpm(money(1005n, 'USD'), 100_000, 'half-even').amountMinor).toBe(100n);
  });

  it('rounds negative amounts symmetrically', () => {
    expect(applyPpm(money(-1005n, 'USD'), 100_000).amountMinor).toBe(-101n);
  });

  it('computes a ratio in ppm and treats a zero whole as zero', () => {
    expect(ratioPpm(money(25n, 'USD'), money(100n, 'USD'))).toBe(250_000);
    expect(ratioPpm(money(5n, 'USD'), zero('USD'))).toBe(0);
  });
});

describe('allocation', () => {
  it('splits without losing a minor unit', () => {
    const parts = allocate(money(100n, 'USD'), 3);
    expect(parts.map((p) => p.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(sum(parts, 'USD').amountMinor).toBe(100n);
  });

  it('splits a negative amount without losing a minor unit', () => {
    const parts = allocate(money(-100n, 'USD'), 3);
    expect(sum(parts, 'USD').amountMinor).toBe(-100n);
  });

  it('splits by weights and still preserves the total', () => {
    const parts = allocateByWeights(money(1000n, 'USD'), [1, 1, 1]);
    expect(sum(parts, 'USD').amountMinor).toBe(1000n);

    const uneven = allocateByWeights(money(1000n, 'USD'), [7, 2, 1]);
    expect(sum(uneven, 'USD').amountMinor).toBe(1000n);
    expect(uneven[0]!.amountMinor).toBe(700n);
  });

  it('gives the truncation remainder to the heaviest weight', () => {
    // 10 split by [2,1] is 6.66/3.33; the leftover unit goes to the larger share.
    const parts = allocateByWeights(money(10n, 'USD'), [2, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([7n, 3n]);
  });

  it('falls back to an even split when every weight is zero', () => {
    const parts = allocateByWeights(money(10n, 'USD'), [0, 0]);
    expect(sum(parts, 'USD').amountMinor).toBe(10n);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocate(money(10n, 'USD'), 0)).toThrow(/positive integer/);
  });
});

describe('parsing human input', () => {
  it('parses plain digits into minor units', () => {
    expect(parseMoneyInput('1500000', 'UZS').amountMinor).toBe(150_000_000n);
  });

  it('tolerates the separators people actually type', () => {
    for (const input of ['1 500 000', '1 500 000', "1'500'000", '1,500,000']) {
      expect(parseMoneyInput(input, 'UZS').amountMinor).toBe(150_000_000n);
    }
  });

  it('parses decimals up to the currency exponent', () => {
    expect(parseMoneyInput('10.5', 'USD').amountMinor).toBe(1050n);
    expect(parseMoneyInput('10.55', 'USD').amountMinor).toBe(1055n);
    expect(parseMoneyInput('.5', 'USD').amountMinor).toBe(50n);
  });

  it('rejects more decimal places than the currency has', () => {
    expect(() => parseMoneyInput('10.555', 'USD')).toThrow(/at most 2 decimal/);
  });

  it('parses negatives', () => {
    expect(parseMoneyInput('-10.50', 'USD').amountMinor).toBe(-1050n);
  });

  it('rejects junk rather than guessing', () => {
    for (const input of ['', 'abc', '1.2.3', '--5', '1e5']) {
      expect(() => parseMoneyInput(input, 'USD')).toThrow();
    }
  });

  it('never routes through a float', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004. Parsing the decimal text must
    // produce exactly 30 cents.
    expect(parseMoneyInput('0.30', 'USD').amountMinor).toBe(30n);
    // A value beyond IEEE-754 integer precision must survive intact.
    expect(parseMoneyInput('99999999999999999', 'UZS').amountMinor).toBe(
      9_999_999_999_999_999_900n,
    );
  });
});

describe('serialisation boundaries', () => {
  it('round-trips through the wire format', () => {
    const original = money(150_000_000n, 'UZS');
    const wire = serializeMoney(original);
    expect(wire.amountMinor).toBe('150000000');
    expect(JSON.parse(JSON.stringify(wire)).amountMinor).toBe('150000000');
    expect(deserializeMoney(wire)).toEqual(original);
  });

  it('renders exact major-unit strings', () => {
    expect(toMajorString(money(150_000_000n, 'UZS'))).toBe('1500000.00');
    expect(toMajorString(money(1055n, 'USD'))).toBe('10.55');
    expect(toMajorString(money(-5n, 'USD'))).toBe('-0.05');
    expect(toMajorString(money(5n, 'USD'))).toBe('0.05');
  });

  it('formats UZS with no decimals and USD with two', () => {
    expect(formatMoney(money(150_000_000n, 'UZS'), { withSymbol: false })).toBe('1 500 000');
    expect(formatMoney(money(1055n, 'USD'), { withSymbol: false })).toBe('10.55');
  });
});
