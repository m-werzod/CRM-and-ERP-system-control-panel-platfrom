/**
 * Entering and publishing exam results.
 *
 * ONE use-case grades a whole class, in one transaction. A per-student endpoint
 * would let a teacher's connection drop halfway through a register and leave the
 * class part-marked, and it would make "re-submit the sheet after fixing one typo"
 * -- which is what teachers actually do -- either a duplicate-key error or thirty
 * separate writes with no shared audit trail.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 *   1. `ExamResult.maxScore` is a SNAPSHOT of the exam's maximum at grading time.
 *      Reading a historical percentage must never depend on today's exam
 *      configuration; without the snapshot, raising an exam from 50 to 100 marks
 *      would silently halve every grade already awarded under it.
 *
 *   2. Re-running is normal, not an error. The write is keyed on the
 *      (examId, studentId) unique index, so re-submitting a corrected sheet UPDATES
 *      the existing row. A score that actually moves is audited on its own, with the
 *      old and the new value -- a grade changing quietly after a student has seen it
 *      is exactly what an audit trail is for.
 */

import type { NotifyInput } from '@/server/notifications';
import type { ExamStatus } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
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
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { loadGradeResolver } from '@/server/services/assessment/grade-resolution';

/** Statuses in which marks may be entered. A draft is not yet a real exam. */
const GRADEABLE_STATUSES: readonly ExamStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'GRADED',
  'PUBLISHED',
];

export interface ExamResultEntryInput {
  readonly studentId: string;
  /** Omitted or null for an absence, or for a paper not yet marked. */
  readonly score?: number | null;
  readonly isAbsent?: boolean;
  readonly remarks?: string | null;
}

export interface RecordExamResultsInput {
  readonly examId: string;
  readonly entries: readonly ExamResultEntryInput[];
  /**
   * Move the exam to GRADED when every student on the roster now has a result.
   * Defaults to true, because finishing the sheet is the normal intent.
   */
  readonly finalise?: boolean;
}

export interface RecordedExamResult {
  readonly studentId: string;
  readonly examResultId: string;
  /** Null for an absence or an unmarked paper: neither earns a gradebook row. */
  readonly gradeId: string | null;
  readonly score: number | null;
  readonly gradeLabel: string | null;
  readonly isPass: boolean | null;
  readonly isAbsent: boolean;
  /** True when a previously recorded score changed value. */
  readonly changed: boolean;
}

export interface RecordExamResultsResult {
  readonly examId: string;
  readonly status: ExamStatus;
  readonly created: number;
  readonly updated: number;
  readonly changedScores: number;
  readonly results: readonly RecordedExamResult[];
}

