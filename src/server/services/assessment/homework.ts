/**
 * Homework: setting it, publishing it, collecting it and marking it.
 *
 * `HomeworkSubmission` rows are NOT pre-created when homework is published. A row
 * means something happened -- a student handed something in, or a teacher excused
 * them -- so the absence of a row is itself the signal the "who hasn't submitted"
 * screen is built on. Pre-seeding thirty NOT_SUBMITTED rows would turn that question
 * into a status scan and would create rows for students who later transfer out.
 *
 * LATE is derived, never asked for. It is computed from `submittedAt` against
 * `dueAt`, because a client that reports its own lateness reports none.
 */

import type { HomeworkStatus, Prisma, SubmissionStatus } from '@/generated/prisma/client';
import type { NotifyInput } from '@/server/notifications';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  diffFields,
  record as recordAudit,
} from '@/server/audit';
import {
  can,
  isSelfScoped,
  organizationFilter,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dayRangeToInstants, formatDate, type DateOnly } from '@/lib/dates';
import { scoreToPpm } from '@/server/services/academics/grading-scales';
import { loadGradeResolver } from '@/server/services/assessment/grade-resolution';
import {
  groupScopeFilter,
  toPage,
  type PageInput,
  type PagedResult,
} from '@/server/services/assessment/shared';

/** Statuses a student or parent may see. A DRAFT is not yet homework. */
const VISIBLE_STATUSES: readonly HomeworkStatus[] = ['PUBLISHED', 'CLOSED'];

export interface CreateHomeworkInput {
  readonly groupId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly dueAt: Date;
  readonly maxScore?: number | null;
  readonly lessonId?: string | null;
  readonly teacherId?: string | null;
  /** Publish immediately instead of leaving a draft. */
  readonly publish?: boolean;
}

export interface HomeworkSummary {
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly branchId: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueAt: Date;
  readonly maxScore: number | null;
  readonly status: HomeworkStatus;
  readonly publishedAt: Date | null;
  readonly lessonId: string | null;
  readonly teacherId: string | null;
  readonly submissionCount: number;
}

/** A teacher may only set homework for the classes they teach. */
async function assertMayManageGroup(
  ctx: AccessContext,
  tx: Tx,
  groupId: string,
): Promise<void> {
  if (ctx.isSystem || !isSelfScoped(ctx) || can(ctx, 'grades.viewAll')) return;

  const teacherId = ctx.self.teacherId;
  const assigned =
    teacherId !== null &&
    (await tx.groupTeacher.count({ where: { groupId, teacherId, endDate: null } })) > 0;
  if (!assigned) throw new ForbiddenError('You are not assigned to that class.');
}

function assertMaxScore(maxScore: number | null | undefined): void {
  if (maxScore === null || maxScore === undefined) return;
  if (!Number.isInteger(maxScore) || maxScore <= 0) {
    throw new BusinessRuleError(
      'homework.invalid_max_score',
      'The maximum score must be a whole number greater than zero, or left empty for homework that is not marked.',
    );
  }
}

export async function createHomework(
  ctx: AccessContext,
  input: CreateHomeworkInput,
  db?: Db,
): Promise<HomeworkSummary> {
  requirePermission(ctx, 'homework.manage');
  assertMaxScore(input.maxScore);

  return withTransaction(
    async (tx) => {
      const group = await tx.group.findFirst({
        where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, name: true, branchId: true, status: true },
      });
      if (!group) throw new NotFoundError('Group', input.groupId);
      if (group.status === 'CANCELLED') {
        throw new StateInvalidError('group', 'cancelled', 'set homework for');
      }
      await assertMayManageGroup(ctx, tx, group.id);

      if (input.lessonId) {
        // A lesson from another group would put the homework on the wrong timetable.
        const lesson = await tx.lesson.findFirst({
          where: { id: input.lessonId, groupId: group.id, ...scopeFilter(ctx) },
          select: { id: true },
        });
        if (!lesson) throw new NotFoundError('Lesson', input.lessonId);
      }

      if (input.teacherId) {
        const teacher = await tx.teacher.findFirst({
          where: {
            id: input.teacherId,
            deletedAt: null,
            employee: { organizationId: ctx.organizationId },
          },
          select: { id: true },
        });
        if (!teacher) throw new NotFoundError('Teacher', input.teacherId);
      }

      const now = new Date();
      const homework = await tx.homework.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: group.branchId,
          groupId: group.id,
          lessonId: input.lessonId ?? null,
          // Defaults to the caller when they are a teacher: the person setting the
          // work is almost always the person who will mark it.
          teacherId: input.teacherId ?? ctx.self.teacherId,
          title: input.title,
          description: input.description ?? null,
          dueAt: input.dueAt,
          maxScore: input.maxScore ?? null,
          status: input.publish ? 'PUBLISHED' : 'DRAFT',
          publishedAt: input.publish ? now : null,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: homeworkSelect,
      });

      await recordAudit(
        ctx,
        {
          action: 'homework.created',
          entityType: 'Homework',
          entityId: homework.id,
          branchId: group.branchId,
          summary: `Homework "${homework.title}" ${input.publish ? 'published' : 'drafted'} for ${group.name}`,
          metadata: { dueAt: input.dueAt, maxScore: input.maxScore ?? null },
          timeline: {
            subjectType: 'GROUP',
            subjectId: group.id,
            type: 'homework.created',
            title: `Homework set: ${homework.title}`,
          },
        },
        tx,
      );

      return toHomeworkSummary(homework);
    },
    { existing: db },
  );
}

