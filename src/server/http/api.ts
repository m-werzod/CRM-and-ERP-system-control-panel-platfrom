/**
 * The API boundary.
 *
 * Every route handler is wrapped by `apiRoute`, which is the single place that:
 *   1. assigns a request id and starts the timer
 *   2. authenticates (unless the route opts out)
 *   3. verifies CSRF on unsafe methods
 *   4. applies rate limiting
 *   5. checks the declared permission
 *   6. validates params / query / body with Zod
 *   7. runs the handler
 *   8. maps any error to a predictable envelope, logging the internals and
 *      revealing none of them
 *
 * A route therefore cannot forget a step: authentication, authorisation and CSRF
 * are declared in its config, not re-implemented in its body. Forgetting to
 * declare a permission is a type error for any route that is not explicitly
 * marked `permission: 'PUBLIC'`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AppError,
  InternalError,
  RateLimitedError,
  ValidationError,
  isAppError,
  mapDatabaseError,
} from '@/server/errors';
import { logger } from '@/server/observability/logger';
import { requireAuth, readRequestMeta, type AuthenticatedRequest } from '@/server/auth/context';
import { CSRF_COOKIE, CSRF_HEADER, verifyCsrf } from '@/server/auth/session';
import { requirePermission, type AccessContext } from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import { consumeRateLimit, type RateLimitRule } from '@/server/security/rate-limit';
import { toFieldIssues } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Response envelope
//
// One shape for success and one for failure, so a client never has to guess.
// BigInt is serialised as a string because JSON has no integer wide enough --
// see src/lib/money.ts.
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta?: Record<string, unknown>;
  readonly requestId: string;
}

export interface ApiFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fieldIssues?: ReadonlyArray<{ path: string; message: string; code?: string }>;
    readonly details?: Record<string, unknown>;
  };
  readonly requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Recursively convert BigInt to string so `JSON.stringify` cannot throw. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    if (value instanceof Map) return jsonSafe(Object.fromEntries(value));
    if (value instanceof Set) return jsonSafe([...value]);
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonSafe(nested);
    }
    return out;
  }
  return value;
}

export function ok<T>(
  data: T,
  options: { status?: number; meta?: Record<string, unknown>; requestId: string } ,
): NextResponse {
  const body: ApiSuccess<unknown> = {
    ok: true,
    data: jsonSafe(data),
    ...(options.meta ? { meta: jsonSafe(options.meta) as Record<string, unknown> } : {}),
    requestId: options.requestId,
  };
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers: { 'x-request-id': options.requestId, 'cache-control': 'no-store' },
  });
}

function failure(error: AppError, requestId: string): NextResponse {
  const body: ApiFailure = {
    ok: false,
    error: {
      code: error.code,
      message: error.publicMessage,
      ...(error.fieldIssues ? { fieldIssues: error.fieldIssues } : {}),
      ...(error.details ? { details: jsonSafe(error.details) as Record<string, unknown> } : {}),
    },
    requestId,
  };
  const headers: Record<string, string> = {
    'x-request-id': requestId,
    'cache-control': 'no-store',
  };
  if (error.retryAfterSeconds) headers['retry-after'] = String(error.retryAfterSeconds);
  return NextResponse.json(body, { status: error.status, headers });
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/** Prisma `skip`/`take` from a validated page/pageSize pair. */
export function toSkipTake(input: { page: number; pageSize: number }): {
  skip: number;
  take: number;
} {
  return { skip: (input.page - 1) * input.pageSize, take: input.pageSize };
}

export interface CursorMeta {
  readonly nextCursor: string | null;
  readonly hasNext: boolean;
}

/**
 * Trim a page fetched with `take: limit + 1` and report the next cursor. Fetching
 * one extra row is how we know whether more exist without a COUNT.
 */
export function cursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; meta: CursorMeta } {
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return {
    items,
    meta: { hasNext, nextCursor: hasNext ? (items[items.length - 1]?.id ?? null) : null },
  };
}

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

