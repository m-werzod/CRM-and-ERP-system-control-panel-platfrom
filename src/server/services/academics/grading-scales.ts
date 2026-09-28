/**
 * Grading scales: the mapping from a score to a grade.
 *
 * A scale's bands are expressed in parts-per-million of the maximum score
 * (50% == 500_000 ppm) with BOTH bounds inclusive, and integers throughout, because a
 * boundary is exactly where a float betrays you: 0.7 * 100 is 69.99999999999999, and
 * a student on the boundary of a pass must not depend on which way that rounded.
 *
 * The bands of a scale must TILE 0..1_000_000 exactly -- no gap, no overlap. A gap
 * would leave a score with no grade at all; an overlap would make the grade depend on
 * iteration order. `validateGradingBands` enforces that and names the band at fault,
 * and `resolveGrade` is pure so the same rule is applied by exam grading, term grades,
 * certificates and the UI preview.
 *
 * One default scale per organisation is enforced by the partial unique index
 * `grading_scales_one_default_per_org`; the flag is moved by clearing then setting
 * inside one transaction, and a concurrent attempt is translated rather than surfaced
 * as a constraint name.
 */

import type { GradingScaleKind, Prisma } from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  DuplicateError,
  NotFoundError,
} from '@/server/errors';
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
} from '@/server/services/academics/shared';

/** Lowest and highest score a band may cover, in ppm of the maximum score. */
export const SCORE_PPM_MIN = 0;
export const SCORE_PPM_MAX = 1_000_000;

/** The minimum a band needs for the pure helpers; the stored row is a superset. */
export interface GradingBandShape {
  readonly label: string;
  readonly minPercentPpm: number;
  readonly maxPercentPpm: number;
}

export interface GradingBandInput extends GradingBandShape {
  readonly gpaPoints?: number | null;
  readonly isPass?: boolean;
  readonly sequence?: number;
}

export interface GradingBand extends GradingBandShape {
  readonly id: string;
  readonly gpaPoints: number | null;
  readonly isPass: boolean;
  readonly sequence: number;
}

// ---------------------------------------------------------------------------
// Pure band arithmetic
// ---------------------------------------------------------------------------

/** Bands lowest-first. Never mutates the caller's array. */
function sortByLowerBound<T extends GradingBandShape>(bands: readonly T[]): T[] {
  return [...bands].sort((a, b) => a.minPercentPpm - b.minPercentPpm);
}

/**
 * Assert that a set of bands tiles 0..1_000_000 exactly, and say which band is wrong.
 *
 * Pure and exported: the same check runs on the server before a write and in the UI
 * while the operator is still editing, so a bad scale is rejected before it can decide
 * anyone's grade. Bounds are inclusive on both sides, so bands are contiguous when
 * each one starts exactly one ppm above the previous one's end -- 0..499_999 then
 * 500_000..1_000_000, not 0..500_000 then 500_000..1_000_000.
 */
