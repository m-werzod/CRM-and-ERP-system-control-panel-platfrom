/**
 * The `jobs` table as a queue.
 *
 * This is the default driver because it needs no infrastructure beyond the
 * PostgreSQL instance the application already depends on, and because it gives
 * one thing Redis cannot: a job row can be inserted inside the transaction that
 * produced the work. "Payment recorded and receipt queued" either both commit or
 * neither does -- see `EnqueueRequest.db`.
 *
 * The interesting part is `claim`. Everything else is bookkeeping.
 */

import { JobStatus, Prisma } from '@/generated/prisma/client';
import { InternalError } from '@/server/errors';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import type {
  CancelRequest,
  ClaimRequest,
  CompleteRequest,
  EnqueueRequest,
  EnqueueResult,
  FailRequest,
  JobRecord,
  QueueProvider,
  ReapRequest,
  ReapResult,
} from '@/server/jobs/types';

// ---------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------

/**
 * Grows fast enough that a provider outage is not hammered, and lands the fifth
 * attempt of a five-attempt job roughly two hours after the first -- the curve
 * `JOB_SPECS` documents for `notification.send`.
 */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_FACTOR = 4;
const BACKOFF_CAP_MS = 60 * 60_000;
/** Jitter spread, as a fraction of the computed delay: +/-25%. */
const BACKOFF_JITTER = 0.25;

/**
 * Delay before retry number `attempt` (1 = the first retry).
 *
 * The jitter is not decoration. A batch job fans out five hundred notification
 * sends; the provider goes down; all five hundred fail within the same second.
 * Without jitter every one of them retries at the identical instant, so the
 * retry is the same thundering herd that just failed, and it stays synchronised
 * for every subsequent attempt. Spreading them over a window lets the first few
 * discover whether the provider is back before the rest commit to trying.
 *
 * `random` is injectable so the curve can be asserted without a flaky test.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, BACKOFF_CAP_MS);
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(capped * jitter);
}

// ---------------------------------------------------------------------------
// Raw row handling
// ---------------------------------------------------------------------------

/**
 * `claim` has to be raw SQL, and raw SQL bypasses Prisma's model deserialiser:
 * the shape that comes back is whatever the driver adapter's type parsers
 * produced, which TypeScript can only describe as "these keys, loosely typed".
 * `toJobRecord` is the one place that turns that back into a `JobRecord`.
 */
interface RawJobRow {
  id: string;
  organizationId: string | null;
  queue: string;
  name: string;
  payload: unknown;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  lockedBy: string | null;
  lockedAt: Date | string | null;
  error: string | null;
  errorStack: string | null;
  result: unknown;
  idempotencyKey: string | null;
  requestId: string | null;
  createdById: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : asDate(value);
}

/**
 * A jsonb column arrives already parsed from the pg driver, but a driver adapter
 * is free to hand back text instead, and either way the static type is `unknown`.
 * Re-parsing (or round-tripping) produces a value that is JSON by construction,
 * which is exactly what the column's declared type asserts.
 */
function asJsonValue(value: unknown): Prisma.JsonValue {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Prisma.JsonValue;
    } catch {
      // Genuinely a string column value, not serialised JSON.
      return value;
    }
  }
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.JsonValue;
}

/** Compared against the values, not `in` the object, which also matches `toString`. */
const JOB_STATUS_VALUES: readonly string[] = Object.values(JobStatus);

function asJobStatus(value: string): JobStatus {
  // The column is a PostgreSQL enum, so an unknown value here would mean the
  // database and the generated client have diverged -- worth failing loudly
  // rather than carrying an impossible status into the worker.
  if (JOB_STATUS_VALUES.includes(value)) return value as JobStatus;
  throw new InternalError(`The jobs table returned an unknown status "${value}".`);
}

function toJobRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    queue: row.queue,
    name: row.name,
    payload: asJsonValue(row.payload),
    status: asJobStatus(row.status),
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: asDate(row.runAt),
    startedAt: asNullableDate(row.startedAt),
    finishedAt: asNullableDate(row.finishedAt),
    lockedBy: row.lockedBy,
    lockedAt: asNullableDate(row.lockedAt),
    error: row.error,
    errorStack: row.errorStack,
    result: row.result === null || row.result === undefined ? null : asJsonValue(row.result),
    idempotencyKey: row.idempotencyKey,
    requestId: row.requestId,
    createdById: row.createdById,
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
  };
}

