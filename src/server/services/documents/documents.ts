/**
 * Document upload, download and deletion.
 *
 * WHY A STORED FILE IS NEVER REACHABLE BY GUESSING A URL
 *
 * Three independent properties, and the design needs all three because any one of
 * them can be defeated by a future feature:
 *
 *   1. There is no public path. The store is not mounted under any route. Every
 *      read goes through `getDocumentForDownload`, which is the only code that
 *      hands out bytes and does so only after checking the owning entity and the
 *      visibility in the SAME `where` clause as the id lookup.
 *   2. The key is unguessable and server-generated. `generateStorageKey` builds
 *      `{org}/{ownerType}/{yyyy}/{mm}/{128 bits of CSPRNG}`; nothing in it comes
 *      from the client, so no crafted filename can walk out of the store and no
 *      amount of enumeration finds a neighbour's file.
 *   3. When a signed URL is issued it is short-lived and issued only AFTER the
 *      authorisation check, and the issue is recorded in `DocumentAccessLog`.
 *      The local driver cannot sign at all, which is a normal answer: the bytes
 *      are streamed back through the authorised route instead.
 *
 * WRITE ORDER: object first, then row.
 *
 * The two writes cannot be one atomic operation — one is object storage, one is
 * PostgreSQL — so the question is which failure is survivable. An object with no
 * row is unreachable garbage: its key is 128 random bits and the row was the only
 * thing that knew it, so nothing can ever serve it and a sweeper can collect it.
 * A row with no object is a document that appears in every list and breaks when
 * anybody clicks it. So the object is written first, the row second, and a failed
 * row creation deletes the object on the way out.
 *
 * DELETE ORDER: row first, then object — for the same reason read backwards. The
 * row is soft-deleted inside the transaction that audits the deletion; only once
 * that has committed is the object removed, because deleting bytes for a
 * transaction that then rolled back is not recoverable.
 */

