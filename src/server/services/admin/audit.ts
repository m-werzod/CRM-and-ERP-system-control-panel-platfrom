/**
 * Reading the audit trail and the activity timeline.
 *
 * `audit_logs` is append-only at the database level, which shapes how it is read:
 *
 *   CURSOR pagination, not offset. The table only grows, and `OFFSET 20000` makes
 *   PostgreSQL walk twenty thousand rows before returning one — so the deeper an
 *   investigator scrolls, the slower it gets, exactly when they are most likely to
 *   keep scrolling. A keyset cursor costs the same at any depth.
 *
 *   ORDER BY (createdAt, id). `createdAt` alone is not a total order: several rows
 *   written inside one transaction share a millisecond, and a cursor over a
 *   non-unique sort key silently skips or repeats rows at the page boundary.
 *
 * Two products, two read paths, matching the write side in `@/server/audit`:
 * `listAuditLog` / `getEntityHistory` serve compliance, and
 * `getActivityTimeline` serves the human timeline on a profile page. They are
 * permissioned differently on purpose — a receptionist should see that a payment
 * was received without being handed the audit log.
 */

import type { ActivitySubjectType, AuditSeverity, Prisma } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import { cursorPage, type CursorMeta } from '@/server/http/api';
import {
  assertBranchAccess,
  organizationFilter,
  requirePermission,
  scopeFilterNullableBranch,
  type AccessContext,
} from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import { getSettings } from '@/server/settings';
import {
  dayRangeToInstants,
  endOfDayExclusiveInstant,
  startOfDayInstant,
  type DateOnly,
} from '@/lib/dates';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly actorUserId: string | null;
  /** Denormalised at write time, so the line stays readable after a user is removed. */
  readonly actorLabel: string | null;
  readonly actorType: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly branchId: string | null;
  readonly summary: string | null;
  readonly changes: Prisma.JsonValue | null;
  readonly reason: string | null;
  readonly severity: AuditSeverity;
  readonly ipAddress: string | null;
  readonly requestId: string | null;
}

const AUDIT_SELECT = {
  id: true,
  createdAt: true,
  actorUserId: true,
  actorLabel: true,
  actorType: true,
  action: true,
  entityType: true,
  entityId: true,
  branchId: true,
  summary: true,
  changes: true,
  reason: true,
  severity: true,
  ipAddress: true,
  requestId: true,
} as const satisfies Prisma.AuditLogSelect;

export interface ListAuditLogInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly actorUserId?: string;
  /** Exact dotted action key, e.g. `payment.reversed`. */
  readonly action?: string;
  /** Prefix match, so `payment.` returns every payment action. */
  readonly actionPrefix?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly severity?: readonly AuditSeverity[];
  readonly branchId?: string;
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  /** Everything one request produced, which is how a report is traced back. */
  readonly requestId?: string;
}

export interface ListAuditLogResult {
  readonly items: readonly AuditLogRow[];
  readonly meta: CursorMeta;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function listAuditLog(
  ctx: AccessContext,
  input: ListAuditLogInput = {},
  db?: Db,
): Promise<ListAuditLogResult> {
  requirePermission(ctx, 'audit.view');

  const client = db ?? prisma;
  const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(input.limit ?? PAGE_SIZE_DEFAULT)));

  const filters: Prisma.AuditLogWhereInput[] = [
    // `branchId` is nullable on an audit row — an organisation-level action
    // belongs to no branch — so the nullable-branch variant is the right one: a
    // branch admin sees their branches plus the organisation-wide entries.
    scopeFilterNullableBranch(ctx) as Prisma.AuditLogWhereInput,
  ];

  if (input.actorUserId) filters.push({ actorUserId: input.actorUserId });
  if (input.action) filters.push({ action: input.action });
  if (input.actionPrefix) filters.push({ action: { startsWith: input.actionPrefix } });
  if (input.entityType) filters.push({ entityType: input.entityType });
  if (input.entityId) filters.push({ entityId: input.entityId });
  if (input.severity && input.severity.length > 0) {
    filters.push({ severity: { in: [...input.severity] } });
  }
  if (input.requestId) filters.push({ requestId: input.requestId });
  if (input.branchId) {
    // Verified, not intersected: asking for a branch the caller cannot see is a
    // 403, not an empty page that reads as "nothing happened there".
    assertBranchAccess(ctx, input.branchId, 'audit log');
    filters.push({ branchId: input.branchId });
  }

  if (input.from || input.to) {
    const { timezone } = await getSettings(
      ['timezone'],
      { organizationId: ctx.organizationId, branchId: input.branchId ?? null },
      client,
    );
    if (input.from && input.to) {
      const range = dayRangeToInstants(input.from, input.to, timezone);
      filters.push({ createdAt: { gte: range.from, lt: range.toExclusive } });
    } else if (input.from) {
      filters.push({ createdAt: { gte: startOfDayInstant(input.from, timezone) } });
    } else if (input.to) {
      filters.push({ createdAt: { lt: endOfDayExclusiveInstant(input.to, timezone) } });
    }
  }

  const rows = await client.auditLog.findMany({
    where: { AND: filters },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One extra row is how `cursorPage` knows whether more exist without a COUNT
    // over a table that only grows.
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: AUDIT_SELECT,
  });

  const { items, meta } = cursorPage(rows, limit);
  return { items, meta };
}

