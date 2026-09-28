'use client';

/**
 * Take a payment at the desk.
 *
 * Two details carry the correctness of this form:
 *
 * `idempotencyKey` is minted once when the form opens and reused for every
 * attempt of THAT submission. A retry after a timeout therefore reaches the same
 * key and `recordPayment` returns the original payment instead of taking the
 * money twice; the key is only replaced once a payment has actually landed.
 *
 * The amount is sent as the operator typed it, with its currency, and parsed
 * server-side by `moneyInputSchema`. Nothing here converts to minor units --
 * a float in the browser is exactly how a rounding error reaches a ledger.
 */

import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { apiGet, apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';
import type { ApiFailure } from '@/server/http/api';

const METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE', 'CREDIT_NOTE', 'OTHER'] as const;

interface StudentHit {
  readonly id: string;
  readonly fullName: string;
  readonly studentCode: string;
  readonly branchName: string;
}

interface RecordedPayment {
  readonly paymentNumber: string;
  readonly allocations: ReadonlyArray<{
    readonly invoiceNumber: string;
    readonly amountMinor: string;
    readonly remainingBalanceMinor: string;
  }>;
  readonly creditedMinor: string;
  readonly wasAlreadyRecorded: boolean;
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function RecordPaymentPanel({
  currencies,
  defaultCurrency,
}: {
  currencies: readonly string[];
  defaultCurrency: string;
}) {
  const t = useTranslator();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [recorded, setRecorded] = useState<RecordedPayment | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly StudentHit[]>([]);
  const [student, setStudent] = useState<StudentHit | null>(null);

  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  // Survives re-renders and failed attempts; replaced only after money lands.
  const idempotencyKey = useRef(newIdempotencyKey());

  // Debounced lookup. The effect talks to an external system rather than
  // syncing state, which is what an effect is actually for.
  useEffect(() => {
    const term = query.trim();
    // Nothing to fetch, and nothing to clear either: whether the list is shown
    // is decided at render, so the effect never has to reach for setState just
    // to hide it.
    if (student || term.length < 2) return;

    const timer = setTimeout(async () => {
      const result = await apiGet<StudentHit[]>('/api/students', { q: term, limit: '8' });
      setHits(result.ok ? result.data : []);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, student]);

  const term = query.trim();
  const visibleHits = !student && term.length >= 2 ? hits : [];

  function fail(failure: ApiFailure) {
    setFormError(failureMessage(t, failure));
    setIssues(fieldIssuesOf(failure));
    setSubmitting(false);
  }

  function reset() {
    setStudent(null);
    setQuery('');
    setAmount('');
    setReference('');
    setNotes('');
    idempotencyKey.current = newIdempotencyKey();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !student) return;

    setSubmitting(true);
    setFormError(null);
    setIssues({});

    const result = await apiPost<RecordedPayment>('/api/payments', {
      studentId: student.id,
      money: { amount, currency },
      method,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
      idempotencyKey: idempotencyKey.current,
    });

    if (!result.ok) {
      fail(result);
      return;
    }

    setRecorded(result.data);
    setOpen(false);
    setSubmitting(false);
    reset();
    router.refresh();
  }

  return (
    <div>
      {recorded && (
        <div
          role="status"
          className="mb-3 rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-subtle)] px-3.5 py-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-semibold text-[var(--color-success-text)]">
                {recorded.paymentNumber}
              </p>
              {recorded.allocations.length > 0 && (
                <ul className="text-2xs text-[var(--color-success-text)]">
                  {recorded.allocations.map((allocation) => (
                    <li key={allocation.invoiceNumber} className="font-mono">
                      {allocation.invoiceNumber}
                    </li>
                  ))}
                </ul>
              )}
              {/* Overpayment is not an error; it becomes credit, and the person
                  at the desk has to be able to say so to the parent. */}
              {recorded.creditedMinor !== '0' && (
                <p className="text-2xs text-[var(--color-success-text)]">
                  {t.t('payments.fields.unapplied')}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              onClick={() => setRecorded(null)}
              aria-label={t.t('common.close')}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {!open ? (
        <Button type="button" variant="default" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          {t.t('payments.create')}
        </Button>
      ) : (
        <form
          onSubmit={onSubmit}
          noValidate
          className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t.t('payments.create')}</h2>
            <Button
              type="button"
              variant="ghost"
              size="iconSm"
              onClick={() => setOpen(false)}
              aria-label={t.t('common.cancel')}
            >
              <X aria-hidden="true" />
            </Button>
          </div>

          <FormError error={formError} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t.t('payments.fields.student')}
              error={issues['studentId']}
              hint={student ? `${student.studentCode} · ${student.branchName}` : undefined}
              required
              className="sm:col-span-2"
            >
              {student ? (
                <div className="flex items-center gap-2">
                  <Input value={student.fullName} readOnly />
                  <Button type="button" variant="ghost" size="sm" onClick={() => setStudent(null)}>
                    {t.t('common.clear')}
                  </Button>
                </div>
              ) : (
                <>
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t.t('students.searchPlaceholder')}
                    autoComplete="off"
                    disabled={submitting}
                  />
                  {visibleHits.length > 0 && (
                    <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {visibleHits.map((hit) => (
                        <li key={hit.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setStudent(hit);
                              setHits([]);
                            }}
                            className="flex w-full items-baseline justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-border-focus)]"
                          >
                            <span>{hit.fullName}</span>
                            <span className="font-mono text-2xs text-[var(--color-text-subtle)]">
                              {hit.studentCode}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Field>

            <Field label={t.t('payments.fields.amount')} error={issues['money.amount']} required>
              <Input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
                placeholder="750000"
                required
                disabled={submitting}
              />
            </Field>

            <Field label={t.t('payments.fields.currency')} error={issues['money.currency']} required>
              <NativeSelect
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                disabled={submitting}
              >
                {currencies.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field label={t.t('payments.fields.method')} error={issues['method']} required>
              <NativeSelect
                value={method}
                onChange={(event) => setMethod(event.target.value as (typeof METHODS)[number])}
                disabled={submitting}
              >
                {METHODS.map((value) => (
                  <option key={value} value={value}>
                    {t.t(`enums.PaymentMethod.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <Field label={t.t('payments.fields.reference')} error={issues['reference']}>
              <Input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                disabled={submitting}
              />
            </Field>

            <Field label={t.t('payments.fields.note')} error={issues['notes']} className="sm:col-span-2">
              <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={submitting} />
            </Field>
          </div>

          <p className="mt-2 text-2xs text-[var(--color-text-subtle)]">
            {t.t('payments.allocateAuto')}
          </p>

          <div className="mt-3 flex items-center gap-2">
            <Button type="submit" variant="default" size="sm" disabled={submitting || !student}>
              {submitting ? t.t('payments.recording') : t.t('payments.record')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={submitting}>
              {t.t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
