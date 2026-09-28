/**
 * Cron expression tests.
 *
 * The parser and the next-fire computation are the only parts of the job system
 * that can be wrong silently: a worker that fails loudly gets noticed, whereas a
 * schedule that fires an hour late, twice, or never simply looks like nothing
 * happened. So the cases here are the ones that bite in production -- month and
 * year boundaries, a leap day, and both directions of a DST transition -- rather
 * than a sweep of the grammar.
 */

import { describe, expect, it } from 'vitest';
import {
  CronExpressionError,
  cronMatchesDate,
  cronMatchesInstant,
  isValidCronExpression,
  nextCronOccurrence,
  parseCronExpression,
} from '@/server/jobs/cron-expression';

const iso = (value: string): Date => new Date(value);

/**
 * `nextCronOccurrence` returns null for an expression that can never fire, which
 * is a real outcome but never the one under test here. Asserting it away in one
 * place keeps the timing assertions readable.
 */
function mustFire(
  expression: string | Parameters<typeof nextCronOccurrence>[0],
  after: Date,
  zone: string,
): Date {
  const at = nextCronOccurrence(expression, after, zone);
  if (at === null) {
    throw new Error(`expected a fire time after ${after.toISOString()} in ${zone}`);
  }
  return at;
}

describe('parseCronExpression: field grammar', () => {
  it('expands a wildcard to the whole field', () => {
    const fields = parseCronExpression('* * * * *');
    expect(fields.minutes).toHaveLength(60);
    expect(fields.hours).toHaveLength(24);
    expect(fields.daysOfMonth).toHaveLength(31);
    expect(fields.months).toHaveLength(12);
    expect(fields.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('reads a single value', () => {
    const fields = parseCronExpression('7 3 15 6 2');
    expect(fields.minutes).toEqual([7]);
    expect(fields.hours).toEqual([3]);
    expect(fields.daysOfMonth).toEqual([15]);
    expect(fields.months).toEqual([6]);
    expect(fields.daysOfWeek).toEqual([2]);
  });

  it('reads a list and sorts it, de-duplicating repeats', () => {
    expect(parseCronExpression('30,0,15,0 * * * *').minutes).toEqual([0, 15, 30]);
  });

  it('reads a range', () => {
    expect(parseCronExpression('0 9-17 * * *').hours).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it('reads a step over a wildcard', () => {
    expect(parseCronExpression('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
  });

  it('reads a step over a range', () => {
    expect(parseCronExpression('10-20/5 * * * *').minutes).toEqual([10, 15, 20]);
  });

  it('reads a step from a single value as "to the end of the field"', () => {
    expect(parseCronExpression('5/20 * * * *').minutes).toEqual([5, 25, 45]);
  });

  it('combines lists of ranges and steps in one field', () => {
    expect(parseCronExpression('0 0,6-8,*/12 * * *').hours).toEqual([0, 6, 7, 8, 12]);
  });

  it('normalises day-of-week 7 to Sunday', () => {
    expect(parseCronExpression('0 0 * * 7').daysOfWeek).toEqual([0]);
    // 0 and 7 are the same day, so naming both is not two days.
    expect(parseCronExpression('0 0 * * 0,7').daysOfWeek).toEqual([0]);
  });

  it('records whether each day field constrains anything', () => {
    const both = parseCronExpression('0 0 1 * 1');
    expect(both.dayOfMonthRestricted).toBe(true);
    expect(both.dayOfWeekRestricted).toBe(true);

    const neither = parseCronExpression('0 0 * * *');
    expect(neither.dayOfMonthRestricted).toBe(false);
    expect(neither.dayOfWeekRestricted).toBe(false);

    // A stepped wildcard still restricts.
    expect(parseCronExpression('0 0 */2 * *').dayOfMonthRestricted).toBe(true);
  });

  it('keeps the trimmed expression on the parsed result', () => {
    expect(parseCronExpression('  0   9 * * 1-5 ').expression).toBe('0   9 * * 1-5');
  });
});

describe('parseCronExpression: malformed expressions', () => {
  const rejected: readonly [string, string][] = [
    ['', 'empty'],
    ['   ', 'blank'],
    ['* * * *', 'four fields'],
    ['* * * * * *', 'six fields (a seconds field is not supported)'],
    ['@daily', 'an alias expression'],
    ['@every 5m', 'an alias expression with an argument'],
    ['60 * * * *', 'minute above 59'],
    ['* 24 * * *', 'hour above 23'],
    ['0 0 0 * *', 'day-of-month below 1'],
    ['0 0 32 * *', 'day-of-month above 31'],
    ['0 0 * 13 *', 'month above 12'],
    ['0 0 * * 8', 'day-of-week above 7'],
    ['5-1 * * * *', 'a reversed range'],
    ['*/0 * * * *', 'a zero step'],
    ['0-10/0 * * * *', 'a zero step over a range'],
    ['1,,2 * * * *', 'an empty list element'],
    ['1, * * * *', 'a trailing comma'],
    ['JAN * * * *', 'a three-letter name'],
    ['0 0 * * MON', 'a three-letter weekday name'],
    ['0 0 L * *', 'the Quartz last-day extension'],
    ['0 0 ? * *', 'the Quartz no-value extension'],
    ['*-5 * * * *', 'a wildcard used as a range bound'],
    ['100 * * * *', 'a three-digit number'],
    ['0 0 1 * 1#2', 'the Quartz nth-weekday extension'],
  ];

  for (const [expression, why] of rejected) {
    it(`rejects ${why}: "${expression}"`, () => {
      expect(() => parseCronExpression(expression)).toThrow(CronExpressionError);
      expect(isValidCronExpression(expression)).toBe(false);
    });
  }

  it('names the offending field in the message', () => {
    expect(() => parseCronExpression('0 99 * * *')).toThrow(/hour/);
    expect(() => parseCronExpression('0 0 * * 9')).toThrow(/day-of-week/);
  });

  it('carries the expression as error details for the API layer', () => {
    try {
      parseCronExpression('nonsense');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CronExpressionError);
      const appError = error as CronExpressionError;
      expect(appError.status).toBe(400);
      expect(appError.details).toMatchObject({ expression: 'nonsense' });
    }
  });
});

describe('cronMatchesDate: the day-of-month / day-of-week rule', () => {
  it('ANDs the month with a single restricted day field', () => {
    const fields = parseCronExpression('0 0 15 6 *');
    expect(cronMatchesDate(fields, '2026-06-15')).toBe(true);
    expect(cronMatchesDate(fields, '2026-06-16')).toBe(false);
    expect(cronMatchesDate(fields, '2026-07-15')).toBe(false);
  });

  it('ORs the two day fields when BOTH are restricted', () => {
    // "the 1st of the month, and every Monday" -- not "Mondays that are the 1st".
    const fields = parseCronExpression('0 0 1 * 1');
    expect(cronMatchesDate(fields, '2026-10-01')).toBe(true); // a Thursday, but the 1st
    expect(cronMatchesDate(fields, '2026-09-28')).toBe(true); // a Monday, not the 1st
    expect(cronMatchesDate(fields, '2026-09-29')).toBe(false); // neither
  });

  it('uses only day-of-week when day-of-month is a wildcard', () => {
    const fields = parseCronExpression('0 0 * * 1-5');
    expect(cronMatchesDate(fields, '2026-09-28')).toBe(true); // Monday
    expect(cronMatchesDate(fields, '2026-09-27')).toBe(false); // Sunday
  });
});

describe('cronMatchesInstant', () => {
  it('matches on the local wall clock, not on UTC', () => {
    const fields = parseCronExpression('0 9 * * *');
    // 04:00Z is 09:00 in Tashkent (UTC+5) and 06:00 in Berlin.
    expect(cronMatchesInstant(fields, iso('2026-09-27T04:00:00Z'), 'Asia/Tashkent')).toBe(true);
    expect(cronMatchesInstant(fields, iso('2026-09-27T04:00:00Z'), 'Europe/Berlin')).toBe(false);
    expect(cronMatchesInstant(fields, iso('2026-09-27T07:00:00Z'), 'Europe/Berlin')).toBe(true);
  });
});

describe('nextCronOccurrence: basics', () => {
  it('returns the next matching minute, strictly after the given instant', () => {
    const at = nextCronOccurrence('*/15 * * * *', iso('2026-09-27T10:07:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-09-27T10:15:00.000Z');
  });

  it('never returns the instant it was given, even when it matches exactly', () => {
    const exactly = iso('2026-09-27T10:15:00Z');
    const at = nextCronOccurrence('*/15 * * * *', exactly, 'UTC');
    // Otherwise a schedule whose nextRunAt equals the moment it fired would fire
    // forever on the same slot.
    expect(at?.toISOString()).toBe('2026-09-27T10:30:00.000Z');
  });

  it('ignores seconds on the input instant', () => {
    const at = nextCronOccurrence('*/15 * * * *', iso('2026-09-27T10:15:30Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-09-27T10:30:00.000Z');
  });

  it('rolls over a month boundary', () => {
    const at = nextCronOccurrence('0 0 1 * *', iso('2026-01-31T12:00:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rolls over a year boundary', () => {
    const at = nextCronOccurrence('0 3 1 1 *', iso('2026-12-31T23:59:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('skips months that do not have the requested day', () => {
    // 31 January to 31 March: February and the 30-day months have no 31st.
    const at = nextCronOccurrence('0 0 31 * *', iso('2026-01-31T00:30:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('finds 29 February in the next leap year', () => {
    const at = nextCronOccurrence('30 3 29 2 *', iso('2026-03-01T00:00:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2028-02-29T03:30:00.000Z');
  });

  it('returns null for a date that never occurs', () => {
    expect(nextCronOccurrence('0 0 30 2 *', iso('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
  });

  it('applies the OR day rule when walking forward', () => {
    // From Sunday 2026-09-27: the next Monday is the 28th.
    const at = nextCronOccurrence('0 0 1 * 1', iso('2026-09-27T12:00:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });

  it('rejects an unknown timezone rather than guessing', () => {
    expect(() => nextCronOccurrence('0 0 * * *', new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });

  it('accepts a pre-parsed expression, so a sweep parses once per row', () => {
    const fields = parseCronExpression('0 0 * * *');
    const at = nextCronOccurrence(fields, iso('2026-09-27T12:00:00Z'), 'UTC');
    expect(at?.toISOString()).toBe('2026-09-28T00:00:00.000Z');
  });
});

describe('nextCronOccurrence: Asia/Tashkent has no DST', () => {
  // The platform default timezone. UTC+5 all year, which is precisely why it
  // cannot prove the timezone arithmetic works -- see the Berlin cases below.
  it('holds a fixed UTC offset across the date Europe changes clocks', () => {
    const before = nextCronOccurrence('0 9 * * *', iso('2026-03-28T05:00:00Z'), 'Asia/Tashkent');
    expect(before?.toISOString()).toBe('2026-03-29T04:00:00.000Z');

    const after = nextCronOccurrence('0 9 * * *', iso('2026-03-29T05:00:00Z'), 'Asia/Tashkent');
    expect(after?.toISOString()).toBe('2026-03-30T04:00:00.000Z');
  });

  it('keeps consecutive daily fires exactly 24 hours apart', () => {
    let at = iso('2026-03-27T04:00:00Z');
    for (let day = 0; day < 4; day += 1) {
      const next = mustFire('0 9 * * *', at, 'Asia/Tashkent');
      expect(next.getTime() - at.getTime()).toBe(24 * 60 * 60 * 1000);
      at = next;
    }
  });
});

describe('nextCronOccurrence: Europe/Berlin DST transitions', () => {
  // Berlin 2026: forward Sunday 29 March (02:00 -> 03:00), back Sunday 25 October
  // (03:00 -> 02:00). A daily fire is 23 hours after the previous one in spring
  // and 25 in autumn -- the local time is what stays put.
  it('keeps a daily schedule at its local time either side of spring forward', () => {
    const before = iso('2026-03-28T08:00:00Z'); // 09:00 local, CET
    const intoTransition = mustFire('0 9 * * *', before, 'Europe/Berlin');
    // 09:00 CEST is 07:00Z: 23 hours later, not 24.
    expect(intoTransition.toISOString()).toBe('2026-03-29T07:00:00.000Z');
    expect(intoTransition.getTime() - before.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('keeps a daily schedule at its local time either side of falling back', () => {
    const before = iso('2026-10-24T07:00:00Z'); // 09:00 local, CEST
    const intoTransition = mustFire('0 9 * * *', before, 'Europe/Berlin');
    expect(intoTransition.toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(intoTransition.getTime() - before.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('still fires a daily schedule whose local time does not exist that day', () => {
    // 02:30 is skipped by the clock on 29 March. The zone database resolves it
    // with the pre-transition offset, so the job runs once at 01:30 local rather
    // than being silently dropped for the day -- which for an attendance summary
    // or a debt sweep is the outcome that matters.
    const before = iso('2026-03-28T01:30:00Z'); // 02:30 local on the 28th
    const at = mustFire('30 2 * * *', before, 'Europe/Berlin');
    expect(at.toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(at.getTime()).toBeGreaterThan(before.getTime());
  });

  it('fires a daily schedule exactly once on the day its local time repeats', () => {
    // 02:30 happens twice on 25 October. It must not fire twice.
    const first = mustFire('30 2 * * *', iso('2026-10-24T00:30:00Z'), 'Europe/Berlin');
    expect(first.toISOString()).toBe('2026-10-25T01:30:00.000Z');

    const second = mustFire('30 2 * * *', first, 'Europe/Berlin');
    expect(second.toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });

  it('does not lose the repeated hour for an hourly schedule', () => {
    // Walking hour by hour through the fall-back: 00:00Z is 02:00 CEST, then the
    // clock goes back and 02:00 local happens again at 01:00Z. Both fire, because
    // candidates are compared as instants and never as wall clocks.
    const at = mustFire('0 * * * *', iso('2026-10-25T00:30:00Z'), 'Europe/Berlin');
    expect(at.toISOString()).toBe('2026-10-25T01:00:00.000Z');

    const next = mustFire('0 * * * *', at, 'Europe/Berlin');
    expect(next.toISOString()).toBe('2026-10-25T02:00:00.000Z');
  });

  it('advances monotonically across a whole spring-forward day', () => {
    // The real invariant a scheduler needs: never the same instant twice, never
    // backwards, whatever the clocks do.
    let at = iso('2026-03-28T22:00:00Z');
    const fired: number[] = [];
    for (let tick = 0; tick < 40; tick += 1) {
      const next = mustFire('*/30 * * * *', at, 'Europe/Berlin');
      expect(next.getTime()).toBeGreaterThan(at.getTime());
      fired.push(next.getTime());
      at = next;
    }
    expect(new Set(fired).size).toBe(fired.length);
  });
});
