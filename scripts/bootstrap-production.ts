/**
 * Bootstrap a real organisation and its first SUPER_ADMIN.
 *
 * Deliberately a separate script from `prisma/seed`, not a flag on it. The seed
 * TRUNCATES every table and fills the database with fabricated people; pointing it
 * at production is the single most destructive mistake available in this repo. Two
 * scripts with two names means that mistake needs a deliberate act rather than a
 * missing flag.
 *
 * What it does, all in one transaction:
 *   1. seeds the global permission catalogue (idempotent)
 *   2. creates the organisation and its first branch
 *   3. creates the eleven baseline roles from src/server/rbac/permissions.ts
 *   4. creates one SUPER_ADMIN with a generated temporary password and
 *      mustChangePassword = true
 *   5. writes the currency and timezone settings so the finance resolver has an
 *      explicit value rather than falling back
 *
 * The temporary password is printed ONCE and never stored anywhere else. Hand it
 * over out of band and have it changed on first login.
 *
 *   npx tsx scripts/bootstrap-production.ts \
 *     --org "Bright Future Education" \
 *     --slug bright-future \
 *     --branch "Main Campus" --branch-code MAIN \
 *     --email admin@your-domain.uz \
 *     --first Sherzod --last Usmonov \
 *     --currency UZS --timezone Asia/Tashkent
 *
 * Safe to re-run: if the slug already exists it reports what is there and changes
 * nothing.
 */

import 'dotenv/config';
import { prisma } from '@/server/db/client';
import { generateTemporaryPassword, hashPassword } from '@/server/auth/password';
import {
  PERMISSIONS,
  ROLE_TEMPLATES,
  resolveTemplatePermissions,
} from '@/server/rbac/permissions';
import { SUPPORTED_CURRENCIES, isSupportedCurrency } from '@/lib/money';
import { assertTimeZone } from '@/lib/dates';
import { emailSchema } from '@/lib/validation';

interface Options {
  org: string;
  slug: string;
  branch: string;
  branchCode: string;
  email: string;
  first: string;
  last: string;
  currency: string;
  timezone: string;
  locale: 'UZ' | 'RU' | 'EN';
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    // A flag followed by another flag means the operator forgot the value; taking
    // "--email" as the org name would produce a silently wrong organisation.
    if (value === undefined || value.startsWith('--')) {
      fail(`--${flag} needs a value`);
    }
    return value;
  };

  const org = get('org');
  const email = get('email');
  if (!org) fail('--org is required, e.g. --org "Bright Future Education"');
  if (!email) fail('--email is required: the first administrator’s address');

  const slug =
    get('slug') ??
    org
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const currency = (get('currency') ?? 'UZS').toUpperCase();
  if (!isSupportedCurrency(currency)) {
    fail(`--currency must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`);
  }

  const timezone = get('timezone') ?? 'Asia/Tashkent';
  try {
    assertTimeZone(timezone);
  } catch {
    fail(`--timezone is not a valid IANA zone: ${timezone}`);
  }

  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) fail(`--email is not a valid address: ${email}`);

  const locale = (get('locale') ?? 'UZ').toUpperCase();
  if (locale !== 'UZ' && locale !== 'RU' && locale !== 'EN') {
    fail('--locale must be UZ, RU or EN');
  }

  return {
    org,
    slug,
    branch: get('branch') ?? 'Main Campus',
    branchCode: (get('branch-code') ?? 'MAIN').toUpperCase(),
    email: parsedEmail.data,
    first: get('first') ?? 'System',
    last: get('last') ?? 'Administrator',
    currency,
    timezone,
    locale,
  };
}

