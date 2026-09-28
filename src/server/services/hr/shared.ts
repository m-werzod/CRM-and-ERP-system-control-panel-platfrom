/**
 * Internal helpers shared by the HR use-cases. Not re-exported from `index.ts`.
 *
 * Three things live here rather than being repeated in five files:
 *
 *   * SCOPE THROUGH A RELATION. `LeaveRequest` carries `organizationId` but no
 *     `branchId`, and `SalaryComponent` carries neither -- both are reached only
 *     via an `Employee`. A branch-scoped caller must therefore be narrowed through
 *     that relation, and every read in this domain composes one of the filters
 *     below rather than inventing its own predicate.
 *
 *   * WORKING DAYS. Leave entitlement, the payroll period divisor and the
 *     ON_LEAVE attendance rows must all count the same days, or an employee is
 *     charged five days of holiday for a week that payroll treats as six.
 *
 *   * The translation of a unique-index violation into a sentence an operator can
 *     act on. HR leans on `(employeeId, workDate)` and
 *     `(organizationId, branchId, periodStart, periodEnd)`; `mapDatabaseError`
 *     would report both as "a record with the same value already exists".
 */

import type { EmploymentStatus, Prisma } from '@/generated/prisma/client';
import { NotFoundError } from '@/server/errors';
import { scopeFilter, type AccessContext } from '@/server/rbac/access';
import {
  addDaysToDateOnly,
  datesMatchingWeekdays,
  prismaDateToDateOnly,
  type DateOnly,
  type TimeZone,
  type WeekdayName,
} from '@/lib/dates';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';
import type { Db } from '@/server/db/client';

// ---------------------------------------------------------------------------
// Constraint translation
// ---------------------------------------------------------------------------

