/**
 * Review gates.
 *
 * One `ApplicationReview` row per stage, so the funnel is auditable stage by stage
 * and "why was this accepted" has a stage-level answer years later. Collapsing the
 * five gates into a single status field on the application would make that
 * unanswerable, which is why the row-per-gate model exists.
 *
 * A gate is recorded, never re-opened: recording the same stage twice overwrites
 * the verdict and the reviewer, and the audit log carries the previous values. The
 * (applicationId, stage) unique index is what keeps that an update rather than a
 * second contradictory row.
 */

import type {
  ApplicationReviewStage,
  ApplicationReviewStatus,
} from '@/generated/prisma/client';
import { withTransaction, prisma, type Db, type Tx } from '@/server/db/client';
import { BusinessRuleError, NotFoundError, StateInvalidError } from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import {
  applicationReadFilter,
  loadApplicationForWrite,
  DEFAULT_REVIEW_STAGES,
} from '@/server/services/admissions/applications';

/**
 * Gates that must be cleared before an ACCEPT.
 *
 * PLACEMENT_TEST and INTERVIEW are deliberately absent: plenty of programmes admit
 * without either, and a mandatory gate nobody intends to use would force every
 * admission through a meaningless SKIPPED row. A FAILED verdict on ANY stage still
 * blocks — see `evaluateGates`.
 */
export const MANDATORY_ACCEPT_STAGES: readonly ApplicationReviewStage[] = [
  'DOCUMENT_CHECK',
  'FINANCE_CHECK',
  'FINAL_APPROVAL',
];

/** Statuses in which a reviewer may still record a verdict. */
const REVIEWABLE_STATUSES = new Set([
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'WAITLISTED',
]);

export interface RecordReviewInput {
  readonly applicationId: string;
  readonly stage: ApplicationReviewStage;
  /** PENDING is not a verdict; a reviewer records an outcome. */
  readonly status: Exclude<ApplicationReviewStatus, 'PENDING'>;
  readonly notes?: string | null;
  /** Stage score, e.g. a placement-test mark out of 100. */
  readonly score?: number | null;
}

export interface ReviewResult {
  readonly id: string;
  readonly applicationId: string;
  readonly stage: ApplicationReviewStage;
  readonly status: ApplicationReviewStatus;
  readonly applicationStatus: string;
}

export async function recordReview(
  ctx: AccessContext,
  input: RecordReviewInput,
  db?: Db,
): Promise<ReviewResult> {
  requirePermission(ctx, 'applications.review');

  if (input.score != null && (!Number.isInteger(input.score) || input.score < 0)) {
    throw new BusinessRuleError(
      'review.invalid_score',
      'A review score must be a whole number of zero or more.',
    );
  }

  return withTransaction(
    async (tx) => {
      const application = await loadApplicationForWrite(ctx, tx, input.applicationId);
      if (!REVIEWABLE_STATUSES.has(application.status)) {
        throw new StateInvalidError('application', application.status.toLowerCase(), 'reviewed');
      }

      const previous = await tx.applicationReview.findUnique({
        where: { applicationId_stage: { applicationId: application.id, stage: input.stage } },
        select: { id: true, status: true, notes: true, score: true, reviewerId: true },
      });

      const completedAt = new Date();
      const reviewerId = ctx.isSystem ? null : ctx.userId;

      const review = await tx.applicationReview.upsert({
        where: { applicationId_stage: { applicationId: application.id, stage: input.stage } },
        // The row normally already exists (submitApplication opens all five), but a
        // stage added to DEFAULT_REVIEW_STAGES after an application was submitted
        // would otherwise be unrecordable.
        create: {
          applicationId: application.id,
          stage: input.stage,
          status: input.status,
          notes: input.notes ?? null,
          score: input.score ?? null,
          reviewerId,
          completedAt,
        },
        update: {
          status: input.status,
          notes: input.notes ?? null,
          score: input.score ?? null,
          reviewerId,
          completedAt,
        },
        select: { id: true, stage: true, status: true },
      });

      // The first recorded verdict is what moves an application into review; doing
      // it here rather than on a separate "start review" action means the status
      // can never disagree with the gates underneath it.
      let applicationStatus: string = application.status;
      const applicationData: {
        status?: 'UNDER_REVIEW';
        reviewedById: string | null;
        reviewedAt: Date;
        placementScore?: number | null;
      } = { reviewedById: reviewerId, reviewedAt: completedAt };

      if (application.status === 'SUBMITTED') {
        applicationData.status = 'UNDER_REVIEW';
        applicationStatus = 'UNDER_REVIEW';
      }
      // The placement result is denormalised onto the application because group
      // placement reads it without caring which gate produced it.
      if (input.stage === 'PLACEMENT_TEST') {
        applicationData.placementScore = input.score ?? null;
      }

      await tx.application.update({ where: { id: application.id }, data: applicationData });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.APPLICATION_REVIEWED,
          entityType: 'ApplicationReview',
          entityId: review.id,
          branchId: application.branchId,
          summary: `${input.stage} ${input.status.toLowerCase()} on application ${application.applicationNumber}`,
          reason: input.notes ?? null,
          changes: previous
            ? diffFields(
                { status: previous.status, score: previous.score, notes: previous.notes },
                { status: input.status, score: input.score, notes: input.notes },
              )
            : null,
          metadata: { applicationId: application.id, stage: input.stage },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: application.id,
            type: 'application.reviewed',
            title: `${input.stage.replace(/_/g, ' ').toLowerCase()}: ${input.status.toLowerCase()}`,
            description: input.notes ?? null,
            occurredAt: completedAt,
          },
        },
        tx,
      );

      return {
        id: review.id,
        applicationId: application.id,
        stage: review.stage,
        status: review.status,
        applicationStatus,
      };
    },
    { existing: db },
  );
}

