/**
 * Certificates: issuing, revoking, listing and public verification.
 *
 * A certificate is the one artefact of this system that leaves the building. It gets
 * printed, photographed, attached to a job application and shown to a university, so
 * two things matter more here than anywhere else in the module:
 *
 *   1. IT IS NOT ISSUED ON REQUEST. The service recomputes the final grade, the
 *      attendance and the programme completion itself and refuses, naming which test
 *      failed, rather than certifying whatever the caller passed in. A certificate
 *      that can be talked into existence is worth nothing.
 *
 *   2. REVOCATION IS VISIBLE, NOT A DELETION. A revoked certificate keeps its number
 *      and its row, and `verifyCertificate` reports it as REVOKED -- which is the only
 *      way the holder of a printed copy can be told it no longer stands.
 */

import type { CertificateStatus, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  record as recordAudit,
} from '@/server/audit';
import {
  organizationFilter,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { nextCertificateNumber } from '@/server/services/finance/numbering';
import {
  attendancePercentagePpm,
  loadAttendanceRule,
} from '@/server/services/attendance/statistics';
import { scoreToPpm } from '@/server/services/academics/grading-scales';
import { loadGradeResolver } from '@/server/services/assessment/grade-resolution';
import {
  studentScopeFilter,
  toPage,
  weightedAverage,
  type PageInput,
  type PagedResult,
} from '@/server/services/assessment/shared';

export interface IssueCertificateInput {
  readonly studentId: string;
  readonly programId: string;
  /** Defaults to "<Program name> — Certificate of completion". */
  readonly title?: string;
  /** Free-form kind, e.g. "COMPLETION", "ACHIEVEMENT". */
  readonly type?: string;
  /**
   * Minimum attendance, in ppm. Defaults to the institution's at-risk floor
   * (`attendance.atRiskBelowPercentPpm`), which is the closest configured rule -- there
   * is no dedicated certificate threshold setting.
   */
  readonly minAttendancePercentPpm?: number;
  readonly issuedAt?: Date;
}

export interface CertificateRow {
  readonly id: string;
  readonly certificateNumber: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly studentCode: string;
  readonly programId: string | null;
  readonly programName: string | null;
  readonly title: string;
  readonly type: string;
  readonly status: CertificateStatus;
  readonly finalGradeLabel: string | null;
  readonly finalScore: number | null;
  readonly issuedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
}

export interface CertificateEligibility {
  readonly eligible: boolean;
  /** Human-readable reasons the certificate cannot be issued. */
  readonly failures: readonly string[];
  readonly attendancePercentPpm: number | null;
  readonly requiredAttendancePercentPpm: number;
  readonly finalPercentPpm: number | null;
  readonly finalGradeLabel: string | null;
  readonly gradeCount: number;
  readonly programComplete: boolean;
}

/**
 * Everything the issue decision rests on, computed from the record.
 *
 * Exported separately so the UI can show "not yet eligible: attendance 68%, 75%
 * required" BEFORE somebody clicks issue, using exactly the arithmetic that will be
 * applied when they do.
 */
export async function checkCertificateEligibility(
  ctx: AccessContext,
  input: { readonly studentId: string; readonly programId: string; readonly minAttendancePercentPpm?: number },
  db: Db = prisma,
): Promise<CertificateEligibility> {
  requirePermission(ctx, 'certificates.view');
  return evaluateEligibility(ctx, db, input);
}

async function evaluateEligibility(
  ctx: AccessContext,
  db: Db,
  input: { readonly studentId: string; readonly programId: string; readonly minAttendancePercentPpm?: number },
): Promise<CertificateEligibility> {
  const student = await db.student.findFirst({
    where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, branchId: true },
  });
  if (!student) throw new NotFoundError('Student', input.studentId);

  const rule = await loadAttendanceRule(
    { organizationId: ctx.organizationId, branchId: student.branchId },
    db,
  );
  const requiredAttendancePercentPpm =
    input.minAttendancePercentPpm ?? rule.atRiskBelowPercentPpm;

  const [enrollments, grades, attendance] = await Promise.all([
    db.enrollment.findMany({
      where: { studentId: student.id, group: { ...scopeFilter(ctx), programId: input.programId } },
      select: { status: true, endDate: true, endReason: true },
    }),
    db.grade.findMany({
      where: {
        ...organizationFilter(ctx),
        studentId: student.id,
        group: { programId: input.programId },
      },
      select: { score: true, maxScore: true, weightPpm: true },
    }),
    db.attendanceRecord.groupBy({
      by: ['status'],
      where: {
        organizationId: ctx.organizationId,
        studentId: student.id,
        lesson: {
          group: { programId: input.programId },
          status: { not: 'CANCELLED' },
        },
      },
      _count: { _all: true },
    }),
  ]);

  const counts = {
    present: countOf(attendance, 'PRESENT'),
    late: countOf(attendance, 'LATE'),
    excused: countOf(attendance, 'EXCUSED'),
    absent: countOf(attendance, 'ABSENT'),
  };
  const attendancePercent = attendancePercentagePpm(counts, rule);

  // Complete means: they finished, and they are not still studying. A student halfway
  // through, or one who transferred out, has not completed the programme even if their
  // marks are good.
  const hasOpen = enrollments.some((row) => row.endDate === null);
  const hasCompleted = enrollments.some(
    (row) => row.status === 'COMPLETED' || row.endReason === 'COMPLETED',
  );
  const programComplete = enrollments.length > 0 && !hasOpen && hasCompleted;

  const finalAverage = weightedAverage(
    grades.map((grade) => ({
      value: scoreToPpm(grade.score, grade.maxScore),
      weightPpm: grade.weightPpm,
    })),
  );
  const finalPercentPpm = finalAverage === null ? null : Math.round(finalAverage);

  const resolver = await loadGradeResolver(ctx, {}, db);
  const resolved =
    finalPercentPpm === null ? null : resolver.resolvePercent(finalPercentPpm, 0);

  const failures: string[] = [];
  if (!programComplete) {
    failures.push(
      enrollments.length === 0
        ? 'The student has never been enrolled in this programme.'
        : hasOpen
          ? 'The student is still enrolled in this programme.'
          : 'The student left this programme without completing it.',
    );
  }
  if (attendancePercent === null) {
    failures.push('There is no attendance on record for this programme.');
  } else if (attendancePercent < requiredAttendancePercentPpm) {
    failures.push(
      `Attendance is ${percentText(attendancePercent)}; ${percentText(requiredAttendancePercentPpm)} is required.`,
    );
  }
  if (grades.length === 0) {
    failures.push('The student has no grades in this programme, so no final grade can be computed.');
  }

  return {
    eligible: failures.length === 0,
    failures,
    attendancePercentPpm: attendancePercent,
    requiredAttendancePercentPpm,
    finalPercentPpm,
    finalGradeLabel: resolved?.gradeLabel ?? null,
    gradeCount: grades.length,
    programComplete,
  };
}

