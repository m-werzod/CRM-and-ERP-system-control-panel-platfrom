/**
 * Admissions reporting: the funnel and the stage bottlenecks.
 *
 * Both are single SQL aggregates. The obvious implementation — fetch the
 * applications in the range and tally them in JavaScript — moves the whole
 * admissions history into memory to draw two charts, and gets slower every term.
 *
 * Conversion rates are integer parts-per-million, the same convention percentages
 * use everywhere else in this codebase, so a rate can be stored, compared and
 * summed without a float creeping into a report.
 */

import type { ApplicationReviewStage, ApplicationStatus } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dayRangeToInstants, type DateOnly } from '@/lib/dates';

/** Pipeline order, so a chart reads left to right without the UI knowing the enum. */
const FUNNEL_STATUS_ORDER: readonly ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED',
  'ACCEPTED',
  'WAITLISTED',
  'REJECTED',
  'WITHDRAWN',
  'ENROLLED',
];

/** Integer parts-per-million; 0 when there is nothing to divide by. */
function ratePpm(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1_000_000);
}

export interface FunnelStatusCount {
  readonly status: ApplicationStatus;
  readonly count: number;
  /** This status's share of every application in the range, in ppm. */
  readonly sharePpm: number;
}

export interface AdmissionsFunnel {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly total: number;
  readonly byStatus: readonly FunnelStatusCount[];
  readonly submitted: number;
  readonly interviewed: number;
  readonly decided: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly waitlisted: number;
  readonly enrolled: number;
  readonly withdrawn: number;
  readonly submissionRatePpm: number;
  readonly interviewRatePpm: number;
  readonly acceptanceRatePpm: number;
  readonly enrollmentRatePpm: number;
  /** Applications created in the range that ended up enrolled. */
  readonly overallConversionPpm: number;
}

interface FunnelRow {
  readonly status: ApplicationStatus;
  readonly count: bigint;
  readonly submitted: bigint;
  readonly interviewed: bigint;
  readonly decided: bigint;
  readonly accepted: bigint;
  readonly rejected: bigint;
  readonly waitlisted: bigint;
}

export interface FunnelInput {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly branchId?: string | null;
  readonly programId?: string | null;
}

export async function getAdmissionsFunnel(
  ctx: AccessContext,
  input: FunnelInput,
  db: Db = prisma,
): Promise<AdmissionsFunnel> {
  requirePermission(ctx, 'applications.view');

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const range = dayRangeToInstants(input.from, input.to, timezone);

  // The scope predicate is built from ctx, never from input, so a caller cannot
  // widen their own branch access through a report parameter.
  const branchIds = ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds];
  const requestedBranch = input.branchId ?? null;
  const programId = input.programId ?? null;

  const rows = await db.$queryRaw<FunnelRow[]>`
    with scoped as (
      select
        a."status",
        a."submittedAt",
        a."decidedAt",
        a."decision",
        exists (
          select 1 from "interviews" i
          where i."applicationId" = a."id" and i."status" = 'COMPLETED'
        ) as interviewed
      from "applications" a
      where a."organizationId" = ${ctx.organizationId}
        and a."deletedAt" is null
        and a."createdAt" >= ${range.from}
        and a."createdAt" < ${range.toExclusive}
        and (${branchIds}::text[] is null or a."branchId" = any(${branchIds}::text[]))
        and (${requestedBranch}::text is null or a."branchId" = ${requestedBranch})
        and (${programId}::text is null or a."programId" = ${programId})
    )
    select
      "status"                                                          as "status",
      count(*)                                                          as "count",
      count(*) filter (where "submittedAt" is not null)                  as "submitted",
      count(*) filter (where interviewed)                                as "interviewed",
      count(*) filter (where "decidedAt" is not null)                    as "decided",
      count(*) filter (where "decision" = 'ACCEPT')                      as "accepted",
      count(*) filter (where "decision" = 'REJECT')                      as "rejected",
      count(*) filter (where "decision" = 'WAITLIST')                    as "waitlisted"
    from scoped
    group by "status"
  `;

  const counts = new Map<ApplicationStatus, number>();
  let total = 0;
  let submitted = 0;
  let interviewed = 0;
  let decided = 0;
  let accepted = 0;
  let rejected = 0;
  let waitlisted = 0;

  // Folding ten grouped rows is not the N+1 the aggregate exists to avoid; it is
  // how the cross-cutting totals are read off the same single scan.
  for (const row of rows) {
    const count = Number(row.count);
    counts.set(row.status, count);
    total += count;
    submitted += Number(row.submitted);
    interviewed += Number(row.interviewed);
    decided += Number(row.decided);
    accepted += Number(row.accepted);
    rejected += Number(row.rejected);
    waitlisted += Number(row.waitlisted);
  }

  const enrolled = counts.get('ENROLLED') ?? 0;
  const withdrawn = counts.get('WITHDRAWN') ?? 0;

  return {
    from: input.from,
    to: input.to,
    total,
    // Every status is listed, zeros included: a funnel with a missing bar reads as
    // a rendering bug rather than as "nobody reached that stage".
    byStatus: FUNNEL_STATUS_ORDER.map((status) => {
      const count = counts.get(status) ?? 0;
      return { status, count, sharePpm: ratePpm(count, total) };
    }),
    submitted,
    interviewed,
    decided,
    accepted,
    rejected,
    waitlisted,
    enrolled,
    withdrawn,
    submissionRatePpm: ratePpm(submitted, total),
    interviewRatePpm: ratePpm(interviewed, submitted),
    acceptanceRatePpm: ratePpm(accepted, decided),
    enrollmentRatePpm: ratePpm(enrolled, accepted),
    overallConversionPpm: ratePpm(enrolled, total),
  };
}

