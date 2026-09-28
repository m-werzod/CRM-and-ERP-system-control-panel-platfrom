/**
 * Invoice use-cases.
 *
 * An invoice's line items are priced once, at issue, and then frozen. A later
 * change to a FeePlan, a Discount definition or a TaxRate must not retroactively
 * alter a document that has already been sent to a parent — so `InvoiceItem` and
 * `InvoiceDiscount` store the computed figures rather than pointing at a live
 * price, and the totals are recomputed only while the invoice is still DRAFT.
 */

import type { InvoiceItemKind, Prisma } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  diffFields,
  record as recordAudit,
} from '@/server/audit';
import {
  assertBranchAccess,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { addDaysToDateOnly, dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import { applyPpm, assertCurrency, money, type CurrencyCode } from '@/lib/money';
import { appendLedgerEntry, recalculateInvoice } from '@/server/services/finance/ledger';
import { nextInvoiceNumber } from '@/server/services/finance/numbering';
import { currencyFor } from '@/server/services/finance/currency';

export interface InvoiceLineInput {
  readonly description: string;
  readonly kind: InvoiceItemKind;
  readonly quantity: number;
  /** Minor units. */
  readonly unitPriceMinor: bigint;
  readonly discountMinor?: bigint;
  /** Parts-per-million, e.g. 120_000 for 12% VAT. */
  readonly taxRatePpm?: number;
  readonly programId?: string | null;
  readonly groupId?: string | null;
}

export interface InvoiceDiscountInput {
  readonly label: string;
  readonly type: 'FIXED' | 'PERCENT' | 'SCHOLARSHIP';
  readonly amountMinor?: bigint;
  readonly percentPpm?: number;
  readonly discountId?: string | null;
  readonly reason?: string | null;
}

export interface CreateInvoiceInput {
  readonly studentId: string;
  readonly branchId?: string | null;
  readonly currency?: string;
  readonly issueDate?: DateOnly;
  readonly dueDate?: DateOnly;
  readonly periodStart?: DateOnly | null;
  readonly periodEnd?: DateOnly | null;
  readonly feePlanId?: string | null;
  readonly items: readonly InvoiceLineInput[];
  readonly discounts?: readonly InvoiceDiscountInput[];
  readonly notes?: string | null;
  /** Issue immediately instead of leaving a draft. */
  readonly issueNow?: boolean;
}

interface ComputedLine {
  readonly description: string;
  readonly kind: InvoiceItemKind;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxRatePpm: number;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly programId: string | null;
  readonly groupId: string | null;
  readonly sequence: number;
}

export interface InvoiceTotalsBreakdown {
  readonly lines: readonly ComputedLine[];
  readonly subtotalMinor: bigint;
  readonly lineDiscountMinor: bigint;
  readonly invoiceDiscountMinor: bigint;
  readonly discountTotalMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly totalMinor: bigint;
  readonly appliedDiscounts: ReadonlyArray<{
    readonly label: string;
    readonly type: 'FIXED' | 'PERCENT' | 'SCHOLARSHIP';
    readonly percentPpm: number | null;
    readonly amountMinor: bigint;
    readonly discountId: string | null;
    readonly reason: string | null;
  }>;
}

/**
 * Compute every figure on an invoice.
 *
 * Pure and exported so it is unit-testable without a database, and so the UI can
 * preview a total before saving using exactly the same arithmetic the server will
 * use. Duplicating this in the client would be how "the preview said 90 but the
 * invoice says 89" bugs happen.
 *
 * Order of operations, which matters:
 *   1. each line: quantity x unitPrice, minus the line discount
 *   2. invoice-level discounts, applied to the post-line-discount subtotal
 *   3. tax, computed per line on that line's share of the discounted subtotal
 * Tax after discount is the common statutory treatment; taxing the pre-discount
 * amount would over-charge.
 */
export function computeInvoiceTotals(input: {
  readonly items: readonly InvoiceLineInput[];
  readonly discounts?: readonly InvoiceDiscountInput[];
  readonly currency: CurrencyCode;
}): InvoiceTotalsBreakdown {
  if (input.items.length === 0) {
    throw new BusinessRuleError('invoice.no_items', 'An invoice must have at least one line.');
  }

  const currency = input.currency;

  // --- 1. lines, before invoice-level discounts ---------------------------
  const base = input.items.map((item, index) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new BusinessRuleError(
        'invoice.invalid_quantity',
        `Line ${index + 1}: quantity must be a whole number of at least 1.`,
      );
    }
    if (item.unitPriceMinor < 0n) {
      throw new BusinessRuleError(
        'invoice.negative_price',
        `Line ${index + 1}: the unit price cannot be negative.`,
      );
    }
    const gross = item.unitPriceMinor * BigInt(item.quantity);
    const lineDiscount = item.discountMinor ?? 0n;
    if (lineDiscount < 0n || lineDiscount > gross) {
      throw new BusinessRuleError(
        'invoice.invalid_line_discount',
        `Line ${index + 1}: the discount cannot be negative or exceed the line total.`,
      );
    }
    return { item, index, gross, lineDiscount, net: gross - lineDiscount };
  });

  const subtotalMinor = base.reduce((total, line) => total + line.gross, 0n);
  const lineDiscountMinor = base.reduce((total, line) => total + line.lineDiscount, 0n);
  const netAfterLineDiscounts = subtotalMinor - lineDiscountMinor;

  // --- 2. invoice-level discounts ----------------------------------------
  const appliedDiscounts: Array<{
    label: string;
    type: 'FIXED' | 'PERCENT' | 'SCHOLARSHIP';
    percentPpm: number | null;
    amountMinor: bigint;
    discountId: string | null;
    reason: string | null;
  }> = [];

  let invoiceDiscountMinor = 0n;
  let remaining = netAfterLineDiscounts;

  for (const discount of input.discounts ?? []) {
    let amount: bigint;
    if (discount.type === 'PERCENT') {
      if (discount.percentPpm == null) {
        throw new BusinessRuleError(
          'invoice.discount_missing_percent',
          `Discount "${discount.label}" is a percentage but has no rate.`,
        );
      }
      // Applied to what remains, so two stacked 10% discounts are 19%, not 20%.
      // Stating this explicitly because both conventions exist in the wild.
      amount = applyPpm(money(remaining, currency), discount.percentPpm).amountMinor;
    } else {
      if (discount.amountMinor == null) {
        throw new BusinessRuleError(
          'invoice.discount_missing_amount',
          `Discount "${discount.label}" is a fixed amount but has no value.`,
        );
      }
      amount = discount.amountMinor;
    }

    if (amount < 0n) {
      throw new BusinessRuleError(
        'invoice.negative_discount',
        `Discount "${discount.label}" cannot be negative.`,
      );
    }
    // Never let discounts drive a total below zero: an invoice for a negative
    // amount is a credit note, which is a different document.
    if (amount > remaining) amount = remaining;

    invoiceDiscountMinor += amount;
    remaining -= amount;
    appliedDiscounts.push({
      label: discount.label,
      type: discount.type,
      percentPpm: discount.type === 'PERCENT' ? (discount.percentPpm ?? null) : null,
      amountMinor: amount,
      discountId: discount.discountId ?? null,
      reason: discount.reason ?? null,
    });
  }

  // --- 3. tax, per line, on the discounted amount ------------------------
  // The invoice-level discount is spread across lines in proportion to their net
  // value so each line is taxed on what was actually charged for it.
  const lines: ComputedLine[] = base.map((line) => {
    const share =
      netAfterLineDiscounts === 0n
        ? 0n
        : (invoiceDiscountMinor * line.net) / netAfterLineDiscounts;
    const taxable = line.net - share;
    const taxRatePpm = line.item.taxRatePpm ?? 0;
    const taxMinor =
      taxRatePpm === 0 ? 0n : applyPpm(money(taxable, currency), taxRatePpm).amountMinor;

    return {
      description: line.item.description,
      kind: line.item.kind,
      quantity: line.item.quantity,
      unitPriceMinor: line.item.unitPriceMinor,
      discountMinor: line.lineDiscount,
      taxRatePpm,
      taxMinor,
      // The stored line total excludes the invoice-level discount, which is a
      // separate document section; the invoice total subtracts it once.
      totalMinor: line.net + taxMinor,
      programId: line.item.programId ?? null,
      groupId: line.item.groupId ?? null,
      sequence: line.index,
    };
  });

  const taxTotalMinor = lines.reduce((total, line) => total + line.taxMinor, 0n);
  const discountTotalMinor = lineDiscountMinor + invoiceDiscountMinor;
  const totalMinor = subtotalMinor - discountTotalMinor + taxTotalMinor;

  if (totalMinor < 0n) {
    throw new BusinessRuleError(
      'invoice.negative_total',
      'The discounts exceed the invoice value. Reduce them or raise a credit note instead.',
    );
  }

  return {
    lines,
    subtotalMinor,
    lineDiscountMinor,
    invoiceDiscountMinor,
    discountTotalMinor,
    taxTotalMinor,
    totalMinor,
    appliedDiscounts,
  };
}

