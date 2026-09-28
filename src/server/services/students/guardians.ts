/**
 * Guardians (parents) and the student <-> guardian link.
 *
 * Two rules this file holds:
 *
 *  1. A guardian is deduplicated on the NORMALISED phone number within the
 *     organisation. A family enrolling a second child must attach to the parent
 *     record that already exists, because a notification preference or an invoice
 *     recipient flag set on one copy silently fails to apply to the other. The
 *     schema deliberately has no unique index on the phone — a household can
 *     legitimately share one number across two guardians — so this check is the
 *     control, and it is best-effort by design: two simultaneous registrations can
 *     still both miss, and a duplicate a user can merge is a better outcome than a
 *     constraint that rejects a real second parent.
 *
 *  2. AT MOST ONE primary guardian per student. A partial unique index
 *     (`student_guardians_one_primary_per_student`) is the enforcement, so a race
 *     between two "make primary" clicks cannot produce two primaries. The reads
 *     here exist only to produce a sentence an operator can act on.
 *
 * Guardian carries no `branchId`: a parent belongs to the organisation and may
 * have children in two branches. Scope is therefore `organizationFilter` plus, for
 * a SELF-scoped caller, a narrowing through the students they may see — a teacher
 * holding `guardians.view` must not be able to page through every parent in the
 * institution.
 */

import type { GuardianRelationship, Locale, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  isSelfScoped,
  organizationFilter,
  requirePermission,
  scopeFilter,
  selfStudentFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { ageInYears, prismaDateToDateOnly, todayIn } from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CreateGuardianInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly altPhone?: string | null;
  readonly email?: string | null;
  readonly occupation?: string | null;
  readonly employer?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly preferredLocale?: Locale | null;
  readonly notes?: string | null;
}

export type UpdateGuardianInput = Partial<CreateGuardianInput>;

export interface GuardianSummary {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly phone: string;
  readonly phoneNormalized: string | null;
  readonly altPhone: string | null;
  readonly email: string | null;
  readonly occupation: string | null;
  readonly employer: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly preferredLocale: Locale | null;
  readonly notes: string | null;
  readonly isArchived: boolean;
  readonly createdAt: Date;
}

/** A guardian plus the attributes of their link to one student. */
export interface StudentGuardianLink {
  readonly linkId: string;
  readonly studentId: string;
  readonly relationship: GuardianRelationship;
  readonly isPrimary: boolean;
  readonly isEmergencyContact: boolean;
  readonly canPickUp: boolean;
  readonly receivesInvoices: boolean;
  readonly receivesNotifications: boolean;
  readonly guardian: GuardianSummary;
}

/** Attributes of the link itself, shared by create-and-link and relink. */
export interface GuardianLinkAttributes {
  readonly relationship?: GuardianRelationship;
  readonly isPrimary?: boolean;
  readonly isEmergencyContact?: boolean;
  readonly canPickUp?: boolean;
  readonly receivesInvoices?: boolean;
  readonly receivesNotifications?: boolean;
}

export interface LinkGuardianInput extends GuardianLinkAttributes {
  readonly studentId: string;
  readonly guardianId: string;
}

const GUARDIAN_SELECT = {
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
} as const satisfies Prisma.GuardianSelect;

type GuardianRow = Prisma.GuardianGetPayload<{ select: typeof GUARDIAN_SELECT }>;

