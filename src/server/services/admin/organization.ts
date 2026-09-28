/**
 * The organisational structure: the tenant itself, its branches, its
 * departments, and the academic calendar every dated record hangs off.
 *
 * Two families of invariant live here, enforced in different places on purpose:
 *
 *   ARCHIVING is guarded in application code, because the guard has to be able
 *   to say WHY. "This branch still has 42 active students and 7 unpaid
 *   invoices" is actionable; a foreign-key error is not. Archiving is a soft
 *   delete throughout — a branch with history can never be removed, only closed.
 *
 *   ONE CURRENT year per organisation and ONE CURRENT term per year are enforced
 *   by partial unique indexes (`academic_years_one_current_per_org`,
 *   `terms_one_current_per_year`). An application-level check-then-write cannot
 *   survive two concurrent requests, so the database is the authority and this
 *   file's job is to clear the previous flag in the same transaction and to
 *   translate the violation if it still fires.
 *
 * TERM OVERLAP, by contrast, is a pure application rule: no index can express
 * "these two date ranges must not intersect", and overlapping terms would make
 * "which term is this lesson in" ambiguous for every grade and exam.
 */

import type { Locale, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '@/server/errors';
import { diffFields, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import {
  addDaysToDateOnly,
  assertTimeZone,
  dateOnlyToPrismaDate,
  intervalsOverlap,
  prismaDateToDateOnly,
  type DateOnly,
} from '@/lib/dates';
import { assertCurrency } from '@/lib/money';
import { isUniqueViolation } from '@/server/services/admin/shared';

/**
 * Audit actions for this domain. `AUDIT_ACTIONS` has no organisation/branch keys
 * — the catalogue there covers the operational domains — so they are spelled out
 * once here rather than inline at each call site, which is what keeps the audit
 * log filterable.
 */
const ORG_AUDIT = {
  ORGANIZATION_UPDATED: 'organization.updated',
  BRANCH_CREATED: 'branch.created',
  BRANCH_UPDATED: 'branch.updated',
  BRANCH_ARCHIVED: 'branch.archived',
  DEPARTMENT_CREATED: 'department.created',
  DEPARTMENT_UPDATED: 'department.updated',
  DEPARTMENT_ARCHIVED: 'department.archived',
  ACADEMIC_YEAR_CREATED: 'academic_year.created',
  ACADEMIC_YEAR_UPDATED: 'academic_year.updated',
  ACADEMIC_YEAR_CURRENT_SET: 'academic_year.current_set',
  ACADEMIC_YEAR_CLOSED: 'academic_year.closed',
  TERM_CREATED: 'term.created',
  TERM_UPDATED: 'term.updated',
  TERM_CURRENT_SET: 'term.current_set',
} as const;

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

export interface OrganizationProfile {
  readonly id: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly slug: string;
  readonly status: string;
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly defaultLocale: Locale;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly logoUrl: string | null;
  readonly taxId: string | null;
}

const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  legalName: true,
  slug: true,
  status: true,
  defaultCurrency: true,
  timezone: true,
  defaultLocale: true,
  email: true,
  phone: true,
  website: true,
  addressLine: true,
  city: true,
  country: true,
  logoUrl: true,
  taxId: true,
} as const satisfies Prisma.OrganizationSelect;

export async function getOrganization(
  ctx: AccessContext,
  db?: Db,
): Promise<OrganizationProfile> {
  requirePermission(ctx, 'settings.view');

  const client = db ?? prisma;
  const row = await client.organization.findFirst({
    where: { id: ctx.organizationId, deletedAt: null },
    select: ORGANIZATION_SELECT,
  });
  if (!row) throw new NotFoundError('Organization', ctx.organizationId);
  return row;
}

/**
 * Mutable twin of `UpdateOrganizationInput`. The public input type is readonly,
 * so the patch assembled here is what BOTH the UPDATE and the audit diff are
 * computed from — the two can never end up describing different values.
 */
interface OrganizationPatch {
  name?: string;
  legalName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine?: string | null;
  city?: string | null;
  country?: string | null;
  logoUrl?: string | null;
  taxId?: string | null;
  timezone?: string;
  defaultLocale?: Locale;
  defaultCurrency?: string;
}

export type UpdateOrganizationInput = Partial<{
  readonly name: string;
  readonly legalName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly website: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly logoUrl: string | null;
  readonly taxId: string | null;
  readonly timezone: string;
  readonly defaultLocale: Locale;
  readonly defaultCurrency: string;
}>;

export async function updateOrganization(
  ctx: AccessContext,
  input: UpdateOrganizationInput,
  db?: Db,
): Promise<OrganizationProfile> {
  requirePermission(ctx, 'settings.manageOrganization');

  return withTransaction(
    async (tx) => {
      const before = await tx.organization.findFirst({
        where: { id: ctx.organizationId, deletedAt: null },
        select: ORGANIZATION_SELECT,
      });
      if (!before) throw new NotFoundError('Organization', ctx.organizationId);

      const next: OrganizationPatch = { ...input };
      if (input.timezone !== undefined) next.timezone = assertValidTimezone(input.timezone);
      if (input.defaultCurrency !== undefined) {
        const currency = assertCurrency(input.defaultCurrency);
        await assertCurrencyChangeIsSafe(tx, ctx, before.defaultCurrency, currency);
        next.defaultCurrency = currency;
      }

      const updated = await tx.organization.update({
        where: { id: ctx.organizationId },
        data: next,
        select: ORGANIZATION_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.ORGANIZATION_UPDATED,
          entityType: 'Organization',
          entityId: ctx.organizationId,
          summary: `Organisation settings updated`,
          changes: diffFields({ ...before }, next),
          severity: 'NOTICE',
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );
}

/**
 * The organisation currency is the fallback every money path resolves through
 * (see `currencyFor`). Changing it once ledger rows exist would re-denominate
 * history: the same stored minor units would start being read as a different
 * currency, and no arithmetic anywhere would notice.
 */
async function assertCurrencyChangeIsSafe(
  tx: Tx,
  ctx: AccessContext,
  from: string,
  to: string,
): Promise<void> {
  if (from === to) return;
  const ledgerRows = await tx.ledgerEntry.count({
    where: { organizationId: ctx.organizationId },
  });
  if (ledgerRows > 0) {
    throw new BusinessRuleError(
      'organization.currency_locked',
      `The organisation currency cannot be changed from ${from} to ${to}: ${ledgerRows} financial records are already denominated in ${from}. Set a per-branch currency instead.`,
      { details: { ledgerRows, from, to } },
    );
  }
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface BranchSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly city: string | null;
  readonly addressLine: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly currency: string | null;
  readonly isActive: boolean;
  readonly archivedAt: Date | null;
  readonly activeStudentCount: number;
}

const BRANCH_SELECT = {
  id: true,
  name: true,
  code: true,
  city: true,
  addressLine: true,
  phone: true,
  email: true,
  timezone: true,
  currency: true,
  isActive: true,
  deletedAt: true,
} as const satisfies Prisma.BranchSelect;

export interface ListBranchesInput {
  readonly includeArchived?: boolean;
  readonly includeInactive?: boolean;
}

export async function listBranches(
  ctx: AccessContext,
  input: ListBranchesInput = {},
  db?: Db,
): Promise<readonly BranchSummary[]> {
  requirePermission(ctx, 'settings.view');

  const client = db ?? prisma;
  // `scopeFilter` keys on `branchId`, which a Branch row does not have; its own
  // id is the branch, so the predicate is written out.
  const where: Prisma.BranchWhereInput = {
    organizationId: ctx.organizationId,
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.includeInactive ? {} : { isActive: true }),
    ...(ctx.scope === 'ORGANIZATION' ? {} : { id: { in: [...ctx.branchIds] } }),
  };

  const rows = await client.branch.findMany({
    where,
    orderBy: [{ name: 'asc' }],
    select: {
      ...BRANCH_SELECT,
      // One filtered relation count per row, in the same query: counting active
      // students per branch with a second round trip each would be an N+1 on the
      // branch list, which every settings screen loads.
      _count: { select: { students: { where: { status: 'ACTIVE', deletedAt: null } } } },
    },
  });

  return rows.map((row) => toBranchSummary(row, row._count.students));
}

export async function getBranch(
  ctx: AccessContext,
  branchId: string,
  db?: Db,
): Promise<BranchSummary> {
  requirePermission(ctx, 'settings.view');
  assertBranchAccess(ctx, branchId, 'branch');

  const client = db ?? prisma;
  const row = await client.branch.findFirst({
    where: { id: branchId, organizationId: ctx.organizationId },
    select: {
      ...BRANCH_SELECT,
      _count: { select: { students: { where: { status: 'ACTIVE', deletedAt: null } } } },
    },
  });
  if (!row) throw new NotFoundError('Branch', branchId);
  return toBranchSummary(row, row._count.students);
}

function toBranchSummary(
  row: {
    id: string;
    name: string;
    code: string;
    city: string | null;
    addressLine: string | null;
    phone: string | null;
    email: string | null;
    timezone: string | null;
    currency: string | null;
    isActive: boolean;
    deletedAt: Date | null;
  },
  activeStudentCount: number,
): BranchSummary {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    city: row.city,
    addressLine: row.addressLine,
    phone: row.phone,
    email: row.email,
    timezone: row.timezone,
    currency: row.currency,
    isActive: row.isActive,
    archivedAt: row.deletedAt,
    activeStudentCount,
  };
}

export interface CreateBranchInput {
  readonly name: string;
  readonly code: string;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  /** Only when the branch sits in a different zone from the organisation. */
  readonly timezone?: string | null;
  /** Only when the branch trades in a different currency. */
  readonly currency?: string | null;
}

export async function createBranch(
  ctx: AccessContext,
  input: CreateBranchInput,
  db?: Db,
): Promise<BranchSummary> {
  requirePermission(ctx, 'settings.manageBranches');

  const timezone = input.timezone ? assertValidTimezone(input.timezone) : null;
  const currency = input.currency ? assertCurrency(input.currency) : null;

  return withTransaction(
    async (tx) => {
      const created = await tx.branch
        .create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name.trim(),
            code: input.code.trim().toUpperCase(),
            addressLine: input.addressLine ?? null,
            city: input.city ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            timezone,
            currency,
          },
          select: BRANCH_SELECT,
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new DuplicateError('branch', ['code']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.BRANCH_CREATED,
          entityType: 'Branch',
          entityId: created.id,
          branchId: created.id,
          summary: `Branch ${created.name} (${created.code}) created`,
          severity: 'NOTICE',
        },
        tx,
      );

      return toBranchSummary(created, 0);
    },
    { existing: db },
  );
}

