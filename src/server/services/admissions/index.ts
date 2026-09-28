/**
 * Admissions: Application -> review gates -> interview -> decision -> Student.
 *
 * The HTTP layer imports from here rather than reaching into the individual files,
 * so the module's surface is one list rather than whatever happens to be exported.
 */

export {
  createApplication,
  updateApplication,
  submitApplication,
  listApplications,
  getApplication,
  DEFAULT_REVIEW_STAGES,
  type ApplicationSummary,
  type ApplicationListRow,
  type ApplicationDetail,
  type CreateApplicationInput,
  type UpdateApplicationInput,
  type ListApplicationsInput,
} from '@/server/services/admissions/applications';

export {
  recordReview,
  getReviewProgress,
  evaluateGates,
  MANDATORY_ACCEPT_STAGES,
  type RecordReviewInput,
  type ReviewResult,
  type ReviewProgress,
  type GateState,
} from '@/server/services/admissions/reviews';

export {
  scheduleInterview,
  rescheduleInterview,
  recordInterviewOutcome,
  cancelInterview,
  type ScheduleInterviewInput,
  type RescheduleInterviewInput,
  type RecordInterviewOutcomeInput,
  type InterviewSummary,
} from '@/server/services/admissions/interviews';

export {
  decideApplication,
  type DecideApplicationInput,
  type DecisionResult,
} from '@/server/services/admissions/decide';

export {
  createStudentFromApplication,
  splitPersonName,
  type CreateStudentFromApplicationInput,
  type CreateStudentFromApplicationResult,
} from '@/server/services/admissions/enroll';

export {
  getAdmissionsFunnel,
  getStageBottlenecks,
  type AdmissionsFunnel,
  type FunnelInput,
  type FunnelStatusCount,
  type StageBottleneck,
} from '@/server/services/admissions/funnel';