/** Serialise a payload or result for a Json column. */
function toInputJson(value: unknown, jobName: string): Prisma.InputJsonValue {
  let text: string | undefined;
  try {
    text = JSON.stringify(value ?? {});
  } catch (cause) {
    // A BigInt money amount is the likely culprit, and it is a call-site bug.
    // Failing here names the job; failing in the driver names nothing useful.
    throw new InternalError(
      `Job "${jobName}" was given a value that cannot be serialised to JSON.`,
      { cause },
    );
  }
  if (text === undefined) {
    throw new InternalError(`Job "${jobName}" was given a value that JSON.stringify drops.`);
  }
  return JSON.parse(text) as Prisma.InputJsonValue;
}

/** Json column write for an optional handler result. */
function toResultJson(
  value: unknown,
  jobName: string,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
  if (value === undefined || value === null) return Prisma.DbNull;
  return toInputJson(value, jobName);
}

const MAX_ERROR_CHARS = 1_000;
const MAX_STACK_CHARS = 8_000;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated]`;
}

/** Flatten an unknown throwable into the two text columns. */
export function describeFailure(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const prefix = typeof code === 'string' ? `${error.name}[${code}]` : error.name;
    return {
      message: truncate(`${prefix}: ${error.message}`, MAX_ERROR_CHARS),
      stack: error.stack ? truncate(error.stack, MAX_STACK_CHARS) : null,
    };
  }
  return { message: truncate(String(error), MAX_ERROR_CHARS), stack: null };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DatabaseQueueProvider implements QueueProvider {
  readonly driver = 'database' as const;

  /** Injectable so a test can bind the provider to its own transaction. */
  constructor(private readonly defaultDb: Db = prisma) {}

  private db(override?: Db): Db {
    return override ?? this.defaultDb;
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const db = this.db(request.db);
    const payload = toInputJson(request.payload, request.name);

    const data = {
      queue: request.queue,
      name: request.name,
      payload,
      priority: request.priority ?? 0,
      maxAttempts: request.maxAttempts,
      runAt: request.runAt ?? new Date(),
      organizationId: request.organizationId ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      requestId: request.requestId ?? null,
      createdById: request.createdById ?? null,
    };

    if (data.idempotencyKey === null) {
      return { job: await db.job.create({ data }), deduplicated: false };
    }

    // Insert first and handle the collision, rather than checking for an existing
    // row and then inserting: two processes enqueueing the same logical job in
    // the same millisecond both pass the check, and only the unique index can
    // break the tie. P2002 here therefore means "someone else got there", which
    // is success for an idempotent enqueue.
    try {
      return { job: await db.job.create({ data }), deduplicated: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await db.job.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (!existing) throw error;
      return { job: existing, deduplicated: true };
    }
  }

  /**
   * Take up to `limit` runnable jobs and stamp our lease on them, in ONE
   * statement.
   *
   * `FOR UPDATE SKIP LOCKED` is the entire reason this is raw SQL and the entire
   * reason it is correct. The inner SELECT locks the rows it returns and skips
   * any row another transaction has already locked, so two workers polling the
   * same queue in the same millisecond get disjoint sets. A read-then-update --
   * `findMany` for PENDING rows, then `updateMany` to mark them RUNNING -- would
   * let both workers read the same row and both believe they own it; the second
   * update would simply overwrite the first worker's lease and the job would run
   * twice. No amount of application-side checking fixes that, because the check
   * and the write are not atomic. SKIP LOCKED is also why a worker never blocks
   * behind another worker's claim: contention costs a skipped row, not a wait.
   *
   * `attempts` is incremented here, at claim time, not at failure time. A worker
   * killed mid-job leaves the increment behind, so a job that crashes the process
   * still burns an attempt and cannot loop forever.
   */
  async claim(request: ClaimRequest): Promise<JobRecord[]> {
    if (request.queues.length === 0 || request.limit < 1) return [];

    const now = request.now ?? new Date();
    const rows = await this.db().$queryRaw<RawJobRow[]>(Prisma.sql`
      update "jobs" as j
         set "status"    = ${JobStatus.RUNNING}::"JobStatus",
             "attempts"  = j."attempts" + 1,
             "startedAt" = coalesce(j."startedAt", ${now}),
             "lockedBy"  = ${request.workerId},
             "lockedAt"  = ${now},
             "updatedAt" = ${now}
       where j."id" in (
         select candidate."id"
           from "jobs" as candidate
          where candidate."status" = ${JobStatus.PENDING}::"JobStatus"
            and candidate."runAt" <= ${now}
            and candidate."queue" in (${Prisma.join([...request.queues])})
          order by candidate."priority" desc, candidate."runAt" asc
          limit ${request.limit}
          for update skip locked
       )
      returning j.*
    `);

    return rows.map(toJobRecord);
  }

  async complete(request: CompleteRequest): Promise<boolean> {
    const now = new Date();
    // The lease is part of the WHERE clause: if the reaper decided this worker
    // was dead and gave the job away, the result must be dropped rather than
    // overwriting whoever owns it now.
    const { count } = await this.db().job.updateMany({
      where: { id: request.jobId, lockedBy: request.workerId, status: JobStatus.RUNNING },
      data: {
        status: JobStatus.COMPLETED,
        finishedAt: now,
        lockedBy: null,
        lockedAt: null,
        error: null,
        errorStack: null,
        result: toResultJson(request.result, request.jobId),
      },
    });
    return count === 1;
  }

  async fail(request: FailRequest): Promise<JobRecord | null> {
    const db = this.db();
    const now = new Date();
    const { message, stack } = describeFailure(request.error);

    // `attempts` was incremented by the claim, so it already counts this run.
    const exhausted = request.job.attempts >= request.job.maxAttempts;
    const terminal = request.permanent === true || exhausted;

    // A permanent failure is FAILED; running out of attempts on a retryable
    // failure is DEAD. The distinction is what an operator needs: FAILED means
    // "this job can never work as queued", DEAD means "it might have, given more
    // patience", and the two get different treatment on a queue dashboard.
    const status = terminal
      ? request.permanent === true
        ? JobStatus.FAILED
        : JobStatus.DEAD
      : JobStatus.PENDING;

    const retryDelay = status === JobStatus.PENDING ? retryDelayMs(request.job.attempts) : 0;

    const { count } = await db.job.updateMany({
      where: { id: request.job.id, lockedBy: request.workerId, status: JobStatus.RUNNING },
      data: {
        status,
        error: message,
        errorStack: stack,
        lockedBy: null,
        lockedAt: null,
        ...(status === JobStatus.PENDING
          ? { runAt: new Date(now.getTime() + retryDelay), finishedAt: null }
          : { finishedAt: now }),
      },
    });
    if (count === 0) return null;

    return db.job.findUnique({ where: { id: request.job.id } });
  }

  async cancel(request: CancelRequest): Promise<boolean> {
    const { count } = await this.db().job.updateMany({
      where: {
        id: request.jobId,
        status: JobStatus.PENDING,
        // `undefined` means "any tenant" (an operator tool); an explicit value --
        // including null for a platform-level job -- scopes the cancel so one
        // organisation cannot cancel another's work by guessing an id.
        ...(request.organizationId === undefined
          ? {}
          : { organizationId: request.organizationId }),
      },
      data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * Return leases held by a worker that died without releasing them.
   *
   * Without this, a worker killed by an OOM or a deploy leaves its in-flight jobs
   * RUNNING forever: nothing else will claim them, because `claim` only looks at
   * PENDING rows. The lease timestamp is the only evidence available, so "older
   * than the visibility timeout" stands in for "the holder is gone" -- which is
   * why the timeout must exceed the longest job's own timeout (see
   * `defaultVisibilityTimeoutMs` in ./worker.ts). Reclaiming a job that is merely
   * slow would run it twice.
   */
  async reapAbandoned(request: ReapRequest): Promise<ReapResult> {
    const now = request.now ?? new Date();
    const cutoff = new Date(now.getTime() - request.visibilityTimeoutMs);

    return withTransaction(async (tx) => {
      // `coalesce` because a RUNNING row with no lockedAt should not be immortal:
      // fall back to when the run started, then to the last write.
      const dead = await tx.$executeRaw(Prisma.sql`
        update "jobs"
           set "status"     = ${JobStatus.DEAD}::"JobStatus",
               "lockedBy"   = null,
               "lockedAt"   = null,
               "finishedAt" = ${now},
               "error"      = coalesce("error", 'Worker lease expired with no attempts left.'),
               "updatedAt"  = ${now}
         where "status" = ${JobStatus.RUNNING}::"JobStatus"
           and coalesce("lockedAt", "startedAt", "updatedAt") < ${cutoff}
           and "attempts" >= "maxAttempts"
      `);

      const requeued = await tx.$executeRaw(Prisma.sql`
        update "jobs"
           set "status"    = ${JobStatus.PENDING}::"JobStatus",
               "lockedBy"  = null,
               "lockedAt"  = null,
               "runAt"     = ${now},
               "error"     = 'Worker lease expired; requeued.',
               "updatedAt" = ${now}
         where "status" = ${JobStatus.RUNNING}::"JobStatus"
           and coalesce("lockedAt", "startedAt", "updatedAt") < ${cutoff}
      `);

      return { requeued, dead };
    }, { existing: this.db() });
  }
}

/** P2002 from Prisma, 23505 straight from PostgreSQL. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}

export const __testing = { retryDelayMs, toJobRecord, describeFailure, asJsonValue };
