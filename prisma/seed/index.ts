/**
 * Development seed.
 *
 * Two deliberate choices:
 *
 * 1. BASE data (organisation, branches, permissions, roles, users, rooms, programs)
 *    is written directly with Prisma. It is reference data with no business rules to
 *    exercise, and going through services would need a bootstrap AccessContext
 *    before any user exists.
 *
 * 2. TRANSACTIONAL data (invoices, payments, enrolments, attendance) goes through
 *    the REAL use-cases. That is the point: the seed is also a smoke test. If
 *    `recordPayment` has a broken ledger invariant, `db:seed` fails loudly here
 *    rather than producing a database full of plausible-looking but inconsistent
 *    rows — which is exactly the kind of seed that hides a bug for weeks.
 *
 * Idempotent-ish: it wipes and rebuilds. It refuses to run against
 * NODE_ENV=production, and every person in it is invented (see ./data.ts).
 */

// MUST be first: it sets LOG_LEVEL before src/server/env.ts parses the environment.
import './bootstrap';
import { performance } from 'node:perf_hooks';
import { prisma } from '@/server/db/client';
import { env } from '@/server/env';
import { hashPassword } from '@/server/auth/password';
import { buildAccessContext } from '@/server/auth/context';
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  resolveTemplatePermissions,
} from '@/server/rbac/permissions';
import type { AccessContext } from '@/server/rbac/access';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '@/server/notifications/templates';
import { addDaysToDateOnly, dateOnlyToPrismaDate, todayIn } from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import { createInvoice } from '@/server/services/finance/invoices';
import { recordPayment } from '@/server/services/finance/payments';
import { enrollStudent, getGroupRoster } from '@/server/services/students/enrollment';
import { markAttendance } from '@/server/services/attendance/mark';
import {
  ANNOUNCEMENTS,
  BRANCHES,
  CALL_NOTES,
  DEV_ACCOUNTS,
  DEV_PASSWORD,
  DISCOUNTS,
  EXAM_TITLES,
  HOMEWORK_TITLES,
  LEAD_SOURCES,
  LEAVE_TYPES,
  LOST_REASONS,
  PROGRAMS,
  ROOMS_PER_BRANCH,
  SUBJECTS,
  createRandom,
  makeEmail,
  makePerson,
  makePhone,
  type Random,
} from './data';

const TIMEZONE = 'Asia/Tashkent';
const CURRENCY = 'UZS';

// Volumes from the specification's minimum seed requirements.
const COUNTS = {
  teachers: 10,
  accountants: 3,
  salesAgents: 5,
  branchAdmins: 3,
  admins: 2,
  receptionists: 3,
  students: 130,
  guardians: 40,
  groups: 18,
  leads: 45,
  lessonWeeksBack: 6,
} as const;