export type UpdateBranchInput = Partial<CreateBranchInput> & { readonly isActive?: boolean };

interface BranchPatch {
  name?: string;
  code?: string;
  addressLine?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  timezone?: string | null;
  currency?: string | null;
  isActive?: boolean;
}

export async function updateBranch(
  ctx: AccessContext,
  branchId: string,
  input: UpdateBranchInput,
  db?: Db,
): Promise<BranchSummary> {
  requirePermission(ctx, 'settings.manageBranches');
  assertBranchAccess(ctx, branchId, 'branch');

  return withTransaction(
    async (tx) => {
      const before = await tx.branch.findFirst({
        where: { id: branchId, organizationId: ctx.organizationId, deletedAt: null },
        select: BRANCH_SELECT,
      });
      if (!before) throw new NotFoundError('Branch', branchId);

      const next: BranchPatch = {};
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.code !== undefined) next.code = input.code.trim().toUpperCase();
      if (input.addressLine !== undefined) next.addressLine = input.addressLine ?? null;
      if (input.city !== undefined) next.city = input.city ?? null;
      if (input.phone !== undefined) next.phone = input.phone ?? null;
      if (input.email !== undefined) next.email = input.email ?? null;
      if (input.timezone !== undefined) {
        next.timezone = input.timezone ? assertValidTimezone(input.timezone) : null;
      }
      if (input.currency !== undefined) {
        next.currency = input.currency ? assertCurrency(input.currency) : null;
      }
      if (input.isActive !== undefined) next.isActive = input.isActive;

      const updated = await tx.branch
        .update({
          where: { id: branchId },
          data: next,
          select: {
            ...BRANCH_SELECT,
            _count: { select: { students: { where: { status: 'ACTIVE', deletedAt: null } } } },
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new DuplicateError('branch', ['code']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.BRANCH_UPDATED,
          entityType: 'Branch',
          entityId: branchId,
          branchId,
          summary: `Branch ${updated.name} updated`,
          changes: diffFields({ ...before }, next),
          severity: 'NOTICE',
        },
        tx,
      );

      return toBranchSummary(updated, updated._count.students);
    },
    { existing: db },
  );
}

export interface ArchiveBranchInput {
  readonly reason: string;
}

/**
 * Close a branch.
 *
 * Refuses while the branch still has active students or unpaid invoices, and
 * says how many of each. Archiving underneath live operations would hide those
 * students from every scoped list — including the debt report that is the only
 * reason anyone would notice the money was still outstanding.
 */
export async function archiveBranch(
  ctx: AccessContext,
  branchId: string,
  input: ArchiveBranchInput,
  db?: Db,
): Promise<{ id: string; archivedAt: Date }> {
  requirePermission(ctx, 'settings.manageBranches');
  assertBranchAccess(ctx, branchId, 'branch');

  return withTransaction(
    async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, name: true, code: true },
      });
      if (!branch) throw new NotFoundError('Branch', branchId);

      const [activeStudents, openInvoices] = await Promise.all([
        tx.student.count({ where: { branchId, status: 'ACTIVE', deletedAt: null } }),
        tx.invoice.count({
          where: {
            branchId,
            balanceMinor: { gt: 0 },
            status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
          },
        }),
      ]);

      if (activeStudents > 0 || openInvoices > 0) {
        throw new BusinessRuleError(
          'branch.not_empty',
          `${branch.name} still has ${activeStudents} active student(s) and ${openInvoices} unpaid invoice(s). Transfer or withdraw the students and settle or write off the invoices first.`,
          { details: { activeStudents, openInvoices } },
        );
      }

      const archivedAt = new Date();
      await tx.branch.update({
        where: { id: branchId },
        data: { deletedAt: archivedAt, isActive: false },
      });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.BRANCH_ARCHIVED,
          entityType: 'Branch',
          entityId: branchId,
          branchId,
          summary: `Branch ${branch.name} (${branch.code}) archived`,
          reason: input.reason,
          severity: 'WARNING',
        },
        tx,
      );

      return { id: branchId, archivedAt };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export interface DepartmentSummary {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly description: string | null;
  readonly branchId: string | null;
  readonly isActive: boolean;
  readonly employeeCount: number;
}