/**
 * `'PUBLIC'` is a deliberate, greppable opt-out. A route that needs no
 * permission must say so, which makes "did we forget the check?" answerable by
 * searching for the literal.
 */
export type RoutePermission = PermissionKey | 'PUBLIC' | 'AUTHENTICATED_ONLY';

export interface RouteContext<TParams, TQuery, TBody> {
  readonly ctx: AccessContext;
  readonly auth: AuthenticatedRequest | null;
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly request: NextRequest;
  readonly requestId: string;
  readonly log: ReturnType<typeof logger.child>;
  /** Helper so handlers return `this.ok(data)` without threading requestId. */
  readonly ok: <T>(data: T, options?: { status?: number; meta?: Record<string, unknown> }) => NextResponse;
}

export interface RouteConfig<TParams, TQuery, TBody> {
  /** Permission required, or an explicit opt-out. */
  readonly permission: RoutePermission;
  readonly params?: z.ZodType<TParams>;
  readonly query?: z.ZodType<TQuery>;
  readonly body?: z.ZodType<TBody>;
  /**
   * Rate limit for this route. Login, password reset and public lead capture
   * must always set one.
   */
  readonly rateLimit?: RateLimitRule;
  /** Allow a user with `mustChangePassword` through (the change-password route). */
  readonly allowPasswordChangePending?: boolean;
  /** Allow a session that has not yet cleared its 2FA challenge. */
  readonly allowPartialAuth?: boolean;
  /**
   * Skip CSRF verification. Only legitimate for endpoints authenticated by
   * something other than a cookie (device API keys, provider webhooks with
   * signature verification).
   */
  readonly csrfExempt?: boolean;
}

type Handler<TParams, TQuery, TBody> = (
  context: RouteContext<TParams, TQuery, TBody>,
) => Promise<NextResponse> | NextResponse;

/** Next 16 passes route params as a promise. */
type NextRouteArgs = { params?: Promise<Record<string, string | string[]>> };