import type {
  DocumentCategory,
  DocumentOwnerType,
  DocumentVisibility,
  Prisma,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  record as recordAudit,
  type ActivitySubject,
} from '@/server/audit';
import {
  assertBranchAccess,
  can,
  isSelfScoped,
  organizationFilter,
  requirePermission,
  scopeFilter,
  scopeFilterNullableBranch,
  selfStudentFilter,
  teacherGroupFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import {
  assertStorageKeyForOrganization,
  buildDownloadHeaders,
  generateStorageKey,
  getStorage,
  validateUpload,
} from '@/server/storage';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';

/** How long a signed URL is valid. Long enough to click, short enough to leak. */
const SIGNED_URL_TTL_SECONDS = 120;

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Capped with the constant the request schemas use, so a service reached directly
 * (from a job, or another service) cannot ask for ten thousand rows either. */
function toPage(input: PageInput): { page: number; pageSize: number; skip: number; take: number } {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly category: DocumentCategory;
  readonly visibility: DocumentVisibility;
  readonly ownerType: DocumentOwnerType;
  readonly branchId: string | null;
  readonly checksum: string | null;
  readonly notes: string | null;
  readonly expiresAt: Date | null;
  readonly uploadedById: string | null;
  readonly createdAt: Date;
}

const DOCUMENT_SELECT = {
  id: true,
  title: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  category: true,
  visibility: true,
  ownerType: true,
  branchId: true,
  checksum: true,
  notes: true,
  expiresAt: true,
  uploadedById: true,
  createdAt: true,
} as const satisfies Prisma.DocumentSelect;

export interface UploadFileInput {
  /** As supplied by the client. Used for display only — never for the key. */
  readonly fileName: string;
  /** As declared by the client. Verified against the bytes before storage. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface UploadDocumentInput {
  readonly ownerType: DocumentOwnerType;
  /** The owning row's id. Omitted only for an ORGANIZATION-level document. */
  readonly ownerId?: string | null;
  readonly category?: DocumentCategory;
  /** Defaults to the sanitised filename. */
  readonly title?: string;
  readonly visibility?: DocumentVisibility;
  readonly notes?: string | null;
  readonly expiresAt?: Date | null;
  /** Only honoured for owner types that carry no branch of their own. */
  readonly branchId?: string | null;
  readonly file: UploadFileInput;
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------

/**
 * The nullable foreign keys a Document may use to point at its owner. Typed from
 * Prisma so a column renamed in the schema fails the build here.
 */
type OwnerLink = Partial<
  Pick<
    Prisma.DocumentUncheckedCreateInput,
    | 'studentId'
    | 'guardianId'
    | 'employeeId'
    | 'applicationId'
    | 'invoiceId'
    | 'leadId'
    | 'groupId'
    | 'homeworkId'
    | 'homeworkSubmissionId'
    | 'certificateId'
    | 'leaveRequestId'
    | 'announcementId'
  >
>;

interface ResolvedOwner {
  readonly link: OwnerLink;
  /** The branch the document belongs to, taken from the owner where it has one. */
  readonly branchId: string | null;
  /** Where a timeline entry belongs, when the owner has a profile page. */
  readonly timeline: { subjectType: ActivitySubject; subjectId: string } | null;
  readonly label: string;
}

/**
 * Load the owning row WITH the caller's scope in the same query, and take the
 * branch from it.
 *
 * Scope comes from the owner rather than from the request: a document about a
 * student in branch B belongs to branch B whatever the uploader typed, and
 * letting the client choose would be a way to file a record where its branch
 * admin cannot see it.
 *
 * A miss is NotFound, never OutOfScope — owner ids travel in URLs, and "that
 * exists but is not yours" is an existence oracle across branches.
 */
async function resolveOwner(
  ctx: AccessContext,
  tx: Db,
  input: UploadDocumentInput,
): Promise<ResolvedOwner> {
  const ownerId = input.ownerId ?? null;

  if (input.ownerType === 'ORGANIZATION') {
    // The only owner type with no row of its own; the branch is the caller's
    // explicit choice, verified.
    const branchId = input.branchId ?? null;
    if (branchId) assertBranchAccess(ctx, branchId, 'document');
    return { link: {}, branchId, timeline: null, label: 'the organisation' };
  }

  if (!ownerId) {
    throw new BusinessRuleError(
      'document.owner_required',
      `A ${input.ownerType} document must name the record it belongs to.`,
    );
  }

  switch (input.ownerType) {
    case 'STUDENT': {
      const row = await tx.student.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true },
      });
      if (!row) throw new NotFoundError('Student', ownerId);
      return {
        link: { studentId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'STUDENT', subjectId: row.id },
        label: `${row.firstName} ${row.lastName}`,
      };
    }
    case 'GUARDIAN': {
      const row = await tx.guardian.findFirst({
        where: { id: ownerId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!row) throw new NotFoundError('Guardian', ownerId);
      return {
        link: { guardianId: row.id },
        // A guardian belongs to the organisation, not a branch: their children
        // may be enrolled at two sites.
        branchId: null,
        timeline: { subjectType: 'GUARDIAN', subjectId: row.id },
        label: `${row.firstName} ${row.lastName}`,
      };
    }
    case 'EMPLOYEE': {
      const row = await tx.employee.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, employeeCode: true },
      });
      if (!row) throw new NotFoundError('Employee', ownerId);
      return {
        link: { employeeId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'EMPLOYEE', subjectId: row.id },
        label: `employee ${row.employeeCode}`,
      };
    }
    case 'APPLICATION': {
      const row = await tx.application.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true },
      });
      if (!row) throw new NotFoundError('Application', ownerId);
      return {
        link: { applicationId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'APPLICATION', subjectId: row.id },
        label: 'an application',
      };
    }
    case 'INVOICE': {
      const row = await tx.invoice.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx) },
        select: { id: true, branchId: true, invoiceNumber: true },
      });
      if (!row) throw new NotFoundError('Invoice', ownerId);
      return {
        link: { invoiceId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'INVOICE', subjectId: row.id },
        label: `invoice ${row.invoiceNumber}`,
      };
    }
    case 'LEAD': {
      const row = await tx.lead.findFirst({
        where: {
          id: ownerId,
          ...(scopeFilterNullableBranch(ctx) as Prisma.LeadWhereInput),
          deletedAt: null,
        },
        select: { id: true, branchId: true, firstName: true },
      });
      if (!row) throw new NotFoundError('Lead', ownerId);
      return {
        link: { leadId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'LEAD', subjectId: row.id },
        label: row.firstName,
      };
    }
    case 'GROUP': {
      const row = await tx.group.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, name: true },
      });
      if (!row) throw new NotFoundError('Group', ownerId);
      return {
        link: { groupId: row.id },
        branchId: row.branchId,
        timeline: { subjectType: 'GROUP', subjectId: row.id },
        label: row.name,
      };
    }
    case 'HOMEWORK': {
      const row = await tx.homework.findFirst({
        where: { id: ownerId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, title: true },
      });
      if (!row) throw new NotFoundError('Homework', ownerId);
      return {
        link: { homeworkId: row.id },
        branchId: row.branchId,
        timeline: null,
        label: row.title,
      };
    }
    case 'HOMEWORK_SUBMISSION': {
      // A submission carries no organisation of its own; it inherits the
      // homework's, which is where the tenancy predicate has to go.
      const row = await tx.homeworkSubmission.findFirst({
        where: { id: ownerId, homework: scopeFilter(ctx) },
        select: { id: true, homework: { select: { branchId: true } } },
      });
      if (!row) throw new NotFoundError('Homework submission', ownerId);
      return {
        link: { homeworkSubmissionId: row.id },
        branchId: row.homework.branchId,
        timeline: null,
        label: 'a homework submission',
      };
    }
    case 'CERTIFICATE': {
      const row = await tx.certificate.findFirst({
        where: { id: ownerId, ...organizationFilter(ctx) },
        select: { id: true, studentId: true, student: { select: { branchId: true } } },
      });
      if (!row) throw new NotFoundError('Certificate', ownerId);
      return {
        link: { certificateId: row.id },
        branchId: row.student.branchId,
        timeline: { subjectType: 'STUDENT', subjectId: row.studentId },
        label: 'a certificate',
      };
    }
    case 'LEAVE_REQUEST': {
      const row = await tx.leaveRequest.findFirst({
        where: { id: ownerId, ...organizationFilter(ctx) },
        select: { id: true, employeeId: true, employee: { select: { branchId: true } } },
      });
      if (!row) throw new NotFoundError('Leave request', ownerId);
      return {
        link: { leaveRequestId: row.id },
        branchId: row.employee.branchId,
        timeline: { subjectType: 'EMPLOYEE', subjectId: row.employeeId },
        label: 'a leave request',
      };
    }
    case 'ANNOUNCEMENT': {
      const row = await tx.announcement.findFirst({
        where: { id: ownerId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, title: true },
      });
      if (!row) throw new NotFoundError('Announcement', ownerId);
      return {
        link: { announcementId: row.id },
        branchId: row.branchId,
        timeline: null,
        label: row.title,
      };
    }
    case 'BIOMETRIC_CONSENT':
      // `BiometricConsent` points AT a document rather than the other way round,
      // so there is no column to fill here. A consent form is attached by the
      // biometric consent use-case, which is also the only place that can check
      // the consent is live.
      throw new BusinessRuleError(
        'document.consent_upload_unsupported',
        'A biometric consent form is attached through the consent flow, not the document uploader.',
      );
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadDocumentResult {
  readonly document: DocumentSummary;
  /** True when an identical file was already attached to the same owner. */
  readonly duplicateOfExistingChecksum: boolean;
}