export interface CreateDepartmentInput {
  readonly name: string;
  readonly code: string;
  readonly description?: string | null;
  /** Null for a department that spans the whole organisation. */
  readonly branchId?: string | null;
}

/**
 * There is no `settings.manageDepartments` permission in the catalogue, so
 * departments are administered under `settings.manageOrganization` — the closest
 * existing key, and the one an operator who maintains the org chart already
 * holds. Inventing a key here would mean a permission nothing seeds and nobody
 * can be granted.
 */
export async function listDepartments(
  ctx: AccessContext,
  input: { readonly includeInactive?: boolean; readonly branchId?: string | null } = {},
  db?: Db,
): Promise<readonly DepartmentSummary[]> {
  requirePermission(ctx, 'settings.view');

  const client = db ?? prisma;
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'department');

  const rows = await client.department.findMany({
    where: {
      ...organizationFilter(ctx),
      deletedAt: null,
      ...(input.includeInactive ? {} : { isActive: true }),
      ...(input.branchId ? { branchId: input.branchId } : {}),
    },
    orderBy: [{ name: 'asc' }],
    select: {
      id: true,
      name: true,
      code: true,
      description: true,
      branchId: true,
      isActive: true,
      _count: { select: { employees: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    branchId: row.branchId,
    isActive: row.isActive,
    employeeCount: row._count.employees,
  }));
}

export async function createDepartment(
  ctx: AccessContext,
  input: CreateDepartmentInput,
  db?: Db,
): Promise<DepartmentSummary> {
  requirePermission(ctx, 'settings.manageOrganization');

  const branchId = input.branchId ?? null;
  if (branchId) assertBranchAccess(ctx, branchId, 'department');

  return withTransaction(
    async (tx) => {
      const created = await tx.department
        .create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            name: input.name.trim(),
            code: input.code.trim().toUpperCase(),
            description: input.description ?? null,
          },
          select: { id: true, name: true, code: true, description: true, branchId: true, isActive: true },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new DuplicateError('department', ['code']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.DEPARTMENT_CREATED,
          entityType: 'Department',
          entityId: created.id,
          branchId,
          summary: `Department ${created.name} (${created.code}) created`,
        },
        tx,
      );

      return { ...created, employeeCount: 0 };
    },
    { existing: db },
  );
}

