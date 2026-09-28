import { describe, expect, it } from 'vitest';
import {
  addToLessonConflictIndex,
  findLessonConflicts,
  findLessonConflictsInIndex,
  findSlotConflicts,
  indexLessonsForConflicts,
  lessonAsSlotCandidate,
  type ExistingLesson,
  type ExistingSlot,
  type LessonCandidate,
  type SlotCandidate,
} from '@/server/services/scheduling/conflicts';

/**
 * These are the rules a timetable is judged by, so they are pinned down here
 * rather than inferred from an integration test: a teacher in two rooms at once,
 * a room hosting two classes, or a group sitting in two lessons are all mistakes
 * nobody notices until a parent complains.
 *
 * The overlap boundary gets the most attention. Back-to-back lessons are the
 * normal case in a language school — 09:00–10:30 then 10:30–12:00 — and an
 * inclusive comparison would reject the entire timetable.
 */

// 540 == 09:00, 630 == 10:30, 720 == 12:00.
const NINE = 540;
const TEN_THIRTY = 630;
const TWELVE = 720;

/** Shares nothing with `candidate()` by default, so resource checks are explicit. */
const existingSlot = (overrides: Partial<ExistingSlot> = {}): ExistingSlot => ({
  id: 'slot-existing',
  groupId: 'group-a',
  teacherId: 'teacher-1',
  roomId: 'room-1',
  dayOfWeek: 'MONDAY',
  startMinute: NINE,
  endMinute: TEN_THIRTY,
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  ...overrides,
});

const candidateSlot = (overrides: Partial<SlotCandidate> = {}): SlotCandidate => ({
  groupId: 'group-b',
  teacherId: 'teacher-2',
  roomId: 'room-2',
  dayOfWeek: 'MONDAY',
  startMinute: NINE,
  endMinute: TEN_THIRTY,
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  labels: { group: 'Group B', teacher: 'Aziza Karimova', room: 'Room 201' },
  ...overrides,
});

const kinds = (conflicts: ReadonlyArray<{ kind: string }>): string[] =>
  conflicts.map((conflict) => conflict.kind);

describe('findSlotConflicts — overlap boundary', () => {
  it('reports nothing when the two slots share no resource', () => {
    // Same weekday, identical times, different teacher / room / group.
    expect(findSlotConflicts(candidateSlot(), [existingSlot()])).toEqual([]);
  });

  it('treats back-to-back slots as free', () => {
    const after = candidateSlot({ teacherId: 'teacher-1', startMinute: TEN_THIRTY, endMinute: TWELVE });
    expect(findSlotConflicts(after, [existingSlot()])).toEqual([]);

    const before = candidateSlot({ teacherId: 'teacher-1', startMinute: 450, endMinute: NINE });
    expect(findSlotConflicts(before, [existingSlot()])).toEqual([]);
  });

  it('reports an overlap that clips the end of an existing slot', () => {
    const overlapping = candidateSlot({ teacherId: 'teacher-1', startMinute: 600, endMinute: TWELVE });
    expect(kinds(findSlotConflicts(overlapping, [existingSlot()]))).toEqual(['TEACHER']);
  });

  it('reports an overlap that clips the start of an existing slot', () => {
    const overlapping = candidateSlot({ teacherId: 'teacher-1', startMinute: 480, endMinute: 560 });
    expect(kinds(findSlotConflicts(overlapping, [existingSlot()]))).toEqual(['TEACHER']);
  });

  it('reports identical times as a conflict', () => {
    const same = candidateSlot({ roomId: 'room-1' });
    expect(kinds(findSlotConflicts(same, [existingSlot()]))).toEqual(['ROOM']);
  });

  it('reports a slot contained inside an existing one', () => {
    const inside = candidateSlot({ roomId: 'room-1', startMinute: 560, endMinute: 600 });
    expect(kinds(findSlotConflicts(inside, [existingSlot()]))).toEqual(['ROOM']);
  });

  it('reports a slot that swallows an existing one', () => {
    const around = candidateSlot({ roomId: 'room-1', startMinute: 480, endMinute: TWELVE });
    expect(kinds(findSlotConflicts(around, [existingSlot()]))).toEqual(['ROOM']);
  });

  it('ignores a slot on another weekday', () => {
    const tuesday = candidateSlot({
      dayOfWeek: 'TUESDAY',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      groupId: 'group-a',
    });
    expect(findSlotConflicts(tuesday, [existingSlot()])).toEqual([]);
  });
});

