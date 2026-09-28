/**
 * Lead use-cases: capture, qualify, assign, merge, archive, list.
 *
 * Two things in here are worth reading before changing anything.
 *
 * DUPLICATE DETECTION WARNS, IT DOES NOT BLOCK. The same person enquiring twice is
 * ordinary — they called on Monday and walked in on Saturday — and a front desk that
 * cannot save a lead because the system suspects a duplicate will write the enquiry
 * on paper instead. So `createLead` returns its matches and lets the caller decide;
 * a caller who wants the strict behaviour passes `allowDuplicate: false`.
 *
 * STATUS IS NEVER WRITTEN HERE DIRECTLY. Every transition goes through
 * `applyLeadStatusChange`, which validates it and appends the `LeadStatusHistory`
 * row that `getConversionFunnel` counts. `updateLead` therefore deliberately has no
 * `status` field: changing it is a different use-case with a different permission
 * story.
 */

import type {
  LeadPriority,
  LeadSource,
  LeadStatus,
  Prisma,
} from '@/generated/prisma/client';
import { withTransaction, prisma, type Db } from '@/server/db/client';
import {
  BusinessRuleError,
  ConflictError,
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '@/server/errors';
import {
  AUDIT_ACTIONS,
  diffFields,
  record as recordAudit,
} from '@/server/audit';
import {
  assertBranchAccess,
  can,
  organizationFilter,
  requirePermission,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import {
  dayRangeToInstants,
  endOfDayExclusiveInstant,
  startOfDayInstant,
  type DateOnly,
} from '@/lib/dates';
import { normalizePhone } from '@/lib/validation';
import { currencyFor } from '@/server/services/finance/currency';
import {
  isLeadTransitionAllowed,
  normalizeEmail,
  rankDuplicateMatches,
  type DuplicateCandidate,
  type DuplicateMatch,
  type DuplicateSubject,
} from '@/server/services/crm/scoring';
import {
  applyLeadStatusChange,
  assertAssignableUser,
  cancelOpenFollowUps,
  leadDisplayName,
  leadReadFilter,
  loadLeadForWrite,
  recomputeLeadNextFollowUp,
  resolveLeadBranch,
} from '@/server/services/crm/shared';
import { getLeadTimeline, type LeadTimelineEntry } from '@/server/services/crm/activities';

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Candidates are searched across the WHOLE organisation, not the caller's branch
 * scope. A duplicate that only the other branch can see is a duplicate the front
 * desk will happily create, so branch-narrowing here would defeat the feature. The
 * price is that the warning names a person outside the caller's scope, so the
 * returned shape carries a name and a status and nothing else — no phone, no email,
 * no branch.
 */
export async function findDuplicateMatches(
  ctx: AccessContext,
  db: Db,
  subject: DuplicateSubject,
  options: { readonly excludeLeadId?: string } = {},
): Promise<DuplicateMatch[]> {
  const phoneNormalized = subject.phone ? normalizePhone(subject.phone) : null;
  const emailNormalized = normalizeEmail(subject.email);
  const name = subject.firstName.trim();
  const lastName = subject.lastName?.trim() ?? null;

  const contactMatch: Prisma.LeadWhereInput[] = [];
  if (phoneNormalized) contactMatch.push({ phoneNormalized });
  if (emailNormalized) contactMatch.push({ emailNormalized });
  if (name !== '') {
    contactMatch.push({
      firstName: { equals: name, mode: 'insensitive' },
      ...(lastName
        ? { lastName: { equals: lastName, mode: 'insensitive' } }
        : { OR: [{ lastName: null }, { lastName: '' }] }),
    });
  }
  if (contactMatch.length === 0) return [];

  // Two queries, one per table, then scored in one pass. A per-candidate lookup
  // would be an N+1 on the hottest write in the CRM.
  const [leads, students] = await Promise.all([
    db.lead.findMany({
      where: {
        ...organizationFilter(ctx),
        deletedAt: null,
        duplicateOfLeadId: null,
        ...(options.excludeLeadId ? { id: { not: options.excludeLeadId } } : {}),
        OR: contactMatch,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNormalized: true,
        emailNormalized: true,
        status: true,
      },
      take: 50,
    }),
    db.student.findMany({
      where: {
        ...organizationFilter(ctx),
        deletedAt: null,
        OR: [
          ...(phoneNormalized ? [{ phoneNormalized }] : []),
          ...(emailNormalized ? [{ email: { equals: emailNormalized, mode: 'insensitive' as const } }] : []),
          ...(name !== ''
            ? [
                {
                  firstName: { equals: name, mode: 'insensitive' as const },
                  ...(lastName ? { lastName: { equals: lastName, mode: 'insensitive' as const } } : {}),
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNormalized: true,
        email: true,
        status: true,
      },
      take: 50,
    }),
  ]);

  const candidates: DuplicateCandidate[] = [
    ...leads.map((lead) => ({
      id: lead.id,
      kind: 'LEAD' as const,
      firstName: lead.firstName,
      lastName: lead.lastName,
      phoneNormalized: lead.phoneNormalized,
      emailNormalized: lead.emailNormalized,
      status: lead.status,
    })),
    ...students.map((student) => ({
      id: student.id,
      kind: 'STUDENT' as const,
      firstName: student.firstName,
      lastName: student.lastName,
      phoneNormalized: student.phoneNormalized,
      emailNormalized: student.email,
      status: student.status,
    })),
  ];

  return rankDuplicateMatches(subject, candidates);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateLeadInput {
  readonly firstName: string;
  readonly lastName?: string | null;
  readonly phone: string;
  readonly email?: string | null;
  readonly branchId?: string | null;
  readonly source?: LeadSource;
  readonly sourceDetail?: string | null;
  readonly priority?: LeadPriority;
  /** 0-100 qualification score maintained by sales. */
  readonly score?: number | null;
  readonly interestedProgramId?: string | null;
  readonly assignedToUserId?: string | null;
  readonly expectedValueMinor?: bigint | null;
  readonly currency?: string;
  readonly notes?: string | null;
  /**
   * Default true. `false` turns a duplicate into a 409 instead of a warning, for
   * an import or a public capture form where nobody is there to judge.
   */
  readonly allowDuplicate?: boolean;
}

export interface CreateLeadResult {
  readonly id: string;
  readonly status: LeadStatus;
  readonly branchId: string | null;
  /** Possible duplicates found at creation time. Informational. */
  readonly duplicateWarnings: readonly DuplicateMatch[];
}

function requireNormalizedPhone(phone: string): string {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new ValidationError([{ path: 'phone', message: 'Not a valid phone number' }]);
  }
  return normalized;
}

function assertScoreInRange(score: number | null | undefined): void {
  if (score == null) return;
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new BusinessRuleError(
      'lead.invalid_score',
      'A lead score must be a whole number between 0 and 100.',
    );
  }
}

export async function createLead(
  ctx: AccessContext,
  input: CreateLeadInput,
  db?: Db,
): Promise<CreateLeadResult> {
  requirePermission(ctx, 'leads.create');

  const firstName = input.firstName.trim();
  if (firstName === '') {
    throw new ValidationError([{ path: 'firstName', message: 'Required' }]);
  }
  assertScoreInRange(input.score);

  const phoneNormalized = requireNormalizedPhone(input.phone);
  const emailNormalized = normalizeEmail(input.email);
  const branchId = resolveLeadBranch(ctx, input.branchId);

  return withTransaction(
    async (tx) => {
      const { duplicateDetectionEnabled } = await getSettings(
        ['duplicateDetectionEnabled'],
        { organizationId: ctx.organizationId },
        tx,
      );

      const duplicateWarnings = duplicateDetectionEnabled
        ? await findDuplicateMatches(ctx, tx, {
            firstName,
            lastName: input.lastName,
            phone: input.phone,
            email: input.email,
          })
        : [];

      if (duplicateWarnings.length > 0 && input.allowDuplicate === false) {
        const fields = [...new Set(duplicateWarnings.flatMap((match) => match.matchedOn))].map(
          (field) => field.toLowerCase(),
        );
        throw new DuplicateError(
          'lead',
          fields,
          `This enquiry matches ${duplicateWarnings.length} existing record(s). Open the existing record, or save anyway.`,
        );
      }

      if (input.interestedProgramId) {
        const program = await tx.program.findFirst({
          where: { id: input.interestedProgramId, ...organizationFilter(ctx) },
          select: { id: true },
        });
        if (!program) throw new NotFoundError('Program', input.interestedProgramId);
      }

      const assignee = input.assignedToUserId
        ? await assertAssignableUser(ctx, tx, input.assignedToUserId)
        : null;

      // Only resolved when there is money to denominate; a lead with no expected
      // value must not acquire a currency that later contradicts its invoice.
      const currency =
        input.expectedValueMinor != null
          ? await currencyFor(
              { organizationId: ctx.organizationId, branchId, requested: input.currency },
              tx,
            )
          : null;

      const lead = await tx.lead.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          firstName,
          lastName: input.lastName?.trim() || null,
          phone: input.phone.trim(),
          phoneNormalized,
          email: input.email?.trim() || null,
          emailNormalized,
          source: input.source ?? 'OTHER',
          sourceDetail: input.sourceDetail ?? null,
          status: 'NEW',
          priority: input.priority ?? 'MEDIUM',
          score: input.score ?? null,
          interestedProgramId: input.interestedProgramId ?? null,
          assignedToUserId: assignee?.id ?? null,
          assignedAt: assignee ? new Date() : null,
          expectedValueMinor: input.expectedValueMinor ?? null,
          currency,
          notes: input.notes ?? null,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: { id: true, status: true, branchId: true, createdAt: true },
      });

      // The funnel counts stage ENTRIES from LeadStatusHistory, so the arrival at
      // NEW has to be a row like any other transition; without it every lead would
      // be missing from the top of the funnel.
      await tx.leadStatusHistory.create({
        data: {
          leadId: lead.id,
          fromStatus: null,
          toStatus: 'NEW',
          reason: input.sourceDetail ?? null,
          changedById: ctx.isSystem ? null : ctx.userId,
          changedAt: lead.createdAt,
        },
      });

      if (assignee) {
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'ASSIGNMENT',
            subject: `Assigned to ${assignee.firstName} ${assignee.lastName}`,
            occurredAt: lead.createdAt,
            createdById: ctx.isSystem ? null : ctx.userId,
          },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAD_CREATED,
          entityType: 'Lead',
          entityId: lead.id,
          branchId: lead.branchId,
          summary: `Lead ${leadDisplayName({ firstName, lastName: input.lastName })} captured from ${input.source ?? 'OTHER'}`,
          metadata: {
            source: input.source ?? 'OTHER',
            duplicateMatches: duplicateWarnings.length,
          },
          timeline: {
            subjectType: 'LEAD',
            subjectId: lead.id,
            type: 'lead.created',
            title: 'Lead created',
            description: input.sourceDetail ?? null,
            occurredAt: lead.createdAt,
          },
        },
        tx,
      );

      return {
        id: lead.id,
        status: lead.status,
        branchId: lead.branchId,
        duplicateWarnings,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateLeadInput {
  readonly firstName?: string;
  readonly lastName?: string | null;
  readonly phone?: string;
  readonly email?: string | null;
  readonly source?: LeadSource;
  readonly sourceDetail?: string | null;
  readonly priority?: LeadPriority;
  readonly score?: number | null;
  readonly interestedProgramId?: string | null;
  readonly expectedValueMinor?: bigint | null;
  readonly currency?: string;
  readonly notes?: string | null;
  readonly branchId?: string | null;
}

/**
 * Edit a lead's details. Not its status, not its owner: those are
 * `changeLeadStatus` and `assignLead`, which leave a trail this does not.
 */
export async function updateLead(
  ctx: AccessContext,
  leadId: string,
  input: UpdateLeadInput,
  db?: Db,
): Promise<{ id: string }> {
  requirePermission(ctx, 'leads.edit');
  assertScoreInRange(input.score);

  return withTransaction(
    async (tx) => {
      const existing = await loadLeadForWrite(ctx, tx, leadId);
      if (existing.convertedAt) {
        throw new BusinessRuleError(
          'lead.already_converted',
          'This lead has been converted into a student. Edit the student record instead.',
        );
      }

      const data: Prisma.LeadUpdateInput = {};
      // Kept as locals as well as in `data`, so the audit diff compares values rather
      // than Prisma's update operations.
      let nextFirstName: string | undefined;
      let nextLastName: string | null | undefined;
      let nextPhoneNormalized: string | undefined;
      let nextEmailNormalized: string | null | undefined;

      if (input.firstName !== undefined) {
        nextFirstName = input.firstName.trim();
        if (nextFirstName === '') {
          throw new ValidationError([{ path: 'firstName', message: 'Required' }]);
        }
        data.firstName = nextFirstName;
      }
      if (input.lastName !== undefined) {
        nextLastName = input.lastName?.trim() || null;
        data.lastName = nextLastName;
      }

      if (input.phone !== undefined) {
        nextPhoneNormalized = requireNormalizedPhone(input.phone);
        data.phone = input.phone.trim();
        data.phoneNormalized = nextPhoneNormalized;
      }
      if (input.email !== undefined) {
        nextEmailNormalized = normalizeEmail(input.email);
        data.email = input.email?.trim() || null;
        data.emailNormalized = nextEmailNormalized;
      }

      if (input.source !== undefined) data.source = input.source;
      if (input.sourceDetail !== undefined) data.sourceDetail = input.sourceDetail;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.score !== undefined) data.score = input.score;
      if (input.notes !== undefined) data.notes = input.notes;

      if (input.interestedProgramId !== undefined) {
        if (input.interestedProgramId) {
          const program = await tx.program.findFirst({
            where: { id: input.interestedProgramId, ...organizationFilter(ctx) },
            select: { id: true },
          });
          if (!program) throw new NotFoundError('Program', input.interestedProgramId);
        }
        data.interestedProgram = input.interestedProgramId
          ? { connect: { id: input.interestedProgramId } }
          : { disconnect: true };
      }

      let branchId = existing.branchId;
      if (input.branchId !== undefined) {
        branchId = resolveLeadBranch(ctx, input.branchId);
        data.branch = branchId ? { connect: { id: branchId } } : { disconnect: true };
      }

      if (input.expectedValueMinor !== undefined) {
        if (input.expectedValueMinor != null && input.expectedValueMinor < 0n) {
          throw new BusinessRuleError(
            'lead.negative_expected_value',
            'An expected deal value cannot be negative.',
          );
        }
        data.expectedValueMinor = input.expectedValueMinor;
        data.currency =
          input.expectedValueMinor == null
            ? null
            : await currencyFor(
                { organizationId: ctx.organizationId, branchId, requested: input.currency },
                tx,
              );
      }

      await tx.lead.update({ where: { id: existing.id }, data });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAD_UPDATED,
          entityType: 'Lead',
          entityId: existing.id,
          branchId,
          summary: `Lead ${leadDisplayName(existing)} updated`,
          changes: diffFields(
            {
              firstName: existing.firstName,
              lastName: existing.lastName,
              phoneNormalized: existing.phoneNormalized,
              emailNormalized: existing.emailNormalized,
              branchId: existing.branchId,
            },
            {
              firstName: nextFirstName,
              lastName: nextLastName,
              phoneNormalized: nextPhoneNormalized,
              emailNormalized: nextEmailNormalized,
              branchId: input.branchId === undefined ? undefined : branchId,
            },
          ),
        },
        tx,
      );

      return { id: existing.id };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------

/**
 * Hand a lead to an agent.
 *
 * Writes a `LeadActivity` so the handover is visible on the lead's timeline, and
 * audits it, but deliberately does NOT write a `LeadStatusHistory` row: the status
 * has not changed, and a from == to row would make `getConversionFunnel` count the
 * stage twice. Ownership history lives in the activity trail and the audit log.
 */
export async function assignLead(
  ctx: AccessContext,
  input: {
    readonly leadId: string;
    /** null un-assigns, returning the lead to the pool. */
    readonly assignedToUserId: string | null;
    readonly reason?: string | null;
  },
  db?: Db,
): Promise<{ id: string; assignedToUserId: string | null }> {
  requirePermission(ctx, 'leads.assign');

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);
      if (lead.assignedToUserId === input.assignedToUserId) {
        throw new BusinessRuleError(
          'lead.already_assigned',
          'This lead is already assigned to that user.',
        );
      }

      const assignee = input.assignedToUserId
        ? await assertAssignableUser(ctx, tx, input.assignedToUserId)
        : null;

      const now = new Date();
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          assignedToUserId: assignee?.id ?? null,
          assignedAt: assignee ? now : null,
        },
      });

      const label = assignee
        ? `Assigned to ${assignee.firstName} ${assignee.lastName}`
        : 'Returned to the unassigned pool';

      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          type: 'ASSIGNMENT',
          subject: label,
          body: input.reason ?? null,
          occurredAt: now,
          createdById: ctx.isSystem ? null : ctx.userId,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAD_ASSIGNED,
          entityType: 'Lead',
          entityId: lead.id,
          branchId: lead.branchId,
          summary: `${leadDisplayName(lead)}: ${label}`,
          reason: input.reason ?? null,
          changes: {
            assignedToUserId: { from: lead.assignedToUserId, to: assignee?.id ?? null },
          },
          timeline: {
            subjectType: 'LEAD',
            subjectId: lead.id,
            type: 'lead.assigned',
            title: label,
            description: input.reason ?? null,
            occurredAt: now,
          },
        },
        tx,
      );

      return { id: lead.id, assignedToUserId: assignee?.id ?? null };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Move a lead along the pipeline.
 *
 * ENROLLED is refused here on purpose: a lead is only enrolled once a `Student` row
 * exists, and `convertLeadToStudent` is what creates it. Allowing the status to be
 * set by hand would produce leads that claim to have enrolled nobody. LOST is
 * delegated to `markLeadLost`, which insists on a reason.
 */
