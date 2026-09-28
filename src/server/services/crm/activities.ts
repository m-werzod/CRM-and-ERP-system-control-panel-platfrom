/**
 * The lead activity trail, and the merged timeline the lead detail page renders.
 *
 * A lead's history is spread over three tables on purpose — `LeadActivity` for what
 * a human did, `LeadStatusHistory` for where it sat in the pipeline, `FollowUpTask`
 * for what was promised — because each is queried on its own by a different report.
 * The cost is that no single table can be read to answer "what happened to this
 * lead", so `getLeadTimeline` merges them, in SQL-ordered slices, into the one
 * chronological list the UI needs.
 */

import type { CallOutcome, LeadActivityType, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import { BusinessRuleError, NotFoundError } from '@/server/errors';
import { recordActivity } from '@/server/audit';
import { can, requirePermission, type AccessContext } from '@/server/rbac/access';
import {
  applyLeadStatusChange,
  leadReadFilter,
  loadLeadForWrite,
} from '@/server/services/crm/shared';

/**
 * The activity types a person may log. The rest of `LeadActivityType`
 * (STATUS_CHANGE, CONVERTED, TRIAL_BOOKED, FOLLOW_UP_*) is written by the
 * use-cases that cause those events, and accepting them from a caller would let
 * anyone forge a conversion in the trail.
 */
export const LOGGABLE_ACTIVITY_TYPES = [
  'NOTE',
  'CALL',
  'EMAIL',
  'SMS',
  'TELEGRAM',
  'MEETING',
] as const;

export type LoggableActivityType = (typeof LOGGABLE_ACTIVITY_TYPES)[number];

/** Types that count as having reached the person, so they move the SLA clock. */
const CONTACT_TYPES: ReadonlySet<LoggableActivityType> = new Set<LoggableActivityType>([
  'CALL',
  'EMAIL',
  'SMS',
  'TELEGRAM',
  'MEETING',
]);

/** Types for which a duration is meaningful. */
const TIMED_TYPES: ReadonlySet<LoggableActivityType> = new Set<LoggableActivityType>([
  'CALL',
  'MEETING',
]);

export function isLoggableActivityType(value: string): value is LoggableActivityType {
  return (LOGGABLE_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export interface LogActivityInput {
  readonly leadId: string;
  readonly type: LoggableActivityType;
  readonly subject?: string | null;
  readonly body?: string | null;
  /** Call disposition. Only meaningful for CALL. */
  readonly outcome?: CallOutcome | null;
  readonly durationSeconds?: number | null;
  /** Defaults to now. Never in the future. */
  readonly occurredAt?: Date;
}

export interface LogActivityResult {
  readonly id: string;
  readonly leadId: string;
  readonly occurredAt: Date;
  /** Set when logging first contact also advanced the lead out of NEW. */
  readonly statusChangedTo: string | null;
}

/**
 * Log a note, a call, a message or a meeting against a lead.
 *
 * Logging a CONTACT on a lead that is still NEW advances it to CONTACTED. That is
 * not a convenience: `crm.firstContactSlaHours` flags leads that have not been
 * contacted, and a pipeline where agents call people without moving the card is a
 * pipeline whose SLA report is wrong.
 */
export async function logActivity(
  ctx: AccessContext,
  input: LogActivityInput,
  db?: Db,
): Promise<LogActivityResult> {
  requirePermission(ctx, 'leads.edit');

  if (!isLoggableActivityType(input.type)) {
    throw new BusinessRuleError(
      'activity.type_not_loggable',
      `"${input.type}" is recorded by the system, not logged by hand. Use one of: ${LOGGABLE_ACTIVITY_TYPES.join(', ')}.`,
    );
  }
  if (input.outcome && input.type !== 'CALL') {
    throw new BusinessRuleError(
      'activity.outcome_not_a_call',
      'A call outcome can only be recorded against a CALL.',
    );
  }
  if (input.durationSeconds != null) {
    if (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 0) {
      throw new BusinessRuleError(
        'activity.invalid_duration',
        'A duration must be a whole number of seconds and cannot be negative.',
      );
    }
    if (!TIMED_TYPES.has(input.type)) {
      throw new BusinessRuleError(
        'activity.duration_not_applicable',
        'A duration only applies to a call or a meeting.',
      );
    }
  }

  const now = new Date();
  const occurredAt = input.occurredAt ?? now;
  if (occurredAt.getTime() > now.getTime() + 60_000) {
    throw new BusinessRuleError(
      'activity.occurred_in_future',
      'An activity cannot be logged as having happened in the future.',
    );
  }

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);

      const activity = await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: input.type,
          subject: input.subject?.trim() || null,
          body: input.body?.trim() || null,
          outcome: input.outcome ?? null,
          durationSeconds: input.durationSeconds ?? null,
          occurredAt,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: { id: true, occurredAt: true },
      });

      let statusChangedTo: string | null = null;
      if (CONTACT_TYPES.has(input.type)) {
        // Only ever moved forward, and never past a later stage the lead already
        // reached: a follow-up call on a QUALIFIED lead must not drag it back.
        await tx.lead.update({
          where: { id: lead.id },
          data: { lastContactedAt: occurredAt },
        });

        if (lead.status === 'NEW') {
          await applyLeadStatusChange(ctx, tx, lead, {
            toStatus: 'CONTACTED',
            reason: `First contact logged (${input.type.toLowerCase()})`,
            occurredAt,
          });
          statusChangedTo = 'CONTACTED';
        }
      }

      // A logged note carries no compliance weight, so it goes on the timeline
      // without an audit row — see the split documented in src/server/audit.
      await recordActivity(
        ctx,
        {
          subjectType: 'LEAD',
          subjectId: lead.id,
          type: `lead.activity.${input.type.toLowerCase()}`,
          title: input.subject?.trim() || defaultActivityTitle(input.type, input.outcome ?? null),
          description: input.body?.trim() || null,
          occurredAt,
          metadata: {
            activityId: activity.id,
            ...(input.outcome ? { outcome: input.outcome } : {}),
            ...(input.durationSeconds != null ? { durationSeconds: input.durationSeconds } : {}),
          },
        },
        tx,
      );

      return {
        id: activity.id,
        leadId: lead.id,
        occurredAt: activity.occurredAt,
        statusChangedTo,
      };
    },
    { existing: db },
  );
}

