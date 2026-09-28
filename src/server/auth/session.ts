/**
 * Server-side session lifecycle.
 *
 * The cookie carries only an opaque 256-bit token. Everything else -- user,
 * expiry, CSRF secret, revocation -- lives in the `sessions` table, which means
 * an administrator can kill a session instantly and a stolen database yields no
 * usable token (only SHA-256 hashes are stored).
 *
 * Two expiries, both enforced:
 *   expiresAt          idle timeout, slid forward as the session is used
 *   absoluteExpiresAt  hard ceiling, never extended
 *
 * CSRF uses the double-submit pattern: a second cookie holds a token whose hash
 * is bound to this session row, and unsafe requests must echo it in a header.
 * Because the expected value is per-session rather than a global secret, a
 * token lifted from one user is useless against another.
 */

import { cookies } from 'next/headers';
import { env } from '@/server/env';
import { prisma, type Db } from '@/server/db/client';
import { generateToken, hashToken, tokensMatch } from '@/server/auth/password';
import { logger } from '@/server/observability/logger';
import { CSRF_COOKIE, SESSION_COOKIE } from '@/lib/auth-tokens';

// Re-exported, not declared: the browser needs the CSRF names as well, so they
// live in `@/lib/auth-tokens` where a client bundle can reach them.
export { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@/lib/auth-tokens';

/** How much of the idle window must elapse before we bother writing a new expiry. */
const SLIDE_THRESHOLD_RATIO = 0.25;

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly isFullyAuthenticated: boolean;
}

export interface IssuedSession extends SessionRecord {
  /** Shown to the client once, as a cookie value. Never stored in plaintext. */
  readonly token: string;
  readonly csrfToken: string;
}

function idleExpiry(from: Date, rememberMe: boolean): Date {
  const minutes = rememberMe
    ? Math.max(env.SESSION_IDLE_TIMEOUT_MINUTES, 60 * 24 * 14)
    : env.SESSION_IDLE_TIMEOUT_MINUTES;
  return new Date(from.getTime() + minutes * 60_000);
}

function absoluteExpiry(from: Date): Date {
  return new Date(from.getTime() + env.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000);
}

// ---------------------------------------------------------------------------
// Creating and ending sessions
// ---------------------------------------------------------------------------

export async function createSession(
  input: {
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    rememberMe?: boolean;
    /** False when a 2FA challenge is still outstanding. */
    isFullyAuthenticated?: boolean;
  },
  db: Db = prisma,
): Promise<IssuedSession> {
  const now = new Date();
  const token = generateToken(32);
  const csrfToken = generateToken(32);

  const session = await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(token),
      csrfTokenHash: hashToken(csrfToken),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      expiresAt: idleExpiry(now, input.rememberMe ?? false),
      absoluteExpiresAt: absoluteExpiry(now),
      isFullyAuthenticated: input.isFullyAuthenticated ?? true,
    },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      isFullyAuthenticated: true,
    },
  });

  return { ...session, token, csrfToken };
}

/**
 * Look up a live session by its cookie token and slide the idle expiry.
 * Returns null for absent, expired or revoked sessions -- callers must not
 * distinguish these to the client.
 */
export async function loadSession(
  token: string | undefined | null,
  db: Db = prisma,
): Promise<{ session: SessionRecord; csrfTokenHash: string } | null> {
  if (!token) return null;

  const row = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      isFullyAuthenticated: true,
      csrfTokenHash: true,
      revokedAt: true,
    },
  });

  if (!row || row.revokedAt) return null;

  const now = new Date();
  if (row.expiresAt <= now || row.absoluteExpiresAt <= now) {
    // Expired sessions are revoked rather than deleted so the security log keeps
    // a record that the session existed.
    await db.session
      .update({
        where: { id: row.id },
        data: { revokedAt: now, revokeReason: 'expired' },
      })
      .catch(() => undefined);
    return null;
  }

  // Slide the idle window, but only once a meaningful fraction has elapsed:
  // writing on every request would turn each page view into a database write.
  const idleWindowMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
  const remaining = row.expiresAt.getTime() - now.getTime();
  if (remaining < idleWindowMs * (1 - SLIDE_THRESHOLD_RATIO)) {
    const slid = new Date(Math.min(now.getTime() + idleWindowMs, row.absoluteExpiresAt.getTime()));
    await db.session
      .update({ where: { id: row.id }, data: { expiresAt: slid, lastUsedAt: now } })
      .catch(() => undefined);
  }

  return {
    session: {
      id: row.id,
      userId: row.userId,
      expiresAt: row.expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      isFullyAuthenticated: row.isFullyAuthenticated,
    },
    csrfTokenHash: row.csrfTokenHash,
  };
}

