/**
 * Turning an accepted application into a student.
 *
 * THE PERSON EXISTS EXACTLY ONCE. This is the only place the applicant's details
 * are copied forward, and it links both directions so the copy can never be made
 * twice: `Student.applicationId` is UNIQUE, so even two simultaneous calls cannot
 * produce two students for one application — the loser gets a 409 and a retry
 * returns the student the winner created.
 *
 * Three identities can already exist for the same human by the time this runs:
 *   - a Student, if the CRM already converted the lead this application came from;
 *   - a Guardian, if the parent is already known from a sibling;
 *   - the Lead itself, which is kept and pointed at, never copied away.
 * Each is adopted rather than duplicated. Creating a second Student for a person
 * who already has one is the worst outcome in this module: their attendance,
 * invoices and history split in two and nothing reconciles them again.
 */

import type { GuardianRelationship } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import { NotFoundError, StateInvalidError } from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import { requirePermission, scopeFilter, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { prismaDateToDateOnly, todayIn, type DateOnly } from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import { nextStudentCode } from '@/server/services/finance/numbering';
import { enrollStudent } from '@/server/services/students/enrollment';

export interface CreateStudentFromApplicationInput {
  readonly applicationId: string;
  /** Enrol into this group as well. Also requires `groups.manageEnrollment`. */
  readonly groupId?: string | null;
  /** Enrolment start date. Defaults to the admission date, else today. */
  readonly startDate?: DateOnly | null;
  readonly allowOvercapacity?: boolean;
}

export interface CreateStudentFromApplicationResult {
  readonly studentId: string;
  readonly studentCode: string;
  readonly applicationId: string;
  /** False when the person already existed and this call only linked things up. */
  readonly created: boolean;
  readonly guardianId: string | null;
  readonly enrollmentId: string | null;
}

/**
 * Split a single free-text name into the two columns Guardian requires.
 *
 * Pure and exported so the same rule is testable and so the UI can preview it. A
 * one-word name stays a first name rather than being duplicated into the surname:
 * "Nodira" must not display as "Nodira Nodira".
 */
export function splitPersonName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter((part) => part.length > 0);
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

export async function createStudentFromApplication(
  ctx: AccessContext,
  input: CreateStudentFromApplicationInput,
  db?: Db,
): Promise<CreateStudentFromApplicationResult> {
  requirePermission(ctx, 'applications.enroll');

  return withTransaction(
    async (tx) => {
      const application = await tx.application.findFirst({
        where: { id: input.applicationId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          applicationNumber: true,
          status: true,
          branchId: true,
          leadId: true,
          firstName: true,
          lastName: true,
          middleName: true,
          dateOfBirth: true,
          gender: true,
          phone: true,
          phoneNormalized: true,
          email: true,
          addressLine: true,
          city: true,
          guardianName: true,
          guardianPhone: true,
          guardianRelation: true,
          admissionDate: true,
          student: { select: { id: true, studentCode: true, applicationId: true } },
        },
      });
      if (!application) throw new NotFoundError('Application', input.applicationId);

      // The lead may already have been converted by the CRM. That student IS this
      // applicant, so it counts as the existing person here.
      const existingPerson =
        application.student ??
        (application.leadId
          ? await tx.student.findFirst({
              where: {
                leadId: application.leadId,
                organizationId: ctx.organizationId,
                deletedAt: null,
              },
              select: { id: true, studentCode: true, applicationId: true },
            })
          : null);

      // --- idempotency -----------------------------------------------------
      // A completed conversion replays as a no-op returning the same student: this
      // use-case sits behind a button people double-click and behind a retry after a
      // timeout. `guardianId` and `enrollmentId` are only reported by the call that
      // did the work.
      if (existingPerson && application.status === 'ENROLLED') {
        return {
          studentId: existingPerson.id,
          studentCode: existingPerson.studentCode,
          applicationId: application.id,
          created: false,
          guardianId: null,
          enrollmentId: null,
        };
      }

      if (application.status !== 'ACCEPTED') {
        throw new StateInvalidError(
          'application',
          application.status.toLowerCase(),
          'converted into a student',
        );
      }

      const settings = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: application.branchId },
        tx,
      );
      const admissionDateOnly = application.admissionDate
        ? prismaDateToDateOnly(application.admissionDate)
        : todayIn(settings.timezone);
      const startDate = input.startDate ?? admissionDateOnly;

      // --- the person ------------------------------------------------------
      let studentId: string;
      let studentCode: string;
      let created: boolean;

      if (existingPerson) {
        studentId = existingPerson.id;
        studentCode = existingPerson.studentCode;
        created = false;
        // `Student.applicationId` is unique, so it is only claimed when free; a
        // student converted under an earlier application keeps that provenance and
        // this application simply records that it ended in an enrolment.
        if (existingPerson.applicationId === null) {
          await tx.student.update({
            where: { id: existingPerson.id },
            data: { applicationId: application.id },
          });
        }
      } else {
        studentCode = await nextStudentCode(tx, ctx.organizationId);
        const student = await tx.student.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: application.branchId,
            studentCode,
            firstName: application.firstName,
            lastName: application.lastName,
            middleName: application.middleName,
            dateOfBirth: application.dateOfBirth,
            gender: application.gender,
            phone: application.phone,
            phoneNormalized: application.phoneNormalized,
            email: application.email,
            addressLine: application.addressLine,
            city: application.city,
            // PROSPECT until they are actually in a group; `enrollStudent` is what
            // promotes them to ACTIVE, so an accepted applicant with no group does
            // not inflate the active-student count.
            status: 'PROSPECT',
            applicationId: application.id,
            // `leadId` is set by `closeLead` below, which is the one place that
            // checks the unique pointer is still free — a soft-deleted student
            // converted from the same lead still holds it.
            createdById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true },
        });
        studentId = student.id;
        created = true;
      }

      if (created) {
        await recordAudit(
          ctx,
          {
            action: AUDIT_ACTIONS.STUDENT_CREATED,
            entityType: 'Student',
            entityId: studentId,
            branchId: application.branchId,
            summary: `${application.firstName} ${application.lastName} (${studentCode}) created from application ${application.applicationNumber}`,
            metadata: { applicationId: application.id, leadId: application.leadId },
            timeline: {
              subjectType: 'STUDENT',
              subjectId: studentId,
              type: 'student.created',
              title: `Admitted from application ${application.applicationNumber}`,
            },
          },
          tx,
        );
      }

      // --- the guardian ----------------------------------------------------
      const guardianId = await linkGuardian(ctx, tx, {
        studentId,
        branchId: application.branchId,
        name: application.guardianName,
        phone: application.guardianPhone,
        relation: application.guardianRelation,
      });

      // --- the group -------------------------------------------------------
      // Delegated rather than reimplemented: capacity, branch match and the
      // one-open-enrollment index all live in enrollStudent, and it checks its own
      // `groups.manageEnrollment` permission.
      let enrollmentId: string | null = null;
      if (input.groupId) {
        const enrollment = await enrollStudent(
          ctx,
          {
            studentId,
            groupId: input.groupId,
            startDate,
            allowOvercapacity: input.allowOvercapacity,
          },
          tx,
        );
        enrollmentId = enrollment.id;
      }

      // --- the application and the lead ------------------------------------
      await tx.application.update({
        where: { id: application.id },
        data: { status: 'ENROLLED' },
      });

      if (application.leadId) {
        await closeLead(ctx, tx, {
          leadId: application.leadId,
          studentId,
          applicationNumber: application.applicationNumber,
        });
      }

      await recordAudit(
        ctx,
        {
          action: 'application.enrolled',
          entityType: 'Application',
          entityId: application.id,
          branchId: application.branchId,
          summary: `Application ${application.applicationNumber} enrolled as ${studentCode}`,
          metadata: { studentId, groupId: input.groupId ?? null, enrollmentId },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: application.id,
            type: 'application.enrolled',
            title: `Enrolled as ${studentCode}`,
          },
        },
        tx,
      );

      return {
        studentId,
        studentCode,
        applicationId: application.id,
        created,
        guardianId,
        enrollmentId,
      };
    },
    { existing: db },
  );
}