export function apiRoute<TParams = undefined, TQuery = undefined, TBody = undefined>(
  config: RouteConfig<TParams, TQuery, TBody>,
  handler: Handler<TParams, TQuery, TBody>,
): (request: NextRequest, args?: NextRouteArgs) => Promise<NextResponse> {
  return async function route(request: NextRequest, args?: NextRouteArgs): Promise<NextResponse> {
    const startedAt = Date.now();
    const requestId = request.headers.get('x-request-id') ?? randomUUID();
    const log = logger.child({ requestId, method: request.method, path: new URL(request.url).pathname });

    try {
      // --- 1. authenticate -------------------------------------------------
      let auth: AuthenticatedRequest | null = null;
      let ctx: AccessContext;

      if (config.permission === 'PUBLIC') {
        const meta = await readRequestMeta();
        // A synthetic context so downstream code has a uniform shape. It holds
        // no permissions, so any accidental permission check fails closed.
        ctx = {
          userId: 'anonymous',
          organizationId: '',
          email: '',
          displayName: 'Anonymous',
          permissions: new Set<string>(),
          scope: 'SELF',
          roleLevel: 0,
          roleKeys: [],
          branchIds: [],
          primaryBranchId: null,
          self: { teacherId: null, employeeId: null, studentId: null, guardianId: null },
          requestId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          sessionId: null,
          isSystem: false,
        };
      } else {
        auth = await requireAuth({
          allowPasswordChangePending: config.allowPasswordChangePending,
          allowPartialAuth: config.allowPartialAuth,
        });
        ctx = { ...auth.ctx, requestId };
      }

      // --- 2. CSRF ---------------------------------------------------------
      if (!config.csrfExempt && auth) {
        const verdict = verifyCsrf({
          method: request.method,
          headerToken: request.headers.get(CSRF_HEADER),
          cookieToken: request.cookies.get(CSRF_COOKIE)?.value ?? null,
          sessionCsrfTokenHash: auth.csrfTokenHash,
          origin: request.headers.get('origin'),
        });
        if (!verdict.ok) {
          log.warn('http.csrf_rejected', { userId: ctx.userId, reason: verdict.reason });
          const { CsrfError } = await import('@/server/errors');
          throw new CsrfError();
        }
      }

      // --- 3. rate limit ---------------------------------------------------
      if (config.rateLimit) {
        const verdict = await consumeRateLimit(config.rateLimit, {
          ipAddress: ctx.ipAddress,
          userId: auth ? ctx.userId : null,
          organizationId: ctx.organizationId || null,
        });
        if (!verdict.allowed) {
          log.warn('http.rate_limited', {
            userId: ctx.userId,
            rule: config.rateLimit.key,
            retryAfterSeconds: verdict.retryAfterSeconds,
          });
          throw new RateLimitedError(verdict.retryAfterSeconds);
        }
      }

      // --- 4. authorise ----------------------------------------------------
      if (config.permission !== 'PUBLIC' && config.permission !== 'AUTHENTICATED_ONLY') {
        requirePermission(ctx, config.permission);
      }

      // --- 5. validate -----------------------------------------------------
      const rawParams = args?.params ? await args.params : {};
      const params = await parseOrThrow(config.params, rawParams, 'params');

      const url = new URL(request.url);
      const rawQuery = collapseSearchParams(url.searchParams);
      const query = await parseOrThrow(config.query, rawQuery, 'query');

      let body: TBody = undefined as TBody;
      if (config.body) {
        const raw = await readJsonBody(request);
        body = await parseOrThrow(config.body, raw, 'body');
      }

      // --- 6. handle -------------------------------------------------------
      const response = await handler({
        ctx,
        auth,
        params,
        query,
        body,
        request,
        requestId,
        log,
        ok: (data, options) => ok(data, { ...options, requestId }),
      });

      log.info('http.request', {
        userId: auth ? ctx.userId : null,
        organizationId: ctx.organizationId || null,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      response.headers.set('x-request-id', requestId);
      return response;
    } catch (error) {
      return handleError(error, requestId, log, startedAt);
    }
  };
}

function handleError(
  error: unknown,
  requestId: string,
  log: ReturnType<typeof logger.child>,
  startedAt: number,
): NextResponse {
  const mapped = isAppError(error) ? error : mapDatabaseError(error);

  if (mapped) {
    // Expected failures are logged at info/warn, not error: a 404 is not an
    // incident, and treating it as one buries the real ones.
    const level = mapped.status >= 500 ? 'error' : 'warn';
    log[level]('http.request_failed', {
      code: mapped.code,
      status: mapped.status,
      durationMs: Date.now() - startedAt,
      details: mapped.details,
      ...(mapped.status >= 500 ? { error } : {}),
    });
    return failure(mapped, requestId);
  }

  // Unexpected: log everything, reveal nothing but the request id.
  log.error('http.unhandled_error', { error, durationMs: Date.now() - startedAt });
  return failure(
    new InternalError(
      `Something went wrong on our side. Quote reference ${requestId} if you contact support.`,
    ),
    requestId,
  );
}

async function parseOrThrow<T>(
  schema: z.ZodType<T> | undefined,
  value: unknown,
  where: 'params' | 'query' | 'body',
): Promise<T> {
  if (!schema) return undefined as T;
  const result = await schema.safeParseAsync(value);
  if (result.success) return result.data;
  throw new ValidationError(
    toFieldIssues(result.error).map((issue) => ({ ...issue, path: `${where}.${issue.path}` })),
  );
}

/**
 * Turn URLSearchParams into a plain object, keeping repeated keys as arrays.
 * `?branchId=a&branchId=b` must not silently become just `b`.
 */
function collapseSearchParams(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : (values[0] ?? '');
  }
  return out;
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // An empty body on a DELETE is normal; a wrong content type on a POST is not.
    if (request.method === 'DELETE') return {};
    const { BadRequestError } = await import('@/server/errors');
    throw new BadRequestError('This endpoint expects a JSON body.');
  }
  try {
    const text = await request.text();
    return text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    const { BadRequestError } = await import('@/server/errors');
    throw new BadRequestError('The request body is not valid JSON.');
  }
}
