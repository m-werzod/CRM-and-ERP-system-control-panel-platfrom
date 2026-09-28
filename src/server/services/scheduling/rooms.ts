/**
 * Classrooms.
 *
 * A room is the third resource the timetable contends for, alongside teachers and
 * groups, which is why it lives with the scheduling services rather than with
 * general settings. Rooms are deactivated, never deleted: a room that hosted last
 * term's lessons must keep existing for those lessons to be readable.
 *
 * `getRoomUtilisation` is deliberately honest about what it does not know. There
 * is no "opening hours" setting in the registry, so the denominator is either
 * supplied by the caller or derived from the branch's own timetable — and when
 * neither is available it is `null`, not a guessed number. A utilisation figure
 * invented from a hard-coded working day would read as fact on a dashboard.
 */

import type { Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  DuplicateError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
// The audit vocabulary has no room-specific key yet, so these use dotted action
// strings in the same house style (see `enrollment.ended` in the students service).
import { diffFields, record as recordAudit } from '@/server/audit';
import {
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { PPM_SCALE } from '@/lib/money';
import { TIME_FREEING_LESSON_STATUSES } from '@/server/services/scheduling/conflicts';

export interface RoomSummary {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly code: string;
  readonly capacity: number;
  readonly floor: string | null;
  readonly notes: string | null;
  readonly isActive: boolean;
}

const ROOM_SELECT = {
  id: true,
  branchId: true,
  name: true,
  code: true,
  capacity: true,
  floor: true,
  notes: true,
  isActive: true,
} satisfies Prisma.RoomSelect;

export interface CreateRoomInput {
  readonly name: string;
  readonly code: string;
  readonly capacity?: number;
  readonly floor?: string | null;
  readonly notes?: string | null;
  readonly branchId?: string | null;
}

export async function createRoom(
  ctx: AccessContext,
  input: CreateRoomInput,
  db?: Db,
): Promise<RoomSummary> {
  requirePermission(ctx, 'settings.manageRooms');

  return withTransaction(
    async (tx) => {
      const branchId = resolveWriteBranch(ctx, input.branchId, 'room');
      const capacity = input.capacity ?? 20;
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new BusinessRuleError('room.capacity_invalid', 'A room must seat at least one person.');
      }

      let room: RoomSummary;
      try {
        room = await tx.room.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            name: input.name.trim(),
            code: input.code.trim().toUpperCase(),
            capacity,
            floor: input.floor?.trim() ?? null,
            notes: input.notes ?? null,
          },
          select: ROOM_SELECT,
        });
      } catch (error) {
        // @@unique([branchId, code]).
        const errorCode = (error as { code?: string }).code;
        if (errorCode === 'P2002' || errorCode === '23505') {
          throw new DuplicateError('room', ['code'], `A room with code ${input.code} already exists in this branch.`);
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'room.created',
          entityType: 'Room',
          entityId: room.id,
          branchId: room.branchId,
          summary: `Room ${room.name} (${room.code}) added, seats ${room.capacity}`,
          metadata: { capacity: room.capacity },
        },
        tx,
      );

      return room;
    },
    { existing: db },
  );
}

export interface UpdateRoomInput {
  readonly roomId: string;
  readonly name?: string;
  readonly code?: string;
  readonly capacity?: number;
  readonly floor?: string | null;
  readonly notes?: string | null;
}

