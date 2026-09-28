/**
 * Request-level idempotency.
 *
 * The finance services already refuse a duplicate *domain* write: `Payment` and
 * `Refund` each carry a unique `idempotencyKey` column, so submitting the same
 * payment twice cannot produce two payments. That protects the row. It does not
 * reproduce the *response*, and it only exists where a natural column was
 * available. This module is the generic layer above it -- any endpoint can hand
 * back its own earlier answer without re-running the work.
 *
 * The contract a client sees:
 *
 *   first call            the handler runs, its response is stored and returned.
 *   replay, same body     the stored response, verbatim. The handler does NOT run.
 *   replay, other body    409 IDEMPOTENCY_MISMATCH -- answering from the cache
 *                         would silently discard the new request.
 *   replay, still running 409 CONFLICT with Retry-After. Never a second run.
 *
 * Deliberately NOT a service: it takes no `AccessContext` and no `db`. The key
 * row must be committed independently of whatever transaction the handler opens.
 * Inside the handler's transaction the reservation would be invisible to a
 * concurrent caller until commit -- so the second caller would block on the
 * index instead of being told "already in flight" -- and a rolled-back handler
 * would take the reservation down with it, which is precisely the window a
 * double-submit lands in. Permission checks belong in the handler, where they
 * already are.
 */

import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db/client';
import { ConflictError, IdempotencyMismatchError, InternalError } from '@/server/errors';
import { logger } from '@/server/observability/logger';

/** A day. Long enough for a human to finish retrying, short enough to prune. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Deterministic serialisation for hashing. `JSON.stringify` cannot be used here,
 * for four separate reasons:
 *
 *  1. Key order is insertion order. `{amount, invoiceId}` and `{invoiceId,
 *     amount}` are the same request, and a client that builds its body from an
 *     object literal one time and from a map the next would produce two
 *     different hashes -- turning a legitimate retry into IDEMPOTENCY_MISMATCH,
 *     which is the one outcome this module exists to avoid.
 *  2. It THROWS on `bigint`, and every amount in this system is bigint minor
 *     units, so it cannot hash a money body at all.
 *  3. `NaN` and `Infinity` both become `null`, so two genuinely different bodies
 *     hash identically -- a replay would then return the wrong response.
 *  4. `-0` and `0` stringify differently despite being `===`.
 *
 * The output is not required to be parseable JSON -- nothing reads it back, it
 * only has to be injective. It happens to be valid JSON anyway, which makes a
 * hash mismatch debuggable.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new WeakSet<object>());
}

function write(value: unknown, seen: WeakSet<object>): string {
  // An absent body and an explicit null body are the same request.
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'string':
      // JSON.stringify is the right escaper for a single string; it is only the
      // container ordering above that it gets wrong.
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      // Rendered as plain digits, so a quantity hashes the same whether it
      // reached us already widened to bigint or still as an integer number.
      return value.toString();
    case 'number':
      if (!Number.isFinite(value)) {
        throw new InternalError('A request body containing NaN or Infinity cannot be hashed.');
      }
      // Object.is distinguishes -0 from 0, which `===` does not.
      return Object.is(value, -0) ? '0' : String(value);
    case 'function':
    case 'symbol':
      throw new InternalError(`A ${typeof value} cannot appear in a hashable request body.`);
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new InternalError('A request body with a circular reference cannot be hashed.');
  }
  seen.add(object);

  // A Map or Set has no enumerable own properties, so the structural walk below
  // would hash every one of them to `{}` -- different bodies, one hash, wrong
  // replay. Zod-parsed JSON never produces either, so this is a programming
  // error and is reported as one rather than silently tolerated.
  if (object instanceof Map || object instanceof Set) {
    throw new InternalError('A Map or Set cannot appear in a hashable request body.');
  }

  // Honouring toJSON keeps the hash aligned with what the value means on the
  // wire, and is what covers Date: `Object.entries(new Date())` is empty, so
  // without this every timestamp would hash alike.
  const toJson = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {
    return write((toJson as () => unknown).call(object), seen);
  }

  if (Array.isArray(object)) {
    // Order is meaningful in an array and is preserved. A hole or an explicit
    // undefined becomes null, matching how it would cross the wire.
    return `[${object.map((item) => write(item, seen)).join(',')}]`;
  }

  const entries = Object.entries(object as Record<string, unknown>)
    // An undefined property is indistinguishable from an absent one once the
    // body has been serialised, so it must not change the hash.
    .filter(([, nested]) => nested !== undefined)
    // Code-unit order, the same comparison JSON key sorting is specified with
    // everywhere else; locale-aware sorting would depend on the server's ICU.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${write(nested, seen)}`);

  return `{${entries.join(',')}}`;
}

/** The value stored in `IdempotencyKey.requestHash`. */
export function hashRequestBody(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Stored responses
// ---------------------------------------------------------------------------

/**
 * Convert a handler result into something the `Json` column accepts.
 *
 * This mirrors the BigInt/Date conversion the response envelope performs in
 * src/server/http/api.ts, so a replay is byte-identical to the original
 * response. That helper is private to api.ts; if it is ever exported, this
 * should call it instead of shadowing it.
 */
function toStorableJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new InternalError('A response containing NaN or Infinity cannot be stored.');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toStorableJson);
  if (value instanceof Map) return toStorableJson(Object.fromEntries(value));
  if (value instanceof Set) return toStorableJson([...value]);
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) out[key] = toStorableJson(nested);
    }
    return out;
  }
  throw new InternalError(`A ${typeof value} cannot be stored as a response body.`);
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