function countOf(
  rows: ReadonlyArray<{ status: string; _count: { _all: number } }>,
  status: string,
): number {
  return rows.find((row) => row.status === status)?._count._all ?? 0;
}

function percentText(ppm: number): string {
  return `${Math.round(ppm / 10_000)}%`;
}

/**
 * Issue a certificate.
 *
 * The number comes from the shared counter inside this transaction, so a rollback
 * cannot leave a gap in the sequence or hand the same number to two students.
 */
export async function issueCertificate(
  ctx: AccessContext,
  input: IssueCertificateInput,
  db?: Db,
): Promise<CertificateRow> {
  requirePermission(ctx, 'certificates.issue');

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true, studentCode: true },
      });
      if (!student) throw new NotFoundError('Student', input.studentId);

      const program = await tx.program.findFirst({
        where: { id: input.programId, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!program) throw new NotFoundError('Program', input.programId);

      // One live certificate per student per programme. A replacement for a lost copy
      // is a reprint of this row, not a second certificate with a second number.
      const existing = await tx.certificate.findFirst({
        where: {
          ...organizationFilter(ctx),
          studentId: student.id,
          programId: program.id,
          status: { in: ['DRAFT', 'ISSUED'] },
        },
        select: { id: true, certificateNumber: true, status: true },
      });
      if (existing) {
        throw new ConflictError(
          `${student.firstName} ${student.lastName} already holds certificate ${existing.certificateNumber} for ${program.name}.`,
          { details: { certificateId: existing.id, status: existing.status } },
        );
      }

      const eligibility = await evaluateEligibility(ctx, tx, input);
      if (!eligibility.eligible) {
        // Naming every failed test, not just the first: an administrator chasing an
        // approval needs the whole list, not one round trip per problem.
        throw new BusinessRuleError(
          'certificate.not_eligible',
          `This certificate cannot be issued yet. ${eligibility.failures.join(' ')}`,
          {
            details: {
              failures: eligibility.failures,
              attendancePercentPpm: eligibility.attendancePercentPpm,
              requiredAttendancePercentPpm: eligibility.requiredAttendancePercentPpm,
              programComplete: eligibility.programComplete,
            },
          },
        );
      }

      const issuedAt = input.issuedAt ?? new Date();
      const certificateNumber = await nextCertificateNumber(tx, ctx.organizationId, issuedAt);

      const certificate = await tx.certificate.create({
        data: {
          organizationId: ctx.organizationId,
          studentId: student.id,
          programId: program.id,
          certificateNumber,
          title: input.title ?? `${program.name} — Certificate of completion`,
          type: input.type ?? 'COMPLETION',
          finalGradeLabel: eligibility.finalGradeLabel,
          // Stored as a percentage out of 100, which is what gets printed. The ppm
          // figure it came from stays in the audit metadata for exactness.
          finalScore:
            eligibility.finalPercentPpm === null
              ? null
              : Math.round(eligibility.finalPercentPpm / 100) / 100,
          status: 'ISSUED',
          issuedAt,
          issuedById: ctx.isSystem ? null : ctx.userId,
        },
        select: certificateSelect,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.CERTIFICATE_ISSUED,
          entityType: 'Certificate',
          entityId: certificate.id,
          branchId: student.branchId,
          summary: `Certificate ${certificateNumber} issued to ${student.firstName} ${student.lastName} for ${program.name}`,
          metadata: {
            certificateNumber,
            programId: program.id,
            finalPercentPpm: eligibility.finalPercentPpm,
            attendancePercentPpm: eligibility.attendancePercentPpm,
            gradeCount: eligibility.gradeCount,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'certificate.issued',
            title: `Certificate issued: ${program.name}`,
            description: eligibility.finalGradeLabel,
            occurredAt: issuedAt,
          },
        },
        tx,
      );

      return toCertificateRow(certificate);
    },
    { existing: db },
  );
}

