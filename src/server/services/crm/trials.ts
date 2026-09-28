/**
 * Trial lessons: the step where a lead sits in a real class before committing.
 *
 * A trial may be attached to a concrete `Lesson` (sit in on Tuesday's 18:00 class) or
 * to a `Group` and a time (the teacher will fit them in). Both shapes exist in the
 * schema and both are booked through here, so the lead's status and its activity
 * trail move the same way whichever the front desk chooses.
 */

import type { ProgramLevel, TrialLessonStatus } from '@/generated/prisma/client';
import { withTransaction, type Db } from '@/server/db/client';
import { BusinessRuleError, NotFoundError, StateInvalidError } from '@/server/errors';
import { record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  organizationFilter,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { isLeadTransitionAllowed } from '@/server/services/crm/scoring';
import {
  applyLeadStatusChange,
  leadDisplayName,
  leadReadFilter,
  loadLeadForWrite,
} from '@/server/services/crm/shared';

export interface BookTrialLessonInput {
  readonly leadId: string;
  /** A specific lesson to sit in on. Supplies the group, teacher and time. */
  readonly lessonId?: string | null;
  readonly groupId?: string | null;
  readonly teacherId?: string | null;
  /** Required unless `lessonId` is given, in which case the lesson's start wins. */
  readonly scheduledAt?: Date;
  readonly note?: string | null;
}

export interface TrialLessonSummary {
  readonly id: string;
  readonly leadId: string;
  readonly groupId: string | null;
  readonly lessonId: string | null;
  readonly teacherId: string | null;
  readonly scheduledAt: Date;
  readonly status: TrialLessonStatus;
  readonly leadStatus: string;
}

export async function bookTrialLesson(
  ctx: AccessContext,
  input: BookTrialLessonInput,
  db?: Db,
): Promise<TrialLessonSummary> {
  requirePermission(ctx, 'leads.edit');

  if (!input.lessonId && !input.scheduledAt) {
    throw new BusinessRuleError(
      'trial.no_time',
      'A trial needs either a lesson to join or a date and time.',
    );
  }

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);
      if (lead.convertedAt) {
        throw new BusinessRuleError(
          'trial.lead_converted',
          'This lead is already a student. Book them into a class through enrolment instead.',
        );
      }
      if (lead.status === 'LOST' || lead.status === 'CLOSED') {
        throw new StateInvalidError('lead', lead.status.toLowerCase(), 'booked onto a trial');
      }

      let groupId = input.groupId ?? null;
      let lessonId: string | null = null;
      let teacherId = input.teacherId ?? null;
      let scheduledAt = input.scheduledAt;
      let branchId = lead.branchId;
      let groupName: string | null = null;

      if (input.lessonId) {
        const lesson = await tx.lesson.findFirst({
          where: { id: input.lessonId, ...scopeFilter(ctx) },
          select: {
            id: true,
            groupId: true,
            teacherId: true,
            branchId: true,
            startsAt: true,
            status: true,
            group: { select: { name: true } },
          },
        });
        if (!lesson) throw new NotFoundError('Lesson', input.lessonId);
        if (lesson.status === 'CANCELLED') {
          throw new StateInvalidError('lesson', 'cancelled', 'used for a trial');
        }
        lessonId = lesson.id;
        groupId = lesson.groupId;
        teacherId = teacherId ?? lesson.teacherId;
        // The lesson's own start time wins over a caller-supplied one: a trial that
        // says 18:00 while the class starts at 18:30 sends the family at the wrong
        // time, and the lesson is the authority.
        scheduledAt = lesson.startsAt;
        branchId = lesson.branchId;
        groupName = lesson.group.name;
      } else if (groupId) {
        const group = await tx.group.findFirst({
          where: { id: groupId, ...scopeFilter(ctx), deletedAt: null },
          select: { id: true, name: true, branchId: true, status: true, primaryTeacherId: true },
        });
        if (!group) throw new NotFoundError('Group', groupId);
        if (group.status === 'CANCELLED' || group.status === 'COMPLETED') {
          throw new StateInvalidError('group', group.status.toLowerCase(), 'used for a trial');
        }
        assertBranchAccess(ctx, group.branchId, 'group');
        teacherId = teacherId ?? group.primaryTeacherId;
        branchId = group.branchId;
        groupName = group.name;
      }

      if (!scheduledAt) {
        throw new BusinessRuleError(
          'trial.no_time',
          'A trial needs either a lesson to join or a date and time.',
        );
      }

      if (teacherId) {
        // Teacher carries no organizationId of its own; it is reached through the
        // employee, which is where tenancy lives.
        const teacher = await tx.teacher.findFirst({
          where: {
            id: teacherId,
            deletedAt: null,
            employee: { organizationId: ctx.organizationId, deletedAt: null },
          },
          select: { id: true },
        });
        if (!teacher) throw new NotFoundError('Teacher', teacherId);
      }

      const trial = await tx.trialLesson.create({
        data: {
          organizationId: ctx.organizationId,
          leadId: lead.id,
          groupId,
          lessonId,
          teacherId,
          scheduledAt,
          status: 'SCHEDULED',
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: {
          id: true,
          leadId: true,
          groupId: true,
          lessonId: true,
          teacherId: true,
          scheduledAt: true,
          status: true,
        },
      });

      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: 'TRIAL_BOOKED',
          subject: groupName ? `Trial booked in ${groupName}` : 'Trial booked',
          body: input.note?.trim() || null,
          occurredAt: new Date(),
          createdById: ctx.isSystem ? null : ctx.userId,
          metadata: { trialLessonId: trial.id, scheduledAt },
        },
      });

      // Booking a second trial for a lead that has already reached this stage or
      // beyond must not drag its status backwards, so the move is attempted only
      // when the pipeline actually permits it.
      let leadStatus: string = lead.status;
      if (isLeadTransitionAllowed(lead.status, 'TRIAL_BOOKED')) {
        await applyLeadStatusChange(ctx, tx, lead, {
          toStatus: 'TRIAL_BOOKED',
          reason: groupName ? `Trial booked in ${groupName}` : 'Trial booked',
        });
        leadStatus = 'TRIAL_BOOKED';
      }

      await recordAudit(
        ctx,
        {
          action: 'lead.trial.booked',
          entityType: 'TrialLesson',
          entityId: trial.id,
          branchId,
          summary: `Trial booked for ${leadDisplayName(lead)}${groupName ? ` in ${groupName}` : ''}`,
          metadata: { leadId: lead.id, groupId, lessonId, scheduledAt },
          timeline: {
            subjectType: 'LEAD',
            subjectId: lead.id,
            type: 'lead.trial.booked',
            title: groupName ? `Trial booked in ${groupName}` : 'Trial lesson booked',
            description: input.note?.trim() || null,
          },
        },
        tx,
      );

      return { ...trial, leadStatus };
    },
    { existing: db },
  );
}

