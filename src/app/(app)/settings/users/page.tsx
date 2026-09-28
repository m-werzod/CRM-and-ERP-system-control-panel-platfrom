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
import type { UserStatus } from '@/generated/prisma/client';
import { dateTime } from '@/lib/i18n';
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
import { listUsers } from '@/server/services/admin/users';

const STATUSES = [
  'INVITED',
  'ACTIVE',
  'INACTIVE',
  'LOCKED',
  'SUSPENDED',
] as const satisfies readonly UserStatus[];

const FILTER_KEYS = ['status', 'roleId'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('users.title') };
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  const status = enumOne(params, 'status', STATUSES);
  const result = await listUsers(ctx, {
    page: pageOf(params),
    pageSize: pageSizeOf(params),
    q: one(params, 'q'),
    status: status ? [status] : undefined,
    roleId: one(params, 'roleId'),
  });

  const filtered = hasActiveFilters(params, [...FILTER_KEYS, 'q']);

  return (
    <>
      <PageHeader title={t.t('users.title')} description={t.t('users.subtitle')} />

      <ListToolbar>
        <ListSearch placeholder={t.t('users.searchPlaceholder')} />
        <ListFilter
          name="status"
          label={t.t('users.fields.status')}
          options={STATUSES.map((value) => ({ value, label: t.t(`enums.UserStatus.${value}`) }))}
        />
        {filtered && <ClearFilters keys={FILTER_KEYS} />}
      </ListToolbar>

      {result.items.length === 0 ? (
        filtered ? (
          <NoResultsState title={t.t('common.noMatches.title')} description={t.t('common.noMatches.description')} />
        ) : (
          <EmptyState title={t.t('users.empty.title')} description={t.t('users.empty.description')} />
        )
      ) : (
        <>
          <TableWrapper caption={t.t('users.title')}>
            <THead>
              <TR>
                <TH>{t.t('common.name')}</TH>
                <TH>{t.t('users.fields.email')}</TH>
                <TH>{t.t('users.fields.roles')}</TH>
                <TH>{t.t('users.fields.branches')}</TH>
                <TH>{t.t('users.fields.lastLoginAt')}</TH>
                <TH>{t.t('users.fields.status')}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((row) => (
                <TR key={row.id} interactive>
                  <TD>
                    <PrimaryCell
                      title={row.fullName}
                      subtitle={row.username ?? undefined}
                      href={`/settings/users/${row.id}`}
                    />
                  </TD>
                  <TD muted nowrap>
                    {row.email}
                  </TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {row.roles.map((grant) => (
                        <Badge key={grant.roleId} tone="neutral">
                          {grant.roleName}
                        </Badge>
                      ))}
                    </span>
                  </TD>
                  <TD muted nowrap>
                    {/* An empty branch list under an organisation-scoped role means
                        "every branch", not "none". */}
                    {row.branchIds.length === 0
                      ? t.t('users.fields.allBranches')
                      : t.plural('common.plurals.items', row.branchIds.length)}
                  </TD>
                  <TD muted nowrap>
                    {row.lastLoginAt ? dateTime(row.lastLoginAt, t) : '—'}
                  </TD>
                  <TD nowrap>
                    <span className="flex items-center gap-1">
                      <StatusBadge status={row.status} label={t.t(`enums.UserStatus.${row.status}`)} />
                      {row.mustChangePassword && (
                        <Badge tone="warning" size="sm">
                          {t.t('users.fields.mustChangePassword')}
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
