import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The panel every screen is built from.
 *
 * Elevation is carried by a border rather than a shadow. In a dense console a
 * page holds six to ten panels, and shadowed cards at that density read as
 * visual noise; a 1px border separates them without competing for attention.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Buttons or a menu, right-aligned on the same baseline as the title. */
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        {title && <h2 className="truncate text-base font-semibold">{title}</h2>}
        {description && (
          <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardContent({
  className,
  /** Tables and lists supply their own edge padding, so opt out here. */
  flush = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { flush?: boolean }) {
  return <div className={cn(flush ? '' : 'px-4 py-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-4 py-2.5',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A single headline metric.
 *
 * `value` is pre-formatted by the caller, because money and counts need
 * locale- and currency-aware formatting that belongs in @/lib/i18n, not here.
 * `delta` is optional and must be real — a tile showing an invented "+12%" is
 * worse than a tile showing nothing.
 */
export function StatTile({
  label,
  value,
  hint,
  delta,
  icon,
  href,
  tone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; /** Is up good? */ upIsGood?: boolean };
  icon?: ReactNode;
  href?: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  className?: string;
}) {
  const toneRing = {
    neutral: '',
    success: 'border-l-2 border-l-[var(--color-success)]',
    warning: 'border-l-2 border-l-[var(--color-warning)]',
    danger: 'border-l-2 border-l-[var(--color-danger)]',
    accent: 'border-l-2 border-l-[var(--color-accent)]',
  }[tone];

  const deltaTone = (() => {
    if (!delta || delta.direction === 'flat') return 'text-[var(--color-text-subtle)]';
    const good = delta.upIsGood ?? true;
    const isGood = delta.direction === 'up' ? good : !good;
    return isGood ? 'text-[var(--color-success-text)]' : 'text-[var(--color-danger-text)]';
  })();

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">{label}</span>
        {icon && <span className="text-[var(--color-text-subtle)]">{icon}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span data-numeric className="text-2xl font-semibold tracking-tight">
          {value}
        </span>
        {delta && (
          <span className={cn('text-xs font-medium', deltaTone)}>
            {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'}{' '}
            {delta.value}
          </span>
        )}
      </div>
      {hint && <p className="mt-0.5 text-2xs text-[var(--color-text-subtle)]">{hint}</p>}
    </>
  );

  const shell = cn(
    'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3',
    toneRing,
    href && 'transition-colors hover:bg-[var(--color-surface-hover)]',
    className,
  );

  if (href) {
    return (
      <a href={href} className={cn(shell, 'block')}>
        {body}
      </a>
    );
  }
  return <div className={shell}>{body}</div>;
}

/** The page title block, consistent across every screen. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('mb-4 space-y-2', className)}>
      {breadcrumbs}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="max-w-2xl text-xs text-[var(--color-text-muted)]">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
