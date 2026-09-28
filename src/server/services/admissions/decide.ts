/**
 * The admission decision.
 *
 * The one place an application becomes ACCEPTED, REJECTED or WAITLISTED, and the
 * only place that writes `decision` / `decidedAt`. An ACCEPT is refused while a
 * mandatory gate is outstanding, and the refusal names the gate — "accepted before
 * anyone checked the documents" is the failure this guard exists to prevent, and a
 * generic "not allowed" would leave the admissions officer guessing.
 *
 * Deciding does NOT create a student. That is `createStudentFromApplication`,
 * which needs its own permission and its own transaction.
 */

import type { ApplicationDecision, ApplicationStatus } from '@/generated/prisma/client';
import { withTransaction, type Db } from '@/server/db/client';
import { BusinessRuleError, StateInvalidError } from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import { loadApplicationForWrite } from '@/server/services/admissions/applications';
import { evaluateGates, readGatesInTransaction } from '@/server/services/admissions/reviews';

/**
 * States a decision may be taken from.
 *
 * DRAFT is excluded (nothing has been submitted yet) and so are ENROLLED and
 * WITHDRAWN: a student already exists, or the applicant has walked away, and
 * re-deciding would contradict a record downstream. ACCEPTED and REJECTED are
 * included on purpose — an offer withdrawn, or a rejection overturned on appeal,
 * is a real event, and it lands in the audit log with its reason.
 */
const DECIDABLE_STATUSES: readonly ApplicationStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'ACCEPTED',
  'REJECTED',
  'WAITLISTED',
];

const STATUS_FOR_DECISION: Record<ApplicationDecision, ApplicationStatus> = {
  ACCEPT: 'ACCEPTED',
  REJECT: 'REJECTED',
  WAITLIST: 'WAITLISTED',
};

export interface DecideApplicationInput {
  readonly applicationId: string;
  readonly decision: ApplicationDecision;
  /** Mandatory: every decision is explainable to the applicant. */
  readonly reason: string;
  /** The day the place starts. Defaults to today for an ACCEPT. */
  readonly admissionDate?: DateOnly | null;
}

export interface DecisionResult {
  readonly id: string;
  readonly applicationNumber: string;
  readonly status: ApplicationStatus;
  readonly decision: ApplicationDecision;
  readonly decidedAt: Date;
  readonly admissionDate: Date | null;
}

export async function decideApplication(
  ctx: AccessContext,
  input: DecideApplicationInput,
  db?: Db,
): Promise<DecisionResult> {
  requirePermission(ctx, 'applications.decide');

  if (input.reason.trim().length === 0) {
    throw new BusinessRuleError(
      'application.decision_without_reason',
      'A decision must carry a reason.',
    );
  }

  return withTransaction(
    async (tx) => {
      const application = await loadApplicationForWrite(ctx, tx, input.applicationId);
      if (!DECIDABLE_STATUSES.includes(application.status)) {
        throw new StateInvalidError('application', application.status.toLowerCase(), 'decided');
      }

      if (input.decision === 'ACCEPT') {
        const { blockingStages } = evaluateGates(
          await readGatesInTransaction(tx, application.id),
        );
        if (blockingStages.length > 0) {
          throw new BusinessRuleError(
            'application.gates_outstanding',
            `This application cannot be accepted yet: ${blockingStages
              .map((stage) => stage.replace(/_/g, ' ').toLowerCase())
              .join(', ')} still ${blockingStages.length === 1 ? 'needs' : 'need'} to pass.`,
            { details: { blockingStages: [...blockingStages] } },
          );
        }
      }

      const status = STATUS_FOR_DECISION[input.decision];
      const decidedAt = new Date();

      // An admission date only means something for an accepted applicant; carrying
      // one on a rejection would show up as a start date in every report.
      let admissionDate: Date | null = null;
      if (input.decision === 'ACCEPT') {
        const { timezone } = await getSettings(
          ['timezone'],
          { organizationId: ctx.organizationId, branchId: application.branchId },
          tx,
        );
        admissionDate = dateOnlyToPrismaDate(input.admissionDate ?? todayIn(timezone));
      }

      const updated = await tx.application.update({
        where: { id: application.id },
        data: {
          status,
          decision: input.decision,
          decisionReason: input.reason,
          decidedAt,
          admissionDate,
          reviewedById: ctx.isSystem ? null : ctx.userId,
          reviewedAt: decidedAt,
        },
        select: { id: true, applicationNumber: true, status: true, admissionDate: true },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.APPLICATION_DECIDED,
          entityType: 'Application',
          entityId: application.id,
          branchId: application.branchId,
          summary: `Application ${application.applicationNumber} ${status.toLowerCase()}`,
          reason: input.reason,
          // A decision changes someone's admission; it is reviewable by definition.
          severity: 'NOTICE',
          metadata: {
            decision: input.decision,
            previousStatus: application.status,
            admissionDate: admissionDate ?? null,
          },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: application.id,
            type: 'application.decided',
            title: `Application ${status.toLowerCase()}`,
            description: input.reason,
            occurredAt: decidedAt,
          },
        },
        tx,
      );

      return {
        id: updated.id,
        applicationNumber: updated.applicationNumber,
        status: updated.status,
        decision: input.decision,
        decidedAt,
        admissionDate: updated.admissionDate,
      };
    },
    { existing: db },
  );
}
