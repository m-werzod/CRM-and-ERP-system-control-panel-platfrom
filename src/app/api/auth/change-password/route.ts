/**
 * Change your own password.
 *
 * `allowPasswordChangePending` is required, not optional: an account flagged
 * `mustChangePassword` is refused by every other route, and this is the one it
 * has to reach to clear the flag.
 */

import { changePasswordSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { changeOwnPassword } from '@/server/services/auth/login';

export const POST = apiRoute(
  {
    permission: 'AUTHENTICATED_ONLY',
    body: changePasswordSchema,
    rateLimit: RATE_LIMITS.write,
    allowPasswordChangePending: true,
  },
  async ({ ctx, body, ok }) => {
    const { revokedSessions } = await changeOwnPassword(ctx, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });

    return ok({ revokedSessions });
  },
);
