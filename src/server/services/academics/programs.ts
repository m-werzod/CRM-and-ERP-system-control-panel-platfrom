/**
 * Programmes: the sellable academic product.
 *
 * A Program is what a lead is interested in, what an applicant applies for, what a
 * FeePlan prices and what a Group delivers. Like Subject it is organisation-wide,
 * so every query scopes on `organizationId` alone.
 *
 * `defaultPriceMinor` is a CATALOGUE price, not the price anyone is charged: a
 * FeePlan may override it per branch or cohort, and an issued invoice froze its own
 * figures at issue time (see finance/invoices.ts). Editing a programme's price
 * therefore never moves money, which is why this file holds no ledger logic.
 * The currency comes from `currencyFor()` so the catalogue cannot end up denominated
 * differently from the invoices raised against it.
 */

import type { Prisma, ProgramLevel } from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/server/errors';
import { diffFields, record as recordAudit } from '@/server/audit';
import {
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import type { CurrencyCode } from '@/lib/money';
import { currencyFor } from '@/server/services/finance/currency';
import {
  isUniqueViolation,
  toPage,
  type PageInput,
  type Paginated,
  type SortDirection,
} from '@/server/services/academics/shared';

/** One line of a programme's curriculum. */
export interface ProgramSubjectInput {
  readonly subjectId: string;
  readonly hoursPerWeek?: number;
  /**
   * Teaching order within the programme. Defaults to the position in the submitted
   * array, which is what a drag-to-reorder UI produces.
   */
  readonly sequence?: number;
}

export interface CreateProgramInput {
  readonly name: string;
  readonly code: string;
  readonly description?: string | null;
  readonly level?: ProgramLevel;
  readonly durationWeeks?: number;
  readonly lessonsPerWeek?: number;
  readonly lessonDurationMinutes?: number;
  /** Minor units. Never a float; see @/lib/money. */
  readonly defaultPriceMinor?: bigint;
  readonly currency?: string;
  readonly isActive?: boolean;
  /** Optional curriculum, set in the same transaction as the programme. */
  readonly subjects?: readonly ProgramSubjectInput[];
}

export interface UpdateProgramInput {
  readonly name?: string;
  readonly code?: string;
  readonly description?: string | null;
  readonly level?: ProgramLevel;
  readonly durationWeeks?: number;
  readonly lessonsPerWeek?: number;
  readonly lessonDurationMinutes?: number;
  readonly defaultPriceMinor?: bigint;
  readonly isActive?: boolean;
}

export interface ProgramSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly description: string | null;
  readonly level: ProgramLevel;
  readonly durationWeeks: number;
  readonly lessonsPerWeek: number;
  readonly lessonDurationMinutes: number;
  readonly defaultPriceMinor: bigint;
  readonly currency: string;
  readonly isActive: boolean;
  readonly archivedAt: Date | null;
}

export interface ProgramCurriculumEntry {
  readonly subjectId: string;
  readonly subjectName: string;
  readonly subjectCode: string;
  readonly hoursPerWeek: number;
  readonly sequence: number;
}

export interface ProgramDetail extends ProgramSummary {
  readonly subjects: readonly ProgramCurriculumEntry[];
  readonly activeGroupCount: number;
  /** Curriculum contact hours per week, the sum of the lines above. */
  readonly totalHoursPerWeek: number;
}

export interface ProgramListRow extends ProgramSummary {
  readonly subjectCount: number;
  readonly activeGroupCount: number;
}

const LIVE_GROUP_STATUSES = ['PLANNED', 'ENROLLING', 'ACTIVE', 'PAUSED'] as const;

const PROGRAM_FIELDS = {
  id: true,
  name: true,
  code: true,
  description: true,
  level: true,
  durationWeeks: true,
  lessonsPerWeek: true,
  lessonDurationMinutes: true,
  defaultPriceMinor: true,
  currency: true,
  isActive: true,
  deletedAt: true,
} as const;

type ProgramRow = {
  id: string;
  name: string;
  code: string;
  description: string | null;
  level: ProgramLevel;
  durationWeeks: number;
  lessonsPerWeek: number;
  lessonDurationMinutes: number;
  defaultPriceMinor: bigint;
  currency: string;
  isActive: boolean;
  deletedAt: Date | null;
};

function toSummary(row: ProgramRow): ProgramSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    level: row.level,
    durationWeeks: row.durationWeeks,
    lessonsPerWeek: row.lessonsPerWeek,
    lessonDurationMinutes: row.lessonDurationMinutes,
    defaultPriceMinor: row.defaultPriceMinor,
    currency: row.currency,
    isActive: row.isActive,
    archivedAt: row.deletedAt,
  };
}

