/**
 * User account administration.
 *
 * This is the most security-sensitive file in the administration domain, because
 * every function in it can hand somebody authority. Two guards run on every
 * write and are worth naming explicitly:
 *
 *   assertCanAdministerUser  you may not edit a peer or a superior. Without it,
 *                            a branch administrator could reset the password of
 *                            the organisation owner and take the tenant.
 *   assertCanGrantRole       you may not attach a role at or above your own
 *                            level. Without it, anyone holding `users.create`
 *                            could create an account with SUPER_ADMIN and sign
 *                            in as it — self-escalation with one extra step.
 *
 * Both are enforced through `loadAdministrableUser` / `loadRole` rather than
 * inline, so there is exactly one implementation of each decision.
 *
 * TEMPORARY PASSWORDS are returned to the caller ONCE, in the response body of
 * the request that created or reset the account, and never stored, logged or
 * audited. They are deliberately not passed to the logger at all: the logger's
 * redaction rules are a safety net for mistakes, not a licence to hand it
 * secrets. `mustChangePassword` makes the value single-use in practice.
 *
 * DEACTIVATION revokes every live session in the same transaction. A user whose
 * status says INACTIVE but whose session cookie still works has not been
 * deactivated; they have been relabelled.
 */

import type { Locale, Prisma, UserStatus } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  StateInvalidError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit, severityFor } from '@/server/audit';
import {
  assertBranchAccess,
  assertCanGrantRole,
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { generateTemporaryPassword, hashPassword } from '@/server/auth/password';
import { revokeAllUserSessions } from '@/server/auth/session';
import { assertTimeZone } from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import {
  ADMIN_USER_SELECT,
  isUniqueViolation,
  loadAdministrableUser,
  loadRole,
  toPage,
  userDisplayName,
  type PageInput,
  type Paginated,
} from '@/server/services/admin/shared';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface UserRoleGrant {
  readonly roleId: string;
  readonly roleKey: string;
  readonly roleName: string;
  readonly level: number;
  readonly scope: 'ORGANIZATION' | 'BRANCH' | 'SELF';
  /** Null means the grant applies across every branch the user can reach. */
  readonly branchId: string | null;
  readonly expiresAt: Date | null;
}

export interface UserSummary {
  readonly id: string;
  readonly email: string;
  readonly username: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly locale: Locale | null;
  readonly timezone: string | null;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly roles: readonly UserRoleGrant[];
  readonly branchIds: readonly string[];
  readonly primaryBranchId: string | null;
}

export interface UserDetail extends UserSummary {
  /** Live sessions, so an administrator can see the account is in use. */
  readonly activeSessionCount: number;
  readonly employeeId: string | null;
  readonly studentId: string | null;
  readonly guardianId: string | null;
}

export interface CreateUserInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly username?: string | null;
  readonly phone?: string | null;
  readonly locale?: Locale | null;
  readonly timezone?: string | null;
  /** Roles to grant at creation. Each is checked against the caller's level. */
  readonly roleIds?: readonly string[];
  readonly branchIds?: readonly string[];
  readonly primaryBranchId?: string | null;
}

export interface CreateUserResult {
  readonly user: UserSummary;
  /**
   * Shown to the administrator once so they can pass it on. Not retrievable
   * afterwards — a second reset is the only way to get a new one.
   */
  readonly temporaryPassword: string;
}

export type UpdateUserInput = Partial<
  Pick<CreateUserInput, 'email' | 'firstName' | 'lastName' | 'username' | 'phone' | 'locale' | 'timezone'>
>;

export type UserSortField = 'lastName' | 'createdAt' | 'lastLoginAt' | 'email';

