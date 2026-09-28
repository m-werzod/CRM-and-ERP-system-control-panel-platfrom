/**
 * The student detail page, assembled once.
 *
 * The profile is the screen that tempts a UI into ten round trips and an N+1 per
 * panel. Everything it shows is fetched here instead: one scoped read of the
 * student, then every panel in a single parallel batch.
 *
 * PERMISSIONS ARE PER SECTION, which is the other reason this is one function.
 * A receptionist may open a student without being allowed to see what the family
 * owes, and answering their request with 403 for the whole page would be wrong —
 * so would rendering an empty financial panel, because an empty panel reads as
 * "no debt". Each section the caller may not see is therefore omitted AND named in
 * `redacted`, so the UI can say "hidden — you do not have permission" rather than
 * inventing a zero.
 */

import { prisma, type Db } from '@/server/db/client';
import { can, requirePermission, type AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import type { CurrencyCode } from '@/lib/money';
import { currencyFor } from '@/server/services/finance/currency';
import { getStudentBalance } from '@/server/services/finance/ledger';
import { getStudentAttendance } from '@/server/services/attendance/statistics';
import { listStudentEnrollments } from '@/server/services/students/enrollment';
import { getStudent, type StudentDetail } from '@/server/services/students/students';
import type { StudentGuardianLink } from '@/server/services/students/guardians';

/** Sections that can be withheld from a caller who lacks the permission. */
export type StudentProfileSection =
  | 'guardians'
  | 'attendance'
  | 'financial'
  | 'discounts'
  | 'documents';

type EnrollmentHistoryRow = Awaited<ReturnType<typeof listStudentEnrollments>>[number];
type AttendanceBlock = Awaited<ReturnType<typeof getStudentAttendance>>;

export interface ProfileInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly status: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly paidTotalMinor: bigint;
  readonly balanceMinor: bigint;
  readonly issueDate: Date;
  readonly dueDate: Date;
}

export interface ProfilePayment {
  readonly id: string;
  readonly paymentNumber: string;
  readonly method: string;
  readonly status: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly receivedAt: Date;
  readonly reference: string | null;
}

export interface StudentFinancialPosition {
  readonly currency: CurrencyCode;
  readonly outstandingMinor: bigint;
  readonly creditMinor: bigint;
  readonly netDueMinor: bigint;
  readonly overdueMinor: bigint;
  readonly openInvoiceCount: number;
  readonly overdueInvoiceCount: number;
  readonly recentInvoices: readonly ProfileInvoice[];
  readonly recentPayments: readonly ProfilePayment[];
}

export interface ProfileDiscount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly amountMinor: bigint | null;
  readonly percentPpm: number | null;
  readonly currency: string | null;
  readonly reason: string;
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
}

export interface ProfileDocument {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly category: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly visibility: string;
  readonly expiresAt: Date | null;
  readonly uploadedAt: Date;
}

export interface ProfileTimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly actorLabel: string | null;
  readonly occurredAt: Date;
}

export interface StudentProfile {
  readonly student: StudentDetail;
  readonly enrollments: {
    /** Open enrollments: where the student is right now. */
    readonly current: readonly EnrollmentHistoryRow[];
    /** Closed enrollments, newest first. Kept, never rewritten. */
    readonly past: readonly EnrollmentHistoryRow[];
  };
  readonly guardians: readonly StudentGuardianLink[] | null;
  readonly attendance: AttendanceBlock | null;
  readonly financial: StudentFinancialPosition | null;
  readonly discounts: readonly ProfileDiscount[] | null;
  readonly documents: readonly ProfileDocument[] | null;
  readonly timeline: readonly ProfileTimelineEntry[];
  /** Sections withheld for lack of permission. Show them as hidden, not empty. */
  readonly redacted: readonly StudentProfileSection[];
}

export interface StudentProfileInput {
  readonly studentId: string;
  /** Attendance window. Defaults to the last year, as the statistics service does. */
  readonly attendanceFrom?: DateOnly;
  readonly attendanceTo?: DateOnly;
  /** How many invoices, payments and timeline entries to return. */
  readonly recentLimit?: number;
  readonly includeArchived?: boolean;
}

const RECENT_LIMIT_DEFAULT = 10;
const RECENT_LIMIT_MAX = 50;
const DOCUMENT_LIMIT = 50;

