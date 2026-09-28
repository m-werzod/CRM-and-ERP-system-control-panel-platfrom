import { Lock } from 'lucide-react';
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
import type { EmploymentStatus } from '@/generated/prisma/client';
import { money as formatMoney } from '@/lib/i18n';
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
import { listEmployees } from '@/server/services/hr/employees';

const STATUSES = [
  'ACTIVE',
  'PROBATION',
  'ON_LEAVE',
  'SUSPENDED',
  'TERMINATED',
  'RESIGNED',
] as const satisfies readonly EmploymentStatus[];

// No employment-type filter: `listEmployees` takes no such input, and a control
// that writes a URL parameter the service ignores is worse than no control.
const FILTER_KEYS = ['status', 'departmentId', 'isTeacher'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('employees.title') };
}

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const result = await listEmployees(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    status: status ? [status] : undefined,
    departmentId: one(params, 'departmentId'),
    isTeacher: one(params, 'isTeacher') === 'true' ? true : undefined,
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  return (
    <>
      <PageHeader title={t.t('employees.title')} description={t.t('employees.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('employees.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('employees.fields.employmentStatus')}
          options={STATUSES.map((value) => ({
            value,
            label: t.t(`enums.EmploymentStatus.${value}`),
          }))}
        />
        <ListFilter
          name="isTeacher"
          label={t.t('employees.fields.isTeacher')}
          options={[{ value: 'true', label: t.t('employees.fields.isTeacher') }]}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.items.length === 0 ? (
        filtered ? (
          <NoResultsState
            title={t.t('employees.emptyFiltered.title')}
            description={t.t('employees.emptyFiltered.description')}
          />
        ) : (
          <EmptyState title={t.t('employees.empty.title')} description={t.t('employees.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('employees.title')}>
            <THead>
              <TR>
                <TH>{t.t('common.name')}</TH>
                <TH>{t.t('employees.fields.position')}</TH>
                <TH>{t.t('employees.fields.branch')}</TH>
                <TH>{t.t('employees.fields.employmentType')}</TH>
                <TH numeric>{t.t('employees.fields.salary')}</TH>
                <TH>{t.t('employees.fields.employmentStatus')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={`${row.firstName} ${row.lastName}`}
                      subtitle={row.employeeCode}
                      href={`/hr/employees/${row.id}`}
                    />
                  </TD>
                  <TD muted>
                    {row.position}
                    {row.isTeacher && (
                      <Badge tone="info" size="sm" className="ml-1.5">
                        {t.t('employees.fields.isTeacher')}
                      </Badge>
                    )}
                  </TD>
                  <TD muted nowrap>
                    {row.branchName}
                  </TD>
                  <TD muted nowrap>
                    {t.t(`enums.EmploymentType.${row.employmentType}`)}
                  </TD>
                  <TD numeric nowrap>
                    {/* Redaction is a real state, not an absence: saying "—" for a
                        salary the caller may not see would read as "unpaid". */}
                    {row.salaryRedacted ? (
                      <span
                        className="inline-flex items-center gap-1 text-[var(--color-text-subtle)]"
                        title={t.t('errors.forbidden')}
                      >
                        <Lock className="size-3" aria-hidden="true" />
                        {t.t('common.notAvailable')}
                      </span>
                    ) : row.salary?.baseSalaryMinor && row.salary.currency ? (
                      formatMoney(
                        makeMoney(BigInt(row.salary.baseSalaryMinor), row.salary.currency),
                        t.locale,
                      )
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD nowrap>
                    <StatusBadge
                      status={row.status}
                      label={t.t(`enums.EmploymentStatus.${row.status}`)}
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
