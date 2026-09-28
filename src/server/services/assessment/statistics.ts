/**
 * Exam and cohort statistics.
 *
 * `examStatistics` is pure and exported because four different screens quote the
 * same numbers -- the exam page, the group performance report, the student profile
 * and the certificate decision -- and a second implementation of "the class
 * average" would eventually disagree with the first. It is unit-tested in
 * tests/unit/exam-statistics.test.ts.
 *
 * THE ABSENCE RULE, which this module exists to get right: a student who did not
 * sit the exam is EXCLUDED from the average, the median, the spread and the pass
 * rate, and counted separately. Averaging an absence as a zero misrepresents the
 * cohort -- it says the class understood less than it did, and it punishes a group
 * for an illness. The absentees are still reported, because "18 sat, 4 were away"
 * is the sentence a head of studies actually needs.
 */

import { prisma, type Db } from '@/server/db/client';
import { BusinessRuleError, NotFoundError } from '@/server/errors';
import {
  can,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
// The score -> ppm conversion belongs to the grading-scale contract; percentages
// computed here and there must agree to the ppm or a band boundary moves.
import { scoreToPpm } from '@/server/services/academics/grading-scales';

// ---------------------------------------------------------------------------
// Pure statistics
// ---------------------------------------------------------------------------

export interface ExamScoreEntry {
  /** `null` when the student has no score: absent, or not marked yet. */
  readonly score: number | null;
  /** Sat-but-absent. Kept out of every aggregate, counted on its own. */
  readonly isAbsent?: boolean;
}

/** A bare number is the common case, so callers may pass one directly. */
export type ExamScoreLike = number | ExamScoreEntry;

export interface ScoreBucket {
  /** Human label, e.g. "40-60%". */
  readonly label: string;
  /** Inclusive lower bound, in ppm of the maximum score. */
  readonly fromPercentPpm: number;
  /** Exclusive upper bound, except on the top bucket where it is inclusive. */
  readonly toPercentPpm: number;
  readonly count: number;
}

export interface ExamStatistics {
  /** Scores actually included in the aggregates. */
  readonly count: number;
  /** Students marked absent: excluded from every figure above, reported here. */
  readonly absentCount: number;
  /** Present but not yet graded. Also excluded, and not a zero either. */
  readonly pendingCount: number;
  readonly average: number | null;
  readonly median: number | null;
  readonly highest: number | null;
  readonly lowest: number | null;
  readonly passCount: number;
  readonly failCount: number;
  readonly passRatePpm: number | null;
  readonly standardDeviation: number | null;
  readonly distribution: readonly ScoreBucket[];
}

export interface ExamScale {
  readonly maxScore: number;
  readonly passingScore: number;
  /** Buckets in the distribution histogram. Five gives 20%-wide bands. */
  readonly bucketCount?: number;
}

/**
 * Rounded to four decimals. Raw IEEE results ("49.99999999999999") are not a
 * meaningful statistic, and a report, a CSV export and a test must all quote the
 * same number for the same cohort.
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function normalise(entry: ExamScoreLike): ExamScoreEntry {
  return typeof entry === 'number' ? { score: entry } : entry;
}

export function examStatistics(
  scores: readonly ExamScoreLike[],
  scale: ExamScale,
): ExamStatistics {
  if (!Number.isFinite(scale.maxScore) || scale.maxScore <= 0) {
    throw new BusinessRuleError(
      'exam.invalid_max_score',
      'An exam must have a maximum score greater than zero.',
    );
  }
  if (scale.passingScore < 0 || scale.passingScore > scale.maxScore) {
    throw new BusinessRuleError(
      'exam.invalid_passing_score',
      'The passing score must be between zero and the maximum score.',
    );
  }

  const bucketCount = Math.max(1, Math.trunc(scale.bucketCount ?? 5));
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    // Bounds in ppm of the maximum, so a 20% boundary is exactly 200_000 and not
    // 0.2 -- the same integer-percentage convention as GradingScaleBand.
    fromPercentPpm: Math.round((index * 1_000_000) / bucketCount),
    toPercentPpm: Math.round(((index + 1) * 1_000_000) / bucketCount),
    count: 0,
  }));

  const entries = scores.map(normalise);
  const absentCount = entries.filter((entry) => entry.isAbsent === true).length;

  const sat: number[] = [];
  let pendingCount = 0;
  for (const entry of entries) {
    if (entry.isAbsent === true) continue;
    if (entry.score === null || !Number.isFinite(entry.score)) {
      pendingCount += 1;
      continue;
    }
    sat.push(entry.score);
  }

  const distribution = (): ScoreBucket[] =>
    buckets.map((bucket) => ({
      label: `${Math.round(bucket.fromPercentPpm / 10_000)}-${Math.round(bucket.toPercentPpm / 10_000)}%`,
      fromPercentPpm: bucket.fromPercentPpm,
      toPercentPpm: bucket.toPercentPpm,
      count: bucket.count,
    }));

  if (sat.length === 0) {
    // Null rather than zero throughout: nobody sat this exam, so its average is
    // unknown, and a pass rate of 0% would read as "everybody failed".
    return {
      count: 0,
      absentCount,
      pendingCount,
      average: null,
      median: null,
      highest: null,
      lowest: null,
      passCount: 0,
      failCount: 0,
      passRatePpm: null,
      standardDeviation: null,
      distribution: distribution(),
    };
  }

  const sorted = [...sat].sort((a, b) => a - b);
  const count = sorted.length;
  const total = sorted.reduce((sum, score) => sum + score, 0);
  const average = total / count;

  const middle = Math.floor(count / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  const median =
    count % 2 === 1
      ? (upper ?? average)
      : lower !== undefined && upper !== undefined
        ? (lower + upper) / 2
        : average;

  // Population, not sample: these are all the students who sat the exam, not a
  // draw from a larger group, so dividing by n is the honest denominator.
  const variance = sorted.reduce((sum, score) => sum + (score - average) ** 2, 0) / count;

  // Inclusive: a student who scores exactly the passing score has passed.
  const passCount = sorted.filter((score) => score >= scale.passingScore).length;

  for (const score of sorted) {
    // Integer multiply before the divide, so a score sitting exactly on a bucket
    // boundary lands in the higher bucket rather than on a rounding coin-flip.
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((score * bucketCount) / scale.maxScore)),
    );
    const bucket = buckets[index];
    if (bucket) bucket.count += 1;
  }

  return {
    count,
    absentCount,
    pendingCount,
    average: round4(average),
    median: round4(median),
    highest: sorted[count - 1] ?? null,
    lowest: sorted[0] ?? null,
    passCount,
    failCount: count - passCount,
    passRatePpm: Math.round((passCount / count) * 1_000_000),
    standardDeviation: round4(Math.sqrt(variance)),
    distribution: distribution(),
  };
}

// ---------------------------------------------------------------------------
// Database-backed reports
// ---------------------------------------------------------------------------

export interface ExamStatisticsResult extends ExamStatistics {
  readonly examId: string;
  readonly title: string;
  readonly maxScore: number;
  readonly passingScore: number;
  /** Students on the roster with no result row at all. */
  readonly missingResultCount: number;
}

