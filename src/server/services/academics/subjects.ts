/**
 * Subjects: the academic building blocks a programme's curriculum is made of.
 *
 * A subject is organisation-wide, not per branch -- "Mathematics" means the same
 * thing in every building, and duplicating it per branch would fragment every
 * academic report written against it. Every query here therefore scopes on
 * `organizationId` alone (`organizationFilter`), never on branch.
 *
 * Archiving is a soft delete and it is REFUSED while something still depends on the
 * subject. The foreign keys are `onDelete: SetNull`, so a subject that disappeared
 * from under a running group would silently blank that group's, lesson's and exam's
 * subject rather than fail; naming what is in the way is the honest alternative.
 */

import type { Prisma } from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/server/errors';
import { diffFields, record as recordAudit } from '@/server/audit';
import {
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import {
  isUniqueViolation,
  toPage,
  type PageInput,
  type Paginated,
  type SortDirection,
} from '@/server/services/academics/shared';

export interface CreateSubjectInput {
  readonly name: string;
  readonly code: string;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

export interface UpdateSubjectInput {
  readonly name?: string;
  readonly code?: string;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

export interface SubjectSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly archivedAt: Date | null;
}

export interface SubjectListRow extends SubjectSummary {
  /** Programmes whose curriculum includes this subject. */
  readonly programCount: number;
  /** Groups currently teaching it (not completed, not cancelled, not archived). */
  readonly activeGroupCount: number;
}

/** Group states that still depend on their subject and programme. */
const LIVE_GROUP_STATUSES = ['PLANNED', 'ENROLLING', 'ACTIVE', 'PAUSED'] as const;

function toSummary(row: {
  id: string;
  name: string;
  code: string;
  category: string | null;
  description: string | null;
  isActive: boolean;
  deletedAt: Date | null;
}): SubjectSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category,
    description: row.description,
    isActive: row.isActive,
    archivedAt: row.deletedAt,
  };
}

const SUBJECT_FIELDS = {
  id: true,
  name: true,
  code: true,
  category: true,
  description: true,
  isActive: true,
  deletedAt: true,
} as const;

