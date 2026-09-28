/**
 * Sign in.
 *
 * PUBLIC by necessity, so it carries the only defences available before a
 * session exists: a per-IP rate limit, and a service that equalises its timing
 * and returns one message for every credential failure. Nothing here inspects
 * WHY a sign-in failed -- that reasoning lives in `login()` and reaches the
 * security log, never the response.
 */

import { loginSchema } from '@/lib/validation';
import { setSessionCookies } from '@/server/auth/session';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { login } from '@/server/services/auth/login';

export const POST = apiRoute(
  {
    permission: 'PUBLIC',
    body: loginSchema,
    rateLimit: RATE_LIMITS.login,
  },
  async ({ ctx, body, ok }) => {
    const result = await login({
      email: body.email,
      password: body.password,
      totpCode: body.totpCode,
      rememberMe: body.rememberMe,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    // The cookie is set for BOTH outcomes. A two-factor challenge needs a session
    // to hang the second step off, and that session is marked not-fully-
    // authenticated, so it opens no doors until the code clears.
    await setSessionCookies(result.session, body.rememberMe);

    if (result.outcome === 'TWO_FACTOR_REQUIRED') {
      return ok({ outcome: 'TWO_FACTOR_REQUIRED' as const });
    }

    return ok({
      outcome: 'SUCCESS' as const,
      displayName: result.displayName,
      mustChangePassword: result.mustChangePassword,
    });
  },
);