export async function revokeSession(
  sessionId: string,
  reason: string,
  db: Db = prisma,
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
}

/**
 * Revoke every session a user holds. Called on password change, on
 * deactivation, and when an administrator forces a sign-out -- a changed
 * password that leaves old sessions alive has not actually locked anyone out.
 */
export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  options: { exceptSessionId?: string } = {},
  db: Db = prisma,
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  if (result.count > 0) {
    logger.info('auth.sessions_revoked', { userId, count: result.count, reason });
  }
  return result.count;
}

/** Promote a session once its 2FA challenge is satisfied. */
export async function markSessionFullyAuthenticated(
  sessionId: string,
  db: Db = prisma,
): Promise<void> {
  await db.session.update({
    where: { id: sessionId },
    data: { isFullyAuthenticated: true },
  });
}

/** Housekeeping: drop sessions that expired long ago. Run from cron. */
export async function pruneExpiredSessions(
  olderThanDays = 30,
  db: Db = prisma,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db.session.deleteMany({
    where: { absoluteExpiresAt: { lt: cutoff } },
  });
  return result.count;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * `httpOnly` keeps the session token away from any script on the page, which is
 * what limits the blast radius of an XSS bug to actions rather than credential
 * theft. `sameSite: 'lax'` blocks cross-site POSTs while still allowing normal
 * top-level navigation into the app from an email link.
 *
 * The CSRF cookie is deliberately NOT httpOnly: the client must read it to echo
 * it back in a header. That is safe because knowing it is useless without the
 * session cookie, which is httpOnly.
 */
function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

export async function setSessionCookies(issued: IssuedSession, rememberMe = false): Promise<void> {
  const store = await cookies();
  const maxAge = rememberMe
    ? Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000)
    : undefined; // Session cookie: cleared when the browser closes.

  store.set(SESSION_COOKIE, issued.token, { ...baseCookieOptions(), maxAge });
  store.set(CSRF_COOKIE, issued.csrfToken, {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', { ...baseCookieOptions(), maxAge: 0 });
  store.set(CSRF_COOKIE, '', { ...baseCookieOptions(), httpOnly: false, maxAge: 0 });
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Verify the double-submit token plus the request Origin.
 *
 * Both checks are kept because they fail independently: the token defends
 * against a forged form post from another site, while the Origin check catches
 * the case where an attacker can somehow read or fixate the cookie but cannot
 * forge the browser-set Origin header.
 */
export function verifyCsrf(input: {
  method: string;
  headerToken: string | null;
  cookieToken: string | null;
  sessionCsrfTokenHash: string;
  origin: string | null;
  appUrl?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (isSafeMethod(input.method)) return { ok: true };

  const expectedOrigin = new URL(input.appUrl ?? env.APP_URL).origin;
  if (input.origin && input.origin !== expectedOrigin) {
    return { ok: false, reason: `origin ${input.origin} does not match ${expectedOrigin}` };
  }

  if (!input.headerToken || !input.cookieToken) {
    return { ok: false, reason: 'csrf token missing from the request' };
  }
  if (!tokensMatch(input.headerToken, input.cookieToken)) {
    return { ok: false, reason: 'csrf header does not match the cookie' };
  }
  if (!tokensMatch(hashToken(input.headerToken), input.sessionCsrfTokenHash)) {
    return { ok: false, reason: 'csrf token is not bound to this session' };
  }
  return { ok: true };
}

/**
 * Client IP, honouring `X-Forwarded-For` only when TRUST_PROXY is on. Trusting
 * that header unconditionally would let any client spoof its address and defeat
 * IP-based rate limiting.
 */
export function clientIpFrom(headers: Headers): string | null {
  if (env.TRUST_PROXY) {
    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
      // Left-most entry is the original client when the chain is trusted.
      const first = forwarded.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return null;
}
