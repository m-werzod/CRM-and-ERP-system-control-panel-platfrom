/**
 * Login, logout and password change.
 *
 * The properties this file exists to guarantee:
 *
 * 1. **No account enumeration.** Every failure returns the same message, and an
 *    unknown email still pays the cost of an Argon2 verify. Without that, "unknown
 *    email" returns in ~1 ms while "wrong password" takes ~15 ms — a reliable
 *    oracle for harvesting valid addresses.
 *
 * 2. **Every attempt is recorded**, including for an email that matches no user,
 *    because that is exactly the signal an enumeration attempt produces.
 *
 * 3. **Lockout is per account**, not per IP. A whole school shares one NAT address,
 *    so an IP limit tight enough to stop credential stuffing would lock out the
 *    building. The IP limit exists too (see RATE_LIMITS.login) but it is the
 *    backstop, not the control.
 *
 * 4. **A password change revokes every other session.** A changed password that
 *    leaves old sessions alive has not actually locked anyone out.
 */

import { prisma, type Db } from '@/server/db/client';
import { env } from '@/server/env';
import {
  AccountInactiveError,
  BusinessRuleError,
  UnauthenticatedError,
} from '@/server/errors';
import {
  fakeVerifyForTiming,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/server/auth/password';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
  type IssuedSession,
} from '@/server/auth/session';
import { verifyTotp } from '@/server/security/totp';
import { ENCRYPTION_PURPOSES, decrypt } from '@/server/security/crypto';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import { buildAccessContext } from '@/server/auth/context';
import type { AccessContext } from '@/server/rbac/access';
import { logger } from '@/server/observability/logger';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string;
  readonly rememberMe?: boolean;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export type LoginResult =
  | {
      readonly outcome: 'SUCCESS';
      readonly session: IssuedSession;
      readonly mustChangePassword: boolean;
      readonly userId: string;
      readonly displayName: string;
    }
  | {
      readonly outcome: 'TWO_FACTOR_REQUIRED';
      /** A session that is authenticated but not yet fully authorised. */
      readonly session: IssuedSession;
      readonly userId: string;
    };

/**
 * One message for every credential failure. The specific reason goes to the
 * security log, never to the client.
 */
const GENERIC_FAILURE = 'Email or password is incorrect.';

