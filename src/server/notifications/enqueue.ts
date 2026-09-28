/**
 * `notify()` -- the only way business code asks for a message to be sent.
 *
 * THE INVARIANT THIS MODULE EXISTS TO HOLD: enqueueing is part of the business
 * transaction, sending is not. `notify()` writes `Notification` rows and the
 * delivery job inside the CALLER'S transaction, so the promise of a message
 * commits or vanishes atomically with the attendance register or the payment
 * that caused it -- and nothing here ever opens a socket to a gateway. A dead SMS
 * provider must never be able to roll back an attendance submission or a
 * payment, and a payment that rolled back must never leave a receipt behind.
 * Everything that can fail slowly lives in ./dispatch.ts, behind the queue.
 *
 * Rendering happens HERE, not at send time, and the rendered text is stored on
 * the row. That makes `Notification.body` the record of what the institution
 * actually said: the in-app feed, the send log and a support query all read the
 * same sentence, and a template edited tomorrow cannot retroactively change a
 * message a parent already saw. `renderTemplate` never throws (see ./template.ts)
 * precisely so that an operator's stray `{{#if` cannot abort the transaction.
 *
 * NO PERMISSION CHECK. A notification is a side effect of an action that was
 * already authorised: a teacher submitting a register does not additionally hold
 * `notifications.send`, which gates the ad-hoc "message this group" use-case.
 * Tenancy is still absolute -- every row and every query is bound to
 * `ctx.organizationId`.
 */

import { randomUUID } from 'node:crypto';
import { Locale, NotificationChannel } from '@/generated/prisma/client';
import type { NotificationEvent, NotificationPriority } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { enqueue as enqueueJob, JOB_NAMES } from '@/server/jobs';
import { assertBranchAccess, type AccessContext } from '@/server/rbac/access';
import { logger } from '@/server/observability/logger';
import { getSetting, getSettings } from '@/server/settings';
import {
  addDaysToDateOnly,
  instantToWallClockMinute,
  todayIn,
  zonedWallClockToInstant,
  type TimeZone,
} from '@/lib/dates';
import {
  eventDefinition,
  parseEventVariables,
  type Audience,
  type EventVariables,
} from './events';
import {
  loadPreferences,
  pointerFor,
  resolveRecipients,
  UNADDRESSABLE_CHANNELS,
  type RecipientSelector,
  type ResolvedRecipient,
} from './recipients';
import { findDefaultTemplate } from './templates';
import { renderTemplate, type TemplateContext } from './template';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface NotifyInput<E extends NotificationEvent> {
  readonly event: E;
  /** Checked against the event's zod schema; a missing field fails to compile. */
  readonly variables: EventVariables<E>;
  /**
   * Explicit recipients. When omitted, the event's `defaultAudience` is expanded
   * and `subjectId` must name the student or user it hangs off.
   */
  readonly recipients?: readonly RecipientSelector[];
  /** The student or user the default audience is derived from. */
  readonly subjectId?: string;
  /**
   * Overrides `notifications.channelPriority` for this call. For an event that
   * only makes sense on one channel -- a password reset link has no business in
   * an SMS if email is available -- the call site names the order it wants.
   */
  readonly channels?: readonly NotificationChannel[];
  /**
   * Namespaced idempotency base, e.g. `absence:<lessonId>:<studentId>`. One row
   * per recipient per channel is derived from it, so "one absence notice per
   * student per lesson" survives the event firing twice.
   */
  readonly dedupeKey?: string;
  /** Defaults to the event's declared priority. */
  readonly priority?: NotificationPriority;
  /** Scopes the branch-overridable settings (quiet hours, the guardian gates). */
  readonly branchId?: string | null;
  /** Deep link the in-app notification opens. */
  readonly actionUrl?: string;
}

export interface NotifyResult {
  readonly event: NotificationEvent;
  /** Ids of the rows that are now queued for delivery. */
  readonly notificationIds: readonly string[];
  /** Rows written as SKIPPED, with the reason, so silence is explainable. */
  readonly suppressed: readonly { readonly recipient: string; readonly reason: string }[];
  /** Set when quiet hours pushed the wire delivery to a later instant. */
  readonly deferredUntil: Date | null;
}

// ---------------------------------------------------------------------------
// Settings narrowing
//
// `notifications.channelPriority` and `locale.defaultLocale` are enum-valued
// settings, but `SettingDefinition<T>` infers T from `defaultValue` as well as
// from the schema, so an array literal widens them to `string[]` and `string`.
// The registry is not ours to change, and a cast would be a lie about a column an
// operator can edit -- these guards narrow the same way the zod schema already
// validated, and drop a member this build does not know.
// ---------------------------------------------------------------------------

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(Object.values(NotificationChannel));
const KNOWN_LOCALES: ReadonlySet<string> = new Set<string>(Object.values(Locale));

