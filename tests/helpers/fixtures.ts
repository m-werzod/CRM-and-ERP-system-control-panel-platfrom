/**
 * Integration-test fixtures.
 *
 * These build real rows in the real development database, because the things worth
 * testing here — the append-only triggers, the partial unique indexes, the CHECK
 * constraints, serialisable isolation — exist only in PostgreSQL. A mocked Prisma
 * client would pass every one of these tests while the production database
 * rejected the same writes.
 *
 * CLEANUP USES TRUNCATE, NOT DELETE. `ledger_entries`, `audit_logs` and
 * `attendance_corrections` carry a BEFORE DELETE trigger that blocks row deletion;
 * `TRUNCATE` is a statement-level operation those row triggers never see, so it is
 * the only cleanup that works — and it is also far faster than cascading deletes
 * across ~100 tables.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db/client';
import { hashPassword } from '@/server/auth/password';
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  resolveTemplatePermissions,
  type RoleKey,
} from '@/server/rbac/permissions';
import { buildAccessContext } from '@/server/auth/context';
import type { AccessContext } from '@/server/rbac/access';

/** A short unique suffix so parallel-ish runs cannot collide on unique columns. */
export function uniqueSuffix(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Wipe every table. Called in `beforeEach` so each test starts from a known state
 * without depending on what ran before it.
 *
 * The table list is read from the catalogue rather than hard-coded: a new model
 * would otherwise silently leak rows between tests forever.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename not like '_prisma%'
  `;
  if (tables.length === 0) return;

  const quoted = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
  // One statement so foreign keys never transiently break. CASCADE covers the
  // dependency order for us.
  await prisma.$executeRawUnsafe(`truncate table ${quoted} restart identity cascade`);
}

/** Seed the global permission catalogue. Required before any role can be granted. */
export async function seedPermissions(): Promise<void> {
  await prisma.permission.createMany({
    data: PERMISSIONS.map((permission) => ({
      key: permission.key,
      module: permission.module,
      action: permission.action,
      description: permission.description,
      isSensitive: permission.sensitive ?? false,
    })),
    skipDuplicates: true,
  });
}

export interface OrganizationFixture {
  organizationId: string;
  branchAId: string;
  branchBId: string;
  currency: 'UZS' | 'USD';
  timezone: string;
}

export async function createOrganization(
  options: { currency?: 'UZS' | 'USD'; timezone?: string } = {},
): Promise<OrganizationFixture> {
  const suffix = uniqueSuffix();
  const currency = options.currency ?? 'USD';
  const timezone = options.timezone ?? 'Asia/Tashkent';

  const organization = await prisma.organization.create({
    data: {
      name: `Test Academy ${suffix}`,
      slug: `test-academy-${suffix}`,
      defaultCurrency: currency,
      timezone,
      defaultLocale: 'EN',
      status: 'ACTIVE',
      branches: {
        create: [
          { name: 'Central', code: `CEN-${suffix}`, isActive: true },
          { name: 'Northside', code: `NOR-${suffix}`, isActive: true },
        ],
      },
    },
    select: { id: true, branches: { select: { id: true, code: true }, orderBy: { code: 'asc' } } },
  });

  const [branchA, branchB] = organization.branches;
  if (!branchA || !branchB) throw new Error('fixture: expected two branches');

  return {
    organizationId: organization.id,
    branchAId: branchA.id,
    branchBId: branchB.id,
    currency,
    timezone,
  };
}

/** Create the roles a test needs, from the real templates. */
export async function createRoles(
  organizationId: string,
  keys: readonly RoleKey[],
): Promise<Map<RoleKey, string>> {
  const out = new Map<RoleKey, string>();

  for (const key of keys) {
    const template = ROLE_TEMPLATES.find((role) => role.key === key);
    if (!template) throw new Error(`fixture: unknown role template "${key}"`);

    const permissionKeys = resolveTemplatePermissions(template);
    const permissions = await prisma.permission.findMany({
      where: { key: { in: permissionKeys } },
      select: { id: true },
    });

    const role = await prisma.role.create({
      data: {
        organizationId,
        key: template.key,
        name: template.name,
        description: template.description,
        scope: template.scope,
        level: template.level,
        isSystem: true,
        permissions: {
          create: permissions.map((permission) => ({ permissionId: permission.id })),
        },
      },
      select: { id: true },
    });
    out.set(key, role.id);
  }

  return out;
}

export interface UserFixture {
  userId: string;
  email: string;
  password: string;
  ctx: AccessContext;
}

/**
 * Create a user with a role, optional branch grants, and a ready-to-use
 * AccessContext built by the real `buildAccessContext` — so a test exercises the
 * same permission and scope resolution the application does, rather than a
 * hand-assembled context that might be more permissive than reality.
 */
export async function createUser(
  input: {
    organizationId: string;
    role: RoleKey;
    roleIds: Map<RoleKey, string>;
    branchIds?: readonly string[];
    primaryBranchId?: string;
    /** Create an Employee (and optionally a Teacher) profile for this user. */
    asEmployee?: boolean;
    asTeacher?: boolean;
    email?: string;
  },
): Promise<UserFixture> {
  const suffix = uniqueSuffix();
  const email = input.email ?? `${input.role.toLowerCase()}.${suffix}@test.local`;
  const password = 'Test-Password-9';
  const roleId = input.roleIds.get(input.role);
  if (!roleId) throw new Error(`fixture: role "${input.role}" was not created`);

  const user = await prisma.user.create({
    data: {
      organizationId: input.organizationId,
      email,
      username: `${input.role.toLowerCase()}-${suffix}`,
      passwordHash: await hashPassword(password),
      firstName: input.role.charAt(0) + input.role.slice(1).toLowerCase().replace(/_/g, ' '),
      lastName: `Tester ${suffix}`,
      status: 'ACTIVE',
      locale: 'EN',
      userRoles: { create: [{ roleId }] },
      userBranches: {
        create: (input.branchIds ?? []).map((branchId, index) => ({
          branchId,
          isPrimary: input.primaryBranchId
            ? branchId === input.primaryBranchId
            : index === 0,
        })),
      },
    },
    select: { id: true },
  });

  if (input.asEmployee || input.asTeacher) {
    const branchId = input.primaryBranchId ?? input.branchIds?.[0];
    if (!branchId) throw new Error('fixture: an employee needs a branch');
    const employee = await prisma.employee.create({
      data: {
        organizationId: input.organizationId,
        branchId,
        userId: user.id,
        employeeCode: `EMP-${suffix}`,
        position: input.asTeacher ? 'Teacher' : 'Administrator',
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        hireDate: new Date('2025-09-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    if (input.asTeacher) {
      await prisma.teacher.create({ data: { employeeId: employee.id } });
    }
  }

  const ctx = await buildAccessContext(user.id, {
    requestId: `test-${suffix}`,
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    sessionId: null,
  });

  return { userId: user.id, email, password, ctx };
}

export interface StudentFixture {
  studentId: string;
  studentCode: string;
}

export async function createStudent(
  input: { organizationId: string; branchId: string; firstName?: string; lastName?: string },
): Promise<StudentFixture> {
  const suffix = uniqueSuffix();
  const student = await prisma.student.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      studentCode: `STU-${suffix}`,
      firstName: input.firstName ?? 'Test',
      lastName: input.lastName ?? `Student ${suffix}`,
      gender: 'UNSPECIFIED',
      status: 'ACTIVE',
      enrolledAt: new Date(),
    },
    select: { id: true, studentCode: true },
  });
  return { studentId: student.id, studentCode: student.studentCode };
}

export async function createProgram(
  input: { organizationId: string; priceMinor?: bigint; currency?: string },
): Promise<{ programId: string }> {
  const suffix = uniqueSuffix();
  const program = await prisma.program.create({
    data: {
      organizationId: input.organizationId,
      name: `General English ${suffix}`,
      code: `ENG-${suffix}`,
      level: 'INTERMEDIATE',
      durationWeeks: 12,
      lessonsPerWeek: 3,
      lessonDurationMinutes: 90,
      defaultPriceMinor: input.priceMinor ?? 50_000n,
      currency: input.currency ?? 'USD',
      isActive: true,
    },
    select: { id: true },
  });
  return { programId: program.id };
}

export async function createGroup(
  input: {
    organizationId: string;
    branchId: string;
    programId?: string;
    teacherId?: string;
    capacity?: number;
  },
): Promise<{ groupId: string }> {
  const suffix = uniqueSuffix();
  const group = await prisma.group.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      name: `Group ${suffix}`,
      code: `GRP-${suffix}`,
      programId: input.programId ?? null,
      primaryTeacherId: input.teacherId ?? null,
      capacity: input.capacity ?? 12,
      status: 'ACTIVE',
      startDate: new Date('2026-01-12T00:00:00.000Z'),
      ...(input.teacherId
        ? {
            teacherAssignments: {
              create: [
                {
                  teacherId: input.teacherId,
                  role: 'PRIMARY',
                  startDate: new Date('2026-01-12T00:00:00.000Z'),
                },
              ],
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return { groupId: group.id };
}

/** Resolve the Teacher row id for a user created with `asTeacher`. */
export async function teacherIdForUser(userId: string): Promise<string> {
  const employee = await prisma.employee.findUnique({
    where: { userId },
    select: { teacher: { select: { id: true } } },
  });
  const teacherId = employee?.teacher?.id;
  if (!teacherId) throw new Error('fixture: user has no teacher profile');
  return teacherId;
}

/**
 * A complete, minimal world: organisation, two branches, permission catalogue,
 * the roles a finance/attendance test needs, and one student in branch A.
 */
export interface WorldFixture extends OrganizationFixture {
  roleIds: Map<RoleKey, string>;
  admin: UserFixture;
  accountant: UserFixture;
  branchAdminA: UserFixture;
  teacher: UserFixture;
  teacherId: string;
  student: StudentFixture;
  programId: string;
  groupId: string;
}

export async function createWorld(
  options: { currency?: 'UZS' | 'USD' } = {},
): Promise<WorldFixture> {
  await seedPermissions();
  const org = await createOrganization({ currency: options.currency });

  const roleIds = await createRoles(org.organizationId, [
    'ADMIN',
    'ACCOUNTANT',
    'BRANCH_ADMIN',
    'TEACHER',
  ]);

  const admin = await createUser({
    organizationId: org.organizationId,
    role: 'ADMIN',
    roleIds,
    branchIds: [org.branchAId, org.branchBId],
    primaryBranchId: org.branchAId,
  });

  const accountant = await createUser({
    organizationId: org.organizationId,
    role: 'ACCOUNTANT',
    roleIds,
    branchIds: [org.branchAId],
    primaryBranchId: org.branchAId,
  });

  const branchAdminA = await createUser({
    organizationId: org.organizationId,
    role: 'BRANCH_ADMIN',
    roleIds,
    branchIds: [org.branchAId],
    primaryBranchId: org.branchAId,
  });

  const teacher = await createUser({
    organizationId: org.organizationId,
    role: 'TEACHER',
    roleIds,
    branchIds: [org.branchAId],
    primaryBranchId: org.branchAId,
    asEmployee: true,
    asTeacher: true,
  });
  const teacherId = await teacherIdForUser(teacher.userId);

  const { programId } = await createProgram({
    organizationId: org.organizationId,
    currency: org.currency,
  });
  const { groupId } = await createGroup({
    organizationId: org.organizationId,
    branchId: org.branchAId,
    programId,
    teacherId,
  });
  const student = await createStudent({
    organizationId: org.organizationId,
    branchId: org.branchAId,
  });

  return {
    ...org,
    roleIds,
    admin,
    accountant,
    branchAdminA,
    teacher,
    teacherId,
    student,
    programId,
    groupId,
  };
}

/** Sum the ledger for an invoice, for assertions that bypass the derived caches. */
export async function ledgerSumFor(invoiceId: string): Promise<
  Array<{ entryType: string; direction: string; amountMinor: bigint }>
> {
  return prisma.ledgerEntry.findMany({
    where: { invoiceId },
    select: { entryType: true, direction: true, amountMinor: true },
    orderBy: { createdAt: 'asc' },
  });
}

export { prisma };
