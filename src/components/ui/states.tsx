import { AlertTriangle, Inbox, Lock, SearchX, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * Loading, empty and error states.
 *
 * These exist as components so that no screen can ship a blank white panel. The
 * three cases are genuinely different and must not be collapsed:
 *
 *   loading  we do not know yet             -> skeleton in the shape of the result
 *   empty    we know, and there is nothing  -> explain why, offer the next action
 *   error    we could not find out          -> say what failed, offer a retry
 *
 * The distinction matters operationally: "no students" and "the students list
 * failed to load" require opposite responses from the person looking at it.
 */

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-md', className)} />;
}

/**
 * A skeleton shaped like the table it replaces. Matching the real column count
 * prevents the layout jump that makes a page feel broken on every load.
 */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  hasActions = true,
}: {
  rows?: number;
  columns?: number;
  hasActions?: boolean;
}) {
  return (
    <div role="status" aria-live="polite" className="w-full">
      <span className="sr-only">Loading</span>
      <div className="border-b border-[var(--color-border)] px-3 py-2">
        <div className="flex gap-4">
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-3 flex-1" />
          ))}
          {hasActions && <Skeleton className="h-3 w-12" />}
        </div>
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-[var(--color-border)] px-3 py-2.5 last:border-0"
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className="h-3.5 flex-1"
              // Vary the widths so it reads as content rather than a loading bar.
              {...{ style: { maxWidth: `${70 + ((rowIndex * 7 + columnIndex * 13) % 30)}%` } }}
            />
          ))}
          {hasActions && <Skeleton className="h-6 w-12" />}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4',
        className,
      )}
    >
      <span className="sr-only">Loading</span>
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div
      role="status"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3"
    >
      <span className="sr-only">Loading</span>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-7 w-20" />
      <Skeleton className="mt-1.5 h-2.5 w-16" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  /** What is missing, e.g. "No students yet". */
  title: ReactNode;
  /** Why it is empty and what to do about it. */
  description?: ReactNode;
  icon?: ReactNode;
  /** The action that resolves the emptiness. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-[var(--color-surface-sunken)] text-[var(--color-text-subtle)]">
        {icon ?? <Inbox className="size-5" aria-hidden="true" />}
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

/**
 * Distinct from EmptyState: the collection is NOT empty, the filters just exclude
 * everything. The resolving action is "clear the filters", not "create a record",
 * and offering "Add student" here would be actively misleading.
 */
export function NoResultsState({
  query,
  onClear,
  clearLabel = 'Clear filters',
  title = 'No matches',
  description,
}: {
  query?: string;
  onClear?: () => void;
  clearLabel?: string;
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <EmptyState
      compact
      icon={<SearchX className="size-5" aria-hidden="true" />}
      title={title}
      description={
        description ??
        (query
          ? `Nothing matched “${query}”. Try a shorter term or a different filter.`
          : 'No records match the current filters.')
      }
      action={
        onClear ? (
          <Button size="sm" variant="secondary" onClick={onClear}>
            {clearLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ErrorStateProps {
  title?: ReactNode;
  /**
   * A user-facing explanation. Pass the API envelope's `error.message`, which is
   * already safe — never an exception message or a stack.
   */
  description?: ReactNode;
  /** Shown in small print so a user can quote it to support. */
  requestId?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  compact?: boolean;
}

export function ErrorState({
  title = 'Could not load this',
  description,
  requestId,
  onRetry,
  retryLabel = 'Try again',
  className,
  compact = false,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-[var(--color-danger-subtle)] text-[var(--color-danger-text)]">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
        {requestId && (
          <p className="font-mono text-2xs text-[var(--color-text-subtle)]">
            Reference: {requestId}
          </p>
        )}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/** Shown when the caller is authenticated but lacks the permission. */
export function ForbiddenState({
  title = 'You do not have access to this',
  description = 'Ask an administrator to grant you the required permission, or switch to a branch you have access to.',
}: {
  title?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <EmptyState
      icon={<Lock className="size-5" aria-hidden="true" />}
      title={title}
      description={description}
    />
  );
}

/**
 * An integration point with no provider configured. This is the honest state the
 * spec demands instead of a feature that appears to work: it names the
 * integration and points at the person who can enable it.
 */
export function NotConfiguredState({
  integration,
  description,
  action,
}: {
  integration: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      icon={<WifiOff className="size-5" aria-hidden="true" />}
      title={`${integration} is not configured`}
      description={
        description ??
        `This feature needs ${integration} to be set up before it can be used. An administrator can configure it in Settings → Integrations.`
      }
      action={action}
    />
  );
}

/**
 * An inline banner for a partial failure, where the page still rendered but one
 * panel could not load. A full-page error here would hide working content.
 */
export function InlineWarning({
  children,
  tone = 'warning',
  className,
}: {
  children: ReactNode;
  tone?: 'warning' | 'danger' | 'info';
  className?: string;
}) {
  const tones = {
    warning:
      'border-[var(--color-warning-border)] bg-[var(--color-warning-subtle)] text-[var(--color-warning-text)]',
    danger:
      'border-[var(--color-danger-border)] bg-[var(--color-danger-subtle)] text-[var(--color-danger-text)]',
    info: 'border-[var(--color-info-border)] bg-[var(--color-info-subtle)] text-[var(--color-info-text)]',
  }[tone];

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', tones, className)}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
