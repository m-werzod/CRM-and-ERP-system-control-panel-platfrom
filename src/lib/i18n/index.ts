/**
 * The i18n entry point: pick a dictionary, read a key, interpolate.
 *
 * Deliberately free of React so a service, a route handler, a PDF renderer and a
 * unit test all translate through the same code path. The UI layer wraps this in
 * a context; it does not get its own copy.
 *
 * Dictionaries are imported statically rather than lazily. All three together
 * are a few tens of kilobytes of string data, and a synchronous `getDictionary`
 * is what lets a service format an SMS body without becoming async.
 */

import { pluralForm, type FormatContext } from './format';
import { en } from './en';
import { ru } from './ru';
import type {
  Dictionary,
  InterpolationArgs,
  Locale,
  PlaceholderValue,
  PluralForms,
  PluralInterpolationArgs,
  PluralKey,
  TranslationKey,
} from './types';
import { DEFAULT_LOCALE, LOCALES, isLocale } from './types';
import { uz } from './uz';

export type {
  Dictionary,
  DottedKeys,
  Locale,
  PlainTranslationKey,
  PluralCategory,
  PluralForms,
  PluralKey,
  ReferenceDictionary,
  TranslationKey,
} from './types';
export { DEFAULT_LOCALE, LOCALES, isLocale } from './types';
export type { FormatContext } from './format';
export {
  date,
  dateTime,
  money,
  number,
  percentFromPpm,
  pluralCategory,
  pluralForm,
  relativeTime,
  tagFor,
  time,
} from './format';
export { en } from './en';
export { ru } from './ru';
export { uz } from './uz';

const DICTIONARIES: Record<Locale, Dictionary> = { UZ: uz, RU: ru, EN: en };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

// ---------------------------------------------------------------------------
// Key access
// ---------------------------------------------------------------------------

/**
 * Walk a dotted path. Typed callers cannot miss, but a dictionary can also
 * arrive from a runtime source (a stored message template, an imported override)
 * so the walk stays defensive.
 */
function readPath(dict: Dictionary, key: string): unknown {
  let node: unknown = dict;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Substitute `{name}` placeholders. An unsupplied placeholder is left in the
 * text rather than blanked: "Due in {days}" reaching a screen is a visible bug
 * report, whereas "Due in " reads like finished copy and survives review.
 */
function interpolate(template: string, values: Record<string, PlaceholderValue> | undefined): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

export function t<K extends TranslationKey>(
  dict: Dictionary,
  key: K,
  ...args: InterpolationArgs<K>
): string;
export function t(
  dict: Dictionary,
  key: string,
  values?: Record<string, PlaceholderValue>,
): string {
  const value = readPath(dict, key);
  // Returning the key is the honest failure: it is obviously not copy, it names
  // exactly what is missing, and it never silently renders an empty label.
  if (typeof value !== 'string') return key;
  return interpolate(value, values);
}

function isPluralForms(value: unknown): value is PluralForms {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PluralForms>;
  return (
    typeof candidate.one === 'string' &&
    typeof candidate.few === 'string' &&
    typeof candidate.many === 'string' &&
    typeof candidate.other === 'string'
  );
}

/**
 * Count-aware lookup. `count` is always available to the message as
 * `{count}`, so a plural form never has to be passed its own number twice.
 */
export function tPlural<K extends PluralKey>(
  dict: Dictionary,
  key: K,
  count: number,
  locale: Locale,
  ...args: PluralInterpolationArgs<K>
): string;
export function tPlural(
  dict: Dictionary,
  key: string,
  count: number,
  locale: Locale,
  values?: Record<string, PlaceholderValue>,
): string {
  const group = readPath(dict, key);
  if (!isPluralForms(group)) return key;
  return interpolate(pluralForm(group, count, locale), { count, ...values });
}

/**
 * A dictionary bound to one locale, so call sites stop threading both around.
 */
export interface Translator extends FormatContext {
  readonly dictionary: Dictionary;
  t<K extends TranslationKey>(key: K, ...args: InterpolationArgs<K>): string;
  plural<K extends PluralKey>(key: K, count: number, ...args: PluralInterpolationArgs<K>): string;
}

export function createTranslator(locale: Locale, timeZone: string): Translator {
  const dictionary = getDictionary(locale);
  return {
    locale,
    timeZone,
    dictionary,
    t: (key, ...args) => t(dictionary, key, ...args),
    plural: (key, count, ...args) => tPlural(dictionary, key, count, locale, ...args),
  };
}

// ---------------------------------------------------------------------------
// Choosing a locale
// ---------------------------------------------------------------------------

/** Language subtags we recognise, including the scripts Uzbek is written in. */
const SUBTAG_TO_LOCALE: Record<string, Locale> = {
  uz: 'UZ',
  ru: 'RU',
  en: 'EN',
  // Karakalpak and Tajik speakers in the region overwhelmingly read Russian
  // administrative text; offering Uzbek Cyrillic we do not have would be worse.
  kaa: 'RU',
  tg: 'RU',
};

/**
 * Parse an `Accept-Language` header into the best locale we actually have.
 * Quality values are honoured because browsers use them to express a real
 * preference order, and `*` is ignored rather than treated as a match.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;

  const candidates = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((c) => c.tag !== '' && c.tag !== '*' && c.q > 0)
    // A stable sort keeps header order among equal q values, which is the order
    // the browser meant.
    .sort((a, b) => b.q - a.q);

  for (const candidate of candidates) {
    const primary = candidate.tag.split('-')[0] ?? '';
    const matched = SUBTAG_TO_LOCALE[primary];
    if (matched) return matched;
  }
  return undefined;
}

/**
 * Resolve the language to render in.
 *
 * Precedence is user choice, then the organization default, then what the
 * browser asked for, then Uzbek. The user's own setting outranks the header
 * because a Russian-speaking administrator on a borrowed English laptop should
 * not have the interface change under them.
 */
export function resolveLocale(
  userLocale?: string | null,
  orgLocale?: string | null,
  acceptLanguageHeader?: string | null,
): Locale {
  if (isLocale(userLocale)) return userLocale;
  if (isLocale(orgLocale)) return orgLocale;
  return localeFromAcceptLanguage(acceptLanguageHeader) ?? DEFAULT_LOCALE;
}

/** Native names for a language switcher, in `LOCALES` order. */
export function localeOptions(): readonly { readonly value: Locale; readonly label: string }[] {
  return LOCALES.map((value) => ({ value, label: DICTIONARIES[value].enums.Locale[value] }));
}
