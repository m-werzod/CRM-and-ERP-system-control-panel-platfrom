/**
 * Marking and correcting attendance.
 *
 * ONE use-case serves every capture method. Manual entry, a teacher's register, a
 * face terminal, a QR scan, an external device and a CSV import all end up here,
 * and `method` records which one it was. That is deliberate: the alternative —
 * a write path per provider — is how one of them ends up skipping the duplicate
 * check, the late-threshold rule, or the notification.
 *
 * Duplicate prevention is a UNIQUE INDEX on (lessonId, studentId), not an
 * application check. A teacher double-tapping submit on a slow connection, or a
 * face terminal retrying a request, cannot produce two rows even if both requests
 * pass a read-then-write test at the same instant.
 *
 * Corrections never overwrite silently: the record is updated and an
 * `AttendanceCorrection` row is appended in the SAME transaction, with a reason and
 * the actor. `attendance_corrections` is append-only at the database level.
 */

import type { AttendanceMethod, AttendanceStatus, Prisma } from '@/generated/prisma/client';
import { withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  StateInvalidError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  can,
  requirePermission,
  scopeFilter,
  type AccessContext,
} from '@/server/rbac/access';
import { getSettings } from '@/server/settings';
import { logger } from '@/server/observability/logger';
import { minutesBetween } from '@/lib/dates';
import { findEnrollmentForLesson } from '@/server/services/students/enrollment';

export interface AttendanceEntryInput {
  readonly studentId: string;
  readonly status: AttendanceStatus;
  /** Only meaningful for LATE; a CHECK constraint rejects it on other statuses. */
  readonly minutesLate?: number | null;
  readonly note?: string | null;
  /** Recognition confidence in ppm, for FACE_RECOGNITION / DEVICE. */
  readonly confidencePpm?: number | null;
}

export interface MarkAttendanceInput {
  readonly lessonId: string;
  readonly entries: readonly AttendanceEntryInput[];
  readonly method: AttendanceMethod;
  readonly deviceId?: string | null;
  /** Instant the attendance was observed. Defaults to now. */
  readonly markedAt?: Date;
  /**
   * Submit the register, closing it for further ordinary marking. A face terminal
   * marking one arrival should NOT submit.
   */
  readonly submit?: boolean;
}

export interface MarkAttendanceResult {
  readonly lessonId: string;
  readonly created: number;
  readonly skippedExisting: number;
  readonly attendanceStatus: string;
  readonly records: ReadonlyArray<{
    readonly studentId: string;
    readonly status: AttendanceStatus;
    readonly minutesLate: number | null;
    readonly alreadyExisted: boolean;
  }>;
}

/**
 * Derive a status from an arrival time, using the institution's thresholds.
 *
 * Pure and exported so the face/QR/device paths and the unit tests all agree on the
 * rule. Arriving before the start is PRESENT; within `lateThresholdMinutes` is
 * PRESENT; beyond it is LATE; beyond `absentAfterMinutes` is ABSENT.
 */
export function statusFromArrival(input: {
  readonly lessonStartsAt: Date;
  readonly arrivedAt: Date;
  readonly lateThresholdMinutes: number;
  readonly absentAfterMinutes: number;
}): { status: AttendanceStatus; minutesLate: number } {
  const minutesLate = Math.max(0, minutesBetween(input.lessonStartsAt, input.arrivedAt));

  if (minutesLate > input.absentAfterMinutes) {
    // Too late to count as attendance at all. `minutesLate` is returned for the
    // audit note but must not be stored on an ABSENT record.
    return { status: 'ABSENT', minutesLate };
  }
  if (minutesLate > input.lateThresholdMinutes) {
    return { status: 'LATE', minutesLate };
  }
  return { status: 'PRESENT', minutesLate: 0 };
}

/**
 * Whether this caller may mark this lesson.
 *
 * A teacher may mark their own lessons and nothing else; that is the SELF scope
 * made concrete. Anyone holding `attendance.viewAll` plus `attendance.mark`
 * (administrators, receptionists) may mark any lesson inside their branch scope.
 */
