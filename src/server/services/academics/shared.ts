/**
 * Internal helpers shared by the academics use-cases.
 *
 * Two things live here rather than being repeated five times: the translation of a
 * database constraint violation into something an operator can act on, and the
 * page arithmetic.
 *
 * The constraint helpers exist because this domain deliberately leans on PARTIAL
 * UNIQUE INDEXES for its invariants -- one open teacher assignment per
 * (group, role), one default grading scale per organisation. An application-level
 * "check then write" cannot survive two concurrent requests, so the database is the
 * authority and the service's job is to turn `group_teachers_one_open_per_group_role`
 * into a sentence. `mapDatabaseError` would otherwise report the generic
 * "a record with the same value already exists", which tells the operator nothing
 * about which rule they hit.
 */

import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';

interface DatabaseErrorShape {
  readonly code?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * The index or column list the database named, lower-cased. Prisma reports
 * `meta.target` as a field array for a model-level `@@unique` and as the index name
 * for one created in raw SQL, so both shapes are flattened to a searchable string.
 */
export function constraintTarget(error: unknown): string {
  const target = (error as DatabaseErrorShape | null)?.meta?.['target'];
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.toLowerCase();
}

/**
 * True for a unique violation, whichever layer reported it: P2002 from Prisma,
 * SQLSTATE 23505 when the driver adapter surfaces it raw. `constraintHint` narrows
 * the match to one index so a use-case that can provoke two different violations
 * can tell them apart.
 */
export function isUniqueViolation(error: unknown, constraintHint?: string): boolean {
  const code = (error as DatabaseErrorShape | null)?.code;
  if (code !== 'P2002' && code !== '23505') return false;
  if (!constraintHint) return true;
  return constraintTarget(error).includes(constraintHint.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * A page of rows plus the figures a client needs to render a pager. The
 * `PageMeta`/`toSkipTake` helpers in `@/server/http/api` do the same arithmetic, but
 * importing them here would pull `next/server` into every service and into the unit
 * tests; the HTTP layer wraps this with `pageMeta(page, pageSize, total)`.
 */
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export function toPage(input: PageInput): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  // Capped with the same constant the request schemas use, so a caller that reaches
  // a service directly (a job, another service) cannot ask for ten thousand rows.
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** A teacher's name lives two relations away: Teacher -> Employee -> User. */
export interface TeacherNameRow {
  readonly employee: {
    readonly user: { readonly firstName: string; readonly lastName: string };
  };
}

export function teacherDisplayName(teacher: TeacherNameRow): string;
export function teacherDisplayName(teacher: TeacherNameRow | null | undefined): string | null;
export function teacherDisplayName(teacher: TeacherNameRow | null | undefined): string | null {
  if (!teacher) return null;
  return `${teacher.employee.user.firstName} ${teacher.employee.user.lastName}`;
}