export interface GateState {
  readonly stage: ApplicationReviewStage;
  readonly status: ApplicationReviewStatus;
  readonly mandatory: boolean;
  /** True when this gate is why a decision cannot be an ACCEPT. */
  readonly blocking: boolean;
  readonly score: number | null;
  readonly notes: string | null;
  readonly reviewerId: string | null;
  readonly completedAt: Date | null;
}

export interface ReviewProgress {
  readonly applicationId: string;
  readonly gates: readonly GateState[];
  readonly completedCount: number;
  readonly totalCount: number;
  /** Stages standing between this application and an ACCEPT. */
  readonly blockingStages: readonly ApplicationReviewStage[];
  readonly canAccept: boolean;
}

interface GateRow {
  readonly stage: ApplicationReviewStage;
  readonly status: ApplicationReviewStatus;
  readonly score: number | null;
  readonly notes: string | null;
  readonly reviewerId: string | null;
  readonly completedAt: Date | null;
}

/**
 * Decide, from the gate rows alone, whether an ACCEPT is permitted.
 *
 * Pure and exported so ./decide.ts and the review screen apply exactly the same
 * rule — a UI that enables the Accept button on a different rule from the server's
 * is how "the button worked but the save failed" happens.
 *
 * Blocking means: a mandatory gate still PENDING, or any gate FAILED. A SKIPPED
 * mandatory gate clears, because skipping is itself a recorded, attributed act
 * rather than an omission.
 */
export function evaluateGates(rows: readonly GateRow[]): {
  gates: GateState[];
  blockingStages: ApplicationReviewStage[];
  canAccept: boolean;
  completedCount: number;
} {
  const seen = new Map<ApplicationReviewStage, GateRow>();
  for (const row of rows) seen.set(row.stage, row);

  // Iterate the canonical stage list, not the rows, so a stage whose row was never
  // created still reports as PENDING and still blocks when it is mandatory.
  const stages: ApplicationReviewStage[] = [
    ...DEFAULT_REVIEW_STAGES,
    ...rows.map((row) => row.stage).filter((stage) => !DEFAULT_REVIEW_STAGES.includes(stage)),
  ];

  const gates: GateState[] = [];
  const blockingStages: ApplicationReviewStage[] = [];
  let completedCount = 0;

  for (const stage of stages) {
    const row = seen.get(stage);
    const status: ApplicationReviewStatus = row?.status ?? 'PENDING';
    const mandatory = MANDATORY_ACCEPT_STAGES.includes(stage);
    const blocking = status === 'FAILED' || (mandatory && status === 'PENDING');

    if (status !== 'PENDING') completedCount += 1;
    if (blocking) blockingStages.push(stage);

    gates.push({
      stage,
      status,
      mandatory,
      blocking,
      score: row?.score ?? null,
      notes: row?.notes ?? null,
      reviewerId: row?.reviewerId ?? null,
      completedAt: row?.completedAt ?? null,
    });
  }

  return { gates, blockingStages, canAccept: blockingStages.length === 0, completedCount };
}

export async function getReviewProgress(
  ctx: AccessContext,
  applicationId: string,
  db: Db = prisma,
): Promise<ReviewProgress> {
  requirePermission(ctx, 'applications.view');

  // Scope lives on the application, so the gate rows are reached through it rather
  // than fetched by applicationId and checked afterwards.
  const application = await db.application.findFirst({
    where: { id: applicationId, ...applicationReadFilter(ctx), deletedAt: null },
    select: {
      id: true,
      reviews: {
        select: {
          stage: true,
          status: true,
          score: true,
          notes: true,
          reviewerId: true,
          completedAt: true,
        },
      },
    },
  });
  if (!application) throw new NotFoundError('Application', applicationId);

  const evaluated = evaluateGates(application.reviews);

  return {
    applicationId: application.id,
    gates: evaluated.gates,
    completedCount: evaluated.completedCount,
    totalCount: evaluated.gates.length,
    blockingStages: evaluated.blockingStages,
    canAccept: evaluated.canAccept,
  };
}

/**
 * Gate rows for a decision check, read inside the caller's transaction. Takes no
 * ctx because the caller has already resolved the application through its scope —
 * re-filtering here by applicationId alone would add nothing.
 */
export async function readGatesInTransaction(
  tx: Tx,
  applicationId: string,
): Promise<GateRow[]> {
  return tx.applicationReview.findMany({
    where: { applicationId },
    select: {
      stage: true,
      status: true,
      score: true,
      notes: true,
      reviewerId: true,
      completedAt: true,
    },
  });
}
