/**
 * CRM surface.
 *
 * The HTTP layer imports from here, not from the individual files, so a use-case can
 * be split or moved without touching a route. `shared.ts` is deliberately absent:
 * those helpers are seams between these services and are not part of the contract.
 */

export {
  createLead,
  updateLead,
  assignLead,
  changeLeadStatus,
  markLeadLost,
  mergeLeads,
  archiveLead,
  listLeads,
  getLead,
  findDuplicateMatches,
  type CreateLeadInput,
  type CreateLeadResult,
  type UpdateLeadInput,
  type ListLeadsInput,
  type ListLeadsResult,
  type LeadListRow,
  type LeadDetail,
  type LeadSortField,
} from '@/server/services/crm/leads';

export {
  logActivity,
  getLeadTimeline,
  isLoggableActivityType,
  LOGGABLE_ACTIVITY_TYPES,
  type LogActivityInput,
  type LogActivityResult,
  type LoggableActivityType,
  type GetLeadTimelineInput,
  type LeadTimelineEntry,
  type LeadTimelineKind,
} from '@/server/services/crm/activities';

export {
  createFollowUp,
  completeFollowUp,
  reassignFollowUp,
  cancelFollowUp,
  listFollowUps,
  countOverdueForUser,
  type CreateFollowUpInput,
  type FollowUpSummary,
  type ListFollowUpsInput,
  type ListFollowUpsResult,
  type FollowUpRow,
} from '@/server/services/crm/follow-ups';

export {
  bookTrialLesson,
  recordTrialOutcome,
  type BookTrialLessonInput,
  type RecordTrialOutcomeInput,
  type TrialLessonSummary,
} from '@/server/services/crm/trials';

export {
  convertLeadToStudent,
  type ConvertLeadToStudentInput,
  type ConvertLeadGuardianInput,
  type ConvertLeadResult,
} from '@/server/services/crm/convert';

export {
  getPipeline,
  getConversionFunnel,
  getSourcePerformance,
  getAgentPerformance,
  type CrmReportRange,
  type PipelineStage,
  type PipelineSummary,
  type FunnelStage,
  type ConversionFunnel,
  type SourcePerformanceRow,
  type SourcePerformance,
  type AgentPerformanceRow,
  type AgentPerformance,
} from '@/server/services/crm/pipeline';

export {
  allowedLeadTransitions,
  assertLeadTransition,
  isLeadTransitionAllowed,
  isExitStatus,
  normalizeEmail,
  normalizeNameKey,
  rankDuplicateMatches,
  scoreDuplicateMatch,
  DUPLICATE_MATCH_THRESHOLD_PPM,
  LEAD_EXIT_STATUSES,
  LEAD_PIPELINE,
  LEAD_REOPEN_STATUS,
  type DuplicateCandidate,
  type DuplicateCandidateKind,
  type DuplicateMatch,
  type DuplicateMatchField,
  type DuplicateSubject,
} from '@/server/services/crm/scoring';
