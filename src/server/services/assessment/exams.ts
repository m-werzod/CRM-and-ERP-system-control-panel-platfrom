/**
 * Exam lifecycle: scheduling, editing, cancelling and reading one back.
 *
 * DRAFT -> SCHEDULED -> IN_PROGRESS -> COMPLETED -> GRADED -> PUBLISHED, with
 * CANCELLED reachable only from the first three. The edit window closes at
 * SCHEDULED for a reason: once a single result has been entered, `maxScore` and
 * `passingScore` are the terms a student was marked against, and moving them would
 * re-scale a grade that has already been communicated. Corrections after that go
 * through `grading.ts`, which snapshots the maximum onto every result row.
 */

import type { ExamStatus, ExamType, Prisma } from '@/generated/prisma/client';
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
  assertBranchAccess,
  can,
  isSelfScoped,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dayRangeToInstants, type DateOnly } from '@/lib/dates';
import { examStatistics, type ExamStatistics } from '@/server/services/assessment/statistics';
import {
  groupScopeFilter,
  toPage,
  type PageInput,
  type PagedResult,
} from '@/server/services/assessment/shared';

/** States in which an exam may still be edited or cancelled. */
const EDITABLE_STATUSES: readonly ExamStatus[] = ['DRAFT', 'SCHEDULED'];
const CANCELLABLE_STATUSES: readonly ExamStatus[] = ['DRAFT', 'SCHEDULED', 'IN_PROGRESS'];

/** Statuses a student or parent may see. A DRAFT is a teacher's working copy. */
const VISIBLE_STATUSES: readonly ExamStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'GRADED',
  'PUBLISHED',
  'CANCELLED',
];

export interface CreateExamInput {
  readonly title: string;
  readonly description?: string | null;
  readonly type?: ExamType;
  readonly scheduledAt: Date;
  readonly durationMinutes?: number;
  readonly maxScore: number;
  readonly passingScore: number;
  /** Weight inside the term grade, parts-per-million. */
  readonly weightPpm?: number;
  readonly branchId?: string | null;
  readonly groupId?: string | null;
  readonly subjectId?: string | null;
  readonly programId?: string | null;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly termId?: string | null;
  readonly gradingScaleId?: string | null;
  /** Publish the date straight away instead of leaving a draft. */
  readonly schedule?: boolean;
}

export interface ExamSummary {
  readonly id: string;
  readonly title: string;
  readonly type: ExamType;
  readonly status: ExamStatus;
  readonly scheduledAt: Date;
  readonly durationMinutes: number;
  readonly maxScore: number;
  readonly passingScore: number;
  readonly weightPpm: number;
  readonly branchId: string;
  readonly groupId: string | null;
  readonly groupName: string | null;
  readonly subjectId: string | null;
  readonly subjectName: string | null;
  readonly teacherId: string | null;
  readonly teacherName: string | null;
  readonly roomName: string | null;
  readonly termId: string | null;
  readonly resultCount: number;
  readonly resultsPublishedAt: Date | null;
}

/**
 * Validate the mark scheme.
 *
 * Pure and exported so the form can check it before submitting and get the same
 * answer the server will give. A zero maximum makes every percentage a division by
 * zero; a pass mark above the maximum makes the exam unpassable, which is never
 * what the operator meant.
 */
export function assertScoreScheme(maxScore: number, passingScore: number): void {
  if (!Number.isInteger(maxScore) || maxScore <= 0) {
    throw new BusinessRuleError(
      'exam.invalid_max_score',
      'The maximum score must be a whole number greater than zero.',
    );
  }
  if (!Number.isInteger(passingScore) || passingScore <= 0) {
    throw new BusinessRuleError(
      'exam.invalid_passing_score',
      'The passing score must be a whole number greater than zero.',
    );
  }
  if (passingScore > maxScore) {
    throw new BusinessRuleError(
      'exam.passing_above_max',
      'The passing score cannot be higher than the maximum score.',
      { details: { maxScore, passingScore } },
    );
  }
}

function assertWeight(weightPpm: number | undefined): void {
  if (weightPpm === undefined) return;
  if (!Number.isInteger(weightPpm) || weightPpm < 0 || weightPpm > 1_000_000) {
    throw new BusinessRuleError(
      'exam.invalid_weight',
      'The exam weight must be between 0 and 1 000 000 parts-per-million.',
    );
  }
}