function toGuardianSummary(row: GuardianRow): GuardianSummary {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.firstName} ${row.lastName}`,
    phone: row.phone,
    phoneNormalized: row.phoneNormalized,
    altPhone: row.altPhone,
    email: row.email,
    occupation: row.occupation,
    employer: row.employer,
    addressLine: row.addressLine,
    city: row.city,
    preferredLocale: row.preferredLocale,
    notes: row.notes,
    isArchived: row.deletedAt !== null,
    createdAt: row.createdAt,
  };
}

/**
 * Normalise a phone the service was handed. The boundary schema normalises too,
 * but a service is never allowed to assume it ran.
 */
function requirePhone(value: string, field = 'phone'): string {
  const normalized = normalizePhone(value);
  if (!normalized) {
    throw new ValidationError([{ path: field, message: 'Not a valid phone number' }]);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Create / update / archive
// ---------------------------------------------------------------------------

export interface CreateGuardianResult {
  readonly guardian: GuardianSummary;
  /** False when an existing guardian with the same number was returned instead. */
  readonly created: boolean;
}

export async function createGuardian(
  ctx: AccessContext,
  input: CreateGuardianInput,
  db?: Db,
): Promise<CreateGuardianResult> {
  requirePermission(ctx, 'guardians.create');

  const phoneNormalized = requirePhone(input.phone);
  const altPhoneNormalized =
    input.altPhone == null || input.altPhone === '' ? null : requirePhone(input.altPhone, 'altPhone');

  return withTransaction(
    async (tx) => {
      const existing = await tx.guardian.findFirst({
        where: { ...organizationFilter(ctx), phoneNormalized, deletedAt: null },
        // Oldest wins, so repeated registrations converge on one record rather
        // than hopping between duplicates that already exist.
        orderBy: { createdAt: 'asc' },
        select: GUARDIAN_SELECT,
      });
      if (existing) return { guardian: toGuardianSummary(existing), created: false };

      const row = await tx.guardian.create({
        data: {
          organizationId: ctx.organizationId,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          phoneNormalized,
          altPhone: altPhoneNormalized,
          email: input.email ?? null,
          occupation: input.occupation ?? null,
          employer: input.employer ?? null,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          preferredLocale: input.preferredLocale ?? null,
          notes: input.notes ?? null,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: GUARDIAN_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GUARDIAN_CREATED,
          entityType: 'Guardian',
          entityId: row.id,
          summary: `Guardian ${row.firstName} ${row.lastName} added`,
          timeline: {
            subjectType: 'GUARDIAN',
            subjectId: row.id,
            type: 'guardian.created',
            title: 'Guardian record created',
          },
        },
        tx,
      );

      return { guardian: toGuardianSummary(row), created: true };
    },
    { existing: db },
  );
}

export async function updateGuardian(
  ctx: AccessContext,
  guardianId: string,
  input: UpdateGuardianInput,
  db?: Db,
): Promise<GuardianSummary> {
  requirePermission(ctx, 'guardians.edit');

  return withTransaction(
    async (tx) => {
      const current = await tx.guardian.findFirst({
        where: { id: guardianId, ...organizationFilter(ctx), deletedAt: null },
        select: GUARDIAN_SELECT,
      });
      if (!current) throw new NotFoundError('Guardian', guardianId);

      const data: Prisma.GuardianUpdateInput = {};
      if (input.firstName !== undefined) data.firstName = input.firstName;
      if (input.lastName !== undefined) data.lastName = input.lastName;
      if (input.phone !== undefined) {
        data.phone = input.phone;
        data.phoneNormalized = requirePhone(input.phone);
      }
      if (input.altPhone !== undefined) {
        data.altPhone =
          input.altPhone == null || input.altPhone === ''
            ? null
            : requirePhone(input.altPhone, 'altPhone');
      }
      if (input.email !== undefined) data.email = input.email;
      if (input.occupation !== undefined) data.occupation = input.occupation;
      if (input.employer !== undefined) data.employer = input.employer;
      if (input.addressLine !== undefined) data.addressLine = input.addressLine;
      if (input.city !== undefined) data.city = input.city;
      if (input.preferredLocale !== undefined) data.preferredLocale = input.preferredLocale;
      if (input.notes !== undefined) data.notes = input.notes;

      // `data` holds exactly the submitted fields, so the diff reports what the
      // caller actually changed rather than every column on the row.
      const changes = diffFields<Record<string, unknown>>({ ...current }, { ...data });
      if (Object.keys(changes).length === 0) return toGuardianSummary(current);

      const row = await tx.guardian.update({
        where: { id: current.id },
        data,
        select: GUARDIAN_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: 'guardian.updated',
          entityType: 'Guardian',
          entityId: row.id,
          summary: `Guardian ${row.firstName} ${row.lastName} updated`,
          changes,
        },
        tx,
      );

      return toGuardianSummary(row);
    },
    { existing: db },
  );
}

/**
 * Archive a guardian. A soft delete: notifications, consents and documents that
 * reference the row must keep resolving, so the record is retired, never removed.
 *
 * Refused while any student is still linked, which keeps the "a minor must have a
 * guardian" rule in exactly one place — `unlinkGuardian`.
 */
export async function archiveGuardian(
  ctx: AccessContext,
  guardianId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<{ readonly id: string; readonly archivedAt: Date }> {
  requirePermission(ctx, 'guardians.delete');

  return withTransaction(
    async (tx) => {
      const guardian = await tx.guardian.findFirst({
        where: { id: guardianId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, firstName: true, lastName: true, _count: { select: { students: true } } },
      });
      if (!guardian) throw new NotFoundError('Guardian', guardianId);

      if (guardian._count.students > 0) {
        throw new BusinessRuleError(
          'guardian.still_linked',
          `${guardian.firstName} ${guardian.lastName} is still linked to ${guardian._count.students} student(s). Unlink them first.`,
          { details: { linkedStudents: guardian._count.students } },
        );
      }

      const archivedAt = new Date();
      await tx.guardian.update({ where: { id: guardian.id }, data: { deletedAt: archivedAt } });

      await recordAudit(
        ctx,
        {
          action: 'guardian.archived',
          entityType: 'Guardian',
          entityId: guardian.id,
          summary: `Guardian ${guardian.firstName} ${guardian.lastName} archived`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          timeline: {
            subjectType: 'GUARDIAN',
            subjectId: guardian.id,
            type: 'guardian.archived',
            title: 'Guardian archived',
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return { id: guardian.id, archivedAt };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'P2002' || code === '23505';
}

/**
 * Did the write hit the one-primary-per-student index rather than the
 * (studentId, guardianId) pair? The aborted transaction cannot be queried again,
 * so the constraint name carried on the error is the only evidence available.
 */
function violatedPrimaryIndex(error: unknown): boolean {
  const candidate = error as {
    meta?: { target?: unknown; constraint?: unknown };
    message?: string;
  };
  return [candidate.meta?.target, candidate.meta?.constraint, candidate.message]
    .map((part) => (Array.isArray(part) ? part.join(' ') : String(part ?? '')))
    .join(' ')
    .toLowerCase()
    .includes('primary');
}

const LINK_SELECT = {
  id: true,
  studentId: true,
  relationship: true,
  isPrimary: true,
  isEmergencyContact: true,
  canPickUp: true,
  receivesInvoices: true,
  receivesNotifications: true,
  guardian: { select: GUARDIAN_SELECT },
} as const satisfies Prisma.StudentGuardianSelect;

type LinkRow = Prisma.StudentGuardianGetPayload<{ select: typeof LINK_SELECT }>;

function toLink(row: LinkRow): StudentGuardianLink {
  return {
    linkId: row.id,
    studentId: row.studentId,
    relationship: row.relationship,
    isPrimary: row.isPrimary,
    isEmergencyContact: row.isEmergencyContact,
    canPickUp: row.canPickUp,
    receivesInvoices: row.receivesInvoices,
    receivesNotifications: row.receivesNotifications,
    guardian: toGuardianSummary(row.guardian),
  };
}

export async function linkGuardianToStudent(
  ctx: AccessContext,
  input: LinkGuardianInput,
  db?: Db,
): Promise<StudentGuardianLink> {
  requirePermission(ctx, 'guardians.link');

  return withTransaction(
    async (tx) => {
      const student = await tx.student.findFirst({
        where: { id: input.studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true, branchId: true, firstName: true, lastName: true },
      });
      if (!student) throw new NotFoundError('Student', input.studentId);
      assertBranchAccess(ctx, student.branchId, 'student');

      const guardian = await tx.guardian.findFirst({
        where: { id: input.guardianId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!guardian) throw new NotFoundError('Guardian', input.guardianId);

      const studentLabel = `${student.firstName} ${student.lastName}`;

      // Read the incumbent primary only to fail with a name rather than a
      // constraint. The index still decides: a concurrent write that slips past
      // this read is rejected below.
      if (input.isPrimary) {
        const incumbent = await tx.studentGuardian.findFirst({
          where: { studentId: student.id, isPrimary: true },
          select: { guardian: { select: { firstName: true, lastName: true } } },
        });
        if (incumbent) {
          throw new ConflictError(
            `${studentLabel} already has ${incumbent.guardian.firstName} ${incumbent.guardian.lastName} as their primary guardian. Clear that first.`,
            { details: { studentId: student.id } },
          );
        }
      }

      let row: LinkRow;
      try {
        row = await tx.studentGuardian.create({
          data: {
            studentId: student.id,
            guardianId: guardian.id,
            relationship: input.relationship ?? 'OTHER',
            isPrimary: input.isPrimary ?? false,
            isEmergencyContact: input.isEmergencyContact ?? false,
            canPickUp: input.canPickUp ?? true,
            receivesInvoices: input.receivesInvoices ?? true,
            receivesNotifications: input.receivesNotifications ?? true,
          },
          select: LINK_SELECT,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (violatedPrimaryIndex(error)) {
          throw new ConflictError(
            `${studentLabel} already has a primary guardian. Clear the current one first.`,
            { details: { studentId: student.id, guardianId: guardian.id } },
          );
        }
        throw new ConflictError(
          `${guardian.firstName} ${guardian.lastName} is already linked to ${studentLabel}.`,
          { details: { studentId: student.id, guardianId: guardian.id } },
        );
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GUARDIAN_LINKED,
          entityType: 'StudentGuardian',
          entityId: row.id,
          branchId: student.branchId,
          summary: `${guardian.firstName} ${guardian.lastName} linked to ${studentLabel} as ${row.relationship}`,
          metadata: { studentId: student.id, guardianId: guardian.id, isPrimary: row.isPrimary },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: student.id,
            type: 'guardian.linked',
            title: `${guardian.firstName} ${guardian.lastName} added as ${row.relationship.toLowerCase()}`,
          },
        },
        tx,
      );

      return toLink(row);
    },
    { existing: db },
  );
}

/**
 * Change the attributes of an existing link (relationship, who receives
 * invoices, who is the emergency contact). Promoting to primary goes through the
 * same index translation as linking does.
 */
export async function updateGuardianLink(
  ctx: AccessContext,
  input: { readonly studentId: string; readonly guardianId: string } & GuardianLinkAttributes,
  db?: Db,
): Promise<StudentGuardianLink> {
  requirePermission(ctx, 'guardians.link');

  return withTransaction(
    async (tx) => {
      const current = await tx.studentGuardian.findFirst({
        where: {
          studentId: input.studentId,
          guardianId: input.guardianId,
          // Scoped through the student, because StudentGuardian carries no
          // organisation of its own.
          student: { ...scopeFilter(ctx), deletedAt: null },
        },
        select: { ...LINK_SELECT, student: { select: { branchId: true, firstName: true, lastName: true } } },
      });
      if (!current) throw new NotFoundError('Guardian link');

      const data: Prisma.StudentGuardianUpdateInput = {};
      if (input.relationship !== undefined) data.relationship = input.relationship;
      if (input.isPrimary !== undefined) data.isPrimary = input.isPrimary;
      if (input.isEmergencyContact !== undefined) data.isEmergencyContact = input.isEmergencyContact;
      if (input.canPickUp !== undefined) data.canPickUp = input.canPickUp;
      if (input.receivesInvoices !== undefined) data.receivesInvoices = input.receivesInvoices;
      if (input.receivesNotifications !== undefined) {
        data.receivesNotifications = input.receivesNotifications;
      }

      const changes = diffFields<Record<string, unknown>>(
        {
          relationship: current.relationship,
          isPrimary: current.isPrimary,
          isEmergencyContact: current.isEmergencyContact,
          canPickUp: current.canPickUp,
          receivesInvoices: current.receivesInvoices,
          receivesNotifications: current.receivesNotifications,
        },
        { ...data },
      );
      if (Object.keys(changes).length === 0) return toLink(current);

      let row: LinkRow;
      try {
        row = await tx.studentGuardian.update({
          where: { id: current.id },
          data,
          select: LINK_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error) && violatedPrimaryIndex(error)) {
          throw new ConflictError(
            `${current.student.firstName} ${current.student.lastName} already has a primary guardian. Clear the current one first.`,
            { details: { studentId: current.studentId } },
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'guardian.link_updated',
          entityType: 'StudentGuardian',
          entityId: row.id,
          branchId: current.student.branchId,
          summary: `Guardian link updated for ${current.student.firstName} ${current.student.lastName}`,
          changes,
        },
        tx,
      );

      return toLink(row);
    },
    { existing: db },
  );
}

/**
 * Remove a guardian from a student.
 *
 * Refused when it would leave a student under 18 with nobody on record. When the
 * date of birth was never captured the removal is allowed and the audit row says
 * the age was unknown: refusing on missing data would make a mistyped link
 * unfixable for every student whose birthday nobody ever entered.
 */
export async function unlinkGuardian(
  ctx: AccessContext,
  input: {
    readonly studentId: string;
    readonly guardianId: string;
    readonly reason?: string | null;
  },
  db?: Db,
): Promise<{ readonly studentId: string; readonly guardianId: string; readonly remaining: number }> {
  requirePermission(ctx, 'guardians.link');

  return withTransaction(
    async (tx) => {
      const link = await tx.studentGuardian.findFirst({
        where: {
          studentId: input.studentId,
          guardianId: input.guardianId,
          student: { ...scopeFilter(ctx), deletedAt: null },
        },
        select: {
          id: true,
          isPrimary: true,
          guardian: { select: { id: true, firstName: true, lastName: true } },
          student: {
            select: {
              id: true,
              branchId: true,
              firstName: true,
              lastName: true,
              dateOfBirth: true,
            },
          },
        },
      });
      if (!link) throw new NotFoundError('Guardian link');

      const remaining = await tx.studentGuardian.count({
        where: { studentId: link.student.id, NOT: { id: link.id } },
      });

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: link.student.branchId },
        tx,
      );
      const age =
        link.student.dateOfBirth === null
          ? null
          : ageInYears(prismaDateToDateOnly(link.student.dateOfBirth), todayIn(timezone));

      if (remaining === 0 && age !== null && age < 18) {
        throw new BusinessRuleError(
          'guardian.last_for_minor',
          `${link.student.firstName} ${link.student.lastName} is ${age} and must have at least one guardian on record. Link another guardian before removing this one.`,
          { details: { studentId: link.student.id, age } },
        );
      }

      await tx.studentGuardian.delete({ where: { id: link.id } });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.GUARDIAN_UNLINKED,
          entityType: 'StudentGuardian',
          entityId: link.id,
          branchId: link.student.branchId,
          summary: `${link.guardian.firstName} ${link.guardian.lastName} unlinked from ${link.student.firstName} ${link.student.lastName}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: {
            studentId: link.student.id,
            guardianId: link.guardian.id,
            wasPrimary: link.isPrimary,
            remainingGuardians: remaining,
            ageUnknown: age === null,
          },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: link.student.id,
            type: 'guardian.unlinked',
            title: `${link.guardian.firstName} ${link.guardian.lastName} removed as guardian`,
            description: input.reason ?? null,
          },
        },
        tx,
      );

      return { studentId: link.student.id, guardianId: link.guardian.id, remaining };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type GuardianSortField = 'lastName' | 'firstName' | 'createdAt';

