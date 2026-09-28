/**
 * Roles, permissions and the grants that attach them to people.
 *
 * `src/server/rbac/permissions.ts` is the catalogue of what the software can
 * authorise; the `roles` and `role_permissions` tables are what this
 * organisation has actually granted. This file is the only sanctioned writer of
 * the second, and it holds three rules that together are what stops the RBAC
 * system being a formality:
 *
 *   1. A role may only be created, edited or granted BELOW the caller's own
 *      level (`assertCanGrantRole`). Otherwise "create a role at level 100, then
 *      grant it to yourself" is a two-request path to owning the tenant.
 *   2. A caller may not add a permission they do not themselves hold. Level
 *      alone does not cover this: two roles can sit at the same level with
 *      different powers, and without this check an accountant with `roles.manage`
 *      could add `users.impersonate` to their own role.
 *   3. A system role's key is immutable and it cannot be deleted. The seed and
 *      `ROLE_TEMPLATES` look roles up by key, so a renamed `SUPER_ADMIN` would
 *      silently stop being the role the code reasons about.
 *
 * Permission changes are audited at NOTICE with the full added/removed diff,
 * because a permission change is the single thing an auditor always asks for.
 */

import type { RoleScope } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  DuplicateError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  assertCanGrantRole,
  can,
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { PERMISSIONS, isKnownPermission } from '@/server/rbac/permissions';
import {
  isUniqueViolation,
  loadAdministrableUser,
  loadRole,
  userDisplayName,
} from '@/server/services/admin/shared';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RoleSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: RoleScope;
  readonly level: number;
  readonly isSystem: boolean;
  readonly isDefault: boolean;
  readonly permissionCount: number;
  readonly userCount: number;
  /** False when the role sits at or above the caller's own level. */
  readonly editableByCaller: boolean;
}

export interface RoleDetail extends RoleSummary {
  readonly permissionKeys: readonly string[];
}

export interface CreateRoleInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  readonly scope: RoleScope;
  readonly level: number;
  readonly permissionKeys?: readonly string[];
}

export type UpdateRoleInput = Partial<
  Pick<CreateRoleInput, 'key' | 'name' | 'description' | 'scope' | 'level'>
> & { readonly isDefault?: boolean };

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listRoles(
  ctx: AccessContext,
  input: { readonly includeDeleted?: boolean } = {},
  db?: Db,
): Promise<readonly RoleSummary[]> {
  requirePermission(ctx, 'roles.view');

  const client = db ?? prisma;
  const rows = await client.role.findMany({
    where: {
      ...organizationFilter(ctx),
      ...(input.includeDeleted ? {} : { deletedAt: null }),
    },
    orderBy: [{ level: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      scope: true,
      level: true,
      isSystem: true,
      isDefault: true,
      _count: { select: { permissions: true, userRoles: true } },
    },
  });

  return rows.map((row) => toSummary(ctx, row, row._count.permissions, row._count.userRoles));
}

export async function getRole(ctx: AccessContext, roleId: string, db?: Db): Promise<RoleDetail> {
  requirePermission(ctx, 'roles.view');
  return readRoleDetail(ctx, db ?? prisma, roleId);
}

/**
 * The read behind `getRole`, without the permission check, so a write use-case
 * can return its result without demanding `roles.view` on top of `roles.manage`.
 */
async function readRoleDetail(
  ctx: AccessContext,
  client: Db,
  roleId: string,
): Promise<RoleDetail> {
  const row = await client.role.findFirst({
    where: { id: roleId, ...organizationFilter(ctx) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      scope: true,
      level: true,
      isSystem: true,
      isDefault: true,
      permissions: { select: { permission: { select: { key: true } } } },
      _count: { select: { userRoles: true } },
    },
  });
  if (!row) throw new NotFoundError('Role', roleId);

  const permissionKeys = row.permissions.map((entry) => entry.permission.key).sort();
  return {
    ...toSummary(ctx, row, permissionKeys.length, row._count.userRoles),
    permissionKeys,
  };
}

function toSummary(
  ctx: AccessContext,
  row: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    scope: RoleScope;
    level: number;
    isSystem: boolean;
    isDefault: boolean;
  },
  permissionCount: number,
  userCount: number,
): RoleSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    scope: row.scope,
    level: row.level,
    isSystem: row.isSystem,
    isDefault: row.isDefault,
    permissionCount,
    userCount,
    // Reported rather than hidden: the UI disables the row and says why, instead
    // of pretending the role does not exist.
    editableByCaller: ctx.isSystem || row.level < ctx.roleLevel,
  };
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

