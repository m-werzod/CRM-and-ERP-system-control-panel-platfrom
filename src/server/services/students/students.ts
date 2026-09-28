/**
 * Student use-cases: registration, editing, archiving and the two ways a student
 * leaves — withdrawal and graduation.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 *  * A student is NEVER hard-deleted. Attendance, invoices and ledger rows point
 *    at them, and `ledger_entries` is append-only, so a delete would either fail
 *    or orphan financial history. `archiveStudent` sets `deletedAt`; every read in
 *    this file filters on it, and `getGroupRoster` already excludes archived
 *    students, so archiving quietly removes them from tomorrow's registers without
 *    touching yesterday's.
 *
 *  * Leaving is a lifecycle transition, not an edit. `withdrawStudent` and
 *    `graduateStudent` close every OPEN enrollment through `endEnrollment`, so the
 *    dated history rule that file enforces is not bypassed by a status update.
 *    `updateStudent` therefore refuses to set a terminal status.
 *
 *  * `studentCode` comes from `nextStudentCode` inside the creating transaction.
 *    Allocating it earlier would leave a permanent gap in the sequence whenever a
 *    validation failure rolls the creation back.
 */

import type {
  EnrollmentEndReason,
  Gender,
  Prisma,
  StudentStatus,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  StateInvalidError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  isSelfScoped,
  requireAnyPermission,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  selfStudentFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import {
  ageInYears,
  dateOnlyToPrismaDate,
  dayRangeToInstants,
  prismaDateToDateOnly,
  todayIn,
  type DateOnly,
} from '@/lib/dates';
import { formatMoney, money } from '@/lib/money';
import { normalizePhone } from '@/lib/validation';
import { nextStudentCode } from '@/server/services/finance/numbering';
import { currencyFor } from '@/server/services/finance/currency';
import { getStudentBalance } from '@/server/services/finance/ledger';
import { endEnrollment } from '@/server/services/students/enrollment';
import {
  createGuardian,
  linkGuardianToStudent,
  type CreateGuardianInput,
  type GuardianLinkAttributes,
} from '@/server/services/students/guardians';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Statuses a plain edit may set. The rest are reached through a use-case. */
const EDITABLE_STATUSES: ReadonlySet<StudentStatus> = new Set<StudentStatus>([
  'PROSPECT',
  'ACTIVE',
  'ON_HOLD',
  'SUSPENDED',
]);

export interface StudentContactInput {
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly emergencyContactName?: string | null;
  readonly emergencyContactPhone?: string | null;
  readonly emergencyContactRelation?: string | null;
}

export interface CreateStudentInput extends StudentContactInput {
  /** Omitted for a branch-scoped caller: their primary branch is used. */
  readonly branchId?: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly middleName?: string | null;
  readonly dateOfBirth?: DateOnly | null;
  readonly gender?: Gender;
  readonly photoUrl?: string | null;
  /** Only the tail of a government id; the full value belongs in a Document. */
  readonly nationalIdLast4?: string | null;
  readonly status?: StudentStatus;
  readonly notes?: string | null;
  /** CRM / admissions provenance, set by the conversion use-cases. */
  readonly leadId?: string | null;
  readonly applicationId?: string | null;
  /**
   * Guardians to create and link in the same transaction. Requires the caller to
   * also hold `guardians.create` and `guardians.link` — the whole registration
   * rolls back rather than leaving a student with no parent on record.
   */
  readonly guardians?: ReadonlyArray<CreateGuardianInput & GuardianLinkAttributes>;
}

export type UpdateStudentInput = Partial<
  Omit<CreateStudentInput, 'branchId' | 'guardians' | 'leadId' | 'applicationId'>
>;

export interface StudentDetail {
  readonly id: string;
  readonly studentCode: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly middleName: string | null;
  readonly fullName: string;
  readonly dateOfBirth: DateOnly | null;
  readonly ageYears: number | null;
  readonly gender: Gender;
  readonly phone: string | null;
  readonly phoneNormalized: string | null;
  readonly email: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly photoUrl: string | null;
  readonly nationalIdLast4: string | null;
  readonly status: StudentStatus;
  readonly enrolledAt: Date | null;
  readonly graduatedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly withdrawalReason: string | null;
  readonly notes: string | null;
  readonly emergencyContactName: string | null;
  readonly emergencyContactPhone: string | null;
  readonly emergencyContactRelation: string | null;
  readonly leadId: string | null;
  readonly applicationId: string | null;
  readonly userId: string | null;
  readonly isArchived: boolean;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const STUDENT_SELECT = {
  id: true,
  studentCode: true,
  branchId: true,
  branch: { select: { name: true } },
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
  postalCode: true,
  photoUrl: true,
  nationalIdLast4: true,
  status: true,
  enrolledAt: true,
  graduatedAt: true,
  withdrawnAt: true,
  withdrawalReason: true,
  notes: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  emergencyContactRelation: true,
  leadId: true,
  applicationId: true,
  userId: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StudentSelect;

type StudentRow = Prisma.StudentGetPayload<{ select: typeof STUDENT_SELECT }>;

function toStudentDetail(row: StudentRow, today: DateOnly): StudentDetail {
  const dateOfBirth = row.dateOfBirth === null ? null : prismaDateToDateOnly(row.dateOfBirth);
  return {
    id: row.id,
    studentCode: row.studentCode,
    branchId: row.branchId,
    branchName: row.branch.name,
    firstName: row.firstName,
    lastName: row.lastName,
    middleName: row.middleName,
    fullName: `${row.firstName} ${row.lastName}`,
    dateOfBirth,
    ageYears: dateOfBirth === null ? null : ageInYears(dateOfBirth, today),
    gender: row.gender,
    phone: row.phone,
    phoneNormalized: row.phoneNormalized,
    email: row.email,
    addressLine: row.addressLine,
    city: row.city,
    postalCode: row.postalCode,
    photoUrl: row.photoUrl,
    nationalIdLast4: row.nationalIdLast4,
    status: row.status,
    enrolledAt: row.enrolledAt,
    graduatedAt: row.graduatedAt,
    withdrawnAt: row.withdrawnAt,
    withdrawalReason: row.withdrawalReason,
    notes: row.notes,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    emergencyContactRelation: row.emergencyContactRelation,
    leadId: row.leadId,
    applicationId: row.applicationId,
    userId: row.userId,
    isArchived: row.deletedAt !== null,
    archivedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Normalise a phone the service was handed. The boundary schema normalises too;
 * a service is never allowed to assume it ran.
 */
function normalizeOptionalPhone(value: string | null | undefined, field: string): string | null {
  if (value == null || value.trim() === '') return null;
  const normalized = normalizePhone(value);
  if (!normalized) {
    throw new ValidationError([{ path: field, message: 'Not a valid phone number' }]);
  }
  return normalized;
}

function assertNationalIdTail(value: string | null | undefined): void {
  // The column is VarChar(8); a longer value would fail as an unmapped database
  // error rather than a field-level message the form can show.
  if (value != null && value.length > 8) {
    throw new ValidationError([
      { path: 'nationalIdLast4', message: 'Store only the last 8 characters of the id' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createStudent(
  ctx: AccessContext,
  input: CreateStudentInput,
  db?: Db,
): Promise<StudentDetail> {
  requirePermission(ctx, 'students.create');

  const branchId = resolveWriteBranch(ctx, input.branchId, 'student');
  const phoneNormalized = normalizeOptionalPhone(input.phone, 'phone');
  const emergencyPhone = normalizeOptionalPhone(
    input.emergencyContactPhone,
    'emergencyContactPhone',
  );
  assertNationalIdTail(input.nationalIdLast4);

  const status = input.status ?? 'PROSPECT';
  if (!EDITABLE_STATUSES.has(status)) {
    throw new BusinessRuleError(
      'student.invalid_initial_status',
      'A new student cannot start as graduated or withdrawn.',
      { details: { status } },
    );
  }

  return withTransaction(
    async (tx) => {
      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId },
        tx,
      );
      const today = todayIn(timezone);
      const studentCode = await nextStudentCode(tx, ctx.organizationId);

      const row = await tx.student.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          studentCode,
          firstName: input.firstName,
          lastName: input.lastName,
          middleName: input.middleName ?? null,
          dateOfBirth: input.dateOfBirth ? dateOnlyToPrismaDate(input.dateOfBirth) : null,
          gender: input.gender ?? 'UNSPECIFIED',
          phone: input.phone ?? null,
          phoneNormalized,
          email: input.email ?? null,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          postalCode: input.postalCode ?? null,
          photoUrl: input.photoUrl ?? null,
          nationalIdLast4: input.nationalIdLast4 ?? null,
          status,
          // Registering someone as already active records that today, so the
          // first invoice period and the enrolled-date report agree.
          enrolledAt: status === 'ACTIVE' ? new Date() : null,
          notes: input.notes ?? null,
          emergencyContactName: input.emergencyContactName ?? null,
          emergencyContactPhone: emergencyPhone,
          emergencyContactRelation: input.emergencyContactRelation ?? null,
          leadId: input.leadId ?? null,
          applicationId: input.applicationId ?? null,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: STUDENT_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_CREATED,
          entityType: 'Student',
          entityId: row.id,
          branchId,
          summary: `Student ${row.firstName} ${row.lastName} (${row.studentCode}) registered`,
          metadata: { studentCode: row.studentCode, status },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: row.id,
            type: 'student.created',
            title: 'Student registered',
          },
        },
        tx,
      );

      // Sequential, not parallel: the guardians share a student, and at most one
      // of them may be primary, so the order in which conflicts surface has to be
      // the order the caller listed them in.
      for (const seed of input.guardians ?? []) {
        const { guardian } = await createGuardian(ctx, seed, tx);
        await linkGuardianToStudent(
          ctx,
          {
            studentId: row.id,
            guardianId: guardian.id,
            relationship: seed.relationship,
            isPrimary: seed.isPrimary,
            isEmergencyContact: seed.isEmergencyContact,
            canPickUp: seed.canPickUp,
            receivesInvoices: seed.receivesInvoices,
            receivesNotifications: seed.receivesNotifications,
          },
          tx,
        );
      }

      return toStudentDetail(row, today);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateStudent(
  ctx: AccessContext,
  studentId: string,
  input: UpdateStudentInput,
  db?: Db,
): Promise<StudentDetail> {
  requirePermission(ctx, 'students.edit');

  if (input.status !== undefined && !EDITABLE_STATUSES.has(input.status)) {
    throw new BusinessRuleError(
      'student.status_needs_use_case',
      'Graduating or withdrawing a student closes their enrollments, so it cannot be done as an edit.',
      { details: { status: input.status } },
    );
  }
  assertNationalIdTail(input.nationalIdLast4);

  return withTransaction(
    async (tx) => {
      const current = await tx.student.findFirst({
        where: { id: studentId, ...scopeFilter(ctx), deletedAt: null },
        select: STUDENT_SELECT,
      });
      if (!current) throw new NotFoundError('Student', studentId);

      // Bringing a former student back is a re-enrolment, not a status edit: the
      // new enrollment is what makes them active again (see enrollment.ts).
      if (
        input.status !== undefined &&
        (current.status === 'WITHDRAWN' || current.status === 'GRADUATED')
      ) {
        throw new StateInvalidError('student', current.status.toLowerCase(), 'reactivated');
      }

      const data: Prisma.StudentUpdateInput = {};
      if (input.firstName !== undefined) data.firstName = input.firstName;
      if (input.lastName !== undefined) data.lastName = input.lastName;
      if (input.middleName !== undefined) data.middleName = input.middleName;
      if (input.dateOfBirth !== undefined) {
        data.dateOfBirth = input.dateOfBirth ? dateOnlyToPrismaDate(input.dateOfBirth) : null;
      }
      if (input.gender !== undefined) data.gender = input.gender;
      if (input.phone !== undefined) {
        data.phone = input.phone;
        data.phoneNormalized = normalizeOptionalPhone(input.phone, 'phone');
      }
      if (input.email !== undefined) data.email = input.email;
      if (input.addressLine !== undefined) data.addressLine = input.addressLine;
      if (input.city !== undefined) data.city = input.city;
      if (input.postalCode !== undefined) data.postalCode = input.postalCode;
      if (input.photoUrl !== undefined) data.photoUrl = input.photoUrl;
      if (input.nationalIdLast4 !== undefined) data.nationalIdLast4 = input.nationalIdLast4;
      if (input.status !== undefined) data.status = input.status;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.emergencyContactName !== undefined) {
        data.emergencyContactName = input.emergencyContactName;
      }
      if (input.emergencyContactPhone !== undefined) {
        data.emergencyContactPhone = normalizeOptionalPhone(
          input.emergencyContactPhone,
          'emergencyContactPhone',
        );
      }
      if (input.emergencyContactRelation !== undefined) {
        data.emergencyContactRelation = input.emergencyContactRelation;
      }

      // Only the fields whose value actually moved reach the audit row, so a form
      // that posts every field does not produce a diff of the whole record.
      const changes = diffFields<Record<string, unknown>>({ ...current }, { ...data });
      if (Object.keys(changes).length === 0) {
        const { timezone } = await getSettings(
          ['timezone'],
          { organizationId: ctx.organizationId, branchId: current.branchId },
          tx,
        );
        return toStudentDetail(current, todayIn(timezone));
      }

      const row = await tx.student.update({
        where: { id: current.id },
        data,
        select: STUDENT_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_UPDATED,
          entityType: 'Student',
          entityId: row.id,
          branchId: row.branchId,
          summary: `Student ${row.firstName} ${row.lastName} updated`,
          changes,
          timeline: {
            subjectType: 'STUDENT',
            subjectId: row.id,
            type: 'student.updated',
            title: 'Details updated',
            description: Object.keys(changes).join(', '),
          },
        },
        tx,
      );

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: row.branchId },
        tx,
      );
      return toStudentDetail(row, todayIn(timezone));
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Archive / restore
// ---------------------------------------------------------------------------

export interface ArchiveStudentInput {
  readonly reason?: string | null;
  /** Archive despite an outstanding balance. Recorded in the audit row. */
  readonly force?: boolean;
}

/**
 * Archive a student: a soft delete, always.
 *
 * Refused while money is owed, because an archived student disappears from the
 * debt report and the balance would simply stop being chased. `force` exists for
 * the legitimate case (the debt was written off elsewhere, the family left the
 * country) and says so in the audit trail.
 */
export async function archiveStudent(
  ctx: AccessContext,
  studentId: string,
  input: ArchiveStudentInput = {},
  db?: Db,
): Promise<{ readonly id: string; readonly archivedAt: Date }> {
  requirePermission(ctx, 'students.delete');

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true, studentCode: true },
      });
      if (!student) throw new NotFoundError('Student', studentId);

      const currency = await currencyFor(
        { organizationId: ctx.organizationId, branchId: student.branchId },
        tx,
      );
      const balance = await getStudentBalance(tx, {
        organizationId: ctx.organizationId,
        studentId: student.id,
        currency,
      });

      if (balance.outstandingMinor > 0n && !input.force) {
        throw new BusinessRuleError(
          'student.archive_with_debt',
          `${student.firstName} ${student.lastName} still owes ${formatMoney(
            money(balance.outstandingMinor, currency),
          )} across ${balance.invoiceCount} invoice(s). Settle or write the balance off first, or archive with force.`,
          {
            details: {
              outstandingMinor: balance.outstandingMinor.toString(),
              currency,
              invoiceCount: balance.invoiceCount,
            },
          },
        );
      }

      const archivedAt = new Date();
      await tx.student.update({ where: { id: student.id }, data: { deletedAt: archivedAt } });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_ARCHIVED,
          entityType: 'Student',
          entityId: student.id,
          branchId: student.branchId,
          summary: `Student ${student.firstName} ${student.lastName} (${student.studentCode}) archived`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: {
            forced: input.force === true,
            outstandingMinor: balance.outstandingMinor.toString(),
            currency,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'student.archived',
            title: 'Student archived',
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return { id: student.id, archivedAt };
    },
    { existing: db },
  );
}

export async function restoreStudent(
  ctx: AccessContext,
  studentId: string,
  db?: Db,
): Promise<{ readonly id: string; readonly status: StudentStatus }> {
  requirePermission(ctx, 'students.restore');

  return withTransaction(
    async (tx) => {
      // The scope predicate sits in the same where as the id; the `deletedAt`
      // state is then a legitimate 409 rather than a probe for existence.
      const student = await tx.student.findFirst({
        where: { id: studentId, ...scopeFilter(ctx) },
        select: {
          id: true,
          branchId: true,
          firstName: true,
          lastName: true,
          status: true,
          deletedAt: true,
        },
      });
      if (!student) throw new NotFoundError('Student', studentId);
      if (student.deletedAt === null) {
        throw new StateInvalidError('student', 'not archived', 'restored');
      }

      await tx.student.update({ where: { id: student.id }, data: { deletedAt: null } });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_RESTORED,
          entityType: 'Student',
          entityId: student.id,
          branchId: student.branchId,
          summary: `Student ${student.firstName} ${student.lastName} restored`,
          severity: 'NOTICE',
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'student.restored',
            title: 'Student restored from the archive',
          },
        },
        tx,
      );

      return { id: student.id, status: student.status };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Leaving: withdrawal and graduation
// ---------------------------------------------------------------------------

export interface LeaveStudentInput {
  readonly studentId: string;
  /** The day the student stops attending. Defaults to today in the branch zone. */
  readonly effectiveDate?: DateOnly;
  readonly reason?: string | null;
}

export interface StudentLeaveResult {
  readonly id: string;
  readonly status: StudentStatus;
  readonly effectiveDate: DateOnly;
  readonly closedEnrollmentIds: readonly string[];
}

/**
 * Shared body of withdrawal and graduation: close every open enrollment, then
 * move the student to the terminal status.
 *
 * The enrollments are closed through `endEnrollment` rather than with an
 * `updateMany` here, so the audit row, the timeline entry and the end-reason
 * bookkeeping that file owns all happen — and so there is only one place that
 * knows how an enrollment ends.
 */
async function leaveInstitution(
  ctx: AccessContext,
  tx: Tx,
  input: LeaveStudentInput,
  target: { status: 'WITHDRAWN' | 'GRADUATED'; endReason: EnrollmentEndReason },
): Promise<StudentLeaveResult> {
  const student = await tx.student.findFirst({
    where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, branchId: true, firstName: true, lastName: true, status: true },
  });
  if (!student) throw new NotFoundError('Student', input.studentId);
  assertBranchAccess(ctx, student.branchId, 'student');

  if (student.status === target.status) {
    throw new StateInvalidError('student', student.status.toLowerCase(), target.status.toLowerCase());
  }
  if (student.status === 'WITHDRAWN' || student.status === 'GRADUATED') {
    throw new StateInvalidError('student', student.status.toLowerCase(), target.status.toLowerCase());
  }

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: student.branchId },
    tx,
  );
  const effectiveDate = input.effectiveDate ?? todayIn(timezone);

  const open = await tx.enrollment.findMany({
    where: { studentId: student.id, endDate: null, group: scopeFilter(ctx) },
    select: { id: true, startDate: true },
  });

  const closedEnrollmentIds: string[] = [];
  for (const enrollment of open) {
    // A future-dated enrolment must not make the student impossible to withdraw,
    // and an enrolment cannot end before it began: the later of the two dates is
    // the only value that satisfies both.
    const startDate = prismaDateToDateOnly(enrollment.startDate);
    const endDate = startDate > effectiveDate ? startDate : effectiveDate;
    await endEnrollment(
      ctx,
      { enrollmentId: enrollment.id, endDate, reason: target.endReason, note: input.reason ?? null },
      tx,
    );
    closedEnrollmentIds.push(enrollment.id);
  }

  const now = new Date();
  await tx.student.update({
    where: { id: student.id },
    data:
      target.status === 'WITHDRAWN'
        ? { status: 'WITHDRAWN', withdrawnAt: now, withdrawalReason: input.reason ?? null }
        : { status: 'GRADUATED', graduatedAt: now },
  });

  await recordAudit(
    ctx,
    {
      action:
        target.status === 'WITHDRAWN'
          ? AUDIT_ACTIONS.STUDENT_WITHDRAWN
          : AUDIT_ACTIONS.STUDENT_GRADUATED,
      entityType: 'Student',
      entityId: student.id,
      branchId: student.branchId,
      summary: `${student.firstName} ${student.lastName} ${target.status.toLowerCase()} on ${effectiveDate}`,
      reason: input.reason ?? null,
      severity: 'NOTICE',
      metadata: { effectiveDate, closedEnrollments: closedEnrollmentIds.length },
      timeline: {
        subjectType: 'STUDENT',
        subjectId: student.id,
        type: target.status === 'WITHDRAWN' ? 'student.withdrawn' : 'student.graduated',
        title: target.status === 'WITHDRAWN' ? 'Withdrawn' : 'Graduated',
        description: input.reason ?? null,
      },
    },
    tx,
  );

  return { id: student.id, status: target.status, effectiveDate, closedEnrollmentIds };
}

export async function withdrawStudent(
  ctx: AccessContext,
  input: LeaveStudentInput,
  db?: Db,
): Promise<StudentLeaveResult> {
  requirePermission(ctx, 'students.withdraw');
  return withTransaction(
    (tx) => leaveInstitution(ctx, tx, input, { status: 'WITHDRAWN', endReason: 'WITHDRAWN' }),
    { existing: db },
  );
}

export async function graduateStudent(
  ctx: AccessContext,
  input: LeaveStudentInput,
  db?: Db,
): Promise<StudentLeaveResult> {
  requirePermission(ctx, 'students.withdraw');
  return withTransaction(
    (tx) => leaveInstitution(ctx, tx, input, { status: 'GRADUATED', endReason: 'COMPLETED' }),
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Lists and single reads
// ---------------------------------------------------------------------------

export type StudentSortField =
  | 'lastName'
  | 'firstName'
  | 'studentCode'
  | 'status'
  | 'enrolledAt'
  | 'createdAt';

export interface ListStudentsInput {
  readonly page?: number;
  readonly pageSize?: number;
  /** Free text over name, student code and phone. */
  readonly q?: string;
  readonly branchId?: string;
  readonly status?: readonly StudentStatus[];
  /** Students with an OPEN enrollment in this group. */
  readonly groupId?: string;
  /** Students with an OPEN enrollment in a group running this programme. */
  readonly programId?: string;
  readonly gender?: Gender;
  readonly enrolledFrom?: DateOnly;
  readonly enrolledTo?: DateOnly;
  /** Requires a financial permission; see the check in `listStudents`. */
  readonly hasDebt?: boolean;
  readonly includeArchived?: boolean;
  readonly sortBy?: StudentSortField;
  readonly sortDir?: 'asc' | 'desc';
}

export interface StudentListRow {
  readonly id: string;
  readonly studentCode: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly gender: Gender;
  readonly status: StudentStatus;
  readonly branchId: string;
  readonly branchName: string;
  readonly photoUrl: string | null;
  readonly enrolledAt: Date | null;
  readonly isArchived: boolean;
  /** Open groups, for the list cell. Capped: the profile shows the full history. */
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export interface StudentListResult {
  readonly rows: readonly StudentListRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** True when the free-text match had to be capped; the UI should say so. */
  readonly searchTruncated: boolean;
}

const PAGE_SIZE_CEILING = 100;
/**
 * How many index-backed candidates a free-text search considers. Bounded because
 * the id set is materialised in the application; ordered by trigram similarity so
 * the closest matches are the ones that survive the cap.
 */
const SEARCH_CANDIDATE_CAP = 500;

/**
 * Candidate student ids for a free-text term, matched through
 * `students_name_trgm`, `students_code_trgm` and `students_phone_reversed`.
 *
 * Raw SQL because all three indexes are on EXPRESSIONS — `search_normalize(first
 * || ' ' || last)`, `search_normalize(studentCode)` and
 * `reverse(phoneNormalized)` — which Prisma's `contains` cannot generate, so a
 * Prisma-only search would sequentially scan every student. The term is folded by
 * the same `search_normalize` the indexes were built with, rather than by a JS
 * lower-case that would disagree about accents.
 *
 * `organizationId` and the caller's branch list are applied here as well as in the
 * Prisma query that follows: both are predicates on the candidate set, so applying
 * them late would let another branch's rows consume the cap. They are built from
 * `ctx`, never from caller input.
 */
async function searchStudentIds(
  db: Db,
  organizationId: string,
  branchIds: string[] | null,
  term: string,
): Promise<string[]> {
  const digits = term.replace(/\D/g, '');
  // Two digits match half the institution; a phone search needs to be a real one.
  const phoneTerm = digits.length >= 3 ? digits : null;

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    select s."id"
    from "students" s
    where s."organizationId" = ${organizationId}
      and (${branchIds}::text[] is null or s."branchId" = any(${branchIds}::text[]))
      and (
        "search_normalize"(s."firstName" || ' ' || s."lastName")
          like '%' || "search_normalize"(${term}) || '%'
        or "search_normalize"(s."studentCode") like '%' || "search_normalize"(${term}) || '%'
        or (
          ${phoneTerm}::text is not null
          and s."phoneNormalized" is not null
          and reverse(s."phoneNormalized") like reverse(${phoneTerm}::text) || '%'
        )
      )
    order by
      similarity(
        "search_normalize"(s."firstName" || ' ' || s."lastName"),
        "search_normalize"(${term})
      ) desc,
      s."lastName" asc,
      s."firstName" asc
    limit ${SEARCH_CANDIDATE_CAP}
  `;
  return rows.map((row) => row.id);
}

export async function listStudents(
  ctx: AccessContext,
  input: ListStudentsInput = {},
  db: Db = prisma,
): Promise<StudentListResult> {
  requirePermission(ctx, 'students.view');

  // Filtering by debt is a financial read even though it returns no figures:
  // "who owes money" is exactly the information the financial permissions gate.
  if (input.hasDebt !== undefined) {
    requireAnyPermission(ctx, ['students.viewFinancials', 'debts.view']);
  }

  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(PAGE_SIZE_CEILING, Math.max(1, Math.trunc(input.pageSize ?? 25)));

  const where: Prisma.StudentWhereInput = composeReadFilter(ctx, {
    selfFilter: selfStudentFilter(ctx),
  }) as Prisma.StudentWhereInput;

  if (!input.includeArchived) where.deletedAt = null;
  if (input.branchId) {
    // Verified against the caller's scope so an explicit branch cannot widen it.
    assertBranchAccess(ctx, input.branchId, 'student');
    where.branchId = input.branchId;
  }
  if (input.status && input.status.length > 0) where.status = { in: [...input.status] };
  if (input.gender) where.gender = input.gender;

  const enrollmentPredicates: Prisma.EnrollmentWhereInput[] = [];
  if (input.groupId) enrollmentPredicates.push({ groupId: input.groupId, endDate: null });
  if (input.programId) {
    enrollmentPredicates.push({ endDate: null, group: { programId: input.programId } });
  }
  const andPredicates: Prisma.StudentWhereInput[] = enrollmentPredicates.map((predicate) => ({
    enrollments: { some: predicate },
  }));

  if (input.hasDebt !== undefined) {
    const owing: Prisma.StudentWhereInput = {
      invoices: {
        some: {
          balanceMinor: { gt: 0 },
          status: { notIn: ['DRAFT', 'CANCELLED', 'VOID', 'WRITTEN_OFF'] },
        },
      },
    };
    andPredicates.push(input.hasDebt ? owing : { NOT: owing });
  }

  if (input.enrolledFrom || input.enrolledTo) {
    const { timezone } = await getSettings(
      ['timezone'],
      { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
      db,
    );
    // `enrolledAt` is an instant, so a calendar range has to be resolved in an
    // explicit zone before it can be compared.
    const from = input.enrolledFrom ?? '1970-01-01';
    const to = input.enrolledTo ?? todayIn(timezone);
    const range = dayRangeToInstants(from, to, timezone);
    where.enrolledAt = { gte: range.from, lt: range.toExclusive };
  }

  let searchTruncated = false;
  const term = input.q?.trim();
  if (term) {
    if (isSelfScoped(ctx)) {
      // A SELF-scoped caller's visible set is their own children or their own
      // classes — a handful of rows, where a substring match costs nothing and,
      // unlike the capped index search, cannot drop a match.
      andPredicates.push({
        OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { studentCode: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
        ],
      });
    } else {
      const ids = await searchStudentIds(
        db,
        ctx.organizationId,
        ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds],
        term,
      );
      searchTruncated = ids.length === SEARCH_CANDIDATE_CAP;
      where.id = { in: ids };
    }
  }

  if (andPredicates.length > 0) {
    const existing = where.AND;
    where.AND = Array.isArray(existing)
      ? [...existing, ...andPredicates]
      : existing
        ? [existing, ...andPredicates]
        : andPredicates;
  }

  const sortBy: StudentSortField = input.sortBy ?? 'lastName';
  const sortDir = input.sortDir ?? 'asc';
  // `id` breaks ties so that page 2 cannot repeat a row from page 1.
  const orderBy: Prisma.StudentOrderByWithRelationInput[] =
    sortBy === 'lastName'
      ? [{ lastName: sortDir }, { firstName: sortDir }, { id: 'asc' }]
      : [{ [sortBy]: sortDir }, { id: 'asc' }];

  const [rows, total] = await Promise.all([
    db.student.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        studentCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        gender: true,
        status: true,
        branchId: true,
        branch: { select: { name: true } },
        photoUrl: true,
        enrolledAt: true,
        deletedAt: true,
        // One extra query for the whole page, not one per row.
        enrollments: {
          where: { endDate: null },
          take: 5,
          orderBy: { startDate: 'desc' },
          select: { group: { select: { id: true, name: true } } },
        },
      },
    }),
    db.student.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      studentCode: row.studentCode,
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: `${row.firstName} ${row.lastName}`,
      phone: row.phone,
      email: row.email,
      gender: row.gender,
      status: row.status,
      branchId: row.branchId,
      branchName: row.branch.name,
      photoUrl: row.photoUrl,
      enrolledAt: row.enrolledAt,
      isArchived: row.deletedAt !== null,
      groups: row.enrollments.map((enrollment) => ({
        id: enrollment.group.id,
        name: enrollment.group.name,
      })),
    })),
    total,
    page,
    pageSize,
    searchTruncated,
  };
}

/**
 * One student.
 *
 * The scope predicate and the id live in the same `where`: fetching the row and
 * then testing its branch would confirm that a student id exists in a branch the
 * caller cannot see, which is exactly how ids get enumerated across branches.
 */
export async function getStudent(
  ctx: AccessContext,
  studentId: string,
  db: Db = prisma,
  options: { readonly includeArchived?: boolean } = {},
): Promise<StudentDetail> {
  requirePermission(ctx, 'students.view');

  const where: Prisma.StudentWhereInput = {
    id: studentId,
    ...(composeReadFilter(ctx, { selfFilter: selfStudentFilter(ctx) }) as Prisma.StudentWhereInput),
  };
  if (!options.includeArchived) where.deletedAt = null;

  const row = await db.student.findFirst({ where, select: STUDENT_SELECT });
  if (!row) throw new NotFoundError('Student', studentId);

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: row.branchId },
    db,
  );
  return toStudentDetail(row, todayIn(timezone));
}