export interface ListUsersInput extends PageInput {
  readonly q?: string;
  readonly status?: readonly UserStatus[];
  readonly roleId?: string;
  readonly branchId?: string;
  readonly sortBy?: UserSortField;
  readonly sortDir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Read predicate
// ---------------------------------------------------------------------------

/**
 * Which accounts a caller may see.
 *
 * `User` has no `branchId` column — a user's branch reach is derived from
 * `UserBranch`, branch-pinned role grants and their employee record, exactly as
 * `buildAccessContext` derives it. So the predicate mirrors that derivation
 * rather than inventing a column.
 *
 * A branch-scoped caller therefore does NOT see an organisation-level
 * administrator, who has no branch link at all. That is the fail-closed answer:
 * such an account is not part of any branch's staff list, and a branch admin has
 * no business enumerating the people above them.
 */
function userReadFilter(ctx: AccessContext): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { ...organizationFilter(ctx), deletedAt: null };
  if (ctx.scope === 'ORGANIZATION') return base;

  const branchIds = [...ctx.branchIds];
  return {
    ...base,
    OR: [
      { userBranches: { some: { branchId: { in: branchIds } } } },
      { userRoles: { some: { branchId: { in: branchIds } } } },
      { employee: { branchId: { in: branchIds } } },
      // Your own account, always: otherwise a SELF-scoped teacher could not open
      // their own profile through the same use-case.
      { id: ctx.userId },
    ],
  };
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOptionalPhone(
  phone: string | null | undefined,
): { phone: string | null; phoneNormalized: string | null } {
  if (phone === undefined || phone === null || phone.trim() === '') {
    return { phone: null, phoneNormalized: null };
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new ValidationError([{ path: 'phone', message: 'Not a valid phone number' }]);
  }
  return { phone: phone.trim(), phoneNormalized: normalized };
}

/** `assertTimeZone` throws a RangeError; the API boundary needs an AppError. */
function assertValidTimezone(zone: string | null | undefined): string | null {
  if (zone === undefined || zone === null || zone.trim() === '') return null;
  try {
    return assertTimeZone(zone.trim());
  } catch {
    throw new ValidationError([{ path: 'timezone', message: 'Not a known IANA timezone' }]);
  }
}

function toSummary(row: {
  id: string;
  email: string;
  username: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: UserStatus;
  locale: Locale | null;
  timezone: string | null;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  userRoles: ReadonlyArray<{
    branchId: string | null;
    expiresAt: Date | null;
    role: {
      id: string;
      key: string;
      name: string;
      level: number;
      scope: 'ORGANIZATION' | 'BRANCH' | 'SELF';
      deletedAt: Date | null;
    };
  }>;
  userBranches: ReadonlyArray<{ branchId: string; isPrimary: boolean }>;
}): UserSummary {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: userDisplayName(row),
    phone: row.phone,
    status: row.status,
    locale: row.locale,
    timezone: row.timezone,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    roles: row.userRoles
      .filter((grant) => !grant.role.deletedAt)
      .map((grant) => ({
        roleId: grant.role.id,
        roleKey: grant.role.key,
        roleName: grant.role.name,
        level: grant.role.level,
        scope: grant.role.scope,
        branchId: grant.branchId,
        expiresAt: grant.expiresAt,
      })),
    branchIds: row.userBranches.map((branch) => branch.branchId),
    primaryBranchId: row.userBranches.find((branch) => branch.isPrimary)?.branchId ?? null,
  };
}

