/**
 * Timetable conflict detection — the pure core of the scheduling module.
 *
 * Three rules, and all three must hold at BOTH levels of the model:
 *
 *   * a teacher cannot be in two overlapping lessons
 *   * a room cannot host two overlapping lessons
 *   * a group cannot sit in two overlapping lessons
 *
 * The two levels are `ScheduleSlot` (the recurring weekly pattern) and `Lesson`
 * (the dated instance). Checking only the pattern would be wrong, because an
 * ad-hoc lesson never goes through a pattern; checking only the instance would be
 * wrong, because a slot is a standing reservation whose lessons may not be
 * materialised yet. So both checkers live here, share one decision function, and
 * every write path in this module runs the relevant one.
 *
 * Everything in this file is PURE. The database round trip belongs to the
 * caller — which is what makes these rules testable without a database, and what
 * stops a second, subtly different overlap test appearing next to a query. Slot
 * comparison works on `DateOnly` strings and wall-clock minutes rather than
 * `Date`s, because a recurring pattern has no instant and introducing one would
 * drag a timezone into a question that does not involve one.
 *
 * OVERLAP IS HALF-OPEN. 09:00–10:30 and 10:30–12:00 are back-to-back, not a
 * clash: the strict comparison in `minuteRangesOverlap` / `intervalsOverlap` is
 * the whole reason those helpers exist rather than an inline `<=`.
 */

import type { LessonStatus, Weekday } from '@/generated/prisma/client';
import type { ScheduleConflict } from '@/server/errors';
import {
  formatWallClock,
  intervalsOverlap,
  minuteRangesOverlap,
  toIso,
  type DateOnly,
  type WallClockMinute,
} from '@/lib/dates';

/**
 * Display names for the candidate's own teacher, room and group.
 *
 * `ScheduleConflict.label` names the resource that is DOUBLE-BOOKED — never the
 * other booking's group or teacher. That is deliberate: a teacher may be shared
 * between branches, so a conflict check has to look across the whole
 * organisation, and reporting the other side's details would leak a branch the
 * caller cannot see. Naming only what the caller themselves selected keeps the
 * message actionable without leaking anything. It also keeps `label` a proper
 * noun, so the UI can localise the sentence around it instead of receiving
 * English prose from the server.
 */
export interface ResourceLabels {
  readonly group?: string | null;
  readonly teacher?: string | null;
  readonly room?: string | null;
}

/** The resources a booking occupies, at either level. */
interface ResourceHolder {
  readonly groupId: string;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
}

export interface SlotCandidate extends ResourceHolder {
  /** Set when updating an existing slot, so it does not clash with itself. */
  readonly id?: string | null;
  readonly dayOfWeek: Weekday;
  readonly startMinute: WallClockMinute;
  readonly endMinute: WallClockMinute;
  readonly effectiveFrom: DateOnly;
  /** Inclusive last day the pattern runs; `null` means open-ended. */
  readonly effectiveTo?: DateOnly | null;
  readonly labels?: ResourceLabels;
}

export interface ExistingSlot extends ResourceHolder {
  readonly id: string;
  readonly teacherId: string | null;
  readonly roomId: string | null;
  readonly dayOfWeek: Weekday;
  readonly startMinute: WallClockMinute;
  readonly endMinute: WallClockMinute;
  readonly effectiveFrom: DateOnly;
  readonly effectiveTo: DateOnly | null;
}

export interface LessonCandidate extends ResourceHolder {
  /** Set when rescheduling, so the lesson does not clash with itself. */
  readonly id?: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly labels?: ResourceLabels;
}

export interface ExistingLesson extends ResourceHolder {
  readonly id: string;
  readonly teacherId: string | null;
  readonly roomId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Absent is treated as occupying time; see `TIME_FREEING_LESSON_STATUSES`. */
  readonly status?: LessonStatus;
}

/**
 * Statuses under which a lesson stops holding its teacher, room and group.
 *
 * A cancelled lesson remains a record — it is never deleted — but it releases
 * the room, otherwise a cancelled class would block the replacement forever.
 * Exported so the SQL that narrows the peer query and the pure check below
 * cannot drift apart.
 */
export const TIME_FREEING_LESSON_STATUSES: readonly LessonStatus[] = ['CANCELLED', 'RESCHEDULED'];