export async function changeLeadStatus(
  ctx: AccessContext,
  input: {
    readonly leadId: string;
    readonly toStatus: LeadStatus;
    readonly reason?: string | null;
  },
  db?: Db,
): Promise<{ id: string; status: LeadStatus }> {
  requirePermission(ctx, 'leads.edit');

  if (input.toStatus === 'ENROLLED') {
    throw new BusinessRuleError(
      'lead.enrol_via_conversion',
      'A lead becomes ENROLLED by being converted into a student. Use the conversion flow.',
    );
  }

  if (input.toStatus === 'LOST') {
    if (!input.reason || input.reason.trim() === '') {
      throw new BusinessRuleError(
        'lead.lost_reason_required',
        'Say why the lead was lost — the reason is what makes the loss report useful.',
      );
    }
    const lost = await markLeadLost(
      ctx,
      { leadId: input.leadId, reason: input.reason },
      db,
    );
    return { id: lost.id, status: lost.status };
  }

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);
      await applyLeadStatusChange(ctx, tx, lead, {
        toStatus: input.toStatus,
        reason: input.reason ?? null,
        extraData:
          // Re-engaging a lost lead clears the loss, otherwise the loss report keeps
          // counting a lead that is back in play.
          lead.status === 'LOST' || lead.status === 'CLOSED'
            ? { lostAt: null, lostReason: null }
            : undefined,
      });
      return { id: lead.id, status: input.toStatus };
    },
    { existing: db },
  );
}