/**
 * Every audit row touching one record, newest first — the "who changed this"
 * panel on a detail page.
 *
 * Backed by the `(organizationId, entityType, entityId)` index. Not cursor
 * paginated: one record's history is bounded by how often a human edited it, and
 * a panel wants the whole list.
 */
export async function getEntityHistory(
  ctx: AccessContext,
  input: {
    readonly entityType: string;
    readonly entityId: string;
    readonly limit?: number;
  },
  db?: Db,
): Promise<readonly AuditLogRow[]> {
  requirePermission(ctx, 'audit.view');

  const client = db ?? prisma;
  return client.auditLog.findMany({
    where: {
      ...(scopeFilterNullableBranch(ctx) as Prisma.AuditLogWhereInput),
      entityType: input.entityType,
      entityId: input.entityId,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(input.limit ?? PAGE_SIZE_MAX))),
    select: AUDIT_SELECT,
  });
}

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------

export interface ActivityTimelineEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorLabel: string | null;
  readonly metadata: Prisma.JsonValue | null;
}

/**
 * Which permission lets a caller read one subject's timeline.
 *
 * `audit.view` would be wrong here: the timeline is the human-readable strip on a
 * student or lead page, and a receptionist who may open the student may read it.
 * The permission that governs the SUBJECT is therefore the permission that
 * governs its timeline.
 */
const TIMELINE_PERMISSION: Record<ActivitySubjectType, PermissionKey> = {
  STUDENT: 'students.view',
  LEAD: 'leads.view',
  APPLICATION: 'applications.view',
  EMPLOYEE: 'employees.view',
  TEACHER: 'teachers.view',
  GROUP: 'groups.view',
  INVOICE: 'invoices.view',
  GUARDIAN: 'guardians.view',
};

export interface GetActivityTimelineInput {
  readonly subjectType: ActivitySubjectType;
  readonly subjectId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ActivityTimelineResult {
  readonly items: readonly ActivityTimelineEntry[];
  readonly meta: CursorMeta;
}

export async function getActivityTimeline(
  ctx: AccessContext,
  input: GetActivityTimelineInput,
  db?: Db,
): Promise<ActivityTimelineResult> {
  requirePermission(ctx, TIMELINE_PERMISSION[input.subjectType]);

  const client = db ?? prisma;
  const limit = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(input.limit ?? PAGE_SIZE_DEFAULT)));

  // `ActivityEvent` carries no branch column: it hangs off a subject whose own
  // scope was already checked by the page that is rendering it, and the
  // organisation predicate is what keeps it inside the tenant.
  const rows = await client.activityEvent.findMany({
    where: {
      ...organizationFilter(ctx),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      title: true,
      description: true,
      occurredAt: true,
      actorUserId: true,
      actorLabel: true,
      metadata: true,
    },
  });

  const { items, meta } = cursorPage(rows, limit);
  return { items, meta };
}
