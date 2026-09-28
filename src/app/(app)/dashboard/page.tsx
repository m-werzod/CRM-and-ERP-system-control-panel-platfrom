import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, PageHeader } from '@/components/ui/card';
import { InlineWarning } from '@/components/ui/states';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('dashboard.title') };
}

export default async function DashboardPage() {
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  // Branch names would need a query of their own; the count is the fact that is
  // already in hand, and an empty list under ORGANIZATION scope means "all" --
  // not "none", which is why it is spelled out rather than rendered as 0.
  const branchAccess =
    ctx.scope === 'ORGANIZATION' || ctx.branchIds.length === 0
      ? t.t('users.fields.allBranches')
      : t.plural('common.plurals.items', ctx.branchIds.length);

  return (
    <>
      <PageHeader
        title={t.t('dashboard.title')}
        description={t.t('dashboard.greeting', { name: ctx.displayName })}
      />

      <div className="space-y-4">
        <Card>
          <CardHeader title={t.t('common.overview')} />
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-[var(--color-text-muted)]">
                {t.t('users.fields.roles')}
              </p>
              <div className="flex flex-wrap gap-1">
                {ctx.roleKeys.map((role) => (
                  <Badge key={role} tone="neutral">
                    {role}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-[var(--color-text-muted)]">
                {t.t('users.fields.branches')}
              </p>
              <p className="text-sm">{branchAccess}</p>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-[var(--color-text-muted)]">
                {t.t('roles.permissions')}
              </p>
              <p data-numeric className="text-sm">
                {t.plural('common.plurals.items', ctx.permissions.size)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Deliberately not a grid of zeroed stat tiles: the figures those would
            carry have no service behind them yet, and an invented number is
            worse than an absent one. */}
        <InlineWarning tone="info">{t.t('dashboard.modulesPending')}</InlineWarning>
      </div>
    </>
  );
}
