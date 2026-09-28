/**
 * Reading and writing settings.
 *
 * Resolution is branch -> organisation -> registry default, so a branch override
 * is optional and a missing row is never an error. Values are validated against
 * the registry schema on BOTH write and read: a row written by an older version
 * of the code, or edited by hand in psql, must not crash a request or silently
 * feed a bad threshold into an attendance calculation -- it falls back to the
 * default and logs.
 *
 * A short per-request cache avoids re-querying the same setting inside one
 * invoice run. It is intentionally tiny and time-bounded rather than a
 * process-lifetime cache, so a settings change takes effect within seconds
 * without a deploy.
 */

import { prisma, type Db } from '@/server/db/client';
import { logger } from '@/server/observability/logger';
import {
  ALL_SETTINGS,
  SETTINGS_REGISTRY,
  settingByKey,
  type SettingName,
  type SettingValue,
} from '@/server/settings/registry';

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** Keyed by `${organizationId}:${branchId ?? '-'}:${settingKey}`. */
const cache = new Map<string, CacheEntry>();

function cacheKey(organizationId: string, branchId: string | null, key: string): string {
  return `${organizationId}:${branchId ?? '-'}:${key}`;
}

/** Drop cached values. Called after any write so a change is visible at once. */
export function invalidateSettingsCache(organizationId?: string): void {
  if (!organizationId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${organizationId}:`)) cache.delete(key);
  }
}

export interface SettingsScope {
  readonly organizationId: string;
  /** When given, a branch-level override takes precedence. */
  readonly branchId?: string | null;
}

/**
 * Read one setting. Always returns a valid value of the declared type: a stored
 * row that fails validation is discarded in favour of the default.
 */
export async function getSetting<K extends SettingName>(
  name: K,
  scope: SettingsScope,
  db: Db = prisma,
): Promise<SettingValue<K>> {
  const definition = SETTINGS_REGISTRY[name];
  const branchId = definition.scope === 'ORGANIZATION_ONLY' ? null : (scope.branchId ?? null);
  const key = cacheKey(scope.organizationId, branchId, definition.key);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as SettingValue<K>;
  }

  // Fetch the branch override and the organisation default in one query, then
  // prefer the branch row. Two round trips would be wasteful on a hot path.
  const rows = await db.setting.findMany({
    where: {
      organizationId: scope.organizationId,
      key: definition.key,
      // Prisma cannot express an `in` list containing null, so the branch
      // override and the organisation default are fetched with an explicit OR.
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : { branchId: null }),
    },
    select: { branchId: true, value: true },
  });

  const branchRow = branchId ? rows.find((row) => row.branchId === branchId) : undefined;
  const orgRow = rows.find((row) => row.branchId === null);
  const chosen = branchRow ?? orgRow;

  let value = definition.defaultValue as SettingValue<K>;
  if (chosen) {
    const parsed = definition.schema.safeParse(chosen.value);
    if (parsed.success) {
      value = parsed.data as SettingValue<K>;
    } else {
      logger.warn('settings.invalid_stored_value', {
        settingKey: definition.key,
        organizationId: scope.organizationId,
        branchId,
        issues: parsed.error.issues.map((issue) => issue.message),
        action: 'falling back to the registry default',
      });
    }
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Read several settings at once. Preferred inside a service, because it makes one
 * query instead of N.
 */
export async function getSettings<K extends SettingName>(
  names: readonly K[],
  scope: SettingsScope,
  db: Db = prisma,
): Promise<{ [P in K]: SettingValue<P> }> {
  const definitions = names.map((name) => ({ name, definition: SETTINGS_REGISTRY[name] }));
  const branchId = scope.branchId ?? null;

  const rows = await db.setting.findMany({
    where: {
      organizationId: scope.organizationId,
      key: { in: definitions.map((entry) => entry.definition.key) },
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : { branchId: null }),
    },
    select: { key: true, branchId: true, value: true },
  });

  const out = {} as { [P in K]: SettingValue<P> };
  for (const { name, definition } of definitions) {
    const effectiveBranch = definition.scope === 'ORGANIZATION_ONLY' ? null : branchId;
    const candidates = rows.filter((row) => row.key === definition.key);
    const chosen =
      (effectiveBranch ? candidates.find((row) => row.branchId === effectiveBranch) : undefined) ??
      candidates.find((row) => row.branchId === null);

    let value = definition.defaultValue;
    if (chosen) {
      const parsed = definition.schema.safeParse(chosen.value);
      if (parsed.success) {
        value = parsed.data;
      } else {
        logger.warn('settings.invalid_stored_value', {
          settingKey: definition.key,
          organizationId: scope.organizationId,
          branchId: effectiveBranch,
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowed by K
    (out as any)[name] = value;
    cache.set(cacheKey(scope.organizationId, effectiveBranch, definition.key), {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }
  return out;
}

export interface SettingWriteResult {
  readonly key: string;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly branchId: string | null;
}

/**
 * Write one setting, returning the before/after pair so the caller can record an
 * audit entry. Validation happens here; an invalid value is rejected rather than
 * stored for a later reader to trip over.
 *
 * Does NOT itself write to the audit log -- the calling use-case does, because it
 * knows the actor and the reason. See src/server/services/settings.
 */
export async function setSetting<K extends SettingName>(
  name: K,
  value: unknown,
  scope: SettingsScope & { updatedById: string | null },
  db: Db = prisma,
): Promise<SettingWriteResult> {
  const definition = SETTINGS_REGISTRY[name];
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid value for setting "${definition.key}": ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  if (definition.scope === 'ORGANIZATION_ONLY' && scope.branchId) {
    throw new Error(
      `Setting "${definition.key}" cannot be overridden per branch; it must be set for the whole organisation.`,
    );
  }

  const branchId = definition.scope === 'ORGANIZATION_ONLY' ? null : (scope.branchId ?? null);

  const existing = await db.setting.findUnique({
    where: {
      organizationId_branchId_key: {
        organizationId: scope.organizationId,
        branchId: branchId as string, // Prisma types a nullable compound member as string
        key: definition.key,
      },
    },
    select: { value: true },
  });

  await db.setting.upsert({
    where: {
      organizationId_branchId_key: {
        organizationId: scope.organizationId,
        branchId: branchId as string,
        key: definition.key,
      },
    },
    create: {
      organizationId: scope.organizationId,
      branchId,
      key: definition.key,
      scope: branchId ? 'BRANCH' : 'ORGANIZATION',
      value: parsed.data as never,
      updatedById: scope.updatedById,
    },
    update: {
      value: parsed.data as never,
      updatedById: scope.updatedById,
    },
  });

  invalidateSettingsCache(scope.organizationId);

  return {
    key: definition.key,
    previousValue: existing?.value ?? definition.defaultValue,
    newValue: parsed.data,
    branchId,
  };
}

/** Remove a branch override so the organisation default applies again. */
export async function clearBranchOverride<K extends SettingName>(
  name: K,
  scope: { organizationId: string; branchId: string },
  db: Db = prisma,
): Promise<void> {
  const definition = SETTINGS_REGISTRY[name];
  await db.setting.deleteMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      key: definition.key,
    },
  });
  invalidateSettingsCache(scope.organizationId);
}

/**
 * Every setting with its effective value and where that value came from. Powers
 * the settings screens, which show whether a value is inherited or overridden.
 */
export interface EffectiveSetting {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly scope: 'ORGANIZATION_ONLY' | 'BRANCH_OVERRIDABLE';
  readonly sensitive: boolean;
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly source: 'default' | 'organization' | 'branch';
}

export async function listEffectiveSettings(
  scope: SettingsScope,
  db: Db = prisma,
): Promise<EffectiveSetting[]> {
  const branchId = scope.branchId ?? null;
  const rows = await db.setting.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : { branchId: null }),
    },
    select: { key: true, branchId: true, value: true },
  });

  return ALL_SETTINGS.map((definition) => {
    const candidates = rows.filter((row) => row.key === definition.key);
    const effectiveBranch = definition.scope === 'ORGANIZATION_ONLY' ? null : branchId;
    const branchRow = effectiveBranch
      ? candidates.find((row) => row.branchId === effectiveBranch)
      : undefined;
    const orgRow = candidates.find((row) => row.branchId === null);

    let value: unknown = definition.defaultValue;
    let source: EffectiveSetting['source'] = 'default';
    for (const [row, rowSource] of [
      [orgRow, 'organization'] as const,
      [branchRow, 'branch'] as const,
    ]) {
      if (!row) continue;
      const parsed = definition.schema.safeParse(row.value);
      if (parsed.success) {
        value = parsed.data;
        source = rowSource;
      }
    }

    return {
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      scope: definition.scope,
      sensitive: definition.sensitive ?? false,
      value,
      defaultValue: definition.defaultValue,
      source,
    };
  });
}

/** Validate an arbitrary key/value pair coming from the settings form. */
export function validateSettingInput(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  const definition = settingByKey(key);
  if (!definition) return { ok: false, errors: [`Unknown setting "${key}"`] };
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message) };
  }
  return { ok: true, value: parsed.data };
}

export { SETTINGS_REGISTRY, ALL_SETTINGS } from '@/server/settings/registry';
export type { SettingName, SettingValue } from '@/server/settings/registry';