export interface IdempotencyRequest {
  /**
   * Namespace, e.g. `'payments.create'`. Two endpoints may safely reuse a key.
   * The tenant is folded in by `rowScope` below -- do not do it here.
   */
  readonly scope: string;
  /** The client-supplied key. Opaque; never parsed. */
  readonly key: string;
  /** The validated body. Hashed, never stored. */
  readonly requestBody: unknown;
  /** Null only for genuinely tenant-less endpoints (platform webhooks). */
  readonly organizationId?: string | null;
  readonly ttlSeconds?: number;
  /** HTTP status to replay alongside the body. The route knows this statically. */
  readonly status?: number;
  /**
   * Opt-in recovery from a reservation whose process died mid-handler.
   *
   * OFF by default, and that default is not timidity. A handler that crashed
   * after its transaction committed but before the response was stored is
   * indistinguishable, from here, from one that crashed before committing --
   * so re-running it could charge a card twice. Only set this on an endpoint
   * whose handler is safe to run again (its own domain unique index will catch
   * the duplicate), never on one that moves money on its own authority.
   */
  readonly staleLockSeconds?: number | null;
}

/**
 * A replayed body comes back as `unknown` on purpose: it made a round trip
 * through JSON, so a `bigint` is now a string and a `Date` is now an ISO string.
 * The caller hands it straight to `ok()`, which is happy with either, or narrows
 * it with the same Zod schema it would use on any other stored JSON.
 */
export type IdempotencyOutcome<T> =
  | { readonly replayed: false; readonly status: number; readonly body: T }
  | { readonly replayed: true; readonly status: number; readonly body: unknown };

