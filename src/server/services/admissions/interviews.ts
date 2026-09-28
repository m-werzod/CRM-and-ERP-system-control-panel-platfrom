/**
 * Admission interviews.
 *
 * A reschedule does NOT move the existing row. The old interview is closed as
 * RESCHEDULED and a new SCHEDULED row is opened, the same dated-history rule the
 * enrollment and assignment models follow: "we moved them twice and they still did
 * not turn up" must stay readable afterwards, and an in-place update erases it.
 *
 * Double-booking is prevented by an explicit overlap test rather than a database
 * constraint, because interviews have a duration rather than a slot and no unique
 * index can express "these two intervals intersect".
 */

import type { ApplicationDecision, InterviewStatus } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  ScheduleConflictError,
  StateInvalidError,
} from '@/server/errors';
import { record as recordAudit } from '@/server/audit';
import { requirePermission, scopeFilter, type AccessContext } from '@/server/rbac/access';
import { intervalsOverlap, plusMinutes } from '@/lib/dates';
import { loadApplicationForWrite } from '@/server/services/admissions/applications';

/** Statuses from which an interview may be arranged. */
const SCHEDULABLE_STATUSES = new Set([
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'WAITLISTED',
]);

/**
 * Upper bound on an interview's length. Also the lookback window for the conflict
 * query: no existing interview that starts more than this long before a new one can
 * still be running when it begins, so the search stays a narrow indexed range
 * instead of a scan of the interviewer's whole history.
 */
const MAX_DURATION_MINUTES = 480;

/** Only a live booking holds a slot; the rest are history. */
const SLOT_HOLDING_STATUSES: readonly InterviewStatus[] = ['SCHEDULED'];

export interface ScheduleInterviewInput {
  readonly applicationId: string;
  readonly scheduledAt: Date;
  readonly durationMinutes?: number;
  readonly location?: string | null;
  readonly interviewerId?: string | null;
  readonly notes?: string | null;
}

export interface InterviewSummary {
  readonly id: string;
  readonly applicationId: string;
  readonly scheduledAt: Date;
  readonly durationMinutes: number;
  readonly status: InterviewStatus;
  readonly interviewerId: string | null;
  readonly applicationStatus: string;
}

function assertDuration(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_DURATION_MINUTES) {
    throw new BusinessRuleError(
      'interview.invalid_duration',
      `An interview must be between 5 and ${MAX_DURATION_MINUTES} minutes long.`,
    );
  }
}

