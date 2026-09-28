/**
 * CRM reports: where leads come from, where they stop, and who is working them.
 *
 * Two decisions worth stating:
 *
 *   THE FUNNEL IS BUILT FROM `LeadStatusHistory`, NOT FROM `Lead.status`. A lead
 *   sitting at ENROLLED passed through CONTACTED and QUALIFIED on the way, and a
 *   funnel that counted only current statuses would show an empty middle and a
 *   conversion rate of 100% at every stage. Reaching a stage is "there exists a
 *   history row with `toStatus` = that stage" -- which is exactly why
 *   `applyLeadStatusChange` is the only sanctioned writer of `Lead.status`.
 *
 *   PIPELINE VALUE IS PER CURRENCY. `Lead.expectedValueMinor` carries its own
 *   currency, and a branch trading in USD alongside one trading in UZS is the case
 *   this system is built for, so the value rows are grouped by currency rather
 *   than summed into a meaningless total.
 *
 * Scope: leads carry a NULLABLE branch -- a website enquiry arrives before anyone
 * has decided which site will serve it -- so an unrouted lead belongs to the
 * organisation and is visible to anyone inside it. The SELF narrowing follows
 * `crm.agentsSeeOnlyOwnLeads`, the same setting the list screens obey, so an agent
 * cannot read the whole pipeline's numbers off a report they cannot read off a
 * list.
 */

