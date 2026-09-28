/**
 * The job registry.
 *
 * Every background job the platform runs is *declared* here -- its name, its
 * payload schema, which queue it belongs to and how many attempts it gets -- and
 * *implemented* elsewhere. The split matters:
 *
 *  - `enqueue()` needs only the declaration, so a Next.js request can validate
 *    and queue a job without pulling every handler (and its service, and its
 *    transitive imports) into the server bundle.
 *  - The worker calls `registerBuiltInHandlers()` and gets the bodies.
 *
 * Declaring the schema next to the name is what makes a bad payload fail at the
 * call site instead of at 03:00 inside a worker. `JobPayload<'...'>` is inferred
 * from the zod schema, so the compiler rejects the wrong shape before it is ever
 * serialised.
 *
 * NOTE ON CRON-TRIGGERED JOBS: a `CronSchedule` row may carry no payload at all,
 * so every job a schedule can fire must accept `{}`. That is why the sweep jobs
 * below have no required fields -- an absent `organizationId` means "every
 * organisation", which is what a platform-wide schedule wants.
 */

import { z } from 'zod';
import { NotificationChannel } from '@/generated/prisma/client';
import { ValidationError } from '@/server/errors';
import { cuidSchema, dateOnlySchema, toFieldIssues } from '@/lib/validation';
import type {
  ErasedJobDefinition,
  JobDefinitionRegistry,
  JobHandler,
} from '@/server/jobs/types';

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

/**
 * Separate queues exist so slow work cannot starve urgent work: an export that
 * takes four minutes must not delay an absence SMS. A deployment can run one
 * worker per queue with different concurrency.
 */
export const JOB_QUEUES = {
  default: 'default',
  /** Latency-sensitive, high volume, short handlers. */
  notifications: 'notifications',
  /** Minutes-long, memory-hungry: imports and exports. */
  reports: 'reports',
  /** Housekeeping nobody waits for. */
  maintenance: 'maintenance',
} as const;

export type JobQueue = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

export const ALL_JOB_QUEUES: readonly JobQueue[] = Object.values(JOB_QUEUES);
export const DEFAULT_QUEUE: JobQueue = JOB_QUEUES.default;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The stored `Job.name`. Dotted and prefixed by owning area, matching the
 * convention already used for audit actions and log events, so a log or a queue
 * dashboard groups by area without anyone parsing English.
 *
 * The keys are the identifiers code refers to; the values are what lands in the
 * database. Renaming a value is a migration, not a refactor -- queued rows carry
 * the old string.
 */
