/**
 * Turning "the guardians of this student" into rows with addresses.
 *
 * Shared by ./enqueue.ts (which needs the address to decide whether a channel is
 * usable at all) and ./dispatch.ts (which needs it again at send time, because a
 * Notification row deliberately stores the recipient POINTER and not the phone
 * number -- a number changed between enqueue and send should send to the new one,
 * and an outbox table full of contact details is a contact dump waiting to leak).
 *
 * Every query here is filtered by `organizationId`. A notification is a side
 * effect of an already-authorised action, so these functions do not re-check a
 * permission -- but tenancy is not authorisation, and there is no code path that
 * reads a recipient without it.
 */

import type { Locale, NotificationChannel } from '@/generated/prisma/client';
import { prisma, type Db } from '@/server/db/client';
import type { PermissionKey } from '@/server/rbac/permissions';

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export type RecipientSelector =
  /** A staff, teacher, student-portal or parent-portal login. */
  | { readonly kind: 'USER'; readonly userId: string }
  /** One guardian row, whether or not it has a portal login. */
  | { readonly kind: 'GUARDIAN'; readonly guardianId: string }
  /** The student themselves: their portal account if they have one, else their own phone. */
  | { readonly kind: 'STUDENT'; readonly studentId: string }
  /** Every guardian of a student whose link has `receivesNotifications`. */
  | { readonly kind: 'GUARDIANS_OF_STUDENT'; readonly studentId: string }
  /**
   * Everyone holding a permission, optionally narrowed to one branch. Resolved
   * through the role -> permission join, so adding the permission to a role is
   * enough to put a person on the distribution list.
   */
  | {
      readonly kind: 'STAFF_WITH_PERMISSION';
      readonly permission: PermissionKey;
      readonly branchId?: string | null;
    }
  /**
   * A phone number or email address with no row behind it: a lead awaiting a
   * trial reminder, an applicant who is not yet a student. The call site owns the
   * address, so it also owns having obtained it lawfully.
   */
  | {
      readonly kind: 'ADDRESS';
      readonly channel: NotificationChannel;
      readonly address: string;
      readonly displayName: string;
      readonly locale?: Locale | null;
    };

/** Which recipient column on Notification a row sets. Exactly one is ever set. */
export type RecipientPointer = 'USER' | 'GUARDIAN' | 'STUDENT';

export interface ResolvedRecipient {
  /** Stable identity for deduplication across overlapping selectors. */
  readonly key: string;
  readonly displayName: string;
  readonly locale: Locale | null;
  /** Present when the recipient can sign in; required for IN_APP. */
  readonly userId: string | null;
  readonly guardianId: string | null;
  readonly studentId: string | null;
  /** Address per channel. An absent entry means the channel cannot reach them. */
  readonly addresses: Readonly<Partial<Record<NotificationChannel, string>>>;
}

// ---------------------------------------------------------------------------
// Channel addressing
// ---------------------------------------------------------------------------

/**
 * Channels with no stored address, and why.
 *
 * TELEGRAM needs a chat id the user grants by starting a conversation with the
 * bot, and PUSH needs a per-device token. Neither has a column in the schema yet,
 * so neither can be addressed. They are left in `NotificationChannel` because the
 * enum is the delivery vocabulary, and a channel that silently degrades to "no
 * address" and gets skipped is honest; inventing an address would not be.
 */
export const UNADDRESSABLE_CHANNELS: ReadonlySet<NotificationChannel> = new Set<NotificationChannel>(
  ['TELEGRAM', 'PUSH'],
);