async function assertMayMarkLesson(
  ctx: AccessContext,
  tx: Tx,
  lesson: { id: string; teacherId: string | null; groupId: string; branchId: string },
): Promise<void> {
  requirePermission(ctx, 'attendance.mark');

  if (ctx.isSystem) return;
  if (can(ctx, 'attendance.viewAll')) return;

  const teacherId = ctx.self.teacherId;
  if (!teacherId) {
    throw new ForbiddenError('Only the assigned teacher or an administrator can mark this lesson.');
  }
  if (lesson.teacherId === teacherId) return;

  // Also allow a teacher assigned to the group (including as assistant or
  // substitute) even when the lesson names someone else.
  const assignment = await tx.groupTeacher.findFirst({
    where: { groupId: lesson.groupId, teacherId, endDate: null },
    select: { id: true },
  });
  if (!assignment) {
    throw new ForbiddenError('You are not assigned to this class.');
  }
}

/**
 * Record attendance for one lesson.
 *
 * Idempotent by construction: an entry for a student who already has a record is
 * REPORTED as skipped rather than overwritten. Overwriting would let a face
 * terminal silently flip an administrator's manual correction back, which is
 * precisely the bug the correction trail exists to make visible.
 */
export async function markAttendance(
  ctx: AccessContext,
  input: MarkAttendanceInput,
  db?: Db,
): Promise<MarkAttendanceResult> {
  if (input.entries.length === 0) {
    throw new BusinessRuleError('attendance.no_entries', 'No attendance entries were supplied.');
  }

  return withTransaction(
    async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: input.lessonId, ...scopeFilter(ctx) },
        select: {
          id: true,
          organizationId: true,
          branchId: true,
          groupId: true,
          teacherId: true,
          lessonDate: true,
          startsAt: true,
          status: true,
          attendanceStatus: true,
          group: { select: { name: true } },
        },
      });
      if (!lesson) throw new NotFoundError('Lesson', input.lessonId);

      await assertMayMarkLesson(ctx, tx, lesson);

      if (lesson.status === 'CANCELLED') {
        throw new StateInvalidError('lesson', 'cancelled', 'marked');
      }

      const settings = await getSettings(
        ['lateThresholdMinutes', 'absentAfterMinutes', 'teacherEditWindowMinutes'],
        { organizationId: ctx.organizationId, branchId: lesson.branchId },
        tx,
      );

      // An APPROVED register is closed to ordinary marking; changes go through
      // correctAttendance, which leaves a trail.
      if (lesson.attendanceStatus === 'APPROVED' && !can(ctx, 'attendance.edit')) {
        throw new StateInvalidError(
          'attendance register',
          'approved',
          'changed without a correction',
        );
      }

      const markedAt = input.markedAt ?? new Date();

      // Existing records, so duplicates are reported rather than attempted.
      const existing = await tx.attendanceRecord.findMany({
        where: { lessonId: lesson.id },
        select: { studentId: true },
      });
      const alreadyMarked = new Set(existing.map((row) => row.studentId));

      // Only students actually enrolled on the lesson date may be marked: a
      // transferred student must not appear on a register for a class they left.
      const rosterIds = new Set<string>();
      const enrollmentByStudent = new Map<string, string | null>();
      for (const entry of input.entries) {
        if (alreadyMarked.has(entry.studentId)) continue;
        const enrollmentId = await findEnrollmentForLesson(tx, {
          studentId: entry.studentId,
          groupId: lesson.groupId,
          lessonDate: lesson.lessonDate,
        });
        if (enrollmentId === null) continue;
        rosterIds.add(entry.studentId);
        enrollmentByStudent.set(entry.studentId, enrollmentId);
      }

      const offRoster = input.entries
        .filter((entry) => !alreadyMarked.has(entry.studentId) && !rosterIds.has(entry.studentId))
        .map((entry) => entry.studentId);
      if (offRoster.length > 0) {
        throw new BusinessRuleError(
          'attendance.not_enrolled',
          'One or more students were not enrolled in this group on the lesson date.',
          { details: { studentIds: offRoster } },
        );
      }

      const toCreate: Prisma.AttendanceRecordCreateManyInput[] = [];
      const summary: Array<{
        studentId: string;
        status: AttendanceStatus;
        minutesLate: number | null;
        alreadyExisted: boolean;
      }> = [];

      for (const entry of input.entries) {
        if (alreadyMarked.has(entry.studentId)) {
          summary.push({
            studentId: entry.studentId,
            status: entry.status,
            minutesLate: entry.minutesLate ?? null,
            alreadyExisted: true,
          });
          continue;
        }

        // A CHECK constraint enforces this too; normalising here produces a clear
        // message instead of a constraint violation.
        const minutesLate = entry.status === 'LATE' ? Math.max(0, entry.minutesLate ?? 0) : 0;
        if (entry.status === 'LATE' && minutesLate === 0) {
          throw new BusinessRuleError(
            'attendance.late_without_minutes',
            'A late arrival must record how many minutes late it was.',
            { details: { studentId: entry.studentId } },
          );
        }
        if (entry.status !== 'LATE' && (entry.minutesLate ?? 0) > 0) {
          throw new BusinessRuleError(
            'attendance.minutes_on_non_late',
            `Minutes late can only be recorded on a LATE entry, not ${entry.status}.`,
            { details: { studentId: entry.studentId } },
          );
        }

        toCreate.push({
          organizationId: lesson.organizationId,
          branchId: lesson.branchId,
          lessonId: lesson.id,
          studentId: entry.studentId,
          enrollmentId: enrollmentByStudent.get(entry.studentId) ?? null,
          status: entry.status,
          method: input.method,
          minutesLate: entry.status === 'LATE' ? minutesLate : null,
          note: entry.note ?? null,
          confidencePpm: entry.confidencePpm ?? null,
          deviceId: input.deviceId ?? null,
          markedById: ctx.isSystem ? null : ctx.userId,
          markedAt,
          isCorrected: false,
        });

        summary.push({
          studentId: entry.studentId,
          status: entry.status,
          minutesLate: entry.status === 'LATE' ? minutesLate : null,
          alreadyExisted: false,
        });
      }

      // `skipDuplicates` closes the last race: between the read above and this
      // insert, another request may have marked the same student. The unique index
      // makes that a no-op rather than an error.
      const inserted = await tx.attendanceRecord.createMany({
        data: toCreate,
        skipDuplicates: true,
      });

      let attendanceStatus = lesson.attendanceStatus;
      if (input.submit) {
        attendanceStatus = 'SUBMITTED';
        await tx.lesson.update({
          where: { id: lesson.id },
          data: {
            attendanceStatus: 'SUBMITTED',
            attendanceSubmittedById: ctx.isSystem ? null : ctx.userId,
            attendanceSubmittedAt: markedAt,
            // A lesson whose register has been submitted has evidently happened.
            status: lesson.status === 'SCHEDULED' ? 'COMPLETED' : lesson.status,
          },
        });
      }

      const counts = summary.reduce(
        (acc, row) => {
          if (!row.alreadyExisted) acc[row.status] = (acc[row.status] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      await recordAudit(
        ctx,
        {
          action: input.submit ? AUDIT_ACTIONS.ATTENDANCE_SUBMITTED : 'attendance.marked',
          entityType: 'Lesson',
          entityId: lesson.id,
          branchId: lesson.branchId,
          summary: `Attendance ${input.submit ? 'submitted' : 'marked'} for ${lesson.group.name}: ${Object.entries(
            counts,
          )
            .map(([status, count]) => `${count} ${status.toLowerCase()}`)
            .join(', ')}`,
          metadata: {
            method: input.method,
            created: inserted.count,
            skipped: summary.filter((row) => row.alreadyExisted).length,
            counts,
            deviceId: input.deviceId ?? null,
          },
        },
        tx,
      );

      if (settings.teacherEditWindowMinutes === 0 && input.submit) {
        logger.info('attendance.submitted_final', {
          requestId: ctx.requestId,
          organizationId: ctx.organizationId,
          lessonId: lesson.id,
        });
      }

      return {
        lessonId: lesson.id,
        created: inserted.count,
        skippedExisting: summary.filter((row) => row.alreadyExisted).length,
        attendanceStatus,
        records: summary,
      };
    },
    { existing: db },
  );
}

