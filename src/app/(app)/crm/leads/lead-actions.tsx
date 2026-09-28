'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormPanel } from '@/components/data/form-panel';
import { useTranslator } from '@/components/i18n/provider';
import { Field, Input, NativeSelect } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';

const SOURCES = [
  'WALK_IN',
  'PHONE_CALL',
  'WEBSITE',
  'INSTAGRAM',
  'TELEGRAM',
  'FACEBOOK',
  'GOOGLE_ADS',
  'REFERRAL',
  'EVENT',
  'PARTNER',
  'OTHER',
] as const;

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export interface Option {
  readonly id: string;
  readonly name: string;
}

/**
 * Mirrors `CreateLeadResult`. Declared here rather than imported because the
 * server type is not reachable from a client bundle -- which means TypeScript
 * cannot check the two agree, so the field names have to be read off the
 * service rather than guessed.
 */
interface CreatedLead {
  readonly id: string;
  /** The service warns rather than refuses when the phone already matches. */
  readonly duplicateWarnings: readonly unknown[];
}

export function AddLeadPanel({ branches }: { branches: readonly Option[] }) {
  const t = useTranslator();
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState<(typeof SOURCES)[number]>('WALK_IN');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('MEDIUM');
  const [branchId, setBranchId] = useState('');

  async function submit() {
    setError(null);
    setIssues({});

    const result = await apiPost<CreatedLead>('/api/crm/leads', {
      firstName,
      lastName: lastName.trim() || undefined,
      phone,
      email: email.trim() || undefined,
      source,
      priority,
      branchId: branchId || undefined,
    });

    if (!result.ok) {
      setError(failureMessage(t, result));
      setIssues(fieldIssuesOf(result));
      return { ok: false };
    }

    const name = [firstName, lastName].filter(Boolean).join(' ');
    setFirstName('');
    setLastName('');
    setPhone('');
    setEmail('');
    router.refresh();

    // A matched phone is a warning, not a failure: the same parent ringing back
    // about a second child is a normal day at a front desk.
    return {
      ok: true,
      message: result.data.duplicateWarnings.length > 0
        ? t.t('leads.duplicateWarning')
        : t.t('leads.created', { name }),
    };
  }

  return (
    <FormPanel label={t.t('leads.create')} onSubmit={submit} error={error}>
      {(disabled) => (
        <>
          <Field label={t.t('leads.fields.firstName')} error={issues['firstName']} required>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              disabled={disabled}
            />
          </Field>
          <Field label={t.t('leads.fields.lastName')} error={issues['lastName']}>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={disabled} />
          </Field>
          <Field label={t.t('leads.fields.phone')} error={issues['phone']} required>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+998 90 123 45 67"
              required
              disabled={disabled}
            />
          </Field>
          <Field label={t.t('leads.fields.email')} error={issues['email']}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              disabled={disabled}
            />
          </Field>
          <Field label={t.t('leads.fields.source')} error={issues['source']}>
            <NativeSelect
              value={source}
              onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}
              disabled={disabled}
            >
              {SOURCES.map((value) => (
                <option key={value} value={value}>
                  {t.t(`enums.LeadSource.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t.t('leads.fields.priority')} error={issues['priority']}>
            <NativeSelect
              value={priority}
              onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}
              disabled={disabled}
            >
              {PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {t.t(`enums.LeadPriority.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {branches.length > 1 && (
            <Field label={t.t('common.branch')} error={issues['branchId']}>
              <NativeSelect
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                disabled={disabled}
              >
                <option value="">{t.t('common.selectPlaceholder')}</option>
                {branches.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
        </>
      )}
    </FormPanel>
  );
}
