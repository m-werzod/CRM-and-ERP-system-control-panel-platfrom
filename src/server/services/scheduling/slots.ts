/**
 * The recurring timetable: `ScheduleSlot` use-cases.
 *
 * A slot is a standing weekly reservation — "Maths A2, Mondays 09:00–10:30, Room
 * 201, teacher X, effective from 1 September". Concrete `Lesson` rows are
 * materialised from it (see ./lessons.ts); the slot itself holds no instants,
 * only local wall-clock minutes, so a DST transition moves the class with the
 * local clock instead of shifting it by an hour.
 *
 * EVERY WRITE RUNS THE CONFLICT CHECK. The candidate's peers are loaded in ONE
 * query, narrowed in SQL to rows that could possibly clash, and handed to the
 * pure checker in ./conflicts.ts. Nothing here re-implements an overlap test.
 *
 * Slots are never deleted. `deactivateScheduleSlot` closes the pattern with an
 * `effectiveTo` date, so lessons already generated under it keep pointing at the
 * row that explains them — the same history rule enrollments follow.
 */

import type { Prisma, Weekday } from '@/generated/prisma/client';
import {
  prisma,
  withSerializableRetry,
  withTransaction,
  type Db,
  type Tx,
} from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  ScheduleConflictError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  requirePermission,
  scopeFilter,
  teacherLessonFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import {
  dateOnlyToPrismaDate,
  formatWallClock,
  isDateOnly,
  prismaDateToDateOnly,
  todayIn,
  type DateOnly,
} from '@/lib/dates';
import {
  findSlotConflicts,
  TIME_FREEING_LESSON_STATUSES,
  type ExistingSlot,
  type SlotCandidate,
} from '@/server/services/scheduling/conflicts';
import {
  assertGroupSchedulable,
  assertMinuteWindow,
  resolveResources,
} from '@/server/services/scheduling/resources';

/** Monday-first; `getWeeklyTimetable` rotates it per the `weekStartsOn` setting. */
const WEEK_ORDER: readonly Weekday[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export interface ScheduleSlotSummary {
  readonly id: string;
  readonly branchId: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly teacherId: string | null;
  readonly teacherName: string | null;
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly subjectId: string | null;
  readonly subjectName: string | null;
  readonly dayOfWeek: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
  /** `HH:MM` in the branch timezone, so the grid need not format minutes itself. */
  readonly startTime: string;
  readonly endTime: string;
  readonly durationMinutes: number;
  readonly effectiveFrom: DateOnly;
  readonly effectiveTo: DateOnly | null;
  readonly isActive: boolean;
}

const SLOT_SELECT = {
  id: true,
  branchId: true,
  groupId: true,
  teacherId: true,
  roomId: true,
  subjectId: true,
  dayOfWeek: true,
  startMinute: true,
  endMinute: true,
  effectiveFrom: true,
  effectiveTo: true,
  isActive: true,
  group: { select: { name: true } },
  subject: { select: { name: true } },
  room: { select: { name: true } },
  teacher: {
    select: { employee: { select: { user: { select: { firstName: true, lastName: true } } } } },
  },
} satisfies Prisma.ScheduleSlotSelect;

type SlotRow = Prisma.ScheduleSlotGetPayload<{ select: typeof SLOT_SELECT }>;

function toSummary(row: SlotRow): ScheduleSlotSummary {
  const teacherUser = row.teacher?.employee.user;
  return {
    id: row.id,
    branchId: row.branchId,
    groupId: row.groupId,
    groupName: row.group.name,
    teacherId: row.teacherId,
    teacherName: teacherUser ? `${teacherUser.firstName} ${teacherUser.lastName}` : null,
    roomId: row.roomId,
    roomName: row.room?.name ?? null,
    subjectId: row.subjectId,
    subjectName: row.subject?.name ?? null,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    startTime: formatWallClock(row.startMinute),
    endTime: row.endMinute === 1440 ? '24:00' : formatWallClock(row.endMinute),
    durationMinutes: row.endMinute - row.startMinute,
    effectiveFrom: prismaDateToDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? prismaDateToDateOnly(row.effectiveTo) : null,
    isActive: row.isActive,
  };
}

// ---------------------------------------------------------------------------
// Conflict check
// ---------------------------------------------------------------------------

/**
 * Load the slots that could possibly clash with `candidate`, in one query.
 *
 * Deliberately NOT branch-scoped. A teacher may work in more than one branch, so
 * a check confined to the caller's branches would happily double-book them; the
 * resource ids are globally unique, which makes the organisation the correct
 * boundary. Tenancy is still pinned by `organizationId`, and the conflict report
 * names only resources the caller themselves chose (see ./conflicts.ts), so
 * nothing about the other branch leaks.
 */
async function loadSlotPeers(
  ctx: AccessContext,
  db: Db,
  candidate: SlotCandidate,
): Promise<ExistingSlot[]> {
  const resourceMatches: Prisma.ScheduleSlotWhereInput[] = [{ groupId: candidate.groupId }];
  if (candidate.teacherId) resourceMatches.push({ teacherId: candidate.teacherId });
  if (candidate.roomId) resourceMatches.push({ roomId: candidate.roomId });

  const rows = await db.scheduleSlot.findMany({
    where: {
      organizationId: ctx.organizationId,
      dayOfWeek: candidate.dayOfWeek,
      isActive: true,
      ...(candidate.id ? { id: { not: candidate.id } } : {}),
      OR: resourceMatches,
      // Narrow the effective ranges in SQL too: an archived term's patterns must
      // not be dragged into memory just to be discarded by the pure checker.
      AND: [
        ...(candidate.effectiveTo
          ? [{ effectiveFrom: { lte: dateOnlyToPrismaDate(candidate.effectiveTo) } }]
          : []),
        {
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gte: dateOnlyToPrismaDate(candidate.effectiveFrom) } },
          ],
        },
      ],
    },
    select: {
      id: true,
      groupId: true,
      teacherId: true,
      roomId: true,
      dayOfWeek: true,
      startMinute: true,
      endMinute: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    effectiveFrom: prismaDateToDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? prismaDateToDateOnly(row.effectiveTo) : null,
  }));
}

