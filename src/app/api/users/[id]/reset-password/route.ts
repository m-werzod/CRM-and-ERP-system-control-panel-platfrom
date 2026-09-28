/**
 * Issue a new temporary password for someone else's account.
 *
 * Separate from `/api/auth/change-password`, which acts on your own account and
 * needs the current password. This one is an administrative override, gated by
 * `users.resetPassword`, and the service refuses a target at or above the
 * caller's own role level so it cannot be used to seize a superior's account.
 *
 * Every other session of that user is revoked as a side effect: a password
 * reset that leaves the old sessions alive protects nobody.
 */

import { z } from 'zod';
import { cuidSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { adminResetPassword } from '@/server/services/admin/users';

export const POST = apiRoute(
  {
    permission: 'users.resetPassword',
    params: z.object({ id: cuidSchema }),
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, params, ok }) => {
    const result = await adminResetPassword(ctx, params.id);

    return ok({
      temporaryPassword: result.temporaryPassword,
      sessionsRevoked: result.sessionsRevoked,
    });
  },
);
