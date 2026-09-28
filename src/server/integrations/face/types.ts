/**
 * The face-recognition provider boundary.
 *
 * Everything above this file (the attendance use-case, the devices API, the
 * settings screen) talks to `FaceRecognitionProvider` and never to a vendor SDK.
 * That is what lets a deployment run with no biometrics at all, and what lets
 * the UI tell the truth about which of those it is doing.
 *
 * Two contract decisions carry most of the weight here:
 *
 * 1. `isRealRecognition` is part of the interface, not a detail of one driver.
 *    A provider that simulates results must declare it, so the UI can label the
 *    feature instead of implying a working biometric system. Nothing may infer
 *    this from `key`.
 *
 * 2. `FaceIdentifyResult` is a discriminated union, not a struct with optional
 *    fields. `subjectRef` and `confidencePpm` exist ONLY on the two outcomes that
 *    actually identified someone, so `if (r.result === 'NO_MATCH') markPresent(r.subjectRef)`
 *    is a compile error rather than a runtime incident. This is the single most
 *    important type in the biometric path: the failure mode being designed out is
 *    marking the wrong child present.
 *
 * Confidence is integer parts-per-million throughout (0.98 -> 980_000), matching
 * `AttendanceRecord.confidencePpm` and `FaceRecognitionEvent.confidencePpm`.
 * Floats are never used for a threshold that decides an attendance record.
 */

import type { FaceRecognitionResult } from '@/generated/prisma/client';
import { LimitExceededError, UnsupportedMediaTypeError } from '@/server/errors';

// ---------------------------------------------------------------------------
// Identify outcomes
// ---------------------------------------------------------------------------

/** Someone was identified with confidence at or above the configured threshold. */
export interface FaceMatched {
  readonly result: 'MATCHED';
  /** The `subjectRef` supplied at enrolment. Opaque to the provider. */
  readonly subjectRef: string;
  readonly confidencePpm: number;
  /** The threshold this result cleared, recorded so a later audit can reproduce the decision. */
  readonly thresholdPpm: number;
}

/**
 * A plausible subject was found but below the threshold. Deliberately NOT folded
 * into NO_MATCH: an operator seeing "low confidence, try again in better light"
 * behaves differently from one seeing "not recognised". It carries `subjectRef`
 * so a human can be offered a confirmation step -- it must never be auto-accepted.
 */
export interface FaceLowConfidence {
  readonly result: 'LOW_CONFIDENCE';
  readonly subjectRef: string;
  readonly confidencePpm: number;
  readonly thresholdPpm: number;
}

/** A face was searched for and nothing matched. */
export interface FaceNoMatch {
  readonly result: 'NO_MATCH';
}

/**
 * Two or more DIFFERENT subjects matched above the threshold. Never resolved by
 * picking the highest score: an ambiguous biometric match is a refusal, because
 * the cost of guessing is attributing a lesson to the wrong student.
 */
export interface FaceMultipleMatches {
  readonly result: 'MULTIPLE_MATCHES';
  /** How many distinct subjects tied. Never the subjects themselves -- see below. */
  readonly candidateCount: number;
}

/** The provider has nothing to match against: no enrolment exists. */
export interface FaceNotEnrolled {
  readonly result: 'NOT_ENROLLED';
}

/** The provider was reached (or attempted) and failed. Not a verdict about a person. */
export interface FaceError {
  readonly result: 'ERROR';
  /** Stable, machine-readable; goes to `FaceRecognitionEvent.errorCode`. */
  readonly errorCode: string;
  /** Safe to log and show an operator. Never contains credentials or image data. */
  readonly errorMessage: string;
}

/** No provider is configured. A first-class outcome, never dressed up as NO_MATCH. */
export interface FaceNotConfigured {
  readonly result: 'NOT_CONFIGURED';
  /** Why, precisely -- "no provider selected", "collection missing", "credentials rejected". */
  readonly reason: string;
}

export type FaceIdentifyResult =
  | FaceMatched
  | FaceLowConfidence
  | FaceNoMatch
  | FaceMultipleMatches
  | FaceNotEnrolled
  | FaceError
  | FaceNotConfigured;

/**
 * The two outcomes that produced a subject. Callers that need to log a
 * confidence alongside a person narrow to this rather than testing two literals.
 */
export type FaceIdentifiedResult = FaceMatched | FaceLowConfidence;

export function isFaceIdentified(result: FaceIdentifyResult): result is FaceIdentifiedResult {
  return result.result === 'MATCHED' || result.result === 'LOW_CONFIDENCE';
}

/**
 * Whether this outcome may be turned into an attendance record without a human
 * confirming it. Exactly one outcome qualifies. Written as a function so the
 * answer lives in the boundary rather than being re-derived at each call site.
 */
export function isFaceAutoAcceptable(result: FaceIdentifyResult): result is FaceMatched {
  return result.result === 'MATCHED';
}

/**
 * Compile-time proof that this union and `FaceRecognitionResult` in the schema
 * stay in step. If a member is added to the Prisma enum and not here (or vice
 * versa), these two aliases stop resolving to `never` and the build fails --
 * which is the point: a persisted result the union cannot express would be
 * written to the database by some other path.
 */
