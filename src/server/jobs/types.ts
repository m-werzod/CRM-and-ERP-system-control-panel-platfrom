/**
 * Background job contracts.
 *
 * The queue is an interface rather than a single implementation for one reason:
 * the default driver is the `jobs` table, which needs no infrastructure beyond
 * the PostgreSQL instance we already run, and a deployment that outgrows it must
 * be able to move to Redis without a single handler changing. Everything in this
 * file is therefore driver-agnostic -- nothing here knows about SQL.
 *
 * Two invariants shape every signature below:
 *
 *  1. A handler may run more than once. Leases expire, workers are killed
 *     mid-deploy, and a network failure between "handler finished" and
 *     "row marked COMPLETED" is indistinguishable from "handler never ran". The
 *     queue therefore promises at-least-once delivery and handlers must be
 *     idempotent. Anything that must happen exactly once needs its own
 *     idempotency key (`Notification.dedupeKey`, `Payment.idempotencyKey`).
 *
 *  2. A payload crosses a process boundary as JSON. It is validated against its
 *     registered schema on the way in AND on the way out, because the row may
 *     have been written by an older deployment whose schema differed.
 */

import type { z } from 'zod';
import type { Job, JobStatus } from '@/generated/prisma/client';
import type { Db } from '@/server/db/client';
import type { ChildLogger } from '@/server/observability/logger';

/**
 * A queued row, exactly as the database models it. Aliased rather than
 * redeclared so a schema change cannot silently drift from this contract.
 */
export type JobRecord = Job;

export type { JobStatus };

/**
 * A handler's return value, persisted into `Job.result` for support and
 * debugging.
 *
 * Typed `unknown` rather than Prisma's JSON union on purpose: a zod-parsed
 * object like `{ invoiceId: string }` is not assignable to an index-signature
 * type, so using the JSON union here would force every handler into a cast. The
 * value is serialised with `JSON.stringify` at the driver boundary, which
 * rejects a non-serialisable one (a `BigInt` money amount, most likely) with a
 * message naming the job.
 */
export type JobResult = unknown;

/** Context handed to every handler invocation. */
export interface JobContext {
  readonly job: JobRecord;
  /** 1 on the first run. Already incremented by the claim, so it is never 0. */
  readonly attempt: number;
  /** Pre-bound with jobName/jobId so a handler never has to repeat them. */
  readonly logger: ChildLogger;
  /**
   * Aborted when the worker is shutting down or the job has outlived its lease.
   * A handler doing anything long-running should pass this to its I/O; the
   * worker cannot interrupt synchronous work, so ignoring it means the job keeps
   * running after the worker has given up waiting for it.
   */
  readonly signal: AbortSignal;
  /** The request that enqueued the job, so its log lines correlate with it. */
  readonly requestId: string | null;
}

/** The business body of one job. Must be idempotent -- see the file header. */
export interface JobHandler<TPayload> {
  (payload: TPayload, context: JobContext): Promise<JobResult | void>;
}

/**
 * A handler whose payload type has been erased so heterogeneous definitions can
 * live in one registry. `strictFunctionTypes` correctly refuses to widen
 * `JobHandler<{ id: string }>` to `JobHandler<unknown>`, so the registry stores
 * this instead: a closure that parses `payload` with the definition's own schema
 * and only then calls the typed handler. There is no cast anywhere in the chain.
 */
export type ErasedJobHandler = (
  payload: unknown,
  context: JobContext,
) => Promise<JobResult | void>;

/** One entry of the registry, with its payload type intact. */
export interface JobDefinition<TPayload> {
  readonly name: string;
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly handler: JobHandler<TPayload>;
  readonly queue: string;
  readonly maxAttempts: number;
  /** Higher is claimed first. */
  readonly priority: number;
  /** How long the worker waits for the handler before giving up on it. */
  readonly timeoutMs: number;
  readonly description: string;
}

/**
 * A definition as the registry stores and the worker consumes it: same shape,
 * payload-validating handler.
 */