/**
 * Create an invoice, optionally issuing it in the same transaction.
 *
 * Issuing is what raises the DEBIT ledger entry, so a DRAFT has no financial
 * effect and can be edited or deleted freely. That separation is what lets an
 * administrator prepare next month's billing without it appearing in this month's
 * revenue.
 */
export async function createInvoice(
  ctx: AccessContext,
  input: CreateInvoiceInput,
  db?: Db,
): Promise<{ id: string; invoiceNumber: string; totalMinor: bigint; status: string }> {
  requirePermission(ctx, 'invoices.create');

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true },
      });
      // NotFound rather than OutOfScope: invoice and student ids are guessable, so
      // distinguishing "exists elsewhere" from "does not exist" leaks across branches.
      if (!student) throw new NotFoundError('Student', input.studentId);

      const branchId = input.branchId ?? student.branchId;
      assertBranchAccess(ctx, branchId, 'invoice');

      const settings = await getSettings(['paymentDueDays', 'timezone'], {
        organizationId: ctx.organizationId,
        branchId,
      }, tx);

      const currency = await currencyFor(
        { organizationId: ctx.organizationId, branchId, requested: input.currency },
        tx,
      );
      const today = todayIn(settings.timezone);
      const issueDate = input.issueDate ?? today;
      const dueDate = input.dueDate ?? addDaysToDateOnly(issueDate, settings.paymentDueDays);

      if (dueDate < issueDate) {
        throw new BusinessRuleError(
          'invoice.due_before_issue',
          'The due date cannot be before the issue date.',
        );
      }

      const totals = computeInvoiceTotals({
        items: input.items,
        discounts: input.discounts,
        currency,
      });

      const invoiceNumber = await nextInvoiceNumber(tx, {
        organizationId: ctx.organizationId,
        branchId,
      });

      const invoice = await tx.invoice.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          invoiceNumber,
          studentId: student.id,
          feePlanId: input.feePlanId ?? null,
          status: 'DRAFT',
          currency,
          subtotalMinor: totals.subtotalMinor,
          discountTotalMinor: totals.discountTotalMinor,
          taxTotalMinor: totals.taxTotalMinor,
          totalMinor: totals.totalMinor,
          // Derived caches start consistent with an unpaid invoice; the CHECK
          // constraint on the balance identity is satisfied by construction.
          paidTotalMinor: 0n,
          refundedTotalMinor: 0n,
          writtenOffMinor: 0n,
          balanceMinor: totals.totalMinor,
          issueDate: dateOnlyToPrismaDate(issueDate),
          dueDate: dateOnlyToPrismaDate(dueDate),
          periodStart: input.periodStart ? dateOnlyToPrismaDate(input.periodStart) : null,
          periodEnd: input.periodEnd ? dateOnlyToPrismaDate(input.periodEnd) : null,
          notes: input.notes ?? null,
          createdById: ctx.isSystem ? null : ctx.userId,
          items: {
            create: totals.lines.map((line) => ({
              description: line.description,
              kind: line.kind,
              programId: line.programId,
              groupId: line.groupId,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              discountMinor: line.discountMinor,
              taxRatePpm: line.taxRatePpm,
              taxMinor: line.taxMinor,
              totalMinor: line.totalMinor,
              sequence: line.sequence,
            })),
          },
          invoiceDiscounts: {
            create: totals.appliedDiscounts.map((discount) => ({
              discountId: discount.discountId,
              label: discount.label,
              type: discount.type,
              percentPpm: discount.percentPpm,
              amountMinor: discount.amountMinor,
              currency,
              reason: discount.reason,
            })),
          },
        },
        select: { id: true, invoiceNumber: true, totalMinor: true, status: true },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.INVOICE_CREATED,
          entityType: 'Invoice',
          entityId: invoice.id,
          branchId,
          summary: `Invoice ${invoice.invoiceNumber} created for ${student.firstName} ${student.lastName}`,
          metadata: { totalMinor: totals.totalMinor.toString(), currency },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'invoice.created',
            title: `Invoice ${invoice.invoiceNumber} created`,
          },
        },
        tx,
      );

      if (input.issueNow) {
        const issued = await issueInvoiceInTransaction(ctx, tx, invoice.id);
        return { ...invoice, status: issued.status };
      }

      return invoice;
    },
    { existing: db },
  );
}

