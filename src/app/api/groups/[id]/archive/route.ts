/**
 * Archive a group. Its lessons, attendance and grades stay attached to the
 * enrolments they were recorded under; only the group leaves the lists.
 */

import { z } from 'zod';
import { cuidSchema, reasonSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { archiveGroup } from '@/server/services/academics/groups';

export const POST = apiRoute(
  {
    permission: 'groups.delete',
    params: z.object({ id: cuidSchema }),
    body: z.object({ reason: reasonSchema }),
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, params, body, ok }) => {
    const group = await archiveGroup(ctx, params.id, { reason: body.reason });
    return ok({ id: group.id, archivedAt: group.archivedAt });
  },
);