type AssertNever<T extends never> = T;
type _EveryEnumMemberIsModelled = AssertNever<
  Exclude<FaceRecognitionResult, FaceIdentifyResult['result']>
>;
type _NoMemberOutsideTheEnum = AssertNever<
  Exclude<FaceIdentifyResult['result'], FaceRecognitionResult>
>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface FaceEnrollInput {
  /**
   * The application's handle for the person -- `Student.id` / `Employee.id`. The
   * provider stores it alongside its template so `identify` can hand it back;
   * the provider never learns what it refers to.
   */
  readonly subjectRef: string;
  readonly image: Uint8Array;
  readonly contentType: string;
}

export interface FaceEnrollResult {
  /**
   * The provider-side identifier, for `BiometricEnrollment.externalRef`. Opaque:
   * nothing above this boundary may parse it, and it is the only thing about the
   * enrolment this application is allowed to keep.
   */
  readonly externalRef: string;
}

export interface FaceIdentifyInput {
  readonly image: Uint8Array;
  readonly contentType: string;
  /**
   * Restrict the search to these subjects -- the roster of the lesson being
   * marked. Narrowing the candidate set is the cheapest available reduction in
   * false-positive rate, so callers should always pass it when they know it.
   */
  readonly candidateRefs?: readonly string[];
}

export interface FaceProviderHealth {
  readonly configured: boolean;
  /** Shown verbatim in Settings. Must name the missing piece, not just "unavailable". */
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** Keys accepted by `FACE_RECOGNITION_PROVIDER`. Kept narrow so the registry in
 * `./index.ts` is exhaustively checked when a provider is added. */
export type FaceProviderKey = 'none' | 'mock' | 'aws-rekognition';

export interface FaceRecognitionProvider {
  readonly key: FaceProviderKey;
  /**
   * False for anything that does not compare biometric templates. The settings
   * badge and every screen that shows a face-captured attendance read this.
   */
  readonly isRealRecognition: boolean;

  /**
   * Never throws: this backs a status badge, and a page that 500s because an
   * integration is down tells the administrator less than a red badge does.
   */
  health(): Promise<FaceProviderHealth>;

  /**
   * Register a subject's face. Throws rather than returning a result union,
   * because there is no partial success worth recording: either an
   * `externalRef` exists to store or the enrolment did not happen.
   */
  enroll(input: FaceEnrollInput): Promise<FaceEnrollResult>;

  /** Returns a verdict; throws only on a programming error. */
  identify(input: FaceIdentifyInput): Promise<FaceIdentifyResult>;

  /**
   * Remove the provider-side template. Must be idempotent -- the caller deletes
   * its row after this resolves, and a retry after a partial failure must not be
   * blocked by an already-deleted reference. Must NOT resolve successfully
   * without having actually reached the provider: a false "deleted" is a privacy
   * failure, not a convenience.
   */
  deleteEnrollment(externalRef: string): Promise<void>;
}

/** What Settings renders. `isRealRecognition` travels with the status so the badge
 * can never say "Connected" about a simulator. */
export interface FaceProviderStatus extends FaceProviderHealth {
  readonly key: FaceProviderKey;
  readonly isRealRecognition: boolean;
}

// ---------------------------------------------------------------------------
// Image rules, shared by every driver
// ---------------------------------------------------------------------------

/**
 * JPEG and PNG only. This is not a house preference: AWS Rekognition accepts
 * exactly these two, so allowing more here would move the rejection from our
 * boundary (a clear 415) to a vendor `InvalidImageFormatException` (an opaque
 * 502) -- and would make the mock accept input the real provider refuses.
 */
export const SUPPORTED_FACE_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

/** Rekognition's limit for an inline image payload. */
export const MAX_FACE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Strip parameters and case so `IMAGE/JPEG; charset=binary` compares equal. */
export function normalizeImageContentType(contentType: string): string {
  const [type] = contentType.split(';');
  return (type ?? '').trim().toLowerCase();
}

/**
 * Enforced by every driver on the way in, so a misconfigured terminal gets the
 * same answer whichever provider is selected.
 */
export function assertUsableFaceImage(input: { image: Uint8Array; contentType: string }): void {
  const normalized = normalizeImageContentType(input.contentType);
  if (!SUPPORTED_FACE_IMAGE_TYPES.some((allowed) => allowed === normalized)) {
    throw new UnsupportedMediaTypeError(
      `A face image must be ${SUPPORTED_FACE_IMAGE_TYPES.join(' or ')}.`,
      { details: { received: normalized || 'unknown' } },
    );
  }
  if (input.image.byteLength === 0) {
    throw new UnsupportedMediaTypeError('The face image is empty.');
  }
  if (input.image.byteLength > MAX_FACE_IMAGE_BYTES) {
    throw new LimitExceededError('This photo is too large. Use an image under 5 MB.', {
      maxBytes: MAX_FACE_IMAGE_BYTES,
      receivedBytes: input.image.byteLength,
    });
  }
}
