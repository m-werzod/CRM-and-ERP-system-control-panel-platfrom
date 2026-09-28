/**
 * Scoped lookup of the things a timetable entry points at.
 *
 * Both write paths in this module — a recurring slot and a concrete lesson —
 * need the same four resources validated in the same way: the group, an optional
 * teacher, an optional room and an optional subject. Resolving them once here
 * keeps the rules identical between the two, which matters because they are
 * security rules as much as sanity checks: every lookup carries the caller's
 * scope in its own `where`, so a branch-scoped user probing another branch's ids
 * gets NOT FOUND rather than a row or a distinguishable 403.
 *
 * It also produces the display names the conflict report needs, so a clash can be
 * described without a second round trip.
 */

import type { GroupStatus } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { BusinessRuleError, NotFoundError } from '@/server/errors';
import {
  organizationFilter,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import type { TimeZone } from '@/lib/dates';
import type { ResourceLabels } from '@/server/services/scheduling/conflicts';

export interface ResourceSelection {
  readonly groupId: string;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly subjectId?: string | null;
  /** Must match the group's branch when given; present so callers can be explicit. */
  readonly branchId?: string | null;
}

export interface ResolvedResources {
  readonly branchId: string;
  readonly group: {
    readonly id: string;
    readonly name: string;
    readonly branchId: string;
    readonly status: GroupStatus;
    readonly startDate: Date | null;
    readonly endDate: Date | null;
  };
  readonly teacherId: string | null;
  readonly roomId: string | null;
  readonly subjectId: string | null;
  readonly labels: ResourceLabels;
  readonly timezone: TimeZone;
}

/**
 * The upper bound on a wall-clock minute. 1440 is admissible as an END minute
 * only — a class may run to midnight but cannot start there.
 */
export const MINUTES_IN_DAY = 1440;

/** Reject a nonsensical window before it reaches the conflict checker. */
export function assertMinuteWindow(startMinute: number, endMinute: number): void {
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    throw new BusinessRuleError(
      'schedule.minutes_not_integral',
      'A lesson time must be a whole number of minutes from midnight.',
    );
  }
  if (startMinute < 0 || startMinute >= MINUTES_IN_DAY || endMinute > MINUTES_IN_DAY) {
    throw new BusinessRuleError(
      'schedule.minutes_out_of_day',
      'A lesson must start and end within the same day.',
      { details: { startMinute, endMinute } },
    );
  }
  if (endMinute <= startMinute) {
    throw new BusinessRuleError(
      'schedule.end_before_start',
      'A lesson must end after it starts.',
      { details: { startMinute, endMinute } },
    );
  }
}

export async function resolveResources(
  ctx: AccessContext,
  selection: ResourceSelection,
  db: Db = prisma,
  /** Names the resource in scope errors, e.g. "schedule slot" or "lesson". */
  resourceName = 'schedule slot',
): Promise<ResolvedResources> {
  const group = await db.group.findFirst({
    where: { id: selection.groupId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      name: true,
      branchId: true,
      status: true,
      startDate: true,
      endDate: true,
    },
  });
  if (!group) throw new NotFoundError('Group', selection.groupId);

  if (selection.branchId && selection.branchId !== group.branchId) {
    throw new BusinessRuleError(
      'schedule.branch_mismatch',
      'A timetable entry belongs to the same branch as its group.',
      { details: { groupBranchId: group.branchId, requestedBranchId: selection.branchId } },
    );
  }

  // The branch is the group's, never the caller's choice; `resolveWriteBranch`
  // is still what asserts the caller may write there at all.
  const branchId = resolveWriteBranch(ctx, group.branchId, resourceName);

  let teacherLabel: string | null = null;
  if (selection.teacherId) {
    // Teacher carries no organizationId of its own -- it is reached through the
    // employee, so the scope predicate goes on the relation.
    const teacher = await db.teacher.findFirst({
      where: {
        id: selection.teacherId,
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
    if (!teacher) throw new NotFoundError('Teacher', selection.teacherId);
    if (teacher.employee.status === 'TERMINATED' || teacher.employee.status === 'RESIGNED') {
      throw new BusinessRuleError(
        'schedule.teacher_not_employed',
        'This teacher has left and cannot be given new classes.',
      );
    }
    teacherLabel = `${teacher.employee.user.firstName} ${teacher.employee.user.lastName}`;
  }

  let roomLabel: string | null = null;
  if (selection.roomId) {
    const room = await db.room.findFirst({
      where: { id: selection.roomId, ...scopeFilter(ctx), deletedAt: null },
      select: { id: true, name: true, branchId: true, isActive: true },
    });
    if (!room) throw new NotFoundError('Room', selection.roomId);
    if (!room.isActive) {
      throw new BusinessRuleError('schedule.room_inactive', `${room.name} is not in use.`);
    }
    if (room.branchId !== group.branchId) {
      throw new BusinessRuleError(
        'schedule.room_other_branch',
        `${room.name} is in a different branch from this group.`,
        { details: { roomBranchId: room.branchId, groupBranchId: group.branchId } },
      );
    }
    roomLabel = room.name;
  }

  if (selection.subjectId) {
    const subject = await db.subject.findFirst({
      where: { id: selection.subjectId, ...organizationFilter(ctx), deletedAt: null },
      select: { id: true },
    });
    if (!subject) throw new NotFoundError('Subject', selection.subjectId);
  }

  const settings = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId },
    db,
  );

  return {
    branchId,
    group,
    teacherId: selection.teacherId ?? null,
    roomId: selection.roomId ?? null,
    subjectId: selection.subjectId ?? null,
    labels: { group: group.name, teacher: teacherLabel, room: roomLabel },
    timezone: settings.timezone,
  };
}

/** A group that has finished or been called off takes no new timetable entries. */
export function assertGroupSchedulable(group: { name: string; status: GroupStatus }): void {
  if (group.status === 'COMPLETED' || group.status === 'CANCELLED') {
    throw new BusinessRuleError(
      'schedule.group_closed',
      `${group.name} is ${group.status.toLowerCase()} and cannot be timetabled.`,
      { details: { status: group.status } },
    );
  }
}
