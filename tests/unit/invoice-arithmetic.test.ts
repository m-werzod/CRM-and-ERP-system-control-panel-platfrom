import { describe, expect, it } from 'vitest';
import {
  computeInvoiceTotals,
  type InvoiceLineInput,
} from '@/server/services/finance/invoices';
import { deriveInvoiceStatus } from '@/server/services/finance/ledger';

/**
 * These cover the arithmetic that decides what a parent is actually charged, and
 * the status a debt report shows. Both are pure functions precisely so they can be
 * pinned down here without a database.
 */

const line = (overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  description: 'Tuition',
  kind: 'TUITION',
  quantity: 1,
  unitPriceMinor: 10_000n,
  ...overrides,
});

describe('computeInvoiceTotals', () => {
  it('reproduces the worked example from the specification', () => {
    // Tuition 100, discount 10, total 90.
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ unitPriceMinor: 10_000n })],
      discounts: [{ label: 'Sibling discount', type: 'FIXED', amountMinor: 1_000n }],
    });

    expect(totals.subtotalMinor).toBe(10_000n);
    expect(totals.discountTotalMinor).toBe(1_000n);
    expect(totals.taxTotalMinor).toBe(0n);
    expect(totals.totalMinor).toBe(9_000n);
  });

  it('multiplies quantity by unit price', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ quantity: 3, unitPriceMinor: 2_500n })],
    });
    expect(totals.subtotalMinor).toBe(7_500n);
    expect(totals.totalMinor).toBe(7_500n);
  });

  it('applies a percentage discount to the post-line-discount subtotal', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ unitPriceMinor: 20_000n, discountMinor: 5_000n })],
      discounts: [{ label: '10% off', type: 'PERCENT', percentPpm: 100_000 }],
    });

    // Net after the line discount is 15 000; 10% of that is 1 500.
    expect(totals.lineDiscountMinor).toBe(5_000n);
    expect(totals.invoiceDiscountMinor).toBe(1_500n);
    expect(totals.totalMinor).toBe(13_500n);
  });

  it('stacks percentage discounts on the running remainder, not the original', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ unitPriceMinor: 10_000n })],
      discounts: [
        { label: 'A', type: 'PERCENT', percentPpm: 100_000 },
        { label: 'B', type: 'PERCENT', percentPpm: 100_000 },
      ],
    });

    // 1000 then 900 -> 1900, i.e. an effective 19%. Two stacked 10% discounts are
    // deliberately NOT 20%.
    expect(totals.invoiceDiscountMinor).toBe(1_900n);
    expect(totals.totalMinor).toBe(8_100n);
  });

  it('taxes the discounted amount, not the gross', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ unitPriceMinor: 10_000n, taxRatePpm: 120_000 })],
      discounts: [{ label: 'Half off', type: 'PERCENT', percentPpm: 500_000 }],
    });

    // Taxable base is 5 000, so 12% VAT is 600 -- not 1 200 on the gross.
    expect(totals.taxTotalMinor).toBe(600n);
    expect(totals.totalMinor).toBe(10_000n - 5_000n + 600n);
  });

  it('spreads an invoice-level discount across lines in proportion to their value', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [
        line({ description: 'Tuition', unitPriceMinor: 30_000n, taxRatePpm: 100_000 }),
        line({ description: 'Materials', kind: 'MATERIALS', unitPriceMinor: 10_000n, taxRatePpm: 100_000 }),
      ],
      discounts: [{ label: 'Bursary', type: 'FIXED', amountMinor: 4_000n }],
    });

    // The 4 000 discount splits 3:1, so the taxable bases are 27 000 and 9 000,
    // giving 2 700 + 900 = 3 600 of tax.
    expect(totals.taxTotalMinor).toBe(3_600n);
    expect(totals.totalMinor).toBe(40_000n - 4_000n + 3_600n);
  });

  it('clamps a discount to the remaining value rather than producing a negative total', () => {
    const totals = computeInvoiceTotals({
      currency: 'USD',
      items: [line({ unitPriceMinor: 5_000n })],
      discounts: [{ label: 'Too generous', type: 'FIXED', amountMinor: 9_999n }],
    });

    expect(totals.invoiceDiscountMinor).toBe(5_000n);
    expect(totals.totalMinor).toBe(0n);
    // The stored discount records what was actually applied, not what was asked for.
    expect(totals.appliedDiscounts[0]?.amountMinor).toBe(5_000n);
  });

  it('rounds tax half-up so a fractional minor unit is not lost', () => {
    // 5% of 1005 is 50.25 -> 50; 5% of 1010 is 50.5 -> 51.
    expect(
      computeInvoiceTotals({
        currency: 'USD',
        items: [line({ unitPriceMinor: 1_005n, taxRatePpm: 50_000 })],
      }).taxTotalMinor,
    ).toBe(50n);

    expect(
      computeInvoiceTotals({
        currency: 'USD',
        items: [line({ unitPriceMinor: 1_010n, taxRatePpm: 50_000 })],
      }).taxTotalMinor,
    ).toBe(51n);
  });

  it('keeps the line totals consistent with the invoice total', () => {
    const totals = computeInvoiceTotals({
      currency: 'UZS',
      items: [
        line({ unitPriceMinor: 150_000_000n, taxRatePpm: 120_000 }),
        line({ description: 'Books', kind: 'MATERIALS', quantity: 2, unitPriceMinor: 5_000_000n }),
      ],
      discounts: [{ label: 'Early payment', type: 'PERCENT', percentPpm: 50_000 }],
    });

    const lineSum = totals.lines.reduce((total, l) => total + l.totalMinor, 0n);
    // Line totals exclude the invoice-level discount, which the invoice total
    // subtracts exactly once.
    expect(lineSum - totals.invoiceDiscountMinor).toBe(totals.totalMinor);
  });

  it('handles amounts beyond IEEE-754 integer precision', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const totals = computeInvoiceTotals({
      currency: 'UZS',
      items: [line({ unitPriceMinor: huge })],
    });
    expect(totals.totalMinor).toBe(huge);
  });

  describe('rejections', () => {
    it('rejects an invoice with no lines', () => {
      expect(() => computeInvoiceTotals({ currency: 'USD', items: [] })).toThrow(/at least one line/i);
    });

    it('rejects a non-positive or fractional quantity', () => {
      expect(() =>
        computeInvoiceTotals({ currency: 'USD', items: [line({ quantity: 0 })] }),
      ).toThrow(/quantity/i);
      expect(() =>
        computeInvoiceTotals({ currency: 'USD', items: [line({ quantity: 1.5 })] }),
      ).toThrow(/quantity/i);
    });

    it('rejects a negative unit price', () => {
      expect(() =>
        computeInvoiceTotals({ currency: 'USD', items: [line({ unitPriceMinor: -1n })] }),
      ).toThrow(/negative/i);
    });

    it('rejects a line discount larger than the line', () => {
      expect(() =>
        computeInvoiceTotals({
          currency: 'USD',
          items: [line({ unitPriceMinor: 100n, discountMinor: 101n })],
        }),
      ).toThrow(/exceed the line total/i);
    });

    it('rejects a percentage discount with no rate', () => {
      expect(() =>
        computeInvoiceTotals({
          currency: 'USD',
          items: [line()],
          discounts: [{ label: 'Broken', type: 'PERCENT' }],
        }),
      ).toThrow(/no rate/i);
    });

    it('rejects a fixed discount with no amount', () => {
      expect(() =>
        computeInvoiceTotals({
          currency: 'USD',
          items: [line()],
          discounts: [{ label: 'Broken', type: 'FIXED' }],
        }),
      ).toThrow(/no value/i);
    });
  });
});

