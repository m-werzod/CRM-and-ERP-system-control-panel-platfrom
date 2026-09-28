/**
 * Follow-up tasks: the promises an institution makes to a person and has to keep.
 *
 * The same table serves sales (call this lead back on Thursday) and student services
 * (chase this debt, check on this absentee), which is why the subject links are two
 * nullable columns rather than one polymorphic pair. A task with no subject at all is
 * allowed — "ring the landlord" is a real task — but a task cannot be about a lead
 * AND a student at once, because then no profile page owns it.
 *
 * `Lead.nextFollowUpAt` is a derived cache of the earliest OPEN task and is
 * recomputed inside every transaction that changes one, never written by hand.
 */

import type { FollowUpStatus, LeadPriority, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import { BusinessRuleError, NotFoundError, StateInvalidError } from '@/server/errors';
import { record as recordAudit, type AuditInput } from '@/server/audit';
import {
  assertBranchAccess,
  requirePermission,
  restrictedToOwn,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { addDaysToDateOnly, todayIn, zonedWallClockToInstant } from '@/lib/dates';
import {
  assertAssignableUser,
  followUpReadFilter,
  leadDisplayName,
  loadLeadForWrite,
  recomputeLeadNextFollowUp,
  resolveLeadBranch,
} from '@/server/services/crm/shared';

/**
 * Local time a defaulted task falls due. Start of the working day rather than
 * "now + N × 24h", so a task created at 19:40 on Monday is due on Wednesday morning
 * and not on Wednesday evening after everyone has gone home.
 */
const DEFAULT_DUE_WALL_CLOCK_MINUTE = 9 * 60;

export interface CreateFollowUpInput {
  readonly leadId?: string | null;
  readonly studentId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  /** Defaults to `crm.defaultFollowUpDays` ahead, at 09:00 local. */
  readonly dueAt?: Date;
  readonly priority?: LeadPriority;
  /** Defaults to the caller. */
  readonly assignedToUserId?: string | null;
  readonly branchId?: string | null;
}

export interface FollowUpSummary {
  readonly id: string;
  readonly title: string;
  readonly dueAt: Date;
  readonly status: FollowUpStatus;
  readonly assignedToUserId: string;
  readonly leadId: string | null;
  readonly studentId: string | null;
}

export async function createFollowUp(
  ctx: AccessContext,
  input: CreateFollowUpInput,
  db?: Db,
): Promise<FollowUpSummary> {
  requirePermission(ctx, 'followUps.create');

  const title = input.title.trim();
  if (title === '') {
    throw new BusinessRuleError('followUp.no_title', 'A follow-up needs a title.');
  }
  if (input.leadId && input.studentId) {
    throw new BusinessRuleError(
      'followUp.two_subjects',
      'A follow-up is about a lead or a student, not both.',
    );
  }

  return withTransaction(
    async (tx) => {
      let leadId: string | null = null;
      let studentId: string | null = null;
      let subjectBranchId: string | null = null;
      let subjectLabel: string | null = null;

      if (input.leadId) {
        const lead = await loadLeadForWrite(ctx, tx, input.leadId);
        if (lead.convertedAt) {
          throw new BusinessRuleError(
            'followUp.lead_converted',
            'This lead is now a student. Attach the task to the student instead.',
          );
        }
        leadId = lead.id;
        subjectBranchId = lead.branchId;
        subjectLabel = leadDisplayName(lead);
      } else if (input.studentId) {
        const student = await tx.student.findFirst({
          where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
          select: { id: true, branchId: true, firstName: true, lastName: true },
        });
        if (!student) throw new NotFoundError('Student', input.studentId);
        studentId = student.id;
        subjectBranchId = student.branchId;
        subjectLabel = `${student.firstName} ${student.lastName}`;
      }

      let branchId: string | null;
      if (input.branchId) {
        assertBranchAccess(ctx, input.branchId, 'follow-up');
        branchId = input.branchId;
      } else {
        branchId = subjectBranchId ?? resolveLeadBranch(ctx, null);
      }

      const assignee = await assertAssignableUser(
        ctx,
        tx,
        input.assignedToUserId ?? ctx.userId,
      );

      const { timezone, defaultFollowUpDays } = await getSettings(
        ['timezone', 'defaultFollowUpDays'],
        { organizationId: ctx.organizationId, branchId },
        tx,
      );

      const dueAt =
        input.dueAt ??
        zonedWallClockToInstant(
          addDaysToDateOnly(todayIn(timezone), defaultFollowUpDays),
          DEFAULT_DUE_WALL_CLOCK_MINUTE,
          timezone,
        );

      const task = await tx.followUpTask.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          leadId,
          studentId,
          title,
          description: input.description?.trim() || null,
          dueAt,
          priority: input.priority ?? 'MEDIUM',
          status: 'OPEN',
          assignedToUserId: assignee.id,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          assignedToUserId: true,
          leadId: true,
          studentId: true,
        },
      });

      if (leadId) {
        await tx.leadActivity.create({
          data: {
            leadId,
            type: 'FOLLOW_UP_CREATED',
            subject: title,
            body: input.description?.trim() || null,
            occurredAt: new Date(),
            createdById: ctx.isSystem ? null : ctx.userId,
            metadata: { followUpTaskId: task.id },
          },
        });
        await recomputeLeadNextFollowUp(tx, leadId);
      }

      await recordAudit(
        ctx,
        {
          action: 'follow_up.created',
          entityType: 'FollowUpTask',
          entityId: task.id,
          branchId,
          summary: `Follow-up "${title}" assigned to ${assignee.firstName} ${assignee.lastName}${subjectLabel ? ` for ${subjectLabel}` : ''}`,
          metadata: { dueAt, leadId, studentId },
          timeline: leadId
            ? {
                subjectType: 'LEAD',
                subjectId: leadId,
                type: 'lead.follow_up.created',
                title: `Follow-up scheduled: ${title}`,
                description: input.description?.trim() || null,
              }
            : studentId
              ? {
                  subjectType: 'STUDENT',
                  subjectId: studentId,
                  type: 'student.follow_up.created',
                  title: `Follow-up scheduled: ${title}`,
                  description: input.description?.trim() || null,
                }
              : null,
        },
        tx,
      );

      return task;
    },
    { existing: db },
  );
}

