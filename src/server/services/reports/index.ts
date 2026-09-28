/**
 * The reporting surface, and the registry that makes a report addressable by key.
 *
 * `SavedReport.type` and `ExportJob.type` are plain strings in the database, so
 * something has to turn a stored key back into a function. That is
 * `REPORT_REGISTRY`: the UI lists reports from it, the export worker resolves one
 * from it, and a saved configuration from last term still runs because the key is
 * stable even when the implementation moves.
 *
 * Every entry shares one signature -- `(ctx, filters, db?)` -- which is why every
 * report takes the same `ReportFilters` and returns the same envelope. A report
 * with a bespoke argument list could not be in the registry, and would therefore
 * not be exportable or savable; that constraint is the point.
 *
 * `REPORTS_COVER_EVERY_KEY` below is a compile-time assertion that the registry
 * and `REPORT_KEYS` agree. Adding a key without a function, or a function without
 * a key, fails `tsc` rather than surfacing as an export job stuck at PENDING.
 */

import type { Db } from '@/server/db/client';
import type { AccessContext } from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';

import {
  studentsDistributionReport,
  studentsOverviewReport,
  studentsRetentionReport,
  STUDENT_DISTRIBUTION_COLUMNS,
  STUDENT_MOVEMENT_COLUMNS,
  STUDENT_RETENTION_COLUMNS,
} from './students';
import {
  attendanceAtRiskReport,
  attendanceByGroupReport,
  attendanceByTeacherReport,
  attendanceRatesReport,
  teacherPunctualityReport,
  ATTENDANCE_AT_RISK_COLUMNS,
  ATTENDANCE_GROUP_COLUMNS,
  ATTENDANCE_PERIOD_COLUMNS,
  ATTENDANCE_TEACHER_COLUMNS,
  TEACHER_PUNCTUALITY_COLUMNS,
} from './attendance';
import {
  financeCollectionsReport,
  financeDiscountsReport,
  financeOutstandingReport,
  financeRefundsReport,
  financeRevenueReport,
  COLLECTION_COLUMNS,
  DISCOUNT_COLUMNS,
  OUTSTANDING_COLUMNS,
  REFUND_COLUMNS,
  REVENUE_COLUMNS,
} from './finance';
import {
  crmFollowUpComplianceReport,
  crmFunnelReport,
  crmLeadsReport,
  crmLostReasonsReport,
  FOLLOW_UP_COMPLIANCE_COLUMNS,
  FUNNEL_COLUMNS,
  LEAD_BREAKDOWN_COLUMNS,
  LOST_REASON_COLUMNS,
} from './crm';
import {
  academicByTeacherReport,
  academicBySubjectReport,
  academicExamPerformanceReport,
  academicGradeDistributionReport,
  academicHomeworkCompletionReport,
  EXAM_PERFORMANCE_COLUMNS,
  GRADE_DISTRIBUTION_COLUMNS,
  HOMEWORK_COMPLETION_COLUMNS,
  SUBJECT_PERFORMANCE_COLUMNS,
  TEACHER_PERFORMANCE_COLUMNS,
} from './academic';
import {
  hrLeaveReport,
  hrPayrollReport,
  hrStaffAttendanceReport,
  hrTeacherWorkloadReport,
  LEAVE_COLUMNS,
  PAYROLL_COLUMNS,
  STAFF_ATTENDANCE_COLUMNS,
  TEACHER_WORKLOAD_COLUMNS,
} from './hr';
import { REPORT_KEYS, type ReportFilters, type ReportKey, type ReportResult, type ReportRow } from './types';
import type { ReportColumn } from './export';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  bucketsIn,
  bucketStart,
  buildResult,
  capRows,
  countSeries,
  emptyResult,
  isReportKey,
  MAX_REPORT_RANGE_DAYS,
  moneySeries,
  percentSeries,
  REPORT_KEYS,
  REPORT_ROW_CAP,
  resolveReportScope,
  selfHasNoIdentity,
  shareOfMoneyPpm,
  sharePpm,
  truncUnit,
  type ReportFilters,
  type ReportGranularity,
  type ReportKey,
  type ReportMeta,
  type ReportResult,
  type ReportRow,
  type ReportScope,
  type ReportSeries,
  type ReportSeriesKind,
  type ReportSeriesPoint,
  type ReportValue,
  type ResolvedReportFilters,
} from './types';

