/**
 * Refund use-cases.
 *
 * A refund is a three-step workflow — request, approve, process — not a single
 * button. The steps are separated because money leaving the institution is the
 * action most worth a second pair of eyes, and because the approval threshold is a
 * configurable policy (`finance.refundApprovalThresholdMinor`) rather than a
 * hard-coded rule.
 *
 * A refund never edits the original payment. `REFUND_ISSUED` is appended to the
 * ledger and the invoice's derived totals are recomputed, so the payment, the
 * refund and the resulting balance are all independently visible afterwards. The
 * refund can be paid out in cash/transfer, or issued as credit the student can
 * spend on a future invoice.
 */

import type { PaymentMethod } from '@/generated/prisma/client';
import { withSerializableRetry, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  requirePermission,
  scopeFilter,
  can,
  type AccessContext,
} from '@/server/rbac/access';
import { getSetting } from '@/server/settings';
import { assertCurrency, formatMoney, money } from '@/lib/money';
import { appendLedgerEntry, recalculateInvoice } from '@/server/services/finance/ledger';
import { nextRefundNumber } from '@/server/services/finance/numbering';

export interface RequestRefundInput {
  readonly paymentId: string;
  /** Defaults to the whole refundable remainder of the payment. */
  readonly amountMinor?: bigint;
  readonly reason: string;
  /** How the money goes back. CREDIT_NOTE keeps it on account. */
  readonly method?: PaymentMethod;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly id: string;
  readonly refundNumber: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSED';
  /** True when the caller's own permission satisfied the approval requirement. */
  readonly autoApproved: boolean;
  readonly wasAlreadyRequested: boolean;
}

/**
 * How much of a payment may still be refunded: what came in, minus what has
 * already gone back out or is committed to going out.
 *
 * Pending and approved refunds are counted so two concurrent requests cannot each
 * claim the full amount.
 */
async function refundableAmount(
  tx: Parameters<Parameters<typeof withSerializableRetry>[0]>[0],
  paymentId: string,
): Promise<bigint> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { amountMinor: true },
  });
  if (!payment) throw new NotFoundError('Payment', paymentId);

  const committed = await tx.refund.aggregate({
    where: {
      paymentId,
      status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PROCESSED'] },
    },
    _sum: { amountMinor: true },
  });

  return payment.amountMinor - (committed._sum.amountMinor ?? 0n);
}

/**
 * Request a refund. Auto-approves when the amount is below the configured
 * threshold AND the caller holds `payments.approveRefund`, so a small correction
 * by an authorised accountant is not gated on a second person who does not exist
 * in a small branch.
 */
