/**
 * The worker loop.
 *
 * Claim a batch sized to free capacity, run the batch concurrently, record each
 * outcome, poll again. Three properties matter more than throughput:
 *
 *  1. ONE FAILING JOB NEVER STOPS THE LOOP. Every per-job path is wrapped,
 *     including the bookkeeping calls that record the outcome -- a database
 *     hiccup while marking a job COMPLETED must not take the worker with it.
 *  2. SHUTDOWN FINISHES WHAT IT STARTED. On SIGINT/SIGTERM the worker stops
 *     claiming and waits for in-flight handlers. A deploy that killed handlers
 *     mid-write would leave the lease to expire and the job to run twice, which
 *     is legal (delivery is at-least-once) but wasteful and confusing.
 *  3. A HANDLER CANNOT HANG FOREVER. Each job gets the timeout its spec declares.
 *
 * The worker deliberately does NOT import the handler modules. `enqueue` needs
 * only the declarations, and keeping registration out of here is what lets a
 * Next.js request bundle the queue without bundling every service. The CLI
 * entrypoint registers handlers; `runWorker` refuses to start if nobody has.
 */

import { hostname } from 'node:os';
import process from 'node:process';
import { isAppError } from '@/server/errors';
import { env } from '@/server/env';
import { logger } from '@/server/observability/logger';
import { getQueue } from '@/server/jobs/index';
import {
  ALL_JOB_NAMES,
  ALL_JOB_QUEUES,
  JOB_SPECS,
  missingHandlers,
  registeredJobs,
  resolve as resolveHandler,
} from '@/server/jobs/registry';
import type { JobRecord, QueueProvider } from '@/server/jobs/types';

/** A handler that outlived its declared timeout. Retryable: usually transient. */
export class JobTimeoutError extends Error {
  constructor(jobName: string, timeoutMs: number) {
    super(`Job "${jobName}" exceeded its ${Math.round(timeoutMs / 1000)}s timeout.`);
    this.name = 'JobTimeoutError';
  }
}

export interface RunWorkerOptions {
  readonly queues?: readonly string[];
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  /** Aborting it asks the worker to stop claiming and drain. */
  readonly signal?: AbortSignal;
  readonly workerId?: string;
  readonly visibilityTimeoutMs?: number;
  readonly reapIntervalMs?: number;
  /** Return as soon as the queue is empty, instead of polling. For CI drains. */
  readonly drain?: boolean;
  /** Stop claiming after this many jobs. For tests. */
  readonly maxJobs?: number;
  /** Install SIGINT/SIGTERM handlers. Off inside tests. */
  readonly handleSignals?: boolean;
  /** Injectable so a test can drive a provider bound to its own transaction. */
  readonly queue?: QueueProvider;
}