export function validateGradingBands(bands: readonly GradingBandInput[]): void {
  if (bands.length === 0) {
    throw new BusinessRuleError(
      'grading_scale.no_bands',
      'A grading scale needs at least one band.',
    );
  }

  const labels = new Set<string>();
  for (const band of bands) {
    if (labels.has(band.label)) {
      throw new BusinessRuleError(
        'grading_scale.duplicate_label',
        `Two bands are both labelled "${band.label}".`,
        { details: { label: band.label } },
      );
    }
    labels.add(band.label);

    if (!Number.isInteger(band.minPercentPpm) || !Number.isInteger(band.maxPercentPpm)) {
      throw new BusinessRuleError(
        'grading_scale.non_integer_bound',
        `Band "${band.label}" has a fractional bound. Bounds are whole parts-per-million.`,
        { details: { label: band.label } },
      );
    }
    if (band.minPercentPpm < SCORE_PPM_MIN || band.maxPercentPpm > SCORE_PPM_MAX) {
      throw new BusinessRuleError(
        'grading_scale.bound_out_of_range',
        `Band "${band.label}" falls outside 0–100%.`,
        { details: { label: band.label, min: band.minPercentPpm, max: band.maxPercentPpm } },
      );
    }
    if (band.maxPercentPpm < band.minPercentPpm) {
      throw new BusinessRuleError(
        'grading_scale.inverted_band',
        `Band "${band.label}" ends below where it starts.`,
        { details: { label: band.label } },
      );
    }
    if (band.gpaPoints != null && band.gpaPoints < 0) {
      throw new BusinessRuleError(
        'grading_scale.negative_gpa',
        `Band "${band.label}" has negative GPA points.`,
        { details: { label: band.label } },
      );
    }
  }

  const sorted = sortByLowerBound(bands);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  // Both are present: `bands.length` was checked above and sorting preserves length.
  if (!lowest || !highest) {
    throw new BusinessRuleError(
      'grading_scale.no_bands',
      'A grading scale needs at least one band.',
    );
  }

  // Pairwise BEFORE the end checks: a band nested inside another sorts last, so the
  // coverage check would otherwise report it as "stops below 100%" when the real
  // problem an operator has to fix is the overlap.
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (!previous || !current) continue;

    if (current.minPercentPpm <= previous.maxPercentPpm) {
      throw new BusinessRuleError(
        'grading_scale.overlapping_bands',
        `Bands "${previous.label}" and "${current.label}" overlap: "${previous.label}" ends at ${previous.maxPercentPpm} ppm and "${current.label}" starts at ${current.minPercentPpm} ppm.`,
        { details: { bands: [previous.label, current.label] } },
      );
    }
    if (current.minPercentPpm !== previous.maxPercentPpm + 1) {
      throw new BusinessRuleError(
        'grading_scale.gap_between_bands',
        `There is a gap between "${previous.label}" and "${current.label}": scores from ${previous.maxPercentPpm + 1} to ${current.minPercentPpm - 1} ppm have no grade.`,
        { details: { bands: [previous.label, current.label] } },
      );
    }
  }

  if (lowest.minPercentPpm !== SCORE_PPM_MIN) {
    throw new BusinessRuleError(
      'grading_scale.gap_at_bottom',
      `The lowest band "${lowest.label}" starts above 0%, so a score below it would have no grade.`,
      { details: { label: lowest.label, startsAtPpm: lowest.minPercentPpm } },
    );
  }
  if (highest.maxPercentPpm !== SCORE_PPM_MAX) {
    throw new BusinessRuleError(
      'grading_scale.gap_at_top',
      `The highest band "${highest.label}" stops below 100%, so a top score would have no grade.`,
      { details: { label: highest.label, endsAtPpm: highest.maxPercentPpm } },
    );
  }
}

/**
 * The band a score falls into.
 *
 * PURE. `scorePpm` is the score as parts-per-million of the maximum, so 43 out of 50
 * is `Math.round(43 * 1_000_000 / 50)`. Returns `null` when nothing matches, which on
 * a scale that has passed `validateGradingBands` can only mean the score itself is
 * outside 0..1_000_000 -- absence of a grade is reported rather than guessed, because
 * silently clamping would turn a marking bug into a plausible-looking grade.
 *
 * Bands are searched lowest-first so an unvalidated, overlapping set still resolves
 * deterministically instead of depending on the order they came out of the database.
 */
export function resolveGrade<T extends GradingBandShape>(
  scaleBands: readonly T[],
  scorePpm: number,
): T | null {
  if (!Number.isFinite(scorePpm)) return null;
  for (const band of sortByLowerBound(scaleBands)) {
    if (scorePpm >= band.minPercentPpm && scorePpm <= band.maxPercentPpm) return band;
  }
  return null;
}

/** Score out of a maximum, as the integer ppm `resolveGrade` expects. */
export function scoreToPpm(score: number, maxScore: number): number {
  if (maxScore <= 0) {
    throw new BusinessRuleError(
      'grading_scale.invalid_max_score',
      'The maximum score must be greater than zero.',
    );
  }
  return Math.round((score * SCORE_PPM_MAX) / maxScore);
}

// ---------------------------------------------------------------------------
// Persisted scales
// ---------------------------------------------------------------------------

export interface GradingScaleSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: GradingScaleKind;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface GradingScaleDetail extends GradingScaleSummary {
  readonly bands: readonly GradingBand[];
  /** Exams currently pointing at this scale; a scale in use should not be retired. */
  readonly examCount: number;
}

const SCALE_FIELDS = {
  id: true,
  name: true,
  kind: true,
  isDefault: true,
  isActive: true,
} as const;

const BAND_FIELDS = {
  id: true,
  label: true,
  minPercentPpm: true,
  maxPercentPpm: true,
  gpaPoints: true,
  isPass: true,
  sequence: true,
} as const;

/** Normalise the input rows: sequence follows the band order unless given. */
function toBandRows(bands: readonly GradingBandInput[]): Array<{
  label: string;
  minPercentPpm: number;
  maxPercentPpm: number;
  gpaPoints: number | null;
  isPass: boolean;
  sequence: number;
}> {
  return sortByLowerBound(bands).map((band, index) => ({
    label: band.label,
    minPercentPpm: band.minPercentPpm,
    maxPercentPpm: band.maxPercentPpm,
    gpaPoints: band.gpaPoints ?? null,
    isPass: band.isPass ?? true,
    sequence: band.sequence ?? index,
  }));
}