/**
 * Resolve and verify every id the exam points at, inside the caller's scope.
 *
 * Each lookup carries the scope predicate in its own `where`, so a caller cannot
 * attach an exam to a group, room or term in a branch they cannot see -- and a miss
 * is a 404 rather than a message that confirms the row exists elsewhere.
 */
async function resolveReferences(
  ctx: AccessContext,
  tx: Tx,
  branchId: string,
  input: {
    readonly groupId?: string | null;
    readonly subjectId?: string | null;
    readonly programId?: string | null;
    readonly teacherId?: string | null;
    readonly roomId?: string | null;
    readonly termId?: string | null;
    readonly gradingScaleId?: string | null;
  },
): Promise<void> {
  if (input.subjectId) {
    const subject = await tx.subject.findFirst({
      where: { id: input.subjectId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!subject) throw new NotFoundError('Subject', input.subjectId);
  }

  if (input.programId) {
    const program = await tx.program.findFirst({
      where: { id: input.programId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!program) throw new NotFoundError('Program', input.programId);
  }

  if (input.teacherId) {
    // Teacher carries no organizationId of its own; it is reached through Employee.
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

  if (input.roomId) {
    const room = await tx.room.findFirst({
      where: { id: input.roomId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!room) throw new NotFoundError('Room', input.roomId);
    if (room.branchId !== branchId) {
      throw new BusinessRuleError(
        'exam.room_other_branch',
        'That room belongs to a different branch from the exam.',
        { details: { roomBranchId: room.branchId, examBranchId: branchId } },
      );
    }
  }

  if (input.termId) {
    // Term hangs off AcademicYear, which is where the organisation predicate lives.
    const term = await tx.term.findFirst({
      where: { id: input.termId, academicYear: { organizationId: ctx.organizationId } },
      select: { id: true },
    });
    if (!term) throw new NotFoundError('Term', input.termId);
  }

  if (input.gradingScaleId) {
    const scale = await tx.gradingScale.findFirst({
      where: { id: input.gradingScaleId, organizationId: ctx.organizationId, isActive: true },
      select: { id: true },
    });
    if (!scale) throw new NotFoundError('Grading scale', input.gradingScaleId);
  }
}

/**
 * A teacher may only schedule exams for classes they actually teach. Checked on the
 * write path rather than left to the list filter, because scheduling an exam for
 * someone else's group is a 403, not an invisible row.
 */
async function assertMayActOnGroup(
  ctx: AccessContext,
  tx: Tx,
  groupId: string,
): Promise<void> {
  if (ctx.isSystem || !isSelfScoped(ctx) || can(ctx, 'grades.viewAll')) return;

  const teacherId = ctx.self.teacherId;
  const assigned =
    teacherId !== null &&
    (await tx.groupTeacher.count({ where: { groupId, teacherId, endDate: null } })) > 0;
  if (!assigned) {
    throw new ForbiddenError('You are not assigned to that class.', { details: { groupId } });
  }
}

export async function createExam(
  ctx: AccessContext,
  input: CreateExamInput,
  db?: Db,
): Promise<ExamSummary> {
  requirePermission(ctx, 'exams.create');

  assertScoreScheme(input.maxScore, input.passingScore);
  assertWeight(input.weightPpm);

  const durationMinutes = input.durationMinutes ?? 60;
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new BusinessRuleError(
      'exam.invalid_duration',
      'The exam duration must be a whole number of minutes greater than zero.',
    );
  }

  return withTransaction(
    async (tx) => {
      let groupBranchId: string | null = null;
      if (input.groupId) {
        const group = await tx.group.findFirst({
          where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
          select: { id: true, branchId: true, status: true },
        });
        if (!group) throw new NotFoundError('Group', input.groupId);
        if (group.status === 'CANCELLED') {
          throw new StateInvalidError('group', 'cancelled', 'given an exam');
        }
        await assertMayActOnGroup(ctx, tx, group.id);
        groupBranchId = group.branchId;
      }

      const branchId = resolveWriteBranch(ctx, input.branchId ?? groupBranchId, 'exam');
      assertBranchAccess(ctx, branchId, 'exam');

      if (groupBranchId !== null && groupBranchId !== branchId) {
        throw new BusinessRuleError(
          'exam.group_other_branch',
          'The group belongs to a different branch from the exam.',
          { details: { groupBranchId, examBranchId: branchId } },
        );
      }

      await resolveReferences(ctx, tx, branchId, input);

      const exam = await tx.exam.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          groupId: input.groupId ?? null,
          subjectId: input.subjectId ?? null,
          programId: input.programId ?? null,
          teacherId: input.teacherId ?? null,
          roomId: input.roomId ?? null,
          termId: input.termId ?? null,
          gradingScaleId: input.gradingScaleId ?? null,
          title: input.title,
          description: input.description ?? null,
          type: input.type ?? 'QUIZ',
          scheduledAt: input.scheduledAt,
          durationMinutes,
          maxScore: input.maxScore,
          passingScore: input.passingScore,
          weightPpm: input.weightPpm ?? 0,
          status: input.schedule ? 'SCHEDULED' : 'DRAFT',
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: examSummarySelect,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EXAM_CREATED,
          entityType: 'Exam',
          entityId: exam.id,
          branchId,
          summary: `Exam "${exam.title}" ${input.schedule ? 'scheduled' : 'drafted'}${
            exam.group ? ` for ${exam.group.name}` : ''
          }`,
          metadata: {
            maxScore: exam.maxScore,
            passingScore: exam.passingScore,
            scheduledAt: exam.scheduledAt,
            type: exam.type,
          },
          // The group is where a human looks for "what is coming up for this class".
          timeline: exam.group
            ? {
                subjectType: 'GROUP',
                subjectId: exam.group.id,
                type: 'exam.created',
                title: `Exam scheduled: ${exam.title}`,
                occurredAt: exam.scheduledAt,
              }
            : null,
        },
        tx,
      );

      return toSummary(exam);
    },
    { existing: db },
  );
}

export interface UpdateExamInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly type?: ExamType;
  readonly scheduledAt?: Date;
  readonly durationMinutes?: number;
  readonly maxScore?: number;
  readonly passingScore?: number;
  readonly weightPpm?: number;
  readonly subjectId?: string | null;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly termId?: string | null;
  readonly gradingScaleId?: string | null;
  /** DRAFT -> SCHEDULED. Any other transition belongs to grading or cancellation. */
  readonly schedule?: boolean;
}

/**
 * Edit an exam that has not been sat.
 *
 * DRAFT and SCHEDULED only. An IN_PROGRESS or graded exam is a thing that has
 * happened; its mark scheme is part of the record, not a form field.
 */
export async function updateExam(
  ctx: AccessContext,
  examId: string,
  input: UpdateExamInput,
  db?: Db,
): Promise<ExamSummary> {
  requirePermission(ctx, 'exams.edit');

  return withTransaction(
    async (tx) => {
      const exam = await tx.exam.findFirst({
        where: { id: examId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          branchId: true,
          groupId: true,
          status: true,
          title: true,
          description: true,
          type: true,
          scheduledAt: true,
          durationMinutes: true,
          maxScore: true,
          passingScore: true,
          weightPpm: true,
          subjectId: true,
          teacherId: true,
          roomId: true,
          termId: true,
          gradingScaleId: true,
          _count: { select: { results: true } },
        },
      });
      if (!exam) throw new NotFoundError('Exam', examId);

      if (!EDITABLE_STATUSES.includes(exam.status)) {
        throw new StateInvalidError('exam', exam.status.toLowerCase(), 'edited');
      }
      if (exam.groupId) await assertMayActOnGroup(ctx, tx, exam.groupId);

      const maxScore = input.maxScore ?? exam.maxScore;
      const passingScore = input.passingScore ?? exam.passingScore;
      assertScoreScheme(maxScore, passingScore);
      assertWeight(input.weightPpm);

      if (input.durationMinutes !== undefined) {
        if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0) {
          throw new BusinessRuleError(
            'exam.invalid_duration',
            'The exam duration must be a whole number of minutes greater than zero.',
          );
        }
      }

      // Belt and braces alongside the status gate: a result row means somebody has
      // already been marked out of the old maximum, and re-scaling their score
      // silently is the exact failure the snapshot on ExamResult exists to prevent.
      if (exam._count.results > 0 && maxScore !== exam.maxScore) {
        throw new BusinessRuleError(
          'exam.max_score_locked',
          'Results have already been entered for this exam, so the maximum score can no longer change. Cancel it and create a new exam instead.',
          { details: { resultCount: exam._count.results } },
        );
      }

      await resolveReferences(ctx, tx, exam.branchId, input);

      const data: Prisma.ExamUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.type !== undefined) data.type = input.type;
      if (input.scheduledAt !== undefined) data.scheduledAt = input.scheduledAt;
      if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
      if (input.maxScore !== undefined) data.maxScore = input.maxScore;
      if (input.passingScore !== undefined) data.passingScore = input.passingScore;
      if (input.weightPpm !== undefined) data.weightPpm = input.weightPpm;
      if (input.subjectId !== undefined) {
        data.subject = input.subjectId ? { connect: { id: input.subjectId } } : { disconnect: true };
      }
      if (input.teacherId !== undefined) {
        data.teacher = input.teacherId ? { connect: { id: input.teacherId } } : { disconnect: true };
      }
      if (input.roomId !== undefined) {
        data.room = input.roomId ? { connect: { id: input.roomId } } : { disconnect: true };
      }
      if (input.termId !== undefined) {
        data.term = input.termId ? { connect: { id: input.termId } } : { disconnect: true };
      }
      if (input.gradingScaleId !== undefined) {
        data.gradingScale = input.gradingScaleId
          ? { connect: { id: input.gradingScaleId } }
          : { disconnect: true };
      }
      if (input.schedule && exam.status === 'DRAFT') data.status = 'SCHEDULED';

      const updated = await tx.exam.update({
        where: { id: exam.id },
        data,
        select: examSummarySelect,
      });

      await recordAudit(
        ctx,
        {
          action: 'exam.updated',
          entityType: 'Exam',
          entityId: exam.id,
          branchId: exam.branchId,
          summary: `Exam "${updated.title}" updated`,
          changes: diffFields(
            {
              title: exam.title,
              description: exam.description,
              type: exam.type,
              scheduledAt: exam.scheduledAt,
              durationMinutes: exam.durationMinutes,
              maxScore: exam.maxScore,
              passingScore: exam.passingScore,
              weightPpm: exam.weightPpm,
              subjectId: exam.subjectId,
              teacherId: exam.teacherId,
              roomId: exam.roomId,
              termId: exam.termId,
              gradingScaleId: exam.gradingScaleId,
              status: exam.status,
            },
            {
              title: input.title,
              description: input.description,
              type: input.type,
              scheduledAt: input.scheduledAt,
              durationMinutes: input.durationMinutes,
              maxScore: input.maxScore,
              passingScore: input.passingScore,
              weightPpm: input.weightPpm,
              subjectId: input.subjectId,
              teacherId: input.teacherId,
              roomId: input.roomId,
              termId: input.termId,
              gradingScaleId: input.gradingScaleId,
              status: updated.status,
            },
          ),
        },
        tx,
      );

      return toSummary(updated);
    },
    { existing: db },
  );
}

/**
 * Cancel an exam.
 *
 * Only before it has been graded. A GRADED or PUBLISHED exam has results attached
 * to students' records; cancelling it would leave those grades hanging off an event
 * the institution says never happened. Withdraw those through the gradebook.
 */
export async function cancelExam(
  ctx: AccessContext,
  examId: string,
  input: { readonly reason: string },
  db?: Db,
): Promise<{ id: string; status: ExamStatus }> {
  requirePermission(ctx, 'exams.delete');

  if (input.reason.trim().length < 3) {
    throw new BusinessRuleError(
      'exam.cancel_reason_required',
      'Cancelling an exam must record why.',
    );
  }

  return withTransaction(
    async (tx) => {
      const exam = await tx.exam.findFirst({
        where: { id: examId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          branchId: true,
          groupId: true,
          group: { select: { id: true, name: true } },
        },
      });
      if (!exam) throw new NotFoundError('Exam', examId);

      if (!CANCELLABLE_STATUSES.includes(exam.status)) {
        throw new StateInvalidError('exam', exam.status.toLowerCase(), 'cancelled');
      }

      await tx.exam.update({ where: { id: exam.id }, data: { status: 'CANCELLED' } });

      await recordAudit(
        ctx,
        {
          action: 'exam.cancelled',
          entityType: 'Exam',
          entityId: exam.id,
          branchId: exam.branchId,
          summary: `Exam "${exam.title}" cancelled`,
          reason: input.reason,
          severity: 'NOTICE',
          timeline: exam.group
            ? {
                subjectType: 'GROUP',
                subjectId: exam.group.id,
                type: 'exam.cancelled',
                title: `Exam cancelled: ${exam.title}`,
                description: input.reason,
              }
            : null,
        },
        tx,
      );

      return { id: exam.id, status: 'CANCELLED' };
    },
    { existing: db },
  );
}

export interface ListExamsInput extends PageInput {
  readonly groupId?: string;
  readonly subjectId?: string;
  readonly programId?: string;
  readonly teacherId?: string;
  readonly termId?: string;
  readonly status?: readonly ExamStatus[];
  readonly type?: readonly ExamType[];
  /** Calendar days in the organisation timezone, inclusive of both ends. */
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly sortDir?: 'asc' | 'desc';
}

/**
 * Exams matching the filters, newest first by default.
 *
 * Filtered, sorted and counted in SQL. The rows a caller may see come from
 * `groupScopeFilter`, so a teacher's list is narrowed by a WHERE fragment rather
 * than by hiding rows after they have been fetched.
 */
export async function listExams(
  ctx: AccessContext,
  input: ListExamsInput = {},
  db: Db = prisma,
): Promise<PagedResult<ExamSummary>> {
  requirePermission(ctx, 'exams.view');

  const { page, pageSize, skip, take } = toPage(input);

  let dateFilter: { gte?: Date; lt?: Date } | undefined;
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
      dateFilter = { gte: range.from, lt: range.toExclusive };
    }
  }

  // A student or parent must not see a teacher's unpublished draft. Folded into the
  // requested status filter rather than added beside it, so one predicate cannot
  // silently overwrite the other.
  const hideDrafts = isSelfScoped(ctx) && !can(ctx, 'exams.edit');
  const requested: ExamStatus[] | null =
    input.status && input.status.length > 0 ? [...input.status] : null;
  const statuses: ExamStatus[] | null = hideDrafts
    ? (requested ?? [...VISIBLE_STATUSES]).filter((status) => status !== 'DRAFT')
    : requested;

  const where: Prisma.ExamWhereInput = {
    ...(groupScopeFilter(ctx) as object),
    deletedAt: null,
    ...(input.groupId ? { groupId: input.groupId } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.programId ? { programId: input.programId } : {}),
    ...(input.teacherId ? { teacherId: input.teacherId } : {}),
    ...(input.termId ? { termId: input.termId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(input.type && input.type.length > 0 ? { type: { in: [...input.type] } } : {}),
    ...(dateFilter ? { scheduledAt: dateFilter } : {}),
  };

  const [rows, total] = await Promise.all([
    db.exam.findMany({
      where,
      orderBy: [{ scheduledAt: input.sortDir ?? 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: examSummarySelect,
    }),
    db.exam.count({ where }),
  ]);

  return { rows: rows.map(toSummary), total, page, pageSize };
}

export interface ExamResultRow {
  readonly studentId: string;
  readonly studentCode: string;
  readonly fullName: string;
  readonly score: number | null;
  readonly maxScore: number;
  readonly gradeLabel: string | null;
  readonly isPass: boolean | null;
  readonly isAbsent: boolean;
  readonly remarks: string | null;
  readonly gradedAt: Date | null;
}

export interface ExamDetail extends ExamSummary {
  readonly description: string | null;
  readonly gradingScaleId: string | null;
  readonly gradingScaleName: string | null;
  readonly results: readonly ExamResultRow[];
  readonly statistics: ExamStatistics;
}

/** One exam with its results and statistics: the exam page in a single call. */
export async function getExam(
  ctx: AccessContext,
  examId: string,
  db: Db = prisma,
): Promise<ExamDetail> {
  requirePermission(ctx, 'exams.view');

  const exam = await db.exam.findFirst({
    // The scope narrowing lives in the same `where` as the id: fetching first and
    // checking afterwards would confirm the exam exists in another branch.
    where: {
      id: examId,
      ...(groupScopeFilter(ctx) as object),
      deletedAt: null,
    },
    select: {
      ...examSummarySelect,
      description: true,
      gradingScaleId: true,
      gradingScale: { select: { name: true } },
      results: {
        orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
        select: {
          studentId: true,
          score: true,
          maxScore: true,
          gradeLabel: true,
          isPass: true,
          isAbsent: true,
          remarks: true,
          gradedAt: true,
          student: { select: { studentCode: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!exam) throw new NotFoundError('Exam', examId);

  // A SELF-scoped student or parent sees only their own line on the sheet; the rest
  // of the cohort's marks are not theirs to read.
  const ownStudentIds = await visibleStudentIds(ctx, db);
  const visibleResults =
    ownStudentIds === null
      ? exam.results
      : exam.results.filter((result) => ownStudentIds.has(result.studentId));

  return {
    ...toSummary(exam),
    description: exam.description,
    gradingScaleId: exam.gradingScaleId,
    gradingScaleName: exam.gradingScale?.name ?? null,
    results: visibleResults.map((result) => ({
      studentId: result.studentId,
      studentCode: result.student.studentCode,
      fullName: `${result.student.firstName} ${result.student.lastName}`,
      score: result.score,
      maxScore: result.maxScore,
      gradeLabel: result.gradeLabel,
      isPass: result.isPass,
      isAbsent: result.isAbsent,
      remarks: result.remarks,
      gradedAt: result.gradedAt,
    })),
    // Statistics stay computed over the WHOLE cohort even when the caller may only
    // see their own row: "you scored 72, the class averaged 61" is the comparison a
    // parent is entitled to, and it names nobody.
    statistics: examStatistics(
      exam.results.map((result) => ({ score: result.score, isAbsent: result.isAbsent })),
      { maxScore: exam.maxScore, passingScore: exam.passingScore },
    ),
  };
}

/**
 * The student ids a SELF-scoped caller may see results for, or `null` when the
 * caller may read the whole sheet.
 *
 * A teacher gets `null` because the exam itself is already narrowed to classes they
 * teach; a student and a parent get an explicit set, because the exam being visible
 * to them says nothing about whose marks are.
 */
async function visibleStudentIds(
  ctx: AccessContext,
  db: Db,
): Promise<ReadonlySet<string> | null> {
  if (ctx.isSystem || !isSelfScoped(ctx) || can(ctx, 'grades.viewAll')) return null;

  const { studentId, guardianId, teacherId } = ctx.self;
  if (studentId) return new Set([studentId]);
  if (guardianId) {
    const children = await db.student.findMany({
      where: { organizationId: ctx.organizationId, guardians: { some: { guardianId } } },
      select: { id: true },
    });
    return new Set(children.map((child) => child.id));
  }
  if (teacherId) return null;
  // A SELF-scoped caller with no identity link sees nobody's marks: fail closed.
  return new Set<string>();
}

const examSummarySelect = {
  id: true,
  title: true,
  type: true,
  status: true,
  scheduledAt: true,
  durationMinutes: true,
  maxScore: true,
  passingScore: true,
  weightPpm: true,
  branchId: true,
  groupId: true,
  subjectId: true,
  teacherId: true,
  termId: true,
  resultsPublishedAt: true,
  group: { select: { id: true, name: true } },
  subject: { select: { name: true } },
  room: { select: { name: true } },
  teacher: {
    select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
  },
  _count: { select: { results: true } },
} satisfies Prisma.ExamSelect;

type ExamSummaryRow = Prisma.ExamGetPayload<{ select: typeof examSummarySelect }>;

function toSummary(exam: ExamSummaryRow): ExamSummary {
  const teacherUser = exam.teacher?.employee.user;
  return {
    id: exam.id,
    title: exam.title,
    type: exam.type,
    status: exam.status,
    scheduledAt: exam.scheduledAt,
    durationMinutes: exam.durationMinutes,
    maxScore: exam.maxScore,
    passingScore: exam.passingScore,
    weightPpm: exam.weightPpm,
    branchId: exam.branchId,
    groupId: exam.groupId,
    groupName: exam.group?.name ?? null,
    subjectId: exam.subjectId,
    subjectName: exam.subject?.name ?? null,
    teacherId: exam.teacherId,
    teacherName: teacherUser ? `${teacherUser.firstName} ${teacherUser.lastName}` : null,
    roomName: exam.room?.name ?? null,
    termId: exam.termId,
    resultCount: exam._count.results,
    resultsPublishedAt: exam.resultsPublishedAt,
  };
}