/**
 * Issue a draft invoice: freeze it and raise the DEBIT ledger entry.
 * This is the moment the money becomes receivable.
 */
export async function issueInvoice(
  ctx: AccessContext,
  invoiceId: string,
  db?: Db,
): Promise<{ id: string; status: string; balanceMinor: bigint }> {
  requirePermission(ctx, 'invoices.issue');
  return withTransaction((tx) => issueInvoiceInTransaction(ctx, tx, invoiceId), { existing: db });
}

async function issueInvoiceInTransaction(
  ctx: AccessContext,
  tx: Tx,
  invoiceId: string,
): Promise<{ id: string; status: string; balanceMinor: bigint }> {
  const invoice = await tx.invoice.findFirst({
    where: { id: invoiceId, ...scopeFilter(ctx) },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      currency: true,
      totalMinor: true,
      branchId: true,
      studentId: true,
    },
  });
  if (!invoice) throw new NotFoundError('Invoice', invoiceId);
  if (invoice.status !== 'DRAFT') {
    throw new StateInvalidError('invoice', invoice.status.toLowerCase(), 'issued');
  }
  if (invoice.totalMinor <= 0n) {
    throw new BusinessRuleError(
      'invoice.zero_total',
      'An invoice for zero cannot be issued. Delete the draft instead.',
    );
  }

  await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED' } });

  await appendLedgerEntry(ctx, tx, {
    entryType: 'INVOICE_ISSUED',
    direction: 'DEBIT',
    amountMinor: invoice.totalMinor,
    currency: invoice.currency,
    branchId: invoice.branchId,
    studentId: invoice.studentId,
    invoiceId: invoice.id,
    description: `Invoice ${invoice.invoiceNumber} issued`,
  });

  const totals = await recalculateInvoice(tx, invoice.id);

  await recordAudit(
    ctx,
    {
      action: AUDIT_ACTIONS.INVOICE_ISSUED,
      entityType: 'Invoice',
      entityId: invoice.id,
      branchId: invoice.branchId,
      summary: `Invoice ${invoice.invoiceNumber} issued`,
      metadata: { totalMinor: invoice.totalMinor.toString(), currency: invoice.currency },
      timeline: {
        subjectType: 'STUDENT',
        subjectId: invoice.studentId,
        type: 'invoice.issued',
        title: `Invoice ${invoice.invoiceNumber} issued`,
      },
    },
    tx,
  );

  return { id: invoice.id, status: 'ISSUED', balanceMinor: totals.balanceMinor };
}

