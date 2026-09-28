import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createTranslator } from '@/lib/i18n';
import { getOptionalAuth } from '@/server/auth/context';
import { anonymousViewerLocale } from '@/server/i18n';
import { LoginForm } from './login-form';

export async function generateMetadata(): Promise<Metadata> {
  const { locale, timeZone } = await anonymousViewerLocale();
  return { title: createTranslator(locale, timeZone).t('auth.signIn') };
}

export default async function LoginPage() {
  const auth = await getOptionalAuth();
  // A partial session is deliberately NOT redirected: it belongs to someone
  // mid-way through a two-factor challenge, and the form's second step is where
  // that gets finished.
  if (auth?.isFullyAuthenticated) redirect('/dashboard');

  const { locale, timeZone } = await anonymousViewerLocale();
  const t = createTranslator(locale, timeZone);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
      <header className="mb-5 space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          {t.t('common.appName')}
        </p>
        <h1 className="text-lg font-semibold tracking-tight">{t.t('auth.signInTitle')}</h1>
        <p className="text-xs text-[var(--color-text-muted)]">{t.t('auth.signInSubtitle')}</p>
      </header>

      <LoginForm awaitingCodeInitially={auth !== null} />
    </div>
  );
}