/**
 * Statistics for one exam.
 *
 * Reads the results with the exam's own scope predicate, so a caller who cannot
 * see the exam gets a 404 rather than an aggregate computed from rows they may not
 * read.
 */
export async function getExamStatistics(
  ctx: AccessContext,
  examId: string,
  db: Db = prisma,
): Promise<ExamStatisticsResult> {
  requirePermission(ctx, 'exams.view');

  const exam = await db.exam.findFirst({
    where: { id: examId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      title: true,
      maxScore: true,
      passingScore: true,
      groupId: true,
      scheduledAt: true,
      results: { select: { score: true, isAbsent: true } },
    },
  });
  if (!exam) throw new NotFoundError('Exam', examId);

  const statistics = examStatistics(
    exam.results.map((row) => ({ score: row.score, isAbsent: row.isAbsent })),
    { maxScore: exam.maxScore, passingScore: exam.passingScore },
  );

  // How many of the students who should have sat it have no row yet: the figure
  // that tells a teacher the grading is unfinished rather than the class small.
  const rosterCount = exam.groupId
    ? await db.enrollment.count({
        where: {
          groupId: exam.groupId,
          startDate: { lte: exam.scheduledAt },
          OR: [{ endDate: null }, { endDate: { gte: exam.scheduledAt } }],
          student: { deletedAt: null },
        },
      })
    : exam.results.length;

  return {
    ...statistics,
    examId: exam.id,
    title: exam.title,
    maxScore: exam.maxScore,
    passingScore: exam.passingScore,
    missingResultCount: Math.max(0, rosterCount - exam.results.length),
  };
}

export interface GroupPerformanceRow {
  readonly examId: string;
  readonly title: string;
  readonly type: string;
  readonly scheduledAt: Date;
  readonly subjectName: string | null;
  readonly statistics: ExamStatistics;
}

export interface GroupPerformance {
  readonly groupId: string;
  readonly groupName: string;
  readonly exams: readonly GroupPerformanceRow[];
  /**
   * Mean of the per-exam average percentages, in ppm. Averaging percentages
   * rather than raw scores is deliberate: two exams marked out of 20 and out of
   * 100 are otherwise silently weighted 1:5.
   */
  readonly averagePercentPpm: number | null;
  readonly students: readonly {
    readonly studentId: string;
    readonly fullName: string;
    readonly studentCode: string;
    readonly gradedCount: number;
    readonly absentCount: number;
    readonly averagePercentPpm: number | null;
  }[];
}

