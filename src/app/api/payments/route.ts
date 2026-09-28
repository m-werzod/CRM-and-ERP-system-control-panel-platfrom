/**
 * Record money received.
 *
 * `idempotencyKey` is required and comes from the client, generated once per
 * submission. It is what makes a retried request safe: `recordPayment` returns
 * the ORIGINAL payment rather than posting a second one, and says so through
 * `wasAlreadyRecorded`. A double-tapped Save on a slow connection must never
 * take the money twice.
 */

import { z } from 'zod';
import { cuidSchema, moneyInputSchema } from '@/lib/validation';
import { apiRoute } from '@/server/http/api';
import { RATE_LIMITS } from '@/server/security/rate-limit';
import { recordPayment } from '@/server/services/finance/payments';

const recordPaymentSchema = z.object({
  studentId: cuidSchema,
  money: moneyInputSchema(),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE', 'CREDIT_NOTE', 'OTHER']),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const POST = apiRoute(
  {
    permission: 'payments.create',
    body: recordPaymentSchema,
    // Money-moving writes get the tighter per-user budget, not the general one.
    rateLimit: RATE_LIMITS.financialWrite,
  },
  async ({ ctx, body, ok }) => {
    const result = await recordPayment(ctx, {
      studentId: body.studentId,
      amountMinor: BigInt(body.money.amountMinor),
      currency: body.money.currency,
      method: body.method,
      reference: body.reference ?? null,
      notes: body.notes ?? null,
      idempotencyKey: body.idempotencyKey,
    });

    return ok(
      {
        id: result.id,
        paymentNumber: result.paymentNumber,
        amountMinor: result.amountMinor.toString(),
        currency: result.currency,
        allocations: result.allocations.map((allocation) => ({
          invoiceNumber: allocation.invoiceNumber,
          amountMinor: allocation.amountMinor.toString(),
          remainingBalanceMinor: allocation.remainingBalanceMinor.toString(),
        })),
        creditedMinor: result.creditedMinor.toString(),
        wasAlreadyRecorded: result.wasAlreadyRecorded,
      },
      { status: result.wasAlreadyRecorded ? 200 : 201 },
    );
  },
);