export async function createRole(
  ctx: AccessContext,
  input: CreateRoleInput,
  db?: Db,
): Promise<RoleDetail> {
  requirePermission(ctx, 'roles.manage');

  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(key)) {
    throw new ValidationError([
      { path: 'key', message: 'Use upper-case letters, digits and underscores, starting with a letter' },
    ]);
  }
  assertLevel(input.level);
  // A role you could not grant is a role you could not use, so creating one is
  // the same escalation attempt with an extra step.
  assertCanGrantRole(ctx, { key, level: input.level });

  const permissionKeys = assertGrantablePermissions(ctx, input.permissionKeys ?? []);

  return withTransaction(
    async (tx) => {
      const permissionIds = await resolvePermissionIds(tx, permissionKeys);

      const created = await tx.role
        .create({
          data: {
            organizationId: ctx.organizationId,
            key,
            name: input.name.trim(),
            description: input.description ?? null,
            scope: input.scope,
            level: input.level,
            isSystem: false,
            permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
          },
          select: { id: true, key: true, name: true },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new DuplicateError('role', ['key']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_CREATED,
          entityType: 'Role',
          entityId: created.id,
          summary: `Created role ${created.name} (${created.key}) at level ${input.level}`,
          severity: 'NOTICE',
          metadata: { level: input.level, scope: input.scope, permissionCount: permissionKeys.length },
        },
        tx,
      );

      return readRoleDetail(ctx, tx, created.id);
    },
    { existing: db },
  );
}

export async function updateRole(
  ctx: AccessContext,
  roleId: string,
  input: UpdateRoleInput,
  db?: Db,
): Promise<RoleDetail> {
  requirePermission(ctx, 'roles.manage');

  return withTransaction(
    async (tx) => {
      const role = await loadRole(ctx, tx, roleId);
      assertCanGrantRole(ctx, role);

      if (input.key !== undefined && input.key.trim().toUpperCase() !== role.key) {
        if (role.isSystem) {
          // The seed, ROLE_TEMPLATES and several services look this role up by
          // key. Renaming it would leave them all pointing at nothing.
          throw new BusinessRuleError(
            'role.system_key_immutable',
            `The key of the built-in role "${role.key}" cannot be changed. Create a custom role instead.`,
          );
        }
      }
      if (input.level !== undefined) {
        assertLevel(input.level);
        // The NEW level is checked too: raising a role to your own level is the
        // same escalation as creating one there.
        assertCanGrantRole(ctx, { key: role.key, level: input.level });
      }

      const next: {
        key?: string;
        name?: string;
        description?: string | null;
        scope?: RoleScope;
        level?: number;
        isDefault?: boolean;
      } = {};
      if (input.key !== undefined) next.key = input.key.trim().toUpperCase();
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.description !== undefined) next.description = input.description ?? null;
      if (input.scope !== undefined) next.scope = input.scope;
      if (input.level !== undefined) next.level = input.level;
      if (input.isDefault !== undefined) next.isDefault = input.isDefault;

      const before = await tx.role.findUniqueOrThrow({
        where: { id: role.id },
        select: { key: true, name: true, description: true, scope: true, level: true, isDefault: true },
      });

      await tx.role.update({ where: { id: role.id }, data: next }).catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new DuplicateError('role', ['key']);
        throw error;
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_UPDATED,
          entityType: 'Role',
          entityId: role.id,
          summary: `Updated role ${before.name}`,
          changes: diffFields({ ...before }, next),
          severity: 'NOTICE',
        },
        tx,
      );

      return readRoleDetail(ctx, tx, role.id);
    },
    { existing: db },
  );
}

/**
 * Soft-delete a custom role.
 *
 * Refuses while anybody still holds it, and names the number, because the
 * alternative — cascading the grants away — silently removes people's access and
 * leaves no record of what they used to be able to do.
 */
