/**
 * ===========================================================================
 *  MOCK FACE RECOGNITION -- A SIMULATOR. IT PERFORMS NO BIOMETRIC RECOGNITION.
 *
 *  This provider never looks at an image. It does not detect a face, does not
 *  compute a template, does not compare anything to anything. Every outcome it
 *  returns was asked for, in writing, by the caller. It exists so the attendance
 *  UI, the event log and the failure states can be built and demonstrated
 *  without a biometric vendor -- not so that biometrics can appear to work.
 *
 *  `isRealRecognition` is false. `env.ts` refuses `FACE_RECOGNITION_PROVIDER=mock`
 *  when NODE_ENV=production, and that rejection is deliberate: with this driver
 *  selected, anyone who can post an image to the attendance endpoint can name the
 *  student to be marked present.
 * ===========================================================================
 *
 * THE DEVELOPER DIRECTIVE
 *
 * A match happens only when the image payload IS a small JSON control envelope:
 *
 *   { "__mockSubjectRef": "<student id>",
 *     "__mockResult": "MATCHED" | "LOW_CONFIDENCE" | "NO_MATCH"
 *                   | "MULTIPLE_MATCHES" | "NOT_ENROLLED" | "ERROR",
 *     "__mockConfidencePpm": 985000,
 *     "__mockCandidateCount": 3,
 *     "__mockErrorCode": "...", "__mockErrorMessage": "..." }
 *
 * Anything else -- a real JPEG, a PNG, random bytes -- returns NO_MATCH.
 * `__mockResult` defaults to MATCHED, so the envelope's minimum useful form is
 * `{"__mockSubjectRef":"<id>"}`; `mockFaceControlEnvelope()` below builds one.
 *
 * Chosen over the alternative (a `mockAccept` option on the provider plus a
 * single-element `candidateRefs`) because the directive then travels inside the
 * request instead of living in server configuration. That matters twice: a
 * developer or e2e test can drive every branch through the real HTTP endpoint
 * with no server restart and no special provider wiring, and -- more importantly
 * -- there is no server-side flag that could be left on and quietly convert
 * "this roster has one student" into "mark that student present". The payload is
 * self-evidently a directive when read in a log or a network trace, which an
 * option flag combined with an ordinary photo would not be.
 *
 * The simulated store holds an opaque reference and a subject id. No image and no
 * embedding, ever -- matching what `BiometricEnrollment` is allowed to hold, so
 * building against the mock cannot teach the rest of the system a shape the real
 * providers will not honour.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/server/env';
import { BadRequestError, IntegrationFailedError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import {
  assertUsableFaceImage,
  type FaceEnrollInput,
  type FaceEnrollResult,
  type FaceIdentifyInput,
  type FaceIdentifyResult,
  type FaceProviderHealth,
  type FaceRecognitionProvider,
} from './types';

/** The content type a directive is sent as. Never one of the image types. */
export const MOCK_FACE_CONTROL_CONTENT_TYPE = 'application/json';

/**
 * A directive is a control message, not an upload. Refusing to even attempt a
 * UTF-8 decode of anything larger keeps a 5 MB photo from being scanned for
 * JSON on every recognition attempt.
 */
const MAX_CONTROL_ENVELOPE_BYTES = 4_096;

/**
 * How far below the threshold a simulated LOW_CONFIDENCE sits when the caller
 * does not name a number. Far enough to be unambiguous in a screenshot.
 */
const LOW_CONFIDENCE_GAP_PPM = 70_000;

/**
 * NOT_CONFIGURED is absent on purpose: this provider IS configured, and letting a
 * directive fake "no provider" would let a test pass against a state this driver
 * can never really be in. Use `FACE_RECOGNITION_PROVIDER=none` for that.
 */
const directiveResultSchema = z.enum([
  'MATCHED',
  'LOW_CONFIDENCE',
  'NO_MATCH',
  'MULTIPLE_MATCHES',
  'NOT_ENROLLED',
  'ERROR',
]);

const controlEnvelopeSchema = z.object({
  __mockSubjectRef: z.string().min(1).max(200).optional(),
  __mockResult: directiveResultSchema.default('MATCHED'),
  __mockConfidencePpm: z.number().int().min(0).max(1_000_000).optional(),
  __mockCandidateCount: z.number().int().min(2).max(50).optional(),
  __mockErrorCode: z.string().min(1).max(64).optional(),
  __mockErrorMessage: z.string().min(1).max(500).optional(),
});

