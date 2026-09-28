'use client';

/**
 * The interactive edge of every list screen.
 *
 * These write to the URL and nothing else. The page itself is a server component
 * that reads `searchParams` and asks the service for exactly those rows, so a
 * filtered list is shareable, survives a reload, and the back button steps
 * through filter states the way a user expects.
 */

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/field';
import { Pagination } from '@/components/ui/table';

function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  return useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params.toString());

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }

      // Changing a filter invalidates the page number. Page 7 of a narrower
      // result set is usually empty, and an empty page reads as "nothing
      // matches" when the truth is "you are past the end".
      if (!('page' in patch)) next.delete('page');

      const query = next.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [params, pathname, router],
  );
}

export function ListSearch({ placeholder }: { placeholder: string }) {
  const t = useTranslator();
  const params = useSearchParams();
  const write = useParamWriter();
  const current = params.get('q') ?? '';
  const [value, setValue] = useState(current);
  const [syncedTo, setSyncedTo] = useState(current);

  // The URL can change without this input doing it -- a nav click, the back
  // button, a cleared filter -- and the box has to follow. Adjusted during
  // render rather than in an effect: an effect would paint the stale term
  // first and then immediately re-render, which is the cascading-render
  // pattern React warns about.
  if (current !== syncedTo) {
    setSyncedTo(current);
    setValue(current);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    write({ q: value.trim() || undefined });
  }

  return (
    <form onSubmit={onSubmit} role="search" className="flex min-w-0 flex-1 items-center gap-1.5">
      <Input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={t.t('common.search')}
        leadingAddon={<Search className="size-3.5" />}
        className="min-w-0"
      />
      {current && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setValue('');
            write({ q: undefined });
          }}
        >
          <X aria-hidden="true" />
          {t.t('common.clear')}
        </Button>
      )}
    </form>
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/** A single-select URL filter. `anyLabel` is the "no filter" choice, never a value. */
export function ListFilter({
  name,
  label,
  options,
  anyLabel,
}: {
  name: string;
  label: string;
  options: readonly FilterOption[];
  anyLabel?: string;
}) {
  const t = useTranslator();
  const params = useSearchParams();
  const write = useParamWriter();

  return (
    <NativeSelect
      aria-label={label}
      value={params.get(name) ?? ''}
      onChange={(event) => write({ [name]: event.target.value || undefined })}
      className="w-auto"
    >
      <option value="">{anyLabel ?? `${label}: ${t.t('common.all')}`}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Clears every filter this list understands, including the search term. */
export function ClearFilters({ keys }: { keys: readonly string[] }) {
  const t = useTranslator();
  const write = useParamWriter();
  const patch: Record<string, undefined> = { q: undefined };
  for (const key of keys) patch[key] = undefined;

  return (
    <Button type="button" variant="ghost" size="sm" onClick={() => write(patch)}>
      {t.t('common.clearFilters')}
    </Button>
  );
}

export function ListToolbar({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}

export function ListPagination({
  page,
  pageSize,
  total,
  totalPages,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}) {
  const t = useTranslator();
  const write = useParamWriter();

  // One page of results needs no control; rendering a disabled one is noise.
  if (total <= pageSize) return null;

  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      total={total}
      totalPages={totalPages}
      onPageChange={(next) => write({ page: String(next) })}
      onPageSizeChange={(next) => write({ pageSize: String(next), page: undefined })}
      labels={{
        previous: t.t('common.previous'),
        next: t.t('common.next'),
        rowsPerPage: t.t('common.perPage'),
        summary: (from, to, count) =>
          t.t('common.showingRange', { from, to, total: count }),
      }}
    />
  );
}
