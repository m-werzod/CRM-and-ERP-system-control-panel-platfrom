/**
 * Biometric attendance: enrolment, consent, and face-driven marking.
 *
 * Three rules shape every function in this file and none of them is negotiable.
 *
 * 1. NO BIOMETRIC DATA IS STORED. `enrollBiometrics` hands the image straight to
 *    the provider and keeps only the opaque `externalRef` it returns plus the
 *    provider key. No image, no embedding, no template reaches this database.
 *    `externalRef` is also kept out of audit rows and log lines: it is the one
 *    handle that can pull a template back out of the provider, so it belongs in
 *    exactly one column and nowhere else.
 *
 * 2. CONSENT IS A PRECONDITION. Enrolment without a live, unrevoked consent row
 *    is refused, and for a child the consent must have been granted by a
 *    guardian. `evaluateConsent` holds that rule once so the enrolment path and
 *    the status screen cannot disagree about it.
 *
 * 3. EVERY RECOGNITION ATTEMPT IS RECORDED, including the ones that identified
 *    nobody, and exactly one outcome may become an attendance record.
 *    `identifyAndMark` returns a discriminated union so "not recognised", "too
 *    blurry", "two people matched" and "no provider configured" arrive at the UI
 *    as four different answers rather than one silent failure. A simulating
 *    provider is reported as simulating -- see `getBiometricStatus`.
 *
 * Marking funnels through `markAttendance` exactly like a teacher's tap, so the
 * (lessonId, studentId) unique index, the late-threshold rule and the audit entry
 * apply identically to a face scan. There is no second insert path.
 */