/**
 * Revoke a certificate.
 *
 * Audited at NOTICE, which for this action is not decorative: `record()` treats a
 * failed NOTICE write as fatal, so a revocation cannot commit without its trail.
 */
export async function revokeCertificate(
  ctx: AccessContext,
  certificateId: string,
  input: { readonly reason: string },
  db?: Db,
): Promise<CertificateRow> {
  requirePermission(ctx, 'certificates.revoke');

  if (input.reason.trim().length < 5) {
    throw new BusinessRuleError(
      'certificate.revoke_reason_required',
      'Revoking a certificate must record why, in a sentence somebody can read later.',
    );
  }

  return withTransaction(
    async (tx) => {
      const certificate = await tx.certificate.findFirst({
        where: { id: certificateId, ...(studentScopeFilter(ctx) as object) },
        select: certificateSelect,
      });
      if (!certificate) throw new NotFoundError('Certificate', certificateId);
      if (certificate.status === 'REVOKED') {
        throw new StateInvalidError('certificate', 'already revoked', 'revoked');
      }

      const now = new Date();
      const updated = await tx.certificate.update({
        where: { id: certificate.id },
        data: { status: 'REVOKED', revokedAt: now, revokeReason: input.reason },
        select: certificateSelect,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.CERTIFICATE_REVOKED,
          entityType: 'Certificate',
          entityId: certificate.id,
          branchId: certificate.student.branchId,
          summary: `Certificate ${certificate.certificateNumber} revoked`,
          reason: input.reason,
          severity: 'NOTICE',
          changes: { status: { from: certificate.status, to: 'REVOKED' } },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: certificate.studentId,
            type: 'certificate.revoked',
            title: `Certificate ${certificate.certificateNumber} revoked`,
            description: input.reason,
            occurredAt: now,
          },
        },
        tx,
      );

      return toCertificateRow(updated);
    },
    { existing: db },
  );
}

export interface ListCertificatesInput extends PageInput {
  readonly studentId?: string;
  readonly programId?: string;
  readonly status?: readonly CertificateStatus[];
}