/** Resolve an interviewer inside the caller's organisation, or refuse. */
async function resolveInterviewer(
  ctx: AccessContext,
  tx: Tx,
  interviewerId: string | null | undefined,
): Promise<string | null> {
  if (!interviewerId) return null;
  const user = await tx.user.findFirst({
    where: { id: interviewerId, organizationId: ctx.organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!user) throw new NotFoundError('Interviewer', interviewerId);
  return user.id;
}

/**
 * Refuse a slot the interviewer is already committed to.
 *
 * The candidate set is bounded by the longest interview we allow, then narrowed
 * with `intervalsOverlap` so back-to-back bookings (10:00-10:30 and 10:30-11:00)
 * are permitted — the comparison is strict at the boundary for exactly that reason.
 */
async function assertInterviewerFree(
  ctx: AccessContext,
  tx: Tx,
  input: {
    readonly interviewerId: string;
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly excludeInterviewId?: string;
  },
): Promise<void> {
  const candidates = await tx.interview.findMany({
    where: {
      interviewerId: input.interviewerId,
      status: { in: [...SLOT_HOLDING_STATUSES] },
      scheduledAt: {
        gte: plusMinutes(input.startsAt, -MAX_DURATION_MINUTES),
        lt: input.endsAt,
      },
      // Interviews carry no organizationId of their own; they are reached through
      // the application, which is where tenancy lives.
      application: { organizationId: ctx.organizationId },
      ...(input.excludeInterviewId ? { id: { not: input.excludeInterviewId } } : {}),
    },
    select: {
      id: true,
      scheduledAt: true,
      durationMinutes: true,
      application: { select: { applicationNumber: true } },
    },
  });

  const conflicts = candidates
    .filter((candidate) =>
      intervalsOverlap(
        input.startsAt,
        input.endsAt,
        candidate.scheduledAt,
        plusMinutes(candidate.scheduledAt, candidate.durationMinutes),
      ),
    )
    .map((candidate) => ({
      // The taxonomy's ScheduleConflict has no INTERVIEWER kind; TEACHER is the
      // person-shaped one and renders as "this person is busy".
      kind: 'TEACHER' as const,
      conflictingId: candidate.id,
      label: `Interview for application ${candidate.application.applicationNumber}`,
      startsAt: candidate.scheduledAt.toISOString(),
      endsAt: plusMinutes(candidate.scheduledAt, candidate.durationMinutes).toISOString(),
    }));

  if (conflicts.length > 0) throw new ScheduleConflictError(conflicts);
}

export async function scheduleInterview(
  ctx: AccessContext,
  input: ScheduleInterviewInput,
  db?: Db,
): Promise<InterviewSummary> {
  requirePermission(ctx, 'applications.scheduleInterview');

  const durationMinutes = input.durationMinutes ?? 30;
  assertDuration(durationMinutes);

  return withTransaction(
    async (tx) => {
      const application = await loadApplicationForWrite(ctx, tx, input.applicationId);
      if (!SCHEDULABLE_STATUSES.has(application.status)) {
        throw new StateInvalidError(
          'application',
          application.status.toLowerCase(),
          'given an interview',
        );
      }

      const interviewerId = await resolveInterviewer(ctx, tx, input.interviewerId);
      const endsAt = plusMinutes(input.scheduledAt, durationMinutes);

      if (interviewerId) {
        await assertInterviewerFree(ctx, tx, {
          interviewerId,
          startsAt: input.scheduledAt,
          endsAt,
        });
      }

      const interview = await tx.interview.create({
        data: {
          applicationId: application.id,
          scheduledAt: input.scheduledAt,
          durationMinutes,
          location: input.location ?? null,
          interviewerId,
          notes: input.notes ?? null,
          status: 'SCHEDULED',
        },
        select: { id: true, scheduledAt: true, durationMinutes: true, status: true },
      });

      await tx.application.update({
        where: { id: application.id },
        data: { status: 'INTERVIEW_SCHEDULED' },
      });

      await recordAudit(
        ctx,
        {
          action: 'application.interview.scheduled',
          entityType: 'Interview',
          entityId: interview.id,
          branchId: application.branchId,
          summary: `Interview scheduled for application ${application.applicationNumber}`,
          metadata: {
            applicationId: application.id,
            scheduledAt: interview.scheduledAt,
            durationMinutes,
            interviewerId,
          },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: application.id,
            type: 'application.interview.scheduled',
            title: 'Interview scheduled',
            description: input.location ?? null,
            occurredAt: new Date(),
          },
        },
        tx,
      );

      return {
        id: interview.id,
        applicationId: application.id,
        scheduledAt: interview.scheduledAt,
        durationMinutes: interview.durationMinutes,
        status: interview.status,
        interviewerId,
        applicationStatus: 'INTERVIEW_SCHEDULED',
      };
    },
    { existing: db },
  );
}

/** Load an interview with the caller's scope applied through its application. */
async function loadInterview(
  ctx: AccessContext,
  tx: Tx,
  interviewId: string,
): Promise<{
  id: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: InterviewStatus;
  location: string | null;
  notes: string | null;
  interviewerId: string | null;
  application: { id: string; applicationNumber: string; status: string; branchId: string };
}> {
  const interview = await tx.interview.findFirst({
    where: { id: interviewId, application: { ...scopeFilter(ctx), deletedAt: null } },
    select: {
      id: true,
      scheduledAt: true,
      durationMinutes: true,
      status: true,
      location: true,
      notes: true,
      interviewerId: true,
      application: {
        select: { id: true, applicationNumber: true, status: true, branchId: true },
      },
    },
  });
  if (!interview) throw new NotFoundError('Interview', interviewId);
  return interview;
}

export interface RescheduleInterviewInput {
  readonly interviewId: string;
  readonly scheduledAt: Date;
  readonly durationMinutes?: number;
  readonly location?: string | null;
  readonly interviewerId?: string | null;
  readonly reason: string;
}

/**
 * Close the old booking and open a new one.
 *
 * `interviewerId` and `location` default to the previous booking's, so a
 * reschedule that only moves the time does not silently drop the interviewer.
 */
export async function rescheduleInterview(
  ctx: AccessContext,
  input: RescheduleInterviewInput,
  db?: Db,
): Promise<InterviewSummary> {
  requirePermission(ctx, 'applications.scheduleInterview');

  return withTransaction(
    async (tx) => {
      const current = await loadInterview(ctx, tx, input.interviewId);
      if (current.status !== 'SCHEDULED') {
        throw new StateInvalidError(
          'interview',
          current.status.toLowerCase(),
          'rescheduled',
        );
      }

      const durationMinutes = input.durationMinutes ?? current.durationMinutes;
      assertDuration(durationMinutes);

      const interviewerId =
        input.interviewerId === undefined
          ? current.interviewerId
          : await resolveInterviewer(ctx, tx, input.interviewerId);
      const endsAt = plusMinutes(input.scheduledAt, durationMinutes);

      if (interviewerId) {
        await assertInterviewerFree(ctx, tx, {
          interviewerId,
          startsAt: input.scheduledAt,
          endsAt,
          // The row being replaced must not conflict with its own replacement.
          excludeInterviewId: current.id,
        });
      }

      await tx.interview.update({
        where: { id: current.id },
        data: {
          status: 'RESCHEDULED',
          // Kept on the closed row so the reason is visible where the move shows,
          // not only in the audit log.
          notes: [current.notes, `Rescheduled: ${input.reason}`]
            .filter((part): part is string => Boolean(part))
            .join('\n'),
        },
      });

      const replacement = await tx.interview.create({
        data: {
          applicationId: current.application.id,
          scheduledAt: input.scheduledAt,
          durationMinutes,
          location: input.location === undefined ? current.location : input.location,
          interviewerId,
          status: 'SCHEDULED',
        },
        select: { id: true, scheduledAt: true, durationMinutes: true, status: true },
      });

      // A reschedule out of INTERVIEW_COMPLETED (a second round, or a no-show being
      // given another chance) puts the application back into the scheduled state.
      if (current.application.status !== 'INTERVIEW_SCHEDULED') {
        await tx.application.update({
          where: { id: current.application.id },
          data: { status: 'INTERVIEW_SCHEDULED' },
        });
      }

      await recordAudit(
        ctx,
        {
          action: 'application.interview.rescheduled',
          entityType: 'Interview',
          entityId: replacement.id,
          branchId: current.application.branchId,
          summary: `Interview for application ${current.application.applicationNumber} moved`,
          reason: input.reason,
          metadata: {
            applicationId: current.application.id,
            previousInterviewId: current.id,
            previousScheduledAt: current.scheduledAt,
            scheduledAt: replacement.scheduledAt,
            interviewerId,
          },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: current.application.id,
            type: 'application.interview.rescheduled',
            title: 'Interview rescheduled',
            description: input.reason,
          },
        },
        tx,
      );

      return {
        id: replacement.id,
        applicationId: current.application.id,
        scheduledAt: replacement.scheduledAt,
        durationMinutes: replacement.durationMinutes,
        status: replacement.status,
        interviewerId,
        applicationStatus: 'INTERVIEW_SCHEDULED',
      };
    },
    { existing: db },
  );
}

