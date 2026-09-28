/**
 * Groups (classes): the thing a student is enrolled in, a teacher is assigned to and
 * a timetable is built for.
 *
 * A group belongs to exactly one branch, so every read here goes through
 * `composeReadFilter` and every write through `resolveWriteBranch` /
 * `assertBranchAccess`. Enrolment itself lives in students/enrollment.ts, which owns
 * the dated Enrollment history; this file owns the group record, its capacity
 * arithmetic and the reads a group screen needs.
 *
 * The "enrolled" number is never stored. It is the count of OPEN enrollments,
 * computed on read: a group that has had two hundred students over three years still
 * has its stated capacity today, and a cached counter would be one crashed request
 * away from lying about whether there is a seat free.
 *
 * `primaryTeacherId` / `assistantTeacherId` are NOT editable here -- they are a cache
 * of the authoritative GroupTeacher history and only academics/teachers.ts may move
 * them. See the header of that file.
 */

import type { GroupStatus, Prisma, ProgramLevel, Weekday } from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  can,
  composeReadFilter,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { dateOnlyToPrismaDate, prismaDateToDateOnly, type DateOnly } from '@/lib/dates';
import { assignTeacherToGroup } from '@/server/services/academics/teachers';
import {
  isUniqueViolation,
  teacherDisplayName,
  toPage,
  type PageInput,
  type Paginated,
  type SortDirection,
} from '@/server/services/academics/shared';

/** States in which a group is still running, or has yet to run. */
export const LIVE_GROUP_STATUSES: readonly GroupStatus[] = [
  'PLANNED',
  'ENROLLING',
  'ACTIVE',
  'PAUSED',
];

// ---------------------------------------------------------------------------
// Read scope
// ---------------------------------------------------------------------------

/**
 * SELF narrowing for groups: a teacher sees the groups they hold an open assignment
 * on, and nobody else SELF-scoped sees any.
 *
 * Deliberately stricter than `teacherGroupFilter`, which returns an empty predicate
 * for a SELF-scoped user who is not a teacher -- empty means "no narrowing", i.e. the
 * whole organisation. A student portal account must fail closed here.
 */
function selfGroupFilter(ctx: AccessContext): Record<string, unknown> {
  const teacherId = ctx.self.teacherId;
  if (!teacherId) return { id: { in: [] as string[] } };
  return { teacherAssignments: { some: { teacherId, endDate: null } } };
}

/**
 * `composeReadFilter` is model-agnostic by design and hands back an opaque predicate
 * record, which TypeScript will not narrow to a generated Prisma type. The assertion
 * goes through `unknown` because the two types do not structurally overlap; the
 * predicate's shape is guaranteed by access.ts, not by this cast.
 */
function groupReadFilter(ctx: AccessContext): Prisma.GroupWhereInput {
  return composeReadFilter(ctx, {
    selfFilter: selfGroupFilter(ctx),
    // "View timetables for all teachers and groups" is the closest existing escape
    // hatch; there is no `groups.viewAll` in the catalogue.
    escapeHatch: 'schedule.viewAll',
  }) as unknown as Prisma.GroupWhereInput;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CreateGroupInput {
  readonly name: string;
  readonly code: string;
  readonly branchId?: string | null;
  readonly programId?: string | null;
  readonly subjectId?: string | null;
  readonly roomId?: string | null;
  readonly academicYearId?: string | null;
  readonly termId?: string | null;
  readonly level?: ProgramLevel | null;
  readonly capacity?: number;
  readonly startDate?: DateOnly | null;
  readonly endDate?: DateOnly | null;
  readonly status?: GroupStatus;
  readonly notes?: string | null;
  /**
   * Optional first teachers. Delegated to `assignTeacherToGroup` in the same
   * transaction so the GroupTeacher history exists from the start -- which also means
   * supplying one requires `groups.assignTeacher` as well as `groups.create`.
   */
  readonly primaryTeacherId?: string | null;
  readonly assistantTeacherId?: string | null;
}

export interface UpdateGroupInput {
  readonly name?: string;
  readonly code?: string;
  readonly programId?: string | null;
  readonly subjectId?: string | null;
  readonly roomId?: string | null;
  readonly academicYearId?: string | null;
  readonly termId?: string | null;
  readonly level?: ProgramLevel | null;
  readonly capacity?: number;
  readonly startDate?: DateOnly | null;
  readonly endDate?: DateOnly | null;
  readonly status?: GroupStatus;
  readonly notes?: string | null;
}

export interface GroupSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly branchId: string;
  readonly programId: string | null;
  readonly programName: string | null;
  readonly subjectId: string | null;
  readonly subjectName: string | null;
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly academicYearId: string | null;
  readonly termId: string | null;
  readonly level: ProgramLevel | null;
  readonly capacity: number;
  readonly status: GroupStatus;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  readonly notes: string | null;
  readonly primaryTeacherId: string | null;
  readonly primaryTeacherName: string | null;
  readonly assistantTeacherId: string | null;
  readonly assistantTeacherName: string | null;
  readonly archivedAt: Date | null;
}