export async function login(input: LoginInput, db: Db = prisma): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const user = await db.user.findFirst({
    where: { email },
    select: {
      id: true,
      organizationId: true,
      email: true,
      passwordHash: true,
      firstName: true,
      lastName: true,
      status: true,
      mustChangePassword: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      twoFactorEnabled: true,
      twoFactorSecret: true,
      deletedAt: true,
      organization: { select: { status: true } },
    },
  });

  const attemptBase = {
    email,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
  };

  // --- unknown email -------------------------------------------------------
  if (!user || user.deletedAt) {
    // Equalise the timing before recording, so the write does not become the new
    // distinguishing signal.
    await fakeVerifyForTiming();
    await recordAttempt(db, { ...attemptBase, success: false, reason: 'UNKNOWN_EMAIL' });
    throw new UnauthenticatedError(GENERIC_FAILURE);
  }

  // --- locked --------------------------------------------------------------
  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await recordAttempt(db, {
      ...attemptBase,
      userId: user.id,
      organizationId: user.organizationId,
      success: false,
      reason: 'ACCOUNT_LOCKED',
    });
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
    // The one case that is NOT the generic message: telling someone their account is
    // temporarily locked is necessary for them to act, and it reveals nothing an
    // attacker who triggered the lockout does not already know.
    throw new AccountInactiveError(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  // --- password ------------------------------------------------------------
  const passwordValid = await verifyPassword(user.passwordHash, input.password);
  if (!passwordValid) {
    await registerFailure(db, user, attemptBase);
    throw new UnauthenticatedError(GENERIC_FAILURE);
  }

  // --- account and organisation state -------------------------------------
  // Checked AFTER the password so an attacker cannot use the error to discover
  // which addresses belong to real (if deactivated) accounts.
  if (user.organization.status !== 'ACTIVE') {
    await recordAttempt(db, {
      ...attemptBase,
      userId: user.id,
      organizationId: user.organizationId,
      success: false,
      reason: 'ORGANIZATION_SUSPENDED',
    });
    throw new AccountInactiveError('This organisation is not active. Contact support.');
  }
  if (user.status !== 'ACTIVE' && user.status !== 'INVITED') {
    await recordAttempt(db, {
      ...attemptBase,
      userId: user.id,
      organizationId: user.organizationId,
      success: false,
      reason: 'ACCOUNT_INACTIVE',
    });
    throw new AccountInactiveError();
  }

  // --- two-factor ----------------------------------------------------------
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    if (!input.totpCode) {
      // A partial session: the password is proven, the second factor is not. It
      // exists so the 2FA step has something to attach to without re-sending the
      // password, and `requireAuth` refuses it for anything else.
      const partial = await createSession(
        {
          userId: user.id,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          rememberMe: false,
          isFullyAuthenticated: false,
        },
        db,
      );
      return { outcome: 'TWO_FACTOR_REQUIRED', session: partial, userId: user.id };
    }

    const secret = decrypt(user.twoFactorSecret, ENCRYPTION_PURPOSES.totpSecret);
    const verdict = verifyTotp(secret, input.totpCode);
    if (!verdict.valid) {
      await registerFailure(db, user, attemptBase, 'TWO_FACTOR_FAILED');
      throw new UnauthenticatedError(GENERIC_FAILURE);
    }
  }

  // --- success -------------------------------------------------------------
  // Transparent parameter upgrade: raising the Argon2 cost later reaches existing
  // accounts on next login rather than needing a forced reset.
  const rehashed = needsRehash(user.passwordHash)
    ? await hashPassword(input.password)
    : undefined;

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: now,
      lastLoginIp: input.ipAddress ?? null,
      // INVITED becomes ACTIVE on first successful sign-in.
      status: user.status === 'INVITED' ? 'ACTIVE' : user.status,
      ...(rehashed ? { passwordHash: rehashed, passwordChangedAt: now } : {}),
    },
  });

  const session = await createSession(
    {
      userId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      rememberMe: input.rememberMe ?? false,
      isFullyAuthenticated: true,
    },
    db,
  );

  await recordAttempt(db, {
    ...attemptBase,
    userId: user.id,
    organizationId: user.organizationId,
    success: true,
  });

  const ctx = await buildAccessContext(
    user.id,
    {
      requestId: `login-${session.id}`,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      sessionId: session.id,
    },
    db,
  );

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      entityType: 'User',
      entityId: user.id,
      summary: `${user.firstName} ${user.lastName} signed in`,
      metadata: { rehashed: Boolean(rehashed), twoFactor: user.twoFactorEnabled },
    },
    db,
  );

  return {
    outcome: 'SUCCESS',
    session,
    mustChangePassword: user.mustChangePassword,
    userId: user.id,
    displayName: `${user.firstName} ${user.lastName}`.trim(),
  };
}

/**
 * Complete the second factor for a partial session. Separate from `login` so the
 * password is never re-sent with the code.
 */
export async function completeTwoFactor(
  input: { sessionId: string; code: string; ipAddress?: string | null },
  db: Db = prisma,
): Promise<{ userId: string; mustChangePassword: boolean }> {
  const session = await db.session.findFirst({
    where: { id: input.sessionId, revokedAt: null, isFullyAuthenticated: false },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          organizationId: true,
          firstName: true,
          lastName: true,
          mustChangePassword: true,
          twoFactorSecret: true,
          twoFactorEnabled: true,
        },
      },
    },
  });
  if (!session || session.expiresAt <= new Date()) {
    throw new UnauthenticatedError('Your sign-in attempt has expired. Please start again.');
  }
  if (!session.user.twoFactorEnabled || !session.user.twoFactorSecret) {
    throw new BusinessRuleError(
      'auth.two_factor_not_enabled',
      'Two-factor authentication is not enabled for this account.',
    );
  }

  const secret = decrypt(session.user.twoFactorSecret, ENCRYPTION_PURPOSES.totpSecret);
  const verdict = verifyTotp(secret, input.code);
  if (!verdict.valid) {
    throw new UnauthenticatedError('That code is not valid. Check your authenticator app.');
  }

  await db.session.update({
    where: { id: session.id },
    data: { isFullyAuthenticated: true },
  });

  logger.info('auth.two_factor_completed', {
    userId: session.user.id,
    organizationId: session.user.organizationId,
  });

  return {
    userId: session.user.id,
    mustChangePassword: session.user.mustChangePassword,
  };
}

