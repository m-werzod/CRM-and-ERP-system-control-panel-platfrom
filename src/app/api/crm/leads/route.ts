/**
 * Capture an enquiry.
 *
 * `allowDuplicate` stays at its default here: someone is standing at the desk
 * or on the phone, and they can see that this is the same parent calling back.
 * The strict setting belongs to imports and the public capture form, where
 * nobody is there to judge.
 */

import { z } from 'zod';
import {
  cuidSchema,
  optionalEmailSchema,
  optionalPersonNameSchema,
  personNameSchema,
  phoneSchema,
} from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { createLead } from '@/server/services/crm/leads';

const createLeadSchema = z.object({
  firstName: personNameSchema,
  lastName: optionalPersonNameSchema,
  phone: phoneSchema,
  email: optionalEmailSchema,
  branchId: cuidSchema.nullish(),
  source: z
    .enum([
      'WALK_IN',
      'PHONE_CALL',
      'WEBSITE',
      'INSTAGRAM',
      'TELEGRAM',
      'FACEBOOK',
      'GOOGLE_ADS',
      'REFERRAL',
      'EVENT',
      'PARTNER',
      'OTHER',
    ])
    .optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const POST = apiRoute(
  {
    permission: 'leads.create',
    body: createLeadSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, body, ok }) => {
    const result = await createLead(ctx, body);
    return ok(result, { status: 201 });
  },
);
