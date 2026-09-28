'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';
import type { ApiFailure } from '@/server/http/api';

/** Mirrors the two shapes `/api/auth/login` returns. */
type LoginData =
  | { outcome: 'TWO_FACTOR_REQUIRED' }
  | { outcome: 'SUCCESS'; displayName: string; mustChangePassword: boolean };

interface TwoFactorData {
  mustChangePassword: boolean;
}

export interface LoginFormProps {
  /**
   * True when the visitor already holds a partial session: the password step is
   * behind them and only the code is outstanding. Without this the form would
   * open on the credentials step and quietly issue a second session for someone
   * who is already half way in.
   */
  readonly awaitingCodeInitially?: boolean;
}

export function LoginForm({ awaitingCodeInitially = false }: LoginFormProps) {
  const t = useTranslator();
  const router = useRouter();

  const [awaitingCode, setAwaitingCode] = useState(awaitingCodeInitially);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  function fail(failure: ApiFailure) {
    setFormError(failureMessage(t, failure));
    setIssues(fieldIssuesOf(failure));
    setSubmitting(false);
  }

  function enter(mustChangePassword: boolean) {
    // `submitting` is deliberately NOT cleared: the button stays disabled across
    // the navigation, so an impatient second click cannot open a second session.
    router.replace(mustChangePassword ? '/change-password' : '/dashboard');
    // The shell is a server component, so it has to be re-rendered to pick up
    // the session that only exists as of this response.
    router.refresh();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);
    setIssues({});

    if (awaitingCode) {
      const verified = await apiPost<TwoFactorData>('/api/auth/two-factor', { code });
      if (!verified.ok) {
        fail(verified);
        return;
      }
      enter(verified.data.mustChangePassword);
      return;
    }

    const result = await apiPost<LoginData>('/api/auth/login', { email, password, rememberMe });
    if (!result.ok) {
      fail(result);
      return;
    }

    if (result.data.outcome === 'TWO_FACTOR_REQUIRED') {
      setAwaitingCode(true);
      setSubmitting(false);
      return;
    }

    enter(result.data.mustChangePassword);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <FormError error={formError} />

      {awaitingCode ? (
        <Field
          label={t.t('auth.twoFactorCode')}
          hint={t.t('auth.twoFactorHint')}
          error={issues['code']}
          required
        >
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            disabled={submitting}
          />
        </Field>
      ) : (
        <>
          <Field label={t.t('auth.emailOrUsername')} error={issues['email']} required>
            <Input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              // Not type="email": the identifier may be a bare handle, and the
              // browser would refuse to submit "Admin" from an email input.
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              disabled={submitting}
            />
          </Field>

          <Field label={t.t('auth.password')} error={issues['password']} required>
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              disabled={submitting}
            />
          </Field>

          <label className="flex w-fit items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              disabled={submitting}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            {t.t('auth.rememberMe')}
          </label>
        </>
      )}

      <Button type="submit" variant="default" size="lg" block disabled={submitting}>
        {submitting ? t.t('auth.signingIn') : t.t('auth.signIn')}
      </Button>
    </form>
  );
}
