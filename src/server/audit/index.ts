/**
 * Audit logging and the operational activity timeline.
 *
 * Two different products from one call site:
 *
 *   AuditLog       compliance. Who did what to which row, the before/after of
 *                  every changed field, the reason, the IP and the request id.
 *                  Written for every sensitive action, append-only at the
 *                  database level, never shown as-is to a receptionist.
 *
 *   ActivityEvent  the human timeline on a student / lead / invoice page.
 *                  Curated prose, safe for any staff member who can see the
 *                  record.
 *
 * `record()` writes the audit row and optionally the timeline entry in the SAME
 * transaction as the change it describes. That matters: an audit trail written
 * after commit can be lost, and one written outside the transaction can describe
 * a change that rolled back. Passing `tx` is therefore strongly preferred.
 */

import type { Prisma } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { logger } from '@/server/observability/logger';
import type { AccessContext } from '@/server/rbac/access';

export type AuditSeverityValue = 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';

export type ActivitySubject =
  | 'STUDENT'
  | 'LEAD'
  | 'APPLICATION'
  | 'EMPLOYEE'
  | 'TEACHER'
  | 'GROUP'
  | 'INVOICE'
  | 'GUARDIAN';

/** `{ field: { from, to } }` for the fields that actually changed. */
export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export interface AuditInput {
  /** Dotted action key, e.g. `payment.refunded`. Stable; used for filtering. */
  readonly action: string;
  /** Prisma model name, e.g. `Invoice`. */
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly branchId?: string | null;
  /** One line describing what happened, for the audit list. */
  readonly summary?: string;
  readonly changes?: FieldChanges | null;
  /** Mandatory for corrections, adjustments, refunds and permission changes. */
  readonly reason?: string | null;
  readonly severity?: AuditSeverityValue;
  /** Extra machine context. Runs through the logger's redaction rules. */
  readonly metadata?: Record<string, unknown>;

  /** When set, a matching timeline entry is written too. */
  readonly timeline?: {
    readonly subjectType: ActivitySubject;
    readonly subjectId: string;
    /** Dotted type key picking an icon and colour, e.g. `payment.received`. */
    readonly type: string;
    readonly title: string;
    readonly description?: string | null;
    readonly occurredAt?: Date;
    readonly metadata?: Record<string, unknown>;
  } | null;
}

/**
 * Values that must never reach an audit row even as a "changed field". A diff of
 * a user update legitimately includes `passwordHash`; storing its before/after
 * would put two password hashes in a table many people can read.
 */
const NEVER_AUDIT_FIELDS = new Set([
  'passwordHash',
  'twoFactorSecret',
  'tokenHash',
  'csrfTokenHash',
  'codeHash',
  'apiKeyHash',
  'externalRef',
  'templateRef',
]);

/** Fields whose values are recorded only as "set"/"cleared", never verbatim. */
const MASK_ONLY_FIELDS = new Set(['nationalIdLast4', 'bankAccountLast4']);

function sanitizeChanges(changes: FieldChanges | null | undefined): Prisma.InputJsonValue | undefined {
  if (!changes) return undefined;
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, pair] of Object.entries(changes)) {
    if (NEVER_AUDIT_FIELDS.has(field)) {
      out[field] = { from: '[redacted]', to: '[redacted]' };
      continue;
    }
    if (MASK_ONLY_FIELDS.has(field)) {
      out[field] = { from: pair.from == null ? null : '[set]', to: pair.to == null ? null : '[set]' };
      continue;
    }
    out[field] = { from: jsonSafe(pair.from), to: jsonSafe(pair.to) };
  }
  return out as Prisma.InputJsonValue;
}

/** BigInt and Date are not JSON-serialisable; normalise them losslessly. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

/**
 * Compute the changed fields between two versions of a row. Only fields present
 * in `next` are considered, so a partial update does not report every untouched
 * column as "changed to undefined".
 */
export function diffFields<T extends Record<string, unknown>>(
  previous: T,
  next: Partial<T>,
): FieldChanges {
  const changes: FieldChanges = {};
  for (const [field, nextValue] of Object.entries(next)) {
    if (nextValue === undefined) continue;
    const previousValue = previous[field];
    if (equalForAudit(previousValue, nextValue)) continue;
    changes[field] = { from: previousValue, to: nextValue };
  }
  return changes;
}

function equalForAudit(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date && typeof b === 'string') return a.toISOString() === new Date(b).toISOString();
  if (typeof a === 'bigint' || typeof b === 'bigint') return String(a) === String(b);
  if (a == null && b == null) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(jsonSafe(a)) === JSON.stringify(jsonSafe(b));
  }
  return false;
}

/**
 * Write an audit entry, and a timeline entry when one is described.
 *
 * Pass the ambient `tx` whenever the audit describes a change made in a
 * transaction, so the record and the change commit or roll back together.
 */
