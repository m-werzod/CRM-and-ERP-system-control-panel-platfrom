/**
 * Locale-aware presentation of values that are already correct.
 *
 * This module DELEGATES: money arithmetic and rendering live in `@/lib/money`,
 * timezone arithmetic in `@/lib/dates`. Nothing here re-derives an amount or a
 * calendar day — it only chooses how an already-computed value is spelled for a
 * given language. A second implementation of either is the failure mode this
 * file exists to avoid.
 */

import {
  formatDate as formatDateInZone,
  formatDateTime as formatDateTimeInZone,
  formatTime as formatTimeInZone,
  localeTag,
  minutesBetween,
  type TimeZone,
} from '@/lib/dates';
import { formatMoney, ppmToPercent, type Money } from '@/lib/money';

import { type Locale, type PluralCategory, type PluralForms } from './types';

/**
 * Who is reading, and in which timezone their calendar days fall. Carried
 * together because a date is meaningless without a zone: the same instant is two
 * different days in Tashkent and in London.
 */
export interface FormatContext {
  readonly locale: Locale;
  readonly timeZone: TimeZone;
}

/** BCP-47 tag for a `Locale`. Shared with `@/lib/dates` so the two never drift. */
export function tagFor(locale: Locale): string {
  return localeTag(locale);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Render an amount in the reader's language. The minor-unit -> major-unit
 * conversion and the per-currency decimal count belong to `@/lib/money`; this
 * only supplies the locale.
 */
export function money(
  value: Money,
  locale: Locale,
  options: { withSymbol?: boolean } = {},
): string {
  return formatMoney(value, { locale: tagFor(locale), withSymbol: options.withSymbol ?? true });
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

export function date(instant: Date, ctx: FormatContext): string {
  return formatDateInZone(instant, ctx.timeZone, ctx.locale);
}

export function dateTime(instant: Date, ctx: FormatContext): string {
  return formatDateTimeInZone(instant, ctx.timeZone, ctx.locale);
}

/**
 * Time only. Deliberately locale-independent: every locale this product serves
 * reads a 24-hour clock, and a timetable column must line up character for
 * character.
 */
export function time(instant: Date, ctx: FormatContext): string {
  return formatTimeInZone(instant, ctx.timeZone);
}

// ---------------------------------------------------------------------------
// Numbers and rates
// ---------------------------------------------------------------------------

export function number(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(tagFor(locale), options).format(value);
}

/**
 * Render a parts-per-million rate as a percentage. `ppmToPercent` does the only
 * arithmetic (100_000 ppm -> 10); the extra /100 is because `Intl`'s percent
 * style multiplies its input by 100, so it wants the fraction, not the percent.
 */
export function percentFromPpm(
  ppm: number,
  locale: Locale,
  options: { maximumFractionDigits?: number } = {},
): string {
  const fraction = ppmToPercent(ppm) / 100;
  return new Intl.NumberFormat(tagFor(locale), {
    style: 'percent',
    // ppm carries four decimal places of a percent; showing two is enough for a
    // discount line and keeps a table narrow.
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(fraction);
}

/**
 * "3 days ago", "in 2 hours". Falls back to an absolute date when the runtime's
 * ICU data has no relative-time rules for the locale — a wrong-language date is
 * still true, an invented phrase would not be.
 */
export function relativeTime(instant: Date, ctx: FormatContext, now: Date = new Date()): string {
  const minutes = minutesBetween(now, instant);

  try {
    const rtf = new Intl.RelativeTimeFormat(tagFor(ctx.locale), { numeric: 'auto' });
    const absMinutes = Math.abs(minutes);

    if (absMinutes < 1) return rtf.format(0, 'minute');
    if (absMinutes < 60) return rtf.format(minutes, 'minute');
    if (absMinutes < 60 * 24) return rtf.format(Math.trunc(minutes / 60), 'hour');
    if (absMinutes < 60 * 24 * 30) return rtf.format(Math.trunc(minutes / (60 * 24)), 'day');
    if (absMinutes < 60 * 24 * 365) return rtf.format(Math.trunc(minutes / (60 * 24 * 30)), 'month');
    return rtf.format(Math.trunc(minutes / (60 * 24 * 365)), 'year');
  } catch {
    return date(instant, ctx);
  }
}

// ---------------------------------------------------------------------------
// Plurals
// ---------------------------------------------------------------------------

/**
 * Russian has THREE cardinal forms and the rule is not "1 is special":
 *
 *   1, 21, 31   -> one    (1 студент)
 *   2, 3, 4, 22 -> few    (2 студента)
 *   0, 5..20, 25-> many   (5 студентов)
 *
 * so a `count === 1 ? singular : plural` check — which is correct for English
 * and for Uzbek — produces "5 студента" and "21 студентов". Both are wrong, and
 * both are the kind of wrong a parent notices on an invoice. `Intl.PluralRules`
 * carries the real CLDR rules per locale, so the decision is delegated rather
 * than encoded here.
 */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  const selected = new Intl.PluralRules(tagFor(locale)).select(count);

  // CLDR also defines `zero` and `two` for other languages. None of UZ/RU/EN use
  // them for cardinals, so they collapse onto `other` rather than forcing two
  // dead keys into every dictionary.
  switch (selected) {
    case 'one':
    case 'few':
    case 'many':
      return selected;
    default:
      return 'other';
  }
}

/** Pick the form matching `count`, without interpolating it. */
export function pluralForm(forms: PluralForms, count: number, locale: Locale): string {
  return forms[pluralCategory(locale, count)];
}
