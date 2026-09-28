/**
 * AccessContext: the resolved authority of the current caller.
 *
 * Built ONCE per request from the session (see src/server/auth/context.ts) and
 * then threaded through every service call. Nothing below the HTTP layer reads
 * cookies or looks up roles again -- a service receives an AccessContext and can
 * only do what it permits.
 *
 * The two axes are enforced by different mechanisms, deliberately:
 *
 *   PERMISSIONS  checked imperatively at the top of each use-case with
 *                `requirePermission(ctx, 'payments.refund')`. Fails closed.
 *
 *   SCOPE        applied declaratively as a WHERE fragment via
 *                `scopeFilter(ctx)`. It is a filter, not a check, because a LIST
 *                endpoint must return the caller's subset rather than 403, and
 *                because "forgot to filter" is the failure mode that leaks other
 *                branches' data. Every list query composes this fragment.
 *
 * `organizationId` is applied on top of scope, always, by the same fragment.
 * There is no code path that reads rows without an organisation predicate.
 */

import { ForbiddenError, OutOfScopeError, PermissionDeniedError } from '@/server/errors';
import { isKnownPermission, type PermissionKey } from '@/server/rbac/permissions';

export type AccessScope = 'ORGANIZATION' | 'BRANCH' | 'SELF';

/** Identity links that give a SELF-scoped user their subset of the data. */
export interface SelfLinks {
  /** Set when the user is a teacher; gates attendance, grades, homework. */
  readonly teacherId: string | null;
  /** Set when the user is an employee; gates leave and own staff attendance. */
  readonly employeeId: string | null;
  /** Set for a student portal account. */
  readonly studentId: string | null;
  /** Set for a parent portal account. */
  readonly guardianId: string | null;
}

export interface AccessContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;

  /** Union of every permission across the user's roles. */
  readonly permissions: ReadonlySet<string>;
  /** Widest scope across the user's roles. */
  readonly scope: AccessScope;
  /** Highest role level; gates who may grant which roles. */
  readonly roleLevel: number;
  readonly roleKeys: readonly string[];

  /**
   * Branches the caller may touch. Empty when scope is ORGANIZATION, in which
   * case no branch predicate is applied at all.
   */
  readonly branchIds: readonly string[];
  readonly primaryBranchId: string | null;

  readonly self: SelfLinks;

  /** Correlates audit rows, logs and jobs produced by this request. */
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly sessionId: string | null;

  /**
   * True for job/cron execution. A system context has full permissions but is
   * recorded in the audit log as actorType "system" with no user.
   */
  readonly isSystem: boolean;
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

export function can(ctx: AccessContext, permission: PermissionKey | string): boolean {
  if (ctx.isSystem) return true;
  if (!isKnownPermission(permission)) {
    // A permission string that is not in the catalogue can never be granted, so
    // treating it as "allowed" would be a silent hole. Fail closed and shout.
    throw new Error(
      `Unknown permission "${permission}". Add it to src/server/rbac/permissions.ts and reseed.`,
    );
  }
  return ctx.permissions.has(permission);
}

export function canAny(ctx: AccessContext, permissions: readonly (PermissionKey | string)[]): boolean {
  return permissions.some((p) => can(ctx, p));
}

export function canAll(ctx: AccessContext, permissions: readonly (PermissionKey | string)[]): boolean {
  return permissions.every((p) => can(ctx, p));
}

/** Throws PermissionDeniedError when the permission is absent. */
export function requirePermission(
  ctx: AccessContext,
  permission: PermissionKey | string,
): void {
  if (!can(ctx, permission)) throw new PermissionDeniedError(permission);
}

export function requireAnyPermission(
  ctx: AccessContext,
  permissions: readonly (PermissionKey | string)[],
): void {
  if (!canAny(ctx, permissions)) throw new PermissionDeniedError(permissions as readonly string[]);
}

// ---------------------------------------------------------------------------
// Scope: branch isolation
// ---------------------------------------------------------------------------

/**
 * The tenancy + branch predicate for any model carrying `organizationId` and
 * `branchId`. Spread it into a Prisma `where`:
 *
 *     prisma.student.findMany({ where: { ...scopeFilter(ctx), status: 'ACTIVE' } })
 *
 * For ORGANIZATION scope this is `{ organizationId }` alone. For BRANCH scope it
 * additionally pins `branchId` to the caller's list. An empty branch list for a
 * BRANCH-scoped user yields `branchId: { in: [] }`, which matches nothing --
 * correct and fail-closed: a branch admin assigned to no branch sees no data.
 */
