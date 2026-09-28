/**
 * Structured logging.
 *
 * One line of JSON per event in production, readable key=value in development.
 * Events carry a stable dotted `event` name rather than a prose message, so logs
 * can be aggregated and alerted on without regex-matching English.
 *
 * REDACTION IS NOT OPTIONAL. Every value passing through here is walked and any
 * key that looks like a credential is replaced. A logger that can leak a password
 * is worse than no logger, and "remember not to log the request body" is not a
 * control. The redaction list is deliberately broad and matched loosely.
 */

import { env } from '@/server/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced with `[redacted]`, matched case-insensitively. */
const REDACT_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /credential/i,
  /private[_-]?key/i,
  /passwordhash/i,
  /csrf/i,
  /totp/i,
  /twofactor/i,
  /signature/i,
  /bearer/i,
  /connectionstring/i,
  /database[_-]?url/i,
  /biometric/i,
  /embedding/i,
  /template[_-]?ref/i,
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;

function shouldRedact(key: string): boolean {
  return REDACT_PATTERNS.some((pattern) => pattern.test(key));
}

/** Recursively copy a value, redacting sensitive keys and bounding size. */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      // BigInt is not JSON-serialisable; money amounts reach the log as strings.
      return value.toString();
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
    default:
      break;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: env.NODE_ENV === 'production' ? undefined : value.stack,
      cause: value.cause ? sanitize(value.cause, depth + 1, seen) : undefined,
    };
  }

  if (depth >= MAX_DEPTH) return '[max depth]';
  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push(`...and ${value.length - MAX_ARRAY} more`);
    return items;
  }

  if (value instanceof Map) return sanitize(Object.fromEntries(value), depth + 1, seen);
  if (value instanceof Set) return sanitize([...value], depth + 1, seen);

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = shouldRedact(key) ? REDACTED : sanitize(nested, depth + 1, seen);
  }
  return out;
}

export interface LogContext {
  /** Correlates every line produced by one request, job or webhook. */
  requestId?: string | null;
  organizationId?: string | null;
  /** Null means the event was not scoped to a branch. */
  branchId?: string | null;
  /** Null for system actors (jobs, cron, devices). */
  userId?: string | null;
  /** Present on job and cron lines. */
  jobName?: string | null;
  durationMs?: number;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[env.LOG_LEVEL]) return;

  const payload = sanitize(context) as Record<string, unknown>;
  const line = {
    level,
    event,
    time: new Date().toISOString(),
    ...payload,
  };

  const target = level === 'error' || level === 'warn' ? console.error : console.warn;

  if (env.NODE_ENV === 'production') {
    target(JSON.stringify(line));
    return;
  }

  // Development: one compact readable line.
  const { level: _l, event: _e, time: _t, ...rest } = line;
  const details = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' ');
  target(`${level.toUpperCase().padEnd(5)} ${event}${details ? ` ${details}` : ''}`);
}

export const logger = {
  debug: (event: string, context?: LogContext) => emit('debug', event, context),
  info: (event: string, context?: LogContext) => emit('info', event, context),
  warn: (event: string, context?: LogContext) => emit('warn', event, context),
  error: (event: string, context?: LogContext) => emit('error', event, context),

  /** A logger with context pre-bound, for the lifetime of a request or job. */
  child(bound: LogContext) {
    return {
      debug: (event: string, context?: LogContext) => emit('debug', event, { ...bound, ...context }),
      info: (event: string, context?: LogContext) => emit('info', event, { ...bound, ...context }),
      warn: (event: string, context?: LogContext) => emit('warn', event, { ...bound, ...context }),
      error: (event: string, context?: LogContext) => emit('error', event, { ...bound, ...context }),
    };
  },
} as const;

export type Logger = typeof logger;
export type ChildLogger = ReturnType<typeof logger.child>;

/** Exposed for the logger's own unit tests. */
export const __testing = { sanitize, shouldRedact };