describe('findSlotConflicts — effective ranges', () => {
  it('ignores a pattern whose effective range has already closed', () => {
    const lastTerm = existingSlot({ effectiveFrom: '2026-01-12', effectiveTo: '2026-05-29' });
    const nextTerm = candidateSlot({
      teacherId: 'teacher-1',
      roomId: 'room-1',
      groupId: 'group-a',
      effectiveFrom: '2026-09-01',
    });
    expect(findSlotConflicts(nextTerm, [lastTerm])).toEqual([]);
  });

  it('ignores a pattern that starts after the candidate has finished', () => {
    const later = existingSlot({ effectiveFrom: '2027-01-11', effectiveTo: null });
    const ending = candidateSlot({
      teacherId: 'teacher-1',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2026-12-25',
    });
    expect(findSlotConflicts(ending, [later])).toEqual([]);
  });

  it('treats effectiveTo as the last day the pattern runs', () => {
    // Ranges that touch on a single day DO coexist on that day.
    const ending = existingSlot({ effectiveFrom: '2026-01-12', effectiveTo: '2026-05-29' });
    const starting = candidateSlot({ teacherId: 'teacher-1', effectiveFrom: '2026-05-29' });
    expect(kinds(findSlotConflicts(starting, [ending]))).toEqual(['TEACHER']);
  });

  it('conflicts when both patterns are open-ended', () => {
    const forever = existingSlot({ effectiveTo: null });
    const alsoForever = candidateSlot({ roomId: 'room-1', effectiveFrom: '2030-01-01', effectiveTo: null });
    expect(kinds(findSlotConflicts(alsoForever, [forever]))).toEqual(['ROOM']);
  });
});

describe('findSlotConflicts — unassigned resources', () => {
  it('never treats two unstaffed, unroomed slots as a clash', () => {
    const unassigned = existingSlot({ teacherId: null, roomId: null });
    const alsoUnassigned = candidateSlot({ teacherId: null, roomId: null });
    expect(findSlotConflicts(alsoUnassigned, [unassigned])).toEqual([]);
  });

  it('does not report a teacher conflict when the candidate has no teacher', () => {
    const noTeacher = candidateSlot({ teacherId: null, roomId: 'room-1' });
    expect(kinds(findSlotConflicts(noTeacher, [existingSlot()]))).toEqual(['ROOM']);
  });

  it('does not report a room conflict when the existing slot has no room', () => {
    const roomless = existingSlot({ roomId: null });
    const withRoom = candidateSlot({ teacherId: 'teacher-1', roomId: 'room-1' });
    expect(kinds(findSlotConflicts(withRoom, [roomless]))).toEqual(['TEACHER']);
  });
});