export async function updateRoom(
  ctx: AccessContext,
  input: UpdateRoomInput,
  db?: Db,
): Promise<RoomSummary> {
  requirePermission(ctx, 'settings.manageRooms');

  return withTransaction(
    async (tx) => {
      const existing = await tx.room.findFirst({
        where: { id: input.roomId, ...scopeFilter(ctx), deletedAt: null },
        select: ROOM_SELECT,
      });
      if (!existing) throw new NotFoundError('Room', input.roomId);

      if (input.capacity !== undefined && (!Number.isInteger(input.capacity) || input.capacity < 1)) {
        throw new BusinessRuleError('room.capacity_invalid', 'A room must seat at least one person.');
      }

      const data = {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.code === undefined ? {} : { code: input.code.trim().toUpperCase() }),
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        ...(input.floor === undefined ? {} : { floor: input.floor?.trim() ?? null }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      };

      let updated: RoomSummary;
      try {
        updated = await tx.room.update({
          where: { id: existing.id },
          data,
          select: ROOM_SELECT,
        });
      } catch (error) {
        const errorCode = (error as { code?: string }).code;
        if (errorCode === 'P2002' || errorCode === '23505') {
          throw new DuplicateError('room', ['code']);
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'room.updated',
          entityType: 'Room',
          entityId: updated.id,
          branchId: updated.branchId,
          summary: `Room ${updated.name} updated`,
          changes: diffFields(
            { name: existing.name, code: existing.code, capacity: existing.capacity, floor: existing.floor, notes: existing.notes },
            { name: updated.name, code: updated.code, capacity: updated.capacity, floor: updated.floor, notes: updated.notes },
          ),
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

export interface DeactivateRoomResult {
  readonly id: string;
  readonly isActive: false;
}

/**
 * Take a room out of use.
 *
 * Refused while the timetable still points at it: silently deactivating a room
 * that Monday's class is booked into would leave a class with nowhere to be, and
 * the operator has to decide where those lessons go.
 */
export async function deactivateRoom(
  ctx: AccessContext,
  input: { readonly roomId: string; readonly reason?: string | null },
  db?: Db,
): Promise<DeactivateRoomResult> {
  requirePermission(ctx, 'settings.manageRooms');

  return withTransaction(
    async (tx) => {
      const room = await tx.room.findFirst({
        where: { id: input.roomId, ...scopeFilter(ctx), deletedAt: null },
        select: ROOM_SELECT,
      });
      if (!room) throw new NotFoundError('Room', input.roomId);
      if (!room.isActive) {
        throw new StateInvalidError('room', 'already out of use', 'deactivated');
      }

      const [activeSlots, futureLessons] = await Promise.all([
        tx.scheduleSlot.count({ where: { roomId: room.id, isActive: true } }),
        tx.lesson.count({
          where: {
            roomId: room.id,
            startsAt: { gte: new Date() },
            status: { notIn: [...TIME_FREEING_LESSON_STATUSES] },
          },
        }),
      ]);

      if (activeSlots > 0 || futureLessons > 0) {
        throw new BusinessRuleError(
          'room.still_in_use',
          `${room.name} is still timetabled. Move or withdraw its ${activeSlots} timetable entr${activeSlots === 1 ? 'y' : 'ies'} and ${futureLessons} upcoming lesson(s) first.`,
          { details: { activeSlots, futureLessons } },
        );
      }

      await tx.room.update({ where: { id: room.id }, data: { isActive: false } });

      await recordAudit(
        ctx,
        {
          action: 'room.deactivated',
          entityType: 'Room',
          entityId: room.id,
          branchId: room.branchId,
          summary: `Room ${room.name} taken out of use`,
          reason: input.reason ?? null,
        },
        tx,
      );

      return { id: room.id, isActive: false };
    },
    { existing: db },
  );
}

export interface ListRoomsFilters {
  readonly branchId?: string | null;
  readonly includeInactive?: boolean;
  /** Only rooms seating at least this many. */
  readonly minCapacity?: number | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function listRooms(
  ctx: AccessContext,
  filters: ListRoomsFilters = {},
  db: Db = prisma,
): Promise<{ rows: RoomSummary[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, 'schedule.view');

  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.RoomWhereInput = {
    ...scopeFilter(ctx),
    deletedAt: null,
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.includeInactive ? {} : { isActive: true }),
    ...(filters.minCapacity ? { capacity: { gte: filters.minCapacity } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.room.findMany({
      where,
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ROOM_SELECT,
    }),
    db.room.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

export async function getRoom(
  ctx: AccessContext,
  roomId: string,
  db: Db = prisma,
): Promise<RoomSummary> {
  requirePermission(ctx, 'schedule.view');

  const room = await db.room.findFirst({
    where: { id: roomId, ...scopeFilter(ctx), deletedAt: null },
    select: ROOM_SELECT,
  });
  if (!room) throw new NotFoundError('Room', roomId);
  return room;
}

// ---------------------------------------------------------------------------
// Utilisation
// ---------------------------------------------------------------------------

export interface RoomUtilisationRow {
  readonly roomId: string;
  readonly name: string;
  readonly code: string;
  readonly branchId: string;
  readonly capacity: number;
  /** Timetabled minutes in a normal week, from the active recurring pattern. */
  readonly scheduledMinutesPerWeek: number;
  readonly slotCount: number;
  /** Null when no teaching window is known; see the module comment. */
  readonly availableMinutesPerWeek: number | null;
  /** Integer parts-per-million of the available window, or null. */
  readonly utilisationPpm: number | null;
}

export interface RoomUtilisation {
  readonly rows: readonly RoomUtilisationRow[];
  readonly availableMinutesPerWeek: number | null;
  /** Where the denominator came from, so a dashboard can label the figure. */
  readonly basis: 'explicit' | 'observedTimetable' | 'unknown';
  readonly workingDays: number;
  readonly openMinutesPerDay: number | null;
}

/**
 * Timetabled minutes per room per week, against the available window.
 *
 * The sum is done in SQL: `endMinute - startMinute` is not something Prisma's
 * aggregate can express, and pulling every slot back to add them up in JS would
 * grow with the size of the timetable.
 */
export async function getRoomUtilisation(
  ctx: AccessContext,
  input: {
    readonly branchId?: string | null;
    readonly roomId?: string | null;
    /** The teaching day in minutes, when the institution knows it. */
    readonly openMinutesPerDay?: number | null;
  } = {},
  db: Db = prisma,
): Promise<RoomUtilisation> {
  requirePermission(ctx, 'schedule.view');

  const settings = await getSettings(
    ['workingDays'],
    { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
    db,
  );
  const workingDays = settings.workingDays.length;

  // Branch scope comes from ctx, never from input, so a caller cannot widen it.
  const branchIds = ctx.scope === 'ORGANIZATION' ? null : [...ctx.branchIds];
  const requestedBranch = input.branchId ?? null;
  const requestedRoom = input.roomId ?? null;

  const rows = await db.$queryRaw<
    Array<{
      roomId: string;
      name: string;
      code: string;
      branchId: string;
      capacity: number;
      scheduledMinutes: bigint | null;
      slotCount: bigint;
      earliestMinute: number | null;
      latestMinute: number | null;
    }>
  >`
    select
      r."id"                                                      as "roomId",
      r."name"                                                    as "name",
      r."code"                                                    as "code",
      r."branchId"                                                as "branchId",
      r."capacity"                                                as "capacity",
      coalesce(sum(s."endMinute" - s."startMinute"), 0)            as "scheduledMinutes",
      count(s."id")                                               as "slotCount",
      min(s."startMinute")                                        as "earliestMinute",
      max(s."endMinute")                                          as "latestMinute"
    from "rooms" r
    left join "schedule_slots" s
      on s."roomId" = r."id"
     and s."isActive" = true
     and s."organizationId" = r."organizationId"
    where r."organizationId" = ${ctx.organizationId}
      and r."deletedAt" is null
      and r."isActive" = true
      and (${branchIds}::text[] is null or r."branchId" = any(${branchIds}::text[]))
      and (${requestedBranch}::text is null or r."branchId" = ${requestedBranch})
      and (${requestedRoom}::text is null or r."id" = ${requestedRoom})
    group by r."id", r."name", r."code", r."branchId", r."capacity"
    order by r."branchId" asc, r."name" asc
  `;

  // The observed window is the span the branch actually teaches in, which is a
  // real figure rather than an assumed 09:00-18:00. It is only meaningful when
  // something is scheduled at all.
  const observedStart = rows
    .map((row) => row.earliestMinute)
    .filter((value): value is number => value !== null);
  const observedEnd = rows
    .map((row) => row.latestMinute)
    .filter((value): value is number => value !== null);

  let openMinutesPerDay: number | null = null;
  let basis: RoomUtilisation['basis'] = 'unknown';
  if (input.openMinutesPerDay && input.openMinutesPerDay > 0) {
    openMinutesPerDay = input.openMinutesPerDay;
    basis = 'explicit';
  } else if (observedStart.length > 0 && observedEnd.length > 0) {
    const span = Math.max(...observedEnd) - Math.min(...observedStart);
    if (span > 0) {
      openMinutesPerDay = span;
      basis = 'observedTimetable';
    }
  }

  const availableMinutesPerWeek =
    openMinutesPerDay === null || workingDays === 0 ? null : openMinutesPerDay * workingDays;

  return {
    rows: rows.map((row) => {
      const scheduledMinutesPerWeek = Number(row.scheduledMinutes ?? 0n);
      return {
        roomId: row.roomId,
        name: row.name,
        code: row.code,
        branchId: row.branchId,
        capacity: row.capacity,
        scheduledMinutesPerWeek,
        slotCount: Number(row.slotCount),
        availableMinutesPerWeek,
        // Parts-per-million, matching the platform's percentage convention, and
        // exact: no floating-point percentage is stored or compared.
        utilisationPpm:
          availableMinutesPerWeek && availableMinutesPerWeek > 0
            ? Number(
                (BigInt(scheduledMinutesPerWeek) * PPM_SCALE) / BigInt(availableMinutesPerWeek),
              )
            : null,
      };
    }),
    availableMinutesPerWeek,
    basis,
    workingDays,
    openMinutesPerDay,
  };
}