/**
 * Load a task the caller may act on, with the scope in the same query.
 *
 * A SELF-scoped agent may only touch their own tasks; anyone with
 * `followUps.viewAll` may act on the team's. Reassigning someone else's task is
 * gated separately by `followUps.reassign`.
 */
async function loadTaskForWrite(
  ctx: AccessContext,
  tx: Tx,
  taskId: string,
): Promise<{
  id: string;
  branchId: string | null;
  title: string;
  status: FollowUpStatus;
  dueAt: Date;
  assignedToUserId: string;
  leadId: string | null;
  studentId: string | null;
}> {
  const task = await tx.followUpTask.findFirst({
    where: { ...followUpReadFilter(ctx), id: taskId },
    select: {
      id: true,
      branchId: true,
      title: true,
      status: true,
      dueAt: true,
      assignedToUserId: true,
      leadId: true,
      studentId: true,
    },
  });
  if (!task) throw new NotFoundError('Follow-up task', taskId);
  return task;
}

function subjectTimeline(
  task: { leadId: string | null; studentId: string | null },
  type: string,
  title: string,
  description: string | null,
): AuditInput['timeline'] {
  if (task.leadId) {
    return {
      subjectType: 'LEAD',
      subjectId: task.leadId,
      type: `lead.${type}`,
      title,
      description,
    };
  }
  if (task.studentId) {
    return {
      subjectType: 'STUDENT',
      subjectId: task.studentId,
      type: `student.${type}`,
      title,
      description,
    };
  }
  return null;
}