export interface GroupListRow extends GroupSummary {
  readonly enrolled: number;
  readonly available: number;
}

export interface GroupCapacity {
  readonly capacity: number;
  readonly enrolled: number;
  readonly available: number;
}

const GROUP_SELECT = {
  id: true,
  name: true,
  code: true,
  branchId: true,
  programId: true,
  subjectId: true,
  roomId: true,
  academicYearId: true,
  termId: true,
  level: true,
  capacity: true,
  status: true,
  startDate: true,
  endDate: true,
  notes: true,
  primaryTeacherId: true,
  assistantTeacherId: true,
  deletedAt: true,
  program: { select: { name: true } },
  subject: { select: { name: true } },
  room: { select: { name: true } },
  primaryTeacher: { select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } } },
  assistantTeacher: { select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } } },
} as const;

type GroupRow = Prisma.GroupGetPayload<{ select: typeof GROUP_SELECT }>;

function toSummary(row: GroupRow): GroupSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    branchId: row.branchId,
    programId: row.programId,
    programName: row.program?.name ?? null,
    subjectId: row.subjectId,
    subjectName: row.subject?.name ?? null,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    academicYearId: row.academicYearId,
    termId: row.termId,
    level: row.level,
    capacity: row.capacity,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
    primaryTeacherId: row.primaryTeacherId,
    primaryTeacherName: teacherDisplayName(row.primaryTeacher),
    assistantTeacherId: row.assistantTeacherId,
    assistantTeacherName: teacherDisplayName(row.assistantTeacher),
    archivedAt: row.deletedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation shared by create and update
// ---------------------------------------------------------------------------

function assertDates(startDate: DateOnly | null, endDate: DateOnly | null): void {
  if (startDate && endDate && endDate < startDate) {
    // Compared as ISO date strings, which sort lexicographically; the same rule is a
    // CHECK constraint on `groups`.
    throw new BusinessRuleError(
      'group.dates_out_of_order',
      'The group cannot finish before it starts.',
    );
  }
}

function assertCapacity(capacity: number | undefined): void {
  if (capacity === undefined) return;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new BusinessRuleError(
      'group.invalid_capacity',
      'Capacity must be a whole number of at least one place.',
    );
  }
}

/**
 * Check that every referenced row exists inside this organisation, and that a room
 * belongs to the group's own branch. A room in another building cannot host the
 * class, and the schedule conflict checks assume the two agree.
 */
