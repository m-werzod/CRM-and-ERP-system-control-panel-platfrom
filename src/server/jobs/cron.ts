/**
 * The cron sweep.
 *
 * `CronSchedule` rows are the schedule: per organisation, editable by an admin,
 * rather than a hard-coded list in a platform file. One tick reads the enabled
 * rows, works out which are due in their own timezone, and enqueues a job for
 * each. It never runs business logic itself -- a cron process holds no
 * `AccessContext`, so anything that touches tenant data must go through a job
 * whose handler establishes its own authority.
 *
 * The expression parser lives in ./cron-expression.ts, deliberately separate:
 * it is pure, and keeping it out of this module is what lets its unit tests run
 * without a database, an env file or a Prisma client.
 *
 * TWO PROPERTIES WORTH KNOWING BEFORE CHANGING ANYTHING HERE:
 *
 *  - A tick NEVER catches up. After four hours of downtime, an hourly schedule
 *    fires once, not four times. `nextRunAt` is recomputed from *now* rather than
 *    from the missed slot, because the alternative empties a backlog of duplicate
 *    reminder SMS into parents' phones the moment the process comes back.
 *  - Two cron processes running at once are safe. The enqueue carries an
 *    idempotency key derived from the schedule and the slot it is firing for, so
 *    the second process's insert collides and returns the first one's job.
 */

import process from 'node:process';
import { isAppError, ValidationError } from '@/server/errors';
import { prisma, type Db } from '@/server/db/client';
import { logger } from '@/server/observability/logger';
import { assertTimeZone } from '@/lib/dates';
import { enqueueByName } from '@/server/jobs/index';
import { isJobName } from '@/server/jobs/registry';
import {
  CronExpressionError,
  nextCronOccurrence,
  parseCronExpression,
} from '@/server/jobs/cron-expression';
import type { Prisma } from '@/generated/prisma/client';

/** Stored in `CronSchedule.lastStatus`, which is a free-text column. */
export const CRON_RUN_STATUS = {
  enqueued: 'ENQUEUED',
  /** Another cron process had already enqueued this slot. */
  deduplicated: 'DEDUPLICATED',
  /** First sight of the schedule: `nextRunAt` computed, nothing fired. */
  scheduled: 'SCHEDULED',
  invalidExpression: 'INVALID_EXPRESSION',
  invalidTimezone: 'INVALID_TIMEZONE',
  unknownJob: 'UNKNOWN_JOB',
  invalidPayload: 'INVALID_PAYLOAD',
  enqueueFailed: 'ENQUEUE_FAILED',
} as const;

export type CronRunStatus = (typeof CRON_RUN_STATUS)[keyof typeof CRON_RUN_STATUS];

/** Not persisted -- a row that is simply not due yet is not written to at all. */
const NOT_DUE = 'NOT_DUE';

export interface CronScheduleOutcome {
  readonly scheduleId: string;
  readonly key: string;
  readonly jobName: string;
  readonly status: CronRunStatus | typeof NOT_DUE;
  readonly nextRunAt: Date | null;
  readonly jobId: string | null;
  readonly error: string | null;
}

export interface CronTickResult {
  readonly evaluated: number;
  readonly enqueued: number;
  readonly deduplicated: number;
  readonly notDue: number;
  readonly invalid: number;
  readonly failed: number;
  readonly outcomes: readonly CronScheduleOutcome[];
}

export interface RunCronOptions {
  /** Injectable clock, so a test can place "now" wherever it needs it. */
  readonly now?: Date;
  readonly db?: Db;
}

const MAX_ERROR_CHARS = 1_000;
/** Consecutive failures before the sweep starts shouting rather than noting. */
const FAILURE_ALERT_THRESHOLD = 5;