export const JOB_NAMES = {
  sendNotification: 'notification.send',
  dispatchNotificationBatch: 'notification.dispatchBatch',
  overduePaymentReminders: 'finance.overduePaymentReminders',
  dailyAttendanceSummary: 'attendance.dailySummary',
  followUpReminders: 'crm.followUpReminders',
  upcomingExamReminders: 'assessment.upcomingExamReminders',
  generateLessons: 'scheduling.generateLessons',
  recalculateInvoice: 'finance.recalculateInvoice',
  autoAbsentSweep: 'attendance.autoAbsentSweep',
  pruneExpiredSessions: 'platform.pruneExpiredSessions',
  pruneRateLimitCounters: 'platform.pruneRateLimitCounters',
  processImport: 'data.processImport',
  generateExport: 'data.generateExport',
  faceIdentifyAsync: 'biometrics.faceIdentifyAsync',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const ALL_JOB_NAMES: readonly JobName[] = Object.values(JOB_NAMES);

/** Guard for a name arriving from outside the codebase (a `CronSchedule` row). */
export function isJobName(value: string): value is JobName {
  return (ALL_JOB_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface JobSpecShape {
  readonly payloadSchema: z.ZodType;
  readonly queue: JobQueue;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly timeoutMs: number;
  readonly description: string;
}

/** Optional tenant scope: absent means "every organisation". */
const organizationScope = z
  .object({ organizationId: cuidSchema.nullish() })
  .partial();

const MINUTE = 60_000;

/**
 * `as const satisfies Record<JobName, ...>` does two jobs at once: `Record`
 * makes the compiler reject a missing or misspelled name, and `as const`
 * preserves each schema's precise type so `JobPayload<K>` can be inferred from
 * it rather than widened to `unknown`.
 */
export const JOB_SPECS = {
  // --- communication ------------------------------------------------------
  [JOB_NAMES.sendNotification]: {
    payloadSchema: z.object({
      /** A `Notification` row that already exists; the job only delivers it. */
      notificationId: cuidSchema,
    }),
    queue: JOB_QUEUES.notifications,
    // A provider that is briefly down deserves patience; five attempts across
    // the backoff curve span roughly two hours.
    maxAttempts: 5,
    priority: 10,
    timeoutMs: 2 * MINUTE,
    description: 'Deliver one persisted Notification through its channel provider.',
  },

  [JOB_NAMES.dispatchNotificationBatch]: {
    payloadSchema: organizationScope.extend({
      channel: z.enum(NotificationChannel).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    queue: JOB_QUEUES.notifications,
    maxAttempts: 3,
    priority: 5,
    timeoutMs: 5 * MINUTE,
    description: 'Sweep PENDING notifications and fan out one send job per row.',
  },

  // --- finance ------------------------------------------------------------
  [JOB_NAMES.overduePaymentReminders]: {
    payloadSchema: organizationScope.extend({
      /** Evaluate debt as of this calendar day rather than today. */
      asOf: dateOnlySchema.optional(),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 10 * MINUTE,
    description: 'Find invoices past their due date and queue reminder notifications.',
  },

  [JOB_NAMES.recalculateInvoice]: {
    payloadSchema: z.object({
      invoiceId: cuidSchema,
      /** Recorded on the audit entry the recalculation writes. */
      reason: z.string().trim().min(1).max(200).optional(),
    }),
    queue: JOB_QUEUES.default,
    // Money paths run Serializable and can lose a write-conflict race, which is
    // exactly what retries are for.
    maxAttempts: 8,
    priority: 20,
    timeoutMs: 2 * MINUTE,
    description: 'Recompute an invoice’s derived totals from its ledger rows.',
  },

  // --- attendance ---------------------------------------------------------
  [JOB_NAMES.dailyAttendanceSummary]: {
    payloadSchema: organizationScope.extend({
      /** The calendar day being summarised, in the branch timezone. */
      date: dateOnlySchema.optional(),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 10 * MINUTE,
    description: 'Send guardians and staff the attendance summary for one day.',
  },

  [JOB_NAMES.autoAbsentSweep]: {
    payloadSchema: organizationScope.extend({
      date: dateOnlySchema.optional(),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 15,
    timeoutMs: 10 * MINUTE,
    description:
      'Mark students with no attendance record absent once a finished lesson’s grace period has passed.',
  },

  [JOB_NAMES.faceIdentifyAsync]: {
    payloadSchema: z.object({
      /** The `FaceRecognitionEvent` row holding the capture reference. */
      faceRecognitionEventId: cuidSchema,
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 25,
    timeoutMs: MINUTE,
    description: 'Resolve a queued face capture against the configured provider.',
  },

  // --- CRM and assessment -------------------------------------------------
  [JOB_NAMES.followUpReminders]: {
    payloadSchema: organizationScope.extend({
      /** How far ahead to look for tasks coming due. */
      withinHours: z.number().int().min(1).max(168).default(24),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 5 * MINUTE,
    description: 'Nudge owners about follow-up tasks that are due or overdue.',
  },

  [JOB_NAMES.upcomingExamReminders]: {
    payloadSchema: organizationScope.extend({
      withinDays: z.number().int().min(1).max(30).default(3),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 5 * MINUTE,
    description: 'Remind students and guardians about exams scheduled soon.',
  },

  // --- scheduling ---------------------------------------------------------
  [JOB_NAMES.generateLessons]: {
    payloadSchema: organizationScope.extend({
      branchId: cuidSchema.nullish(),
      groupId: cuidSchema.nullish(),
      /** Defaults to the configured generation horizon when omitted. */
      fromDate: dateOnlySchema.optional(),
      throughDate: dateOnlySchema.optional(),
    }),
    queue: JOB_QUEUES.default,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 15 * MINUTE,
    description: 'Materialise Lesson rows from active ScheduleSlot patterns.',
  },

  // --- bulk data ----------------------------------------------------------
  [JOB_NAMES.processImport]: {
    payloadSchema: z.object({
      importJobId: cuidSchema,
      /**
       * The two-phase import: `validate` reports bad rows and stops, `commit`
       * writes the ones the operator approved. One handler, two phases, because
       * they must read the same file with the same parser.
       */
      phase: z.enum(['validate', 'commit']),
    }),
    queue: JOB_QUEUES.reports,
    // A half-imported file is worse than a failed one, so do not keep retrying
    // blindly; the operator re-runs it after fixing the input.
    maxAttempts: 2,
    priority: 0,
    timeoutMs: 30 * MINUTE,
    description: 'Validate or commit an uploaded CSV import.',
  },

  [JOB_NAMES.generateExport]: {
    payloadSchema: z.object({ exportJobId: cuidSchema }),
    queue: JOB_QUEUES.reports,
    maxAttempts: 3,
    priority: 0,
    timeoutMs: 30 * MINUTE,
    description: 'Render a report to a file and attach it to its ExportJob row.',
  },

  // --- housekeeping -------------------------------------------------------
  [JOB_NAMES.pruneExpiredSessions]: {
    payloadSchema: z.object({
      /** Revoked and expired rows are kept this long for incident review. */
      retainDays: z.number().int().min(0).max(365).default(30),
    }),
    queue: JOB_QUEUES.maintenance,
    maxAttempts: 2,
    priority: -10,
    timeoutMs: 5 * MINUTE,
    description: 'Delete sessions that can no longer authenticate anyone.',
  },

  [JOB_NAMES.pruneRateLimitCounters]: {
    payloadSchema: z.object({}),
    queue: JOB_QUEUES.maintenance,
    maxAttempts: 2,
    priority: -10,
    timeoutMs: 5 * MINUTE,
    description: 'Delete fixed-window rate limit counters whose window has passed.',
  },
} as const satisfies Record<JobName, JobSpecShape>;

export type JobSpecs = typeof JOB_SPECS;

/** The validated payload type of one job, inferred from its declared schema. */
export type JobPayload<K extends JobName> = z.infer<JobSpecs[K]['payloadSchema']>;

/** The declaration for a name. Total, so no existence check is needed. */
export function jobSpec<K extends JobName>(name: K): JobSpecs[K] {
  return JOB_SPECS[name];
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

const registry = new Map<string, ErasedJobDefinition>();

/**
 * Attach the implementation for a declared job.
 *
 * `handler`'s payload parameter is inferred from the declared zod schema, so
 * `register(JOB_NAMES.recalculateInvoice, async ({ invoiceId }) => ...)` type
 * checks and a misspelled field does not.
 *
 * Duplicate registration throws rather than overwriting: two modules each
 * claiming the same job is a bug that would otherwise surface as "the other
 * implementation ran". `replace` exists for tests and for Next's HMR, which
 * re-evaluates a module on every edit.
 */
export function register<K extends JobName>(
  name: K,
  handler: JobHandler<JobPayload<K>>,
  options: { readonly replace?: boolean } = {},
): void {
  if (registry.has(name) && options.replace !== true) {
    throw new Error(
      `A handler for job "${name}" is already registered. Pass { replace: true } if that is intended.`,
    );
  }

  const spec = JOB_SPECS[name];
  // The one erasure in the chain: `spec.payloadSchema` IS the schema that
  // `JobPayload<K>` is inferred from, but TypeScript cannot follow an indexed
  // access through a generic parameter to prove it, so the union of every spec's
  // schema does not overlap the single instantiated one. Routed through `unknown`
  // because that is the only assertion TS accepts here; the relationship is
  // guaranteed by JOB_SPECS being the sole source of both sides.
  const schema = spec.payloadSchema as unknown as z.ZodType<JobPayload<K>>;

  registry.set(name, {
    name,
    payloadSchema: schema,
    queue: spec.queue,
    maxAttempts: spec.maxAttempts,
    priority: spec.priority,
    timeoutMs: spec.timeoutMs,
    description: spec.description,
    // Re-validating on the way out is not belt-and-braces: the row may have been
    // written by a previous deployment whose schema had different fields, and a
    // handler must never see a payload its own types say is impossible.
    handler: async (payload, context) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ValidationError(
          toFieldIssues(parsed.error),
          `Job "${name}" was queued with a payload that does not match its schema.`,
        );
      }
      return handler(parsed.data, context);
    },
  });
}

/** The implementation for a stored name, or null when nothing claims it. */
export function resolve(name: string): ErasedJobDefinition | null {
  return registry.get(name) ?? null;
}

/** Every registered job, for a health endpoint or an operator dashboard. */
export function registeredJobs(): JobDefinitionRegistry {
  return registry;
}

/** True once a handler exists for every declared job. */
export function missingHandlers(): readonly JobName[] {
  return ALL_JOB_NAMES.filter((name) => !registry.has(name));
}

/** Exposed so unit tests can register fakes without leaking between cases. */
export const __testing = {
  clearRegistry: () => registry.clear(),
};