import { prisma, type Db } from '@/server/db/client';
import {
  can,
  isSelfScoped,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import type { DateOnly } from '@/lib/dates';
import { LEAD_PIPELINE } from '@/server/services/crm/scoring';
import {
  buildResult,
  capRows,
  countSeries,
  REPORT_ROW_CAP,
  resolveReportScope,
  sharePpm,
  truncUnit,
  type ReportFilters,
  type ReportResult,
  type ReportScope,
} from './types';
import { moneyColumn, percentColumn, type ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type LeadBreakdownRow = {
  /** `source`, `status`, `agent` or `pipelineValue`. */
  readonly dimension: string;
  readonly key: string;
  readonly label: string | null;
  readonly leads: number;
  readonly converted: number;
  readonly lost: number;
  readonly conversionPpm: number | null;
  /** Set only on `pipelineValue` rows, where the currency is meaningful. */
  readonly currency: string | null;
  readonly expectedValueMinor: string | null;
  readonly sharePpm: number | null;
};

export type LeadBreakdownTotals = {
  readonly leads: number;
  readonly converted: number;
  readonly lost: number;
  readonly open: number;
  readonly conversionPpm: number | null;
};

export type FunnelStageRow = {
  readonly stage: string;
  readonly sequence: number;
  readonly reached: number;
  /** Share of the leads that entered the funnel at all. */
  readonly ofEnteredPpm: number | null;
  /** Share of the previous stage: where the pipeline actually leaks. */
  readonly ofPreviousPpm: number | null;
  readonly droppedFromPrevious: number;
};

export type FunnelTotals = {
  readonly entered: number;
  readonly converted: number;
  readonly lost: number;
  readonly conversionPpm: number | null;
  /** Median days from a lead's creation to its conversion. */
  readonly medianDaysToConvert: number | null;
  readonly averageDaysToConvert: number | null;
};

export type LostReasonRow = {
  readonly reason: string;
  readonly leads: number;
  readonly sharePpm: number | null;
  readonly averageDaysBeforeLost: number | null;
};

export type LostReasonTotals = {
  readonly lost: number;
  readonly withReason: number;
};

export type FollowUpComplianceRow = {
  readonly userId: string;
  readonly userName: string;
  readonly tasks: number;
  readonly completed: number;
  readonly completedOnTime: number;
  readonly overdueOpen: number;
  readonly cancelled: number;
  readonly completionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
  readonly medianDelayHours: number | null;
};

export type FollowUpComplianceTotals = {
  readonly tasks: number;
  readonly completed: number;
  readonly completedOnTime: number;
  readonly overdueOpen: number;
  readonly completionRatePpm: number | null;
  readonly onTimeRatePpm: number | null;
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const LEAD_BREAKDOWN_COLUMNS: readonly ReportColumn<LeadBreakdownRow>[] = [
  { key: 'dimension', labelKey: 'reports.columns.dimension' },
  { key: 'label', labelKey: 'reports.columns.name' },
  { key: 'leads', labelKey: 'reports.columns.leads', kind: 'number' },
  { key: 'converted', labelKey: 'reports.columns.converted', kind: 'number' },
  { key: 'lost', labelKey: 'reports.columns.lost', kind: 'number' },
  percentColumn<LeadBreakdownRow>('conversionPpm', 'reports.columns.conversionRate'),
  moneyColumn<LeadBreakdownRow>('expectedValueMinor', 'reports.columns.pipelineValue', 'currency'),
];

export const FUNNEL_COLUMNS: readonly ReportColumn<FunnelStageRow>[] = [
  { key: 'stage', labelKey: 'reports.columns.stage' },
  { key: 'reached', labelKey: 'reports.columns.reached', kind: 'number' },
  percentColumn<FunnelStageRow>('ofEnteredPpm', 'reports.columns.ofEntered'),
  percentColumn<FunnelStageRow>('ofPreviousPpm', 'reports.columns.ofPrevious'),
  { key: 'droppedFromPrevious', labelKey: 'reports.columns.dropped', kind: 'number' },
];

export const LOST_REASON_COLUMNS: readonly ReportColumn<LostReasonRow>[] = [
  { key: 'reason', labelKey: 'reports.columns.lostReason' },
  { key: 'leads', labelKey: 'reports.columns.leads', kind: 'number' },
  percentColumn<LostReasonRow>('sharePpm', 'reports.columns.share'),
  {
    key: 'averageDaysBeforeLost',
    labelKey: 'reports.columns.averageDaysBeforeLost',
    kind: 'number',
  },
];

export const FOLLOW_UP_COMPLIANCE_COLUMNS: readonly ReportColumn<FollowUpComplianceRow>[] = [
  { key: 'userName', labelKey: 'reports.columns.assignee' },
  { key: 'tasks', labelKey: 'reports.columns.tasks', kind: 'number' },
  { key: 'completed', labelKey: 'reports.columns.completed', kind: 'number' },
  { key: 'completedOnTime', labelKey: 'reports.columns.onTime', kind: 'number' },
  { key: 'overdueOpen', labelKey: 'reports.columns.overdueOpen', kind: 'number' },
  percentColumn<FollowUpComplianceRow>('completionRatePpm', 'reports.columns.completionRate'),
  percentColumn<FollowUpComplianceRow>('onTimeRatePpm', 'reports.columns.onTimeRate'),
  { key: 'medianDelayHours', labelKey: 'reports.columns.medianDelayHours', kind: 'number' },
];

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface LeadScopeParams {
  readonly branchIds: string[] | null;
  readonly programIds: string[] | null;
  /** Set only when the institution blinkers agents AND this caller lacks `leads.viewAll`. */
  readonly ownUserId: string | null;
}

/**
 * The lead predicates, derived from `ctx` and the institution's setting only.
 *
 * This mirrors `leadReadFilter` in @/server/services/crm/shared, which the Prisma
 * paths use. Both must say the same thing: a report is not a different security
 * boundary from a list.
 */
async function leadScope(
  ctx: AccessContext,
  scope: ReportScope,
  db: Db,
): Promise<LeadScopeParams> {
  const { agentsSeeOnlyOwnLeads } = await getSettings(
    ['agentsSeeOnlyOwnLeads'],
    { organizationId: ctx.organizationId },
    db,
  );
  const blinkered = agentsSeeOnlyOwnLeads && isSelfScoped(ctx) && !can(ctx, 'leads.viewAll');

  return {
    branchIds: scope.branchIds,
    programIds: scope.programIds,
    ownUserId: blinkered ? ctx.userId : null,
  };
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Leads by source / status / agent, and pipeline value
// ---------------------------------------------------------------------------

/**
 * Lead counts and conversion across four axes in one round trip.
 *
 * `duplicateOfLeadId is null` throughout: a lead merged into another is not a
 * second enquiry, and counting it would inflate both the source volume and the
 * denominator of every conversion rate.
 */
export async function crmLeadsReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<LeadBreakdownRow, LeadBreakdownTotals>> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const lead = await leadScope(ctx, scope, client);
  const unit = truncUnit(scope.granularity);

  const [breakdown, trend] = await Promise.all([
    client.$queryRaw<
      Array<{
        dimension: string;
        key: string;
        label: string | null;
        leads: number;
        converted: number;
        lost: number;
        currency: string | null;
        expectedValue: bigint | null;
      }>
    >`
      with scoped as (
        select
          l."id", l."source", l."status", l."assignedToUserId",
          l."convertedAt", l."lostAt", l."currency", l."expectedValueMinor"
        from "leads" l
        where l."organizationId" = ${scope.organizationId}
          and l."deletedAt" is null
          and l."duplicateOfLeadId" is null
          and l."createdAt" >= ${scope.fromInstant}
          and l."createdAt" < ${scope.toExclusive}
          and (${lead.branchIds}::text[] is null
               or l."branchId" is null
               or l."branchId" = any(${lead.branchIds}::text[]))
          and (${lead.programIds}::text[] is null
               or l."interestedProgramId" = any(${lead.programIds}::text[]))
          and (${lead.ownUserId}::text is null
               or l."assignedToUserId" = ${lead.ownUserId}
               or l."createdById" = ${lead.ownUserId})
      )
      select 'source'::text as "dimension", s."source"::text as "key", null::text as "label",
             count(*)::int as "leads",
             count(*) filter (where s."convertedAt" is not null)::int as "converted",
             count(*) filter (where s."status" = 'LOST')::int as "lost",
             null::text as "currency", null::bigint as "expectedValue"
      from scoped s group by 1, 2, 3
      union all
      select 'status', s."status"::text, null,
             count(*)::int,
             count(*) filter (where s."convertedAt" is not null)::int,
             count(*) filter (where s."status" = 'LOST')::int,
             null, null
      from scoped s group by 1, 2, 3
      union all
      select 'agent', coalesce(s."assignedToUserId", 'UNASSIGNED'),
             case when u."id" is null then null else (u."firstName" || ' ' || u."lastName") end,
             count(*)::int,
             count(*) filter (where s."convertedAt" is not null)::int,
             count(*) filter (where s."status" = 'LOST')::int,
             null, null
      from scoped s
      left join "users" u on u."id" = s."assignedToUserId"
      group by 1, 2, 3
      union all
      -- Pipeline value: only leads still in play, grouped by their own currency.
      select 'pipelineValue', coalesce(s."currency", 'UNKNOWN'), null,
             count(*)::int,
             0, 0,
             coalesce(s."currency", 'UNKNOWN'),
             coalesce(sum(s."expectedValueMinor"), 0)::bigint
      from scoped s
      where s."expectedValueMinor" is not null
        and s."status" not in ('LOST', 'CLOSED', 'ENROLLED')
      group by 1, 2, 3, 7
      order by 1, 4 desc
      limit ${REPORT_ROW_CAP + 1}
    `,
    client.$queryRaw<Array<{ period: Date; leads: number; converted: number }>>`
      select
        (date_trunc(
           ${unit}::text,
           (l."createdAt" at time zone ${scope.timezone}::text)
             + ${scope.weekShiftDays}::int * interval '1 day'
         ) - ${scope.weekShiftDays}::int * interval '1 day')::date         as "period",
        count(*)::int                                                      as "leads",
        count(*) filter (where l."convertedAt" is not null)::int            as "converted"
      from "leads" l
      where l."organizationId" = ${scope.organizationId}
        and l."deletedAt" is null
        and l."duplicateOfLeadId" is null
        and l."createdAt" >= ${scope.fromInstant}
        and l."createdAt" < ${scope.toExclusive}
        and (${lead.branchIds}::text[] is null
             or l."branchId" is null
             or l."branchId" = any(${lead.branchIds}::text[]))
        and (${lead.programIds}::text[] is null
             or l."interestedProgramId" = any(${lead.programIds}::text[]))
        and (${lead.ownUserId}::text is null
             or l."assignedToUserId" = ${lead.ownUserId}
             or l."createdById" = ${lead.ownUserId})
      group by 1
      order by 1
    `,
  ]);

  const dimensionTotals = new Map<string, number>();
  for (const row of breakdown) {
    dimensionTotals.set(row.dimension, (dimensionTotals.get(row.dimension) ?? 0) + row.leads);
  }

  const capped = capRows(
    breakdown.map<LeadBreakdownRow>((row) => ({
      dimension: row.dimension,
      key: row.key,
      label: row.label,
      leads: row.leads,
      converted: row.converted,
      lost: row.lost,
      conversionPpm: sharePpm(row.converted, row.leads),
      currency: row.currency,
      expectedValueMinor: row.expectedValue === null ? null : BigInt(row.expectedValue).toString(),
      sharePpm: sharePpm(row.leads, dimensionTotals.get(row.dimension) ?? 0),
    })),
  );

  // Totalled from the status axis: every lead has exactly one status, so it sums
  // to the true count while the agent axis would too and the source axis would
  // -- but only one of them can be the definition, and status is the one that is
  // never null.
  const statusRows = capped.rows.filter((row) => row.dimension === 'status');
  const leads = statusRows.reduce((sum, row) => sum + row.leads, 0);
  const converted = statusRows.reduce((sum, row) => sum + row.converted, 0);
  const lost = statusRows.reduce((sum, row) => sum + row.lost, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      leads,
      converted,
      lost,
      open: leads - converted - lost,
      conversionPpm: sharePpm(converted, leads),
    },
    series: [
      countSeries(
        'reports.series.leads',
        scope,
        new Map(trend.map((row) => [toDateOnly(row.period), row.leads])),
      ),
      countSeries(
        'reports.series.converted',
        scope,
        new Map(trend.map((row) => [toDateOnly(row.period), row.converted])),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Conversion funnel
// ---------------------------------------------------------------------------

/**
 * Stage-by-stage conversion, with the drop-off between stages.
 *
 * `ofPreviousPpm` is the number that identifies a problem: a funnel where 90% of
 * leads reach CONTACTED and 20% reach QUALIFIED says the qualification
 * conversation is where the pipeline leaks, and no absolute count says that.
 *
 * Days-to-convert is reported as a median AND a mean: one enquiry that converted
 * after eleven months drags the mean and leaves the median describing the
 * typical deal.
 */
export async function crmFunnelReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<FunnelStageRow, FunnelTotals>> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const lead = await leadScope(ctx, scope, client);

  const [stageRows, timing] = await Promise.all([
    client.$queryRaw<Array<{ stage: string; reached: number }>>`
      with scoped as (
        select l."id", l."status"
        from "leads" l
        where l."organizationId" = ${scope.organizationId}
          and l."deletedAt" is null
          and l."duplicateOfLeadId" is null
          and l."createdAt" >= ${scope.fromInstant}
          and l."createdAt" < ${scope.toExclusive}
          and (${lead.branchIds}::text[] is null
               or l."branchId" is null
               or l."branchId" = any(${lead.branchIds}::text[]))
          and (${lead.programIds}::text[] is null
               or l."interestedProgramId" = any(${lead.programIds}::text[]))
          and (${lead.ownUserId}::text is null
               or l."assignedToUserId" = ${lead.ownUserId}
               or l."createdById" = ${lead.ownUserId})
      ),
      -- A lead "reached" a stage if it is there now or the history says it was.
      -- The history rows are what make the middle of the funnel visible at all.
      reached as (
        select s."id", s."status"::text as stage from scoped s
        union
        select h."leadId", h."toStatus"::text
        from "lead_status_history" h
        join scoped s on s."id" = h."leadId"
      )
      select stage, count(distinct "id")::int as "reached"
      from reached
      group by stage
    `,
    client.$queryRaw<
      Array<{ medianDays: number | null; averageDays: number | null; converted: number; lost: number }>
    >`
      select
        percentile_cont(0.5) within group (
          order by extract(epoch from (l."convertedAt" - l."createdAt")) / 86400
        ) filter (where l."convertedAt" is not null)                       as "medianDays",
        avg(extract(epoch from (l."convertedAt" - l."createdAt")) / 86400)
          filter (where l."convertedAt" is not null)                       as "averageDays",
        count(*) filter (where l."convertedAt" is not null)::int            as "converted",
        count(*) filter (where l."status" = 'LOST')::int                    as "lost"
      from "leads" l
      where l."organizationId" = ${scope.organizationId}
        and l."deletedAt" is null
        and l."duplicateOfLeadId" is null
        and l."createdAt" >= ${scope.fromInstant}
        and l."createdAt" < ${scope.toExclusive}
        and (${lead.branchIds}::text[] is null
             or l."branchId" is null
             or l."branchId" = any(${lead.branchIds}::text[]))
        and (${lead.programIds}::text[] is null
             or l."interestedProgramId" = any(${lead.programIds}::text[]))
        and (${lead.ownUserId}::text is null
             or l."assignedToUserId" = ${lead.ownUserId}
             or l."createdById" = ${lead.ownUserId})
    `,
  ]);

  const reachedByStage = new Map(stageRows.map((row) => [row.stage, row.reached]));
  // Every lead entered at NEW, so the first pipeline stage is the denominator.
  const entered = reachedByStage.get(LEAD_PIPELINE[0] ?? 'NEW') ?? 0;

  const rows: FunnelStageRow[] = [];
  let previous: number | null = null;
  for (const [index, stage] of LEAD_PIPELINE.entries()) {
    const stageReached = reachedByStage.get(stage) ?? 0;
    rows.push({
      stage,
      sequence: index,
      reached: stageReached,
      ofEnteredPpm: sharePpm(stageReached, entered),
      ofPreviousPpm: previous === null ? null : sharePpm(stageReached, previous),
      droppedFromPrevious: previous === null ? 0 : Math.max(0, previous - stageReached),
    });
    previous = stageReached;
  }

  const summary = timing[0];

  return buildResult({
    scope,
    rows,
    totals: {
      entered,
      converted: summary?.converted ?? 0,
      lost: summary?.lost ?? 0,
      conversionPpm: sharePpm(summary?.converted ?? 0, entered),
      medianDaysToConvert: roundOrNull(summary?.medianDays ?? null),
      averageDaysToConvert: roundOrNull(summary?.averageDays ?? null),
    },
  });
}

/** One decimal place: "11.4 days" is useful, "11.428571 days" is noise. */
function roundOrNull(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Lost reasons
// ---------------------------------------------------------------------------

/**
 * Why leads were lost.
 *
 * `Lead.lostReason` is free text, so the rows are whatever sales actually typed.
 * Reporting it verbatim rather than mapping it to a tidy enum is the honest
 * choice: an invented taxonomy would hide the reason that matters. Leads lost
 * with no reason recorded are their own row, because "we do not know" is itself a
 * finding about how the pipeline is worked.
 */
export async function crmLostReasonsReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<LostReasonRow, LostReasonTotals>> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const lead = await leadScope(ctx, scope, client);

  const rows = await client.$queryRaw<
    Array<{ reason: string; leads: number; averageDays: number | null }>
  >`
    select
      coalesce(nullif(btrim(l."lostReason"), ''), 'UNRECORDED')            as "reason",
      count(*)::int                                                        as "leads",
      avg(extract(epoch from (l."lostAt" - l."createdAt")) / 86400)         as "averageDays"
    from "leads" l
    where l."organizationId" = ${scope.organizationId}
      and l."deletedAt" is null
      and l."duplicateOfLeadId" is null
      and l."status" = 'LOST'
      and l."lostAt" >= ${scope.fromInstant}
      and l."lostAt" < ${scope.toExclusive}
      and (${lead.branchIds}::text[] is null
           or l."branchId" is null
           or l."branchId" = any(${lead.branchIds}::text[]))
      and (${lead.programIds}::text[] is null
           or l."interestedProgramId" = any(${lead.programIds}::text[]))
      and (${lead.ownUserId}::text is null
           or l."assignedToUserId" = ${lead.ownUserId}
           or l."createdById" = ${lead.ownUserId})
    group by 1
    order by 2 desc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const lost = rows.reduce((sum, row) => sum + row.leads, 0);
  const capped = capRows(
    rows.map<LostReasonRow>((row) => ({
      reason: row.reason,
      leads: row.leads,
      sharePpm: sharePpm(row.leads, lost),
      averageDaysBeforeLost: roundOrNull(row.averageDays),
    })),
  );

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      lost,
      withReason: rows
        .filter((row) => row.reason !== 'UNRECORDED')
        .reduce((sum, row) => sum + row.leads, 0),
    },
  });
}

// ---------------------------------------------------------------------------
// Follow-up compliance
// ---------------------------------------------------------------------------

/**
 * Whether follow-up tasks are actually being done, per assignee.
 *
 * Tasks are selected by their DUE date rather than their creation date: "was the
 * work due this month done" is the question a sales manager asks, and a task
 * created in March for a July call belongs in July's compliance.
 *
 * Follow-ups are used by student services as well as sales (retention calls, debt
 * chasing), so `followUps.viewAll` -- not `leads.viewAll` -- is what lifts the
 * narrowing here, matching `followUpReadFilter`.
 */
export async function crmFollowUpComplianceReport(
  ctx: AccessContext,
  filters: ReportFilters = {},
  db?: Db,
): Promise<ReportResult<FollowUpComplianceRow, FollowUpComplianceTotals>> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const scope = await resolveReportScope(ctx, filters, client);
  const ownUserId = isSelfScoped(ctx) && !can(ctx, 'followUps.viewAll') ? ctx.userId : null;

  const rows = await client.$queryRaw<
    Array<{
      userId: string;
      userName: string;
      tasks: number;
      completed: number;
      completedOnTime: number;
      overdueOpen: number;
      cancelled: number;
      medianDelayHours: number | null;
    }>
  >`
    with scoped as (
      select
        f."assignedToUserId", f."status", f."dueAt", f."completedAt"
      from "follow_up_tasks" f
      where f."organizationId" = ${scope.organizationId}
        and f."dueAt" >= ${scope.fromInstant}
        and f."dueAt" < ${scope.toExclusive}
        and (${scope.branchIds}::text[] is null
             or f."branchId" is null
             or f."branchId" = any(${scope.branchIds}::text[]))
        and (${ownUserId}::text is null or f."assignedToUserId" = ${ownUserId})
    ),
    tally as (
      select
        "assignedToUserId",
        count(*)::int                                                          as tasks,
        count(*) filter (where "status" = 'COMPLETED')::int                     as completed,
        count(*) filter (
          where "status" = 'COMPLETED' and "completedAt" is not null and "completedAt" <= "dueAt"
        )::int                                                                 as completed_on_time,
        count(*) filter (where "status" = 'OPEN' and "dueAt" < now())::int       as overdue_open,
        count(*) filter (where "status" = 'CANCELLED')::int                      as cancelled,
        percentile_cont(0.5) within group (
          order by extract(epoch from ("completedAt" - "dueAt")) / 3600
        ) filter (where "status" = 'COMPLETED' and "completedAt" is not null)    as median_delay_hours
      from scoped
      group by "assignedToUserId"
    )
    select
      t."assignedToUserId"                   as "userId",
      (u."firstName" || ' ' || u."lastName")  as "userName",
      t.tasks, t.completed,
      t.completed_on_time                    as "completedOnTime",
      t.overdue_open                         as "overdueOpen",
      t.cancelled,
      -- Cast to numeric first: two-argument round() is numeric-only, and
      -- percentile_cont returns double precision.
      round(t.median_delay_hours::numeric, 1)::float8  as "medianDelayHours"
    from tally t
    join "users" u on u."id" = t."assignedToUserId"
    order by t.overdue_open desc, t.tasks desc, u."lastName" asc
    limit ${REPORT_ROW_CAP + 1}
  `;

  const capped = capRows(
    rows.map<FollowUpComplianceRow>((row) => ({
      userId: row.userId,
      userName: row.userName,
      tasks: row.tasks,
      completed: row.completed,
      completedOnTime: row.completedOnTime,
      overdueOpen: row.overdueOpen,
      cancelled: row.cancelled,
      // Cancelled tasks leave the denominator: a retention call cancelled because
      // the student re-enrolled is not a missed follow-up.
      completionRatePpm: sharePpm(row.completed, row.tasks - row.cancelled),
      onTimeRatePpm: sharePpm(row.completedOnTime, row.completed),
      medianDelayHours: row.medianDelayHours,
    })),
  );

  const tasks = capped.rows.reduce((sum, row) => sum + row.tasks, 0);
  const cancelled = capped.rows.reduce((sum, row) => sum + row.cancelled, 0);
  const completed = capped.rows.reduce((sum, row) => sum + row.completed, 0);
  const onTime = capped.rows.reduce((sum, row) => sum + row.completedOnTime, 0);

  return buildResult({
    scope,
    rows: capped.rows,
    truncated: capped.truncated,
    totals: {
      tasks,
      completed,
      completedOnTime: onTime,
      overdueOpen: capped.rows.reduce((sum, row) => sum + row.overdueOpen, 0),
      completionRatePpm: sharePpm(completed, tasks - cancelled),
      onTimeRatePpm: sharePpm(onTime, completed),
    },
  });
}
