/**
 * Turning a raw score into a grade label.
 *
 * The band arithmetic itself belongs to the academics domain
 * (`@/server/services/academics/grading-scales`) and is NOT reimplemented here --
 * an exam result and the grading-scale editor must agree about where a boundary
 * falls, and two copies of that rule would eventually disagree by one ppm. This
 * module is only the lookup: which scale applies to this exam, and what happens
 * when none does.
 *
 * When no scale is configured the label is `null` and `isPass` falls back to the
 * exam's own pass mark. That is deliberately honest: an institution that has not
 * set up its grading gets "72 / 100, passed" rather than an invented "B", because
 * fabricating a letter grade would put a figure on a certificate that nobody chose.
 */

import { prisma, type Db } from '@/server/db/client';
import type { AccessContext } from '@/server/rbac/access';
import { resolveGrade, scoreToPpm } from '@/server/services/academics/grading-scales';

export interface ResolvedScore {
  readonly gradeLabel: string | null;
  readonly gpaPoints: number | null;
  readonly isPass: boolean;
  readonly percentPpm: number;
}

interface ScaleBand {
  readonly label: string;
  readonly minPercentPpm: number;
  readonly maxPercentPpm: number;
  readonly gpaPoints: number | null;
  readonly isPass: boolean;
}

/**
 * A grading scale's bands, ready to be applied to many scores.
 *
 * Loaded once per grading run rather than once per student: a class of thirty would
 * otherwise make thirty identical queries for the same four bands.
 */
export interface GradeResolver {
  readonly scaleId: string | null;
  readonly bands: readonly ScaleBand[];
  resolve(score: number, maxScore: number, passingScore: number): ResolvedScore;
  /**
   * For a figure that is already a percentage -- a term average, a final grade --
   * where there is no raw score to divide.
   */
  resolvePercent(percentPpm: number, passingPercentPpm: number): ResolvedScore;
}

const NO_BANDS: readonly ScaleBand[] = [];

/**
 * Load the scale an exam is marked against: its own when it names one, otherwise
 * the organisation's default. Both lookups carry the organisation predicate, so an
 * exam cannot be graded against another tenant's scale.
 */
export async function loadGradeResolver(
  ctx: AccessContext,
  input: { readonly gradingScaleId?: string | null },
  db: Db = prisma,
): Promise<GradeResolver> {
  const scale = await db.gradingScale.findFirst({
    where: input.gradingScaleId
      ? { id: input.gradingScaleId, organizationId: ctx.organizationId }
      : { organizationId: ctx.organizationId, isDefault: true, isActive: true },
    select: {
      id: true,
      bands: {
        orderBy: { minPercentPpm: 'asc' },
        select: {
          label: true,
          minPercentPpm: true,
          maxPercentPpm: true,
          gpaPoints: true,
          isPass: true,
        },
      },
    },
  });

  return makeResolver(scale?.id ?? null, scale?.bands ?? NO_BANDS);
}

/** Resolver over bands the caller already has. Pure; useful for a preview. */
export function makeResolver(
  scaleId: string | null,
  bands: readonly ScaleBand[],
): GradeResolver {
  function resolvePercent(percentPpm: number, passingPercentPpm: number): ResolvedScore {
    const band = bands.length === 0 ? null : resolveGrade(bands, percentPpm);
    return {
      gradeLabel: band?.label ?? null,
      gpaPoints: band?.gpaPoints ?? null,
      // The scale wins when there is one: an institution whose scale says 50% is a
      // pass has said so more deliberately than whoever typed the exam's pass mark.
      isPass: band ? band.isPass : percentPpm >= passingPercentPpm,
      percentPpm,
    };
  }

  return {
    scaleId,
    bands,
    resolvePercent,
    resolve(score: number, maxScore: number, passingScore: number): ResolvedScore {
      return resolvePercent(scoreToPpm(score, maxScore), scoreToPpm(passingScore, maxScore));
    },
  };
}
