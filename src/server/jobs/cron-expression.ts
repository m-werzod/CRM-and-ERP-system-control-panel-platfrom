/**
 * A focused five-field cron parser.
 *
 * No cron library is installed, and the alternative to parsing an expression is
 * hard-coding the schedules -- which would defeat the point of `CronSchedule`
 * being a per-organisation database row. So this module implements the subset of
 * Vixie cron the platform actually needs, as pure functions over an explicit
 * `after` instant and timezone. Nothing here reads the clock, touches the
 * database or imports `env`, which is what makes it unit-testable and what keeps
 * `tests/unit/cron.test.ts` free of a database.
 *
 * SUPPORTED: five whitespace-separated fields -- minute (0-59), hour (0-23),
 * day-of-month (1-31), month (1-12), day-of-week (0-7, where both 0 and 7 mean
 * Sunday). Each field takes `*`, a number, a range `a-b`, a list `a,b,c`, and a
 * step on any of those ("every 15 minutes", `10-20/5`, `5/20` meaning "from 5 to the field
 * maximum, every 20"). A step is written as a slash followed by an interval.
 *
 * DELIBERATELY NOT SUPPORTED, because every one of them is a way for a schedule
 * to mean something subtly different from what its author expected, and none is
 * needed by the automations in `JOB_SPECS`:
 *   - alias expressions (`@daily`, `@weekly`, `@reboot`)
 *   - a seconds field: the cron sweep runs on a coarse tick, so sub-minute
 *     precision would be a lie
 *   - three-letter names (`JAN`, `MON`): numeric only, so there is no locale or
 *     case ambiguity to resolve
 *   - the Quartz extensions `L`, `W`, `#` and `?`
 * Anything in that list is rejected as malformed rather than silently
 * reinterpreted.
 */

import { BadRequestError } from '@/server/errors';
import {
  addDaysToDateOnly,
  assertTimeZone,
  instantToWallClockMinute,
  toZonedDateOnly,
  zonedWallClockToInstant,
  type DateOnly,
  type TimeZone,
} from '@/lib/dates';

/**
 * Thrown for an expression that cannot be parsed. A `BadRequestError` rather
 * than a bare `Error` because the expression usually arrives from an admin
 * editing a `CronSchedule`, so the failure has to travel back through the API as
 * a 400 with the reason attached.
 */
export class CronExpressionError extends BadRequestError {
  constructor(expression: string, reason: string) {
    super(`"${expression}" is not a valid cron expression: ${reason}.`, {
      details: { expression, reason },
    });
  }
}

/**
 * A parsed expression. The enumerated values are sorted ascending because
 * `nextCronOccurrence` walks them in order and returns the first match, which is
 * only the *earliest* match if the iteration order is ascending.
 */
export interface CronFields {
  readonly expression: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0 = Sunday. A `7` in the expression is normalised to 0. */
  readonly daysOfWeek: readonly number[];
  /**
   * Whether each day field constrains anything -- i.e. whether it was written as
   * something other than a bare `*`. Needed for the day-matching rule below.
   */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** Folds an out-of-range-but-legal value onto its canonical one (7 -> 0). */
  readonly normalize?: (value: number) => number;
}