export async function recordExamResults(
  ctx: AccessContext,
  input: RecordExamResultsInput,
  db?: Db,
): Promise<RecordExamResultsResult> {
  requirePermission(ctx, 'exams.grade');

  if (input.entries.length === 0) {
    throw new BusinessRuleError('exam.no_results', 'No results were supplied.');
  }

  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (seen.has(entry.studentId)) {
      throw new BusinessRuleError(
        'exam.duplicate_student',
        'The same student appears twice in this result sheet.',
        { details: { studentId: entry.studentId } },
      );
    }
    seen.add(entry.studentId);
  }

  return withTransaction(
    async (tx) => {
      const exam = await tx.exam.findFirst({
        where: { id: input.examId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          branchId: true,
          groupId: true,
          subjectId: true,
          termId: true,
          maxScore: true,
          passingScore: true,
          weightPpm: true,
          status: true,
          scheduledAt: true,
          gradingScaleId: true,
          group: { select: { id: true, name: true } },
        },
      });
      if (!exam) throw new NotFoundError('Exam', input.examId);

      if (!GRADEABLE_STATUSES.includes(exam.status)) {
        throw new StateInvalidError('exam', exam.status.toLowerCase(), 'graded');
      }

      await assertMayGrade(ctx, tx, exam.groupId);

      const submittedIds = input.entries.map((entry) => entry.studentId);
      const eligible = await eligibleStudentIds(ctx, tx, exam, submittedIds);
      const offRoster = submittedIds.filter((studentId) => !eligible.has(studentId));
      if (offRoster.length > 0) {
        throw new BusinessRuleError(
          'exam.student_not_enrolled',
          exam.groupId
            ? 'One or more students were not enrolled in this group on the exam date.'
            : 'One or more students could not be found.',
          { details: { studentIds: offRoster } },
        );
      }

      for (const entry of input.entries) {
        assertEntryValid(entry, exam.maxScore);
      }

      // The scale is loaded once for the whole sheet, not once per student.
      const resolver = await loadGradeResolver(ctx, { gradingScaleId: exam.gradingScaleId }, tx);

      const studentIds = submittedIds;
      const existingResults = await tx.examResult.findMany({
        where: { examId: exam.id, studentId: { in: studentIds } },
        select: {
          id: true,
          studentId: true,
          score: true,
          maxScore: true,
          gradeLabel: true,
          isPass: true,
          isAbsent: true,
          remarks: true,
        },
      });
      const existingByStudent = new Map(existingResults.map((row) => [row.studentId, row]));

      // One query for the Grade rows already attached to those results, so the
      // gradebook row is updated in step rather than duplicated.
      const existingGrades = await tx.grade.findMany({
        where: {
          organizationId: ctx.organizationId,
          examId: exam.id,
          sourceType: 'EXAM',
          studentId: { in: studentIds },
        },
        select: { id: true, studentId: true, score: true },
      });
      const gradeByStudent = new Map(existingGrades.map((row) => [row.studentId, row]));

      const now = new Date();
      const results: RecordedExamResult[] = [];
      const changes: Array<{
        studentId: string;
        examResultId: string;
        previous: { score: number | null; gradeLabel: string | null; isPass: boolean | null; isAbsent: boolean };
        next: { score: number | null; gradeLabel: string | null; isPass: boolean | null; isAbsent: boolean };
      }> = [];
      let created = 0;
      let updated = 0;

      for (const entry of input.entries) {
        const isAbsent = entry.isAbsent === true;
        const score = isAbsent ? null : (entry.score ?? null);

        // An absence and an unmarked paper both have no grade: inventing one would
        // put a letter on a student's record for an exam they did not sit.
        const resolved =
          score === null ? null : resolver.resolve(score, exam.maxScore, exam.passingScore);

        let changed = false;
        const previous = existingByStudent.get(entry.studentId);
        const data = {
          score,
          // The snapshot. See the rule at the top of this file.
          maxScore: exam.maxScore,
          gradeLabel: resolved?.gradeLabel ?? null,
          isPass: resolved === null ? null : resolved.isPass,
          isAbsent,
          remarks: entry.remarks ?? null,
          gradedById: ctx.isSystem ? null : ctx.userId,
          gradedAt: score === null && !isAbsent ? null : now,
        };

        const examResult = previous
          ? await tx.examResult.update({
              where: { id: previous.id },
              data,
              select: { id: true },
            })
          : await tx.examResult.create({
              data: { examId: exam.id, studentId: entry.studentId, ...data },
              select: { id: true },
            });

        if (previous) {
          updated += 1;
          if (
            previous.score !== data.score ||
            previous.isAbsent !== data.isAbsent ||
            previous.gradeLabel !== data.gradeLabel
          ) {
            changed = true;
            changes.push({
              studentId: entry.studentId,
              examResultId: examResult.id,
              previous: {
                score: previous.score,
                gradeLabel: previous.gradeLabel,
                isPass: previous.isPass,
                isAbsent: previous.isAbsent,
              },
              next: {
                score: data.score,
                gradeLabel: data.gradeLabel,
                isPass: data.isPass,
                isAbsent: data.isAbsent,
              },
            });
          }
        } else {
          created += 1;
        }

        // The gradebook row. Written from the same numbers in the same transaction,
        // so a Grade can never describe a result that rolled back.
        const gradeData = {
          groupId: exam.groupId,
          subjectId: exam.subjectId,
          termId: exam.termId,
          sourceType: 'EXAM' as const,
          examId: exam.id,
          examResultId: examResult.id,
          score: score ?? 0,
          maxScore: exam.maxScore,
          weightPpm: exam.weightPpm,
          gradeLabel: data.gradeLabel,
          gpaPoints: resolved?.gpaPoints ?? null,
          isPass: data.isPass,
          gradedById: ctx.isSystem ? null : ctx.userId,
          gradedAt: now,
        };

        const existingGrade = gradeByStudent.get(entry.studentId);
        let gradeId: string | null;
        if (score === null) {
          // No score means no gradebook entry. A row carrying `score: 0` for an
          // absence would poison every average that reads the gradebook.
          if (existingGrade) await tx.grade.delete({ where: { id: existingGrade.id } });
          gradeId = null;
        } else if (existingGrade) {
          const grade = await tx.grade.update({
            where: { id: existingGrade.id },
            data: gradeData,
            select: { id: true },
          });
          gradeId = grade.id;
        } else {
          const grade = await tx.grade.create({
            data: {
              organizationId: ctx.organizationId,
              studentId: entry.studentId,
              ...gradeData,
            },
            select: { id: true },
          });
          gradeId = grade.id;
        }

        results.push({
          studentId: entry.studentId,
          examResultId: examResult.id,
          gradeId,
          score,
          gradeLabel: data.gradeLabel,
          isPass: data.isPass,
          isAbsent,
          changed,
        });
      }

      // --- status ----------------------------------------------------------
      let status = exam.status;
      const finalise = input.finalise ?? true;
      if (finalise && exam.status !== 'PUBLISHED') {
        const resultCount = await tx.examResult.count({ where: { examId: exam.id } });
        const complete = resultCount >= eligible.size;
        if (complete) {
          status = 'GRADED';
          if (exam.status !== 'GRADED') {
            await tx.exam.update({ where: { id: exam.id }, data: { status: 'GRADED' } });
          }
        }
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EXAM_GRADED,
          entityType: 'Exam',
          entityId: exam.id,
          branchId: exam.branchId,
          summary: `Results entered for "${exam.title}": ${created} new, ${updated} updated`,
          metadata: {
            created,
            updated,
            changedScores: changes.length,
            gradingScaleId: resolver.scaleId,
          },
          timeline: exam.group
            ? {
                subjectType: 'GROUP',
                subjectId: exam.group.id,
                type: 'exam.graded',
                title: `Results entered: ${exam.title}`,
              }
            : null,
        },
        tx,
      );

      // A score that moved gets its own row, at NOTICE, naming the student. This is
      // the trail somebody follows when a parent asks why a grade changed.
      for (const change of changes) {
        await recordAudit(
          ctx,
          {
            action: AUDIT_ACTIONS.GRADE_CHANGED,
            entityType: 'ExamResult',
            entityId: change.examResultId,
            branchId: exam.branchId,
            summary: `Exam result changed on "${exam.title}": ${formatScore(change.previous.score, exam.maxScore, change.previous.isAbsent)} to ${formatScore(change.next.score, exam.maxScore, change.next.isAbsent)}`,
            changes: diffFields(change.previous, change.next),
            severity: 'NOTICE',
            metadata: { examId: exam.id, studentId: change.studentId },
            timeline: {
              subjectType: 'STUDENT',
              subjectId: change.studentId,
              type: 'exam.result_changed',
              title: `${exam.title}: result changed to ${formatScore(change.next.score, exam.maxScore, change.next.isAbsent)}`,
            },
          },
          tx,
        );
      }

      return {
        examId: exam.id,
        status,
        created,
        updated,
        changedScores: changes.length,
        results,
      };
    },
    { existing: db },
  );
}

