/**
 * Timezone-aware date handling.
 *
 * Rules this module exists to enforce:
 *
 *  1. Instants are stored and transported as UTC (`timestamptz` in the database,
 *     ISO-8601 with `Z` on the wire). The SERVER TIMEZONE IS NEVER CONSULTED --
 *     the database session is pinned to UTC in src/server/db/client.ts.
 *
 *  2. "Calendar day" is always relative to an explicit timezone: the branch's,
 *     falling back to the organisation's. A lesson at 23:30 Tashkent time on the
 *     30th belongs to the 30th even though it is the 29th in UTC, so
 *     `Lesson.lessonDate` is computed with `toZonedDateOnly`, never with
 *     `new Date().toISOString().slice(0, 10)`.
 *
 *  3. Recurring schedule patterns store local wall-clock minutes, not instants,
 *     so a DST transition moves the lesson with the clock rather than shifting
 *     every class by an hour. `zonedWallClockToInstant` is the only sanctioned
 *     conversion from a pattern to a concrete lesson time.
 */

import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  addDays,
  addMinutes,
  differenceInCalendarDays,
  differenceInMinutes,
  endOfDay,
  isAfter,
  isBefore,
  startOfDay,
} from 'date-fns';

/** IANA timezone identifier, e.g. "Asia/Tashkent". */
export type TimeZone = string;

/** A calendar date with no time or zone, as "YYYY-MM-DD". */
export type DateOnly = string;

