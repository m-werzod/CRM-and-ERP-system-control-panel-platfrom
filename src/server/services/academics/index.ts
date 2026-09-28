/**
 * Academic structure: subjects, programmes, groups, teacher assignment and grading
 * scales.
 *
 * Two invariants this domain exists to hold, both worth knowing before calling
 * anything here:
 *
 *   * teacher assignment is DATED. `GroupTeacher` is the authoritative history;
 *     `Group.primaryTeacherId` / `assistantTeacherId` are a cache of its open rows
 *     that only `assignTeacherToGroup` / `unassignTeacherFromGroup` may write.
 *   * a grading scale's bands TILE 0..1_000_000 ppm exactly. `resolveGrade` is pure
 *     and is the only sanctioned score-to-grade mapping.
 *
 * `shared.ts` is internal and is not re-exported.
 */

export {
  archiveSubject,
  createSubject,
  getSubject,
  listSubjects,
  restoreSubject,
  updateSubject,
  type CreateSubjectInput,
  type ListSubjectsInput,
  type SubjectListRow,
  type SubjectReference,
  type SubjectSummary,
  type UpdateSubjectInput,
} from '@/server/services/academics/subjects';

export {
  archiveProgram,
  createProgram,
  getProgram,
  listPrograms,
  manageProgramSubjects,
  updateProgram,
  type CreateProgramInput,
  type ListProgramsInput,
  type ProgramCurriculumEntry,
  type ProgramDetail,
  type ProgramListRow,
  type ProgramSubjectInput,
  type ProgramSummary,
  type UpdateProgramInput,
} from '@/server/services/academics/programs';

export {
  archiveGroup,
  createGroup,
  getGroup,
  getGroupCapacity,
  listGroups,
  updateGroup,
  LIVE_GROUP_STATUSES,
  type CreateGroupInput,
  type GroupCapacity,
  type GroupDetail,
  type GroupListRow,
  type GroupRosterEntry,
  type GroupScheduleSlotEntry,
  type GroupSummary,
  type GroupTeacherHistoryEntry,
  type ListGroupsInput,
  type UpdateGroupInput,
} from '@/server/services/academics/groups';

export {
  assignTeacherToGroup,
  getTeacherProfile,
  getTeacherWorkload,
  listTeachers,
  manageTeacherSubjects,
  unassignTeacherFromGroup,
  type AssignTeacherToGroupInput,
  type ListTeachersInput,
  type TeacherAssignmentResult,
  type TeacherGroupEntry,
  type TeacherListRow,
  type TeacherProfile,
  type TeacherSubjectEntry,
  type TeacherSubjectInput,
  type TeacherWorkload,
  type TeacherWorkloadInput,
  type UnassignTeacherFromGroupInput,
  type WorkloadSlot,
} from '@/server/services/academics/teachers';

export {
  createGradingScale,
  deactivateGradingScale,
  getDefaultGradingScale,
  getGradingScale,
  listGradingScales,
  replaceGradingScaleBands,
  resolveGrade,
  scoreToPpm,
  setDefaultGradingScale,
  updateGradingScale,
  validateGradingBands,
  SCORE_PPM_MAX,
  SCORE_PPM_MIN,
  type CreateGradingScaleInput,
  type GradingBand,
  type GradingBandInput,
  type GradingBandShape,
  type GradingScaleDetail,
  type GradingScaleSummary,
  type ListGradingScalesInput,
  type UpdateGradingScaleInput,
} from '@/server/services/academics/grading-scales';

export type { PageInput, Paginated, SortDirection } from '@/server/services/academics/shared';
