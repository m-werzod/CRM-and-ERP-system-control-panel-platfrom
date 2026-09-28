/**
 * Prisma client singleton.
 *
 * Prisma 7 talks to PostgreSQL through a driver adapter rather than a bundled
 * query engine, so the pool is ours to configure. In development the module is
 * cached on `globalThis` because Next's HMR re-evaluates modules on every edit
 * and would otherwise open a new pool per keystroke until PostgreSQL refuses
 * connections.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/server/env';

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    // Serverless platforms give each lambda its own pool, so keep it small.
    // A long-lived Node server can afford more.
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Always interpret and store timestamps as UTC. Display-time conversion to
    // the organisation's timezone happens in src/lib/dates.ts.
    options: '-c timezone=UTC',
  });

  return new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === 'development'
        ? [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
        : [{ emit: 'stdout', level: 'error' }],
  });
}

declare global {
  // `var` is required, not a style slip: only a `var` declaration augments the
  // `globalThis` type. `let`/`const` in a declare-global block are block-scoped
  // and would not add the property.
  var __eduPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = globalThis.__eduPrisma ?? createClient();

if (env.NODE_ENV !== 'production') {
  globalThis.__eduPrisma = prisma;
}

/**
 * A transaction handle. Services accept this so that a use-case can be composed
 * into a larger transaction by its caller: `recordPayment` must be able to run
 * inside `convertLeadToStudent` without opening a nested transaction.
 */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/** Either an ambient transaction or the root client. */
export type Db = Tx | PrismaClient;

/**
 * Run `fn` inside a transaction, reusing `existing` when the caller already has
 * one. This is the only sanctioned way to open a transaction, so a use-case can
 * never accidentally split its writes across two transactions.
 *
 * `Serializable` is deliberate for money-moving work: `RepeatableRead` still
 * permits write skew, which is exactly the anomaly that lets two concurrent
 * payments each see an unpaid invoice and both mark it paid. Callers must be
 * prepared for a 40001 retry, which `mapDatabaseError` surfaces as a retryable
 * CONFLICT.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: {
    existing?: Db | null;
    isolation?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
    timeoutMs?: number;
    maxWaitMs?: number;
  } = {},
): Promise<T> {
  const { existing, isolation = 'ReadCommitted', timeoutMs = 15_000, maxWaitMs = 5_000 } = options;

  if (existing && isTransaction(existing)) {
    // Already inside a transaction: join it rather than nesting.
    return fn(existing);
  }

  const root = (existing as PrismaClient | undefined) ?? prisma;
  return root.$transaction(fn, {
    isolationLevel: isolation,
    timeout: timeoutMs,
    maxWait: maxWaitMs,
  });
}

/** A transaction client lacks `$transaction`; the root client has it. */
function isTransaction(db: Db): db is Tx {
  return typeof (db as PrismaClient).$transaction !== 'function';
}

/**
 * Run `fn` with the append-only guard lifted for the current transaction.
 *
 * ONLY two operations may use this: purging a tenant (a hard Organization
 * delete cascades into `ledger_entries` and `audit_logs`) and test teardown.
 * `SET LOCAL` means the permission dies with the transaction. Never call this
 * from a request handler.
 */
export async function withHistoryMutationAllowed<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRawUnsafe(`set local app.allow_history_mutation = 'on'`);
  return fn();
}

/** Serializable retry helper for the money paths. */
export async function withSerializableRetry<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { existing?: Db | null; attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withTransaction(fn, { existing: options.existing, isolation: 'Serializable' });
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      const retryable = code === 'P2034' || code === '40001' || code === '40P01';
      if (!retryable || attempt === attempts) throw error;
      // Small randomised backoff so two colliding writers do not re-collide.
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
    }
  }
  throw lastError;
}
