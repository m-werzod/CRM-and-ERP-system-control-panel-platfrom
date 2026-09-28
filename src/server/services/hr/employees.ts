/**
 * Employee records: hiring, editing, termination and the HR directory.
 *
 * A staff member is ONE `User` plus ONE `Employee`, and optionally a `Teacher`
 * profile — see prisma/schema/03-people.prisma. `createEmployee` therefore creates
 * the login and the HR record in the SAME transaction: a half-created staff member
 * (a user who cannot be found in the directory, or an employee nobody can sign in
 * as) is not a state worth being able to reach.
 *
 * SALARY VISIBILITY. Every read here omits the salary block unless the caller holds
 * `employees.viewSalary`, and says so with `salaryRedacted: true`. Refusing the
 * whole record instead would make the HR directory unusable for the receptionist
 * who legitimately needs a phone number, and hiding the fact that something was
 * withheld would leave them thinking the salary is simply unset.
 *
 * TERMINATION is more than a status change. It deactivates the login, revokes every
 * live session (an ex-employee with an open laptop keeps their access otherwise) and
 * closes any open teaching assignment, because a terminated teacher must not remain
 * the current teacher of a class.
 */

import type {
  EmploymentStatus,
  EmploymentType,
  Locale,
  Prisma,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  DuplicateError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  diffFields,
  record as recordAudit,
} from '@/server/audit';
import {
  assertBranchAccess,
  assertCanAdministerUser,
  assertCanGrantRole,
  can,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { generateTemporaryPassword, hashPassword } from '@/server/auth/password';
import { revokeAllUserSessions } from '@/server/auth/session';
import { nextEmployeeCode } from '@/server/services/finance/numbering';
import { dateOnlyToPrismaDate, todayIn, type DateOnly } from '@/lib/dates';
import {
  employeeDisplayName,
  employeeSearchFilter,
  isUniqueViolation,
  loadScopedEmployee,
  toPage,
  type PageInput,
  type Paginated,
  type SortDirection,
} from '@/server/services/hr/shared';

/** Employment states in which the person has left. */
const ENDED_EMPLOYMENT: readonly EmploymentStatus[] = ['TERMINATED', 'RESIGNED'];

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateEmployeeTeacherInput {
  readonly specialization?: string | null;
  readonly qualification?: string | null;
  readonly bio?: string | null;
  readonly maxWeeklyHours?: number;
}

export interface CreateEmployeeInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone?: string | null;
  readonly locale?: Locale | null;
  readonly branchId?: string | null;
  readonly position: string;
  readonly departmentId?: string | null;
  readonly employmentType?: EmploymentType;
  /** ACTIVE or PROBATION. A new hire cannot start already terminated. */
  readonly status?: EmploymentStatus;
  readonly hireDate?: DateOnly;
  readonly probationEndDate?: DateOnly | null;
  /** Role key to grant, e.g. `TEACHER`. Must be below the caller's own level. */
  readonly roleKey: string;
  /** Present for a teaching hire; creates the `Teacher` profile too. */
  readonly teacher?: CreateEmployeeTeacherInput | null;
  readonly bankAccountLast4?: string | null;
}

export interface CreateEmployeeResult {
  readonly id: string;
  readonly employeeCode: string;
  readonly userId: string;
  readonly teacherId: string | null;
  readonly email: string;
  readonly branchId: string;
  /**
   * ONE-TIME SECRET. The generated password, returned only here and never stored
   * in plaintext, never audited and never logged. The caller must show it to the
   * administrator once — on screen, to be dictated or handed over — and must not
   * persist it, email it or put it in a URL. The account carries
   * `mustChangePassword`, so it stops working as soon as the new hire signs in.
   */
  readonly temporaryPassword: string;
}

/**
 * Hire someone: create the login, the employee record, the optional teacher profile
 * and the role grant, in one transaction.
 *
 * Two permissions rather than one, deliberately: this both adds an HR record and
 * mints a credential that can sign in, and those are different powers. The role
 * grant is guarded by `assertCanGrantRole` (level, not a permission) because
 * granting the role IS the act of hiring — there is no useful staff account with no
 * role — while self-escalation still has to be impossible.
 */
