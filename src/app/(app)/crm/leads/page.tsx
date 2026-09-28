import type { Metadata } from 'next';
import {
  ClearFilters,
  ListFilter,
  ListPagination,
  ListSearch,
  ListToolbar,
} from '@/components/data/list-controls';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import type { LeadPriority, LeadSource, LeadStatus } from '@/generated/prisma/client';
import { date, money as formatMoney } from '@/lib/i18n';
import {
  enumOne,
  hasActiveFilters,
  one,
  pageOf,
  pageSizeOf,
  totalPagesOf,
  type RawSearchParams,
} from '@/lib/list-params';
import { money as makeMoney } from '@/lib/money';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { can } from '@/server/rbac/access';
import { listBranches } from '@/server/services/admin/organization';
import { listLeads } from '@/server/services/crm/leads';
import { AddLeadPanel } from './lead-actions';

const STATUSES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL_BOOKED',
  'TRIAL_COMPLETED',
  'APPLICATION',
  'ENROLLED',
  'LOST',
  'CLOSED',
] as const satisfies readonly LeadStatus[];

const SOURCES = [
  'WALK_IN',
  'PHONE_CALL',
  'WEBSITE',
  'INSTAGRAM',
  'TELEGRAM',
  'FACEBOOK',
  'GOOGLE_ADS',
  'REFERRAL',
  'EVENT',
  'PARTNER',
  'OTHER',
] as const satisfies readonly LeadSource[];

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const satisfies readonly LeadPriority[];

const PRIORITY_TONE = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  URGENT: 'danger',
} as const;

const FILTER_KEYS = ['status', 'source', 'priority'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('leads.title') };
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const source = enumOne(params, 'source', SOURCES);
  const priority = enumOne(params, 'priority', PRIORITIES);

  const result = await listLeads(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    status: status ? [status] : undefined,
    source: source ? [source] : undefined,
    priority: priority ? [priority] : undefined,
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  const mayCreate = can(ctx, 'leads.create');
  const branchRows = mayCreate && can(ctx, 'settings.view') ? await listBranches(ctx) : [];
  const branches = branchRows.map((b) => ({ id: b.id, name: b.name }));

  return (
    <>
      <PageHeader
        title={t.t('leads.title')}
        description={t.t('leads.subtitle')}
        actions={mayCreate ? <AddLeadPanel branches={branches} /> : undefined}
      />

      <ListToolbar>
        <ListSearch placeholder={t.t('leads.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('leads.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.LeadStatus.${value}`) }))}
        />
        <ListFilter
          name="source"
          label={t.t('leads.fields.source')}
          options={SOURCES.map((value) => ({ value, label: t.t(`enums.LeadSource.${value}`) }))}
        />
        <ListFilter
          name="priority"
          label={t.t('leads.fields.priority')}
          options={PRIORITIES.map((value) => ({ value, label: t.t(`enums.LeadPriority.${value}`) }))}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.rows.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('leads.emptyFiltered.title')} description={t.t('leads.emptyFiltered.description')} />
        ) : (
          <EmptyState title={t.t('leads.empty.title')} description={t.t('leads.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('leads.title')}>
            <THead>
              <TR>
                <TH>{t.t('common.name')}</TH>
                <TH>{t.t('leads.fields.phone')}</TH>
                <TH>{t.t('leads.fields.source')}</TH>
                <TH>{t.t('leads.fields.priority')}</TH>
                <TH>{t.t('leads.fields.assignedTo')}</TH>
                <TH>{t.t('leads.fields.nextFollowUpAt')}</TH>
                <TH numeric>{t.t('leads.fields.budget')}</TH>
                <TH>{t.t('leads.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => {
                const name = [row.firstName, row.lastName].filter(Boolean).join(' ');
                return (
                  <TR key={row.id} interactive>
                    <TD>
                      <PrimaryCell
                        title={name}
                        subtitle={row.interestedProgramName ?? undefined}
                        href={`/crm/leads/${row.id}`}
                      />
                    </TD>
                    <TD muted nowrap>
                      {row.phone}
                    </TD>
                    <TD muted nowrap>
                      {t.t(`enums.LeadSource.${row.source}`)}
                    </TD>
                    <TD nowrap>
                      <Badge tone={PRIORITY_TONE[row.priority]}>
                        {t.t(`enums.LeadPriority.${row.priority}`)}
                      </Badge>
                    </TD>
                    <TD muted nowrap>
                      {row.assignedToName ?? t.t('leads.fields.unassigned')}
                    </TD>
                    <TD muted nowrap>
                      {row.nextFollowUpAt ? date(row.nextFollowUpAt, t) : '—'}
                    </TD>
                    <TD numeric nowrap>
                      {row.expectedValueMinor !== null && row.currency
                        ? formatMoney(makeMoney(row.expectedValueMinor, row.currency), t.locale)
                        : '—'}
                    </TD>
                    <TD nowrap>
                      <StatusBadge status={row.status} label={t.t(`enums.LeadStatus.${row.status}`)} />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </TableWrapper>

          <div className="mt-3">
            <ListPagination
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              totalPages={totalPagesOf(result.total, result.pageSize)}
            />
          </div>
        </>
      )}
    </>
  );
}