/**
 * Clear whatever default the organisation has, so the flag can move.
 *
 * Clearing before setting is what keeps the partial unique index satisfied at every
 * point inside the transaction; setting first would violate it.
 */
async function clearCurrentDefault(
  ctx: AccessContext,
  tx: Db,
  exceptScaleId?: string,
): Promise<void> {
  await tx.gradingScale.updateMany({
    where: {
      ...organizationFilter(ctx),
      isDefault: true,
      ...(exceptScaleId ? { id: { not: exceptScaleId } } : {}),
    },
    data: { isDefault: false },
  });
}

function translateScaleWriteError(error: unknown, name: string): never {
  if (isUniqueViolation(error, 'one_default')) {
    throw new ConflictError(
      'Another default grading scale was set at the same moment. Reload and try again.',
    );
  }
  if (isUniqueViolation(error, 'label')) {
    throw new DuplicateError('grading band', ['label']);
  }
  if (isUniqueViolation(error)) {
    throw new DuplicateError(
      'grading scale',
      ['name'],
      `A grading scale called "${name}" already exists.`,
    );
  }
  throw error;
}

export interface CreateGradingScaleInput {
  readonly name: string;
  readonly kind?: GradingScaleKind;
  readonly isDefault?: boolean;
  readonly isActive?: boolean;
  readonly bands: readonly GradingBandInput[];
}

export async function createGradingScale(
  ctx: AccessContext,
  input: CreateGradingScaleInput,
  db?: Db,
): Promise<GradingScaleDetail> {
  requirePermission(ctx, 'grades.manageScales');
  validateGradingBands(input.bands);

  return withTransaction(
    async (tx) => {
      const isDefault = input.isDefault ?? false;
      if (isDefault) await clearCurrentDefault(ctx, tx);

      let created: GradingScaleSummary;
      try {
        created = await tx.gradingScale.create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name,
            kind: input.kind ?? 'PERCENTAGE',
            isDefault,
            isActive: input.isActive ?? true,
            bands: { create: toBandRows(input.bands) },
          },
          select: SCALE_FIELDS,
        });
      } catch (error) {
        translateScaleWriteError(error, input.name);
      }

      await recordAudit(
        ctx,
        {
          action: 'grading_scale.created',
          entityType: 'GradingScale',
          entityId: created.id,
          summary: `Grading scale "${created.name}" created with ${input.bands.length} band(s)${
            isDefault ? ' and made the default' : ''
          }`,
          metadata: { kind: created.kind, isDefault, bandCount: input.bands.length },
        },
        tx,
      );

      return loadDetail(ctx, tx, created);
    },
    { existing: db },
  );
}

export interface UpdateGradingScaleInput {
  readonly name?: string;
  readonly kind?: GradingScaleKind;
  readonly isActive?: boolean;
}

/**
 * Rename or re-type a scale.
 *
 * `isDefault` is deliberately not a field here: it is a singleton invariant across the
 * organisation rather than a property of one row, so it moves through
 * `setDefaultGradingScale`, which clears the incumbent in the same transaction.
 */
export async function updateGradingScale(
  ctx: AccessContext,
  scaleId: string,
  input: UpdateGradingScaleInput,
  db?: Db,
): Promise<GradingScaleDetail> {
  requirePermission(ctx, 'grades.manageScales');

  return withTransaction(
    async (tx) => {
      const existing = await tx.gradingScale.findFirst({
        where: { id: scaleId, ...organizationFilter(ctx) },
        select: SCALE_FIELDS,
      });
      if (!existing) throw new NotFoundError('Grading scale', scaleId);

      if (input.isActive === false && existing.isDefault) {
        throw new BusinessRuleError(
          'grading_scale.default_must_stay_active',
          `"${existing.name}" is the organisation's default scale. Make another scale the default before retiring it.`,
        );
      }

      const data: Prisma.GradingScaleUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.kind !== undefined) data.kind = input.kind;
      if (input.isActive !== undefined) data.isActive = input.isActive;

      let updated: GradingScaleSummary;
      try {
        updated = await tx.gradingScale.update({
          where: { id: existing.id },
          data,
          select: SCALE_FIELDS,
        });
      } catch (error) {
        translateScaleWriteError(error, input.name ?? existing.name);
      }

      await recordAudit(
        ctx,
        {
          action: 'grading_scale.updated',
          entityType: 'GradingScale',
          entityId: existing.id,
          summary: `Grading scale "${updated.name}" updated`,
          changes: diffFields(
            { name: existing.name, kind: existing.kind, isActive: existing.isActive },
            { name: input.name, kind: input.kind, isActive: input.isActive },
          ),
        },
        tx,
      );

      return loadDetail(ctx, tx, updated);
    },
    { existing: db },
  );
}