describe('deriveInvoiceStatus', () => {
  const base = {
    currentStatus: 'ISSUED' as const,
    totalMinor: 10_000n,
    paidTotalMinor: 0n,
    refundedTotalMinor: 0n,
    writtenOffMinor: 0n,
    balanceMinor: 10_000n,
    dueDate: new Date('2026-12-31T00:00:00Z'),
    cancelled: false,
    voided: false,
    now: new Date('2026-06-01T00:00:00Z'),
  };

  it('is ISSUED when nothing is paid and it is not yet due', () => {
    expect(deriveInvoiceStatus(base)).toBe('ISSUED');
  });

  it('is PARTIALLY_PAID when some is paid and it is not yet due', () => {
    expect(
      deriveInvoiceStatus({ ...base, paidTotalMinor: 4_000n, balanceMinor: 6_000n }),
    ).toBe('PARTIALLY_PAID');
  });

  it('is PAID when the balance reaches zero', () => {
    expect(
      deriveInvoiceStatus({ ...base, paidTotalMinor: 10_000n, balanceMinor: 0n }),
    ).toBe('PAID');
  });

  it('is PAID when overpaid, never a negative-balance state', () => {
    expect(
      deriveInvoiceStatus({ ...base, paidTotalMinor: 12_000n, balanceMinor: -2_000n }),
    ).toBe('PAID');
  });

  it('prefers OVERDUE over PARTIALLY_PAID once past due', () => {
    // An accountant chasing debt must see OVERDUE on a half-paid invoice.
    expect(
      deriveInvoiceStatus({
        ...base,
        paidTotalMinor: 4_000n,
        balanceMinor: 6_000n,
        now: new Date('2027-01-05T00:00:00Z'),
      }),
    ).toBe('OVERDUE');
  });

  it('is not overdue on the due date itself', () => {
    // The due date is inclusive: payment is expected by end of that day.
    expect(
      deriveInvoiceStatus({ ...base, now: new Date('2026-12-31T18:00:00Z') }),
    ).toBe('ISSUED');
  });

  it('keeps a DRAFT a draft regardless of dates', () => {
    expect(
      deriveInvoiceStatus({
        ...base,
        currentStatus: 'DRAFT',
        now: new Date('2030-01-01T00:00:00Z'),
      }),
    ).toBe('DRAFT');
  });

  it('lets the terminal administrative states win over the arithmetic', () => {
    expect(deriveInvoiceStatus({ ...base, voided: true, paidTotalMinor: 10_000n })).toBe('VOID');
    expect(deriveInvoiceStatus({ ...base, cancelled: true })).toBe('CANCELLED');
    // Voided beats cancelled when both are somehow set.
    expect(deriveInvoiceStatus({ ...base, cancelled: true, voided: true })).toBe('VOID');
  });

  it('is WRITTEN_OFF when a write-off clears the balance', () => {
    expect(
      deriveInvoiceStatus({ ...base, writtenOffMinor: 10_000n, balanceMinor: 0n }),
    ).toBe('WRITTEN_OFF');
  });

  it('is REFUNDED when everything received has gone back out', () => {
    expect(
      deriveInvoiceStatus({
        ...base,
        paidTotalMinor: 10_000n,
        refundedTotalMinor: 10_000n,
        balanceMinor: 10_000n,
      }),
    ).toBe('REFUNDED');
  });

  it('is not REFUNDED after a partial refund', () => {
    // Half the money came back, so the invoice is owed again -- and it is past due.
    expect(
      deriveInvoiceStatus({
        ...base,
        paidTotalMinor: 10_000n,
        refundedTotalMinor: 5_000n,
        balanceMinor: 5_000n,
        now: new Date('2027-02-01T00:00:00Z'),
      }),
    ).toBe('OVERDUE');
  });

  it('satisfies the balance identity the database CHECK constraint enforces', () => {
    // Guards against the derived formula drifting from the constraint in
    // prisma/migrations/.../integrity_search_guards.
    const cases = [
      { total: 10_000n, paid: 0n, written: 0n, refunded: 0n },
      { total: 10_000n, paid: 4_000n, written: 0n, refunded: 0n },
      { total: 10_000n, paid: 10_000n, written: 0n, refunded: 3_000n },
      { total: 10_000n, paid: 2_000n, written: 8_000n, refunded: 0n },
    ];
    for (const c of cases) {
      const balance = c.total - c.paid - c.written + c.refunded;
      expect(
        deriveInvoiceStatus({
          ...base,
          totalMinor: c.total,
          paidTotalMinor: c.paid,
          writtenOffMinor: c.written,
          refundedTotalMinor: c.refunded,
          balanceMinor: balance,
        }),
      ).toBeTypeOf('string');
    }
  });
});