export async function completeFollowUp(
  ctx: AccessContext,
  input: { readonly taskId: string; readonly note?: string | null; readonly completedAt?: Date },
  db?: Db,
): Promise<FollowUpSummary> {
  requirePermission(ctx, 'followUps.complete');

  return withTransaction(
    async (tx) => {
      const task = await loadTaskForWrite(ctx, tx, input.taskId);
      if (task.status !== 'OPEN') {
        throw new StateInvalidError('follow-up', task.status.toLowerCase(), 'completed');
      }

      const completedAt = input.completedAt ?? new Date();
      const updated = await tx.followUpTask.update({
        where: { id: task.id },
        data: {
          status: 'COMPLETED',
          completedAt,
          completedById: ctx.isSystem ? null : ctx.userId,
          completionNote: input.note?.trim() || null,
        },
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          assignedToUserId: true,
          leadId: true,
          studentId: true,
        },
      });

      if (task.leadId) {
        await tx.leadActivity.create({
          data: {
            leadId: task.leadId,
            type: 'FOLLOW_UP_COMPLETED',
            subject: task.title,
            body: input.note?.trim() || null,
            occurredAt: completedAt,
            createdById: ctx.isSystem ? null : ctx.userId,
            metadata: { followUpTaskId: task.id },
          },
        });
        await recomputeLeadNextFollowUp(tx, task.leadId);
      }

      await recordAudit(
        ctx,
        {
          action: 'follow_up.completed',
          entityType: 'FollowUpTask',
          entityId: task.id,
          branchId: task.branchId,
          summary: `Follow-up "${task.title}" completed`,
          metadata: { completedAt, wasOverdue: completedAt > task.dueAt },
          timeline: subjectTimeline(
            task,
            'follow_up.completed',
            `Follow-up completed: ${task.title}`,
            input.note?.trim() || null,
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

export async function reassignFollowUp(
  ctx: AccessContext,
  input: {
    readonly taskId: string;
    readonly toUserId: string;
    readonly reason?: string | null;
  },
  db?: Db,
): Promise<FollowUpSummary> {
  requirePermission(ctx, 'followUps.reassign');

  return withTransaction(
    async (tx) => {
      const task = await loadTaskForWrite(ctx, tx, input.taskId);
      if (task.status !== 'OPEN') {
        throw new StateInvalidError('follow-up', task.status.toLowerCase(), 'reassigned');
      }
      if (task.assignedToUserId === input.toUserId) {
        throw new BusinessRuleError(
          'followUp.already_assigned',
          'This task is already assigned to that user.',
        );
      }

      const assignee = await assertAssignableUser(ctx, tx, input.toUserId);

      const updated = await tx.followUpTask.update({
        where: { id: task.id },
        data: { assignedToUserId: assignee.id },
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          assignedToUserId: true,
          leadId: true,
          studentId: true,
        },
      });

      await recordAudit(
        ctx,
        {
          action: 'follow_up.reassigned',
          entityType: 'FollowUpTask',
          entityId: task.id,
          branchId: task.branchId,
          summary: `Follow-up "${task.title}" reassigned to ${assignee.firstName} ${assignee.lastName}`,
          reason: input.reason ?? null,
          changes: {
            assignedToUserId: { from: task.assignedToUserId, to: assignee.id },
          },
          timeline: subjectTimeline(
            task,
            'follow_up.reassigned',
            `Follow-up reassigned to ${assignee.firstName} ${assignee.lastName}`,
            input.reason ?? null,
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

export async function cancelFollowUp(
  ctx: AccessContext,
  input: { readonly taskId: string; readonly reason: string },
  db?: Db,
): Promise<FollowUpSummary> {
  requirePermission(ctx, 'followUps.edit');

  const reason = input.reason.trim();
  if (reason === '') {
    throw new BusinessRuleError(
      'followUp.cancel_reason_required',
      'Say why the follow-up is being cancelled, so the next person knows it was not forgotten.',
    );
  }

  return withTransaction(
    async (tx) => {
      const task = await loadTaskForWrite(ctx, tx, input.taskId);
      if (task.status !== 'OPEN') {
        throw new StateInvalidError('follow-up', task.status.toLowerCase(), 'cancelled');
      }

      const updated = await tx.followUpTask.update({
        where: { id: task.id },
        data: { status: 'CANCELLED', completionNote: reason },
        select: {
          id: true,
          title: true,
          dueAt: true,
          status: true,
          assignedToUserId: true,
          leadId: true,
          studentId: true,
        },
      });

      if (task.leadId) await recomputeLeadNextFollowUp(tx, task.leadId);

      await recordAudit(
        ctx,
        {
          action: 'follow_up.cancelled',
          entityType: 'FollowUpTask',
          entityId: task.id,
          branchId: task.branchId,
          summary: `Follow-up "${task.title}" cancelled`,
          reason,
          timeline: subjectTimeline(
            task,
            'follow_up.cancelled',
            `Follow-up cancelled: ${task.title}`,
            reason,
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListFollowUpsInput {
  /** `mine` is forced for a caller without `followUps.viewAll`. */
  readonly scope?: 'mine' | 'all';
  readonly status?: readonly FollowUpStatus[];
  readonly assignedToUserId?: string | null;
  readonly leadId?: string | null;
  readonly studentId?: string | null;
  readonly overdueOnly?: boolean;
  readonly dueBefore?: Date;
  readonly dueAfter?: Date;
  readonly branchId?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface FollowUpRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueAt: Date;
  readonly priority: LeadPriority;
  readonly status: FollowUpStatus;
  readonly isOverdue: boolean;
  readonly assignedToUserId: string;
  readonly assignedToName: string;
  readonly leadId: string | null;
  readonly leadName: string | null;
  readonly leadStatus: string | null;
  readonly studentId: string | null;
  readonly studentName: string | null;
  readonly branchId: string | null;
  readonly completedAt: Date | null;
  readonly completionNote: string | null;
  readonly createdAt: Date;
}

export interface ListFollowUpsResult {
  readonly rows: readonly FollowUpRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export async function listFollowUps(
  ctx: AccessContext,
  input: ListFollowUpsInput = {},
  db?: Db,
): Promise<ListFollowUpsResult> {
  requirePermission(ctx, 'followUps.view');

  const client = db ?? prisma;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const now = new Date();

  const mustBeMine = restrictedToOwn(ctx, 'followUps.viewAll');
  if (input.scope === 'all' && mustBeMine) {
    requirePermission(ctx, 'followUps.viewAll');
  }
  const onlyMine = mustBeMine || input.scope === 'mine';

  const filters: Prisma.FollowUpTaskWhereInput[] = [followUpReadFilter(ctx, { onlyMine })];

  if (input.status && input.status.length > 0) {
    filters.push({ status: { in: [...input.status] } });
  }
  if (input.assignedToUserId && !onlyMine) {
    filters.push({ assignedToUserId: input.assignedToUserId });
  }
  if (input.leadId) filters.push({ leadId: input.leadId });
  if (input.studentId) filters.push({ studentId: input.studentId });
  if (input.branchId) {
    assertBranchAccess(ctx, input.branchId, 'follow-up');
    filters.push({ branchId: input.branchId });
  }
  if (input.overdueOnly) filters.push({ status: 'OPEN', dueAt: { lt: now } });
  if (input.dueBefore) filters.push({ dueAt: { lt: input.dueBefore } });
  if (input.dueAfter) filters.push({ dueAt: { gte: input.dueAfter } });

  const where: Prisma.FollowUpTaskWhereInput = { AND: filters };

  const [total, rows] = await Promise.all([
    client.followUpTask.count({ where }),
    client.followUpTask.findMany({
      where,
      // FollowUpStatus is declared OPEN, COMPLETED, CANCELLED, so ascending puts
      // the live work first; ascending dueAt then puts the most overdue at the top,
      // which is the whole point of the screen.
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        description: true,
        dueAt: true,
        priority: true,
        status: true,
        assignedToUserId: true,
        branchId: true,
        completedAt: true,
        completionNote: true,
        createdAt: true,
        assignedToUser: { select: { firstName: true, lastName: true } },
        lead: { select: { id: true, firstName: true, lastName: true, status: true } },
        student: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      dueAt: row.dueAt,
      priority: row.priority,
      status: row.status,
      isOverdue: row.status === 'OPEN' && row.dueAt < now,
      assignedToUserId: row.assignedToUserId,
      assignedToName: `${row.assignedToUser.firstName} ${row.assignedToUser.lastName}`,
      leadId: row.lead?.id ?? null,
      leadName: row.lead ? leadDisplayName(row.lead) : null,
      leadStatus: row.lead?.status ?? null,
      studentId: row.student?.id ?? null,
      studentName: row.student ? `${row.student.firstName} ${row.student.lastName}` : null,
      branchId: row.branchId,
      completedAt: row.completedAt,
      completionNote: row.completionNote,
      createdAt: row.createdAt,
    })),
  };
}

/**
 * How many open tasks are past their due date for one user. Drives the badge in the
 * navigation, so it is a COUNT and never loads the rows.
 */
export async function countOverdueForUser(
  ctx: AccessContext,
  input: { readonly userId?: string | null; readonly asOf?: Date } = {},
  db?: Db,
): Promise<number> {
  const userId = input.userId ?? ctx.userId;
  if (userId === ctx.userId) {
    requirePermission(ctx, 'followUps.view');
  } else {
    // Counting someone else's workload is a management view.
    requirePermission(ctx, 'followUps.viewAll');
  }

  const client = db ?? prisma;
  return client.followUpTask.count({
    where: {
      AND: [
        followUpReadFilter(ctx, { onlyMine: userId === ctx.userId }),
        { assignedToUserId: userId, status: 'OPEN', dueAt: { lt: input.asOf ?? new Date() } },
      ],
    },
  });
}
