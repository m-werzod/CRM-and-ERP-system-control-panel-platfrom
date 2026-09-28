import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/components/i18n/provider';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth, type AuthenticatedRequest } from '@/server/auth/context';
import { PasswordChangeRequiredError } from '@/server/errors';
import { viewerLocale } from '@/server/i18n';

/**
 * The authoritative gate for every signed-in screen.
 *
 * Note what this is NOT: a middleware cookie check. `requireAuth` loads the
 * session row, rebuilds the AccessContext and re-reads account and organisation
 * status, so a revoked session or a suspended tenant is refused on the next
 * request rather than at the next cookie expiry.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  let auth: AuthenticatedRequest | null = null;
  let destination: string | null = null;

  try {
    auth = await requireAuth();
  } catch (error) {
    // Decided here and acted on below: `redirect()` works by throwing, and the
    // Next.js docs are explicit that it belongs outside a try/catch. A pending
    // two-factor challenge falls through to /login, where the code step lives.
    destination =
      error instanceof PasswordChangeRequiredError ? '/change-password' : '/login';
  }

  if (destination) redirect(destination);
  if (!auth) redirect('/login');

  const { locale, timeZone } = await viewerLocale(auth.ctx);

  return (
    <I18nProvider locale={locale} timeZone={timeZone}>
      <AppShell
        displayName={auth.ctx.displayName}
        email={auth.ctx.email}
        permissions={[...auth.ctx.permissions]}
      >
        {children}
      </AppShell>
    </I18nProvider>
  );
}