export interface ListGuardiansInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly q?: string;
  readonly includeArchived?: boolean;
  readonly sortBy?: GuardianSortField;
  readonly sortDir?: 'asc' | 'desc';
}

export interface GuardianListRow extends GuardianSummary {
  readonly studentCount: number;
  /** The first few children, for the list cell. `studentCount` is authoritative. */
  readonly students: ReadonlyArray<{
    readonly id: string;
    readonly fullName: string;
    readonly studentCode: string;
    readonly isPrimary: boolean;
  }>;
}

export interface GuardianListResult {
  readonly rows: readonly GuardianListRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** True when the free-text match had to be capped; the UI should say so. */
  readonly searchTruncated: boolean;
}

const PAGE_SIZE_CEILING = 100;
/**
 * How many index-backed candidates a free-text search considers. Bounded because
 * the id set is materialised in the application; ordered by trigram similarity so
 * the closest matches are the ones that survive the cap.
 */
const SEARCH_CANDIDATE_CAP = 500;

/**
 * Candidate guardian ids for a free-text term, matched through
 * `guardians_name_trgm` and `guardians_phone_reversed`.
 *
 * Raw SQL because both indexes are on EXPRESSIONS — `search_normalize(first || ' '
 * || last)` and `reverse(phoneNormalized)` — which Prisma's `contains` cannot
 * generate, so a Prisma-only search would scan the table. The term is normalised
 * by the same `search_normalize` the index was built with, never by a JS
 * lower-casing that would disagree about accents.
 */
