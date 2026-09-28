'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/**
 * Data table primitives.
 *
 * Real `<table>` markup, not a grid of divs: a screen reader announces "row 4 of
 * 120, column Balance" for free, and that is not reproducible with flexbox
 * without a pile of ARIA that tends to rot.
 *
 * Wide tables scroll inside `TableWrapper`. The page body must never scroll
 * horizontally — a horizontally-scrolling page makes the sidebar and header
 * unreachable.
 */

export function TableWrapper({
  className,
  children,
  /** Announced by a screen reader; also the printed caption. */
  caption,
}: {
  className?: string;
  children: ReactNode;
  caption?: string;
}) {
  return (
    <div className={cn('scroll-x w-full', className)}>
      <table className="w-full border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)]',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-[var(--color-border)]', className)} {...props} />;
}

export function TR({
  className,
  interactive = false,
  selected = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      // aria-selected is only meaningful on a row in a selectable table; setting
      // it unconditionally would announce every row as selectable.
      aria-selected={selected || undefined}
      className={cn(
        'transition-colors',
        interactive && 'cursor-pointer hover:bg-[var(--color-surface-hover)]',
        selected && 'bg-[var(--color-accent-subtle)]',
        className,
      )}
      {...props}
    />
  );
}

export type SortDirection = 'asc' | 'desc';

export interface THProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-align numeric columns so digits line up down the column. */
  numeric?: boolean;
  /** Keeps the column visible while the body scrolls horizontally. */
  sticky?: boolean;
  /** When set, the header becomes a sort control. */
  sort?: {
    readonly active: boolean;
    readonly direction: SortDirection;
    readonly onToggle: () => void;
    /** Screen-reader label, e.g. "Sort by balance". */
    readonly label: string;
  };
}

export function TH({ className, numeric, sticky, sort, children, ...props }: THProps) {
  return (
    <th
      scope="col"
      // aria-sort is what tells assistive tech the current ordering; the arrow
      // icon alone conveys nothing to a screen reader.
      aria-sort={sort ? (sort.active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
      className={cn(
        'px-3 py-2 text-2xs font-semibold tracking-wide text-[var(--color-text-muted)] uppercase',
        numeric && 'text-right',
        sticky && 'sticky left-0 z-10 bg-[var(--color-surface-sunken)]',
        className,
      )}
      {...props}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.onToggle}
          className={cn(
            'inline-flex items-center gap-1 rounded-sm text-2xs font-semibold tracking-wide uppercase transition-colors hover:text-[var(--color-text)]',
            numeric && 'flex-row-reverse',
            sort.active && 'text-[var(--color-text)]',
          )}
        >
          <span>{children}</span>
          <span className="sr-only">{sort.label}</span>
          {sort.active ? (
            sort.direction === 'asc' ? (
              <ArrowUp className="size-3" aria-hidden="true" />
            ) : (
              <ArrowDown className="size-3" aria-hidden="true" />
            )
          ) : (
            <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
          )}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TDProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
  sticky?: boolean;
  /** De-emphasise secondary columns so the primary ones lead the eye. */
  muted?: boolean;
  /** Prevent wrapping for codes, dates and amounts. */
  nowrap?: boolean;
}

export function TD({ className, numeric, sticky, muted, nowrap, ...props }: TDProps) {
  return (
    <td
      data-numeric={numeric || undefined}
      className={cn(
        'px-3 py-2 align-middle',
        numeric && 'text-right',
        muted && 'text-[var(--color-text-muted)]',
        nowrap && 'whitespace-nowrap',
        sticky && 'sticky left-0 z-10 bg-[var(--color-surface)]',
        className,
      )}
      {...props}
    />
  );
}

/** A full-width row used for the empty, loading and error states inside a table. */
export function TableMessageRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        {children}
      </td>
    </tr>
  );
}

/**
 * The primary cell of a row: a bold identifier with a muted secondary line.
 * Used for "Sherzod Usmonov / STU-000412" style cells, which is most tables'
 * first column.
 */
export function PrimaryCell({
  title,
  subtitle,
  href,
  leading,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  href?: string;
  leading?: ReactNode;
}) {
  const body = (
    <span className="flex min-w-0 items-center gap-2">
      {leading}
      <span className="min-w-0">
        <span className="block truncate font-medium text-[var(--color-text)]">{title}</span>
        {subtitle && (
          <span className="block truncate text-2xs text-[var(--color-text-subtle)]">{subtitle}</span>
        )}
      </span>
    </span>
  );

  if (href) {
    return (
      <a href={href} className="group inline-flex min-w-0 hover:underline">
        {body}
      </a>
    );
  }
  return body;
}

/**
 * Row actions. Kept visible rather than revealed on hover: hover-only actions are
 * invisible on touch and undiscoverable by keyboard.
 */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  /** Localised labels; defaults are English fallbacks. */
  labels?: {
    previous?: string;
    next?: string;
    rowsPerPage?: string;
    /** Receives (from, to, total). */
    summary?: (from: number, to: number, total: number) => string;
  };
}

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  labels,
}: PaginationProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const summary =
    labels?.summary?.(from, to, total) ?? `${from}–${to} of ${total}`;

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] px-3 py-2"
    >
      <p className="text-xs text-[var(--color-text-muted)]" data-numeric>
        {summary}
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            {labels?.rowsPerPage ?? 'Rows'}
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="h-7 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-1.5 text-xs"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            {labels?.previous ?? 'Previous'}
          </Button>
          <span className="px-1 text-xs text-[var(--color-text-muted)]" data-numeric>
            {page} / {Math.max(1, totalPages)}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            {labels?.next ?? 'Next'}
          </Button>
        </div>
      </div>
    </nav>
  );
}
