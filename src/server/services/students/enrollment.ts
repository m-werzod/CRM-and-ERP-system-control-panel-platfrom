/**
 * Enrollment: putting a student into a group, moving them, and taking them out.
 *
 * THE HISTORY RULE, which this file exists to enforce:
 * an enrollment is never mutated to point at a different group. Moving a student
 * CLOSES the current row (endDate + endReason) and OPENS a new one, linked through
 * `transferredToId`. Attendance, grades and invoices stay attached to the
 * enrollment they were created under, so last term remains reportable exactly as it
 * happened — which is the difference between an audit trail and a guess.
 *
 * A partial unique index (`enrollments_one_open_per_student_group`) guarantees at
 * most one OPEN enrollment per (student, group) at the database level. That is what
 * makes a double-submitted "enrol" button impossible rather than merely unlikely,
 * and it is why these use-cases can be written without a read-then-check race.
 */

import type { EnrollmentEndReason } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';

export interface EnrollStudentInput {
  readonly studentId: string;
  readonly groupId: string;
  /** Defaults to today in the branch timezone. */
  readonly startDate?: DateOnly;
  /** Permit exceeding the group's capacity, when the caller may override it. */
  readonly allowOvercapacity?: boolean;
}

export interface EnrollmentSummary {
  readonly id: string;
  readonly studentId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly startDate: Date;
  readonly status: string;
}

/**
 * Enrol a student into a group.
 *
 * Capacity is checked inside the transaction, so two concurrent enrolments cannot
 * both see the last free seat. The check counts OPEN enrollments only — a group
 * that has had 200 students over three years still has its stated capacity today.
 */
export async function enrollStudent(
  ctx: AccessContext,
  input: EnrollStudentInput,
  db?: Db,
): Promise<EnrollmentSummary> {
  requirePermission(ctx, 'groups.manageEnrollment');

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          branchId: true,
          firstName: true,
          lastName: true,
          status: true,
          enrolledAt: true,
        },
      });
      if (!student) throw new NotFoundError('Student', input.studentId);

      if (student.status === 'WITHDRAWN' || student.status === 'GRADUATED') {
        throw new StateInvalidError('student', student.status.toLowerCase(), 'enrolled');
      }

      const group = await tx.group.findFirst({
        where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          name: true,
          branchId: true,
          capacity: true,
          status: true,
          startDate: true,
          endDate: true,
        },
      });
      if (!group) throw new NotFoundError('Group', input.groupId);

      assertBranchAccess(ctx, group.branchId, 'group');

      if (group.status === 'COMPLETED' || group.status === 'CANCELLED') {
        throw new StateInvalidError('group', group.status.toLowerCase(), 'enrolled into');
      }

      // A student belongs to one branch; enrolling them into a group in another
      // would make their attendance and invoices span branches and break every
      // branch-scoped report.
      if (group.branchId !== student.branchId) {
        throw new BusinessRuleError(
          'enrollment.branch_mismatch',
          'This group belongs to a different branch from the student. Transfer the student to that branch first.',
          { details: { studentBranchId: student.branchId, groupBranchId: group.branchId } },
        );
      }

      const settings = await getSettings(['timezone', 'allowGroupOvercapacity'], {
        organizationId: ctx.organizationId,
        branchId: group.branchId,
      }, tx);

      const startDate = input.startDate ?? todayIn(settings.timezone);

      if (group.endDate && dateOnlyToPrismaDate(startDate) > group.endDate) {
        throw new BusinessRuleError(
          'enrollment.after_group_end',
          'The start date is after this group has finished.',
        );
      }

      const openCount = await tx.enrollment.count({
        where: { groupId: group.id, endDate: null },
      });
      const overcapacityAllowed = input.allowOvercapacity ?? settings.allowGroupOvercapacity;
      if (openCount >= group.capacity && !overcapacityAllowed) {
        throw new BusinessRuleError(
          'enrollment.group_full',
          `${group.name} is full (${openCount} of ${group.capacity} places taken).`,
          { details: { capacity: group.capacity, enrolled: openCount } },
        );
      }

      let enrollment: { id: string; startDate: Date; status: string };
      try {
        enrollment = await tx.enrollment.create({
          data: {
            studentId: student.id,
            groupId: group.id,
            status: 'ACTIVE',
            startDate: dateOnlyToPrismaDate(startDate),
            createdById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true, startDate: true, status: true },
        });
      } catch (error) {
        // The partial unique index rejected a second open enrollment. Translating
        // it here gives the operator a sentence they can act on instead of a
        // constraint name.
        if ((error as { code?: string }).code === 'P2002' || (error as { code?: string }).code === '23505') {
          throw new ConflictError(
            `${student.firstName} ${student.lastName} is already enrolled in ${group.name}.`,
            { details: { studentId: student.id, groupId: group.id } },
          );
        }
        throw error;
      }

      // First enrolment promotes a prospect to an active student.
      if (student.status === 'PROSPECT' || student.enrolledAt === null) {
        await tx.student.update({
          where: { id: student.id },
          data: {
            status: 'ACTIVE',
            enrolledAt: student.enrolledAt ?? dateOnlyToPrismaDate(startDate),
          },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_ENROLLED,
          entityType: 'Enrollment',
          entityId: enrollment.id,
          branchId: group.branchId,
          summary: `${student.firstName} ${student.lastName} enrolled in ${group.name}`,
          metadata: { studentId: student.id, groupId: group.id, startDate },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'enrollment.created',
            title: `Added to ${group.name}`,
          },
        },
        tx,
      );

      return {
        id: enrollment.id,
        studentId: student.id,
        groupId: group.id,
        groupName: group.name,
        startDate: enrollment.startDate,
        status: enrollment.status,
      };
    },
    { existing: db },
  );
}

