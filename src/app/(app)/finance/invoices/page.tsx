import { AlertTriangle } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ClearFilters,
  ListFilter,
  ListPagination,
  ListSearch,
  ListToolbar,
} from '@/components/data/list-controls';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import type { InvoiceStatus } from '@/generated/prisma/client';
import { date, money as formatMoney } from '@/lib/i18n';
import {
  boolOf,
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
import { listInvoices } from '@/server/services/finance/invoices';

const STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'VOID',
  'REFUNDED',
  'WRITTEN_OFF',
] as const satisfies readonly InvoiceStatus[];

const FILTER_KEYS = ['status', 'overdue'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('invoices.title') };
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const result = await listInvoices(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    status: status ? [status] : undefined,
    overdueOnly: boolOf(params, 'overdue') === true ? true : undefined,
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  return (
    <>
      <PageHeader title={t.t('invoices.title')} description={t.t('invoices.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('invoices.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('invoices.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.InvoiceStatus.${value}`) }))}
        />
        <ListFilter
          name="overdue"
          label={t.t('invoices.overdueOnly')}
          options={[{ value: 'true', label: t.t('invoices.overdueOnly') }]}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.rows.length === 0 ? (
        filtered ? (
          <NoResultsState
            title={t.t('common.noMatches.title')}
            description={t.t('common.noMatches.description')}
          />
        ) : (
          <EmptyState
            title={t.t('invoices.empty.title')}
            description={t.t('invoices.empty.description')}
          />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('invoices.title')}>
            <THead>
              <TR>
                <TH>{t.t('invoices.fields.invoiceNumber')}</TH>
                <TH>{t.t('invoices.fields.student')}</TH>
                <TH>{t.t('invoices.fields.issueDate')}</TH>
                <TH>{t.t('invoices.fields.dueDate')}</TH>
                <TH numeric>{t.t('invoices.fields.total')}</TH>
                <TH numeric>{t.t('invoices.fields.paidTotal')}</TH>
                <TH numeric>{t.t('invoices.fields.balance')}</TH>
                <TH>{t.t('invoices.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={<span className="font-mono">{row.invoiceNumber}</span>}
                      href={`/finance/invoices/${row.id}`}
                    />
                  </TD>
                  <TD>
                    <Link
                      href={`/students/${row.studentId}`}
                      className="text-[var(--color-accent-text)] hover:underline"
                    >
                      {row.studentName}
                    </Link>
                  </TD>
                  <TD muted nowrap>
                    {date(row.issueDate, t)}
                  </TD>
                  <TD nowrap muted={!row.isOverdue}>
                    {/* Overdue is marked on the date itself: it is the fact that
                        made it overdue, and a status column alone leaves the
                        reader comparing dates in their head. */}
                    <span
                      className={
                        row.isOverdue
                          ? 'inline-flex items-center gap-1 font-medium text-[var(--color-danger-text)]'
                          : undefined
                      }
                    >
                      {row.isOverdue && <AlertTriangle className="size-3" aria-hidden="true" />}
                      {date(row.dueDate, t)}
                    </span>
                  </TD>
                  <TD numeric nowrap>
                    {formatMoney(makeMoney(row.totalMinor, row.currency), t.locale)}
                  </TD>
                  <TD numeric nowrap muted>
                    {formatMoney(makeMoney(row.paidTotalMinor, row.currency), t.locale)}
                  </TD>
                  <TD numeric nowrap>
                    <span className={row.balanceMinor > 0n ? 'font-medium' : undefined}>
                      {formatMoney(makeMoney(row.balanceMinor, row.currency), t.locale)}
                    </span>
                  </TD>
                  <TD nowrap>
                    <StatusBadge
                      status={row.status}
                      label={t.t(`enums.InvoiceStatus.${row.status}`)}
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
