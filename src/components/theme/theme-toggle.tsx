'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { cn } from '@/lib/cn';

/** The snapshot never changes after hydration, so there is nothing to subscribe to. */
const subscribeNever = () => () => {};

/**
 * Three explicit choices rather than a light/dark switch.
 *
 * A two-state toggle cannot express "follow the OS", so the moment a user
 * touches it they are opted out of their system setting for good without being
 * told. Naming the third state costs one more button and removes the surprise.
 */
export function ThemeToggle() {
  const t = useTranslator();
  const { theme, setTheme } = useTheme();

  // The stored choice lives in localStorage, which the server cannot read, so
  // the active button is unknowable until hydration. `useSyncExternalStore` is
  // how React models exactly that -- a different snapshot on server and client
  // -- without an effect that would set state on mount and re-render the row.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  const options = [
    { value: 'light', label: t.t('theme.light'), icon: Sun },
    { value: 'dark', label: t.t('theme.dark'), icon: Moon },
    { value: 'system', label: t.t('theme.system'), icon: Monitor },
  ] as const;

  return (
    <div
      role="group"
      aria-label={t.t('theme.label')}
      className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = hydrated && theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            aria-pressed={active}
            title={option.label}
            className={cn(
              'flex size-6 items-center justify-center rounded transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-border-focus)]',
              active
                ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-xs'
                : 'text-[var(--color-text-subtle)] hover:text-[var(--color-text)]',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