interface DepartmentPatch {
  name?: string;
  code?: string;
  description?: string | null;
  branchId?: string | null;
  isActive?: boolean;
}

export async function updateDepartment(
  ctx: AccessContext,
  departmentId: string,
  input: Partial<CreateDepartmentInput> & { readonly isActive?: boolean },
  db?: Db,
): Promise<DepartmentSummary> {
  requirePermission(ctx, 'settings.manageOrganization');

  return withTransaction(
    async (tx) => {
      const before = await tx.department.findFirst({
        where: { id: departmentId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, name: true, code: true, description: true, branchId: true, isActive: true },
      });
      if (!before) throw new NotFoundError('Department', departmentId);

      const next: DepartmentPatch = {};
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.code !== undefined) next.code = input.code.trim().toUpperCase();
      if (input.description !== undefined) next.description = input.description ?? null;
      if (input.isActive !== undefined) next.isActive = input.isActive;
      if (input.branchId !== undefined) {
        if (input.branchId) assertBranchAccess(ctx, input.branchId, 'department');
        next.branchId = input.branchId ?? null;
      }

      const updated = await tx.department
        .update({
          where: { id: departmentId },
          data: next,
          select: {
            id: true,
            name: true,
            code: true,
            description: true,
            branchId: true,
            isActive: true,
            _count: { select: { employees: true } },
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new DuplicateError('department', ['code']);
          throw error;
        });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.DEPARTMENT_UPDATED,
          entityType: 'Department',
          entityId: departmentId,
          branchId: updated.branchId,
          summary: `Department ${updated.name} updated`,
          changes: diffFields({ ...before }, next),
        },
        tx,
      );

      const { _count, ...department } = updated;
      return { ...department, employeeCount: _count.employees };
    },
    { existing: db },
  );
}