export interface ErasedJobDefinition
  extends Omit<JobDefinition<unknown>, 'handler' | 'payloadSchema'> {
  readonly payloadSchema: z.ZodType;
  readonly handler: ErasedJobHandler;
}

/** The registry itself. Read-only to everything except `register()`. */
export type JobDefinitionRegistry = ReadonlyMap<string, ErasedJobDefinition>;

// ---------------------------------------------------------------------------
// Queue provider
// ---------------------------------------------------------------------------

export interface EnqueueRequest {
  readonly name: string;
  /**
   * Already validated against the job's schema by the caller (`enqueue()` in
   * ./index.ts is the only sanctioned entry point). Typed `unknown` for the same
   * reason as `JobResult`.
   */
  readonly payload: unknown;
  readonly queue: string;
  readonly maxAttempts: number;
  readonly priority?: number;
  /** Earliest execution time. Defaults to now. */
  readonly runAt?: Date;
  readonly organizationId?: string | null;
  /**
   * Makes the enqueue itself idempotent: a second call with the same key returns
   * the existing job instead of creating a second one. This is what lets an
   * at-least-once webhook or a racing cron process enqueue freely.
   */
  readonly idempotencyKey?: string | null;
  readonly requestId?: string | null;
  readonly createdById?: string | null;
  /**
   * Enqueue inside the caller's transaction. This is the difference between
   * "payment recorded and its receipt will be sent" and "receipt sent for a
   * payment that rolled back": the job row commits or vanishes with the work
   * that produced it.
   */
  readonly db?: Db;
}

export interface EnqueueResult {
  readonly job: JobRecord;
  /** True when `idempotencyKey` matched an existing job and nothing was written. */
  readonly deduplicated: boolean;
}

export interface ClaimRequest {
  readonly queues: readonly string[];
  /** Maximum jobs to take. The worker asks for exactly its free capacity. */
  readonly limit: number;
  /** Identifies the lease holder, so a zombie worker cannot finish someone else's job. */
  readonly workerId: string;
  readonly now?: Date;
}

export interface CompleteRequest {
  readonly jobId: string;
  readonly workerId: string;
  readonly result?: JobResult;
}

export interface FailRequest {
  /** The claimed row: its `attempts`/`maxAttempts` decide retry versus terminal. */
  readonly job: JobRecord;
  readonly workerId: string;
  readonly error: unknown;
  /**
   * The failure cannot change on retry (a payload that fails its schema, a
   * missing handler, any 4xx). Goes straight to FAILED rather than burning four
   * more attempts on a certainty.
   */
  readonly permanent?: boolean;
}

export interface CancelRequest {
  readonly jobId: string;
  readonly organizationId?: string | null;
}

export interface ReapRequest {
  /** A lease older than this is presumed dead. */
  readonly visibilityTimeoutMs: number;
  readonly now?: Date;
}

export interface ReapResult {
  /** Leases returned to PENDING for another worker. */
  readonly requeued: number;
  /** Leases whose job had no attempts left and was parked as DEAD. */
  readonly dead: number;
}

/**
 * The driver contract. Implemented by the `jobs` table (the default) and, when
 * throughput demands it, by Redis.
 */
export interface QueueProvider {
  readonly driver: 'database' | 'redis';

  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;

  /**
   * Atomically take up to `limit` runnable jobs and hold a lease on them.
   * Concurrency-safety is the whole point of this method: two workers polling
   * the same queue in the same millisecond must never receive the same row.
   */
  claim(request: ClaimRequest): Promise<JobRecord[]>;

  /** False when the lease had already been taken away -- the result is discarded. */
  complete(request: CompleteRequest): Promise<boolean>;

  /** Returns the updated row, or null when the lease was no longer ours. */
  fail(request: FailRequest): Promise<JobRecord | null>;

  /** False when the job was not PENDING; a running handler cannot be interrupted. */
  cancel(request: CancelRequest): Promise<boolean>;

  /**
   * Recover leases held by a worker that died without releasing them. Optional
   * because a driver with its own lease expiry has nothing to do here.
   */
  reapAbandoned?(request: ReapRequest): Promise<ReapResult>;
}
