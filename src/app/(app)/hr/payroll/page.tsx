import type { Metadata } from 'next';
import { ClearFilters, ListFilter, ListPagination, ListToolbar } from '@/components/data/list-controls';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import type { PayrollRunStatus } from '@/generated/prisma/client';
import { date, money as formatMoney } from '@/lib/i18n';
import {
  enumOne,
  hasActiveFilters,
  pageOf,
  pageSizeOf,
  totalPagesOf,
  type RawSearchParams,
} from '@/lib/list-params';
import { money as makeMoney } from '@/lib/money';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { listPayrollRuns } from '@/server/services/hr/payroll/runs';

const STATUSES = [
  'DRAFT',
  'CALCULATED',
  'APPROVED',
  'PAID',
  'CANCELLED',
] as const satisfies readonly PayrollRunStatus[];

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('payroll.title') };
}

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const result = await listPayrollRuns(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    status: enumOne(params, 'status', STATUSES),
  });

  const filtered = hasActiveFilters(params, ['status']);

  return (
    <>
      <PageHeader title={t.t('payroll.title')} description={t.t('payroll.subtitle')} />

      <ListToolbar>
        <ListFilter
          name="status"
          label={t.t('payroll.fields.status')}
          options={STATUSES.map((value) => ({
            value,
            label: t.t(`enums.PayrollRunStatus.${value}`),
          }))}
        />
        {filtered && <ClearFilters keys={['status']} />}
      </ListToolbar>

      {result.items.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('common.noMatches.title')} description={t.t('common.noMatches.description')} />
        ) : (
          <EmptyState title={t.t('payroll.empty.title')} description={t.t('payroll.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('payroll.title')}>
            <THead>
              <TR>
                <TH>{t.t('payroll.fields.period')}</TH>
                <TH numeric>{t.t('payroll.fields.employeeCount')}</TH>
                <TH numeric>{t.t('payroll.fields.grossTotal')}</TH>
                <TH numeric>{t.t('payroll.fields.deductionTotal')}</TH>
                <TH numeric>{t.t('payroll.fields.netTotal')}</TH>
                <TH>{t.t('payroll.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={`${date(row.periodStart, t)} — ${date(row.periodEnd, t)}`}
                      href={`/hr/payroll/${row.id}`}
                    />
                  </TD>
                  <TD numeric>{row.itemCount}</TD>
                  {/* Totals arrive as minor-unit strings; BigInt is the only safe parse. */}
                  <TD numeric nowrap>
                    {formatMoney(makeMoney(BigInt(row.totalGrossMinor), row.currency), t.locale)}
                  </TD>
                  <TD numeric nowrap muted>
                    {formatMoney(makeMoney(BigInt(row.totalDeductionMinor), row.currency), t.locale)}
                  </TD>
                  <TD numeric nowrap>
                    {formatMoney(makeMoney(BigInt(row.totalNetMinor), row.currency), t.locale)}
                  </TD>
                  <TD nowrap>
                    <StatusBadge
                      status={row.status}
                      label={t.t(`enums.PayrollRunStatus.${row.status}`)}
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
