/**
 * Provision a staff, teacher or administrator account.
 *
 * The response carries a temporary password that exists nowhere else: the
 * service hashes it before returning, never stores it readably and never writes
 * it to the audit log. If the administrator loses it, a reset is the only way
 * to issue another -- which is why the UI shows it once, prominently.
 */

import { z } from 'zod';
import {
  cuidSchema,
  emailSchema,
  optionalPhoneSchema,
  personNameSchema,
} from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { createUser } from '@/server/services/admin/users';

const createUserSchema = z.object({
  email: emailSchema,
  firstName: personNameSchema,
  lastName: personNameSchema,
  phone: optionalPhoneSchema,
  // At least one, because an account with no role can sign in and do nothing --
  // which reads to the user as a broken product rather than a missing grant.
  roleIds: z.array(cuidSchema).min(1, 'Choose at least one role'),
  branchIds: z.array(cuidSchema).default([]),
  primaryBranchId: cuidSchema.nullish(),
});

export const POST = apiRoute(
  {
    permission: 'users.create',
    body: createUserSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, body, ok }) => {
    const result = await createUser(ctx, {
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      roleIds: body.roleIds,
      branchIds: body.branchIds,
      primaryBranchId: body.primaryBranchId,
    });

    return ok(
      {
        id: result.user.id,
        fullName: result.user.fullName,
        email: result.user.email,
        temporaryPassword: result.temporaryPassword,
      },
      { status: 201 },
    );
  },
);
