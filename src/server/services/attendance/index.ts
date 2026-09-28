/**
 * Attendance: one register, six ways of filling it in.
 *
 * Read this before calling anything here, because the shape of the domain is the
 * whole point:
 *
 *   * `markAttendance` is the ONLY path that writes an `AttendanceRecord`. Manual
 *     entry, a teacher's register, a face terminal, a QR scan, an unattended device
 *     and a CSV import all funnel through it, and `method` records which one it
 *     was. The face, QR and device use-cases below resolve a person and a lesson
 *     and then call it -- they do not insert. That is what keeps the
 *     (lessonId, studentId) unique index, the late-threshold rule and the audit
 *     entry identical for every capture method.
 *
 *   * `statusFromArrival` is the one arrival rule. A late scan, a late tap and a
 *     late turnstile read are classified by the same function and the same two
 *     settings.
 *
 *   * corrections are appended, never applied silently: `correctAttendance` writes
 *     an `AttendanceCorrection` in the same transaction as the change.
 *
 *   * biometrics store NO biometric data -- only an opaque provider reference and a
 *     consent link -- and every recognition attempt, including the failures, is
 *     persisted as a `FaceRecognitionEvent`. A provider that simulates recognition
 *     says so through `getBiometricStatus`; nothing here dresses a simulator up as
 *     a working biometric system.
 */

export {
  approveCorrection,
  approveRegister,
  correctAttendance,
  markAttendance,
  statusFromArrival,
  type AttendanceEntryInput,
  type CorrectAttendanceInput,
  type MarkAttendanceInput,
  type MarkAttendanceResult,
} from '@/server/services/attendance/mark';

export {
  attendancePercentagePpm,
  EMPTY_COUNTS,
  findAtRiskStudents,
  getDailyAttendance,
  getGroupAttendance,
  getStudentAttendance,
  loadAttendanceRule,
  totalRecords,
  type AttendanceCounts,
  type AttendanceSummary,
  type StatusWeightsPpm,
} from '@/server/services/attendance/statistics';

export {
  enrollBiometrics,
  evaluateConsent,
  getBiometricStatus,
  grantConsent,
  identifyAndMark,
  listFaceRecognitionEvents,
  revokeBiometricEnrollment,
  revokeConsent,
  type BiometricEnrollmentResult,
  type BiometricStatus,
  type BiometricSubjectStatus,
  type ConsentDecision,
  type ConsentResult,
  type EnrollBiometricsInput,
  type FaceAttendanceOutcome,
  type FaceEventRow,
  type FaceOutcomeDetail,
  type GrantConsentInput,
  type IdentifyAndMarkInput,
  type ListFaceEventsInput,
  type RevokeBiometricEnrollmentInput,
  type RevokeConsentInput,
} from '@/server/services/attendance/face';

export {
  issueQrToken,
  purgeExpiredQrTokens,
  redeemQrToken,
  type IssuedQrToken,
  type IssueQrTokenInput,
  type RedeemQrTokenInput,
  type RedeemQrTokenResult,
} from '@/server/services/attendance/qr';

export {
  authenticateDevice,
  deactivateDevice,
  deviceAccessContext,
  findLessonForObservation,
  listDevices,
  recordDeviceHeartbeat,
  registerDevice,
  rotateDeviceKey,
  submitDeviceAttendance,
  type AuthenticatedDevice,
  type DeviceAttendanceResult,
  type DeviceKeyIssued,
  type DeviceRow,
  type LessonWindowMatch,
  type ListDevicesInput,
  type RegisterDeviceInput,
  type SubmitDeviceAttendanceInput,
} from '@/server/services/attendance/device';