/** Re-read a summary after a write performed by another admin use-case. */
export async function readUserSummary(db: Db, userId: string): Promise<UserSummary> {
  const row = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: ADMIN_USER_SELECT,
  });
  return toSummary(row);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createUser(
  ctx: AccessContext,
  input: CreateUserInput,
  db?: Db,
): Promise<CreateUserResult> {
  requirePermission(ctx, 'users.create');

  const email = normalizeEmail(input.email);
  const { phone, phoneNormalized } = normalizeOptionalPhone(input.phone);
  const timezone = assertValidTimezone(input.timezone);
  const branchIds = [...new Set(input.branchIds ?? [])];
  const roleIds = [...new Set(input.roleIds ?? [])];

  // Generated before the transaction because Argon2id deliberately costs ~15 ms
  // and a transaction is not the place to spend it.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await withTransaction(
    async (tx) => {
      const roles = await assertGrantableRoles(ctx, tx, roleIds);
      const primaryBranchId = assertBranchSelection(ctx, branchIds, input.primaryBranchId);

      const created = await tx.user
        .create({
          data: {
            organizationId: ctx.organizationId,
            email,
            username: input.username?.trim() || null,
            passwordHash,
            // INVITED, not ACTIVE: the account has never been signed into, and
            // the login flow distinguishes the two.
            status: 'INVITED',
            mustChangePassword: true,
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            phone,
            phoneNormalized,
            locale: input.locale ?? null,
            timezone,
            userRoles: {
              create: roles.map((role) => ({
                roleId: role.id,
                grantedById: ctx.isSystem ? null : ctx.userId,
              })),
            },
            userBranches: {
              create: branchIds.map((branchId) => ({
                branchId,
                isPrimary: branchId === primaryBranchId,
              })),
            },
          },
          select: ADMIN_USER_SELECT,
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'email')) throw new DuplicateError('user', ['email']);
          if (isUniqueViolation(error, 'username')) throw new DuplicateError('user', ['username']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.USER_CREATED,
          entityType: 'User',
          entityId: created.id,
          branchId: primaryBranchId,
          summary: `Created account ${created.email} for ${userDisplayName(created)}`,
          severity: 'NOTICE',
          // The temporary password is deliberately absent. An audit row is
          // readable by anyone with `audit.view`.
          metadata: {
            roleKeys: roles.map((role) => role.key),
            branchCount: branchIds.length,
          },
        },
        tx,
      );

      return toSummary(created);
    },
    { existing: db },
  );

  return { user, temporaryPassword };
}

/**
 * Verify every role in a grant set is one the caller is allowed to hand out.
 * Runs before the write, so a set containing one forbidden role grants none of
 * them.
 */
async function assertGrantableRoles(
  ctx: AccessContext,
  tx: Tx,
  roleIds: readonly string[],
): Promise<ReadonlyArray<{ id: string; key: string; level: number }>> {
  const roles: Array<{ id: string; key: string; level: number }> = [];
  for (const roleId of roleIds) {
    const role = await loadRole(ctx, tx, roleId);
    assertCanGrantRole(ctx, role);
    roles.push({ id: role.id, key: role.key, level: role.level });
  }
  return roles;
}

/**
 * Check the branch list and resolve which one is primary.
 *
 * A caller may only grant access to branches they can reach themselves —
 * otherwise a branch administrator could give a new account the run of a branch
 * they have never seen.
 */
function assertBranchSelection(
  ctx: AccessContext,
  branchIds: readonly string[],
  requestedPrimary: string | null | undefined,
): string | null {
  for (const branchId of branchIds) assertBranchAccess(ctx, branchId, 'user');

  if (requestedPrimary) {
    if (!branchIds.includes(requestedPrimary)) {
      throw new BusinessRuleError(
        'user.primary_branch_not_granted',
        'The primary branch must be one of the branches the user has access to.',
      );
    }
    return requestedPrimary;
  }
  return branchIds[0] ?? null;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateUser(
  ctx: AccessContext,
  userId: string,
  input: UpdateUserInput,
  db?: Db,
): Promise<UserSummary> {
  requirePermission(ctx, 'users.edit');

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, userId);

      // Built as a plain object first so the audit diff and the UPDATE are
      // guaranteed to describe the same values.
      const next: {
        email?: string;
        username?: string | null;
        firstName?: string;
        lastName?: string;
        phone?: string | null;
        locale?: Locale | null;
        timezone?: string | null;
      } = {};
      let phoneNormalized: string | null | undefined;

      if (input.email !== undefined) next.email = normalizeEmail(input.email);
      if (input.firstName !== undefined) next.firstName = input.firstName.trim();
      if (input.lastName !== undefined) next.lastName = input.lastName.trim();
      if (input.username !== undefined) next.username = input.username?.trim() || null;
      if (input.phone !== undefined) {
        const normalized = normalizeOptionalPhone(input.phone);
        next.phone = normalized.phone;
        phoneNormalized = normalized.phoneNormalized;
      }
      if (input.locale !== undefined) next.locale = input.locale ?? null;
      if (input.timezone !== undefined) next.timezone = assertValidTimezone(input.timezone);

      const before = await tx.user.findUniqueOrThrow({
        where: { id: target.id },
        select: {
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          phone: true,
          locale: true,
          timezone: true,
        },
      });

      const updated = await tx.user
        .update({
          where: { id: target.id },
          data: { ...next, ...(phoneNormalized !== undefined ? { phoneNormalized } : {}) },
          select: ADMIN_USER_SELECT,
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, 'email')) throw new DuplicateError('user', ['email']);
          if (isUniqueViolation(error, 'username')) throw new DuplicateError('user', ['username']);
          throw error;
        });

      const changes = diffFields(
        {
          email: before.email,
          username: before.username,
          firstName: before.firstName,
          lastName: before.lastName,
          phone: before.phone,
          locale: before.locale,
          timezone: before.timezone,
        },
        next,
      );

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.USER_UPDATED,
          entityType: 'User',
          entityId: target.id,
          summary: `Updated account ${updated.email}`,
          changes,
          severity: Object.hasOwn(changes, 'email') ? 'NOTICE' : severityFor(AUDIT_ACTIONS.USER_UPDATED),
        },
        tx,
      );

      return toSummary(updated);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Deactivate / reactivate
