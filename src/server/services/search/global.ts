/**
 * Global search: one box over students, guardians, leads, employees, groups,
 * invoices and payments.
 *
 * PER-TYPE PERMISSION FILTERING IS A SECURITY BOUNDARY, NOT A UI NICETY. A
 * receptionist without `invoices.view` must not see invoice hits, and the reason
 * is not tidiness: an invoice hit carries the invoice number, the student's name
 * and the branch. Hiding the section in the dropdown would still have shipped
 * that payload to the browser. So each entity type is queried only when the
 * caller holds its read permission, and a type they cannot read is reported in
 * `skippedTypes` rather than silently omitted -- an operator who expects invoices
 * and sees none deserves to know it is a permission, not an empty index.
 *
 * EVERY QUERY USES THE INDEXES THAT ALREADY EXIST (see
 * prisma/migrations/20260927030000_integrity_search_guards/migration.sql):
 *
 *   * names go through `search_normalize(...)` LIKE '%…%', which is what the
 *     trigram GIN indexes are built on. Writing `lower(...)` instead, or
 *     comparing the raw column, silently drops to a sequential scan -- and would
 *     also disagree about accents, so "Nodira" would stop matching "Nodirà".
 *
 *   * phone numbers are matched as a SUFFIX, because what a parent reads out at
 *     the desk is the last four digits. A suffix cannot use a btree, so the
 *     migration indexes `reverse(phoneNormalized)` and this queries it with a
 *     reversed prefix.
 *
 *   * `invoiceNumber` / `paymentNumber` are indexed on the RAW column, not on
 *     `search_normalize(...)`, so the term is upper-cased in TypeScript and the
 *     comparison stays on the indexed expression; normalising the column here
 *     would make the index unusable. NOTE: the migration declares
 *     `invoices_number_trgm` and `payments_number_trgm`, but they are absent from
 *     the development database (`db:verify` reports six trigram indexes where the
 *     migration creates eight, and `pg_indexes` shows none on either table).
 *     Until that drift is fixed, an infix number match falls back to a filter over
 *     one organisation's rows; the predicate here is already the right shape and
 *     starts using the index the moment it exists.
 *
 *   * `employeeCode` and `Group.code` have only their composite unique btree, and
 *     a default-collation btree cannot serve a prefix LIKE. They are therefore
 *     matched by EQUALITY -- typing a code in full finds the record, and typing
 *     part of one finds it by name instead. Honest, and no table scan per
 *     keystroke.
 */

import { prisma, type Db } from '@/server/db/client';
import { BadRequestError } from '@/server/errors';
import {
  can,
  isSelfScoped,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import { getSettings } from '@/server/settings';
import { normalizePhone } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SearchHitType =
  | 'STUDENT'
  | 'GUARDIAN'
  | 'LEAD'
  | 'EMPLOYEE'
  | 'GROUP'
  | 'INVOICE'
  | 'PAYMENT';

export const SEARCH_HIT_TYPES: readonly SearchHitType[] = [
  'STUDENT',
  'GUARDIAN',
  'LEAD',
  'EMPLOYEE',
  'GROUP',
  'INVOICE',
  'PAYMENT',
];

/**
 * Three characters is the minimum a trigram index can serve: `pg_trgm` indexes
 * three-character shingles, so `LIKE '%ab%'` cannot use the GIN index and would
 * sequential-scan seven tables on every keystroke. Exported so the UI can show
 * the same threshold in its hint instead of hard-coding a second one.
 */
export const SEARCH_MIN_QUERY_LENGTH = 3;

/** Longest term accepted. Beyond this it is not a search, it is a paste. */
const SEARCH_MAX_QUERY_LENGTH = 100;

/** A phone search needs enough digits to be a real one; two match half the school. */
const PHONE_MIN_DIGITS = 4;

/** Default and ceiling for the number of hits returned per entity type. */
const PER_TYPE_LIMIT_DEFAULT = 8;
const PER_TYPE_LIMIT_MAX = 25;

/**
 * Match quality, ascending. A single ordering across every entity type is what
 * lets the dropdown put the exact invoice number above a student whose name
 * happens to contain the same letters.
 */
export const MATCH_RANK = {
  /** The whole code or document number, typed out. */
  EXACT_CODE: 0,
  /** The tail of a phone number -- what a parent reads out at the desk. */
  PHONE_SUFFIX: 1,
  /** The start of a name. */
  PREFIX_NAME: 2,
  /** Somewhere inside a name or number. */
  INFIX: 3,
} as const;

export interface SearchHit {
  readonly type: SearchHitType;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  /** Relative path to the record. See `SEARCH_ROUTES`. */
  readonly url: string;
  readonly branchId: string | null;
  /** One of `MATCH_RANK`. Lower is a better match. */
  readonly rank: number;
}

export interface GlobalSearchInput {
  readonly query: string;
  /** Restrict to these types. Defaults to every type the caller may read. */
  readonly types?: readonly SearchHitType[];
  /** Hits per type, not in total, so no one type crowds out the others. */
  readonly limit?: number;
}

export interface GlobalSearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly countsByType: Readonly<Record<SearchHitType, number>>;
  /** Types actually queried. */
  readonly searchedTypes: readonly SearchHitType[];
  /** Types left out because the caller lacks the permission for them. */
  readonly skippedTypes: readonly SearchHitType[];
  /** Types where the per-type limit clipped the results. */
  readonly truncatedTypes: readonly SearchHitType[];
}

