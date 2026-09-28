/**
 * Archive a student.
 *
 * Archiving, not deleting: attendance, grades and invoices stay attached to the
 * enrolments they were created under, and a deleted student would orphan a
 * ledger that the database will not let anyone rewrite anyway.
 *
 * `force` exists because the service refuses to archive someone who still owes
 * money. That refusal is the safe default -- an archived debtor quietly leaves
 * the debt reports -- so overriding it is a deliberate act and is recorded as
 * one in the audit row.
 */

import { z } from 'zod';
import { cuidSchema, reasonSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { archiveStudent } from '@/server/services/students/students';

export const POST = apiRoute(
  {
    permission: 'students.delete',
    params: z.object({ id: cuidSchema }),
    body: z.object({ reason: reasonSchema, force: z.boolean().default(false) }),
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, params, body, ok }) => {
    const result = await archiveStudent(ctx, params.id, {
      reason: body.reason,
      force: body.force,
    });

    return ok({ id: result.id, archivedAt: result.archivedAt });
  },
);