function isChannel(value: string): value is NotificationChannel {
  return KNOWN_CHANNELS.has(value);
}

function isLocale(value: string): value is Locale {
  return KNOWN_LOCALES.has(value);
}

// ---------------------------------------------------------------------------
// JSON payload
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/**
 * Reduce validated event variables to values that are both JSON-storable and
 * renderable.
 *
 * One function for both because the stored `payload` and the render context must
 * be the same data -- a support engineer reading the payload has to see exactly
 * what the template saw. Anything outside the JSON primitives is dropped rather
 * than coerced: the event schemas promise pre-formatted strings and integers (see
 * ./events.ts), so a `Date` or a `bigint` arriving here is a call site that
 * skipped `formatMoney`/`@/lib/dates`, and silently stringifying it would put
 * `1970-01-01T00:00:00.000Z` or `45000000` in front of a parent.
 */
function toJsonObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    const converted = toJsonValue(nested);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return value;
    default:
      break;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const converted = toJsonValue(item);
      if (converted !== undefined) items.push(converted);
    }
    return items;
  }
  if (typeof value === 'object') return toJsonObject(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// Audience expansion
// ---------------------------------------------------------------------------

/**
 * Turn the event's declared audience into selectors.
 *
 * An audience that needs a subject and did not get one yields nothing rather
 * than throwing: the alternative is a 500 on an attendance submission because
 * somebody forgot an id, which is exactly the coupling this whole module is
 * built to avoid. The gap is logged and reported in the result.
 */
function expandAudience(
  audiences: readonly Audience[],
  subjectId: string | undefined,
  branchId: string | null,
): readonly RecipientSelector[] {
  const selectors: RecipientSelector[] = [];
  for (const audience of audiences) {
    switch (audience.kind) {
      case 'GUARDIANS_OF_STUDENT':
        if (subjectId) selectors.push({ kind: 'GUARDIANS_OF_STUDENT', studentId: subjectId });
        break;
      case 'STUDENT':
        if (subjectId) selectors.push({ kind: 'STUDENT', studentId: subjectId });
        break;
      case 'ASSIGNED_USER':
        if (subjectId) selectors.push({ kind: 'USER', userId: subjectId });
        break;
      case 'STAFF_WITH_PERMISSION':
        selectors.push({
          kind: 'STAFF_WITH_PERMISSION',
          permission: audience.permission,
          branchId,
        });
        break;
      case 'EXPLICIT':
        // By definition the call site owns these; nothing to derive.
        break;
    }
  }
  return selectors;
}

/** A selector that reaches a guardian, for the guardian-gate settings. */
function targetsGuardian(selector: RecipientSelector): boolean {
  return selector.kind === 'GUARDIAN' || selector.kind === 'GUARDIANS_OF_STUDENT';
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

interface QuietHours {
  readonly enabled: boolean;
  readonly fromMinute: number;
  readonly toMinute: number;
}

/**
 * When a non-critical message should go out instead of now.
 *
 * CRITICAL priority always goes immediately, and that is a deliberate exception
 * rather than an oversight: the critical events are a password reset link with a
 * lifetime measured in minutes and a security alert about somebody signing in as
 * you. Holding either until 08:00 is not politeness, it is a link that has
 * expired and a break-in nobody was told about. Everything else -- an absence, a
 * receipt, a grade -- can wait for morning.
 *
 * `from === to` is treated as no window at all. A zero-length window is what an
 * operator produces by mistake; reading it as "suppress for 24 hours" would
 * silently stop every message in the institution.
 */
function quietHoursDeferral(
  quiet: QuietHours,
  priority: NotificationPriority,
  zone: TimeZone,
  now: Date,
): Date | null {
  if (!quiet.enabled || priority === 'CRITICAL') return null;
  if (quiet.fromMinute === quiet.toMinute) return null;

  const minute = instantToWallClockMinute(now, zone);
  const wraps = quiet.fromMinute > quiet.toMinute;
  const inside = wraps
    ? minute >= quiet.fromMinute || minute < quiet.toMinute
    : minute >= quiet.fromMinute && minute < quiet.toMinute;
  if (!inside) return null;

  const today = todayIn(zone, now);
  const endToday = zonedWallClockToInstant(today, quiet.toMinute, zone);
  // Inside a window that started yesterday evening, the end is still ahead of us
  // today; inside one that starts this morning, it is tomorrow's.
  return endToday > now ? endToday : zonedWallClockToInstant(addDaysToDateOnly(today, 1), quiet.toMinute, zone);
}

// ---------------------------------------------------------------------------
// Template selection and rendering
// ---------------------------------------------------------------------------

interface TemplateRow {
  readonly id: string;
  readonly channel: NotificationChannel;
  readonly locale: Locale;
  readonly subject: string | null;
  readonly body: string;
}

interface Rendered {
  readonly templateId: string | null;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * The organisation's own template, else the built-in default.
 *
 * Telegram, WhatsApp and push borrow the SMS text: all three are read on a phone
 * in the same glance, and no organisation is expected to author four copies of
 * one sentence. A channel with no row and no default returns null, and the caller
 * declines to write a row at all -- a `Notification` with an empty body would
 * cost an SMS segment and say nothing.
 */
function pickTemplate(
  rows: readonly TemplateRow[],
  event: NotificationEvent,
  channel: NotificationChannel,
  locale: Locale,
  fallbackLocale: Locale,
): TemplateRow | { readonly builtIn: true; readonly subject: string | null; readonly body: string } | null {
  const bodyChannels: readonly NotificationChannel[] =
    channel === 'IN_APP' || channel === 'EMAIL' ? [channel] : [channel, 'SMS'];
  const locales = locale === fallbackLocale ? [locale] : [locale, fallbackLocale];

  for (const candidateChannel of bodyChannels) {
    for (const candidateLocale of locales) {
      const row = rows.find(
        (entry) => entry.channel === candidateChannel && entry.locale === candidateLocale,
      );
      if (row) return row;
    }
  }

  for (const candidateLocale of locales) {
    const seed = findDefaultTemplate(event, channel, candidateLocale);
    if (seed) return { builtIn: true, subject: seed.subject, body: seed.body };
  }
  return null;
}

function render(
  template: TemplateRow | { builtIn: true; subject: string | null; body: string },
  context: TemplateContext,
  describe: Record<string, unknown>,
): Rendered {
  const body = renderTemplate(template.body, context);
  const subject = template.subject ? renderTemplate(template.subject, context) : null;

  const problems = [...body.syntaxErrors, ...(subject?.syntaxErrors ?? [])];
  const missing = [...new Set([...body.missingVariables, ...(subject?.missingVariables ?? [])])];

  // Rendering degrades rather than throwing, so a template problem has to be
  // visible somewhere or it is invisible everywhere: the operator who wrote the
  // typo never sees the blank space it leaves in nine hundred messages.
  if (problems.length > 0 || missing.length > 0) {
    logger.warn('notification.template_problem', { ...describe, problems, missing });
  }

  return {
    templateId: 'builtIn' in template ? null : template.id,
    subject: subject?.text ?? null,
    body: body.text,
  };
}

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

interface PlannedRow {
  readonly dedupeKey: string;
  readonly channel: NotificationChannel;
  readonly recipient: ResolvedRecipient;
  readonly rendered: Rendered;
  readonly skipReason: string | null;
}

/**
 * Queue a notification for an event.
 *
 * Pass the caller's `db` whenever there is one. Without it the rows commit on
 * their own, which is correct only for a job or a cron sweep that has no
 * surrounding business transaction to belong to.
 */
export async function notify<E extends NotificationEvent>(
  ctx: AccessContext,
  input: NotifyInput<E>,
  db: Db = prisma,
): Promise<NotifyResult> {
  const definition = eventDefinition(input.event);
  const branchId = input.branchId ?? null;
  if (branchId) assertBranchAccess(ctx, branchId, 'notification');

  const priority = input.priority ?? definition.defaultPriority;
  const scope = { organizationId: ctx.organizationId, branchId };

  const settings = await getSettings(
    ['channelPriority', 'quietHours', 'timezone', 'defaultLocale'],
    scope,
    db,
  );

  // --- audience -----------------------------------------------------------
  let selectors =
    input.recipients ??
    expandAudience(definition.defaultAudience, input.subjectId, branchId);

  if (definition.guardianGate) {
    const guardiansEnabled = await getSetting(definition.guardianGate, scope, db);
    if (!guardiansEnabled) {
      // The gate belongs to the event, not to the dozen call sites that can
      // cause it, which is why it travels on the definition.
      selectors = selectors.filter((selector) => !targetsGuardian(selector));
    }
  }

  if (selectors.length === 0) {
    logger.warn('notification.no_recipients', {
      organizationId: ctx.organizationId,
      event: input.event,
      subjectRequirement: definition.subjectRequirement,
      hasSubject: Boolean(input.subjectId),
    });
    return { event: input.event, notificationIds: [], suppressed: [], deferredUntil: null };
  }

  const recipients = await resolveRecipients({ organizationId: ctx.organizationId }, selectors, db);
  if (recipients.length === 0) {
    return { event: input.event, notificationIds: [], suppressed: [], deferredUntil: null };
  }

  // --- context ------------------------------------------------------------
  // Validated even though the compiler already checked the call site: the same
  // variables arrive from a job payload and from a support re-send, neither of
  // which the compiler saw.
  const variables = toJsonObject(parseEventVariables(input.event, input.variables));

  const [preferences, templateRows] = await Promise.all([
    loadPreferences(input.event, recipients, db),
    db.notificationTemplate.findMany({
      where: {
        organizationId: ctx.organizationId,
        key: definition.templateKey,
        isActive: true,
      },
      select: { id: true, channel: true, locale: true, subject: true, body: true },
    }),
  ]);

  const channelOrder = input.channels ?? settings.channelPriority.filter(isChannel);
  const fallbackLocale: Locale = isLocale(settings.defaultLocale) ? settings.defaultLocale : 'UZ';

  // --- plan ---------------------------------------------------------------
  const planned: PlannedRow[] = [];
  const suppressed: { recipient: string; reason: string }[] = [];

  for (const recipient of recipients) {
    const locale = recipient.locale ?? fallbackLocale;
    const choice = chooseChannel(recipient, channelOrder, preferences.allows);

    const template = pickTemplate(
      templateRows,
      input.event,
      choice.channel,
      locale,
      fallbackLocale,
    );
    if (!template) {
      suppressed.push({
        recipient: recipient.key,
        reason: `no ${choice.channel.toLowerCase()} template for ${input.event}`,
      });
      continue;
    }

    const rendered = render(template, variables, {
      organizationId: ctx.organizationId,
      event: input.event,
      channel: choice.channel,
      locale,
    });
    if (rendered.body.trim().length === 0) {
      suppressed.push({ recipient: recipient.key, reason: 'the template rendered to nothing' });
      continue;
    }

    planned.push({
      dedupeKey: rowDedupeKey(input.dedupeKey, input.event, recipient.key, choice.channel),
      channel: choice.channel,
      recipient,
      rendered,
      skipReason: choice.skipReason,
    });
    if (choice.skipReason) suppressed.push({ recipient: recipient.key, reason: choice.skipReason });
  }

  if (planned.length === 0) {
    return { event: input.event, notificationIds: [], suppressed, deferredUntil: null };
  }

  // --- write --------------------------------------------------------------
  await db.notification.createMany({
    data: planned.map((row) => ({
      organizationId: ctx.organizationId,
      ...pointerColumns(row.recipient, row.channel),
      event: input.event,
      channel: row.channel,
      priority,
      templateId: row.rendered.templateId,
      subject: row.rendered.subject,
      body: row.rendered.body,
      actionUrl: input.actionUrl ?? null,
      status: row.skipReason ? ('SKIPPED' as const) : ('PENDING' as const),
      skipReason: row.skipReason,
      dedupeKey: row.dedupeKey,
      payload: payloadFor(variables, row.recipient, row.channel),
    })),
    // The unique index on `dedupeKey` is the real guarantee; skipping duplicates
    // is what keeps a second firing of the event from aborting the caller's
    // transaction on a 23505 it cannot recover from inside one.
    skipDuplicates: true,
  });

  const rows = await db.notification.findMany({
    where: {
      organizationId: ctx.organizationId,
      dedupeKey: { in: planned.map((row) => row.dedupeKey) },
      status: 'PENDING',
    },
    select: { id: true, channel: true },
  });

  // --- hand over to the queue --------------------------------------------
  const deferral = quietHoursDeferral(
    settings.quietHours,
    priority,
    settings.timezone,
    new Date(),
  );
  let applied: Date | null = null;

  for (const row of rows) {
    // Quiet hours hold a phone buzzing at 02:00, not a row in a feed nobody is
    // woken by, so an in-app notification is never deferred.
    const runAt = row.channel === 'IN_APP' ? undefined : (deferral ?? undefined);
    if (runAt) applied = runAt;
    await enqueueJob(
      JOB_NAMES.sendNotification,
      { notificationId: row.id },
      {
        db,
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        runAt,
        // At-least-once means notify() may run twice for the same row; the job's
        // own idempotency key keeps that from becoming two deliveries.
        idempotencyKey: `${JOB_NAMES.sendNotification}:${row.id}`,
      },
    );
  }

  return {
    event: input.event,
    notificationIds: rows.map((row) => row.id),
    suppressed,
    deferredUntil: applied,
  };
}

// ---------------------------------------------------------------------------
// Channel choice
// ---------------------------------------------------------------------------

interface ChannelChoice {
  readonly channel: NotificationChannel;
  /** Set when no channel was usable; the row is written SKIPPED with it. */
  readonly skipReason: string | null;
}

/**
 * The first channel in the configured order that can actually reach this person.
 *
 * `notifications.channelPriority` is documented as "channels attempted, in order,
 * until one succeeds", so this is one message per recipient, not a broadcast
 * across every channel they own -- a parent with a portal login, a phone and an
 * email address gets one absence notice, not three, and the institution is billed
 * for one.
 *
 * "Succeeds" is settled at enqueue time as "is addressable and not opted out",
 * because whether a gateway accepts the message is only known in ./dispatch.ts.
 * True failover -- a FAILED SMS advancing to email -- would need dispatch to
 * queue the next channel, which it does not yet do; a row that fails stays
 * failed and visible.
 */
function chooseChannel(
  recipient: ResolvedRecipient,
  order: readonly NotificationChannel[],
  allows: (recipient: ResolvedRecipient, channel: NotificationChannel) => boolean,
): ChannelChoice {
  let optedOut = false;
  for (const channel of order) {
    if (UNADDRESSABLE_CHANNELS.has(channel)) continue;
    if (!recipient.addresses[channel]) continue;
    if (!allows(recipient, channel)) {
      optedOut = true;
      continue;
    }
    return { channel, skipReason: null };
  }

  // Nothing worked. A row is still written, on the channel the institution would
  // have preferred, so "why did this parent hear nothing?" is answerable from the
  // data instead of from an absence of data.
  const fallback = order.find((channel) => !UNADDRESSABLE_CHANNELS.has(channel)) ?? 'IN_APP';
  return {
    channel: fallback,
    skipReason: optedOut
      ? 'the recipient has opted out of every available channel'
      : 'the recipient has no address for any enabled channel',
  };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

/**
 * Exactly one recipient pointer, or none.
 *
 * NOTE FOR WHOEVER OWNS prisma/schema/12-communication.prisma: the model's
 * comment says "Exactly one recipient pointer is set". A lead awaiting a trial
 * reminder and an applicant awaiting a decision have no user, guardian or student
 * row to point at, and both are `EXPLICIT`-audience events in ./events.ts, so
 * this widens it to "AT MOST one". Such a row carries its address in
 * `payload.address` instead; ./dispatch.ts reads it from there. There is no CHECK
 * constraint either way -- the comment is what needs updating.
 */
function pointerColumns(
  recipient: ResolvedRecipient,
  channel: NotificationChannel,
): {
  recipientUserId: string | null;
  recipientGuardianId: string | null;
  recipientStudentId: string | null;
} {
  const pointer = pointerFor(recipient, channel);
  return {
    recipientUserId: pointer?.pointer === 'USER' ? pointer.id : null,
    recipientGuardianId: pointer?.pointer === 'GUARDIAN' ? pointer.id : null,
    recipientStudentId: pointer?.pointer === 'STUDENT' ? pointer.id : null,
  };
}

function payloadFor(
  variables: JsonObject,
  recipient: ResolvedRecipient,
  channel: NotificationChannel,
): JsonObject {
  const payload: JsonObject = { variables };
  // Only a recipient with no row to point at needs its address persisted. For
  // everyone else the pointer is deliberately the only thing stored, so a number
  // changed between enqueue and send reaches the new one, and the outbox does not
  // become a second copy of the contact database.
  const hasRow = recipient.userId || recipient.guardianId || recipient.studentId;
  const address = recipient.addresses[channel];
  if (!hasRow && address) {
    payload.address = { value: address, displayName: recipient.displayName };
  }
  return payload;
}

/**
 * The per-row idempotency key.
 *
 * A caller-supplied base is what makes the guarantee real; the `auto:` form is an
 * honest admission that this call asked for no deduplication, and exists so the
 * write path is one branch rather than two -- `createMany({ skipDuplicates })`
 * needs a value in the unique column.
 */
function rowDedupeKey(
  base: string | undefined,
  event: NotificationEvent,
  recipientKey: string,
  channel: NotificationChannel,
): string {
  if (base) return `${base}:${recipientKey}:${channel}`;
  return `auto:${event}:${randomUUID()}`;
}
