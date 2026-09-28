/**
 * Student lookup for typeaheads.
 *
 * Deliberately small and read-only: it exists so a form can resolve "who is this
 * payment from" without shipping every student to the browser. The service
 * applies the caller's branch scope, so the results are already narrowed to what
 * this user may see -- the endpoint adds no filtering of its own.
 */

import { z } from 'zod';
import { searchTermSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { listStudents } from '@/server/services/students/students';

const querySchema = z.object({
  q: searchTermSchema.optional(),
  // A typeahead shows a handful of rows; a bigger page would just be discarded.
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const GET = apiRoute(
  {
    permission: 'students.view',
    query: querySchema,
    rateLimit: RATE_LIMITS.search,
  },
  async ({ ctx, query, ok }) => {
    const result = await listStudents(ctx, { q: query.q, page: 1, pageSize: query.limit });

    return ok(
      result.rows.map((row) => ({
        id: row.id,
        fullName: row.fullName,
        studentCode: row.studentCode,
        branchName: row.branchName,
      })),
    );
  },
);
