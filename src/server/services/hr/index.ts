/**
 * HR: employees, staff attendance, leave, salary structure and payroll.
 *
 * Three invariants this domain exists to hold, all worth knowing before calling
 * anything here:
 *
 *   * PAY IS DATED. `SalaryComponent` rows are closed and re-opened, never edited,
 *     so an approved payroll run stays reproducible. `setSalaryComponent` is the
 *     only writer, and `Employee.baseSalaryMinor` is a headline cache it maintains.
 *
 *   * A PAYROLL RUN IS A DOCUMENT. `calculatePayrollRun` snapshots each payslip into
 *     `PayrollItem.breakdown`; nothing re-derives an approved payslip from today's
 *     salary table.
 *
 *   * FOUR EYES on leave decisions and on payroll approval: the approver is never
 *     the requester, and never the person who calculated the run.
 *
 * The payroll engine (`calculatePayrollItem`) is pure and has no database access, so
 * the HTTP layer can also use it to preview what a change would cost.
 *
 * `shared.ts` is internal and is not re-exported.
 */

export {
  createEmployee,
  getEmployee,
  listEmployees,
  terminateEmployee,
  updateEmployee,
  type CreateEmployeeInput,
  type CreateEmployeeResult,
  type CreateEmployeeTeacherInput,
  type EmployeeDetail,
  type EmployeeListRow,
  type EmployeeSalaryBlock,
  type ListEmployeesInput,
  type TerminateEmployeeInput,
  type TerminateEmployeeResult,
  type UpdateEmployeeInput,
} from '@/server/services/hr/employees';

export {
  checkIn,
  checkOut,
  computeStaffTiming,
  getStaffAttendanceSummary,
  listStaffAttendance,
  recordStaffAttendance,
  type CheckInInput,
  type CheckOutInput,
  type ExpectedWindow,
  type ExpectedWindowOverride,
  type ExpectedWindowSource,
  type ListStaffAttendanceInput,
  type RecordStaffAttendanceInput,
  type StaffAttendanceListRow,
  type StaffAttendanceRecord,
  type StaffAttendanceSummary,
  type StaffAttendanceSummaryInput,
  type StaffAttendanceSummaryRow,
  type StaffTiming,
} from '@/server/services/hr/staff-attendance';

export {
  approveLeave,
  cancelLeave,
  createLeaveType,
  getLeaveBalance,
  listLeaveRequests,
  listLeaveTypes,
  rejectLeave,
  requestLeave,
  updateLeaveType,
  type LeaveBalance,
  type LeaveBalanceRow,
  type LeaveRequestSummary,
  type LeaveTypeInput,
  type LeaveTypeSummary,
  type ListLeaveRequestsInput,
  type ListLeaveTypesInput,
  type RequestLeaveInput,
  type UpdateLeaveTypeInput,
} from '@/server/services/hr/leave';

export {
  getEffectiveSalary,
  listSalaryComponents,
  setSalaryComponent,
  toSpecs,
  type EffectiveSalary,
  type ListSalaryComponentsInput,
  type SalaryComponentRow,
  type SetSalaryComponentInput,
  type SetSalaryComponentResult,
} from '@/server/services/hr/salary';

export {
  DEFAULT_PAYROLL_CALCULATOR_KEY,
  PAYROLL_CALCULATORS,
  SHORTFALL_LINE_TYPE,
  calculatePayrollItem,
  defaultPayrollCalculator,
  getPayrollCalculator,
  selectEffectiveComponents,
  type CalculatePayrollItemInput,
  type PayrollBreakdownLine,
  type PayrollCalculator,
  type PayrollComputation,
  type PayrollLineEffect,
  type ProRationMode,
  type SalaryComponentSpec,
} from '@/server/services/hr/payroll/calculator';

export {
  approvePayrollRun,
  calculatePayrollRun,
  createPayrollRun,
  getPayrollRun,
  listPayrollRuns,
  markPayrollPaid,
  type CalculatePayrollRunInput,
  type CalculatePayrollRunResult,
  type CreatePayrollRunInput,
  type ListPayrollRunsInput,
  type PayrollItemRow,
  type PayrollRunDetail,
  type PayrollRunSummary,
  type SkippedEmployee,
} from '@/server/services/hr/payroll/runs';

export type { PageInput, Paginated, SortDirection } from '@/server/services/hr/shared';