export async function deleteRole(
  ctx: AccessContext,
  roleId: string,
  db?: Db,
): Promise<{ id: string }> {
  requirePermission(ctx, 'roles.manage');

  return withTransaction(
    async (tx) => {
      const role = await loadRole(ctx, tx, roleId);
      assertCanGrantRole(ctx, role);

      if (role.isSystem) {
        throw new BusinessRuleError(
          'role.system_not_deletable',
          `The built-in role "${role.key}" cannot be deleted.`,
        );
      }

      const holders = await tx.userRole.count({ where: { roleId: role.id } });
      if (holders > 0) {
        throw new BusinessRuleError(
          'role.still_granted',
          `${holders} ${holders === 1 ? 'user still holds' : 'users still hold'} this role. Revoke it from them first.`,
          { details: { holders } },
        );
      }

      await tx.role.update({ where: { id: role.id }, data: { deletedAt: new Date() } });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_UPDATED,
          entityType: 'Role',
          entityId: role.id,
          summary: `Deleted role ${role.name} (${role.key})`,
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: role.id };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Permissions on a role
// ---------------------------------------------------------------------------

export interface SetRolePermissionsInput {
  readonly permissionKeys: readonly string[];
  readonly reason?: string | null;
}

export interface SetRolePermissionsResult {
  readonly roleId: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly permissionKeys: readonly string[];
}

/**
 * Replace a role's permission set.
 *
 * Declarative rather than add/remove calls: the role editor submits the whole
 * set, and a diff computed here is what the audit row carries. An incremental
 * API would let two concurrent editors each drop the other's change with no sign
 * of it in the log.
 */
export async function setRolePermissions(
  ctx: AccessContext,
  roleId: string,
  input: SetRolePermissionsInput,
  db?: Db,
): Promise<SetRolePermissionsResult> {
  requirePermission(ctx, 'roles.manage');

  const requested = [...new Set(input.permissionKeys.map((key) => key.trim()))];
  const unknown = requested.filter((key) => !isKnownPermission(key));
  if (unknown.length > 0) {
    // An unknown key can never be checked by `can()` — it throws rather than
    // returning false — so storing one would turn every check against it into a
    // 500 for whoever holds the role.
    throw new ValidationError(
      unknown.map((key) => ({
        path: 'permissionKeys',
        message: `"${key}" is not a permission this software defines`,
      })),
    );
  }

  return withTransaction(
    async (tx) => {
      const role = await loadRole(ctx, tx, roleId);
      assertCanGrantRole(ctx, role);

      const existing = await tx.rolePermission.findMany({
        where: { roleId: role.id },
        select: { permissionId: true, permission: { select: { key: true } } },
      });
      const currentKeys = new Set(existing.map((entry) => entry.permission.key));

      const added = requested.filter((key) => !currentKeys.has(key));
      const removed = [...currentKeys].filter((key) => !requested.includes(key));

      // Only the ADDED keys are checked against the caller's own set: taking a
      // permission away is never an escalation, and blocking it would strand a
      // role nobody can tidy up.
      assertGrantablePermissions(ctx, added);

      if (added.length === 0 && removed.length === 0) {
        return {
          roleId: role.id,
          added: [],
          removed: [],
          permissionKeys: [...currentKeys].sort(),
        };
      }

      const addedIds = await resolvePermissionIds(tx, added);
      const removedIds = existing
        .filter((entry) => removed.includes(entry.permission.key))
        .map((entry) => entry.permissionId);

      if (removedIds.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { roleId: role.id, permissionId: { in: removedIds } },
        });
      }
      if (addedIds.length > 0) {
        await tx.rolePermission.createMany({
          data: addedIds.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
          entityType: 'Role',
          entityId: role.id,
          summary: `Permissions changed on ${role.name}: +${added.length} / -${removed.length}`,
          reason: input.reason ?? null,
          // NOTICE, always. This is the row an auditor comes looking for.
          severity: 'NOTICE',
          changes: {
            permissions: { from: [...currentKeys].sort(), to: [...requested].sort() },
          },
          metadata: { added, removed },
        },
        tx,
      );

      return { roleId: role.id, added, removed, permissionKeys: [...requested].sort() };
    },
    { existing: db },
  );
}

/**
 * Refuse to hand out a permission the caller does not hold.
 *
 * `assertCanGrantRole` guards the role's LEVEL; this guards its CONTENT. Both
 * are needed: levels are just integers an operator chose, so two roles can sit
 * side by side with very different power.
 */
function assertGrantablePermissions(
  ctx: AccessContext,
  keys: readonly string[],
): readonly string[] {
  if (ctx.isSystem) return keys;
  const beyond = keys.filter((key) => !can(ctx, key));
  if (beyond.length > 0) {
    throw new ForbiddenError(
      'You cannot grant a permission you do not hold yourself.',
      { details: { permissions: beyond } },
    );
  }
  return keys;
}

/**
 * Map catalogue keys to `Permission` row ids.
 *
 * A key that is in the catalogue but missing from the table means the seed has
 * not been run since it was added. That is a deployment fault, not a user error,
 * and silently dropping the key would produce a role that looks right in the
 * editor and denies access at runtime.
 */
async function resolvePermissionIds(db: Db, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db.permission.findMany({
    where: { key: { in: [...keys] } },
    select: { id: true, key: true },
  });
  if (rows.length !== keys.length) {
    const found = new Set(rows.map((row) => row.key));
    const missing = keys.filter((key) => !found.has(key));
    throw new ConflictError(
      'The permission catalogue in the database is out of date. Run the seed and try again.',
      { details: { missingPermissions: missing } },
    );
  }
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export interface GrantRoleInput {
  readonly userId: string;
  readonly roleId: string;
  /** Null pins the grant to no branch, i.e. everywhere the user can reach. */
  readonly branchId?: string | null;
  readonly expiresAt?: Date | null;
}

export async function grantRole(
  ctx: AccessContext,
  input: GrantRoleInput,
  db?: Db,
): Promise<{ userId: string; roleId: string; branchId: string | null }> {
  requirePermission(ctx, 'users.manageRoles');

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, input.userId);
      const role = await loadRole(ctx, tx, input.roleId);
      assertCanGrantRole(ctx, role);

      const branchId = input.branchId ?? null;
      if (branchId) assertBranchAccess(ctx, branchId, 'role grant');

      if (input.expiresAt && input.expiresAt <= new Date()) {
        throw new BusinessRuleError(
          'role.grant_already_expired',
          'The expiry date of a role grant must be in the future.',
        );
      }

      await tx.userRole
        .create({
          data: {
            userId: target.id,
            roleId: role.id,
            branchId,
            grantedById: ctx.isSystem ? null : ctx.userId,
            expiresAt: input.expiresAt ?? null,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new DuplicateError(
              'role grant',
              ['role', 'branch'],
              `${userDisplayName(target)} already holds the ${role.name} role here.`,
            );
          }
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_GRANTED,
          entityType: 'User',
          entityId: target.id,
          branchId,
          summary: `Granted ${role.name} to ${userDisplayName(target)}`,
          severity: 'NOTICE',
          metadata: { roleKey: role.key, roleLevel: role.level, expiresAt: input.expiresAt ?? null },
        },
        tx,
      );

      return { userId: target.id, roleId: role.id, branchId };
    },
    { existing: db },
  );
}

