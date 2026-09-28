import { describe, expect, it } from 'vitest';
import type { Dictionary } from '@/lib/i18n/types';

import {
  LOCALES,
  createTranslator,
  en,
  getDictionary,
  isLocale,
  localeFromAcceptLanguage,
  localeOptions,
  money as formatMoneyIn,
  percentFromPpm,
  pluralCategory,
  resolveLocale,
  ru,
  t,
  tPlural,
  uz,
} from '@/lib/i18n';
import { date, dateTime, number, relativeTime, time } from '@/lib/i18n/format';
import { money } from '@/lib/money';
import type { Locale } from '@/lib/i18n';

/**
 * Collect every dotted path to a string leaf, so the three dictionaries can be
 * compared as sets. The `Dictionary` type already forces this at compile time;
 * asserting it at runtime too catches the one case types cannot -- a dictionary
 * reaching production through a path that skipped `tsc`.
 */
function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string') return [prefix];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    leafPaths(value, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('dictionary shape', () => {
  const enPaths = leafPaths(en).sort();

  it('covers a non-trivial surface', () => {
    // Guards against a refactor that accidentally empties a dictionary and makes
    // every set-equality assertion below pass vacuously.
    expect(enPaths.length).toBeGreaterThan(800);
  });

  it.each([
    ['uz', uz],
    ['ru', ru],
  ])('%s has exactly the English key set', (_name, dictionary) => {
    const paths = leafPaths(dictionary).sort();
    expect(paths).toEqual(enPaths);
  });

  it.each([
    ['uz', uz],
    ['ru', ru],
  ])('%s leaves no value blank', (_name, dictionary) => {
    const blanks = leafPaths(dictionary).filter((path) => t(dictionary, path as never).trim() === '');
    expect(blanks).toEqual([]);
  });

  it('labels every member of an enum in every locale', () => {
    // The enum block is the part most likely to drift, because members are added
    // to the Prisma schema rather than to this file.
    for (const locale of LOCALES) {
      const dictionary = getDictionary(locale);
      for (const [enumName, members] of Object.entries(en.enums)) {
        const translated = dictionary.enums[enumName as keyof typeof en.enums];
        expect(Object.keys(translated).sort()).toEqual(Object.keys(members).sort());
      }
    }
  });

  it('exposes each language under its own name', () => {
    expect(localeOptions()).toEqual([
      { value: 'UZ', label: "O'zbekcha" },
      { value: 'RU', label: 'Русский' },
      { value: 'EN', label: 'English' },
    ]);
  });
});

describe('t', () => {
  it('reads a nested key', () => {
    expect(t(en, 'students.title')).toBe('Students');
    expect(t(ru, 'students.title')).toBe('Студенты');
    expect(t(uz, 'nav.attendance')).toBe('Davomat');
  });

  it('interpolates named placeholders', () => {
    expect(t(en, 'common.pageOf', { page: 2, pages: 7 })).toBe('Page 2 of 7');
    expect(t(ru, 'common.pageOf', { page: 2, pages: 7 })).toBe('Страница 2 из 7');
  });

  it('interpolates the same placeholder set in every locale', () => {
    const values = { present: 8, absent: 1, late: 2, excused: 0 };
    for (const locale of LOCALES) {
      const rendered = t(getDictionary(locale), 'attendance.summary', values);
      expect(rendered).not.toMatch(/[{}]/);
      expect(rendered).toContain('8');
    }
  });

  it('leaves an unsupplied placeholder visible rather than blanking it', () => {
    // A half-rendered string is a bug report; "Due in " would pass review.
    const rendered = t(en, 'invoices.dueIn', { days: undefined as unknown as string });
    expect(rendered).toBe('Due in {days}');
  });

  it('returns the key when a path is missing', () => {
    expect(t(en, 'students.doesNotExist' as never)).toBe('students.doesNotExist');
  });

  it('does not treat an object node as a message', () => {
    expect(t(en, 'students.fields' as never)).toBe('students.fields');
  });
});

