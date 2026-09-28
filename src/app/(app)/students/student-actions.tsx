'use client';

/**
 * Registering a student, and taking one out of circulation.
 *
 * There is no delete. A student carries attendance, grades, invoices and ledger
 * entries, and the database refuses to rewrite the last two at all -- so the
 * only honest operation is to archive, which hides the record from lists and
 * blocks new enrolments while leaving every history intact.
 */

import { ArchiveRestore, Plus, RotateCcw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';
import type { ApiFailure } from '@/server/http/api';

const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'] as const;

export interface BranchOption {
  readonly id: string;
  readonly name: string;
}

interface CreatedStudent {
  readonly id: string;
  readonly studentCode: string;
  readonly fullName: string;
}

export function AddStudentPanel({ branches }: { branches: readonly BranchOption[] }) {
  const t = useTranslator();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [created, setCreated] = useState<CreatedStudent | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [gender, setGender] = useState<(typeof GENDERS)[number]>('UNSPECIFIED');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [branchId, setBranchId] = useState('');

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

    const result = await apiPost<CreatedStudent>('/api/students', {
      firstName,
      lastName,
      middleName: middleName.trim() || undefined,
      dateOfBirth: dateOfBirth || undefined,
      gender,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      branchId: branchId || undefined,
    });

    if (!result.ok) {
      fail(result);
      return;
    }

    setCreated(result.data);
    setOpen(false);
    setFirstName('');
    setLastName('');
    setMiddleName('');
    setDateOfBirth('');
    setPhone('');
    setEmail('');
    setSubmitting(false);
    router.refresh();
  }

  return (
    <div>
      {created && (
        <div
          role="status"
          className="mb-3 flex items-start justify-between gap-3 rounded-md border border-[var(--color-success-border)] bg-[var(--color-success-subtle)] px-3.5 py-2.5"
        >
          <p className="text-xs text-[var(--color-success-text)]">
            {t.t('students.created', { name: created.fullName })}{' '}
            <span className="font-mono">{created.studentCode}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="iconSm"
            onClick={() => setCreated(null)}
            aria-label={t.t('common.close')}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      {!open ? (
        <Button type="button" variant="default" size="sm" onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" />
          {t.t('students.create')}
        </Button>
      ) : (
        <form
          onSubmit={onSubmit}
          noValidate
          className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t.t('students.create')}</h2>
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

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t.t('students.fields.firstName')} error={issues['firstName']} required>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required disabled={submitting} />
            </Field>
            <Field label={t.t('students.fields.lastName')} error={issues['lastName']} required>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} required disabled={submitting} />
            </Field>
            <Field label={t.t('students.fields.middleName')} error={issues['middleName']}>
              <Input value={middleName} onChange={(e) => setMiddleName(e.target.value)} disabled={submitting} />
            </Field>
            <Field label={t.t('students.fields.dateOfBirth')} error={issues['dateOfBirth']}>
              <Input
                type="date"
                value={dateOfBirth}
                onChange={(e) => setDateOfBirth(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label={t.t('students.fields.gender')} error={issues['gender']}>
              <NativeSelect
                value={gender}
                onChange={(e) => setGender(e.target.value as (typeof GENDERS)[number])}
                disabled={submitting}
              >
                {GENDERS.map((value) => (
                  <option key={value} value={value}>
                    {t.t(`enums.Gender.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t.t('students.fields.phone')} error={issues['phone']}>
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+998 90 123 45 67"
                disabled={submitting}
              />
            </Field>
            <Field label={t.t('students.fields.email')} error={issues['email']}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoCapitalize="none"
                disabled={submitting}
              />
            </Field>
            {/* Shown only when there is a choice to make -- and then REQUIRED.
                `resolveWriteBranch` refuses an organisation-scoped caller who
                names no branch, so leaving it optional here just turns a form
                mistake into a 403 the user cannot interpret. */}
            {branches.length > 1 && (
              <Field label={t.t('students.fields.branch')} error={issues['branchId']} required>
                <NativeSelect
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  required
                  disabled={submitting}
                >
                  <option value="">{t.t('common.selectPlaceholder')}</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={submitting || (branches.length > 1 && branchId === '')}
            >
              {submitting ? t.t('common.saving') : t.t('students.create')}
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

export function ArchiveStudentButton({
  studentId,
  name,
  isArchived,
}: {
  studentId: string;
  name: string;
  isArchived: boolean;
}) {
  const t = useTranslator();
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    const result = isArchived
      ? await apiPost(`/api/students/${studentId}/restore`)
      : await apiPost(`/api/students/${studentId}/archive`, { reason, force: false });

    if (!result.ok) {
      setError(failureMessage(t, result));
      setSubmitting(false);
      return;
    }

    setConfirming(false);
    setSubmitting(false);
    setReason('');
    router.refresh();
  }

  if (isArchived) {
    return (
      <Button type="button" variant="ghost" size="xs" onClick={run} disabled={submitting}>
        <RotateCcw aria-hidden="true" />
        {t.t('common.restore')}
      </Button>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-2xs text-[var(--color-danger-text)]">{error}</span>}
        <Button type="button" variant="ghost" size="xs" onClick={() => setConfirming(true)}>
          <ArchiveRestore aria-hidden="true" />
          {t.t('common.archive')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-56 flex-col items-end gap-1.5 text-right">
      <p className="text-2xs font-medium">{t.t('students.archiveTitle')}</p>
      <p className="text-2xs text-[var(--color-text-muted)]">
        {t.t('students.archiveBody', { name })}
      </p>
      {/* A reason is not optional: it is written to the audit log, which is the
          only record of why someone vanished from every list. */}
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t.t('common.reasonPlaceholder')}
        rows={2}
        disabled={submitting}
        aria-label={t.t('common.reason')}
      />
      {error && <span className="text-2xs text-[var(--color-danger-text)]">{error}</span>}
      <div className="flex gap-1">
        <Button
          type="button"
          variant="destructive"
          size="xs"
          onClick={run}
          disabled={submitting || reason.trim().length === 0}
        >
          {submitting ? t.t('common.saving') : t.t('common.archive')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setConfirming(false)}
          disabled={submitting}
        >
          {t.t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
