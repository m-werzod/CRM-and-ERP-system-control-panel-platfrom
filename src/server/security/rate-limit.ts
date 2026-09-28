/**
 * Rate limiting.
 *
 * A pluggable fixed-window counter with three drivers:
 *   memory    per-process. Correct only for a single instance; used in tests.
 *   database  durable and shared across instances with no extra infrastructure.
 *             The default.
 *   redis     the same interface, for deployments that already run Redis.
 *
 * Fixed windows are chosen over a sliding log because a limiter must be cheaper
 * than the work it protects. The known weakness -- up to 2x the limit across a
 * window boundary -- is acceptable for abuse prevention, and the brute-force
 * defence that actually matters (account lockout) is enforced separately and
 * counts attempts per account, not per window.
 */

import { env } from '@/server/env';
import { prisma } from '@/server/db/client';
import { logger } from '@/server/observability/logger';

export type RateLimitSubject = 'ip' | 'user' | 'organization' | 'global';

export interface RateLimitRule {
  /** Stable name, used as the counter key prefix and in logs. */
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** What the limit is counted against. */
  readonly by: RateLimitSubject;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitContext {
  readonly ipAddress: string | null;
  readonly userId: string | null;
  readonly organizationId: string | null;
}

/** The standard rules. Routes reference these rather than inventing numbers. */
export const RATE_LIMITS = {
  /**
   * Deliberately generous per IP, because a whole school shares one NAT address.
   * Per-account brute force is stopped by lockout, not by this.
   */
  login: { key: 'auth.login', limit: 30, windowSeconds: 300, by: 'ip' },
  passwordResetRequest: { key: 'auth.password_reset', limit: 5, windowSeconds: 900, by: 'ip' },
  twoFactorVerify: { key: 'auth.two_factor', limit: 10, windowSeconds: 300, by: 'user' },
  /** Public lead capture from the website: the most abusable endpoint. */
  publicLeadCapture: { key: 'crm.public_lead', limit: 10, windowSeconds: 3600, by: 'ip' },
  /** Money-moving writes, per user. */
  financialWrite: { key: 'finance.write', limit: 120, windowSeconds: 60, by: 'user' },
  /** Bulk operations are expensive; keep them to a trickle. */
  bulkImport: { key: 'data.import', limit: 5, windowSeconds: 3600, by: 'user' },
  export: { key: 'data.export', limit: 30, windowSeconds: 3600, by: 'user' },
  /** Ordinary authenticated writes. */
  write: { key: 'api.write', limit: 300, windowSeconds: 60, by: 'user' },
  /** Attendance device polling. */
  devicePost: { key: 'attendance.device', limit: 600, windowSeconds: 60, by: 'global' },
  search: { key: 'search.global', limit: 120, windowSeconds: 60, by: 'user' },
  notificationSend: { key: 'notification.send', limit: 60, windowSeconds: 3600, by: 'user' },
} as const satisfies Record<string, RateLimitRule>;

/** Build the counter key. An unidentifiable subject falls back to a shared bucket. */
function counterKey(rule: RateLimitRule, context: RateLimitContext): string {
  switch (rule.by) {
    case 'ip':
      // A missing IP (no proxy configured) must not mean "unlimited": everyone
      // shares one bucket instead, which is restrictive but safe.
      return `${rule.key}:ip:${context.ipAddress ?? 'unknown'}`;
    case 'user':
      return `${rule.key}:user:${context.userId ?? context.ipAddress ?? 'unknown'}`;
    case 'organization':
      return `${rule.key}:org:${context.organizationId ?? 'unknown'}`;
    case 'global':
      return `${rule.key}:global`;
  }
}

interface RateLimitDriver {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitVerdict>;
  reset(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// memory driver
// ---------------------------------------------------------------------------

interface MemoryEntry {
  count: number;
  windowStart: number;
}

const memoryStore = new Map<string, MemoryEntry>();

const memoryDriver: RateLimitDriver = {
  async consume(key, limit, windowSeconds) {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = memoryStore.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      memoryStore.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    entry.count += 1;
    if (entry.count > limit) {
      const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }
    return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 };
  },

  async reset(key) {
    memoryStore.delete(key);
  },
};

/** Keep the map from growing without bound in a long-lived process. */
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memoryStore) {
      // Any entry older than the longest window we define is dead.
      if (now - entry.windowStart > 3_600_000) memoryStore.delete(key);
    }
  }, 300_000);
  // Do not hold the process open just for cleanup.
  if (typeof timer.unref === 'function') timer.unref();
}

