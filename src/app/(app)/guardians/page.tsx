import type { Metadata } from 'next';
import Link from 'next/link';
import { ListPagination, ListSearch, ListToolbar } from '@/components/data/list-controls';
import { PageHeader } from '@/components/ui/card';
import { EmptyState, InlineWarning, NoResultsState } from '@/components/ui/states';
import { PrimaryCell, TBody, TD, TH, THead, TR, TableWrapper } from '@/components/ui/table';
import { hasActiveFilters, one, pageOf, pageSizeOf, totalPagesOf, type RawSearchParams } from '@/lib/list-params';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { listGuardians } from '@/server/services/students/guardians';

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('guardians.title') };
}

export default async function GuardiansPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const result = await listGuardians(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
  });

  const filtered = hasActiveFilters(params, ['q']);

  return (
    <>
      <PageHeader title={t.t('guardians.title')} description={t.t('guardians.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('guardians.searchPlaceholder')} />
        <span className="ml-auto text-2xs text-[var(--color-text-subtle)]">
          {t.t('common.showingRange', { from: 1, to: result.rows.length, total: result.total })}
        </span>
      </ListToolbar>

      {result.searchTruncated && (
        <InlineWarning tone="info" className="mb-3">
          {t.t('search.truncated')}
        </InlineWarning>
      )}

      {result.rows.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('common.noMatches.title')} description={t.t('common.noMatches.description')} />
        ) : (
          <EmptyState title={t.t('guardians.empty.title')} description={t.t('guardians.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('guardians.title')}>
            <THead>
              <TR>
                <TH>{t.t('common.name')}</TH>
                <TH>{t.t('guardians.fields.phone')}</TH>
                <TH>{t.t('guardians.fields.email')}</TH>
                <TH>{t.t('students.title')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.rows.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={row.fullName}
                      subtitle={row.occupation ?? undefined}
                      href={`/guardians/${row.id}`}
                    />
                  </TD>
                  <TD muted nowrap>
                    {row.phone}
                  </TD>
                  <TD muted nowrap>
                    {row.email ?? '—'}
                  </TD>
                  <TD>
                    {row.students.length === 0 ? (
                      <span className="text-[var(--color-text-subtle)]">—</span>
                    ) : (
                      <span className="flex flex-wrap items-baseline gap-1">
                        {row.students.map((student) => (
                          <Link
                            key={student.id}
                            href={`/students/${student.id}`}
                            className="text-[var(--color-accent-text)] hover:underline"
                          >
                            {student.fullName}
                          </Link>
                        ))}
                        {/* `students` is capped for the cell; the count is authoritative. */}
                        {row.studentCount > row.students.length && (
                          <span className="text-2xs text-[var(--color-text-subtle)]">
                            +{row.studentCount - row.students.length}
                          </span>
                        )}
                      </span>
                    )}
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