function defaultActivityTitle(
  type: LoggableActivityType,
  outcome: CallOutcome | null,
): string {
  if (type === 'CALL') return outcome ? `Call — ${outcome}` : 'Call logged';
  if (type === 'NOTE') return 'Note added';
  if (type === 'MEETING') return 'Meeting logged';
  return `${type} sent`;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type LeadTimelineKind = 'ACTIVITY' | 'STATUS' | 'FOLLOW_UP';

export interface LeadTimelineEntry {
  /** Unique within the merged list: `<kind>:<row id>:<event>`. */
  readonly key: string;
  readonly kind: LeadTimelineKind;
  readonly occurredAt: Date;
  /** Dotted type key the UI maps to an icon, e.g. `lead.activity.call`. */
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly actorName: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface GetLeadTimelineInput {
  readonly leadId: string;
  /** Page size. Each source is queried for at most this many rows. */
  readonly limit?: number;
  /** Cursor: return only entries strictly older than this instant. */
  readonly before?: Date;
}

const TIMELINE_LIMIT_DEFAULT = 50;
const TIMELINE_LIMIT_MAX = 200;

function personName(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}` : null;
}

/**
 * The merged, newest-first history of one lead.
 *
 * Paging is a time cursor rather than an offset, because the three sources cannot
 * share an OFFSET. Each is asked for `limit` rows older than the cursor and the
 * merge is truncated to `limit`; the entries dropped by that truncation are older
 * than the returned cursor, so the next page picks them up. Nothing is skipped and
 * nothing is repeated.
 */
export async function getLeadTimeline(
  ctx: AccessContext,
  input: GetLeadTimelineInput,
  db?: Db,
): Promise<LeadTimelineEntry[]> {
  requirePermission(ctx, 'leads.view');

  const client = db ?? prisma;
  const limit = Math.min(TIMELINE_LIMIT_MAX, Math.max(1, input.limit ?? TIMELINE_LIMIT_DEFAULT));

  // The lead is re-resolved through the read filter so this use-case cannot be
  // called with an id from another branch to read its history.
  const scoped = await leadReadFilter(ctx, client, {
    includeArchived: can(ctx, 'leads.delete'),
  });
  const lead = await client.lead.findFirst({
    where: { ...scoped, id: input.leadId },
    select: { id: true },
  });
  if (!lead) throw new NotFoundError('Lead', input.leadId);

  const before = input.before;
  const activityWhere: Prisma.LeadActivityWhereInput = {
    leadId: lead.id,
    ...(before ? { occurredAt: { lt: before } } : {}),
  };
  const statusWhere: Prisma.LeadStatusHistoryWhereInput = {
    leadId: lead.id,
    ...(before ? { changedAt: { lt: before } } : {}),
  };
  const followUpWhere: Prisma.FollowUpTaskWhereInput = {
    leadId: lead.id,
    ...(before ? { createdAt: { lt: before } } : {}),
  };

  const [activities, statusRows, followUps] = await Promise.all([
    client.leadActivity.findMany({
      where: activityWhere,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        type: true,
        subject: true,
        body: true,
        outcome: true,
        durationSeconds: true,
        occurredAt: true,
        createdBy: { select: { firstName: true, lastName: true } },
      },
    }),
    client.leadStatusHistory.findMany({
      where: statusWhere,
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        changedAt: true,
        changedBy: { select: { firstName: true, lastName: true } },
      },
    }),
    client.followUpTask.findMany({
      where: followUpWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        description: true,
        dueAt: true,
        status: true,
        completedAt: true,
        completionNote: true,
        createdAt: true,
        assignedToUser: { select: { firstName: true, lastName: true } },
        completedBy: { select: { firstName: true, lastName: true } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  const entries: LeadTimelineEntry[] = [];

  for (const activity of activities) {
    entries.push({
      key: `ACTIVITY:${activity.id}`,
      kind: 'ACTIVITY',
      occurredAt: activity.occurredAt,
      type: `lead.activity.${activity.type.toLowerCase()}`,
      title: activity.subject ?? activityTitleFor(activity.type),
      description: activity.body,
      actorName: personName(activity.createdBy),
      metadata: {
        activityType: activity.type,
        ...(activity.outcome ? { outcome: activity.outcome } : {}),
        ...(activity.durationSeconds != null
          ? { durationSeconds: activity.durationSeconds }
          : {}),
      },
    });
  }

  for (const row of statusRows) {
    entries.push({
      key: `STATUS:${row.id}`,
      kind: 'STATUS',
      occurredAt: row.changedAt,
      type: 'lead.status_changed',
      title: row.fromStatus
        ? `${row.fromStatus} → ${row.toStatus}`
        : `Entered the pipeline as ${row.toStatus}`,
      description: row.reason,
      actorName: personName(row.changedBy),
      metadata: { fromStatus: row.fromStatus, toStatus: row.toStatus },
    });
  }

  for (const task of followUps) {
    entries.push({
      key: `FOLLOW_UP:${task.id}:created`,
      kind: 'FOLLOW_UP',
      occurredAt: task.createdAt,
      type: 'lead.follow_up.created',
      title: `Follow-up scheduled: ${task.title}`,
      description: task.description,
      actorName: personName(task.createdBy),
      metadata: {
        followUpTaskId: task.id,
        dueAt: task.dueAt,
        assignedTo: personName(task.assignedToUser),
        status: task.status,
      },
    });

    // A cancelled task has no timestamp of its own in the schema, so only a
    // completion produces a second entry; the cancellation shows as the task's
    // current status on the entry above.
    if (task.completedAt) {
      entries.push({
        key: `FOLLOW_UP:${task.id}:completed`,
        kind: 'FOLLOW_UP',
        occurredAt: task.completedAt,
        type: 'lead.follow_up.completed',
        title: `Follow-up completed: ${task.title}`,
        description: task.completionNote,
        actorName: personName(task.completedBy),
        metadata: { followUpTaskId: task.id },
      });
    }
  }

  entries.sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.key.localeCompare(b.key),
  );

  return entries.slice(0, limit);
}

function activityTitleFor(type: LeadActivityType): string {
  switch (type) {
    case 'NOTE':
      return 'Note added';
    case 'CALL':
      return 'Call logged';
    case 'MEETING':
      return 'Meeting logged';
    case 'STATUS_CHANGE':
      return 'Status changed';
    case 'ASSIGNMENT':
      return 'Ownership changed';
    case 'CONVERTED':
      return 'Converted to a student';
    case 'TRIAL_BOOKED':
      return 'Trial lesson booked';
    case 'TRIAL_ATTENDED':
      return 'Trial lesson attended';
    case 'FOLLOW_UP_CREATED':
      return 'Follow-up scheduled';
    case 'FOLLOW_UP_COMPLETED':
      return 'Follow-up completed';
    case 'APPLICATION_CREATED':
      return 'Application started';
    case 'DOCUMENT_ATTACHED':
      return 'Document attached';
    default:
      return `${type} logged`;
  }
}
