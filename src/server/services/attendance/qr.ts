/**
 * QR attendance: a rotating, single-use token displayed on the teacher's screen.
 *
 * THE THREAT MODEL IS THE FEATURE. A QR code shown to a classroom is visible to
 * every phone in the room and to anyone the first student sends a photograph to.
 * Two properties, together, are what make it worth anything at all:
 *
 *   * SINGLE USE -- the first redemption consumes the token, so a screenshot
 *     passed to the friend who stayed at home marks nobody. The claim is a
 *     conditional UPDATE inside the marking transaction, not a read-then-write,
 *     because two scans arriving in the same instant would both pass a read.
 *   * SHORT TTL -- `attendance.qrTokenTtlSeconds` (a minute by default), after
 *     which the displayed code rotates. A photograph taken in the lesson is
 *     useless by the end of it.
 *
 * Neither is sufficient alone: single-use without rotation lets the first arrival
 * hand the code on before scanning, rotation without single-use lets everyone in
 * the room share one code for its lifetime. Anything that weakens either -- a
 * longer TTL "for convenience", a reusable token per lesson -- turns this back into
 * an honour system with extra steps.
 *
 * Only the token's hash is stored. The plaintext is returned exactly once, to the
 * screen that will display it.
 */

import { prisma, withTransaction, type Db } from '@/server/db/client';
import { generateToken, hashToken } from '@/server/auth/password';
import { BadRequestError, NotFoundError, StateInvalidError } from '@/server/errors';
import {
  composeReadFilter,
  organizationFilter,
  requirePermission,
  scopeFilter,
  teacherLessonFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import { plusMinutes } from '@/lib/dates';
import type { AttendanceStatus } from '@/generated/prisma/client';
import { markAttendance, statusFromArrival } from '@/server/services/attendance/mark';

export interface IssueQrTokenInput {
  readonly lessonId: string;
}

export interface IssuedQrToken {
  readonly id: string;
  readonly lessonId: string;
  /** The plaintext, returned once for display. It is not stored and cannot be re-read. */
  readonly token: string;
  readonly rotationIndex: number;
  readonly expiresAt: Date;
  readonly ttlSeconds: number;
}

/**
 * Issue the next token for a lesson.
 *
 * Any token still outstanding for the lesson is expired in the same transaction.
 * One code is on screen at a time, so leaving the previous one alive for the rest
 * of its TTL would quietly double the window a shared screenshot works in.
 */
export async function issueQrToken(
  ctx: AccessContext,
  input: IssueQrTokenInput,
  db?: Db,
): Promise<IssuedQrToken> {
  requirePermission(ctx, 'attendance.mark');

  const client = db ?? prisma;

  // Scope in the same where clause as the id: tenancy, branch, and -- for a
  // teacher without `attendance.viewAll` -- only their own lessons. A teacher must
  // not be able to raise a code for somebody else's class.
  const lesson = await client.lesson.findFirst({
    where: {
      id: input.lessonId,
      ...composeReadFilter(ctx, {
        selfFilter: teacherLessonFilter(ctx),
        escapeHatch: 'attendance.viewAll',
      }),
    },
    select: { id: true, branchId: true, status: true, attendanceStatus: true },
  });
  if (!lesson) throw new NotFoundError('Lesson', input.lessonId);

  if (lesson.status === 'CANCELLED') {
    throw new StateInvalidError('lesson', 'cancelled', 'marked');
  }
  if (lesson.attendanceStatus === 'APPROVED') {
    throw new StateInvalidError(
      'attendance register',
      'approved',
      'reopened for scanning',
    );
  }

  const { qrTokenTtlSeconds } = await getSettings(
    ['qrTokenTtlSeconds'],
    { organizationId: ctx.organizationId, branchId: lesson.branchId },
    client,
  );

  const token = generateToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + qrTokenTtlSeconds * 1000);

  return withTransaction(
    async (tx) => {
      const previous = await tx.qrToken.aggregate({
        where: { lessonId: lesson.id, ...organizationFilter(ctx) },
        _max: { rotationIndex: true },
      });

      await tx.qrToken.updateMany({
        where: { lessonId: lesson.id, usedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      });

      const rotationIndex = (previous._max.rotationIndex ?? -1) + 1;
      const row = await tx.qrToken.create({
        data: {
          organizationId: ctx.organizationId,
          lessonId: lesson.id,
          tokenHash: hashToken(token),
          rotationIndex,
          expiresAt,
        },
        select: { id: true },
      });

      // Not audited: the token itself grants nothing, and the redemption it may
      // lead to is audited by markAttendance. Logged so a suspicious burst of
      // rotations is still visible.
      logger.info('attendance.qr.issued', {
        requestId: ctx.requestId,
        organizationId: ctx.organizationId,
        lessonId: lesson.id,
        rotationIndex,
        ttlSeconds: qrTokenTtlSeconds,
      });

      return {
        id: row.id,
        lessonId: lesson.id,
        token,
        rotationIndex,
        expiresAt,
        ttlSeconds: qrTokenTtlSeconds,
      };
    },
    { existing: db },
  );
}

export interface RedeemQrTokenInput {
  readonly token: string;
  /** The student being marked. Defaults to the caller when they are a student. */
  readonly studentId?: string | null;
  /** When the code was scanned. Defaults to now. */
  readonly scannedAt?: Date;
}

export interface RedeemQrTokenResult {
  readonly lessonId: string;
  readonly studentId: string;
  readonly rotationIndex: number;
  readonly status: AttendanceStatus;
  readonly minutesLate: number | null;
  readonly alreadyMarked: boolean;
}

/**
 * Redeem a scanned code and mark the student present.
 *
 * The token is claimed with `updateMany ... where usedAt IS NULL` and the write is
 * only accepted when it affected exactly one row. That conditional update is the
 * single-use guarantee; the read above it exists to produce a good error message,
 * not to enforce anything.
 */
export async function redeemQrToken(
  ctx: AccessContext,
  input: RedeemQrTokenInput,
  db?: Db,
): Promise<RedeemQrTokenResult> {
  requirePermission(ctx, 'attendance.mark');

  const studentId = input.studentId ?? ctx.self.studentId;
  if (!studentId) {
    throw new BadRequestError('A QR redemption must say which student is being marked.');
  }
  if (input.token.trim().length === 0) {
    throw new BadRequestError('No QR code was supplied.');
  }

  const scannedAt = input.scannedAt ?? new Date();
  const tokenHash = hashToken(input.token.trim());

  return withTransaction(
    async (tx) => {
      const row = await tx.qrToken.findFirst({
        where: {
          tokenHash,
          ...organizationFilter(ctx),
          // The lesson's branch must be inside the caller's scope, tested here
          // rather than after the fetch so a code from another branch is simply
          // not found.
          lesson: scopeFilter(ctx),
        },
        select: {
          id: true,
          lessonId: true,
          rotationIndex: true,
          expiresAt: true,
          usedAt: true,
          lesson: { select: { startsAt: true, branchId: true } },
        },
      });
      if (!row) throw new NotFoundError('QR code');

      if (row.usedAt !== null) {
        throw new StateInvalidError('QR code', 'already used', 'redeemed');
      }
      if (row.expiresAt <= scannedAt) {
        throw new StateInvalidError('QR code', 'expired', 'redeemed');
      }

      const student = await tx.student.findFirst({
        where: { id: studentId, ...scopeFilter(ctx), deletedAt: null },
        select: { id: true },
      });
      if (!student) throw new NotFoundError('Student', studentId);

      // The claim. `usedAt: null` in the predicate is what makes this single-use
      // under concurrency: the loser of a race updates zero rows.
      const claimed = await tx.qrToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: scannedAt, usedByStudentId: student.id },
      });
      if (claimed.count !== 1) {
        throw new StateInvalidError('QR code', 'already used', 'redeemed');
      }

      const settings = await getSettings(
        ['lateThresholdMinutes', 'absentAfterMinutes'],
        { organizationId: ctx.organizationId, branchId: row.lesson.branchId },
        tx,
      );
      // The arrival rule from mark.ts, so a scan and a tap classify a latecomer
      // identically.
      const arrival = statusFromArrival({
        lessonStartsAt: row.lesson.startsAt,
        arrivedAt: scannedAt,
        lateThresholdMinutes: settings.lateThresholdMinutes,
        absentAfterMinutes: settings.absentAfterMinutes,
      });

      // An arrival past `attendance.absentAfterMinutes` is recorded as ABSENT by
      // the shared rule rather than refused here. The scan happened and the record
      // should say what it was; a refusal would leave no trace of a student who
      // did turn up, very late, and would put a second late-arrival policy in this
      // file for the UI to disagree with. `status` in the result is what the
      // student is shown.
      const marked = await markAttendance(
        ctx,
        {
          lessonId: row.lessonId,
          method: 'QR',
          markedAt: scannedAt,
          entries: [
            {
              studentId: student.id,
              status: arrival.status,
              minutesLate: arrival.status === 'LATE' ? arrival.minutesLate : null,
            },
          ],
        },
        tx,
      );

      const summary = marked.records[0];
      return {
        lessonId: row.lessonId,
        studentId: student.id,
        rotationIndex: row.rotationIndex,
        status: summary?.status ?? arrival.status,
        minutesLate: summary?.minutesLate ?? null,
        alreadyMarked: summary?.alreadyExisted ?? false,
      };
    },
    { existing: db },
  );
}

/**
 * Drop expired, unused tokens. For the maintenance job: a lesson that rotated its
 * code every minute for two hours leaves 120 dead rows, and none of them is
 * evidence of anything -- a redeemed token keeps its row because `usedByStudentId`
 * and `usedAt` are part of how the attendance came to exist.
 */
export async function purgeExpiredQrTokens(
  ctx: AccessContext,
  input: { readonly before?: Date } = {},
  db?: Db,
): Promise<{ deleted: number }> {
  requirePermission(ctx, 'attendance.mark');

  const client = db ?? prisma;
  const before = input.before ?? plusMinutes(new Date(), -60);

  const result = await client.qrToken.deleteMany({
    where: { ...organizationFilter(ctx), usedAt: null, expiresAt: { lt: before } },
  });
  return { deleted: result.count };
}