async function searchGuardianIds(
  db: Db,
  organizationId: string,
  term: string,
): Promise<string[]> {
  const digits = term.replace(/\D/g, '');
  // Two digits match half the institution; a phone search needs to be a real one.
  const phoneTerm = digits.length >= 3 ? digits : null;

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    select g."id"
    from "guardians" g
    where g."organizationId" = ${organizationId}
      and (
        "search_normalize"(g."firstName" || ' ' || g."lastName")
          like '%' || "search_normalize"(${term}) || '%'
        or (
          ${phoneTerm}::text is not null
          and g."phoneNormalized" is not null
          and reverse(g."phoneNormalized") like reverse(${phoneTerm}::text) || '%'
        )
      )
    order by
      similarity(
        "search_normalize"(g."firstName" || ' ' || g."lastName"),
        "search_normalize"(${term})
      ) desc,
      g."lastName" asc,
      g."firstName" asc
    limit ${SEARCH_CANDIDATE_CAP}
  `;
  return rows.map((row) => row.id);
}

/**
 * The SELF narrowing for guardians: a caller restricted to their own records sees
 * their own guardian row and the guardians of the students they may see. Built
 * from `selfStudentFilter` so "which students" has one definition.
 */
function selfGuardianFilter(ctx: AccessContext): Prisma.GuardianWhereInput | null {
  if (!isSelfScoped(ctx)) return null;
  const branches: Prisma.GuardianWhereInput[] = [
    // `selfStudentFilter` returns an untyped predicate by design (it is shared by
    // several modules); it is a StudentWhereInput at every call site.
    { students: { some: { student: selfStudentFilter(ctx) as Prisma.StudentWhereInput } } },
  ];
  if (ctx.self.guardianId) branches.push({ id: ctx.self.guardianId });
  return { OR: branches };
}

export async function listGuardians(
  ctx: AccessContext,
  input: ListGuardiansInput = {},
  db: Db = prisma,
): Promise<GuardianListResult> {
  requirePermission(ctx, 'guardians.view');

  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(PAGE_SIZE_CEILING, Math.max(1, Math.trunc(input.pageSize ?? 25)));

  const where: Prisma.GuardianWhereInput = { ...organizationFilter(ctx) };
  if (!input.includeArchived) where.deletedAt = null;

  const self = selfGuardianFilter(ctx);
  if (self) where.AND = [self];

  let searchTruncated = false;
  const term = input.q?.trim();
  if (term) {
    if (self) {
      // A SELF-scoped caller's visible set is a handful of rows, so a substring
      // match over it costs nothing and — unlike the capped index search — cannot
      // drop a match. The index exists for organisation-wide searching.
      where.OR = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term } },
        { phoneNormalized: { contains: term.replace(/\D/g, '') || term } },
      ];
    } else {
      const ids = await searchGuardianIds(db, ctx.organizationId, term);
      searchTruncated = ids.length === SEARCH_CANDIDATE_CAP;
      where.id = { in: ids };
    }
  }

  const sortBy: GuardianSortField = input.sortBy ?? 'lastName';
  const sortDir = input.sortDir ?? 'asc';
  // `id` breaks ties so that page 2 cannot repeat a row from page 1.
  const orderBy: Prisma.GuardianOrderByWithRelationInput[] =
    sortBy === 'lastName'
      ? [{ lastName: sortDir }, { firstName: sortDir }, { id: 'asc' }]
      : [{ [sortBy]: sortDir }, { id: 'asc' }];

  const [rows, total] = await Promise.all([
    db.guardian.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...GUARDIAN_SELECT,
        _count: { select: { students: true } },
        students: {
          take: 5,
          orderBy: { isPrimary: 'desc' },
          select: {
            isPrimary: true,
            student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
          },
        },
      },
    }),
    db.guardian.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      ...toGuardianSummary(row),
      studentCount: row._count.students,
      students: row.students.map((link) => ({
        id: link.student.id,
        fullName: `${link.student.firstName} ${link.student.lastName}`,
        studentCode: link.student.studentCode,
        isPrimary: link.isPrimary,
      })),
    })),
    total,
    page,
    pageSize,
    searchTruncated,
  };
}

export interface GuardianDetail extends GuardianSummary {
  readonly students: ReadonlyArray<{
    readonly linkId: string;
    readonly studentId: string;
    readonly studentCode: string;
    readonly fullName: string;
    readonly status: string;
    readonly branchId: string;
    readonly relationship: GuardianRelationship;
    readonly isPrimary: boolean;
    readonly isEmergencyContact: boolean;
    readonly canPickUp: boolean;
    readonly receivesInvoices: boolean;
    readonly receivesNotifications: boolean;
  }>;
}

export async function getGuardian(
  ctx: AccessContext,
  guardianId: string,
  db: Db = prisma,
): Promise<GuardianDetail> {
  requirePermission(ctx, 'guardians.view');

  const self = selfGuardianFilter(ctx);
  const row = await db.guardian.findFirst({
    // Scope in the same predicate as the id: fetching first and checking after
    // would confirm that a guardian in another organisation exists.
    where: { id: guardianId, ...organizationFilter(ctx), ...(self ? { AND: [self] } : {}) },
    select: {
      ...GUARDIAN_SELECT,
      students: {
        orderBy: [{ isPrimary: 'desc' }, { student: { lastName: 'asc' } }],
        select: {
          id: true,
          relationship: true,
          isPrimary: true,
          isEmergencyContact: true,
          canPickUp: true,
          receivesInvoices: true,
          receivesNotifications: true,
          student: {
            select: {
              id: true,
              studentCode: true,
              firstName: true,
              lastName: true,
              status: true,
              branchId: true,
            },
          },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('Guardian', guardianId);

  return {
    ...toGuardianSummary(row),
    students: row.students.map((link) => ({
      linkId: link.id,
      studentId: link.student.id,
      studentCode: link.student.studentCode,
      fullName: `${link.student.firstName} ${link.student.lastName}`,
      status: link.student.status,
      branchId: link.student.branchId,
      relationship: link.relationship,
      isPrimary: link.isPrimary,
      isEmergencyContact: link.isEmergencyContact,
      canPickUp: link.canPickUp,
      receivesInvoices: link.receivesInvoices,
      receivesNotifications: link.receivesNotifications,
    })),
  };
}

/**
 * The guardians of one student, primary first.
 *
 * Empty rather than 403 when the student is outside the caller's scope: this feeds
 * a profile panel, and the caller learns nothing from an empty list that they did
 * not already know.
 */
export async function getStudentGuardians(
  ctx: AccessContext,
  studentId: string,
  db: Db = prisma,
): Promise<StudentGuardianLink[]> {
  requirePermission(ctx, 'guardians.view');

  const rows = await db.studentGuardian.findMany({
    where: {
      studentId,
      student: composeReadFilter(ctx, {
        selfFilter: selfStudentFilter(ctx),
      }) as Prisma.StudentWhereInput,
    },
    orderBy: [{ isPrimary: 'desc' }, { guardian: { lastName: 'asc' } }],
    select: LINK_SELECT,
  });

  return rows.map(toLink);
}