export function scopeFilter(ctx: AccessContext): {
  organizationId: string;
  branchId?: { in: string[] };
} {
  if (ctx.scope === 'ORGANIZATION') {
    return { organizationId: ctx.organizationId };
  }
  return {
    organizationId: ctx.organizationId,
    // Copied into a fresh mutable array: Prisma's generated `where` types accept
    // `string[]` but not `readonly string[]`, and `ctx.branchIds` is readonly so
    // that no service can mutate a caller's scope in place.
    branchId: { in: [...ctx.branchIds] },
  };
}

/**
 * Same as `scopeFilter` for models whose `branchId` is nullable (leads,
 * follow-ups, departments). A row with no branch belongs to the organisation and
 * is visible to anyone inside it.
 */
export function scopeFilterNullableBranch(ctx: AccessContext):
  | { organizationId: string }
  | { organizationId: string; OR: [{ branchId: { in: string[] } }, { branchId: null }] } {
  if (ctx.scope === 'ORGANIZATION') {
    return { organizationId: ctx.organizationId };
  }
  return {
    organizationId: ctx.organizationId,
    OR: [{ branchId: { in: [...ctx.branchIds] } }, { branchId: null }],
  };
}

/** The organisation predicate alone, for models with no branch column. */
export function organizationFilter(ctx: AccessContext): { organizationId: string } {
  return { organizationId: ctx.organizationId };
}

export function hasBranchAccess(ctx: AccessContext, branchId: string | null | undefined): boolean {
  if (ctx.scope === 'ORGANIZATION') return true;
  if (branchId == null) return true;
  return ctx.branchIds.includes(branchId);
}

/**
 * Assert the caller may act on a specific branch. Used on WRITE paths, where
 * filtering is not enough: creating a student in another branch must be an
 * explicit 403, not a silently-relocated record.
 */
export function assertBranchAccess(
  ctx: AccessContext,
  branchId: string | null | undefined,
  resource: string,
): void {
  if (!hasBranchAccess(ctx, branchId)) {
    throw new OutOfScopeError(resource, { branchId: branchId ?? null });
  }
}

/**
 * Resolve the branch a write should target. When the caller is branch-scoped and
 * supplied nothing, their primary branch is used; when they supplied a branch,
 * it is verified. ORGANIZATION-scoped callers must be explicit, because guessing
 * on their behalf is how records end up in the wrong branch.
 */
export function resolveWriteBranch(
  ctx: AccessContext,
  requested: string | null | undefined,
  resource: string,
): string {
  if (requested) {
    assertBranchAccess(ctx, requested, resource);
    return requested;
  }
  if (ctx.scope !== 'ORGANIZATION' && ctx.primaryBranchId) return ctx.primaryBranchId;
  if (ctx.branchIds.length === 1 && ctx.branchIds[0]) return ctx.branchIds[0];
  throw new ForbiddenError(`A branch must be specified when creating this ${resource}.`);
}

// ---------------------------------------------------------------------------
// Scope: SELF
//
// SELF-scoped callers (teachers, sales agents, students, parents) see only rows
// tied to their own identity. The shape of "their own" differs per module, so
// each helper returns the extra predicate that module needs. A caller who also
// holds the module's `viewAll` permission is promoted out of SELF for reads --
// that is how a sales manager sees the whole pipeline while an agent does not.
// ---------------------------------------------------------------------------

export function isSelfScoped(ctx: AccessContext): boolean {
  return ctx.scope === 'SELF' && !ctx.isSystem;
}

/**
 * True when the caller should be restricted to their own records for this
 * module, i.e. SELF-scoped and lacking the module's escape-hatch permission.
 */
export function restrictedToOwn(
  ctx: AccessContext,
  viewAllPermission: PermissionKey | string,
): boolean {
  return isSelfScoped(ctx) && !can(ctx, viewAllPermission);
}

/** Predicate limiting groups to those the caller teaches. */
export function teacherGroupFilter(ctx: AccessContext): { teacherAssignments: { some: { teacherId: string; endDate: null } } } | Record<string, never> {
  if (!ctx.self.teacherId) return {};
  return { teacherAssignments: { some: { teacherId: ctx.self.teacherId, endDate: null } } };
}

/**
 * Predicate limiting lessons to the caller's own teaching. Applied when a
 * teacher lacks `schedule.viewAll`.
 */
export function teacherLessonFilter(ctx: AccessContext): Record<string, unknown> {
  const teacherId = ctx.self.teacherId;
  if (!teacherId) {
    // A SELF-scoped user who is not a teacher must see no lessons at all rather
    // than every lesson.
    return { id: { in: [] as string[] } };
  }
  return {
    OR: [
      { teacherId },
      { group: { teacherAssignments: { some: { teacherId, endDate: null } } } },
    ],
  };
}