describe('Russian pluralisation', () => {
  // The cases that a `count === 1 ? one : other` check gets wrong.
  it.each([
    [1, 'one'],
    [2, 'few'],
    [5, 'many'],
    [21, 'one'],
    [25, 'many'],
  ])('selects the right category for %i', (count, expected) => {
    expect(pluralCategory('RU', count)).toBe(expected);
  });

  it.each([
    [1, '1 студент'],
    [2, '2 студента'],
    [5, '5 студентов'],
    [21, '21 студент'],
    [25, '25 студентов'],
  ])('renders %i correctly', (count, expected) => {
    expect(tPlural(ru, 'common.plurals.students', count, 'RU')).toBe(expected);
  });

  it('differs from the naive singular/plural split', () => {
    const naive = (count: number) =>
      count === 1 ? ru.common.plurals.students.one : ru.common.plurals.students.other;
    // 5 and 21 are exactly where the naive rule produces "5 студента" and
    // "21 студента"; if these ever agreed, the plural layer would be pointless.
    expect(tPlural(ru, 'common.plurals.students', 5, 'RU')).not.toBe(naive(5));
    expect(tPlural(ru, 'common.plurals.students', 21, 'RU')).not.toBe(naive(21));
  });

  it('uses one/other for English and Uzbek', () => {
    expect(pluralCategory('EN', 1)).toBe('one');
    expect(pluralCategory('EN', 5)).toBe('other');
    expect(pluralCategory('UZ', 1)).toBe('one');
    expect(pluralCategory('UZ', 5)).toBe('other');
    expect(tPlural(en, 'common.plurals.lessons', 1, 'EN')).toBe('1 lesson');
    expect(tPlural(en, 'common.plurals.lessons', 3, 'EN')).toBe('3 lessons');
  });

  it('returns the key for a path that is not a plural group', () => {
    expect(tPlural(en, 'students.title' as never, 1, 'EN')).toBe('students.title');
  });
});

describe('percent formatting', () => {
  it('renders parts-per-million as a percentage', () => {
    // 100_000 ppm is 10%, which is the conversion the finance layer relies on.
    expect(percentFromPpm(100_000, 'EN')).toBe('10%');
    expect(percentFromPpm(1_000_000, 'EN')).toBe('100%');
    expect(percentFromPpm(0, 'EN')).toBe('0%');
  });

  it('keeps fractional percentages exact', () => {
    expect(percentFromPpm(125_000, 'EN')).toBe('12.5%');
    expect(percentFromPpm(5_000, 'EN')).toBe('0.5%');
  });

  it('respects the locale separator', () => {
    // Russian uses a comma for decimals; the digits must not change.
    const rendered = percentFromPpm(125_000, 'RU');
    expect(rendered.replace(/[\s ]/g, '')).toMatch(/^12[.,]5%$/);
  });
});

