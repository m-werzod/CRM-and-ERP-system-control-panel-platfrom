/**
 * The Redis driver, honestly absent.
 *
 * `env.QUEUE_DRIVER` accepts `redis` and validates `REDIS_URL` alongside it,
 * because a deployment that outgrows the `jobs` table should be able to switch
 * driver without touching a handler. But no Redis client and no bullmq are
 * installed, so there is nothing behind this interface yet.
 *
 * What it therefore does is fail, immediately and by name. The alternative --
 * accepting an enqueue and returning a plausible-looking job row that no worker
 * will ever see -- would mean receipts that are never sent and reminders that
 * never arrive, with a green light on every dashboard. A queue that silently
 * drops work is the worst possible failure mode for this system, so selecting
 * this driver breaks at the first enqueue rather than at the first complaint.
 *
 * To implement it: add a Redis client, keep the semantics the database driver
 * documents (at-least-once delivery, `idempotencyKey` dedupe, a lease with a
 * visibility timeout, exponential backoff with jitter, a dead-letter state), and
 * remember that `EnqueueRequest.db` cannot be honoured -- a Redis enqueue cannot
 * join a PostgreSQL transaction, so it needs an outbox table to keep the
 * "receipt queued only if the payment committed" guarantee.
 */

import { IntegrationNotConfiguredError } from '@/server/errors';
import type {
  CancelRequest,
  ClaimRequest,
  CompleteRequest,
  EnqueueRequest,
  EnqueueResult,
  FailRequest,
  JobRecord,
  QueueProvider,
} from '@/server/jobs/types';

const INTEGRATION = 'Redis queue (QUEUE_DRIVER=redis)';

function notConfigured(operation: string): never {
  throw new IntegrationNotConfiguredError(
    INTEGRATION,
    `QUEUE_DRIVER=redis is selected but no Redis queue driver is implemented, so "${operation}" cannot be honoured. Set QUEUE_DRIVER=database (the default, which is fully implemented) or implement src/server/jobs/redis-queue.ts.`,
  );
}

export class RedisQueueProvider implements QueueProvider {
  readonly driver = 'redis' as const;

  async enqueue(_request: EnqueueRequest): Promise<EnqueueResult> {
    notConfigured('enqueue');
  }

  async claim(_request: ClaimRequest): Promise<JobRecord[]> {
    notConfigured('claim');
  }

  async complete(_request: CompleteRequest): Promise<boolean> {
    notConfigured('complete');
  }

  async fail(_request: FailRequest): Promise<JobRecord | null> {
    notConfigured('fail');
  }

  async cancel(_request: CancelRequest): Promise<boolean> {
    notConfigured('cancel');
  }

  // `reapAbandoned` is deliberately not implemented: the interface marks it
  // optional, and a driver that cannot enqueue has no leases to reclaim.
}