export async function archiveDepartment(
  ctx: AccessContext,
  departmentId: string,
  input: { readonly reason: string },
  db?: Db,
): Promise<{ id: string; archivedAt: Date }> {
  requirePermission(ctx, 'settings.manageOrganization');

  return withTransaction(
    async (tx) => {
      const department = await tx.department.findFirst({
        where: { id: departmentId, ...organizationFilter(ctx), deletedAt: null },
        select: { id: true, name: true, branchId: true, _count: { select: { employees: true } } },
      });
      if (!department) throw new NotFoundError('Department', departmentId);

      if (department._count.employees > 0) {
        throw new BusinessRuleError(
          'department.not_empty',
          `${department.name} still has ${department._count.employees} employee(s) assigned. Move them to another department first.`,
          { details: { employees: department._count.employees } },
        );
      }

      const archivedAt = new Date();
      await tx.department.update({
        where: { id: departmentId },
        data: { deletedAt: archivedAt, isActive: false },
      });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.DEPARTMENT_ARCHIVED,
          entityType: 'Department',
          entityId: departmentId,
          branchId: department.branchId,
          summary: `Department ${department.name} archived`,
          reason: input.reason,
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: departmentId, archivedAt };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Academic years and terms
// ---------------------------------------------------------------------------

export interface TermSummary {
  readonly id: string;
  readonly academicYearId: string;
  readonly name: string;
  readonly sequence: number;
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
  readonly isCurrent: boolean;
}

export interface AcademicYearSummary {
  readonly id: string;
  readonly name: string;
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
  readonly isCurrent: boolean;
  readonly isClosed: boolean;
  readonly terms: readonly TermSummary[];
}

export async function listAcademicYears(
  ctx: AccessContext,
  db?: Db,
): Promise<readonly AcademicYearSummary[]> {
  requirePermission(ctx, 'settings.view');

  const client = db ?? prisma;
  const rows = await client.academicYear.findMany({
    where: organizationFilter(ctx),
    orderBy: [{ startDate: 'desc' }],
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      isClosed: true,
      // Included, not fetched per year: the settings screen renders every term
      // of every year at once.
      terms: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          sequence: true,
          startDate: true,
          endDate: true,
          isCurrent: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    startDate: prismaDateToDateOnly(row.startDate),
    endDate: prismaDateToDateOnly(row.endDate),
    isCurrent: row.isCurrent,
    isClosed: row.isClosed,
    terms: row.terms.map(toTermSummary),
  }));
}

function toTermSummary(row: {
  id: string;
  academicYearId: string;
  name: string;
  sequence: number;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}): TermSummary {
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    name: row.name,
    sequence: row.sequence,
    startDate: prismaDateToDateOnly(row.startDate),
    endDate: prismaDateToDateOnly(row.endDate),
    isCurrent: row.isCurrent,
  };
}

export interface CreateAcademicYearInput {
  readonly name: string;
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
  readonly isCurrent?: boolean;
}

export async function createAcademicYear(
  ctx: AccessContext,
  input: CreateAcademicYearInput,
  db?: Db,
): Promise<AcademicYearSummary> {
  requirePermission(ctx, 'settings.manageAcademicYear');
  assertRange(input.startDate, input.endDate);

  return withTransaction(
    async (tx) => {
      if (input.isCurrent) await clearCurrentYear(tx, ctx.organizationId);

      const created = await tx.academicYear
        .create({
          data: {
            organizationId: ctx.organizationId,
            name: input.name.trim(),
            startDate: dateOnlyToPrismaDate(input.startDate),
            endDate: dateOnlyToPrismaDate(input.endDate),
            isCurrent: input.isCurrent ?? false,
          },
          select: { id: true, name: true },
        })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.ACADEMIC_YEAR_CREATED,
          entityType: 'AcademicYear',
          entityId: created.id,
          summary: `Academic year ${created.name} created`,
        },
        tx,
      );

      return readAcademicYear(ctx, tx, created.id);
    },
    { existing: db },
  );
}

export type UpdateAcademicYearInput = Partial<Omit<CreateAcademicYearInput, 'isCurrent'>>;

interface AcademicYearPatch {
  name?: string;
  startDate?: Date;
  endDate?: Date;
}