export const DEFAULT_TIMEZONE: TimeZone = 'Asia/Tashkent';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string): value is DateOnly {
  return DATE_ONLY_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function assertTimeZone(zone: string): TimeZone {
  try {
    // Throws RangeError for an unknown identifier.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    throw new RangeError(`Unknown IANA timezone: ${zone}`);
  }
}

/**
 * Pick the timezone for an operation. A branch may sit in a different zone from
 * its organisation; the branch wins when it declares one.
 */
export function resolveTimeZone(
  branchTimezone: string | null | undefined,
  organizationTimezone: string | null | undefined,
): TimeZone {
  return branchTimezone || organizationTimezone || DEFAULT_TIMEZONE;
}

// ---------------------------------------------------------------------------
// Calendar day boundaries
// ---------------------------------------------------------------------------

/** The calendar date an instant falls on, in the given zone. */
export function toZonedDateOnly(instant: Date, zone: TimeZone): DateOnly {
  return formatInTimeZone(instant, zone, 'yyyy-MM-dd');
}

/** Today's calendar date in the given zone. */
export function todayIn(zone: TimeZone, now: Date = new Date()): DateOnly {
  return toZonedDateOnly(now, zone);
}

/**
 * The UTC instant at which a local calendar day begins.
 * `startOfDayInstant('2026-03-29', 'Europe/Berlin')` accounts for the DST jump.
 */
export function startOfDayInstant(date: DateOnly, zone: TimeZone): Date {
  return fromZonedTime(`${date}T00:00:00`, zone);
}

/** The UTC instant immediately after a local calendar day ends (exclusive). */
export function endOfDayExclusiveInstant(date: DateOnly, zone: TimeZone): Date {
  return startOfDayInstant(addDaysToDateOnly(date, 1), zone);
}

/**
 * Half-open instant range `[from, to)` covering a span of local calendar days.
 * Half-open is deliberate: `lessonDate >= from AND lessonDate < to` cannot
 * double-count a lesson at exactly midnight, which an inclusive range can.
 */
export function dayRangeToInstants(
  fromDate: DateOnly,
  toDate: DateOnly,
  zone: TimeZone,
): { from: Date; toExclusive: Date } {
  return {
    from: startOfDayInstant(fromDate, zone),
    toExclusive: endOfDayExclusiveInstant(toDate, zone),
  };
}

export function addDaysToDateOnly(date: DateOnly, days: number): DateOnly {
  // Arithmetic in UTC so no zone can shift the calendar result.
  const base = new Date(`${date}T00:00:00Z`);
  return addDays(base, days).toISOString().slice(0, 10);
}

export function daysBetweenDateOnly(from: DateOnly, to: DateOnly): number {
  return differenceInCalendarDays(new Date(`${to}T00:00:00Z`), new Date(`${from}T00:00:00Z`));
}

/** A `Date` suitable for a Prisma `@db.Date` column: midnight UTC on that day. */
export function dateOnlyToPrismaDate(date: DateOnly): Date {
  if (!isDateOnly(date)) throw new RangeError(`Not a calendar date: ${date}`);
  return new Date(`${date}T00:00:00.000Z`);
}

/** Read a Prisma `@db.Date` value back as a calendar date string. */
export function prismaDateToDateOnly(value: Date): DateOnly {
  // A DATE column round-trips as midnight UTC, so UTC extraction is correct here
  // and must NOT be zone-converted -- that would shift the day.
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Wall-clock minutes <-> instants (recurring schedule patterns)
// ---------------------------------------------------------------------------

/** Minutes from local midnight, e.g. 540 for 09:00. */
export type WallClockMinute = number;

export function parseWallClock(value: string): WallClockMinute {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new RangeError(`Not a HH:MM time: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new RangeError(`Not a valid time: ${value}`);
  return hours * 60 + minutes;
}

export function formatWallClock(minute: WallClockMinute): string {
  const clamped = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Turn a pattern (calendar day + local wall-clock minute) into a UTC instant.
 * This is how ScheduleSlot rows become Lesson rows.
 */
export function zonedWallClockToInstant(
  date: DateOnly,
  minute: WallClockMinute,
  zone: TimeZone,
): Date {
  // Build the local naive timestamp then let the zone database resolve the
  // offset, including DST. Adding minutes to midnight would be wrong across a
  // spring-forward boundary.
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  const naive = `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
  return fromZonedTime(naive, zone);
}

/** The local wall-clock minute an instant lands on, in the given zone. */
export function instantToWallClockMinute(instant: Date, zone: TimeZone): WallClockMinute {
  const [hours, minutes] = formatInTimeZone(instant, zone, 'HH:mm').split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** ISO weekday name for an instant in a zone, matching the `Weekday` enum. */
export type WeekdayName =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

const WEEKDAYS: readonly WeekdayName[] = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

export function weekdayOf(date: DateOnly | Date, zone: TimeZone): WeekdayName {
  const instant = typeof date === 'string' ? startOfDayInstant(date, zone) : date;
  const index = Number(formatInTimeZone(instant, zone, 'i')) % 7; // 1=Mon..7=Sun
  return WEEKDAYS[index === 0 ? 0 : index] ?? 'MONDAY';
}

/** Every calendar date in `[from, to]` whose weekday is in `weekdays`. */
export function datesMatchingWeekdays(
  from: DateOnly,
  to: DateOnly,
  weekdays: readonly WeekdayName[],
  zone: TimeZone,
): DateOnly[] {
  const wanted = new Set(weekdays);
  const out: DateOnly[] = [];
  const span = daysBetweenDateOnly(from, to);
  for (let offset = 0; offset <= span; offset += 1) {
    const date = addDaysToDateOnly(from, offset);
    if (wanted.has(weekdayOf(date, zone))) out.push(date);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlap tests (scheduling conflict detection)
// ---------------------------------------------------------------------------

/**
 * Do two half-open intervals overlap? Back-to-back lessons (09:00-10:30 and
 * 10:30-12:00) do NOT overlap, which is why the comparison is strict.
 */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function minuteRangesOverlap(
  aStart: WallClockMinute,
  aEnd: WallClockMinute,
  bStart: WallClockMinute,
  bEnd: WallClockMinute,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Formatting for display
// ---------------------------------------------------------------------------

const LOCALE_TAGS: Record<string, string> = { UZ: 'uz-UZ', RU: 'ru-RU', EN: 'en-GB' };

export function localeTag(locale: string | null | undefined): string {
  return LOCALE_TAGS[(locale ?? 'EN').toUpperCase()] ?? 'en-GB';
}

/** Date in the viewer's zone, e.g. "27 Sep 2026". */
export function formatDate(instant: Date, zone: TimeZone, locale?: string | null): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: zone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(instant);
}

/** Date and time in the viewer's zone, e.g. "27 Sep 2026, 09:00". */
export function formatDateTime(instant: Date, zone: TimeZone, locale?: string | null): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: zone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

/** Time only, e.g. "09:00". */
export function formatTime(instant: Date, zone: TimeZone): string {
  return formatInTimeZone(instant, zone, 'HH:mm');
}

/** ISO-8601 UTC, the only instant format that crosses the wire. */
export function toIso(instant: Date): string {
  return instant.toISOString();
}

// ---------------------------------------------------------------------------
// Small helpers used across services
// ---------------------------------------------------------------------------

export function minutesBetween(from: Date, to: Date): number {
  return differenceInMinutes(to, from);
}

export function isPast(instant: Date, now: Date = new Date()): boolean {
  return isBefore(instant, now);
}

export function isFuture(instant: Date, now: Date = new Date()): boolean {
  return isAfter(instant, now);
}

export function plusMinutes(instant: Date, minutes: number): Date {
  return addMinutes(instant, minutes);
}

/**
 * Age in whole years on a given date. Used for consent rules (a minor's
 * biometric consent must come from a guardian) and for reporting.
 */
export function ageInYears(dateOfBirth: DateOnly, on: DateOnly): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  if (!by || !bm || !bd || !oy || !om || !od) return 0;
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return Math.max(0, age);
}

/** Re-exported so callers need not import date-fns-tz directly. */
export { toZonedTime, fromZonedTime, formatInTimeZone, startOfDay, endOfDay };
