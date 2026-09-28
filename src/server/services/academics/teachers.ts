/**
 * Teachers: dated assignment to groups, subject competence, and workload.
 *
 * THE HISTORY RULE, which the assignment use-cases exist to enforce:
 * a teacher change never UPDATEs `GroupTeacher.teacherId`. Assigning CLOSES the open
 * row for that (group, role) with an `endDate` and an `endReason`, then OPENS a new
 * one. Last term's register, grades and payroll must stay attributable to whoever
 * actually taught the class; mutating the assignment in place would silently
 * reassign that history to the new teacher.
 *
 * `GroupTeacher` is therefore the AUTHORITATIVE, dated history.
 * `Group.primaryTeacherId` / `Group.assistantTeacherId` are a DENORMALISED CACHE of
 * its currently-open rows, kept only so that listing a hundred groups and checking a
 * timetable conflict do not each need a join to a history table. Nothing may write
 * those columns except the two use-cases below, and any report about who taught what
 * reads `GroupTeacher`.
 *
 * A partial unique index (`group_teachers_one_open_per_group_role`) guarantees at
 * most one open row per (group, role) at the database level, so a double-submitted
 * assignment is impossible rather than merely unlikely -- and its violation is
 * translated here into a sentence rather than a constraint name.
 */

import type {
  EmploymentStatus,
  GroupTeacherRole,
  Prisma,
  SubjectProficiency,
  Weekday,
} from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  record as recordAudit,
  recordActivity,
} from '@/server/audit';
import {
  assertBranchAccess,
  can,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dateOnlyToPrismaDate, todayIn, addDaysToDateOnly, type DateOnly } from '@/lib/dates';
import {
  isUniqueViolation,
  teacherDisplayName,
  toPage,
  type PageInput,
  type Paginated,
  type SortDirection,
} from '@/server/services/academics/shared';

/** Group states whose teaching load still counts and whose teachers still matter. */
const LIVE_GROUP_STATUSES = ['PLANNED', 'ENROLLING', 'ACTIVE', 'PAUSED'] as const;

/** Employment states in which a person can no longer be given a class. */
const ENDED_EMPLOYMENT: readonly EmploymentStatus[] = ['TERMINATED', 'RESIGNED'];

const TEACHER_NAME_SELECT = {
  employee: { select: { user: { select: { firstName: true, lastName: true } } } },
} as const;

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export interface AssignTeacherToGroupInput {
  readonly groupId: string;
  readonly teacherId: string;
  readonly role?: GroupTeacherRole;
  /** The day the new assignment takes effect. Defaults to today in the branch zone. */
  readonly startDate?: DateOnly;
  /** Why the outgoing teacher's row was closed. Shown on the group's history. */
  readonly endReason?: string | null;
}

export interface TeacherAssignmentResult {
  readonly assignmentId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly role: GroupTeacherRole;
  readonly startDate: Date;
  /** The row this assignment closed, when it replaced someone. */
  readonly closed: {
    readonly assignmentId: string;
    readonly teacherId: string;
    readonly teacherName: string;
    readonly endDate: Date;
  } | null;
}

/**
 * Give a group a teacher in a role, closing whoever held that role before.
 *
 * Both writes happen in one transaction: a crash between them would leave a group
 * with two open primary teachers, which the partial unique index would then refuse
 * to let anyone fix.
 */