/** Make one scale the organisation's default, retiring the incumbent's flag. */
export async function setDefaultGradingScale(
  ctx: AccessContext,
  scaleId: string,
  db?: Db,
): Promise<GradingScaleSummary> {
  requirePermission(ctx, 'grades.manageScales');

  return withTransaction(
    async (tx) => {
      const scale = await tx.gradingScale.findFirst({
        where: { id: scaleId, ...organizationFilter(ctx) },
        select: SCALE_FIELDS,
      });
      if (!scale) throw new NotFoundError('Grading scale', scaleId);
      if (!scale.isActive) {
        throw new BusinessRuleError(
          'grading_scale.inactive_cannot_be_default',
          `"${scale.name}" is retired. Reactivate it before making it the default.`,
        );
      }
      if (scale.isDefault) return scale;

      const previous = await tx.gradingScale.findFirst({
        where: { ...organizationFilter(ctx), isDefault: true },
        select: { id: true, name: true },
      });

      await clearCurrentDefault(ctx, tx, scale.id);

      let updated: GradingScaleSummary;
      try {
        updated = await tx.gradingScale.update({
          where: { id: scale.id },
          data: { isDefault: true },
          select: SCALE_FIELDS,
        });
      } catch (error) {
        translateScaleWriteError(error, scale.name);
      }

      await recordAudit(
        ctx,
        {
          action: 'grading_scale.default_changed',
          entityType: 'GradingScale',
          entityId: scale.id,
          summary: `"${scale.name}" is now the default grading scale`,
          severity: 'NOTICE',
          changes: {
            defaultGradingScale: { from: previous?.name ?? null, to: scale.name },
          },
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

/**
 * Replace a scale's bands wholesale.
 *
 * Existing results are unaffected: `ExamResult.gradeLabel` and `isPass` are SNAPSHOTS
 * taken at grading time, precisely so that retuning a scale cannot silently rewrite
 * grades already published to students.
 */
export async function replaceGradingScaleBands(
  ctx: AccessContext,
  scaleId: string,
  input: { readonly bands: readonly GradingBandInput[] },
  db?: Db,
): Promise<GradingScaleDetail> {
  requirePermission(ctx, 'grades.manageScales');
  validateGradingBands(input.bands);

  return withTransaction(
    async (tx) => {
      const scale = await tx.gradingScale.findFirst({
        where: { id: scaleId, ...organizationFilter(ctx) },
        select: SCALE_FIELDS,
      });
      if (!scale) throw new NotFoundError('Grading scale', scaleId);

      const previous = await tx.gradingScale
        .findFirst({
          where: { id: scale.id },
          select: { bands: { select: BAND_FIELDS, orderBy: { minPercentPpm: 'asc' } } },
        })
        .then((row) => row?.bands ?? []);

      await tx.gradingScaleBand.deleteMany({ where: { gradingScaleId: scale.id } });
      try {
        await tx.gradingScaleBand.createMany({
          data: toBandRows(input.bands).map((band) => ({ ...band, gradingScaleId: scale.id })),
        });
      } catch (error) {
        translateScaleWriteError(error, scale.name);
      }

      await recordAudit(
        ctx,
        {
          action: 'grading_scale.bands_changed',
          entityType: 'GradingScale',
          entityId: scale.id,
          summary: `Bands of "${scale.name}" replaced with ${input.bands.length} band(s)`,
          severity: 'NOTICE',
          changes: {
            bands: {
              from: previous.map((band) => ({
                label: band.label,
                minPercentPpm: band.minPercentPpm,
                maxPercentPpm: band.maxPercentPpm,
              })),
              to: input.bands.map((band) => ({
                label: band.label,
                minPercentPpm: band.minPercentPpm,
                maxPercentPpm: band.maxPercentPpm,
              })),
            },
          },
        },
        tx,
      );

      return loadDetail(ctx, tx, scale);
    },
    { existing: db },
  );
}

/**
 * Retire a scale.
 *
 * Deactivation, not deletion: exams and results reference it, and `GradingScale` has
 * no soft-delete column because a scale is never meant to leave the record. The
 * default cannot be retired, and a scale still attached to a live exam is refused
 * with the count, because the alternative is an exam that cannot be graded.
 */
export async function deactivateGradingScale(
  ctx: AccessContext,
  scaleId: string,
  input: { readonly reason?: string | null } = {},
  db?: Db,
): Promise<GradingScaleSummary> {
  requirePermission(ctx, 'grades.manageScales');

  return withTransaction(
    async (tx) => {
      const scale = await tx.gradingScale.findFirst({
        where: { id: scaleId, ...organizationFilter(ctx) },
        select: SCALE_FIELDS,
      });
      if (!scale) throw new NotFoundError('Grading scale', scaleId);
      if (!scale.isActive) return scale;

      if (scale.isDefault) {
        throw new BusinessRuleError(
          'grading_scale.default_must_stay_active',
          `"${scale.name}" is the organisation's default scale. Make another scale the default first.`,
        );
      }

      const liveExams = await tx.exam.count({
        where: {
          gradingScaleId: scale.id,
          organizationId: ctx.organizationId,
          deletedAt: null,
          // Only exams that still have to be graded block a retirement; a graded,
          // published or cancelled exam has already taken its snapshot of the bands.
          status: { in: ['DRAFT', 'SCHEDULED', 'IN_PROGRESS'] },
        },
      });
      if (liveExams > 0) {
        throw new BusinessRuleError(
          'grading_scale.still_in_use',
          `"${scale.name}" is still attached to ${liveExams} exam(s) that have not finished. Move them to another scale first.`,
          { details: { liveExams } },
        );
      }

      const updated = await tx.gradingScale.update({
        where: { id: scale.id },
        data: { isActive: false },
        select: SCALE_FIELDS,
      });

      await recordAudit(
        ctx,
        {
          action: 'grading_scale.deactivated',
          entityType: 'GradingScale',
          entityId: scale.id,
          summary: `Grading scale "${scale.name}" retired`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

export interface ListGradingScalesInput extends PageInput {
  readonly q?: string;
  readonly kind?: GradingScaleKind;
  readonly isActive?: boolean;
}

export async function listGradingScales(
  ctx: AccessContext,
  input: ListGradingScalesInput = {},
  db?: Db,
): Promise<Paginated<GradingScaleDetail>> {
  requirePermission(ctx, 'grades.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);

  const where: Prisma.GradingScaleWhereInput = {
    ...organizationFilter(ctx),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.q ? { name: { contains: input.q, mode: 'insensitive' } } : {}),
  };

  const [rows, total] = await Promise.all([
    client.gradingScale.findMany({
      where,
      // The default first: it is the one an operator is looking for.
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      skip,
      take,
      select: {
        ...SCALE_FIELDS,
        bands: { select: BAND_FIELDS, orderBy: { minPercentPpm: 'asc' } },
        _count: { select: { exams: true } },
      },
    }),
    client.gradingScale.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      isDefault: row.isDefault,
      isActive: row.isActive,
      bands: row.bands,
      examCount: row._count.exams,
    })),
    page,
    pageSize,
    total,
  };
}

export async function getGradingScale(
  ctx: AccessContext,
  scaleId: string,
  db?: Db,
): Promise<GradingScaleDetail> {
  requirePermission(ctx, 'grades.view');
  const client = db ?? prisma;

  const scale = await client.gradingScale.findFirst({
    where: { id: scaleId, ...organizationFilter(ctx) },
    select: SCALE_FIELDS,
  });
  if (!scale) throw new NotFoundError('Grading scale', scaleId);

  return loadDetail(ctx, client, scale);
}

/**
 * The organisation's default scale, or `null` when none has been chosen.
 *
 * Null rather than a fabricated fallback: an institution that has not configured its
 * grading is a state the UI must show honestly, not one to paper over with an invented
 * A–F scale.
 */
export async function getDefaultGradingScale(
  ctx: AccessContext,
  db?: Db,
): Promise<GradingScaleDetail | null> {
  requirePermission(ctx, 'grades.view');
  const client = db ?? prisma;

  const scale = await client.gradingScale.findFirst({
    where: { ...organizationFilter(ctx), isDefault: true, isActive: true },
    select: SCALE_FIELDS,
  });
  if (!scale) return null;

  return loadDetail(ctx, client, scale);
}

/** Bands and exam count for one already-scoped scale. */
async function loadDetail(
  ctx: AccessContext,
  client: Db,
  scale: GradingScaleSummary,
): Promise<GradingScaleDetail> {
  const [bands, examCount] = await Promise.all([
    client.gradingScaleBand.findMany({
      where: { gradingScaleId: scale.id },
      orderBy: { minPercentPpm: 'asc' },
      select: BAND_FIELDS,
    }),
    client.exam.count({
      where: { gradingScaleId: scale.id, organizationId: ctx.organizationId },
    }),
  ]);

  return { ...scale, bands, examCount };
}