export async function requestRefund(
  ctx: AccessContext,
  input: RequestRefundInput,
  db?: Db,
): Promise<RefundResult> {
  requirePermission(ctx, 'payments.refund');

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      'refund.reason_required',
      'A refund must record why the money is being returned.',
    );
  }
  if (!input.idempotencyKey.trim()) {
    throw new BusinessRuleError(
      'refund.missing_idempotency_key',
      'An idempotency key is required to request a refund.',
    );
  }

  return withSerializableRetry(
    async (tx) => {
      const existing = await tx.refund.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          organizationId: true,
          refundNumber: true,
          amountMinor: true,
          currency: true,
          status: true,
        },
      });
      if (existing) {
        if (existing.organizationId !== ctx.organizationId) {
          throw new ConflictError('This refund reference has already been used.');
        }
        return {
          id: existing.id,
          refundNumber: existing.refundNumber,
          amountMinor: existing.amountMinor,
          currency: existing.currency,
          status: existing.status as RefundResult['status'],
          autoApproved: false,
          wasAlreadyRequested: true,
        };
      }

      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, ...scopeFilter(ctx) },
        select: {
          id: true,
          paymentNumber: true,
          status: true,
          amountMinor: true,
          currency: true,
          branchId: true,
          studentId: true,
          invoiceId: true,
          allocations: { select: { invoiceId: true, amountMinor: true } },
        },
      });
      if (!payment) throw new NotFoundError('Payment', input.paymentId);

      if (payment.status !== 'COMPLETED') {
        throw new StateInvalidError('payment', payment.status.toLowerCase(), 'refunded');
      }

      const available = await refundableAmount(tx, payment.id);
      if (available <= 0n) {
        throw new BusinessRuleError(
          'refund.nothing_refundable',
          'This payment has already been fully refunded.',
        );
      }

      const amount = input.amountMinor ?? available;
      if (amount <= 0n) {
        throw new BusinessRuleError(
          'refund.non_positive_amount',
          'A refund must be for a positive amount.',
        );
      }
      if (amount > available) {
        throw new BusinessRuleError(
          'refund.exceeds_refundable',
          `Only ${formatMoney(money(available, payment.currency))} of this payment can still be refunded.`,
          { details: { availableMinor: available.toString() } },
        );
      }

      const currency = assertCurrency(payment.currency);
      const thresholdRaw = await getSetting(
        'refundApprovalThresholdMinor',
        { organizationId: ctx.organizationId, branchId: payment.branchId },
        tx,
      );
      const threshold = BigInt(thresholdRaw);

      // A threshold of 0 means every refund needs explicit approval.
      const needsSecondApproval = threshold === 0n || amount >= threshold;
      const canApprove = can(ctx, 'payments.approveRefund');
      const autoApproved = !needsSecondApproval && canApprove;

      const refundNumber = await nextRefundNumber(tx, {
        organizationId: ctx.organizationId,
        branchId: payment.branchId,
      });

      const refund = await tx.refund.create({
        data: {
          organizationId: ctx.organizationId,
          refundNumber,
          paymentId: payment.id,
          // Attribute to the single invoice the payment settled, when there was one.
          invoiceId:
            payment.allocations.length === 1 ? payment.allocations[0]!.invoiceId : payment.invoiceId,
          amountMinor: amount,
          currency,
          method: input.method ?? 'CASH',
          reason: input.reason,
          status: autoApproved ? 'APPROVED' : 'PENDING_APPROVAL',
          requestedById: ctx.isSystem ? null : ctx.userId,
          approvedById: autoApproved ? ctx.userId : null,
          approvedAt: autoApproved ? new Date() : null,
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true, refundNumber: true },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.REFUND_REQUESTED,
          entityType: 'Refund',
          entityId: refund.id,
          branchId: payment.branchId,
          summary: `Refund ${refundNumber} of ${formatMoney(money(amount, currency))} requested against payment ${payment.paymentNumber}`,
          reason: input.reason,
          severity: 'NOTICE',
          metadata: {
            amountMinor: amount.toString(),
            currency,
            autoApproved,
            thresholdMinor: threshold.toString(),
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: payment.studentId,
            type: 'refund.requested',
            title: `Refund requested: ${formatMoney(money(amount, currency))}`,
            description: input.reason,
          },
        },
        tx,
      );

      return {
        id: refund.id,
        refundNumber,
        amountMinor: amount,
        currency,
        status: autoApproved ? 'APPROVED' : 'PENDING_APPROVAL',
        autoApproved,
        wasAlreadyRequested: false,
      };
    },
    { existing: db },
  );
}

/**
 * Approve a pending refund.
 *
 * The approver may not be the requester unless they are the same person who is
 * also allowed to self-approve under the threshold rule — separation of duties is
 * the entire point of this step, so a four-eyes check is enforced here rather than
 * left to procedure.
 */
