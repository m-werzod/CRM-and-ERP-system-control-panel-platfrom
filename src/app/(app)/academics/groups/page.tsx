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
import type { GroupStatus, ProgramLevel } from '@/generated/prisma/client';
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
import { listGroups } from '@/server/services/academics/groups';

const STATUSES = [
  'PLANNED',
  'ENROLLING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const satisfies readonly GroupStatus[];

const LEVELS = [
  'BEGINNER',
  'ELEMENTARY',
  'PRE_INTERMEDIATE',
  'INTERMEDIATE',
  'UPPER_INTERMEDIATE',
  'ADVANCED',
] as const satisfies readonly ProgramLevel[];

const FILTER_KEYS = ['status', 'level', 'programId', 'subjectId'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('groups.title') };
}

export default async function GroupsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const result = await listGroups(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    status: status ? [status] : undefined,
    level: enumOne(params, 'level', LEVELS),
    programId: one(params, 'programId'),
    subjectId: one(params, 'subjectId'),
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  return (
    <>
      <PageHeader title={t.t('groups.title')} description={t.t('groups.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('groups.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('groups.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.GroupStatus.${value}`) }))}
        />
        <ListFilter
          name="level"
          label={t.t('groups.fields.level')}
          options={LEVELS.map((value) => ({ value, label: t.t(`enums.ProgramLevel.${value}`) }))}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.items.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('groups.emptyFiltered.title')} description={t.t('groups.emptyFiltered.description')} />
        ) : (
          <EmptyState title={t.t('groups.empty.title')} description={t.t('groups.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('groups.title')}>
            <THead>
              <TR>
                <TH>{t.t('groups.fields.name')}</TH>
                <TH>{t.t('groups.fields.program')}</TH>
                <TH>{t.t('groups.fields.teacher')}</TH>
                <TH numeric>{t.t('groups.fields.enrolled')}</TH>
                <TH numeric>{t.t('groups.fields.seatsLeft')}</TH>
                <TH>{t.t('groups.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell title={row.name} subtitle={row.code} href={`/groups/${row.id}`} />
                  </TD>
                  <TD muted>
                    {row.programName ?? '—'}
                    {row.subjectName && (
                      <span className="text-[var(--color-text-subtle)]"> · {row.subjectName}</span>
                    )}
                  </TD>
                  <TD muted nowrap>
                    {row.primaryTeacherId && row.primaryTeacherName ? (
                      <Link
                        href={`/teachers/${row.primaryTeacherId}`}
                        className="text-[var(--color-accent-text)] hover:underline"
                      >
                        {row.primaryTeacherName}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD numeric>
                    {row.enrolled} / {row.capacity}
                  </TD>
                  <TD numeric muted={row.available > 0}>
                    {row.available}
                  </TD>
                  <TD nowrap>
                    <StatusBadge status={row.status} label={t.t(`enums.GroupStatus.${row.status}`)} />
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