export async function assignTeacherToGroup(
  ctx: AccessContext,
  input: AssignTeacherToGroupInput,
  db?: Db,
): Promise<TeacherAssignmentResult> {
  requirePermission(ctx, 'groups.assignTeacher');

  const role: GroupTeacherRole = input.role ?? 'PRIMARY';

  return withTransaction(
    async (tx) => {
      const group = await tx.group.findFirst({
        where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          name: true,
          code: true,
          branchId: true,
          status: true,
          primaryTeacherId: true,
          assistantTeacherId: true,
        },
      });
      // NotFound rather than OutOfScope: group ids are guessable, so distinguishing
      // "exists in another branch" from "does not exist" leaks across branches.
      if (!group) throw new NotFoundError('Group', input.groupId);
      assertBranchAccess(ctx, group.branchId, 'group');

      if (group.status === 'COMPLETED' || group.status === 'CANCELLED') {
        throw new StateInvalidError('group', group.status.toLowerCase(), 'given a teacher');
      }

      const teacher = await tx.teacher.findFirst({
        // Scoped through the employee, because Teacher carries no organizationId of
        // its own -- it is reached only via an Employee.
        where: {
          id: input.teacherId,
          deletedAt: null,
          employee: { ...scopeFilter(ctx), deletedAt: null },
        },
        select: {
          id: true,
          employee: {
            select: { status: true, user: { select: { firstName: true, lastName: true } } },
          },
        },
      });
      if (!teacher) throw new NotFoundError('Teacher', input.teacherId);

      const teacherName = teacherDisplayName(teacher);
      if (ENDED_EMPLOYMENT.includes(teacher.employee.status)) {
        throw new BusinessRuleError(
          'assignment.employment_ended',
          `${teacherName} no longer works here and cannot be given a class.`,
          { details: { employmentStatus: teacher.employee.status } },
        );
      }

      // A CHECK constraint on `groups` forbids the assistant also being the primary,
      // and it fires on the cache columns rather than on GroupTeacher. Catching it
      // here produces an instruction instead of a constraint violation.
      if (role === 'ASSISTANT' && group.primaryTeacherId === teacher.id) {
        throw new BusinessRuleError(
          'assignment.already_primary',
          `${teacherName} is already the primary teacher of ${group.code} and cannot also be its assistant.`,
        );
      }
      if (role === 'PRIMARY' && group.assistantTeacherId === teacher.id) {
        throw new BusinessRuleError(
          'assignment.already_assistant',
          `${teacherName} is currently the assistant on ${group.code}. Unassign them from that role first.`,
        );
      }

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: group.branchId },
        tx,
      );
      const startDate = input.startDate ?? todayIn(timezone);
      const startsOn = dateOnlyToPrismaDate(startDate);

      const open = await tx.groupTeacher.findFirst({
        where: { groupId: group.id, role, endDate: null },
        select: { id: true, teacherId: true, startDate: true, teacher: { select: TEACHER_NAME_SELECT } },
      });

      let closed: TeacherAssignmentResult['closed'] = null;

      if (open) {
        if (open.teacherId === teacher.id) {
          throw new ConflictError(
            `${teacherName} already holds the ${role.toLowerCase()} role on ${group.code}.`,
            { details: { assignmentId: open.id, since: open.startDate.toISOString() } },
          );
        }
        if (startsOn < open.startDate) {
          // `group_teachers_dates_ordered` would reject the closing update anyway;
          // saying which date is wrong is more useful than a CHECK violation.
          throw new BusinessRuleError(
            'assignment.before_current_start',
            'The new assignment starts before the current teacher did. Choose a later date.',
            { details: { currentStartDate: open.startDate.toISOString() } },
          );
        }

        await tx.groupTeacher.update({
          where: { id: open.id },
          // Closed on the day the successor starts, matching the enrollment transfer
          // convention: the handover day belongs to the incoming teacher.
          data: {
            endDate: startsOn,
            endReason: input.endReason ?? `Replaced by ${teacherName}`,
          },
        });

        closed = {
          assignmentId: open.id,
          teacherId: open.teacherId,
          teacherName: teacherDisplayName(open.teacher),
          endDate: startsOn,
        };
      }

      let assignment: { id: string; startDate: Date };
      try {
        assignment = await tx.groupTeacher.create({
          data: {
            groupId: group.id,
            teacherId: teacher.id,
            role,
            startDate: startsOn,
            assignedById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true, startDate: true },
        });
      } catch (error) {
        if (isUniqueViolation(error, 'one_open')) {
          throw new ConflictError(
            `${group.code} already has an open ${role.toLowerCase()} teacher. Someone else assigned one at the same moment; reload and try again.`,
          );
        }
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            `${teacherName} already has a ${role.toLowerCase()} assignment on ${group.code} starting ${startDate}. Use a different start date.`,
          );
        }
        throw error;
      }

      // Refresh the cache. SUBSTITUTE has no column: a stand-in does not replace the
      // group's teacher of record, which is exactly why the cache is not the truth.
      if (role === 'PRIMARY' || role === 'ASSISTANT') {
        await tx.group.update({
          where: { id: group.id },
          data:
            role === 'PRIMARY'
              ? { primaryTeacherId: teacher.id }
              : { assistantTeacherId: teacher.id },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.TEACHER_ASSIGNED,
          entityType: 'GroupTeacher',
          entityId: assignment.id,
          branchId: group.branchId,
          summary: `${teacherName} assigned to ${group.code} as ${role.toLowerCase()}${
            closed ? `, replacing ${closed.teacherName}` : ''
          }`,
          reason: input.endReason ?? null,
          severity: 'NOTICE',
          metadata: {
            groupId: group.id,
            teacherId: teacher.id,
            role,
            startDate,
            closedAssignmentId: closed?.assignmentId ?? null,
          },
          timeline: {
            subjectType: 'GROUP',
            subjectId: group.id,
            type: 'group.teacher_assigned',
            title: `${teacherName} assigned as ${role.toLowerCase()}`,
            description: closed ? `Replaced ${closed.teacherName}` : null,
          },
        },
        tx,
      );

      // A second timeline entry on the teacher: their profile page is the other place
      // a human looks for "when did I take this class over".
      await recordActivity(
        ctx,
        {
          subjectType: 'TEACHER',
          subjectId: teacher.id,
          type: 'teacher.group_assigned',
          title: `Assigned to ${group.name} as ${role.toLowerCase()}`,
          metadata: { groupId: group.id, role, startDate },
        },
        tx,
      );

      return {
        assignmentId: assignment.id,
        groupId: group.id,
        groupName: group.name,
        teacherId: teacher.id,
        teacherName,
        role,
        startDate: assignment.startDate,
        closed,
      };
    },
    { existing: db },
  );
}