export {
  completeExportJob,
  createExportJob,
  exponentFor,
  failExportJob,
  minorToMajorString,
  moneyColumn,
  percentColumn,
  renderCell,
  toCsv,
  UTF8_BOM,
  type CompleteExportJobInput,
  type CreateExportJobInput,
  type ExportJobSummary,
  type FailExportJobInput,
  type ReportColumn,
  type ReportColumnKind,
  type ToCsvOptions,
} from './export';

export * from './students';
export * from './attendance';
export * from './finance';
export * from './crm';
export * from './academic';
export * from './hr';

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * A report, addressable by key.
 *
 * `columns` travels with the function because the table header, the CSV header
 * and the column order are the same decision: an exporter that took its own
 * column list would drift from the screen it claims to export.
 */
export interface ReportDefinition {
  readonly key: ReportKey;
  /**
   * The permission the function itself enforces, repeated here so the UI can hide
   * a report it cannot run. Hiding it is a courtesy; the check inside the service
   * is the control.
   */
  readonly permission: PermissionKey;
  /** i18n key for the report's name, e.g. `reports.revenue`. */
  readonly titleKey: string;
  readonly run: (
    ctx: AccessContext,
    filters: ReportFilters,
    db?: Db,
  ) => Promise<ReportResult<ReportRow, ReportRow>>;
  readonly columns: readonly ReportColumn<ReportRow>[];
}

/**
 * Widen a concrete report to the registry's row type.
 *
 * Every row and totals shape in this module is an object TYPE ALIAS, so it
 * carries an implicit index signature and is genuinely assignable to `ReportRow` --
 * there is no unsoundness being papered over here. The helper exists only because
 * TypeScript will not infer that for a generic function's return type, and it is a
 * cast through the assignable supertype rather than through `unknown`.
 */
function define<TRow extends ReportRow, TTotals extends ReportRow>(
  key: ReportKey,
  permission: PermissionKey,
  titleKey: string,
  run: (ctx: AccessContext, filters: ReportFilters, db?: Db) => Promise<ReportResult<TRow, TTotals>>,
  columns: readonly ReportColumn<TRow>[],
): ReportDefinition {
  return {
    key,
    permission,
    titleKey,
    run: (ctx, filters, db) => run(ctx, filters, db),
    columns: columns as readonly ReportColumn<ReportRow>[],
  };
}

