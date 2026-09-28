import { GraduationCap, Receipt, Target, UsersRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, PageHeader } from '@/components/ui/card';
import { InlineWarning } from '@/components/ui/states';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';
import { can } from '@/server/rbac/access';
import { listGroups } from '@/server/services/academics/groups';
import { listLeads } from '@/server/services/crm/leads';
import { listInvoices } from '@/server/services/finance/invoices';
import { listStudents } from '@/server/services/students/students';

/**
 * A figure the caller is actually allowed to see.
 *
 * Every tile is a real count from the service that owns it, asked for with
 * `pageSize: 1` so only the total crosses the wire. A permission the caller
 * lacks means no tile, not a zero -- a zero would read as "no students", which
 * is a different and wrong statement.
 */
function StatLink({
  label,
  value,
  hint,
  href,
  icon,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  href: string;
  icon: ReactNode;
  tone: string;
}) {
  return (
    <Link
      href={href}
      style={{ '--tile': tone } as CSSProperties}
      className="group rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 transition-colors hover:border-[var(--tile)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-border-focus)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">{label}</span>
        <span className="text-[var(--tile)]">{icon}</span>
      </div>
      <div
        data-numeric
        className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums"
      >
        {value.toLocaleString('en-US').replace(/,/g, ' ')}
      </div>
      <p className="mt-0.5 text-2xs text-[var(--color-text-subtle)]">{hint}</p>
    </Link>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('dashboard.title') };
}

export default async function DashboardPage() {
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  // Asked for together rather than in sequence: four independent counts against
  // a pool of ten connections, so the page costs one round trip, not four.
  const [students, groups, leads, overdue] = await Promise.all([
    can(ctx, 'students.view') ? listStudents(ctx, { pageSize: 1 }) : null,
    can(ctx, 'groups.view') ? listGroups(ctx, { pageSize: 1 }) : null,
    can(ctx, 'leads.view') ? listLeads(ctx, { pageSize: 1 }) : null,
    can(ctx, 'invoices.view') ? listInvoices(ctx, { pageSize: 1, overdueOnly: true }) : null,
  ]);

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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {students && (
            <StatLink
              label={t.t('dashboard.activeStudents')}
              value={students.total}
              hint={t.t('students.subtitle')}
              href="/students"
              icon={<GraduationCap className="size-4" aria-hidden="true" />}
              tone="var(--color-module-people)"
            />
          )}
          {groups && (
            <StatLink
              label={t.t('nav.groups')}
              value={groups.total}
              hint={t.t('groups.subtitle')}
              href="/academics/groups"
              icon={<UsersRound className="size-4" aria-hidden="true" />}
              tone="var(--color-module-academics)"
            />
          )}
          {leads && (
            <StatLink
              label={t.t('dashboard.newLeads')}
              value={leads.total}
              hint={t.t('leads.subtitle')}
              href="/crm/leads"
              icon={<Target className="size-4" aria-hidden="true" />}
              tone="var(--color-module-crm)"
            />
          )}
          {overdue && (
            <StatLink
              label={t.t('dashboard.overdueInvoices')}
              value={overdue.total}
              hint={t.t('invoices.overdueOnly')}
              href="/finance/invoices?overdue=true"
              icon={<Receipt className="size-4" aria-hidden="true" />}
              // Overdue is a status, not a module, so it takes the status hue --
              // the one place on this page where colour means "attention".
              tone={
                overdue.total > 0 ? 'var(--color-danger)' : 'var(--color-module-finance)'
              }
            />
          )}
        </div>

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

        <InlineWarning tone="info">{t.t('dashboard.modulesPending')}</InlineWarning>
      </div>
    </>
  );
}
