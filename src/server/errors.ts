/**
 * Application error taxonomy.
 *
 * Every failure a request can produce is one of these. They carry an HTTP status
 * and a stable machine `code` so the client can react to a specific condition
 * without string-matching prose, and a `publicMessage` that is safe to show a
 * user. Anything not in this taxonomy is treated as an unexpected internal
 * error: it is logged with its stack and reported to the client as a generic 500
 * with a request id, never as a stack trace.
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_FAILED'
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  // 401
  | 'UNAUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'TWO_FACTOR_REQUIRED'
  // 403
  | 'FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'OUT_OF_SCOPE'
  | 'CSRF_FAILED'
  | 'ACCOUNT_INACTIVE'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'STATE_INVALID'
  | 'SCHEDULE_CONFLICT'
  | 'IDEMPOTENCY_MISMATCH'
  // 422
  | 'BUSINESS_RULE_VIOLATED'
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED'
  // 429
  | 'RATE_LIMITED'
  // 500 / 503
  | 'INTERNAL_ERROR'
  | 'INTEGRATION_NOT_CONFIGURED'
  | 'INTEGRATION_FAILED';

export interface FieldIssue {
  /** Dotted path into the submitted payload, e.g. "items.0.unitPrice". */
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface AppErrorOptions {
  /** Extra machine-readable context. MUST NOT contain secrets or PII. */
  readonly details?: Record<string, unknown>;
  readonly fieldIssues?: readonly FieldIssue[];
  readonly cause?: unknown;
  /** Seconds the client should wait before retrying; sets Retry-After. */
  readonly retryAfterSeconds?: number;
}

/** Base class for every expected failure. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Safe to render to an end user. */
  readonly publicMessage: string;
  readonly details?: Record<string, unknown>;
  readonly fieldIssues?: readonly FieldIssue[];
  readonly retryAfterSeconds?: number;
  /** True for the taxonomy above; false for unexpected crashes. */
  readonly expected = true;

  constructor(
    code: ErrorCode,
    status: number,
    publicMessage: string,
    options: AppErrorOptions = {},
  ) {
    // `message` is for logs and may be more specific than publicMessage.
    super(publicMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    this.details = options.details;
    this.fieldIssues = options.fieldIssues;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// 400
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  constructor(fieldIssues: readonly FieldIssue[], message = 'The submitted data is not valid.') {
    super('VALIDATION_FAILED', 400, message, { fieldIssues });
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('BAD_REQUEST', 400, message, options);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'This file type is not accepted.', options?: AppErrorOptions) {
    super('UNSUPPORTED_MEDIA_TYPE', 415, message, options);
  }
}

// ---------------------------------------------------------------------------
// 401 / 403
//
// Deliberate distinction: 401 means "we do not know who you are", 403 means
// "we know, and you may not". Login failures never reveal whether an email
// exists -- see src/server/auth/login.ts.
// ---------------------------------------------------------------------------

export class UnauthenticatedError extends AppError {
  constructor(message = 'You need to sign in to continue.', code: ErrorCode = 'UNAUTHENTICATED') {
    super(code, 401, message);
  }
}

export class SessionExpiredError extends AppError {
  constructor(message = 'Your session has expired. Please sign in again.') {
    super('SESSION_EXPIRED', 401, message);
  }
}

export class PasswordChangeRequiredError extends AppError {
  constructor(message = 'You must set a new password before continuing.') {
    super('PASSWORD_CHANGE_REQUIRED', 401, message);
  }
}

export class TwoFactorRequiredError extends AppError {
  constructor(message = 'Enter your two-factor code to continue.') {
    super('TWO_FACTOR_REQUIRED', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this.', options?: AppErrorOptions) {
    super('FORBIDDEN', 403, message, options);
  }
}

/** A required permission key is missing from the caller's role set. */
export class PermissionDeniedError extends AppError {
  constructor(required: string | readonly string[]) {
    const keys = Array.isArray(required) ? required : [required];
    super('PERMISSION_DENIED', 403, 'You do not have permission to perform this action.', {
      details: { requiredPermissions: keys },
    });
  }
}

/**
 * The caller holds the permission but the target row is outside their branch or
 * assignment scope. Reported separately from PERMISSION_DENIED because it is a
 * different operational problem -- usually "ask an admin to add you to that
 * branch" rather than "ask for a different role".
 */
export class OutOfScopeError extends AppError {
  constructor(
    resource: string,
    options: { branchId?: string | null; reason?: string } = {},
  ) {
    super('OUT_OF_SCOPE', 403, 'This record is outside the branches you have access to.', {
      details: { resource, ...options },
    });
  }
}

export class CsrfError extends AppError {
  constructor(message = 'Your request could not be verified. Please reload the page.') {
    super('CSRF_FAILED', 403, message);
  }
}

export class AccountInactiveError extends AppError {
  constructor(message = 'This account is not active. Contact your administrator.') {
    super('ACCOUNT_INACTIVE', 403, message);
  }
}

// ---------------------------------------------------------------------------
// 404 / 409
// ---------------------------------------------------------------------------

/**
 * Also used when a record exists but lies outside the caller's scope AND
 * revealing its existence would itself leak information (e.g. probing invoice
 * numbers across branches). Choose NotFound over OutOfScope when the id is
 * guessable; see docs/SECURITY.md.
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', 404, `${resource} was not found.`, {
      details: id ? { resource, id } : { resource },
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super('CONFLICT', 409, message, options);
  }
}

export class DuplicateError extends AppError {
  constructor(resource: string, fields: readonly string[], message?: string) {
    super(
      'DUPLICATE',
      409,
      message ?? `A ${resource} with the same ${fields.join(' and ')} already exists.`,
      { details: { resource, fields } },
    );
  }
}

/** The entity is in a state that forbids this transition. */
export class StateInvalidError extends AppError {
  constructor(
    resource: string,
    currentState: string,
    attempted: string,
    message?: string,
  ) {
    super(
      'STATE_INVALID',
      409,
      message ?? `This ${resource} is ${currentState} and cannot be ${attempted}.`,
      { details: { resource, currentState, attempted } },
    );
  }
}

export interface ScheduleConflict {
  readonly kind: 'TEACHER' | 'ROOM' | 'GROUP';
  readonly conflictingId: string;
  readonly label: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export class ScheduleConflictError extends AppError {
  constructor(conflicts: readonly ScheduleConflict[]) {
    super('SCHEDULE_CONFLICT', 409, 'This time slot is already taken.', {
      details: { conflicts },
    });
  }
}

/**
 * An idempotency key was replayed with a different request body. Answering from
 * the cache would silently ignore the new request, so this is an error.
 */
export class IdempotencyMismatchError extends AppError {
  constructor() {
    super(
      'IDEMPOTENCY_MISMATCH',
      409,
      'This request was already submitted with different data. Start again.',
    );
  }
}

// ---------------------------------------------------------------------------
// 422
// ---------------------------------------------------------------------------

/** Input was structurally valid but violates a domain rule. */
export class BusinessRuleError extends AppError {
  constructor(rule: string, message: string, options?: AppErrorOptions) {
    super('BUSINESS_RULE_VIOLATED', 422, message, {
      ...options,
      details: { rule, ...options?.details },
    });
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INSUFFICIENT_FUNDS', 422, message, { details });
  }
}

export class LimitExceededError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('LIMIT_EXCEEDED', 422, message, { details });
  }
}

// ---------------------------------------------------------------------------
// 429 / 5xx
// ---------------------------------------------------------------------------

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, message = 'Too many attempts. Please wait and try again.') {
    super('RATE_LIMITED', 429, message, { retryAfterSeconds });
  }
}

