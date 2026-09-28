/**
 * Read or amend one student.
 *
 * PATCH rather than PUT: the form sends only what changed, and the service
 * diffs it against the stored row so the audit entry names the fields that
 * actually moved instead of every field on the record.
 */

import { z } from 'zod';
import {
  cuidSchema,
  optionalDateOnlySchema,
  optionalEmailSchema,
  optionalPersonNameSchema,
  optionalPhoneSchema,
  personNameSchema,
} from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { getStudent, updateStudent } from '@/server/services/students/students';

const updateStudentSchema = z.object({
  firstName: personNameSchema.optional(),
  lastName: personNameSchema.optional(),
  middleName: optionalPersonNameSchema,
  dateOfBirth: optionalDateOnlySchema,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).optional(),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  addressLine: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const GET = apiRoute(
  {
    permission: 'students.view',
    params: z.object({ id: cuidSchema }),
  },
  async ({ ctx, params, ok }) => ok(await getStudent(ctx, params.id)),
);

export const PATCH = apiRoute(
  {
    permission: 'students.edit',
    params: z.object({ id: cuidSchema }),
    body: updateStudentSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, params, body, ok }) => {
    const student = await updateStudent(ctx, params.id, body);
    return ok({ id: student.id, fullName: student.fullName });
  },
);