/**
 * Throw if the candidate pattern clashes with a standing reservation.
 *
 * Exported because a concrete lesson must be checked against the pattern level
 * too (./lessons.ts) — an hour a slot has reserved but not yet materialised is
 * still taken. `excludeSlotId` lets a lesson ignore the slot it is an instance of.
 */
export async function assertSlotIsFree(
  ctx: AccessContext,
  db: Db,
  candidate: SlotCandidate,
  excludeSlotId?: string | null,
): Promise<void> {
  const effective: SlotCandidate = excludeSlotId
    ? { ...candidate, id: excludeSlotId }
    : candidate;
  const conflicts = findSlotConflicts(effective, await loadSlotPeers(ctx, db, effective));
  if (conflicts.length > 0) throw new ScheduleConflictError(conflicts);
}

function assertEffectiveRange(effectiveFrom: DateOnly, effectiveTo: DateOnly | null): void {
  if (!isDateOnly(effectiveFrom)) {
    throw new BusinessRuleError('schedule.bad_effective_from', 'The start date is not a calendar date.');
  }
  if (effectiveTo !== null) {
    if (!isDateOnly(effectiveTo)) {
      throw new BusinessRuleError('schedule.bad_effective_to', 'The end date is not a calendar date.');
    }
    if (effectiveTo < effectiveFrom) {
      throw new BusinessRuleError(
        'schedule.effective_to_before_from',
        'The timetable entry cannot end before it starts.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateScheduleSlotInput {
  readonly groupId: string;
  readonly dayOfWeek: Weekday;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly effectiveFrom: DateOnly;
  readonly effectiveTo?: DateOnly | null;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly subjectId?: string | null;
  /** Optional and only ever confirmatory: the slot's branch is the group's. */
  readonly branchId?: string | null;
}

export async function createScheduleSlot(
  ctx: AccessContext,
  input: CreateScheduleSlotInput,
  db?: Db,
): Promise<ScheduleSlotSummary> {
  requirePermission(ctx, 'schedule.manage');

  // Serializable, not because money moves, but because the invariant has no
  // database constraint behind it: two administrators booking the same room at
  // the same instant would both read a clear check and both write under READ
  // COMMITTED. Write skew is the exact anomaly, and there is no unique index to
  // catch the loser.
  return withSerializableRetry(
    async (tx) => {
      assertMinuteWindow(input.startMinute, input.endMinute);
      const effectiveTo = input.effectiveTo ?? null;
      assertEffectiveRange(input.effectiveFrom, effectiveTo);

      const resources = await resolveResources(ctx, input, tx);
      assertGroupSchedulable(resources.group);

      if (resources.group.endDate && dateOnlyToPrismaDate(input.effectiveFrom) > resources.group.endDate) {
        throw new BusinessRuleError(
          'schedule.after_group_end',
          `${resources.group.name} has already finished on the date this entry would start.`,
        );
      }

      // The conflict check and the insert share one transaction, so two
      // administrators booking the same room at the same moment cannot both pass.
      await assertSlotIsFree(ctx, tx, {
        groupId: input.groupId,
        teacherId: resources.teacherId,
        roomId: resources.roomId,
        dayOfWeek: input.dayOfWeek,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        effectiveFrom: input.effectiveFrom,
        effectiveTo,
        labels: resources.labels,
      });

      const created = await tx.scheduleSlot.create({
        data: {
          organizationId: ctx.organizationId,
          branchId: resources.branchId,
          groupId: input.groupId,
          teacherId: resources.teacherId,
          roomId: resources.roomId,
          subjectId: resources.subjectId,
          dayOfWeek: input.dayOfWeek,
          startMinute: input.startMinute,
          endMinute: input.endMinute,
          effectiveFrom: dateOnlyToPrismaDate(input.effectiveFrom),
          effectiveTo: effectiveTo ? dateOnlyToPrismaDate(effectiveTo) : null,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: SLOT_SELECT,
      });

      const summary = toSummary(created);

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.SCHEDULE_CHANGED,
          entityType: 'ScheduleSlot',
          entityId: summary.id,
          branchId: summary.branchId,
          summary: `${summary.groupName} timetabled ${summary.dayOfWeek.toLowerCase()} ${summary.startTime}–${summary.endTime}`,
          metadata: {
            groupId: summary.groupId,
            teacherId: summary.teacherId,
            roomId: summary.roomId,
            dayOfWeek: summary.dayOfWeek,
            startMinute: summary.startMinute,
            endMinute: summary.endMinute,
          },
          timeline: {
            subjectType: 'GROUP',
            subjectId: summary.groupId,
            type: 'schedule.slot.created',
            title: `Added to the timetable: ${summary.dayOfWeek.toLowerCase()} ${summary.startTime}–${summary.endTime}`,
            description: summary.roomName,
          },
        },
        tx,
      );

      return summary;
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateScheduleSlotInput {
  readonly slotId: string;
  /** `undefined` leaves a field unchanged; `null` clears a nullable one. */
  readonly dayOfWeek?: Weekday;
  readonly startMinute?: number;
  readonly endMinute?: number;
  readonly effectiveFrom?: DateOnly;
  readonly effectiveTo?: DateOnly | null;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly subjectId?: string | null;
}

/**
 * Change a slot in place.
 *
 * The group is not changeable: a pattern that moves to another group is a
 * different reservation, and mutating it would rewrite the explanation of every
 * lesson already generated. Close this slot and open a new one instead.
 */
export async function updateScheduleSlot(
  ctx: AccessContext,
  input: UpdateScheduleSlotInput,
  db?: Db,
): Promise<ScheduleSlotSummary> {
  requirePermission(ctx, 'schedule.manage');

  // Serializable, not because money moves, but because the invariant has no
  // database constraint behind it: two administrators booking the same room at
  // the same instant would both read a clear check and both write under READ
  // COMMITTED. Write skew is the exact anomaly, and there is no unique index to
  // catch the loser.
  return withSerializableRetry(
    async (tx) => {
      const existing = await tx.scheduleSlot.findFirst({
        where: { id: input.slotId, ...scopeFilter(ctx) },
        select: SLOT_SELECT,
      });
      if (!existing) throw new NotFoundError('Schedule slot', input.slotId);
      if (!existing.isActive) {
        throw new StateInvalidError('timetable entry', 'no longer in use', 'changed');
      }

      const merged = {
        dayOfWeek: input.dayOfWeek ?? existing.dayOfWeek,
        startMinute: input.startMinute ?? existing.startMinute,
        endMinute: input.endMinute ?? existing.endMinute,
        effectiveFrom: input.effectiveFrom ?? prismaDateToDateOnly(existing.effectiveFrom),
        effectiveTo:
          input.effectiveTo === undefined
            ? existing.effectiveTo
              ? prismaDateToDateOnly(existing.effectiveTo)
              : null
            : input.effectiveTo,
        teacherId: input.teacherId === undefined ? existing.teacherId : input.teacherId,
        roomId: input.roomId === undefined ? existing.roomId : input.roomId,
        subjectId: input.subjectId === undefined ? existing.subjectId : input.subjectId,
      };

      assertMinuteWindow(merged.startMinute, merged.endMinute);
      assertEffectiveRange(merged.effectiveFrom, merged.effectiveTo);

      const resources = await resolveResources(
        ctx,
        {
          groupId: existing.groupId,
          teacherId: merged.teacherId,
          roomId: merged.roomId,
          subjectId: merged.subjectId,
        },
        tx,
      );
      assertGroupSchedulable(resources.group);

      await assertSlotIsFree(ctx, tx, {
        id: existing.id,
        groupId: existing.groupId,
        teacherId: merged.teacherId,
        roomId: merged.roomId,
        dayOfWeek: merged.dayOfWeek,
        startMinute: merged.startMinute,
        endMinute: merged.endMinute,
        effectiveFrom: merged.effectiveFrom,
        effectiveTo: merged.effectiveTo,
        labels: resources.labels,
      });

      const updated = await tx.scheduleSlot.update({
        where: { id: existing.id },
        data: {
          dayOfWeek: merged.dayOfWeek,
          startMinute: merged.startMinute,
          endMinute: merged.endMinute,
          effectiveFrom: dateOnlyToPrismaDate(merged.effectiveFrom),
          effectiveTo: merged.effectiveTo ? dateOnlyToPrismaDate(merged.effectiveTo) : null,
          teacherId: merged.teacherId,
          roomId: merged.roomId,
          subjectId: merged.subjectId,
        },
        select: SLOT_SELECT,
      });

      const before = toSummary(existing);
      const after = toSummary(updated);

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.SCHEDULE_CHANGED,
          entityType: 'ScheduleSlot',
          entityId: after.id,
          branchId: after.branchId,
          summary: `Timetable entry for ${after.groupName} changed to ${after.dayOfWeek.toLowerCase()} ${after.startTime}–${after.endTime}`,
          changes: diffFields(
            {
              dayOfWeek: before.dayOfWeek,
              startMinute: before.startMinute,
              endMinute: before.endMinute,
              effectiveFrom: before.effectiveFrom,
              effectiveTo: before.effectiveTo,
              teacherId: before.teacherId,
              roomId: before.roomId,
              subjectId: before.subjectId,
            },
            {
              dayOfWeek: after.dayOfWeek,
              startMinute: after.startMinute,
              endMinute: after.endMinute,
              effectiveFrom: after.effectiveFrom,
              effectiveTo: after.effectiveTo,
              teacherId: after.teacherId,
              roomId: after.roomId,
              subjectId: after.subjectId,
            },
          ),
          severity: 'NOTICE',
          timeline: {
            subjectType: 'GROUP',
            subjectId: after.groupId,
            type: 'schedule.slot.updated',
            title: `Timetable changed to ${after.dayOfWeek.toLowerCase()} ${after.startTime}–${after.endTime}`,
            description: after.roomName,
          },
        },
        tx,
      );

      return after;
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export interface DeactivateScheduleSlotResult {
  readonly id: string;
  readonly effectiveTo: DateOnly;
  /**
   * Lessons already generated beyond the closing date. They are NOT touched:
   * removing a class a parent has been told about is a decision for a person, so
   * the count is reported and `cancelLesson` remains explicit.
   */
  readonly futureLessonCount: number;
}

export async function deactivateScheduleSlot(
  ctx: AccessContext,
  input: { readonly slotId: string; readonly effectiveTo?: DateOnly; readonly reason?: string | null },
  db?: Db,
): Promise<DeactivateScheduleSlotResult> {
  requirePermission(ctx, 'schedule.manage');

  return withTransaction(
    async (tx) => {
      const existing = await tx.scheduleSlot.findFirst({
        where: { id: input.slotId, ...scopeFilter(ctx) },
        select: SLOT_SELECT,
      });
      if (!existing) throw new NotFoundError('Schedule slot', input.slotId);
      if (!existing.isActive) {
        throw new StateInvalidError('timetable entry', 'already withdrawn', 'withdrawn');
      }

      const settings = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: existing.branchId },
        tx,
      );
      const effectiveTo = input.effectiveTo ?? todayIn(settings.timezone);
      const closing = dateOnlyToPrismaDate(effectiveTo);
      if (closing < existing.effectiveFrom) {
        throw new BusinessRuleError(
          'schedule.close_before_start',
          'A timetable entry cannot be withdrawn before it started.',
        );
      }

      await tx.scheduleSlot.update({
        where: { id: existing.id },
        data: { isActive: false, effectiveTo: closing },
      });

      const futureLessonCount = await tx.lesson.count({
        where: {
          scheduleSlotId: existing.id,
          lessonDate: { gt: closing },
          status: { notIn: [...TIME_FREEING_LESSON_STATUSES] },
        },
      });

      const summary = toSummary(existing);

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.SCHEDULE_CHANGED,
          entityType: 'ScheduleSlot',
          entityId: existing.id,
          branchId: existing.branchId,
          summary: `Timetable entry withdrawn for ${summary.groupName} (${summary.dayOfWeek.toLowerCase()} ${summary.startTime}–${summary.endTime}) from ${effectiveTo}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: { effectiveTo, futureLessonCount },
          timeline: {
            subjectType: 'GROUP',
            subjectId: summary.groupId,
            type: 'schedule.slot.withdrawn',
            title: `Removed from the timetable: ${summary.dayOfWeek.toLowerCase()} ${summary.startTime}–${summary.endTime}`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return { id: existing.id, effectiveTo, futureLessonCount };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListScheduleSlotsFilters {
  readonly branchId?: string | null;
  readonly groupId?: string | null;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly dayOfWeek?: Weekday | null;
  /** Only patterns in force on this calendar day. */
  readonly activeOn?: DateOnly | null;
  readonly includeInactive?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * Build the read predicate shared by the list and the weekly grid.
 *
 * `teacherLessonFilter` is written for `Lesson` but its shape — `teacherId` or an
 * open assignment on the group — applies verbatim to `ScheduleSlot`, which
 * carries both. Reusing it keeps one definition of "the classes that are mine".
 */
function slotReadFilter(
  ctx: AccessContext,
  filters: ListScheduleSlotsFilters,
): Prisma.ScheduleSlotWhereInput {
  const on = filters.activeOn ? dateOnlyToPrismaDate(filters.activeOn) : null;

  return {
    ...(composeReadFilter(ctx, {
      selfFilter: teacherLessonFilter(ctx),
      escapeHatch: 'schedule.viewAll',
    }) as object),
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.groupId ? { groupId: filters.groupId } : {}),
    ...(filters.teacherId ? { teacherId: filters.teacherId } : {}),
    ...(filters.roomId ? { roomId: filters.roomId } : {}),
    ...(filters.dayOfWeek ? { dayOfWeek: filters.dayOfWeek } : {}),
    ...(filters.includeInactive ? {} : { isActive: true }),
    ...(on
      ? {
          effectiveFrom: { lte: on },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
        }
      : {}),
  };
}

export async function listScheduleSlots(
  ctx: AccessContext,
  filters: ListScheduleSlotsFilters = {},
  db: Db = prisma,
): Promise<{ rows: ScheduleSlotSummary[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, 'schedule.view');

  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 50));
  const where = slotReadFilter(ctx, filters);

  const [rows, total] = await Promise.all([
    db.scheduleSlot.findMany({
      where,
      // The enum is declared Monday-first in the schema, so PostgreSQL orders it
      // chronologically without a CASE expression.
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: SLOT_SELECT,
    }),
    db.scheduleSlot.count({ where }),
  ]);

  return { rows: rows.map(toSummary), total, page, pageSize };
}

export interface WeeklyTimetable {
  readonly days: ReadonlyArray<{
    readonly dayOfWeek: Weekday;
    readonly slots: readonly ScheduleSlotSummary[];
  }>;
  /** Earliest / latest minute in use, so the grid knows how many rows to draw. */
  readonly firstMinute: number | null;
  readonly lastMinute: number | null;
  /** True when the week hit the row cap; narrow the filters. */
  readonly truncated: boolean;
}

/** A branch's week of slots is bounded by rooms x hours; this guards the pathological case. */
const WEEKLY_GRID_CAP = 2000;

/**
 * The timetable grid: every weekday present, in the institution's week order,
 * with an empty array where nothing is scheduled so the UI renders a real empty
 * cell rather than collapsing the column.
 */
export async function getWeeklyTimetable(
  ctx: AccessContext,
  filters: Omit<ListScheduleSlotsFilters, 'page' | 'pageSize' | 'dayOfWeek'> = {},
  db: Db = prisma,
): Promise<WeeklyTimetable> {
  requirePermission(ctx, 'schedule.view');

  const settings = await getSettings(
    ['weekStartsOn'],
    { organizationId: ctx.organizationId, branchId: filters.branchId ?? null },
    db,
  );

  const rows = await db.scheduleSlot.findMany({
    where: slotReadFilter(ctx, filters),
    orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    take: WEEKLY_GRID_CAP + 1,
    select: SLOT_SELECT,
  });

  const truncated = rows.length > WEEKLY_GRID_CAP;
  const summaries = (truncated ? rows.slice(0, WEEKLY_GRID_CAP) : rows).map(toSummary);

  const byDay = new Map<Weekday, ScheduleSlotSummary[]>();
  for (const slot of summaries) {
    const list = byDay.get(slot.dayOfWeek);
    if (list) list.push(slot);
    else byDay.set(slot.dayOfWeek, [slot]);
  }

  const startIndex = settings.weekStartsOn === 'SUNDAY' ? WEEK_ORDER.indexOf('SUNDAY') : 0;
  const ordered = [...WEEK_ORDER.slice(startIndex), ...WEEK_ORDER.slice(0, startIndex)];

  return {
    days: ordered.map((dayOfWeek) => ({ dayOfWeek, slots: byDay.get(dayOfWeek) ?? [] })),
    firstMinute: summaries.length > 0 ? Math.min(...summaries.map((s) => s.startMinute)) : null,
    lastMinute: summaries.length > 0 ? Math.max(...summaries.map((s) => s.endMinute)) : null,
    truncated,
  };
}

/**
 * The active patterns generation should materialise, loaded in one query.
 *
 * Exported for ./lessons.ts rather than duplicated there, so "which slots are in
 * force over this range" has a single definition.
 *
 * Unlike the conflict-peer query, this one IS branch-scoped: it decides which
 * rows get written, and a branch-scoped operator must not be able to materialise
 * another branch's timetable by naming its id.
 */
export async function loadGenerableSlots(
  ctx: AccessContext,
  tx: Tx,
  range: { from: DateOnly; to: DateOnly },
  filters: { branchId?: string | null; groupId?: string | null; slotId?: string | null } = {},
): Promise<
  Array<{
    id: string;
    branchId: string;
    groupId: string;
    teacherId: string | null;
    roomId: string | null;
    subjectId: string | null;
    dayOfWeek: Weekday;
    startMinute: number;
    endMinute: number;
    effectiveFrom: DateOnly;
    effectiveTo: DateOnly | null;
    group: { name: string; status: string; startDate: Date | null; endDate: Date | null };
  }>
> {
  if (filters.branchId) assertBranchAccess(ctx, filters.branchId, 'lesson');

  const rows = await tx.scheduleSlot.findMany({
    where: {
      ...scopeFilter(ctx),
      isActive: true,
      ...(filters.slotId ? { id: filters.slotId } : {}),
      ...(filters.branchId ? { branchId: filters.branchId } : {}),
      ...(filters.groupId ? { groupId: filters.groupId } : {}),
      effectiveFrom: { lte: dateOnlyToPrismaDate(range.to) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnlyToPrismaDate(range.from) } }],
      // A finished or cancelled group keeps its history but gains no new lessons.
      group: { deletedAt: null, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
    },
    orderBy: [{ branchId: 'asc' }, { dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    select: {
      id: true,
      branchId: true,
      groupId: true,
      teacherId: true,
      roomId: true,
      subjectId: true,
      dayOfWeek: true,
      startMinute: true,
      endMinute: true,
      effectiveFrom: true,
      effectiveTo: true,
      group: { select: { name: true, status: true, startDate: true, endDate: true } },
    },
  });

  return rows.map((row) => ({
    ...row,
    effectiveFrom: prismaDateToDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? prismaDateToDateOnly(row.effectiveTo) : null,
  }));
}