export type MockFaceDirective = z.input<typeof controlEnvelopeSchema>;
type ParsedDirective = z.output<typeof controlEnvelopeSchema>;

/** Build a directive payload. For dev tooling, seeds and e2e tests. */
export function mockFaceControlEnvelope(directive: MockFaceDirective): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(directive));
}

/**
 * Returns the directive, or null when the payload is not one (the ordinary case:
 * an actual photograph).
 *
 * A payload that clearly means to be a directive but is malformed throws instead
 * of falling through to NO_MATCH -- a silent NO_MATCH on a typo'd key is the
 * single most confusing failure this file could produce.
 */
function readControlEnvelope(image: Uint8Array): ParsedDirective | null {
  if (image.byteLength === 0 || image.byteLength > MAX_CONTROL_ENVELOPE_BYTES) return null;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(image).trim();
  } catch {
    return null;
  }
  if (!text.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const keys = Object.keys(parsed);
  if (!keys.some((key) => key.startsWith('__mock'))) return null;

  const result = controlEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError(
      'The mock face-recognition directive is not valid. See src/server/integrations/face/mock.ts for the accepted fields.',
      {
        fieldIssues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
    );
  }
  return result.data;
}

interface MockEnrollment {
  readonly subjectRef: string;
  readonly enrolledAt: Date;
}

/**
 * Process-local, exactly like the terminal-side store of a device that has been
 * power-cycled: a restart forgets enrolments and `identify` then honestly reports
 * NOT_ENROLLED. Parked on `globalThis` outside production for the same reason as
 * the Prisma client -- Next's HMR re-evaluates this module on every edit, and a
 * dev losing their enrolments on each keystroke would work around the mock rather
 * than with it.
 */
declare global {
  // `var` is required: only a `var` declaration augments the `globalThis` type.
  var __eduMockFaceEnrollments: Map<string, MockEnrollment> | undefined;
}

const enrollments: Map<string, MockEnrollment> = globalThis.__eduMockFaceEnrollments ?? new Map();

if (env.NODE_ENV !== 'production') {
  globalThis.__eduMockFaceEnrollments = enrollments;
}

function findEnrollment(subjectRef: string): boolean {
  for (const enrollment of enrollments.values()) {
    if (enrollment.subjectRef === subjectRef) return true;
  }
  // A linear scan over a development store. An index here would be upkeep for a
  // map that holds a demo class.
  return false;
}

export interface MockFaceProviderOptions {
  /**
   * The bar a simulated confidence must clear to be reported as MATCHED. Defaults
   * to the deployment's real threshold so the mock exercises the same boundary
   * the configured provider would.
   */
  readonly minConfidencePpm?: number;
}

export class MockFaceRecognitionProvider implements FaceRecognitionProvider {
  readonly key = 'mock' as const;
  /** No template is computed and no image is read. Nothing here is recognition. */
  readonly isRealRecognition = false;

  private readonly minConfidencePpm: number;

  constructor(options: MockFaceProviderOptions = {}) {
    this.minConfidencePpm = options.minConfidencePpm ?? env.FACE_MATCH_MIN_CONFIDENCE_PPM;
  }

  async health(): Promise<FaceProviderHealth> {
    return {
      configured: true,
      message: `Mock provider: simulated results only, no biometric recognition. ${enrollments.size} simulated enrolment(s) in this process.`,
    };
  }

  /**
   * Stores an opaque reference and nothing else.
   *
   * The reference is `sha256(subjectRef + salt)` with a fresh random salt per
   * enrolment, so it is derived from the subject rather than the image -- the
   * same photo enrolled twice yields two references, as it would at a real
   * provider that indexes each submission separately. The hash is not security;
   * it is there so no code above this boundary can pull a student id out of an
   * "opaque" reference and start depending on it, because `FaceId` from
   * Rekognition gives nothing to depend on.
   */
  async enroll(input: FaceEnrollInput): Promise<FaceEnrollResult> {
    const directive = readControlEnvelope(input.image);
    if (directive?.__mockResult === 'ERROR') {
      throw new IntegrationFailedError('Mock face recognition', {
        details: {
          simulated: true,
          errorCode: directive.__mockErrorCode ?? 'MOCK_SIMULATED_ENROLL_FAILURE',
        },
      });
    }
    // A directive stands in for a photo so a developer can enrol without a camera.
    // Anything else must satisfy the same rules the real provider enforces.
    if (!directive) assertUsableFaceImage(input);

    const salt = randomBytes(16).toString('hex');
    const externalRef = `mock-${createHash('sha256').update(`${input.subjectRef}:${salt}`).digest('hex').slice(0, 32)}`;

    enrollments.set(externalRef, { subjectRef: input.subjectRef, enrolledAt: new Date() });
    logger.warn('face.mock.enrolled', {
      simulated: true,
      externalRef,
      enrolmentCount: enrollments.size,
    });
    return { externalRef };
  }