export interface TransferStudentInput {
  readonly studentId: string;
  readonly fromGroupId: string;
  readonly toGroupId: string;
  /** The day the move takes effect. Defaults to today. */
  readonly effectiveDate?: DateOnly;
  readonly reason?: string | null;
  readonly allowOvercapacity?: boolean;
}

/**
 * Move a student between groups, preserving both enrollments.
 *
 * The old row is closed with `TRANSFERRED_OUT` and points at its successor, so the
 * chain is walkable in both directions. Attendance already recorded against the old
 * enrollment stays there — this is the behaviour the specification calls out
 * explicitly, and the reason `AttendanceRecord.enrollmentId` exists at all.
 */
export async function transferStudent(
  ctx: AccessContext,
  input: TransferStudentInput,
  db?: Db,
): Promise<{ closed: EnrollmentSummary; opened: EnrollmentSummary }> {
  requirePermission(ctx, 'students.transfer');

  if (input.fromGroupId === input.toGroupId) {
    throw new BusinessRuleError(
      'transfer.same_group',
      'The source and destination groups are the same.',
    );
  }

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true },
      });
      if (!student) throw new NotFoundError('Student', input.studentId);

      const current = await tx.enrollment.findFirst({
        where: { studentId: student.id, groupId: input.fromGroupId, endDate: null },
        select: { id: true, startDate: true, group: { select: { id: true, name: true, branchId: true } } },
      });
      if (!current) {
        throw new NotFoundError('Open enrollment in the source group');
      }
      assertBranchAccess(ctx, current.group.branchId, 'group');

      const settings = await getSettings(['timezone'], {
        organizationId: ctx.organizationId,
        branchId: current.group.branchId,
      }, tx);
      const effectiveDate = input.effectiveDate ?? todayIn(settings.timezone);
      const effective = dateOnlyToPrismaDate(effectiveDate);

      if (effective < current.startDate) {
        throw new BusinessRuleError(
          'transfer.before_start',
          'The transfer date is before the student joined the current group.',
        );
      }

      // Open the new enrollment first so a capacity or branch failure aborts before
      // the student is left belonging to nothing.
      const opened = await enrollStudent(
        ctx,
        {
          studentId: student.id,
          groupId: input.toGroupId,
          startDate: effectiveDate,
          allowOvercapacity: input.allowOvercapacity,
        },
        tx,
      );

      await tx.enrollment.update({
        where: { id: current.id },
        data: {
          status: 'TRANSFERRED',
          endDate: effective,
          endReason: 'TRANSFERRED_OUT',
          endNote: input.reason ?? null,
          transferredToId: opened.id,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.STUDENT_TRANSFERRED,
          entityType: 'Enrollment',
          entityId: current.id,
          branchId: current.group.branchId,
          summary: `${student.firstName} ${student.lastName} transferred from ${current.group.name} to ${opened.groupName}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: {
            studentId: student.id,
            fromGroupId: current.group.id,
            toGroupId: opened.groupId,
            effectiveDate,
            closedEnrollmentId: current.id,
            openedEnrollmentId: opened.id,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'enrollment.transferred',
            title: `Moved from ${current.group.name} to ${opened.groupName}`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return {
        closed: {
          id: current.id,
          studentId: student.id,
          groupId: current.group.id,
          groupName: current.group.name,
          startDate: current.startDate,
          status: 'TRANSFERRED',
        },
        opened,
      };
    },
    { existing: db },
  );
}

/**
 * End an enrollment without opening another: the student has finished the course,
 * withdrawn, or been removed.
 */
export async function endEnrollment(
  ctx: AccessContext,
  input: {
    readonly enrollmentId: string;
    readonly endDate?: DateOnly;
    readonly reason: EnrollmentEndReason;
    readonly note?: string | null;
  },
  db?: Db,
): Promise<{ id: string; endDate: Date; status: string }> {
  requirePermission(ctx, 'groups.manageEnrollment');

  return withTransaction(
    async (tx) => {
      const enrollment = await tx.enrollment.findFirst({
        where: {
          id: input.enrollmentId,
          // Scope through the group, because Enrollment carries no organizationId
          // of its own -- it is reached only via a student and a group.
          group: scopeFilter(ctx),
        },
        select: {
          id: true,
          startDate: true,
          endDate: true,
          student: { select: { id: true, firstName: true, lastName: true } },
          group: { select: { id: true, name: true, branchId: true } },
        },
      });
      if (!enrollment) throw new NotFoundError('Enrollment', input.enrollmentId);
      if (enrollment.endDate) {
        throw new StateInvalidError('enrollment', 'already closed', 'ended');
      }

      const settings = await getSettings(['timezone'], {
        organizationId: ctx.organizationId,
        branchId: enrollment.group.branchId,
      }, tx);
      const endDate = dateOnlyToPrismaDate(input.endDate ?? todayIn(settings.timezone));

      if (endDate < enrollment.startDate) {
        throw new BusinessRuleError(
          'enrollment.end_before_start',
          'The end date cannot be before the start date.',
        );
      }

      const status = input.reason === 'COMPLETED' ? 'COMPLETED' : 'WITHDRAWN';

      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { status, endDate, endReason: input.reason, endNote: input.note ?? null },
      });

      await recordAudit(
        ctx,
        {
          action: 'enrollment.ended',
          entityType: 'Enrollment',
          entityId: enrollment.id,
          branchId: enrollment.group.branchId,
          summary: `${enrollment.student.firstName} ${enrollment.student.lastName} left ${enrollment.group.name} (${input.reason})`,
          reason: input.note ?? null,
          metadata: { reason: input.reason, endDate: input.endDate ?? null },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: enrollment.student.id,
            type: 'enrollment.ended',
            title: `Left ${enrollment.group.name}`,
            description: input.note ?? null,
          },
        },
        tx,
      );

      return { id: enrollment.id, endDate, status };
    },
    { existing: db },
  );
}

/**
 * A student's whole enrollment history, newest first.
 *
 * Returns closed rows as well as open ones — that is the point of the model, and a
 * student profile that showed only the current group would hide the history the
 * schema goes to some trouble to keep.
 */
export async function listStudentEnrollments(
  ctx: AccessContext,
  studentId: string,
  db?: Db,
): Promise<
  Array<{
    id: string;
    groupId: string;
    groupName: string;
    groupCode: string;
    programName: string | null;
    teacherName: string | null;
    status: string;
    startDate: Date;
    endDate: Date | null;
    endReason: string | null;
    isOpen: boolean;
    transferredToId: string | null;
  }>
> {
  requirePermission(ctx, 'students.view');
  const { prisma } = await import('@/server/db/client');
  const client = db ?? prisma;

  // Scoped through the group so a branch-scoped caller cannot read an enrollment
  // in a branch they cannot see, even for a student they can.
  const rows = await client.enrollment.findMany({
    where: { studentId, group: scopeFilter(ctx) },
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      endReason: true,
      transferredToId: true,
      group: {
        select: {
          id: true,
          name: true,
          code: true,
          program: { select: { name: true } },
          primaryTeacher: {
            select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
          },
        },
      },
    },
  });

  return rows.map((row) => {
    const teacherUser = row.group.primaryTeacher?.employee.user;
    return {
      id: row.id,
      groupId: row.group.id,
      groupName: row.group.name,
      groupCode: row.group.code,
      programName: row.group.program?.name ?? null,
      teacherName: teacherUser ? `${teacherUser.firstName} ${teacherUser.lastName}` : null,
      status: row.status,
      startDate: row.startDate,
      endDate: row.endDate,
      endReason: row.endReason,
      isOpen: row.endDate === null,
      transferredToId: row.transferredToId,
    };
  });
}

/**
 * The roster a teacher marks attendance against: students whose enrollment was open
 * on the given date.
 *
 * Dated rather than "currently open", so opening yesterday's register shows the
 * students who were actually in the room, not today's membership. Getting this
 * wrong is how a transferred student appears absent from a class they had already
 * left.
 */
export async function getGroupRoster(
  ctx: AccessContext,
  input: { groupId: string; onDate: DateOnly },
  db?: Db,
): Promise<
  Array<{
    enrollmentId: string;
    studentId: string;
    studentCode: string;
    firstName: string;
    lastName: string;
    photoUrl: string | null;
  }>
> {
  requirePermission(ctx, 'students.view');
  const { prisma } = await import('@/server/db/client');
  const client = db ?? prisma;

  const on = dateOnlyToPrismaDate(input.onDate);

  const rows = await client.enrollment.findMany({
    where: {
      groupId: input.groupId,
      group: scopeFilter(ctx),
      startDate: { lte: on },
      // Open, or closed on/after the date in question.
      OR: [{ endDate: null }, { endDate: { gte: on } }],
      student: { deletedAt: null },
    },
    orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
    select: {
      id: true,
      student: {
        select: {
          id: true,
          studentCode: true,
          firstName: true,
          lastName: true,
          photoUrl: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    enrollmentId: row.id,
    studentId: row.student.id,
    studentCode: row.student.studentCode,
    firstName: row.student.firstName,
    lastName: row.student.lastName,
    photoUrl: row.student.photoUrl,
  }));
}

/** Resolve the enrollment a lesson's attendance should be attributed to. */
export async function findEnrollmentForLesson(
  tx: Tx,
  input: { studentId: string; groupId: string; lessonDate: Date },
): Promise<string | null> {
  const enrollment = await tx.enrollment.findFirst({
    where: {
      studentId: input.studentId,
      groupId: input.groupId,
      startDate: { lte: input.lessonDate },
      OR: [{ endDate: null }, { endDate: { gte: input.lessonDate } }],
    },
    orderBy: { startDate: 'desc' },
    select: { id: true },
  });
  return enrollment?.id ?? null;
}