describe('money formatting', () => {
  it('shows UZS without decimals', () => {
    // UZS is stored in tiyin but quoted in whole som, which @/lib/money decides;
    // this only asserts the delegation still holds.
    const rendered = formatMoneyIn(money(150_000_000n, 'UZS'), 'UZ');
    expect(rendered.replace(/[\s ]/g, '')).toContain('1500000');
    expect(rendered).not.toMatch(/[.,]00/);
  });

  it('shows USD with two decimals', () => {
    const rendered = formatMoneyIn(money(150_025n, 'USD'), 'EN');
    expect(rendered.replace(/[\s ]/g, '')).toMatch(/1,500\.25|1500\.25/);
  });

  it('can omit the currency symbol', () => {
    const rendered = formatMoneyIn(money(100_000n, 'UZS'), 'RU', { withSymbol: false });
    expect(rendered).not.toContain('UZS');
  });

  it('formats a negative amount without losing the sign', () => {
    expect(formatMoneyIn(money(-50_000n, 'UZS'), 'EN')).toMatch(/-|−|\(/);
  });
});

describe('date and number formatting', () => {
  const instant = new Date('2026-09-27T04:30:00.000Z');
  const tashkent = 'Asia/Tashkent';

  it('renders a calendar day in the given zone', () => {
    // 04:30 UTC is 09:30 in Tashkent on the same day.
    expect(date(instant, { locale: 'EN', timeZone: tashkent })).toContain('2026');
    expect(time(instant, { locale: 'EN', timeZone: tashkent })).toBe('09:30');
  });

  it('shifts the day when the zone shifts it', () => {
    const lateInstant = new Date('2026-09-27T20:00:00.000Z');
    // 20:00 UTC is already the 28th in Tashkent (UTC+5).
    expect(time(lateInstant, { locale: 'EN', timeZone: tashkent })).toBe('01:00');
    expect(dateTime(lateInstant, { locale: 'EN', timeZone: tashkent })).toContain('28');
  });

  it('groups numbers per locale', () => {
    expect(number(1_500_000, 'EN').replace(/[\s ]/g, '')).toBe('1,500,000');
    expect(number(1_500_000, 'RU').replace(/[\s ]/g, '')).toBe('1500000');
  });

  it('describes a past instant relatively', () => {
    const now = new Date('2026-09-30T04:30:00.000Z');
    const rendered = relativeTime(instant, { locale: 'EN', timeZone: tashkent }, now);
    expect(rendered).toMatch(/3 days ago/);
  });
});

describe('resolveLocale', () => {
  it('prefers the user setting over everything else', () => {
    expect(resolveLocale('RU', 'UZ', 'en-GB,en;q=0.9')).toBe('RU');
  });

  it('falls back to the organization default', () => {
    expect(resolveLocale(null, 'RU', 'en-GB')).toBe('RU');
  });

  it('falls back to the Accept-Language header', () => {
    expect(resolveLocale(null, null, 'ru-RU,ru;q=0.9,en;q=0.8')).toBe('RU');
    expect(resolveLocale(null, null, 'en-US,en;q=0.9')).toBe('EN');
  });

  it('honours quality values rather than header order', () => {
    expect(resolveLocale(null, null, 'en;q=0.3,ru;q=0.9')).toBe('RU');
  });

  it('skips languages it has no dictionary for', () => {
    expect(resolveLocale(null, null, 'de-DE,de;q=0.9,ru;q=0.5')).toBe('RU');
  });

  it('defaults to Uzbek when nothing is known', () => {
    expect(resolveLocale(null, null, null)).toBe('UZ');
    expect(resolveLocale(undefined, undefined, undefined)).toBe('UZ');
    expect(resolveLocale('', '', '*')).toBe('UZ');
  });

  it('ignores an unrecognised locale string', () => {
    // A stale value in a cookie or a column must not produce an undefined dictionary.
    expect(resolveLocale('KLINGON', null, null)).toBe('UZ');
  });

  it('parses Accept-Language on its own', () => {
    expect(localeFromAcceptLanguage('uz-Latn-UZ,uz;q=0.9')).toBe('UZ');
    expect(localeFromAcceptLanguage('')).toBeUndefined();
    expect(localeFromAcceptLanguage(null)).toBeUndefined();
    expect(localeFromAcceptLanguage('de')).toBeUndefined();
  });

  it('narrows unknown values with isLocale', () => {
    expect(isLocale('UZ')).toBe(true);
    expect(isLocale('uz')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(7)).toBe(false);
  });
});

describe('createTranslator', () => {
  it('binds a locale and a timezone', () => {
    const tr = createTranslator('RU', 'Asia/Tashkent');
    expect(tr.locale).toBe('RU');
    expect(tr.timeZone).toBe('Asia/Tashkent');
    expect(tr.t('common.save')).toBe('Сохранить');
    expect(tr.t('common.pageOf', { page: 1, pages: 3 })).toBe('Страница 1 из 3');
  });

  it('pluralises through the bound locale', () => {
    const tr = createTranslator('RU', 'Asia/Tashkent');
    expect(tr.plural('common.plurals.days', 2)).toBe('2 дня');
    expect(tr.plural('common.plurals.days', 7)).toBe('7 дней');
  });

  it('resolves a dictionary for every locale', () => {
    for (const locale of LOCALES satisfies readonly Locale[]) {
      expect(getDictionary(locale).common.save.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Compile-time guarantees.
 *
 * The main reason this i18n layer is hand-rolled rather than key-string based is
 * that a missing translation or a typo'd key should fail the BUILD, not surface as
 * "undefined" on a screen in production. `@ts-expect-error` asserts that: each one
 * fails the typecheck if the error it expects stops being reported, so the
 * guarantee cannot quietly erode.
 */
describe('type-level guarantees', () => {
  it('rejects an unknown dotted key', () => {
    // @ts-expect-error — 'students.definitelyNotAKey' is not in the dictionary
    expect(() => t(en, 'students.definitelyNotAKey')).toBeTypeOf('function');
  });

  it('rejects a dictionary missing a section', () => {
    // @ts-expect-error — a Dictionary needs every section, not just `common`
    const incomplete: Dictionary = { common: en.common };
    expect(incomplete).toBeTruthy();
  });

  it('rejects a dictionary carrying an unknown key', () => {
    // @ts-expect-error — `bogusKey` is not part of the reference dictionary
    const extended: Dictionary = { ...ru, common: { ...ru.common, bogusKey: 'x' } };
    expect(extended).toBeTruthy();
  });

  it('rejects a dictionary missing a single leaf', () => {
    const { save: _omitted, ...commonWithoutSave } = uz.common;
    // @ts-expect-error — `common.save` is required
    const missingLeaf: Dictionary = { ...uz, common: commonWithoutSave };
    expect(missingLeaf).toBeTruthy();
  });
});