export interface StageBottleneck {
  readonly stage: ApplicationReviewStage;
  readonly completedCount: number;
  readonly pendingCount: number;
  readonly failedCount: number;
  /** Mean days from the gate opening to a verdict. Null when none is recorded. */
  readonly averageDaysToComplete: number | null;
  readonly longestDaysToComplete: number | null;
  /** Mean age of the gates still waiting — the actual queue, not its history. */
  readonly averageDaysPending: number | null;
}

interface BottleneckRow {
  readonly stage: ApplicationReviewStage;
  readonly completedCount: bigint;
  readonly pendingCount: bigint;
  readonly failedCount: bigint;
  readonly averageDaysToComplete: number | null;
  readonly longestDaysToComplete: number | null;
  readonly averageDaysPending: number | null;
}

/**
 * How long each gate takes, and how long the outstanding ones have been waiting.
 *
 * Both halves matter: a stage can show a healthy average because the only reviews
 * that ever complete are the easy ones, while twenty hard cases sit PENDING for
 * weeks. `averageDaysPending` is what surfaces those.
 */
export async function getStageBottlenecks(
  ctx: AccessContext,
  input: { from: DateOnly; to: DateOnly; branchId?: string | null },
  db: Db = prisma,
): Promise<StageBottleneck[]> {
  requirePermission(ctx, 'applications.view');

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const range = dayRangeToInstants(input.from, input.to, timezone);
  const branchIds = ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds];
  const requestedBranch = input.branchId ?? null;
  const now = new Date();

  // Averages are cast to double precision: PostgreSQL's avg() returns numeric,
  // which the driver hands back as a string, and a report must not have to parse
  // its own numbers.
  const rows = await db.$queryRaw<BottleneckRow[]>`
    select
      r."stage"                                                       as "stage",
      count(*) filter (where r."status" <> 'PENDING')                  as "completedCount",
      count(*) filter (where r."status" = 'PENDING')                   as "pendingCount",
      count(*) filter (where r."status" = 'FAILED')                    as "failedCount",
      (avg(extract(epoch from (r."completedAt" - r."createdAt")) / 86400.0)
        filter (where r."completedAt" is not null))::double precision  as "averageDaysToComplete",
      (max(extract(epoch from (r."completedAt" - r."createdAt")) / 86400.0)
        filter (where r."completedAt" is not null))::double precision  as "longestDaysToComplete",
      (avg(extract(epoch from (${now}::timestamptz - r."createdAt")) / 86400.0)
        filter (where r."status" = 'PENDING'))::double precision       as "averageDaysPending"
    from "application_reviews" r
    join "applications" a on a."id" = r."applicationId"
    where a."organizationId" = ${ctx.organizationId}
      and a."deletedAt" is null
      and a."createdAt" >= ${range.from}
      and a."createdAt" < ${range.toExclusive}
      and (${branchIds}::text[] is null or a."branchId" = any(${branchIds}::text[]))
      and (${requestedBranch}::text is null or a."branchId" = ${requestedBranch})
    group by r."stage"
  `;

  const byStage = new Map(rows.map((row) => [row.stage, row]));

  return FUNNEL_REVIEW_STAGES.map((stage) => {
    const row = byStage.get(stage);
    return {
      stage,
      completedCount: row ? Number(row.completedCount) : 0,
      pendingCount: row ? Number(row.pendingCount) : 0,
      failedCount: row ? Number(row.failedCount) : 0,
      averageDaysToComplete: round2(row?.averageDaysToComplete ?? null),
      longestDaysToComplete: round2(row?.longestDaysToComplete ?? null),
      averageDaysPending: round2(row?.averageDaysPending ?? null),
    };
  });
}

/** Stage order for the bottleneck table: the sequence a reviewer works through. */
const FUNNEL_REVIEW_STAGES: readonly ApplicationReviewStage[] = [
  'DOCUMENT_CHECK',
  'PLACEMENT_TEST',
  'INTERVIEW',
  'FINANCE_CHECK',
  'FINAL_APPROVAL',
];

/** Two decimals is the resolution anyone acts on; more is noise in a report. */
function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}
