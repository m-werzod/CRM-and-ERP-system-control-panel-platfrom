import { describe, expect, it } from 'vitest';
import { examStatistics } from '@/server/services/assessment/statistics';
import { BusinessRuleError } from '@/server/errors';

/**
 * These pin down the arithmetic behind every number a teacher, a head of studies
 * and a certificate decision read off an exam. The absence rule in particular is
 * a judgement, not a formula, so it is asserted rather than assumed: an absence is
 * not a zero.
 */

const outOfTen = { maxScore: 10, passingScore: 5 };

describe('examStatistics', () => {
  it('reports nothing rather than zero for an empty cohort', () => {
    const stats = examStatistics([], outOfTen);

    expect(stats.count).toBe(0);
    // Null, not 0: an exam nobody sat has an unknown average, and a 0% pass rate
    // would read as "everybody failed".
    expect(stats.average).toBeNull();
    expect(stats.median).toBeNull();
    expect(stats.highest).toBeNull();
    expect(stats.lowest).toBeNull();
    expect(stats.passRatePpm).toBeNull();
    expect(stats.standardDeviation).toBeNull();
    expect(stats.passCount).toBe(0);
    expect(stats.failCount).toBe(0);
    // The histogram still has its shape, so a chart renders empty rather than absent.
    expect(stats.distribution).toHaveLength(5);
    expect(stats.distribution.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('handles a single score', () => {
    const stats = examStatistics([7], outOfTen);

    expect(stats.count).toBe(1);
    expect(stats.average).toBe(7);
    expect(stats.median).toBe(7);
    expect(stats.highest).toBe(7);
    expect(stats.lowest).toBe(7);
    expect(stats.passCount).toBe(1);
    expect(stats.failCount).toBe(0);
    expect(stats.passRatePpm).toBe(1_000_000);
    // One observation has no spread.
    expect(stats.standardDeviation).toBe(0);
  });

  it('takes the middle value as the median for an odd count', () => {
    // Deliberately unsorted: the function sorts, the caller does not have to.
    const stats = examStatistics([9, 1, 5], outOfTen);
    expect(stats.median).toBe(5);
    expect(stats.average).toBe(5);
  });

  it('averages the two middle values as the median for an even count', () => {
    const stats = examStatistics([1, 4, 6, 9], outOfTen);
    expect(stats.median).toBe(5);
    expect(stats.average).toBe(5);
  });

  it('reports a median that differs from the average', () => {
    // 1, 1, 1, 9 -> median 1, average 3. A cohort where one student carries the mean.
    const stats = examStatistics([1, 1, 1, 9], outOfTen);
    expect(stats.median).toBe(1);
    expect(stats.average).toBe(3);
  });

  it('excludes absent students from the average but still counts them', () => {
    const withAbsences = examStatistics(
      [
        { score: 10 },
        { score: 8 },
        { score: null, isAbsent: true },
        { score: null, isAbsent: true },
      ],
      outOfTen,
    );

    expect(withAbsences.count).toBe(2);
    expect(withAbsences.absentCount).toBe(2);
    // 9, not 4.5: averaging the two absences as zeros would understate the class
    // by half and punish it for an illness.
    expect(withAbsences.average).toBe(9);
    expect(withAbsences.median).toBe(9);
    expect(withAbsences.lowest).toBe(8);
    expect(withAbsences.passCount).toBe(2);
    expect(withAbsences.failCount).toBe(0);
    expect(withAbsences.passRatePpm).toBe(1_000_000);
    // And the absences do not appear in the bottom bucket either.
    expect(withAbsences.distribution[0]?.count).toBe(0);

    // The same two students, had they been scored zero, would tell a different story.
    const asZeros = examStatistics([10, 8, 0, 0], outOfTen);
    expect(asZeros.average).toBe(4.5);
    expect(asZeros.passRatePpm).toBe(500_000);
  });

  it('counts a present-but-ungraded student separately from an absence', () => {
    const stats = examStatistics(
      [{ score: 6 }, { score: null }, { score: null, isAbsent: true }],
      outOfTen,
    );

    expect(stats.count).toBe(1);
    expect(stats.pendingCount).toBe(1);
    expect(stats.absentCount).toBe(1);
    expect(stats.average).toBe(6);
  });

  it('treats the passing score itself as a pass', () => {
    const stats = examStatistics([4, 5, 6], { maxScore: 10, passingScore: 5 });

    // 5 is a pass: the boundary is inclusive, which is the difference between a
    // resit and a certificate for the student who scored exactly the pass mark.
    expect(stats.passCount).toBe(2);
    expect(stats.failCount).toBe(1);
    expect(stats.passRatePpm).toBe(666_667);
  });

  it('matches a hand-computed population standard deviation', () => {
    // Mean of [2,4,4,4,5,5,7,9] is 5. Squared deviations 9,1,1,1,0,0,4,16 sum to
    // 32; 32/8 = 4; sqrt(4) = 2. Population (divide by n), because these are all
    // the students who sat the exam, not a sample of a larger group.
    const stats = examStatistics([2, 4, 4, 4, 5, 5, 7, 9], outOfTen);

    expect(stats.average).toBe(5);
    expect(stats.standardDeviation).toBe(2);
  });

  it('does not leak floating-point dust into the average', () => {
    const stats = examStatistics([1, 2], { maxScore: 3, passingScore: 2 });
    expect(stats.average).toBe(1.5);

    const thirds = examStatistics([1, 1, 2], { maxScore: 3, passingScore: 2 });
    // 4/3 rounded to four decimals, not 1.3333333333333333.
    expect(thirds.average).toBe(1.3333);
  });

  it('puts a score on a bucket boundary in the higher bucket', () => {
    const scale = { maxScore: 100, passingScore: 50 };

    // Five buckets, 20 percentage points each: [0,20) [20,40) [40,60) [60,80) [80,100].
    const stats = examStatistics([0, 19, 20, 39, 40, 79, 80, 99, 100], scale);

    expect(stats.distribution.map((bucket) => bucket.count)).toEqual([2, 2, 1, 1, 3]);
    expect(stats.distribution.map((bucket) => bucket.label)).toEqual([
      '0-20%',
      '20-40%',
      '40-60%',
      '60-80%',
      '80-100%',
    ]);
    expect(stats.distribution[0]?.fromPercentPpm).toBe(0);
    expect(stats.distribution[0]?.toPercentPpm).toBe(200_000);
    expect(stats.distribution[4]?.toPercentPpm).toBe(1_000_000);
  });

  it('keeps the maximum score inside the top bucket', () => {
    const stats = examStatistics([100], { maxScore: 100, passingScore: 50, bucketCount: 4 });

    expect(stats.distribution).toHaveLength(4);
    expect(stats.distribution[3]?.count).toBe(1);
    expect(stats.distribution[3]?.label).toBe('75-100%');
  });

  it('honours a custom bucket count', () => {
    const stats = examStatistics([1, 3, 5, 7, 9], { maxScore: 10, passingScore: 5, bucketCount: 2 });

    // Halves of a ten-mark paper: [0,5) takes 1 and 3; [5,10] takes 5, 7 and 9.
    expect(stats.distribution.map((bucket) => bucket.count)).toEqual([2, 3]);
  });

  it('rejects a scale that cannot produce a percentage', () => {
    expect(() => examStatistics([1], { maxScore: 0, passingScore: 0 })).toThrow(BusinessRuleError);
    expect(() => examStatistics([1], { maxScore: -10, passingScore: 0 })).toThrow(BusinessRuleError);
    expect(() => examStatistics([1], { maxScore: 10, passingScore: 11 })).toThrow(
      BusinessRuleError,
    );
    expect(() => examStatistics([1], { maxScore: 10, passingScore: -1 })).toThrow(
      BusinessRuleError,
    );
  });
});