export async function record(
  ctx: AccessContext,
  input: AuditInput,
  db: Db = prisma,
): Promise<void> {
  const severity = input.severity ?? 'INFO';

  try {
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        branchId: input.branchId ?? null,
        actorUserId: ctx.isSystem ? null : ctx.userId,
        actorLabel: ctx.displayName,
        actorType: ctx.isSystem ? 'system' : 'user',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary ?? null,
        changes: sanitizeChanges(input.changes),
        reason: input.reason ?? null,
        severity,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        requestId: ctx.requestId,
      },
    });

    if (input.timeline) {
      await db.activityEvent.create({
        data: {
          organizationId: ctx.organizationId,
          subjectType: input.timeline.subjectType,
          subjectId: input.timeline.subjectId,
          type: input.timeline.type,
          title: input.timeline.title,
          description: input.timeline.description ?? null,
          actorUserId: ctx.isSystem ? null : ctx.userId,
          actorLabel: ctx.displayName,
          occurredAt: input.timeline.occurredAt ?? new Date(),
          metadata: input.timeline.metadata
            ? (jsonSafe(input.timeline.metadata) as Prisma.InputJsonValue)
            : undefined,
        },
      });
    }
  } catch (error) {
    // An audit write must never be the reason a legitimate business action
    // fails... EXCEPT when it is describing a sensitive change, where losing the
    // record is worse than losing the action. See docs/SECURITY.md.
    logger.error('audit.write_failed', {
      requestId: ctx.requestId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      severity,
      error,
    });
    if (severity === 'CRITICAL' || severity === 'WARNING') throw error;
  }

  logger.info('audit', {
    requestId: ctx.requestId,
    organizationId: ctx.organizationId,
    branchId: input.branchId,
    userId: ctx.isSystem ? null : ctx.userId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    severity,
    ...input.metadata,
  });
}

/**
 * Timeline-only entry, for events that are operationally interesting but carry no
 * compliance weight (a note added, a call logged).
 */
export async function recordActivity(
  ctx: AccessContext,
  input: NonNullable<AuditInput['timeline']>,
  db: Db = prisma,
): Promise<void> {
  await db.activityEvent.create({
    data: {
      organizationId: ctx.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      actorUserId: ctx.isSystem ? null : ctx.userId,
      actorLabel: ctx.displayName,
      occurredAt: input.occurredAt ?? new Date(),
      metadata: input.metadata ? (jsonSafe(input.metadata) as Prisma.InputJsonValue) : undefined,
    },
  });
}

/**
 * Standard audit actions. Using these constants rather than inline strings keeps
 * the action vocabulary consistent, which is what makes the audit log filterable.
 */
