import type { Metadata } from 'next';
import { PasswordChangeForm } from '@/components/auth/password-change-form';
import { Card, CardContent, CardHeader, PageHeader } from '@/components/ui/card';
import { InlineWarning } from '@/components/ui/states';
import { requireContext } from '@/server/auth/context';
import { viewerTranslator } from '@/server/i18n';

export async function generateMetadata(): Promise<Metadata> {
  const t = await viewerTranslator(await requireContext());
  return { title: t.t('settings.title') };
}

/**
 * No permission gate: everything on this page acts on the caller's own account,
 * which every authenticated user may do. The organisation-wide panels that
 * `settings.subtitle` describes arrive with the administration module, and each
 * will check `settings.view` for itself.
 */
export default async function SettingsPage() {
  const ctx = await requireContext();
  const t = await viewerTranslator(ctx);

  return (
    <>
      <PageHeader title={t.t('settings.title')} />

      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader title={t.t('settings.sections.security')} />
          <CardContent>
            <PasswordChangeForm />
          </CardContent>
        </Card>

        <InlineWarning tone="info">{t.t('dashboard.modulesPending')}</InlineWarning>
      </div>
    </>
  );
}