/**
 * Attach the guardian named on the application, reusing the existing record when
 * the organisation already knows that phone number — a second sibling must not
 * create a second copy of the same parent, or half their children's invoices go to
 * a guardian record nobody is looking at.
 *
 * Needs both a name and a phone: `Guardian.phone` is required, and a guardian with
 * no name is not a contact anyone can use.
 */
async function linkGuardian(
  ctx: AccessContext,
  tx: Tx,
  input: {
    readonly studentId: string;
    readonly branchId: string;
    readonly name: string | null;
    readonly phone: string | null;
    readonly relation: GuardianRelationship | null;
  },
): Promise<string | null> {
  if (!input.name || !input.phone) return null;

  const phoneNormalized = normalizePhone(input.phone);
  if (!phoneNormalized) return null;

  const { firstName, lastName } = splitPersonName(input.name);
  if (firstName === '') return null;

  const existing = await tx.guardian.findFirst({
    where: { organizationId: ctx.organizationId, phoneNormalized, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, firstName: true, lastName: true },
  });

  const guardianId =
    existing?.id ??
    (
      await tx.guardian.create({
        data: {
          organizationId: ctx.organizationId,
          firstName,
          lastName,
          phone: input.phone,
          phoneNormalized,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: { id: true },
      })
    ).id;

  // Idempotent through the (studentId, guardianId) unique index, so a re-run after a
  // partial failure links rather than throwing.
  await tx.studentGuardian.upsert({
    where: { studentId_guardianId: { studentId: input.studentId, guardianId } },
    create: {
      studentId: input.studentId,
      guardianId,
      relationship: input.relation ?? 'OTHER',
      isPrimary: true,
      isEmergencyContact: true,
    },
    update: {},
  });

  await recordAudit(
    ctx,
    {
      action: existing ? AUDIT_ACTIONS.GUARDIAN_LINKED : AUDIT_ACTIONS.GUARDIAN_CREATED,
      entityType: 'Guardian',
      entityId: guardianId,
      branchId: input.branchId,
      summary: existing
        ? `Existing guardian ${existing.firstName} ${existing.lastName} linked to the new student`
        : `Guardian ${firstName} ${lastName} created and linked`,
      metadata: { studentId: input.studentId },
    },
    tx,
  );

  return guardianId;
}

/**
 * Move the originating lead to ENROLLED and point the student at it.
 *
 * The lead is never deleted or emptied: `Student.leadId` plus the lead's own
 * activity and status trail is how "where did this student come from, and who
 * worked the deal" stays answerable years later.
 */
async function closeLead(
  ctx: AccessContext,
  tx: Tx,
  input: {
    readonly leadId: string;
    readonly studentId: string;
    readonly applicationNumber: string;
  },
): Promise<void> {
  const lead = await tx.lead.findFirst({
    where: { id: input.leadId, organizationId: ctx.organizationId },
    select: { id: true, status: true, convertedAt: true },
  });
  if (!lead) return;

  // `Student.leadId` is unique: if another student already holds this lead, leave
  // the pointer alone rather than failing the admission over provenance.
  const holder = await tx.student.findFirst({
    where: { leadId: lead.id, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!holder) {
    await tx.student.update({ where: { id: input.studentId }, data: { leadId: lead.id } });
  }

  if (lead.status === 'ENROLLED') return;

  const now = new Date();
  await tx.lead.update({
    where: { id: lead.id },
    data: { status: 'ENROLLED', convertedAt: lead.convertedAt ?? now },
  });
  await tx.leadStatusHistory.create({
    data: {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: 'ENROLLED',
      reason: `Enrolled from application ${input.applicationNumber}`,
      changedById: ctx.isSystem ? null : ctx.userId,
    },
  });
  await tx.leadActivity.create({
    data: {
      leadId: lead.id,
      type: 'CONVERTED',
      subject: 'Converted to student',
      body: `Application ${input.applicationNumber} enrolled`,
      createdById: ctx.isSystem ? null : ctx.userId,
      occurredAt: now,
      metadata: { studentId: input.studentId },
    },
  });

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.LEAD_CONVERTED,
      entityType: 'Lead',
      entityId: lead.id,
      summary: `Lead converted through application ${input.applicationNumber}`,
      metadata: { studentId: input.studentId },
      timeline: {
        subjectType: 'LEAD',
        subjectId: lead.id,
        type: 'lead.converted',
        title: 'Converted to student',
        occurredAt: now,
      },
    },
    tx,
  );
}