export const AUDIT_ACTIONS = {
  // auth
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password.changed',
  PASSWORD_RESET_REQUESTED: 'auth.password.reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password.reset_completed',
  PASSWORD_RESET_BY_ADMIN: 'auth.password.reset_by_admin',
  ACCOUNT_LOCKED: 'auth.account.locked',
  TWO_FACTOR_ENABLED: 'auth.two_factor.enabled',
  TWO_FACTOR_DISABLED: 'auth.two_factor.disabled',
  SESSIONS_REVOKED: 'auth.sessions.revoked',

  // users & rbac
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  ROLE_GRANTED: 'user.role.granted',
  ROLE_REVOKED: 'user.role.revoked',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions.changed',
  BRANCH_ACCESS_CHANGED: 'user.branch_access.changed',

  // students & people
  STUDENT_CREATED: 'student.created',
  STUDENT_UPDATED: 'student.updated',
  STUDENT_ARCHIVED: 'student.archived',
  STUDENT_RESTORED: 'student.restored',
  STUDENT_ENROLLED: 'student.enrolled',
  STUDENT_TRANSFERRED: 'student.transferred',
  STUDENT_WITHDRAWN: 'student.withdrawn',
  STUDENT_GRADUATED: 'student.graduated',
  GUARDIAN_CREATED: 'guardian.created',
  GUARDIAN_LINKED: 'guardian.linked',
  GUARDIAN_UNLINKED: 'guardian.unlinked',

  // crm
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_STATUS_CHANGED: 'lead.status.changed',
  LEAD_CONVERTED: 'lead.converted',
  LEAD_LOST: 'lead.lost',
  LEAD_MERGED: 'lead.merged',

  // admissions
  APPLICATION_CREATED: 'application.created',
  APPLICATION_SUBMITTED: 'application.submitted',
  APPLICATION_REVIEWED: 'application.reviewed',
  APPLICATION_DECIDED: 'application.decided',

  // academics
  GROUP_CREATED: 'group.created',
  GROUP_UPDATED: 'group.updated',
  TEACHER_ASSIGNED: 'group.teacher.assigned',
  TEACHER_UNASSIGNED: 'group.teacher.unassigned',
  LESSON_CANCELLED: 'lesson.cancelled',
  LESSON_RESCHEDULED: 'lesson.rescheduled',
  SCHEDULE_CHANGED: 'schedule.changed',

  // attendance
  ATTENDANCE_SUBMITTED: 'attendance.submitted',
  ATTENDANCE_CORRECTED: 'attendance.corrected',
  ATTENDANCE_APPROVED: 'attendance.approved',
  BIOMETRIC_ENROLLED: 'attendance.biometric.enrolled',
  BIOMETRIC_REVOKED: 'attendance.biometric.revoked',
  BIOMETRIC_CONSENT_GRANTED: 'attendance.biometric.consent_granted',
  BIOMETRIC_CONSENT_REVOKED: 'attendance.biometric.consent_revoked',
  DEVICE_REGISTERED: 'attendance.device.registered',

  // assessment
  EXAM_CREATED: 'exam.created',
  EXAM_GRADED: 'exam.graded',
  EXAM_RESULTS_PUBLISHED: 'exam.results.published',
  GRADE_CHANGED: 'grade.changed',
  CERTIFICATE_ISSUED: 'certificate.issued',
  CERTIFICATE_REVOKED: 'certificate.revoked',

  // finance
  INVOICE_CREATED: 'invoice.created',
  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_CANCELLED: 'invoice.cancelled',
  INVOICE_VOIDED: 'invoice.voided',
  INVOICE_WRITTEN_OFF: 'invoice.written_off',
  PAYMENT_RECORDED: 'payment.recorded',
  PAYMENT_REVERSED: 'payment.reversed',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_APPROVED: 'refund.approved',
  REFUND_REJECTED: 'refund.rejected',
  REFUND_PROCESSED: 'refund.processed',
  DISCOUNT_CREATED: 'discount.created',
  DISCOUNT_APPLIED: 'discount.applied',
  DISCOUNT_APPROVED: 'discount.approved',
  TUITION_UPDATED: 'fee_plan.student_assignment.updated',
  FINANCIAL_ADJUSTMENT: 'finance.adjustment.recorded',
  CREDIT_ISSUED: 'finance.credit.issued',

  // hr
  EMPLOYEE_CREATED: 'employee.created',
  EMPLOYEE_UPDATED: 'employee.updated',
  EMPLOYEE_TERMINATED: 'employee.terminated',
  SALARY_CHANGED: 'employee.salary.changed',
  LEAVE_REQUESTED: 'leave.requested',
  LEAVE_DECIDED: 'leave.decided',
  PAYROLL_CALCULATED: 'payroll.calculated',
  PAYROLL_APPROVED: 'payroll.approved',
  PAYROLL_PAID: 'payroll.paid',

  // documents & communication
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_DELETED: 'document.deleted',
  DOCUMENT_ACCESSED: 'document.accessed',
  ANNOUNCEMENT_PUBLISHED: 'announcement.published',
  NOTIFICATION_SENT: 'notification.sent',
  TEMPLATE_UPDATED: 'notification.template.updated',

  // platform
  SETTING_CHANGED: 'setting.changed',
  INTEGRATION_CONFIGURED: 'integration.configured',
  IMPORT_COMPLETED: 'import.completed',
  EXPORT_GENERATED: 'export.generated',
  DATA_EXPORTED: 'data.exported',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Actions that must be recorded at NOTICE or above. Anything touching money,
 * permissions, biometrics or bulk data export is inherently review-worthy.
 */
export const ELEVATED_ACTIONS: ReadonlySet<string> = new Set<string>([
  AUDIT_ACTIONS.PAYMENT_REVERSED,
  AUDIT_ACTIONS.REFUND_APPROVED,
  AUDIT_ACTIONS.REFUND_PROCESSED,
  AUDIT_ACTIONS.INVOICE_VOIDED,
  AUDIT_ACTIONS.INVOICE_WRITTEN_OFF,
  AUDIT_ACTIONS.FINANCIAL_ADJUSTMENT,
  AUDIT_ACTIONS.TUITION_UPDATED,
  AUDIT_ACTIONS.DISCOUNT_APPROVED,
  AUDIT_ACTIONS.ROLE_GRANTED,
  AUDIT_ACTIONS.ROLE_REVOKED,
  AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
  AUDIT_ACTIONS.BRANCH_ACCESS_CHANGED,
  AUDIT_ACTIONS.USER_DEACTIVATED,
  AUDIT_ACTIONS.PASSWORD_RESET_BY_ADMIN,
  AUDIT_ACTIONS.ATTENDANCE_CORRECTED,
  AUDIT_ACTIONS.BIOMETRIC_ENROLLED,
  AUDIT_ACTIONS.BIOMETRIC_REVOKED,
  AUDIT_ACTIONS.SETTING_CHANGED,
  AUDIT_ACTIONS.INTEGRATION_CONFIGURED,
  AUDIT_ACTIONS.DATA_EXPORTED,
  AUDIT_ACTIONS.CERTIFICATE_REVOKED,
]);

export function severityFor(action: string): AuditSeverityValue {
  return ELEVATED_ACTIONS.has(action) ? 'NOTICE' : 'INFO';
}
