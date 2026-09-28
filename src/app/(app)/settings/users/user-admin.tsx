'use client';

/**
 * Account provisioning: create a login, or issue a new temporary password for
 * one that exists.
 *
 * Both operations end the same way -- a password the server will never show
 * again. That is why the result panel is loud, stays until dismissed, and offers
 * a copy button: an administrator who navigates away without reading it has to
 * reset the account a second time.
 */

import { Check, Copy, KeyRound, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, NativeSelect } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';
import type { ApiFailure } from '@/server/http/api';

export interface RoleOption {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  /** False when the role sits at or above the caller's own level. */
  readonly editableByCaller: boolean;
}

export interface BranchOption {
  readonly id: string;
  readonly name: string;
}

interface CreatedUser {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly temporaryPassword: string;
}

/** The one-time password panel, shared by both flows. */
function TemporaryPassword({
  heading,
  password,
  onDismiss,
}: {
  heading: string;
  password: string;
  onDismiss: () => void;
}) {
  const t = useTranslator();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright (permissions, insecure origin).
      // The password is on screen either way, so there is nothing to recover
      // from -- only a button that should stop claiming it worked.
      setCopied(false);
    }
  }

  return (
    <div
      role="status"
      className="mb-3 rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-subtle)] px-3.5 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--color-success-text)]">{heading}</p>
          <p className="mt-0.5 text-2xs text-[var(--color-success-text)]">
            {t.t('users.temporaryPasswordHint')}
          </p>
        </div>
        <Button type="button" variant="ghost" size="iconSm" onClick={onDismiss} aria-label={t.t('common.close')}>
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="select-all rounded border border-[var(--color-success-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-sm font-semibold">
          {password}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t.t('common.copied') : t.t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

export function AddUserPanel({
  roles,
  branches,
}: {
  roles: readonly RoleOption[];
  branches: readonly BranchOption[];
}) {
  const t = useTranslator();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [created, setCreated] = useState<CreatedUser | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [branchId, setBranchId] = useState('');

  // A role the caller cannot grant is not offered: the server refuses it anyway,
  // and an option that always fails is worse than an absent one.
  const grantable = roles.filter((role) => role.editableByCaller);

  function fail(failure: ApiFailure) {
    setFormError(failureMessage(t, failure));
    setIssues(fieldIssuesOf(failure));
    setSubmitting(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFormError(null);
    setIssues({});

    const result = await apiPost<CreatedUser>('/api/users', {
      firstName,
      lastName,
      email,
      phone: phone.trim() || undefined,
      roleIds: roleId ? [roleId] : [],
      branchIds: branchId ? [branchId] : [],
      primaryBranchId: branchId || null,
    });

    if (!result.ok) {
      fail(result);
      return;
    }

    setCreated(result.data);
    setOpen(false);
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setRoleId('');
    setBranchId('');
    setSubmitting(false);
    router.refresh();
  }

  return (
    <div>
      {created && (
        <TemporaryPassword
          heading={t.t('users.createdWithPassword', { name: created.fullName })}
          password={created.temporaryPassword}
          onDismiss={() => setCreated(null)}
        />
      )}

      {!open ? (
        <Button type="button" variant="default" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          {t.t('users.create')}
        </Button>
      ) : (
        <form
          onSubmit={onSubmit}
          noValidate
          className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t.t('users.create')}</h2>
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
            <Field label={t.t('users.fields.firstName')} error={issues['firstName']} required>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={submitting} />
            </Field>
            <Field label={t.t('users.fields.lastName')} error={issues['lastName']} required>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={submitting} />
            </Field>
            <Field label={t.t('users.fields.email')} error={issues['email']} required>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoCapitalize="none"
                required
                disabled={submitting}
              />
            </Field>
            <Field label={t.t('users.fields.phone')} error={issues['phone']}>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+998 90 123 45 67"
                disabled={submitting}
              />
            </Field>
            <Field label={t.t('users.fields.roles')} error={issues['roleIds']} required>
              <NativeSelect
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                required
                disabled={submitting}
              >
                <option value="">{t.t('common.selectPlaceholder')}</option>
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t.t('users.fields.branches')} error={issues['branchIds']}>
              <NativeSelect value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={submitting}>
                <option value="">{t.t('users.fields.allBranches')}</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button type="submit" variant="default" size="sm" disabled={submitting}>
              {submitting ? t.t('common.saving') : t.t('users.create')}
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

export function ResetPasswordButton({ userId, name }: { userId: string; name: string }) {
  const t = useTranslator();
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const result = await apiPost<{ temporaryPassword: string; sessionsRevoked: number }>(
      `/api/users/${userId}/reset-password`,
    );

    if (!result.ok) {
      setError(failureMessage(t, result));
      setSubmitting(false);
      setConfirming(false);
      return;
    }

    setPassword(result.data.temporaryPassword);
    setConfirming(false);
    setSubmitting(false);
    router.refresh();
  }

  if (password) {
    return (
      <TemporaryPassword
        heading={t.t('users.resetPasswordDone')}
        password={password}
        onDismiss={() => setPassword(null)}
      />
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-2xs text-[var(--color-danger-text)]">{error}</span>}
        <Button type="button" variant="ghost" size="xs" onClick={() => setConfirming(true)}>
          <KeyRound aria-hidden="true" />
          {t.t('users.resetPassword')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      {/* Naming the person and the consequence, because this ends their sessions. */}
      <p className="text-2xs font-medium">{t.t('users.resetPasswordTitle', { name })}</p>
      <p className="max-w-56 text-2xs text-[var(--color-text-muted)]">{t.t('users.resetPasswordBody')}</p>
      <div className="flex gap-1">
        <Button type="button" variant="destructive" size="xs" onClick={reset} disabled={submitting}>
          {submitting ? t.t('common.saving') : t.t('users.confirmReset')}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => setConfirming(false)} disabled={submitting}>
          {t.t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
