/**
 * CRM reporting: the board, the funnel, and who is actually selling.
 *
 * Every figure here is computed by the database. A report that loads leads and folds
 * them in JavaScript works on the demo data and falls over at twenty thousand rows,
 * and — worse — quietly disagrees with the list screens because the folding drifts
 * from the WHERE clause. So: `groupBy` where Prisma can express the aggregate, raw
 * SQL where it cannot (distinct stage entries, average days to convert).
 *
 * Scope is applied in both worlds from `ctx` alone, never from the request: the
 * Prisma paths reuse `leadReadFilter`, and the raw paths build the same three
 * predicates (organisation, branch list, own-leads-only) as SQL fragments.
 *
 * Expected value is reported PER CURRENCY. Summing minor units across currencies
 * would produce a number that means nothing, and a multi-branch institution
 * trading in two currencies is the case this system is built for.
 */

import type { LeadSource, LeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import {
  assertBranchAccess,
  can,
  isSelfScoped,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dayRangeToInstants, todayIn, type DateOnly } from '@/lib/dates';
import { currencyFor } from '@/server/services/finance/currency';
import { LEAD_EXIT_STATUSES, LEAD_PIPELINE } from '@/server/services/crm/scoring';
import { leadReadFilter } from '@/server/services/crm/shared';

/** Integer parts-per-million share, the project's percentage representation. */
function sharePpm(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part * 1_000_000) / whole);
}

export interface CrmReportRange {
  /** Calendar days in the organisation timezone. Defaults to the current month. */
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly branchId?: string | null;
  readonly assignedToUserId?: string | null;
  readonly source?: LeadSource | null;
}

interface ResolvedRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly fromInstant: Date;
  readonly toExclusive: Date;
}

async function resolveRange(
  ctx: AccessContext,
  db: Db,
  input: CrmReportRange,
): Promise<ResolvedRange> {
  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const to = input.to ?? todayIn(timezone);
  // Month-to-date by default, computed in the institution's zone rather than the
  // server's.
  const from = input.from ?? `${to.slice(0, 8)}01`;
  const range = dayRangeToInstants(from, to, timezone);
  return { from, to, fromInstant: range.from, toExclusive: range.toExclusive };
}

/**
 * The scope predicates a raw aggregate needs, derived from `ctx` only.
 *
 * `branchIds` is null for an organisation-scoped caller, which the SQL reads as "no
 * branch predicate". `ownUserId` is set only when the institution has asked agents to
 * be blinkered AND this caller lacks `leads.viewAll`.
 */
interface RawLeadScope {
  readonly branchIds: string[] | null;
  readonly requestedBranch: string | null;
  readonly ownUserId: string | null;
  readonly assignedToUserId: string | null;
  readonly source: string | null;
}

async function rawLeadScope(
  ctx: AccessContext,
  db: Db,
  input: CrmReportRange,
): Promise<RawLeadScope> {
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'lead');

  const { agentsSeeOnlyOwnLeads } = await getSettings(
    ['agentsSeeOnlyOwnLeads'],
    { organizationId: ctx.organizationId },
    db,
  );
  const blinkered =
    agentsSeeOnlyOwnLeads && isSelfScoped(ctx) && !can(ctx, 'leads.viewAll');

  return {
    branchIds: ctx.scope === 'ORGANIZATION' || ctx.isSystem ? null : [...ctx.branchIds],
    requestedBranch: input.branchId ?? null,
    ownUserId: blinkered ? ctx.userId : null,
    // An agent who may only see their own leads cannot filter to someone else's.
    assignedToUserId: blinkered ? null : (input.assignedToUserId ?? null),
    source: input.source ?? null,
  };
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export interface PipelineStage {
  readonly status: LeadStatus;
  readonly count: number;
  readonly expectedValue: ReadonlyArray<{ readonly currency: string; readonly totalMinor: bigint }>;
}

export interface PipelineSummary {
  readonly stages: readonly PipelineStage[];
  readonly totalLeads: number;
  /** The currency figures without one of their own are denominated in. */
  readonly defaultCurrency: string;
}

/**
 * Count and expected value per status, for the pipeline board.
 *
 * Every status is returned, including the ones with no leads, so the board renders a
 * stable set of columns instead of growing one when the first lead lands in it.
 */
