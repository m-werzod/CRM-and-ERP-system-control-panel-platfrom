/**
 * The outbox worker side: take one persisted Notification and put it on a wire.
 *
 * This runs in a background job, never in a request, and the split is the whole
 * design (see ./enqueue.ts): `notify()` writes the row inside the business
 * transaction, `renderAndDeliver()` talks to the gateway afterwards. Nothing here
 * opens a transaction around the provider call, because holding a PostgreSQL
 * transaction open across an HTTP request to Eskiz is how a pool of ten
 * connections becomes an outage.
 *
 * THE MESSAGE TEXT IS ALREADY DECIDED. `Notification.body` was rendered at
 * enqueue time and is the record of what the institution said; this module only
 * turns it into the wire form a channel needs. "Render" here therefore means
 * channel presentation -- an HTML alternative for email, nothing for SMS -- not
 * a second pass over the template, because re-rendering at send time would let a
 * template edited in between silently change a message the in-app feed has
 * already shown.
 *
 * At-least-once delivery is assumed: a job may run twice, so a row that has
 * already reached a terminal status is left alone rather than sent again.
 */

import { z } from 'zod';
import type {
  CommunicationStatus,
  NotificationChannel,
  NotificationStatus,
} from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { NotFoundError } from '@/server/errors';
import { enqueue as enqueueJob, JOB_NAMES } from '@/server/jobs';
import {
  getProviderForChannel,
  type MessageChannel,
  type MessageProvider,
  type OutboundMessage,
  type SendResult,
} from '@/server/integrations/messaging';
import { logger } from '@/server/observability/logger';
import { getSetting } from '@/server/settings';
import {
  channelAddress,
  maskAddress,
  resolveRecipients,
  UNADDRESSABLE_CHANNELS,
  type RecipientSelector,
} from './recipients';
import { escapeHtml } from './template';

// ---------------------------------------------------------------------------
// The stored payload envelope
// ---------------------------------------------------------------------------

/**
 * `Notification.payload` as `notify()` writes it.
 *
 * `variables` is the render context, kept for support ("what did we actually
 * tell them?") and for a re-send after a template fix. `address` exists for the
 * one recipient the schema cannot point at: a lead awaiting a trial reminder or
 * an applicant awaiting a decision has no user, guardian or student row, so the
 * only place to keep their number is the row's own payload.
 *
 * Parsed leniently -- unknown keys are ignored -- because a row may have been
 * written by an earlier deployment and a delivery must not fail over a field
 * this version does not know about.
 */
export const deliveryEnvelopeSchema = z.object({
  address: z
    .object({
      /** An email address or an E.164 phone number. */
      value: z.string().trim().min(1).max(320),
      displayName: z.string().trim().max(200).optional(),
    })
    .optional(),
});

export type DeliveryEnvelope = z.infer<typeof deliveryEnvelopeSchema>;

