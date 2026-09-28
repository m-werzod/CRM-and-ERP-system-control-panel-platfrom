/**
 * Reading list state out of the URL.
 *
 * The URL is the single source of truth for page, page size, search term and
 * filters: it makes a filtered list shareable, survives a reload, and lets the
 * back button do what the user means. Nothing about a list lives in component
 * state, so a server component can render the right rows on the first pass
 * without a client round-trip.
 *
 * Next passes `searchParams` as a promise whose values are `string | string[]`;
 * these helpers collapse that into the scalars a service input expects, and
 * refuse anything out of range rather than passing it down.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Repeated keys keep their first value: a list takes one page number, not two. */
export function one(params: RawSearchParams, key: string): string | undefined {
  const value = params[key];
  const found = Array.isArray(value) ? value[0] : value;
  const trimmed = found?.trim();
  return trimmed ? trimmed : undefined;
}

/** Every value of a repeated key, for multi-select filters such as status. */
export function many(params: RawSearchParams, key: string): string[] {
  const value = params[key];
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : value.split(',');
  return list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Only values the enum actually contains survive, so a hand-edited URL cannot reach the service. */
export function enumOne<T extends string>(
  params: RawSearchParams,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = one(params, key);
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export function enumMany<T extends string>(
  params: RawSearchParams,
  key: string,
  allowed: readonly T[],
): T[] {
  const allowedSet = new Set<string>(allowed);
  return many(params, key).filter((value): value is T => allowedSet.has(value));
}

export function pageOf(params: RawSearchParams): number {
  const parsed = Number.parseInt(one(params, 'page') ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function pageSizeOf(params: RawSearchParams): number {
  const parsed = Number.parseInt(one(params, 'pageSize') ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function boolOf(params: RawSearchParams, key: string): boolean | undefined {
  const value = one(params, key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function sortDirOf(params: RawSearchParams, fallback: 'asc' | 'desc' = 'desc'): 'asc' | 'desc' {
  return one(params, 'sortDir') === 'asc' ? 'asc' : one(params, 'sortDir') === 'desc' ? 'desc' : fallback;
}

/**
 * True when the user has narrowed the list themselves.
 *
 * Drives which empty state to show: "no students yet, add one" is the wrong
 * message for someone who has just filtered a full list down to nothing, and
 * offering them "Add student" instead of "Clear filters" sends them the wrong way.
 */
export function hasActiveFilters(params: RawSearchParams, keys: readonly string[]): boolean {
  return keys.some((key) => one(params, key) !== undefined || many(params, key).length > 0);
}

export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}