import type {
  AttendanceStatus,
  BiometricSubjectType,
  FaceRecognitionResult,
  Prisma,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BadRequestError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  organizationFilter,
  requirePermission,
  scopeFilter,
  teacherLessonFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import { env } from '@/server/env';
import {
  describeFaceProvider,
  getFaceProvider,
  type FaceIdentifyResult,
  type FaceProviderStatus,
} from '@/server/integrations/face';
import {
  ageInYears,
  endOfDayExclusiveInstant,
  prismaDateToDateOnly,
  startOfDayInstant,
  todayIn,
  type DateOnly,
} from '@/lib/dates';
import { markAttendance, statusFromArrival } from '@/server/services/attendance/mark';
// A face terminal is a kind of attendance device, so the "which lesson does this
// observation belong to" rule is reused from there rather than copied.
import { findLessonForObservation } from '@/server/services/attendance/device';

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

interface ResolvedSubject {
  readonly subjectType: BiometricSubjectType;
  readonly subjectId: string;
  readonly branchId: string;
  readonly label: string;
  /** Students only; `null` when no date of birth is on file. */
  readonly dateOfBirth: DateOnly | null;
}

/**
 * Resolve the person being enrolled, with the caller's scope in the SAME where
 * clause. Fetching first and checking the branch afterwards would answer "that
 * student exists but is not yours", which is enough to enumerate another branch's
 * roster.
 */
async function resolveSubject(
  ctx: AccessContext,
  db: Db,
  input: { subjectType: BiometricSubjectType; studentId?: string | null; employeeId?: string | null },
): Promise<ResolvedSubject> {
  if (input.subjectType === 'STUDENT') {
    if (!input.studentId) {
      throw new BadRequestError('A student must be identified for a student biometric enrolment.');
    }
    const student = await db.student.findFirst({
      where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
      select: { id: true, branchId: true, firstName: true, lastName: true, dateOfBirth: true },
    });
    if (!student) throw new NotFoundError('Student', input.studentId);
    return {
      subjectType: 'STUDENT',
      subjectId: student.id,
      branchId: student.branchId,
      label: `${student.firstName} ${student.lastName}`,
      dateOfBirth: student.dateOfBirth ? prismaDateToDateOnly(student.dateOfBirth) : null,
    };
  }

  if (!input.employeeId) {
    throw new BadRequestError('An employee must be identified for a staff biometric enrolment.');
  }
  const employee = await db.employee.findFirst({
    where: { id: input.employeeId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      branchId: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });
  if (!employee) throw new NotFoundError('Employee', input.employeeId);
  return {
    subjectType: 'EMPLOYEE',
    subjectId: employee.id,
    branchId: employee.branchId,
    label: `${employee.user.firstName} ${employee.user.lastName}`,
    // Staff consent is given by the person themselves, so their age is irrelevant.
    dateOfBirth: null,
  };
}

/**
 * The subject of a consent row, for display and for the branch the audit entry is
 * filed under. Unlike `resolveSubject` this tolerates an archived person, because
 * withdrawing consent must not stop working when a student leaves.
 */
async function findConsentSubject(
  ctx: AccessContext,
  db: Db,
  subjectType: BiometricSubjectType,
  subjectId: string,
): Promise<{ branchId: string; label: string } | null> {
  if (subjectType === 'STUDENT') {
    const student = await db.student.findFirst({
      where: { id: subjectId, ...scopeFilter(ctx) },
      select: { branchId: true, firstName: true, lastName: true },
    });
    return student
      ? { branchId: student.branchId, label: `${student.firstName} ${student.lastName}` }
      : null;
  }

  const employee = await db.employee.findFirst({
    where: { id: subjectId, ...scopeFilter(ctx) },
    select: { branchId: true, user: { select: { firstName: true, lastName: true } } },
  });
  return employee
    ? {
        branchId: employee.branchId,
        label: `${employee.user.firstName} ${employee.user.lastName}`,
      }
    : null;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

interface ConsentRow {
  readonly id: string;
  readonly grantedByGuardianId: string | null;
  readonly grantedByUserId: string | null;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

export type ConsentDecision =
  | { readonly ok: true; readonly requiresGuardianConsent: boolean }
  | {
      readonly ok: false;
      readonly requiresGuardianConsent: boolean;
      readonly rule: string;
      readonly message: string;
    };

/**
 * The single consent rule, expressed once.
 *
 * Two of its branches are deliberately stricter than the settings suggest:
 *
 *  * an unknown date of birth counts as "possibly a child". Guessing the other way
 *    would let a missing field decide whether a minor's face may be enrolled.
 *  * the guardian requirement holds even when `security.requireBiometricConsent`
 *    is off. That switch is an institution's policy about adults; enrolling a
 *    child's face with no recorded guardian consent is not a policy question.
 */
export function evaluateConsent(input: {
  readonly subjectType: BiometricSubjectType;
  /** `null` when the subject is a student with no date of birth on file. */
  readonly ageYears: number | null;
  readonly consent: ConsentRow | null;
  readonly requireConsent: boolean;
  readonly guardianConsentUnderAge: number;
}): ConsentDecision {
  const live = input.consent && input.consent.revokedAt === null ? input.consent : null;

  const guardianRuleApplies =
    input.subjectType === 'STUDENT' &&
    input.guardianConsentUnderAge > 0 &&
    (input.ageYears === null || input.ageYears < input.guardianConsentUnderAge);

  if (!live && (input.requireConsent || guardianRuleApplies)) {
    return {
      ok: false,
      requiresGuardianConsent: guardianRuleApplies,
      rule: 'biometrics.consent_required',
      message:
        'Biometric enrolment requires a recorded, unrevoked consent for this person. Record the consent first.',
    };
  }

  if (guardianRuleApplies && live && !live.grantedByGuardianId) {
    return {
      ok: false,
      requiresGuardianConsent: true,
      rule:
        input.ageYears === null
          ? 'biometrics.age_unknown'
          : 'biometrics.guardian_consent_required',
      message:
        input.ageYears === null
          ? 'This student has no date of birth on file, so guardian consent is required and the recorded consent was not given by a guardian. Add the date of birth or record a guardian consent.'
          : `Students under ${input.guardianConsentUnderAge} need biometric consent from a guardian; the recorded consent was not given by one.`,
    };
  }

  return { ok: true, requiresGuardianConsent: guardianRuleApplies };
}

/** The consent that would back an enrolment: a specific one, or the newest live one. */
async function findConsent(
  ctx: AccessContext,
  db: Db,
  subject: ResolvedSubject,
  consentId?: string | null,
): Promise<ConsentRow | null> {
  const consent = await db.biometricConsent.findFirst({
    where: {
      ...organizationFilter(ctx),
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      ...(consentId ? { id: consentId } : { revokedAt: null }),
    },
    orderBy: { grantedAt: 'desc' },
    select: {
      id: true,
      grantedByGuardianId: true,
      grantedByUserId: true,
      grantedAt: true,
      revokedAt: true,
    },
  });
  if (consentId && !consent) throw new NotFoundError('Biometric consent', consentId);
  return consent;
}

async function loadConsentPolicy(
  ctx: AccessContext,
  db: Db,
  branchId: string | null,
): Promise<{ requireConsent: boolean; guardianConsentUnderAge: number; timezone: string }> {
  const settings = await getSettings(
    ['requireBiometricConsent', 'biometricGuardianConsentUnderAge', 'timezone'],
    { organizationId: ctx.organizationId, branchId },
    db,
  );
  return {
    requireConsent: settings.requireBiometricConsent,
    guardianConsentUnderAge: settings.biometricGuardianConsentUnderAge,
    timezone: settings.timezone,
  };
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export interface EnrollBiometricsInput {
  readonly subjectType: BiometricSubjectType;
  readonly studentId?: string | null;
  readonly employeeId?: string | null;
  readonly image: Uint8Array;
  readonly contentType: string;
  /** When omitted, the newest live consent for the subject is used. */
  readonly consentId?: string | null;
}

export interface BiometricEnrollmentResult {
  readonly id: string;
  readonly subjectType: BiometricSubjectType;
  readonly subjectId: string;
  readonly provider: string;
  readonly status: 'ACTIVE';
  readonly consentId: string | null;
  /** False when the provider only simulates recognition. Surface it, do not hide it. */
  readonly isRealRecognition: boolean;
}

/**
 * Enrol a face against the configured provider.
 *
 * The provider call happens BEFORE the transaction opens: it is network I/O, and
 * holding a transaction open across a vendor round trip is how a busy terminal
 * exhausts the pool. If the row cannot then be written, the provider-side
 * template is deleted again -- an enrolment nothing in this system references is
 * exactly the orphan the schema comment warns about.
 *
 * Image format and size are enforced by the provider boundary
 * (`assertUsableFaceImage`), not here, so every driver rejects the same inputs and
 * the development simulator keeps accepting its control envelope.
 */
export async function enrollBiometrics(
  ctx: AccessContext,
  input: EnrollBiometricsInput,
  db?: Db,
): Promise<BiometricEnrollmentResult> {
  requirePermission(ctx, 'attendance.enrollBiometrics');

  const client = db ?? prisma;
  const subject = await resolveSubject(ctx, client, input);
  assertBranchAccess(ctx, subject.branchId, 'biometric enrolment');

  const policy = await loadConsentPolicy(ctx, client, subject.branchId);
  const consent = await findConsent(ctx, client, subject, input.consentId);
  const ageYears = subject.dateOfBirth
    ? ageInYears(subject.dateOfBirth, todayIn(policy.timezone))
    : null;

  const decision = evaluateConsent({
    subjectType: subject.subjectType,
    ageYears,
    consent,
    requireConsent: policy.requireConsent,
    guardianConsentUnderAge: policy.guardianConsentUnderAge,
  });
  if (!decision.ok) {
    throw new BusinessRuleError(decision.rule, decision.message, {
      details: { subjectType: subject.subjectType, subjectId: subject.subjectId },
    });
  }

  const existing = await client.biometricEnrollment.findFirst({
    where: {
      ...organizationFilter(ctx),
      subjectType: subject.subjectType,
      ...(subject.subjectType === 'STUDENT'
        ? { studentId: subject.subjectId }
        : { employeeId: subject.subjectId }),
      status: { in: ['ACTIVE', 'PENDING'] },
    },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(
      `${subject.label} already has a biometric enrolment. Revoke it before enrolling again.`,
      { details: { enrollmentId: existing.id } },
    );
  }

  const provider = getFaceProvider();
  const { externalRef } = await provider.enroll({
    subjectRef: subject.subjectId,
    image: input.image,
    contentType: input.contentType,
  });

  try {
    return await withTransaction(
      async (tx) => {
        const row = await tx.biometricEnrollment.create({
          data: {
            organizationId: ctx.organizationId,
            subjectType: subject.subjectType,
            studentId: subject.subjectType === 'STUDENT' ? subject.subjectId : null,
            employeeId: subject.subjectType === 'EMPLOYEE' ? subject.subjectId : null,
            provider: provider.key,
            externalRef,
            status: 'ACTIVE',
            consentId: consent?.id ?? null,
            enrolledById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true },
        });

        await recordAudit(
          ctx,
          {
            action: AUDIT_ACTIONS.BIOMETRIC_ENROLLED,
            entityType: 'BiometricEnrollment',
            entityId: row.id,
            branchId: subject.branchId,
            summary: `Biometric enrolment created for ${subject.label}`,
            // NOTICE: a biometric enrolment must never be traceable only through
            // application logs. `externalRef` is deliberately absent -- see the
            // file header.
            severity: 'NOTICE',
            metadata: {
              provider: provider.key,
              isRealRecognition: provider.isRealRecognition,
              consentId: consent?.id ?? null,
              guardianConsent: Boolean(consent?.grantedByGuardianId),
            },
            timeline: {
              subjectType: subject.subjectType,
              subjectId: subject.subjectId,
              type: 'attendance.biometric.enrolled',
              title: 'Biometric enrolment recorded',
              description: provider.isRealRecognition
                ? `Enrolled with ${provider.key}.`
                : `Enrolled with the ${provider.key} provider, which simulates recognition and performs none.`,
            },
          },
          tx,
        );

        return {
          id: row.id,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          provider: provider.key,
          status: 'ACTIVE' as const,
          consentId: consent?.id ?? null,
          isRealRecognition: provider.isRealRecognition,
        };
      },
      { existing: db },
    );
  } catch (error) {
    // The template exists at the provider but nothing here points at it. Leaving
    // it would be an untracked copy of someone's biometrics.
    await provider.deleteEnrollment(externalRef).catch((cleanupError: unknown) => {
      logger.error('face.enrollment_orphaned', {
        requestId: ctx.requestId,
        organizationId: ctx.organizationId,
        provider: provider.key,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        error: cleanupError,
      });
    });
    throw error;
  }
}

export interface RevokeBiometricEnrollmentInput {
  readonly enrollmentId: string;
  readonly reason?: string | null;
}

/**
 * Revoke an enrolment, deleting the provider-side template first.
 *
 * The order is the whole point: the row is only marked REVOKED once the provider
 * has confirmed the template is gone. Marking first and deleting afterwards would
 * let a provider failure leave this application telling a person their face had
 * been deleted while a live template remained.
 */
export async function revokeBiometricEnrollment(
  ctx: AccessContext,
  input: RevokeBiometricEnrollmentInput,
  db?: Db,
): Promise<{ id: string; status: 'REVOKED' }> {
  requirePermission(ctx, 'attendance.enrollBiometrics');

  const client = db ?? prisma;

  // BiometricEnrollment carries no branchId, so scope travels through the
  // subject's own row -- in the same where clause, not as a later check.
  const enrollment = await client.biometricEnrollment.findFirst({
    where: {
      id: input.enrollmentId,
      ...organizationFilter(ctx),
      OR: [{ student: scopeFilter(ctx) }, { employee: scopeFilter(ctx) }],
    },
    select: {
      id: true,
      provider: true,
      externalRef: true,
      status: true,
      subjectType: true,
      studentId: true,
      employeeId: true,
      student: { select: { branchId: true, firstName: true, lastName: true } },
      employee: {
        select: { branchId: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (!enrollment) throw new NotFoundError('Biometric enrolment', input.enrollmentId);
  if (enrollment.status === 'REVOKED') {
    throw new StateInvalidError('biometric enrolment', 'revoked', 'revoked');
  }

  const provider = getFaceProvider();
  if (enrollment.provider !== provider.key) {
    // Handing one provider's reference to another would at best fail and at worst
    // delete an unrelated template.
    throw new ConflictError(
      `This enrolment belongs to the "${enrollment.provider}" provider, but "${provider.key}" is configured. Restore that provider to complete the deletion.`,
      { details: { enrolledWith: enrollment.provider, configured: provider.key } },
    );
  }

  await provider.deleteEnrollment(enrollment.externalRef);

  const branchId = enrollment.student?.branchId ?? enrollment.employee?.branchId ?? null;
  const label = enrollment.student
    ? `${enrollment.student.firstName} ${enrollment.student.lastName}`
    : enrollment.employee
      ? `${enrollment.employee.user.firstName} ${enrollment.employee.user.lastName}`
      : 'this person';
  const subjectId = enrollment.studentId ?? enrollment.employeeId;

  return withTransaction(
    async (tx) => {
      await tx.biometricEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedById: ctx.isSystem ? null : ctx.userId,
          failureReason: input.reason ?? null,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.BIOMETRIC_REVOKED,
          entityType: 'BiometricEnrollment',
          entityId: enrollment.id,
          branchId,
          summary: `Biometric enrolment revoked for ${label}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: { provider: enrollment.provider, providerTemplateDeleted: true },
          timeline: subjectId
            ? {
                subjectType: enrollment.subjectType,
                subjectId,
                type: 'attendance.biometric.revoked',
                title: 'Biometric enrolment revoked',
                description: input.reason ?? 'The provider-side template was deleted.',
              }
            : null,
        },
        tx,
      );

      return { id: enrollment.id, status: 'REVOKED' as const };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Consent records
// ---------------------------------------------------------------------------

export interface GrantConsentInput {
  readonly subjectType: BiometricSubjectType;
  readonly studentId?: string | null;
  readonly employeeId?: string | null;
  readonly purpose: string;
  /** The guardian giving consent for a student. Required for a minor. */
  readonly grantedByGuardianId?: string | null;
  /** The user giving consent for themselves (staff, or an adult student). */
  readonly grantedByUserId?: string | null;
  /** Signed consent form, when one was collected. */
  readonly documentId?: string | null;
}

export interface ConsentResult {
  readonly id: string;
  readonly subjectType: BiometricSubjectType;
  readonly subjectId: string;
  readonly grantedAt: Date;
  readonly grantedByGuardianId: string | null;
  readonly grantedByUserId: string | null;
}

/**
 * Record biometric consent.
 *
 * A guardian is accepted only when they are actually linked to the student: a
 * consent row naming an unrelated adult looks valid in every list and proves
 * nothing, which is worse than no consent at all.
 *
 * The IP is stored on the row, not only in the audit log, because a consent
 * record is the artefact a regulator asks to see.
 */
export async function grantConsent(
  ctx: AccessContext,
  input: GrantConsentInput,
  db?: Db,
): Promise<ConsentResult> {
  requirePermission(ctx, 'attendance.enrollBiometrics');

  const client = db ?? prisma;
  const subject = await resolveSubject(ctx, client, input);
  assertBranchAccess(ctx, subject.branchId, 'biometric consent');

  if (input.purpose.trim().length < 5) {
    throw new BusinessRuleError(
      'biometrics.consent_purpose_required',
      'A consent record must say what the biometric data will be used for.',
    );
  }
  if (!input.grantedByGuardianId && !input.grantedByUserId) {
    throw new BadRequestError('A consent record must name who gave the consent.');
  }

  if (input.grantedByGuardianId) {
    if (subject.subjectType !== 'STUDENT') {
      throw new BadRequestError('Guardian consent only applies to a student.');
    }
    const link = await client.studentGuardian.findFirst({
      where: { studentId: subject.subjectId, guardianId: input.grantedByGuardianId },
      select: { id: true },
    });
    if (!link) {
      throw new BusinessRuleError(
        'biometrics.guardian_not_linked',
        'That guardian is not linked to this student, so they cannot give consent for them.',
      );
    }
  }

  return withTransaction(
    async (tx) => {
      const consent = await tx.biometricConsent.create({
        data: {
          organizationId: ctx.organizationId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          purpose: input.purpose.trim(),
          grantedByGuardianId: input.grantedByGuardianId ?? null,
          grantedByUserId: input.grantedByUserId ?? null,
          documentId: input.documentId ?? null,
          ipAddress: ctx.ipAddress,
        },
        select: {
          id: true,
          grantedAt: true,
          grantedByGuardianId: true,
          grantedByUserId: true,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_GRANTED,
          entityType: 'BiometricConsent',
          entityId: consent.id,
          branchId: subject.branchId,
          summary: `Biometric consent recorded for ${subject.label}`,
          // NOTICE rather than INFO: consent is the legal basis for every later
          // recognition event, so its creation must survive log rotation.
          severity: 'NOTICE',
          metadata: {
            purpose: input.purpose.trim(),
            byGuardian: Boolean(input.grantedByGuardianId),
            documentId: input.documentId ?? null,
          },
          timeline: {
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            type: 'attendance.biometric.consent_granted',
            title: 'Biometric consent recorded',
            description: input.purpose.trim(),
          },
        },
        tx,
      );

      return {
        id: consent.id,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        grantedAt: consent.grantedAt,
        grantedByGuardianId: consent.grantedByGuardianId,
        grantedByUserId: consent.grantedByUserId,
      };
    },
    { existing: db },
  );
}

export interface RevokeConsentInput {
  readonly consentId: string;
  readonly reason: string;
}

/**
 * Withdraw consent, and with it every enrolment it authorised.
 *
 * The provider deletions run BEFORE the consent row is updated, and a failure
 * aborts the whole thing. That ordering keeps the invariant a person actually
 * cares about -- "consent withdrawn means no live template" -- true at every
 * instant. Recording the withdrawal while a template survived would be a lie the
 * UI would then repeat.
 */
export async function revokeConsent(
  ctx: AccessContext,
  input: RevokeConsentInput,
  db?: Db,
): Promise<{ id: string; revokedEnrollmentIds: readonly string[] }> {
  requirePermission(ctx, 'attendance.enrollBiometrics');

  const client = db ?? prisma;
  const consent = await client.biometricConsent.findFirst({
    where: { id: input.consentId, ...organizationFilter(ctx) },
    select: {
      id: true,
      subjectType: true,
      subjectId: true,
      revokedAt: true,
      enrollments: {
        where: { status: { in: ['ACTIVE', 'PENDING'] } },
        select: { id: true, provider: true, externalRef: true },
      },
    },
  });
  if (!consent) throw new NotFoundError('Biometric consent', input.consentId);
  if (consent.revokedAt) {
    throw new StateInvalidError('biometric consent', 'already withdrawn', 'withdrawn');
  }
  if (input.reason.trim().length < 5) {
    throw new BusinessRuleError(
      'biometrics.revoke_reason_required',
      'Withdrawing consent must record why.',
    );
  }

  // Looked up leniently: an archived student must still be able to have their
  // consent withdrawn, so `deletedAt` does not block it. Scope still does -- a
  // consent whose subject is outside the caller's branches reads as not found,
  // because `BiometricConsent` carries no branch of its own.
  const subject = await findConsentSubject(ctx, client, consent.subjectType, consent.subjectId);
  if (!subject) throw new NotFoundError('Biometric consent', input.consentId);

  const provider = getFaceProvider();
  for (const enrollment of consent.enrollments) {
    if (enrollment.provider !== provider.key) {
      throw new ConflictError(
        `An enrolment backed by this consent belongs to the "${enrollment.provider}" provider, but "${provider.key}" is configured. Restore that provider so the template can actually be deleted.`,
        { details: { enrollmentId: enrollment.id, enrolledWith: enrollment.provider } },
      );
    }
    await provider.deleteEnrollment(enrollment.externalRef);
  }

  const revokedAt = new Date();
  const enrollmentIds = consent.enrollments.map((row) => row.id);

  return withTransaction(
    async (tx) => {
      await tx.biometricConsent.update({
        where: { id: consent.id },
        data: { revokedAt, revokeReason: input.reason.trim(), ipAddress: ctx.ipAddress },
      });

      if (enrollmentIds.length > 0) {
        await tx.biometricEnrollment.updateMany({
          where: { id: { in: enrollmentIds } },
          data: {
            status: 'REVOKED',
            revokedAt,
            revokedById: ctx.isSystem ? null : ctx.userId,
            failureReason: 'Consent withdrawn',
          },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_REVOKED,
          entityType: 'BiometricConsent',
          entityId: consent.id,
          branchId: subject.branchId,
          summary: `Biometric consent withdrawn for ${subject.label}${
            enrollmentIds.length > 0 ? `, ${enrollmentIds.length} enrolment(s) revoked` : ''
          }`,
          reason: input.reason.trim(),
          severity: 'NOTICE',
          metadata: { revokedEnrollments: enrollmentIds.length, provider: provider.key },
          timeline: {
            subjectType: consent.subjectType,
            subjectId: consent.subjectId,
            type: 'attendance.biometric.consent_revoked',
            title: 'Biometric consent withdrawn',
            description: input.reason.trim(),
          },
        },
        tx,
      );

      return { id: consent.id, revokedEnrollmentIds: enrollmentIds };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Identify and mark
// ---------------------------------------------------------------------------

export interface IdentifyAndMarkInput {
  readonly image: Uint8Array;
  readonly contentType: string;
  /** The lesson being marked. Required unless a device implies it. */
  readonly lessonId?: string | null;
  /** A terminal's own id; the lesson is then resolved from its branch and the clock. */
  readonly deviceId?: string | null;
  /** When the person stood in front of the camera. Defaults to now. */
  readonly observedAt?: Date;
}

interface FaceOutcomeContext {
  readonly eventId: string;
  readonly lessonId: string;
  readonly provider: string;
  /**
   * False when the configured provider simulates results. Every screen showing a
   * face-captured record reads this; it is never inferred from the provider key.
   */
  readonly isRealRecognition: boolean;
  /** The confidence an automatic mark required, so a decision can be reproduced. */
  readonly thresholdPpm: number;
}

/**
 * Every way a scan can end. A union rather than a nullable success object: the UI
 * must be unable to render "not recognised" as a tick, and a caller cannot read a
 * `studentId` off an outcome that never identified anybody.
 */
export type FaceOutcomeDetail =
  | {
      readonly outcome: 'MARKED';
      readonly studentId: string;
      readonly status: AttendanceStatus;
      readonly minutesLate: number | null;
      readonly confidencePpm: number;
      /** True when a record already existed; the scan changed nothing. */
      readonly alreadyMarked: boolean;
    }
  | {
      readonly outcome: 'LOW_CONFIDENCE';
      /** Offered for a human confirmation step. Never auto-accepted. */
      readonly studentId: string | null;
      readonly confidencePpm: number;
    }
  | { readonly outcome: 'NO_MATCH' }
  | { readonly outcome: 'MULTIPLE_MATCHES'; readonly candidateCount: number }
  | { readonly outcome: 'NOT_ENROLLED' }
  /** The provider returned somebody who is not on this lesson's roster. */
  | { readonly outcome: 'NOT_ON_ROSTER' }
  | { readonly outcome: 'ERROR'; readonly errorCode: string; readonly errorMessage: string }
  | { readonly outcome: 'NOT_CONFIGURED'; readonly reason: string };

export type FaceAttendanceOutcome = FaceOutcomeContext & FaceOutcomeDetail;

interface LessonForMarking {
  readonly id: string;
  readonly branchId: string;
  readonly groupId: string;
  readonly lessonDate: Date;
  readonly startsAt: Date;
}

/** Fetch the lesson with permission scope in the same where clause. */
async function loadMarkableLesson(
  ctx: AccessContext,
  db: Db,
  lessonId: string,
): Promise<LessonForMarking> {
  const lesson = await db.lesson.findFirst({
    where: {
      id: lessonId,
      // The sanctioned composition: tenancy, branch scope, and -- for a teacher
      // without `attendance.viewAll` -- only their own lessons.
      ...composeReadFilter(ctx, {
        selfFilter: teacherLessonFilter(ctx),
        escapeHatch: 'attendance.viewAll',
      }),
    },
    select: { id: true, branchId: true, groupId: true, lessonDate: true, startsAt: true },
  });
  if (!lesson) throw new NotFoundError('Lesson', lessonId);
  return lesson;
}

/**
 * Recognise a face and, on exactly one outcome, mark attendance.
 *
 * The candidate set is narrowed to the lesson's roster before the provider is
 * called. That is the cheapest available reduction in false-positive rate, and a
 * false positive here means attributing a lesson to the wrong child.
 */
export async function identifyAndMark(
  ctx: AccessContext,
  input: IdentifyAndMarkInput,
  db?: Db,
): Promise<FaceAttendanceOutcome> {
  requirePermission(ctx, 'attendance.mark');

  const client = db ?? prisma;
  const observedAt = input.observedAt ?? new Date();

  let deviceId: string | null = null;
  let lessonId = input.lessonId ?? null;

  if (input.deviceId) {
    const device = await client.attendanceDevice.findFirst({
      where: { id: input.deviceId, ...scopeFilter(ctx), deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!device) throw new NotFoundError('Attendance device', input.deviceId);
    deviceId = device.id;

    if (!lessonId) {
      const resolved = await findLessonForObservation(client, {
        organizationId: ctx.organizationId,
        branchId: device.branchId,
        observedAt,
      });
      if (!resolved) {
        throw new BusinessRuleError(
          'attendance.no_lesson_for_observation',
          'No lesson is running at this terminal right now, so there is nothing to mark.',
          { details: { deviceId: device.id, observedAt: observedAt.toISOString() } },
        );
      }
      lessonId = resolved.id;
    }
  }

  if (!lessonId) {
    throw new BadRequestError('A lesson or a device must be supplied for a face scan.');
  }

  const lesson = await loadMarkableLesson(ctx, client, lessonId);

  // Tenancy holds through the already-scoped lesson: these are the enrolments of
  // its group on its own date.
  const roster = await client.enrollment.findMany({
    where: {
      groupId: lesson.groupId,
      startDate: { lte: lesson.lessonDate },
      OR: [{ endDate: null }, { endDate: { gte: lesson.lessonDate } }],
    },
    select: { studentId: true },
  });
  const candidateRefs = [...new Set(roster.map((row) => row.studentId))];

  const provider = getFaceProvider();
  const startedAt = Date.now();
  let identified: FaceIdentifyResult;
  try {
    identified = await provider.identify({
      image: input.image,
      contentType: input.contentType,
      candidateRefs,
    });
  } catch (error) {
    // `identify` is contractually non-throwing, so reaching here is a driver bug.
    // It still must not become an unrecorded scan.
    logger.error('face.identify_threw', {
      requestId: ctx.requestId,
      organizationId: ctx.organizationId,
      lessonId: lesson.id,
      provider: provider.key,
      error,
    });
    identified = {
      result: 'ERROR',
      errorCode: 'PROVIDER_THREW',
      errorMessage: 'The recognition provider failed unexpectedly.',
    };
  }
  const latencyMs = Date.now() - startedAt;

  const thresholdPpm = env.FACE_MATCH_MIN_CONFIDENCE_PPM;
  const decision = classifyIdentification(identified, {
    thresholdPpm,
    onRoster: (subjectRef) => candidateRefs.includes(subjectRef),
  });

  // The attempt is written before, and outside, the marking transaction: a scan
  // that vanished because marking rolled back would remove the only evidence that
  // a camera decided something about a person. (A caller that passes its own `db`
  // transaction folds this into it and gives up that guarantee knowingly.)
  const event = await client.faceRecognitionEvent.create({
    data: {
      organizationId: ctx.organizationId,
      branchId: lesson.branchId,
      provider: provider.key,
      result: decision.persisted,
      confidencePpm: decision.confidencePpm,
      deviceId,
      lessonId: lesson.id,
      matchedStudentId: decision.studentId,
      errorCode: decision.errorCode,
      errorMessage: decision.errorMessage,
      latencyMs,
    },
    select: { id: true },
  });

  const base: FaceOutcomeContext = {
    eventId: event.id,
    lessonId: lesson.id,
    provider: provider.key,
    isRealRecognition: provider.isRealRecognition,
    thresholdPpm,
  };

  if (decision.kind !== 'MARKED') return { ...base, ...decision.outcome };

  const settings = await getSettings(
    ['lateThresholdMinutes', 'absentAfterMinutes'],
    { organizationId: ctx.organizationId, branchId: lesson.branchId },
    client,
  );
  // The same arrival rule a manual entry goes through, from mark.ts.
  const arrival = statusFromArrival({
    lessonStartsAt: lesson.startsAt,
    arrivedAt: observedAt,
    lateThresholdMinutes: settings.lateThresholdMinutes,
    absentAfterMinutes: settings.absentAfterMinutes,
  });

  const studentId = decision.studentId;
  return withTransaction(
    async (tx) => {
      const marked = await markAttendance(
        ctx,
        {
          lessonId: lesson.id,
          method: 'FACE_RECOGNITION',
          deviceId,
          markedAt: observedAt,
          entries: [
            {
              studentId,
              status: arrival.status,
              minutesLate: arrival.status === 'LATE' ? arrival.minutesLate : null,
              confidencePpm: decision.confidencePpm,
            },
          ],
        },
        tx,
      );

      // mark.ts returns a summary rather than row ids; the link from a recognition
      // event to the record it produced is what makes a biometric decision
      // auditable, so it is worth one indexed lookup.
      const row = await tx.attendanceRecord.findUnique({
        where: { lessonId_studentId: { lessonId: lesson.id, studentId } },
        select: { id: true },
      });
      if (row) {
        await tx.faceRecognitionEvent.update({
          where: { id: event.id },
          data: { attendanceRecordId: row.id },
        });
      }

      const summary = marked.records[0];
      return {
        ...base,
        outcome: 'MARKED' as const,
        studentId,
        status: summary?.status ?? arrival.status,
        minutesLate: summary?.minutesLate ?? null,
        confidencePpm: decision.confidencePpm,
        alreadyMarked: summary?.alreadyExisted ?? false,
      };
    },
    { existing: db },
  );
}

type Classification =
  | {
      readonly kind: 'MARKED';
      readonly persisted: FaceRecognitionResult;
      readonly studentId: string;
      readonly confidencePpm: number;
      readonly errorCode: null;
      readonly errorMessage: null;
    }
  | {
      readonly kind: 'REFUSED';
      readonly persisted: FaceRecognitionResult;
      readonly studentId: string | null;
      readonly confidencePpm: number | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly outcome: Exclude<FaceOutcomeDetail, { outcome: 'MARKED' }>;
    };

/**
 * Turn a provider verdict into what gets persisted and what the caller is told.
 *
 * Kept separate from the I/O so the one rule that matters -- MATCHED, at or above
 * the configured threshold, for somebody actually on this roster -- is readable in
 * a single place.
 */
function classifyIdentification(
  identified: FaceIdentifyResult,
  options: { thresholdPpm: number; onRoster: (subjectRef: string) => boolean },
): Classification {
  switch (identified.result) {
    case 'MATCHED': {
      if (!options.onRoster(identified.subjectRef)) {
        // The roster was passed as `candidateRefs`; a provider that answers with
        // somebody outside it is not trusted to name a student for this lesson.
        return {
          kind: 'REFUSED',
          persisted: 'MATCHED',
          studentId: null,
          confidencePpm: identified.confidencePpm,
          errorCode: 'SUBJECT_NOT_ON_ROSTER',
          errorMessage: 'The matched person is not enrolled in this group on this date.',
          outcome: { outcome: 'NOT_ON_ROSTER' },
        };
      }
      if (identified.confidencePpm < options.thresholdPpm) {
        // A provider may accept a lower bar than this deployment does. The
        // stricter of the two wins, and the event says LOW_CONFIDENCE so the log
        // does not claim a match that was refused.
        return {
          kind: 'REFUSED',
          persisted: 'LOW_CONFIDENCE',
          studentId: identified.subjectRef,
          confidencePpm: identified.confidencePpm,
          errorCode: null,
          errorMessage: null,
          outcome: {
            outcome: 'LOW_CONFIDENCE',
            studentId: identified.subjectRef,
            confidencePpm: identified.confidencePpm,
          },
        };
      }
      return {
        kind: 'MARKED',
        persisted: 'MATCHED',
        studentId: identified.subjectRef,
        confidencePpm: identified.confidencePpm,
        errorCode: null,
        errorMessage: null,
      };
    }

    case 'LOW_CONFIDENCE': {
      const onRoster = options.onRoster(identified.subjectRef);
      return {
        kind: 'REFUSED',
        persisted: 'LOW_CONFIDENCE',
        studentId: onRoster ? identified.subjectRef : null,
        confidencePpm: identified.confidencePpm,
        errorCode: onRoster ? null : 'SUBJECT_NOT_ON_ROSTER',
        errorMessage: null,
        outcome: {
          outcome: 'LOW_CONFIDENCE',
          studentId: onRoster ? identified.subjectRef : null,
          confidencePpm: identified.confidencePpm,
        },
      };
    }

    case 'MULTIPLE_MATCHES':
      return {
        kind: 'REFUSED',
        persisted: 'MULTIPLE_MATCHES',
        studentId: null,
        confidencePpm: null,
        errorCode: null,
        errorMessage: null,
        outcome: { outcome: 'MULTIPLE_MATCHES', candidateCount: identified.candidateCount },
      };

    case 'NOT_ENROLLED':
      return {
        kind: 'REFUSED',
        persisted: 'NOT_ENROLLED',
        studentId: null,
        confidencePpm: null,
        errorCode: null,
        errorMessage: null,
        outcome: { outcome: 'NOT_ENROLLED' },
      };

    case 'ERROR':
      return {
        kind: 'REFUSED',
        persisted: 'ERROR',
        studentId: null,
        confidencePpm: null,
        errorCode: identified.errorCode,
        errorMessage: identified.errorMessage,
        outcome: {
          outcome: 'ERROR',
          errorCode: identified.errorCode,
          errorMessage: identified.errorMessage,
        },
      };

    case 'NOT_CONFIGURED':
      return {
        kind: 'REFUSED',
        persisted: 'NOT_CONFIGURED',
        studentId: null,
        confidencePpm: null,
        errorCode: 'NOT_CONFIGURED',
        errorMessage: identified.reason,
        outcome: { outcome: 'NOT_CONFIGURED', reason: identified.reason },
      };

    case 'NO_MATCH':
      return {
        kind: 'REFUSED',
        persisted: 'NO_MATCH',
        studentId: null,
        confidencePpm: null,
        errorCode: null,
        errorMessage: null,
        outcome: { outcome: 'NO_MATCH' },
      };
  }
}

// ---------------------------------------------------------------------------
// Status for the UI
// ---------------------------------------------------------------------------

export interface BiometricSubjectStatus {
  readonly subjectType: BiometricSubjectType;
  readonly subjectId: string;
  readonly label: string;
  readonly enrollment: {
    readonly id: string;
    readonly provider: string;
    readonly status: string;
    readonly enrolledAt: Date;
    readonly revokedAt: Date | null;
  } | null;
  readonly consent: {
    readonly id: string;
    readonly grantedAt: Date;
    readonly byGuardian: boolean;
    readonly revokedAt: Date | null;
  } | null;
  readonly requiresGuardianConsent: boolean;
  readonly canEnroll: boolean;
  /** Why not, in the words the operator needs. `null` when enrolment may proceed. */
  readonly blockedReason: string | null;
}

export interface BiometricStatus {
  readonly provider: FaceProviderStatus;
  readonly matchThresholdPpm: number;
  readonly consentRequired: boolean;
  readonly guardianConsentUnderAge: number;
  readonly subject: BiometricSubjectStatus | null;
}

/**
 * What the biometrics screen renders.
 *
 * `provider.isRealRecognition` travels with `configured` so a badge can never say
 * "Connected" about a simulator, and the blocked reason is produced by the SAME
 * `evaluateConsent` the enrolment path uses -- a screen that says "ready to
 * enrol" and a POST that refuses would be worse than either alone.
 */
export async function getBiometricStatus(
  ctx: AccessContext,
  input: {
    readonly subjectType?: BiometricSubjectType;
    readonly studentId?: string | null;
    readonly employeeId?: string | null;
  } = {},
  db?: Db,
): Promise<BiometricStatus> {
  requirePermission(ctx, 'attendance.viewBiometrics');

  const client = db ?? prisma;
  const providerStatus = await describeFaceProvider();

  const wantsSubject = Boolean(input.subjectType && (input.studentId || input.employeeId));
  if (!wantsSubject) {
    const policy = await loadConsentPolicy(ctx, client, ctx.primaryBranchId);
    return {
      provider: providerStatus,
      matchThresholdPpm: env.FACE_MATCH_MIN_CONFIDENCE_PPM,
      consentRequired: policy.requireConsent,
      guardianConsentUnderAge: policy.guardianConsentUnderAge,
      subject: null,
    };
  }

  const subject = await resolveSubject(ctx, client, {
    subjectType: input.subjectType ?? 'STUDENT',
    studentId: input.studentId,
    employeeId: input.employeeId,
  });
  const policy = await loadConsentPolicy(ctx, client, subject.branchId);

  const [enrollment, consent] = await Promise.all([
    client.biometricEnrollment.findFirst({
      where: {
        ...organizationFilter(ctx),
        subjectType: subject.subjectType,
        ...(subject.subjectType === 'STUDENT'
          ? { studentId: subject.subjectId }
          : { employeeId: subject.subjectId }),
      },
      orderBy: { enrolledAt: 'desc' },
      select: {
        id: true,
        provider: true,
        status: true,
        enrolledAt: true,
        revokedAt: true,
      },
    }),
    findConsent(ctx, client, subject),
  ]);

  const ageYears = subject.dateOfBirth
    ? ageInYears(subject.dateOfBirth, todayIn(policy.timezone))
    : null;
  const decision = evaluateConsent({
    subjectType: subject.subjectType,
    ageYears,
    consent,
    requireConsent: policy.requireConsent,
    guardianConsentUnderAge: policy.guardianConsentUnderAge,
  });

  const alreadyEnrolled =
    enrollment !== null && (enrollment.status === 'ACTIVE' || enrollment.status === 'PENDING');

  return {
    provider: providerStatus,
    matchThresholdPpm: env.FACE_MATCH_MIN_CONFIDENCE_PPM,
    consentRequired: policy.requireConsent,
    guardianConsentUnderAge: policy.guardianConsentUnderAge,
    subject: {
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      label: subject.label,
      enrollment,
      consent: consent
        ? {
            id: consent.id,
            grantedAt: consent.grantedAt,
            byGuardian: consent.grantedByGuardianId !== null,
            revokedAt: consent.revokedAt,
          }
        : null,
      requiresGuardianConsent: decision.requiresGuardianConsent,
      canEnroll: decision.ok && !alreadyEnrolled && providerStatus.configured,
      blockedReason: !decision.ok
        ? decision.message
        : alreadyEnrolled
          ? 'This person is already enrolled. Revoke the existing enrolment first.'
          : !providerStatus.configured
            ? (providerStatus.message ?? 'No face-recognition provider is configured.')
            : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Recognition log
// ---------------------------------------------------------------------------

export interface ListFaceEventsInput {
  readonly lessonId?: string | null;
  readonly deviceId?: string | null;
  readonly studentId?: string | null;
  readonly result?: readonly FaceRecognitionResult[];
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface FaceEventRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly provider: string;
  readonly result: FaceRecognitionResult;
  readonly confidencePpm: number | null;
  readonly lessonId: string | null;
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly studentId: string | null;
  readonly studentName: string | null;
  readonly attendanceRecordId: string | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
}

/**
 * The recognition log, failures included.
 *
 * This list is the honesty mechanism for the whole feature: an operator comparing
 * NO_MATCH and LOW_CONFIDENCE counts against MATCHED is the only way to notice a
 * camera that has stopped working, or a provider that is not really matching.
 */
export async function listFaceRecognitionEvents(
  ctx: AccessContext,
  input: ListFaceEventsInput = {},
  db?: Db,
): Promise<{ rows: FaceEventRow[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, 'attendance.viewBiometrics');

  const client = db ?? prisma;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  const filters: Prisma.FaceRecognitionEventWhereInput[] = [
    // branchId is nullable on this model: an event captured before a branch could
    // be attributed still belongs to the organisation.
    composeReadFilter(ctx, { nullableBranch: true }),
  ];
  if (input.lessonId) filters.push({ lessonId: input.lessonId });
  if (input.deviceId) filters.push({ deviceId: input.deviceId });
  if (input.studentId) filters.push({ matchedStudentId: input.studentId });
  if (input.result && input.result.length > 0) filters.push({ result: { in: [...input.result] } });

  if (input.from || input.to) {
    // Calendar days come from the organisation's timezone, never from the server's.
    const { timezone } = await getSettings(
      ['timezone'],
      { organizationId: ctx.organizationId },
      client,
    );
    const createdAt: Prisma.DateTimeFilter = {};
    if (input.from) createdAt.gte = startOfDayInstant(input.from, timezone);
    if (input.to) createdAt.lt = endOfDayExclusiveInstant(input.to, timezone);
    filters.push({ createdAt });
  }

  const where: Prisma.FaceRecognitionEventWhereInput = { AND: filters };

  const [total, rows] = await Promise.all([
    client.faceRecognitionEvent.count({ where }),
    client.faceRecognitionEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        createdAt: true,
        provider: true,
        result: true,
        confidencePpm: true,
        lessonId: true,
        deviceId: true,
        matchedStudentId: true,
        attendanceRecordId: true,
        errorCode: true,
        latencyMs: true,
        device: { select: { name: true } },
        matchedStudent: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      provider: row.provider,
      result: row.result,
      confidencePpm: row.confidencePpm,
      lessonId: row.lessonId,
      deviceId: row.deviceId,
      deviceName: row.device?.name ?? null,
      studentId: row.matchedStudentId,
      studentName: row.matchedStudent
        ? `${row.matchedStudent.firstName} ${row.matchedStudent.lastName}`
        : null,
      attendanceRecordId: row.attendanceRecordId,
      errorCode: row.errorCode,
      latencyMs: row.latencyMs,
    })),
    total,
    page,
    pageSize,
  };
}
