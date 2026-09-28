/**
 * Sign out: revoke the session server-side, then clear the cookies.
 *
 * Both "allow" flags are set deliberately. A user held at a two-factor prompt,
 * or at a forced password change, must still be able to leave -- refusing to
 * sign them out would strand them on a screen they cannot pass.
 */

import { clearSessionCookies } from '@/server/auth/session';
import { apiRoute } from '@/server/http/api';
import { logout } from '@/server/services/auth/login';

export const POST = apiRoute(
  {
    permission: 'AUTHENTICATED_ONLY',
    allowPartialAuth: true,
    allowPasswordChangePending: true,
  },
  async ({ ctx, ok }) => {
    await logout(ctx);
    await clearSessionCookies();
    return ok({ signedOut: true });
  },
);