function formatScore(score: number | null, maxScore: number, isAbsent: boolean): string {
  if (isAbsent) return 'absent';
  if (score === null) return 'not marked';
  return `${score}/${maxScore}`;
}

function assertEntryValid(entry: ExamResultEntryInput, maxScore: number): void {
  const isAbsent = entry.isAbsent === true;

  if (isAbsent && entry.score !== undefined && entry.score !== null) {
    throw new BusinessRuleError(
      'exam.absent_with_score',
      'A student marked absent cannot also have a score.',
      { details: { studentId: entry.studentId } },
    );
  }
  if (isAbsent || entry.score === undefined || entry.score === null) return;

  if (!Number.isInteger(entry.score)) {
    throw new BusinessRuleError(
      'exam.fractional_score',
      'Scores are whole marks.',
      { details: { studentId: entry.studentId, score: entry.score } },
    );
  }
  if (entry.score < 0 || entry.score > maxScore) {
    throw new BusinessRuleError(
      'exam.score_out_of_range',
      `A score must be between 0 and the exam maximum of ${maxScore}.`,
      { details: { studentId: entry.studentId, score: entry.score, maxScore } },
    );
  }
}

/** A teacher may only grade the classes they teach. */
async function assertMayGrade(
  ctx: AccessContext,
  tx: Tx,
  groupId: string | null,
): Promise<void> {
  if (ctx.isSystem || !isSelfScoped(ctx) || can(ctx, 'grades.viewAll')) return;

  const teacherId = ctx.self.teacherId;
  if (!teacherId) {
    throw new ForbiddenError('Only the assigned teacher or an administrator can grade this exam.');
  }
  if (!groupId) return;

  const assigned = await tx.groupTeacher.count({
    where: { groupId, teacherId, endDate: null },
  });
  if (assigned === 0) throw new ForbiddenError('You are not assigned to that class.');
}

