/**
 * Turning a request into an AccessContext.
 *
 * This is the ONLY place that reads the session cookie and resolves roles. Every
 * page, route handler and server action obtains its authority here and passes it
 * down; nothing deeper re-derives permissions, so there is exactly one code path
 * to audit.
 *
 * The role resolution happens in a single query with nested selects rather than a
 * sequence of lookups, because it runs on literally every authenticated request.
 */

import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { prisma, type Db } from '@/server/db/client';
import {
  AccountInactiveError,
  PasswordChangeRequiredError,
  SessionExpiredError,
  TwoFactorRequiredError,
  UnauthenticatedError,
} from '@/server/errors';
import type { AccessContext, AccessScope } from '@/server/rbac/access';
import { clientIpFrom, loadSession, readSessionToken } from '@/server/auth/session';

/** Widest scope wins: a user who is both a teacher and a branch admin gets BRANCH. */
const SCOPE_RANK: Record<AccessScope, number> = { SELF: 1, BRANCH: 2, ORGANIZATION: 3 };

function widestScope(scopes: readonly AccessScope[]): AccessScope {
  return scopes.reduce<AccessScope>(
    (widest, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[widest] ? scope : widest),
    'SELF',
  );
}

export interface RequestMeta {
  readonly requestId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export async function readRequestMeta(): Promise<RequestMeta> {
  const headerList = await headers();
  return {
    // Honour an upstream request id so logs correlate across a proxy.
    requestId: headerList.get('x-request-id') ?? randomUUID(),
    ipAddress: clientIpFrom(headerList),
    userAgent: headerList.get('user-agent'),
  };
}

/**
 * Build the AccessContext for a known user. Separated from cookie handling so
 * tests, jobs and the login flow can construct a context without a request.
 */
export async function buildAccessContext(
  userId: string,
  meta: RequestMeta & { sessionId?: string | null },
  db: Db = prisma,
): Promise<AccessContext> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      mustChangePassword: true,
      deletedAt: true,
      organization: { select: { status: true } },
      userRoles: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: {
          branchId: true,
          role: {
            select: {
              key: true,
              scope: true,
              level: true,
              deletedAt: true,
              permissions: { select: { permission: { select: { key: true } } } },
            },
          },
        },
      },
      userBranches: { select: { branchId: true, isPrimary: true } },
      employee: { select: { id: true, branchId: true, teacher: { select: { id: true } } } },
      studentProfile: { select: { id: true } },
      guardianProfile: { select: { id: true } },
    },
  });

  if (!user || user.deletedAt) throw new UnauthenticatedError();
  if (user.organization.status !== 'ACTIVE') {
    throw new AccountInactiveError('This organisation is not active. Contact support.');
  }
  if (user.status !== 'ACTIVE' && user.status !== 'INVITED') {
    throw new AccountInactiveError();
  }

  const activeRoles = user.userRoles.filter((assignment) => !assignment.role.deletedAt);

  const permissions = new Set<string>();
  for (const assignment of activeRoles) {
    for (const entry of assignment.role.permissions) permissions.add(entry.permission.key);
  }

  const scope = widestScope(activeRoles.map((assignment) => assignment.role.scope));
  const roleLevel = activeRoles.reduce((max, a) => Math.max(max, a.role.level), 0);
  const roleKeys = [...new Set(activeRoles.map((assignment) => assignment.role.key))];

  // Branch reach = explicit UserBranch grants + any branch pinned on a role
  // grant + the employee's own branch. A BRANCH-scoped user with none of these
  // sees nothing, which is the correct fail-closed outcome.
  const branchIds = new Set<string>();
  for (const row of user.userBranches) branchIds.add(row.branchId);
  for (const assignment of activeRoles) {
    if (assignment.branchId) branchIds.add(assignment.branchId);
  }
  if (user.employee?.branchId) branchIds.add(user.employee.branchId);

  const primaryBranchId =
    user.userBranches.find((row) => row.isPrimary)?.branchId ??
    user.employee?.branchId ??
    [...branchIds][0] ??
    null;

  return {
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    displayName: `${user.firstName} ${user.lastName}`.trim(),
    permissions,
    scope,
    roleLevel,
    roleKeys,
    branchIds: [...branchIds],
    primaryBranchId,
    self: {
      teacherId: user.employee?.teacher?.id ?? null,
      employeeId: user.employee?.id ?? null,
      studentId: user.studentProfile?.id ?? null,
      guardianId: user.guardianProfile?.id ?? null,
    },
    requestId: meta.requestId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    sessionId: meta.sessionId ?? null,
    isSystem: false,
  };
}

export interface AuthenticatedRequest {
  readonly ctx: AccessContext;
  readonly sessionId: string;
  readonly csrfTokenHash: string;
  readonly mustChangePassword: boolean;
  readonly isFullyAuthenticated: boolean;
}

/**
 * Resolve the current session without enforcing anything. Returns null when
 * unauthenticated, so a public page can render differently rather than redirect.
 */
export async function getOptionalAuth(db: Db = prisma): Promise<AuthenticatedRequest | null> {
  const token = await readSessionToken();
  if (!token) return null;

  const loaded = await loadSession(token, db);
  if (!loaded) return null;

  const meta = await readRequestMeta();

  let ctx: AccessContext;
  try {
    ctx = await buildAccessContext(loaded.session.userId, { ...meta, sessionId: loaded.session.id }, db);
  } catch {
    // The session is valid but the account is not usable (deactivated, org
    // suspended, deleted). Treat it as unauthenticated here; the enforcing
    // helpers below surface the specific reason.
    return null;
  }

  const user = await db.user.findUnique({
    where: { id: loaded.session.userId },
    select: { mustChangePassword: true },
  });

  return {
    ctx,
    sessionId: loaded.session.id,
    csrfTokenHash: loaded.csrfTokenHash,
    mustChangePassword: user?.mustChangePassword ?? false,
    isFullyAuthenticated: loaded.session.isFullyAuthenticated,
  };
}

/**
 * Require a fully usable session. Throws the specific reason so the UI can route
 * to the right screen: a 2FA prompt, a forced password change, or the login page.
 */
export async function requireAuth(
  options: { allowPasswordChangePending?: boolean; allowPartialAuth?: boolean } = {},
  db: Db = prisma,
): Promise<AuthenticatedRequest> {
  const token = await readSessionToken();
  if (!token) throw new UnauthenticatedError();

  const loaded = await loadSession(token, db);
  if (!loaded) throw new SessionExpiredError();

  const meta = await readRequestMeta();
  // Deliberately NOT swallowed: buildAccessContext throws
  // AccountInactiveError / UnauthenticatedError with the real reason.
  const ctx = await buildAccessContext(
    loaded.session.userId,
    { ...meta, sessionId: loaded.session.id },
    db,
  );

  if (!loaded.session.isFullyAuthenticated && !options.allowPartialAuth) {
    throw new TwoFactorRequiredError();
  }

  const user = await db.user.findUnique({
    where: { id: loaded.session.userId },
    select: { mustChangePassword: true },
  });
  const mustChangePassword = user?.mustChangePassword ?? false;

  if (mustChangePassword && !options.allowPasswordChangePending) {
    throw new PasswordChangeRequiredError();
  }

  return {
    ctx,
    sessionId: loaded.session.id,
    csrfTokenHash: loaded.csrfTokenHash,
    mustChangePassword,
    isFullyAuthenticated: loaded.session.isFullyAuthenticated,
  };
}

/** Convenience for pages that only need the context. */
export async function requireContext(db: Db = prisma): Promise<AccessContext> {
  return (await requireAuth({}, db)).ctx;
}