export interface RecordInterviewOutcomeInput {
  readonly interviewId: string;
  /** What actually happened. A cancellation is `cancelInterview`, not an outcome. */
  readonly status: Extract<InterviewStatus, 'COMPLETED' | 'NO_SHOW'>;
  readonly score?: number | null;
  readonly notes?: string | null;
  readonly recommendation?: ApplicationDecision | null;
}

export async function recordInterviewOutcome(
  ctx: AccessContext,
  input: RecordInterviewOutcomeInput,
  db?: Db,
): Promise<InterviewSummary> {
  // Recording a score and a recommendation is a review act, not a diary act, so it
  // takes the review permission rather than `scheduleInterview`.
  requirePermission(ctx, 'applications.review');

  if (input.score != null && (!Number.isInteger(input.score) || input.score < 0)) {
    throw new BusinessRuleError(
      'interview.invalid_score',
      'An interview score must be a whole number of zero or more.',
    );
  }
  if (input.status === 'NO_SHOW' && input.score != null) {
    throw new BusinessRuleError(
      'interview.score_without_interview',
      'An interview nobody attended cannot carry a score.',
    );
  }

  return withTransaction(
    async (tx) => {
      const current = await loadInterview(ctx, tx, input.interviewId);
      if (current.status !== 'SCHEDULED') {
        throw new StateInvalidError('interview', current.status.toLowerCase(), 'completed');
      }

      const completedAt = new Date();
      const interview = await tx.interview.update({
        where: { id: current.id },
        data: {
          status: input.status,
          score: input.score ?? null,
          notes: input.notes ?? current.notes,
          recommendation: input.recommendation ?? null,
          completedAt,
        },
        select: { id: true, scheduledAt: true, durationMinutes: true, status: true },
      });

      const applicationStatus = await settleApplicationAfterInterview(tx, {
        applicationId: current.application.id,
        applicationStatus: current.application.status,
        interviewHappened: input.status === 'COMPLETED',
      });

      await recordAudit(
        ctx,
        {
          action: 'application.interview.completed',
          entityType: 'Interview',
          entityId: interview.id,
          branchId: current.application.branchId,
          summary: `Interview for application ${current.application.applicationNumber}: ${input.status.toLowerCase()}`,
          reason: input.notes ?? null,
          metadata: {
            applicationId: current.application.id,
            outcome: input.status,
            score: input.score ?? null,
            recommendation: input.recommendation ?? null,
          },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: current.application.id,
            type: 'application.interview.completed',
            title:
              input.status === 'COMPLETED'
                ? 'Interview completed'
                : 'Interview missed (no show)',
            description: input.notes ?? null,
            occurredAt: completedAt,
          },
        },
        tx,
      );

      return {
        id: interview.id,
        applicationId: current.application.id,
        scheduledAt: interview.scheduledAt,
        durationMinutes: interview.durationMinutes,
        status: interview.status,
        interviewerId: current.interviewerId,
        applicationStatus,
      };
    },
    { existing: db },
  );
}