function assertShape(input: {
  durationWeeks?: number;
  lessonsPerWeek?: number;
  lessonDurationMinutes?: number;
  defaultPriceMinor?: bigint;
}): void {
  if (input.durationWeeks !== undefined && input.durationWeeks < 1) {
    throw new BusinessRuleError(
      'program.invalid_duration',
      'A programme must run for at least one week.',
    );
  }
  if (input.lessonsPerWeek !== undefined && input.lessonsPerWeek < 1) {
    throw new BusinessRuleError(
      'program.invalid_lessons_per_week',
      'A programme must have at least one lesson a week.',
    );
  }
  if (input.lessonDurationMinutes !== undefined && input.lessonDurationMinutes < 1) {
    throw new BusinessRuleError(
      'program.invalid_lesson_duration',
      'A lesson must be at least one minute long.',
    );
  }
  if (input.defaultPriceMinor !== undefined && input.defaultPriceMinor < 0n) {
    throw new BusinessRuleError(
      'program.negative_price',
      'A catalogue price cannot be negative.',
    );
  }
}

/**
 * Validate the curriculum lines and resolve them against live subjects.
 *
 * Returns the rows ready to insert. One query for every subject named, so a
 * fifty-subject curriculum is still one round trip.
 */
async function resolveCurriculum(
  ctx: AccessContext,
  tx: Db,
  lines: readonly ProgramSubjectInput[],
): Promise<Array<{ subjectId: string; hoursPerWeek: number; sequence: number }>> {
  if (lines.length === 0) return [];

  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.subjectId)) {
      throw new BusinessRuleError(
        'program.duplicate_subject',
        'The same subject appears twice in the curriculum.',
        { details: { subjectId: line.subjectId } },
      );
    }
    seen.add(line.subjectId);
    if (line.hoursPerWeek !== undefined && line.hoursPerWeek < 1) {
      throw new BusinessRuleError(
        'program.invalid_hours',
        'A curriculum subject must have at least one hour a week.',
        { details: { subjectId: line.subjectId } },
      );
    }
  }

  const subjects = await tx.subject.findMany({
    where: { id: { in: [...seen] }, ...organizationFilter(ctx), deletedAt: null },
    select: { id: true },
  });
  const known = new Set(subjects.map((subject) => subject.id));
  const missing = [...seen].filter((id) => !known.has(id));
  if (missing.length > 0) {
    // NotFound rather than a validation issue: from the caller's side the subject
    // either is not there or is archived, and both are the same fix.
    throw new NotFoundError(
      missing.length === 1 ? 'Subject' : 'Subjects',
      missing.join(', '),
    );
  }

  return lines.map((line, index) => ({
    subjectId: line.subjectId,
    hoursPerWeek: line.hoursPerWeek ?? 3,
    sequence: line.sequence ?? index,
  }));
}

