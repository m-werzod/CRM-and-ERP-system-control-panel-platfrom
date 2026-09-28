import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRoles,
  createOrganization,
  createUser,
  prisma,
  resetDatabase,
  seedPermissions,
  type OrganizationFixture,
  type UserFixture,
} from '@tests/helpers/fixtures';
import {
  changeOwnPassword,
  completeTwoFactor,
  login,
  logout,
  unlockAccount,
} from '@/server/services/auth/login';
import { loadSession, revokeAllUserSessions, verifyCsrf } from '@/server/auth/session';
import { hashToken } from '@/server/auth/password';
import { ENCRYPTION_PURPOSES, encrypt } from '@/server/security/crypto';
import { generateSecret, stepAt, totpCodeForStep } from '@/server/security/totp';
import { env } from '@/server/env';

/**
 * Authentication integration tests against real PostgreSQL.
 *
 * The properties under test are the ones whose absence is invisible until
 * exploited: that a failure does not reveal whether an account exists, that lockout
 * actually engages, that a password change invalidates other sessions, and that a
 * session token is never recoverable from the database.
 */

let org: OrganizationFixture;
let user: UserFixture;

const PASSWORD = 'Test-Password-9';

/** The code an authenticator would show right now. */
const currentCode = (secret: string): string => totpCodeForStep(secret, stepAt(Date.now()));

beforeEach(async () => {
  await resetDatabase();
  await seedPermissions();
  org = await createOrganization({ currency: 'USD' });
  const roleIds = await createRoles(org.organizationId, ['ADMIN']);
  user = await createUser({
    organizationId: org.organizationId,
    role: 'ADMIN',
    roleIds,
    branchIds: [org.branchAId],
    primaryBranchId: org.branchAId,
    email: 'admin@example.test',
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('login', () => {
  it('signs in with correct credentials and issues a session', async () => {
    const result = await login({
      email: 'admin@example.test',
      password: PASSWORD,
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });

    expect(result.outcome).toBe('SUCCESS');
    if (result.outcome !== 'SUCCESS') return;

    expect(result.userId).toBe(user.userId);
    expect(result.session.token).toBeTruthy();
    expect(result.session.csrfToken).toBeTruthy();

    const loaded = await loadSession(result.session.token);
    expect(loaded?.session.userId).toBe(user.userId);
    expect(loaded?.session.isFullyAuthenticated).toBe(true);
  });

  it('stores only the token HASH, never the token', async () => {
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    if (result.outcome !== 'SUCCESS') throw new Error('expected success');

    const row = await prisma.session.findUniqueOrThrow({
      where: { id: result.session.id },
      select: { tokenHash: true, csrfTokenHash: true },
    });

    // A leaked database must not yield a usable session.
    expect(row.tokenHash).toBe(hashToken(result.session.token));
    expect(row.tokenHash).not.toBe(result.session.token);
    expect(row.csrfTokenHash).toBe(hashToken(result.session.csrfToken));

    const anySessionHoldingTheToken = await prisma.session.count({
      where: { tokenHash: result.session.token },
    });
    expect(anySessionHoldingTheToken).toBe(0);
  });

  it('is case-insensitive on the email and trims it', async () => {
    const result = await login({ email: '  ADMIN@Example.TEST  ', password: PASSWORD });
    expect(result.outcome).toBe('SUCCESS');
  });

  it('gives the SAME message for an unknown email and a wrong password', async () => {
    const unknown = await login({ email: 'nobody@example.test', password: PASSWORD }).catch(
      (error: Error) => error,
    );
    const wrong = await login({ email: 'admin@example.test', password: 'Wrong-Password-9' }).catch(
      (error: Error) => error,
    );

    expect(unknown).toBeInstanceOf(Error);
    expect(wrong).toBeInstanceOf(Error);
    // Differing messages here would be an account-enumeration oracle.
    expect((unknown as Error).message).toBe((wrong as Error).message);
  });

  it('records an attempt for an email that matches no user', async () => {
    // This is precisely the signal an enumeration sweep produces, so it must be
    // logged rather than discarded.
    await login({ email: 'probe@example.test', password: 'x' }).catch(() => undefined);

    const attempt = await prisma.loginAttempt.findFirstOrThrow({
      where: { email: 'probe@example.test' },
      select: { success: true, reason: true, userId: true },
    });
    expect(attempt.success).toBe(false);
    expect(attempt.reason).toBe('UNKNOWN_EMAIL');
    expect(attempt.userId).toBeNull();
  });

  it('records a successful attempt with its organisation', async () => {
    await login({ email: 'admin@example.test', password: PASSWORD, ipAddress: '198.51.100.7' });

    const attempt = await prisma.loginAttempt.findFirstOrThrow({
      where: { email: 'admin@example.test', success: true },
      select: { organizationId: true, ipAddress: true },
    });
    expect(attempt.organizationId).toBe(org.organizationId);
    expect(attempt.ipAddress).toBe('198.51.100.7');
  });

  it('writes an audit entry on success', async () => {
    await login({ email: 'admin@example.test', password: PASSWORD });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.login.succeeded' },
      select: { actorUserId: true, entityType: true, entityId: true },
    });
    expect(audit.actorUserId).toBe(user.userId);
    expect(audit.entityType).toBe('User');
    expect(audit.entityId).toBe(user.userId);
  });

  it('updates lastLoginAt and clears the failure counter', async () => {
    await login({ email: 'admin@example.test', password: 'Wrong-Password-9' }).catch(() => undefined);
    let row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { failedLoginAttempts: true },
    });
    expect(row.failedLoginAttempts).toBe(1);

    await login({ email: 'admin@example.test', password: PASSWORD });
    row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { failedLoginAttempts: true },
    });
    expect(row.failedLoginAttempts).toBe(0);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { lastLoginAt: true },
    });
    expect(after.lastLoginAt).toBeInstanceOf(Date);
  });
});