export interface CorrectAttendanceInput {
  readonly attendanceRecordId: string;
  readonly newStatus: AttendanceStatus;
  readonly newMinutesLate?: number | null;
  readonly reason: string;
  readonly note?: string | null;
}

/**
 * Amend an existing attendance record.
 *
 * The record is updated and an `AttendanceCorrection` row appended in one
 * transaction, so a corrected register can always be read back as "what it says
 * now, and what it said before, and who changed it and why". Whether the
 * correction takes effect immediately or waits for approval is institution policy
 * (`attendance.requireCorrectionApproval`).
 *
 * A teacher may amend their own submission within
 * `attendance.teacherEditWindowMinutes`; past that, it needs `attendance.correct`.
 */
export async function correctAttendance(
  ctx: AccessContext,
  input: CorrectAttendanceInput,
  db?: Db,
): Promise<{
  id: string;
  previousStatus: AttendanceStatus;
  newStatus: AttendanceStatus;
  requiresApproval: boolean;
  correctionId: string;
}> {
  return withTransaction(
    async (tx) => {
      const record = await tx.attendanceRecord.findFirst({
        where: { id: input.attendanceRecordId, ...scopeFilter(ctx) },
        select: {
          id: true,
          status: true,
          minutesLate: true,
          studentId: true,
          branchId: true,
          markedById: true,
          markedAt: true,
          lesson: {
            select: {
              id: true,
              groupId: true,
              teacherId: true,
              attendanceStatus: true,
              attendanceSubmittedAt: true,
              group: { select: { name: true } },
            },
          },
          student: { select: { firstName: true, lastName: true } },
        },
      });
      if (!record) throw new NotFoundError('Attendance record', input.attendanceRecordId);

      const settings = await getSettings(
        [
          'requireCorrectionApproval',
          'requireCorrectionReason',
          'teacherEditWindowMinutes',
        ],
        { organizationId: ctx.organizationId, branchId: record.branchId },
        tx,
      );

      if (settings.requireCorrectionReason && input.reason.trim().length < 5) {
        throw new BusinessRuleError(
          'attendance.correction_reason_required',
          'A correction must record why the attendance is being changed.',
        );
      }

      // --- who may correct this -------------------------------------------
      const isOwnRecentSubmission =
        ctx.self.teacherId !== null &&
        record.lesson.teacherId === ctx.self.teacherId &&
        record.lesson.attendanceSubmittedAt !== null &&
        minutesBetween(record.lesson.attendanceSubmittedAt, new Date()) <=
          settings.teacherEditWindowMinutes;

      if (!ctx.isSystem && !can(ctx, 'attendance.correct')) {
        // The grace window is what lets a teacher fix a mis-tap without raising a
        // ticket, while still leaving a correction row behind.
        if (!isOwnRecentSubmission || !can(ctx, 'attendance.mark')) {
          throw new ForbiddenError(
            settings.teacherEditWindowMinutes > 0
              ? `Attendance can only be changed by the submitting teacher within ${settings.teacherEditWindowMinutes} minutes, or by someone with permission to correct it.`
              : 'Changing submitted attendance requires permission to correct it.',
          );
        }
      }

      const newMinutesLate =
        input.newStatus === 'LATE' ? Math.max(0, input.newMinutesLate ?? 0) : null;

      if (input.newStatus === 'LATE' && (newMinutesLate ?? 0) === 0) {
        throw new BusinessRuleError(
          'attendance.late_without_minutes',
          'A late arrival must record how many minutes late it was.',
        );
      }

      // A CHECK constraint rejects a no-op correction, which would otherwise add
      // noise to the trail without changing anything.
      const unchanged =
        record.status === input.newStatus &&
        (record.minutesLate ?? null) === newMinutesLate;
      if (unchanged) {
        throw new BusinessRuleError(
          'attendance.correction_changes_nothing',
          'The correction does not change the recorded attendance.',
        );
      }

      const requiresApproval = settings.requireCorrectionApproval && !can(ctx, 'attendance.approve');

      const correction = await tx.attendanceCorrection.create({
        data: {
          attendanceRecordId: record.id,
          previousStatus: record.status,
          newStatus: input.newStatus,
          previousMinutesLate: record.minutesLate,
          newMinutesLate,
          reason: input.reason,
          correctedById: ctx.userId,
          // Self-approved when the corrector already holds the approval permission;
          // the row still records who did it.
          approvedById: requiresApproval ? null : ctx.userId,
          approvedAt: requiresApproval ? null : new Date(),
        },
        select: { id: true },
      });

      // The record itself only moves once the correction is effective. A pending
      // correction leaves the register reading as it did, which is the honest
      // behaviour when a second person still has to sign it off.
      if (!requiresApproval) {
        await tx.attendanceRecord.update({
          where: { id: record.id },
          data: {
            status: input.newStatus,
            minutesLate: newMinutesLate,
            isCorrected: true,
            note: input.note ?? undefined,
          },
        });
      }

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ATTENDANCE_CORRECTED,
          entityType: 'AttendanceRecord',
          entityId: record.id,
          branchId: record.branchId,
          summary: `Attendance for ${record.student.firstName} ${record.student.lastName} in ${record.lesson.group.name} changed from ${record.status} to ${input.newStatus}${requiresApproval ? ' (pending approval)' : ''}`,
          reason: input.reason,
          changes: {
            status: { from: record.status, to: input.newStatus },
            minutesLate: { from: record.minutesLate, to: newMinutesLate },
          },
          // NOTICE, so the audit write is not best-effort: an untraceable
          // attendance change is exactly what this trail exists to prevent.
          severity: 'NOTICE',
          metadata: { correctionId: correction.id, requiresApproval },
          timeline: {
            subjectType: 'STUDENT',
            subjectId: record.studentId,
            type: 'attendance.corrected',
            title: `Attendance corrected: ${record.status} → ${input.newStatus}`,
            description: input.reason,
          },
        },
        tx,
      );

      return {
        id: record.id,
        previousStatus: record.status,
        newStatus: input.newStatus,
        requiresApproval,
        correctionId: correction.id,
      };
    },
    { existing: db },
  );
}