export interface PublishHomeworkResult {
  readonly id: string;
  readonly status: HomeworkStatus;
  readonly publishedAt: Date;
  /**
   * Payloads for `notify()`, one per student on the roster. Not sent here: queuing a
   * message inside this transaction would send twice on a retry, or send at all for a
   * publish that rolled back. The caller sends them after the commit.
   */
  readonly notifications: readonly NotifyInput<'HOMEWORK_ASSIGNED'>[];
}

export async function publishHomework(
  ctx: AccessContext,
  homeworkId: string,
  db?: Db,
): Promise<PublishHomeworkResult> {
  requirePermission(ctx, 'homework.manage');

  return withTransaction(
    async (tx) => {
      const homework = await tx.homework.findFirst({
        where: { id: homeworkId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          dueAt: true,
          branchId: true,
          groupId: true,
          group: { select: { id: true, name: true, subject: { select: { name: true } } } },
        },
      });
      if (!homework) throw new NotFoundError('Homework', homeworkId);
      if (homework.status !== 'DRAFT') {
        throw new StateInvalidError('homework', homework.status.toLowerCase(), 'published');
      }
      await assertMayManageGroup(ctx, tx, homework.groupId);

      const now = new Date();
      await tx.homework.update({
        where: { id: homework.id },
        data: { status: 'PUBLISHED', publishedAt: now },
      });

      const settings = await getSettings(
        ['timezone', 'defaultLocale'],
        { organizationId: ctx.organizationId, branchId: homework.branchId },
        tx,
      );

      // Students enrolled when the work is due, not when it was drafted.
      const roster = await tx.enrollment.findMany({
        where: {
          groupId: homework.groupId,
          startDate: { lte: homework.dueAt },
          OR: [{ endDate: null }, { endDate: { gte: homework.dueAt } }],
          student: { deletedAt: null },
        },
        select: { studentId: true },
      });

      const notifications = roster.map((row) => ({
        event: 'HOMEWORK_ASSIGNED' as const,
        subjectId: row.studentId,
        branchId: homework.branchId,
        dedupeKey: `homework_assigned:${homework.id}:${row.studentId}`,
        variables: {
          // Already formatted, in the organisation's zone and locale: the renderer
          // deliberately cannot format a date itself.
          subjectName: homework.group.subject?.name ?? homework.group.name,
          title: homework.title,
          dueDate: formatDate(homework.dueAt, settings.timezone, settings.defaultLocale),
          groupName: homework.group.name,
        },
      }));

      await recordAudit(
        ctx,
        {
          action: 'homework.published',
          entityType: 'Homework',
          entityId: homework.id,
          branchId: homework.branchId,
          summary: `Homework "${homework.title}" published to ${roster.length} students`,
          metadata: { studentCount: roster.length },
          timeline: {
            subjectType: 'GROUP',
            subjectId: homework.group.id,
            type: 'homework.published',
            title: `Homework published: ${homework.title}`,
            occurredAt: now,
          },
        },
        tx,
      );

      return { id: homework.id, status: 'PUBLISHED', publishedAt: now, notifications };
    },
    { existing: db },
  );
}