export async function approveRefund(
  ctx: AccessContext,
  refundId: string,
  input: { note?: string | null } = {},
  db?: Db,
): Promise<{ id: string; status: 'APPROVED' }> {
  requirePermission(ctx, 'payments.approveRefund');

  return withSerializableRetry(
    async (tx) => {
      const refund = await tx.refund.findFirst({
        where: { id: refundId, organizationId: ctx.organizationId },
        select: {
          id: true,
          refundNumber: true,
          status: true,
          amountMinor: true,
          currency: true,
          requestedById: true,
          payment: { select: { branchId: true, studentId: true, paymentNumber: true } },
        },
      });
      if (!refund) throw new NotFoundError('Refund', refundId);
      if (refund.status !== 'PENDING_APPROVAL') {
        throw new StateInvalidError('refund', refund.status.toLowerCase(), 'approved');
      }
      if (refund.requestedById && refund.requestedById === ctx.userId) {
        throw new ForbiddenError(
          'A refund must be approved by someone other than the person who requested it.',
          { details: { refundId } },
        );
      }

      await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date() },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.REFUND_APPROVED,
          entityType: 'Refund',
          entityId: refund.id,
          branchId: refund.payment.branchId,
          summary: `Refund ${refund.refundNumber} of ${formatMoney(money(refund.amountMinor, refund.currency))} approved`,
          reason: input.note ?? null,
          severity: 'WARNING',
          metadata: { amountMinor: refund.amountMinor.toString(), currency: refund.currency },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: refund.payment.studentId,
            type: 'refund.approved',
            title: `Refund ${refund.refundNumber} approved`,
          },
        },
        tx,
      );

      return { id: refund.id, status: 'APPROVED' };
    },
    { existing: db },
  );
}

export async function rejectRefund(
  ctx: AccessContext,
  refundId: string,
  input: { reason: string },
  db?: Db,
): Promise<{ id: string; status: 'REJECTED' }> {
  requirePermission(ctx, 'payments.approveRefund');

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      'refund.rejection_needs_reason',
      'Rejecting a refund must record why.',
    );
  }

  return withSerializableRetry(
    async (tx) => {
      const refund = await tx.refund.findFirst({
        where: { id: refundId, organizationId: ctx.organizationId },
        select: {
          id: true,
          refundNumber: true,
          status: true,
          payment: { select: { branchId: true, studentId: true } },
        },
      });
      if (!refund) throw new NotFoundError('Refund', refundId);
      if (refund.status !== 'PENDING_APPROVAL') {
        throw new StateInvalidError('refund', refund.status.toLowerCase(), 'rejected');
      }

      await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'REJECTED', rejectionReason: input.reason, approvedById: ctx.userId },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.REFUND_REJECTED,
          entityType: 'Refund',
          entityId: refund.id,
          branchId: refund.payment.branchId,
          summary: `Refund ${refund.refundNumber} rejected`,
          reason: input.reason,
          severity: 'NOTICE',
          timeline: {
            subjectType: 'STUDENT',
            subjectId: refund.payment.studentId,
            type: 'refund.rejected',
            title: `Refund ${refund.refundNumber} rejected`,
            description: input.reason,
          },
        },
        tx,
      );

      return { id: refund.id, status: 'REJECTED' };
    },
    { existing: db },
  );
}

/**
 * Process an approved refund: this is the step that moves the money on the ledger.
 *
 * For a CREDIT_NOTE refund the money stays with the institution as student credit
 * rather than being paid out. For every other method the payout itself happens
 * outside the system (cash drawer, bank transfer); this records that it did, which
 * is why `processedAt` and the operator are captured.
 */