/**
 * A provider (face recognition, SMS, payment gateway...) has no configuration.
 * This is a first-class, honest state: the UI shows "not configured" rather than
 * pretending the feature works.
 */
export class IntegrationNotConfiguredError extends AppError {
  constructor(kind: string, message?: string) {
    super(
      'INTEGRATION_NOT_CONFIGURED',
      503,
      message ?? `${kind} is not configured yet. An administrator must set it up in Settings.`,
      { details: { integration: kind } },
    );
  }
}

export class IntegrationFailedError extends AppError {
  constructor(kind: string, options?: AppErrorOptions) {
    super('INTEGRATION_FAILED', 502, `${kind} is temporarily unavailable. Please try again.`, {
      ...options,
      details: { integration: kind, ...options?.details },
    });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our side.', options?: AppErrorOptions) {
    super('INTERNAL_ERROR', 500, message, options);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Translate a Prisma error into the taxonomy. Keeps database vocabulary
 * (constraint names, SQLSTATE) out of API responses while still producing a
 * precise, actionable error.
 */
export function mapDatabaseError(error: unknown): AppError | null {
  const candidate = error as { code?: string; meta?: Record<string, unknown>; message?: string };
  if (typeof candidate?.code !== 'string') return null;

  switch (candidate.code) {
    case 'P2002': {
      // Unique constraint violation.
      const target = candidate.meta?.['target'];
      const fields = Array.isArray(target) ? target.map(String) : [String(target ?? 'value')];
      return new DuplicateError('record', fields);
    }
    case 'P2003':
      // Foreign key constraint violation: a referenced row does not exist.
      return new ConflictError('A related record is missing or has been removed.', {
        details: { constraint: candidate.meta?.['field_name'] },
      });
    case 'P2025':
      return new NotFoundError('Record');
    case 'P2034':
      // Transaction write conflict / deadlock -- safe to retry.
      return new ConflictError('The record was changed by someone else. Please try again.', {
        retryAfterSeconds: 1,
      });
    default:
      break;
  }

  // Raw PostgreSQL SQLSTATEs that surface through the driver adapter.
  switch (candidate.code) {
    case '23001':
      // restrict_violation -- our append-only guard.
      return new ForbiddenError(
        'This record is part of an immutable history and cannot be changed. Record a correction instead.',
      );
    case '23505':
      return new DuplicateError('record', ['unique constraint']);
    case '23514':
      // check_violation: a business invariant the database enforces.
      return new BusinessRuleError(
        String(candidate.meta?.['constraint'] ?? 'database_check'),
        'The values submitted break a rule this record must satisfy.',
      );
    case '40001':
    case '40P01':
      return new ConflictError('The record was changed by someone else. Please try again.', {
        retryAfterSeconds: 1,
      });
    default:
      return null;
  }
}
