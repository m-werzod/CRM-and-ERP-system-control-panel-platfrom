'use client';

/**
 * The disclosure-and-form chrome every "add X" screen repeats.
 *
 * Extracted after the fourth copy, not the first: users, payments and students
 * each grew the same toggle button, the same card, the same close affordance,
 * the same submitting flag and the same double-submit guard. What differs is the
 * fields and what to do with the result, so those stay with the caller and
 * everything else lives here once.
 *
 * `onSubmit` returns the success line to show, or null to show nothing. Throwing
 * is not part of the contract -- `apiPost` does not throw, and a form that
 * crashes on a failed save is worse than one that says so.
 */

import { Plus, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';

export interface FormPanelProps {
  /** Labels the toggle button, the heading and the submit button. */
  readonly label: string;
  /** Runs on submit. Return a confirmation line, or null for a silent success. */
  readonly onSubmit: () => Promise<{ ok: boolean; message?: string | null }>;
  /** Shown above the fields when the last attempt failed. */
  readonly error: string | null;
  /** Disables submit while the form is incomplete in a way the server would reject. */
  readonly canSubmit?: boolean;
  /** The fields. Receives `disabled` so each control can go inert while saving. */
  readonly children: (disabled: boolean) => ReactNode;
}

export function FormPanel({
  label,
  onSubmit,
  error,
  canSubmit = true,
  children,
}: FormPanelProps) {
  const t = useTranslator();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setSuccess(null);

    const result = await onSubmit();

    if (result.ok) {
      setOpen(false);
      setSuccess(result.message ?? null);
    }
    setSubmitting(false);
  }

  return (
    <div>
      {success && (
        <div
          role="status"
          className="mb-3 flex items-start justify-between gap-3 rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-subtle)] px-3.5 py-2.5"
        >
          <p className="text-xs text-[var(--color-success-text)]">{success}</p>
          <Button
            type="button"
            variant="ghost"
            size="iconSm"
            onClick={() => setSuccess(null)}
            aria-label={t.t('common.close')}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      {!open ? (
        <Button type="button" variant="default" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          {label}
        </Button>
      ) : (
        <form
          onSubmit={handleSubmit}
          noValidate
          className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{label}</h2>
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

          <FormError error={error} />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children(submitting)}</div>

          <div className="mt-3 flex items-center gap-2">
            <Button type="submit" variant="default" size="sm" disabled={submitting || !canSubmit}>
              {submitting ? t.t('common.saving') : label}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t.t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
