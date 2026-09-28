/**
 * Turning a lead into a student.
 *
 * This is the seam between CRM and everything downstream, and it has one absolute
 * rule: THE LEAD IS NOT MOVED, COPIED OR DELETED. `Student.leadId` points back at it
 * and the lead keeps its whole activity and status trail, so "where did this student
 * come from, which agent worked the deal, how long did it take" is still answerable
 * in three years. Copying the lead's fields onto the student and deleting the lead
 * would destroy exactly the data the conversion report is made of.
 *
 * One transaction does all of it: the student (with its generated code), the optional
 * guardian and link, the optional enrolment, the lead's move to ENROLLED, the
 * activity, and the audit. A student that exists without the lead pointing at it, or
 * a lead marked ENROLLED with no student, are both states this file must never leave
 * behind.
 *
 * IDEMPOTENT. Converting a lead that has already been converted returns the existing
 * student. `Student.leadId` is UNIQUE, so even two simultaneous requests cannot
 * produce two students for one lead — the loser gets a CONFLICT and, on retry, the
 * existing student.
 */

import type { Gender, GuardianRelationship } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  organizationFilter,
  requirePermission,
  resolveWriteBranch,
  type AccessContext,
} from '@/server/rbac/access';
import { dateOnlyToPrismaDate, type DateOnly } from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import { nextStudentCode } from '@/server/services/finance/numbering';
import { enrollStudent } from '@/server/services/students/enrollment';
import { normalizeEmail } from '@/server/services/crm/scoring';
import {
  applyLeadStatusChange,
  cancelOpenFollowUps,
  leadDisplayName,
  leadReadFilter,
} from '@/server/services/crm/shared';

export interface ConvertLeadGuardianInput {
  /** Link an existing guardian instead of creating one. */
  readonly guardianId?: string | null;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string;
  readonly email?: string | null;
  readonly relationship?: GuardianRelationship;
  readonly isPrimary?: boolean;
}

export interface ConvertLeadToStudentInput {
  readonly leadId: string;
  /** The student's branch. Defaults to the lead's; a student must have one. */
  readonly branchId?: string | null;
  /** Overrides for details the lead captured loosely. */
  readonly firstName?: string;
  readonly lastName?: string;
  readonly middleName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: Gender;
  readonly phone?: string;
  readonly email?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly notes?: string | null;
  readonly guardian?: ConvertLeadGuardianInput | null;
  /** Enrol into this group as part of the conversion. */
  readonly groupId?: string | null;
  readonly enrollmentStartDate?: DateOnly;
  readonly allowOvercapacity?: boolean;
}

export interface ConvertLeadResult {
  readonly studentId: string;
  readonly studentCode: string;
  readonly leadId: string;
  readonly guardianId: string | null;
  readonly enrollmentId: string | null;
  readonly cancelledFollowUps: number;
  /** True when the lead was already converted and the existing student is returned. */
  readonly wasAlreadyConverted: boolean;
}