interface AddressableFields {
  readonly userId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

function buildAddresses(
  fields: AddressableFields,
): Readonly<Partial<Record<NotificationChannel, string>>> {
  const addresses: Partial<Record<NotificationChannel, string>> = {};
  // The "address" for an in-app notification is the account that will read it:
  // there is no wire, only a row the portal queries by recipientUserId.
  if (fields.userId) addresses.IN_APP = fields.userId;
  if (fields.email) addresses.EMAIL = fields.email;
  if (fields.phone) {
    addresses.SMS = fields.phone;
    // WhatsApp Cloud API addresses a recipient by their phone number, so the
    // same value serves both. Whether the number is actually registered with
    // WhatsApp is the provider's answer, not ours.
    addresses.WHATSAPP = fields.phone;
  }
  return addresses;
}

export function channelAddress(
  recipient: ResolvedRecipient,
  channel: NotificationChannel,
): string | null {
  return recipient.addresses[channel] ?? null;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * Reduce an address to the least that still lets a person reconcile a delivery
 * with a complaint. CommunicationLog is a high-volume table that support staff
 * and exports read freely; storing full contact details there would turn the
 * send log into a second, less protected copy of the contact database.
 */
export function maskAddress(channel: NotificationChannel, address: string): string {
  if (channel === 'IN_APP') return 'in-app';
  if (channel === 'EMAIL') return maskEmail(address);
  return maskPhone(address);
}

function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6) return '*'.repeat(Math.max(digits.length, 3));
  const prefix = value.startsWith('+') ? '+' : '';
  const head = digits.slice(0, 5);
  const tail = digits.slice(-4);
  return `${prefix}${head}${'*'.repeat(Math.max(digits.length - 9, 1))}${tail}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  phoneNormalized: true,
  locale: true,
} as const;

/**
 * Expand selectors into concrete recipients, deduplicated.
 *
 * Deduplication is by identity, not by selector: a head teacher who is both the
 * assigned user and a member of the permission audience must receive one message.
 */
export async function resolveRecipients(
  scope: { readonly organizationId: string },
  selectors: readonly RecipientSelector[],
  db: Db = prisma,
): Promise<readonly ResolvedRecipient[]> {
  const byKey = new Map<string, ResolvedRecipient>();
  const add = (recipient: ResolvedRecipient): void => {
    if (!byKey.has(recipient.key)) byKey.set(recipient.key, recipient);
  };

  const userIds = new Set<string>();
  const guardianIds = new Set<string>();
  const studentIds = new Set<string>();
  const guardiansOfStudents = new Set<string>();
  const permissionAudiences: { permission: string; branchId?: string | null }[] = [];

  for (const selector of selectors) {
    switch (selector.kind) {
      case 'USER':
        userIds.add(selector.userId);
        break;
      case 'GUARDIAN':
        guardianIds.add(selector.guardianId);
        break;
      case 'STUDENT':
        studentIds.add(selector.studentId);
        break;
      case 'GUARDIANS_OF_STUDENT':
        guardiansOfStudents.add(selector.studentId);
        break;
      case 'STAFF_WITH_PERMISSION':
        permissionAudiences.push({
          permission: selector.permission,
          branchId: selector.branchId ?? null,
        });
        break;
      case 'ADDRESS':
        add({
          key: `address:${selector.channel}:${selector.address}`,
          displayName: selector.displayName,
          locale: selector.locale ?? null,
          userId: null,
          guardianId: null,
          studentId: null,
          addresses: { [selector.channel]: selector.address },
        });
        break;
    }
  }

  if (guardiansOfStudents.size > 0) {
    const links = await db.studentGuardian.findMany({
      where: {
        studentId: { in: [...guardiansOfStudents] },
        // The link, not the guardian row, carries the opt-out: a father who
        // wants no messages about one child may still want them about another.
        receivesNotifications: true,
        guardian: { organizationId: scope.organizationId, deletedAt: null },
      },
      select: { guardianId: true },
    });
    for (const link of links) guardianIds.add(link.guardianId);
  }

  if (userIds.size > 0) {
    const users = await db.user.findMany({
      where: {
        id: { in: [...userIds] },
        organizationId: scope.organizationId,
        deletedAt: null,
        // A deactivated or suspended account is not a place to send anything:
        // the person may have left the organisation.
        status: { in: ['ACTIVE', 'INVITED'] },
      },
      select: USER_SELECT,
    });
    for (const user of users) add(fromUser(user));
  }

  if (guardianIds.size > 0) {
    const guardians = await db.guardian.findMany({
      where: {
        id: { in: [...guardianIds] },
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        phoneNormalized: true,
        email: true,
        preferredLocale: true,
        userId: true,
      },
    });
    for (const guardian of guardians) {
      add({
        key: `guardian:${guardian.id}`,
        displayName: `${guardian.firstName} ${guardian.lastName}`.trim(),
        locale: guardian.preferredLocale,
        userId: guardian.userId,
        guardianId: guardian.id,
        studentId: null,
        addresses: buildAddresses({
          userId: guardian.userId,
          email: guardian.email,
          phone: guardian.phoneNormalized ?? guardian.phone,
        }),
      });
    }
  }

  if (studentIds.size > 0) {
    const students = await db.student.findMany({
      where: {
        id: { in: [...studentIds] },
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        phoneNormalized: true,
        email: true,
        user: { select: USER_SELECT },
      },
    });
    for (const student of students) {
      // A student with a portal login is addressed as that login, so the message
      // lands in the feed they actually open. Without one, the student row's own
      // phone and email are the only way to reach them.
      const user = student.user;
      add({
        key: `student:${student.id}`,
        displayName: `${student.firstName} ${student.lastName}`.trim(),
        locale: user?.locale ?? null,
        userId: user?.id ?? null,
        guardianId: null,
        studentId: student.id,
        addresses: buildAddresses({
          userId: user?.id ?? null,
          email: user?.email ?? student.email,
          phone: user?.phoneNormalized ?? user?.phone ?? student.phoneNormalized ?? student.phone,
        }),
      });
    }
  }

  for (const audience of permissionAudiences) {
    const users = await db.user.findMany({
      where: {
        organizationId: scope.organizationId,
        deletedAt: null,
        status: 'ACTIVE',
        userRoles: {
          some: {
            // An expired grant confers nothing, so it must not put someone on a
            // distribution list either.
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            role: {
              deletedAt: null,
              permissions: { some: { permission: { key: audience.permission } } },
            },
            ...(audience.branchId
              ? // A role granted for one branch only hears about that branch;
                // an organisation-wide grant (branchId null) hears everything.
                { OR: [{ branchId: audience.branchId }, { branchId: null }] }
              : {}),
          },
        },
        ...(audience.branchId
          ? { userBranches: { some: { branchId: audience.branchId } } }
          : {}),
      },
      select: USER_SELECT,
    });
    for (const user of users) add(fromUser(user));
  }

  return [...byKey.values()];
}

function fromUser(user: {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  phoneNormalized: string | null;
  locale: Locale | null;
}): ResolvedRecipient {
  return {
    key: `user:${user.id}`,
    displayName: `${user.firstName} ${user.lastName}`.trim(),
    locale: user.locale,
    userId: user.id,
    guardianId: null,
    studentId: null,
    addresses: buildAddresses({
      userId: user.id,
      email: user.email,
      phone: user.phoneNormalized ?? user.phone,
    }),
  };
}

/** Which Notification column a row for this recipient and channel should set. */
export function pointerFor(
  recipient: ResolvedRecipient,
  channel: NotificationChannel,
): { readonly pointer: RecipientPointer; readonly id: string } | null {
  // IN_APP is read through the portal, which queries by recipientUserId, so an
  // in-app row must point at the account even when the person is a guardian.
  if (channel === 'IN_APP') {
    return recipient.userId ? { pointer: 'USER', id: recipient.userId } : null;
  }
  if (recipient.guardianId) return { pointer: 'GUARDIAN', id: recipient.guardianId };
  if (recipient.studentId && !recipient.userId) {
    return { pointer: 'STUDENT', id: recipient.studentId };
  }
  if (recipient.userId) return { pointer: 'USER', id: recipient.userId };
  // An ADDRESS recipient has no row to point at. Nothing in the schema models
  // "sent to a bare phone number", so the caller is told rather than guessed at.
  return null;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface PreferenceLookup {
  /** False when the recipient has opted out of this channel for this event. */
  readonly allows: (recipient: ResolvedRecipient, channel: NotificationChannel) => boolean;
}

/**
 * Load every preference row that could apply, in one query, and expose the
 * precedence rule: an event-specific row beats the channel-wide row, and absence
 * of both means opted in. Opt-out is explicit because a school that has just
 * imported nine hundred guardians must not have to opt each one in before an
 * absence notice works.
 */
export async function loadPreferences(
  event: string,
  recipients: readonly ResolvedRecipient[],
  db: Db = prisma,
): Promise<PreferenceLookup> {
  const userIds = recipients.flatMap((recipient) => (recipient.userId ? [recipient.userId] : []));
  const guardianIds = recipients.flatMap((recipient) =>
    recipient.guardianId ? [recipient.guardianId] : [],
  );

  if (userIds.length === 0 && guardianIds.length === 0) {
    return { allows: () => true };
  }

  const rows = await db.notificationPreference.findMany({
    where: {
      OR: [
        ...(userIds.length > 0 ? [{ userId: { in: userIds } }] : []),
        ...(guardianIds.length > 0 ? [{ guardianId: { in: guardianIds } }] : []),
      ],
    },
    select: { userId: true, guardianId: true, event: true, channel: true, enabled: true },
  });

  const index = new Map<string, boolean>();
  for (const row of rows) {
    const owner = row.guardianId ? `guardian:${row.guardianId}` : `user:${row.userId ?? ''}`;
    index.set(`${owner}:${row.event ?? '*'}:${row.channel}`, row.enabled);
  }

  return {
    allows: (recipient, channel) => {
      // A guardian who also has a login is asked about as a guardian: the parent
      // preference is the one they set in the parent-facing UI.
      const owners = recipient.guardianId
        ? [`guardian:${recipient.guardianId}`]
        : recipient.userId
          ? [`user:${recipient.userId}`]
          : [];
      for (const owner of owners) {
        const specific = index.get(`${owner}:${event}:${channel}`);
        if (specific !== undefined) return specific;
        const wide = index.get(`${owner}:*:${channel}`);
        if (wide !== undefined) return wide;
      }
      return true;
    },
  };
}
