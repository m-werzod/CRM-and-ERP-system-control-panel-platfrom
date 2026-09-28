/**
 * The typed event catalogue.
 *
 * Every NotificationEvent declares, in one place, the variables its templates may
 * use and who hears about it by default. That declaration is a Zod schema rather
 * than a comment, so `notify()` can be generic over the event and a call site that
 * forgets `dueDate` fails to compile instead of sending nine hundred guardians a
 * message with a hole in it. This is the whole point of the module: a template is
 * edited by an operator, the call site is written by a developer, and the schema is
 * the contract between them.
 *
 * VARIABLES ARE ALREADY-FORMATTED STRINGS. Money arrives via `formatMoney` and
 * dates via `@/lib/dates`, because only the call site knows the recipient's locale
 * and the branch's timezone -- the renderer deliberately cannot format anything
 * (see ./template.ts). A schema here therefore asks for `amount: string`, never a
 * bigint and never a Date.
 */

import { z } from 'zod';
import type { NotificationEvent, NotificationPriority } from '@/generated/prisma/client';
import type { PermissionKey } from '@/server/rbac/permissions';

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/**
 * Who an event reaches when the call site does not name recipients itself.
 *
 * `EXPLICIT` is not a fallback for "we did not think about it" -- it marks events
 * whose recipient is not derivable from a subject id, such as a trial-lesson
 * reminder to a lead who has neither a user account nor a guardian row.
 */
export type Audience =
  | { readonly kind: 'GUARDIANS_OF_STUDENT' }
  | { readonly kind: 'STUDENT' }
  | { readonly kind: 'STAFF_WITH_PERMISSION'; readonly permission: PermissionKey }
  | { readonly kind: 'ASSIGNED_USER' }
  | { readonly kind: 'EXPLICIT' };

/** Which id `defaultAudience` needs from the call site to expand. */
export type SubjectRequirement = 'STUDENT' | 'USER' | 'NONE';

/**
 * Notification settings that suppress a whole class of guardian message. Named
 * here so the gate travels with the event rather than being remembered at each of
 * the dozen call sites that can cause a payment receipt.
 */
export type GuardianGate = 'notifyGuardianOnAbsence' | 'notifyGuardianOnPayment';

export interface EventDefinition<S extends z.ZodType = z.ZodType> {
  /** Template key prefix; the seed derives one row per channel and locale. */
  readonly templateKey: string;
  readonly variables: S;
  readonly defaultAudience: readonly Audience[];
  readonly subjectRequirement: SubjectRequirement;
  readonly defaultPriority: NotificationPriority;
  /** When set, guardians are dropped from the audience while the setting is off. */
  readonly guardianGate?: GuardianGate;
  /** Why this event exists, for the settings screen that lists them. */
  readonly description: string;
}

function defineEvent<S extends z.ZodType>(definition: EventDefinition<S>): EventDefinition<S> {
  return definition;
}

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------

/** A person or thing's display name. */
const name = z.string().trim().min(1).max(200);
/** A pre-formatted date, time or datetime, e.g. "27.09.2026" or "14:30". */
const formatted = z.string().trim().min(1).max(60);
/** A pre-formatted money amount, e.g. "450 000 so'm". */
const amount = z.string().trim().min(1).max(60);
/** Free text supplied by a user: a reason, a note, a title. */
const freeText = z.string().trim().min(1).max(500);
const count = z.number().int().min(0).max(1_000_000);
/** An absolute URL the recipient can open. Never a token pasted into prose. */
const url = z.string().url().max(2_000);

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const GUARDIANS: readonly Audience[] = [{ kind: 'GUARDIANS_OF_STUDENT' }];
const GUARDIANS_AND_STUDENT: readonly Audience[] = [
  { kind: 'GUARDIANS_OF_STUDENT' },
  { kind: 'STUDENT' },
];

function staff(permission: PermissionKey): readonly Audience[] {
  return [{ kind: 'STAFF_WITH_PERMISSION', permission }];
}