interface DatabaseErrorShape {
  readonly code?: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * The index or column list the database named, lower-cased. Prisma reports
 * `meta.target` as a field array for a model-level `@@unique` and as the index
 * name for one created in raw SQL, so both shapes are flattened to a searchable
 * string.
 */
export function constraintTarget(error: unknown): string {
  const target = (error as DatabaseErrorShape | null)?.meta?.['target'];
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.toLowerCase();
}

/**
 * True for a unique violation, whichever layer reported it: P2002 from Prisma,
 * SQLSTATE 23505 when the driver adapter surfaces it raw. `constraintHint`
 * narrows the match to one index, so a use-case that can provoke two different
 * violations can tell them apart.
 */
export function isUniqueViolation(error: unknown, constraintHint?: string): boolean {
  const code = (error as DatabaseErrorShape | null)?.code;
  if (code !== 'P2002' && code !== '23505') return false;
  if (!constraintHint) return true;
  return constraintTarget(error).includes(constraintHint.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PageInput {
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * A page of rows plus the figures a client needs to render a pager. The
 * `pageMeta`/`toSkipTake` helpers in `@/server/http/api` do the same arithmetic,
 * but importing them here would pull `next/server` into every service and into
 * the unit tests; the HTTP layer wraps this with `pageMeta(page, pageSize, total)`.
 */
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export function toPage(input: PageInput): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  // Capped with the same constant the request schemas use, so a caller reaching a
  // service directly (a job, another service) cannot ask for ten thousand rows.
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export type SortDirection = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** An employee's name lives one relation away: Employee -> User. */
export const EMPLOYEE_NAME_SELECT = {
  user: { select: { firstName: true, lastName: true } },
} as const;

export interface EmployeeNameRow {
  readonly user: { readonly firstName: string; readonly lastName: string };
}

export function employeeDisplayName(employee: EmployeeNameRow): string {
  return `${employee.user.firstName} ${employee.user.lastName}`;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Branch narrowing for a model that reaches its branch only through `employee`.
 * Empty for an ORGANIZATION-scoped caller, so the predicate stays as small as the
 * caller's authority allows.
 */
export function employeeBranchScope(
  ctx: AccessContext,
): { employee: { branchId: { in: string[] } } } | Record<string, never> {
  if (ctx.scope === 'ORGANIZATION') return {};
  return { employee: { branchId: { in: [...ctx.branchIds] } } };
}

/**
 * The SELF narrowing for HR: a teacher or other staff member sees their own leave
 * and their own attendance, nobody else's. A SELF-scoped user with no employee
 * link matches nothing rather than everything -- the same fail-closed choice
 * `selfStudentFilter` makes.
 */
export function selfEmployeeFilter(ctx: AccessContext): Record<string, unknown> {
  const employeeId = ctx.self.employeeId;
  if (!employeeId) return { employeeId: { in: [] as string[] } };
  return { employeeId };
}

/** What every write path needs to know about the employee it is about to touch. */
export interface ScopedEmployee {
  readonly id: string;
  readonly employeeCode: string;
  readonly branchId: string;
  readonly position: string;
  readonly status: EmploymentStatus;
  readonly terminationDate: Date | null;
  readonly hireDate: Date;
  readonly salaryCurrency: string | null;
  readonly userId: string;
  readonly user: { readonly firstName: string; readonly lastName: string };
  readonly teacher: { readonly id: string } | null;
}

/**
 * Load an employee for a write, with the caller's scope in the SAME `where`.
 *
 * Fetching by id and then checking the branch would answer "that employee exists
 * but is not yours", which leaks the existence of staff in other branches;
 * employee ids appear in URLs, so the distinction is worth nothing and costs
 * information.
 */
export async function loadScopedEmployee(
  ctx: AccessContext,
  db: Db,
  employeeId: string,
): Promise<ScopedEmployee> {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      employeeCode: true,
      branchId: true,
      position: true,
      status: true,
      terminationDate: true,
      hireDate: true,
      salaryCurrency: true,
      userId: true,
      user: { select: { firstName: true, lastName: true } },
      teacher: { select: { id: true } },
    },
  });
  if (!employee) throw new NotFoundError('Employee', employeeId);
  return employee;
}

// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

/** The `academic.workingDays` setting, as the value type `getSettings` returns. */
export type WorkingDays = readonly WeekdayName[];

/**
 * The working dates inside an inclusive calendar range.
 *
 * Non-working days are excluded here rather than subtracted afterwards, so a
 * leave request that spans a weekend, the ON_LEAVE attendance rows written when it
 * is approved, and the payroll period divisor all agree by construction.
 */
export function workingDatesBetween(
  from: DateOnly,
  to: DateOnly,
  workingDays: WorkingDays,
  zone: TimeZone,
): DateOnly[] {
  if (to < from) return [];
  return datesMatchingWeekdays(from, to, workingDays, zone);
}

export function countWorkingDays(
  from: DateOnly,
  to: DateOnly,
  workingDays: WorkingDays,
  zone: TimeZone,
): number {
  return workingDatesBetween(from, to, workingDays, zone).length;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface MonthBounds {
  readonly month: string;
  readonly firstDay: DateOnly;
  readonly lastDay: DateOnly;
}

/**
 * First and last calendar day of a `YYYY-MM` month. The last day is derived by
 * stepping back one day from the first of the following month, which is correct
 * for February in a leap year without a table of month lengths.
 */
export function monthBounds(month: string): MonthBounds {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new RangeError(`Not a calendar month: ${month}`);
  const [, year, monthNumber] = match;
  const firstDay: DateOnly = `${year}-${monthNumber}-01`;
  const nextMonth = Number(monthNumber) === 12 ? `${Number(year) + 1}-01-01` : `${year}-${String(Number(monthNumber) + 1).padStart(2, '0')}-01`;
  return { month, firstDay, lastDay: addDaysToDateOnly(nextMonth, -1) };
}

/** The `YYYY-MM` a calendar date belongs to. */
export function monthOf(date: DateOnly): string {
  return date.slice(0, 7);
}

/** Inclusive calendar-day bounds of a year, for annual leave entitlement. */
export function yearBounds(year: number): { firstDay: DateOnly; lastDay: DateOnly } {
  return { firstDay: `${year}-01-01`, lastDay: `${year}-12-31` };
}

/** A `@db.Date` column value as a calendar date string. */
export function dateOnlyOf(value: Date): DateOnly {
  return prismaDateToDateOnly(value);
}

// ---------------------------------------------------------------------------
// Free-text search
// ---------------------------------------------------------------------------

/**
 * The employee free-text predicate, shared by the employee list and the payroll
 * and attendance screens that filter by person. Matched in SQL, never in JS.
 */
export function employeeSearchFilter(term: string): Prisma.EmployeeWhereInput {
  return {
    OR: [
      { employeeCode: { contains: term, mode: 'insensitive' } },
      { position: { contains: term, mode: 'insensitive' } },
      { user: { firstName: { contains: term, mode: 'insensitive' } } },
      { user: { lastName: { contains: term, mode: 'insensitive' } } },
      { user: { email: { contains: term, mode: 'insensitive' } } },
    ],
  };
}
