/**
 * The public face of the job system.
 *
 * Two things live here and nothing else: driver selection, and the `enqueue`
 * every caller should use.
 *
 * `enqueue` validates the payload against the job's registered schema BEFORE the
 * row is written. That ordering is the whole point. A payload that fails
 * validation at the call site produces a stack trace pointing at the service that
 * built it, during the request that caused it, while the developer is looking;
 * the same payload validated only by the worker produces a DEAD job at 03:00
 * whose origin nobody can reconstruct. The worker re-validates anyway (see
 * `register` in ./registry.ts) because a row may have been written by an older
 * deployment -- but by then it is a diagnosis, not a prevention.
 */

import type { z } from 'zod';
import { ValidationError } from '@/server/errors';
import { env } from '@/server/env';
import { toFieldIssues } from '@/lib/validation';
import type { Db } from '@/server/db/client';
import { DatabaseQueueProvider } from '@/server/jobs/database-queue';
import { RedisQueueProvider } from '@/server/jobs/redis-queue';
import { JOB_SPECS, type JobName, type JobSpecs } from '@/server/jobs/registry';
import type { EnqueueResult, QueueProvider } from '@/server/jobs/types';

/**
 * The payload as a CALLER writes it, which is not the same type the handler
 * receives: a spec whose schema has `.default(100)` accepts the field being
 * absent on the way in and guarantees it present on the way out. Using the output
 * type here would force every call site to supply values the schema exists to
 * fill in.
 */
export type JobPayloadInput<K extends JobName> = z.input<JobSpecs[K]['payloadSchema']>;

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

let cached: QueueProvider | null = null;

/**
 * The process-wide queue. Memoised because the database driver holds no state
 * worth duplicating and because `getQueue()` is called per enqueue -- on a
 * request path, in a loop.
 */
export function getQueue(): QueueProvider {
  if (cached) return cached;
  cached = env.QUEUE_DRIVER === 'redis' ? new RedisQueueProvider() : new DatabaseQueueProvider();
  return cached;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Earliest execution time. Mutually exclusive with `delayMs`. */
  readonly runAt?: Date;
  /** Convenience for `runAt = now + delayMs`. */
  readonly delayMs?: number;
  /** Overrides the spec's priority for this one job. */
  readonly priority?: number;
  /** Overrides the spec's attempt budget for this one job. */
  readonly maxAttempts?: number;
  readonly organizationId?: string | null;
  /**
   * Makes the enqueue itself idempotent. Namespace it -- the unique index is
   * global, so `invoice-reminder:<invoiceId>:<date>` is a key and `reminder` is a
   * collision waiting to happen.
   */
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly createdById?: string | null;
  /** Enqueue inside the caller's transaction, so the job commits with the work. */
  readonly db?: Db;
}

/**
 * Queue a declared job. The payload type is checked at compile time against the
 * job's schema, and its value at run time.
 */
export async function enqueue<K extends JobName>(
  name: K,
  payload: JobPayloadInput<K>,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  return enqueueByName(name, payload, options);
}

/**
 * The same thing for a name that is only known at run time -- a `CronSchedule`
 * row's `jobName`, or an operator re-queueing from a dashboard. The payload
 * cannot be type-checked against a name the compiler has not seen, so it is
 * typed `unknown` and validated against the schema resolved from the registry.
 * The validation is identical; only the compile-time guarantee is absent, which
 * is why ordinary code should call `enqueue` instead.
 */
export async function enqueueByName(
  name: JobName,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const spec = JOB_SPECS[name];
  if (!spec) {
    throw new ValidationError(
      [{ path: 'name', message: `"${name}" is not a declared job.` }],
      `"${name}" is not a declared job.`,
    );
  }

  const parsed = spec.payloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new ValidationError(
      toFieldIssues(parsed.error),
      `Job "${name}" was given a payload that does not match its schema.`,
    );
  }

  if (options.runAt && options.delayMs !== undefined) {
    throw new ValidationError(
      [{ path: 'runAt', message: 'Pass runAt or delayMs, not both.' }],
      'Pass runAt or delayMs, not both.',
    );
  }

  const runAt =
    options.runAt ??
    (options.delayMs === undefined ? undefined : new Date(Date.now() + options.delayMs));

  return getQueue().enqueue({
    name,
    // The PARSED payload is stored, not the input: defaults are materialised now,
    // so a job already in the queue keeps the values it was queued with even if
    // a later deployment changes what the default is.
    payload: parsed.data,
    // The queue is a property of the job's cost profile, not of the call site, so
    // it comes from the spec and is deliberately not overridable here.
    queue: spec.queue,
    maxAttempts: options.maxAttempts ?? spec.maxAttempts,
    priority: options.priority ?? spec.priority,
    runAt,
    organizationId: options.organizationId ?? null,
    idempotencyKey: options.idempotencyKey ?? null,
    requestId: options.requestId ?? null,
    createdById: options.createdById ?? null,
    db: options.db,
  });
}

/** Cancel a queued job that has not started. False when it is already running. */
export async function cancelJob(
  jobId: string,
  organizationId?: string | null,
): Promise<boolean> {
  return getQueue().cancel({ jobId, organizationId });
}

/**
 * Drop the memoised provider. For tests that switch `QUEUE_DRIVER`, and for
 * Next's HMR, which re-evaluates this module without restarting the process.
 */
export const __testing = {
  resetQueue: () => {
    cached = null;
  },
};

export { JOB_NAMES, JOB_QUEUES, ALL_JOB_QUEUES, type JobName, type JobQueue } from '@/server/jobs/registry';
export type { EnqueueResult, JobRecord, QueueProvider } from '@/server/jobs/types';