/**
 * Edit a draft. Only a draft: an issued invoice is a document someone has been
 * sent, and silently changing its lines is exactly the kind of untraceable
 * financial edit the ledger design exists to prevent. Correct an issued invoice by
 * cancelling it and issuing a new one, or with an approved adjustment.
 */
export async function updateDraftInvoice(
  ctx: AccessContext,
  invoiceId: string,
  input: {
    readonly items?: readonly InvoiceLineInput[];
    readonly discounts?: readonly InvoiceDiscountInput[];
    readonly dueDate?: DateOnly;
    readonly notes?: string | null;
  },
  db?: Db,
): Promise<{ id: string; totalMinor: bigint }> {
  requirePermission(ctx, 'invoices.edit');

  return withTransaction(
    async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, ...scopeFilter(ctx) },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          currency: true,
          branchId: true,
          studentId: true,
          totalMinor: true,
          dueDate: true,
          issueDate: true,
          notes: true,
        },
      });
      if (!invoice) throw new NotFoundError('Invoice', invoiceId);
      if (invoice.status !== 'DRAFT') {
        throw new StateInvalidError('invoice', invoice.status.toLowerCase(), 'edited');
      }

      const currency = assertCurrency(invoice.currency);
      let totalMinor = invoice.totalMinor;
      const data: Prisma.InvoiceUpdateInput = {};

      if (input.items) {
        const totals = computeInvoiceTotals({
          items: input.items,
          discounts: input.discounts,
          currency,
        });
        totalMinor = totals.totalMinor;

        // Replace the lines wholesale. Diffing them would add complexity for no
        // benefit: a draft has no ledger rows referencing its items.
        await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
        await tx.invoiceDiscount.deleteMany({ where: { invoiceId: invoice.id } });

        data.subtotalMinor = totals.subtotalMinor;
        data.discountTotalMinor = totals.discountTotalMinor;
        data.taxTotalMinor = totals.taxTotalMinor;
        data.totalMinor = totals.totalMinor;
        data.balanceMinor = totals.totalMinor;
        data.items = {
          create: totals.lines.map((line) => ({
            description: line.description,
            kind: line.kind,
            programId: line.programId,
            groupId: line.groupId,
            quantity: line.quantity,
            unitPriceMinor: line.unitPriceMinor,
            discountMinor: line.discountMinor,
            taxRatePpm: line.taxRatePpm,
            taxMinor: line.taxMinor,
            totalMinor: line.totalMinor,
            sequence: line.sequence,
          })),
        };
        data.invoiceDiscounts = {
          create: totals.appliedDiscounts.map((discount) => ({
            discountId: discount.discountId,
            label: discount.label,
            type: discount.type,
            percentPpm: discount.percentPpm,
            amountMinor: discount.amountMinor,
            currency,
            reason: discount.reason,
          })),
        };
      }

      if (input.dueDate) {
        const due = dateOnlyToPrismaDate(input.dueDate);
        if (due < invoice.issueDate) {
          throw new BusinessRuleError(
            'invoice.due_before_issue',
            'The due date cannot be before the issue date.',
          );
        }
        data.dueDate = due;
      }
      if (input.notes !== undefined) data.notes = input.notes;

      await tx.invoice.update({ where: { id: invoice.id }, data });

      await recordAudit(
        ctx,
        {
          action: 'invoice.draft_updated',
          entityType: 'Invoice',
          entityId: invoice.id,
          branchId: invoice.branchId,
          summary: `Draft invoice ${invoice.invoiceNumber} updated`,
          changes: diffFields(
            { totalMinor: invoice.totalMinor, notes: invoice.notes },
            { totalMinor, notes: input.notes },
          ),
        },
        tx,
      );

      return { id: invoice.id, totalMinor };
    },
    { existing: db },
  );
}

