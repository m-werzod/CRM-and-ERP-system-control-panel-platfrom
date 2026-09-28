/**
 * Applications: the admissions record for a person who is not yet a student.
 *
 * An application carries the applicant's details itself rather than creating a
 * Student up front. That is what keeps the funnel honest: a rejected applicant
 * never becomes a student row that has to be cleaned up afterwards, and the
 * person is created exactly once, by `createStudentFromApplication`.
 *
 * DRAFT -> SUBMITTED is the boundary between "being typed in" and "in the
 * pipeline". Only those two states are editable; once reviews have been recorded
 * against an application, changing the details underneath them would invalidate
 * the gates that were already signed off.
 */

import type {
  ApplicationReviewStage,
  ApplicationStatus,
  Gender,
  GuardianRelationship,
  Prisma,
  ProgramLevel,
} from '@/generated/prisma/client';
import { withTransaction, prisma, type Db, type Tx } from '@/server/db/client';
import { BusinessRuleError, NotFoundError, StateInvalidError } from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  composeReadFilter,
  organizationFilter,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  scopeFilterNullableBranch,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import {
  dateOnlyToPrismaDate,
  endOfDayExclusiveInstant,
  startOfDayInstant,
  type DateOnly,
} from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import { nextApplicationNumber } from '@/server/services/finance/numbering';

/**
 * The gates opened when an application is submitted. All five are created so the
 * review screen is a complete checklist from the start; which of them actually
 * block a decision is decided in ./reviews.ts, not by their existence.
 */
export const DEFAULT_REVIEW_STAGES: readonly ApplicationReviewStage[] = [
  'DOCUMENT_CHECK',
  'PLACEMENT_TEST',
  'INTERVIEW',
  'FINANCE_CHECK',
  'FINAL_APPROVAL',
];

/** States in which the applicant's own details may still be corrected. */
const EDITABLE_STATUSES: readonly ApplicationStatus[] = ['DRAFT', 'SUBMITTED'];

export interface ApplicationSummary {
  readonly id: string;
  readonly applicationNumber: string;
  readonly status: ApplicationStatus;
  readonly branchId: string;
}

export interface CreateApplicationInput {
  readonly branchId?: string | null;
  /** CRM provenance: the lead this application came out of. */
  readonly leadId?: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly middleName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: Gender;
  readonly phone: string;
  readonly email?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly guardianName?: string | null;
  readonly guardianPhone?: string | null;
  readonly guardianRelation?: GuardianRelationship | null;
  readonly programId: string;
  readonly desiredStartDate?: DateOnly | null;
  readonly desiredLevel?: ProgramLevel | null;
  readonly notes?: string | null;
  /** Submit in the same transaction instead of leaving a draft. */
  readonly submitNow?: boolean;
}

/**
 * Narrowing for a SELF-scoped caller (a sales agent). An application has no
 * assignee of its own, so "mine" means one I raised, or one raised against a lead
 * I own. `leads.viewAll` lifts it, which is how a sales manager sees every
 * application in the branch while an agent sees their own.
 */
function selfApplicationFilter(ctx: AccessContext): Record<string, unknown> {
  return {
    OR: [{ createdById: ctx.userId }, { lead: { assignedToUserId: ctx.userId } }],
  };
}

function applicationReadFilter(ctx: AccessContext): Prisma.ApplicationWhereInput {
  return composeReadFilter(ctx, {
    selfFilter: selfApplicationFilter(ctx),
    escapeHatch: 'leads.viewAll',
  }) as Prisma.ApplicationWhereInput;
}

/** Normalise a contact number or refuse the write; never store an unusable one. */
function requireNormalizedPhone(phone: string, field: string): string {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new BusinessRuleError(
      'application.invalid_phone',
      `The ${field} is not a usable phone number.`,
    );
  }
  return normalized;
}

/**
 * Load an application for a write, with the caller's scope in the SAME predicate.
 * Fetching first and checking the branch afterwards would answer "that id exists,
 * just not for you", which is enough to enumerate another branch's applicants.
 */