// ---------------------------------------------------------------------------
// database driver
// ---------------------------------------------------------------------------

const databaseDriver: RateLimitDriver = {
  async consume(key, limit, windowSeconds) {
    const now = new Date();
    const windowMs = windowSeconds * 1000;

    // One statement, atomic under concurrency: insert the counter, or bump it and
    // roll the window over if the stored one has expired. Read-then-write would
    // let two simultaneous requests both see count = limit - 1.
    const rows = await prisma.$queryRaw<Array<{ count: number; windowStart: Date }>>`
      insert into "rate_limit_counters" ("id", "key", "windowStart", "count", "expiresAt", "updatedAt")
      values (gen_random_uuid()::text, ${key}, ${now}, 1, ${new Date(now.getTime() + windowMs)}, ${now})
      on conflict ("key") do update set
        "count" = case
                    when "rate_limit_counters"."windowStart" + make_interval(secs => ${windowSeconds}::double precision) <= ${now}
                    then 1
                    else "rate_limit_counters"."count" + 1
                  end,
        "windowStart" = case
                    when "rate_limit_counters"."windowStart" + make_interval(secs => ${windowSeconds}::double precision) <= ${now}
                    then ${now}
                    else "rate_limit_counters"."windowStart"
                  end,
        "expiresAt" = case
                    when "rate_limit_counters"."windowStart" + make_interval(secs => ${windowSeconds}::double precision) <= ${now}
                    then ${new Date(now.getTime() + windowMs)}
                    else "rate_limit_counters"."expiresAt"
                  end,
        "updatedAt" = ${now}
      returning "count", "windowStart"
    `;

    const row = rows[0];
    if (!row) {
      // Should be unreachable; failing open here is the lesser evil versus
      // locking every user out because the counter table is unavailable.
      logger.error('rate_limit.no_row_returned', { key });
      return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
    }

    if (row.count > limit) {
      const retryAfterSeconds = Math.ceil(
        (row.windowStart.getTime() + windowMs - now.getTime()) / 1000,
      );
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }
    return { allowed: true, remaining: limit - row.count, retryAfterSeconds: 0 };
  },

  async reset(key) {
    await prisma.rateLimitCounter.deleteMany({ where: { key } });
  },
};

// ---------------------------------------------------------------------------
// redis driver (interface boundary only)
// ---------------------------------------------------------------------------

/**
 * Not implemented: REDIS_URL is validated by env.ts but no client is bundled, and
 * shipping a fake would be worse than an honest gap. Selecting this driver fails
 * loudly at the first request rather than silently letting traffic through.
 */
const redisDriver: RateLimitDriver = {
  async consume() {
    throw new Error(
      'RATE_LIMIT_DRIVER=redis is not implemented. Use "database" (the default), or add a Redis client in src/server/security/rate-limit.ts.',
    );
  },
  async reset() {
    throw new Error('RATE_LIMIT_DRIVER=redis is not implemented.');
  },
};

function selectDriver(): RateLimitDriver {
  switch (env.RATE_LIMIT_DRIVER) {
    case 'memory':
      return memoryDriver;
    case 'redis':
      return redisDriver;
    case 'database':
    default:
      return databaseDriver;
  }
}

const driver = selectDriver();

export async function consumeRateLimit(
  rule: RateLimitRule,
  context: RateLimitContext,
): Promise<RateLimitVerdict> {
  const key = counterKey(rule, context);
  try {
    return await driver.consume(key, rule.limit, rule.windowSeconds);
  } catch (error) {
    // A broken limiter must not take the application down. Allow the request but
    // record it loudly -- a silent limiter failure is a real incident.
    logger.error('rate_limit.driver_failed', { key, rule: rule.key, error });
    return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
  }
}

export async function resetRateLimit(
  rule: RateLimitRule,
  context: RateLimitContext,
): Promise<void> {
  await driver.reset(counterKey(rule, context));
}

/** Housekeeping for the database driver. Run from cron. */
export async function pruneRateLimitCounters(): Promise<number> {
  const result = await prisma.rateLimitCounter.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/** Exposed so unit tests can exercise the memory driver directly. */
export const __testing = { memoryDriver, memoryStore, counterKey };
