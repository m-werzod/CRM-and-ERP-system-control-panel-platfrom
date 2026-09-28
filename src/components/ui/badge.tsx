import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Status badges.
 *
 * Colour is the ONLY thing most badges vary, so the tone-to-meaning mapping must
 * be global rather than per-screen: green always means "good / settled", amber
 * "needs attention", red "problem / overdue", grey "inactive / draft", blue
 * "in progress". `statusTone()` below enforces that by deriving the tone from the
 * enum value instead of letting each page pick a colour.
 *
 * Colour is never the only signal: the badge always carries its label text, so a
 * colour-blind reader loses nothing.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral:
          'border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[var(--color-text-muted)]',
        accent:
          'border-[var(--color-accent-border)] bg-[var(--color-accent-subtle)] text-[var(--color-accent-text)]',
        success:
          'border-[var(--color-success-border)] bg-[var(--color-success-subtle)] text-[var(--color-success-text)]',
        warning:
          'border-[var(--color-warning-border)] bg-[var(--color-warning-subtle)] text-[var(--color-warning-text)]',
        danger:
          'border-[var(--color-danger-border)] bg-[var(--color-danger-subtle)] text-[var(--color-danger-text)]',
        info: 'border-[var(--color-info-border)] bg-[var(--color-info-subtle)] text-[var(--color-info-text)]',
      },
      size: {
        sm: 'px-1.5 py-px text-2xs',
        md: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** A small leading dot, for dense tables where the label is already short. */
  dot?: boolean;
  icon?: ReactNode;
}

export function Badge({ className, tone, size, dot, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-70" />}
      {icon}
      {children}
    </span>
  );
}

/**
 * The single mapping from a domain enum value to a badge tone.
 *
 * Every status enum in the schema is covered. Unknown values fall back to
 * neutral rather than throwing: a new enum member added by a migration must not
 * crash a list page before its label lands.
 */
const STATUS_TONES: Record<string, BadgeTone> = {
  // settled / healthy
  ACTIVE: 'success',
  PAID: 'success',
  COMPLETED: 'success',
  APPROVED: 'success',
  PRESENT: 'success',
  PASSED: 'success',
  ENROLLED: 'success',
  ACCEPTED: 'success',
  PROCESSED: 'success',
  SENT: 'success',
  DELIVERED: 'success',
  PUBLISHED: 'success',
  ISSUED: 'success',
  HEALTHY: 'success',
  GRADED: 'success',
  ATTENDED: 'success',
  CONFIGURED: 'success',
  AVAILABLE: 'success',

  // needs attention
  PENDING: 'warning',
  PENDING_APPROVAL: 'warning',
  PARTIALLY_PAID: 'warning',
  PARTIALLY_USED: 'warning',
  LATE: 'warning',
  ON_HOLD: 'warning',
  PAUSED: 'warning',
  AWAITING_CONFIRMATION: 'warning',
  UNDER_REVIEW: 'warning',
  WAITLISTED: 'warning',
  PROBATION: 'warning',
  DEGRADED: 'warning',
  LOW_CONFIDENCE: 'warning',
  COMPLETED_WITH_ERRORS: 'warning',
  RESUBMIT_REQUESTED: 'warning',
  HELD: 'warning',
  QUEUED: 'warning',
  VALIDATING: 'warning',

  // problems
  OVERDUE: 'danger',
  ABSENT: 'danger',
  FAILED: 'danger',
  REJECTED: 'danger',
  LOST: 'danger',
  SUSPENDED: 'danger',
  LOCKED: 'danger',
  WITHDRAWN: 'danger',
  TERMINATED: 'danger',
  DEFAULTED: 'danger',
  ERROR: 'danger',
  BOUNCED: 'danger',
  NO_SHOW: 'danger',
  DEAD: 'danger',
  INVALID_SIGNATURE: 'danger',
  REVOKED: 'danger',
  WRITTEN_OFF: 'danger',
  NOT_SUBMITTED: 'danger',

  // in progress / informational
  IN_PROGRESS: 'info',
  RUNNING: 'info',
  SCHEDULED: 'info',
  SUBMITTED: 'info',
  CONTACTED: 'info',
  QUALIFIED: 'info',
  TRIAL_BOOKED: 'info',
  TRIAL_COMPLETED: 'info',
  APPLICATION: 'info',
  INTERVIEW_SCHEDULED: 'info',
  INTERVIEW_COMPLETED: 'info',
  CALCULATED: 'info',
  IMPORTING: 'info',
  RECEIVED: 'info',
  ENROLLING: 'info',
  EXCUSED: 'info',
  REMOTE: 'info',
  ON_LEAVE: 'info',
  MATCHED: 'info',
  NEW: 'accent',

  // inactive / not started
  DRAFT: 'neutral',
  INACTIVE: 'neutral',
  INVITED: 'neutral',
  CANCELLED: 'neutral',
  VOID: 'neutral',
  ARCHIVED: 'neutral',
  EXPIRED: 'neutral',
  CLOSED: 'neutral',
  PLANNED: 'neutral',
  PROSPECT: 'neutral',
  SKIPPED: 'neutral',
  NOT_CONFIGURED: 'neutral',
  NOT_REQUIRED: 'neutral',
  DISABLED: 'neutral',
  OFFLINE: 'neutral',
  UNCONFIGURED: 'neutral',
  GRADUATED: 'accent',
  TRANSFERRED: 'neutral',
  REVERSED: 'neutral',
  REFUNDED: 'neutral',
  EXHAUSTED: 'neutral',
  DUPLICATE: 'neutral',
  NO_MATCH: 'neutral',
  NOT_ENROLLED: 'neutral',
  HOLIDAY: 'neutral',
  HALF_DAY: 'neutral',
  READ: 'neutral',
  RESCHEDULED: 'neutral',
  MULTIPLE_MATCHES: 'warning',
};