describe('brute-force protection', () => {
  it('locks the account after the configured number of failures', async () => {
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i += 1) {
      await login({ email: 'admin@example.test', password: 'Wrong-Password-9' }).catch(
        () => undefined,
      );
    }

    const locked = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { failedLoginAttempts: true, lockedUntil: true, status: true },
    });
    expect(locked.failedLoginAttempts).toBe(env.LOGIN_MAX_ATTEMPTS);
    expect(locked.lockedUntil).toBeInstanceOf(Date);
    expect(locked.status).toBe('LOCKED');

    // And the CORRECT password is now refused too — otherwise the lock is theatre.
    await expect(login({ email: 'admin@example.test', password: PASSWORD })).rejects.toThrow(
      /Too many failed attempts/i,
    );
  });

  it('an administrator can unlock an account', async () => {
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i += 1) {
      await login({ email: 'admin@example.test', password: 'Wrong-Password-9' }).catch(
        () => undefined,
      );
    }

    await unlockAccount(user.ctx, user.userId);

    const unlocked = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { lockedUntil: true, status: true, failedLoginAttempts: true },
    });
    expect(unlocked.lockedUntil).toBeNull();
    expect(unlocked.status).toBe('ACTIVE');
    expect(unlocked.failedLoginAttempts).toBe(0);

    await expect(
      login({ email: 'admin@example.test', password: PASSWORD }),
    ).resolves.toMatchObject({ outcome: 'SUCCESS' });
  });
});

describe('account state', () => {
  it('refuses a deactivated account', async () => {
    await prisma.user.update({ where: { id: user.userId }, data: { status: 'INACTIVE' } });
    await expect(login({ email: 'admin@example.test', password: PASSWORD })).rejects.toThrow(
      /not active/i,
    );
  });

  it('refuses a soft-deleted account with the generic message', async () => {
    await prisma.user.update({ where: { id: user.userId }, data: { deletedAt: new Date() } });
    await expect(login({ email: 'admin@example.test', password: PASSWORD })).rejects.toThrow(
      /incorrect/i,
    );
  });

  it('refuses a suspended organisation', async () => {
    await prisma.organization.update({
      where: { id: org.organizationId },
      data: { status: 'SUSPENDED' },
    });
    await expect(login({ email: 'admin@example.test', password: PASSWORD })).rejects.toThrow(
      /organisation is not active/i,
    );
  });

  it('promotes an INVITED account to ACTIVE on first sign-in', async () => {
    await prisma.user.update({ where: { id: user.userId }, data: { status: 'INVITED' } });
    await login({ email: 'admin@example.test', password: PASSWORD });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { status: true },
    });
    expect(row.status).toBe('ACTIVE');
  });

  it('reports mustChangePassword so the caller can route to the change screen', async () => {
    await prisma.user.update({
      where: { id: user.userId },
      data: { mustChangePassword: true },
    });
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    expect(result).toMatchObject({ outcome: 'SUCCESS', mustChangePassword: true });
  });
});