export async function updateAcademicYear(
  ctx: AccessContext,
  academicYearId: string,
  input: UpdateAcademicYearInput,
  db?: Db,
): Promise<AcademicYearSummary> {
  requirePermission(ctx, 'settings.manageAcademicYear');

  return withTransaction(
    async (tx) => {
      const before = await tx.academicYear.findFirst({
        where: { id: academicYearId, ...organizationFilter(ctx) },
        select: { id: true, name: true, startDate: true, endDate: true, isClosed: true },
      });
      if (!before) throw new NotFoundError('Academic year', academicYearId);
      if (before.isClosed) {
        throw new BusinessRuleError(
          'academic_year.closed',
          'A closed academic year cannot be edited. Its grades and invoices are attached to these dates.',
        );
      }

      const startDate = input.startDate ?? prismaDateToDateOnly(before.startDate);
      const endDate = input.endDate ?? prismaDateToDateOnly(before.endDate);
      assertRange(startDate, endDate);

      const next: AcademicYearPatch = {};
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.startDate !== undefined) next.startDate = dateOnlyToPrismaDate(startDate);
      if (input.endDate !== undefined) next.endDate = dateOnlyToPrismaDate(endDate);

      await tx.academicYear
        .update({ where: { id: academicYearId }, data: next })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.ACADEMIC_YEAR_UPDATED,
          entityType: 'AcademicYear',
          entityId: academicYearId,
          summary: `Academic year ${before.name} updated`,
          changes: diffFields({ ...before }, next),
        },
        tx,
      );

      return readAcademicYear(ctx, tx, academicYearId);
    },
    { existing: db },
  );
}

/**
 * Make one year current.
 *
 * The previous flag is cleared in the same transaction, then the new one set:
 * the partial unique index would reject the intermediate state where two rows
 * claim to be current, which is exactly the protection we want if two operators
 * do this at once.
 */
export async function setCurrentAcademicYear(
  ctx: AccessContext,
  academicYearId: string,
  db?: Db,
): Promise<{ id: string }> {
  requirePermission(ctx, 'settings.manageAcademicYear');

  return withTransaction(
    async (tx) => {
      const year = await tx.academicYear.findFirst({
        where: { id: academicYearId, ...organizationFilter(ctx) },
        select: { id: true, name: true, isClosed: true },
      });
      if (!year) throw new NotFoundError('Academic year', academicYearId);
      if (year.isClosed) {
        throw new BusinessRuleError(
          'academic_year.closed',
          'A closed academic year cannot be made current.',
        );
      }

      await clearCurrentYear(tx, ctx.organizationId);
      await tx.academicYear
        .update({ where: { id: academicYearId }, data: { isCurrent: true } })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.ACADEMIC_YEAR_CURRENT_SET,
          entityType: 'AcademicYear',
          entityId: academicYearId,
          summary: `Academic year ${year.name} is now current`,
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: academicYearId };
    },
    { existing: db },
  );
}

export async function closeAcademicYear(
  ctx: AccessContext,
  academicYearId: string,
  db?: Db,
): Promise<{ id: string }> {
  requirePermission(ctx, 'settings.manageAcademicYear');

  return withTransaction(
    async (tx) => {
      const year = await tx.academicYear.findFirst({
        where: { id: academicYearId, ...organizationFilter(ctx) },
        select: { id: true, name: true, isCurrent: true, isClosed: true },
      });
      if (!year) throw new NotFoundError('Academic year', academicYearId);
      if (year.isClosed) {
        throw new BusinessRuleError('academic_year.already_closed', 'This year is already closed.');
      }
      if (year.isCurrent) {
        throw new BusinessRuleError(
          'academic_year.close_current',
          'Make another year current before closing this one.',
        );
      }

      await tx.academicYear.update({ where: { id: academicYearId }, data: { isClosed: true } });

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.ACADEMIC_YEAR_CLOSED,
          entityType: 'AcademicYear',
          entityId: academicYearId,
          summary: `Academic year ${year.name} closed`,
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: academicYearId };
    },
    { existing: db },
  );
}

export interface CreateTermInput {
  readonly academicYearId: string;
  readonly name: string;
  readonly sequence: number;
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
  readonly isCurrent?: boolean;
}

export async function createTerm(
  ctx: AccessContext,
  input: CreateTermInput,
  db?: Db,
): Promise<TermSummary> {
  requirePermission(ctx, 'settings.manageAcademicYear');
  assertRange(input.startDate, input.endDate);

  return withTransaction(
    async (tx) => {
      const year = await loadYearForTermWrite(ctx, tx, input.academicYearId);
      assertWithinYear(year, input.startDate, input.endDate);
      await assertNoTermOverlap(tx, input.academicYearId, input.startDate, input.endDate, null);

      if (input.isCurrent) await clearCurrentTerm(tx, input.academicYearId);

      const created = await tx.term
        .create({
          data: {
            academicYearId: input.academicYearId,
            name: input.name.trim(),
            sequence: input.sequence,
            startDate: dateOnlyToPrismaDate(input.startDate),
            endDate: dateOnlyToPrismaDate(input.endDate),
            isCurrent: input.isCurrent ?? false,
          },
          select: {
            id: true,
            academicYearId: true,
            name: true,
            sequence: true,
            startDate: true,
            endDate: true,
            isCurrent: true,
          },
        })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.TERM_CREATED,
          entityType: 'Term',
          entityId: created.id,
          summary: `Term ${created.name} created in ${year.name}`,
        },
        tx,
      );

      return toTermSummary(created);
    },
    { existing: db },
  );
}

