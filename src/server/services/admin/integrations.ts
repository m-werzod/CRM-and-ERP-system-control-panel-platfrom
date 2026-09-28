/**
 * The integrations settings screen.
 *
 * The one rule this file exists to enforce: REPORT WHAT IS TRUE. Every provider
 * module already exposes a `describe*()` that answers honestly — including the
 * awkward answers: the mock face provider is configured and performs no
 * recognition, the console messaging driver reports every send as delivered and
 * delivers nothing, SMTP is selectable in this build but cannot run. This service
 * joins those runtime answers to the stored `IntegrationConfig` rows and hands
 * both to the UI, so a badge can never say "working" about something that is not.
 *
 * The RUNTIME answer is authoritative, not the stored row. `IntegrationConfig`
 * records what an operator saved; which provider actually serves a request is
 * decided by `env` at module load. When the two disagree — a row saying Payme
 * while the deployment runs `manual` — both are reported, because that
 * disagreement is exactly the misconfiguration an administrator is looking for.
 *
 * SECRETS NEVER GO IN `config`. Credentials live in environment variables and the
 * database stores only the NAME of the variable, in `secretRefs`. A token in a
 * JSON column is readable by anyone with database access, survives in every
 * backup, and is one careless `select *` away from a log line — whereas a name is
 * worthless on its own. `assertNoSecretsInConfig` below refuses the write rather
 * than trusting the caller to have remembered.
 */

