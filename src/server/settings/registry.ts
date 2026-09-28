/**
 * The settings registry.
 *
 * Every configurable business rule in the platform is declared here once, with a
 * type, a default and a validator. Nothing in the codebase may hard-code a late
 * threshold, a payment due window, an attendance weight or an invoice prefix --
 * it reads the setting instead, which is what makes the same code serve an
 * institution that counts a late arrival as a full presence and one that counts
 * it as half.
 *
 * Resolution order (see `./index.ts`):
 *   branch-scoped row  ->  organisation-scoped row  ->  the default below
 *
 * A setting's `scope` says where it may be overridden. `ORGANIZATION_ONLY`
 * settings (currency, timezone, academic year) must not diverge per branch,
 * because invoices and reports would stop aggregating.
 */

import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '@/lib/money';

export type SettingOverrideScope = 'ORGANIZATION_ONLY' | 'BRANCH_OVERRIDABLE';

export interface SettingDefinition<T> {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  readonly defaultValue: T;
  readonly scope: SettingOverrideScope;
  /** Changing this affects money or access; edits are audited at NOTICE or above. */
  readonly sensitive?: boolean;
}

/**
 * Declare a setting.
 *
 * The value type is inferred from the SCHEMA alone (`z.infer<S>`), not from the
 * schema and `defaultValue` together. Inferring from both lets TypeScript widen:
 * a `defaultValue` of `['MONDAY', 'TUESDAY']` is a plain `string[]` literal, so
 * `T` resolved to `string[]` and every consumer of `settings.workingDays`
 * received `string[]` instead of the weekday union — which then failed at the
 * first function that wanted the narrow type. Making the schema the single source
 * of truth keeps the narrow type all the way to the call site, and `defaultValue`
 * is checked against it rather than defining it.
 */
function setting<S extends z.ZodTypeAny>(definition: {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly schema: S;
  readonly defaultValue: z.infer<S>;
  readonly scope: SettingOverrideScope;
  readonly sensitive?: boolean;
}): SettingDefinition<z.infer<S>> {
  // Belt and braces: the type above makes a wrong default a compile error, and
  // this makes a schema refinement the type system cannot see (a `.min(1)`, a
  // `.refine`) a load-time error rather than a runtime surprise.
  const parsed = definition.schema.safeParse(definition.defaultValue);
  if (!parsed.success) {
    throw new Error(
      `Setting "${definition.key}" has a default that fails its own schema: ${parsed.error.message}`,
    );
  }
  return definition as SettingDefinition<z.infer<S>>;
}