export async function createEmployee(
  ctx: AccessContext,
  input: CreateEmployeeInput,
  db?: Db,
): Promise<CreateEmployeeResult> {
  requirePermission(ctx, 'employees.create');
  requirePermission(ctx, 'users.create');

  if (input.status && ENDED_EMPLOYMENT.includes(input.status)) {
    throw new BusinessRuleError(
      'employee.hired_as_terminated',
      'A new employee cannot be created with an ended employment status.',
    );
  }

  // Argon2id is deliberately slow and memory-hard, so it runs BEFORE the
  // transaction opens rather than holding a database transaction for ~20 ms of KDF.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  return withTransaction(
    async (tx) => {
      const branchId = resolveWriteBranch(ctx, input.branchId, 'employee');

      const role = await tx.role.findFirst({
        where: { organizationId: ctx.organizationId, key: input.roleKey, deletedAt: null },
        select: { id: true, key: true, level: true },
      });
      if (!role) throw new NotFoundError('Role', input.roleKey);
      assertCanGrantRole(ctx, role);

      if (input.departmentId) {
        const department = await tx.department.findFirst({
          where: {
            id: input.departmentId,
            organizationId: ctx.organizationId,
            deletedAt: null,
            // A department pinned to another branch would put the employee in an
            // org chart they do not belong to.
            OR: [{ branchId: null }, { branchId }],
          },
          select: { id: true },
        });
        if (!department) throw new NotFoundError('Department', input.departmentId);
      }

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId },
        tx,
      );
      const hireDate = input.hireDate ?? todayIn(timezone);

      if (input.probationEndDate && input.probationEndDate < hireDate) {
        throw new BusinessRuleError(
          'employee.probation_before_hire',
          'The probation end date cannot be before the hire date.',
        );
      }

      const employeeCode = await nextEmployeeCode(tx, ctx.organizationId);

      let user: { id: string; email: string };
      try {
        user = await tx.user.create({
          data: {
            organizationId: ctx.organizationId,
            email: input.email.trim().toLowerCase(),
            passwordHash,
            // The account is usable for exactly one sign-in, which must change the
            // password; see src/server/auth/context.ts, which admits INVITED.
            mustChangePassword: true,
            status: 'INVITED',
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone ?? null,
            locale: input.locale ?? null,
          },
          select: { id: true, email: true },
        });
      } catch (error) {
        if (isUniqueViolation(error, 'email')) {
          throw new DuplicateError(
            'user account',
            ['email'],
            'Someone in this organisation already uses that email address.',
          );
        }
        throw error;
      }

      const employee = await tx.employee.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          userId: user.id,
          employeeCode,
          position: input.position,
          departmentId: input.departmentId ?? null,
          employmentType: input.employmentType ?? 'FULL_TIME',
          status: input.status ?? 'ACTIVE',
          hireDate: dateOnlyToPrismaDate(hireDate),
          probationEndDate: input.probationEndDate
            ? dateOnlyToPrismaDate(input.probationEndDate)
            : null,
          bankAccountLast4: input.bankAccountLast4 ?? null,
          // Pay is NOT set here. It is a dated SalaryComponent row, so that an old
          // payroll run stays reproducible; see ./salary.ts.
          ...(input.teacher
            ? {
                teacher: {
                  create: {
                    specialization: input.teacher.specialization ?? null,
                    qualification: input.teacher.qualification ?? null,
                    bio: input.teacher.bio ?? null,
                    ...(input.teacher.maxWeeklyHours !== undefined
                      ? { maxWeeklyHours: input.teacher.maxWeeklyHours }
                      : {}),
                  },
                },
              }
            : {}),
        },
        select: { id: true, employeeCode: true, teacher: { select: { id: true } } },
      });

      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          // Pinned to the branch the person was hired into, so a BRANCH-scoped role
          // reaches exactly that branch.
          branchId,
          grantedById: ctx.isSystem ? null : ctx.userId,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EMPLOYEE_CREATED,
          entityType: 'Employee',
          entityId: employee.id,
          branchId,
          summary: `${input.firstName} ${input.lastName} hired as ${input.position} (${employee.employeeCode})`,
          // The temporary password is deliberately absent: an audit row is read by
          // more people than a credential should be.
          metadata: {
            userId: user.id,
            roleKey: role.key,
            employmentType: input.employmentType ?? 'FULL_TIME',
            hireDate,
          },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: employee.id,
            type: 'employee.hired',
            title: `Hired as ${input.position}`,
          },
        },
        tx,
      );

      return {
        id: employee.id,
        employeeCode: employee.employeeCode,
        userId: user.id,
        teacherId: employee.teacher?.id ?? null,
        email: user.email,
        branchId,
        temporaryPassword,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateEmployeeInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
  readonly locale?: Locale | null;
  readonly position?: string;
  readonly departmentId?: string | null;
  readonly employmentType?: EmploymentType;
  /** ACTIVE, PROBATION, ON_LEAVE or SUSPENDED. Ending employment is a separate use-case. */
  readonly status?: EmploymentStatus;
  readonly probationEndDate?: DateOnly | null;
  readonly bankAccountLast4?: string | null;
}