export async function getPipeline(
  ctx: AccessContext,
  input: CrmReportRange = {},
  db?: Db,
): Promise<PipelineSummary> {
  requirePermission(ctx, 'leads.view');

  const client = db ?? prisma;
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'lead');

  const scoped = await leadReadFilter(ctx, client);
  const filters: Prisma.LeadWhereInput[] = [scoped, { duplicateOfLeadId: null }];
  if (input.branchId) filters.push({ branchId: input.branchId });
  if (input.assignedToUserId) filters.push({ assignedToUserId: input.assignedToUserId });
  if (input.source) filters.push({ source: input.source });
  if (input.from || input.to) {
    const range = await resolveRange(ctx, client, input);
    filters.push({ createdAt: { gte: range.fromInstant, lt: range.toExclusive } });
  }

  const [grouped, defaultCurrency] = await Promise.all([
    client.lead.groupBy({
      by: ['status', 'currency'],
      where: { AND: filters },
      _count: { _all: true },
      _sum: { expectedValueMinor: true },
    }),
    currencyFor({ organizationId: ctx.organizationId, branchId: input.branchId ?? null }, client),
  ]);

  const byStatus = new Map<LeadStatus, { count: number; values: Map<string, bigint> }>();
  for (const status of [...LEAD_PIPELINE, ...LEAD_EXIT_STATUSES]) {
    byStatus.set(status, { count: 0, values: new Map<string, bigint>() });
  }

  for (const row of grouped) {
    const bucket = byStatus.get(row.status);
    if (!bucket) continue;
    bucket.count += row._count._all;

    const total = row._sum.expectedValueMinor;
    if (total == null || total === 0n) continue;
    // A lead with an expected value but no currency predates the currency column or
    // was imported; it is reported in the organisation's currency rather than dropped.
    const currency = row.currency ?? defaultCurrency;
    bucket.values.set(currency, (bucket.values.get(currency) ?? 0n) + total);
  }

  const stages: PipelineStage[] = [...byStatus.entries()].map(([status, bucket]) => ({
    status,
    count: bucket.count,
    expectedValue: [...bucket.values.entries()]
      .map(([currency, totalMinor]) => ({ currency, totalMinor }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  }));

  return {
    stages,
    totalLeads: stages.reduce((sum, stage) => sum + stage.count, 0),
    defaultCurrency,
  };
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

export interface FunnelStage {
  readonly status: LeadStatus;
  /** Leads in the cohort that EVER reached this stage. */
  readonly leads: number;
  /** Share of the whole cohort, in ppm. */
  readonly reachedPpm: number;
  /** Share of the previous stage that advanced to this one, in ppm. */
  readonly fromPreviousPpm: number;
}

export interface ConversionFunnel {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly cohortSize: number;
  readonly stages: readonly FunnelStage[];
  readonly lost: number;
  readonly closed: number;
  /** Cohort leads that reached ENROLLED, in ppm. */
  readonly conversionPpm: number;
}

const COHORT_MARKER = '_COHORT_';

/**
 * The funnel for leads CREATED in the range.
 *
 * Counted from `LeadStatusHistory`, not from the current status: a lead now sitting
 * at ENROLLED also passed through CONTACTED and QUALIFIED, and a funnel built from
 * current status would show an empty middle. `count(distinct "leadId")` is what makes
 * a re-engaged lead count once per stage, which is why this is raw SQL — Prisma's
 * `groupBy` cannot express a distinct count.
 */
export async function getConversionFunnel(
  ctx: AccessContext,
  input: CrmReportRange = {},
  db?: Db,
): Promise<ConversionFunnel> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const range = await resolveRange(ctx, client, input);
  const scope = await rawLeadScope(ctx, client, input);

  const rows = await client.$queryRaw<Array<{ stage: string; leads: bigint }>>`
    with cohort as (
      select l."id"
      from "leads" l
      where l."organizationId" = ${ctx.organizationId}
        and l."deletedAt" is null
        and l."duplicateOfLeadId" is null
        and l."createdAt" >= ${range.fromInstant}
        and l."createdAt" < ${range.toExclusive}
        and (${scope.branchIds}::text[] is null
             or l."branchId" is null
             or l."branchId" = any(${scope.branchIds}::text[]))
        and (${scope.requestedBranch}::text is null or l."branchId" = ${scope.requestedBranch})
        and (${scope.ownUserId}::text is null
             or l."assignedToUserId" = ${scope.ownUserId}
             or l."createdById" = ${scope.ownUserId})
        and (${scope.assignedToUserId}::text is null
             or l."assignedToUserId" = ${scope.assignedToUserId})
        and (${scope.source}::text is null or l."source"::text = ${scope.source})
    )
    select h."toStatus"::text as "stage", count(distinct h."leadId")::bigint as "leads"
    from "lead_status_history" h
    join cohort c on c."id" = h."leadId"
    group by h."toStatus"
    union all
    select ${COHORT_MARKER}::text as "stage", count(*)::bigint as "leads" from cohort
  `;

  const reached = new Map<string, number>();
  for (const row of rows) reached.set(row.stage, Number(row.leads));

  const cohortSize = reached.get(COHORT_MARKER) ?? 0;

  const stages: FunnelStage[] = [];
  let previous = cohortSize;
  for (const status of LEAD_PIPELINE) {
    // Every lead enters at NEW, so the cohort size is authoritative for the first
    // stage even for rows created before the initial history row was written.
    const leads =
      status === 'NEW' ? Math.max(cohortSize, reached.get(status) ?? 0) : (reached.get(status) ?? 0);
    stages.push({
      status,
      leads,
      reachedPpm: sharePpm(leads, cohortSize),
      fromPreviousPpm: sharePpm(leads, previous),
    });
    previous = leads;
  }

  return {
    from: range.from,
    to: range.to,
    cohortSize,
    stages,
    lost: reached.get('LOST') ?? 0,
    closed: reached.get('CLOSED') ?? 0,
    conversionPpm: sharePpm(reached.get('ENROLLED') ?? 0, cohortSize),
  };
}

// ---------------------------------------------------------------------------
// Source performance
// ---------------------------------------------------------------------------

export interface SourcePerformanceRow {
  readonly source: LeadSource;
  readonly leads: number;
  readonly converted: number;
  readonly lost: number;
  readonly conversionPpm: number;
  readonly expectedValue: ReadonlyArray<{ readonly currency: string; readonly totalMinor: bigint }>;
}

export interface SourcePerformance {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly rows: readonly SourcePerformanceRow[];
  readonly totalLeads: number;
  readonly totalConverted: number;
  readonly conversionPpm: number;
}

/** Which channels actually produce students, best conversion rate first. */
export async function getSourcePerformance(
  ctx: AccessContext,
  input: CrmReportRange = {},
  db?: Db,
): Promise<SourcePerformance> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'lead');

  const range = await resolveRange(ctx, client, input);
  const scoped = await leadReadFilter(ctx, client);

  const cohort: Prisma.LeadWhereInput = {
    AND: [
      scoped,
      { duplicateOfLeadId: null },
      { createdAt: { gte: range.fromInstant, lt: range.toExclusive } },
      ...(input.branchId ? [{ branchId: input.branchId }] : []),
      ...(input.assignedToUserId ? [{ assignedToUserId: input.assignedToUserId }] : []),
    ],
  };

  // Three aggregates, not one query per source: the merge happens in a Map.
  const [defaultCurrency, totals, converted, lost] = await Promise.all([
    currencyFor({ organizationId: ctx.organizationId, branchId: input.branchId ?? null }, client),
    client.lead.groupBy({
      by: ['source', 'currency'],
      where: cohort,
      _count: { _all: true },
      _sum: { expectedValueMinor: true },
    }),
    client.lead.groupBy({
      by: ['source'],
      where: { AND: [cohort, { convertedAt: { not: null } }] },
      _count: { _all: true },
    }),
    client.lead.groupBy({
      by: ['source'],
      where: { AND: [cohort, { status: 'LOST' }] },
      _count: { _all: true },
    }),
  ]);

  const convertedBySource = new Map(converted.map((row) => [row.source, row._count._all]));
  const lostBySource = new Map(lost.map((row) => [row.source, row._count._all]));

  const bySource = new Map<LeadSource, { leads: number; values: Map<string, bigint> }>();
  for (const row of totals) {
    const bucket = bySource.get(row.source) ?? { leads: 0, values: new Map<string, bigint>() };
    bucket.leads += row._count._all;
    const total = row._sum.expectedValueMinor;
    if (total != null && total !== 0n) {
      // Same rule as the board: a value with no currency of its own is reported in
      // the organisation's, never silently dropped from the total.
      const currency = row.currency ?? defaultCurrency;
      bucket.values.set(currency, (bucket.values.get(currency) ?? 0n) + total);
    }
    bySource.set(row.source, bucket);
  }

  const rows: SourcePerformanceRow[] = [...bySource.entries()]
    .map(([source, bucket]) => {
      const convertedCount = convertedBySource.get(source) ?? 0;
      return {
        source,
        leads: bucket.leads,
        converted: convertedCount,
        lost: lostBySource.get(source) ?? 0,
        conversionPpm: sharePpm(convertedCount, bucket.leads),
        expectedValue: [...bucket.values.entries()]
          .map(([currency, totalMinor]) => ({ currency, totalMinor }))
          .sort((a, b) => a.currency.localeCompare(b.currency)),
      };
    })
    .sort((a, b) => b.conversionPpm - a.conversionPpm || b.leads - a.leads);

  const totalLeads = rows.reduce((sum, row) => sum + row.leads, 0);
  const totalConverted = rows.reduce((sum, row) => sum + row.converted, 0);

  return {
    from: range.from,
    to: range.to,
    rows,
    totalLeads,
    totalConverted,
    conversionPpm: sharePpm(totalConverted, totalLeads),
  };
}

