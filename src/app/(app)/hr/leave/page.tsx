import type { Metadata } from 'next';
import { ClearFilters, ListFilter, ListPagination, ListToolbar } from '@/components/data/list-controls';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import type { LeaveRequestStatus } from '@/generated/prisma/client';
import { date } from '@/lib/i18n';
import {
  enumOne,
  hasActiveFilters,
  pageOf,
  pageSizeOf,
  totalPagesOf,
  type RawSearchParams,
} from '@/lib/list-params';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { listLeaveRequests } from '@/server/services/hr/leave';

const STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const satisfies readonly LeaveRequestStatus[];

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('leave.title') };
}

export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const result = await listLeaveRequests(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    status: enumOne(params, 'status', STATUSES),
  });

  const filtered = hasActiveFilters(params, ['status']);

  return (
    <>
      <PageHeader title={t.t('leave.title')} description={t.t('leave.subtitle')} />

      <ListToolbar>
        <ListFilter
          name="status"
          label={t.t('leave.fields.status')}
          options={STATUSES.map((value) => ({
            value,
            label: t.t(`enums.LeaveRequestStatus.${value}`),
          }))}
        />
        {filtered && <ClearFilters keys={['status']} />}
      </ListToolbar>

      {result.items.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('common.noMatches.title')} description={t.t('common.noMatches.description')} />
        ) : (
          <EmptyState title={t.t('leave.empty.title')} description={t.t('leave.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('leave.title')}>
            <THead>
              <TR>
                <TH>{t.t('leave.fields.employee')}</TH>
                <TH>{t.t('leave.fields.leaveType')}</TH>
                <TH>{t.t('leave.fields.startDate')}</TH>
                <TH>{t.t('leave.fields.endDate')}</TH>
                <TH numeric>{t.t('leave.fields.days')}</TH>
                <TH>{t.t('leave.fields.reason')}</TH>
                <TH>{t.t('leave.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <PrimaryCell title={row.employeeName} href={`/hr/employees/${row.employeeId}`} />
                  </TD>
                  <TD muted nowrap>
                    {row.leaveTypeName}
                  </TD>
                  <TD muted nowrap>
                    {date(row.startDate, t)}
                  </TD>
                  <TD muted nowrap>
                    {date(row.endDate, t)}
                  </TD>
                  <TD numeric>{row.days}</TD>
                  <TD muted>{row.reason ?? '—'}</TD>
                  <TD nowrap>
                    <StatusBadge
                      status={row.status}
                      label={t.t(`enums.LeaveRequestStatus.${row.status}`)}
                    />
                  </TD>
                </TR>
              ))}
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
