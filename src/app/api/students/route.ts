/**
 * Student lookup for typeaheads.
 *
 * Deliberately small and read-only: it exists so a form can resolve "who is this
 * payment from" without shipping every student to the browser. The service
 * applies the caller's branch scope, so the results are already narrowed to what
 * this user may see -- the endpoint adds no filtering of its own.
 */

import { z } from 'zod';
import {
  cuidSchema,
  optionalDateOnlySchema,
  optionalEmailSchema,
  optionalPersonNameSchema,
  optionalPhoneSchema,
  personNameSchema,
  searchTermSchema,
} from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { createStudent, listStudents } from '@/server/services/students/students';

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

const createStudentSchema = z.object({
  firstName: personNameSchema,
  lastName: personNameSchema,
  middleName: optionalPersonNameSchema,
  dateOfBirth: optionalDateOnlySchema,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']).optional(),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  addressLine: z.string().trim().max(300).optional(),
  city: z.string().trim().max(120).optional(),
  // Optional on purpose: a branch-scoped caller has exactly one answer, and
  // `resolveWriteBranch` in the service supplies it rather than the form.
  branchId: cuidSchema.nullish(),
  notes: z.string().trim().max(2000).optional(),
});

export const POST = apiRoute(
  {
    permission: 'students.create',
    body: createStudentSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, body, ok }) => {
    const student = await createStudent(ctx, {
      firstName: body.firstName,
      lastName: body.lastName,
      middleName: body.middleName,
      dateOfBirth: body.dateOfBirth,
      gender: body.gender,
      phone: body.phone,
      email: body.email,
      addressLine: body.addressLine,
      city: body.city,
      branchId: body.branchId,
      notes: body.notes,
    });

    return ok(
      {
        id: student.id,
        studentCode: student.studentCode,
        fullName: student.fullName,
      },
      { status: 201 },
    );
  },
);