export async function createProgram(
  ctx: AccessContext,
  input: CreateProgramInput,
  db?: Db,
): Promise<ProgramDetail> {
  requirePermission(ctx, 'subjects.manage');
  assertShape(input);

  return withTransaction(
    async (tx) => {
      const currency: CurrencyCode = await currencyFor(
        { organizationId: ctx.organizationId, requested: input.currency },
        tx,
      );
      const curriculum = await resolveCurriculum(ctx, tx, input.subjects ?? []);

      let created: ProgramRow;
      try {
        created = await tx.program.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            code: input.code,
            description: input.description ?? null,
            level: input.level ?? 'BEGINNER',
            durationWeeks: input.durationWeeks ?? 12,
            lessonsPerWeek: input.lessonsPerWeek ?? 3,
            lessonDurationMinutes: input.lessonDurationMinutes ?? 90,
            defaultPriceMinor: input.defaultPriceMinor ?? 0n,
            currency,
            isActive: input.isActive ?? true,
            subjects: { create: curriculum },
          },
          select: PROGRAM_FIELDS,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError(
            'programme',
            ['code'],
            `The programme code "${input.code}" is already used in this organisation. It may belong to an archived programme.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'program.created',
          entityType: 'Program',
          entityId: created.id,
          summary: `Programme ${created.code} — ${created.name} created`,
          metadata: {
            level: created.level,
            defaultPriceMinor: created.defaultPriceMinor.toString(),
            currency,
            subjectCount: curriculum.length,
          },
        },
        tx,
      );

      return loadDetail(ctx, tx, created);
    },
    { existing: db },
  );
}

export async function updateProgram(
  ctx: AccessContext,
  programId: string,
  input: UpdateProgramInput,
  db?: Db,
): Promise<ProgramSummary> {
  requirePermission(ctx, 'subjects.manage');
  assertShape(input);

  return withTransaction(
    async (tx) => {
      const existing = await tx.program.findFirst({
        where: { id: programId, ...organizationFilter(ctx), deletedAt: null },
        select: PROGRAM_FIELDS,
      });
      if (!existing) throw new NotFoundError('Programme', programId);

      const data: Prisma.ProgramUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.code !== undefined) data.code = input.code;
      if (input.description !== undefined) data.description = input.description;
      if (input.level !== undefined) data.level = input.level;
      if (input.durationWeeks !== undefined) data.durationWeeks = input.durationWeeks;
      if (input.lessonsPerWeek !== undefined) data.lessonsPerWeek = input.lessonsPerWeek;
      if (input.lessonDurationMinutes !== undefined) {
        data.lessonDurationMinutes = input.lessonDurationMinutes;
      }
      if (input.defaultPriceMinor !== undefined) data.defaultPriceMinor = input.defaultPriceMinor;
      if (input.isActive !== undefined) data.isActive = input.isActive;
      // `currency` is deliberately absent: re-denominating a catalogue price would
      // reinterpret the number rather than convert it, and the invoices already
      // raised against this programme keep their own frozen currency.

      let updated: ProgramRow;
      try {
        updated = await tx.program.update({
          where: { id: existing.id },
          data,
          select: PROGRAM_FIELDS,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateError(
            'programme',
            ['code'],
            `The programme code "${input.code ?? existing.code}" is already used in this organisation.`,
          );
        }
        throw error;
      }

      await recordAudit(
        ctx,
        {
          action: 'program.updated',
          entityType: 'Program',
          entityId: existing.id,
          summary: `Programme ${updated.code} — ${updated.name} updated`,
          changes: diffFields(
            {
              name: existing.name,
              code: existing.code,
              description: existing.description,
              level: existing.level,
              durationWeeks: existing.durationWeeks,
              lessonsPerWeek: existing.lessonsPerWeek,
              lessonDurationMinutes: existing.lessonDurationMinutes,
              defaultPriceMinor: existing.defaultPriceMinor,
              isActive: existing.isActive,
            },
            {
              name: input.name,
              code: input.code,
              description: input.description,
              level: input.level,
              durationWeeks: input.durationWeeks,
              lessonsPerWeek: input.lessonsPerWeek,
              lessonDurationMinutes: input.lessonDurationMinutes,
              defaultPriceMinor: input.defaultPriceMinor,
              isActive: input.isActive,
            },
          ),
        },
        tx,
      );

      return toSummary(updated);
    },
    { existing: db },
  );
}

/**
 * Archive a programme. Refused while a live group delivers it, naming those groups:
 * the FK is `SetNull`, so deleting underneath them would quietly orphan the groups
 * from the product they sell.
 */
export async function archiveProgram(
  ctx: AccessContext,
  programId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<ProgramSummary> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      const program = await tx.program.findFirst({
        where: { id: programId, ...organizationFilter(ctx), deletedAt: null },
        select: PROGRAM_FIELDS,
      });
      if (!program) throw new NotFoundError('Programme', programId);

      const groups = await tx.group.findMany({
        where: {
          programId: program.id,
          organizationId: ctx.organizationId,
          deletedAt: null,
          status: { in: [...LIVE_GROUP_STATUSES] },
        },
        select: { id: true, name: true, code: true },
        take: 10,
      });

      if (groups.length > 0) {
        throw new BusinessRuleError(
          'program.still_referenced',
          `${program.name} is still delivered by ${groups
            .map((group) => group.code)
            .join(', ')}. Complete or cancel those groups first.`,
          { details: { groups } },
        );
      }

      const archived = await tx.program.update({
        where: { id: program.id },
        data: { deletedAt: new Date(), isActive: false },
        select: PROGRAM_FIELDS,
      });

      await recordAudit(
        ctx,
        {
          action: 'program.archived',
          entityType: 'Program',
          entityId: program.id,
          summary: `Programme ${program.code} — ${program.name} archived`,
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

/**
 * Set a programme's whole curriculum.
 *
 * Replace-wholesale rather than diff: the curriculum is a small ordered list a user
 * edits as a unit, and `ProgramSubject` carries no history anyone reads -- lessons,
 * exams and grades hang off Subject and Group directly, so rewriting these rows
 * loses nothing. The `(programId, subjectId)` unique index still guards against a
 * duplicate slipping through a concurrent edit.
 */
export async function manageProgramSubjects(
  ctx: AccessContext,
  programId: string,
  input: { readonly subjects: readonly ProgramSubjectInput[] },
  db?: Db,
): Promise<ProgramDetail> {
  requirePermission(ctx, 'subjects.manage');

  return withTransaction(
    async (tx) => {
      const program = await tx.program.findFirst({
        where: { id: programId, ...organizationFilter(ctx), deletedAt: null },
        select: PROGRAM_FIELDS,
      });
      if (!program) throw new NotFoundError('Programme', programId);

      const curriculum = await resolveCurriculum(ctx, tx, input.subjects);

      const previous = await tx.programSubject.findMany({
        where: { programId: program.id },
        select: { subjectId: true, hoursPerWeek: true, sequence: true },
        orderBy: { sequence: 'asc' },
      });

      await tx.programSubject.deleteMany({ where: { programId: program.id } });
      if (curriculum.length > 0) {
        await tx.programSubject.createMany({
          data: curriculum.map((line) => ({ ...line, programId: program.id })),
        });
      }

      await recordAudit(
        ctx,
        {
          action: 'program.curriculum_changed',
          entityType: 'Program',
          entityId: program.id,
          summary: `Curriculum for ${program.code} set to ${curriculum.length} subject(s)`,
          changes: {
            subjects: { from: previous, to: curriculum },
          },
        },
        tx,
      );

      return loadDetail(ctx, tx, program);
    },
    { existing: db },
  );
}

export interface ListProgramsInput extends PageInput {
  readonly q?: string;
  readonly level?: ProgramLevel;
  readonly isActive?: boolean;
  readonly includeArchived?: boolean;
  readonly sortBy?: 'name' | 'code' | 'level' | 'defaultPriceMinor' | 'createdAt';
  readonly sortDir?: SortDirection;
}

export async function listPrograms(
  ctx: AccessContext,
  input: ListProgramsInput = {},
  db?: Db,
): Promise<Paginated<ProgramListRow>> {
  requirePermission(ctx, 'subjects.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const where: Prisma.ProgramWhereInput = {
    ...organizationFilter(ctx),
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.level ? { level: input.level } : {}),
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
    client.program.findMany({
      where,
      orderBy: { [sortBy]: input.sortDir ?? 'asc' },
      skip,
      take,
      select: { ...PROGRAM_FIELDS, _count: { select: { subjects: true } } },
    }),
    client.program.count({ where }),
  ]);

  const ids = rows.map((row) => row.id);
  // One grouped count for the page. `_count` cannot carry the status predicate, so
  // the live-group tally is its own query rather than N per-row counts.
  const groupCounts =
    ids.length === 0
      ? []
      : await client.group.groupBy({
          by: ['programId'],
          where: {
            programId: { in: ids },
            organizationId: ctx.organizationId,
            deletedAt: null,
            status: { in: [...LIVE_GROUP_STATUSES] },
          },
          _count: { _all: true },
        });
  const groupCountByProgram = new Map(
    groupCounts.flatMap((row) => (row.programId ? [[row.programId, row._count._all] as const] : [])),
  );

  return {
    items: rows.map((row) => ({
      ...toSummary(row),
      subjectCount: row._count.subjects,
      activeGroupCount: groupCountByProgram.get(row.id) ?? 0,
    })),
    page,
    pageSize,
    total,
  };
}

export async function getProgram(
  ctx: AccessContext,
  programId: string,
  db?: Db,
): Promise<ProgramDetail> {
  requirePermission(ctx, 'subjects.view');
  const client = db ?? prisma;

  const program = await client.program.findFirst({
    where: { id: programId, ...organizationFilter(ctx) },
    select: PROGRAM_FIELDS,
  });
  if (!program) throw new NotFoundError('Programme', programId);

  return loadDetail(ctx, client, program);
}

/** The curriculum and the live-group tally for one already-scoped programme. */
async function loadDetail(
  ctx: AccessContext,
  client: Db,
  program: ProgramRow,
): Promise<ProgramDetail> {
  const [lines, activeGroupCount] = await Promise.all([
    client.programSubject.findMany({
      where: { programId: program.id },
      orderBy: [{ sequence: 'asc' }, { subject: { name: 'asc' } }],
      select: {
        hoursPerWeek: true,
        sequence: true,
        subject: { select: { id: true, name: true, code: true } },
      },
    }),
    client.group.count({
      where: {
        programId: program.id,
        organizationId: ctx.organizationId,
        deletedAt: null,
        status: { in: [...LIVE_GROUP_STATUSES] },
      },
    }),
  ]);

  const subjects = lines.map((line) => ({
    subjectId: line.subject.id,
    subjectName: line.subject.name,
    subjectCode: line.subject.code,
    hoursPerWeek: line.hoursPerWeek,
    sequence: line.sequence,
  }));

  return {
    ...toSummary(program),
    subjects,
    activeGroupCount,
    totalHoursPerWeek: subjects.reduce((total, line) => total + line.hoursPerWeek, 0),
  };
}