/**
 * Predicate limiting students to those the caller may see under SELF scope:
 * a teacher's enrolled students, a parent's children, or a student themselves.
 */
export function selfStudentFilter(ctx: AccessContext): Record<string, unknown> {
  const { teacherId, studentId, guardianId } = ctx.self;

  if (studentId) return { id: studentId };
  if (guardianId) return { guardians: { some: { guardianId } } };
  if (teacherId) {
    return {
      enrollments: {
        some: {
          endDate: null,
          group: { teacherAssignments: { some: { teacherId, endDate: null } } },
        },
      },
    };
  }
  return { id: { in: [] as string[] } };
}

/** Predicate limiting leads to the caller's own book of business. */
export function selfLeadFilter(ctx: AccessContext): Record<string, unknown> {
  return {
    OR: [{ assignedToUserId: ctx.userId }, { createdById: ctx.userId }],
  };
}

/**
 * Compose the full read predicate for a module: tenancy, branch scope, and the
 * SELF narrowing when it applies.
 *
 *     where: composeReadFilter(ctx, {
 *       viewAllPermission: 'students.view',   // not needed; see below
 *       selfFilter: selfStudentFilter(ctx),
 *       escapeHatch: 'attendance.viewAll',
 *     })
 */
export function composeReadFilter(
  ctx: AccessContext,
  options: {
    /** SELF narrowing to apply when the caller lacks `escapeHatch`. */
    readonly selfFilter?: Record<string, unknown>;
    /** Permission that lifts the SELF narrowing, e.g. `students.view` for staff. */
    readonly escapeHatch?: PermissionKey | string;
    /** Use the nullable-branch variant for models where branchId is optional. */
    readonly nullableBranch?: boolean;
  } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = options.nullableBranch
    ? { ...scopeFilterNullableBranch(ctx) }
    : { ...scopeFilter(ctx) };

  const needsSelf =
    options.selfFilter &&
    isSelfScoped(ctx) &&
    !(options.escapeHatch && can(ctx, options.escapeHatch));

  if (!needsSelf) return base;

  // AND the self predicate rather than merging keys, so an `OR` inside the self
  // filter cannot collide with an `OR` from the branch filter.
  return { AND: [base, options.selfFilter as Record<string, unknown>] };
}

// ---------------------------------------------------------------------------
// Role-grant guard
// ---------------------------------------------------------------------------

/**
 * A user may only grant, edit or delete roles strictly below their own level.
 * Without this, any user holding `users.manageRoles` could award themselves
 * SUPER_ADMIN.
 */
export function assertCanGrantRole(
  ctx: AccessContext,
  targetRole: { key: string; level: number },
): void {
  if (ctx.isSystem) return;
  if (targetRole.level >= ctx.roleLevel) {
    throw new ForbiddenError(
      `You cannot grant the "${targetRole.key}" role because it is at or above your own privilege level.`,
      { details: { targetRoleLevel: targetRole.level, yourLevel: ctx.roleLevel } },
    );
  }
}

/** Guards edits to another user: never escalate, never touch a peer or superior. */
export function assertCanAdministerUser(
  ctx: AccessContext,
  target: { id: string; highestRoleLevel: number },
): void {
  if (ctx.isSystem) return;
  if (target.id === ctx.userId) return; // Editing your own profile is allowed.
  if (target.highestRoleLevel >= ctx.roleLevel) {
    throw new ForbiddenError(
      'You cannot administer a user whose privileges are at or above your own.',
    );
  }
}

// ---------------------------------------------------------------------------
// System context for jobs and cron
// ---------------------------------------------------------------------------

/**
 * Context for background work. Full authority, but attributed to "system" in the
 * audit log rather than to a user. Constructing one requires naming the job, so
 * an audit reader can always tell which automation acted.
 */
export function createSystemContext(options: {
  organizationId: string;
  jobName: string;
  requestId: string;
}): AccessContext {
  return {
    userId: `system:${options.jobName}`,
    organizationId: options.organizationId,
    email: 'system@internal',
    displayName: `System (${options.jobName})`,
    permissions: new Set<string>(),
    scope: 'ORGANIZATION',
    roleLevel: Number.MAX_SAFE_INTEGER,
    roleKeys: ['SYSTEM'],
    branchIds: [],
    primaryBranchId: null,
    self: { teacherId: null, employeeId: null, studentId: null, guardianId: null },
    requestId: options.requestId,
    ipAddress: null,
    userAgent: null,
    sessionId: null,
    isSystem: true,
  };
}
