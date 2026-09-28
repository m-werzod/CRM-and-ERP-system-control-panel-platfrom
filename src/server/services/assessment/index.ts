/**
 * The assessment domain's public surface: exams, grading, the gradebook, homework and
 * certificates.
 *
 * `./shared` and `./grade-resolution` are internal. A caller wanting a grade label
 * gets one from the use-cases below; a caller wanting the band arithmetic itself wants
 * `@/server/services/academics/grading-scales`, which owns it.
 */

// --- exams ------------------------------------------------------------------
export {
  assertScoreScheme,
  cancelExam,
  createExam,
  getExam,
  listExams,
  updateExam,
} from './exams';
export type {
  CreateExamInput,
  ExamDetail,
  ExamResultRow,
  ExamSummary,
  ListExamsInput,
  UpdateExamInput,
} from './exams';

// --- grading ----------------------------------------------------------------
export { publishExamResults, recordExamResults } from './grading';
export type {
  ExamResultEntryInput,
  PublishExamResultsResult,
  RecordExamResultsInput,
  RecordExamResultsResult,
  RecordedExamResult,
} from './grading';

// --- statistics -------------------------------------------------------------
export { examStatistics, getExamStatistics, getGroupPerformance } from './statistics';
export type {
  ExamScale,
  ExamScoreEntry,
  ExamScoreLike,
  ExamStatistics,
  ExamStatisticsResult,
  GroupPerformance,
  GroupPerformanceRow,
  ScoreBucket,
} from './statistics';

// --- gradebook --------------------------------------------------------------
export {
  getGroupGradebook,
  getStudentGradebook,
  recordManualGrade,
  updateGrade,
} from './gradebook';
export type {
  GradebookCell,
  GradebookColumn,
  GradebookStudentRow,
  GradeRow,
  GroupGradebook,
  RecordManualGradeInput,
  StudentGradebook,
  SubjectGradeBlock,
  TermGradeBlock,
  UpdateGradeInput,
} from './gradebook';

// --- homework ---------------------------------------------------------------
export {
  closeHomework,
  createHomework,
  getHomeworkWithSubmissions,
  gradeSubmission,
  listHomework,
  publishHomework,
  requestResubmission,
  submitHomework,
} from './homework';
export type {
  CreateHomeworkInput,
  GradeSubmissionInput,
  GradedSubmission,
  HomeworkSummary,
  HomeworkWithSubmissions,
  ListHomeworkInput,
  PublishHomeworkResult,
  SubmissionResult,
  SubmissionRow,
  SubmitHomeworkInput,
} from './homework';

// --- certificates -----------------------------------------------------------
export {
  checkCertificateEligibility,
  issueCertificate,
  listCertificates,
  revokeCertificate,
  verifyCertificate,
} from './certificates';
export type {
  CertificateEligibility,
  CertificateRow,
  CertificateVerification,
  IssueCertificateInput,
  ListCertificatesInput,
} from './certificates';

// --- shared shapes the HTTP layer needs to type a response ------------------
export type { PagedResult, PageInput } from './shared';