const percentPpm = z.number().int().min(0).max(1_000_000);

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export const ATTENDANCE_SETTINGS = {
  /**
   * Arriving within this many minutes of the start is PRESENT; beyond it, LATE.
   * Beyond `absentAfterMinutes`, the student is ABSENT.
   */
  lateThresholdMinutes: setting({
    key: 'attendance.lateThresholdMinutes',
    group: 'attendance',
    label: 'Late after (minutes)',
    description:
      'A student arriving more than this many minutes after the lesson starts is marked late.',
    schema: z.number().int().min(0).max(240),
    defaultValue: 10,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  absentAfterMinutes: setting({
    key: 'attendance.absentAfterMinutes',
    group: 'attendance',
    label: 'Absent after (minutes)',
    description:
      'A student arriving more than this many minutes late is recorded absent rather than late.',
    schema: z.number().int().min(1).max(600),
    defaultValue: 30,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /**
   * Weights used to compute an attendance percentage, in ppm of a full
   * attendance. An institution that treats a late arrival as half-present sets
   * `late` to 500000.
   */
  statusWeightsPpm: setting({
    key: 'attendance.statusWeightsPpm',
    group: 'attendance',
    label: 'Attendance weights',
    description:
      'How each status contributes to an attendance percentage. 1000000 = counts as a full attendance.',
    schema: z.object({
      PRESENT: percentPpm,
      LATE: percentPpm,
      EXCUSED: percentPpm,
      ABSENT: percentPpm,
    }),
    defaultValue: { PRESENT: 1_000_000, LATE: 1_000_000, EXCUSED: 1_000_000, ABSENT: 0 },
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /**
   * Whether EXCUSED lessons count in the denominator. Excluding them means an
   * authorised absence neither helps nor harms the percentage.
   */
  excusedCountsInDenominator: setting({
    key: 'attendance.excusedCountsInDenominator',
    group: 'attendance',
    label: 'Count excused lessons in the total',
    description:
      'When off, excused absences are removed from both sides of the attendance percentage.',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /**
   * How long after submitting a register the teacher may still amend it without
   * an administrator. 0 means submission is final.
   */
  teacherEditWindowMinutes: setting({
    key: 'attendance.teacherEditWindowMinutes',
    group: 'attendance',
    label: 'Teacher edit window (minutes)',
    description:
      'After submitting attendance, how long a teacher may still change it themselves.',
    schema: z.number().int().min(0).max(60 * 24 * 7),
    defaultValue: 120,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  requireCorrectionApproval: setting({
    key: 'attendance.requireCorrectionApproval',
    group: 'attendance',
    label: 'Corrections need approval',
    description:
      'When on, an attendance correction stays pending until a user with attendance.approve signs it off.',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'BRANCH_OVERRIDABLE',
    sensitive: true,
  }),

  requireCorrectionReason: setting({
    key: 'attendance.requireCorrectionReason',
    group: 'attendance',
    label: 'Corrections need a written reason',
    description: 'When on, an attendance correction cannot be saved without a reason.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Auto-mark students absent this long after a lesson ends if nobody submitted. */
  autoAbsentAfterLessonMinutes: setting({
    key: 'attendance.autoAbsentAfterLessonMinutes',
    group: 'attendance',
    label: 'Auto-absent after lesson (minutes)',
    description:
      'If a register is never submitted, mark the roster absent this long after the lesson ends. 0 disables it.',
    schema: z.number().int().min(0).max(60 * 24 * 14),
    defaultValue: 0,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Consecutive absences that trigger a parent notification and a follow-up task. */
  consecutiveAbsenceAlertThreshold: setting({
    key: 'attendance.consecutiveAbsenceAlertThreshold',
    group: 'attendance',
    label: 'Alert after consecutive absences',
    description: 'Notify guardians and raise a follow-up after this many absences in a row.',
    schema: z.number().int().min(1).max(30),
    defaultValue: 3,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Attendance percentage below which a student is flagged at risk. */
  atRiskBelowPercentPpm: setting({
    key: 'attendance.atRiskBelowPercentPpm',
    group: 'attendance',
    label: 'At-risk attendance threshold',
    description: 'Flag a student whose attendance falls below this percentage.',
    schema: percentPpm,
    defaultValue: 750_000,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Seconds a QR attendance token stays valid before rotating. */
  qrTokenTtlSeconds: setting({
    key: 'attendance.qrTokenTtlSeconds',
    group: 'attendance',
    label: 'QR code lifetime (seconds)',
    description:
      'How long a displayed attendance QR code remains valid. Shorter is harder to share as a screenshot.',
    schema: z.number().int().min(10).max(900),
    defaultValue: 60,
    scope: 'BRANCH_OVERRIDABLE',
  }),
} as const;

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export const FINANCE_SETTINGS = {
  currency: setting({
    key: 'finance.currency',
    group: 'finance',
    label: 'Currency',
    description: 'The currency invoices and payments are denominated in.',
    schema: z.enum(SUPPORTED_CURRENCIES),
    defaultValue: 'UZS',
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  paymentDueDays: setting({
    key: 'finance.paymentDueDays',
    group: 'finance',
    label: 'Payment due after (days)',
    description: 'Default number of days after issue that an invoice falls due.',
    schema: z.number().int().min(0).max(365),
    defaultValue: 10,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  invoiceNumberPrefix: setting({
    key: 'finance.invoiceNumberPrefix',
    group: 'finance',
    label: 'Invoice number prefix',
    description: 'Prefix for generated invoice numbers, e.g. INV in INV-2026-000123.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'INV',
    scope: 'ORGANIZATION_ONLY',
  }),

  paymentNumberPrefix: setting({
    key: 'finance.paymentNumberPrefix',
    group: 'finance',
    label: 'Payment number prefix',
    description: 'Prefix for generated payment receipt numbers.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'PAY',
    scope: 'ORGANIZATION_ONLY',
  }),

  refundNumberPrefix: setting({
    key: 'finance.refundNumberPrefix',
    group: 'finance',
    label: 'Refund number prefix',
    description: 'Prefix for generated refund numbers.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'REF',
    scope: 'ORGANIZATION_ONLY',
  }),

  /** Refunds at or above this amount require a second approver. 0 = always. */
  refundApprovalThresholdMinor: setting({
    key: 'finance.refundApprovalThresholdMinor',
    group: 'finance',
    label: 'Refund approval threshold',
    description:
      'Refunds of this amount or more need approval from a user with payments.approveRefund. Set 0 to require approval for every refund.',
    schema: z.string().regex(/^\d{1,19}$/, 'Whole number of minor units'),
    defaultValue: '0',
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  /** Discounts above this percentage need approval regardless of the discount's own flag. */
  discountApprovalAbovePercentPpm: setting({
    key: 'finance.discountApprovalAbovePercentPpm',
    group: 'finance',
    label: 'Discount approval threshold',
    description: 'Any discount above this percentage requires approval.',
    schema: percentPpm,
    defaultValue: 200_000,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  allowOverpayment: setting({
    key: 'finance.allowOverpayment',
    group: 'finance',
    label: 'Allow overpayment',
    description:
      'When on, a payment larger than the balance is accepted and the remainder becomes student credit. When off, it is rejected.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  /** Days past due at which each ageing bucket starts, for the debt report. */
  debtAgingBuckets: setting({
    key: 'finance.debtAgingBuckets',
    group: 'finance',
    label: 'Debt ageing buckets (days)',
    description: 'Upper bound in days for each ageing bucket. The final bucket is open-ended.',
    schema: z.array(z.number().int().min(1).max(3650)).min(1).max(8),
    defaultValue: [7, 30, 60],
    scope: 'ORGANIZATION_ONLY',
  }),

  lateFeeEnabled: setting({
    key: 'finance.lateFeeEnabled',
    group: 'finance',
    label: 'Charge late fees',
    description: 'When on, overdue invoices accrue a late fee.',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  lateFeePercentPpm: setting({
    key: 'finance.lateFeePercentPpm',
    group: 'finance',
    label: 'Late fee percentage',
    description: 'Percentage of the outstanding balance charged as a late fee.',
    schema: percentPpm,
    defaultValue: 0,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  taxEnabled: setting({
    key: 'finance.taxEnabled',
    group: 'finance',
    label: 'Apply tax to invoices',
    description: 'When on, invoice lines carry the default tax rate.',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  /** Days before the due date that a reminder is sent. */
  paymentReminderDaysBefore: setting({
    key: 'finance.paymentReminderDaysBefore',
    group: 'finance',
    label: 'Payment reminder (days before due)',
    description: 'Send a reminder this many days before an invoice falls due.',
    schema: z.array(z.number().int().min(0).max(90)).max(5),
    defaultValue: [3],
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Days after the due date that overdue reminders are sent. */
  overdueReminderDaysAfter: setting({
    key: 'finance.overdueReminderDaysAfter',
    group: 'finance',
    label: 'Overdue reminder (days after due)',
    description: 'Send overdue reminders this many days after an invoice falls due.',
    schema: z.array(z.number().int().min(0).max(365)).max(6),
    defaultValue: [1, 7, 14, 30],
    scope: 'BRANCH_OVERRIDABLE',
  }),
} as const;

// ---------------------------------------------------------------------------
// Academic
// ---------------------------------------------------------------------------

export const ACADEMIC_SETTINGS = {
  studentCodePrefix: setting({
    key: 'academic.studentCodePrefix',
    group: 'academic',
    label: 'Student code prefix',
    description: 'Prefix for generated student codes, e.g. STU in STU-000412.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'STU',
    scope: 'ORGANIZATION_ONLY',
  }),

  employeeCodePrefix: setting({
    key: 'academic.employeeCodePrefix',
    group: 'academic',
    label: 'Employee code prefix',
    description: 'Prefix for generated employee codes.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'EMP',
    scope: 'ORGANIZATION_ONLY',
  }),

  applicationNumberPrefix: setting({
    key: 'academic.applicationNumberPrefix',
    group: 'academic',
    label: 'Application number prefix',
    description: 'Prefix for generated application numbers.',
    schema: z.string().trim().min(1).max(10).regex(/^[A-Z0-9-]+$/, 'Use upper-case letters, digits or dashes'),
    defaultValue: 'APP',
    scope: 'ORGANIZATION_ONLY',
  }),

  /** Allow enrolling beyond a group's declared capacity. */
  allowGroupOvercapacity: setting({
    key: 'academic.allowGroupOvercapacity',
    group: 'academic',
    label: 'Allow enrolment beyond capacity',
    description: 'When off, enrolling into a full group is rejected.',
    schema: z.boolean(),
    defaultValue: false,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  passMarkPercentPpm: setting({
    key: 'academic.passMarkPercentPpm',
    group: 'academic',
    label: 'Default pass mark',
    description: 'Pass mark used when an exam does not specify one.',
    schema: percentPpm,
    defaultValue: 600_000,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** How many weeks ahead lessons are generated from the timetable. */
  lessonGenerationHorizonWeeks: setting({
    key: 'academic.lessonGenerationHorizonWeeks',
    group: 'academic',
    label: 'Generate lessons ahead (weeks)',
    description: 'How far into the future the scheduler materialises lessons from the timetable.',
    schema: z.number().int().min(1).max(52),
    defaultValue: 8,
    scope: 'ORGANIZATION_ONLY',
  }),

  /** Days of the week the institution normally operates. */
  workingDays: setting({
    key: 'academic.workingDays',
    group: 'academic',
    label: 'Working days',
    description: 'Days the institution normally teaches. Used by the timetable and HR calendars.',
    schema: z
      .array(z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']))
      .min(1)
      .max(7),
    defaultValue: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
    scope: 'BRANCH_OVERRIDABLE',
  }),
} as const;

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

export const CRM_SETTINGS = {
  /** Hours within which a new lead must be contacted before it is flagged. */
  firstContactSlaHours: setting({
    key: 'crm.firstContactSlaHours',
    group: 'crm',
    label: 'First contact SLA (hours)',
    description: 'Flag a new lead that has not been contacted within this many hours.',
    schema: z.number().int().min(1).max(24 * 30),
    defaultValue: 24,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  defaultFollowUpDays: setting({
    key: 'crm.defaultFollowUpDays',
    group: 'crm',
    label: 'Default follow-up interval (days)',
    description: 'How far ahead a follow-up task is scheduled when no date is given.',
    schema: z.number().int().min(1).max(90),
    defaultValue: 2,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  /** Auto-mark an untouched lead as lost after this many days. 0 disables it. */
  autoLoseAfterDaysInactive: setting({
    key: 'crm.autoLoseAfterDaysInactive',
    group: 'crm',
    label: 'Auto-lose stale leads after (days)',
    description: 'Mark a lead lost after this many days with no activity. 0 disables it.',
    schema: z.number().int().min(0).max(365),
    defaultValue: 0,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  duplicateDetectionEnabled: setting({
    key: 'crm.duplicateDetectionEnabled',
    group: 'crm',
    label: 'Warn about duplicate leads',
    description: 'Check the phone number and email against existing leads and students on creation.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'ORGANIZATION_ONLY',
  }),

  /** Agents may only see their own leads unless they hold leads.viewAll. */
  agentsSeeOnlyOwnLeads: setting({
    key: 'crm.agentsSeeOnlyOwnLeads',
    group: 'crm',
    label: 'Agents see only their own leads',
    description: 'When on, a sales agent cannot browse another agent’s pipeline.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'ORGANIZATION_ONLY',
  }),
} as const;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_SETTINGS = {
  /** Channels attempted, in order, until one succeeds for a given recipient. */
  channelPriority: setting({
    key: 'notifications.channelPriority',
    group: 'notifications',
    label: 'Channel priority',
    description: 'Order in which delivery channels are attempted.',
    schema: z.array(z.enum(['IN_APP', 'SMS', 'TELEGRAM', 'EMAIL', 'WHATSAPP', 'PUSH'])).min(1),
    defaultValue: ['IN_APP', 'SMS', 'TELEGRAM', 'EMAIL'],
    scope: 'ORGANIZATION_ONLY',
  }),

  /** Local wall-clock window outside which non-critical messages are held. */
  quietHours: setting({
    key: 'notifications.quietHours',
    group: 'notifications',
    label: 'Quiet hours',
    description:
      'Non-critical notifications are held until the window ends. Times are local to the branch.',
    schema: z.object({
      enabled: z.boolean(),
      fromMinute: z.number().int().min(0).max(1439),
      toMinute: z.number().int().min(0).max(1439),
    }),
    defaultValue: { enabled: true, fromMinute: 21 * 60, toMinute: 8 * 60 },
    scope: 'BRANCH_OVERRIDABLE',
  }),

  notifyGuardianOnAbsence: setting({
    key: 'notifications.notifyGuardianOnAbsence',
    group: 'notifications',
    label: 'Notify guardians about absences',
    description: 'Send a guardian a message when their child is marked absent.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  notifyGuardianOnPayment: setting({
    key: 'notifications.notifyGuardianOnPayment',
    group: 'notifications',
    label: 'Send payment receipts to guardians',
    description: 'Send a confirmation when a payment is recorded.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'BRANCH_OVERRIDABLE',
  }),

  maxDeliveryAttempts: setting({
    key: 'notifications.maxDeliveryAttempts',
    group: 'notifications',
    label: 'Maximum delivery attempts',
    description: 'How many times a failed notification is retried before being abandoned.',
    schema: z.number().int().min(1).max(10),
    defaultValue: 3,
    scope: 'ORGANIZATION_ONLY',
  }),
} as const;

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export const SECURITY_SETTINGS = {
  passwordExpiryDays: setting({
    key: 'security.passwordExpiryDays',
    group: 'security',
    label: 'Password expiry (days)',
    description: 'Force a password change after this many days. 0 disables expiry.',
    schema: z.number().int().min(0).max(3650),
    defaultValue: 0,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  require2faForRoles: setting({
    key: 'security.require2faForRoles',
    group: 'security',
    label: 'Require two-factor for roles',
    description: 'Users holding any of these roles must set up two-factor authentication.',
    schema: z.array(z.string().min(1).max(40)).max(20),
    defaultValue: [],
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  documentAccessLogging: setting({
    key: 'security.documentAccessLogging',
    group: 'security',
    label: 'Log document access',
    description: 'Record every view and download of a document.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  auditRetentionDays: setting({
    key: 'security.auditRetentionDays',
    group: 'security',
    label: 'Audit log retention (days)',
    description: 'How long audit entries are kept. 0 keeps them indefinitely.',
    schema: z.number().int().min(0).max(3650 * 3),
    defaultValue: 0,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  /** Biometric enrolment requires a recorded consent row. */
  requireBiometricConsent: setting({
    key: 'security.requireBiometricConsent',
    group: 'security',
    label: 'Require biometric consent',
    description:
      'Refuse to enrol a face or other biometric template without a recorded, unrevoked consent.',
    schema: z.boolean(),
    defaultValue: true,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  /** Below this age, biometric consent must come from a guardian. */
  biometricGuardianConsentUnderAge: setting({
    key: 'security.biometricGuardianConsentUnderAge',
    group: 'security',
    label: 'Guardian consent required under age',
    description: 'Students younger than this need a guardian to give biometric consent.',
    schema: z.number().int().min(0).max(21),
    defaultValue: 18,
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),
} as const;

// ---------------------------------------------------------------------------
// Localisation
// ---------------------------------------------------------------------------

export const LOCALE_SETTINGS = {
  defaultLocale: setting({
    key: 'locale.defaultLocale',
    group: 'locale',
    label: 'Default language',
    description: 'Language used for users and notifications that express no preference.',
    schema: z.enum(['UZ', 'RU', 'EN']),
    defaultValue: 'UZ',
    scope: 'ORGANIZATION_ONLY',
  }),

  enabledLocales: setting({
    key: 'locale.enabledLocales',
    group: 'locale',
    label: 'Available languages',
    description: 'Languages users may choose from.',
    schema: z.array(z.enum(['UZ', 'RU', 'EN'])).min(1),
    defaultValue: ['UZ', 'RU', 'EN'],
    scope: 'ORGANIZATION_ONLY',
  }),

  timezone: setting({
    key: 'locale.timezone',
    group: 'locale',
    label: 'Timezone',
    description: 'Timezone used to interpret calendar days and display times.',
    schema: z.string().min(1).max(64),
    defaultValue: 'Asia/Tashkent',
    scope: 'ORGANIZATION_ONLY',
    sensitive: true,
  }),

  weekStartsOn: setting({
    key: 'locale.weekStartsOn',
    group: 'locale',
    label: 'Week starts on',
    description: 'First day of the week in calendars and weekly reports.',
    schema: z.enum(['MONDAY', 'SUNDAY']),
    defaultValue: 'MONDAY',
    scope: 'ORGANIZATION_ONLY',
  }),
} as const;

// ---------------------------------------------------------------------------
// Flat registry
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the registry is deliberately
   heterogeneous: each entry carries its own value type, and the typed accessors in
   ./index.ts recover it. Widening to `any` happens only for this lookup table. */
export const SETTINGS_REGISTRY = {
  ...ATTENDANCE_SETTINGS,
  ...FINANCE_SETTINGS,
  ...ACADEMIC_SETTINGS,
  ...CRM_SETTINGS,
  ...NOTIFICATION_SETTINGS,
  ...SECURITY_SETTINGS,
  ...LOCALE_SETTINGS,
} as const;

type Registry = typeof SETTINGS_REGISTRY;

/** Property name of a setting, e.g. `lateThresholdMinutes`. */
export type SettingName = keyof Registry;

/** The value type a given setting resolves to. */
export type SettingValue<K extends SettingName> =
  Registry[K] extends SettingDefinition<infer V> ? V : never;

/** All definitions as a flat list, for the settings UI and the seed. */
export const ALL_SETTINGS: readonly SettingDefinition<any>[] = Object.values(SETTINGS_REGISTRY);

const BY_KEY = new Map<string, SettingDefinition<any>>(
  ALL_SETTINGS.map((definition) => [definition.key, definition]),
);

export function settingByKey(key: string): SettingDefinition<any> | undefined {
  return BY_KEY.get(key);
}

/** Groups in display order, for rendering the settings screens. */
export const SETTING_GROUPS = [
  'locale',
  'academic',
  'attendance',
  'finance',
  'crm',
  'notifications',
  'security',
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

export function settingsInGroup(group: SettingGroup): readonly SettingDefinition<any>[] {
  return ALL_SETTINGS.filter((definition) => definition.group === group);
}

/** Guard against two definitions colliding on the same stored key. */
(function assertKeysUnique(): void {
  const seen = new Set<string>();
  for (const definition of ALL_SETTINGS) {
    if (seen.has(definition.key)) {
      throw new Error(`Duplicate setting key "${definition.key}" in SETTINGS_REGISTRY`);
    }
    seen.add(definition.key);
  }
})();
