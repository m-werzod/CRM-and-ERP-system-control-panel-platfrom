import type { ReactNode } from 'react';
import { I18nProvider } from '@/components/i18n/provider';
import { getOptionalAuth } from '@/server/auth/context';
import { anonymousViewerLocale, viewerLocale } from '@/server/i18n';

/**
 * The shell for screens reached without a usable session: one centred card on an
 * empty canvas, and no navigation to offer someone who cannot use it yet.
 *
 * The locale still comes from the session when there is one, because a forced
 * password change happens while signed in -- switching that screen to the
 * browser's language would be a jarring and pointless regression.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
  const auth = await getOptionalAuth();
  const { locale, timeZone } = auth
    ? await viewerLocale(auth.ctx)
    : await anonymousViewerLocale();

  return (
    <I18nProvider locale={locale} timeZone={timeZone}>
      <main className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] px-4 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </I18nProvider>
  );
}
