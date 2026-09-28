/**
 * The settings screens.
 *
 * `@/server/settings` already owns resolution (branch -> organisation ->
 * registry default), validation and the cache. This file adds only the three
 * things a service must: the permission decision, the audit trail, and a shape
 * the UI can render.
 *
 * WHICH PERMISSION depends on the setting. A finance setting is guarded by
 * `settings.manageFinance`, an attendance threshold by
 * `settings.manageAttendanceRules`, and so on — because an accountant who may
 * change the payment window has no business changing the late-arrival threshold
 * that drives teachers' attendance marking. The mapping is a table below rather
 * than a check per call site, so a setting added to the registry cannot end up
 * with no guard at all.
 *
 * EVERY change is audited at NOTICE with the old and the new value. A settings
 * row is a business rule: "why did last month's invoices use a 14-day window"
 * has to be answerable, and it only is if the change left a record.
 */

import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  can,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import {
  SETTINGS_REGISTRY,
  clearBranchOverride,
  listEffectiveSettings,
  setSetting,
  validateSettingInput,
  type EffectiveSetting,
  type SettingName,
} from '@/server/settings';

// ---------------------------------------------------------------------------
// Group -> permission
// ---------------------------------------------------------------------------

/**
 * Which permission governs each settings group.
 *
 * `crm`, `notifications` and `security` have no dedicated key in the catalogue,
 * so they fall to `settings.manageOrganization` — the permission an operator who
 * runs the institution's configuration already holds. Inventing new keys here
 * would produce permissions nothing seeds and nobody can be granted, which is a
 * silently-closed door rather than a guard.
 */
const PERMISSION_BY_GROUP: Record<string, PermissionKey> = {
  attendance: 'settings.manageAttendanceRules',
  finance: 'settings.manageFinance',
  academic: 'settings.manageAcademicYear',
  locale: 'settings.manageOrganization',
  crm: 'settings.manageOrganization',
  notifications: 'settings.manageOrganization',
  security: 'settings.manageOrganization',
};

function permissionForGroup(group: string): PermissionKey {
  // Fail closed: a group added to the registry without a row above lands on the
  // most restrictive key we have rather than on no check.
  return PERMISSION_BY_GROUP[group] ?? 'settings.manageOrganization';
}

/**
 * Registry property name for a stored key. `setSetting` is keyed by the property
 * (`paymentDueDays`) while the UI, the audit log and the `settings` table all
 * speak the stored key (`finance.paymentDueDays`), so the two have to be bridged
 * exactly once.
 */
const SETTING_NAME_BY_KEY: ReadonlyMap<string, SettingName> = new Map(
  (Object.keys(SETTINGS_REGISTRY) as SettingName[]).map((name) => [
    SETTINGS_REGISTRY[name].key,
    name,
  ]),
);

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface SettingRowForUi extends EffectiveSetting {
  /** False when the caller lacks the permission that governs this group. */
  readonly editable: boolean;
  /** True when this value comes from a branch override rather than inherited. */
  readonly overridden: boolean;
  readonly permission: PermissionKey;
}

export interface SettingGroupForUi {
  readonly group: string;
  readonly permission: PermissionKey;
  readonly settings: readonly SettingRowForUi[];
}

export interface SettingsForUi {
  /** Null when viewing the organisation-wide values. */
  readonly branchId: string | null;
  readonly groups: readonly SettingGroupForUi[];
}

/**
 * Every setting with its effective value, where that value came from, and whether
 * this caller may change it.
 *
 * `source` is passed straight through from `listEffectiveSettings` because the
 * distinction matters on screen: an operator editing a branch needs to see that
 * a value is inherited from the organisation before they pin a copy of it to the
 * branch and stop tracking future changes.
 */
