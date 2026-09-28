/**
 * The type spine of the i18n layer.
 *
 * `Dictionary` is DERIVED from the English dictionary rather than declared by
 * hand. That is the whole reason this layer is hand-rolled instead of reaching
 * for a key-string library: a key added to en.ts becomes a compile error in
 * uz.ts and ru.ts until it is translated, and a stray key in a translation is
 * caught by the excess-property check. A missing translation must fail `tsc`,
 * not show a raw dotted key to a parent.
 *
 * No React, no server imports: these types are consumed by route handlers,
 * services and unit tests alike.
 */

import type { Locale as PrismaLocale } from '@/generated/prisma/client';

import type { en } from './en';

/**
 * Display order, not just membership: the language switcher iterates this, so
 * Uzbek comes first as the default language of the market.
 */
export const LOCALES = ['UZ', 'RU', 'EN'] as const;

export type Locale = (typeof LOCALES)[number];

/** The locale used when nothing better is known. */
export const DEFAULT_LOCALE: Locale = 'UZ';

/**
 * The dictionary keys are ours, but the locale values travel through Prisma's
 * `Locale` column. These two aliases fail to resolve if the enum and this union
 * ever drift apart — cheaper than a runtime guard on every read.
 */
type MutuallyAssignable<A extends B, B> = [A, B] extends [B, A] ? true : never;
export type LocaleCoversPrismaEnum = MutuallyAssignable<Locale, PrismaLocale>;
export type PrismaEnumCoversLocale = MutuallyAssignable<PrismaLocale, Locale>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Every CLDR plural category this codebase writes translations for. Russian
 * genuinely uses one/few/many, so the shape carries all four everywhere and
 * English simply repeats itself — identical key sets are what makes the
 * `Dictionary` check above meaningful.
 */
export interface PluralForms {
  readonly one: string;
  readonly few: string;
  readonly many: string;
  readonly other: string;
}

export type PluralCategory = keyof PluralForms;

/**
 * Drop the string literals from the reference dictionary so a translation is
 * checked on SHAPE only — `uz.ts` must not be forced to repeat English text.
 * Homomorphic mapping preserves the `readonly` modifiers `as const` added.
 */
type WidenStrings<T> = T extends string ? string : { [K in keyof T]: WidenStrings<T[K]> };

/** The reference dictionary's literal type, placeholders and all. */
export type ReferenceDictionary = typeof en;

/** What `uz.ts` and `ru.ts` must satisfy exactly. */
export type Dictionary = WidenStrings<ReferenceDictionary>;

/**
 * Dotted paths to every string leaf. Built from the reference dictionary so an
 * unknown key is a compile error at the call site.
 */
export type DottedKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : DottedKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = DottedKeys<ReferenceDictionary>;

/** Dotted paths to plural GROUPS rather than to their individual forms. */
export type PluralDottedKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends PluralForms
      ? `${Prefix}${K}`
      : PluralDottedKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type PluralKey = PluralDottedKeys<ReferenceDictionary>;

/** The literal type sitting at a dotted path. */
export type ValueAtPath<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ValueAtPath<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Placeholder names appearing in a literal message, e.g. `'Due in {days}'` ->
 * `'days'`. Only possible because en.ts is `as const`; this is what lets `t()`
 * demand exactly the values a message actually interpolates.
 */
export type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

export type PlaceholderValue = string | number;

export type PlaceholderValues<S extends string> = Record<PlaceholderNames<S>, PlaceholderValue>;

/**
 * `t()`'s trailing parameter: forbidden when the message has no placeholders,
 * required (and exhaustive) when it has. `[never]` rather than a bare
 * conditional because a naked `never extends never` distributes and collapses
 * to both branches.
 */
export type InterpolationArgs<K extends TranslationKey> = [
  PlaceholderNames<Extract<ValueAtPath<ReferenceDictionary, K>, string>>,
] extends [never]
  ? []
  : [values: PlaceholderValues<Extract<ValueAtPath<ReferenceDictionary, K>, string>>];

/**
 * Keys whose message interpolates nothing, so `t(key)` needs no second argument.
 *
 * Required wherever a key is held in a VARIABLE rather than written literally.
 * `InterpolationArgs<TranslationKey>` collapses to the union of every
 * placeholder name in the dictionary, which is not empty, so the whole key type
 * makes the values argument mandatory. Narrowing to this set keeps such a call
 * site argument-free -- and, more usefully, refuses to accept a key that does
 * need values where none can be supplied.
 */
export type PlainTranslationKey = {
  [K in TranslationKey]: InterpolationArgs<K> extends [] ? K : never;
}[TranslationKey];

/**
 * A plural message always receives `count`; any other placeholder in its forms
 * must be supplied alongside.
 */
export type PluralInterpolationArgs<K extends PluralKey> = [
  Exclude<
    PlaceholderNames<Extract<ValueAtPath<ReferenceDictionary, `${K}.other`>, string>>,
    'count'
  >,
] extends [never]
  ? []
  : [
      values: Record<
        Exclude<
          PlaceholderNames<Extract<ValueAtPath<ReferenceDictionary, `${K}.other`>, string>>,
          'count'
        >,
        PlaceholderValue
      >,
    ];