export async function withIdempotency<T>(
  request: IdempotencyRequest,
  handler: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const key = request.key.trim();
  if (!key) {
    throw new ConflictError('An idempotency key is required for this request.');
  }

  const ttlSeconds = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 24 * 60 * 60) {
    throw new InternalError('An idempotency TTL must be between 60 seconds and 30 days.');
  }

  const scope = rowScope(request);
  const requestHash = hashRequestBody(request.requestBody);
  const status = request.status ?? 200;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // The INSERT is the lock. Two concurrent first calls are resolved by the
  // unique index on (scope, key) -- one of them gets a constraint violation from
  // PostgreSQL and falls into the replay path below. A `findUnique` followed by
  // a `create` would let both see nothing and both run the handler, which is the
  // exact bug this module exists to prevent, so there is no read here at all.
  try {
    await prisma.idempotencyKey.create({
      data: {
        organizationId: request.organizationId ?? null,
        scope,
        key,
        requestHash,
        lockedAt: now,
        expiresAt,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return resolveExisting(scope, key, requestHash, status, {
      ttlSeconds,
      staleLockSeconds: request.staleLockSeconds ?? null,
      organizationId: request.organizationId ?? null,
      handler,
    });
  }

  return run(scope, key, status, handler);
}

/**
 * Run the handler under a reservation we hold, then record the response.
 *
 * The two failure paths are deliberately asymmetric:
 *
 *  - the handler threw: the request did not take effect, so the reservation is
 *    released and the client may retry with the same key. Leaving it would wedge
 *    the key until its TTL over a validation error.
 *  - the handler succeeded but storing the response failed: the work IS done.
 *    The row stays locked, so every replay is told "in flight" rather than
 *    re-running it. An operator resolves it; a second charge does not happen.
 */
async function run<T>(
  scope: string,
  key: string,
  status: number,
  handler: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  let body: T;
  try {
    body = await handler();
  } catch (error) {
    // deleteMany, not delete: a completed row must never be removed here, and
    // the filter makes that structural rather than a matter of ordering.
    await prisma.idempotencyKey
      .deleteMany({ where: { scope, key, completedAt: null } })
      .catch((cleanupError: unknown) => {
        // The original error is what the caller needs; losing the reservation
        // cleanup only costs the client a retry once the TTL lapses.
        logger.error('idempotency.release_failed', { scope, error: cleanupError });
      });
    throw error;
  }

  await prisma.idempotencyKey.update({
    where: { scope_key: { scope, key } },
    data: {
      completedAt: new Date(),
      responseStatus: status,
      responseBody: toStorableJson(body) ?? Prisma.JsonNull,
    },
  });

  return { replayed: false, status, body };
}

interface ResolveOptions<T> {
  readonly ttlSeconds: number;
  readonly staleLockSeconds: number | null;
  readonly organizationId: string | null;
  readonly handler: () => Promise<T>;
}

/** A row already exists for this (scope, key). Decide what the client gets. */
async function resolveExisting<T>(
  scope: string,
  key: string,
  requestHash: string,
  status: number,
  options: ResolveOptions<T>,
): Promise<IdempotencyOutcome<T>> {
  const row = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope, key } } });
  if (!row) {
    // It was pruned between our INSERT failing and this read. Retrying is safe
    // and will take the reservation cleanly.
    throw new ConflictError('This request is already being processed. Please try again.', {
      retryAfterSeconds: 1,
    });
  }

  const now = new Date();

  // An expired reservation no longer protects anything -- that is what the TTL
  // means -- so the key becomes reusable without waiting for the prune job.
  if (row.expiresAt <= now) {
    const claimed = await claim(scope, key, requestHash, options, now, {
      lockedAt: row.lockedAt,
      expiresAt: { lte: now },
    });
    if (claimed) return run(scope, key, status, options.handler);
    throw new ConflictError('This request is already being processed. Please try again.', {
      retryAfterSeconds: 1,
    });
  }

  // Checked before completion state: a mismatched body is a client bug whether
  // or not the first call has finished, and saying "still processing" would send
  // them into a retry loop over a request we are never going to accept.
  if (row.requestHash !== requestHash) {
    throw new IdempotencyMismatchError();
  }

  if (row.completedAt === null) {
    const staleSeconds = options.staleLockSeconds;
    if (staleSeconds !== null && row.lockedAt.getTime() + staleSeconds * 1000 <= now.getTime()) {
      logger.warn('idempotency.stale_lock_taken_over', { scope, lockedAt: row.lockedAt });
      const claimed = await claim(scope, key, requestHash, options, now, {
        lockedAt: row.lockedAt,
        completedAt: null,
      });
      if (claimed) return run(scope, key, status, options.handler);
    }
    throw new ConflictError('This request is already being processed. Please try again.', {
      retryAfterSeconds: 2,
    });
  }

  return {
    replayed: true,
    status: row.responseStatus ?? status,
    body: row.responseBody,
  };
}

/**
 * Atomically take over an existing reservation.
 *
 * The WHERE clause carries the state we observed -- `lockedAt` in particular --
 * so of two callers racing to reclaim the same dead row exactly one gets
 * `count === 1`. This is the same principle as the INSERT above: the database
 * decides the winner, not a read we performed a moment ago.
 */
async function claim(
  scope: string,
  key: string,
  requestHash: string,
  options: { ttlSeconds: number; organizationId: string | null },
  now: Date,
  guard: Prisma.IdempotencyKeyWhereInput,
): Promise<boolean> {
  const result = await prisma.idempotencyKey.updateMany({
    where: { scope, key, ...guard },
    data: {
      organizationId: options.organizationId,
      requestHash,
      lockedAt: now,
      completedAt: null,
      responseStatus: null,
      responseBody: Prisma.JsonNull,
      expiresAt: new Date(now.getTime() + options.ttlSeconds * 1000),
    },
  });
  return result.count === 1;
}

/**
 * The stored scope, with the tenant folded in.
 *
 * The unique index is `(scope, key)` across the whole table, and keys are
 * client-chosen. Without this, tenant B submitting a key tenant A had already
 * used would get IDEMPOTENCY_MISMATCH -- a clean read-out of which keys another
 * organisation has spent. Namespacing makes the collision impossible instead of
 * merely unlikely. `organizationId` stays on the row as well, because that is
 * what cascades the rows away when a tenant is purged.
 */
function rowScope(request: IdempotencyRequest): string {
  return `${request.organizationId ?? 'platform'}:${request.scope}`;
}

/** P2002 from Prisma, 23505 straight from the driver adapter. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}

/** Housekeeping. Run from cron; see src/server/jobs. */
export async function pruneIdempotencyKeys(now: Date = new Date()): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

/** Exposed so the storage and namespacing rules can be asserted without a database. */
export const __testing = { toStorableJson, rowScope };