function truncate(value: string, max = MAX_ERROR_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[truncated]`;
}

function describe(error: unknown): string {
  if (isAppError(error)) return truncate(`${error.code}: ${error.message}`);
  if (error instanceof Error) return truncate(`${error.name}: ${error.message}`);
  return truncate(String(error));
}

/**
 * Run one sweep.
 *
 * Every row is evaluated independently and every failure is confined to its own
 * row: a schedule with a typo in its expression must not stop the overdue-payment
 * reminders from firing.
 */
export async function runCron(options: RunCronOptions = {}): Promise<CronTickResult> {
  const now = options.now ?? new Date();
  const db = options.db ?? prisma;
  const log = logger.child({ jobName: 'cron.sweep' });

  // The one legitimately unscoped read in the codebase: this is not a request,
  // there is no caller to scope to, and a platform schedule (organizationId null)
  // has to be visible alongside every tenant's own.
  const schedules = await db.cronSchedule.findMany({
    where: { isEnabled: true },
    orderBy: [{ organizationId: 'asc' }, { key: 'asc' }],
  });

  const outcomes: CronScheduleOutcome[] = [];
  let enqueued = 0;
  let deduplicated = 0;
  let notDue = 0;
  let invalid = 0;
  let failed = 0;

  for (const schedule of schedules) {
    const scheduleLog = logger.child({
      jobName: 'cron.sweep',
      organizationId: schedule.organizationId,
      cronKey: schedule.key,
      scheduleId: schedule.id,
    });

    const record = (
      status: CronRunStatus | typeof NOT_DUE,
      extra: { nextRunAt?: Date | null; jobId?: string | null; error?: string | null } = {},
    ): void => {
      outcomes.push({
        scheduleId: schedule.id,
        key: schedule.key,
        jobName: schedule.jobName,
        status,
        nextRunAt: extra.nextRunAt ?? null,
        jobId: extra.jobId ?? null,
        error: extra.error ?? null,
      });
    };

    const persist = async (data: Prisma.CronScheduleUpdateInput): Promise<void> => {
      try {
        await db.cronSchedule.update({ where: { id: schedule.id }, data });
      } catch (error) {
        // The sweep is idempotent per slot, so losing a bookkeeping write costs a
        // repeated evaluation next tick, not a lost or duplicated job.
        scheduleLog.error('cron.schedule_update_failed', { error });
      }
    };

    const markInvalid = async (status: CronRunStatus, error: unknown): Promise<void> => {
      invalid += 1;
      const message = describe(error);
      scheduleLog.error('cron.schedule_invalid', { status, error });
      record(status, { error: message });
      await persist({
        lastStatus: status,
        lastError: message,
        consecutiveFailures: { increment: 1 },
      });
    };

    try {
      const fields = parseCronExpression(schedule.cronExpression);
      const zone = assertTimeZone(schedule.timezone);

      if (!isJobName(schedule.jobName)) {
        // A job that was renamed or removed while a schedule still points at it.
        await markInvalid(CRON_RUN_STATUS.unknownJob, new Error(
          `"${schedule.jobName}" is not a declared job. Update or disable this schedule.`,
        ));
        continue;
      }

      if (schedule.nextRunAt === null) {
        // First sight of the schedule (or one whose expression was just changed).
        // Compute the next slot and fire nothing: a schedule created at 14:05 for
        // "every hour at :00" must not run the instant it is saved.
        const next = nextCronOccurrence(fields, schedule.lastRunAt ?? now, zone);
        record(CRON_RUN_STATUS.scheduled, { nextRunAt: next });
        await persist({ nextRunAt: next, lastStatus: CRON_RUN_STATUS.scheduled });
        continue;
      }

      if (schedule.nextRunAt.getTime() > now.getTime()) {
        notDue += 1;
        record(NOT_DUE, { nextRunAt: schedule.nextRunAt });
        continue;
      }

      const dueAt = schedule.nextRunAt;
      const result = await enqueueByName(schedule.jobName, schedule.payload ?? {}, {
        organizationId: schedule.organizationId,
        // The slot, not the moment: two cron processes evaluating the same due row
        // produce the same key, so the second insert collides and returns the
        // first's job. It also makes retrying a failed sweep safe.
        idempotencyKey: `cron:${schedule.id}:${dueAt.toISOString()}`,
        requestId: `cron:${schedule.key}`,
      });

      // Recomputed from `now`, not from `dueAt` -- see the file header on why a
      // tick must not catch up.
      const next = nextCronOccurrence(fields, now, zone);
      const status = result.deduplicated
        ? CRON_RUN_STATUS.deduplicated
        : CRON_RUN_STATUS.enqueued;
      if (result.deduplicated) deduplicated += 1;
      else enqueued += 1;

      scheduleLog.info('cron.schedule_fired', {
        status,
        queuedJobName: schedule.jobName,
        jobId: result.job.id,
        dueAt,
        nextRunAt: next,
      });
      record(status, { nextRunAt: next, jobId: result.job.id });
      await persist({
        lastRunAt: now,
        lastStatus: status,
        lastError: null,
        consecutiveFailures: 0,
        nextRunAt: next,
      });
    } catch (error) {
      if (error instanceof CronExpressionError) {
        await markInvalid(CRON_RUN_STATUS.invalidExpression, error);
        continue;
      }
      if (error instanceof RangeError) {
        // assertTimeZone rejects an unknown IANA identifier.
        await markInvalid(CRON_RUN_STATUS.invalidTimezone, error);
        continue;
      }
      if (error instanceof ValidationError) {
        // The schedule's stored payload does not match the job's schema.
        await markInvalid(CRON_RUN_STATUS.invalidPayload, error);
        continue;
      }

      // Transient: the database or the queue is unhappy. `nextRunAt` is left where
      // it is, so the next tick retries this same slot -- and because the
      // idempotency key is derived from the slot, retrying cannot double-fire.
      failed += 1;
      const message = describe(error);
      const failures = schedule.consecutiveFailures + 1;
      scheduleLog.error('cron.schedule_failed', { error, consecutiveFailures: failures });
      if (failures >= FAILURE_ALERT_THRESHOLD) {
        scheduleLog.error('cron.schedule_repeatedly_failing', {
          consecutiveFailures: failures,
          // Left enabled on purpose: disabling it would stop the noise and the
          // automation together, and a silent schedule is how an organisation
          // discovers months later that nobody was reminded.
          queuedJobName: schedule.jobName,
        });
      }
      record(CRON_RUN_STATUS.enqueueFailed, { error: message });
      await persist({
        lastStatus: CRON_RUN_STATUS.enqueueFailed,
        lastError: message,
        consecutiveFailures: { increment: 1 },
      });
    }
  }

  const result: CronTickResult = {
    evaluated: schedules.length,
    enqueued,
    deduplicated,
    notDue,
    invalid,
    failed,
    outcomes,
  };

  log.info('cron.tick_finished', {
    evaluated: result.evaluated,
    enqueued,
    deduplicated,
    notDue,
    invalid,
    failed,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export interface RunCronLoopOptions {
  /**
   * Twice a minute by default. Schedules have minute precision, so a tick slower
   * than a minute would miss slots; a tick faster than this buys nothing.
   */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly handleSignals?: boolean;
  readonly db?: Db;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveSleep) => {
    const onAbort = () => finish();
    const timer = setTimeout(() => finish(), ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Tick until the signal aborts or a shutdown signal arrives. */
export async function runCronLoop(options: RunCronLoopOptions = {}): Promise<void> {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS);
  const stop = new AbortController();
  const log = logger.child({ jobName: 'cron.loop' });

  const requestStop = (reason: string): void => {
    if (stop.signal.aborted) return;
    log.info('cron.shutdown_requested', { reason });
    stop.abort();
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  const onExternalAbort = () => requestStop('signal');

  const handleSignals = options.handleSignals ?? true;
  if (handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  log.info('cron.loop_started', { intervalMs });
  try {
    while (!stop.signal.aborted) {
      try {
        await runCron({ db: options.db });
      } catch (error) {
        // A sweep-wide failure (the schedules table is unreachable) must not end
        // the daemon; the next tick will try again.
        log.error('cron.tick_failed', { error });
      }
      await sleep(intervalMs, stop.signal);
    }
  } finally {
    if (handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
    options.signal?.removeEventListener('abort', onExternalAbort);
    log.info('cron.loop_stopped', {});
  }
}

export {
  CronExpressionError,
  isValidCronExpression,
  nextCronOccurrence,
  parseCronExpression,
} from '@/server/jobs/cron-expression';