/**
 * Students who may legitimately appear on this sheet: those enrolled in the group on
 * the exam date. Dated rather than "currently enrolled", so a student who has since
 * transferred out still has the mark they earned, and one who joined afterwards
 * cannot be given a score for an exam they did not sit.
 */
async function eligibleStudentIds(
  ctx: AccessContext,
  tx: Tx,
  exam: { readonly groupId: string | null; readonly scheduledAt: Date },
  submittedIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (exam.groupId) {
    const enrollments = await tx.enrollment.findMany({
      where: {
        groupId: exam.groupId,
        startDate: { lte: exam.scheduledAt },
        OR: [{ endDate: null }, { endDate: { gte: exam.scheduledAt } }],
        student: { deletedAt: null },
      },
      select: { studentId: true },
    });
    return new Set(enrollments.map((row) => row.studentId));
  }

  // A group-less exam (a placement test, say) has no roster, so the only test left
  // is scope. Restricted to the ids submitted rather than every student in the
  // organisation: the answer is used as a membership test, not as a list.
  const students = await tx.student.findMany({
    where: { id: { in: [...submittedIds] }, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true },
  });
  return new Set(students.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface PublishExamResultsResult {
  readonly examId: string;
  readonly status: ExamStatus;
  readonly resultsPublishedAt: Date;
  readonly publishedCount: number;
  /**
   * Ready-made payloads for `notify()`. This service does NOT send them: queuing a
   * message inside the publishing transaction would either send twice on a retry or
   * commit a message for a publish that rolled back. The caller sends them after the
   * commit, and owns the failure handling.
   */
  readonly notifications: readonly NotifyInput<'EXAM_RESULT_PUBLISHED'>[];
}

/**
 * Publish results to students and parents.
 *
 * Absent and unmarked students are deliberately left out of the notification list:
 * "you scored nothing out of 100" is not a message anybody should receive, and an
 * absence is the attendance module's story to tell.
 */
export async function publishExamResults(
  ctx: AccessContext,
  examId: string,
  db?: Db,
): Promise<PublishExamResultsResult> {
  requirePermission(ctx, 'exams.publishResults');

  return withTransaction(
    async (tx) => {
      const exam = await tx.exam.findFirst({
        where: { id: examId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          title: true,
          branchId: true,
          status: true,
          maxScore: true,
          resultsPublishedAt: true,
          group: { select: { id: true, name: true } },
          results: {
            select: {
              studentId: true,
              score: true,
              maxScore: true,
              isPass: true,
              isAbsent: true,
              student: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });
      if (!exam) throw new NotFoundError('Exam', examId);

      if (exam.status === 'PUBLISHED') {
        throw new StateInvalidError('exam', 'already published', 'published again');
      }
      if (exam.status !== 'GRADED' && exam.status !== 'COMPLETED') {
        throw new StateInvalidError('exam', exam.status.toLowerCase(), 'published');
      }
      if (exam.results.length === 0) {
        throw new BusinessRuleError(
          'exam.nothing_to_publish',
          'This exam has no results to publish.',
        );
      }

      const now = new Date();
      await tx.exam.update({
        where: { id: exam.id },
        data: { status: 'PUBLISHED', resultsPublishedAt: now },
      });

      const notifications = exam.results
        .filter((result) => !result.isAbsent && result.score !== null)
        .map((result) => ({
          event: 'EXAM_RESULT_PUBLISHED' as const,
          subjectId: result.studentId,
          branchId: exam.branchId,
          // Namespaced on the exam and the student, so publishing twice after a
          // failed send does not message a parent twice.
          dedupeKey: `exam_result:${exam.id}:${result.studentId}`,
          variables: {
            studentName: `${result.student.firstName} ${result.student.lastName}`,
            examName: exam.title,
            score: String(result.score),
            maxScore: String(result.maxScore),
            passed: result.isPass === true,
          },
        }));

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EXAM_RESULTS_PUBLISHED,
          entityType: 'Exam',
          entityId: exam.id,
          branchId: exam.branchId,
          summary: `Results published for "${exam.title}" (${exam.results.length} students)`,
          severity: 'NOTICE',
          metadata: { resultCount: exam.results.length, notified: notifications.length },
          timeline: exam.group
            ? {
                subjectType: 'GROUP',
                subjectId: exam.group.id,
                type: 'exam.results_published',
                title: `Results published: ${exam.title}`,
                occurredAt: now,
              }
            : null,
        },
        tx,
      );

      return {
        examId: exam.id,
        status: 'PUBLISHED',
        resultsPublishedAt: now,
        publishedCount: exam.results.length,
        notifications,
      };
    },
    { existing: db },
  );
}