export async function listCertificates(
  ctx: AccessContext,
  input: ListCertificatesInput = {},
  db: Db = prisma,
): Promise<PagedResult<CertificateRow>> {
  requirePermission(ctx, 'certificates.view');

  const { page, pageSize, skip, take } = toPage(input);

  const where: Prisma.CertificateWhereInput = {
    ...(studentScopeFilter(ctx) as object),
    ...(input.studentId ? { studentId: input.studentId } : {}),
    ...(input.programId ? { programId: input.programId } : {}),
    ...(input.status && input.status.length > 0 ? { status: { in: [...input.status] } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.certificate.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
      select: certificateSelect,
    }),
    db.certificate.count({ where }),
  ]);

  return { rows: rows.map(toCertificateRow), total, page, pageSize };
}

export interface CertificateVerification {
  readonly certificateNumber: string;
  readonly studentName: string;
  readonly programName: string | null;
  readonly title: string;
  readonly issuedAt: Date | null;
  readonly status: CertificateStatus;
  readonly finalGradeLabel: string | null;
}

/**
 * Public lookup by certificate number.
 *
 * NO `AccessContext`: this backs an unauthenticated "is this certificate real?" page,
 * so there is no caller identity to scope by. The organisation comes from the tenant
 * the request arrived on and is applied here explicitly -- the (organizationId,
 * certificateNumber) unique index means a number is only unique within a tenant.
 *
 * THE PAYLOAD IS DELIBERATELY MINIMAL. Anyone on the internet holding a number can
 * call this, so it returns only what the printed certificate already shows: the name
 * on it, the programme, the date, the grade and whether it still stands. No student
 * id, no code, no contact details, no marks breakdown, no branch -- a verification
 * endpoint that returned a student record would be a directory of every graduate,
 * enumerable by guessing sequential numbers.
 */
export async function verifyCertificate(
  input: { readonly organizationId: string; readonly certificateNumber: string },
  db: Db = prisma,
): Promise<CertificateVerification> {
  const certificate = await db.certificate.findFirst({
    where: {
      organizationId: input.organizationId,
      certificateNumber: input.certificateNumber.trim(),
      // A draft has not been awarded to anybody, so it must not verify as genuine.
      status: { in: ['ISSUED', 'REVOKED'] },
    },
    select: {
      certificateNumber: true,
      title: true,
      status: true,
      issuedAt: true,
      finalGradeLabel: true,
      student: { select: { firstName: true, lastName: true } },
      program: { select: { name: true } },
    },
  });
  if (!certificate) throw new NotFoundError('Certificate');

  return {
    certificateNumber: certificate.certificateNumber,
    studentName: `${certificate.student.firstName} ${certificate.student.lastName}`,
    programName: certificate.program?.name ?? null,
    title: certificate.title,
    issuedAt: certificate.issuedAt,
    status: certificate.status,
    finalGradeLabel: certificate.finalGradeLabel,
  };
}

const certificateStudentSelect = {
  branchId: true,
  firstName: true,
  lastName: true,
  studentCode: true,
} satisfies Prisma.StudentSelect;

const certificateSelect = {
  id: true,
  certificateNumber: true,
  studentId: true,
  programId: true,
  title: true,
  type: true,
  status: true,
  finalGradeLabel: true,
  finalScore: true,
  issuedAt: true,
  revokedAt: true,
  revokeReason: true,
  student: { select: certificateStudentSelect },
  program: { select: { name: true } },
} satisfies Prisma.CertificateSelect;

type CertificateSelectRow = Prisma.CertificateGetPayload<{ select: typeof certificateSelect }>;

function toCertificateRow(certificate: CertificateSelectRow): CertificateRow {
  return {
    id: certificate.id,
    certificateNumber: certificate.certificateNumber,
    studentId: certificate.studentId,
    studentName: `${certificate.student.firstName} ${certificate.student.lastName}`,
    studentCode: certificate.student.studentCode,
    programId: certificate.programId,
    programName: certificate.program?.name ?? null,
    title: certificate.title,
    type: certificate.type,
    status: certificate.status,
    finalGradeLabel: certificate.finalGradeLabel,
    finalScore: certificate.finalScore,
    issuedAt: certificate.issuedAt,
    revokedAt: certificate.revokedAt,
    revokeReason: certificate.revokeReason,
  };
}