export async function getSettingsForUi(
  ctx: AccessContext,
  input: { readonly branchId?: string | null } = {},
  db?: Db,
): Promise<SettingsForUi> {
  requirePermission(ctx, 'settings.view');

  const branchId = input.branchId ?? null;
  if (branchId) assertBranchAccess(ctx, branchId, 'settings');

  const effective = await listEffectiveSettings(
    { organizationId: ctx.organizationId, branchId },
    db ?? prisma,
  );

  const groups = new Map<string, SettingRowForUi[]>();
  for (const setting of effective) {
    const permission = permissionForGroup(setting.group);
    const rows = groups.get(setting.group) ?? [];
    rows.push({
      ...setting,
      permission,
      overridden: setting.source === 'branch',
      // An ORGANIZATION_ONLY setting is never editable from a branch view, whatever
      // the caller holds: `setSetting` refuses it, so offering the field would be
      // an input that cannot be saved.
      editable:
        can(ctx, permission) && !(setting.scope === 'ORGANIZATION_ONLY' && branchId !== null),
    });
    groups.set(setting.group, rows);
  }

  // Display order follows the registry's own composition order, so the screens
  // and the file a developer edits agree.
  return {
    branchId,
    groups: [...groups.entries()].map(([group, settings]) => ({
      group,
      permission: permissionForGroup(group),
      settings,
    })),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SettingChangeInput {
  /** The stored key, e.g. `finance.paymentDueDays`. */
  readonly key: string;
  readonly value: unknown;
}

export interface UpdateSettingsInput {
  readonly changes: readonly SettingChangeInput[];
  /** When set, the values are written as branch overrides. */
  readonly branchId?: string | null;
  readonly reason?: string | null;
}

export interface AppliedSettingChange {
  readonly key: string;
  readonly group: string;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly sensitive: boolean;
  readonly branchId: string | null;
}

/**
 * Apply a set of setting changes.
 *
 * All of them in one transaction: a settings form is submitted as a unit, and
 * half-applied business rules (a tax rate changed but not the rate it depends on)
 * are worse than a rejected form.
 */
export async function updateSettings(
  ctx: AccessContext,
  input: UpdateSettingsInput,
  db?: Db,
): Promise<{ applied: readonly AppliedSettingChange[] }> {
  // The group-specific permissions are checked below, once the keys are known;
  // this is the gate that stops anybody without settings access getting even the
  // "which keys exist" information an error message would leak.
  requirePermission(ctx, 'settings.view');

  const branchId = input.branchId ?? null;
  if (branchId) assertBranchAccess(ctx, branchId, 'settings');

  if (input.changes.length === 0) return { applied: [] };

  // The registry metadata comes from the same call the UI reads, so a key the
  // screen offered is a key this accepts.
  const definitions = new Map(
    (await listEffectiveSettings({ organizationId: ctx.organizationId, branchId }, db ?? prisma)).map(
      (setting) => [setting.key, setting] as const,
    ),
  );

  const issues: Array<{ path: string; message: string }> = [];
  const planned: Array<{
    key: string;
    name: SettingName;
    definition: EffectiveSetting;
    value: unknown;
  }> = [];

  for (const change of input.changes) {
    const definition = definitions.get(change.key);
    const name = SETTING_NAME_BY_KEY.get(change.key);
    if (!definition || !name) {
      issues.push({ path: change.key, message: `"${change.key}" is not a known setting` });
      continue;
    }
    if (definition.scope === 'ORGANIZATION_ONLY' && branchId !== null) {
      throw new BusinessRuleError(
        'setting.not_branch_overridable',
        `"${definition.label}" must be the same across the whole organisation; it cannot be set per branch.`,
        { details: { key: change.key } },
      );
    }

    const validated = validateSettingInput(change.key, change.value);
    if (!validated.ok) {
      for (const message of validated.errors) issues.push({ path: change.key, message });
      continue;
    }
    planned.push({ key: change.key, name, definition, value: validated.value });
  }

  // Every key validated before anything is written: a form with one bad field
  // must not leave the other fields applied.
  if (issues.length > 0) throw new ValidationError(issues);

  // One permission check per distinct group rather than per key.
  for (const group of new Set(planned.map((entry) => entry.definition.group))) {
    requirePermission(ctx, permissionForGroup(group));
  }

  return withTransaction(
    async (tx) => {
      const applied: AppliedSettingChange[] = [];

      for (const entry of planned) {
        const written = await setSetting(
          entry.name,
          entry.value,
          {
            organizationId: ctx.organizationId,
            branchId,
            updatedById: ctx.isSystem ? null : ctx.userId,
          },
          tx,
        );

        await recordAudit(
          ctx,
          {
            action: AUDIT_ACTIONS.SETTING_CHANGED,
            entityType: 'Setting',
            entityId: entry.key,
            branchId,
            summary: `${entry.definition.label} changed${branchId ? ' for one branch' : ''}`,
            reason: input.reason ?? null,
            // NOTICE for every setting, sensitive or not: the value itself is
            // the business rule, and an auditor reading the log needs the pair.
            severity: 'NOTICE',
            changes: { value: { from: written.previousValue, to: written.newValue } },
            metadata: { settingKey: entry.key, sensitive: entry.definition.sensitive },
          },
          tx,
        );

        applied.push({
          key: entry.key,
          group: entry.definition.group,
          previousValue: written.previousValue,
          newValue: written.newValue,
          sensitive: entry.definition.sensitive,
          branchId: written.branchId,
        });
      }

      return { applied };
    },
    { existing: db },
  );
}

/**
 * Drop a stored value so the inherited one applies again.
 *
 * With a `branchId` this removes the branch override and the organisation value
 * takes over; without one it removes the organisation row and the registry
 * default takes over. Deleting rather than writing the default back is what keeps
 * "inherited" and "explicitly set to the same value" distinguishable on screen.
 */
export async function resetSettingToDefault(
  ctx: AccessContext,
  input: { readonly key: string; readonly branchId?: string | null },
  db?: Db,
): Promise<{ key: string; branchId: string | null; value: unknown }> {
  requirePermission(ctx, 'settings.view');

  const branchId = input.branchId ?? null;
  if (branchId) assertBranchAccess(ctx, branchId, 'settings');

  const name = SETTING_NAME_BY_KEY.get(input.key);
  if (!name) throw new NotFoundError('Setting', input.key);

  return withTransaction(
    async (tx) => {
      const before = (
        await listEffectiveSettings({ organizationId: ctx.organizationId, branchId }, tx)
      ).find((setting) => setting.key === input.key);
      if (!before) throw new NotFoundError('Setting', input.key);

      requirePermission(ctx, permissionForGroup(before.group));

      if (branchId) {
        await clearBranchOverride(name, { organizationId: ctx.organizationId, branchId }, tx);
      } else {
        await tx.setting.deleteMany({
          where: { organizationId: ctx.organizationId, branchId: null, key: input.key },
        });
      }

      const after = (
        await listEffectiveSettings({ organizationId: ctx.organizationId, branchId }, tx)
      ).find((setting) => setting.key === input.key);

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.SETTING_CHANGED,
          entityType: 'Setting',
          entityId: input.key,
          branchId,
          summary: `${before.label} reset to its ${branchId ? 'organisation' : 'default'} value`,
          severity: 'NOTICE',
          changes: { value: { from: before.value, to: after?.value ?? before.defaultValue } },
          metadata: { settingKey: input.key, sensitive: before.sensitive },
        },
        tx,
      );

      return {
        key: input.key,
        branchId,
        value: after?.value ?? before.defaultValue,
      };
    },
    { existing: db },
  );
}