export type UpdateTermInput = Partial<Omit<CreateTermInput, 'academicYearId' | 'isCurrent'>>;

interface TermPatch {
  name?: string;
  sequence?: number;
  startDate?: Date;
  endDate?: Date;
}

export async function updateTerm(
  ctx: AccessContext,
  termId: string,
  input: UpdateTermInput,
  db?: Db,
): Promise<TermSummary> {
  requirePermission(ctx, 'settings.manageAcademicYear');

  return withTransaction(
    async (tx) => {
      const before = await tx.term.findFirst({
        where: { id: termId, academicYear: organizationFilter(ctx) },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          sequence: true,
          startDate: true,
          endDate: true,
          isCurrent: true,
        },
      });
      if (!before) throw new NotFoundError('Term', termId);

      const year = await loadYearForTermWrite(ctx, tx, before.academicYearId);
      const startDate = input.startDate ?? prismaDateToDateOnly(before.startDate);
      const endDate = input.endDate ?? prismaDateToDateOnly(before.endDate);
      assertRange(startDate, endDate);
      assertWithinYear(year, startDate, endDate);
      await assertNoTermOverlap(tx, before.academicYearId, startDate, endDate, termId);

      const next: TermPatch = {};
      if (input.name !== undefined) next.name = input.name.trim();
      if (input.sequence !== undefined) next.sequence = input.sequence;
      if (input.startDate !== undefined) next.startDate = dateOnlyToPrismaDate(startDate);
      if (input.endDate !== undefined) next.endDate = dateOnlyToPrismaDate(endDate);

      const updated = await tx.term
        .update({
          where: { id: termId },
          data: next,
          select: {
            id: true,
            academicYearId: true,
            name: true,
            sequence: true,
            startDate: true,
            endDate: true,
            isCurrent: true,
          },
        })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.TERM_UPDATED,
          entityType: 'Term',
          entityId: termId,
          summary: `Term ${updated.name} updated`,
          changes: diffFields({ ...before }, next),
        },
        tx,
      );

      return toTermSummary(updated);
    },
    { existing: db },
  );
}