  /**
   * Resolves a subject only from an explicit directive. There is no code path
   * here that reads `input.image` as an image.
   */
  async identify(input: FaceIdentifyInput): Promise<FaceIdentifyResult> {
    const directive = readControlEnvelope(input.image);

    if (!directive) {
      // The ordinary case: a real photograph, which this provider cannot assess.
      if (input.image.byteLength > 0) assertUsableFaceImage(input);
      return { result: 'NO_MATCH' };
    }

    const thresholdPpm = this.minConfidencePpm;

    switch (directive.__mockResult) {
      case 'NO_MATCH':
        return { result: 'NO_MATCH' };

      case 'NOT_ENROLLED':
        return { result: 'NOT_ENROLLED' };

      case 'MULTIPLE_MATCHES':
        return {
          result: 'MULTIPLE_MATCHES',
          candidateCount: directive.__mockCandidateCount ?? 2,
        };

      case 'ERROR':
        return {
          result: 'ERROR',
          errorCode: directive.__mockErrorCode ?? 'MOCK_SIMULATED_ERROR',
          errorMessage:
            directive.__mockErrorMessage ??
            'Simulated recognition failure from the mock provider.',
        };

      case 'MATCHED':
      case 'LOW_CONFIDENCE': {
        const subjectRef = directive.__mockSubjectRef;
        if (!subjectRef) {
          throw new BadRequestError(
            `A mock directive asking for ${directive.__mockResult} must also set "__mockSubjectRef".`,
          );
        }

        // Simulating a match against a subject that was never enrolled would let
        // a test pass through a branch the real providers cannot reach.
        if (!findEnrollment(subjectRef)) return { result: 'NOT_ENROLLED' };

        // Exercises the roster narrowing the real providers apply: someone not in
        // this lesson's candidate set is not a match for this lesson.
        if (input.candidateRefs && !input.candidateRefs.includes(subjectRef)) {
          return { result: 'NO_MATCH' };
        }

        const wantsMatch = directive.__mockResult === 'MATCHED';
        const requested = directive.__mockConfidencePpm;
        const confidencePpm = clampConfidenceToBranch(requested, wantsMatch, thresholdPpm);

        if (requested !== undefined && requested !== confidencePpm) {
          // Emitting MATCHED at 40% (or LOW_CONFIDENCE at 99%) would train the UI
          // and the event log on a pair that cannot occur, which is the opposite
          // of what a simulator is for.
          logger.warn('face.mock.confidence_clamped', {
            simulated: true,
            requestedPpm: requested,
            usedPpm: confidencePpm,
            thresholdPpm,
            branch: directive.__mockResult,
          });
        }

        return wantsMatch
          ? { result: 'MATCHED', subjectRef, confidencePpm, thresholdPpm }
          : { result: 'LOW_CONFIDENCE', subjectRef, confidencePpm, thresholdPpm };
      }
    }
  }

  /** Idempotent: an unknown reference is already in the desired state. */
  async deleteEnrollment(externalRef: string): Promise<void> {
    const existed = enrollments.delete(externalRef);
    logger.warn('face.mock.enrollment_deleted', { simulated: true, externalRef, existed });
  }
}

/** Keep the requested confidence inside the range its branch requires. */
function clampConfidenceToBranch(
  requested: number | undefined,
  wantsMatch: boolean,
  thresholdPpm: number,
): number {
  if (wantsMatch) {
    const fallback = Math.min(1_000_000, thresholdPpm + LOW_CONFIDENCE_GAP_PPM);
    if (requested === undefined) return fallback;
    return Math.max(requested, thresholdPpm);
  }
  const fallback = Math.max(0, thresholdPpm - LOW_CONFIDENCE_GAP_PPM);
  if (requested === undefined) return fallback;
  return Math.min(requested, Math.max(0, thresholdPpm - 1));
}

/** Exposed for unit tests and for a dev tool that needs to clear the simulated store. */
export const __testing = {
  readControlEnvelope,
  enrollments,
  clampConfidenceToBranch,
  reset: () => enrollments.clear(),
};