// ---------------------------------------------------------------------------

export interface DeactivateUserInput {
  readonly reason: string;
}

export async function deactivateUser(
  ctx: AccessContext,
  userId: string,
  input: DeactivateUserInput,
  db?: Db,
): Promise<{ id: string; status: UserStatus; sessionsRevoked: number }> {
  requirePermission(ctx, 'users.deactivate');

  // Locking yourself out is never the intent, and there may be no second
  // administrator to undo it.
  if (userId === ctx.userId) {
    throw new ForbiddenError('You cannot deactivate your own account.');
  }

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, userId);
      if (target.status === 'INACTIVE') {
        throw new StateInvalidError('user', 'already inactive', 'deactivated');
      }

      const status: UserStatus = 'INACTIVE';
      await tx.user.update({ where: { id: target.id }, data: { status } });

      // In the SAME transaction as the status change: a deactivation that
      // committed without the revocation would leave a working session behind,
      // and nothing would ever retry it.
      const sessionsRevoked = await revokeAllUserSessions(
        target.id,
        `deactivated by ${ctx.userId}`,
        {},
        tx,
      );

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.USER_DEACTIVATED,
          entityType: 'User',
          entityId: target.id,
          summary: `Deactivated account ${target.email}`,
          reason: input.reason,
          changes: { status: { from: target.status, to: status } },
          severity: 'NOTICE',
          metadata: { sessionsRevoked },
        },
        tx,
      );

      return { id: target.id, status, sessionsRevoked };
    },
    { existing: db },
  );
}