function readEnvelope(payload: unknown): DeliveryEnvelope {
  const parsed = deliveryEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data : {};
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** Stored as `CommunicationLog.provider` for the channel that has no vendor. */
export const IN_APP_PROVIDER_KEY = 'in-app';

export interface DeliveryOutcome {
  readonly notificationId: string;
  readonly status: NotificationStatus;
  readonly attempts: number;
  /** Null when nothing was dispatched: a terminal row, or an unaddressable one. */
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly skipReason: string | null;
  readonly error: string | null;
  /**
   * True when the row is left PENDING for another attempt. The caller does NOT
   * have to act on it -- `renderAndDeliver` throws in that case so the queue's
   * backoff schedules the retry -- but a batch sweep reads it to decide whether
   * to count the row as settled.
   */
  readonly willRetry: boolean;
}

// ---------------------------------------------------------------------------
// Channel plumbing
// ---------------------------------------------------------------------------

/**
 * A status nothing should be sent from again.
 *
 * FAILED is in the set even though an operator may retry: a manual re-send
 * resets the row to PENDING first, so a job that finds FAILED is a duplicate
 * delivery of work that has already concluded.
 */
const TERMINAL_STATUSES: ReadonlySet<NotificationStatus> = new Set<NotificationStatus>([
  'SENT',
  'DELIVERED',
  'READ',
  'SKIPPED',
  'FAILED',
]);

/**
 * The messaging channels that have a provider. Returns the same literal rather
 * than casting, so adding a `NotificationChannel` member forces a decision here
 * instead of silently falling into one branch or the other.
 */
function wireChannel(channel: NotificationChannel): MessageChannel | null {
  switch (channel) {
    case 'EMAIL':
    case 'SMS':
    case 'TELEGRAM':
    case 'WHATSAPP':
      return channel;
    case 'IN_APP':
    case 'PUSH':
      return null;
  }
}

/**
 * The HTML alternative for email.
 *
 * Substituted values AND the operator's own template text are escaped, then
 * newlines are honoured by CSS rather than by inserted markup. That means an
 * operator cannot author real HTML in a template body -- a genuine limitation --
 * and it is the deliberate trade: `NotificationTemplate.body` is editable by
 * anyone with `notifications.manageTemplates`, so treating it as markup would
 * make a receptionist's text field a stored-XSS vector into every guardian's
 * inbox. An HTML email builder belongs behind its own column and its own
 * sanitiser, not here.
 */
function htmlPart(text: string): string {
  return `<div style="white-space:pre-wrap;font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(
    text,
  )}</div>`;
}

const NOTIFICATION_SELECT = {
  id: true,
  organizationId: true,
  event: true,
  channel: true,
  priority: true,
  status: true,
  attempts: true,
  subject: true,
  body: true,
  payload: true,
  recipientUserId: true,
  recipientGuardianId: true,
  recipientStudentId: true,
} as const;

/** The recipient pointer as a selector `resolveRecipients` understands. */
function selectorFor(row: {
  recipientUserId: string | null;
  recipientGuardianId: string | null;
  recipientStudentId: string | null;
}): RecipientSelector | null {
  if (row.recipientGuardianId) return { kind: 'GUARDIAN', guardianId: row.recipientGuardianId };
  if (row.recipientUserId) return { kind: 'USER', userId: row.recipientUserId };
  if (row.recipientStudentId) return { kind: 'STUDENT', studentId: row.recipientStudentId };
  return null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Render one Notification for its channel, send it, and record what happened.
 *
 * Returns the outcome for every settled row. Throws only for a retryable
 * transport failure that still has budget left, so the queue's own backoff
 * schedules the next attempt -- a gateway that is down for ten minutes should be
 * waited out, not hammered inside this function.
 */
export async function renderAndDeliver(
  notificationId: string,
  db: Db = prisma,
): Promise<DeliveryOutcome> {
  const notification = await db.notification.findUnique({
    where: { id: notificationId },
    select: NOTIFICATION_SELECT,
  });

  // A row can disappear under us: deleting a guardian cascades into their
  // notifications. NotFoundError rather than a silent no-op because a job
  // pointing at nothing is worth seeing, and its 404 status is what tells a
  // worker the failure is permanent and not worth five retries.
  if (!notification) throw new NotFoundError('Notification', notificationId);

  const log = logger.child({
    organizationId: notification.organizationId,
    notificationId,
    event: notification.event,
    channel: notification.channel,
  });

  if (TERMINAL_STATUSES.has(notification.status)) {
    log.debug('notification.delivery_skipped_terminal', { status: notification.status });
    return settled(notification.id, notification.status, notification.attempts);
  }

  if (notification.body.trim().length === 0) {
    // A template that rendered to nothing. Sending an empty SMS still costs a
    // segment and tells the recipient nothing, so this is a skip with a reason
    // an operator can act on.
    return skip(db, notification.id, notification.attempts, 'the rendered message is empty', log);
  }

  const channel = notification.channel;

  if (channel === 'IN_APP') {
    return deliverInApp(db, notification.id, notification.organizationId, channel, log);
  }

  if (UNADDRESSABLE_CHANNELS.has(channel)) {
    // Telegram needs a chat id the user grants the bot, push needs a device
    // token; neither has a column in the schema. Skipping is the honest state.
    return skip(db, notification.id, notification.attempts, `${channel.toLowerCase()} has no stored address`, log);
  }

  const transport = wireChannel(channel);
  if (!transport) {
    return skip(db, notification.id, notification.attempts, `${channel.toLowerCase()} has no provider`, log);
  }

  const address = await resolveAddress(db, notification, channel);
  if (!address) {
    return skip(db, notification.id, notification.attempts, `no ${channel.toLowerCase()} address on file`, log);
  }

  const maxAttempts = await getSetting(
    'maxDeliveryAttempts',
    { organizationId: notification.organizationId },
    db,
  );

  if (notification.attempts >= maxAttempts) {
    return fail(db, {
      notificationId: notification.id,
      organizationId: notification.organizationId,
      channel,
      attempts: notification.attempts,
      provider: getProviderForChannel(transport).key,
      maskedAddress: maskAddress(channel, address),
      subject: notification.subject,
      errorCode: 'ATTEMPTS_EXHAUSTED',
      errorMessage: `Gave up after ${notification.attempts} attempts (notifications.maxDeliveryAttempts = ${maxAttempts}).`,
      log,
    });
  }

  const provider = getProviderForChannel(transport);
  const attempt = notification.attempts + 1;
  const message = buildMessage(notification, channel, address);

  const result = await send(provider, message, log);

  switch (result.status) {
    case 'SKIPPED':
      // A channel with no gateway configured. NOT a failure: the institution
      // never bought an SMS package, and recording that as a delivery failure
      // would put a red row in front of a receptionist who can do nothing about
      // it. No CommunicationLog row either -- that table is the wire record, and
      // nothing went on a wire.
      return skip(db, notification.id, notification.attempts, result.reason, log);

    case 'SENT':
      return succeed(db, {
        notificationId: notification.id,
        organizationId: notification.organizationId,
        channel,
        attempts: attempt,
        provider: provider.key,
        providerRef: result.providerRef ?? null,
        maskedAddress: maskAddress(channel, address),
        subject: notification.subject,
        segments: result.segments ?? null,
        costMinor: result.costMinor ?? null,
        currency: result.currency ?? null,
        log,
      });

    case 'FAILED': {
      const exhausted = attempt >= maxAttempts;
      if (result.retryable && !exhausted) {
        return retryLater(db, {
          notificationId: notification.id,
          attempts: attempt,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          provider: provider.key,
          log,
        });
      }
      return fail(db, {
        notificationId: notification.id,
        organizationId: notification.organizationId,
        channel,
        attempts: attempt,
        provider: provider.key,
        maskedAddress: maskAddress(channel, address),
        subject: notification.subject,
        errorCode: result.errorCode,
        errorMessage: result.retryable
          ? `${result.errorMessage} (no attempts left of ${maxAttempts})`
          : result.errorMessage,
        log,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface BatchDispatchInput {
  /** Absent means every organisation, which is what a platform cron wants. */
  readonly organizationId?: string | null;
  readonly channel?: NotificationChannel | null;
  readonly limit?: number;
}

/**
 * Fan one send job out per PENDING row.
 *
 * The safety net, not the main path: `notify()` already queues a job per row
 * inside the business transaction. This exists because at-least-once is a
 * promise about jobs that RAN, not about jobs that were written -- a queue driver
 * swapped mid-flight, a Redis flush, or a deploy that lost an in-memory schedule
 * leaves rows PENDING with nothing pointing at them, and without a sweep they
 * stay PENDING forever.
 *
 * Enqueueing rather than delivering inline is deliberate: one row per gateway
 * round trip inside a single job would blow the job's timeout at the first slow
 * provider and lose the rows behind it.
 */
export async function dispatchPendingBatch(
  input: BatchDispatchInput = {},
  db: Db = prisma,
): Promise<{ readonly queued: number; readonly deduplicated: number }> {
  const limit = input.limit ?? 100;
  const rows = await db.notification.findMany({
    where: {
      status: 'PENDING',
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    },
    // Priority first so a password reset never queues behind a night's worth of
    // homework notices; createdAt second so a backlog drains in order.
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: limit,
    select: { id: true, organizationId: true },
  });

  let queued = 0;
  let deduplicated = 0;
  for (const row of rows) {
    const result = await enqueueJob(
      JOB_NAMES.sendNotification,
      { notificationId: row.id },
      {
        organizationId: row.organizationId,
        // The same key `notify()` uses, so a sweep that races the original
        // enqueue adds nothing rather than sending twice.
        idempotencyKey: `${JOB_NAMES.sendNotification}:${row.id}`,
      },
    );
    if (result.deduplicated) deduplicated += 1;
    else queued += 1;
  }

  logger.info('notification.batch_dispatched', {
    organizationId: input.organizationId ?? null,
    channel: input.channel ?? null,
    found: rows.length,
    queued,
    deduplicated,
  });

  return { queued, deduplicated };
}

/**
 * The provider contract says `send` reports a rejection as data rather than
 * throwing, but a driver is ordinary code and a `TypeError` in one of them must
 * not leave the row stuck in PENDING forever. An unexpected throw is normalised
 * into a retryable failure, which is the safe reading: the message may or may not
 * have gone out, and the attempt counter bounds how often we find out.
 */
async function send(
  provider: MessageProvider,
  message: OutboundMessage,
  log: ReturnType<typeof logger.child>,
): Promise<SendResult> {
  try {
    return await provider.send(message);
  } catch (error) {
    log.error('notification.provider_threw', {
      provider: provider.key,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'FAILED',
      errorCode: 'PROVIDER_EXCEPTION',
      errorMessage: error instanceof Error ? error.message : 'The provider threw a non-Error.',
      retryable: true,
    };
  }
}

function buildMessage(
  notification: { id: string; organizationId: string; subject: string | null; body: string },
  channel: NotificationChannel,
  address: string,
): OutboundMessage {
  return {
    to: address,
    // Channels without a subject line ignore it; sending it anyway would put the
    // heading twice in front of an SMS reader.
    subject: channel === 'EMAIL' ? (notification.subject ?? undefined) : undefined,
    body: notification.body,
    html: channel === 'EMAIL' ? htmlPart(notification.body) : undefined,
    // Ids only. Some providers echo metadata into webhooks and keep it
    // indefinitely, so the event name stays out of it: "PASSWORD_RESET" beside a
    // masked number tells a vendor's dashboard something about a person.
    metadata: { notificationId: notification.id, organizationId: notification.organizationId },
  };
}

/**
 * The recipient's address for this channel, resolved at SEND time.
 *
 * Deliberately not stored on the row: a guardian who changed their number
 * between the absence being marked and the SMS going out should hear about it on
 * the new one, and an outbox table full of phone numbers is a second copy of the
 * contact database with none of its access control.
 */
async function resolveAddress(
  db: Db,
  notification: {
    organizationId: string;
    payload: unknown;
    recipientUserId: string | null;
    recipientGuardianId: string | null;
    recipientStudentId: string | null;
  },
  channel: NotificationChannel,
): Promise<string | null> {
  const selector = selectorFor(notification);
  if (!selector) {
    // No pointer: a lead or applicant, whose address travels in the payload.
    return readEnvelope(notification.payload).address?.value ?? null;
  }

  const [recipient] = await resolveRecipients(
    { organizationId: notification.organizationId },
    [selector],
    db,
  );
  // An empty result means the row is gone, soft-deleted or deactivated since the
  // message was queued. Nothing to send to, and not an error.
  return recipient ? channelAddress(recipient, channel) : null;
}

// ---------------------------------------------------------------------------
// Terminal writes
// ---------------------------------------------------------------------------

type ChildLog = ReturnType<typeof logger.child>;

function settled(
  notificationId: string,
  status: NotificationStatus,
  attempts: number,
  extra: Partial<DeliveryOutcome> = {},
): DeliveryOutcome {
  return {
    notificationId,
    status,
    attempts,
    provider: null,
    providerRef: null,
    skipReason: null,
    error: null,
    willRetry: false,
    ...extra,
  };
}

/**
 * IN_APP has no transport. The row in `notifications` IS the delivery -- the
 * portal queries it by `recipientUserId` -- so it goes straight to DELIVERED;
 * READ is the portal's to set when the person opens it.
 */
async function deliverInApp(
  db: Db,
  notificationId: string,
  organizationId: string,
  channel: NotificationChannel,
  log: ChildLog,
): Promise<DeliveryOutcome> {
  const now = new Date();
  await db.notification.update({
    where: { id: notificationId },
    data: { status: 'DELIVERED', sentAt: now, deliveredAt: now, attempts: 1, error: null },
  });

  await db.communicationLog.create({
    data: {
      organizationId,
      channel,
      provider: IN_APP_PROVIDER_KEY,
      direction: 'OUTBOUND',
      // There is no address to mask: `maskAddress` answers 'in-app' for this
      // channel, which is the only truthful value the column can hold.
      toAddressMasked: maskAddress(channel, IN_APP_PROVIDER_KEY),
      status: 'DELIVERED',
      relatedType: 'Notification',
      relatedId: notificationId,
      sentAt: now,
    },
  });

  log.debug('notification.delivered_in_app');
  return settled(notificationId, 'DELIVERED', 1, { provider: IN_APP_PROVIDER_KEY });
}

async function skip(
  db: Db,
  notificationId: string,
  attempts: number,
  reason: string,
  log: ChildLog,
): Promise<DeliveryOutcome> {
  await db.notification.update({
    where: { id: notificationId },
    data: { status: 'SKIPPED', skipReason: reason },
  });
  // Info, not warn: "this school has no SMS gateway" is a configuration fact
  // that would otherwise fill the error budget once per guardian per absence.
  log.info('notification.skipped', { reason });
  return settled(notificationId, 'SKIPPED', attempts, { skipReason: reason });
}

interface SuccessWrite {
  readonly notificationId: string;
  readonly organizationId: string;
  readonly channel: NotificationChannel;
  readonly attempts: number;
  readonly provider: string;
  readonly providerRef: string | null;
  readonly maskedAddress: string;
  readonly subject: string | null;
  readonly segments: number | null;
  readonly costMinor: bigint | null;
  readonly currency: string | null;
  readonly log: ChildLog;
}

async function succeed(db: Db, write: SuccessWrite): Promise<DeliveryOutcome> {
  const now = new Date();
  await db.notification.update({
    where: { id: write.notificationId },
    data: {
      // SENT, not DELIVERED: the gateway accepted it. DELIVERED is what a
      // delivery receipt webhook upgrades it to, and claiming it here would be
      // inventing a confirmation nobody gave us.
      status: 'SENT',
      sentAt: now,
      attempts: write.attempts,
      providerRef: write.providerRef,
      error: null,
    },
  });

  await db.communicationLog.create({
    data: {
      organizationId: write.organizationId,
      channel: write.channel,
      provider: write.provider,
      direction: 'OUTBOUND',
      toAddressMasked: write.maskedAddress,
      subject: write.subject,
      status: 'SENT',
      providerRef: write.providerRef,
      segments: write.segments,
      costMinor: write.costMinor,
      currency: write.currency,
      relatedType: 'Notification',
      relatedId: write.notificationId,
      sentAt: now,
    },
  });

  write.log.info('notification.sent', {
    provider: write.provider,
    attempts: write.attempts,
    segments: write.segments,
  });

  return settled(write.notificationId, 'SENT', write.attempts, {
    provider: write.provider,
    providerRef: write.providerRef,
  });
}

interface FailureWrite {
  readonly notificationId: string;
  readonly organizationId: string;
  readonly channel: NotificationChannel;
  readonly attempts: number;
  readonly provider: string;
  readonly maskedAddress: string;
  readonly subject: string | null;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly log: ChildLog;
}

/** Terminal failure: either the gateway said "never", or the budget ran out. */
async function fail(db: Db, write: FailureWrite): Promise<DeliveryOutcome> {
  const now = new Date();
  const error = `${write.errorCode}: ${write.errorMessage}`;

  await db.notification.update({
    where: { id: write.notificationId },
    data: { status: 'FAILED', failedAt: now, attempts: write.attempts, error },
  });

  await db.communicationLog.create({
    data: {
      organizationId: write.organizationId,
      channel: write.channel,
      provider: write.provider,
      direction: 'OUTBOUND',
      toAddressMasked: write.maskedAddress,
      subject: write.subject,
      status: mapFailureStatus(write.errorCode),
      errorCode: write.errorCode,
      errorMessage: write.errorMessage,
      relatedType: 'Notification',
      relatedId: write.notificationId,
    },
  });

  write.log.warn('notification.failed', {
    provider: write.provider,
    attempts: write.attempts,
    errorCode: write.errorCode,
  });

  return settled(write.notificationId, 'FAILED', write.attempts, {
    provider: write.provider,
    error,
  });
}

/**
 * A gateway that refused the address is a different operational problem from one
 * that broke: REJECTED points at the contact record, FAILED at the transport.
 * Support reads this column to decide which of the two to chase.
 */
function mapFailureStatus(errorCode: string): CommunicationStatus {
  const code = errorCode.toUpperCase();
  if (code.includes('BOUNCE')) return 'BOUNCED';
  if (code.includes('INVALID') || code.includes('BLOCKED') || code.includes('REJECT')) {
    return 'REJECTED';
  }
  return 'FAILED';
}

interface RetryWrite {
  readonly notificationId: string;
  readonly attempts: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly provider: string;
  readonly log: ChildLog;
}

/**
 * Record the attempt, leave the row PENDING, and throw.
 *
 * Throwing is what hands the retry to the queue, which owns the backoff curve;
 * looping here would hold a worker slot while a gateway is down. The two budgets
 * are independent and the smaller one wins: `notifications.maxDeliveryAttempts`
 * is the institution's, and the job's own `maxAttempts` bounds it from above.
 * `failedAt` stays null because the row has not failed yet -- it is between
 * attempts.
 */
async function retryLater(db: Db, write: RetryWrite): Promise<never> {
  const error = `${write.errorCode}: ${write.errorMessage}`;
  await db.notification.update({
    where: { id: write.notificationId },
    data: { status: 'PENDING', attempts: write.attempts, error },
  });

  write.log.warn('notification.delivery_retrying', {
    provider: write.provider,
    attempts: write.attempts,
    errorCode: write.errorCode,
  });

  throw new IntegrationRetryError(write.provider, error);
}

/**
 * Signals "try this job again" to the queue.
 *
 * Deliberately not `IntegrationFailedError`: that is a 502 an `apiRoute` would
 * hand to a browser, and this never crosses an HTTP boundary -- it exists to be
 * caught by the worker, logged, and turned into a backoff.
 */
export class IntegrationRetryError extends Error {
  readonly provider: string;
  /** Read by the worker: this failure is expected to clear on its own. */
  readonly retryable = true;

  constructor(provider: string, message: string) {
    super(`Delivery through "${provider}" failed and will be retried: ${message}`);
    this.name = 'IntegrationRetryError';
    this.provider = provider;
  }
}