function occupiesTime(status: LessonStatus | undefined): boolean {
  return status === undefined || !TIME_FREEING_LESSON_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// The shared decision
// ---------------------------------------------------------------------------

/**
 * Append one conflict per resource the two bookings share, given that their
 * times have already been found to overlap.
 *
 * A `null` teacher or room is never a conflict: it means "not assigned yet", and
 * two unstaffed slots in the same hour are a planning state, not a clash. Group
 * is unconditional because `groupId` is required on both models.
 */
function collectSharedResources(
  out: ScheduleConflict[],
  candidate: ResourceHolder & { labels?: ResourceLabels },
  existing: ResourceHolder,
  conflictingId: string,
  window: { startsAt: string; endsAt: string },
): void {
  if (candidate.teacherId && existing.teacherId === candidate.teacherId) {
    out.push({
      kind: 'TEACHER',
      conflictingId,
      // Falling back to the id keeps `label` non-empty and honest when the
      // caller had no display name to hand; it is never invented prose.
      label: candidate.labels?.teacher ?? candidate.teacherId,
      ...window,
    });
  }
  if (candidate.roomId && existing.roomId === candidate.roomId) {
    out.push({
      kind: 'ROOM',
      conflictingId,
      label: candidate.labels?.room ?? candidate.roomId,
      ...window,
    });
  }
  if (existing.groupId === candidate.groupId) {
    out.push({
      kind: 'GROUP',
      conflictingId,
      label: candidate.labels?.group ?? candidate.groupId,
      ...window,
    });
  }
}

/**
 * Do two recurring patterns' effective ranges intersect?
 *
 * `YYYY-MM-DD` sorts lexicographically in chronological order, so string
 * comparison is exact here and keeps instants and timezones out of a question
 * that does not involve them. `effectiveTo` is the last day the pattern runs,
 * hence the inclusive comparison: a slot ending 31 March and one starting
 * 1 April never coexist.
 */
function effectiveRangesIntersect(
  a: { effectiveFrom: DateOnly; effectiveTo?: DateOnly | null },
  b: { effectiveFrom: DateOnly; effectiveTo?: DateOnly | null },
): boolean {
  if (a.effectiveTo && a.effectiveTo < b.effectiveFrom) return false;
  if (b.effectiveTo && b.effectiveTo < a.effectiveFrom) return false;
  return true;
}

/**
 * `formatWallClock` wraps at midnight, which would render a slot ending at
 * 24:00 as "00:00" and read as an empty window.
 */
function wallClockLabel(minute: WallClockMinute): string {
  return minute === 1440 ? '24:00' : formatWallClock(minute);
}

// ---------------------------------------------------------------------------
// Pattern level: ScheduleSlot
// ---------------------------------------------------------------------------

/**
 * Conflicts between a candidate weekly pattern and its existing peers.
 *
 * `startsAt` / `endsAt` on the returned conflicts are wall-clock `HH:MM` in the
 * branch timezone, not instants: a pattern has no instant, and inventing one for
 * an error message would be a lie the UI then has to format.
 *
 * The caller is expected to have loaded only ACTIVE peers; activity is a query
 * concern, whereas the overlap rules are the domain rule this function owns.
 */
export function findSlotConflicts(
  candidate: SlotCandidate,
  existingSlots: readonly ExistingSlot[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];

  for (const existing of existingSlots) {
    if (candidate.id && existing.id === candidate.id) continue;
    if (existing.dayOfWeek !== candidate.dayOfWeek) continue;
    if (
      !minuteRangesOverlap(
        candidate.startMinute,
        candidate.endMinute,
        existing.startMinute,
        existing.endMinute,
      )
    ) {
      continue;
    }
    if (!effectiveRangesIntersect(candidate, existing)) continue;

    collectSharedResources(conflicts, candidate, existing, existing.id, {
      startsAt: wallClockLabel(existing.startMinute),
      endsAt: wallClockLabel(existing.endMinute),
    });
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Instance level: Lesson
// ---------------------------------------------------------------------------

/**
 * Conflicts between a candidate lesson and existing lessons.
 *
 * `startsAt` / `endsAt` on the returned conflicts are ISO-8601 UTC instants, the
 * only instant format that crosses the wire.
 */
export function findLessonConflicts(
  candidate: LessonCandidate,
  existingLessons: readonly ExistingLesson[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];

  for (const existing of existingLessons) {
    if (candidate.id && existing.id === candidate.id) continue;
    if (!occupiesTime(existing.status)) continue;
    if (
      !intervalsOverlap(candidate.startsAt, candidate.endsAt, existing.startsAt, existing.endsAt)
    ) {
      continue;
    }

    collectSharedResources(conflicts, candidate, existing, existing.id, {
      startsAt: toIso(existing.startsAt),
      endsAt: toIso(existing.endsAt),
    });
  }

  return conflicts;
}

/**
 * Existing lessons bucketed by the resources they occupy.
 *
 * Bulk generation compares thousands of candidate lessons against thousands of
 * existing ones; comparing every pair is quadratic in the size of the term. The
 * index is a pre-filter only — it decides nothing, it just narrows the rows
 * `findLessonConflicts` is asked about, so there remains exactly one place where
 * a clash is decided.
 */
export interface LessonConflictIndex {
  readonly byTeacher: Map<string, ExistingLesson[]>;
  readonly byRoom: Map<string, ExistingLesson[]>;
  readonly byGroup: Map<string, ExistingLesson[]>;
}

function pushIntoBucket(
  bucket: Map<string, ExistingLesson[]>,
  key: string,
  lesson: ExistingLesson,
): void {
  const list = bucket.get(key);
  if (list) list.push(lesson);
  else bucket.set(key, [lesson]);
}

export function indexLessonsForConflicts(
  lessons: readonly ExistingLesson[],
): LessonConflictIndex {
  const index: LessonConflictIndex = {
    byTeacher: new Map(),
    byRoom: new Map(),
    byGroup: new Map(),
  };
  for (const lesson of lessons) addToLessonConflictIndex(index, lesson);
  return index;
}

/**
 * Add one lesson to an existing index.
 *
 * Bulk generation needs this: a lesson it has just decided to create occupies its
 * teacher, room and group for the rest of the run, so two patterns that wrongly
 * share a room cannot both be materialised in one pass.
 */
export function addToLessonConflictIndex(
  index: LessonConflictIndex,
  lesson: ExistingLesson,
): void {
  // Cancelled lessons are dropped once, here, rather than on every lookup.
  if (!occupiesTime(lesson.status)) return;
  if (lesson.teacherId) pushIntoBucket(index.byTeacher, lesson.teacherId, lesson);
  if (lesson.roomId) pushIntoBucket(index.byRoom, lesson.roomId, lesson);
  pushIntoBucket(index.byGroup, lesson.groupId, lesson);
}

export function findLessonConflictsInIndex(
  candidate: LessonCandidate,
  index: LessonConflictIndex,
): ScheduleConflict[] {
  // A lesson sharing two resources with the candidate must be considered once,
  // not twice: `collectSharedResources` already reports one conflict per shared
  // resource, so de-duplicating by id here keeps the output identical to the
  // unindexed checker.
  const relevant = new Map<string, ExistingLesson>();
  for (const lesson of candidate.teacherId ? index.byTeacher.get(candidate.teacherId) ?? [] : []) {
    relevant.set(lesson.id, lesson);
  }
  for (const lesson of candidate.roomId ? index.byRoom.get(candidate.roomId) ?? [] : []) {
    relevant.set(lesson.id, lesson);
  }
  for (const lesson of index.byGroup.get(candidate.groupId) ?? []) {
    relevant.set(lesson.id, lesson);
  }

  return findLessonConflicts(candidate, [...relevant.values()]);
}

/**
 * Turn a concrete lesson into the pattern-shaped candidate needed to check it
 * against standing `ScheduleSlot` reservations.
 *
 * An ad-hoc lesson must not drop into an hour a slot has reserved but not yet
 * materialised, so its single date is expressed as a one-day effective range on
 * that weekday.
 */
export function lessonAsSlotCandidate(input: {
  readonly groupId: string;
  readonly teacherId?: string | null;
  readonly roomId?: string | null;
  readonly dayOfWeek: Weekday;
  readonly startMinute: WallClockMinute;
  readonly endMinute: WallClockMinute;
  readonly onDate: DateOnly;
  readonly labels?: ResourceLabels;
}): SlotCandidate {
  return {
    groupId: input.groupId,
    teacherId: input.teacherId ?? null,
    roomId: input.roomId ?? null,
    dayOfWeek: input.dayOfWeek,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    effectiveFrom: input.onDate,
    effectiveTo: input.onDate,
    labels: input.labels,
  };
}