export async function reactivateUser(
  ctx: AccessContext,
  userId: string,
  db?: Db,
): Promise<{ id: string; status: UserStatus }> {
  requirePermission(ctx, 'users.deactivate');

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, userId);
      if (target.status === 'ACTIVE' || target.status === 'INVITED') {
        throw new StateInvalidError('user', 'already active', 'reactivated');
      }

      // An account that never completed a first login returns to INVITED, not
      // ACTIVE, so the login flow still walks it through setting a password.
      const status: UserStatus = 'ACTIVE';
      await tx.user.update({
        where: { id: target.id },
        data: {
          status,
          // A lockout is a consequence of the failed-login counter, not a
          // decision an administrator should have to undo separately.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.USER_REACTIVATED,
          entityType: 'User',
          entityId: target.id,
          summary: `Reactivated account ${target.email}`,
          changes: { status: { from: target.status, to: status } },
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: target.id, status };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Password reset by an administrator
// ---------------------------------------------------------------------------

export interface AdminResetPasswordResult {
  readonly userId: string;
  /** Returned once; never stored in readable form and never audited. */
  readonly temporaryPassword: string;
  readonly sessionsRevoked: number;
}

/**
 * Reset another user's password to a temporary one.
 *
 * Distinct from the self-service reset flow in `@/server/auth`: there is no
 * emailed token and no proof of address, so the only thing standing between this
 * and an account takeover is the `assertCanAdministerUser` guard and the audit
 * row. Both are mandatory, which is why this is recorded at NOTICE even when
 * nothing else about the account changed.
 */
export async function adminResetPassword(
  ctx: AccessContext,
  userId: string,
  db?: Db,
): Promise<AdminResetPasswordResult> {
  requirePermission(ctx, 'users.resetPassword');

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, userId);

      await tx.user.update({
        where: { id: target.id },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mustChangePassword: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      // Every existing session is revoked: a reset exists to lock somebody out,
      // and leaving their cookies alive defeats the whole point.
      const sessionsRevoked = await revokeAllUserSessions(
        target.id,
        `password reset by ${ctx.userId}`,
        {},
        tx,
      );

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.PASSWORD_RESET_BY_ADMIN,
          entityType: 'User',
          entityId: target.id,
          summary: `Password reset for ${target.email} by an administrator`,
          severity: 'NOTICE',
          metadata: { sessionsRevoked },
        },
        tx,
      );

      return { userId: target.id, sessionsRevoked };
    },
    { existing: db },
  );

  return { ...result, temporaryPassword };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listUsers(
  ctx: AccessContext,
  input: ListUsersInput = {},
  db?: Db,
): Promise<Paginated<UserSummary>> {
  requirePermission(ctx, 'users.view');

  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const filters: Prisma.UserWhereInput[] = [userReadFilter(ctx)];

  if (input.status && input.status.length > 0) {
    filters.push({ status: { in: [...input.status] } });
  }
  if (input.roleId) {
    filters.push({ userRoles: { some: { roleId: input.roleId } } });
  }
  if (input.branchId) {
    // Verified rather than intersected with the scope: asking for a branch the
    // caller cannot see is a 403, not an empty list that reads as "no staff".
    assertBranchAccess(ctx, input.branchId, 'user');
    filters.push({ userBranches: { some: { branchId: input.branchId } } });
  }

  const term = input.q?.trim();
  if (term) {
    filters.push({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { username: { contains: term, mode: 'insensitive' } },
        { phoneNormalized: { contains: term } },
      ],
    });
  }

  const where: Prisma.UserWhereInput = { AND: filters };
  const direction = input.sortDir ?? (input.sortBy === 'lastName' ? 'asc' : 'desc');
  const orderBy: Prisma.UserOrderByWithRelationInput[] =
    input.sortBy === 'email'
      ? [{ email: direction }]
      : input.sortBy === 'lastLoginAt'
        ? [{ lastLoginAt: direction }, { id: 'asc' }]
        : input.sortBy === 'createdAt'
          ? [{ createdAt: direction }, { id: 'asc' }]
          : [{ lastName: direction }, { firstName: direction }];

  const [total, rows] = await Promise.all([
    client.user.count({ where }),
    client.user.findMany({ where, orderBy, skip, take, select: ADMIN_USER_SELECT }),
  ]);

  return { items: rows.map(toSummary), page, pageSize, total };
}

export async function getUser(
  ctx: AccessContext,
  userId: string,
  db?: Db,
): Promise<UserDetail> {
  requirePermission(ctx, 'users.view');

  const client = db ?? prisma;
  // Scope in the same `where` as the id: fetching first and checking after would
  // reveal that an account exists in a branch the caller cannot see.
  const row = await client.user.findFirst({
    where: { AND: [userReadFilter(ctx), { id: userId }] },
    select: {
      ...ADMIN_USER_SELECT,
      employee: { select: { id: true } },
      studentProfile: { select: { id: true } },
      guardianProfile: { select: { id: true } },
      _count: {
        select: {
          sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('User', userId);

  return {
    ...toSummary(row),
    activeSessionCount: row._count.sessions,
    employeeId: row.employee?.id ?? null,
    studentId: row.studentProfile?.id ?? null,
    guardianId: row.guardianProfile?.id ?? null,
  };
}
