/**
 * Internal plumbing shared by the CRM use-cases.
 *
 * Two things live here rather than being re-derived per file:
 *
 *   the READ PREDICATE for leads and follow-ups, because "which leads may this
 *   caller see" is a security decision that must have exactly one implementation;
 *
 *   the STATUS WRITE, because a lead's status is changed by six different
 *   use-cases (a manual change, losing it, logging first contact, booking a trial,
 *   recording its outcome, converting it) and every one of them must validate the
 *   transition, append `LeadStatusHistory` and leave an activity behind. A second
 *   place that writes `Lead.status` is a second place that can forget the history
 *   row the funnel report is built from.
 *
 * Nothing here is exported from the barrel: these are seams between the CRM
 * services, not part of the surface the HTTP layer calls.
 */

import type { LeadStatus, Prisma } from '@/generated/prisma/client';
import type { Db, Tx } from '@/server/db/client';
import { ForbiddenError, NotFoundError } from '@/server/errors';
import {
  AUDIT_ACTIONS,
  record as recordAudit,
  type AuditSeverityValue,
} from '@/server/audit';
import {
  assertBranchAccess,
  composeReadFilter,
  organizationFilter,
  restrictedToOwn,
  scopeFilterNullableBranch,
  selfLeadFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { assertLeadTransition } from '@/server/services/crm/scoring';

/** The columns every CRM write needs about the lead it is touching. */
export const LEAD_WRITE_SELECT = {
  id: true,
  organizationId: true,
  branchId: true,
  firstName: true,
  lastName: true,
  phone: true,
  phoneNormalized: true,
  emailNormalized: true,
  status: true,
  assignedToUserId: true,
  convertedAt: true,
  duplicateOfLeadId: true,
  deletedAt: true,
} as const satisfies Prisma.LeadSelect;

export interface LeadWriteSubject {
  readonly id: string;
  readonly branchId: string | null;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly status: LeadStatus;
}

export function leadDisplayName(lead: {
  firstName: string;
  lastName?: string | null;
}): string {
  return [lead.firstName, lead.lastName].filter(Boolean).join(' ');
}

/**
 * The predicate that decides which leads a caller may read.
 *
 * A SELF-scoped sales agent is narrowed to their own book of business, but only
 * when the institution has asked for that (`crm.agentsSeeOnlyOwnLeads`) and only
 * while the agent lacks `leads.viewAll` — which is how a sales manager, who is also
 * branch-scoped, sees the whole pipeline through the same code path.
 */
export async function leadReadFilter(
  ctx: AccessContext,
  db: Db,
  options: { readonly includeArchived?: boolean } = {},
): Promise<Prisma.LeadWhereInput> {
  const { agentsSeeOnlyOwnLeads } = await getSettings(
    ['agentsSeeOnlyOwnLeads'],
    { organizationId: ctx.organizationId },
    db,
  );

  const base = composeReadFilter(ctx, {
    selfFilter: agentsSeeOnlyOwnLeads ? selfLeadFilter(ctx) : undefined,
    escapeHatch: 'leads.viewAll',
    nullableBranch: true,
  });

  return {
    // `composeReadFilter` returns an open record because it is model-agnostic; the
    // keys it produces (organizationId / branchId / AND) are all valid here.
    ...(base as Prisma.LeadWhereInput),
    ...(options.includeArchived ? {} : { deletedAt: null }),
  };
}

/**
 * Load a lead for a write, with the scope predicate in the SAME query.
 *
 * NotFound rather than OutOfScope on a miss: lead ids are handed out in URLs, and
 * answering "that exists but is not yours" would let one agent enumerate another
 * branch's pipeline.
 */
export async function loadLeadForWrite(
  ctx: AccessContext,
  tx: Tx,
  leadId: string,
): Promise<{
  id: string;
  organizationId: string;
  branchId: string | null;
  firstName: string;
  lastName: string | null;
  phone: string;
  phoneNormalized: string;
  emailNormalized: string | null;
  status: LeadStatus;
  assignedToUserId: string | null;
  convertedAt: Date | null;
  duplicateOfLeadId: string | null;
  deletedAt: Date | null;
}> {
  const where = await leadReadFilter(ctx, tx);
  const lead = await tx.lead.findFirst({
    where: { ...where, id: leadId },
    select: LEAD_WRITE_SELECT,
  });
  if (!lead) throw new NotFoundError('Lead', leadId);
  return lead;
}

/**
 * Resolve the branch a lead belongs to.
 *
 * Unlike a student, a lead may legitimately have no branch: a website enquiry
 * arrives before anyone has decided which site will serve it. So this is not
 * `resolveWriteBranch` — it verifies an explicit choice, defaults a branch-scoped
 * caller to their own branch, and lets an organisation-scoped caller leave it
 * unrouted.
 */
export function resolveLeadBranch(
  ctx: AccessContext,
  requested: string | null | undefined,
): string | null {
  if (requested) {
    assertBranchAccess(ctx, requested, 'lead');
    return requested;
  }
  if (ctx.scope === 'ORGANIZATION' || ctx.isSystem) return null;
  return ctx.primaryBranchId ?? ctx.branchIds[0] ?? null;
}

export interface ApplyStatusChangeInput {
  readonly toStatus: LeadStatus;
  readonly reason?: string | null;
  /** Defaults to `lead.status.changed`. */
  readonly auditAction?: string;
  readonly severity?: AuditSeverityValue;
  /** Extra columns to set in the same UPDATE, e.g. `lostAt`, `convertedAt`. */
  readonly extraData?: Prisma.LeadUpdateInput;
  readonly occurredAt?: Date;
}

/**
 * Move a lead to a new status: validate, update, append the history row and the
 * activity, audit. The ONLY sanctioned writer of `Lead.status`.
 */
export async function applyLeadStatusChange(
  ctx: AccessContext,
  tx: Tx,
  lead: LeadWriteSubject,
  input: ApplyStatusChangeInput,
): Promise<void> {
  assertLeadTransition(lead.status, input.toStatus);

  const occurredAt = input.occurredAt ?? new Date();
  const actorId = ctx.isSystem ? null : ctx.userId;
  const name = leadDisplayName(lead);

  await tx.lead.update({
    where: { id: lead.id },
    data: { status: input.toStatus, ...input.extraData },
  });

  await tx.leadStatusHistory.create({
    data: {
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
      changedById: actorId,
      changedAt: occurredAt,
    },
  });

  await tx.leadActivity.create({
    data: {
      leadId: lead.id,
      type: 'STATUS_CHANGE',
      subject: `${lead.status} → ${input.toStatus}`,
      body: input.reason ?? null,
      occurredAt,
      createdById: actorId,
    },
  });

  await recordAudit(
    ctx,
    {
      action: input.auditAction ?? AUDIT_ACTIONS.LEAD_STATUS_CHANGED,
      entityType: 'Lead',
      entityId: lead.id,
      branchId: lead.branchId,
      summary: `${name}: ${lead.status} → ${input.toStatus}`,
      changes: { status: { from: lead.status, to: input.toStatus } },
      reason: input.reason ?? null,
      severity: input.severity ?? 'INFO',
      timeline: {
        subjectType: 'LEAD',
        subjectId: lead.id,
        type: 'lead.status_changed',
        title: `Status changed to ${input.toStatus}`,
        description: input.reason ?? null,
        occurredAt,
      },
    },
    tx,
  );
}

/**
 * Refresh `Lead.nextFollowUpAt` from the open tasks.
 *
 * The column is a derived cache that exists so "leads due today" is one indexed
 * scan instead of a join; it is recomputed inside the same transaction as every
 * follow-up write, never edited independently.
 */
export async function recomputeLeadNextFollowUp(tx: Tx, leadId: string): Promise<void> {
  const next = await tx.followUpTask.aggregate({
    where: { leadId, status: 'OPEN' },
    _min: { dueAt: true },
  });
  await tx.lead.update({
    where: { id: leadId },
    data: { nextFollowUpAt: next._min.dueAt ?? null },
  });
}

/**
 * Cancel the open follow-ups on a lead that has left the pipeline (converted,
 * lost, archived). Leaving them open would put tasks nobody should act on at the
 * top of an agent's overdue list, which is how a task list stops being trusted.
 */
export async function cancelOpenFollowUps(
  tx: Tx,
  leadId: string,
  reason: string,
): Promise<number> {
  const open = await tx.followUpTask.findMany({
    where: { leadId, status: 'OPEN' },
    select: { id: true },
  });
  if (open.length === 0) return 0;

  await tx.followUpTask.updateMany({
    where: { id: { in: open.map((task) => task.id) } },
    data: { status: 'CANCELLED', completionNote: reason },
  });
  await tx.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: null } });
  return open.length;
}

