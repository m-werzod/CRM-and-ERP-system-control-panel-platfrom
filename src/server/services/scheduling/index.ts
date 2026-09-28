/**
 * Scheduling services: the recurring timetable, the lessons it produces, the
 * rooms they contend for, and the conflict rules that hold all three together.
 *
 * The HTTP and UI layers import from here. `./conflicts` is the pure core and is
 * re-exported deliberately: an API route that wants to preview a clash before
 * committing can run the same checker the write path runs, rather than a second
 * approximation of it.
 */

export {
  findLessonConflicts,
  findLessonConflictsInIndex,
  findSlotConflicts,
  indexLessonsForConflicts,
  addToLessonConflictIndex,
  lessonAsSlotCandidate,
  TIME_FREEING_LESSON_STATUSES,
  type ExistingLesson,
  type ExistingSlot,
  type LessonCandidate,
  type LessonConflictIndex,
  type ResourceLabels,
  type SlotCandidate,
} from '@/server/services/scheduling/conflicts';

export {
  assertMinuteWindow,
  MINUTES_IN_DAY,
  type ResolvedResources,
  type ResourceSelection,
} from '@/server/services/scheduling/resources';

export {
  assertSlotIsFree,
  createScheduleSlot,
  deactivateScheduleSlot,
  getWeeklyTimetable,
  listScheduleSlots,
  loadGenerableSlots,
  updateScheduleSlot,
  type CreateScheduleSlotInput,
  type DeactivateScheduleSlotResult,
  type ListScheduleSlotsFilters,
  type ScheduleSlotSummary,
  type UpdateScheduleSlotInput,
  type WeeklyTimetable,
} from '@/server/services/scheduling/slots';

export {
  cancelLesson,
  createAdHocLesson,
  generateLessons,
  getLesson,
  getTodaysLessonsForTeacher,
  listLessons,
  rescheduleLesson,
  type CreateAdHocLessonInput,
  type GenerateLessonsInput,
  type GenerateLessonsResult,
  type LessonDetail,
  type LessonSummary,
  type ListLessonsFilters,
  type RescheduleLessonInput,
  type TeacherDay,
  type TeacherDayLesson,
} from '@/server/services/scheduling/lessons';

export {
  createRoom,
  deactivateRoom,
  getRoom,
  getRoomUtilisation,
  listRooms,
  updateRoom,
  type CreateRoomInput,
  type DeactivateRoomResult,
  type ListRoomsFilters,
  type RoomSummary,
  type RoomUtilisation,
  type RoomUtilisationRow,
  type UpdateRoomInput,
} from '@/server/services/scheduling/rooms';