export async function uploadDocument(
  ctx: AccessContext,
  input: UploadDocumentInput,
  db?: Db,
): Promise<UploadDocumentResult> {
  requirePermission(ctx, 'documents.upload');

  // Magic bytes, MIME allow-list, extension cross-check and the size cap, all
  // against the actual buffer. The declared type is attacker-controlled; this is
  // the only place that sees what was really uploaded.
  const validated = validateUpload({
    fileName: input.file.fileName,
    declaredMimeType: input.file.mimeType,
    bytes: input.file.bytes,
  });

  const storage = getStorage();

  // Resolved before the object is written so a forbidden upload never reaches
  // the store at all.
  const owner = await resolveOwner(ctx, db ?? prisma, input);

  const storageKey = generateStorageKey({
    organizationId: ctx.organizationId,
    ownerType: input.ownerType,
    mimeType: validated.mimeType,
  });

  const stored = await storage.put(storageKey, input.file.bytes, {
    contentType: validated.mimeType,
    contentLength: validated.sizeBytes,
  });

  try {
    return await withTransaction(
      async (tx) => {
        // Informational only: the same file legitimately appears twice (a parent
        // sends the same scan for two children), so this warns rather than blocks.
        const duplicate = await tx.document.findFirst({
          where: {
            ...organizationFilter(ctx),
            checksum: stored.checksum,
            ownerType: input.ownerType,
            deletedAt: null,
            ...owner.link,
          },
          select: { id: true },
        });

        const created = await tx.document.create({
          data: {
            organizationId: ctx.organizationId,
            branchId: owner.branchId,
            ownerType: input.ownerType,
            category: input.category ?? 'OTHER',
            ...owner.link,
            title: (input.title?.trim() || validated.fileName).slice(0, 200),
            fileName: validated.fileName,
            storageKey: stored.key,
            storageDriver: storage.name,
            mimeType: validated.mimeType,
            sizeBytes: stored.size,
            checksum: stored.checksum,
            visibility: input.visibility ?? 'STAFF',
            expiresAt: input.expiresAt ?? null,
            notes: input.notes ?? null,
            uploadedById: ctx.isSystem ? null : ctx.userId,
          },
          select: DOCUMENT_SELECT,
        });

        await recordAudit(
          ctx,
          {
            action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
            entityType: 'Document',
            entityId: created.id,
            branchId: owner.branchId,
            summary: `Uploaded "${created.title}" to ${owner.label}`,
            metadata: {
              category: created.category,
              visibility: created.visibility,
              sizeBytes: created.sizeBytes,
              mimeType: created.mimeType,
              checksum: created.checksum,
            },
            ...(owner.timeline
              ? {
                  timeline: {
                    subjectType: owner.timeline.subjectType,
                    subjectId: owner.timeline.subjectId,
                    type: 'document.uploaded',
                    title: `Document added: ${created.title}`,
                  },
                }
              : {}),
          },
          tx,
        );

        return { document: created, duplicateOfExistingChecksum: duplicate !== null };
      },
      { existing: db },
    );
  } catch (error) {
    // The row never committed, so nothing can ever reach this object. Removing it
    // is best-effort: a failed cleanup leaves unreferenced bytes, which is a
    // housekeeping cost, not a correctness or disclosure problem.
    await storage.delete(stored.key).catch((cleanupError: unknown) => {
      logger.error('documents.orphan_object', {
        organizationId: ctx.organizationId,
        storageKey: stored.key,
        error: cleanupError,
      });
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Read predicate
// ---------------------------------------------------------------------------

/**
 * Which documents a caller may see. One predicate, applied as a WHERE fragment on
 * every read — list and single-row alike — so a document can never be reached by
 * fetching it and checking afterwards.
 *
 * Three populations, because `visibility` means different things to each:
 *
 *   PORTAL accounts (a student, a parent) see only OWNER and INTERNAL_PUBLIC
 *   documents about themselves or their children. STAFF and PRIVATE documents —
 *   a safeguarding note, an internal assessment — are invisible to them, which is
 *   the entire reason those levels exist.
 *
 *   A TEACHER, being SELF-scoped, sees documents on their own students and
 *   groups, plus anything they uploaded themselves.
 *
 *   BRANCH or ORGANIZATION staff see everything in scope except other people's
 *   PRIVATE documents.
 *
 * `documents.viewAll` lifts the visibility narrowing but NOT the branch scope: it
 * is an escape hatch for a compliance officer, not a way out of tenancy.
 */
function documentReadFilter(ctx: AccessContext): Prisma.DocumentWhereInput {
  const base: Prisma.DocumentWhereInput = {
    ...(scopeFilterNullableBranch(ctx) as Prisma.DocumentWhereInput),
    deletedAt: null,
  };

  if (ctx.isSystem || can(ctx, 'documents.viewAll')) return base;

  const { studentId, guardianId } = ctx.self;
  if (studentId || guardianId) {
    const ownerClauses: Prisma.DocumentWhereInput[] = [];
    if (studentId) ownerClauses.push({ studentId });
    if (guardianId) {
      ownerClauses.push({ guardianId });
      // A parent may see documents about the children linked to them.
      ownerClauses.push({ student: { guardians: { some: { guardianId } } } });
    }
    return {
      AND: [
        base,
        { visibility: { in: ['OWNER', 'INTERNAL_PUBLIC'] } },
        { OR: ownerClauses },
      ],
    };
  }

  const staffVisible: Prisma.DocumentWhereInput = {
    OR: [
      { visibility: { in: ['STAFF', 'OWNER', 'INTERNAL_PUBLIC'] } },
      // Your own PRIVATE uploads stay visible to you.
      { visibility: 'PRIVATE', uploadedById: ctx.userId },
    ],
  };

  if (!isSelfScoped(ctx)) return { AND: [base, staffVisible] };

  return {
    AND: [
      base,
      staffVisible,
      {
        OR: [
          { uploadedById: ctx.userId },
          { student: selfStudentFilter(ctx) as Prisma.StudentWhereInput },
          { group: teacherGroupFilter(ctx) as Prisma.GroupWhereInput },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListDocumentsInput extends PageInput {
  readonly ownerType?: DocumentOwnerType;
  readonly ownerId?: string;
  readonly category?: readonly DocumentCategory[];
  readonly visibility?: readonly DocumentVisibility[];
  readonly branchId?: string;
  readonly q?: string;
  /** Documents whose `expiresAt` has passed — a compliance chase list. */
  readonly expiredOnly?: boolean;
  readonly sortBy?: 'createdAt' | 'title' | 'sizeBytes';
  readonly sortDir?: 'asc' | 'desc';
}

export async function listDocuments(
  ctx: AccessContext,
  input: ListDocumentsInput = {},
  db?: Db,
): Promise<Paginated<DocumentSummary>> {
  requirePermission(ctx, 'documents.view');

  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const filters: Prisma.DocumentWhereInput[] = [documentReadFilter(ctx)];

  if (input.ownerType) filters.push({ ownerType: input.ownerType });
  if (input.ownerId) filters.push(ownerIdFilter(input.ownerType, input.ownerId));
  if (input.category && input.category.length > 0) {
    filters.push({ category: { in: [...input.category] } });
  }
  if (input.visibility && input.visibility.length > 0) {
    filters.push({ visibility: { in: [...input.visibility] } });
  }
  if (input.branchId) {
    assertBranchAccess(ctx, input.branchId, 'document');
    filters.push({ branchId: input.branchId });
  }
  if (input.expiredOnly) filters.push({ expiresAt: { lt: new Date() } });

  const term = input.q?.trim();
  if (term) {
    filters.push({
      OR: [
        { title: { contains: term, mode: 'insensitive' } },
        { fileName: { contains: term, mode: 'insensitive' } },
      ],
    });
  }

  const where: Prisma.DocumentWhereInput = { AND: filters };
  const direction = input.sortDir ?? (input.sortBy === 'title' ? 'asc' : 'desc');
  const orderBy: Prisma.DocumentOrderByWithRelationInput[] =
    input.sortBy === 'title'
      ? [{ title: direction }]
      : input.sortBy === 'sizeBytes'
        ? [{ sizeBytes: direction }, { id: 'asc' }]
        : [{ createdAt: direction }, { id: 'asc' }];

  const [total, items] = await Promise.all([
    client.document.count({ where }),
    client.document.findMany({ where, orderBy, skip, take, select: DOCUMENT_SELECT }),
  ]);

  return { items, page, pageSize, total };
}

/**
 * Filter by owner id.
 *
 * Without a declared `ownerType` the id could belong to any of eleven columns, so
 * the predicate is an OR across all of them rather than a guess. Supplying the
 * type as well turns it into a single indexed column comparison.
 */
function ownerIdFilter(
  ownerType: DocumentOwnerType | undefined,
  ownerId: string,
): Prisma.DocumentWhereInput {
  switch (ownerType) {
    case 'STUDENT':
      return { studentId: ownerId };
    case 'GUARDIAN':
      return { guardianId: ownerId };
    case 'EMPLOYEE':
      return { employeeId: ownerId };
    case 'APPLICATION':
      return { applicationId: ownerId };
    case 'INVOICE':
      return { invoiceId: ownerId };
    case 'LEAD':
      return { leadId: ownerId };
    case 'GROUP':
      return { groupId: ownerId };
    case 'HOMEWORK':
      return { homeworkId: ownerId };
    case 'HOMEWORK_SUBMISSION':
      return { homeworkSubmissionId: ownerId };
    case 'CERTIFICATE':
      return { certificateId: ownerId };
    case 'LEAVE_REQUEST':
      return { leaveRequestId: ownerId };
    case 'ANNOUNCEMENT':
      return { announcementId: ownerId };
    default:
      return {
        OR: [
          { studentId: ownerId },
          { guardianId: ownerId },
          { employeeId: ownerId },
          { applicationId: ownerId },
          { invoiceId: ownerId },
          { leadId: ownerId },
          { groupId: ownerId },
          { homeworkId: ownerId },
          { homeworkSubmissionId: ownerId },
          { certificateId: ownerId },
          { leaveRequestId: ownerId },
          { announcementId: ownerId },
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export interface DownloadDocumentInput {
  /** `inline` is downgraded to `attachment` for any type a browser might run. */
  readonly disposition?: 'attachment' | 'inline';
  /**
   * Prefer a short-lived signed URL over streaming, when the driver can sign.
   * The local driver never can, and `signedUrl` will be null.
   */
  readonly preferSignedUrl?: boolean;
}

export interface DocumentDownload {
  readonly document: DocumentSummary;
  /** Set when the driver signed a URL; the caller redirects to it. */
  readonly signedUrl: string | null;
  /** Set when the bytes must be streamed through our own authorised route. */
  readonly body: ReadableStream<Uint8Array> | Buffer | null;
  /** Content-Type, Content-Disposition, nosniff, CSP and cache headers. */
  readonly headers: Headers;
}

/**
 * Authorise, record the access, and hand back either a stream or a signed URL.
 *
 * The lookup carries the full read predicate, so a document belonging to another
 * branch or hidden by its visibility is simply not found — the same answer as an
 * id that never existed, which is what stops this endpoint being an oracle.
 */
export async function getDocumentForDownload(
  ctx: AccessContext,
  documentId: string,
  input: DownloadDocumentInput = {},
  db?: Db,
): Promise<DocumentDownload> {
  requirePermission(ctx, 'documents.view');

  const client = db ?? prisma;
  const row = await client.document.findFirst({
    where: { AND: [documentReadFilter(ctx), { id: documentId }] },
    select: { ...DOCUMENT_SELECT, storageKey: true },
  });
  if (!row) throw new NotFoundError('Document', documentId);

  // The key is an internal identifier and never leaves the server, so it is split
  // off here rather than filtered out later.
  const { storageKey, ...document } = row;

  // Belt and braces over the read predicate: the key must also decode to this
  // tenant. A key that does not is either a corrupted row or a cross-tenant
  // replay, and both are worth refusing loudly rather than fetching.
  assertStorageKeyForOrganization(storageKey, ctx.organizationId);

  const { documentAccessLogging } = await getSettings(
    ['documentAccessLogging'],
    { organizationId: ctx.organizationId, branchId: document.branchId },
    client,
  );

  const storage = getStorage();
  const headers = buildDownloadHeaders({
    fileName: document.fileName,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    disposition: input.disposition,
  });

  const signedUrl = input.preferSignedUrl
    ? await storage.signedUrl(storageKey, SIGNED_URL_TTL_SECONDS)
    : null;

  // Recorded AFTER authorisation and BEFORE the bytes leave, so the log cannot
  // claim an access that was refused nor miss one that succeeded.
  if (documentAccessLogging) {
    await client.documentAccessLog.create({
      data: {
        documentId: document.id,
        userId: ctx.isSystem ? null : ctx.userId,
        action: signedUrl ? 'SIGNED_URL_ISSUED' : 'DOWNLOAD',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
      },
    });
  }

  if (signedUrl) {
    return { document, signedUrl, body: null, headers };
  }

  const object = await storage.get(storageKey);
  return { document, signedUrl: null, body: object.stream, headers };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteDocumentInput {
  readonly reason: string;
}

/**
 * Soft-delete a document, then remove the bytes.
 *
 * Soft on the row because the audit trail has to keep pointing at something: "who
 * deleted the contract, and when" is unanswerable if the row is gone. The object
 * is removed for real, because keeping a file nobody can reach is a data-retention
 * liability rather than a safety net.
 */
export async function deleteDocument(
  ctx: AccessContext,
  documentId: string,
  input: DeleteDocumentInput,
  db?: Db,
): Promise<{ id: string; deletedAt: Date; objectRemoved: boolean }> {
  requirePermission(ctx, 'documents.delete');

  const deleted = await withTransaction(
    async (tx) => {
      const document = await tx.document.findFirst({
        where: { AND: [documentReadFilter(ctx), { id: documentId }] },
        select: {
          id: true,
          title: true,
          branchId: true,
          storageKey: true,
          studentId: true,
          ownerType: true,
        },
      });
      if (!document) throw new NotFoundError('Document', documentId);
      assertStorageKeyForOrganization(document.storageKey, ctx.organizationId);

      const deletedAt = new Date();
      await tx.document.update({ where: { id: document.id }, data: { deletedAt } });

      // The access log records reads AND deletions, so the "who touched this file"
      // panel stays complete after the row is gone from every list.
      await tx.documentAccessLog.create({
        data: {
          documentId: document.id,
          userId: ctx.isSystem ? null : ctx.userId,
          action: 'DELETE',
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.DOCUMENT_DELETED,
          entityType: 'Document',
          entityId: document.id,
          branchId: document.branchId,
          summary: `Deleted document "${document.title}"`,
          reason: input.reason,
          severity: 'NOTICE',
          ...(document.studentId
            ? {
                timeline: {
                  subjectType: 'STUDENT' as ActivitySubject,
                  subjectId: document.studentId,
                  type: 'document.deleted',
                  title: `Document removed: ${document.title}`,
                  description: input.reason,
                },
              }
            : {}),
        },
        tx,
      );

      return { id: document.id, deletedAt, storageKey: document.storageKey };
    },
    { existing: db },
  );

  // Only after the transaction has committed: bytes deleted for a transaction
  // that then rolled back cannot be brought back.
  let objectRemoved = true;
  await getStorage()
    .delete(deleted.storageKey)
    .catch((error: unknown) => {
      objectRemoved = false;
      // The row is already marked deleted, so the document is unreachable either
      // way. Surfaced in the log for a sweeper rather than failing the request.
      logger.error('documents.object_delete_failed', {
        organizationId: ctx.organizationId,
        documentId: deleted.id,
        error,
      });
    });

  return { id: deleted.id, deletedAt: deleted.deletedAt, objectRemoved };
}

// ---------------------------------------------------------------------------
// Access log
// ---------------------------------------------------------------------------

export interface DocumentAccessEntry {
  readonly id: string;
  readonly action: string;
  readonly userId: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: Date;
}

/**
 * Who opened one document. Behind its own permission because an access log is a
 * record of people's behaviour, not of the document's content.
 */
export async function listDocumentAccessLog(
  ctx: AccessContext,
  documentId: string,
  input: PageInput = {},
  db?: Db,
): Promise<Paginated<DocumentAccessEntry>> {
  requirePermission(ctx, 'documents.viewAccessLog');

  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  // Scoped through the document, so the log of a file in another branch is not
  // readable even by someone holding the log permission.
  const document = await client.document.findFirst({
    where: { AND: [documentReadFilter(ctx), { id: documentId }] },
    select: { id: true },
  });
  if (!document) throw new NotFoundError('Document', documentId);

  const [total, items] = await Promise.all([
    client.documentAccessLog.count({ where: { documentId: document.id } }),
    client.documentAccessLog.findMany({
      where: { documentId: document.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
      select: { id: true, action: true, userId: true, ipAddress: true, createdAt: true },
    }),
  ]);

  return { items, page, pageSize, total };
}