export async function markLeadLost(
  ctx: AccessContext,
  input: {
    readonly leadId: string;
    readonly reason: string;
    readonly lostAt?: Date;
  },
  db?: Db,
): Promise<{ id: string; status: LeadStatus; cancelledFollowUps: number }> {
  requirePermission(ctx, 'leads.edit');

  const reason = input.reason.trim();
  if (reason === '') {
    throw new BusinessRuleError(
      'lead.lost_reason_required',
      'Say why the lead was lost — the reason is what makes the loss report useful.',
    );
  }

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);
      const lostAt = input.lostAt ?? new Date();

      await applyLeadStatusChange(ctx, tx, lead, {
        toStatus: 'LOST',
        reason,
        auditAction: AUDIT_ACTIONS.LEAD_LOST,
        severity: 'NOTICE',
        occurredAt: lostAt,
        extraData: { lostAt, lostReason: reason },
      });

      const cancelledFollowUps = await cancelOpenFollowUps(
        tx,
        lead.id,
        `Lead marked lost: ${reason}`,
      );

      return { id: lead.id, status: 'LOST' as LeadStatus, cancelledFollowUps };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Fold a duplicate lead into the one being kept.
 *
 * The duplicate is NOT deleted. It keeps its own status history and points at the
 * survivor through `duplicateOfLeadId`, so "we talked to this person twice and
 * merged the records" stays answerable. What moves is the work: activities and
 * follow-up tasks, because those are what an agent needs in one place.
 */
