import type { Metadata } from 'next';
import {
  ClearFilters,
  ListFilter,
  ListPagination,
  ListToolbar,
} from '@/components/data/list-controls';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import type { ExamStatus, ExamType } from '@/generated/prisma/client';
import { dateTime } from '@/lib/i18n';
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
import { listExams } from '@/server/services/assessment/exams';

const STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'GRADED',
  'PUBLISHED',
  'CANCELLED',
] as const satisfies readonly ExamStatus[];

const TYPES = [
  'QUIZ',
  'UNIT_TEST',
  'MIDTERM',
  'FINAL',
  'PLACEMENT',
  'MOCK',
  'CERTIFICATION',
] as const satisfies readonly ExamType[];

const FILTER_KEYS = ['status', 'type'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('exams.title') };
}

export default async function ExamsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const type = enumOne(params, 'type', TYPES);

  const result = await listExams(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    status: status ? [status] : undefined,
    type: type ? [type] : undefined,
  });

  const filtered = hasActiveFilters(params, FILTER_KEYS);

  return (
    <>
      <PageHeader title={t.t('exams.title')} description={t.t('exams.subtitle')} />

      <ListToolbar>
        <ListFilter
          name="status"
          label={t.t('exams.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.ExamStatus.${value}`) }))}
        />
        <ListFilter
          name="type"
          label={t.t('exams.fields.type')}
          options={TYPES.map((value) => ({ value, label: t.t(`enums.ExamType.${value}`) }))}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.rows.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('common.noMatches.title')} description={t.t('common.noMatches.description')} />
        ) : (
          <EmptyState title={t.t('exams.empty.title')} description={t.t('exams.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('exams.title')}>
            <THead>
              <TR>
                <TH>{t.t('exams.fields.name')}</TH>
                <TH>{t.t('exams.fields.group')}</TH>
                <TH>{t.t('exams.fields.date')}</TH>
                <TH numeric>{t.t('exams.fields.maxScore')}</TH>
                <TH numeric>{t.t('exams.tabs.results')}</TH>
                <TH>{t.t('exams.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={row.title}
                      subtitle={t.t(`enums.ExamType.${row.type}`)}
                      href={`/academics/exams/${row.id}`}
                    />
                  </TD>
                  <TD muted>
                    {row.groupName ?? row.subjectName ?? '—'}
                  </TD>
                  <TD muted nowrap>
                    {dateTime(row.scheduledAt, t)}
                  </TD>
                  <TD numeric>
                    {row.passingScore} / {row.maxScore}
                  </TD>
                  <TD numeric>{row.resultCount}</TD>
                  <TD nowrap>
                    <StatusBadge status={row.status} label={t.t(`enums.ExamStatus.${row.status}`)} />
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
