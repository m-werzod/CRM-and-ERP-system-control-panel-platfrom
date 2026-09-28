'use client';

import { LogOut, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { isNavItemActive, visibleNavigation } from '@/components/layout/navigation';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { cn } from '@/lib/cn';

/**
 * The destinations that exist today.
 *
 * `NAV_SECTIONS` describes the finished product, and most of it is not built
 * yet. Filtering through this set is what keeps "no dead nav links" true in the
 * meantime: add a route here the moment its page lands and the item appears by
 * itself, still gated by the permission the tree already declares.
 */
const BUILT_ROUTES: ReadonlySet<string> = new Set([
  '/dashboard',
  '/crm/leads',
  '/students',
  '/guardians',
  '/academics/groups',
  '/academics/exams',
  '/finance/invoices',
  '/finance/payments',
  '/hr/employees',
  '/hr/leave',
  '/hr/payroll',
  '/settings',
  '/settings/users',
]);

export interface AppShellProps {
  readonly displayName: string;
  readonly email: string;
  /** Flattened from the AccessContext: a Set does not cross the server boundary. */
  readonly permissions: readonly string[];
  readonly children: ReactNode;
}

export function AppShell({ displayName, email, permissions, children }: AppShellProps) {
  const t = useTranslator();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const held = new Set(permissions);
  const sections = visibleNavigation((permission) => held.has(permission))
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => BUILT_ROUTES.has(item.href)),
    }))
    .filter((section) => section.items.length > 0);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);

    await apiPost('/api/auth/logout');
    // The result is not branched on: whatever the server said, the user asked to
    // leave, and the login screen re-checks the session on arrival anyway.
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] text-[var(--color-text)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-[var(--color-surface)] focus:px-3 focus:py-2 focus:text-sm focus:outline-2 focus:outline-[var(--color-border-focus)]"
      >
        {t.t('nav.skipToContent')}
      </a>

      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 lg:hidden">
        <span className="text-sm font-semibold">{t.t('common.appName')}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-expanded={menuOpen}
          aria-controls="app-nav"
          aria-label={menuOpen ? t.t('nav.closeMenu') : t.t('nav.openMenu')}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </Button>
      </header>

      <div className="lg:grid lg:grid-cols-[13rem_1fr] lg:items-start">
        {/* One element rather than a desktop copy and a mobile copy: two <nav>
            landmarks holding the same links is noise for a screen reader. */}
        <aside
          id="app-nav"
          className={cn(
            'border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-3',
            'lg:sticky lg:top-0 lg:block lg:h-dvh lg:overflow-y-auto lg:border-r',
            menuOpen ? 'block border-b' : 'hidden',
          )}
        >
          <p className="mb-3 hidden px-2 text-sm font-semibold lg:block">{t.t('common.appName')}</p>

          <nav className="space-y-4">
            {sections.map((section) => (
              <div key={section.label}>
                <h2 className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  {t.t(section.label)}
                </h2>
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = isNavItemActive(item, pathname);
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => setMenuOpen(false)}
                          className={cn(
                            'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-border-focus)]',
                            active
                              ? 'bg-[var(--color-surface-sunken)] font-medium text-[var(--color-text)]'
                              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
                          )}
                        >
                          <Icon className="size-4 shrink-0" aria-hidden="true" />
                          {t.t(item.label)}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="mt-4 border-t border-[var(--color-border)] px-2 pt-3">
            <div className="mb-2.5">
              <ThemeToggle />
            </div>
            <p className="truncate text-xs font-medium">{displayName}</p>
            <p className="truncate text-2xs text-[var(--color-text-subtle)]">{email}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 w-full justify-start"
              onClick={signOut}
              disabled={signingOut}
            >
              <LogOut aria-hidden="true" />
              {t.t('auth.signOut')}
            </Button>
          </div>
        </aside>

        <main id="main" className="min-w-0 px-4 py-5 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