/**
 * The predicate for follow-up tasks. Same shape as leads: branch scope, plus a
 * narrowing to the caller's own tasks unless they hold `followUps.viewAll`.
 */
export function followUpReadFilter(
  ctx: AccessContext,
  options: { readonly onlyMine?: boolean } = {},
): Prisma.FollowUpTaskWhereInput {
  const base: Prisma.FollowUpTaskWhereInput = {
    ...(scopeFilterNullableBranch(ctx) as Prisma.FollowUpTaskWhereInput),
  };

  if (options.onlyMine || restrictedToOwn(ctx, 'followUps.viewAll')) {
    return { AND: [base, { assignedToUserId: ctx.userId }] };
  }
  return base;
}

/**
 * Verify that a user may be handed work: same organisation, still active. The FK on
 * `FollowUpTask.assignedToUserId` is `Restrict`, so an unknown id would otherwise
 * surface as a constraint error rather than a sentence.
 */
export async function assertAssignableUser(
  ctx: AccessContext,
  tx: Tx,
  userId: string,
): Promise<{ id: string; firstName: string; lastName: string }> {
  const user = await tx.user.findFirst({
    where: { id: userId, ...organizationFilter(ctx), deletedAt: null },
    select: { id: true, firstName: true, lastName: true, status: true },
  });
  if (!user) throw new NotFoundError('User', userId);
  if (user.status !== 'ACTIVE') {
    throw new ForbiddenError(
      `${user.firstName} ${user.lastName} is not an active user and cannot be given work.`,
    );
  }
  return { id: user.id, firstName: user.firstName, lastName: user.lastName };
}