/**
 * The read permission each type requires.
 *
 * One table rather than a check per query, so "which permission gates which type"
 * is answerable by reading six lines instead of auditing seven SQL blocks.
 */
const TYPE_PERMISSION: Readonly<Record<SearchHitType, PermissionKey>> = {
  STUDENT: 'students.view',
  GUARDIAN: 'guardians.view',
  LEAD: 'leads.view',
  EMPLOYEE: 'employees.view',
  GROUP: 'groups.view',
  INVOICE: 'invoices.view',
  PAYMENT: 'payments.view',
};

/**
 * Where each hit links.
 *
 * Kept here rather than in the client so a search result cannot link somewhere
 * that does not exist: if a route moves, this map moves with it and every caller
 * follows.
 */
const SEARCH_ROUTES: Readonly<Record<SearchHitType, string>> = {
  STUDENT: '/students',
  GUARDIAN: '/guardians',
  LEAD: '/leads',
  EMPLOYEE: '/employees',
  GROUP: '/groups',
  INVOICE: '/invoices',
  PAYMENT: '/payments',
};

// ---------------------------------------------------------------------------
// Term preparation
// ---------------------------------------------------------------------------

/**
 * Escape the LIKE metacharacters.
 *
 * Without this, a query of `%` matches every row in seven tables at once, and `_`
 * quietly becomes a single-character wildcard. Escaping happens BEFORE
 * `search_normalize` is applied in SQL, which is safe because normalisation only
 * lower-cases and strips accents -- it cannot introduce or remove a backslash.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

interface PreparedTerm {
  readonly raw: string;
  /** For LIKE comparisons against `search_normalize(...)` expressions. */
  readonly pattern: string;
  /** Upper-cased, for the raw-column trigram indexes on document numbers. */
  readonly upper: string;
  /** Lower-cased, for the normalised e-mail column. */
  readonly lower: string;
  /**
   * Digits of a plausible phone suffix, or null. Taken from the digits the user
   * typed rather than from `normalizePhone`, because a suffix is not a whole
   * number and normalisation would prepend a country code that is not there.
   */
  readonly phoneSuffix: string | null;
  /** A complete, normalisable number; matched as a prefix on the stored E.164 form. */
  readonly phoneFull: string | null;
}