export interface WorkerSummary {
  readonly workerId: string;
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Outcomes discarded because the lease had been reclaimed mid-run. */
  readonly leasesLost: number;
  readonly reapedRequeued: number;
  readonly reapedDead: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;
const MAX_CLAIM_BACKOFF_MS = 30_000;

/**
 * How long a lease may go untouched before the reaper presumes its holder dead.
 *
 * Derived from the declared timeouts rather than picked, because the constraint
 * is a relationship: this driver has no lease heartbeat, so the only evidence a
 * worker is alive is how recently it claimed. A visibility timeout shorter than
 * the longest job's own timeout would hand a 30-minute import to a second worker
 * while the first is still importing. Doubling the longest timeout leaves room
 * for a slow claim and a slow shutdown.
 */
export function defaultVisibilityTimeoutMs(): number {
  const longest = Math.max(...ALL_JOB_NAMES.map((name) => JOB_SPECS[name].timeoutMs));
  return Math.max(10 * 60_000, longest * 2);
}

function generateWorkerId(): string {
  // Host and pid make a lease traceable to a process an operator can inspect;
  // the random suffix keeps two workers in one container distinct.
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${hostname()}:${process.pid}:${suffix}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolveSleep) => {
    const onAbort = () => finish();
    const timer = setTimeout(() => finish(), ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Is retrying this pointless?
 *
 * A 4xx means the input or the state is wrong: a payload that fails its schema, a
 * row that has been deleted, a transition the entity does not allow. None of that
 * changes by waiting, so burning the remaining attempts only delays the operator
 * seeing it. 5xx is the opposite -- an integration that is down is the case
 * retries exist for. Two 4xx codes are still worth retrying: CONFLICT is how a
 * Serializable write conflict surfaces, and RATE_LIMITED is by definition
 * temporary.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.code === 'CONFLICT' || error.code === 'RATE_LIMITED') return false;
  return error.status >= 400 && error.status < 500;
}

export async function runWorker(options: RunWorkerOptions = {}): Promise<WorkerSummary> {
  const queue = options.queue ?? getQueue();
  const queues = [...(options.queues ?? ALL_JOB_QUEUES)];
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? defaultVisibilityTimeoutMs();
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const workerId = options.workerId ?? env.WORKER_ID ?? generateWorkerId();

  if (registeredJobs().size === 0) {
    // Starting anyway would claim every queued job and mark each one permanently
    // failed for want of a handler -- the queue would be emptied into the dead
    // letter state by a misconfigured process. Refusing is the safe default.
    throw new Error(
      'No job handlers are registered, so this worker would fail every job it claimed. Register handlers before calling runWorker() -- see scripts/worker.ts.',
    );
  }

  const log = logger.child({ workerId });
  const missing = missingHandlers();
  if (missing.length > 0) {
    // Not fatal: a rolling deploy legitimately runs a worker that predates a new
    // job. It does mean those jobs will fail on this worker, so it is loud.
    log.warn('worker.handlers_missing', { jobs: [...missing], count: missing.length });
  }

  /** Stop claiming; keep draining. */
  const shutdown = new AbortController();
  /** Abort the handlers themselves -- second signal only. */
  const hardStop = new AbortController();

  const requestShutdown = (reason: string): void => {
    if (shutdown.signal.aborted) {
      if (!hardStop.signal.aborted) {
        log.warn('worker.hard_stop', { reason });
        hardStop.abort(new Error(`Worker hard stop: ${reason}`));
      }
      return;
    }
    log.info('worker.shutdown_requested', { reason });
    shutdown.abort();
  };

  const onSigint = () => requestShutdown('SIGINT');
  const onSigterm = () => requestShutdown('SIGTERM');
  const onExternalAbort = () => requestShutdown('signal');

  const handleSignals = options.handleSignals ?? true;
  if (handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  let leasesLost = 0;
  let reapedRequeued = 0;
  let reapedDead = 0;
  let claimFailures = 0;
  let lastReapAt = 0;

  /** jobId -> the promise that settles once the job and its bookkeeping are done. */
  const inFlight = new Map<string, Promise<void>>();

  const runOne = async (job: JobRecord): Promise<void> => {
    const jobLog = logger.child({
      workerId,
      jobName: job.name,
      jobId: job.id,
      queue: job.queue,
      requestId: job.requestId,
      organizationId: job.organizationId,
      attempt: job.attempts,
    });
    const startedAt = Date.now();

    const definition = resolveHandler(job.name);
    if (!definition) {
      // Nothing this process can do with the row. Permanent rather than retried,
      // so it lands in FAILED where an operator will see the name and can deploy
      // the handler or cancel it.
      failed += 1;
      jobLog.error('job.no_handler', {});
      await recordFailure(
        job,
        new Error(`No handler is registered for job "${job.name}".`),
        true,
        jobLog,
      );
      return;
    }

    const controller = new AbortController();
    const onHardStop = () => controller.abort(new Error('Worker is shutting down.'));
    hardStop.signal.addEventListener('abort', onHardStop, { once: true });

    // The handler's own outcome is settled first and recorded second, so that a
    // database hiccup while writing COMPLETED is never mistaken for -- and never
    // recorded as -- a failure of the business logic.
    let outcome:
      | { readonly ok: true; readonly result: unknown }
      | { readonly ok: false; readonly error: unknown };

    try {
      const result = await withTimeout(
        Promise.resolve(
          definition.handler(job.payload, {
            job,
            attempt: job.attempts,
            logger: jobLog,
            signal: controller.signal,
            requestId: job.requestId,
          }),
        ),
        definition.timeoutMs,
        () => {
          const timeout = new JobTimeoutError(job.name, definition.timeoutMs);
          // The handler keeps running -- a promise cannot be cancelled. Aborting
          // the signal is the only lever, and a handler that ignores it will
          // still be working when its retry starts. Hence the at-least-once
          // contract and the idempotency requirement on handlers.
          controller.abort(timeout);
          return timeout;
        },
      );
      outcome = { ok: true, result };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      hardStop.signal.removeEventListener('abort', onHardStop);
    }

    if (!outcome.ok) {
      failed += 1;
      const permanent = isPermanentFailure(outcome.error);
      jobLog.error('job.failed', {
        durationMs: Date.now() - startedAt,
        permanent,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        error: outcome.error,
      });
      await recordFailure(job, outcome.error, permanent, jobLog);
      return;
    }

    try {
      const kept = await queue.complete({ jobId: job.id, workerId, result: outcome.result });
      if (kept) {
        succeeded += 1;
        jobLog.info('job.completed', { durationMs: Date.now() - startedAt });
      } else {
        // The reaper handed the job to someone else while we were working. Our
        // result is stale by definition; whoever owns it now decides the outcome.
        leasesLost += 1;
        jobLog.warn('job.lease_lost', { durationMs: Date.now() - startedAt });
      }
    } catch (error) {
      // The work is done but unrecorded: the lease will expire and the job will
      // run again. That is exactly why handlers must be idempotent.
      jobLog.error('job.completion_record_failed', { error });
    }
  };

  /** Bookkeeping is itself fallible, and its failure must not escape. */
  async function recordFailure(
    job: JobRecord,
    error: unknown,
    permanent: boolean,
    jobLog: ReturnType<typeof logger.child>,
  ): Promise<void> {
    try {
      const updated = await queue.fail({ job, workerId, error, permanent });
      if (!updated) {
        leasesLost += 1;
        jobLog.warn('job.lease_lost_on_failure', {});
        return;
      }
      jobLog.info('job.failure_recorded', {
        status: updated.status,
        nextRunAt: updated.status === 'PENDING' ? updated.runAt : null,
      });
    } catch (bookkeepingError) {
      // The lease will expire and the reaper will requeue the job. Losing the
      // error text is bad; crashing the worker over it is worse.
      jobLog.error('job.failure_record_failed', { error: bookkeepingError });
    }
  }

  const start = (job: JobRecord): void => {
    const promise = runOne(job)
      .catch((error: unknown) => {
        // runOne is defensive throughout, so this is unreachable by design. If it
        // ever fires, the loop must still survive it.
        log.error('worker.job_runner_crashed', { jobId: job.id, jobName: job.name, error });
      })
      .finally(() => {
        inFlight.delete(job.id);
      });
    inFlight.set(job.id, promise);
  };

  log.info('worker.started', {
    queues,
    concurrency,
    pollIntervalMs,
    visibilityTimeoutMs,
    drain: options.drain === true,
  });

  try {
    while (!shutdown.signal.aborted) {
      if (options.maxJobs !== undefined && claimed >= options.maxJobs) break;

      if (inFlight.size >= concurrency) {
        // Full. Wait for the first job to finish rather than polling for work we
        // have no capacity to run.
        await Promise.race(inFlight.values());
        continue;
      }

      if (Date.now() - lastReapAt >= reapIntervalMs) {
        lastReapAt = Date.now();
        try {
          const reaped = await queue.reapAbandoned?.({ visibilityTimeoutMs });
          if (reaped && (reaped.requeued > 0 || reaped.dead > 0)) {
            reapedRequeued += reaped.requeued;
            reapedDead += reaped.dead;
            log.warn('worker.reaped_abandoned', {
              requeued: reaped.requeued,
              dead: reaped.dead,
              visibilityTimeoutMs,
            });
          }
        } catch (error) {
          log.error('worker.reap_failed', { error });
        }
      }

      let capacity = concurrency - inFlight.size;
      if (options.maxJobs !== undefined) {
        capacity = Math.min(capacity, options.maxJobs - claimed);
      }

      let batch: JobRecord[] = [];
      try {
        batch = await queue.claim({ queues, limit: capacity, workerId });
        claimFailures = 0;
      } catch (error) {
        claimFailures += 1;
        const backoff = Math.min(pollIntervalMs * 2 ** (claimFailures - 1), MAX_CLAIM_BACKOFF_MS);
        // A database that is down must not become a hot loop against itself.
        log.error('worker.claim_failed', { error, consecutive: claimFailures, backoffMs: backoff });
        await sleep(backoff, shutdown.signal);
        continue;
      }

      if (batch.length === 0) {
        if (options.drain === true && inFlight.size === 0) break;
        await sleep(pollIntervalMs, shutdown.signal);
        continue;
      }

      claimed += batch.length;
      for (const job of batch) start(job);
    }
  } finally {
    if (inFlight.size > 0) {
      log.info('worker.draining', { inFlight: inFlight.size });
      await Promise.allSettled(inFlight.values());
    }
    if (handleSignals) {
      // Long-lived listeners on `process` outlive this call; a test that runs two
      // workers would otherwise accumulate them.
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
    options.signal?.removeEventListener('abort', onExternalAbort);
  }

  const summary: WorkerSummary = {
    workerId,
    claimed,
    succeeded,
    failed,
    leasesLost,
    reapedRequeued,
    reapedDead,
  };
  log.info('worker.stopped', { ...summary });
  return summary;
}