export async function convertLeadToStudent(
  ctx: AccessContext,
  input: ConvertLeadToStudentInput,
  db?: Db,
): Promise<ConvertLeadResult> {
  requirePermission(ctx, 'leads.convert');

  return withTransaction(
    async (tx) => {
      const scoped = await leadReadFilter(ctx, tx);
      const lead = await tx.lead.findFirst({
        where: { ...scoped, id: input.leadId },
        select: {
          id: true,
          branchId: true,
          firstName: true,
          lastName: true,
          phone: true,
          phoneNormalized: true,
          email: true,
          status: true,
          notes: true,
          assignedToUserId: true,
          convertedAt: true,
          convertedStudent: { select: { id: true, studentCode: true } },
        },
      });
      if (!lead) throw new NotFoundError('Lead', input.leadId);

      // Idempotent: the caller retried, or two tabs submitted the same form.
      if (lead.convertedStudent) {
        return {
          studentId: lead.convertedStudent.id,
          studentCode: lead.convertedStudent.studentCode,
          leadId: lead.id,
          guardianId: null,
          enrollmentId: null,
          cancelledFollowUps: 0,
          wasAlreadyConverted: true,
        };
      }

      if (lead.status === 'LOST' || lead.status === 'CLOSED') {
        throw new StateInvalidError(
          'lead',
          lead.status.toLowerCase(),
          'converted',
          `This lead is ${lead.status.toLowerCase()}. Re-engage it first, so the pipeline shows that it came back.`,
        );
      }

      // A student must belong to a branch, so this is the strict resolver: an
      // organisation-scoped caller converting an unrouted website lead has to say
      // which site the student joins.
      const branchId = resolveWriteBranch(ctx, input.branchId ?? lead.branchId, 'student');

      const firstName = (input.firstName ?? lead.firstName).trim();
      const lastName = (input.lastName ?? lead.lastName ?? '').trim();
      if (firstName === '') {
        throw new ValidationError([{ path: 'firstName', message: 'Required' }]);
      }
      if (lastName === '') {
        throw new BusinessRuleError(
          'convert.missing_last_name',
          'A student record needs a family name. Add one to the lead, or supply it with the conversion.',
        );
      }

      const rawPhone = input.phone ?? lead.phone;
      const phoneNormalized = normalizePhone(rawPhone);
      if (!phoneNormalized) {
        throw new ValidationError([{ path: 'phone', message: 'Not a valid phone number' }]);
      }

      const studentCode = await nextStudentCode(tx, ctx.organizationId);

      let student: { id: string; studentCode: string };
      try {
        student = await tx.student.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            studentCode,
            firstName,
            lastName,
            middleName: input.middleName?.trim() || null,
            dateOfBirth: input.dateOfBirth ? dateOnlyToPrismaDate(input.dateOfBirth) : null,
            gender: input.gender ?? 'UNSPECIFIED',
            phone: rawPhone.trim(),
            phoneNormalized,
            email: normalizeEmail(input.email ?? lead.email),
            addressLine: input.addressLine?.trim() || null,
            city: input.city?.trim() || null,
            // PROSPECT until an enrolment exists; `enrollStudent` promotes them.
            status: 'PROSPECT',
            notes: input.notes?.trim() || lead.notes,
            // The provenance link. Never null on a converted lead.
            leadId: lead.id,
            createdById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true, studentCode: true },
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'P2002' || code === '23505') {
          // The unique index on Student.leadId fired: another request converted this
          // lead between our read and our write.
          throw new ConflictError(
            'This lead is already being converted. Reload the page to see the student.',
            { details: { leadId: lead.id } },
          );
        }
        throw error;
      }

      const guardianId = await attachGuardian(ctx, tx, {
        studentId: student.id,
        branchId,
        guardian: input.guardian ?? null,
      });

      let enrollmentId: string | null = null;
      if (input.groupId) {
        // Composed into this transaction, so a full group or a branch mismatch rolls
        // the whole conversion back rather than leaving a student nobody enrolled.
        const enrollment = await enrollStudent(
          ctx,
          {
            studentId: student.id,
            groupId: input.groupId,
            startDate: input.enrollmentStartDate,
            allowOvercapacity: input.allowOvercapacity,
          },
          tx,
        );
        enrollmentId = enrollment.id;
      }

      const convertedAt = new Date();
      await applyLeadStatusChange(
        ctx,
        tx,
        { id: lead.id, branchId: lead.branchId, firstName: lead.firstName, lastName: lead.lastName, status: lead.status },
        {
          toStatus: 'ENROLLED',
          reason: `Converted to student ${student.studentCode}`,
          occurredAt: convertedAt,
          extraData: { convertedAt },
        },
      );

      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: 'CONVERTED',
          subject: `Converted to student ${student.studentCode}`,
          occurredAt: convertedAt,
          createdById: ctx.isSystem ? null : ctx.userId,
          metadata: { studentId: student.id, enrollmentId },
        },
      });

      const cancelledFollowUps = await cancelOpenFollowUps(
        tx,
        lead.id,
        `Lead converted to student ${student.studentCode}`,
      );

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAD_CONVERTED,
          entityType: 'Lead',
          entityId: lead.id,
          branchId,
          summary: `${leadDisplayName(lead)} converted to student ${student.studentCode}`,
          severity: 'NOTICE',
          metadata: {
            studentId: student.id,
            studentCode: student.studentCode,
            guardianId,
            enrollmentId,
            assignedToUserId: lead.assignedToUserId,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'student.converted_from_lead',
            title: 'Created from a lead',
            description: `Lead ${leadDisplayName(lead)} converted by ${ctx.displayName}`,
            occurredAt: convertedAt,
            metadata: { leadId: lead.id },
          },
        },
        tx,
      );

      return {
        studentId: student.id,
        studentCode: student.studentCode,
        leadId: lead.id,
        guardianId,
        enrollmentId,
        cancelledFollowUps,
        wasAlreadyConverted: false,
      };
    },
    { existing: db },
  );
}

