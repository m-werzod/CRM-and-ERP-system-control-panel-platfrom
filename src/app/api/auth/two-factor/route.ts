/**
 * Second step of a two-factor sign-in: promote the partial session issued by
 * `/api/auth/login` to a fully authenticated one.
 *
 * `allowPartialAuth` is the whole point -- every other authenticated route
 * refuses a session in this state.
 */

import { twoFactorCodeSchema } from '@/lib/validation';
import { UnauthenticatedError } from '@/server/errors';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { completeTwoFactor } from '@/server/services/auth/login';

export const POST = apiRoute(
  {
    permission: 'AUTHENTICATED_ONLY',
    body: twoFactorCodeSchema,
    rateLimit: RATE_LIMITS.twoFactorVerify,
    allowPartialAuth: true,
    // A forced password change is checked after the factor, not before it.
    allowPasswordChangePending: true,
  },
  async ({ auth, ctx, body, ok }) => {
    if (!auth) throw new UnauthenticatedError();

    const result = await completeTwoFactor({
      sessionId: auth.sessionId,
      code: body.code,
      ipAddress: ctx.ipAddress,
    });

    return ok({ mustChangePassword: result.mustChangePassword });
  },
);