describe('two-factor', () => {
  async function enableTwoFactor(): Promise<string> {
    const secret = generateSecret();
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        twoFactorEnabled: true,
        // Stored encrypted, never in plaintext.
        twoFactorSecret: encrypt(secret, ENCRYPTION_PURPOSES.totpSecret),
        twoFactorEnabledAt: new Date(),
      },
    });
    return secret;
  }

  it('issues a partial session and demands a code', async () => {
    await enableTwoFactor();
    const result = await login({ email: 'admin@example.test', password: PASSWORD });

    expect(result.outcome).toBe('TWO_FACTOR_REQUIRED');
    if (result.outcome !== 'TWO_FACTOR_REQUIRED') return;

    const loaded = await loadSession(result.session.token);
    // Authenticated but not yet authorised: requireAuth refuses it for anything else.
    expect(loaded?.session.isFullyAuthenticated).toBe(false);
  });

  it('completes with a valid code and promotes the session', async () => {
    const secret = await enableTwoFactor();
    const partial = await login({ email: 'admin@example.test', password: PASSWORD });
    if (partial.outcome !== 'TWO_FACTOR_REQUIRED') throw new Error('expected a 2FA challenge');

    await completeTwoFactor({
      sessionId: partial.session.id,
      code: currentCode(secret),
    });

    const loaded = await loadSession(partial.session.token);
    expect(loaded?.session.isFullyAuthenticated).toBe(true);
  });

  it('rejects a wrong code without promoting the session', async () => {
    const secret = await enableTwoFactor();
    const partial = await login({ email: 'admin@example.test', password: PASSWORD });
    if (partial.outcome !== 'TWO_FACTOR_REQUIRED') throw new Error('expected a 2FA challenge');

    await expect(
      completeTwoFactor({ sessionId: partial.session.id, code: '000000' }),
    ).rejects.toThrow(/not valid/i);

    const loaded = await loadSession(partial.session.token);
    expect(loaded?.session.isFullyAuthenticated).toBe(false);
    expect(secret).toBeTruthy();
  });

  it('signs in directly when the code is supplied with the password', async () => {
    const secret = await enableTwoFactor();
    const result = await login({
      email: 'admin@example.test',
      password: PASSWORD,
      totpCode: currentCode(secret),
    });
    expect(result.outcome).toBe('SUCCESS');
  });
});