export const REPORT_REGISTRY = {
  'students.overview': define(
    'students.overview',
    'reports.view',
    'reports.enrollment',
    studentsOverviewReport,
    STUDENT_MOVEMENT_COLUMNS,
  ),
  'students.distribution': define(
    'students.distribution',
    'reports.view',
    'reports.enrollment',
    studentsDistributionReport,
    STUDENT_DISTRIBUTION_COLUMNS,
  ),
  'students.retention': define(
    'students.retention',
    'reports.view',
    'reports.enrollment',
    studentsRetentionReport,
    STUDENT_RETENTION_COLUMNS,
  ),

  'attendance.rates': define(
    'attendance.rates',
    'reports.viewAcademic',
    'reports.attendanceSummary',
    attendanceRatesReport,
    ATTENDANCE_PERIOD_COLUMNS,
  ),
  'attendance.byGroup': define(
    'attendance.byGroup',
    'reports.viewAcademic',
    'reports.attendanceSummary',
    attendanceByGroupReport,
    ATTENDANCE_GROUP_COLUMNS,
  ),
  'attendance.byTeacher': define(
    'attendance.byTeacher',
    'reports.viewAcademic',
    'reports.attendanceSummary',
    attendanceByTeacherReport,
    ATTENDANCE_TEACHER_COLUMNS,
  ),
  'attendance.atRisk': define(
    'attendance.atRisk',
    'reports.viewAcademic',
    'reports.attendanceSummary',
    attendanceAtRiskReport,
    ATTENDANCE_AT_RISK_COLUMNS,
  ),
  'attendance.teacherPunctuality': define(
    'attendance.teacherPunctuality',
    'reports.viewAcademic',
    'reports.attendanceSummary',
    teacherPunctualityReport,
    TEACHER_PUNCTUALITY_COLUMNS,
  ),

  'finance.revenue': define(
    'finance.revenue',
    'reports.viewFinancial',
    'reports.revenue',
    financeRevenueReport,
    REVENUE_COLUMNS,
  ),
  'finance.collections': define(
    'finance.collections',
    'reports.viewFinancial',
    'reports.collections',
    financeCollectionsReport,
    COLLECTION_COLUMNS,
  ),
  'finance.outstanding': define(
    'finance.outstanding',
    'reports.viewFinancial',
    'reports.outstanding',
    financeOutstandingReport,
    OUTSTANDING_COLUMNS,
  ),
  'finance.discounts': define(
    'finance.discounts',
    'reports.viewFinancial',
    'reports.discountUsage',
    financeDiscountsReport,
    DISCOUNT_COLUMNS,
  ),
  'finance.refunds': define(
    'finance.refunds',
    'reports.viewFinancial',
    'reports.revenue',
    financeRefundsReport,
    REFUND_COLUMNS,
  ),

  'crm.leads': define(
    'crm.leads',
    'reports.viewCrm',
    'reports.leadSourcePerformance',
    crmLeadsReport,
    LEAD_BREAKDOWN_COLUMNS,
  ),
  'crm.funnel': define(
    'crm.funnel',
    'reports.viewCrm',
    'reports.leadConversion',
    crmFunnelReport,
    FUNNEL_COLUMNS,
  ),
  'crm.lostReasons': define(
    'crm.lostReasons',
    'reports.viewCrm',
    'reports.leadConversion',
    crmLostReasonsReport,
    LOST_REASON_COLUMNS,
  ),
  'crm.followUpCompliance': define(
    'crm.followUpCompliance',
    'reports.viewCrm',
    'reports.leadConversion',
    crmFollowUpComplianceReport,
    FOLLOW_UP_COMPLIANCE_COLUMNS,
  ),

  'academic.gradeDistribution': define(
    'academic.gradeDistribution',
    'reports.viewAcademic',
    'reports.examResults',
    academicGradeDistributionReport,
    GRADE_DISTRIBUTION_COLUMNS,
  ),
  'academic.examPerformance': define(
    'academic.examPerformance',
    'reports.viewAcademic',
    'reports.examResults',
    academicExamPerformanceReport,
    EXAM_PERFORMANCE_COLUMNS,
  ),
  'academic.bySubject': define(
    'academic.bySubject',
    'reports.viewAcademic',
    'reports.groupPerformance',
    academicBySubjectReport,
    SUBJECT_PERFORMANCE_COLUMNS,
  ),
  'academic.byTeacher': define(
    'academic.byTeacher',
    'reports.viewAcademic',
    'reports.groupPerformance',
    academicByTeacherReport,
    TEACHER_PERFORMANCE_COLUMNS,
  ),
  'academic.homeworkCompletion': define(
    'academic.homeworkCompletion',
    'reports.viewAcademic',
    'reports.groupPerformance',
    academicHomeworkCompletionReport,
    HOMEWORK_COMPLETION_COLUMNS,
  ),

  'hr.staffAttendance': define(
    'hr.staffAttendance',
    'reports.viewHr',
    'reports.attendanceSummary',
    hrStaffAttendanceReport,
    STAFF_ATTENDANCE_COLUMNS,
  ),
  'hr.teacherWorkload': define(
    'hr.teacherWorkload',
    'reports.viewHr',
    'reports.teacherLoad',
    hrTeacherWorkloadReport,
    TEACHER_WORKLOAD_COLUMNS,
  ),
  'hr.leave': define('hr.leave', 'reports.viewHr', 'reports.payrollSummary', hrLeaveReport, LEAVE_COLUMNS),
  'hr.payroll': define(
    'hr.payroll',
    'reports.viewHr',
    'reports.payrollSummary',
    hrPayrollReport,
    PAYROLL_COLUMNS,
  ),
} as const satisfies Record<ReportKey, ReportDefinition>;

/**
 * Compile-time proof that the registry covers exactly `REPORT_KEYS`.
 *
 * `satisfies Record<ReportKey, …>` above catches a missing key; this catches the
 * other direction, a registry entry whose key is not in the catalogue.
 */
type RegistryKey = keyof typeof REPORT_REGISTRY;
type MissingFromRegistry = Exclude<ReportKey, RegistryKey>;
type ExtraInRegistry = Exclude<RegistryKey, ReportKey>;
export type REPORTS_COVER_EVERY_KEY = [MissingFromRegistry, ExtraInRegistry] extends [never, never]
  ? true
  : never;

/** Look up a report by a key that came out of the database. */
export function reportByKey(key: string): ReportDefinition | null {
  return Object.hasOwn(REPORT_REGISTRY, key)
    ? REPORT_REGISTRY[key as ReportKey]
    : null;
}

/** Every report, in catalogue order. The UI's report picker iterates this. */
export function listReportDefinitions(): readonly ReportDefinition[] {
  return REPORT_KEYS.map((key) => REPORT_REGISTRY[key]);
}
