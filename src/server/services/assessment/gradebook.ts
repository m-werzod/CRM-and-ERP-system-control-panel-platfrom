/**
 * The gradebook: the unified `Grade` row, and the two views built on it.
 *
 * Every grade, wherever it came from, is one row with a `sourceType` and a link back
 * to its evidence. That is what makes "this student's term average" answerable in one
 * query instead of a union of exams, homework and a teacher's notebook.
 *
 * WEIGHTS ARE PPM INTEGERS AN OPERATOR TYPES, so they do not reliably sum to
 * 1_000_000. Every average here normalises by the weights actually present -- see
 * `weightedAverage` in ./shared.ts. Assuming they sum to a million is how a term with
 * three exams weighted 300_000 each ends up reported as 90% of what the student
 * actually scored.
 *
 * Grades sourced from an exam or a homework submission are NOT editable here. Their
 * numbers belong to the result row they were derived from, and editing one side would
 * leave the gradebook and the exam sheet quietly disagreeing; correct those through
 * `recordExamResults` and `gradeSubmission`.
 */

import type { GradeSourceType, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
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
import { scoreToPpm } from '@/server/services/academics/grading-scales';
import { loadGradeResolver } from '@/server/services/assessment/grade-resolution';
import { studentScopeFilter, weightedAverage } from '@/server/services/assessment/shared';

/** Source types a human may enter by hand. The rest are derived from evidence. */
const MANUAL_SOURCE_TYPES: readonly GradeSourceType[] = [
  'MANUAL',
  'PARTICIPATION',
  'PROJECT',
  'TERM_AVERAGE',
];

export interface RecordManualGradeInput {
  readonly studentId: string;
  readonly score: number;
  readonly maxScore: number;
  readonly sourceType?: GradeSourceType;
  readonly groupId?: string | null;
  readonly subjectId?: string | null;
  readonly termId?: string | null;
  readonly weightPpm?: number;
  readonly comment?: string | null;
  readonly gradedAt?: Date;
}

export interface GradeRow {
  readonly id: string;
  readonly studentId: string;
  readonly sourceType: GradeSourceType;
  readonly score: number;
  readonly maxScore: number;
  readonly percentPpm: number;
  readonly weightPpm: number;
  readonly gradeLabel: string | null;
  readonly gpaPoints: number | null;
  readonly isPass: boolean | null;
  readonly comment: string | null;
  readonly groupId: string | null;
  readonly subjectId: string | null;
  readonly subjectName: string | null;
  readonly termId: string | null;
  readonly termName: string | null;
  readonly examId: string | null;
  readonly gradedAt: Date;
}

function assertScore(score: number, maxScore: number): void {
  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    throw new BusinessRuleError(
      'grade.invalid_max_score',
      'The maximum score must be greater than zero.',
    );
  }
  if (!Number.isFinite(score) || score < 0 || score > maxScore) {
    throw new BusinessRuleError(
      'grade.score_out_of_range',
      `A score must be between 0 and ${maxScore}.`,
      { details: { score, maxScore } },
    );
  }
}

function assertWeight(weightPpm: number | undefined): void {
  if (weightPpm === undefined) return;
  if (!Number.isInteger(weightPpm) || weightPpm < 0 || weightPpm > 1_000_000) {
    throw new BusinessRuleError(
      'grade.invalid_weight',
      'A grade weight must be between 0 and 1 000 000 parts-per-million.',
    );
  }
}

/**
 * Verify the student, and the group/subject/term the grade is filed under, all inside
 * the caller's scope. Each predicate travels with its own lookup, so a miss is a 404
 * rather than a confirmation that the row exists in another branch.
 */
