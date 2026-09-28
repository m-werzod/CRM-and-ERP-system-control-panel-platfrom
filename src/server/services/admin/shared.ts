/**
 * Internal plumbing shared by the administration use-cases.
 *
 * The important thing here is `loadAdministrableUser`. Every write in `users.ts`
 * and every grant in `roles.ts` goes through it, because "may this caller touch
 * that account" is one security decision and a second implementation of it is a
 * second chance to get privilege escalation wrong. It does three things in one
 * step that must not be split: it scopes the lookup to the caller's
 * organisation, it computes the target's effective privilege level, and it
 * refuses when that level is at or above the caller's own.
 *
 * Nothing here is re-exported from the barrel: these are seams between the admin
 * services, not part of the surface the HTTP layer calls.
 */

import type { Prisma, UserStatus } from '@/generated/prisma/client';
import type { Db } from '@/server/db/client';
import { NotFoundError } from '@/server/errors';
import {
  assertCanAdministerUser,
  organizationFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * Page arithmetic, capped with the same constant the request schemas use so a
 * caller reaching a service directly (a job, another service) cannot ask for ten
 * thousand rows.
 */
export function toPage(input: PageInput): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// ---------------------------------------------------------------------------
// Constraint violations
// ---------------------------------------------------------------------------

interface DatabaseErrorShape {
  readonly code?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * The index or column list the database named, lower-cased. Prisma reports
 * `meta.target` as a field array for a model-level `@@unique` and as the index
 * name for one created in raw SQL, so both shapes are flattened to a searchable
 * string.
 */
export function constraintTarget(error: unknown): string {
  const target = (error as DatabaseErrorShape | null)?.meta?.['target'];
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.toLowerCase();
}

export function isUniqueViolation(error: unknown, constraintHint?: string): boolean {
  const code = (error as DatabaseErrorShape | null)?.code;
  if (code !== 'P2002' && code !== '23505') return false;
  if (!constraintHint) return true;
  return constraintTarget(error).includes(constraintHint.toLowerCase());
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function userDisplayName(user: {
  firstName: string;
  lastName: string;
}): string {
  return `${user.firstName} ${user.lastName}`.trim();
}

/** The columns every admin write needs about the account it is touching. */
export const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  phone: true,
  status: true,
  locale: true,
  timezone: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  userRoles: {
    select: {
      id: true,
      branchId: true,
      expiresAt: true,
      role: { select: { id: true, key: true, name: true, level: true, scope: true, deletedAt: true } },
    },
  },
  userBranches: { select: { branchId: true, isPrimary: true } },
} as const satisfies Prisma.UserSelect;

export interface AdministrableUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly status: UserStatus;
  /** Highest level across the target's live role grants; 0 when they hold none. */
  readonly highestRoleLevel: number;
  readonly roleIds: readonly string[];
  readonly branchIds: readonly string[];
}

/**
 * Load a user for administration, with the tenancy predicate in the SAME query
 * and the escalation guard applied before the caller can act.
 *
 * Two deliberate choices:
 *
 *   NotFound, not OutOfScope, on a miss. User ids appear in URLs, and answering
 *   "that account exists but belongs to another organisation" is an existence
 *   oracle across tenants.
 *
 *   EXPIRED grants are ignored when computing the level, exactly as
 *   `buildAccessContext` ignores them when computing authority. The two numbers
 *   have to mean the same thing: if an expired SUPER_ADMIN grant still counted
 *   here, an account with no remaining power would be permanently
 *   unadministerable by anyone below that level.
 */
export async function loadAdministrableUser(
  ctx: AccessContext,
  db: Db,
  userId: string,
): Promise<AdministrableUser> {
  const now = new Date();
  const user = await db.user.findFirst({
    where: { id: userId, ...organizationFilter(ctx), deletedAt: null },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      userRoles: {
        select: { roleId: true, expiresAt: true, role: { select: { level: true, deletedAt: true } } },
      },
      userBranches: { select: { branchId: true } },
    },
  });
  if (!user) throw new NotFoundError('User', userId);

  const live = user.userRoles.filter(
    (grant) => !grant.role.deletedAt && (grant.expiresAt === null || grant.expiresAt > now),
  );
  const target = {
    id: user.id,
    highestRoleLevel: live.reduce((max, grant) => Math.max(max, grant.role.level), 0),
  };

  // The guard, before any caller has a chance to write: never edit a peer or a
  // superior, and never anybody at all in another organisation.
  assertCanAdministerUser(ctx, target);

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    status: user.status,
    highestRoleLevel: target.highestRoleLevel,
    roleIds: [...new Set(live.map((grant) => grant.roleId))],
    branchIds: user.userBranches.map((row) => row.branchId),
  };
}

/**
 * Load a role for a grant or an edit, scoped to the organisation.
 *
 * Does NOT itself call `assertCanGrantRole` — the callers do, because some of
 * them (listing, reading) legitimately need a role they may not grant.
 */
export async function loadRole(
  ctx: AccessContext,
  db: Db,
  roleId: string,
): Promise<{
  id: string;
  key: string;
  name: string;
  level: number;
  isSystem: boolean;
  scope: 'ORGANIZATION' | 'BRANCH' | 'SELF';
}> {
  const role = await db.role.findFirst({
    where: { id: roleId, ...organizationFilter(ctx), deletedAt: null },
    select: { id: true, key: true, name: true, level: true, isSystem: true, scope: true },
  });
  if (!role) throw new NotFoundError('Role', roleId);
  return role;
}