export async function processRefund(
  ctx: AccessContext,
  refundId: string,
  input: { providerRef?: string | null } = {},
  db?: Db,
): Promise<{ id: string; status: 'PROCESSED'; creditId: string | null }> {
  requirePermission(ctx, 'payments.refund');

  return withSerializableRetry(
    async (tx) => {
      const refund = await tx.refund.findFirst({
        where: { id: refundId, organizationId: ctx.organizationId },
        select: {
          id: true,
          refundNumber: true,
          status: true,
          amountMinor: true,
          currency: true,
          method: true,
          reason: true,
          invoiceId: true,
          payment: {
            select: {
              id: true,
              paymentNumber: true,
              branchId: true,
              studentId: true,
              allocations: { select: { invoiceId: true, amountMinor: true } },
            },
          },
        },
      });
      if (!refund) throw new NotFoundError('Refund', refundId);
      if (refund.status !== 'APPROVED') {
        throw new StateInvalidError('refund', refund.status.toLowerCase(), 'processed');
      }

      const now = new Date();
      const currency = assertCurrency(refund.currency);

      // Attribute the refund to the invoices the payment settled, proportionally,
      // so each invoice's own balance reflects the money that came back out of it.
      const allocations = refund.payment.allocations;
      const allocatedTotal = allocations.reduce((total, a) => total + a.amountMinor, 0n);

      const touched = new Set<string>();
      if (allocations.length === 0 || allocatedTotal === 0n) {
        // The payment was entirely overpayment: nothing to attribute to an invoice.
        await appendLedgerEntry(ctx, tx, {
          entryType: 'REFUND_ISSUED',
          direction: 'DEBIT',
          amountMinor: refund.amountMinor,
          currency,
          branchId: refund.payment.branchId,
          studentId: refund.payment.studentId,
          paymentId: refund.payment.id,
          refundId: refund.id,
          occurredAt: now,
          description: `Refund ${refund.refundNumber} issued`,
        });
      } else {
        let distributed = 0n;
        for (const [index, allocation] of allocations.entries()) {
          const isLast = index === allocations.length - 1;
          // The last slice absorbs the rounding remainder so the parts sum exactly
          // to the refund amount.
          const share = isLast
            ? refund.amountMinor - distributed
            : (refund.amountMinor * allocation.amountMinor) / allocatedTotal;
          if (share <= 0n) continue;
          distributed += share;

          await appendLedgerEntry(ctx, tx, {
            entryType: 'REFUND_ISSUED',
            direction: 'DEBIT',
            amountMinor: share,
            currency,
            branchId: refund.payment.branchId,
            studentId: refund.payment.studentId,
            invoiceId: allocation.invoiceId,
            paymentId: refund.payment.id,
            refundId: refund.id,
            occurredAt: now,
            description: `Refund ${refund.refundNumber} issued`,
          });
          touched.add(allocation.invoiceId);
        }
      }

      let creditId: string | null = null;
      if (refund.method === 'CREDIT_NOTE') {
        const credit = await tx.studentCredit.create({
          data: {
            organizationId: ctx.organizationId,
            studentId: refund.payment.studentId,
            source: 'REFUND_AS_CREDIT',
            sourceRefundId: refund.id,
            amountMinor: refund.amountMinor,
            balanceMinor: refund.amountMinor,
            currency,
            status: 'AVAILABLE',
            note: `Refund ${refund.refundNumber}: ${refund.reason}`,
            createdById: ctx.isSystem ? null : ctx.userId,
          },
          select: { id: true },
        });
        creditId = credit.id;

        await appendLedgerEntry(ctx, tx, {
          entryType: 'CREDIT_ISSUED',
          direction: 'CREDIT',
          amountMinor: refund.amountMinor,
          currency,
          branchId: refund.payment.branchId,
          studentId: refund.payment.studentId,
          refundId: refund.id,
          creditId: credit.id,
          occurredAt: now,
          description: `Refund ${refund.refundNumber} issued as account credit`,
        });
      }

      await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: 'PROCESSED',
          processedAt: now,
          providerRef: input.providerRef ?? null,
        },
      });

      for (const invoiceId of touched) {
        await recalculateInvoice(tx, invoiceId, { now });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.REFUND_PROCESSED,
          entityType: 'Refund',
          entityId: refund.id,
          branchId: refund.payment.branchId,
          summary: `Refund ${refund.refundNumber} of ${formatMoney(money(refund.amountMinor, currency))} processed via ${refund.method}`,
          reason: refund.reason,
          severity: 'WARNING',
          metadata: {
            amountMinor: refund.amountMinor.toString(),
            currency,
            method: refund.method,
            issuedAsCredit: refund.method === 'CREDIT_NOTE',
            invoiceCount: touched.size,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: refund.payment.studentId,
            type: 'refund.processed',
            title: `Refund issued: ${formatMoney(money(refund.amountMinor, currency))}`,
            description:
              refund.method === 'CREDIT_NOTE'
                ? 'Held as credit on account'
                : `Paid out by ${refund.method.toLowerCase().replace('_', ' ')}`,
            occurredAt: now,
          },
        },
        tx,
      );

      return { id: refund.id, status: 'PROCESSED', creditId };
    },
    { existing: db },
  );
}