function prepareTerm(query: string): PreparedTerm {
  const raw = query.trim();
  if (raw.length < SEARCH_MIN_QUERY_LENGTH) {
    throw new BadRequestError(
      `Type at least ${SEARCH_MIN_QUERY_LENGTH} characters to search.`,
      { details: { minLength: SEARCH_MIN_QUERY_LENGTH } },
    );
  }
  if (raw.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new BadRequestError('That search term is too long.', {
      details: { maxLength: SEARCH_MAX_QUERY_LENGTH },
    });
  }

  const escaped = escapeLike(raw);
  const digits = raw.replace(/\D/g, '');

  return {
    raw,
    pattern: escaped,
    upper: escaped.toUpperCase(),
    lower: escaped.toLowerCase(),
    phoneSuffix: digits.length >= PHONE_MIN_DIGITS ? digits : null,
    phoneFull: normalizePhone(raw),
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

interface SearchScope {
  readonly organizationId: string;
  /** null means no branch predicate: an organisation-scoped caller. */
  readonly branchIds: string[] | null;
  /** SELF narrowing, mirroring `selfStudentFilter`. */
  readonly ownStudentId: string | null;
  readonly ownGuardianId: string | null;
  readonly ownTeacherId: string | null;
  readonly ownEmployeeId: string | null;
  readonly selfRestricted: boolean;
  /** Set when an agent may see only their own book of business. */
  readonly ownLeadUserId: string | null;
}

async function buildScope(ctx: AccessContext, db: Db): Promise<SearchScope> {
  const { agentsSeeOnlyOwnLeads } = await getSettings(
    ['agentsSeeOnlyOwnLeads'],
    { organizationId: ctx.organizationId },
    db,
  );
  const blinkered = agentsSeeOnlyOwnLeads && isSelfScoped(ctx) && !can(ctx, 'leads.viewAll');

  return {
    organizationId: ctx.organizationId,
    // Built from ctx alone. There is no caller input that can widen it, which is
    // why search takes no branch parameter at all.
    branchIds: ctx.scope === 'ORGANIZATION' || ctx.isSystem ? null : [...ctx.branchIds],
    ownStudentId: isSelfScoped(ctx) ? ctx.self.studentId : null,
    ownGuardianId: isSelfScoped(ctx) ? ctx.self.guardianId : null,
    ownTeacherId: isSelfScoped(ctx) ? ctx.self.teacherId : null,
    ownEmployeeId: isSelfScoped(ctx) ? ctx.self.employeeId : null,
    selfRestricted: isSelfScoped(ctx),
    ownLeadUserId: blinkered ? ctx.userId : null,
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

interface RawHit {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly branchId: string | null;
  readonly rank: number;
}

/**
 * Search everything the caller is allowed to see.
 *
 * The per-type queries are independent, so they run concurrently: seven small
 * index lookups in parallel beat one union of seven tables, which PostgreSQL
 * would have to plan as a whole and could not cap per type.
 */
export async function globalSearch(
  ctx: AccessContext,
  input: GlobalSearchInput,
  db?: Db,
): Promise<GlobalSearchResult> {
  requirePermission(ctx, 'search.global');

  const client = db ?? prisma;
  const term = prepareTerm(input.query);
  const perType = Math.min(
    PER_TYPE_LIMIT_MAX,
    Math.max(1, Math.trunc(input.limit ?? PER_TYPE_LIMIT_DEFAULT)),
  );

  const requested = input.types && input.types.length > 0 ? input.types : SEARCH_HIT_TYPES;
  const wanted = SEARCH_HIT_TYPES.filter((type) => requested.includes(type));

  const searchedTypes = wanted.filter((type) => can(ctx, TYPE_PERMISSION[type]));
  const skippedTypes = wanted.filter((type) => !searchedTypes.includes(type));

  const scope = await buildScope(ctx, client);

  // One extra row per type so the cap is detectable without a second count.
  const fetchLimit = perType + 1;

  const results = await Promise.all(
    searchedTypes.map(async (type) => ({
      type,
      rows: await runTypeQuery(type, client, scope, term, fetchLimit),
    })),
  );

  const hits: SearchHit[] = [];
  const countsByType: Record<SearchHitType, number> = {
    STUDENT: 0,
    GUARDIAN: 0,
    LEAD: 0,
    EMPLOYEE: 0,
    GROUP: 0,
    INVOICE: 0,
    PAYMENT: 0,
  };
  const truncatedTypes: SearchHitType[] = [];

  for (const result of results) {
    const clipped = result.rows.length > perType;
    if (clipped) truncatedTypes.push(result.type);
    const kept = clipped ? result.rows.slice(0, perType) : result.rows;
    countsByType[result.type] = kept.length;

    for (const row of kept) {
      hits.push({
        type: result.type,
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        url: `${SEARCH_ROUTES[result.type]}/${row.id}`,
        branchId: row.branchId,
        rank: row.rank,
      });
    }
  }

  return {
    query: term.raw,
    // Best match first across every type, then by type order so the list is
    // stable between identical searches. SQL already ordered within each type.
    hits: hits.sort(
      (a, b) =>
        a.rank - b.rank ||
        SEARCH_HIT_TYPES.indexOf(a.type) - SEARCH_HIT_TYPES.indexOf(b.type),
    ),
    countsByType,
    searchedTypes,
    skippedTypes,
    truncatedTypes,
  };
}

function runTypeQuery(
  type: SearchHitType,
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  switch (type) {
    case 'STUDENT':
      return searchStudents(db, scope, term, limit);
    case 'GUARDIAN':
      return searchGuardians(db, scope, term, limit);
    case 'LEAD':
      return searchLeads(db, scope, term, limit);
    case 'EMPLOYEE':
      return searchEmployees(db, scope, term, limit);
    case 'GROUP':
      return searchGroups(db, scope, term, limit);
    case 'INVOICE':
      return searchInvoices(db, scope, term, limit);
    case 'PAYMENT':
      return searchPayments(db, scope, term, limit);
  }
}

// ---------------------------------------------------------------------------
// Per-type queries
// ---------------------------------------------------------------------------

function searchStudents(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    select
      s."id"                                   as "id",
      (s."firstName" || ' ' || s."lastName")   as "title",
      s."studentCode"                          as "subtitle",
      s."branchId"                             as "branchId",
      case
        when "search_normalize"(s."studentCode") = "search_normalize"(${term.pattern})
          then ${MATCH_RANK.EXACT_CODE}
        when ${term.phoneSuffix}::text is not null
             and s."phoneNormalized" is not null
             and reverse(s."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%'
          then ${MATCH_RANK.PHONE_SUFFIX}
        -- Ranked against each name PART, not only the concatenation: typing a
        -- surname is the commonest search there is, and "smirnova" is not a
        -- prefix of "natalya smirnova". This test runs on rows the WHERE clause
        -- already found through the trigram index, so it costs nothing.
        when "search_normalize"(s."firstName") like "search_normalize"(${term.pattern}) || '%'
             or "search_normalize"(s."lastName") like "search_normalize"(${term.pattern}) || '%'
          then ${MATCH_RANK.PREFIX_NAME}
        else ${MATCH_RANK.INFIX}
      end                                      as "rank"
    from "students" s
    where s."organizationId" = ${scope.organizationId}
      and s."deletedAt" is null
      and (${scope.branchIds}::text[] is null or s."branchId" = any(${scope.branchIds}::text[]))
      and (not ${scope.selfRestricted}::boolean or (
            (${scope.ownStudentId}::text is not null and s."id" = ${scope.ownStudentId})
            or (${scope.ownGuardianId}::text is not null and exists (
                  select 1 from "student_guardians" sg
                  where sg."studentId" = s."id" and sg."guardianId" = ${scope.ownGuardianId}))
            or (${scope.ownTeacherId}::text is not null and exists (
                  select 1 from "enrollments" e
                  join "group_teachers" gt on gt."groupId" = e."groupId"
                  where e."studentId" = s."id" and e."endDate" is null
                    and gt."teacherId" = ${scope.ownTeacherId} and gt."endDate" is null))))
      and (
        "search_normalize"(s."firstName" || ' ' || s."lastName")
          like '%' || "search_normalize"(${term.pattern}) || '%'
        or "search_normalize"(s."studentCode") like '%' || "search_normalize"(${term.pattern}) || '%'
        or (${term.phoneSuffix}::text is not null
            and s."phoneNormalized" is not null
            and reverse(s."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%')
      )
    order by
      "rank" asc,
      similarity(
        "search_normalize"(s."firstName" || ' ' || s."lastName"),
        "search_normalize"(${term.pattern})
      ) desc,
      s."lastName" asc, s."firstName" asc
    limit ${limit}
  `;
}

/**
 * Guardians carry no `branchId` -- a parent belongs to the organisation, not to a
 * site -- so this matches `listGuardians`: organisation scope plus the SELF
 * narrowing, and no branch predicate. Adding one here would make search disagree
 * with the list screen about who exists.
 */
function searchGuardians(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    select
      g."id"                                   as "id",
      (g."firstName" || ' ' || g."lastName")   as "title",
      g."phone"                                as "subtitle",
      null::text                               as "branchId",
      case
        when ${term.phoneSuffix}::text is not null
             and g."phoneNormalized" is not null
             and reverse(g."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%'
          then ${MATCH_RANK.PHONE_SUFFIX}
        when "search_normalize"(g."firstName") like "search_normalize"(${term.pattern}) || '%'
             or "search_normalize"(g."lastName") like "search_normalize"(${term.pattern}) || '%'
          then ${MATCH_RANK.PREFIX_NAME}
        else ${MATCH_RANK.INFIX}
      end                                      as "rank"
    from "guardians" g
    where g."organizationId" = ${scope.organizationId}
      and g."deletedAt" is null
      and (not ${scope.selfRestricted}::boolean or (
            (${scope.ownGuardianId}::text is not null and g."id" = ${scope.ownGuardianId})
            or exists (
              select 1 from "student_guardians" sg
              join "students" s on s."id" = sg."studentId"
              where sg."guardianId" = g."id"
                and (
                  (${scope.ownStudentId}::text is not null and s."id" = ${scope.ownStudentId})
                  or (${scope.ownTeacherId}::text is not null and exists (
                        select 1 from "enrollments" e
                        join "group_teachers" gt on gt."groupId" = e."groupId"
                        where e."studentId" = s."id" and e."endDate" is null
                          and gt."teacherId" = ${scope.ownTeacherId} and gt."endDate" is null))
                ))))
      and (
        "search_normalize"(g."firstName" || ' ' || g."lastName")
          like '%' || "search_normalize"(${term.pattern}) || '%'
        or (${term.phoneSuffix}::text is not null
            and g."phoneNormalized" is not null
            and reverse(g."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%')
      )
    order by
      "rank" asc,
      similarity(
        "search_normalize"(g."firstName" || ' ' || g."lastName"),
        "search_normalize"(${term.pattern})
      ) desc,
      g."lastName" asc, g."firstName" asc
    limit ${limit}
  `;
}

/**
 * A lead's branch is nullable -- a website enquiry arrives before anyone has
 * decided which site will serve it -- so an unrouted lead is visible to the whole
 * organisation, exactly as `scopeFilterNullableBranch` has it. Merged duplicates
 * are excluded: surfacing both halves of a merge is how a receptionist phones the
 * same parent twice.
 */
function searchLeads(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    select
      l."id"                                                       as "id",
      (l."firstName" || ' ' || coalesce(l."lastName", ''))          as "title",
      l."phone"                                                    as "subtitle",
      l."branchId"                                                 as "branchId",
      case
        when ${term.phoneSuffix}::text is not null
             and reverse(l."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%'
          then ${MATCH_RANK.PHONE_SUFFIX}
        when l."emailNormalized" = ${term.lower} then ${MATCH_RANK.EXACT_CODE}
        when "search_normalize"(l."firstName") like "search_normalize"(${term.pattern}) || '%'
             or "search_normalize"(coalesce(l."lastName", ''))
                  like "search_normalize"(${term.pattern}) || '%'
          then ${MATCH_RANK.PREFIX_NAME}
        else ${MATCH_RANK.INFIX}
      end                                                          as "rank"
    from "leads" l
    where l."organizationId" = ${scope.organizationId}
      and l."deletedAt" is null
      and l."duplicateOfLeadId" is null
      and (${scope.branchIds}::text[] is null
           or l."branchId" is null
           or l."branchId" = any(${scope.branchIds}::text[]))
      and (${scope.ownLeadUserId}::text is null
           or l."assignedToUserId" = ${scope.ownLeadUserId}
           or l."createdById" = ${scope.ownLeadUserId})
      and (
        "search_normalize"(l."firstName" || ' ' || coalesce(l."lastName", ''))
          like '%' || "search_normalize"(${term.pattern}) || '%'
        or l."emailNormalized" = ${term.lower}
        or (${term.phoneSuffix}::text is not null
            and reverse(l."phoneNormalized") like reverse(${term.phoneSuffix}::text) || '%')
        or (${term.phoneFull}::text is not null
            and l."phoneNormalized" like ${term.phoneFull}::text || '%')
      )
    order by
      "rank" asc,
      similarity(
        "search_normalize"(l."firstName" || ' ' || coalesce(l."lastName", '')),
        "search_normalize"(${term.pattern})
      ) desc,
      l."createdAt" desc
    limit ${limit}
  `;
}

/**
 * Employees are matched on the USER's name, which is where `users_name_trgm`
 * lives, and on `employeeCode` by equality (see the note at the top about the
 * btree collation). Terminated staff are still findable: an HR manager looking up
 * last year's leaver needs to find them, and `EmploymentStatus` is shown in the
 * subtitle rather than used to hide the row.
 */
function searchEmployees(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    select
      e."id"                                                 as "id",
      (u."firstName" || ' ' || u."lastName")                 as "title",
      (e."employeeCode" || ' · ' || e."position")            as "subtitle",
      e."branchId"                                           as "branchId",
      case
        when e."employeeCode" = ${term.upper} then ${MATCH_RANK.EXACT_CODE}
        when "search_normalize"(u."firstName") like "search_normalize"(${term.pattern}) || '%'
             or "search_normalize"(u."lastName") like "search_normalize"(${term.pattern}) || '%'
          then ${MATCH_RANK.PREFIX_NAME}
        else ${MATCH_RANK.INFIX}
      end                                                    as "rank"
    from "employees" e
    join "users" u on u."id" = e."userId"
    where e."organizationId" = ${scope.organizationId}
      and e."deletedAt" is null
      and (${scope.branchIds}::text[] is null or e."branchId" = any(${scope.branchIds}::text[]))
      and (not ${scope.selfRestricted}::boolean
           or (${scope.ownEmployeeId}::text is not null and e."id" = ${scope.ownEmployeeId}))
      and (
        "search_normalize"(u."firstName" || ' ' || u."lastName")
          like '%' || "search_normalize"(${term.pattern}) || '%'
        or e."employeeCode" = ${term.upper}
      )
    order by
      "rank" asc,
      similarity(
        "search_normalize"(u."firstName" || ' ' || u."lastName"),
        "search_normalize"(${term.pattern})
      ) desc,
      u."lastName" asc
    limit ${limit}
  `;
}

/** Groups: `groups_name_trgm` for the name, the composite unique btree for the code. */
function searchGroups(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    select
      g."id"                                    as "id",
      g."name"                                  as "title",
      (g."code" || ' · ' || g."status"::text)    as "subtitle",
      g."branchId"                              as "branchId",
      case
        when g."code" = ${term.upper} then ${MATCH_RANK.EXACT_CODE}
        when "search_normalize"(g."name") like "search_normalize"(${term.pattern}) || '%'
          then ${MATCH_RANK.PREFIX_NAME}
        else ${MATCH_RANK.INFIX}
      end                                       as "rank"
    from "groups" g
    where g."organizationId" = ${scope.organizationId}
      and g."deletedAt" is null
      and (${scope.branchIds}::text[] is null or g."branchId" = any(${scope.branchIds}::text[]))
      and (not ${scope.selfRestricted}::boolean or (
            (${scope.ownTeacherId}::text is not null and exists (
                  select 1 from "group_teachers" gt
                  where gt."groupId" = g."id" and gt."teacherId" = ${scope.ownTeacherId}
                    and gt."endDate" is null))
            or (${scope.ownStudentId}::text is not null and exists (
                  select 1 from "enrollments" e
                  where e."groupId" = g."id" and e."studentId" = ${scope.ownStudentId}
                    and e."endDate" is null))
            or (${scope.ownGuardianId}::text is not null and exists (
                  select 1 from "enrollments" e
                  join "student_guardians" sg on sg."studentId" = e."studentId"
                  where e."groupId" = g."id" and e."endDate" is null
                    and sg."guardianId" = ${scope.ownGuardianId}))))
      and (
        "search_normalize"(g."name") like '%' || "search_normalize"(${term.pattern}) || '%'
        or g."code" = ${term.upper}
      )
    order by
      "rank" asc,
      similarity("search_normalize"(g."name"), "search_normalize"(${term.pattern})) desc,
      g."name" asc
    limit ${limit}
  `;
}

/**
 * Invoices are found by number and by the student's name -- "the Karimov
 * invoice" is how people actually ask.
 *
 * THE TWO MATCHES ARE SEPARATE CTEs, NOT AN `OR`. Written as
 * `where number like … or student_name like …` the plan degrades to a hash join
 * with a join filter and NEITHER trigram index can be used: PostgreSQL cannot
 * build a bitmap OR across two tables. Each branch on its own is a single-table
 * predicate that its index serves, and each is capped before the union, so the
 * merge is over at most `2 * limit` rows. This was measured with EXPLAIN, not
 * assumed.
 */
function searchInvoices(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    with by_number as (
      select
        i."id", i."invoiceNumber", i."studentId", i."branchId", i."status", i."issueDate",
        case
          when i."invoiceNumber" = ${term.upper} then ${MATCH_RANK.EXACT_CODE}
          when i."invoiceNumber" like ${term.upper} || '%' then ${MATCH_RANK.PREFIX_NAME}
          else ${MATCH_RANK.INFIX}
        end as rank
      from "invoices" i
      where i."organizationId" = ${scope.organizationId}
        and (${scope.branchIds}::text[] is null or i."branchId" = any(${scope.branchIds}::text[]))
        and (not ${scope.selfRestricted}::boolean or (
              (${scope.ownStudentId}::text is not null and i."studentId" = ${scope.ownStudentId})
              or (${scope.ownGuardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = i."studentId"
                      and sg."guardianId" = ${scope.ownGuardianId}))))
        and i."invoiceNumber" like '%' || ${term.upper} || '%'
      order by i."issueDate" desc
      limit ${limit}
    ),
    by_student as (
      select
        i."id", i."invoiceNumber", i."studentId", i."branchId", i."status", i."issueDate",
        ${MATCH_RANK.INFIX} as rank
      from "students" s
      join "invoices" i on i."studentId" = s."id"
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and (${scope.branchIds}::text[] is null or i."branchId" = any(${scope.branchIds}::text[]))
        and (not ${scope.selfRestricted}::boolean or (
              (${scope.ownStudentId}::text is not null and s."id" = ${scope.ownStudentId})
              or (${scope.ownGuardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id"
                      and sg."guardianId" = ${scope.ownGuardianId}))))
        and "search_normalize"(s."firstName" || ' ' || s."lastName")
              like '%' || "search_normalize"(${term.pattern}) || '%'
      order by i."issueDate" desc
      limit ${limit}
    ),
    -- An invoice can match both branches; keep the better rank, not two rows.
    ranked as (
      select "id", "invoiceNumber", "studentId", "branchId", "status", "issueDate",
             min(rank)::int as rank
      from (select * from by_number union all select * from by_student) merged
      group by 1, 2, 3, 4, 5, 6
    )
    select
      r."id"                                                             as "id",
      r."invoiceNumber"                                                  as "title",
      (s."firstName" || ' ' || s."lastName" || ' · ' || r."status"::text) as "subtitle",
      r."branchId"                                                       as "branchId",
      r.rank                                                             as "rank"
    from ranked r
    join "students" s on s."id" = r."studentId"
    order by r.rank asc, r."issueDate" desc
    limit ${limit}
  `;
}

/**
 * Payments: the receipt number, the payer's name, and a bank reference typed off
 * a slip. Split into index-friendly branches for the same reason as invoices.
 *
 * `Payment.reference` / `providerRef` have no index of their own, so that branch
 * narrows by `organizationId` and then filters. It is kept because reconciling a
 * bank statement against a receipt is a real daily task and the branch is bounded
 * by one organisation's payments; an index on `(organizationId, reference)` would
 * make it a lookup rather than a filter.
 */
function searchPayments(
  db: Db,
  scope: SearchScope,
  term: PreparedTerm,
  limit: number,
): Promise<RawHit[]> {
  return db.$queryRaw<RawHit[]>`
    with by_number as (
      select
        p."id", p."paymentNumber", p."studentId", p."branchId", p."method", p."receivedAt",
        case
          when p."paymentNumber" = ${term.upper} then ${MATCH_RANK.EXACT_CODE}
          when p."paymentNumber" like ${term.upper} || '%' then ${MATCH_RANK.PREFIX_NAME}
          else ${MATCH_RANK.INFIX}
        end as rank
      from "payments" p
      where p."organizationId" = ${scope.organizationId}
        and (${scope.branchIds}::text[] is null or p."branchId" = any(${scope.branchIds}::text[]))
        and (not ${scope.selfRestricted}::boolean or (
              (${scope.ownStudentId}::text is not null and p."studentId" = ${scope.ownStudentId})
              or (${scope.ownGuardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = p."studentId"
                      and sg."guardianId" = ${scope.ownGuardianId}))))
        and (
          p."paymentNumber" like '%' || ${term.upper} || '%'
          or p."reference" = ${term.raw}
          or p."providerRef" = ${term.raw}
        )
      order by p."receivedAt" desc
      limit ${limit}
    ),
    by_student as (
      select
        p."id", p."paymentNumber", p."studentId", p."branchId", p."method", p."receivedAt",
        ${MATCH_RANK.INFIX} as rank
      from "students" s
      join "payments" p on p."studentId" = s."id"
      where s."organizationId" = ${scope.organizationId}
        and s."deletedAt" is null
        and (${scope.branchIds}::text[] is null or p."branchId" = any(${scope.branchIds}::text[]))
        and (not ${scope.selfRestricted}::boolean or (
              (${scope.ownStudentId}::text is not null and s."id" = ${scope.ownStudentId})
              or (${scope.ownGuardianId}::text is not null and exists (
                    select 1 from "student_guardians" sg
                    where sg."studentId" = s."id"
                      and sg."guardianId" = ${scope.ownGuardianId}))))
        and "search_normalize"(s."firstName" || ' ' || s."lastName")
              like '%' || "search_normalize"(${term.pattern}) || '%'
      order by p."receivedAt" desc
      limit ${limit}
    ),
    ranked as (
      select "id", "paymentNumber", "studentId", "branchId", "method", "receivedAt",
             min(rank)::int as rank
      from (select * from by_number union all select * from by_student) merged
      group by 1, 2, 3, 4, 5, 6
    )
    select
      r."id"                                                             as "id",
      r."paymentNumber"                                                  as "title",
      (s."firstName" || ' ' || s."lastName" || ' · ' || r."method"::text) as "subtitle",
      r."branchId"                                                       as "branchId",
      r.rank                                                             as "rank"
    from ranked r
    join "students" s on s."id" = r."studentId"
    order by r.rank asc, r."receivedAt" desc
    limit ${limit}
  `;
}