export async function cancelInterview(
  ctx: AccessContext,
  input: { readonly interviewId: string; readonly reason: string },
  db?: Db,
): Promise<{ id: string; status: InterviewStatus; applicationStatus: string }> {
  requirePermission(ctx, 'applications.scheduleInterview');

  return withTransaction(
    async (tx) => {
      const current = await loadInterview(ctx, tx, input.interviewId);
      if (current.status !== 'SCHEDULED') {
        throw new StateInvalidError('interview', current.status.toLowerCase(), 'cancelled');
      }

      await tx.interview.update({
        where: { id: current.id },
        data: {
          status: 'CANCELLED',
          notes: [current.notes, `Cancelled: ${input.reason}`]
            .filter((part): part is string => Boolean(part))
            .join('\n'),
        },
      });

      const applicationStatus = await settleApplicationAfterInterview(tx, {
        applicationId: current.application.id,
        applicationStatus: current.application.status,
        interviewHappened: false,
      });

      await recordAudit(
        ctx,
        {
          action: 'application.interview.cancelled',
          entityType: 'Interview',
          entityId: current.id,
          branchId: current.application.branchId,
          summary: `Interview for application ${current.application.applicationNumber} cancelled`,
          reason: input.reason,
          metadata: { applicationId: current.application.id },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: current.application.id,
            type: 'application.interview.cancelled',
            title: 'Interview cancelled',
            description: input.reason,
          },
        },
        tx,
      );

      return { id: current.id, status: 'CANCELLED', applicationStatus };
    },
    { existing: db },
  );
}

/**
 * Move the application out of INTERVIEW_SCHEDULED once no live booking remains.
 *
 * Without this an application whose only interview was cancelled or missed would
 * sit in INTERVIEW_SCHEDULED forever, invisible on the review worklist while
 * nothing is actually scheduled.
 */
async function settleApplicationAfterInterview(
  tx: Tx,
  input: {
    readonly applicationId: string;
    readonly applicationStatus: string;
    readonly interviewHappened: boolean;
  },
): Promise<string> {
  if (input.interviewHappened) {
    await tx.application.update({
      where: { id: input.applicationId },
      data: { status: 'INTERVIEW_COMPLETED' },
    });
    return 'INTERVIEW_COMPLETED';
  }

  if (input.applicationStatus !== 'INTERVIEW_SCHEDULED') return input.applicationStatus;

  const stillScheduled = await tx.interview.count({
    where: { applicationId: input.applicationId, status: 'SCHEDULED' },
  });
  if (stillScheduled > 0) return input.applicationStatus;

  await tx.application.update({
    where: { id: input.applicationId },
    data: { status: 'UNDER_REVIEW' },
  });
  return 'UNDER_REVIEW';
}