/**
 * Every graded exam for a group, with per-exam and per-student aggregates.
 *
 * Two queries and two Maps rather than one query per exam: a group with a term's
 * worth of quizzes would otherwise make thirty round trips to render one page.
 */
export async function getGroupPerformance(
  ctx: AccessContext,
  input: { readonly groupId: string; readonly termId?: string | null },
  db: Db = prisma,
): Promise<GroupPerformance> {
  requirePermission(ctx, 'exams.view');

  const group = await db.group.findFirst({
    where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, name: true },
  });
  if (!group) throw new NotFoundError('Group', input.groupId);

  // A teacher without the module escape hatch sees performance only for groups
  // they are assigned to; the predicate is a WHERE fragment, not a UI filter.
  if (ctx.scope === 'SELF' && !ctx.isSystem && !can(ctx, 'grades.viewAll')) {
    const teacherId = ctx.self.teacherId;
    const assigned =
      teacherId !== null &&
      (await db.groupTeacher.count({
        where: { groupId: group.id, teacherId, endDate: null },
      })) > 0;
    if (!assigned) throw new NotFoundError('Group', input.groupId);
  }

  const exams = await db.exam.findMany({
    where: {
      ...scopeFilter(ctx),
      groupId: group.id,
      deletedAt: null,
      status: { in: ['GRADED', 'PUBLISHED', 'COMPLETED'] },
      ...(input.termId ? { termId: input.termId } : {}),
    },
    orderBy: { scheduledAt: 'asc' },
    select: {
      id: true,
      title: true,
      type: true,
      scheduledAt: true,
      maxScore: true,
      passingScore: true,
      subject: { select: { name: true } },
      results: { select: { studentId: true, score: true, maxScore: true, isAbsent: true } },
    },
  });

  const rows: GroupPerformanceRow[] = exams.map((exam) => ({
    examId: exam.id,
    title: exam.title,
    type: exam.type,
    scheduledAt: exam.scheduledAt,
    subjectName: exam.subject?.name ?? null,
    statistics: examStatistics(
      exam.results.map((result) => ({ score: result.score, isAbsent: result.isAbsent })),
      { maxScore: exam.maxScore, passingScore: exam.passingScore },
    ),
  }));

  const examPercentages = rows
    .map((row, index) => {
      const exam = exams[index];
      const average = row.statistics.average;
      if (!exam || average === null) return null;
      return scoreToPpm(average, exam.maxScore);
    })
    .filter((value): value is number => value !== null);

  // Per-student totals, folded from the rows already in memory.
  const perStudent = new Map<string, { percentPpmTotal: number; graded: number; absent: number }>();
  for (const exam of exams) {
    for (const result of exam.results) {
      const current =
        perStudent.get(result.studentId) ?? { percentPpmTotal: 0, graded: 0, absent: 0 };
      if (result.isAbsent) {
        current.absent += 1;
      } else if (result.score !== null) {
        // Against the snapshot on the result, not today's exam configuration.
        current.percentPpmTotal += scoreToPpm(result.score, result.maxScore);
        current.graded += 1;
      }
      perStudent.set(result.studentId, current);
    }
  }

  const studentRows = await db.student.findMany({
    where: { id: { in: [...perStudent.keys()] }, ...scopeFilter(ctx) },
    select: { id: true, firstName: true, lastName: true, studentCode: true },
  });
  const byId = new Map(studentRows.map((row) => [row.id, row]));

  return {
    groupId: group.id,
    groupName: group.name,
    exams: rows,
    averagePercentPpm:
      examPercentages.length === 0
        ? null
        : Math.round(
            examPercentages.reduce((sum, value) => sum + value, 0) / examPercentages.length,
          ),
    students: [...perStudent.entries()]
      .map(([studentId, totals]) => {
        const student = byId.get(studentId);
        return {
          studentId,
          fullName: student ? `${student.firstName} ${student.lastName}` : 'Unknown',
          studentCode: student?.studentCode ?? '',
          gradedCount: totals.graded,
          absentCount: totals.absent,
          averagePercentPpm:
            totals.graded === 0 ? null : Math.round(totals.percentPpmTotal / totals.graded),
        };
      })
      // Weakest first: that is the list a teacher acts on.
      .sort(
        (a, b) =>
          (a.averagePercentPpm ?? Number.MAX_SAFE_INTEGER) -
          (b.averagePercentPpm ?? Number.MAX_SAFE_INTEGER),
      ),
  };
}