export async function loadApplicationForWrite(
  ctx: AccessContext,
  tx: Tx,
  applicationId: string,
): Promise<{
  id: string;
  applicationNumber: string;
  status: ApplicationStatus;
  branchId: string;
  leadId: string | null;
  firstName: string;
  lastName: string;
}> {
  const application = await tx.application.findFirst({
    where: { id: applicationId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      applicationNumber: true,
      status: true,
      branchId: true,
      leadId: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!application) throw new NotFoundError('Application', applicationId);
  return application;
}

export async function createApplication(
  ctx: AccessContext,
  input: CreateApplicationInput,
  db?: Db,
): Promise<ApplicationSummary> {
  requirePermission(ctx, 'applications.create');
  // Submitting in the same call performs the DRAFT -> SUBMITTED transition too, so
  // it passes that use-case's own check rather than riding in on `create`.
  if (input.submitNow) requirePermission(ctx, 'applications.edit');

  return withTransaction(
    async (tx) => {
      const branchId = resolveWriteBranch(ctx, input.branchId, 'application');

      // A programme is organisation-wide (no branch column), so only tenancy
      // applies here.
      const program = await tx.program.findFirst({
        where: { id: input.programId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, name: true },
      });
      if (!program) throw new NotFoundError('Program', input.programId);

      const phoneNormalized = requireNormalizedPhone(input.phone, 'applicant phone number');
      const guardianPhone = input.guardianPhone
        ? requireNormalizedPhone(input.guardianPhone, 'guardian phone number')
        : null;

      const lead = input.leadId
        ? await tx.lead.findFirst({
            // Leads carry a nullable branch: an unassigned lead belongs to the
            // organisation and is visible to anyone inside it.
            where: { id: input.leadId, ...scopeFilterNullableBranch(ctx), deletedAt: null },
            select: { id: true, status: true, firstName: true, lastName: true },
          })
        : null;
      if (input.leadId && !lead) throw new NotFoundError('Lead', input.leadId);

      const applicationNumber = await nextApplicationNumber(tx, ctx.organizationId);

      const application = await tx.application.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          applicationNumber,
          leadId: lead?.id ?? null,
          firstName: input.firstName,
          lastName: input.lastName,
          middleName: input.middleName ?? null,
          dateOfBirth: input.dateOfBirth ? dateOnlyToPrismaDate(input.dateOfBirth) : null,
          gender: input.gender ?? 'UNSPECIFIED',
          phone: input.phone,
          phoneNormalized,
          email: input.email ?? null,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          guardianName: input.guardianName ?? null,
          guardianPhone,
          guardianRelation: input.guardianRelation ?? null,
          programId: program.id,
          desiredStartDate: input.desiredStartDate
            ? dateOnlyToPrismaDate(input.desiredStartDate)
            : null,
          desiredLevel: input.desiredLevel ?? null,
          notes: input.notes ?? null,
          status: 'DRAFT',
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: { id: true, applicationNumber: true, status: true, branchId: true },
      });

      if (lead) {
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'APPLICATION_CREATED',
            subject: `Application ${application.applicationNumber}`,
            body: `Applied for ${program.name}`,
            createdById: ctx.isSystem ? null : ctx.userId,
            metadata: {
              applicationId: application.id,
              applicationNumber: application.applicationNumber,
            },
          },
        });

        // Advance the pipeline, but only forwards: a lead that is already
        // ENROLLED, LOST or CLOSED must not be dragged back to APPLICATION by a
        // second application raised against it.
        if (
          lead.status === 'NEW' ||
          lead.status === 'CONTACTED' ||
          lead.status === 'QUALIFIED' ||
          lead.status === 'TRIAL_BOOKED' ||
          lead.status === 'TRIAL_COMPLETED'
        ) {
          await tx.lead.update({ where: { id: lead.id }, data: { status: 'APPLICATION' } });
          await tx.leadStatusHistory.create({
            data: {
              leadId: lead.id,
              fromStatus: lead.status,
              toStatus: 'APPLICATION',
              reason: `Application ${application.applicationNumber} created`,
              changedById: ctx.isSystem ? null : ctx.userId,
            },
          });
        }
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.APPLICATION_CREATED,
          entityType: 'Application',
          entityId: application.id,
          branchId,
          summary: `Application ${application.applicationNumber} created for ${input.firstName} ${input.lastName}`,
          metadata: { programId: program.id, leadId: lead?.id ?? null },
          timeline: {
            subjectType: 'APPLICATION',
            subjectId: application.id,
            type: 'application.created',
            title: `Application ${application.applicationNumber} created`,
            description: program.name,
          },
        },
        tx,
      );

      if (input.submitNow) {
        return submitApplicationInTransaction(ctx, tx, application.id);
      }
      return application;
    },
    { existing: db },
  );
}