/**
 * Edit an employee's details.
 *
 * Deliberately cannot end employment: `terminateEmployee` also revokes sessions and
 * releases classes, and a status field that quietly skipped all of that would leave
 * an ex-employee logged in.
 */
export async function updateEmployee(
  ctx: AccessContext,
  employeeId: string,
  input: UpdateEmployeeInput,
  db?: Db,
): Promise<{ id: string; employeeCode: string }> {
  requirePermission(ctx, 'employees.edit');

  if (input.status && ENDED_EMPLOYMENT.includes(input.status)) {
    throw new BusinessRuleError(
      'employee.termination_via_update',
      'Use the termination action to end employment: it also deactivates the login and releases classes.',
    );
  }

  return withTransaction(
    async (tx) => {
      const employee = await loadScopedEmployee(ctx, tx, employeeId);
      await assertMayAdministerEmployee(ctx, tx, employee.userId);

      if (input.departmentId) {
        const department = await tx.department.findFirst({
          where: {
            id: input.departmentId,
            organizationId: ctx.organizationId,
            deletedAt: null,
            OR: [{ branchId: null }, { branchId: employee.branchId }],
          },
          select: { id: true },
        });
        if (!department) throw new NotFoundError('Department', input.departmentId);
      }

      const probationEndDate =
        input.probationEndDate === undefined
          ? undefined
          : input.probationEndDate === null
            ? null
            : dateOnlyToPrismaDate(input.probationEndDate);

      if (probationEndDate && probationEndDate < employee.hireDate) {
        throw new BusinessRuleError(
          'employee.probation_before_hire',
          'The probation end date cannot be before the hire date.',
        );
      }

      const employeeData: Prisma.EmployeeUpdateInput = {};
      if (input.position !== undefined) employeeData.position = input.position;
      if (input.departmentId !== undefined) {
        employeeData.department = input.departmentId
          ? { connect: { id: input.departmentId } }
          : { disconnect: true };
      }
      if (input.employmentType !== undefined) employeeData.employmentType = input.employmentType;
      if (input.status !== undefined) employeeData.status = input.status;
      if (probationEndDate !== undefined) employeeData.probationEndDate = probationEndDate;
      if (input.bankAccountLast4 !== undefined) {
        employeeData.bankAccountLast4 = input.bankAccountLast4;
      }

      const userData: Prisma.UserUpdateInput = {};
      if (input.firstName !== undefined) userData.firstName = input.firstName;
      if (input.lastName !== undefined) userData.lastName = input.lastName;
      if (input.phone !== undefined) userData.phone = input.phone;
      if (input.locale !== undefined) userData.locale = input.locale;

      if (Object.keys(employeeData).length > 0) {
        await tx.employee.update({ where: { id: employee.id }, data: employeeData });
      }
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: employee.userId }, data: userData });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EMPLOYEE_UPDATED,
          entityType: 'Employee',
          entityId: employee.id,
          branchId: employee.branchId,
          summary: `${employeeDisplayName(employee)} (${employee.employeeCode}) updated`,
          changes: diffFields(
            {
              position: employee.position,
              status: employee.status,
              firstName: employee.user.firstName,
              lastName: employee.user.lastName,
            },
            {
              position: input.position,
              status: input.status,
              firstName: input.firstName,
              lastName: input.lastName,
            },
          ),
        },
        tx,
      );

      return { id: employee.id, employeeCode: employee.employeeCode };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Terminate
// ---------------------------------------------------------------------------

export interface TerminateEmployeeInput {
  readonly employeeId: string;
  /** Defaults to today in the branch timezone. */
  readonly terminationDate?: DateOnly;
  readonly reason: string;
  /** TERMINATED (dismissed) or RESIGNED. Both end employment. */
  readonly status?: Extract<EmploymentStatus, 'TERMINATED' | 'RESIGNED'>;
}

export interface TerminateEmployeeResult {
  readonly id: string;
  readonly status: EmploymentStatus;
  readonly terminationDate: Date;
  readonly sessionsRevoked: number;
  readonly assignmentsClosed: number;
}