async function assertReferences(
  ctx: AccessContext,
  tx: Db,
  branchId: string,
  input: {
    programId?: string | null;
    subjectId?: string | null;
    roomId?: string | null;
    academicYearId?: string | null;
    termId?: string | null;
  },
): Promise<void> {
  if (input.programId) {
    const program = await tx.program.findFirst({
      where: { id: input.programId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!program) throw new NotFoundError('Programme', input.programId);
  }

  if (input.subjectId) {
    const subject = await tx.subject.findFirst({
      where: { id: input.subjectId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!subject) throw new NotFoundError('Subject', input.subjectId);
  }

  if (input.roomId) {
    const room = await tx.room.findFirst({
      where: { id: input.roomId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, branchId: true, name: true },
    });
    if (!room) throw new NotFoundError('Room', input.roomId);
    if (room.branchId !== branchId) {
      throw new BusinessRuleError(
        'group.room_in_other_branch',
        `${room.name} is in another branch and cannot host this group.`,
        { details: { roomBranchId: room.branchId, groupBranchId: branchId } },
      );
    }
  }

  if (input.academicYearId) {
    const year = await tx.academicYear.findFirst({
      where: { id: input.academicYearId, organizationId: ctx.organizationId },
      select: { id: true },
    });
    if (!year) throw new NotFoundError('Academic year', input.academicYearId);
  }

  if (input.termId) {
    const term = await tx.term.findFirst({
      where: {
        id: input.termId,
        academicYear: { organizationId: ctx.organizationId },
        ...(input.academicYearId ? { academicYearId: input.academicYearId } : {}),
      },
      select: { id: true },
    });
    if (!term) {
      throw new NotFoundError(
        input.academicYearId ? 'Term in that academic year' : 'Term',
        input.termId,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createGroup(
  ctx: AccessContext,
  input: CreateGroupInput,
  db?: Db,
): Promise<GroupSummary> {
  requirePermission(ctx, 'groups.create');
  assertCapacity(input.capacity);
  assertDates(input.startDate ?? null, input.endDate ?? null);

  if (
    input.primaryTeacherId &&
    input.assistantTeacherId &&
    input.primaryTeacherId === input.assistantTeacherId
  ) {
    throw new BusinessRuleError(
      'group.same_teacher_twice',
      'The primary teacher and the assistant cannot be the same person.',
    );
  }

  return withTransaction(
    async (tx) => {
      const branchId = resolveWriteBranch(ctx, input.branchId, 'group');
      await assertReferences(ctx, tx, branchId, input);

      let created: GroupRow;
      try {
        created = await tx.group.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            name: input.name,
            code: input.code,
            programId: input.programId ?? null,
            subjectId: input.subjectId ?? null,
            roomId: input.roomId ?? null,
            academicYearId: input.academicYearId ?? null,
            termId: input.termId ?? null,
            level: input.level ?? null,
            capacity: input.capacity ?? 15,
            status: input.status ?? 'PLANNED',
            startDate: input.startDate ? dateOnlyToPrismaDate(input.startDate) : null,
            endDate: input.endDate ? dateOnlyToPrismaDate(input.endDate) : null,
            notes: input.notes ?? null,
            createdById: ctx.isSystem ? null : ctx.userId,
          },
          select: GROUP_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError(
            'group',
            ['code'],
            `The group code "${input.code}" is already used in this organisation. It may belong to an archived group.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GROUP_CREATED,
          entityType: 'Group',
          entityId: created.id,
          branchId,
          summary: `Group ${created.code} — ${created.name} created`,
          metadata: {
            capacity: created.capacity,
            status: created.status,
            programId: created.programId,
          },
          timeline: {
            subjectType: 'GROUP',
            subjectId: created.id,
            type: 'group.created',
            title: `Group ${created.name} created`,
          },
        },
        tx,
      );

      // Teachers go through the assignment use-case so GroupTeacher -- not the cache
      // column -- is the origin of the history.
      if (input.primaryTeacherId) {
        await assignTeacherToGroup(
          ctx,
          { groupId: created.id, teacherId: input.primaryTeacherId, role: 'PRIMARY' },
          tx,
        );
      }
      if (input.assistantTeacherId) {
        await assignTeacherToGroup(
          ctx,
          { groupId: created.id, teacherId: input.assistantTeacherId, role: 'ASSISTANT' },
          tx,
        );
      }

      if (input.primaryTeacherId || input.assistantTeacherId) {
        const refreshed = await tx.group.findFirst({
          where: { id: created.id },
          select: GROUP_SELECT,
        });
        if (refreshed) return toSummary(refreshed);
      }

      return toSummary(created);
    },
    { existing: db },
  );
}

/**
 * Edit a group.
 *
 * Teacher fields are absent from `UpdateGroupInput` on purpose: writing
 * `primaryTeacherId` here would move the cache without opening a GroupTeacher row,
 * leaving the group's history claiming the previous teacher still holds the class.
 * Use `assignTeacherToGroup`.
 */
export async function updateGroup(
  ctx: AccessContext,
  groupId: string,
  input: UpdateGroupInput,
  db?: Db,
): Promise<GroupSummary> {
  requirePermission(ctx, 'groups.edit');
  assertCapacity(input.capacity);

  return withTransaction(
    async (tx) => {
      const existing = await tx.group.findFirst({
        where: { id: groupId, ...scopeFilter(ctx), deletedAt: null },
        select: GROUP_SELECT,
      });
      if (!existing) throw new NotFoundError('Group', groupId);
      assertBranchAccess(ctx, existing.branchId, 'group');

      // Validate the dates as they will END UP, not as they were submitted: changing
      // only the end date must still be checked against the stored start.
      const nextStart =
        input.startDate === undefined
          ? existing.startDate
            ? prismaDateToDateOnly(existing.startDate)
            : null
          : input.startDate;
      const nextEnd =
        input.endDate === undefined
          ? existing.endDate
            ? prismaDateToDateOnly(existing.endDate)
            : null
          : input.endDate;
      assertDates(nextStart, nextEnd);

      await assertReferences(ctx, tx, existing.branchId, {
        programId: input.programId,
        subjectId: input.subjectId,
        roomId: input.roomId,
        academicYearId: input.academicYearId ?? existing.academicYearId,
        termId: input.termId,
      });

      if (input.capacity !== undefined && input.capacity < existing.capacity) {
        const enrolled = await tx.enrollment.count({
          where: { groupId: existing.id, endDate: null },
        });
        if (input.capacity < enrolled) {
          throw new BusinessRuleError(
            'group.capacity_below_enrolled',
            `${existing.name} already has ${enrolled} students enrolled, so capacity cannot be reduced to ${input.capacity}.`,
            { details: { enrolled, requestedCapacity: input.capacity } },
          );
        }
      }

      const data: Prisma.GroupUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code;
      if (input.programId !== undefined) data.programId = input.programId;
      if (input.subjectId !== undefined) data.subjectId = input.subjectId;
      if (input.roomId !== undefined) data.roomId = input.roomId;
      if (input.academicYearId !== undefined) data.academicYearId = input.academicYearId;
      if (input.termId !== undefined) data.termId = input.termId;
      if (input.level !== undefined) data.level = input.level;
      if (input.capacity !== undefined) data.capacity = input.capacity;
      if (input.status !== undefined) data.status = input.status;
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.startDate !== undefined) {
        data.startDate = input.startDate ? dateOnlyToPrismaDate(input.startDate) : null;
      }
      if (input.endDate !== undefined) {
        data.endDate = input.endDate ? dateOnlyToPrismaDate(input.endDate) : null;
      }

      let updated: GroupRow;
      try {
        updated = await tx.group.update({
          where: { id: existing.id },
          data,
          select: GROUP_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError(
            'group',
            ['code'],
            `The group code "${input.code ?? existing.code}" is already used in this organisation.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GROUP_UPDATED,
          entityType: 'Group',
          entityId: existing.id,
          branchId: existing.branchId,
          summary: `Group ${updated.code} — ${updated.name} updated`,
          changes: diffFields(
            {
              name: existing.name,
              code: existing.code,
              programId: existing.programId,
              subjectId: existing.subjectId,
              roomId: existing.roomId,
              academicYearId: existing.academicYearId,
              termId: existing.termId,
              level: existing.level,
              capacity: existing.capacity,
              status: existing.status,
              startDate: existing.startDate,
              endDate: existing.endDate,
              notes: existing.notes,
            },
            {
              name: input.name,
              code: input.code,
              programId: input.programId,
              subjectId: input.subjectId,
              roomId: input.roomId,
              academicYearId: input.academicYearId,
              termId: input.termId,
              level: input.level,
              capacity: input.capacity,
              status: input.status,
              startDate: updated.startDate,
              endDate: updated.endDate,
              notes: input.notes,
            },
          ),
        },
        tx,
      );

      return toSummary(updated);
    },
    { existing: db },
  );
}

/**
 * Archive a group.
 *
 * Refused while any enrollment is still open: archiving would remove the class from
 * every list while students were still in it, and their attendance and invoices would
 * go on referencing a group nobody can find. End or transfer those enrollments first.
 *
 * Its timetable slots are deactivated in the same transaction, because a slot left
 * active would keep the lesson generator producing lessons for an archived group.
 */
export async function archiveGroup(
  ctx: AccessContext,
  groupId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<GroupSummary> {
  requirePermission(ctx, 'groups.delete');

  return withTransaction(
    async (tx) => {
      const group = await tx.group.findFirst({
        where: { id: groupId, ...scopeFilter(ctx), deletedAt: null },
        select: GROUP_SELECT,
      });
      if (!group) throw new NotFoundError('Group', groupId);
      assertBranchAccess(ctx, group.branchId, 'group');

      const openEnrollments = await tx.enrollment.count({
        where: { groupId: group.id, endDate: null },
      });
      if (openEnrollments > 0) {
        throw new BusinessRuleError(
          'group.has_open_enrollments',
          `${group.name} still has ${openEnrollments} enrolled student(s). End or transfer their enrollments before archiving it.`,
          { details: { openEnrollments } },
        );
      }

      const now = new Date();
      await tx.group.update({
        where: { id: group.id },
        data: {
          deletedAt: now,
          // A group that finished keeps COMPLETED as its academic outcome; anything
          // else is cancelled, because an archived-but-ACTIVE group would misreport
          // every status dashboard.
          status: group.status === 'COMPLETED' ? group.status : 'CANCELLED',
        },
      });
      const deactivatedSlots = await tx.scheduleSlot.updateMany({
        where: { groupId: group.id, isActive: true },
        data: { isActive: false },
      });

      await recordAudit(
        ctx,
        {
          action: 'group.archived',
          entityType: 'Group',
          entityId: group.id,
          branchId: group.branchId,
          summary: `Group ${group.code} — ${group.name} archived`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: { deactivatedScheduleSlots: deactivatedSlots.count },
          timeline: {
            subjectType: 'GROUP',
            subjectId: group.id,
            type: 'group.archived',
            title: 'Group archived',
            description: input.reason ?? null,
          },
        },
        tx,
      );

      const archived = await tx.group.findFirst({
        where: { id: group.id },
        select: GROUP_SELECT,
      });
      // The row was just updated inside this transaction, so it is always found; the
      // guard is only here because findFirst is nullable.
      return toSummary(archived ?? group);
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListGroupsInput extends PageInput {
  readonly q?: string;
  readonly branchId?: string;
  readonly status?: readonly GroupStatus[];
  readonly programId?: string;
  readonly subjectId?: string;
  /** Groups the teacher holds an OPEN assignment on, in any role. */
  readonly teacherId?: string;
  readonly level?: ProgramLevel;
  readonly academicYearId?: string;
  readonly termId?: string;
  /** true: only groups with a free place. false: only full ones. */
  readonly hasCapacity?: boolean;
  readonly includeArchived?: boolean;
  readonly sortBy?: 'name' | 'code' | 'startDate' | 'createdAt';
  readonly sortDir?: SortDirection;
}

export async function listGroups(
  ctx: AccessContext,
  input: ListGroupsInput = {},
  db?: Db,
): Promise<Paginated<GroupListRow>> {
  requirePermission(ctx, 'groups.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  // Verified before it is merged in: spreading a requested branch over the scope
  // filter's own `branchId` would otherwise widen the caller's scope.
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'group');

  const where: Prisma.GroupWhereInput = {
    ...groupReadFilter(ctx),
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.status && input.status.length > 0 ? { status: { in: [...input.status] } } : {}),
    ...(input.programId ? { programId: input.programId } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
    ...(input.level ? { level: input.level } : {}),
    ...(input.academicYearId ? { academicYearId: input.academicYearId } : {}),
    ...(input.termId ? { termId: input.termId } : {}),
    ...(input.teacherId
      ? // Through the authoritative history, not the cache: this also finds groups
        // where the teacher is the assistant or the standing substitute.
        { teacherAssignments: { some: { teacherId: input.teacherId, endDate: null } } }
      : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { code: { contains: input.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  if (input.hasCapacity !== undefined) {
    const fullGroupIds = await findFullGroupIds(ctx, client);
    // Prisma cannot compare a relation count against a sibling column, so the seat
    // test is done in SQL and its (typically short) result narrows this query. The
    // list is of FULL groups because those are the rare ones.
    where.id = input.hasCapacity ? { notIn: fullGroupIds } : { in: fullGroupIds };
  }

  const sortBy = input.sortBy ?? 'name';
  const [rows, total] = await Promise.all([
    client.group.findMany({
      where,
      orderBy: { [sortBy]: input.sortDir ?? 'asc' },
      skip,
      take,
      select: GROUP_SELECT,
    }),
    client.group.count({ where }),
  ]);

  const enrolledByGroup = await countOpenEnrollments(
    client,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) => {
      const enrolled = enrolledByGroup.get(row.id) ?? 0;
      return {
        ...toSummary(row),
        enrolled,
        available: Math.max(0, row.capacity - enrolled),
      };
    }),
    page,
    pageSize,
    total,
  };
}

/**
 * Ids of the groups whose open enrolments have reached their capacity.
 *
 * Scoped to the organisation only: the result is intersected with the caller's own
 * scoped predicate by `listGroups`, so nothing outside their branches can be revealed
 * by it either way.
 */
async function findFullGroupIds(ctx: AccessContext, client: Db): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    select g."id"
    from "groups" g
    where g."organizationId" = ${ctx.organizationId}
      and g."deletedAt" is null
      and (
        select count(*) from "enrollments" e
        where e."groupId" = g."id" and e."endDate" is null
      ) >= g."capacity"
  `;
  return rows.map((row) => row.id);
}

/**
 * Open-enrolment counts for a page of groups: ONE grouped query folded into a Map,
 * not a count per row.
 *
 * `Enrollment` carries no organizationId -- it is reached only through a student and a
 * group -- so the tenancy predicate is the caller-supplied id list, which came from an
 * already-scoped query.
 */
async function countOpenEnrollments(
  client: Db,
  groupIds: readonly string[],
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await client.enrollment.groupBy({
    by: ['groupId'],
    where: { groupId: { in: [...groupIds] }, endDate: null },
    _count: { _all: true },
  });
  return new Map(rows.map((row) => [row.groupId, row._count._all]));
}

export interface GroupRosterEntry {
  readonly enrollmentId: string;
  readonly studentId: string;
  readonly studentCode: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly photoUrl: string | null;
  readonly startDate: Date;
  readonly status: string;
}

export interface GroupScheduleSlotEntry {
  readonly slotId: string;
  readonly dayOfWeek: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly roomName: string | null;
  readonly subjectName: string | null;
  readonly teacherId: string | null;
  readonly teacherName: string | null;
}

export interface GroupTeacherHistoryEntry {
  readonly assignmentId: string;
  readonly teacherId: string;
  readonly teacherName: string;
  readonly role: string;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly endReason: string | null;
  readonly isOpen: boolean;
}

export interface GroupDetail extends GroupListRow {
  readonly roster: readonly GroupRosterEntry[];
  /**
   * `false` means the caller lacks `students.view`, so `roster` is empty for that
   * reason rather than because the group is empty.
   */
  readonly canViewRoster: boolean;
  readonly scheduleSlots: readonly GroupScheduleSlotEntry[];
  readonly teacherHistory: readonly GroupTeacherHistoryEntry[];
}

/**
 * One group with everything its page shows: the current roster, the timetable pattern
 * and the full dated teacher history.
 *
 * The roster is the OPEN enrollments, i.e. who is in the class now. Who was in the
 * room on a particular past date is a different question, answered by
 * `getGroupRoster` in students/enrollment.ts, which takes a date.
 */
export async function getGroup(
  ctx: AccessContext,
  groupId: string,
  db?: Db,
): Promise<GroupDetail> {
  requirePermission(ctx, 'groups.view');
  const client = db ?? prisma;

  const group = await client.group.findFirst({
    // Scope in the same where clause, so a group in another branch reads as absent
    // rather than as forbidden.
    where: { id: groupId, ...groupReadFilter(ctx) },
    select: GROUP_SELECT,
  });
  if (!group) throw new NotFoundError('Group', groupId);

  const canViewRoster = can(ctx, 'students.view');

  const [enrollments, slots, history, enrolledCount] = await Promise.all([
    canViewRoster
      ? client.enrollment.findMany({
          where: { groupId: group.id, endDate: null, student: { deletedAt: null } },
          orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }],
          select: {
            id: true,
            startDate: true,
            status: true,
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
        })
      : Promise.resolve([]),
    client.scheduleSlot.findMany({
      where: { groupId: group.id, isActive: true },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      select: {
        id: true,
        dayOfWeek: true,
        startMinute: true,
        endMinute: true,
        effectiveFrom: true,
        effectiveTo: true,
        room: { select: { name: true } },
        subject: { select: { name: true } },
        teacherId: true,
        teacher: {
          select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
        },
      },
    }),
    client.groupTeacher.findMany({
      where: { groupId: group.id },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        teacherId: true,
        role: true,
        startDate: true,
        endDate: true,
        endReason: true,
        teacher: {
          select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
        },
      },
    }),
    client.enrollment.count({ where: { groupId: group.id, endDate: null } }),
  ]);

  return {
    ...toSummary(group),
    enrolled: enrolledCount,
    available: Math.max(0, group.capacity - enrolledCount),
    canViewRoster,
    roster: enrollments.map((row) => ({
      enrollmentId: row.id,
      studentId: row.student.id,
      studentCode: row.student.studentCode,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      photoUrl: row.student.photoUrl,
      startDate: row.startDate,
      status: row.status,
    })),
    scheduleSlots: slots.map((slot) => ({
      slotId: slot.id,
      dayOfWeek: slot.dayOfWeek,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      effectiveFrom: slot.effectiveFrom,
      effectiveTo: slot.effectiveTo,
      roomName: slot.room?.name ?? null,
      subjectName: slot.subject?.name ?? null,
      teacherId: slot.teacherId,
      teacherName: teacherDisplayName(slot.teacher),
    })),
    teacherHistory: history.map((row) => ({
      assignmentId: row.id,
      teacherId: row.teacherId,
      teacherName: teacherDisplayName(row.teacher),
      role: row.role,
      startDate: row.startDate,
      endDate: row.endDate,
      endReason: row.endReason,
      isOpen: row.endDate === null,
    })),
  };
}

/**
 * Seats: stated capacity, open enrolments, and the difference.
 *
 * Counted live rather than cached, and clamped at zero so an over-capacity group
 * (which `allowGroupOvercapacity` permits) reports no free places rather than a
 * negative number a UI would render as "-2 available".
 */
export async function getGroupCapacity(
  ctx: AccessContext,
  groupId: string,
  db?: Db,
): Promise<GroupCapacity> {
  requirePermission(ctx, 'groups.view');
  const client = db ?? prisma;

  const group = await client.group.findFirst({
    where: { id: groupId, ...groupReadFilter(ctx), deletedAt: null },
    select: { id: true, capacity: true },
  });
  if (!group) throw new NotFoundError('Group', groupId);

  const enrolled = await client.enrollment.count({
    where: { groupId: group.id, endDate: null },
  });

  return {
    capacity: group.capacity,
    enrolled,
    available: Math.max(0, group.capacity - enrolled),
  };
}