export interface UpdateApplicationInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly middleName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: Gender;
  readonly phone?: string;
  readonly email?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly guardianName?: string | null;
  readonly guardianPhone?: string | null;
  readonly guardianRelation?: GuardianRelationship | null;
  readonly programId?: string;
  readonly desiredStartDate?: DateOnly | null;
  readonly desiredLevel?: ProgramLevel | null;
  readonly notes?: string | null;
}

/**
 * Correct the applicant's details. DRAFT and SUBMITTED only — once a reviewer has
 * signed off a gate, the details they checked are part of that decision.
 */
export async function updateApplication(
  ctx: AccessContext,
  applicationId: string,
  input: UpdateApplicationInput,
  db?: Db,
): Promise<ApplicationSummary> {
  requirePermission(ctx, 'applications.edit');

  return withTransaction(
    async (tx) => {
      const existing = await tx.application.findFirst({
        where: { id: applicationId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          applicationNumber: true,
          status: true,
          branchId: true,
          firstName: true,
          lastName: true,
          middleName: true,
          gender: true,
          phone: true,
          email: true,
          addressLine: true,
          city: true,
          guardianName: true,
          guardianPhone: true,
          guardianRelation: true,
          programId: true,
          desiredLevel: true,
          notes: true,
        },
      });
      if (!existing) throw new NotFoundError('Application', applicationId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new StateInvalidError('application', existing.status.toLowerCase(), 'edited');
      }

      const data: Prisma.ApplicationUpdateInput = {};

      if (input.firstName !== undefined) data.firstName = input.firstName;
      if (input.lastName !== undefined) data.lastName = input.lastName;
      if (input.middleName !== undefined) data.middleName = input.middleName;
      if (input.gender !== undefined) data.gender = input.gender;
      if (input.email !== undefined) data.email = input.email;
      if (input.addressLine !== undefined) data.addressLine = input.addressLine;
      if (input.city !== undefined) data.city = input.city;
      if (input.guardianName !== undefined) data.guardianName = input.guardianName;
      if (input.guardianRelation !== undefined) data.guardianRelation = input.guardianRelation;
      if (input.desiredLevel !== undefined) data.desiredLevel = input.desiredLevel;
      if (input.notes !== undefined) data.notes = input.notes;

      if (input.phone !== undefined) {
        data.phone = input.phone;
        // Both columns move together; a stale `phoneNormalized` would silently
        // break duplicate detection and search.
        data.phoneNormalized = requireNormalizedPhone(input.phone, 'applicant phone number');
      }
      if (input.guardianPhone !== undefined) {
        data.guardianPhone = input.guardianPhone
          ? requireNormalizedPhone(input.guardianPhone, 'guardian phone number')
          : null;
      }
      if (input.dateOfBirth !== undefined) {
        data.dateOfBirth = input.dateOfBirth ? dateOnlyToPrismaDate(input.dateOfBirth) : null;
      }
      if (input.desiredStartDate !== undefined) {
        data.desiredStartDate = input.desiredStartDate
          ? dateOnlyToPrismaDate(input.desiredStartDate)
          : null;
      }
      if (input.programId !== undefined && input.programId !== existing.programId) {
        const program = await tx.program.findFirst({
          where: { id: input.programId, ...organizationFilter(ctx), deletedAt: null },
          select: { id: true },
        });
        if (!program) throw new NotFoundError('Program', input.programId);
        data.program = { connect: { id: program.id } };
      }

      const updated = await tx.application.update({
        where: { id: existing.id },
        data,
        select: { id: true, applicationNumber: true, status: true, branchId: true },
      });

      await recordAudit(
        ctx,
        {
          action: 'application.updated',
          entityType: 'Application',
          entityId: existing.id,
          branchId: existing.branchId,
          summary: `Application ${existing.applicationNumber} updated`,
          changes: diffFields(
            {
              firstName: existing.firstName,
              lastName: existing.lastName,
              middleName: existing.middleName,
              gender: existing.gender,
              phone: existing.phone,
              email: existing.email,
              addressLine: existing.addressLine,
              city: existing.city,
              guardianName: existing.guardianName,
              guardianPhone: existing.guardianPhone,
              guardianRelation: existing.guardianRelation,
              programId: existing.programId,
              desiredLevel: existing.desiredLevel,
              notes: existing.notes,
            },
            {
              firstName: input.firstName,
              lastName: input.lastName,
              middleName: input.middleName,
              gender: input.gender,
              phone: input.phone,
              email: input.email,
              addressLine: input.addressLine,
              city: input.city,
              guardianName: input.guardianName,
              guardianPhone: input.guardianPhone,
              guardianRelation: input.guardianRelation,
              programId: input.programId,
              desiredLevel: input.desiredLevel,
              notes: input.notes,
            },
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

/**
 * Submit a draft: stamp `submittedAt` and open the review gates.
 *
 * The gate rows are created here rather than at creation time so a half-typed
 * draft does not show up on anyone's review worklist.
 */
export async function submitApplication(
  ctx: AccessContext,
  applicationId: string,
  db?: Db,
): Promise<ApplicationSummary> {
  // There is no `applications.submit` key in the catalogue; submitting is the last
  // act of filling the form in, so it rides on `applications.edit`.
  requirePermission(ctx, 'applications.edit');
  return withTransaction((tx) => submitApplicationInTransaction(ctx, tx, applicationId), {
    existing: db,
  });
}

async function submitApplicationInTransaction(
  ctx: AccessContext,
  tx: Tx,
  applicationId: string,
): Promise<ApplicationSummary> {
  const application = await loadApplicationForWrite(ctx, tx, applicationId);
  if (application.status !== 'DRAFT') {
    throw new StateInvalidError('application', application.status.toLowerCase(), 'submitted');
  }

  const submittedAt = new Date();
  const updated = await tx.application.update({
    where: { id: application.id },
    data: { status: 'SUBMITTED', submittedAt },
    select: { id: true, applicationNumber: true, status: true, branchId: true },
  });

  // `skipDuplicates` leans on the (applicationId, stage) unique index so a
  // double-submitted form cannot produce two DOCUMENT_CHECK rows.
  await tx.applicationReview.createMany({
    data: DEFAULT_REVIEW_STAGES.map((stage) => ({ applicationId: application.id, stage })),
    skipDuplicates: true,
  });

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.APPLICATION_SUBMITTED,
      entityType: 'Application',
      entityId: application.id,
      branchId: application.branchId,
      summary: `Application ${application.applicationNumber} submitted`,
      metadata: { stages: [...DEFAULT_REVIEW_STAGES] },
      timeline: {
        subjectType: 'APPLICATION',
        subjectId: application.id,
        type: 'application.submitted',
        title: 'Application submitted',
        occurredAt: submittedAt,
      },
    },
    tx,
  );

  return updated;
}

export interface ApplicationListRow {
  readonly id: string;
  readonly applicationNumber: string;
  readonly status: ApplicationStatus;
  readonly branchId: string;
  readonly branchName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly programId: string;
  readonly programName: string;
  readonly desiredStartDate: Date | null;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
  readonly leadId: string | null;
  readonly studentId: string | null;
}

export interface ListApplicationsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: readonly ApplicationStatus[] | null;
  readonly branchId?: string | null;
  readonly programId?: string | null;
  /** Calendar range over `createdAt`, in the branch's timezone. */
  readonly from?: DateOnly | null;
  readonly to?: DateOnly | null;
  /** Name, application number, email or phone. */
  readonly q?: string | null;
  readonly sortBy?: 'createdAt' | 'submittedAt' | 'lastName' | 'applicationNumber';
  readonly sortDir?: 'asc' | 'desc';
}

const LIST_PAGE_SIZE_MAX = 100;

export async function listApplications(
  ctx: AccessContext,
  input: ListApplicationsInput = {},
  db: Db = prisma,
): Promise<{ rows: ApplicationListRow[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, 'applications.view');

  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(LIST_PAGE_SIZE_MAX, Math.max(1, input.pageSize ?? 25));

  const where: Prisma.ApplicationWhereInput = {
    ...applicationReadFilter(ctx),
    deletedAt: null,
    ...(input.status && input.status.length > 0 ? { status: { in: [...input.status] } } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.programId ? { programId: input.programId } : {}),
  };

  if (input.from || input.to) {
    const { timezone } = await getSettings(
      ['timezone'],
      { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
      db,
    );
    // A calendar filter is resolved to instants in the branch's zone: an
    // application created at 23:30 in Tashkent belongs to that local day. Each
    // bound is converted on its own so an open-ended range needs no sentinel date.
    where.createdAt = {
      ...(input.from ? { gte: startOfDayInstant(input.from, timezone) } : {}),
      ...(input.to ? { lt: endOfDayExclusiveInstant(input.to, timezone) } : {}),
    };
  }

  const term = input.q?.trim();
  if (term) {
    const asPhone = normalizePhone(term);
    where.OR = [
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { applicationNumber: { contains: term, mode: 'insensitive' } },
      { email: { contains: term, mode: 'insensitive' } },
      ...(asPhone ? [{ phoneNormalized: { contains: asPhone } }] : []),
    ];
  }

  const sortBy = input.sortBy ?? 'createdAt';
  const sortDir = input.sortDir ?? 'desc';
  const orderBy: Prisma.ApplicationOrderByWithRelationInput[] =
    sortBy === 'lastName'
      ? [{ lastName: sortDir }, { firstName: sortDir }]
      : [{ [sortBy]: sortDir } as Prisma.ApplicationOrderByWithRelationInput];

  // One count + one page, both filtered and ordered in SQL.
  const [total, rows] = await Promise.all([
    db.application.count({ where }),
    db.application.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        applicationNumber: true,
        status: true,
        branchId: true,
        firstName: true,
        lastName: true,
        phone: true,
        programId: true,
        desiredStartDate: true,
        submittedAt: true,
        decidedAt: true,
        createdAt: true,
        leadId: true,
        branch: { select: { name: true } },
        program: { select: { name: true } },
        student: { select: { id: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      applicationNumber: row.applicationNumber,
      status: row.status,
      branchId: row.branchId,
      branchName: row.branch.name,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      programId: row.programId,
      programName: row.program.name,
      desiredStartDate: row.desiredStartDate,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
      leadId: row.leadId,
      studentId: row.student?.id ?? null,
    })),
  };
}

export interface ApplicationDetail extends ApplicationListRow {
  readonly middleName: string | null;
  readonly dateOfBirth: Date | null;
  readonly gender: Gender;
  readonly email: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly guardianName: string | null;
  readonly guardianPhone: string | null;
  readonly guardianRelation: GuardianRelationship | null;
  readonly desiredLevel: ProgramLevel | null;
  readonly placementScore: number | null;
  readonly decision: string | null;
  readonly decisionReason: string | null;
  readonly admissionDate: Date | null;
  readonly notes: string | null;
  readonly reviews: ReadonlyArray<{
    readonly id: string;
    readonly stage: ApplicationReviewStage;
    readonly status: string;
    readonly notes: string | null;
    readonly score: number | null;
    readonly reviewerId: string | null;
    readonly reviewerName: string | null;
    readonly completedAt: Date | null;
  }>;
  readonly interviews: ReadonlyArray<{
    readonly id: string;
    readonly scheduledAt: Date;
    readonly durationMinutes: number;
    readonly location: string | null;
    readonly status: string;
    readonly interviewerId: string | null;
    readonly interviewerName: string | null;
    readonly score: number | null;
    readonly notes: string | null;
    readonly recommendation: string | null;
    readonly completedAt: Date | null;
  }>;
  readonly studentCode: string | null;
}

/** The application profile page: the record plus its gates and its interviews. */
export async function getApplication(
  ctx: AccessContext,
  applicationId: string,
  db: Db = prisma,
): Promise<ApplicationDetail> {
  requirePermission(ctx, 'applications.view');

  const row = await db.application.findFirst({
    where: { id: applicationId, ...applicationReadFilter(ctx), deletedAt: null },
    select: {
      id: true,
      applicationNumber: true,
      status: true,
      branchId: true,
      firstName: true,
      lastName: true,
      middleName: true,
      dateOfBirth: true,
      gender: true,
      phone: true,
      email: true,
      addressLine: true,
      city: true,
      guardianName: true,
      guardianPhone: true,
      guardianRelation: true,
      programId: true,
      desiredStartDate: true,
      desiredLevel: true,
      placementScore: true,
      submittedAt: true,
      decision: true,
      decisionReason: true,
      decidedAt: true,
      admissionDate: true,
      notes: true,
      createdAt: true,
      leadId: true,
      branch: { select: { name: true } },
      program: { select: { name: true } },
      student: { select: { id: true, studentCode: true } },
      reviews: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          stage: true,
          status: true,
          notes: true,
          score: true,
          reviewerId: true,
          completedAt: true,
          reviewer: { select: { firstName: true, lastName: true } },
        },
      },
      interviews: {
        orderBy: { scheduledAt: 'desc' },
        select: {
          id: true,
          scheduledAt: true,
          durationMinutes: true,
          location: true,
          status: true,
          interviewerId: true,
          score: true,
          notes: true,
          recommendation: true,
          completedAt: true,
          interviewer: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('Application', applicationId);

  return {
    id: row.id,
    applicationNumber: row.applicationNumber,
    status: row.status,
    branchId: row.branchId,
    branchName: row.branch.name,
    firstName: row.firstName,
    lastName: row.lastName,
    middleName: row.middleName,
    dateOfBirth: row.dateOfBirth,
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    addressLine: row.addressLine,
    city: row.city,
    guardianName: row.guardianName,
    guardianPhone: row.guardianPhone,
    guardianRelation: row.guardianRelation,
    programId: row.programId,
    programName: row.program.name,
    desiredStartDate: row.desiredStartDate,
    desiredLevel: row.desiredLevel,
    placementScore: row.placementScore,
    submittedAt: row.submittedAt,
    decision: row.decision,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt,
    admissionDate: row.admissionDate,
    notes: row.notes,
    createdAt: row.createdAt,
    leadId: row.leadId,
    studentId: row.student?.id ?? null,
    studentCode: row.student?.studentCode ?? null,
    reviews: row.reviews.map((review) => ({
      id: review.id,
      stage: review.stage,
      status: review.status,
      notes: review.notes,
      score: review.score,
      reviewerId: review.reviewerId,
      reviewerName: review.reviewer
        ? `${review.reviewer.firstName} ${review.reviewer.lastName}`
        : null,
      completedAt: review.completedAt,
    })),
    interviews: row.interviews.map((interview) => ({
      id: interview.id,
      scheduledAt: interview.scheduledAt,
      durationMinutes: interview.durationMinutes,
      location: interview.location,
      status: interview.status,
      interviewerId: interview.interviewerId,
      interviewerName: interview.interviewer
        ? `${interview.interviewer.firstName} ${interview.interviewer.lastName}`
        : null,
      score: interview.score,
      notes: interview.notes,
      recommendation: interview.recommendation,
      completedAt: interview.completedAt,
    })),
  };
}

/** Exported for the sibling use-cases, which all need the same scoped read. */
export { applicationReadFilter };
