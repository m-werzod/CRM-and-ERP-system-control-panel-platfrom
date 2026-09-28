/**
 * External attendance terminals: turnstiles, face panels, card and QR readers.
 *
 * A terminal is not a user. It has no session, nobody is watching it, and it will
 * keep POSTing whatever it reads for years. Three decisions follow from that and
 * they are the substance of this file:
 *
 * 1. IT AUTHENTICATES WITH A BEARER KEY WHOSE HASH IS ALL WE STORE. The plaintext
 *    is returned exactly once, at registration or rotation, and `apiKeyLast4` is
 *    kept purely so an administrator can tell two devices apart on screen.
 *
 * 2. ITS AUTHORITY IS ITS BRANCH. `deviceAccessContext` builds a system context
 *    pinned to `device.branchId`, so a compromised terminal in one branch cannot
 *    mark a student in another. That single line is the authorisation boundary for
 *    an unattended device -- there is no role, no permission set and no human
 *    behind it to narrow the damage any other way.
 *
 * 3. IT DOES NOT GET ITS OWN WRITE PATH. `submitDeviceAttendance` resolves the
 *    person and the lesson and then calls `markAttendance` like everything else,
 *    so the duplicate index, the late-threshold rule and the audit entry apply to
 *    a turnstile exactly as they do to a teacher's tap.
 */