async function resolveGradeContext(
  ctx: AccessContext,
  tx: Tx,
  input: {
    readonly studentId: string;
    readonly groupId?: string | null;
    readonly subjectId?: string | null;
    readonly termId?: string | null;
  },
): Promise<{ branchId: string; firstName: string; lastName: string }> {
  const student = await tx.student.findFirst({
    where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, branchId: true, firstName: true, lastName: true },
  });
  if (!student) throw new NotFoundError('Student', input.studentId);

  if (input.groupId) {
    const group = await tx.group.findFirst({
      where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
      select: { id: true },
    });
    if (!group) throw new NotFoundError('Group', input.groupId);
    await assertMayGradeGroup(ctx, tx, input.groupId);
  }
  if (input.subjectId) {
    const subject = await tx.subject.findFirst({
      where: { id: input.subjectId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!subject) throw new NotFoundError('Subject', input.subjectId);
  }
  if (input.termId) {
    const term = await tx.term.findFirst({
      where: { id: input.termId, academicYear: { organizationId: ctx.organizationId } },
      select: { id: true },
    });
    if (!term) throw new NotFoundError('Term', input.termId);
  }

  return { branchId: student.branchId, firstName: student.firstName, lastName: student.lastName };
}

/**
 * The pass mark for a grade that has no exam behind it, in marks.
 *
 * `academic.passMarkPercentPpm` exists precisely for this case. It matters only when
 * no grading scale is configured, because a scale's own bands say what a pass is; the
 * alternative -- treating the maximum as the pass mark -- would fail every student who
 * did not score full marks.
 */
async function defaultPassMark(
  ctx: AccessContext,
  maxScore: number,
  branchId: string,
  tx: Tx,
): Promise<number> {
  const { passMarkPercentPpm } = await getSettings(
    ['passMarkPercentPpm'],
    { organizationId: ctx.organizationId, branchId },
    tx,
  );
  return Math.ceil((maxScore * passMarkPercentPpm) / 1_000_000);
}

async function assertMayGradeGroup(
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

/** A grade a teacher enters directly: participation, a project, a one-off mark. */
export async function recordManualGrade(
  ctx: AccessContext,
  input: RecordManualGradeInput,
  db?: Db,
): Promise<GradeRow> {
  requirePermission(ctx, 'grades.edit');

  const sourceType = input.sourceType ?? 'MANUAL';
  if (!MANUAL_SOURCE_TYPES.includes(sourceType)) {
    throw new BusinessRuleError(
      'grade.source_not_manual',
      'A grade derived from an exam or a homework submission must be entered through that assessment, not by hand.',
      { details: { sourceType } },
    );
  }

  assertScore(input.score, input.maxScore);
  assertWeight(input.weightPpm);

  return withTransaction(
    async (tx) => {
      const student = await resolveGradeContext(ctx, tx, input);

      // No exam means no exam-specific scale, so the organisation's default decides
      // the label. When none is configured the label stays null rather than invented.
      const resolver = await loadGradeResolver(ctx, {}, tx);
      const resolved = resolver.resolve(
        input.score,
        input.maxScore,
        await defaultPassMark(ctx, input.maxScore, student.branchId, tx),
      );

      const grade = await tx.grade.create({
        data: {
          organizationId: ctx.organizationId,
          studentId: input.studentId,
          groupId: input.groupId ?? null,
          subjectId: input.subjectId ?? null,
          termId: input.termId ?? null,
          sourceType,
          score: input.score,
          maxScore: input.maxScore,
          weightPpm: input.weightPpm ?? 0,
          gradeLabel: resolved.gradeLabel,
          gpaPoints: resolved.gpaPoints,
          isPass: resolved.isPass,
          comment: input.comment ?? null,
          gradedById: ctx.isSystem ? null : ctx.userId,
          ...(input.gradedAt ? { gradedAt: input.gradedAt } : {}),
        },
        select: gradeSelect,
      });

      await recordAudit(
        ctx,
        {
          action: 'grade.recorded',
          entityType: 'Grade',
          entityId: grade.id,
          branchId: student.branchId,
          summary: `Grade ${input.score}/${input.maxScore} recorded for ${student.firstName} ${student.lastName}`,
          metadata: { sourceType, subjectId: input.subjectId ?? null, termId: input.termId ?? null },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: input.studentId,
            type: 'grade.recorded',
            title: `Grade recorded: ${resolved.gradeLabel ?? `${input.score}/${input.maxScore}`}`,
            description: input.comment ?? null,
          },
        },
        tx,
      );

      return toGradeRow(grade);
    },
    { existing: db },
  );
}

export interface UpdateGradeInput {
  readonly score?: number;
  readonly maxScore?: number;
  readonly weightPpm?: number;
  readonly comment?: string | null;
  /** Mandatory when the score moves: a changed grade always has a why. */
  readonly reason?: string | null;
}

/**
 * Amend a manually entered grade.
 *
 * Audited at NOTICE with the old and the new score. A grade quietly edited after a
 * student or a parent has seen it is exactly the change an audit trail exists to make
 * visible, so the old value is recorded even when nobody thinks to ask.
 */
export async function updateGrade(
  ctx: AccessContext,
  gradeId: string,
  input: UpdateGradeInput,
  db?: Db,
): Promise<GradeRow> {
  requirePermission(ctx, 'grades.edit');

  assertWeight(input.weightPpm);

  return withTransaction(
    async (tx) => {
      const grade = await tx.grade.findFirst({
        where: { id: gradeId, ...(studentScopeFilter(ctx) as object) },
        select: {
          id: true,
          studentId: true,
          sourceType: true,
          score: true,
          maxScore: true,
          weightPpm: true,
          comment: true,
          groupId: true,
          student: { select: { branchId: true, firstName: true, lastName: true } },
        },
      });
      if (!grade) throw new NotFoundError('Grade', gradeId);

      if (!MANUAL_SOURCE_TYPES.includes(grade.sourceType)) {
        throw new BusinessRuleError(
          'grade.derived_not_editable',
          grade.sourceType === 'EXAM'
            ? 'This grade comes from an exam result. Re-enter the result so the exam sheet and the gradebook stay in step.'
            : 'This grade comes from a homework submission. Re-grade the submission instead.',
          { details: { sourceType: grade.sourceType } },
        );
      }
      if (grade.groupId) await assertMayGradeGroup(ctx, tx, grade.groupId);

      const score = input.score ?? grade.score;
      const maxScore = input.maxScore ?? grade.maxScore;
      assertScore(score, maxScore);

      const scoreMoved = score !== grade.score || maxScore !== grade.maxScore;
      if (scoreMoved && (input.reason ?? '').trim().length < 3) {
        throw new BusinessRuleError(
          'grade.reason_required',
          'Changing a grade must record why.',
        );
      }

      const resolver = await loadGradeResolver(ctx, {}, tx);
      const resolved = resolver.resolve(
        score,
        maxScore,
        await defaultPassMark(ctx, maxScore, grade.student.branchId, tx),
      );

      const data: Prisma.GradeUpdateInput = {
        score,
        maxScore,
        gradeLabel: resolved.gradeLabel,
        gpaPoints: resolved.gpaPoints,
        isPass: resolved.isPass,
        // The person who last touched the number, not the person who first entered it.
        gradedBy: ctx.isSystem ? { disconnect: true } : { connect: { id: ctx.userId } },
      };
      if (input.weightPpm !== undefined) data.weightPpm = input.weightPpm;
      if (input.comment !== undefined) data.comment = input.comment;

      const updated = await tx.grade.update({
        where: { id: grade.id },
        data,
        select: gradeSelect,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GRADE_CHANGED,
          entityType: 'Grade',
          entityId: grade.id,
          branchId: grade.student.branchId,
          summary: `Grade for ${grade.student.firstName} ${grade.student.lastName} changed from ${grade.score}/${grade.maxScore} to ${score}/${maxScore}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          changes: diffFields(
            {
              score: grade.score,
              maxScore: grade.maxScore,
              weightPpm: grade.weightPpm,
              comment: grade.comment,
            },
            {
              score: input.score,
              maxScore: input.maxScore,
              weightPpm: input.weightPpm,
              comment: input.comment,
            },
          ),
          timeline: scoreMoved
            ? {
                subjectType: 'STUDENT',
                subjectId: grade.studentId,
                type: 'grade.changed',
                title: `Grade changed to ${score}/${maxScore}`,
                description: input.reason ?? null,
              }
            : null,
        },
        tx,
      );

      return toGradeRow(updated);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface SubjectGradeBlock {
  readonly subjectId: string | null;
  readonly subjectName: string;
  readonly grades: readonly GradeRow[];
  /** Weighted by `weightPpm`, normalised by the weights present. */
  readonly averagePercentPpm: number | null;
}

export interface TermGradeBlock {
  readonly termId: string | null;
  readonly termName: string;
  readonly subjects: readonly SubjectGradeBlock[];
  readonly averagePercentPpm: number | null;
  readonly gradeCount: number;
}

export interface StudentGradebook {
  readonly studentId: string;
  readonly fullName: string;
  readonly studentCode: string;
  readonly terms: readonly TermGradeBlock[];
  readonly overallAveragePercentPpm: number | null;
  readonly gradeCount: number;
}

/**
 * Every grade a student holds, grouped by term and then subject.
 *
 * One query with two joins, folded in memory. Terms and subjects both come back on
 * the grade row, so the shape below needs no further round trips.
 */
export async function getStudentGradebook(
  ctx: AccessContext,
  studentId: string,
  input: { readonly termId?: string; readonly subjectId?: string } = {},
  db: Db = prisma,
): Promise<StudentGradebook> {
  requirePermission(ctx, 'grades.view');

  const needsSelf = isSelfScoped(ctx) && !can(ctx, 'grades.viewAll');
  const student = await db.student.findFirst({
    // Scope in the same `where` as the id: a teacher, a parent and a student each see
    // their own subset, and a miss must not reveal that the student exists elsewhere.
    // ANDed rather than merged, because the SELF predicate can itself carry an `id`
    // and merging would silently answer with the caller's own record instead of a 404.
    where: {
      AND: [
        { id: studentId, ...scopeFilter(ctx), deletedAt: null },
        ...(needsSelf ? [selfStudentPredicate(ctx) as Prisma.StudentWhereInput] : []),
      ],
    },
    select: { id: true, firstName: true, lastName: true, studentCode: true },
  });
  if (!student) throw new NotFoundError('Student', studentId);

  const grades = await db.grade.findMany({
    where: {
      ...organizationFilter(ctx),
      studentId: student.id,
      ...(input.termId ? { termId: input.termId } : {}),
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    },
    orderBy: [{ gradedAt: 'desc' }],
    select: gradeSelect,
  });

  const rows = grades.map(toGradeRow);

  // term -> subject -> grades, with the term order taken from the rows themselves.
  const byTerm = new Map<string, GradeRow[]>();
  for (const row of rows) {
    const key = row.termId ?? '';
    const bucket = byTerm.get(key);
    if (bucket) bucket.push(row);
    else byTerm.set(key, [row]);
  }

  const terms: TermGradeBlock[] = [...byTerm.entries()].map(([termKey, termRows]) => {
    const bySubject = new Map<string, GradeRow[]>();
    for (const row of termRows) {
      const key = row.subjectId ?? '';
      const bucket = bySubject.get(key);
      if (bucket) bucket.push(row);
      else bySubject.set(key, [row]);
    }

    const subjects: SubjectGradeBlock[] = [...bySubject.entries()].map(([subjectKey, subjectRows]) => ({
      subjectId: subjectKey === '' ? null : subjectKey,
      subjectName: subjectRows[0]?.subjectName ?? 'Unassigned',
      grades: subjectRows,
      averagePercentPpm: averagePercentPpm(subjectRows),
    }));

    return {
      termId: termKey === '' ? null : termKey,
      termName: termRows[0]?.termName ?? 'No term',
      subjects: subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
      // Computed across the term's grades directly rather than by averaging the
      // subject averages: a subject with six assessments should weigh more than one
      // with a single participation mark, unless the weights say otherwise.
      averagePercentPpm: averagePercentPpm(termRows),
      gradeCount: termRows.length,
    };
  });

  return {
    studentId: student.id,
    fullName: `${student.firstName} ${student.lastName}`,
    studentCode: student.studentCode,
    terms,
    overallAveragePercentPpm: averagePercentPpm(rows),
    gradeCount: rows.length,
  };
}

function averagePercentPpm(rows: readonly GradeRow[]): number | null {
  const average = weightedAverage(
    rows.map((row) => ({ value: row.percentPpm, weightPpm: row.weightPpm })),
  );
  return average === null ? null : Math.round(average);
}

/** SELF narrowing for a single-student fetch, mirroring `selfStudentFilter`. */
function selfStudentPredicate(ctx: AccessContext): Record<string, unknown> {
  const { studentId, guardianId, teacherId } = ctx.self;
  if (studentId) return { id: studentId };
  if (guardianId) return { guardians: { some: { guardianId } } };
  if (teacherId) {
    return {
      enrollments: {
        some: { group: { teacherAssignments: { some: { teacherId, endDate: null } } } },
      },
    };
  }
  return { id: { in: [] as string[] } };
}

export interface GradebookColumn {
  /** `exam:<id>` or `homework:<id>`. Stable, so a UI can key a cell by it. */
  readonly key: string;
  readonly kind: 'EXAM' | 'HOMEWORK';
  readonly id: string;
  readonly title: string;
  readonly maxScore: number | null;
  readonly weightPpm: number;
  readonly occurredAt: Date;
}

export interface GradebookCell {
  readonly score: number;
  readonly maxScore: number;
  readonly percentPpm: number;
  readonly gradeLabel: string | null;
  readonly isPass: boolean | null;
}

export interface GradebookStudentRow {
  readonly studentId: string;
  readonly fullName: string;
  readonly studentCode: string;
  /** Keyed by `GradebookColumn.key`; a missing key means no grade recorded. */
  readonly cells: Readonly<Record<string, GradebookCell>>;
  /**
   * Weighted across every grade the student holds in this group, including manual
   * entries that have no column of their own.
   */
  readonly averagePercentPpm: number | null;
  readonly gradeCount: number;
}

export interface GroupGradebook {
  readonly groupId: string;
  readonly groupName: string;
  readonly columns: readonly GradebookColumn[];
  readonly students: readonly GradebookStudentRow[];
  readonly averagePercentPpm: number | null;
}

/**
 * The matrix view: students down the side, assessments across the top.
 *
 * Five queries, whatever the size of the class: group, roster, exams, homework, and
 * the grades. Assembling it per student would be a textbook N+1 on the one screen a
 * teacher opens most often.
 */
export async function getGroupGradebook(
  ctx: AccessContext,
  input: { readonly groupId: string; readonly termId?: string },
  db: Db = prisma,
): Promise<GroupGradebook> {
  requirePermission(ctx, 'grades.view');

  const group = await db.group.findFirst({
    where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, name: true },
  });
  if (!group) throw new NotFoundError('Group', input.groupId);

  if (isSelfScoped(ctx) && !ctx.isSystem && !can(ctx, 'grades.viewAll')) {
    const teacherId = ctx.self.teacherId;
    const assigned =
      teacherId !== null &&
      (await db.groupTeacher.count({
        where: { groupId: group.id, teacherId, endDate: null },
      })) > 0;
    // A student or parent has no business reading the whole class's marks, and a
    // teacher only their own class: 404 rather than an empty matrix, which would
    // imply the class exists but has no grades.
    if (!assigned) throw new NotFoundError('Group', input.groupId);
  }

  const [enrollments, exams, homework, grades] = await Promise.all([
    db.enrollment.findMany({
      where: { groupId: group.id, endDate: null, student: { deletedAt: null } },
      orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
      select: {
        student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
      },
    }),
    db.exam.findMany({
      where: {
        ...scopeFilter(ctx),
        groupId: group.id,
        deletedAt: null,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        ...(input.termId ? { termId: input.termId } : {}),
      },
      orderBy: { scheduledAt: 'asc' },
      select: { id: true, title: true, maxScore: true, weightPpm: true, scheduledAt: true },
    }),
    db.homework.findMany({
      where: {
        ...scopeFilter(ctx),
        groupId: group.id,
        deletedAt: null,
        status: { not: 'DRAFT' },
      },
      orderBy: { dueAt: 'asc' },
      select: { id: true, title: true, maxScore: true, dueAt: true },
    }),
    db.grade.findMany({
      where: {
        ...organizationFilter(ctx),
        groupId: group.id,
        ...(input.termId ? { termId: input.termId } : {}),
      },
      select: {
        studentId: true,
        sourceType: true,
        score: true,
        maxScore: true,
        weightPpm: true,
        gradeLabel: true,
        isPass: true,
        examId: true,
        homeworkSubmissionId: true,
      },
    }),
  ]);

  // A homework grade points at the SUBMISSION, so one more query maps submissions to
  // their homework. Still one query, not one per row.
  const submissionIds = grades
    .map((grade) => grade.homeworkSubmissionId)
    .filter((id): id is string => id !== null);
  const submissions =
    submissionIds.length === 0
      ? []
      : await db.homeworkSubmission.findMany({
          where: { id: { in: submissionIds } },
          select: { id: true, homeworkId: true },
        });
  const homeworkBySubmission = new Map(submissions.map((row) => [row.id, row.homeworkId]));

  const columns: GradebookColumn[] = [
    ...exams.map((exam) => ({
      key: `exam:${exam.id}`,
      kind: 'EXAM' as const,
      id: exam.id,
      title: exam.title,
      maxScore: exam.maxScore,
      weightPpm: exam.weightPpm,
      occurredAt: exam.scheduledAt,
    })),
    ...homework.map((item) => ({
      key: `homework:${item.id}`,
      kind: 'HOMEWORK' as const,
      id: item.id,
      title: item.title,
      maxScore: item.maxScore,
      weightPpm: 0,
      occurredAt: item.dueAt,
    })),
  ].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const cellsByStudent = new Map<string, Record<string, GradebookCell>>();
  const weightsByStudent = new Map<string, Array<{ value: number; weightPpm: number }>>();

  for (const grade of grades) {
    const percentPpm = scoreToPpm(grade.score, grade.maxScore);

    const weights = weightsByStudent.get(grade.studentId) ?? [];
    weights.push({ value: percentPpm, weightPpm: grade.weightPpm });
    weightsByStudent.set(grade.studentId, weights);

    const key =
      grade.sourceType === 'EXAM' && grade.examId
        ? `exam:${grade.examId}`
        : grade.sourceType === 'HOMEWORK' && grade.homeworkSubmissionId
          ? `homework:${homeworkBySubmission.get(grade.homeworkSubmissionId) ?? ''}`
          : null;
    if (key === null || key === 'homework:') continue;

    const cells = cellsByStudent.get(grade.studentId) ?? {};
    cells[key] = {
      score: grade.score,
      maxScore: grade.maxScore,
      percentPpm,
      gradeLabel: grade.gradeLabel,
      isPass: grade.isPass,
    };
    cellsByStudent.set(grade.studentId, cells);
  }

  const students: GradebookStudentRow[] = enrollments.map(({ student }) => {
    const weights = weightsByStudent.get(student.id) ?? [];
    const average = weightedAverage(weights);
    return {
      studentId: student.id,
      fullName: `${student.firstName} ${student.lastName}`,
      studentCode: student.studentCode,
      cells: cellsByStudent.get(student.id) ?? {},
      averagePercentPpm: average === null ? null : Math.round(average),
      gradeCount: weights.length,
    };
  });

  const classAverages = students
    .map((student) => student.averagePercentPpm)
    .filter((value): value is number => value !== null);

  return {
    groupId: group.id,
    groupName: group.name,
    columns,
    students,
    averagePercentPpm:
      classAverages.length === 0
        ? null
        : Math.round(classAverages.reduce((sum, value) => sum + value, 0) / classAverages.length),
  };
}

const gradeSelect = {
  id: true,
  studentId: true,
  sourceType: true,
  score: true,
  maxScore: true,
  weightPpm: true,
  gradeLabel: true,
  gpaPoints: true,
  isPass: true,
  comment: true,
  groupId: true,
  subjectId: true,
  termId: true,
  examId: true,
  gradedAt: true,
  subject: { select: { name: true } },
  term: { select: { name: true } },
} satisfies Prisma.GradeSelect;

type GradeSelectRow = Prisma.GradeGetPayload<{ select: typeof gradeSelect }>;

function toGradeRow(grade: GradeSelectRow): GradeRow {
  return {
    id: grade.id,
    studentId: grade.studentId,
    sourceType: grade.sourceType,
    score: grade.score,
    maxScore: grade.maxScore,
    percentPpm: scoreToPpm(grade.score, grade.maxScore),
    weightPpm: grade.weightPpm,
    gradeLabel: grade.gradeLabel,
    gpaPoints: grade.gpaPoints,
    isPass: grade.isPass,
    comment: grade.comment,
    groupId: grade.groupId,
    subjectId: grade.subjectId,
    subjectName: grade.subject?.name ?? 'Unassigned',
    termId: grade.termId,
    termName: grade.term?.name ?? 'No term',
    examId: grade.examId,
    gradedAt: grade.gradedAt,
  };
}