/**
 * End someone's employment.
 *
 * All of it in one transaction, because each half-done version is a live problem:
 * a deactivated user who is still the primary teacher of four groups, or a released
 * teacher whose session is still valid.
 *
 * `Group.primaryTeacherId` / `assistantTeacherId` are the denormalised cache of the
 * open `GroupTeacher` rows, normally written only by the academics assignment
 * use-cases. Termination is the one other writer: closing the assignment rows while
 * leaving the cache pointing at the departed teacher would leave them named as the
 * current teacher on every timetable and group list — the exact inconsistency the
 * cache rule exists to prevent. Reassigning the class is a separate, deliberate act
 * for whoever runs academics; this only vacates the seat.
 */
export async function terminateEmployee(
  ctx: AccessContext,
  input: TerminateEmployeeInput,
  db?: Db,
): Promise<TerminateEmployeeResult> {
  requirePermission(ctx, 'employees.terminate');

  if (!input.reason.trim()) {
    throw new BusinessRuleError(
      'employee.termination_without_reason',
      'A termination must record a reason.',
    );
  }

  return withTransaction(
    async (tx) => {
      const employee = await loadScopedEmployee(ctx, tx, input.employeeId);
      await assertMayAdministerEmployee(ctx, tx, employee.userId);

      if (employee.terminationDate || ENDED_EMPLOYMENT.includes(employee.status as EmploymentStatus)) {
        throw new StateInvalidError('employee', employee.status.toLowerCase(), 'terminated');
      }

      const { timezone } = await getSettings(
        ['timezone'],
        { organizationId: ctx.organizationId, branchId: employee.branchId },
        tx,
      );
      const terminationDateOnly = input.terminationDate ?? todayIn(timezone);
      const terminationDate = dateOnlyToPrismaDate(terminationDateOnly);

      if (terminationDate < employee.hireDate) {
        throw new BusinessRuleError(
          'employee.termination_before_hire',
          'The termination date cannot be before the hire date.',
        );
      }

      const status: EmploymentStatus = input.status ?? 'TERMINATED';

      await tx.employee.update({
        where: { id: employee.id },
        data: { status, terminationDate, terminationReason: input.reason },
      });

      await tx.user.update({
        where: { id: employee.userId },
        data: { status: 'INACTIVE' },
      });

      const sessionsRevoked = await revokeAllUserSessions(
        employee.userId,
        `employment ended: ${status.toLowerCase()}`,
        {},
        tx,
      );

      let assignmentsClosed = 0;
      if (employee.teacher) {
        const teacherId = employee.teacher.id;
        const closed = await tx.groupTeacher.updateMany({
          where: { teacherId, endDate: null },
          data: { endDate: terminationDate, endReason: `Employment ended: ${input.reason}` },
        });
        assignmentsClosed = closed.count;

        // Vacate the denormalised pointers, scoped to this teacher so a group whose
        // cache has already moved on is left alone.
        await tx.group.updateMany({
          where: { organizationId: ctx.organizationId, primaryTeacherId: teacherId },
          data: { primaryTeacherId: null },
        });
        await tx.group.updateMany({
          where: { organizationId: ctx.organizationId, assistantTeacherId: teacherId },
          data: { assistantTeacherId: null },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EMPLOYEE_TERMINATED,
          entityType: 'Employee',
          entityId: employee.id,
          branchId: employee.branchId,
          summary: `${employeeDisplayName(employee)} (${employee.employeeCode}) ${status.toLowerCase()}`,
          reason: input.reason,
          severity: 'WARNING',
          metadata: {
            terminationDate: terminationDateOnly,
            status,
            sessionsRevoked,
            assignmentsClosed,
          },
          timeline: {
            subjectType: 'EMPLOYEE',
            subjectId: employee.id,
            type: 'employee.terminated',
            title: `Employment ended (${status.toLowerCase()})`,
            description: input.reason,
          },
        },
        tx,
      );

      return { id: employee.id, status, terminationDate, sessionsRevoked, assignmentsClosed };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The pay figures on the HR profile. Present only with `employees.viewSalary`. */
export interface EmployeeSalaryBlock {
  readonly baseSalaryMinor: string | null;
  readonly currency: string | null;
  readonly period: string;
  readonly bankAccountLast4: string | null;
}

export interface EmployeeListRow {
  readonly id: string;
  readonly employeeCode: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly position: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly employmentType: EmploymentType;
  readonly status: EmploymentStatus;
  readonly hireDate: Date;
  readonly terminationDate: Date | null;
  readonly isTeacher: boolean;
  readonly roleKeys: readonly string[];
  readonly salary: EmployeeSalaryBlock | null;
  /** True when a salary block exists but the caller may not see it. */
  readonly salaryRedacted: boolean;
}

export interface ListEmployeesInput extends PageInput {
  readonly q?: string;
  readonly branchId?: string;
  readonly departmentId?: string;
  readonly status?: EmploymentStatus | readonly EmploymentStatus[];
  readonly roleKey?: string;
  readonly position?: string;
  readonly isTeacher?: boolean;
  /** Include people who have left. Off by default. */
  readonly includeEnded?: boolean;
  readonly includeArchived?: boolean;
  readonly sortBy?: 'name' | 'employeeCode' | 'position' | 'hireDate';
  readonly sortDir?: SortDirection;
}

export async function listEmployees(
  ctx: AccessContext,
  input: ListEmployeesInput = {},
  db?: Db,
): Promise<Paginated<EmployeeListRow>> {
  requirePermission(ctx, 'employees.view');
  const client = db ?? prisma;
  const { page, pageSize, skip, take } = toPage(input);
  const maySeeSalary = can(ctx, 'employees.viewSalary');

  // Verified BEFORE it is merged into the predicate: spreading a requested branch
  // over `scopeFilter`'s own `branchId` would otherwise widen the caller's scope.
  if (input.branchId) assertBranchAccess(ctx, input.branchId, 'employee');

  const statuses = input.status
    ? Array.isArray(input.status)
      ? [...input.status]
      : [input.status]
    : undefined;

  const where: Prisma.EmployeeWhereInput = {
    ...scopeFilter(ctx),
    ...(input.includeArchived ? {} : { deletedAt: null }),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(!statuses && !input.includeEnded ? { status: { notIn: [...ENDED_EMPLOYMENT] } } : {}),
    ...(input.position ? { position: { contains: input.position, mode: 'insensitive' } } : {}),
    ...(input.isTeacher === true ? { teacher: { isNot: null } } : {}),
    ...(input.isTeacher === false ? { teacher: { is: null } } : {}),
    ...(input.roleKey
      ? { user: { userRoles: { some: { role: { key: input.roleKey, deletedAt: null } } } } }
      : {}),
    ...(input.q ? employeeSearchFilter(input.q) : {}),
  };

  const sortBy = input.sortBy ?? 'name';
  const sortDir = input.sortDir ?? 'asc';
  const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
    sortBy === 'name'
      ? [{ user: { lastName: sortDir } }, { user: { firstName: sortDir } }]
      : sortBy === 'employeeCode'
        ? [{ employeeCode: sortDir }]
        : sortBy === 'position'
          ? [{ position: sortDir }, { user: { lastName: 'asc' } }]
          : [{ hireDate: sortDir }];

  const [rows, total] = await Promise.all([
    client.employee.findMany({
      where,
      orderBy,
      skip,
      take,
      select: {
        id: true,
        employeeCode: true,
        position: true,
        branchId: true,
        departmentId: true,
        employmentType: true,
        status: true,
        hireDate: true,
        terminationDate: true,
        baseSalaryMinor: true,
        salaryCurrency: true,
        salaryPeriod: true,
        bankAccountLast4: true,
        branch: { select: { name: true } },
        department: { select: { name: true } },
        teacher: { select: { id: true } },
        user: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            userRoles: { select: { role: { select: { key: true, deletedAt: true } } } },
          },
        },
      },
    }),
    client.employee.count({ where }),
  ]);

  return {
    items: rows.map((row) => toListRow(row, maySeeSalary)),
    page,
    pageSize,
    total,
  };
}

/** The select above, as the shape `toListRow` consumes. */
interface EmployeeRowShape {
  readonly id: string;
  readonly employeeCode: string;
  readonly position: string;
  readonly branchId: string;
  readonly departmentId: string | null;
  readonly employmentType: EmploymentType;
  readonly status: EmploymentStatus;
  readonly hireDate: Date;
  readonly terminationDate: Date | null;
  readonly baseSalaryMinor: bigint | null;
  readonly salaryCurrency: string | null;
  readonly salaryPeriod: string;
  readonly bankAccountLast4: string | null;
  readonly branch: { readonly name: string };
  readonly department: { readonly name: string } | null;
  readonly teacher: { readonly id: string } | null;
  readonly user: {
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly phone: string | null;
    readonly userRoles: ReadonlyArray<{ readonly role: { readonly key: string; readonly deletedAt: Date | null } }>;
  };
}

function toListRow(row: EmployeeRowShape, maySeeSalary: boolean): EmployeeListRow {
  const hasSalary = row.baseSalaryMinor !== null || row.bankAccountLast4 !== null;
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    email: row.user.email,
    phone: row.user.phone,
    position: row.position,
    branchId: row.branchId,
    branchName: row.branch.name,
    departmentId: row.departmentId,
    departmentName: row.department?.name ?? null,
    employmentType: row.employmentType,
    status: row.status,
    hireDate: row.hireDate,
    terminationDate: row.terminationDate,
    isTeacher: row.teacher !== null,
    roleKeys: row.user.userRoles
      .filter((assignment) => !assignment.role.deletedAt)
      .map((assignment) => assignment.role.key),
    salary: maySeeSalary
      ? {
          // Minor units leave the service as strings: BigInt does not survive
          // JSON.stringify, and the HTTP layer must not have to remember that.
          baseSalaryMinor: row.baseSalaryMinor?.toString() ?? null,
          currency: row.salaryCurrency,
          period: row.salaryPeriod,
          bankAccountLast4: row.bankAccountLast4,
        }
      : null,
    salaryRedacted: !maySeeSalary && hasSalary,
  };
}

export interface EmployeeDetail extends EmployeeListRow {
  readonly userId: string;
  readonly userStatus: string;
  readonly mustChangePassword: boolean;
  readonly probationEndDate: Date | null;
  readonly terminationReason: string | null;
  readonly teacherId: string | null;
  readonly teacherProfile: {
    readonly specialization: string | null;
    readonly qualification: string | null;
    readonly bio: string | null;
    readonly maxWeeklyHours: number;
  } | null;
  readonly openLeaveRequests: number;
}

export async function getEmployee(
  ctx: AccessContext,
  employeeId: string,
  db?: Db,
): Promise<EmployeeDetail> {
  requirePermission(ctx, 'employees.view');
  const client = db ?? prisma;
  const maySeeSalary = can(ctx, 'employees.viewSalary');

  // Scope in the same `where` as the id: fetching first and checking after would
  // distinguish "no such employee" from "not in your branch".
  const row = await client.employee.findFirst({
    where: { id: employeeId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      employeeCode: true,
      position: true,
      branchId: true,
      departmentId: true,
      employmentType: true,
      status: true,
      hireDate: true,
      probationEndDate: true,
      terminationDate: true,
      terminationReason: true,
      baseSalaryMinor: true,
      salaryCurrency: true,
      salaryPeriod: true,
      bankAccountLast4: true,
      userId: true,
      branch: { select: { name: true } },
      department: { select: { name: true } },
      teacher: {
        select: {
          id: true,
          specialization: true,
          qualification: true,
          bio: true,
          maxWeeklyHours: true,
        },
      },
      user: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          status: true,
          mustChangePassword: true,
          userRoles: { select: { role: { select: { key: true, deletedAt: true } } } },
        },
      },
      _count: { select: { leaveRequests: { where: { status: 'PENDING' } } } },
    },
  });
  if (!row) throw new NotFoundError('Employee', employeeId);

  return {
    ...toListRow(row, maySeeSalary),
    userId: row.userId,
    userStatus: row.user.status,
    mustChangePassword: row.user.mustChangePassword,
    probationEndDate: row.probationEndDate,
    terminationReason: row.terminationReason,
    teacherId: row.teacher?.id ?? null,
    teacherProfile: row.teacher
      ? {
          specialization: row.teacher.specialization,
          qualification: row.teacher.qualification,
          bio: row.teacher.bio,
          maxWeeklyHours: row.teacher.maxWeeklyHours,
        }
      : null,
    openLeaveRequests: row._count.leaveRequests,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Refuse to edit or terminate someone at or above the caller's own privilege
 * level. Without this, anyone holding `employees.edit` could rename, suspend or
 * dismiss the director — and `employees.terminate` would be a way to revoke a
 * superior's sessions.
 */
async function assertMayAdministerEmployee(
  ctx: AccessContext,
  tx: Tx,
  userId: string,
): Promise<void> {
  if (ctx.isSystem) return;
  const grants = await tx.userRole.findMany({
    where: { userId, role: { deletedAt: null } },
    select: { role: { select: { level: true } } },
  });
  const highestRoleLevel = grants.reduce((max, grant) => Math.max(max, grant.role.level), 0);
  assertCanAdministerUser(ctx, { id: userId, highestRoleLevel });
}