export interface UnassignTeacherFromGroupInput {
  readonly groupId: string;
  readonly role?: GroupTeacherRole;
  /**
   * Expected holder of the role. Supplied by the UI so a stale screen cannot end
   * someone else's assignment.
   */
  readonly teacherId?: string;
  readonly endDate?: DateOnly;
  readonly reason: string;
}

/** Close a group's open assignment for a role without opening a replacement. */
export async function unassignTeacherFromGroup(
  ctx: AccessContext,
  input: UnassignTeacherFromGroupInput,
  db?: Db,
): Promise<{
  readonly assignmentId: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly role: GroupTeacherRole;
  readonly endDate: Date;
}> {
  requirePermission(ctx, 'groups.assignTeacher');

  const role: GroupTeacherRole = input.role ?? 'PRIMARY';

  return withTransaction(
    async (tx) => {
      const group = await tx.group.findFirst({
        where: { id: input.groupId, ...scopeFilter(ctx), deletedAt: null },
        select: {
          id: true,
          name: true,
          code: true,
          branchId: true,
          primaryTeacherId: true,
          assistantTeacherId: true,
        },
      });
      if (!group) throw new NotFoundError('Group', input.groupId);
      assertBranchAccess(ctx, group.branchId, 'group');

      const open = await tx.groupTeacher.findFirst({
        where: {
          groupId: group.id,
          role,
          endDate: null,
          ...(input.teacherId ? { teacherId: input.teacherId } : {}),
        },
        select: {
          id: true,
          teacherId: true,
          startDate: true,
          teacher: { select: TEACHER_NAME_SELECT },
        },
      });
      if (!open) {
        throw new NotFoundError(`Open ${role.toLowerCase()} assignment on ${group.code}`);
      }

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: group.branchId },
        tx,
      );
      const endsOn = dateOnlyToPrismaDate(input.endDate ?? todayIn(timezone));
      if (endsOn < open.startDate) {
        throw new BusinessRuleError(
          'assignment.end_before_start',
          'The end date cannot be before the assignment started.',
          { details: { startDate: open.startDate.toISOString() } },
        );
      }

      await tx.groupTeacher.update({
        where: { id: open.id },
        data: { endDate: endsOn, endReason: input.reason },
      });

      // Clear the cache only when it still points at the teacher being removed: a
      // SUBSTITUTE row never touched it, and a concurrent reassignment may already
      // have moved it on.
      const cacheClear: Prisma.GroupUpdateInput = {};
      if (role === 'PRIMARY' && group.primaryTeacherId === open.teacherId) {
        cacheClear.primaryTeacher = { disconnect: true };
      }
      if (role === 'ASSISTANT' && group.assistantTeacherId === open.teacherId) {
        cacheClear.assistantTeacher = { disconnect: true };
      }
      if (Object.keys(cacheClear).length > 0) {
        await tx.group.update({ where: { id: group.id }, data: cacheClear });
      }

      const teacherName = teacherDisplayName(open.teacher);

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.TEACHER_UNASSIGNED,
          entityType: 'GroupTeacher',
          entityId: open.id,
          branchId: group.branchId,
          summary: `${teacherName} removed as ${role.toLowerCase()} of ${group.code}`,
          reason: input.reason,
          severity: 'NOTICE',
          metadata: { groupId: group.id, teacherId: open.teacherId, role },
          timeline: {
            subjectType: 'GROUP',
            subjectId: group.id,
            type: 'group.teacher_unassigned',
            title: `${teacherName} removed as ${role.toLowerCase()}`,
            description: input.reason,
          },
        },
        tx,
      );

      await recordActivity(
        ctx,
        {
          subjectType: 'TEACHER',
          subjectId: open.teacherId,
          type: 'teacher.group_unassigned',
          title: `Removed from ${group.name} (${role.toLowerCase()})`,
          description: input.reason,
          metadata: { groupId: group.id, role },
        },
        tx,
      );

      return {
        assignmentId: open.id,
        teacherId: open.teacherId,
        teacherName,
        role,
        endDate: endsOn,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Reading teachers
// ---------------------------------------------------------------------------

export interface TeacherSubjectEntry {
  readonly subjectId: string;
  readonly name: string;
  readonly code: string;
  readonly proficiency: SubjectProficiency;
}

export interface TeacherListRow {
  readonly id: string;
  readonly fullName: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly position: string;
  readonly branchId: string;
  readonly employmentStatus: EmploymentStatus;
  readonly specialization: string | null;
  readonly maxWeeklyHours: number;
  readonly subjects: readonly TeacherSubjectEntry[];
  /** Groups the teacher currently holds any open assignment on. */
  readonly openGroupCount: number;
}

export interface ListTeachersInput extends PageInput {
  readonly q?: string;
  readonly branchId?: string;
  readonly subjectId?: string;
  readonly employmentStatus?: EmploymentStatus;
  /** Include teachers whose profile has been archived. Off by default. */
  readonly includeArchived?: boolean;
  readonly sortBy?: 'name' | 'employeeCode' | 'createdAt';
  readonly sortDir?: SortDirection;
}

export async function listTeachers(
  ctx: AccessContext,
  input: ListTeachersInput = {},
  db?: Db,
): Promise<Paginated<TeacherListRow>> {
  requirePermission(ctx, 'teachers.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  // Verified BEFORE it is merged into the predicate: spreading a requested branch
  // over `scopeFilter`'s own `branchId` would otherwise widen the caller's scope.
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'teacher');

  const employeeWhere: Prisma.EmployeeWhereInput = {
    ...scopeFilter(ctx),
    deletedAt: null,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.employmentStatus ? { status: input.employmentStatus } : {}),
    ...(input.q
      ? {
          OR: [
            { employeeCode: { contains: input.q, mode: 'insensitive' } },
            { user: { firstName: { contains: input.q, mode: 'insensitive' } } },
            { user: { lastName: { contains: input.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const where: Prisma.TeacherWhereInput = {
    ...(input.includeArchived ? {} : { deletedAt: null }),
    employee: employeeWhere,
    ...(input.subjectId ? { subjects: { some: { subjectId: input.subjectId } } } : {}),
  };

  const sortBy = input.sortBy ?? 'name';
  const sortDir = input.sortDir ?? 'asc';
  const orderBy: Prisma.TeacherOrderByWithRelationInput[] =
    sortBy === 'name'
      ? [
          { employee: { user: { lastName: sortDir } } },
          { employee: { user: { firstName: sortDir } } },
        ]
      : sortBy === 'employeeCode'
        ? [{ employee: { employeeCode: sortDir } }]
        : [{ createdAt: sortDir }];

  const [rows, total] = await Promise.all([
    client.teacher.findMany({
      where,
      orderBy,
      skip,
      take,
      select: {
        id: true,
        specialization: true,
        maxWeeklyHours: true,
        employee: {
          select: {
            id: true,
            employeeCode: true,
            position: true,
            branchId: true,
            status: true,
            user: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
    client.teacher.count({ where }),
  ]);

  const ids = rows.map((row) => row.id);

  // Two batched queries for the page, folded into Maps. One query per teacher would
  // be 2N round trips for a list that already costs two.
  const [subjectRows, groupCounts] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : client.teacherSubject.findMany({
          where: { teacherId: { in: ids } },
          select: {
            teacherId: true,
            proficiency: true,
            subject: { select: { id: true, name: true, code: true } },
          },
          orderBy: { subject: { name: 'asc' } },
        }),
    ids.length === 0
      ? Promise.resolve([])
      : client.groupTeacher.groupBy({
          by: ['teacherId'],
          where: {
            teacherId: { in: ids },
            endDate: null,
            group: { deletedAt: null, status: { in: [...LIVE_GROUP_STATUSES] } },
          },
          _count: { _all: true },
        }),
  ]);

  const subjectsByTeacher = new Map<string, TeacherSubjectEntry[]>();
  for (const row of subjectRows) {
    const list = subjectsByTeacher.get(row.teacherId) ?? [];
    list.push({
      subjectId: row.subject.id,
      name: row.subject.name,
      code: row.subject.code,
      proficiency: row.proficiency,
    });
    subjectsByTeacher.set(row.teacherId, list);
  }
  const groupCountByTeacher = new Map(groupCounts.map((row) => [row.teacherId, row._count._all]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      fullName: teacherDisplayName(row),
      employeeId: row.employee.id,
      employeeCode: row.employee.employeeCode,
      position: row.employee.position,
      branchId: row.employee.branchId,
      employmentStatus: row.employee.status,
      specialization: row.specialization,
      maxWeeklyHours: row.maxWeeklyHours,
      subjects: subjectsByTeacher.get(row.id) ?? [],
      openGroupCount: groupCountByTeacher.get(row.id) ?? 0,
    })),
    page,
    pageSize,
    total,
  };
}

export interface TeacherGroupEntry {
  readonly groupId: string;
  readonly name: string;
  readonly code: string;
  readonly status: string;
  readonly role: GroupTeacherRole;
  readonly since: Date;
  readonly capacity: number;
  readonly enrolled: number;
}

export interface TeacherProfile {
  readonly id: string;
  readonly fullName: string;
  readonly employeeId: string;
  readonly employeeCode: string;
  readonly position: string;
  readonly branchId: string;
  readonly employmentStatus: EmploymentStatus;
  readonly specialization: string | null;
  readonly qualification: string | null;
  readonly bio: string | null;
  readonly maxWeeklyHours: number;
  readonly archivedAt: Date | null;
  readonly subjects: readonly TeacherSubjectEntry[];
  readonly currentGroups: readonly TeacherGroupEntry[];
  /**
   * `null` means the caller may not see workload figures (`teachers.viewWorkload`),
   * NOT that the teacher has none. `canViewWorkload` says which it is.
   */
  readonly workload: TeacherWorkload | null;
  readonly canViewWorkload: boolean;
}

export async function getTeacherProfile(
  ctx: AccessContext,
  teacherId: string,
  db?: Db,
): Promise<TeacherProfile> {
  requirePermission(ctx, 'teachers.view');
  const client = db ?? prisma;

  const teacher = await client.teacher.findFirst({
    where: { id: teacherId, employee: { ...scopeFilter(ctx), deletedAt: null } },
    select: {
      id: true,
      specialization: true,
      qualification: true,
      bio: true,
      maxWeeklyHours: true,
      deletedAt: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          position: true,
          branchId: true,
          status: true,
          user: { select: { firstName: true, lastName: true } },
        },
      },
      subjects: {
        select: {
          proficiency: true,
          subject: { select: { id: true, name: true, code: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      },
    },
  });
  if (!teacher) throw new NotFoundError('Teacher', teacherId);

  const assignments = await client.groupTeacher.findMany({
    where: {
      teacherId: teacher.id,
      endDate: null,
      group: { deletedAt: null, status: { in: [...LIVE_GROUP_STATUSES] } },
    },
    orderBy: { startDate: 'desc' },
    select: {
      role: true,
      startDate: true,
      group: { select: { id: true, name: true, code: true, status: true, capacity: true } },
    },
  });

  // One grouped count for every group on the profile rather than one per row.
  const groupIds = assignments.map((row) => row.group.id);
  const enrolledCounts =
    groupIds.length === 0
      ? []
      : await client.enrollment.groupBy({
          by: ['groupId'],
          where: { groupId: { in: groupIds }, endDate: null },
          _count: { _all: true },
        });
  const enrolledByGroup = new Map(enrolledCounts.map((row) => [row.groupId, row._count._all]));

  const canViewWorkload = can(ctx, 'teachers.viewWorkload');

  return {
    id: teacher.id,
    fullName: teacherDisplayName(teacher),
    employeeId: teacher.employee.id,
    employeeCode: teacher.employee.employeeCode,
    position: teacher.employee.position,
    branchId: teacher.employee.branchId,
    employmentStatus: teacher.employee.status,
    specialization: teacher.specialization,
    qualification: teacher.qualification,
    bio: teacher.bio,
    maxWeeklyHours: teacher.maxWeeklyHours,
    archivedAt: teacher.deletedAt,
    subjects: teacher.subjects.map((row) => ({
      subjectId: row.subject.id,
      name: row.subject.name,
      code: row.subject.code,
      proficiency: row.proficiency,
    })),
    currentGroups: assignments.map((row) => ({
      groupId: row.group.id,
      name: row.group.name,
      code: row.group.code,
      status: row.group.status,
      role: row.role,
      since: row.startDate,
      capacity: row.group.capacity,
      enrolled: enrolledByGroup.get(row.group.id) ?? 0,
    })),
    workload: canViewWorkload
      ? await getTeacherWorkload(ctx, { teacherId: teacher.id }, client)
      : null,
    canViewWorkload,
  };
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

export interface WorkloadSlot {
  readonly slotId: string;
  readonly groupId: string;
  readonly groupCode: string;
  readonly dayOfWeek: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly minutes: number;
}

export interface TeacherWorkload {
  readonly teacherId: string;
  readonly fullName: string;
  readonly maxWeeklyHours: number;
  readonly maxWeeklyMinutes: number;
  /** Sum of the teacher's currently-effective weekly timetable slots. */
  readonly scheduledMinutesPerWeek: number;
  /** Share of the ceiling used, in integer parts-per-million. */
  readonly utilizationPpm: number | null;
  readonly isOverAllocated: boolean;
  readonly overAllocatedByMinutes: number;
  readonly groupCount: number;
  readonly slots: readonly WorkloadSlot[];
  readonly byDay: ReadonlyArray<{ dayOfWeek: Weekday; minutes: number; slotCount: number }>;
  /** Actual sessions in the window, which a pattern alone does not show. */
  readonly lessons: {
    readonly from: DateOnly;
    readonly to: DateOnly;
    readonly total: number;
    readonly completed: number;
    readonly cancelled: number;
  };
}

export interface TeacherWorkloadInput {
  readonly teacherId: string;
  /** Lesson-count window. Defaults to the seven days from today in the branch zone. */
  readonly from?: DateOnly;
  readonly to?: DateOnly;
}

/**
 * A teacher's weekly load, measured against `Teacher.maxWeeklyHours`.
 *
 * The weekly figure comes from ScheduleSlot rather than from Lesson rows, because the
 * ceiling is a contractual commitment about the RECURRING timetable: counting a week
 * that happened to contain a public holiday would report a teacher as
 * under-allocated. Lesson counts are reported alongside it, not folded into it.
 *
 * Only slots effective today count. A slot that ended last term is history, and a
 * slot starting next month is not yet a commitment.
 */
export async function getTeacherWorkload(
  ctx: AccessContext,
  input: TeacherWorkloadInput,
  db?: Db,
): Promise<TeacherWorkload> {
  requirePermission(ctx, 'teachers.viewWorkload');
  const client = db ?? prisma;

  const teacher = await client.teacher.findFirst({
    where: { id: input.teacherId, employee: { ...scopeFilter(ctx), deletedAt: null } },
    select: {
      id: true,
      maxWeeklyHours: true,
      employee: {
        select: { branchId: true, user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  if (!teacher) throw new NotFoundError('Teacher', input.teacherId);

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: teacher.employee.branchId },
    client,
  );
  const today = todayIn(timezone);
  const from = input.from ?? today;
  const to = input.to ?? addDaysToDateOnly(from, 6);
  if (to < from) {
    throw new BusinessRuleError(
      'workload.invalid_range',
      'The end of the window cannot be before its start.',
    );
  }

  const effectiveOn = dateOnlyToPrismaDate(today);

  const [slots, lessonCounts] = await Promise.all([
    client.scheduleSlot.findMany({
      where: {
        ...scopeFilter(ctx),
        teacherId: teacher.id,
        isActive: true,
        effectiveFrom: { lte: effectiveOn },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }],
        group: { deletedAt: null, status: { in: [...LIVE_GROUP_STATUSES] } },
      },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      select: {
        id: true,
        dayOfWeek: true,
        startMinute: true,
        endMinute: true,
        group: { select: { id: true, code: true } },
      },
    }),
    client.lesson.groupBy({
      by: ['status'],
      where: {
        ...scopeFilter(ctx),
        teacherId: teacher.id,
        lessonDate: {
          gte: dateOnlyToPrismaDate(from),
          lte: dateOnlyToPrismaDate(to),
        },
      },
      _count: { _all: true },
    }),
  ]);

  const workloadSlots: WorkloadSlot[] = slots.map((slot) => ({
    slotId: slot.id,
    groupId: slot.group.id,
    groupCode: slot.group.code,
    dayOfWeek: slot.dayOfWeek,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    minutes: Math.max(0, slot.endMinute - slot.startMinute),
  }));

  const scheduledMinutesPerWeek = workloadSlots.reduce((total, slot) => total + slot.minutes, 0);
  const maxWeeklyMinutes = teacher.maxWeeklyHours * 60;

  const perDay = new Map<Weekday, { minutes: number; slotCount: number }>();
  for (const slot of workloadSlots) {
    const current = perDay.get(slot.dayOfWeek) ?? { minutes: 0, slotCount: 0 };
    perDay.set(slot.dayOfWeek, {
      minutes: current.minutes + slot.minutes,
      slotCount: current.slotCount + 1,
    });
  }

  const lessonsByStatus = new Map(lessonCounts.map((row) => [row.status, row._count._all]));
  const lessonTotal = lessonCounts.reduce((total, row) => total + row._count._all, 0);

  return {
    teacherId: teacher.id,
    fullName: teacherDisplayName(teacher),
    maxWeeklyHours: teacher.maxWeeklyHours,
    maxWeeklyMinutes,
    scheduledMinutesPerWeek,
    // Integer ppm, like every other ratio in this codebase: a float here would drift
    // and this number decides whether someone is flagged as over-allocated.
    utilizationPpm:
      maxWeeklyMinutes === 0
        ? null
        : Math.round((scheduledMinutesPerWeek * 1_000_000) / maxWeeklyMinutes),
    isOverAllocated: maxWeeklyMinutes > 0 && scheduledMinutesPerWeek > maxWeeklyMinutes,
    overAllocatedByMinutes:
      maxWeeklyMinutes > 0 ? Math.max(0, scheduledMinutesPerWeek - maxWeeklyMinutes) : 0,
    groupCount: new Set(workloadSlots.map((slot) => slot.groupId)).size,
    slots: workloadSlots,
    byDay: [...perDay.entries()].map(([dayOfWeek, tally]) => ({ dayOfWeek, ...tally })),
    lessons: {
      from,
      to,
      total: lessonTotal,
      completed: lessonsByStatus.get('COMPLETED') ?? 0,
      cancelled: lessonsByStatus.get('CANCELLED') ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Subject competence
// ---------------------------------------------------------------------------

export interface TeacherSubjectInput {
  readonly subjectId: string;
  readonly proficiency?: SubjectProficiency;
}

/**
 * Set which subjects a teacher may teach.
 *
 * Replace-wholesale, like a programme's curriculum: this is a small set a user edits
 * as a unit and nothing dated hangs off it. Removing a subject does NOT touch the
 * groups or lessons already taught -- competence is a forward-looking statement used
 * to suggest and validate future assignments.
 */
export async function manageTeacherSubjects(
  ctx: AccessContext,
  teacherId: string,
  input: { readonly subjects: readonly TeacherSubjectInput[] },
  db?: Db,
): Promise<readonly TeacherSubjectEntry[]> {
  requirePermission(ctx, 'teachers.manage');

  return withTransaction(
    async (tx) => {
      const teacher = await tx.teacher.findFirst({
        where: {
          id: teacherId,
          deletedAt: null,
          employee: { ...scopeFilter(ctx), deletedAt: null },
        },
        select: {
          id: true,
          employee: {
            select: { branchId: true, user: { select: { firstName: true, lastName: true } } },
          },
        },
      });
      if (!teacher) throw new NotFoundError('Teacher', teacherId);

      const seen = new Set<string>();
      for (const line of input.subjects) {
        if (seen.has(line.subjectId)) {
          throw new BusinessRuleError(
            'teacher.duplicate_subject',
            'The same subject is listed twice.',
            { details: { subjectId: line.subjectId } },
          );
        }
        seen.add(line.subjectId);
      }

      if (seen.size > 0) {
        const known = await tx.subject.findMany({
          where: {
            id: { in: [...seen] },
            organizationId: ctx.organizationId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const missing = [...seen].filter((id) => !known.some((subject) => subject.id === id));
        if (missing.length > 0) {
          throw new NotFoundError(
            missing.length === 1 ? 'Subject' : 'Subjects',
            missing.join(', '),
          );
        }
      }

      const previous = await tx.teacherSubject.findMany({
        where: { teacherId: teacher.id },
        select: { subjectId: true, proficiency: true },
      });

      await tx.teacherSubject.deleteMany({ where: { teacherId: teacher.id } });
      if (input.subjects.length > 0) {
        await tx.teacherSubject.createMany({
          data: input.subjects.map((line) => ({
            teacherId: teacher.id,
            subjectId: line.subjectId,
            proficiency: line.proficiency ?? 'PRIMARY',
          })),
        });
      }

      const teacherName = teacherDisplayName(teacher);

      await recordAudit(
        ctx,
        {
          action: 'teacher.subjects_changed',
          entityType: 'Teacher',
          entityId: teacher.id,
          branchId: teacher.employee.branchId,
          summary: `${teacherName} now teaches ${input.subjects.length} subject(s)`,
          changes: {
            subjects: {
              from: previous,
              to: input.subjects.map((line) => ({
                subjectId: line.subjectId,
                proficiency: line.proficiency ?? 'PRIMARY',
              })),
            },
          },
          timeline: {
            subjectType: 'TEACHER',
            subjectId: teacher.id,
            type: 'teacher.subjects_changed',
            title: 'Subject competence updated',
          },
        },
        tx,
      );

      const rows = await tx.teacherSubject.findMany({
        where: { teacherId: teacher.id },
        select: {
          proficiency: true,
          subject: { select: { id: true, name: true, code: true } },
        },
        orderBy: { subject: { name: 'asc' } },
      });

      return rows.map((row) => ({
        subjectId: row.subject.id,
        name: row.subject.name,
        code: row.subject.code,
        proficiency: row.proficiency,
      }));
    },
    { existing: db },
  );
}