// ---------------------------------------------------------------------------
// Agent performance
// ---------------------------------------------------------------------------

export interface AgentPerformanceRow {
  readonly userId: string;
  readonly agentName: string;
  readonly leads: number;
  readonly converted: number;
  readonly lost: number;
  readonly openFollowUps: number;
  readonly conversionPpm: number;
  /** Mean days from lead creation to conversion. Null when nobody converted. */
  readonly averageDaysToConvert: number | null;
}

export interface AgentPerformance {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly rows: readonly AgentPerformanceRow[];
}

/**
 * Per-agent throughput over the range.
 *
 * Raw SQL because `avg(convertedAt - createdAt)` has no `groupBy` expression in
 * Prisma, and because doing it per agent in a loop would be one query per row of the
 * report. `filter (where ...)` gives every tally in a single pass over the leads.
 */
export async function getAgentPerformance(
  ctx: AccessContext,
  input: CrmReportRange = {},
  db?: Db,
): Promise<AgentPerformance> {
  requirePermission(ctx, 'reports.viewCrm');

  const client = db ?? prisma;
  const range = await resolveRange(ctx, client, input);
  const scope = await rawLeadScope(ctx, client, input);

  const rows = await client.$queryRaw<
    Array<{
      userId: string;
      agentName: string;
      leads: bigint;
      converted: bigint;
      lost: bigint;
      openFollowUps: bigint;
      averageDaysToConvert: number | null;
    }>
  >`
    select u."id"                                   as "userId",
           (u."firstName" || ' ' || u."lastName")   as "agentName",
           count(*)::bigint                         as "leads",
           count(*) filter (where l."convertedAt" is not null)::bigint as "converted",
           count(*) filter (where l."status" = 'LOST')::bigint         as "lost",
           coalesce(sum(t."open_tasks"), 0)::bigint as "openFollowUps",
           (avg(
              extract(epoch from (l."convertedAt" - l."createdAt")) / 86400.0
            ) filter (where l."convertedAt" is not null))::double precision
                                                    as "averageDaysToConvert"
    from "leads" l
    join "users" u on u."id" = l."assignedToUserId"
    left join lateral (
      select count(*) as "open_tasks"
      from "follow_up_tasks" f
      where f."leadId" = l."id" and f."status" = 'OPEN'
    ) t on true
    where l."organizationId" = ${ctx.organizationId}
      and l."deletedAt" is null
      and l."duplicateOfLeadId" is null
      and l."createdAt" >= ${range.fromInstant}
      and l."createdAt" < ${range.toExclusive}
      and (${scope.branchIds}::text[] is null
           or l."branchId" is null
           or l."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.requestedBranch}::text is null or l."branchId" = ${scope.requestedBranch})
      and (${scope.ownUserId}::text is null or l."assignedToUserId" = ${scope.ownUserId})
      and (${scope.assignedToUserId}::text is null
           or l."assignedToUserId" = ${scope.assignedToUserId})
      and (${scope.source}::text is null or l."source"::text = ${scope.source})
    group by u."id", u."firstName", u."lastName"
    order by "converted" desc, "leads" desc, "agentName" asc
  `;

  return {
    from: range.from,
    to: range.to,
    rows: rows.map((row) => {
      const leads = Number(row.leads);
      const converted = Number(row.converted);
      return {
        userId: row.userId,
        agentName: row.agentName,
        leads,
        converted,
        lost: Number(row.lost),
        openFollowUps: Number(row.openFollowUps),
        conversionPpm: sharePpm(converted, leads),
        averageDaysToConvert:
          row.averageDaysToConvert == null
            ? null
            : Math.round(Number(row.averageDaysToConvert) * 10) / 10,
      };
    }),
  };
}