export async function revokeRole(
  ctx: AccessContext,
  input: { readonly userId: string; readonly roleId: string; readonly branchId?: string | null },
  db?: Db,
): Promise<{ revoked: number }> {
  requirePermission(ctx, 'users.manageRoles');

  // Revoking your own role is how an administrator locks themselves out of the
  // screen they would need to undo it. Another administrator must do it.
  if (input.userId === ctx.userId) {
    throw new ForbiddenError(
      'You cannot revoke your own roles. Ask another administrator to do it.',
    );
  }

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, input.userId);
      const role = await loadRole(ctx, tx, input.roleId);
      assertCanGrantRole(ctx, role);

      const result = await tx.userRole.deleteMany({
        where: {
          userId: target.id,
          roleId: role.id,
          ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        },
      });
      if (result.count === 0) {
        throw new NotFoundError('Role grant', `${input.userId}:${input.roleId}`);
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ROLE_REVOKED,
          entityType: 'User',
          entityId: target.id,
          branchId: input.branchId ?? null,
          summary: `Revoked ${role.name} from ${userDisplayName(target)}`,
          severity: 'NOTICE',
          metadata: { roleKey: role.key, grantsRemoved: result.count },
        },
        tx,
      );

      return { revoked: result.count };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Branch access
// ---------------------------------------------------------------------------

export interface SetUserBranchesInput {
  readonly userId: string;
  readonly branchIds: readonly string[];
  readonly primaryBranchId?: string | null;
}

/**
 * Replace a user's explicit branch access list.
 *
 * `UserBranch` is one half of the scope axis — the other half is the role's
 * `scope` — so this is an authorisation change and is audited as one. A partial
 * unique index (`user_branches_one_primary_per_user`) enforces the single
 * primary; the violation is translated rather than left as a generic duplicate.
 */