export async function logout(ctx: AccessContext, db: Db = prisma): Promise<void> {
  if (ctx.sessionId) {
    await revokeSession(ctx.sessionId, 'user logged out', db);
  }
  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.LOGOUT,
      entityType: 'User',
      entityId: ctx.userId,
      summary: `${ctx.displayName} signed out`,
    },
    db,
  );
}

/**
 * Change your own password.
 *
 * Revokes every OTHER session on success. The current one survives so the user is
 * not bounced to the login screen by their own action.
 */
export async function changeOwnPassword(
  ctx: AccessContext,
  input: { currentPassword: string; newPassword: string },
  db: Db = prisma,
): Promise<{ revokedSessions: number }> {
  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new UnauthenticatedError();

  const valid = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!valid) {
    // Not the generic message: the user has already proven who they are by holding a
    // session, so naming the wrong field is helpful rather than a leak.
    throw new BusinessRuleError(
      'auth.current_password_wrong',
      'Your current password is not correct.',
    );
  }
  if (input.currentPassword === input.newPassword) {
    throw new BusinessRuleError(
      'auth.password_unchanged',
      'The new password must differ from the current one.',
    );
  }

  const now = new Date();
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      passwordChangedAt: now,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  const revokedSessions = await revokeAllUserSessions(
    user.id,
    'password changed',
    { exceptSessionId: ctx.sessionId ?? undefined },
    db,
  );

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      entityType: 'User',
      entityId: user.id,
      summary: `${ctx.displayName} changed their password`,
      severity: 'NOTICE',
      metadata: { revokedSessions },
    },
    db,
  );

  return { revokedSessions };
}

// ---------------------------------------------------------------------------

type FailureReason =
  | 'UNKNOWN_EMAIL'
  | 'BAD_PASSWORD'
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_LOCKED'
  | 'RATE_LIMITED'
  | 'TWO_FACTOR_FAILED'
  | 'ORGANIZATION_SUSPENDED';

async function recordAttempt(
  db: Db,
  input: {
    email: string;
    userId?: string;
    organizationId?: string;
    success: boolean;
    reason?: FailureReason;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  // A failure to write the security log must not become a way to log in
  // unobserved, but nor should it deny a legitimate user — logged loudly instead.
  try {
    await db.loginAttempt.create({
      data: {
        organizationId: input.organizationId ?? null,
        email: input.email,
        userId: input.userId ?? null,
        success: input.success,
        reason: input.reason ?? null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  } catch (error) {
    logger.error('auth.login_attempt_write_failed', { email: input.email, error });
  }
}

/** Increment the failure counter and lock the account once the limit is reached. */
async function registerFailure(
  db: Db,
  user: { id: string; organizationId: string; failedLoginAttempts: number },
  attemptBase: { email: string; ipAddress: string | null; userAgent: string | null },
  reason: FailureReason = 'BAD_PASSWORD',
): Promise<void> {
  const attempts = user.failedLoginAttempts + 1;
  const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: attempts,
      lockedUntil: shouldLock
        ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000)
        : null,
      status: shouldLock ? 'LOCKED' : undefined,
    },
  });

  await recordAttempt(db, {
    ...attemptBase,
    userId: user.id,
    organizationId: user.organizationId,
    success: false,
    reason,
  });

  if (shouldLock) {
    logger.warn('auth.account_locked', {
      userId: user.id,
      organizationId: user.organizationId,
      attempts,
      lockoutMinutes: env.LOGIN_LOCKOUT_MINUTES,
    });
  }
}

/**
 * Clear a lock administratively. Separate from the password-reset path because an
 * administrator unlocking an account is its own auditable act.
 */
export async function unlockAccount(
  ctx: AccessContext,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const { requirePermission } = await import('@/server/rbac/access');
  requirePermission(ctx, 'users.edit');

  const user = await db.user.findFirst({
    where: { id: userId, organizationId: ctx.organizationId },
    select: { id: true, firstName: true, lastName: true, status: true },
  });
  if (!user) throw new UnauthenticatedError();

  await db.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      status: user.status === 'LOCKED' ? 'ACTIVE' : user.status,
    },
  });

  await recordAudit(
    ctx,
    {
      action: 'auth.account.unlocked',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.firstName} ${user.lastName} unlocked by ${ctx.displayName}`,
      severity: 'NOTICE',
    },
    db,
  );
}
