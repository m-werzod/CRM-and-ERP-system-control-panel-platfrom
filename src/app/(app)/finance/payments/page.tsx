import type { Metadata } from 'next';
import Link from 'next/link';
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
import type { PaymentMethod, PaymentStatus } from '@/generated/prisma/client';
import { dateTime, money as formatMoney } from '@/lib/i18n';
import {
  enumOne,
  hasActiveFilters,
  one,
  pageOf,
  pageSizeOf,
  totalPagesOf,
  type RawSearchParams,
} from '@/lib/list-params';
import { SUPPORTED_CURRENCIES, money as makeMoney } from '@/lib/money';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { can } from '@/server/rbac/access';
import { currencyFor } from '@/server/services/finance/currency';
import { listPayments } from '@/server/services/finance/payments';
import { RecordPaymentPanel } from './record-payment';

const METHODS = [
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'ONLINE',
  'CREDIT_NOTE',
  'OTHER',
] as const satisfies readonly PaymentMethod[];

const STATUSES = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'REVERSED',
] as const satisfies readonly PaymentStatus[];

const FILTER_KEYS = ['method', 'status'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('payments.title') };
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const method = enumOne(params, 'method', METHODS);
  const status = enumOne(params, 'status', STATUSES);

  const result = await listPayments(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    method: method ? [method] : undefined,
    status: status ? [status] : undefined,
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  const mayRecord = can(ctx, 'payments.create');
  const defaultCurrency = mayRecord
    ? await currencyFor({ organizationId: ctx.organizationId, branchId: ctx.primaryBranchId })
    : 'UZS';

  return (
    <>
      <PageHeader
        title={t.t('payments.title')}
        description={t.t('payments.subtitle')}
        actions={
          mayRecord ? (
            <RecordPaymentPanel
              currencies={SUPPORTED_CURRENCIES}
              defaultCurrency={defaultCurrency}
            />
          ) : undefined
        }
      />

      <ListToolbar>
        <ListSearch placeholder={t.t('common.searchPlaceholder')} />
        <ListFilter
          name="method"
          label={t.t('payments.fields.method')}
          options={METHODS.map((value) => ({ value, label: t.t(`enums.PaymentMethod.${value}`) }))}
        />
        <ListFilter
          name="status"
          label={t.t('payments.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.PaymentStatus.${value}`) }))}
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
            title={t.t('payments.empty.title')}
            description={t.t('payments.empty.description')}
          />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('payments.title')}>
            <THead>
              <TR>
                <TH>{t.t('payments.fields.receiptNumber')}</TH>
                <TH>{t.t('payments.fields.student')}</TH>
                <TH>{t.t('payments.fields.invoice')}</TH>
                <TH>{t.t('payments.fields.method')}</TH>
                <TH numeric>{t.t('payments.fields.amount')}</TH>
                <TH>{t.t('payments.fields.paidAt')}</TH>
                <TH>{t.t('payments.fields.receivedBy')}</TH>
                <TH>{t.t('payments.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={<span className="font-mono">{row.paymentNumber}</span>}
                      subtitle={row.reference ?? undefined}
                      href={`/finance/payments/${row.id}`}
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
                    {row.invoiceId && row.invoiceNumber ? (
                      <Link
                        href={`/finance/invoices/${row.invoiceId}`}
                        className="font-mono text-[var(--color-accent-text)] hover:underline"
                      >
                        {row.invoiceNumber}
                      </Link>
                    ) : (
                      // No invoice pointer means the money became student credit
                      // rather than settling a specific bill.
                      '—'
                    )}
                  </TD>
                  <TD muted nowrap>
                    {t.t(`enums.PaymentMethod.${row.method}`)}
                  </TD>
                  <TD numeric nowrap>
                    <span className={row.reversedAt ? 'line-through opacity-60' : 'font-medium'}>
                      {formatMoney(makeMoney(row.amountMinor, row.currency), t.locale)}
                    </span>
                  </TD>
                  <TD muted nowrap>
                    {dateTime(row.receivedAt, t)}
                  </TD>
                  <TD muted nowrap>
                    {row.receivedByName ?? '—'}
                  </TD>
                  <TD nowrap>
                    <span className="flex items-center gap-1">
                      <StatusBadge
                        status={row.status}
                        label={t.t(`enums.PaymentStatus.${row.status}`)}
                      />
                      {/* A reversal is kept, never deleted, so it has to be
                          visible as its own fact rather than an absence. */}
                      {row.reversedAt && (
                        <Badge tone="danger" size="sm">
                          {t.t('payments.reversed')}
                        </Badge>
                      )}
                    </span>
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