describe('findSlotConflicts — what is reported', () => {
  it('reports each of the three kinds with the resource that is double-booked', () => {
    const clashing = candidateSlot({ groupId: 'group-a', teacherId: 'teacher-1', roomId: 'room-1' });
    const conflicts = findSlotConflicts(clashing, [existingSlot()]);

    expect(conflicts).toEqual([
      {
        kind: 'TEACHER',
        conflictingId: 'slot-existing',
        label: 'Aziza Karimova',
        startsAt: '09:00',
        endsAt: '10:30',
      },
      {
        kind: 'ROOM',
        conflictingId: 'slot-existing',
        label: 'Room 201',
        startsAt: '09:00',
        endsAt: '10:30',
      },
      {
        kind: 'GROUP',
        conflictingId: 'slot-existing',
        label: 'Group B',
        startsAt: '09:00',
        endsAt: '10:30',
      },
    ]);
  });

  it('reports the window of the booking that is already there', () => {
    const existing = existingSlot({ startMinute: TEN_THIRTY, endMinute: TWELVE });
    const clashing = candidateSlot({ roomId: 'room-1', startMinute: 600, endMinute: 660 });
    const [conflict] = findSlotConflicts(clashing, [existing]);

    expect(conflict?.startsAt).toBe('10:30');
    expect(conflict?.endsAt).toBe('12:00');
  });

  it('renders a window ending at midnight as 24:00 rather than 00:00', () => {
    const lateClass = existingSlot({ startMinute: 1380, endMinute: 1440 });
    const clashing = candidateSlot({ roomId: 'room-1', startMinute: 1400, endMinute: 1430 });
    const [conflict] = findSlotConflicts(clashing, [lateClass]);

    expect(conflict?.endsAt).toBe('24:00');
  });

  it('falls back to the resource id when no display name was supplied', () => {
    const clashing = candidateSlot({ teacherId: 'teacher-1', labels: undefined });
    const [conflict] = findSlotConflicts(clashing, [existingSlot()]);

    expect(conflict?.label).toBe('teacher-1');
  });

  it('reports one conflict per clashing peer', () => {
    const clashing = candidateSlot({ roomId: 'room-1' });
    const conflicts = findSlotConflicts(clashing, [
      existingSlot({ id: 'slot-1' }),
      existingSlot({ id: 'slot-2', startMinute: 600, endMinute: TWELVE }),
    ]);

    expect(conflicts.map((conflict) => conflict.conflictingId)).toEqual(['slot-1', 'slot-2']);
  });

  it('does not let a slot being edited conflict with itself', () => {
    const editing = candidateSlot({
      id: 'slot-existing',
      groupId: 'group-a',
      teacherId: 'teacher-1',
      roomId: 'room-1',
    });
    expect(findSlotConflicts(editing, [existingSlot()])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instance level
// ---------------------------------------------------------------------------

const at = (iso: string): Date => new Date(iso);

const existingLesson = (overrides: Partial<ExistingLesson> = {}): ExistingLesson => ({
  id: 'lesson-existing',
  groupId: 'group-a',
  teacherId: 'teacher-1',
  roomId: 'room-1',
  startsAt: at('2026-09-07T04:00:00.000Z'),
  endsAt: at('2026-09-07T05:30:00.000Z'),
  ...overrides,
});

const candidateLesson = (overrides: Partial<LessonCandidate> = {}): LessonCandidate => ({
  groupId: 'group-b',
  teacherId: 'teacher-2',
  roomId: 'room-2',
  startsAt: at('2026-09-07T04:00:00.000Z'),
  endsAt: at('2026-09-07T05:30:00.000Z'),
  labels: { group: 'Group B', teacher: 'Aziza Karimova', room: 'Room 201' },
  ...overrides,
});

describe('findLessonConflicts', () => {
  it('reports nothing when the lessons share no resource', () => {
    expect(findLessonConflicts(candidateLesson(), [existingLesson()])).toEqual([]);
  });

  it('treats back-to-back lessons as free', () => {
    const after = candidateLesson({
      teacherId: 'teacher-1',
      startsAt: at('2026-09-07T05:30:00.000Z'),
      endsAt: at('2026-09-07T07:00:00.000Z'),
    });
    expect(findLessonConflicts(after, [existingLesson()])).toEqual([]);
  });

  it('reports a partial overlap at either edge', () => {
    const clipsEnd = candidateLesson({
      roomId: 'room-1',
      startsAt: at('2026-09-07T05:00:00.000Z'),
      endsAt: at('2026-09-07T06:00:00.000Z'),
    });
    expect(kinds(findLessonConflicts(clipsEnd, [existingLesson()]))).toEqual(['ROOM']);

    const clipsStart = candidateLesson({
      roomId: 'room-1',
      startsAt: at('2026-09-07T03:30:00.000Z'),
      endsAt: at('2026-09-07T04:30:00.000Z'),
    });
    expect(kinds(findLessonConflicts(clipsStart, [existingLesson()]))).toEqual(['ROOM']);
  });

  it('reports identical times and containment', () => {
    const identical = candidateLesson({ teacherId: 'teacher-1' });
    expect(kinds(findLessonConflicts(identical, [existingLesson()]))).toEqual(['TEACHER']);

    const inside = candidateLesson({
      teacherId: 'teacher-1',
      startsAt: at('2026-09-07T04:30:00.000Z'),
      endsAt: at('2026-09-07T05:00:00.000Z'),
    });
    expect(kinds(findLessonConflicts(inside, [existingLesson()]))).toEqual(['TEACHER']);
  });

  it('ignores a lesson on another day', () => {
    const nextDay = candidateLesson({
      groupId: 'group-a',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      startsAt: at('2026-09-08T04:00:00.000Z'),
      endsAt: at('2026-09-08T05:30:00.000Z'),
    });
    expect(findLessonConflicts(nextDay, [existingLesson()])).toEqual([]);
  });

  it('never treats an unstaffed, unroomed lesson as a clash', () => {
    const unassigned = existingLesson({ teacherId: null, roomId: null });
    const alsoUnassigned = candidateLesson({ teacherId: null, roomId: null });
    expect(findLessonConflicts(alsoUnassigned, [unassigned])).toEqual([]);
  });

  it('frees the room when the existing lesson was cancelled or moved away', () => {
    const clashing = candidateLesson({ groupId: 'group-a', teacherId: 'teacher-1', roomId: 'room-1' });

    expect(findLessonConflicts(clashing, [existingLesson({ status: 'CANCELLED' })])).toEqual([]);
    expect(findLessonConflicts(clashing, [existingLesson({ status: 'RESCHEDULED' })])).toEqual([]);
    expect(findLessonConflicts(clashing, [existingLesson({ status: 'SCHEDULED' })]).length).toBe(3);
  });

  it('reports each kind with the double-booked resource and an ISO window', () => {
    const clashing = candidateLesson({ groupId: 'group-a', teacherId: 'teacher-1', roomId: 'room-1' });

    expect(findLessonConflicts(clashing, [existingLesson()])).toEqual([
      {
        kind: 'TEACHER',
        conflictingId: 'lesson-existing',
        label: 'Aziza Karimova',
        startsAt: '2026-09-07T04:00:00.000Z',
        endsAt: '2026-09-07T05:30:00.000Z',
      },
      {
        kind: 'ROOM',
        conflictingId: 'lesson-existing',
        label: 'Room 201',
        startsAt: '2026-09-07T04:00:00.000Z',
        endsAt: '2026-09-07T05:30:00.000Z',
      },
      {
        kind: 'GROUP',
        conflictingId: 'lesson-existing',
        label: 'Group B',
        startsAt: '2026-09-07T04:00:00.000Z',
        endsAt: '2026-09-07T05:30:00.000Z',
      },
    ]);
  });

  it('does not let a lesson being rescheduled conflict with itself', () => {
    const moving = candidateLesson({
      id: 'lesson-existing',
      groupId: 'group-a',
      teacherId: 'teacher-1',
      roomId: 'room-1',
    });
    expect(findLessonConflicts(moving, [existingLesson()])).toEqual([]);
  });
});

describe('the lesson conflict index', () => {
  const lessons: ExistingLesson[] = [
    existingLesson({ id: 'l1' }),
    existingLesson({ id: 'l2', groupId: 'group-c', teacherId: 'teacher-3', roomId: 'room-3' }),
    existingLesson({ id: 'l3', status: 'CANCELLED' }),
  ];

  it('agrees with the unindexed checker', () => {
    const clashing = candidateLesson({ groupId: 'group-a', teacherId: 'teacher-1', roomId: 'room-1' });

    expect(findLessonConflictsInIndex(clashing, indexLessonsForConflicts(lessons))).toEqual(
      findLessonConflicts(clashing, lessons),
    );
  });

  it('does not double-report a lesson that shares two resources', () => {
    const clashing = candidateLesson({ teacherId: 'teacher-1', roomId: 'room-1' });
    const conflicts = findLessonConflictsInIndex(clashing, indexLessonsForConflicts(lessons));

    expect(kinds(conflicts)).toEqual(['TEACHER', 'ROOM']);
  });

  it('lets a lesson added mid-run block a later candidate', () => {
    const index = indexLessonsForConflicts([]);
    const pending = candidateLesson({ roomId: 'room-9' });
    expect(findLessonConflictsInIndex(pending, index)).toEqual([]);

    addToLessonConflictIndex(index, {
      id: 'pending-1',
      groupId: 'group-z',
      teacherId: null,
      roomId: 'room-9',
      startsAt: pending.startsAt,
      endsAt: pending.endsAt,
    });

    expect(kinds(findLessonConflictsInIndex(pending, index))).toEqual(['ROOM']);
  });

  it('never indexes a cancelled lesson', () => {
    const index = indexLessonsForConflicts([existingLesson({ id: 'gone', status: 'CANCELLED' })]);
    expect(index.byRoom.size).toBe(0);
    expect(index.byGroup.size).toBe(0);
  });
});

describe('lessonAsSlotCandidate', () => {
  it('expresses a single date as a one-day effective range on that weekday', () => {
    const candidate = lessonAsSlotCandidate({
      groupId: 'group-a',
      teacherId: 'teacher-1',
      roomId: null,
      dayOfWeek: 'SATURDAY',
      startMinute: NINE,
      endMinute: TEN_THIRTY,
      onDate: '2026-09-12',
    });

    expect(candidate.effectiveFrom).toBe('2026-09-12');
    expect(candidate.effectiveTo).toBe('2026-09-12');
    expect(candidate.dayOfWeek).toBe('SATURDAY');
    expect(candidate.roomId).toBeNull();
  });

  it('clashes with a standing pattern that covers the date, and not with one that does not', () => {
    const adHoc = lessonAsSlotCandidate({
      groupId: 'group-a',
      teacherId: 'teacher-1',
      roomId: 'room-1',
      dayOfWeek: 'SATURDAY',
      startMinute: NINE,
      endMinute: TEN_THIRTY,
      onDate: '2026-09-12',
      labels: { room: 'Room 201' },
    });

    const covering = existingSlot({ dayOfWeek: 'SATURDAY', effectiveFrom: '2026-09-01', effectiveTo: '2026-12-25' });
    expect(kinds(findSlotConflicts(adHoc, [covering]))).toEqual(['TEACHER', 'ROOM', 'GROUP']);

    const notYetInForce = existingSlot({ dayOfWeek: 'SATURDAY', effectiveFrom: '2026-09-14' });
    expect(findSlotConflicts(adHoc, [notYetInForce])).toEqual([]);
  });
});