function step(label: string): () => void {
  const startedAt = performance.now();
  process.stdout.write(`  ${label} ... `);
  return () => {
    console.log(`${Math.round(performance.now() - startedAt)}ms`);
  };
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed a production database. This data is fabricated and would corrupt a live tenant.',
    );
  }

  console.log('\nSeeding development data\n');
  const random = createRandom();

  // -------------------------------------------------------------------------
  // Wipe. TRUNCATE rather than DELETE: the append-only triggers on
  // ledger_entries / audit_logs / attendance_corrections block row deletion, and
  // TRUNCATE is a statement-level operation those row triggers never see.
  // -------------------------------------------------------------------------
  let done = step('clearing existing data');
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like '_prisma%'
  `;
  if (tables.length > 0) {
    const quoted = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`truncate table ${quoted} restart identity cascade`);
  }
  done();

  // -------------------------------------------------------------------------
  // Permission catalogue + organisation + branches
  // -------------------------------------------------------------------------
  done = step(`seeding ${PERMISSIONS.length} permissions`);
  await prisma.permission.createMany({
    data: PERMISSIONS.map((permission) => ({
      key: permission.key,
      module: permission.module,
      action: permission.action,
      description: permission.description,
      isSensitive: permission.sensitive ?? false,
    })),
  });
  done();

  done = step('creating organisation and branches');
  const organization = await prisma.organization.create({
    data: {
      name: 'Bright Future Education Group',
      slug: 'bright-future',
      legalName: 'Bright Future Education LLC',
      status: 'ACTIVE',
      defaultCurrency: CURRENCY,
      timezone: TIMEZONE,
      defaultLocale: 'UZ',
      email: 'info@example.test',
      phone: '+998711234500',
      city: 'Tashkent',
      country: 'Uzbekistan',
      branches: { create: BRANCHES.map((branch) => ({ ...branch, isActive: true })) },
    },
    select: { id: true, branches: { select: { id: true, code: true }, orderBy: { code: 'asc' } } },
  });
  const organizationId = organization.id;
  const branchByCode = new Map(organization.branches.map((b) => [b.code, b.id]));
  const branchIds = organization.branches.map((b) => b.id);
  const chilonzorId = branchByCode.get('CHI')!;
  done();

  // The currency setting is written explicitly so the resolver's `setting` layer is
  // exercised rather than only its organisation fallback.
  await prisma.setting.create({
    data: {
      organizationId,
      key: 'finance.currency',
      scope: 'ORGANIZATION',
      value: CURRENCY,
    },
  });

  done = step('creating academic year and terms');
  const currentYear = new Date().getUTCFullYear();
  const academicYear = await prisma.academicYear.create({
    data: {
      organizationId,
      name: `${currentYear}–${currentYear + 1}`,
      startDate: new Date(Date.UTC(currentYear, 8, 1)),
      endDate: new Date(Date.UTC(currentYear + 1, 5, 30)),
      isCurrent: true,
      terms: {
        create: [
          {
            name: 'Autumn term',
            sequence: 1,
            startDate: new Date(Date.UTC(currentYear, 8, 1)),
            endDate: new Date(Date.UTC(currentYear, 11, 31)),
            isCurrent: true,
          },
          {
            name: 'Spring term',
            sequence: 2,
            startDate: new Date(Date.UTC(currentYear + 1, 0, 8)),
            endDate: new Date(Date.UTC(currentYear + 1, 4, 31)),
          },
        ],
      },
    },
    select: { id: true, terms: { select: { id: true, sequence: true } } },
  });
  const currentTermId = academicYear.terms.find((t) => t.sequence === 1)!.id;
  done();

  done = step('creating rooms');
  await prisma.room.createMany({
    data: branchIds.flatMap((branchId) =>
      ROOMS_PER_BRANCH.map((room) => ({ ...room, organizationId, branchId, isActive: true })),
    ),
  });
  done();

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------
  done = step(`creating ${ROLE_TEMPLATES.length} roles`);
  const permissionIdByKey = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
  );
  const roleIdByKey = new Map<string, string>();
  for (const template of ROLE_TEMPLATES) {
    const keys = resolveTemplatePermissions(template);
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
          create: keys
            .map((key) => permissionIdByKey.get(key))
            .filter((id): id is string => Boolean(id))
            .map((permissionId) => ({ permissionId })),
        },
      },
      select: { id: true },
    });
    roleIdByKey.set(template.key, role.id);
  }
  done();

  // -------------------------------------------------------------------------
  // Users. The password is hashed ONCE and reused: Argon2id at OWASP parameters
  // takes ~15ms, and hashing 30 identical dev passwords separately would add
  // nothing but half a second.
  // -------------------------------------------------------------------------
  done = step('creating users and employees');
  const sharedHash = await hashPassword(DEV_PASSWORD);

  interface CreateUserSpec {
    email: string;
    roleKey: string;
    firstName: string;
    lastName: string;
    gender: 'MALE' | 'FEMALE';
    branchIds: string[];
    primaryBranchId: string;
    asEmployee: boolean;
    asTeacher?: boolean;
    position: string;
  }

  const userSpecs: CreateUserSpec[] = [];

  // The documented logins, so every role can be demonstrated.
  const namedAccountBranches: Record<string, string[]> = {
    SUPER_ADMIN: branchIds,
    ADMIN: branchIds,
    BRANCH_ADMIN: [chilonzorId],
    ACCOUNTANT: [chilonzorId, branchByCode.get('YUN')!],
    HR: branchIds,
    TEACHER: [chilonzorId],
    RECEPTIONIST: [chilonzorId],
    SALES_MANAGER: branchIds,
    SALES_AGENT: [chilonzorId],
  };

  for (const account of DEV_ACCOUNTS) {
    const person = makePerson(random);
    userSpecs.push({
      email: account.email,
      roleKey: account.role,
      firstName: person.firstName,
      lastName: person.lastName,
      gender: person.gender,
      branchIds: namedAccountBranches[account.role] ?? [chilonzorId],
      primaryBranchId: namedAccountBranches[account.role]?.[0] ?? chilonzorId,
      asEmployee: true,
      asTeacher: account.role === 'TEACHER',
      position: account.role
        .split('_')
        .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
        .join(' '),
    });
  }

  // Bulk staff to reach the specification's volumes.
  const bulk: Array<{ roleKey: string; count: number; position: string; teacher?: boolean }> = [
    { roleKey: 'TEACHER', count: COUNTS.teachers - 1, position: 'Teacher', teacher: true },
    { roleKey: 'ACCOUNTANT', count: COUNTS.accountants - 1, position: 'Accountant' },
    { roleKey: 'SALES_AGENT', count: COUNTS.salesAgents - 1, position: 'Sales agent' },
    { roleKey: 'BRANCH_ADMIN', count: COUNTS.branchAdmins - 1, position: 'Branch administrator' },
    { roleKey: 'ADMIN', count: COUNTS.admins - 1, position: 'Administrator' },
    { roleKey: 'RECEPTIONIST', count: COUNTS.receptionists - 1, position: 'Receptionist' },
  ];

  let staffIndex = 0;
  for (const group of bulk) {
    for (let i = 0; i < group.count; i += 1) {
      staffIndex += 1;
      const person = makePerson(random);
      const branchId = branchIds[staffIndex % branchIds.length]!;
      userSpecs.push({
        email: makeEmail(person.firstName, person.lastName, staffIndex),
        roleKey: group.roleKey,
        firstName: person.firstName,
        lastName: person.lastName,
        gender: person.gender,
        branchIds: group.roleKey === 'ADMIN' ? branchIds : [branchId],
        primaryBranchId: branchId,
        asEmployee: true,
        asTeacher: group.teacher,
        position: group.position,
      });
    }
  }

  const teacherIds: string[] = [];
  const teacherIdsByBranch = new Map<string, string[]>();
  const userIdByEmail = new Map<string, string>();
  const salesAgentUserIds: string[] = [];
  let employeeSequence = 0;

  // `@@unique([organizationId, username])` and the local part of an email are not
  // the same thing: "admin" and "admin@example.test" both reduce to "admin". The
  // second claimant takes a suffix rather than failing the whole seed on a
  // collision nobody chose.
  const usedUsernames = new Set<string>();
  const uniqueUsername = (email: string): string => {
    const base = email.split('@')[0] ?? email;
    let candidate = base;
    let suffix = 1;
    while (usedUsernames.has(candidate)) {
      suffix += 1;
      candidate = `${base}${suffix}`;
    }
    usedUsernames.add(candidate);
    return candidate;
  };

  for (const spec of userSpecs) {
    employeeSequence += 1;
    const user = await prisma.user.create({
      data: {
        organizationId,
        email: spec.email,
        username: uniqueUsername(spec.email),
        passwordHash: sharedHash,
        firstName: spec.firstName,
        lastName: spec.lastName,
        phone: makePhone(random),
        phoneNormalized: normalizePhone(makePhone(random)),
        status: 'ACTIVE',
        locale: 'UZ',
        emailVerifiedAt: new Date(),
        // Deliberately false for seeded accounts: a forced password change on
        // first login would block every demo and E2E test.
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        userRoles: { create: [{ roleId: roleIdByKey.get(spec.roleKey)! }] },
        userBranches: {
          create: spec.branchIds.map((branchId) => ({
            branchId,
            isPrimary: branchId === spec.primaryBranchId,
          })),
        },
      },
      select: { id: true },
    });
    userIdByEmail.set(spec.email, user.id);
    if (spec.roleKey === 'SALES_AGENT' || spec.roleKey === 'SALES_MANAGER') {
      salesAgentUserIds.push(user.id);
    }

    if (spec.asEmployee) {
      const employee = await prisma.employee.create({
        data: {
          organizationId,
          branchId: spec.primaryBranchId,
          userId: user.id,
          employeeCode: `EMP-${String(employeeSequence).padStart(4, '0')}`,
          position: spec.position,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          hireDate: new Date(Date.UTC(currentYear - random.int(0, 3), random.int(0, 11), random.int(1, 28))),
          baseSalaryMinor: BigInt(random.int(400, 1_200)) * 1_000_00n,
          salaryCurrency: CURRENCY,
          salaryPeriod: 'MONTHLY',
        },
        select: { id: true },
      });

      if (spec.asTeacher) {
        const teacher = await prisma.teacher.create({
          data: {
            employeeId: employee.id,
            specialization: random.pick(SUBJECTS).name,
            qualification: random.pick(['CELTA', 'TESOL', 'BA Philology', 'MA Education', 'DELTA']),
            maxWeeklyHours: random.int(18, 30),
          },
          select: { id: true },
        });
        teacherIds.push(teacher.id);
        const list = teacherIdsByBranch.get(spec.primaryBranchId) ?? [];
        list.push(teacher.id);
        teacherIdsByBranch.set(spec.primaryBranchId, list);
      }
    }
  }
  done();

  // The bootstrap context: every service call below acts as the super admin, which
  // is the only honest way to seed through real use-cases that enforce permissions.
  const superAdminId = userIdByEmail.get('superadmin@example.test')!;
  const adminCtx: AccessContext = await buildAccessContext(superAdminId, {
    requestId: 'seed',
    ipAddress: null,
    userAgent: 'prisma/seed',
    sessionId: null,
  });

  // -------------------------------------------------------------------------
  // Academic catalogue
  // -------------------------------------------------------------------------
  done = step('creating subjects, programs and fee plans');
  const subjectIdByCode = new Map<string, string>();
  for (const subject of SUBJECTS) {
    const created = await prisma.subject.create({
      data: { organizationId, ...subject, isActive: true },
      select: { id: true },
    });
    subjectIdByCode.set(subject.code, created.id);
  }

  const programIdByCode = new Map<string, string>();
  const programPrice = new Map<string, bigint>();
  for (const program of PROGRAMS) {
    const created = await prisma.program.create({
      data: {
        organizationId,
        name: program.name,
        code: program.code,
        level: program.level,
        durationWeeks: program.durationWeeks,
        lessonsPerWeek: program.lessonsPerWeek,
        lessonDurationMinutes: program.lessonDurationMinutes,
        defaultPriceMinor: program.priceMinor,
        currency: CURRENCY,
        isActive: true,
        subjects: {
          create: [
            {
              subjectId: subjectIdByCode.get(program.subjectCode)!,
              hoursPerWeek: program.lessonsPerWeek,
              sequence: 0,
            },
          ],
        },
      },
      select: { id: true },
    });
    programIdByCode.set(program.code, created.id);
    programPrice.set(created.id, program.priceMinor);

    await prisma.feePlan.create({
      data: {
        organizationId,
        name: `${program.name} — monthly`,
        code: `FEE-${program.code}`,
        programId: created.id,
        billingCycle: 'MONTHLY',
        amountMinor: program.priceMinor,
        currency: CURRENCY,
        dueDaysAfterIssue: 10,
        isActive: true,
      },
    });
  }
  done();

  done = step('creating grading scale, discounts, tax and leave types');
  await prisma.gradingScale.create({
    data: {
      organizationId,
      name: 'Percentage (default)',
      kind: 'PERCENTAGE',
      isDefault: true,
      bands: {
        create: [
          { label: 'A', minPercentPpm: 900_000, maxPercentPpm: 1_000_000, gpaPoints: 4, isPass: true, sequence: 1 },
          { label: 'B', minPercentPpm: 800_000, maxPercentPpm: 899_999, gpaPoints: 3, isPass: true, sequence: 2 },
          { label: 'C', minPercentPpm: 700_000, maxPercentPpm: 799_999, gpaPoints: 2, isPass: true, sequence: 3 },
          { label: 'D', minPercentPpm: 600_000, maxPercentPpm: 699_999, gpaPoints: 1, isPass: true, sequence: 4 },
          { label: 'F', minPercentPpm: 0, maxPercentPpm: 599_999, gpaPoints: 0, isPass: false, sequence: 5 },
        ],
      },
    },
  });

  for (const discount of DISCOUNTS) {
    await prisma.discount.create({
      data: {
        organizationId,
        code: discount.code,
        name: discount.name,
        type: discount.type,
        appliesTo: discount.appliesTo,
        percentPpm: 'percentPpm' in discount ? discount.percentPpm : null,
        amountMinor: 'amountMinor' in discount ? discount.amountMinor : null,
        currency: 'amountMinor' in discount ? CURRENCY : null,
        requiresApproval: discount.requiresApproval,
        isActive: true,
      },
    });
  }

  await prisma.taxRate.create({
    data: { organizationId, name: 'VAT 12%', ratePpm: 120_000, isDefault: true, isActive: true },
  });

  await prisma.leaveType.createMany({
    data: LEAVE_TYPES.map((type) => ({
      organizationId,
      name: type.name,
      code: type.code,
      isPaid: type.isPaid,
      maxDaysPerYear: type.maxDaysPerYear,
      requiresApproval: true,
      requiresDocument: 'requiresDocument' in type ? type.requiresDocument : false,
      isActive: true,
    })),
  });

  for (const method of ['CASH', 'CARD', 'BANK_TRANSFER'] as const) {
    await prisma.paymentMethodConfig.create({
      data: {
        organizationId,
        method,
        label: method === 'BANK_TRANSFER' ? 'Bank transfer' : method.charAt(0) + method.slice(1).toLowerCase(),
        isActive: true,
        requiresReference: method !== 'CASH',
      },
    });
  }
  done();

  done = step(`seeding ${DEFAULT_NOTIFICATION_TEMPLATES.length} notification templates`);
  await prisma.notificationTemplate.createMany({
    data: DEFAULT_NOTIFICATION_TEMPLATES.map((template) => ({
      organizationId,
      key: template.key,
      event: template.event,
      channel: template.channel,
      locale: template.locale,
      subject: template.subject,
      body: template.body,
      // Spread into a mutable array: Prisma's Json input type rejects a
      // `readonly string[]`.
      variables: [...template.variables],
      isActive: true,
    })),
    skipDuplicates: true,
  });
  done();

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------
  done = step(`creating ${COUNTS.groups} groups`);
  const roomsByBranch = new Map<string, string[]>();
  for (const branchId of branchIds) {
    const rooms = await prisma.room.findMany({ where: { branchId }, select: { id: true } });
    roomsByBranch.set(branchId, rooms.map((r) => r.id));
  }

  const programCodes = PROGRAMS.map((p) => p.code);
  const groups: Array<{ id: string; branchId: string; programId: string; teacherId: string }> = [];

  for (let i = 0; i < COUNTS.groups; i += 1) {
    const branchId = branchIds[i % branchIds.length]!;
    const programCode = programCodes[i % programCodes.length]!;
    const programId = programIdByCode.get(programCode)!;
    const branchTeachers = teacherIdsByBranch.get(branchId) ?? teacherIds;
    const teacherId = branchTeachers[i % branchTeachers.length] ?? teacherIds[0]!;
    const rooms = roomsByBranch.get(branchId)!;
    const startDate = addDaysToDateOnly(todayIn(TIMEZONE), -random.int(30, 120));

    const group = await prisma.group.create({
      data: {
        organizationId,
        branchId,
        name: `${programCode}-${String(i + 1).padStart(2, '0')}`,
        code: `G-${programCode}-${String(i + 1).padStart(2, '0')}`,
        programId,
        subjectId: subjectIdByCode.get(PROGRAMS[i % PROGRAMS.length]!.subjectCode)!,
        primaryTeacherId: teacherId,
        roomId: rooms[i % rooms.length]!,
        academicYearId: academicYear.id,
        termId: currentTermId,
        level: PROGRAMS[i % PROGRAMS.length]!.level,
        capacity: random.int(10, 16),
        startDate: dateOnlyToPrismaDate(startDate),
        status: 'ACTIVE',
        teacherAssignments: {
          create: [{ teacherId, role: 'PRIMARY', startDate: dateOnlyToPrismaDate(startDate) }],
        },
      },
      select: { id: true },
    });
    groups.push({ id: group.id, branchId, programId, teacherId });
  }
  done();

  // -------------------------------------------------------------------------
  // Students, guardians, enrolments
  // -------------------------------------------------------------------------
  done = step(`creating ${COUNTS.guardians} guardians`);
  const guardianIds: string[] = [];
  for (let i = 0; i < COUNTS.guardians; i += 1) {
    const person = makePerson(random);
    const phone = makePhone(random);
    const guardian = await prisma.guardian.create({
      data: {
        organizationId,
        firstName: person.firstName,
        lastName: person.lastName,
        phone,
        phoneNormalized: normalizePhone(phone),
        email: random.chance(0.6) ? makeEmail(person.firstName, person.lastName, 500 + i) : null,
        occupation: random.pick(['Engineer', 'Teacher', 'Doctor', 'Entrepreneur', 'Accountant', 'Driver']),
        city: random.pick(['Tashkent', 'Samarkand']),
        preferredLocale: random.pick(['UZ', 'RU'] as const),
      },
      select: { id: true },
    });
    guardianIds.push(guardian.id);
  }
  done();

  done = step(`creating ${COUNTS.students} students and enrolling them`);
  const studentIds: string[] = [];
  const studentBranch = new Map<string, string>();
  const studentGroup = new Map<string, { groupId: string; programId: string }>();

  for (let i = 0; i < COUNTS.students; i += 1) {
    const person = makePerson(random);
    const group = groups[i % groups.length]!;
    const phone = makePhone(random);
    const enrolledAt = addDaysToDateOnly(todayIn(TIMEZONE), -random.int(10, 150));

    // Most students are active; a realistic tail is on hold, withdrawn or graduated
    // so the list filters and the status badges have something to show.
    const status = random.chance(0.86)
      ? 'ACTIVE'
      : random.chance(0.4)
        ? 'ON_HOLD'
        : random.chance(0.5)
          ? 'WITHDRAWN'
          : 'GRADUATED';

    const student = await prisma.student.create({
      data: {
        organizationId,
        branchId: group.branchId,
        studentCode: `STU-${String(i + 1).padStart(6, '0')}`,
        firstName: person.firstName,
        lastName: person.lastName,
        gender: person.gender,
        dateOfBirth: new Date(
          Date.UTC(currentYear - random.int(8, 34), random.int(0, 11), random.int(1, 28)),
        ),
        phone,
        phoneNormalized: normalizePhone(phone),
        email: random.chance(0.5) ? makeEmail(person.firstName, person.lastName, i) : null,
        addressLine: `${random.int(1, 180)} ${random.pick(['Navoi', 'Amir Temur', 'Bunyodkor', 'Shota Rustaveli'])} Street`,
        city: group.branchId === branchByCode.get('SAM') ? 'Samarkand' : 'Tashkent',
        status,
        enrolledAt: dateOnlyToPrismaDate(enrolledAt),
        emergencyContactName: `${makePerson(random).firstName} ${person.lastName}`,
        emergencyContactPhone: makePhone(random),
        emergencyContactRelation: random.pick(['Mother', 'Father', 'Uncle', 'Aunt']),
        createdById: superAdminId,
      },
      select: { id: true },
    });
    studentIds.push(student.id);
    studentBranch.set(student.id, group.branchId);

    // Link one or two guardians; roughly a fifth share a guardian, which is what
    // makes the sibling-discount and multi-child parent views meaningful.
    const primaryGuardian = guardianIds[i % guardianIds.length]!;
    await prisma.studentGuardian.create({
      data: {
        studentId: student.id,
        guardianId: primaryGuardian,
        relationship: random.pick(['MOTHER', 'FATHER'] as const),
        isPrimary: true,
        isEmergencyContact: true,
        receivesInvoices: true,
        receivesNotifications: true,
      },
    });
    if (random.chance(0.3)) {
      const second = guardianIds[(i + 7) % guardianIds.length]!;
      if (second !== primaryGuardian) {
        await prisma.studentGuardian.create({
          data: {
            studentId: student.id,
            guardianId: second,
            relationship: 'FATHER',
            isPrimary: false,
            receivesInvoices: false,
            receivesNotifications: true,
          },
        });
      }
    }

    // Enrol through the REAL use-case, so capacity, branch matching and the
    // partial unique index are all exercised. Over-capacity is permitted here
    // because the seed deliberately fills groups.
    if (status === 'ACTIVE' || status === 'ON_HOLD') {
      await enrollStudent(
        adminCtx,
        { studentId: student.id, groupId: group.id, startDate: enrolledAt, allowOvercapacity: true },
      );
      studentGroup.set(student.id, { groupId: group.id, programId: group.programId });
    }
  }
  done();

  // -------------------------------------------------------------------------
  // Lessons + attendance, through the real use-case
  // -------------------------------------------------------------------------
  done = step('creating lessons and attendance');
  const today = todayIn(TIMEZONE);
  let lessonCount = 0;
  let attendanceCount = 0;

  for (const group of groups) {
    // Enrolments are dated, so membership is resolved per lesson date below rather
    // than once per group -- exactly what getGroupRoster exists for.
    const anyEnrolled = await prisma.enrollment.count({ where: { groupId: group.id } });
    if (anyEnrolled === 0) continue;

    // Three lessons a week for the configured number of weeks back, plus today's,
    // so the dashboard and the teacher's "today" screen both have content.
    for (let week = COUNTS.lessonWeeksBack; week >= 0; week -= 1) {
      for (const dayOffset of [0, 2, 4]) {
        const date = addDaysToDateOnly(today, -(week * 7) + dayOffset);
        if (date > today) continue;

        const startHour = 9 + ((lessonCount % 4) * 2);
        const startsAt = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00+05:00`);
        const endsAt = new Date(startsAt.getTime() + 90 * 60_000);

        const lesson = await prisma.lesson.create({
          data: {
            organizationId,
            branchId: group.branchId,
            groupId: group.id,
            teacherId: group.teacherId,
            lessonDate: dateOnlyToPrismaDate(date),
            startsAt,
            endsAt,
            topic: `Unit ${random.int(1, 12)}`,
            lessonNumber: lessonCount + 1,
            status: date === today ? 'SCHEDULED' : 'COMPLETED',
            attendanceStatus: 'PENDING',
          },
          select: { id: true },
        });
        lessonCount += 1;

        // Today's registers are left PENDING on purpose: the teacher's mobile flow
        // needs something to actually mark.
        if (date === today) continue;

        const roster = await getGroupRoster(adminCtx, { groupId: group.id, onDate: date });
        if (roster.length === 0) continue;

        const entries = roster.map((row) => {
          const roll = random.next();
          if (roll < 0.84) return { studentId: row.studentId, status: 'PRESENT' as const };
          if (roll < 0.91) {
            return {
              studentId: row.studentId,
              status: 'LATE' as const,
              minutesLate: random.int(5, 25),
            };
          }
          if (roll < 0.96) return { studentId: row.studentId, status: 'ABSENT' as const };
          return { studentId: row.studentId, status: 'EXCUSED' as const };
        });

        await markAttendance(adminCtx, {
          lessonId: lesson.id,
          entries,
          method: 'TEACHER',
          markedAt: new Date(startsAt.getTime() + 10 * 60_000),
          submit: true,
        });
        attendanceCount += entries.length;
      }
    }
  }
  done();
  console.log(`      ${lessonCount} lessons, ${attendanceCount} attendance records`);

  // -------------------------------------------------------------------------
  // Invoices + payments, through the real use-cases
  // -------------------------------------------------------------------------
  done = step('creating invoices and payments');
  let invoiceCount = 0;
  let paymentCount = 0;

  for (const [index, studentId] of studentIds.entries()) {
    const placement = studentGroup.get(studentId);
    if (!placement) continue;

    const price = programPrice.get(placement.programId) ?? 45_000_000n;

    // Two months of billing: last month (mostly settled) and this month (a
    // realistic mix of paid, part-paid and overdue).
    for (const monthsAgo of [1, 0]) {
      const issueDate = addDaysToDateOnly(today, -(monthsAgo * 30) - 5);
      const dueDate = addDaysToDateOnly(issueDate, 10);

      const useDiscount = index % 9 === 0;
      const invoice = await createInvoice(adminCtx, {
        studentId,
        items: [
          {
            description: `Tuition — ${monthsAgo === 0 ? 'current' : 'previous'} month`,
            kind: 'TUITION',
            quantity: 1,
            unitPriceMinor: price,
            programId: placement.programId,
            groupId: placement.groupId,
          },
        ],
        discounts: useDiscount
          ? [{ label: 'Sibling discount', type: 'PERCENT', percentPpm: 100_000 }]
          : undefined,
        issueDate,
        dueDate,
        periodStart: issueDate,
        periodEnd: addDaysToDateOnly(issueDate, 29),
        issueNow: true,
      });
      invoiceCount += 1;

      // Last month is mostly settled; this month is deliberately mixed so the debt
      // ageing report, the overdue list and the partially-paid badge all have data.
      const roll = random.next();
      const payFully = monthsAgo === 1 ? roll < 0.88 : roll < 0.45;
      const payPartly = !payFully && (monthsAgo === 1 ? roll < 0.95 : roll < 0.7);

      if (payFully || payPartly) {
        const amount = payFully
          ? invoice.totalMinor
          : (invoice.totalMinor * BigInt(random.int(30, 70))) / 100n;
        if (amount > 0n) {
          await recordPayment(adminCtx, {
            studentId,
            amountMinor: amount,
            method: random.pick(['CASH', 'CARD', 'BANK_TRANSFER'] as const),
            receivedAt: new Date(`${addDaysToDateOnly(issueDate, random.int(1, 12))}T10:00:00+05:00`),
            invoiceIds: [invoice.id],
            reference: random.chance(0.4) ? `REF-${random.int(100_000, 999_999)}` : null,
            idempotencyKey: `seed-${studentId}-${monthsAgo}`,
          });
          paymentCount += 1;
        }
      }
    }
  }
  done();
  console.log(`      ${invoiceCount} invoices, ${paymentCount} payments`);

  // -------------------------------------------------------------------------
  // CRM
  // -------------------------------------------------------------------------
  done = step(`creating ${COUNTS.leads} leads with activity`);
  const leadStatuses = [
    'NEW', 'NEW', 'CONTACTED', 'CONTACTED', 'QUALIFIED', 'TRIAL_BOOKED',
    'TRIAL_COMPLETED', 'APPLICATION', 'ENROLLED', 'LOST',
  ] as const;

  for (let i = 0; i < COUNTS.leads; i += 1) {
    const person = makePerson(random);
    const phone = makePhone(random);
    const status = leadStatuses[i % leadStatuses.length]!;
    const assignedTo = salesAgentUserIds[i % salesAgentUserIds.length]!;
    const createdAt = new Date(
      `${addDaysToDateOnly(today, -random.int(0, 60))}T${String(random.int(9, 18)).padStart(2, '0')}:00:00+05:00`,
    );

    const lead = await prisma.lead.create({
      data: {
        organizationId,
        branchId: branchIds[i % branchIds.length]!,
        firstName: person.firstName,
        lastName: person.lastName,
        phone,
        phoneNormalized: normalizePhone(phone)!,
        email: random.chance(0.45) ? makeEmail(person.firstName, person.lastName, 900 + i) : null,
        emailNormalized: null,
        source: random.pick(LEAD_SOURCES),
        status,
        priority: random.pick(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const),
        score: random.int(20, 95),
        interestedProgramId: programIdByCode.get(random.pick(programCodes))!,
        assignedToUserId: assignedTo,
        assignedAt: createdAt,
        expectedValueMinor: programPrice.get(programIdByCode.get(random.pick(programCodes))!) ?? null,
        currency: CURRENCY,
        nextFollowUpAt:
          status === 'LOST' || status === 'ENROLLED'
            ? null
            : new Date(`${addDaysToDateOnly(today, random.int(-3, 7))}T11:00:00+05:00`),
        lastContactedAt: status === 'NEW' ? null : createdAt,
        lostReason: status === 'LOST' ? random.pick(LOST_REASONS) : null,
        lostAt: status === 'LOST' ? createdAt : null,
        createdById: assignedTo,
        createdAt,
        statusHistory: {
          create: [{ toStatus: 'NEW', changedById: assignedTo, changedAt: createdAt }],
        },
      },
      select: { id: true },
    });

    // A couple of activities each, so the timeline view is not empty.
    const activityCount = status === 'NEW' ? 0 : random.int(1, 4);
    for (let a = 0; a < activityCount; a += 1) {
      await prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          type: random.pick(['CALL', 'NOTE', 'TELEGRAM', 'MEETING'] as const),
          subject: 'Follow-up',
          body: random.pick(CALL_NOTES),
          outcome: random.chance(0.7) ? random.pick(['ANSWERED', 'NO_ANSWER', 'CALLBACK_REQUESTED'] as const) : null,
          durationSeconds: random.int(30, 480),
          occurredAt: new Date(createdAt.getTime() + (a + 1) * 86_400_000),
          createdById: assignedTo,
        },
      });
    }

    if (status !== 'LOST' && status !== 'ENROLLED' && random.chance(0.6)) {
      await prisma.followUpTask.create({
        data: {
          organizationId,
          branchId: branchIds[i % branchIds.length]!,
          leadId: lead.id,
          title: random.pick(['Call back', 'Send the price list', 'Confirm the trial lesson', 'Discuss instalments']),
          dueAt: new Date(`${addDaysToDateOnly(today, random.int(-4, 6))}T14:00:00+05:00`),
          priority: random.pick(['MEDIUM', 'HIGH'] as const),
          status: 'OPEN',
          assignedToUserId: assignedTo,
          createdById: assignedTo,
        },
      });
    }
  }
  done();

  // -------------------------------------------------------------------------
  // Exams, grades, homework, announcements
  // -------------------------------------------------------------------------
  done = step('creating exams, grades and homework');
  let examCount = 0;
  let gradeCount = 0;

  for (const group of groups.slice(0, 12)) {
    const roster = await prisma.enrollment.findMany({
      where: { groupId: group.id, endDate: null },
      select: { studentId: true },
    });
    if (roster.length === 0) continue;

    const scheduledAt = new Date(`${addDaysToDateOnly(today, -random.int(5, 30))}T10:00:00+05:00`);
    const maxScore = 100;
    const exam = await prisma.exam.create({
      data: {
        organizationId,
        branchId: group.branchId,
        groupId: group.id,
        teacherId: group.teacherId,
        termId: currentTermId,
        title: random.pick(EXAM_TITLES),
        type: random.pick(['QUIZ', 'MIDTERM', 'UNIT_TEST'] as const),
        scheduledAt,
        durationMinutes: 60,
        maxScore,
        passingScore: 60,
        weightPpm: 200_000,
        status: 'PUBLISHED',
        resultsPublishedAt: scheduledAt,
      },
      select: { id: true },
    });
    examCount += 1;

    for (const row of roster) {
      const absent = random.chance(0.06);
      const score = absent ? null : random.int(42, 100);
      const label = score === null ? null : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

      await prisma.examResult.create({
        data: {
          examId: exam.id,
          studentId: row.studentId,
          score,
          maxScore,
          gradeLabel: label,
          isPass: score === null ? null : score >= 60,
          isAbsent: absent,
          gradedById: superAdminId,
          gradedAt: scheduledAt,
        },
      });

      if (score !== null) {
        await prisma.grade.create({
          data: {
            organizationId,
            studentId: row.studentId,
            groupId: group.id,
            termId: currentTermId,
            sourceType: 'EXAM',
            examId: exam.id,
            score,
            maxScore,
            weightPpm: 200_000,
            gradeLabel: label,
            isPass: score >= 60,
            gradedById: superAdminId,
            gradedAt: scheduledAt,
          },
        });
        gradeCount += 1;
      }
    }

    await prisma.homework.create({
      data: {
        organizationId,
        branchId: group.branchId,
        groupId: group.id,
        teacherId: group.teacherId,
        title: random.pick(HOMEWORK_TITLES),
        description: 'Complete and bring to the next lesson.',
        dueAt: new Date(`${addDaysToDateOnly(today, random.int(1, 7))}T18:00:00+05:00`),
        maxScore: 10,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
  }
  done();
  console.log(`      ${examCount} exams, ${gradeCount} grades`);

  done = step('creating announcements');
  for (const announcement of ANNOUNCEMENTS) {
    await prisma.announcement.create({
      data: {
        organizationId,
        title: announcement.title,
        body: announcement.body,
        audience: announcement.audience,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishAt: new Date(),
        pinned: announcement.audience === 'ORGANIZATION',
        createdById: superAdminId,
      },
    });
  }
  done();

  done = step('registering cron schedules');
  await prisma.cronSchedule.createMany({
    data: [
      { organizationId, key: 'overdue-reminders', cronExpression: '0 9 * * *', jobName: 'finance.overdueReminders', description: 'Daily overdue payment reminders', timezone: TIMEZONE },
      { organizationId, key: 'daily-attendance-summary', cronExpression: '30 19 * * *', jobName: 'attendance.dailySummary', description: 'Daily attendance summary to administrators', timezone: TIMEZONE },
      { organizationId, key: 'follow-up-reminders', cronExpression: '0 8 * * *', jobName: 'crm.followUpReminders', description: 'Remind agents of due follow-ups', timezone: TIMEZONE },
      { organizationId, key: 'generate-lessons', cronExpression: '0 2 * * 0', jobName: 'scheduling.generateLessons', description: 'Materialise lessons from the timetable', timezone: TIMEZONE },
    ],
    skipDuplicates: true,
  });
  done();

  // -------------------------------------------------------------------------
  await report(random);
}

async function report(_random: Random): Promise<void> {
  const [students, guardians, groups, leads, invoices, payments, attendance, users, ledger] =
    await Promise.all([
      prisma.student.count(),
      prisma.guardian.count(),
      prisma.group.count(),
      prisma.lead.count(),
      prisma.invoice.count(),
      prisma.payment.count(),
      prisma.attendanceRecord.count(),
      prisma.user.count(),
      prisma.ledgerEntry.count(),
    ]);

  console.log('\n  Seeded:');
  for (const [label, value] of [
    ['users', users],
    ['students', students],
    ['guardians', guardians],
    ['groups', groups],
    ['leads', leads],
    ['invoices', invoices],
    ['payments', payments],
    ['attendance records', attendance],
    ['ledger entries', ledger],
  ] as const) {
    console.log(`    ${String(value).padStart(6)}  ${label}`);
  }

  console.log('\n  Development logins (password for all: ' + DEV_PASSWORD + ')');
  for (const account of DEV_ACCOUNTS) {
    console.log(`    ${account.email.padEnd(34)} ${account.role.padEnd(15)} ${account.label}`);
  }
  console.log(
    '\n  All names, phone numbers and addresses are fabricated. Emails use the\n' +
      '  reserved .test TLD and can never resolve.\n',
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error('\nSeed failed:\n', error);
    await prisma.$disconnect();
    process.exit(1);
  });