export async function getStudentProfile(
  ctx: AccessContext,
  input: StudentProfileInput,
  db?: Db,
): Promise<StudentProfile> {
  requirePermission(ctx, 'students.view');

  const client = db ?? prisma;
  const recentLimit = Math.min(
    RECENT_LIMIT_MAX,
    Math.max(1, Math.trunc(input.recentLimit ?? RECENT_LIMIT_DEFAULT)),
  );

  // Scoped read, and the only place the student id is resolved: every query below
  // hangs off a student the caller has already been shown to be allowed to see.
  const student = await getStudent(ctx, input.studentId, client, {
    includeArchived: input.includeArchived,
  });

  const redacted: StudentProfileSection[] = [];
  const showGuardians = can(ctx, 'guardians.view');
  const showAttendance = can(ctx, 'attendance.view');
  const showFinancial = can(ctx, 'students.viewFinancials');
  const showDiscounts = can(ctx, 'discounts.view');
  const showDocuments = can(ctx, 'students.viewDocuments');
  if (!showGuardians) redacted.push('guardians');
  if (!showAttendance) redacted.push('attendance');
  if (!showFinancial) redacted.push('financial');
  if (!showDiscounts) redacted.push('discounts');
  if (!showDocuments) redacted.push('documents');

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: ctx.organizationId, branchId: student.branchId },
    client,
  );
  const today = todayIn(timezone);

  // Resolved before the batch because the balance and the invoice list are both
  // denominated in it, and because a currency is a per-branch fact rather than a
  // per-request one. Skipped entirely when the financial block is withheld.
  const currency: CurrencyCode | null = showFinancial
    ? await currencyFor({ organizationId: ctx.organizationId, branchId: student.branchId }, client)
    : null;

  const [enrollments, guardianLinks, attendance, balance, invoices, payments, discounts, documents, timeline] =
    await Promise.all([
      listStudentEnrollments(ctx, student.id, client),

      showGuardians
        ? client.studentGuardian.findMany({
            // The student was already resolved under scope, so this needs only the
            // student id -- a second scope join would buy nothing.
            where: { studentId: student.id },
            orderBy: [{ isPrimary: 'desc' }, { guardian: { lastName: 'asc' } }],
            select: {
              id: true,
              studentId: true,
              relationship: true,
              isPrimary: true,
              isEmergencyContact: true,
              canPickUp: true,
              receivesInvoices: true,
              receivesNotifications: true,
              guardian: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  phone: true,
                  phoneNormalized: true,
                  altPhone: true,
                  email: true,
                  occupation: true,
                  employer: true,
                  addressLine: true,
                  city: true,
                  preferredLocale: true,
                  notes: true,
                  deletedAt: true,
                  createdAt: true,
                },
              },
            },
          })
        : Promise.resolve(null),

      showAttendance
        ? getStudentAttendance(
            ctx,
            { studentId: student.id, from: input.attendanceFrom, to: input.attendanceTo },
            client,
          )
        : Promise.resolve(null),

      currency
        ? getStudentBalance(client, {
            organizationId: ctx.organizationId,
            studentId: student.id,
            currency,
          })
        : Promise.resolve(null),

      currency
        ? client.invoice.findMany({
            // Organisation and student, deliberately without a branch predicate:
            // the student was already resolved under scope, and `getStudentBalance`
            // aggregates the same way. Adding a branch filter here would make the
            // list disagree with the figure above it for a student whose invoice was
            // raised in another branch, and would empty it entirely for a caller
            // holding no branch assignment.
            //
            // A draft has been prepared, not sent: it is not part of what the family
            // has been billed, so it is excluded in SQL rather than in the page.
            where: {
              studentId: student.id,
              organizationId: ctx.organizationId,
              status: { not: 'DRAFT' },
            },
            orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
            take: recentLimit,
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              currency: true,
              totalMinor: true,
              paidTotalMinor: true,
              balanceMinor: true,
              issueDate: true,
              dueDate: true,
            },
          })
        : Promise.resolve(null),

      currency
        ? client.payment.findMany({
            // Scoped as the invoices above are, and for the same reason.
            where: { studentId: student.id, organizationId: ctx.organizationId },
            orderBy: { receivedAt: 'desc' },
            take: recentLimit,
            select: {
              id: true,
              paymentNumber: true,
              method: true,
              status: true,
              amountMinor: true,
              currency: true,
              receivedAt: true,
              reference: true,
            },
          })
        : Promise.resolve(null),

      showDiscounts
        ? client.studentDiscount.findMany({
            where: {
              studentId: student.id,
              status: 'APPROVED',
              // StudentDiscount carries no organisation column of its own; the
              // tenancy predicate goes through the Discount it grants.
              discount: { organizationId: ctx.organizationId },
              AND: [
                { OR: [{ validFrom: null }, { validFrom: { lte: dateOnlyToPrismaDate(today) } }] },
                { OR: [{ validTo: null }, { validTo: { gte: dateOnlyToPrismaDate(today) } }] },
              ],
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              amountMinor: true,
              percentPpm: true,
              currency: true,
              reason: true,
              validFrom: true,
              validTo: true,
              discount: { select: { code: true, name: true, type: true } },
            },
          })
        : Promise.resolve(null),

      showDocuments
        ? client.document.findMany({
            where: {
              studentId: student.id,
              organizationId: ctx.organizationId,
              deletedAt: null,
              // PRIVATE documents are visible to the uploader and to holders of
              // documents.viewAll only; showing their titles here would defeat the
              // point of the setting.
              ...(can(ctx, 'documents.viewAll') ? {} : { visibility: { not: 'PRIVATE' } }),
            },
            orderBy: { createdAt: 'desc' },
            take: DOCUMENT_LIMIT,
            select: {
              id: true,
              title: true,
              fileName: true,
              category: true,
              mimeType: true,
              sizeBytes: true,
              visibility: true,
              expiresAt: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),

      client.activityEvent.findMany({
        where: {
          organizationId: ctx.organizationId,
          subjectType: 'STUDENT',
          subjectId: student.id,
        },
        orderBy: { occurredAt: 'desc' },
        take: recentLimit,
        select: {
          id: true,
          type: true,
          title: true,
          description: true,
          actorLabel: true,
          occurredAt: true,
        },
      }),
    ]);

  const financial: StudentFinancialPosition | null =
    currency && balance
      ? {
          currency: balance.currency,
          outstandingMinor: balance.outstandingMinor,
          creditMinor: balance.creditMinor,
          netDueMinor: balance.netDueMinor,
          overdueMinor: balance.overdueMinor,
          openInvoiceCount: balance.invoiceCount,
          overdueInvoiceCount: balance.overdueInvoiceCount,
          recentInvoices: invoices ?? [],
          recentPayments: payments ?? [],
        }
      : null;

  return {
    student,
    enrollments: {
      current: enrollments.filter((row) => row.isOpen),
      past: enrollments.filter((row) => !row.isOpen),
    },
    guardians:
      guardianLinks === null
        ? null
        : guardianLinks.map((link) => ({
            linkId: link.id,
            studentId: link.studentId,
            relationship: link.relationship,
            isPrimary: link.isPrimary,
            isEmergencyContact: link.isEmergencyContact,
            canPickUp: link.canPickUp,
            receivesInvoices: link.receivesInvoices,
            receivesNotifications: link.receivesNotifications,
            guardian: {
              id: link.guardian.id,
              firstName: link.guardian.firstName,
              lastName: link.guardian.lastName,
              fullName: `${link.guardian.firstName} ${link.guardian.lastName}`,
              phone: link.guardian.phone,
              phoneNormalized: link.guardian.phoneNormalized,
              altPhone: link.guardian.altPhone,
              email: link.guardian.email,
              occupation: link.guardian.occupation,
              employer: link.guardian.employer,
              addressLine: link.guardian.addressLine,
              city: link.guardian.city,
              preferredLocale: link.guardian.preferredLocale,
              notes: link.guardian.notes,
              isArchived: link.guardian.deletedAt !== null,
              createdAt: link.guardian.createdAt,
            },
          })),
    attendance,
    financial,
    discounts:
      discounts === null
        ? null
        : discounts.map((row) => ({
            id: row.id,
            code: row.discount.code,
            name: row.discount.name,
            type: row.discount.type,
            amountMinor: row.amountMinor,
            percentPpm: row.percentPpm,
            currency: row.currency,
            reason: row.reason,
            validFrom: row.validFrom,
            validTo: row.validTo,
          })),
    documents:
      documents === null
        ? null
        : documents.map((row) => ({
            id: row.id,
            title: row.title,
            fileName: row.fileName,
            category: row.category,
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            visibility: row.visibility,
            expiresAt: row.expiresAt,
            uploadedAt: row.createdAt,
          })),
    timeline,
    redacted,
  };
}