export async function createSubject(
  ctx: AccessContext,
  input: CreateSubjectInput,
  db?: Db,
): Promise<SubjectSummary> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      let created;
      try {
        created = await tx.subject.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            code: input.code,
            category: input.category ?? null,
            description: input.description ?? null,
            isActive: input.isActive ?? true,
          },
          select: SUBJECT_FIELDS,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // `subjects_organizationId_code_key` covers archived rows too, so the code
          // of an archived subject stays taken. Saying so is more useful than
          // "already exists", because the fix is to restore that subject.
          throw new DuplicateError(
            'subject',
            ['code'],
            `The subject code "${input.code}" is already used in this organisation. It may belong to an archived subject.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'subject.created',
          entityType: 'Subject',
          entityId: created.id,
          summary: `Subject ${created.code} — ${created.name} created`,
          metadata: { code: created.code, category: created.category },
        },
        tx,
      );

      return toSummary(created);
    },
    { existing: db },
  );
}

export async function updateSubject(
  ctx: AccessContext,
  subjectId: string,
  input: UpdateSubjectInput,
  db?: Db,
): Promise<SubjectSummary> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      const existing = await tx.subject.findFirst({
        // Scope in the same where clause: fetching then checking the organisation
        // would answer "this id exists" for another tenant's subject.
        where: { id: subjectId, ...organizationFilter(ctx), deletedAt: null },
        select: SUBJECT_FIELDS,
      });
      if (!existing) throw new NotFoundError('Subject', subjectId);

      const data: Prisma.SubjectUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code;
      if (input.category !== undefined) data.category = input.category;
      if (input.description !== undefined) data.description = input.description;
      if (input.isActive !== undefined) data.isActive = input.isActive;

      let updated;
      try {
        updated = await tx.subject.update({
          where: { id: existing.id },
          data,
          select: SUBJECT_FIELDS,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError(
            'subject',
            ['code'],
            `The subject code "${input.code ?? existing.code}" is already used in this organisation.`,
          );
        }
        throw error;
      }

      const changes = diffFields(
        {
          name: existing.name,
          code: existing.code,
          category: existing.category,
          description: existing.description,
          isActive: existing.isActive,
        },
        {
          name: input.name,
          code: input.code,
          category: input.category,
          description: input.description,
          isActive: input.isActive,
        },
      );

      await recordAudit(
        ctx,
        {
          action: 'subject.updated',
          entityType: 'Subject',
          entityId: existing.id,
          summary: `Subject ${updated.code} — ${updated.name} updated`,
          changes,
        },
        tx,
      );

      return toSummary(updated);
    },
    { existing: db },
  );
}

export interface SubjectReference {
  readonly kind: 'GROUP' | 'PROGRAM';
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

/**
 * Archive a subject.
 *
 * Refused while a live group teaches it or a live programme's curriculum lists it,
 * and the blockers are returned by name: "in use" without saying by what leaves the
 * operator hunting. Completed and cancelled groups do not block -- they are history
 * and keep their subject either way.
 */
export async function archiveSubject(
  ctx: AccessContext,
  subjectId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<SubjectSummary> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      const subject = await tx.subject.findFirst({
        where: { id: subjectId, ...organizationFilter(ctx), deletedAt: null },
        select: SUBJECT_FIELDS,
      });
      if (!subject) throw new NotFoundError('Subject', subjectId);

      const [groups, programSubjects] = await Promise.all([
        tx.group.findMany({
          where: {
            subjectId: subject.id,
            organizationId: ctx.organizationId,
            deletedAt: null,
            status: { in: [...LIVE_GROUP_STATUSES] },
          },
          select: { id: true, name: true, code: true },
          // Enough to name the problem without returning a thousand rows.
          take: 10,
        }),
        tx.programSubject.findMany({
          where: {
            subjectId: subject.id,
            program: { organizationId: ctx.organizationId, deletedAt: null, isActive: true },
          },
          select: { program: { select: { id: true, name: true, code: true } } },
          take: 10,
        }),
      ]);

      const blockers: SubjectReference[] = [
        ...groups.map((group) => ({
          kind: 'GROUP' as const,
          id: group.id,
          name: group.name,
          code: group.code,
        })),
        ...programSubjects.map((row) => ({
          kind: 'PROGRAM' as const,
          id: row.program.id,
          name: row.program.name,
          code: row.program.code,
        })),
      ];

      if (blockers.length > 0) {
        throw new BusinessRuleError(
          'subject.still_referenced',
          `${subject.name} is still in use by ${blockers
            .map((blocker) => `${blocker.kind === 'GROUP' ? 'group' : 'programme'} ${blocker.code}`)
            .join(', ')}. Remove it from those first.`,
          { details: { references: blockers } },
        );
      }

      const archived = await tx.subject.update({
        where: { id: subject.id },
        // Deactivated as well as archived: `isActive` is what the pickers filter on,
        // and an archived-but-active subject would still be offered for selection.
        data: { deletedAt: new Date(), isActive: false },
        select: SUBJECT_FIELDS,
      });

      await recordAudit(
        ctx,
        {
          action: 'subject.archived',
          entityType: 'Subject',
          entityId: subject.id,
          summary: `Subject ${subject.code} — ${subject.name} archived`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
        },
        tx,
      );

      return toSummary(archived);
    },
    { existing: db },
  );
}

/** Bring an archived subject back into use. */
export async function restoreSubject(
  ctx: AccessContext,
  subjectId: string,
  db?: Db,
): Promise<SubjectSummary> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      const subject = await tx.subject.findFirst({
        where: { id: subjectId, ...organizationFilter(ctx), deletedAt: { not: null } },
        select: SUBJECT_FIELDS,
      });
      if (!subject) throw new NotFoundError('Archived subject', subjectId);

      const restored = await tx.subject.update({
        where: { id: subject.id },
        data: { deletedAt: null, isActive: true },
        select: SUBJECT_FIELDS,
      });

      await recordAudit(
        ctx,
        {
          action: 'subject.restored',
          entityType: 'Subject',
          entityId: subject.id,
          summary: `Subject ${subject.code} — ${subject.name} restored`,
          severity: 'NOTICE',
        },
        tx,
      );

      return toSummary(restored);
    },
    { existing: db },
  );
}

export interface ListSubjectsInput extends PageInput {
  readonly q?: string;
  readonly category?: string | null;
  readonly isActive?: boolean;
  /** Include soft-deleted subjects. Off by default. */
  readonly includeArchived?: boolean;
  readonly sortBy?: 'name' | 'code' | 'createdAt';
  readonly sortDir?: SortDirection;
}

export async function listSubjects(
  ctx: AccessContext,
  input: ListSubjectsInput = {},
  db?: Db,
): Promise<Paginated<SubjectListRow>> {
  requirePermission(ctx, 'subjects.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const where: Prisma.SubjectWhereInput = {
    ...organizationFilter(ctx),
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.category ? { category: input.category } : {}),
    ...(input.q
      ? {
          OR: [
            { name: { contains: input.q, mode: 'insensitive' } },
            { code: { contains: input.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const sortBy = input.sortBy ?? 'name';
  const [rows, total] = await Promise.all([
    client.subject.findMany({
      where,
      orderBy: { [sortBy]: input.sortDir ?? 'asc' },
      skip,
      take,
      select: SUBJECT_FIELDS,
    }),
    client.subject.count({ where }),
  ]);

  const ids = rows.map((row) => row.id);

  // Two grouped counts for the whole page rather than two queries per row. With
  // `_count` on the relation Prisma would still have to count every group, live or
  // not, so the status predicate is applied here instead.
  const [programCounts, groupCounts] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : client.programSubject.groupBy({
          by: ['subjectId'],
          where: {
            subjectId: { in: ids },
            program: { organizationId: ctx.organizationId, deletedAt: null },
          },
          _count: { _all: true },
        }),
    ids.length === 0
      ? Promise.resolve([])
      : client.group.groupBy({
          by: ['subjectId'],
          where: {
            subjectId: { in: ids },
            organizationId: ctx.organizationId,
            deletedAt: null,
            status: { in: [...LIVE_GROUP_STATUSES] },
          },
          _count: { _all: true },
        }),
  ]);

  const programCountBySubject = new Map(
    programCounts.map((row) => [row.subjectId, row._count._all]),
  );
  const groupCountBySubject = new Map(
    // `Group.subjectId` is nullable, so groupBy types the key as `string | null`;
    // the `in` predicate above guarantees a value on every row we asked for.
    groupCounts.flatMap((row) => (row.subjectId ? [[row.subjectId, row._count._all] as const] : [])),
  );

  return {
    items: rows.map((row) => ({
      ...toSummary(row),
      programCount: programCountBySubject.get(row.id) ?? 0,
      activeGroupCount: groupCountBySubject.get(row.id) ?? 0,
    })),
    page,
    pageSize,
    total,
  };
}

/** One subject, with the same counts the list shows. */
export async function getSubject(
  ctx: AccessContext,
  subjectId: string,
  db?: Db,
): Promise<SubjectListRow> {
  requirePermission(ctx, 'subjects.view');
  const client = db ?? prisma;

  const subject = await client.subject.findFirst({
    where: { id: subjectId, ...organizationFilter(ctx) },
    select: SUBJECT_FIELDS,
  });
  if (!subject) throw new NotFoundError('Subject', subjectId);

  const [programCount, activeGroupCount] = await Promise.all([
    client.programSubject.count({
      where: {
        subjectId: subject.id,
        program: { organizationId: ctx.organizationId, deletedAt: null },
      },
    }),
    client.group.count({
      where: {
        subjectId: subject.id,
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: [...LIVE_GROUP_STATUSES] },
      },
    }),
  ]);

  return { ...toSummary(subject), programCount, activeGroupCount };
}