import { Prisma } from '@/generated/prisma/client';
import type {
  DocumentOwnerType,
  IntegrationKind,
  IntegrationStatus,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import { BusinessRuleError, isAppError, ValidationError } from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { logger } from '@/server/observability/logger';
import { describeFaceProvider } from '@/server/integrations/face';
import { describeMessagingProviders } from '@/server/integrations/messaging';
import { describePaymentProvider } from '@/server/integrations/payments';
import { generateStorageKey, getStorage } from '@/server/storage';
import { getQueue } from '@/server/jobs';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface IntegrationStatusRow {
  readonly kind: IntegrationKind;
  /** The provider this deployment actually runs, from `env`. */
  readonly activeProvider: string;
  /** The provider recorded in `IntegrationConfig`, when a row exists. */
  readonly savedProvider: string | null;
  readonly isEnabled: boolean;
  /** Derived from the runtime, not copied from the stored row. */
  readonly status: IntegrationStatus;
  readonly configured: boolean;
  /** What is missing, or what this driver will and will not do. */
  readonly message: string | null;
  /**
   * True when the saved provider differs from the one actually running, which
   * means the screen is describing a deployment that was never redeployed.
   */
  readonly savedProviderMismatch: boolean;
  readonly config: Record<string, unknown> | null;
  /** Names of environment variables, never values. */
  readonly secretRefs: Record<string, string> | null;
  readonly lastCheckedAt: Date | null;
  readonly lastError: string | null;
  /**
   * FACE_RECOGNITION only. False for the mock provider: it answers every call and
   * matches nobody. A screen that shows "configured" without this is lying.
   */
  readonly isRealRecognition?: boolean;
  /** Extra provider facts worth showing, e.g. whether checkout is supported. */
  readonly details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every integration point with its live state.
 *
 * The `describe*()` calls are documented as configuration-only and non-throwing,
 * so this is cheap enough to run while rendering a settings page. Storage is the
 * exception: `StorageProvider` has no `health()`, so its state is established by
 * asking whether one freshly generated (and therefore certainly absent) key
 * exists. That answers "can this driver be reached at all" without writing
 * anything or revealing another tenant's object.
 */
export async function listIntegrationStatus(
  ctx: AccessContext,
  db?: Db,
): Promise<readonly IntegrationStatusRow[]> {
  requirePermission(ctx, 'settings.view');

  const client = db ?? prisma;
  const [saved, face, messaging, payments, storage] = await Promise.all([
    client.integrationConfig.findMany({
      where: organizationFilter(ctx),
      select: {
        kind: true,
        provider: true,
        isEnabled: true,
        status: true,
        config: true,
        secretRefs: true,
        lastCheckedAt: true,
        lastError: true,
      },
    }),
    describeFaceProvider(),
    describeMessagingProviders(),
    describePaymentProvider(),
    probeStorage(ctx),
  ]);

  const byKind = new Map(saved.map((row) => [row.kind, row] as const));
  const rows: IntegrationStatusRow[] = [];

  rows.push(
    merge(byKind.get('FACE_RECOGNITION'), {
      kind: 'FACE_RECOGNITION',
      activeProvider: face.key,
      configured: face.configured,
      message: face.message ?? null,
      isRealRecognition: face.isRealRecognition,
      details: { isRealRecognition: face.isRealRecognition },
    }),
  );

  for (const channel of messaging) {
    rows.push(
      merge(byKind.get(channel.channel), {
        kind: channel.channel,
        activeProvider: channel.provider,
        configured: channel.configured,
        message: channel.message ?? null,
        // `delivery` is the honest half: CONSOLE and NONE are both "configured"
        // and neither reaches a recipient.
        details: { delivery: channel.delivery },
      }),
    );
  }

  rows.push(
    merge(byKind.get('PAYMENT_GATEWAY'), {
      kind: 'PAYMENT_GATEWAY',
      activeProvider: payments.key,
      configured: payments.configured,
      message: payments.message ?? null,
      details: {
        label: payments.label,
        supportsCheckout: payments.supportsCheckout,
        supportsWebhooks: payments.supportsWebhooks,
        webhookPath: payments.webhookPath,
        currencies: payments.currencies,
      },
    }),
  );

  rows.push(
    merge(byKind.get('STORAGE'), {
      kind: 'STORAGE',
      activeProvider: storage.driver,
      configured: storage.configured,
      message: storage.message,
      details: { driver: storage.driver },
    }),
  );

  const queue = getQueue();
  rows.push(
    merge(byKind.get('QUEUE'), {
      kind: 'QUEUE',
      activeProvider: queue.driver,
      configured: true,
      message:
        queue.driver === 'database'
          ? 'Database-backed queue. No external service is required.'
          : 'Redis queue selected. Connectivity is established on first use and is not probed here.',
      details: { driver: queue.driver },
    }),
  );

  return rows;
}

interface RuntimeFacts {
  readonly kind: IntegrationKind;
  readonly activeProvider: string;
  readonly configured: boolean;
  readonly message: string | null;
  readonly isRealRecognition?: boolean;
  readonly details?: Record<string, unknown>;
}

type SavedRow = {
  provider: string;
  isEnabled: boolean;
  status: IntegrationStatus;
  config: Prisma.JsonValue | null;
  secretRefs: Prisma.JsonValue | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
};

function merge(saved: SavedRow | undefined, runtime: RuntimeFacts): IntegrationStatusRow {
  // Enabled defaults to true when no row exists: the environment selected a
  // provider, so the integration IS on whether or not anyone saved a row.
  const isEnabled = saved?.isEnabled ?? true;

  return {
    kind: runtime.kind,
    activeProvider: runtime.activeProvider,
    savedProvider: saved?.provider ?? null,
    isEnabled,
    status: deriveStatus(isEnabled, runtime.configured, saved?.lastError ?? null),
    configured: runtime.configured,
    message: runtime.message,
    savedProviderMismatch: saved !== undefined && saved.provider !== runtime.activeProvider,
    config: asRecord(saved?.config ?? null),
    secretRefs: asStringRecord(saved?.secretRefs ?? null),
    lastCheckedAt: saved?.lastCheckedAt ?? null,
    lastError: saved?.lastError ?? null,
    ...(runtime.isRealRecognition === undefined
      ? {}
      : { isRealRecognition: runtime.isRealRecognition }),
    ...(runtime.details ? { details: runtime.details } : {}),
  };
}

/**
 * The status a badge should show. Derived here rather than read from the stored
 * column, because the stored column is what an operator last saved and cannot
 * know that a credential was removed from the environment afterwards.
 */
function deriveStatus(
  isEnabled: boolean,
  configured: boolean,
  lastError: string | null,
): IntegrationStatus {
  if (!isEnabled) return 'DISABLED';
  if (!configured) return 'NOT_CONFIGURED';
  if (lastError) return 'DEGRADED';
  return 'HEALTHY';
}

async function probeStorage(
  ctx: AccessContext,
): Promise<{ driver: string; configured: boolean; message: string | null }> {
  const storage = getStorage();
  // A freshly generated key is 128 bits of CSPRNG output, so it is certainly
  // absent: the call proves reachability without touching a real object.
  const probeKey = generateStorageKey({
    organizationId: ctx.organizationId,
    ownerType: 'ORGANIZATION' satisfies DocumentOwnerType,
  });

  try {
    await storage.exists(probeKey);
    return {
      driver: storage.name,
      configured: true,
      message:
        storage.name === 'local'
          ? 'Files are stored on the application server’s disk. Not suitable for more than one instance.'
          : 'Object storage responded.',
    };
  } catch (error) {
    // The driver's own message can name buckets, endpoints and credential paths,
    // so it goes to the log and not to the screen.
    logger.warn('integrations.storage_probe_failed', {
      organizationId: ctx.organizationId,
      driver: storage.name,
      error,
    });
    return {
      driver: storage.name,
      configured: false,
      message: isAppError(error)
        ? error.publicMessage
        : 'The storage driver could not be reached. Check its configuration.',
    };
  }
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function asStringRecord(value: Prisma.JsonValue | null): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SetIntegrationConfigInput {
  readonly kind: IntegrationKind;
  /** The provider key this organisation intends to use. */
  readonly provider: string;
  readonly isEnabled: boolean;
  /** Non-secret settings only. Rejected if it looks like it holds a credential. */
  readonly config?: Record<string, unknown> | null;
  /**
   * `{ settingName: 'ENV_VAR_NAME' }`. The NAME of the environment variable that
   * holds each credential — never the credential.
   */
  readonly secretRefs?: Record<string, string> | null;
}

/**
 * Save an organisation's intent for one integration point.
 *
 * Deliberately does NOT change which provider runs: that is an environment
 * variable read at module load, because a runtime-switchable payment gateway is a
 * way to start taking money through a provider nobody deployed credentials for.
 * The row records intent and non-secret settings; `listIntegrationStatus` reports
 * the disagreement when the two drift apart.
 */
export async function setIntegrationConfig(
  ctx: AccessContext,
  input: SetIntegrationConfigInput,
  db?: Db,
): Promise<IntegrationStatusRow> {
  requirePermission(ctx, 'settings.manageIntegrations');

  const config = input.config ?? null;
  const secretRefs = input.secretRefs ?? null;
  assertNoSecretsInConfig(config);
  assertSecretRefsAreNames(secretRefs);

  const provider = input.provider.trim();
  if (provider === '') {
    throw new ValidationError([{ path: 'provider', message: 'Required' }]);
  }

  await withTransaction(
    async (tx) => {
      const before = await tx.integrationConfig.findUnique({
        where: { organizationId_kind: { organizationId: ctx.organizationId, kind: input.kind } },
        select: { provider: true, isEnabled: true, status: true, config: true, secretRefs: true },
      });

      const status: IntegrationStatus = input.isEnabled ? 'CONFIGURED' : 'DISABLED';
      const data = {
        provider,
        isEnabled: input.isEnabled,
        status,
        config: toJsonColumn(config),
        secretRefs: toJsonColumn(secretRefs),
        updatedById: ctx.isSystem ? null : ctx.userId,
        // Cleared on save: whatever failure was recorded described the previous
        // configuration and would otherwise keep a red badge on a fixed setup.
        lastError: null,
      };

      await tx.integrationConfig.upsert({
        where: { organizationId_kind: { organizationId: ctx.organizationId, kind: input.kind } },
        create: { organizationId: ctx.organizationId, kind: input.kind, ...data },
        update: data,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.INTEGRATION_CONFIGURED,
          entityType: 'IntegrationConfig',
          entityId: input.kind,
          summary: `${input.kind} integration set to provider "${provider}"${input.isEnabled ? '' : ' (disabled)'}`,
          severity: 'NOTICE',
          changes: diffFields(
            {
              provider: before?.provider ?? null,
              isEnabled: before?.isEnabled ?? null,
              status: before?.status ?? null,
            },
            { provider, isEnabled: input.isEnabled, status },
          ),
          // Only the KEYS of `config` and the NAMES in `secretRefs`: an audit row
          // must not become the place a credential ends up either.
          metadata: {
            configKeys: config ? Object.keys(config) : [],
            secretRefNames: secretRefs ? Object.values(secretRefs) : [],
          },
        },
        tx,
      );
    },
    { existing: db },
  );

  // Re-read through the same path the UI uses, so the caller gets the derived
  // runtime status rather than the intent it just saved.
  const rows = await listIntegrationStatus(ctx, db);
  const row = rows.find((candidate) => candidate.kind === input.kind);
  if (!row) {
    // Every kind in the enum is produced by `listIntegrationStatus`; a miss means
    // a kind was added to the schema without a runtime describer.
    throw new BusinessRuleError(
      'integration.no_runtime_describer',
      `The ${input.kind} integration has no runtime status reporter yet.`,
    );
  }
  return row;
}

/**
 * Prisma distinguishes "leave this column alone" (`undefined`) from "store SQL
 * NULL" (`Prisma.DbNull`). Clearing an integration's settings has to mean the
 * second, or the old JSON survives a save that was meant to remove it.
 */
function toJsonColumn(
  value: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  // A JSON object is assignable to `Record<string, unknown>` but not the other
  // way round, so the narrowing cast is the direction TS cannot verify.
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/**
 * Keys that name a credential. A value under one of these is refused outright
 * rather than stored, because the alternative is discovering a live API key in a
 * JSON column during an incident.
 */
const SECRET_LIKE_KEY = /secret|token|password|passwd|credential|private|apikey|api_key|auth/i;

function assertNoSecretsInConfig(config: Record<string, unknown> | null): void {
  if (!config) return;

  const offending = Object.keys(config).filter((key) => SECRET_LIKE_KEY.test(key));
  if (offending.length > 0) {
    throw new BusinessRuleError(
      'integration.secret_in_config',
      `Credentials are not stored in the database. Put the value in an environment variable and name it in secretRefs instead of in config (${offending.join(', ')}).`,
      { details: { offendingKeys: offending } },
    );
  }

  // A nested object is refused rather than walked: a shallow allow-list cannot
  // promise anything about what is three levels down, and no integration needs
  // structured settings badly enough to make that promise.
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && typeof value === 'object') {
      throw new BusinessRuleError(
        'integration.nested_config',
        `Integration settings must be flat values. "${key}" is an object.`,
      );
    }
  }
}

/** An environment variable NAME: upper snake case, and nothing else. */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

function assertSecretRefsAreNames(secretRefs: Record<string, string> | null): void {
  if (!secretRefs) return;

  const issues: Array<{ path: string; message: string }> = [];
  for (const [setting, name] of Object.entries(secretRefs)) {
    if (typeof name !== 'string' || !ENV_VAR_NAME.test(name)) {
      // A shape check, not proof that it is not a secret — but a real token
      // almost never looks like an env var name, and this is the cheap gate that
      // catches somebody pasting one into the wrong field.
      issues.push({
        path: `secretRefs.${setting}`,
        message:
          'This must be the NAME of an environment variable (e.g. PAYME_MERCHANT_KEY), not the value itself',
      });
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}
