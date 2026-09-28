/**
 * Internal helpers shared by the assessment use-cases.
 *
 * The page arithmetic is repeated here rather than imported from
 * `@/server/http/api`, because that module imports `next/server`; pulling the HTTP
 * layer into a service would put a request/response type into every unit test and
 * every background job that grades an exam. The HTTP layer wraps what these return
 * with `pageMeta(page, pageSize, total)`.
 *
 * The scope helpers exist because "which assessment rows may this caller read"
 * differs by role in a way `scopeFilter` alone cannot express: a teacher sees their
 * own classes, a student their own grades, a parent their children's. Each is
 * returned as a WHERE fragment so it is applied in SQL, never as a UI filter.
 */

import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';
import {
  can,
  isSelfScoped,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PagedResult<T> {
  readonly rows: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export function toPage(input: PageInput): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  // Capped with the same constant the request schemas use, so a caller reaching a
  // service directly (a job, another service) cannot ask for ten thousand rows.
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Matches nothing. Returned for a SELF-scoped caller with no identity link, so the
 * query is fail-closed rather than unfiltered.
 */
export const MATCHES_NOTHING: Record<string, unknown> = { id: { in: [] as string[] } };

/**
 * Narrowing for rows that hang off a `groupId` -- exams, homework, grades.
 *
 * `grades.viewAll` is the module escape hatch: a head of studies holds it and sees
 * every class, a teacher does not and sees the groups they are assigned to. A
 * student or parent is narrowed to groups the student is (or was) enrolled in, so a
 * published result stays visible after the course ends.
 */
export function groupScopeFilter(
  ctx: AccessContext,
  options: { readonly escapeHatch?: string } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...scopeFilter(ctx) };
  const escapeHatch = options.escapeHatch ?? 'grades.viewAll';

  if (!isSelfScoped(ctx) || can(ctx, escapeHatch)) return base;

  const { teacherId, studentId, guardianId } = ctx.self;

  if (teacherId) {
    return {
      AND: [
        base,
        {
          OR: [
            { teacherId },
            { group: { teacherAssignments: { some: { teacherId, endDate: null } } } },
          ],
        },
      ],
    };
  }
  if (studentId) {
    return { AND: [base, { group: { enrollments: { some: { studentId } } } }] };
  }
  if (guardianId) {
    return {
      AND: [
        base,
        { group: { enrollments: { some: { student: { guardians: { some: { guardianId } } } } } } },
      ],
    };
  }
  return { AND: [base, MATCHES_NOTHING] };
}

/**
 * Narrowing for rows keyed by `studentId` (Grade, HomeworkSubmission, Certificate)
 * on models that carry no branch column of their own.
 */
export function studentScopeFilter(
  ctx: AccessContext,
  options: { readonly escapeHatch?: string } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = { organizationId: ctx.organizationId };
  const escapeHatch = options.escapeHatch ?? 'grades.viewAll';

  if (ctx.scope === 'BRANCH') {
    // Reached through the student, because Grade has no branchId.
    Object.assign(base, { student: { branchId: { in: [...ctx.branchIds] } } });
  }

  if (!isSelfScoped(ctx) || can(ctx, escapeHatch)) return base;

  const { teacherId, studentId, guardianId } = ctx.self;

  if (studentId) return { AND: [base, { studentId }] };
  if (guardianId) {
    return { AND: [base, { student: { guardians: { some: { guardianId } } } }] };
  }
  if (teacherId) {
    return {
      AND: [
        base,
        {
          student: {
            enrollments: {
              some: {
                group: { teacherAssignments: { some: { teacherId, endDate: null } } },
              },
            },
          },
        },
      ],
    };
  }
  return { AND: [base, MATCHES_NOTHING] };
}

/**
 * Normalise a set of weights given in parts-per-million.
 *
 * Weights are integers that an operator types per assessment, so they do NOT
 * reliably sum to 1_000_000 -- a term with three exams weighted 300_000 each sums
 * to 900_000, and one where somebody typed 500_000 twice sums to 1_500_000.
 * Rescaling by the actual total is what makes the average mean "these assessments
 * in these proportions" in both cases. A set with no positive weight falls back to
 * equal weighting, because an unweighted average is the honest reading of "nobody
 * said how much these count for".
 */
export function weightedAverage(
  entries: ReadonlyArray<{ readonly value: number; readonly weightPpm: number }>,
): number | null {
  if (entries.length === 0) return null;

  const totalWeight = entries.reduce((sum, entry) => sum + Math.max(0, entry.weightPpm), 0);
  if (totalWeight <= 0) {
    return entries.reduce((sum, entry) => sum + entry.value, 0) / entries.length;
  }

  const weighted = entries.reduce(
    (sum, entry) => sum + entry.value * Math.max(0, entry.weightPpm),
    0,
  );
  return weighted / totalWeight;
}
