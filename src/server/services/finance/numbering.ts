/**
 * Generated document numbers: invoices, payments, refunds, student codes,
 * employee codes, application numbers, certificate numbers.
 *
 * These appear on printed receipts and contracts, so they must be unique,
 * human-readable and stable. Allocation goes through the `DocumentCounter` row
 * lock rather than `max(n) + 1`, because the latter races: two concurrent
 * invoices read the same maximum and then either collide on the unique index or,
 * under a weaker isolation level, both commit.
 *
 * MUST be called inside the same transaction as the row being numbered. A number
 * allocated in its own transaction and then used in another leaves a permanent
 * gap whenever the second one rolls back.
 */

import type { Db, Tx } from '@/server/db/client';
import { getSetting } from '@/server/settings';

export type DocumentScope =
  | 'invoice'
  | 'payment'
  | 'refund'
  | 'student'
  | 'employee'
  | 'application'
  | 'certificate';

/** Whether a scope restarts each calendar year. */
const YEARLY_SCOPES: ReadonlySet<DocumentScope> = new Set(['invoice', 'payment', 'refund']);

/** Zero-padding width per scope, chosen so a realistic volume never overflows it. */
const PAD_WIDTH: Record<DocumentScope, number> = {
  invoice: 6,
  payment: 6,
  refund: 5,
  student: 6,
  employee: 4,
  application: 6,
  certificate: 5,
};

/**
 * Reserve the next value for a scope.
 *
 * `UPSERT ... RETURNING` is one statement, so the read and the increment cannot
 * be separated by another transaction. The row lock taken by the update is what
 * serialises concurrent allocation; everything else here is formatting.
 */
async function nextValue(
  tx: Tx,
  organizationId: string,
  scope: DocumentScope,
  period: string,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ nextValue: number }>>`
    insert into "document_counters" ("id", "organizationId", "scope", "period", "nextValue", "createdAt", "updatedAt")
    values (gen_random_uuid()::text, ${organizationId}, ${scope}, ${period}, 2, now(), now())
    on conflict ("organizationId", "scope", "period")
      do update set "nextValue" = "document_counters"."nextValue" + 1, "updatedAt" = now()
    returning ("nextValue" - 1) as "nextValue"
  `;

  const value = rows[0]?.nextValue;
  if (typeof value !== 'number') {
    // Unreachable with the statement above; failing loudly beats emitting a
    // duplicate or NaN document number.
    throw new Error(`Could not allocate a ${scope} number for organisation ${organizationId}`);
  }
  return value;
}

function currentPeriod(scope: DocumentScope, now: Date): string {
  return YEARLY_SCOPES.has(scope) ? String(now.getUTCFullYear()) : '-';
}

interface NumberOptions {
  readonly organizationId: string;
  readonly branchId?: string | null;
  /** Business date, so a back-dated invoice lands in the right yearly sequence. */
  readonly now?: Date;
}

/**
 * `INV-2026-000123`. The prefix comes from settings so an institution can match
 * its existing paperwork instead of adopting ours.
 */
export async function nextInvoiceNumber(tx: Tx, options: NumberOptions): Promise<string> {
  const now = options.now ?? new Date();
  const prefix = await getSetting(
    'invoiceNumberPrefix',
    { organizationId: options.organizationId },
    tx,
  );
  const period = currentPeriod('invoice', now);
  const value = await nextValue(tx, options.organizationId, 'invoice', period);
  return `${prefix}-${period}-${String(value).padStart(PAD_WIDTH.invoice, '0')}`;
}

export async function nextPaymentNumber(tx: Tx, options: NumberOptions): Promise<string> {
  const now = options.now ?? new Date();
  const prefix = await getSetting(
    'paymentNumberPrefix',
    { organizationId: options.organizationId },
    tx,
  );
  const period = currentPeriod('payment', now);
  const value = await nextValue(tx, options.organizationId, 'payment', period);
  return `${prefix}-${period}-${String(value).padStart(PAD_WIDTH.payment, '0')}`;
}

export async function nextRefundNumber(tx: Tx, options: NumberOptions): Promise<string> {
  const now = options.now ?? new Date();
  const prefix = await getSetting(
    'refundNumberPrefix',
    { organizationId: options.organizationId },
    tx,
  );
  const period = currentPeriod('refund', now);
  const value = await nextValue(tx, options.organizationId, 'refund', period);
  return `${prefix}-${period}-${String(value).padStart(PAD_WIDTH.refund, '0')}`;
}

/** `STU-000412`. Never resets: a student code must not be reused. */
export async function nextStudentCode(tx: Tx, organizationId: string): Promise<string> {
  const prefix = await getSetting('studentCodePrefix', { organizationId }, tx);
  const value = await nextValue(tx, organizationId, 'student', '-');
  return `${prefix}-${String(value).padStart(PAD_WIDTH.student, '0')}`;
}

export async function nextEmployeeCode(tx: Tx, organizationId: string): Promise<string> {
  const prefix = await getSetting('employeeCodePrefix', { organizationId }, tx);
  const value = await nextValue(tx, organizationId, 'employee', '-');
  return `${prefix}-${String(value).padStart(PAD_WIDTH.employee, '0')}`;
}

export async function nextApplicationNumber(tx: Tx, organizationId: string): Promise<string> {
  const prefix = await getSetting('applicationNumberPrefix', { organizationId }, tx);
  const value = await nextValue(tx, organizationId, 'application', '-');
  return `${prefix}-${String(value).padStart(PAD_WIDTH.application, '0')}`;
}

/** `CERT-2026-00123`: the year is informational, the sequence never resets. */
export async function nextCertificateNumber(
  tx: Tx,
  organizationId: string,
  now: Date = new Date(),
): Promise<string> {
  const value = await nextValue(tx, organizationId, 'certificate', '-');
  return `CERT-${now.getUTCFullYear()}-${String(value).padStart(PAD_WIDTH.certificate, '0')}`;
}

/**
 * Peek at the next value without consuming it, for a "next number will be ..."
 * hint in a form. Deliberately NOT a reservation: by the time the form is
 * submitted another user may have taken it, so the UI must present this as
 * indicative only.
 */
export async function peekNextValue(
  db: Db,
  organizationId: string,
  scope: DocumentScope,
  now: Date = new Date(),
): Promise<number> {
  const row = await db.documentCounter.findUnique({
    where: {
      organizationId_scope_period: {
        organizationId,
        scope,
        period: currentPeriod(scope, now),
      },
    },
    select: { nextValue: true },
  });
  return row?.nextValue ?? 1;
}