describe('sessions', () => {
  it('rejects a revoked session', async () => {
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    if (result.outcome !== 'SUCCESS') throw new Error('expected success');

    await logout({ ...user.ctx, sessionId: result.session.id });

    expect(await loadSession(result.session.token)).toBeNull();
  });

  it('rejects an expired session and revokes it rather than deleting it', async () => {
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    if (result.outcome !== 'SUCCESS') throw new Error('expected success');

    await prisma.session.update({
      where: { id: result.session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await loadSession(result.session.token)).toBeNull();

    // The row survives, marked revoked: the security log keeps the fact it existed.
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: result.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokeReason).toBe('expired');
  });

  it('honours the absolute ceiling even when the idle window is fresh', async () => {
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    if (result.outcome !== 'SUCCESS') throw new Error('expected success');

    await prisma.session.update({
      where: { id: result.session.id },
      data: {
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    expect(await loadSession(result.session.token)).toBeNull();
  });

  it('revokes every session for a user on demand', async () => {
    const first = await login({ email: 'admin@example.test', password: PASSWORD });
    const second = await login({ email: 'admin@example.test', password: PASSWORD });
    if (first.outcome !== 'SUCCESS' || second.outcome !== 'SUCCESS') {
      throw new Error('expected success');
    }

    const count = await revokeAllUserSessions(user.userId, 'test');
    expect(count).toBe(2);
    expect(await loadSession(first.session.token)).toBeNull();
    expect(await loadSession(second.session.token)).toBeNull();
  });

  it('rejects a garbage token without throwing', async () => {
    expect(await loadSession('not-a-real-token')).toBeNull();
    expect(await loadSession(undefined)).toBeNull();
  });
});

describe('password change', () => {
  it('changes the password and revokes every OTHER session', async () => {
    const keep = await login({ email: 'admin@example.test', password: PASSWORD });
    const other = await login({ email: 'admin@example.test', password: PASSWORD });
    if (keep.outcome !== 'SUCCESS' || other.outcome !== 'SUCCESS') {
      throw new Error('expected success');
    }

    const result = await changeOwnPassword(
      { ...user.ctx, sessionId: keep.session.id },
      { currentPassword: PASSWORD, newPassword: 'Brand-New-Password-7' },
    );

    expect(result.revokedSessions).toBe(1);
    // The session that made the change survives; the other does not.
    expect(await loadSession(keep.session.token)).not.toBeNull();
    expect(await loadSession(other.session.token)).toBeNull();

    // The new password works and the old one does not.
    await expect(
      login({ email: 'admin@example.test', password: 'Brand-New-Password-7' }),
    ).resolves.toMatchObject({ outcome: 'SUCCESS' });
    await expect(login({ email: 'admin@example.test', password: PASSWORD })).rejects.toThrow();
  });

  it('refuses a wrong current password', async () => {
    await expect(
      changeOwnPassword(user.ctx, {
        currentPassword: 'Not-The-Password-1',
        newPassword: 'Brand-New-Password-7',
      }),
    ).rejects.toThrow(/current password is not correct/i);
  });

  it('refuses reusing the same password', async () => {
    await expect(
      changeOwnPassword(user.ctx, { currentPassword: PASSWORD, newPassword: PASSWORD }),
    ).rejects.toThrow(/must differ/i);
  });

  it('clears mustChangePassword and any lock', async () => {
    await prisma.user.update({
      where: { id: user.userId },
      data: { mustChangePassword: true, failedLoginAttempts: 3 },
    });

    await changeOwnPassword(user.ctx, {
      currentPassword: PASSWORD,
      newPassword: 'Brand-New-Password-7',
    });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { mustChangePassword: true, failedLoginAttempts: true, passwordChangedAt: true },
    });
    expect(row.mustChangePassword).toBe(false);
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.passwordChangedAt).toBeInstanceOf(Date);
  });

  it('audits the change at NOTICE severity', async () => {
    await changeOwnPassword(user.ctx, {
      currentPassword: PASSWORD,
      newPassword: 'Brand-New-Password-7',
    });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.password.changed' },
      select: { severity: true, actorUserId: true },
    });
    expect(audit.severity).toBe('NOTICE');
    expect(audit.actorUserId).toBe(user.userId);
  });
});

describe('CSRF', () => {
  it('accepts a matching token bound to the session', async () => {
    const result = await login({ email: 'admin@example.test', password: PASSWORD });
    if (result.outcome !== 'SUCCESS') throw new Error('expected success');

    const verdict = verifyCsrf({
      method: 'POST',
      headerToken: result.session.csrfToken,
      cookieToken: result.session.csrfToken,
      sessionCsrfTokenHash: hashToken(result.session.csrfToken),
      origin: env.APP_URL,
    });
    expect(verdict.ok).toBe(true);
  });

  it('never checks a safe method', () => {
    const verdict = verifyCsrf({
      method: 'GET',
      headerToken: null,
      cookieToken: null,
      sessionCsrfTokenHash: 'irrelevant',
      origin: 'https://evil.example',
    });
    expect(verdict.ok).toBe(true);
  });

  it('rejects a foreign origin', () => {
    const token = 'a'.repeat(43);
    const verdict = verifyCsrf({
      method: 'POST',
      headerToken: token,
      cookieToken: token,
      sessionCsrfTokenHash: hashToken(token),
      origin: 'https://evil.example',
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects a token from a DIFFERENT session', async () => {
    const mine = await login({ email: 'admin@example.test', password: PASSWORD });
    const theirs = await login({ email: 'admin@example.test', password: PASSWORD });
    if (mine.outcome !== 'SUCCESS' || theirs.outcome !== 'SUCCESS') {
      throw new Error('expected success');
    }

    // The token is valid in itself and matches its own cookie, but it is not bound
    // to this session — which is the property that makes a lifted token useless.
    const verdict = verifyCsrf({
      method: 'POST',
      headerToken: theirs.session.csrfToken,
      cookieToken: theirs.session.csrfToken,
      sessionCsrfTokenHash: hashToken(mine.session.csrfToken),
      origin: env.APP_URL,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/not bound to this session/i);
  });

  it('rejects a missing token', () => {
    const verdict = verifyCsrf({
      method: 'DELETE',
      headerToken: null,
      cookieToken: 'something',
      sessionCsrfTokenHash: 'irrelevant',
      origin: env.APP_URL,
    });
    expect(verdict.ok).toBe(false);
  });
});
