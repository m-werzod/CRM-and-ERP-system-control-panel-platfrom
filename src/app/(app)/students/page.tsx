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
import { EmptyState, InlineWarning, NoResultsState } from '@/components/ui/states';
import {
  PrimaryCell,
  TBody,
  TD,
  TH,
  THead,
  TR,
  TableWrapper,
} from '@/components/ui/table';
import type { Gender, StudentStatus } from '@/generated/prisma/client';
import {
  enumOne,
  hasActiveFilters,
  one,
  pageOf,
  pageSizeOf,
  totalPagesOf,
  type RawSearchParams,
} from '@/lib/list-params';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { listStudents } from '@/server/services/students/students';

const STATUSES = [
  'PROSPECT',
  'ACTIVE',
  'ON_HOLD',
  'GRADUATED',
  'WITHDRAWN',
  'SUSPENDED',
] as const satisfies readonly StudentStatus[];

const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'] as const satisfies readonly Gender[];

const FILTER_KEYS = ['status', 'gender', 'groupId', 'programId'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('students.title') };
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const page = pageOf(params);
  const pageSize = pageSizeOf(params);

  // The service checks `students.view` itself and applies the caller's branch
  // scope as a WHERE fragment; nothing here decides which rows are visible.
  const result = await listStudents(ctx, {
    page,
    pageSize,
    q: one(params, 'q'),
    status: enumOne(params, 'status', STATUSES) ? [enumOne(params, 'status', STATUSES)!] : undefined,
    gender: enumOne(params, 'gender', GENDERS),
    groupId: one(params, 'groupId'),
    programId: one(params, 'programId'),
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  return (
    <>
      <PageHeader title={t.t('students.title')} description={t.t('students.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('students.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('students.fields.status')}
          options={STATUSES.map((value) => ({
            value,
            label: t.t(`enums.StudentStatus.${value}`),
          }))}
        />
        <ListFilter
          name="gender"
          label={t.t('students.fields.gender')}
          options={GENDERS.map((value) => ({ value, label: t.t(`enums.Gender.${value}`) }))}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
        <span className="ml-auto text-2xs text-[var(--color-text-subtle)]">
          {t.plural('common.plurals.students', result.total)}
        </span>
      </ListToolbar>

      {result.searchTruncated && (
        <InlineWarning tone="info" className="mb-3">
          {t.t('search.truncated')}
        </InlineWarning>
      )}

      {result.rows.length === 0 ? (
        filtered ? (
          <NoResultsState
            title={t.t('students.emptyFiltered.title')}
            description={t.t('students.emptyFiltered.description')}
          />
        ) : (
          <EmptyState
            title={t.t('students.empty.title')}
            description={t.t('students.empty.description')}
          />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('students.title')}>
            <THead>
              <TR>
                <TH>{t.t('students.fields.fullName')}</TH>
                <TH>{t.t('students.fields.studentCode')}</TH>
                <TH>{t.t('students.fields.phone')}</TH>
                <TH>{t.t('students.fields.groups')}</TH>
                <TH>{t.t('students.fields.branch')}</TH>
                <TH>{t.t('students.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell title={row.fullName} href={`/students/${row.id}`} />
                  </TD>
                  <TD muted nowrap>
                    <span className="font-mono text-2xs">{row.studentCode}</span>
                  </TD>
                  <TD muted nowrap>
                    {row.phone ?? '—'}
                  </TD>
                  <TD>
                    {row.groups.length === 0 ? (
                      <span className="text-[var(--color-text-subtle)]">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {row.groups.map((group) => (
                          <Link
                            key={group.id}
                            href={`/academics/groups/${group.id}`}
                            className="text-[var(--color-accent-text)] hover:underline"
                          >
                            {group.name}
                          </Link>
                        ))}
                      </span>
                    )}
                  </TD>
                  <TD muted nowrap>
                    {row.branchName}
                  </TD>
                  <TD nowrap>
                    <StatusBadge status={row.status} label={t.t(`enums.StudentStatus.${row.status}`)} />
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