/**
 * Cancel an issued invoice, reversing the charge.
 *
 * Requires that nothing has been paid against it: reversing an invoice that has
 * received money would leave the payment attached to a cancelled document. Use a
 * refund, or a write-off, for that case.
 */
export async function cancelInvoice(
  ctx: AccessContext,
  invoiceId: string,
  input: { reason: string },
  db?: Db,
): Promise<{ id: string; status: string }> {
  requirePermission(ctx, 'invoices.cancel');

  return withTransaction(
    async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, ...scopeFilter(ctx) },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          currency: true,
          totalMinor: true,
          paidTotalMinor: true,
          branchId: true,
          studentId: true,
        },
      });
      if (!invoice) throw new NotFoundError('Invoice', invoiceId);

      if (invoice.status === 'CANCELLED' || invoice.status === 'VOID') {
        throw new StateInvalidError('invoice', invoice.status.toLowerCase(), 'cancelled');
      }
      if (invoice.paidTotalMinor > 0n) {
        throw new BusinessRuleError(
          'invoice.cancel_with_payments',
          'This invoice has payments against it. Refund or reverse them first, or write the balance off instead.',
          { details: { paidTotalMinor: invoice.paidTotalMinor.toString() } },
        );
      }

      const now = new Date();
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { cancelledAt: now, cancelReason: input.reason, status: 'CANCELLED' },
      });

      // A draft never raised a charge, so there is nothing to reverse.
      if (invoice.status !== 'DRAFT') {
        await appendLedgerEntry(ctx, tx, {
          entryType: 'INVOICE_CANCELLED',
          direction: 'CREDIT',
          amountMinor: invoice.totalMinor,
          currency: invoice.currency,
          branchId: invoice.branchId,
          studentId: invoice.studentId,
          invoiceId: invoice.id,
          description: `Invoice ${invoice.invoiceNumber} cancelled: ${input.reason}`,
          occurredAt: now,
        });
      }

      await recalculateInvoice(tx, invoice.id, { now });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.INVOICE_CANCELLED,
          entityType: 'Invoice',
          entityId: invoice.id,
          branchId: invoice.branchId,
          summary: `Invoice ${invoice.invoiceNumber} cancelled`,
          reason: input.reason,
          severity: 'NOTICE',
          metadata: { totalMinor: invoice.totalMinor.toString() },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: invoice.studentId,
            type: 'invoice.cancelled',
            title: `Invoice ${invoice.invoiceNumber} cancelled`,
            description: input.reason,
          },
        },
        tx,
      );

      return { id: invoice.id, status: 'CANCELLED' };
    },
    { existing: db },
  );
}

