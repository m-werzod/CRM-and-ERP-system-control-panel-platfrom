'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';

interface ChangePasswordData {
  /** Other devices signed out as a consequence; worth telling the user about. */
  revokedSessions: number;
}

/**
 * Shared by the forced-change screen and the settings panel, because they are
 * the same operation against the same endpoint. The only difference is where
 * the user goes afterwards, which is what `redirectTo` decides.
 */
export function PasswordChangeForm({ redirectTo }: { redirectTo?: string }) {
  const t = useTranslator();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);
    setSucceeded(false);
    setIssues({});

    const result = await apiPost<ChangePasswordData>('/api/auth/change-password', {
      currentPassword,
      newPassword,
      confirmPassword,
    });

    if (!result.ok) {
      setFormError(failureMessage(t, result));
      setIssues(fieldIssuesOf(result));
      setSubmitting(false);
      return;
    }

    if (redirectTo) {
      // Left disabled through the navigation, as on the sign-in form.
      router.replace(redirectTo);
      router.refresh();
      return;
    }

    // Clearing the fields matters: a filled password form left on screen is an
    // invitation to a passer-by, and there is nothing left to resubmit.
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setSucceeded(true);
    setSubmitting(false);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-sm space-y-3">
      <FormError error={formError} />

      {succeeded && (
        <p
          role="status"
          className="rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-subtle)] px-3 py-2 text-xs text-[var(--color-success-text)]"
        >
          {t.t('auth.passwordChanged')}
        </p>
      )}

      <Field label={t.t('auth.currentPassword')} error={issues['currentPassword']} required>
        <Input
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          required
          disabled={submitting}
        />
      </Field>

      <Field
        label={t.t('auth.newPassword')}
        hint={t.t('validation.passwordTooWeak', { min: 10 })}
        error={issues['newPassword']}
        required
      >
        <Input
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          required
          disabled={submitting}
        />
      </Field>

      <Field label={t.t('auth.confirmPassword')} error={issues['confirmPassword']} required>
        <Input
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          autoComplete="new-password"
          required
          disabled={submitting}
        />
      </Field>

      <Button type="submit" variant="default" disabled={submitting}>
        {submitting ? t.t('common.saving') : t.t('auth.changePassword')}
      </Button>
    </form>
  );
}
