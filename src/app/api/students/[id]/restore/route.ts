/**
 * Undo an archive. The counterpart to the archive route, and the reason
 * archiving is preferred to deletion in the first place.
 */

import { z } from 'zod';
import { cuidSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { restoreStudent } from '@/server/services/students/students';

export const POST = apiRoute(
  {
    permission: 'students.restore',
    params: z.object({ id: cuidSchema }),
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, params, ok }) => ok(await restoreStudent(ctx, params.id)),
);