/**
 * Write off an uncollectable balance.
 *
 * Distinct from cancelling: the charge was legitimate and stays on the ledger, and
 * the write-off is recorded as an approved loss. That distinction is what keeps
 * revenue reporting honest — cancelling bad debt would make it disappear from the
 * books entirely.
 */
export async function writeOffInvoice(
  ctx: AccessContext,
  invoiceId: string,
  input: { reason: string; amountMinor?: bigint },
  db?: Db,
): Promise<{ id: string; status: string; writtenOffMinor: bigint }> {
  requirePermission(ctx, 'invoices.writeOff');

  return withTransaction(
    async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, ...scopeFilter(ctx) },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          currency: true,
          balanceMinor: true,
          branchId: true,
          studentId: true,
        },
      });
      if (!invoice) throw new NotFoundError('Invoice', invoiceId);
      if (invoice.balanceMinor <= 0n) {
        throw new BusinessRuleError(
          'invoice.nothing_to_write_off',
          'This invoice has no outstanding balance.',
        );
      }

      const amount = input.amountMinor ?? invoice.balanceMinor;
      if (amount <= 0n || amount > invoice.balanceMinor) {
        throw new BusinessRuleError(
          'invoice.write_off_exceeds_balance',
          'The write-off cannot exceed the outstanding balance.',
        );
      }

      const now = new Date();
      const ledgerEntry = await appendLedgerEntry(ctx, tx, {
        entryType: 'WRITE_OFF',
        direction: 'CREDIT',
        amountMinor: amount,
        currency: invoice.currency,
        branchId: invoice.branchId,
        studentId: invoice.studentId,
        invoiceId: invoice.id,
        description: `Balance written off: ${input.reason}`,
        occurredAt: now,
      });

      // Every balance movement outside the normal payment flow is recorded as an
      // adjustment with a named approver, so no figure changes anonymously.
      await tx.financialAdjustment.create({
        data: {
          organizationId: ctx.organizationId,
          type: 'WRITE_OFF',
          studentId: invoice.studentId,
          invoiceId: invoice.id,
          amountMinor: amount,
          currency: invoice.currency,
          reason: input.reason,
          requestedById: ctx.isSystem ? null : ctx.userId,
          approvedById: ctx.userId,
          approvedAt: now,
          ledgerEntryId: ledgerEntry.id,
        },
      });

      const totals = await recalculateInvoice(tx, invoice.id, { now });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.INVOICE_WRITTEN_OFF,
          entityType: 'Invoice',
          entityId: invoice.id,
          branchId: invoice.branchId,
          summary: `Wrote off ${amount} on invoice ${invoice.invoiceNumber}`,
          reason: input.reason,
          severity: 'WARNING',
          metadata: { amountMinor: amount.toString(), currency: invoice.currency },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: invoice.studentId,
            type: 'invoice.written_off',
            title: `Balance written off on ${invoice.invoiceNumber}`,
            description: input.reason,
          },
        },
        tx,
      );

      return {
        id: invoice.id,
        status: 'WRITTEN_OFF',
        writtenOffMinor: totals.writtenOffMinor,
      };
    },
    { existing: db },
  );
}

/**
 * Mark overdue invoices. Run from cron.
 *
 * Deliberately a status refresh only — it raises no late fee, because charging one
 * is a separate, configurable decision with its own ledger entry.
 */
export async function markOverdueInvoices(
  ctx: AccessContext,
  db?: Db,
): Promise<{ marked: number }> {
  const { prisma } = await import('@/server/db/client');
  const client = db ?? prisma;
  const now = new Date();

  const result = await client.invoice.updateMany({
    where: {
      organizationId: ctx.organizationId,
      status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
      balanceMinor: { gt: 0 },
      dueDate: { lt: now },
    },
    data: { status: 'OVERDUE' },
  });

  return { marked: result.count };
}