/**
 * Link or create the guardian, if the conversion form supplied one.
 *
 * Linking an existing guardian is preferred and offered first in the UI, because a
 * family with three children here should be one `Guardian` row, not three. A new
 * guardian needs a name and a phone: a contact record with neither is not a contact.
 */
async function attachGuardian(
  ctx: AccessContext,
  tx: Tx,
  input: {
    readonly studentId: string;
    readonly branchId: string;
    readonly guardian: ConvertLeadGuardianInput | null;
  },
): Promise<string | null> {
  const guardian = input.guardian;
  if (!guardian) return null;

  let guardianId: string;

  if (guardian.guardianId) {
    const existing = await tx.guardian.findFirst({
      where: { id: guardian.guardianId, ...organizationFilter(ctx), deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!existing) throw new NotFoundError('Guardian', guardian.guardianId);
    guardianId = existing.id;
  } else {
    const firstName = guardian.firstName?.trim();
    const lastName = guardian.lastName?.trim();
    const phone = guardian.phone?.trim();
    if (!firstName || !lastName || !phone) {
      throw new BusinessRuleError(
        'convert.guardian_incomplete',
        'A new guardian needs a first name, a family name and a phone number.',
      );
    }
    const phoneNormalized = normalizePhone(phone);
    if (!phoneNormalized) {
      throw new ValidationError([
        { path: 'guardian.phone', message: 'Not a valid phone number' },
      ]);
    }

    const created = await tx.guardian.create({
      data: {
        organizationId: ctx.organizationId,
        firstName,
        lastName,
        phone,
        phoneNormalized,
        email: normalizeEmail(guardian.email),
        createdById: ctx.isSystem ? null : ctx.userId,
      },
      select: { id: true },
    });
    guardianId = created.id;

    await recordAudit(
      ctx,
      {
        action: AUDIT_ACTIONS.GUARDIAN_CREATED,
        entityType: 'Guardian',
        entityId: guardianId,
        branchId: input.branchId,
        summary: `Guardian ${firstName} ${lastName} created during a lead conversion`,
      },
      tx,
    );
  }

  await tx.studentGuardian.create({
    data: {
      studentId: input.studentId,
      guardianId,
      relationship: guardian.relationship ?? 'OTHER',
      // The first guardian on a brand-new student is the one the institution rings.
      isPrimary: guardian.isPrimary ?? true,
    },
  });

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.GUARDIAN_LINKED,
      entityType: 'StudentGuardian',
      entityId: input.studentId,
      branchId: input.branchId,
      summary: 'Guardian linked to the new student',
      metadata: { studentId: input.studentId, guardianId },
    },
    tx,
  );

  return guardianId;
}