export async function setCurrentTerm(
  ctx: AccessContext,
  termId: string,
  db?: Db,
): Promise<{ id: string }> {
  requirePermission(ctx, 'settings.manageAcademicYear');

  return withTransaction(
    async (tx) => {
      const term = await tx.term.findFirst({
        where: { id: termId, academicYear: organizationFilter(ctx) },
        select: { id: true, name: true, academicYearId: true },
      });
      if (!term) throw new NotFoundError('Term', termId);

      await clearCurrentTerm(tx, term.academicYearId);
      await tx.term
        .update({ where: { id: termId }, data: { isCurrent: true } })
        .catch(translateCalendarViolation);

      await recordAudit(
        ctx,
        {
          action: ORG_AUDIT.TERM_CURRENT_SET,
          entityType: 'Term',
          entityId: termId,
          summary: `Term ${term.name} is now current`,
          severity: 'NOTICE',
        },
        tx,
      );

      return { id: termId };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

async function readAcademicYear(
  ctx: AccessContext,
  tx: Tx,
  academicYearId: string,
): Promise<AcademicYearSummary> {
  const row = await tx.academicYear.findFirstOrThrow({
    where: { id: academicYearId, ...organizationFilter(ctx) },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isCurrent: true,
      isClosed: true,
      terms: {
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          academicYearId: true,
          name: true,
          sequence: true,
          startDate: true,
          endDate: true,
          isCurrent: true,
        },
      },
    },
  });

  return {
    id: row.id,
    name: row.name,
    startDate: prismaDateToDateOnly(row.startDate),
    endDate: prismaDateToDateOnly(row.endDate),
    isCurrent: row.isCurrent,
    isClosed: row.isClosed,
    terms: row.terms.map(toTermSummary),
  };
}

async function loadYearForTermWrite(
  ctx: AccessContext,
  tx: Tx,
  academicYearId: string,
): Promise<{ id: string; name: string; startDate: DateOnly; endDate: DateOnly }> {
  const year = await tx.academicYear.findFirst({
    where: { id: academicYearId, ...organizationFilter(ctx) },
    select: { id: true, name: true, startDate: true, endDate: true, isClosed: true },
  });
  if (!year) throw new NotFoundError('Academic year', academicYearId);
  if (year.isClosed) {
    throw new BusinessRuleError(
      'academic_year.closed',
      'The terms of a closed academic year cannot be changed.',
    );
  }
  return {
    id: year.id,
    name: year.name,
    startDate: prismaDateToDateOnly(year.startDate),
    endDate: prismaDateToDateOnly(year.endDate),
  };
}

function assertRange(startDate: DateOnly, endDate: DateOnly): void {
  // Lexicographic comparison is exact for `YYYY-MM-DD`, which is why the format
  // is used throughout instead of a Date.
  if (endDate < startDate) {
    throw new ValidationError([
      { path: 'endDate', message: 'The end date cannot be before the start date' },
    ]);
  }
}

function assertWithinYear(
  year: { name: string; startDate: DateOnly; endDate: DateOnly },
  startDate: DateOnly,
  endDate: DateOnly,
): void {
  if (startDate < year.startDate || endDate > year.endDate) {
    throw new BusinessRuleError(
      'term.outside_year',
      `A term must fall inside ${year.name} (${year.startDate} to ${year.endDate}).`,
      { details: { yearStart: year.startDate, yearEnd: year.endDate } },
    );
  }
}

/**
 * Terms within one year must not overlap: a lesson on an overlapping day would
 * belong to two terms, and every grade and exam keyed to a term would become
 * ambiguous.
 *
 * `intervalsOverlap` compares HALF-OPEN intervals, so each inclusive end date is
 * advanced by one day before the comparison — otherwise two terms that merely
 * touch (one ending on the 31st, the next starting on the 1st) would be reported
 * as a conflict, and two that share a single day would not.
 */
async function assertNoTermOverlap(
  tx: Tx,
  academicYearId: string,
  startDate: DateOnly,
  endDate: DateOnly,
  excludeTermId: string | null,
): Promise<void> {
  const siblings = await tx.term.findMany({
    where: {
      academicYearId,
      ...(excludeTermId ? { id: { not: excludeTermId } } : {}),
    },
    select: { id: true, name: true, startDate: true, endDate: true },
  });

  const start = dateOnlyToPrismaDate(startDate);
  const endExclusive = dateOnlyToPrismaDate(addDaysToDateOnly(endDate, 1));

  for (const sibling of siblings) {
    const siblingEndExclusive = dateOnlyToPrismaDate(
      addDaysToDateOnly(prismaDateToDateOnly(sibling.endDate), 1),
    );
    if (intervalsOverlap(start, endExclusive, sibling.startDate, siblingEndExclusive)) {
      throw new BusinessRuleError(
        'term.overlaps',
        `These dates overlap the term "${sibling.name}" (${prismaDateToDateOnly(sibling.startDate)} to ${prismaDateToDateOnly(sibling.endDate)}).`,
        { details: { conflictingTermId: sibling.id } },
      );
    }
  }
}

async function clearCurrentYear(tx: Tx, organizationId: string): Promise<void> {
  await tx.academicYear.updateMany({
    where: { organizationId, isCurrent: true },
    data: { isCurrent: false },
  });
}

async function clearCurrentTerm(tx: Tx, academicYearId: string): Promise<void> {
  await tx.term.updateMany({
    where: { academicYearId, isCurrent: true },
    data: { isCurrent: false },
  });
}

/**
 * Turn the calendar's unique violations into sentences. Without this the operator
 * sees "a record with the same value already exists", which does not say whether
 * they collided on the year name, the term sequence or the current-year flag.
 */
function translateCalendarViolation(error: unknown): never {
  if (isUniqueViolation(error, 'one_current_per_org')) {
    throw new ConflictError(
      'Another academic year was just made current. Reload and try again.',
      { retryAfterSeconds: 1 },
    );
  }
  if (isUniqueViolation(error, 'one_current_per_year')) {
    throw new ConflictError(
      'Another term in this year was just made current. Reload and try again.',
      { retryAfterSeconds: 1 },
    );
  }
  if (isUniqueViolation(error, 'sequence')) {
    throw new DuplicateError('term', ['sequence']);
  }
  if (isUniqueViolation(error, 'name')) {
    throw new DuplicateError('academic year', ['name']);
  }
  throw error;
}

/** `assertTimeZone` throws a RangeError; the API boundary needs an AppError. */
function assertValidTimezone(zone: string): string {
  try {
    return assertTimeZone(zone.trim());
  } catch {
    throw new ValidationError([{ path: 'timezone', message: 'Not a known IANA timezone' }]);
  }
}