export async function mergeLeads(
  ctx: AccessContext,
  input: {
    readonly survivorId: string;
    readonly duplicateId: string;
    readonly reason?: string | null;
  },
  db?: Db,
): Promise<{
  survivorId: string;
  duplicateId: string;
  movedActivities: number;
  movedFollowUps: number;
}> {
  requirePermission(ctx, 'leads.merge');

  if (input.survivorId === input.duplicateId) {
    throw new BusinessRuleError('lead.merge_into_self', 'A lead cannot be merged into itself.');
  }

  return withTransaction(
    async (tx) => {
      const survivor = await loadLeadForWrite(ctx, tx, input.survivorId);
      const duplicate = await loadLeadForWrite(ctx, tx, input.duplicateId);

      if (duplicate.convertedAt) {
        throw new BusinessRuleError(
          'lead.merge_converted',
          'This lead has already become a student, so it is not a duplicate to fold away. Merge the other one instead.',
        );
      }
      // Merging a chain (A -> B, then B -> C) would leave A pointing at a lead that
      // is itself a duplicate, and no screen walks that chain.
      if (survivor.duplicateOfLeadId) {
        throw new ConflictError(
          'The lead you are merging into has itself been merged away. Merge into the surviving lead instead.',
          { details: { survivorId: survivor.id, mergedInto: survivor.duplicateOfLeadId } },
        );
      }
      if (duplicate.duplicateOfLeadId) {
        throw new ConflictError('That lead has already been merged into another one.', {
          details: { duplicateId: duplicate.id, mergedInto: duplicate.duplicateOfLeadId },
        });
      }

      const now = new Date();
      const [activities, followUps] = await Promise.all([
        tx.leadActivity.updateMany({
          where: { leadId: duplicate.id },
          data: { leadId: survivor.id },
        }),
        tx.followUpTask.updateMany({
          where: { leadId: duplicate.id },
          data: { leadId: survivor.id },
        }),
      ]);

      await tx.lead.update({
        where: { id: duplicate.id },
        data: { duplicateOfLeadId: survivor.id },
      });

      // CLOSED rather than LOST: the enquiry was not lost to a competitor, the record
      // was administratively folded away. A duplicate that someone had already closed
      // stays as it is — the merge is recorded by `duplicateOfLeadId` and the activity
      // below, and forcing CLOSED -> CLOSED through the validator would fail.
      if (isLeadTransitionAllowed(duplicate.status, 'CLOSED')) {
        await applyLeadStatusChange(ctx, tx, duplicate, {
          toStatus: 'CLOSED',
          reason: input.reason ?? `Merged into ${leadDisplayName(survivor)}`,
          auditAction: AUDIT_ACTIONS.LEAD_MERGED,
          severity: 'NOTICE',
          occurredAt: now,
        });
      }

      await tx.leadActivity.create({
        data: {
          leadId: survivor.id,
          type: 'NOTE',
          subject: `Merged duplicate ${leadDisplayName(duplicate)}`,
          body: input.reason ?? null,
          occurredAt: now,
          createdById: ctx.isSystem ? null : ctx.userId,
          metadata: { mergedLeadId: duplicate.id },
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.LEAD_MERGED,
          entityType: 'Lead',
          entityId: survivor.id,
          branchId: survivor.branchId,
          summary: `${leadDisplayName(duplicate)} merged into ${leadDisplayName(survivor)}`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          metadata: {
            duplicateLeadId: duplicate.id,
            movedActivities: activities.count,
            movedFollowUps: followUps.count,
          },
          timeline: {
            subjectType: 'LEAD',
            subjectId: survivor.id,
            type: 'lead.merged',
            title: `Merged duplicate ${leadDisplayName(duplicate)}`,
            description: input.reason ?? null,
            occurredAt: now,
          },
        },
        tx,
      );

      // Both ends: the survivor may have inherited an earlier task, and the duplicate
      // has none left to point at.
      await recomputeLeadNextFollowUp(tx, survivor.id);
      await recomputeLeadNextFollowUp(tx, duplicate.id);

      return {
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        movedActivities: activities.count,
        movedFollowUps: followUps.count,
      };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/**
 * Soft delete. Archive rather than delete, so the funnel and the source-performance
 * report for last quarter do not change shape when someone tidies up this quarter's
 * junk enquiries.
 */
export async function archiveLead(
  ctx: AccessContext,
  input: { readonly leadId: string; readonly reason?: string | null },
  db?: Db,
): Promise<{ id: string; deletedAt: Date }> {
  requirePermission(ctx, 'leads.delete');

  return withTransaction(
    async (tx) => {
      const lead = await loadLeadForWrite(ctx, tx, input.leadId);
      if (lead.convertedAt) {
        throw new BusinessRuleError(
          'lead.archive_converted',
          'This lead became a student, so archiving it would cut the student off from where they came from.',
        );
      }

      const deletedAt = new Date();
      await tx.lead.update({ where: { id: lead.id }, data: { deletedAt } });
      await cancelOpenFollowUps(tx, lead.id, input.reason ?? 'Lead archived');

      await recordAudit(
        ctx,
        {
          action: 'lead.archived',
          entityType: 'Lead',
          entityId: lead.id,
          branchId: lead.branchId,
          summary: `Lead ${leadDisplayName(lead)} archived`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          timeline: {
            subjectType: 'LEAD',
            subjectId: lead.id,
            type: 'lead.archived',
            title: 'Lead archived',
            description: input.reason ?? null,
            occurredAt: deletedAt,
          },
        },
        tx,
      );

      return { id: lead.id, deletedAt };
    },
    { existing: db },
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type LeadSortField =
  | 'createdAt'
  | 'updatedAt'
  | 'nextFollowUpAt'
  | 'lastContactedAt'
  | 'score'
  | 'priority';

export interface ListLeadsInput {
  readonly page?: number;
  readonly pageSize?: number;
  /** Free text over name, phone and email. */
  readonly q?: string | null;
  readonly status?: readonly LeadStatus[];
  readonly source?: readonly LeadSource[];
  readonly priority?: readonly LeadPriority[];
  readonly assignedToUserId?: string | null;
  readonly unassignedOnly?: boolean;
  readonly branchId?: string | null;
  readonly interestedProgramId?: string | null;
  /** Created-at range, as calendar days in the organisation timezone. */
  readonly from?: DateOnly | null;
  readonly to?: DateOnly | null;
  readonly includeArchived?: boolean;
  readonly includeMerged?: boolean;
  readonly sortBy?: LeadSortField;
  readonly sortDir?: 'asc' | 'desc';
}

export interface LeadListRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly phone: string;
  readonly email: string | null;
  readonly status: LeadStatus;
  readonly source: LeadSource;
  readonly priority: LeadPriority;
  readonly score: number | null;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly assignedToUserId: string | null;
  readonly assignedToName: string | null;
  readonly interestedProgramName: string | null;
  readonly expectedValueMinor: bigint | null;
  readonly currency: string | null;
  readonly nextFollowUpAt: Date | null;
  readonly lastContactedAt: Date | null;
  readonly convertedStudentId: string | null;
  readonly duplicateOfLeadId: string | null;
  readonly activityCount: number;
  readonly createdAt: Date;
}

export interface ListLeadsResult {
  readonly rows: readonly LeadListRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * A free-text term resolves to a bounded id set first.
 *
 * The name index is `gin (search_normalize(firstName || ' ' || lastName))`, so only
 * a predicate written against that exact expression can use it — which Prisma's
 * `contains` cannot express. Matching the expression in one small raw query and
 * then filtering on `id in (...)` keeps the search index-backed instead of degrading
 * into a sequential scan on every keystroke.
 */
const SEARCH_CANDIDATE_CAP = 5_000;

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function resolveSearchIds(db: Db, organizationId: string, term: string): Promise<string[]> {
  const asPhone = normalizePhone(term);
  if (asPhone) {
    // A complete phone number: a prefix match on the normalised column, which the
    // (organizationId, phoneNormalized) btree serves directly.
    const rows = await db.lead.findMany({
      where: { organizationId, phoneNormalized: { startsWith: asPhone } },
      select: { id: true },
      take: SEARCH_CANDIDATE_CAP,
    });
    return rows.map((row) => row.id);
  }

  const pattern = `%${escapeLikePattern(term)}%`;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    select "id"
    from "leads"
    where "organizationId" = ${organizationId}
      and (
        "search_normalize"("firstName" || ' ' || coalesce("lastName", ''))
          like "search_normalize"(${pattern})
        or "phoneNormalized" like ${pattern}
        or coalesce("emailNormalized", '') like ${pattern}
      )
    limit ${SEARCH_CANDIDATE_CAP}
  `;
  return rows.map((row) => row.id);
}

function leadOrderBy(
  sortBy: LeadSortField,
  sortDir: 'asc' | 'desc',
): Prisma.LeadOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'nextFollowUpAt':
      // Nulls last in both directions: a lead with no follow-up scheduled is not
      // the most urgent thing on the screen.
      return [{ nextFollowUpAt: { sort: sortDir, nulls: 'last' } }, { createdAt: 'desc' }];
    case 'lastContactedAt':
      return [{ lastContactedAt: { sort: sortDir, nulls: 'last' } }, { createdAt: 'desc' }];
    case 'score':
      return [{ score: { sort: sortDir, nulls: 'last' } }, { createdAt: 'desc' }];
    case 'priority':
      // The enum is declared LOW..URGENT, so `desc` is most urgent first.
      return [{ priority: sortDir }, { createdAt: 'desc' }];
    case 'updatedAt':
      return [{ updatedAt: sortDir }, { id: 'desc' }];
    default:
      return [{ createdAt: sortDir }, { id: sortDir }];
  }
}

export async function listLeads(
  ctx: AccessContext,
  input: ListLeadsInput = {},
  db?: Db,
): Promise<ListLeadsResult> {
  requirePermission(ctx, 'leads.view');

  const client = db ?? prisma;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  // Archived leads are visible to whoever may archive them, and to nobody else: a
  // soft-deleted record should not reappear in an agent's list.
  if (input.includeArchived) requirePermission(ctx, 'leads.delete');

  const scoped = await leadReadFilter(ctx, client, {
    includeArchived: input.includeArchived ?? false,
  });

  const filters: Prisma.LeadWhereInput[] = [scoped];

  if (input.status && input.status.length > 0) filters.push({ status: { in: [...input.status] } });
  if (input.source && input.source.length > 0) filters.push({ source: { in: [...input.source] } });
  if (input.priority && input.priority.length > 0) {
    filters.push({ priority: { in: [...input.priority] } });
  }
  if (input.unassignedOnly) {
    filters.push({ assignedToUserId: null });
  } else if (input.assignedToUserId) {
    filters.push({ assignedToUserId: input.assignedToUserId });
  }
  if (input.branchId) {
    // Verified, not merely intersected with the scope: asking for a branch the
    // caller cannot see is a 403, not an empty list that looks like "no leads yet".
    assertBranchAccess(ctx, input.branchId, 'lead');
    filters.push({ branchId: input.branchId });
  }
  if (input.interestedProgramId) {
    filters.push({ interestedProgramId: input.interestedProgramId });
  }
  if (!input.includeMerged) filters.push({ duplicateOfLeadId: null });

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

  const term = input.q?.trim();
  if (term) {
    const ids = await resolveSearchIds(client, ctx.organizationId, term);
    if (ids.length === 0) return { rows: [], total: 0, page, pageSize };
    filters.push({ id: { in: ids } });
  }

  const where: Prisma.LeadWhereInput = { AND: filters };

  const [total, rows] = await Promise.all([
    client.lead.count({ where }),
    client.lead.findMany({
      where,
      orderBy: leadOrderBy(input.sortBy ?? 'createdAt', input.sortDir ?? 'desc'),
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        status: true,
        source: true,
        priority: true,
        score: true,
        branchId: true,
        assignedToUserId: true,
        expectedValueMinor: true,
        currency: true,
        nextFollowUpAt: true,
        lastContactedAt: true,
        duplicateOfLeadId: true,
        createdAt: true,
        branch: { select: { name: true } },
        assignedToUser: { select: { firstName: true, lastName: true } },
        interestedProgram: { select: { name: true } },
        convertedStudent: { select: { id: true } },
        _count: { select: { activities: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    rows: rows.map((row) => ({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      email: row.email,
      status: row.status,
      source: row.source,
      priority: row.priority,
      score: row.score,
      branchId: row.branchId,
      branchName: row.branch?.name ?? null,
      assignedToUserId: row.assignedToUserId,
      assignedToName: row.assignedToUser
        ? `${row.assignedToUser.firstName} ${row.assignedToUser.lastName}`
        : null,
      interestedProgramName: row.interestedProgram?.name ?? null,
      expectedValueMinor: row.expectedValueMinor,
      currency: row.currency,
      nextFollowUpAt: row.nextFollowUpAt,
      lastContactedAt: row.lastContactedAt,
      convertedStudentId: row.convertedStudent?.id ?? null,
      duplicateOfLeadId: row.duplicateOfLeadId,
      activityCount: row._count.activities,
      createdAt: row.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface LeadDetail extends LeadListRow {
  readonly sourceDetail: string | null;
  readonly notes: string | null;
  readonly lostReason: string | null;
  readonly lostAt: Date | null;
  readonly convertedAt: Date | null;
  readonly assignedAt: Date | null;
  readonly interestedProgramId: string | null;
  readonly createdByName: string | null;
  readonly deletedAt: Date | null;
  readonly openFollowUpCount: number;
  readonly trialLessons: ReadonlyArray<{
    readonly id: string;
    readonly scheduledAt: Date;
    readonly status: string;
    readonly groupName: string | null;
    readonly recommendedLevel: string | null;
    readonly feedback: string | null;
  }>;
  readonly timeline: readonly LeadTimelineEntry[];
}

export async function getLead(
  ctx: AccessContext,
  leadId: string,
  db?: Db,
): Promise<LeadDetail> {
  requirePermission(ctx, 'leads.view');

  const client = db ?? prisma;
  // Same rule as the list: an archived lead is only reachable by someone who may
  // archive one, so a stale bookmark does not resurrect a deleted record.
  const scoped = await leadReadFilter(ctx, client, {
    includeArchived: can(ctx, 'leads.delete'),
  });

  const lead = await client.lead.findFirst({
    where: { ...scoped, id: leadId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      status: true,
      source: true,
      sourceDetail: true,
      priority: true,
      score: true,
      branchId: true,
      assignedToUserId: true,
      assignedAt: true,
      expectedValueMinor: true,
      currency: true,
      notes: true,
      nextFollowUpAt: true,
      lastContactedAt: true,
      lostReason: true,
      lostAt: true,
      convertedAt: true,
      duplicateOfLeadId: true,
      interestedProgramId: true,
      deletedAt: true,
      createdAt: true,
      branch: { select: { name: true } },
      assignedToUser: { select: { firstName: true, lastName: true } },
      createdBy: { select: { firstName: true, lastName: true } },
      interestedProgram: { select: { name: true } },
      convertedStudent: { select: { id: true } },
      trialLessons: {
        orderBy: { scheduledAt: 'desc' },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          recommendedLevel: true,
          feedback: true,
          group: { select: { name: true } },
        },
      },
      _count: { select: { activities: true, followUpTasks: { where: { status: 'OPEN' } } } },
    },
  });
  if (!lead) throw new NotFoundError('Lead', leadId);

  const timeline = await getLeadTimeline(ctx, { leadId: lead.id }, client);

  return {
    id: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    email: lead.email,
    status: lead.status,
    source: lead.source,
    sourceDetail: lead.sourceDetail,
    priority: lead.priority,
    score: lead.score,
    branchId: lead.branchId,
    branchName: lead.branch?.name ?? null,
    assignedToUserId: lead.assignedToUserId,
    assignedToName: lead.assignedToUser
      ? `${lead.assignedToUser.firstName} ${lead.assignedToUser.lastName}`
      : null,
    assignedAt: lead.assignedAt,
    interestedProgramId: lead.interestedProgramId,
    interestedProgramName: lead.interestedProgram?.name ?? null,
    expectedValueMinor: lead.expectedValueMinor,
    currency: lead.currency,
    notes: lead.notes,
    nextFollowUpAt: lead.nextFollowUpAt,
    lastContactedAt: lead.lastContactedAt,
    lostReason: lead.lostReason,
    lostAt: lead.lostAt,
    convertedAt: lead.convertedAt,
    convertedStudentId: lead.convertedStudent?.id ?? null,
    duplicateOfLeadId: lead.duplicateOfLeadId,
    createdByName: lead.createdBy
      ? `${lead.createdBy.firstName} ${lead.createdBy.lastName}`
      : null,
    deletedAt: lead.deletedAt,
    activityCount: lead._count.activities,
    openFollowUpCount: lead._count.followUpTasks,
    createdAt: lead.createdAt,
    trialLessons: lead.trialLessons.map((trial) => ({
      id: trial.id,
      scheduledAt: trial.scheduledAt,
      status: trial.status,
      groupName: trial.group?.name ?? null,
      recommendedLevel: trial.recommendedLevel,
      feedback: trial.feedback,
    })),
    timeline,
  };
}
