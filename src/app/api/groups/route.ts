/**
 * Create a class group.
 *
 * `code` is supplied rather than generated: a group code appears on a timetable
 * a parent reads and on the whiteboard outside the room, so it follows the
 * institution's own convention instead of a sequence we invented.
 */

import { z } from 'zod';
import { codeSchema, cuidSchema, optionalDateOnlySchema, shortTextSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { createGroup } from '@/server/services/academics/groups';

const createGroupSchema = z.object({
  name: shortTextSchema(120),
  code: codeSchema,
  branchId: cuidSchema.nullish(),
  programId: cuidSchema.nullish(),
  subjectId: cuidSchema.nullish(),
  level: z
    .enum([
      'BEGINNER',
      'ELEMENTARY',
      'PRE_INTERMEDIATE',
      'INTERMEDIATE',
      'UPPER_INTERMEDIATE',
      'ADVANCED',
    ])
    .nullish(),
  capacity: z.coerce.number().int().min(1).max(500).optional(),
  startDate: optionalDateOnlySchema,
  status: z
    .enum(['PLANNED', 'ENROLLING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'])
    .optional(),
});

export const POST = apiRoute(
  {
    permission: 'groups.create',
    body: createGroupSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, body, ok }) => {
    const group = await createGroup(ctx, body);
    return ok({ id: group.id, name: group.name, code: group.code }, { status: 201 });
  },
);
