'use client';

import { ArchiveRestore } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormPanel } from '@/components/data/form-panel';
import { useTranslator } from '@/components/i18n/provider';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/field';
import { apiPost, failureMessage, fieldIssuesOf } from '@/lib/api-client';

const LEVELS = [
  'BEGINNER',
  'ELEMENTARY',
  'PRE_INTERMEDIATE',
  'INTERMEDIATE',
  'UPPER_INTERMEDIATE',
  'ADVANCED',
] as const;

export interface Option {
  readonly id: string;
  readonly name: string;
}

export function AddGroupPanel({
  branches,
  programs,
  subjects,
}: {
  branches: readonly Option[];
  programs: readonly Option[];
  subjects: readonly Option[];
}) {
  const t = useTranslator();
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [branchId, setBranchId] = useState('');
  const [programId, setProgramId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [level, setLevel] = useState('');
  const [capacity, setCapacity] = useState('12');
  const [startDate, setStartDate] = useState('');

  const branchRequired = branches.length > 1;

  async function submit() {
    setError(null);
    setIssues({});

    const result = await apiPost<{ id: string; name: string; code: string }>('/api/groups', {
      name,
      code,
      branchId: branchId || undefined,
      programId: programId || undefined,
      subjectId: subjectId || undefined,
      level: level || undefined,
      capacity: capacity || undefined,
      startDate: startDate || undefined,
    });

    if (!result.ok) {
      setError(failureMessage(t, result));
      setIssues(fieldIssuesOf(result));
      return { ok: false };
    }

    setName('');
    setCode('');
    setProgramId('');
    setSubjectId('');
    setStartDate('');
    router.refresh();
    return { ok: true, message: t.t('groups.created', { name: result.data.name }) };
  }

  return (
    <FormPanel
      label={t.t('groups.create')}
      onSubmit={submit}
      error={error}
      canSubmit={!branchRequired || branchId !== ''}
    >
      {(disabled) => (
        <>
          <Field label={t.t('groups.fields.name')} error={issues['name']} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} required disabled={disabled} />
          </Field>
          <Field
            label={t.t('groups.fields.code')}
            hint="ENG-A1-07"
            error={issues['code']}
            required
          >
            <Input value={code} onChange={(e) => setCode(e.target.value)} required disabled={disabled} />
          </Field>
          <Field label={t.t('groups.fields.capacity')} error={issues['capacity']}>
            <Input
              type="number"
              min={1}
              max={500}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              disabled={disabled}
            />
          </Field>
          <Field label={t.t('groups.fields.program')} error={issues['programId']}>
            <NativeSelect value={programId} onChange={(e) => setProgramId(e.target.value)} disabled={disabled}>
              <option value="">{t.t('common.none')}</option>
              {programs.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t.t('groups.fields.subject')} error={issues['subjectId']}>
            <NativeSelect value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={disabled}>
              <option value="">{t.t('common.none')}</option>
              {subjects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t.t('groups.fields.level')} error={issues['level']}>
            <NativeSelect value={level} onChange={(e) => setLevel(e.target.value)} disabled={disabled}>
              <option value="">{t.t('common.none')}</option>
              {LEVELS.map((value) => (
                <option key={value} value={value}>
                  {t.t(`enums.ProgramLevel.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t.t('groups.fields.startDate')} error={issues['startDate']}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={disabled}
            />
          </Field>
          {/* Required when there is a choice: `resolveWriteBranch` refuses an
              organisation-scoped caller who names none. */}
          {branchRequired && (
            <Field label={t.t('groups.fields.branch')} error={issues['branchId']} required>
              <NativeSelect
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                required
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

export function ArchiveGroupButton({ groupId, name }: { groupId: string; name: string }) {
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

    const result = await apiPost(`/api/groups/${groupId}/archive`, { reason });

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
      <p className="text-2xs font-medium">{t.t('groups.archiveTitle', { name })}</p>
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