import { randomUUID } from 'node:crypto';
import type {
  AttendanceDeviceStatus,
  AttendanceDeviceType,
  AttendanceStatus,
  Prisma,
} from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import { generateToken, hashToken, tokensMatch } from '@/server/auth/password';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  BadRequestError,
  BusinessRuleError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import {
  createSystemContext,
  requirePermission,
  resolveWriteBranch,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import { dateOnlyToPrismaDate, minutesBetween, plusMinutes, todayIn } from '@/lib/dates';
import { markAttendance, statusFromArrival } from '@/server/services/attendance/mark';

/**
 * How early a tap may attach to a lesson that has not started yet. Students
 * arrive before the bell; a turnstile read at 08:45 belongs to the 09:00 class.
 * There is no setting for this because it describes a building, not a policy --
 * callers that know better (a campus with a long walk from the gate) pass their
 * own value.
 */
const EARLY_ARRIVAL_GRACE_MINUTES = 30;

/**
 * A terminal's clock is not trustworthy. A few minutes of skew is normal; an hour
 * into the future is a broken clock, and accepting it would file attendance
 * against tomorrow's lesson.
 */
const MAX_CLOCK_SKEW_MINUTES = 5;

/**
 * How far back a submission may be dated. Generous on purpose: a device that lost
 * its network buffers taps and uploads them when it reconnects, and discarding
 * those would silently lose a day of attendance.
 */
const MAX_BACKDATE_MINUTES = 24 * 60;

// ---------------------------------------------------------------------------
// Registration and keys
// ---------------------------------------------------------------------------

export interface RegisterDeviceInput {
  readonly name: string;
  readonly serialNumber: string;
  readonly type: AttendanceDeviceType;
  readonly branchId?: string | null;
  readonly location?: string | null;
  readonly firmware?: string | null;
}

export interface DeviceKeyIssued {
  readonly id: string;
  readonly name: string;
  readonly serialNumber: string;
  readonly branchId: string;
  /** Shown once and never retrievable. Only its hash is stored. */
  readonly apiKey: string;
  readonly apiKeyLast4: string;
  readonly status: AttendanceDeviceStatus;
}

function issueKey(): { apiKey: string; apiKeyHash: string; apiKeyLast4: string } {
  const apiKey = generateToken(32);
  return { apiKey, apiKeyHash: hashToken(apiKey), apiKeyLast4: apiKey.slice(-4) };
}

/**
 * Register a terminal and issue its first key.
 *
 * The device is ACTIVE immediately: it holds a credential, so describing it as
 * UNCONFIGURED would make the status column lie. A device that should not yet be
 * trusted is deactivated, not left in a pending state nothing clears.
 */
export async function registerDevice(
  ctx: AccessContext,
  input: RegisterDeviceInput,
  db?: Db,
): Promise<DeviceKeyIssued> {
  requirePermission(ctx, 'attendance.manageDevices');

  const branchId = resolveWriteBranch(ctx, input.branchId, 'attendance device');
  const serialNumber = input.serialNumber.trim();
  if (serialNumber.length === 0) {
    throw new BadRequestError('A device needs its serial number so it can be identified on site.');
  }

  const key = issueKey();

  return withTransaction(
    async (tx) => {
      const device = await tx.attendanceDevice.create({
        data: {
          organizationId: ctx.organizationId,
          branchId,
          name: input.name.trim(),
          serialNumber,
          type: input.type,
          location: input.location?.trim() ?? null,
          firmware: input.firmware?.trim() ?? null,
          status: 'ACTIVE',
          apiKeyHash: key.apiKeyHash,
          apiKeyLast4: key.apiKeyLast4,
        },
        select: { id: true, name: true, serialNumber: true, status: true },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.DEVICE_REGISTERED,
          entityType: 'AttendanceDevice',
          entityId: device.id,
          branchId,
          summary: `Attendance device "${device.name}" registered (${input.type})`,
          // NOTICE: this hands out a credential that can write attendance
          // unattended, which is worth the same scrutiny as a role grant.
          severity: 'NOTICE',
          metadata: {
            type: input.type,
            serialNumber: device.serialNumber,
            apiKeyLast4: key.apiKeyLast4,
          },
        },
        tx,
      );

      return {
        id: device.id,
        name: device.name,
        serialNumber: device.serialNumber,
        branchId,
        apiKey: key.apiKey,
        apiKeyLast4: key.apiKeyLast4,
        status: device.status,
      };
    },
    { existing: db },
  );
}

/**
 * Replace a device's key.
 *
 * The old hash is overwritten in the same statement that writes the new one, so
 * there is no window in which both keys work. A rotation therefore takes the
 * device offline until it is reconfigured, which is the correct behaviour when the
 * reason for rotating is that the old key leaked.
 */
export async function rotateDeviceKey(
  ctx: AccessContext,
  input: { readonly deviceId: string; readonly reason?: string | null },
  db?: Db,
): Promise<DeviceKeyIssued> {
  requirePermission(ctx, 'attendance.manageDevices');

  const client = db ?? prisma;
  const device = await client.attendanceDevice.findFirst({
    where: { id: input.deviceId, ...scopeFilter(ctx), deletedAt: null },
    select: {
      id: true,
      name: true,
      serialNumber: true,
      branchId: true,
      status: true,
      apiKeyLast4: true,
    },
  });
  if (!device) throw new NotFoundError('Attendance device', input.deviceId);

  const key = issueKey();

  return withTransaction(
    async (tx) => {
      const updated = await tx.attendanceDevice.update({
        where: { id: device.id },
        data: {
          apiKeyHash: key.apiKeyHash,
          apiKeyLast4: key.apiKeyLast4,
          // Until the terminal is reconfigured with the new key it cannot check in.
          status: device.status === 'DISABLED' ? 'DISABLED' : 'UNCONFIGURED',
        },
        select: { status: true },
      });

      await recordAudit(
        ctx,
        {
          // AUDIT_ACTIONS has no key for a device credential rotation; the dotted
          // string keeps the vocabulary accurate rather than filing this under
          // "registered", which would hide it from anyone auditing key changes.
          action: 'attendance.device.key_rotated',
          entityType: 'AttendanceDevice',
          entityId: device.id,
          branchId: device.branchId,
          summary: `API key rotated for attendance device "${device.name}"`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          changes: {
            apiKeyLast4: { from: device.apiKeyLast4, to: key.apiKeyLast4 },
          },
          metadata: { serialNumber: device.serialNumber },
        },
        tx,
      );

      return {
        id: device.id,
        name: device.name,
        serialNumber: device.serialNumber,
        branchId: device.branchId,
        apiKey: key.apiKey,
        apiKeyLast4: key.apiKeyLast4,
        status: updated.status,
      };
    },
    { existing: db },
  );
}

export interface AuthenticatedDevice {
  readonly id: string;
  readonly organizationId: string;
  readonly branchId: string;
  readonly name: string;
  readonly serialNumber: string;
  readonly type: AttendanceDeviceType;
}

/**
 * A stored hash to compare against when no device matched, so the miss costs the
 * same work as the hit.
 */
const DUMMY_KEY_HASH = hashToken('attendance-device-timing-equalisation');

/**
 * Resolve a device from its bearer key. Returns `null` for every failure -- an
 * unknown key, a disabled device, an archived one -- and never says which.
 *
 * A terminal endpoint is reachable by anyone who can see the building's network,
 * so a response that distinguished "no such key" from "that device is disabled"
 * would be a free oracle. The comparison is performed whether or not a row came
 * back for the same reason: the two paths should not be tellable apart by timing.
 */
export async function authenticateDevice(
  rawKey: string,
  db?: Db,
): Promise<AuthenticatedDevice | null> {
  const client = db ?? prisma;

  if (rawKey.length === 0) {
    tokensMatch(DUMMY_KEY_HASH, DUMMY_KEY_HASH);
    return null;
  }

  const presented = hashToken(rawKey);
  const device = await client.attendanceDevice.findUnique({
    where: { apiKeyHash: presented },
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      name: true,
      serialNumber: true,
      type: true,
      status: true,
      deletedAt: true,
      apiKeyHash: true,
    },
  });

  const matches = tokensMatch(device?.apiKeyHash ?? DUMMY_KEY_HASH, presented);
  if (!device || !matches) return null;
  if (device.deletedAt !== null) return null;
  if (device.status === 'DISABLED') return null;

  return {
    id: device.id,
    organizationId: device.organizationId,
    branchId: device.branchId,
    name: device.name,
    serialNumber: device.serialNumber,
    type: device.type,
  };
}