function fail(message: string): never {
  console.error(`\n  bootstrap: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const options = parseArgs();

  const existing = await prisma.organization.findUnique({
    where: { slug: options.slug },
    select: { id: true, name: true, _count: { select: { users: true, branches: true } } },
  });
  if (existing) {
    console.log(
      `\n  An organisation with slug "${options.slug}" already exists:\n` +
        `    ${existing.name}\n` +
        `    ${existing._count.branches} branch(es), ${existing._count.users} user(s)\n\n` +
        `  Nothing changed. Use a different --slug to create another organisation.\n`,
    );
    return;
  }

  // The catalogue is global, not per-tenant, so this is idempotent and safe to run
  // on a database that already has other organisations.
  const permissionResult = await prisma.permission.createMany({
    data: PERMISSIONS.map((permission) => ({
      key: permission.key,
      module: permission.module,
      action: permission.action,
      description: permission.description,
      isSensitive: permission.sensitive ?? false,
    })),
    skipDuplicates: true,
  });

  const temporaryPassword = generateTemporaryPassword(16);
  const passwordHash = await hashPassword(temporaryPassword);

  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: options.org,
        slug: options.slug,
        status: 'ACTIVE',
        defaultCurrency: options.currency,
        timezone: options.timezone,
        defaultLocale: options.locale,
        branches: {
          create: [{ name: options.branch, code: options.branchCode, isActive: true }],
        },
      },
      select: { id: true, branches: { select: { id: true } } },
    });

    const branchId = organization.branches[0]?.id;
    if (!branchId) throw new Error('bootstrap: the branch was not created');

    const permissionIdByKey = new Map(
      (await tx.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
    );

    let superAdminRoleId: string | null = null;
    for (const template of ROLE_TEMPLATES) {
      const role = await tx.role.create({
        data: {
          organizationId: organization.id,
          key: template.key,
          name: template.name,
          description: template.description,
          scope: template.scope,
          level: template.level,
          isSystem: true,
          permissions: {
            create: resolveTemplatePermissions(template)
              .map((key) => permissionIdByKey.get(key))
              .filter((id): id is string => Boolean(id))
              .map((permissionId) => ({ permissionId })),
          },
        },
        select: { id: true },
      });
      if (template.key === 'SUPER_ADMIN') superAdminRoleId = role.id;
    }
    if (!superAdminRoleId) throw new Error('bootstrap: the SUPER_ADMIN role is missing');

    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email: options.email,
        passwordHash,
        firstName: options.first,
        lastName: options.last,
        status: 'ACTIVE',
        locale: options.locale,
        // The whole point of a temporary password: it must be replaced on first use.
        mustChangePassword: true,
        userRoles: { create: [{ roleId: superAdminRoleId }] },
        userBranches: { create: [{ branchId, isPrimary: true }] },
      },
      select: { id: true },
    });

    // Written explicitly so `currencyFor()` resolves from a real setting row rather
    // than falling through to the organisation default — one less layer of
    // indirection when someone later asks "why is this invoice in UZS?".
    await tx.setting.createMany({
      data: [
        {
          organizationId: organization.id,
          key: 'finance.currency',
          scope: 'ORGANIZATION',
          value: options.currency,
          updatedById: user.id,
        },
        {
          organizationId: organization.id,
          key: 'locale.timezone',
          scope: 'ORGANIZATION',
          value: options.timezone,
          updatedById: user.id,
        },
        {
          organizationId: organization.id,
          key: 'locale.defaultLocale',
          scope: 'ORGANIZATION',
          value: options.locale,
          updatedById: user.id,
        },
      ],
    });

    // Recorded like any other privileged action, with no user as the actor because
    // this ran from a shell rather than a session.
    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorUserId: null,
        actorLabel: 'bootstrap-production.ts',
        actorType: 'system',
        action: 'organization.bootstrapped',
        entityType: 'Organization',
        entityId: organization.id,
        summary: `Organisation "${options.org}" created with its first SUPER_ADMIN`,
        severity: 'CRITICAL',
        changes: {
          organization: { from: null, to: options.org },
          superAdmin: { from: null, to: options.email },
        },
      },
    });

    return { organizationId: organization.id, branchId, userId: user.id };
  });

  console.log(
    [
      '',
      `  Organisation created: ${options.org}`,
      `    id          ${result.organizationId}`,
      `    slug        ${options.slug}`,
      `    branch      ${options.branch} (${options.branchCode})`,
      `    currency    ${options.currency}`,
      `    timezone    ${options.timezone}`,
      `    roles       ${ROLE_TEMPLATES.length} baseline roles`,
      `    permissions ${PERMISSIONS.length} in catalogue (${permissionResult.count} newly inserted)`,
      '',
      '  First administrator',
      `    email       ${options.email}`,
      `    password    ${temporaryPassword}`,
      '',
      '  This password is shown ONCE and is stored only as an Argon2id hash.',
      '  Hand it over out of band. The account must change it at first login.',
      '',
      '  Next: npm run db:verify   (assert the database guarantees are in place)',
      '',
    ].join('\n'),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('\nBootstrap failed:\n', error);
    await prisma.$disconnect();
    process.exit(1);
  });