export const NOTIFICATION_EVENTS = {
  // --- Attendance ---------------------------------------------------------
  STUDENT_ABSENT: defineEvent({
    templateKey: 'attendance.student_absent',
    description: 'A student was marked absent from a lesson.',
    variables: z.object({
      studentName: name,
      groupName: name,
      lessonDate: formatted,
      lessonTime: formatted,
    }),
    defaultAudience: GUARDIANS,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'HIGH',
    guardianGate: 'notifyGuardianOnAbsence',
  }),

  STUDENT_LATE: defineEvent({
    templateKey: 'attendance.student_late',
    description: 'A student arrived after the late threshold.',
    variables: z.object({
      studentName: name,
      groupName: name,
      lessonDate: formatted,
      lessonTime: formatted,
      minutesLate: count,
    }),
    defaultAudience: GUARDIANS,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
    guardianGate: 'notifyGuardianOnAbsence',
  }),

  ATTENDANCE_SUBMITTED: defineEvent({
    templateKey: 'attendance.submitted',
    description: 'A teacher submitted a register. Internal confirmation for office staff.',
    variables: z.object({
      groupName: name,
      teacherName: name,
      lessonDate: formatted,
      presentCount: count,
      absentCount: count,
    }),
    defaultAudience: staff('attendance.viewAll'),
    subjectRequirement: 'NONE',
    defaultPriority: 'LOW',
  }),

  ATTENDANCE_CORRECTED: defineEvent({
    templateKey: 'attendance.corrected',
    description: 'An attendance record was changed after submission.',
    variables: z.object({
      studentName: name,
      groupName: name,
      lessonDate: formatted,
      previousStatus: name,
      newStatus: name,
      correctedBy: name,
      reason: freeText.optional(),
    }),
    defaultAudience: staff('attendance.approve'),
    subjectRequirement: 'NONE',
    defaultPriority: 'NORMAL',
  }),

  DAILY_ATTENDANCE_SUMMARY: defineEvent({
    templateKey: 'attendance.daily_summary',
    description: 'End-of-day attendance figures for a branch.',
    variables: z.object({
      branchName: name,
      date: formatted,
      presentCount: count,
      lateCount: count,
      absentCount: count,
      attendancePercent: formatted,
    }),
    defaultAudience: staff('attendance.viewAll'),
    subjectRequirement: 'NONE',
    defaultPriority: 'LOW',
  }),

  // --- Finance ------------------------------------------------------------
  INVOICE_ISSUED: defineEvent({
    templateKey: 'finance.invoice_issued',
    description: 'An invoice was issued to a student.',
    variables: z.object({
      studentName: name,
      invoiceNumber: name,
      amount,
      dueDate: formatted,
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
    guardianGate: 'notifyGuardianOnPayment',
  }),

  PAYMENT_RECEIVED: defineEvent({
    templateKey: 'finance.payment_received',
    description: 'A payment was recorded. Doubles as the receipt.',
    variables: z.object({
      studentName: name,
      amount,
      receiptNumber: name,
      paidOn: formatted,
      remainingBalance: amount.optional(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
    guardianGate: 'notifyGuardianOnPayment',
  }),

  PAYMENT_REMINDER: defineEvent({
    templateKey: 'finance.payment_reminder',
    description: 'An invoice falls due shortly.',
    variables: z.object({
      studentName: name,
      invoiceNumber: name,
      amount,
      dueDate: formatted,
      daysUntilDue: count,
    }),
    defaultAudience: GUARDIANS,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
    guardianGate: 'notifyGuardianOnPayment',
  }),

  PAYMENT_OVERDUE: defineEvent({
    templateKey: 'finance.payment_overdue',
    description: 'An invoice passed its due date and is still unpaid.',
    variables: z.object({
      studentName: name,
      invoiceNumber: name,
      amount,
      dueDate: formatted,
      daysOverdue: count,
    }),
    defaultAudience: GUARDIANS,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'HIGH',
    guardianGate: 'notifyGuardianOnPayment',
  }),

  REFUND_PROCESSED: defineEvent({
    templateKey: 'finance.refund_processed',
    description: 'A refund was paid back to a student or guardian.',
    variables: z.object({
      studentName: name,
      amount,
      refundNumber: name,
      processedOn: formatted,
    }),
    defaultAudience: GUARDIANS,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
    guardianGate: 'notifyGuardianOnPayment',
  }),

  DISCOUNT_APPROVAL_REQUESTED: defineEvent({
    templateKey: 'finance.discount_approval_requested',
    description: 'A discount above the threshold is waiting for an approver.',
    variables: z.object({
      studentName: name,
      discountName: name,
      discountValue: formatted,
      requestedBy: name,
    }),
    defaultAudience: staff('discounts.approve'),
    subjectRequirement: 'NONE',
    defaultPriority: 'HIGH',
  }),

  // --- Academics ----------------------------------------------------------
  ENROLLMENT_CREATED: defineEvent({
    templateKey: 'academics.enrollment_created',
    description: 'A student was enrolled into a group.',
    variables: z.object({
      studentName: name,
      groupName: name,
      startDate: formatted,
      branchName: name.optional(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
  }),

  SCHEDULE_CHANGED: defineEvent({
    templateKey: 'academics.schedule_changed',
    description: 'A group timetable changed.',
    variables: z.object({
      groupName: name,
      effectiveFrom: formatted,
      changeSummary: freeText,
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'HIGH',
  }),

  LESSON_CANCELLED: defineEvent({
    templateKey: 'academics.lesson_cancelled',
    description: 'A lesson was cancelled.',
    variables: z.object({
      groupName: name,
      lessonDate: formatted,
      lessonTime: formatted,
      reason: freeText.optional(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'HIGH',
  }),

  HOMEWORK_ASSIGNED: defineEvent({
    templateKey: 'academics.homework_assigned',
    description: 'Homework was published for a group.',
    variables: z.object({
      subjectName: name,
      title: name,
      dueDate: formatted,
      groupName: name.optional(),
    }),
    defaultAudience: [{ kind: 'STUDENT' }],
    subjectRequirement: 'STUDENT',
    defaultPriority: 'LOW',
  }),

  GRADE_UPDATED: defineEvent({
    templateKey: 'academics.grade_updated',
    description: 'A grade was entered or changed.',
    variables: z.object({
      studentName: name,
      subjectName: name,
      grade: formatted,
      comment: freeText.optional(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'LOW',
  }),

  EXAM_SCHEDULED: defineEvent({
    templateKey: 'assessment.exam_scheduled',
    description: 'An exam date was published.',
    variables: z.object({
      examName: name,
      subjectName: name,
      examDate: formatted,
      examTime: formatted,
      roomName: name.optional(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
  }),

  EXAM_RESULT_PUBLISHED: defineEvent({
    templateKey: 'assessment.exam_result_published',
    description: 'Exam results were published.',
    variables: z.object({
      studentName: name,
      examName: name,
      score: formatted,
      maxScore: formatted,
      passed: z.boolean(),
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
  }),

  CERTIFICATE_ISSUED: defineEvent({
    templateKey: 'assessment.certificate_issued',
    description: 'A certificate was issued to a student.',
    variables: z.object({
      studentName: name,
      certificateName: name,
      certificateNumber: name,
      issuedOn: formatted,
    }),
    defaultAudience: GUARDIANS_AND_STUDENT,
    subjectRequirement: 'STUDENT',
    defaultPriority: 'NORMAL',
  }),

  ANNOUNCEMENT_PUBLISHED: defineEvent({
    templateKey: 'communication.announcement_published',
    description: 'An announcement was published to an audience.',
    variables: z.object({
      title: name,
      summary: freeText,
      publishedBy: name.optional(),
    }),
    // The announcement itself carries its targets, so the publishing service
    // resolves them and passes recipients explicitly.
    defaultAudience: [{ kind: 'EXPLICIT' }],
    subjectRequirement: 'NONE',
    defaultPriority: 'LOW',
  }),

  // --- CRM and admissions -------------------------------------------------
  NEW_LEAD_ASSIGNED: defineEvent({
    templateKey: 'crm.new_lead_assigned',
    description: 'A lead was assigned to a sales agent.',
    variables: z.object({
      leadName: name,
      leadPhone: name,
      source: name.optional(),
      assignedBy: name.optional(),
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    defaultPriority: 'HIGH',
  }),

  FOLLOW_UP_DUE: defineEvent({
    templateKey: 'crm.follow_up_due',
    description: 'A follow-up task has reached its due time.',
    variables: z.object({
      taskTitle: name,
      dueAt: formatted,
      relatedName: name.optional(),
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    defaultPriority: 'HIGH',
  }),

  TRIAL_REMINDER: defineEvent({
    templateKey: 'crm.trial_reminder',
    description: 'A trial lesson is coming up.',
    variables: z.object({
      attendeeName: name,
      trialDate: formatted,
      trialTime: formatted,
      groupName: name.optional(),
      branchName: name.optional(),
    }),
    // A lead has no user or guardian row, so the CRM service supplies the
    // recipient (and its phone number) directly.
    defaultAudience: [{ kind: 'EXPLICIT' }],
    subjectRequirement: 'NONE',
    defaultPriority: 'NORMAL',
  }),

  APPLICATION_STATUS_CHANGED: defineEvent({
    templateKey: 'admissions.application_status_changed',
    description: 'An admission application moved to a new status.',
    variables: z.object({
      applicantName: name,
      applicationNumber: name,
      status: name,
      nextStep: freeText.optional(),
    }),
    defaultAudience: [{ kind: 'EXPLICIT' }],
    subjectRequirement: 'NONE',
    defaultPriority: 'NORMAL',
  }),

  // --- HR -----------------------------------------------------------------
  LEAVE_REQUEST_SUBMITTED: defineEvent({
    templateKey: 'hr.leave_request_submitted',
    description: 'An employee requested leave and needs a decision.',
    variables: z.object({
      employeeName: name,
      leaveType: name,
      fromDate: formatted,
      toDate: formatted,
      dayCount: count,
    }),
    defaultAudience: staff('leave.approve'),
    subjectRequirement: 'NONE',
    defaultPriority: 'NORMAL',
  }),

  LEAVE_REQUEST_DECIDED: defineEvent({
    templateKey: 'hr.leave_request_decided',
    description: 'A leave request was approved or rejected.',
    variables: z.object({
      employeeName: name,
      leaveType: name,
      fromDate: formatted,
      toDate: formatted,
      decision: name,
      decidedBy: name,
      reason: freeText.optional(),
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    defaultPriority: 'NORMAL',
  }),

  // --- Account and security ----------------------------------------------
  //
  // These carry no credential. A notification is delivered over SMS and email,
  // neither of which is a safe place for a password, so ACCOUNT_CREATED sends a
  // link and PASSWORD_RESET sends a single-use URL that expires.
  ACCOUNT_CREATED: defineEvent({
    templateKey: 'account.created',
    description: 'An account was created and the user must set a password.',
    variables: z.object({
      userName: name,
      organizationName: name,
      loginUrl: url,
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    defaultPriority: 'HIGH',
  }),

  PASSWORD_RESET: defineEvent({
    templateKey: 'account.password_reset',
    description: 'A password reset was requested.',
    variables: z.object({
      userName: name,
      resetUrl: url,
      expiresInMinutes: count,
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    // Critical, so quiet hours never hold it: a reset link that arrives after it
    // has expired is worse than no reset at all.
    defaultPriority: 'CRITICAL',
  }),

  SECURITY_ALERT: defineEvent({
    templateKey: 'account.security_alert',
    description: 'A sign-in or account change that the owner should know about.',
    variables: z.object({
      userName: name,
      alertKind: name,
      occurredAt: formatted,
      ipAddress: name.optional(),
      location: name.optional(),
    }),
    defaultAudience: [{ kind: 'ASSIGNED_USER' }],
    subjectRequirement: 'USER',
    defaultPriority: 'CRITICAL',
  }),
} as const satisfies Record<NotificationEvent, EventDefinition>;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type NotificationEventCatalogue = typeof NOTIFICATION_EVENTS;

/** The variables a given event requires, inferred from its schema. */
export type EventVariables<E extends NotificationEvent> = z.infer<
  NotificationEventCatalogue[E]['variables']
>;

export function eventDefinition<E extends NotificationEvent>(
  event: E,
): NotificationEventCatalogue[E] {
  return NOTIFICATION_EVENTS[event];
}

/**
 * The variable names an event supplies, for seeding `NotificationTemplate.variables`
 * and for `validateTemplate()` in the settings UI. Read off the schema so the list
 * cannot drift from the type.
 */
export function eventVariableNames(event: NotificationEvent): readonly string[] {
  const schema = NOTIFICATION_EVENTS[event].variables;
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  return Object.keys(shape).sort();
}

/**
 * Parse and narrow the variables for an event. Called by `notify()` so that a
 * JavaScript caller, an imported job payload or a re-send from the support UI is
 * held to the same contract the compiler holds a TypeScript call site to.
 */
export function parseEventVariables<E extends NotificationEvent>(
  event: E,
  input: unknown,
): EventVariables<E> {
  return NOTIFICATION_EVENTS[event].variables.parse(input) as EventVariables<E>;
}

/**
 * Events an operator may see and edit templates for, in a stable display order.
 *
 * Typed as a non-empty tuple because callers build a `z.enum()` from it, which
 * requires at least one member. `Object.keys` only promises `string[]`, so the
 * emptiness is checked at module load rather than asserted away — an empty
 * catalogue is a programming error worth failing the process over.
 */
const eventKeys = Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[];

if (eventKeys.length === 0) {
  throw new Error('NOTIFICATION_EVENTS is empty; the notification catalogue cannot be built.');
}

export const NOTIFICATION_EVENT_KEYS: readonly [NotificationEvent, ...NotificationEvent[]] = [
  eventKeys[0]!,
  ...eventKeys.slice(1),
];