/**
 * Close homework to further submission.
 *
 * Marking is still possible afterwards: closing stops students handing work in, it
 * does not stop a teacher finishing the marking they already have.
 */
export async function closeHomework(
  ctx: AccessContext,
  homeworkId: string,
  db?: Db,
): Promise<{ id: string; status: HomeworkStatus; missingCount: number }> {
  requirePermission(ctx, 'homework.manage');

  return withTransaction(
    async (tx) => {
      const homework = await tx.homework.findFirst({
        where: { id: homeworkId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          dueAt: true,
          branchId: true,
          groupId: true,
          group: { select: { id: true, name: true } },
        },
      });
      if (!homework) throw new NotFoundError('Homework', homeworkId);
      if (homework.status !== 'PUBLISHED') {
        throw new StateInvalidError('homework', homework.status.toLowerCase(), 'closed');
      }
      await assertMayManageGroup(ctx, tx, homework.groupId);

      await tx.homework.update({ where: { id: homework.id }, data: { status: 'CLOSED' } });

      const [rosterCount, submittedCount] = await Promise.all([
        tx.enrollment.count({
          where: {
            groupId: homework.groupId,
            startDate: { lte: homework.dueAt },
            OR: [{ endDate: null }, { endDate: { gte: homework.dueAt } }],
            student: { deletedAt: null },
          },
        }),
        tx.homeworkSubmission.count({
          where: {
            homeworkId: homework.id,
            status: { in: ['SUBMITTED', 'LATE', 'GRADED', 'EXCUSED'] },
          },
        }),
      ]);
      const missingCount = Math.max(0, rosterCount - submittedCount);

      await recordAudit(
        ctx,
        {
          action: 'homework.closed',
          entityType: 'Homework',
          entityId: homework.id,
          branchId: homework.branchId,
          summary: `Homework "${homework.title}" closed with ${missingCount} not handed in`,
          metadata: { rosterCount, submittedCount, missingCount },
        },
        tx,
      );

      return { id: homework.id, status: 'CLOSED', missingCount };
    },
    { existing: db },
  );
}

export interface ListHomeworkInput extends PageInput {
  readonly groupId?: string;
  readonly teacherId?: string;
  readonly status?: readonly HomeworkStatus[];
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly sortDir?: 'asc' | 'desc';
}

