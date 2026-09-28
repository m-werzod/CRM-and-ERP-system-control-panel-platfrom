import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PasswordChangeForm } from '@/components/auth/password-change-form';
import { createTranslator } from '@/lib/i18n';
import { getOptionalAuth } from '@/server/auth/context';
import { anonymousViewerLocale, viewerLocale } from '@/server/i18n';

export async function generateMetadata(): Promise<Metadata> {
  const auth = await getOptionalAuth();
  const { locale, timeZone } = auth
    ? await viewerLocale(auth.ctx)
    : await anonymousViewerLocale();
  return { title: createTranslator(locale, timeZone).t('auth.changePassword') };
}

/**
 * The forced password change, for an account an administrator created with a
 * temporary password. It lives outside the app shell on purpose: until the flag
 * clears, `requireAuth` refuses every other screen, so a sidebar full of links
 * the user cannot follow would be a dead end dressed up as a menu.
 */
export default async function ChangePasswordPage() {
  const auth = await getOptionalAuth();
  if (!auth) redirect('/login');
  // Nothing is being forced, so the ordinary place to do this is Settings.
  if (!auth.mustChangePassword) redirect('/settings');

  const { locale, timeZone } = await viewerLocale(auth.ctx);
  const t = createTranslator(locale, timeZone);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
      <header className="mb-5 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">{t.t('auth.changePassword')}</h1>
        <p className="text-xs text-[var(--color-text-muted)]">
          {t.t('auth.mustChangePassword')}
        </p>
      </header>

      <PasswordChangeForm redirectTo="/dashboard" />
    </div>
  );
}