export interface RecordTrialOutcomeInput {
  readonly trialId: string;
  /** Only an outcome: a trial that never happened is cancelled, not "recorded". */
  readonly status: 'ATTENDED' | 'NO_SHOW';
  readonly feedback?: string | null;
  readonly recommendedLevel?: ProgramLevel | null;
  readonly occurredAt?: Date;
}

/**
 * Record how the trial went.
 *
 * ATTENDED advances the lead to TRIAL_COMPLETED. A NO_SHOW deliberately leaves the
 * status at TRIAL_BOOKED: the family still owes the institution a visit, and marking
 * the stage complete would count a trial that nobody delivered in the conversion
 * funnel. Rebook, or mark the lead lost.
 */
export async function recordTrialOutcome(
  ctx: AccessContext,
  input: RecordTrialOutcomeInput,
  db?: Db,
): Promise<TrialLessonSummary & { feedback: string | null; recommendedLevel: ProgramLevel | null }> {
  requirePermission(ctx, 'leads.edit');

  return withTransaction(
    async (tx) => {
      const leadWhere = await leadReadFilter(ctx, tx);
      const trial = await tx.trialLesson.findFirst({
        where: { id: input.trialId, ...organizationFilter(ctx), lead: leadWhere },
        select: {
          id: true,
          status: true,
          scheduledAt: true,
          groupId: true,
          lessonId: true,
          teacherId: true,
          lead: {
            select: {
              id: true,
              branchId: true,
              firstName: true,
              lastName: true,
              status: true,
            },
          },
          group: { select: { name: true } },
        },
      });
      if (!trial) throw new NotFoundError('Trial lesson', input.trialId);
      if (trial.status !== 'SCHEDULED') {
        throw new StateInvalidError('trial lesson', trial.status.toLowerCase(), 'updated');
      }

      const occurredAt = input.occurredAt ?? new Date();

      await tx.trialLesson.update({
        where: { id: trial.id },
        data: {
          status: input.status,
          feedback: input.feedback?.trim() || null,
          recommendedLevel: input.recommendedLevel ?? null,
        },
      });

      await tx.leadActivity.create({
        data: {
          leadId: trial.lead.id,
          // The enum has no TRIAL_NO_SHOW member, so a missed trial is a NOTE whose
          // subject says so rather than a TRIAL_ATTENDED row that would be a lie.
          type: input.status === 'ATTENDED' ? 'TRIAL_ATTENDED' : 'NOTE',
          subject:
            input.status === 'ATTENDED'
              ? `Trial attended${trial.group ? ` in ${trial.group.name}` : ''}`
              : 'Trial no-show',
          body: input.feedback?.trim() || null,
          occurredAt,
          createdById: ctx.isSystem ? null : ctx.userId,
          metadata: {
            trialLessonId: trial.id,
            ...(input.recommendedLevel ? { recommendedLevel: input.recommendedLevel } : {}),
          },
        },
      });

      let leadStatus: string = trial.lead.status;
      if (
        input.status === 'ATTENDED' &&
        isLeadTransitionAllowed(trial.lead.status, 'TRIAL_COMPLETED')
      ) {
        await applyLeadStatusChange(ctx, tx, trial.lead, {
          toStatus: 'TRIAL_COMPLETED',
          reason: input.recommendedLevel
            ? `Trial attended, recommended level ${input.recommendedLevel}`
            : 'Trial attended',
          occurredAt,
        });
        leadStatus = 'TRIAL_COMPLETED';
      }

      await recordAudit(
        ctx,
        {
          action: 'lead.trial.outcome_recorded',
          entityType: 'TrialLesson',
          entityId: trial.id,
          branchId: trial.lead.branchId,
          summary: `Trial for ${leadDisplayName(trial.lead)}: ${input.status}`,
          metadata: {
            leadId: trial.lead.id,
            outcome: input.status,
            recommendedLevel: input.recommendedLevel ?? null,
          },
          timeline: {
            subjectType: 'LEAD',
            subjectId: trial.lead.id,
            type: input.status === 'ATTENDED' ? 'lead.trial.attended' : 'lead.trial.no_show',
            title: input.status === 'ATTENDED' ? 'Trial attended' : 'Trial no-show',
            description: input.feedback?.trim() || null,
            occurredAt,
          },
        },
        tx,
      );

      return {
        id: trial.id,
        leadId: trial.lead.id,
        groupId: trial.groupId,
        lessonId: trial.lessonId,
        teacherId: trial.teacherId,
        scheduledAt: trial.scheduledAt,
        status: input.status,
        leadStatus,
        feedback: input.feedback?.trim() || null,
        recommendedLevel: input.recommendedLevel ?? null,
      };
    },
    { existing: db },
  );
}