export async function listHomework(
  ctx: AccessContext,
  input: ListHomeworkInput = {},
  db: Db = prisma,
): Promise<PagedResult<HomeworkSummary>> {
  requirePermission(ctx, 'homework.view');

  const { page, pageSize, skip, take } = toPage(input);

  let dueFilter: { gte?: Date; lt?: Date } | undefined;
  if (input.from || input.to) {
    const { timezone } = await getSettings(
      ['timezone'],
      { organizationId: ctx.organizationId },
      db,
    );
    const from = input.from ?? input.to;
    const to = input.to ?? input.from;
    if (from && to) {
      const range = dayRangeToInstants(from, to, timezone);
      dueFilter = { gte: range.from, lt: range.toExclusive };
    }
  }

  // A student never sees a draft: unpublished homework is a teacher's working copy.
  // Folded into the requested status filter rather than added beside it, so one
  // predicate cannot silently overwrite the other.
  const hideDrafts = isSelfScoped(ctx) && !can(ctx, 'homework.manage');
  const requestedStatuses: HomeworkStatus[] | null =
    input.status && input.status.length > 0 ? [...input.status] : null;
  const statuses: HomeworkStatus[] | null = hideDrafts
    ? (requestedStatuses ?? [...VISIBLE_STATUSES]).filter((status) => status !== 'DRAFT')
    : requestedStatuses;

  const where: Prisma.HomeworkWhereInput = {
    ...(groupScopeFilter(ctx, { escapeHatch: 'homework.grade' }) as object),
    deletedAt: null,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.teacherId ? { teacherId: input.teacherId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(dueFilter ? { dueAt: dueFilter } : {}),
  };

  const [rows, total] = await Promise.all([
    db.homework.findMany({
      where,
      orderBy: [{ dueAt: input.sortDir ?? 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: homeworkSelect,
    }),
    db.homework.count({ where }),
  ]);

  return { rows: rows.map(toHomeworkSummary), total, page, pageSize };
}

export interface SubmitHomeworkInput {
  readonly homeworkId: string;
  readonly studentId: string;
  readonly content?: string | null;
  /** Defaults to now. A teacher recording a paper handout may back-date it. */
  readonly submittedAt?: Date;
}

export interface SubmissionResult {
  readonly id: string;
  readonly homeworkId: string;
  readonly studentId: string;
  readonly status: SubmissionStatus;
  readonly submittedAt: Date;
  readonly isLate: boolean;
}

/**
 * Hand homework in.
 *
 * A student submits their own work; a teacher may submit on a student's behalf, which
 * is how paper handed in during a lesson gets recorded. Both go through this one
 * use-case so the lateness rule and the enrolment check cannot diverge.
 */
export async function submitHomework(
  ctx: AccessContext,
  input: SubmitHomeworkInput,
  db?: Db,
): Promise<SubmissionResult> {
  // `homework.view` is the only homework permission a student portal account holds;
  // acting for somebody else additionally requires the grading permission below.
  requirePermission(ctx, 'homework.view');

  const onBehalf = ctx.self.studentId !== input.studentId;
  if (onBehalf && !ctx.isSystem) {
    if (!can(ctx, 'homework.grade') && !can(ctx, 'homework.manage')) {
      throw new ForbiddenError('You can only submit your own homework.');
    }
  }

  return withTransaction(
    async (tx) => {
      const homework = await tx.homework.findFirst({
        where: { id: input.homeworkId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          dueAt: true,
          branchId: true,
          groupId: true,
          group: { select: { name: true } },
        },
      });
      if (!homework) throw new NotFoundError('Homework', input.homeworkId);

      if (homework.status === 'DRAFT') {
        throw new StateInvalidError('homework', 'not yet published', 'submitted to');
      }
      if (homework.status === 'CLOSED') {
        throw new StateInvalidError('homework', 'closed', 'submitted to');
      }

      // Enrolled when the work was due: a student who has since left the group keeps
      // what they handed in, and one who joined later cannot submit retrospectively.
      const enrolled = await tx.enrollment.count({
        where: {
          studentId: input.studentId,
          groupId: homework.groupId,
          startDate: { lte: homework.dueAt },
          OR: [{ endDate: null }, { endDate: { gte: homework.dueAt } }],
        },
      });
      if (enrolled === 0) {
        throw new BusinessRuleError(
          'homework.not_enrolled',
          'That student was not enrolled in this group when the homework was due.',
          { details: { studentId: input.studentId, groupId: homework.groupId } },
        );
      }

      const submittedAt = input.submittedAt ?? new Date();
      // Derived, never taken from the caller.
      const isLate = submittedAt > homework.dueAt;
      const status: SubmissionStatus = isLate ? 'LATE' : 'SUBMITTED';

      const existing = await tx.homeworkSubmission.findUnique({
        where: { homeworkId_studentId: { homeworkId: homework.id, studentId: input.studentId } },
        select: { id: true, status: true },
      });

      // Replacing marked work silently would erase a grade the student has seen. A
      // resubmission is only allowed once a teacher has asked for one.
      if (existing?.status === 'GRADED') {
        throw new StateInvalidError(
          'submission',
          'already marked',
          'replaced',
          'This homework has already been marked. Ask the teacher to request a resubmission.',
        );
      }

      const submission = existing
        ? await tx.homeworkSubmission.update({
            where: { id: existing.id },
            data: { status, submittedAt, content: input.content ?? null },
            select: { id: true },
          })
        : await tx.homeworkSubmission.create({
            data: {
              homeworkId: homework.id,
              studentId: input.studentId,
              status,
              submittedAt,
              content: input.content ?? null,
            },
            select: { id: true },
          });

      await recordAudit(
        ctx,
        {
          action: 'homework.submitted',
          entityType: 'HomeworkSubmission',
          entityId: submission.id,
          branchId: homework.branchId,
          summary: `Homework "${homework.title}" handed in${isLate ? ' late' : ''}${
            onBehalf ? ' (recorded on the student’s behalf)' : ''
          }`,
          metadata: { homeworkId: homework.id, studentId: input.studentId, isLate, onBehalf },
        },
        tx,
      );

      return {
        id: submission.id,
        homeworkId: homework.id,
        studentId: input.studentId,
        status,
        submittedAt,
        isLate,
      };
    },
    { existing: db },
  );
}

export interface GradeSubmissionInput {
  readonly submissionId: string;
  readonly score: number;
  readonly feedback?: string | null;
  readonly weightPpm?: number;
  /** Required when re-marking work that already carries a score. */
  readonly reason?: string | null;
}

export interface GradedSubmission {
  readonly id: string;
  readonly studentId: string;
  readonly score: number;
  readonly maxScore: number;
  readonly gradeLabel: string | null;
  readonly isPass: boolean;
  readonly gradeId: string;
  readonly status: SubmissionStatus;
}

/**
 * Mark a submission and write the matching gradebook row.
 *
 * The score is snapshotted onto the submission alongside the maximum in force, for the
 * same reason exam results are: a later change to the homework's maximum must not
 * re-scale a mark the student has already been given.
 */
export async function gradeSubmission(
  ctx: AccessContext,
  input: GradeSubmissionInput,
  db?: Db,
): Promise<GradedSubmission> {
  requirePermission(ctx, 'homework.grade');

  return withTransaction(
    async (tx) => {
      const submission = await tx.homeworkSubmission.findFirst({
        // HomeworkSubmission carries no organizationId; it is scoped through its
        // homework, which does.
        where: { id: input.submissionId, homework: { ...scopeFilter(ctx), deletedAt: null } },
        select: {
          id: true,
          studentId: true,
          status: true,
          score: true,
          maxScore: true,
          feedback: true,
          homework: {
            select: {
              id: true,
              title: true,
              maxScore: true,
              branchId: true,
              groupId: true,
              group: { select: { subjectId: true, termId: true } },
            },
          },
        },
      });
      if (!submission) throw new NotFoundError('Homework submission', input.submissionId);

      await assertMayManageGroup(ctx, tx, submission.homework.groupId);

      const maxScore = submission.homework.maxScore;
      if (maxScore === null) {
        throw new BusinessRuleError(
          'homework.not_markable',
          'This homework has no maximum score, so it cannot be given one. Set a maximum on the homework first.',
        );
      }
      if (!Number.isFinite(input.score) || input.score < 0 || input.score > maxScore) {
        throw new BusinessRuleError(
          'homework.score_out_of_range',
          `A score must be between 0 and the homework maximum of ${maxScore}.`,
          { details: { score: input.score, maxScore } },
        );
      }
      if (input.weightPpm !== undefined) {
        if (!Number.isInteger(input.weightPpm) || input.weightPpm < 0 || input.weightPpm > 1_000_000) {
          throw new BusinessRuleError(
            'homework.invalid_weight',
            'A grade weight must be between 0 and 1 000 000 parts-per-million.',
          );
        }
      }

      const scoreMoved = submission.score !== null && submission.score !== input.score;
      if (scoreMoved && (input.reason ?? '').trim().length < 3) {
        throw new BusinessRuleError(
          'homework.remark_reason_required',
          'Changing a mark that has already been given must record why.',
        );
      }

      const { passMarkPercentPpm } = await getSettings(
        ['passMarkPercentPpm'],
        { organizationId: ctx.organizationId, branchId: submission.homework.branchId },
        tx,
      );
      const resolver = await loadGradeResolver(ctx, {}, tx);
      const resolved = resolver.resolve(
        input.score,
        maxScore,
        Math.ceil((maxScore * passMarkPercentPpm) / 1_000_000),
      );

      const now = new Date();
      await tx.homeworkSubmission.update({
        where: { id: submission.id },
        data: {
          score: input.score,
          // Snapshot, for the same reason ExamResult keeps one.
          maxScore,
          feedback: input.feedback ?? null,
          status: 'GRADED',
          gradedById: ctx.isSystem ? null : ctx.userId,
          gradedAt: now,
        },
      });

      const existingGrade = await tx.grade.findFirst({
        where: {
          ...organizationFilter(ctx),
          homeworkSubmissionId: submission.id,
          sourceType: 'HOMEWORK',
        },
        select: { id: true, score: true },
      });

      const gradeData = {
        groupId: submission.homework.groupId,
        subjectId: submission.homework.group.subjectId,
        termId: submission.homework.group.termId,
        sourceType: 'HOMEWORK' as const,
        homeworkSubmissionId: submission.id,
        score: input.score,
        maxScore,
        weightPpm: input.weightPpm ?? 0,
        gradeLabel: resolved.gradeLabel,
        gpaPoints: resolved.gpaPoints,
        isPass: resolved.isPass,
        gradedById: ctx.isSystem ? null : ctx.userId,
        gradedAt: now,
      };

      const grade = existingGrade
        ? await tx.grade.update({
            where: { id: existingGrade.id },
            data: gradeData,
            select: { id: true },
          })
        : await tx.grade.create({
            data: { organizationId: ctx.organizationId, studentId: submission.studentId, ...gradeData },
            select: { id: true },
          });

      await recordAudit(
        ctx,
        {
          action: scoreMoved ? AUDIT_ACTIONS.GRADE_CHANGED : 'homework.graded',
          entityType: 'HomeworkSubmission',
          entityId: submission.id,
          branchId: submission.homework.branchId,
          summary: scoreMoved
            ? `Homework "${submission.homework.title}" re-marked from ${submission.score}/${submission.maxScore ?? maxScore} to ${input.score}/${maxScore}`
            : `Homework "${submission.homework.title}" marked ${input.score}/${maxScore}`,
          reason: input.reason ?? null,
          // A mark that moves after the student has seen it is the change worth
          // surfacing; a first mark is ordinary business.
          severity: scoreMoved ? 'NOTICE' : 'INFO',
          changes: scoreMoved
            ? diffFields(
                { score: submission.score, feedback: submission.feedback },
                { score: input.score, feedback: input.feedback },
              )
            : null,
          metadata: { gradeId: grade.id, percentPpm: scoreToPpm(input.score, maxScore) },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: submission.studentId,
            type: scoreMoved ? 'homework.remarked' : 'homework.graded',
            title: `${submission.homework.title}: ${resolved.gradeLabel ?? `${input.score}/${maxScore}`}`,
            description: input.feedback ?? null,
          },
        },
        tx,
      );

      return {
        id: submission.id,
        studentId: submission.studentId,
        score: input.score,
        maxScore,
        gradeLabel: resolved.gradeLabel,
        isPass: resolved.isPass,
        gradeId: grade.id,
        status: 'GRADED',
      };
    },
    { existing: db },
  );
}

/**
 * Ask a student to hand the work in again.
 *
 * The counterpart to `submitHomework` refusing to overwrite marked work: this is the
 * only way a graded submission reopens, so re-marking is always something a teacher
 * asked for rather than something a resubmission caused. The existing score and
 * feedback stay on the row until new work replaces them, so the student can still see
 * what they were told.
 */
export async function requestResubmission(
  ctx: AccessContext,
  input: { readonly submissionId: string; readonly reason: string },
  db?: Db,
): Promise<{ id: string; status: SubmissionStatus }> {
  requirePermission(ctx, 'homework.grade');

  if (input.reason.trim().length < 3) {
    throw new BusinessRuleError(
      'homework.resubmit_reason_required',
      'Asking for a resubmission must say what needs redoing.',
    );
  }

  return withTransaction(
    async (tx) => {
      const submission = await tx.homeworkSubmission.findFirst({
        where: { id: input.submissionId, homework: { ...scopeFilter(ctx), deletedAt: null } },
        select: {
          id: true,
          status: true,
          studentId: true,
          homework: { select: { id: true, title: true, status: true, branchId: true, groupId: true } },
        },
      });
      if (!submission) throw new NotFoundError('Homework submission', input.submissionId);

      await assertMayManageGroup(ctx, tx, submission.homework.groupId);

      if (submission.homework.status === 'CLOSED') {
        throw new StateInvalidError(
          'homework',
          'closed',
          'reopened for resubmission',
          'This homework is closed. Reopen it before asking for the work again.',
        );
      }
      if (submission.status === 'RESUBMIT_REQUESTED') {
        throw new StateInvalidError('submission', 'already awaiting a resubmission', 'requested again');
      }

      await tx.homeworkSubmission.update({
        where: { id: submission.id },
        data: { status: 'RESUBMIT_REQUESTED', feedback: input.reason },
      });

      await recordAudit(
        ctx,
        {
          action: 'homework.resubmission_requested',
          entityType: 'HomeworkSubmission',
          entityId: submission.id,
          branchId: submission.homework.branchId,
          summary: `Resubmission requested for "${submission.homework.title}"`,
          reason: input.reason,
          changes: { status: { from: submission.status, to: 'RESUBMIT_REQUESTED' } },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: submission.studentId,
            type: 'homework.resubmission_requested',
            title: `Resubmission requested: ${submission.homework.title}`,
            description: input.reason,
          },
        },
        tx,
      );

      return { id: submission.id, status: 'RESUBMIT_REQUESTED' };
    },
    { existing: db },
  );
}

export interface SubmissionRow {
  readonly studentId: string;
  readonly studentCode: string;
  readonly fullName: string;
  readonly submissionId: string | null;
  readonly status: SubmissionStatus;
  readonly submittedAt: Date | null;
  readonly isLate: boolean;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly feedback: string | null;
  readonly gradedAt: Date | null;
}

export interface HomeworkWithSubmissions extends HomeworkSummary {
  readonly rows: readonly SubmissionRow[];
  readonly submittedCount: number;
  readonly gradedCount: number;
  /** Students on the roster with nothing handed in. The point of the screen. */
  readonly missingCount: number;
}

/**
 * One homework with every student on the roster, submitted or not.
 *
 * Two queries and a Map: the roster, the submissions, joined in memory. The students
 * who have NOT handed anything in have no submission row to join to, which is why the
 * roster leads and the submissions are looked up against it rather than the reverse.
 */
export async function getHomeworkWithSubmissions(
  ctx: AccessContext,
  homeworkId: string,
  db: Db = prisma,
): Promise<HomeworkWithSubmissions> {
  requirePermission(ctx, 'homework.view');

  const homework = await db.homework.findFirst({
    where: {
      id: homeworkId,
      ...(groupScopeFilter(ctx, { escapeHatch: 'homework.grade' }) as object),
      deletedAt: null,
    },
    select: homeworkSelect,
  });
  if (!homework) throw new NotFoundError('Homework', homeworkId);

  const [enrollments, submissions] = await Promise.all([
    db.enrollment.findMany({
      where: {
        groupId: homework.groupId,
        startDate: { lte: homework.dueAt },
        OR: [{ endDate: null }, { endDate: { gte: homework.dueAt } }],
        student: { deletedAt: null },
      },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      select: {
        student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
      },
    }),
    db.homeworkSubmission.findMany({
      where: { homeworkId: homework.id },
      select: {
        id: true,
        studentId: true,
        status: true,
        submittedAt: true,
        score: true,
        maxScore: true,
        feedback: true,
        gradedAt: true,
      },
    }),
  ]);

  const byStudent = new Map(submissions.map((row) => [row.studentId, row]));

  const rows: SubmissionRow[] = enrollments.map(({ student }) => {
    const submission = byStudent.get(student.id);
    return {
      studentId: student.id,
      studentCode: student.studentCode,
      fullName: `${student.firstName} ${student.lastName}`,
      submissionId: submission?.id ?? null,
      // No row means nothing handed in. That is a state, not missing data.
      status: submission?.status ?? 'NOT_SUBMITTED',
      submittedAt: submission?.submittedAt ?? null,
      isLate: submission?.status === 'LATE',
      score: submission?.score ?? null,
      maxScore: submission?.maxScore ?? null,
      feedback: submission?.feedback ?? null,
      gradedAt: submission?.gradedAt ?? null,
    };
  });

  const submittedCount = rows.filter(
    (row) => row.status !== 'NOT_SUBMITTED' && row.status !== 'RESUBMIT_REQUESTED',
  ).length;

  return {
    ...toHomeworkSummary(homework),
    rows,
    submittedCount,
    gradedCount: rows.filter((row) => row.status === 'GRADED').length,
    missingCount: rows.length - submittedCount,
  };
}

const homeworkSelect = {
  id: true,
  groupId: true,
  branchId: true,
  title: true,
  description: true,
  dueAt: true,
  maxScore: true,
  status: true,
  publishedAt: true,
  lessonId: true,
  teacherId: true,
  group: { select: { name: true } },
  _count: { select: { submissions: true } },
} satisfies Prisma.HomeworkSelect;

type HomeworkRow = Prisma.HomeworkGetPayload<{ select: typeof homeworkSelect }>;

function toHomeworkSummary(homework: HomeworkRow): HomeworkSummary {
  return {
    id: homework.id,
    groupId: homework.groupId,
    groupName: homework.group.name,
    branchId: homework.branchId,
    title: homework.title,
    description: homework.description,
    dueAt: homework.dueAt,
    maxScore: homework.maxScore,
    status: homework.status,
    publishedAt: homework.publishedAt,
    lessonId: homework.lessonId,
    teacherId: homework.teacherId,
    submissionCount: homework._count.submissions,
  };
}
