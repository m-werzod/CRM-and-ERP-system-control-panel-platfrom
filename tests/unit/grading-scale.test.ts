import { describe, expect, it } from 'vitest';
import {
  resolveGrade,
  scoreToPpm,
  validateGradingBands,
  SCORE_PPM_MAX,
  type GradingBandInput,
} from '@/server/services/academics/grading-scales';

/**
 * These pin down the score-to-grade mapping and the band-tiling rule. Both are pure
 * precisely so the boundary cases -- the ppm at which a fail becomes a pass -- can be
 * asserted without a database, because that boundary is what decides whether a student
 * passes.
 */

/** A conventional five-band percentage scale, contiguous over 0..1_000_000 ppm. */
const FIVE_BAND: readonly GradingBandInput[] = [
  { label: 'F', minPercentPpm: 0, maxPercentPpm: 499_999, isPass: false, gpaPoints: 0 },
  { label: 'D', minPercentPpm: 500_000, maxPercentPpm: 599_999, gpaPoints: 1 },
  { label: 'C', minPercentPpm: 600_000, maxPercentPpm: 749_999, gpaPoints: 2 },
  { label: 'B', minPercentPpm: 750_000, maxPercentPpm: 899_999, gpaPoints: 3 },
  { label: 'A', minPercentPpm: 900_000, maxPercentPpm: 1_000_000, gpaPoints: 4 },
];

const PASS_FAIL: readonly GradingBandInput[] = [
  { label: 'Fail', minPercentPpm: 0, maxPercentPpm: 599_999, isPass: false },
  { label: 'Pass', minPercentPpm: 600_000, maxPercentPpm: 1_000_000 },
];

describe('resolveGrade', () => {
  it('maps a mid-band score to its band', () => {
    expect(resolveGrade(FIVE_BAND, 820_000)?.label).toBe('B');
  });

  it('includes both bounds, so a score sitting exactly on a boundary resolves', () => {
    // Both ends inclusive: 749_999 is still a C and 750_000 is already a B.
    expect(resolveGrade(FIVE_BAND, 749_999)?.label).toBe('C');
    expect(resolveGrade(FIVE_BAND, 750_000)?.label).toBe('B');
  });

  it('resolves the extremes of the range', () => {
    expect(resolveGrade(FIVE_BAND, 0)?.label).toBe('F');
    expect(resolveGrade(FIVE_BAND, SCORE_PPM_MAX)?.label).toBe('A');
  });

  it('carries the band payload through, not just the label', () => {
    const band = resolveGrade(FIVE_BAND, 100_000);
    expect(band?.isPass).toBe(false);
    expect(band?.gpaPoints).toBe(0);
  });

  it('returns null outside 0..1_000_000 rather than clamping', () => {
    // Clamping would turn a marking bug into a plausible-looking grade.
    expect(resolveGrade(FIVE_BAND, -1)).toBeNull();
    expect(resolveGrade(FIVE_BAND, 1_000_001)).toBeNull();
    expect(resolveGrade(FIVE_BAND, Number.NaN)).toBeNull();
  });

  it('returns null for an empty scale', () => {
    expect(resolveGrade([], 500_000)).toBeNull();
  });

  it('does not depend on the order the bands arrive in', () => {
    const shuffled = [...FIVE_BAND].reverse();
    for (const ppm of [0, 499_999, 500_000, 600_000, 899_999, 900_000, 1_000_000]) {
      expect(resolveGrade(shuffled, ppm)?.label).toBe(resolveGrade(FIVE_BAND, ppm)?.label);
    }
  });

  it('is deterministic on an overlapping scale, picking the lower band', () => {
    // An unvalidated scale can still be stored by a hand-edited database; the result
    // must not depend on which order the rows came back in.
    const overlapping: GradingBandInput[] = [
      { label: 'High', minPercentPpm: 400_000, maxPercentPpm: 1_000_000 },
      { label: 'Low', minPercentPpm: 0, maxPercentPpm: 600_000 },
    ];
    expect(resolveGrade(overlapping, 500_000)?.label).toBe('Low');
    expect(resolveGrade([...overlapping].reverse(), 500_000)?.label).toBe('Low');
  });

  it('does not mutate the array it is given', () => {
    const bands = [...FIVE_BAND];
    resolveGrade(bands, 500_000);
    expect(bands.map((band) => band.label)).toEqual(['F', 'D', 'C', 'B', 'A']);
  });

  it('works for a two-band pass/fail scale', () => {
    expect(resolveGrade(PASS_FAIL, 599_999)?.isPass).toBe(false);
    expect(resolveGrade(PASS_FAIL, 600_000)?.label).toBe('Pass');
  });

  it('resolves every ppm on a valid scale to exactly one band', () => {
    // The tiling guarantee, sampled: no gap and no ambiguity anywhere in the range.
    for (let ppm = 0; ppm <= SCORE_PPM_MAX; ppm += 1_249) {
      const matches = FIVE_BAND.filter(
        (band) => ppm >= band.minPercentPpm && ppm <= band.maxPercentPpm,
      );
      expect(matches).toHaveLength(1);
      expect(resolveGrade(FIVE_BAND, ppm)?.label).toBe(matches[0]?.label);
    }
  });
});