export function statusTone(status: string | null | undefined): BadgeTone {
  if (!status) return 'neutral';
  return STATUS_TONES[status] ?? 'neutral';
}

/**
 * A badge whose tone is derived from the status value. `label` is supplied by the
 * caller from the i18n enum dictionary, so this component never hard-codes
 * user-visible text.
 */
export function StatusBadge({
  status,
  label,
  size,
  dot = true,
  className,
}: {
  status: string | null | undefined;
  label: string;
  size?: BadgeProps['size'];
  dot?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={statusTone(status)} size={size} dot={dot} className={className}>
      {label}
    </Badge>
  );
}

/**
 * Attendance uses its own reserved hues (see globals.css) so that present/late/
 * absent/excused read identically in the register, the reports and the charts.
 */
export function AttendanceBadge({
  status,
  label,
  minutesLate,
  size = 'sm',
}: {
  status: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
  label: string;
  minutesLate?: number | null;
  size?: BadgeProps['size'];
}) {
  const tone: BadgeTone = {
    PRESENT: 'success' as const,
    ABSENT: 'danger' as const,
    LATE: 'warning' as const,
    EXCUSED: 'info' as const,
  }[status];

  return (
    <Badge tone={tone} size={size} dot>
      {label}
      {status === 'LATE' && typeof minutesLate === 'number' && minutesLate > 0 && (
        <span className="opacity-75">+{minutesLate}m</span>
      )}
    </Badge>
  );
}

/**
 * Honest integration status. `isReal` distinguishes a working provider from a
 * development mock, which the spec requires the UI to surface rather than hide.
 */
export function IntegrationStatusBadge({
  status,
  label,
  isReal = true,
}: {
  status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'DISABLED';
  label: string;
  isReal?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={statusTone(status)} dot>
        {label}
      </Badge>
      {!isReal && status !== 'NOT_CONFIGURED' && (
        <Badge tone="warning" size="sm">
          Simulated
        </Badge>
      )}
    </span>
  );
}