/** Approve a pending correction, applying it to the record. */
export async function approveCorrection(
  ctx: AccessContext,
  correctionId: string,
  db?: Db,
): Promise<{ id: string; applied: boolean }> {
  requirePermission(ctx, 'attendance.approve');

  return withTransaction(
    async (tx) => {
      const correction = await tx.attendanceCorrection.findFirst({
        where: {
          id: correctionId,
          attendanceRecord: scopeFilter(ctx),
        },
        select: {
          id: true,
          newStatus: true,
          newMinutesLate: true,
          previousStatus: true,
          approvedAt: true,
          correctedById: true,
          reason: true,
          attendanceRecord: {
            select: {
              id: true,
              branchId: true,
              studentId: true,
              student: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });
      if (!correction) throw new NotFoundError('Attendance correction', correctionId);
      if (correction.approvedAt) {
        throw new StateInvalidError('correction', 'already approved', 'approved');
      }
      if (correction.correctedById === ctx.userId && !ctx.isSystem) {
        throw new ForbiddenError(
          'A correction must be approved by someone other than the person who made it.',
        );
      }

      // `attendance_corrections` is append-only, so the approval is recorded by
      // updating... which the trigger blocks. Approval therefore lives on the
      // record plus a fresh audit entry, and the correction row keeps its original
      // pending state as the historical fact of what was requested.
      await tx.attendanceRecord.update({
        where: { id: correction.attendanceRecord.id },
        data: {
          status: correction.newStatus,
          minutesLate: correction.newMinutesLate,
          isCorrected: true,
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ATTENDANCE_APPROVED,
          entityType: 'AttendanceRecord',
          entityId: correction.attendanceRecord.id,
          branchId: correction.attendanceRecord.branchId,
          summary: `Correction approved for ${correction.attendanceRecord.student.firstName} ${correction.attendanceRecord.student.lastName}: ${correction.previousStatus} → ${correction.newStatus}`,
          reason: correction.reason,
          severity: 'NOTICE',
          metadata: { correctionId: correction.id },
        },
        tx,
      );

      return { id: correction.id, applied: true };
    },
    { existing: db },
  );
}

/** Approve a whole submitted register, closing it to ordinary marking. */
export async function approveRegister(
  ctx: AccessContext,
  lessonId: string,
  db?: Db,
): Promise<{ lessonId: string; attendanceStatus: string }> {
  requirePermission(ctx, 'attendance.approve');

  return withTransaction(
    async (tx) => {
      const lesson = await tx.lesson.findFirst({
        where: { id: lessonId, ...scopeFilter(ctx) },
        select: {
          id: true,
          branchId: true,
          attendanceStatus: true,
          group: { select: { name: true } },
        },
      });
      if (!lesson) throw new NotFoundError('Lesson', lessonId);
      if (lesson.attendanceStatus !== 'SUBMITTED') {
        throw new StateInvalidError(
          'attendance register',
          lesson.attendanceStatus.toLowerCase(),
          'approved',
        );
      }

      await tx.lesson.update({
        where: { id: lesson.id },
        data: {
          attendanceStatus: 'APPROVED',
          attendanceApprovedById: ctx.isSystem ? null : ctx.userId,
          attendanceApprovedAt: new Date(),
        },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.ATTENDANCE_APPROVED,
          entityType: 'Lesson',
          entityId: lesson.id,
          branchId: lesson.branchId,
          summary: `Attendance register approved for ${lesson.group.name}`,
        },
        tx,
      );

      return { lessonId: lesson.id, attendanceStatus: 'APPROVED' };
    },
    { existing: db },
  );
}