describe('scoreToPpm', () => {
  it('converts a score out of a maximum to integer ppm', () => {
    expect(scoreToPpm(43, 50)).toBe(860_000);
    expect(scoreToPpm(50, 50)).toBe(SCORE_PPM_MAX);
    expect(scoreToPpm(0, 50)).toBe(0);
  });

  it('rounds to a whole ppm rather than carrying a fraction', () => {
    // 1/3 of the marks is 333_333.33 ppm; a float here is what makes a boundary
    // irreproducible.
    expect(scoreToPpm(1, 3)).toBe(333_333);
    expect(Number.isInteger(scoreToPpm(2, 3))).toBe(true);
  });

  it('composes with resolveGrade for a real marking case', () => {
    expect(resolveGrade(FIVE_BAND, scoreToPpm(30, 50))?.label).toBe('C');
    expect(resolveGrade(FIVE_BAND, scoreToPpm(29, 50))?.label).toBe('D');
  });

  it('rejects a non-positive maximum', () => {
    expect(() => scoreToPpm(10, 0)).toThrow(/greater than zero/i);
  });
});

describe('validateGradingBands', () => {
  it('accepts a contiguous scale', () => {
    expect(() => validateGradingBands(FIVE_BAND)).not.toThrow();
    expect(() => validateGradingBands(PASS_FAIL)).not.toThrow();
  });

  it('accepts a single band covering the whole range', () => {
    expect(() =>
      validateGradingBands([{ label: 'Complete', minPercentPpm: 0, maxPercentPpm: 1_000_000 }]),
    ).not.toThrow();
  });

  it('accepts bands submitted out of order', () => {
    expect(() => validateGradingBands([...FIVE_BAND].reverse())).not.toThrow();
  });

  it('rejects an empty scale', () => {
    expect(() => validateGradingBands([])).toThrow(/at least one band/i);
  });

  it('rejects a gap between two bands, naming both', () => {
    const withGap: GradingBandInput[] = [
      { label: 'Low', minPercentPpm: 0, maxPercentPpm: 499_999 },
      { label: 'High', minPercentPpm: 600_000, maxPercentPpm: 1_000_000 },
    ];
    expect(() => validateGradingBands(withGap)).toThrow(/gap between "Low" and "High"/i);
  });

  it('treats a shared boundary as an overlap, because both bounds are inclusive', () => {
    const touching: GradingBandInput[] = [
      { label: 'Low', minPercentPpm: 0, maxPercentPpm: 500_000 },
      { label: 'High', minPercentPpm: 500_000, maxPercentPpm: 1_000_000 },
    ];
    expect(() => validateGradingBands(touching)).toThrow(/overlap/i);
    expect(() => validateGradingBands(touching)).toThrow(/"Low" and "High"/);
  });

  it('rejects a wholly contained band', () => {
    const nested: GradingBandInput[] = [
      { label: 'Everything', minPercentPpm: 0, maxPercentPpm: 1_000_000 },
      { label: 'Middle', minPercentPpm: 400_000, maxPercentPpm: 600_000 },
    ];
    expect(() => validateGradingBands(nested)).toThrow(/overlap/i);
  });

  it('rejects a scale that does not start at 0', () => {
    expect(() =>
      validateGradingBands([{ label: 'Pass', minPercentPpm: 1, maxPercentPpm: 1_000_000 }]),
    ).toThrow(/starts above 0%/i);
  });

  it('rejects a scale that does not reach 100%', () => {
    expect(() =>
      validateGradingBands([{ label: 'Pass', minPercentPpm: 0, maxPercentPpm: 999_999 }]),
    ).toThrow(/stops below 100%/i);
  });

  it('rejects a bound outside 0..1_000_000', () => {
    expect(() =>
      validateGradingBands([{ label: 'Silly', minPercentPpm: 0, maxPercentPpm: 1_000_001 }]),
    ).toThrow(/outside 0–100%/i);
    expect(() =>
      validateGradingBands([{ label: 'Silly', minPercentPpm: -1, maxPercentPpm: 1_000_000 }]),
    ).toThrow(/outside 0–100%/i);
  });

  it('rejects an inverted band', () => {
    expect(() =>
      validateGradingBands([
        { label: 'Backwards', minPercentPpm: 800_000, maxPercentPpm: 200_000 },
      ]),
    ).toThrow(/ends below where it starts/i);
  });

  it('rejects a fractional bound', () => {
    expect(() =>
      validateGradingBands([{ label: 'Fuzzy', minPercentPpm: 0, maxPercentPpm: 999_999.5 }]),
    ).toThrow(/fractional bound/i);
  });

  it('rejects two bands with the same label', () => {
    expect(() =>
      validateGradingBands([
        { label: 'Pass', minPercentPpm: 0, maxPercentPpm: 499_999 },
        { label: 'Pass', minPercentPpm: 500_000, maxPercentPpm: 1_000_000 },
      ]),
    ).toThrow(/both labelled "Pass"/i);
  });

  it('rejects negative GPA points', () => {
    expect(() =>
      validateGradingBands([
        { label: 'Odd', minPercentPpm: 0, maxPercentPpm: 1_000_000, gpaPoints: -1 },
      ]),
    ).toThrow(/negative GPA/i);
  });

  it('does not mutate the array it is given', () => {
    const bands = [...FIVE_BAND].reverse();
    const before = bands.map((band) => band.label);
    validateGradingBands(bands);
    expect(bands.map((band) => band.label)).toEqual(before);
  });

  it('guarantees resolveGrade finds a band for every in-range score it accepts', () => {
    // The contract between the two functions: validation is what makes a null from
    // resolveGrade mean "the score is out of range", not "the scale has a hole".
    validateGradingBands(FIVE_BAND);
    for (const ppm of [0, 1, 499_999, 500_000, 899_999, 900_000, 999_999, 1_000_000]) {
      expect(resolveGrade(FIVE_BAND, ppm)).not.toBeNull();
    }
  });
});