const MINUTE_FIELD: FieldSpec = { label: 'minute', min: 0, max: 59 };
const HOUR_FIELD: FieldSpec = { label: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH_FIELD: FieldSpec = { label: 'day-of-month', min: 1, max: 31 };
const MONTH_FIELD: FieldSpec = { label: 'month', min: 1, max: 12 };
const DAY_OF_WEEK_FIELD: FieldSpec = {
  label: 'day-of-week',
  min: 0,
  max: 7,
  normalize: (value) => (value === 7 ? 0 : value),
};

/**
 * `a`, `a-b`, `*`, and any of those with `/n`. The digit bound is part of the
 * grammar: a three-digit number is a typo, not an out-of-range value, and saying
 * so at the syntax level gives a clearer message than a range check would.
 */
const ELEMENT_PATTERN = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/;

function parseField(expression: string, raw: string, spec: FieldSpec): number[] {
  const values = new Set<number>();

  for (const element of raw.split(',')) {
    if (element === '') {
      throw new CronExpressionError(
        expression,
        `the ${spec.label} field "${raw}" has an empty list element`,
      );
    }

    const match = ELEMENT_PATTERN.exec(element);
    if (!match) {
      throw new CronExpressionError(
        expression,
        `"${element}" is not a valid ${spec.label} element -- use a number, *, a range (a-b), a list (a,b) or a step (*/n)`,
      );
    }

    const [, startRaw = '', endRaw, stepRaw] = match;
    const isWildcard = startRaw === '*';

    if (isWildcard && endRaw !== undefined) {
      throw new CronExpressionError(expression, `"${element}" uses * as a range bound`);
    }

    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) {
      throw new CronExpressionError(expression, `"${element}" has a step of ${step}`);
    }

    // A bare number means exactly itself; a number with a step means "from here
    // to the end of the field", which is the Vixie reading of `5/20`.
    const from = isWildcard ? spec.min : Number(startRaw);
    const to = isWildcard
      ? spec.max
      : endRaw !== undefined
        ? Number(endRaw)
        : stepRaw !== undefined
          ? spec.max
          : from;

    if (from < spec.min || from > spec.max || to < spec.min || to > spec.max) {
      throw new CronExpressionError(
        expression,
        `"${element}" is outside the ${spec.label} range ${spec.min}-${spec.max}`,
      );
    }
    if (to < from) {
      throw new CronExpressionError(
        expression,
        `"${element}" is a reversed range -- ${spec.label} ranges must ascend`,
      );
    }

    for (let value = from; value <= to; value += step) {
      values.add(spec.normalize ? spec.normalize(value) : value);
    }
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCronExpression(expression: string): CronFields {
  const trimmed = expression.trim();
  if (trimmed === '') {
    throw new CronExpressionError(expression, 'it is empty');
  }
  if (trimmed.startsWith('@')) {
    throw new CronExpressionError(
      expression,
      'alias expressions such as @daily are not supported -- write the five fields out',
    );
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronExpressionError(
      expression,
      `expected 5 fields (minute hour day-of-month month day-of-week) but found ${parts.length}`,
    );
  }

  // Indexed rather than destructured: `noUncheckedIndexedAccess` types every
  // element as possibly undefined, and the length check above does not narrow it.
  const field = (index: number): string => parts[index] ?? '';

  const dayOfMonthRaw = field(2);
  const dayOfWeekRaw = field(4);

  return {
    expression: trimmed,
    minutes: parseField(trimmed, field(0), MINUTE_FIELD),
    hours: parseField(trimmed, field(1), HOUR_FIELD),
    daysOfMonth: parseField(trimmed, dayOfMonthRaw, DAY_OF_MONTH_FIELD),
    months: parseField(trimmed, field(3), MONTH_FIELD),
    daysOfWeek: parseField(trimmed, dayOfWeekRaw, DAY_OF_WEEK_FIELD),
    dayOfMonthRestricted: dayOfMonthRaw !== '*',
    dayOfWeekRestricted: dayOfWeekRaw !== '*',
  };
}

/** Cheap validity probe for a form or a seed check. */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Weekday of a calendar date, 0 = Sunday, computed without any zone involved. */
function weekdayOfDateOnly(date: DateOnly): number {
  // Anchored at midnight UTC so the weekday is a property of the date string
  // itself. Using the local zone here would shift the day for half the world.
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function monthOfDateOnly(date: DateOnly): number {
  return Number(date.slice(5, 7));
}

function dayOfMonthOf(date: DateOnly): number {
  return Number(date.slice(8, 10));
}

/**
 * Does a calendar day satisfy the month and the two day fields?
 *
 * The day-of-month / day-of-week rule is the historical cron one and it is NOT
 * an AND: when both fields are restricted the day matches if EITHER does, so
 * `0 0 1 * 1` means "the 1st and every Monday", not "a Monday that is the 1st".
 * When only one is restricted, that one decides. Getting this backwards is the
 * classic cron bug, so it is spelled out rather than inferred.
 */
export function cronMatchesDate(fields: CronFields, date: DateOnly): boolean {
  if (!fields.months.includes(monthOfDateOnly(date))) return false;

  const dayOfMonthMatches = fields.daysOfMonth.includes(dayOfMonthOf(date));
  const dayOfWeekMatches = fields.daysOfWeek.includes(weekdayOfDateOnly(date));

  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

/** Does an instant fall on a minute the expression selects, in `timezone`? */
export function cronMatchesInstant(
  fields: CronFields,
  instant: Date,
  timezone: TimeZone,
): boolean {
  const zone = assertTimeZone(timezone);
  const minuteOfDay = instantToWallClockMinute(instant, zone);
  return (
    cronMatchesDate(fields, toZonedDateOnly(instant, zone)) &&
    fields.hours.includes(Math.floor(minuteOfDay / 60)) &&
    fields.minutes.includes(minuteOfDay % 60)
  );
}

/**
 * Five years of candidate days. Long enough that `0 0 29 2 *` resolves to the
 * next leap year instead of reporting "never", and short enough that an
 * impossible expression (`0 0 30 2 *`) terminates in milliseconds.
 */
const MAX_LOOKAHEAD_DAYS = 366 * 5;

/**
 * The first instant strictly after `after` that the expression selects, or null
 * when the expression can never fire (30 February).
 *
 * Wall-clock semantics, which is the whole reason this takes a timezone: "every
 * day at 09:00" means 09:00 as the branch reads a clock, so across a DST change
 * the UTC instant moves rather than the local time drifting.
 *
 * TWO DST EDGE CASES, both resolved in favour of "fires exactly once":
 *
 *  - The hour that repeats in autumn. 02:30 exists twice; `zonedWallClockToInstant`
 *    resolves it to the second (post-transition) one, and because every candidate
 *    must be strictly after `after`, a job already fired at the first 02:30 does
 *    not fire again.
 *  - The hour that does not exist in spring. The zone database resolves 02:30 on
 *    a spring-forward day using the pre-transition offset, so the job fires at
 *    01:30 local -- an hour early in wall-clock terms, but it fires. Skipping the
 *    minute instead would silently drop a daily job for a day, which is the worse
 *    failure for an attendance summary or an overdue-payment sweep.
 */
export function nextCronOccurrence(
  expression: string | CronFields,
  after: Date,
  timezone: TimeZone,
): Date | null {
  const fields = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const zone = assertTimeZone(timezone);

  const startDate = toZonedDateOnly(after, zone);

  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const date = addDaysToDateOnly(startDate, offset);
    if (!cronMatchesDate(fields, date)) continue;

    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        // Every candidate of the first day is converted, including ones whose
        // wall clock is behind `after`, and `> after` is the ONLY filter. Skipping
        // them by wall clock would look like a free optimisation and is not: on an
        // autumn fall-back day an earlier wall clock can map to a later instant,
        // so an hourly schedule would silently lose the repeated hour. Comparing
        // instants is the only comparison that means anything across a transition.
        const instant = zonedWallClockToInstant(date, hour * 60 + minute, zone);
        if (instant.getTime() > after.getTime()) return instant;
      }
    }
  }

  return null;
}

/** Exposed so the parser's own tests can reach the per-field logic directly. */
export const __testing = { parseField, weekdayOfDateOnly, MINUTE_FIELD, DAY_OF_WEEK_FIELD };