/**
 * The authority an unattended terminal acts with.
 *
 * A system context, because there is no user to attribute the write to -- the
 * audit row and `AttendanceRecord.markedById` correctly record "system", with the
 * device id alongside. Narrowed to BRANCH scope over the device's own branch:
 * THIS is the authorisation boundary for a device. Everything it can reach is
 * reached through `scopeFilter`, so a terminal bolted to a wall in Central cannot
 * touch a Northside student even if someone walks off with its key.
 */
export function deviceAccessContext(
  device: AuthenticatedDevice,
  options: { readonly requestId?: string; readonly ipAddress?: string | null } = {},
): AccessContext {
  const base = createSystemContext({
    organizationId: device.organizationId,
    jobName: `device:${device.serialNumber}`,
    requestId: options.requestId ?? randomUUID(),
  });

  return {
    ...base,
    displayName: `Terminal ${device.name}`,
    scope: 'BRANCH',
    branchIds: [device.branchId],
    primaryBranchId: device.branchId,
    ipAddress: options.ipAddress ?? null,
  };
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export interface ListDevicesInput {
  readonly branchId?: string | null;
  readonly status?: readonly AttendanceDeviceStatus[];
  readonly type?: readonly AttendanceDeviceType[];
  readonly q?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly serialNumber: string;
  readonly type: AttendanceDeviceType;
  readonly status: AttendanceDeviceStatus;
  readonly branchId: string;
  readonly branchName: string;
  readonly location: string | null;
  readonly firmware: string | null;
  readonly lastSeenAt: Date | null;
  /** For display only. The key itself is unrecoverable. */
  readonly apiKeyLast4: string | null;
  readonly hasApiKey: boolean;
}

export async function listDevices(
  ctx: AccessContext,
  input: ListDevicesInput = {},
  db?: Db,
): Promise<{ rows: DeviceRow[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, 'attendance.manageDevices');

  const client = db ?? prisma;
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));

  const filters: Prisma.AttendanceDeviceWhereInput[] = [scopeFilter(ctx), { deletedAt: null }];
  if (input.branchId) filters.push({ branchId: input.branchId });
  if (input.status && input.status.length > 0) filters.push({ status: { in: [...input.status] } });
  if (input.type && input.type.length > 0) filters.push({ type: { in: [...input.type] } });

  const term = input.q?.trim();
  if (term) {
    filters.push({
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { serialNumber: { contains: term, mode: 'insensitive' } },
        { location: { contains: term, mode: 'insensitive' } },
      ],
    });
  }

  const where: Prisma.AttendanceDeviceWhereInput = { AND: filters };

  const [total, rows] = await Promise.all([
    client.attendanceDevice.count({ where }),
    client.attendanceDevice.findMany({
      where,
      // Sorted in SQL, not after the fact: the page boundary has to be stable.
      orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        serialNumber: true,
        type: true,
        status: true,
        branchId: true,
        location: true,
        firmware: true,
        lastSeenAt: true,
        apiKeyLast4: true,
        // Never the hash itself, only whether one exists.
        apiKeyHash: true,
        branch: { select: { name: true } },
      },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      serialNumber: row.serialNumber,
      type: row.type,
      status: row.status,
      branchId: row.branchId,
      branchName: row.branch.name,
      location: row.location,
      firmware: row.firmware,
      lastSeenAt: row.lastSeenAt,
      apiKeyLast4: row.apiKeyLast4,
      hasApiKey: row.apiKeyHash !== null,
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * Disable a device. Deliberately not a delete: its past attendance records point
 * at this row, and `authenticateDevice` refuses a DISABLED device, so the key is
 * inert the moment this commits.
 */
export async function deactivateDevice(
  ctx: AccessContext,
  input: { readonly deviceId: string; readonly reason?: string | null },
  db?: Db,
): Promise<{ id: string; status: AttendanceDeviceStatus }> {
  requirePermission(ctx, 'attendance.manageDevices');

  const client = db ?? prisma;
  const device = await client.attendanceDevice.findFirst({
    where: { id: input.deviceId, ...scopeFilter(ctx), deletedAt: null },
    select: { id: true, name: true, branchId: true, status: true },
  });
  if (!device) throw new NotFoundError('Attendance device', input.deviceId);
  if (device.status === 'DISABLED') {
    throw new StateInvalidError('attendance device', 'disabled', 'disabled');
  }

  return withTransaction(
    async (tx) => {
      await tx.attendanceDevice.update({
        where: { id: device.id },
        data: { status: 'DISABLED' },
      });

      await recordAudit(
        ctx,
        {
          action: 'attendance.device.deactivated',
          entityType: 'AttendanceDevice',
          entityId: device.id,
          branchId: device.branchId,
          summary: `Attendance device "${device.name}" disabled`,
          reason: input.reason ?? null,
          severity: 'NOTICE',
          changes: { status: { from: device.status, to: 'DISABLED' } },
        },
        tx,
      );

      return { id: device.id, status: 'DISABLED' as const };
    },
    { existing: db },
  );
}

/**
 * A terminal checking in.
 *
 * Not audited: this runs every minute or so per device and would bury every other
 * entry in the log. `lastSeenAt` IS the record, and it is what the devices screen
 * reads to show whether a panel has gone quiet.
 */
export async function recordDeviceHeartbeat(
  device: AuthenticatedDevice,
  input: { readonly firmware?: string | null; readonly observedStatus?: 'ACTIVE' | 'OFFLINE' } = {},
  db?: Db,
): Promise<{ id: string; lastSeenAt: Date }> {
  const client = db ?? prisma;
  const lastSeenAt = new Date();

  const updated = await client.attendanceDevice.updateMany({
    // The device id came from `authenticateDevice`, but the organisation predicate
    // is still applied: no query reads or writes tenant data without one. The
    // status guard matters too -- without it a disabled terminal would promote
    // itself back to ACTIVE on its next heartbeat and undo `deactivateDevice`.
    where: {
      id: device.id,
      organizationId: device.organizationId,
      deletedAt: null,
      status: { not: 'DISABLED' },
    },
    data: {
      lastSeenAt,
      ...(input.firmware ? { firmware: input.firmware } : {}),
      // A device that just spoke to us is not OFFLINE, and a freshly rotated key
      // that works moves it out of UNCONFIGURED. It may report OFFLINE itself when
      // it is going down cleanly.
      status: input.observedStatus === 'OFFLINE' ? 'OFFLINE' : 'ACTIVE',
    },
  });

  if (updated.count === 0) throw new NotFoundError('Attendance device', device.id);

  logger.debug('attendance.device.heartbeat', {
    organizationId: device.organizationId,
    deviceId: device.id,
    firmware: input.firmware ?? null,
  });

  return { id: device.id, lastSeenAt };
}

// ---------------------------------------------------------------------------
// Lesson resolution
// ---------------------------------------------------------------------------

export interface LessonWindowMatch {
  readonly id: string;
  readonly groupId: string;
  readonly branchId: string;
  readonly lessonDate: Date;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Which lesson does an observation at a terminal belong to?
 *
 * A tap carries a person and an instant, never a lesson id -- the person walked
 * through a door. The answer is the lesson whose window contains the instant, and
 * failing that the next one due to start within the grace window.
 *
 * Ordering by `startsAt` ascending resolves both cases with one query: a lesson
 * already in progress starts earlier than one about to begin, so it wins. Lessons
 * that have already ended are excluded by `endsAt > observedAt`, which is also
 * what stops a late-evening tap being filed against the morning class.
 */
export async function findLessonForObservation(
  db: Db,
  input: {
    readonly organizationId: string;
    readonly branchId: string;
    readonly observedAt: Date;
    /** Restrict to the groups the observed person is actually enrolled in. */
    readonly groupIds?: readonly string[];
    readonly graceMinutes?: number;
  },
): Promise<LessonWindowMatch | null> {
  const graceMinutes = Math.max(0, input.graceMinutes ?? EARLY_ARRIVAL_GRACE_MINUTES);

  return db.lesson.findFirst({
    where: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
      ...(input.groupIds ? { groupId: { in: [...input.groupIds] } } : {}),
      startsAt: { lte: plusMinutes(input.observedAt, graceMinutes) },
      endsAt: { gt: input.observedAt },
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      groupId: true,
      branchId: true,
      lessonDate: true,
      startsAt: true,
      endsAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface SubmitDeviceAttendanceInput {
  /** An opaque biometric enrolment reference the terminal read. */
  readonly externalRef?: string | null;
  /** The printed/scanned student code, for card readers and QR panels. */
  readonly studentCode?: string | null;
  readonly observedAt: Date;
  readonly confidencePpm?: number | null;
  readonly graceMinutes?: number;
  /** Correlates this submission with the HTTP request that carried it. */
  readonly requestId?: string;
  readonly ipAddress?: string | null;
}

export interface DeviceAttendanceResult {
  readonly lessonId: string;
  readonly studentId: string;
  readonly status: AttendanceStatus;
  readonly minutesLate: number | null;
  readonly alreadyMarked: boolean;
  readonly deviceId: string;
}

/**
 * Accept an observation from a terminal and turn it into attendance.
 *
 * Takes the authenticated device rather than an `AccessContext` because there is
 * no caller to trust: the context is DERIVED from the device here, pinned to its
 * branch, so the HTTP layer cannot widen it. Every lookup below carries that
 * branch in the same where clause as the id it is matching, which is what makes a
 * stolen key useless outside the room it was stolen from.
 */
export async function submitDeviceAttendance(
  device: AuthenticatedDevice,
  input: SubmitDeviceAttendanceInput,
  db?: Db,
): Promise<DeviceAttendanceResult> {
  const client = db ?? prisma;
  const now = new Date();
  const skewMinutes = minutesBetween(now, input.observedAt);
  if (skewMinutes > MAX_CLOCK_SKEW_MINUTES) {
    throw new BusinessRuleError(
      'attendance.device_clock_ahead',
      'This device reported a time in the future. Correct its clock before it can mark attendance.',
      { details: { observedAt: input.observedAt.toISOString(), skewMinutes } },
    );
  }
  if (-skewMinutes > MAX_BACKDATE_MINUTES) {
    throw new BusinessRuleError(
      'attendance.device_observation_too_old',
      'This observation is too old to be filed against a lesson.',
      { details: { observedAt: input.observedAt.toISOString() } },
    );
  }

  const confidencePpm = input.confidencePpm ?? null;
  if (confidencePpm !== null && (confidencePpm < 0 || confidencePpm > 1_000_000)) {
    // A CHECK constraint enforces this range too; rejecting it here names the
    // field instead of surfacing a constraint violation from a terminal's payload.
    throw new BadRequestError('A confidence must be parts-per-million between 0 and 1000000.', {
      details: { confidencePpm },
    });
  }

  const ctx = deviceAccessContext(device, {
    requestId: input.requestId,
    ipAddress: input.ipAddress,
  });

  const student = await resolveDeviceSubject(client, device, input);

  const { timezone } = await getSettings(
    ['timezone'],
    { organizationId: device.organizationId },
    client,
  );
  // The calendar day the tap happened on, in the institution's zone -- an evening
  // class in Tashkent is already tomorrow in UTC.
  const observedDay = dateOnlyToPrismaDate(todayIn(timezone, input.observedAt));

  const enrollments = await client.enrollment.findMany({
    where: {
      studentId: student.id,
      startDate: { lte: observedDay },
      OR: [{ endDate: null }, { endDate: { gte: observedDay } }],
    },
    select: { groupId: true },
  });
  if (enrollments.length === 0) {
    throw new BusinessRuleError(
      'attendance.not_enrolled',
      `${student.label} is not enrolled in any group on this date.`,
      { details: { studentId: student.id } },
    );
  }

  const lesson = await findLessonForObservation(client, {
    organizationId: device.organizationId,
    branchId: device.branchId,
    observedAt: input.observedAt,
    groupIds: enrollments.map((row) => row.groupId),
    graceMinutes: input.graceMinutes,
  });
  if (!lesson) {
    throw new BusinessRuleError(
      'attendance.no_lesson_for_observation',
      `No lesson for ${student.label} is running or about to start at this terminal.`,
      {
        details: {
          deviceId: device.id,
          studentId: student.id,
          observedAt: input.observedAt.toISOString(),
        },
      },
    );
  }

  const settings = await getSettings(
    ['lateThresholdMinutes', 'absentAfterMinutes'],
    { organizationId: device.organizationId, branchId: lesson.branchId },
    client,
  );
  // The same arrival rule a manual entry uses, from mark.ts. A terminal must not
  // invent its own idea of "late".
  const arrival = statusFromArrival({
    lessonStartsAt: lesson.startsAt,
    arrivedAt: input.observedAt,
    lateThresholdMinutes: settings.lateThresholdMinutes,
    absentAfterMinutes: settings.absentAfterMinutes,
  });

  const marked = await markAttendance(
    ctx,
    {
      lessonId: lesson.id,
      method: 'DEVICE',
      deviceId: device.id,
      markedAt: input.observedAt,
      entries: [
        {
          studentId: student.id,
          status: arrival.status,
          minutesLate: arrival.status === 'LATE' ? arrival.minutesLate : null,
          confidencePpm,
        },
      ],
    },
    db,
  );

  const summary = marked.records[0];
  return {
    lessonId: lesson.id,
    studentId: student.id,
    status: summary?.status ?? arrival.status,
    minutesLate: summary?.minutesLate ?? null,
    alreadyMarked: summary?.alreadyExisted ?? false,
    deviceId: device.id,
  };
}

/**
 * Resolve the person a terminal read, inside the device's branch.
 *
 * The branch predicate sits in the same where clause as the identifier, so a code
 * belonging to another branch's student is simply not found -- the terminal learns
 * nothing about students it has no business seeing.
 */
async function resolveDeviceSubject(
  db: Db,
  device: AuthenticatedDevice,
  input: SubmitDeviceAttendanceInput,
): Promise<{ id: string; label: string }> {
  if (input.externalRef) {
    // Looked up by reference alone, without filtering on the currently configured
    // provider: the reference is opaque, the row records which provider issued it,
    // and a card reader's reference was never a face provider's to begin with.
    const enrollment = await db.biometricEnrollment.findFirst({
      where: {
        organizationId: device.organizationId,
        externalRef: input.externalRef,
        status: 'ACTIVE',
        student: { branchId: device.branchId, deletedAt: null },
      },
      select: {
        studentId: true,
        student: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const student = enrollment?.student;
    if (!student) throw new NotFoundError('Biometric enrolment');
    return { id: student.id, label: `${student.firstName} ${student.lastName}` };
  }

  if (input.studentCode) {
    const student = await db.student.findFirst({
      where: {
        organizationId: device.organizationId,
        branchId: device.branchId,
        studentCode: input.studentCode.trim(),
        deletedAt: null,
      },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!student) throw new NotFoundError('Student');
    return { id: student.id, label: `${student.firstName} ${student.lastName}` };
  }

  throw new BadRequestError(
    'A device submission must identify the person, by biometric reference or student code.',
  );
}