export async function setUserBranches(
  ctx: AccessContext,
  input: SetUserBranchesInput,
  db?: Db,
): Promise<{ userId: string; branchIds: readonly string[]; primaryBranchId: string | null }> {
  requirePermission(ctx, 'users.manageRoles');

  const branchIds = [...new Set(input.branchIds)];
  // A caller cannot hand out reach they do not have themselves.
  for (const branchId of branchIds) assertBranchAccess(ctx, branchId, 'branch access');

  const primaryBranchId = input.primaryBranchId ?? branchIds[0] ?? null;
  if (primaryBranchId && !branchIds.includes(primaryBranchId)) {
    throw new BusinessRuleError(
      'user.primary_branch_not_granted',
      'The primary branch must be one of the branches the user has access to.',
    );
  }

  return withTransaction(
    async (tx) => {
      const target = await loadAdministrableUser(ctx, tx, input.userId);

      const existing = await tx.branch.findMany({
        where: { id: { in: branchIds }, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true },
      });
      if (existing.length !== branchIds.length) {
        const found = new Set(existing.map((row) => row.id));
        throw new NotFoundError('Branch', branchIds.find((id) => !found.has(id)));
      }

      await tx.userBranch.deleteMany({ where: { userId: target.id } });
      if (branchIds.length > 0) {
        await tx.userBranch
          .createMany({
            data: branchIds.map((branchId) => ({
              userId: target.id,
              branchId,
              isPrimary: branchId === primaryBranchId,
            })),
          })
          .catch((error: unknown) => {
            if (isUniqueViolation(error, 'one_primary_per_user')) {
              throw new ConflictError('A user can have only one primary branch.');
            }
            throw error;
          });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.BRANCH_ACCESS_CHANGED,
          entityType: 'User',
          entityId: target.id,
          branchId: primaryBranchId,
          summary: `Branch access for ${userDisplayName(target)} set to ${branchIds.length} branch(es)`,
          severity: 'NOTICE',
          changes: { branchIds: { from: [...target.branchIds].sort(), to: [...branchIds].sort() } },
        },
        tx,
      );

      return { userId: target.id, branchIds, primaryBranchId };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// The access matrix
// ---------------------------------------------------------------------------

export interface AccessMatrixPermission {
  readonly key: string;
  readonly action: string;
  readonly description: string;
  readonly sensitive: boolean;
}

export interface AccessMatrixModule {
  readonly module: string;
  readonly permissions: readonly AccessMatrixPermission[];
}

export interface AccessMatrixRole {
  readonly roleId: string;
  readonly key: string;
  readonly name: string;
  readonly level: number;
  readonly scope: RoleScope;
  readonly isSystem: boolean;
  readonly userCount: number;
  /** Keys actually present in `role_permissions`, not what a template says. */
  readonly grantedKeys: readonly string[];
  /**
   * Granted keys that are no longer in the catalogue. Always empty on a seeded
   * database; non-empty means a permission was removed from the code and the
   * rows have not been cleaned up, which is worth showing rather than hiding.
   */
  readonly staleKeys: readonly string[];
}

export interface AccessMatrix {
  readonly modules: readonly AccessMatrixModule[];
  readonly roles: readonly AccessMatrixRole[];
}

/**
 * The documented role x module matrix, built from the rows that actually govern
 * access rather than from `ROLE_TEMPLATES`.
 *
 * That is the whole point: the templates describe what a role looked like when
 * it was seeded, and an administrator has been able to edit it ever since. A
 * matrix rendered from the templates would keep showing the original answer
 * while the system behaved differently.
 */
export async function getAccessMatrix(ctx: AccessContext, db?: Db): Promise<AccessMatrix> {
  requirePermission(ctx, 'roles.view');

  const client = db ?? prisma;
  const roles = await client.role.findMany({
    where: { ...organizationFilter(ctx), deletedAt: null },
    orderBy: [{ level: 'desc' }, { name: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      level: true,
      scope: true,
      isSystem: true,
      // One query for every role's permissions; assembling this per role would
      // be an N+1 on a screen that renders all of them at once.
      permissions: { select: { permission: { select: { key: true } } } },
      _count: { select: { userRoles: true } },
    },
  });

  const modules = new Map<string, AccessMatrixPermission[]>();
  for (const definition of PERMISSIONS) {
    const list = modules.get(definition.module) ?? [];
    list.push({
      key: definition.key,
      action: definition.action,
      description: definition.description,
      sensitive: definition.sensitive ?? false,
    });
    modules.set(definition.module, list);
  }

  return {
    modules: [...modules.entries()].map(([module, permissions]) => ({ module, permissions })),
    roles: roles.map((role) => {
      const grantedKeys = role.permissions.map((entry) => entry.permission.key).sort();
      return {
        roleId: role.id,
        key: role.key,
        name: role.name,
        level: role.level,
        scope: role.scope,
        isSystem: role.isSystem,
        userCount: role._count.userRoles,
        grantedKeys,
        staleKeys: grantedKeys.filter((key) => !isKnownPermission(key)),
      };
    }),
  };
}

function assertLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > 100) {
    throw new ValidationError([
      { path: 'level', message: 'A role level must be a whole number between 1 and 100' },
    ]);
  }
}

