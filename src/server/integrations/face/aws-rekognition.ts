/**
 * AWS Rekognition, spoken over its REST API with `fetch` and signed with
 * Signature Version 4 computed here from `node:crypto`.
 *
 * This is the only driver in this directory that performs real biometric
 * recognition, so `isRealRecognition` is true and every outcome it reports is
 * something Rekognition actually said.
 *
 * WHY NO SDK: `@aws-sdk/client-rekognition` is not a dependency of this project.
 * Rekognition is a JSON-1.1 RPC API -- one POST to `/` with an `X-Amz-Target`
 * header -- so the only part worth care is the signature, and it is written out in
 * full below rather than approximated. A half-signed request does not fail
 * loudly: AWS answers 403 `SignatureDoesNotMatch`, which looks like a credentials
 * problem forever. For a biometric provider that is worse than being absent,
 * because the terminal would report NOT_CONFIGURED while the administrator can see
 * the credentials are right there in the environment.
 *
 * The signer deliberately mirrors `src/server/storage/s3.ts` step for step --
 * canonical request, string to sign, the four-step HMAC chain, the same
 * `timestamps`/`hmac`/`sha256Hex` primitives with the same names. It is not
 * imported from there because that module bakes `s3` into its key derivation
 * (the service name is the third HMAC step), and the AWS signing algorithm is not
 * something to parameterise across two integrations that are otherwise unrelated:
 * the copy is 60 lines, and each side is independently verifiable against the
 * published AWS test vectors through its own `__testing` export.
 *
 * FaceId/ExternalImageId mapping, which the rest of the system depends on:
 *
 *   IndexFaces  ExternalImageId := subjectRef   -> FaceId becomes `externalRef`
 *   SearchFaces FaceMatch.Face.ExternalImageId  -> the subjectRef handed back
 *   DeleteFaces FaceIds := [externalRef]
 *
 * So the only thing about a person that reaches AWS is an opaque application id,
 * and the only thing stored here is an opaque AWS id -- which is what
 * `BiometricEnrollment` is allowed to hold.
 */

import { createHash, createHmac } from 'node:crypto';
import { env } from '@/server/env';
import {
  BadRequestError,
  IntegrationFailedError,
  IntegrationNotConfiguredError,
  LimitExceededError,
  UnsupportedMediaTypeError,
} from '@/server/errors';
import { logger } from '@/server/observability/logger';
import {
  assertUsableFaceImage,
  type FaceEnrollInput,
  type FaceEnrollResult,
  type FaceIdentifyInput,
  type FaceIdentifyResult,
  type FaceNoMatch,
  type FaceNotEnrolled,
  type FaceProviderHealth,
  type FaceRecognitionProvider,
} from './types';

const INTEGRATION = 'AWS Rekognition';

/** The SigV4 service name. Also the host label: `rekognition.<region>.amazonaws.com`. */
const SERVICE = 'rekognition';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** Rekognition is JSON-1.1 RPC: one path, the operation named by a header. */
const CANONICAL_URI = '/';
const CONTENT_TYPE = 'application/x-amz-json-1.1';
const TARGET_PREFIX = 'RekognitionService';

/**
 * Long enough for a cold call carrying a 5 MB frame, short enough that an
 * unreachable region does not pin the request that is waiting on it. A terminal
 * polls this path, so a stuck call must end on its own.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How many matches to ask for. More than one because MULTIPLE_MATCHES has to be
 * detectable -- with `MaxFaces: 1` an ambiguous face would silently return
 * whichever subject scored highest, which is the exact failure the result union
 * exists to prevent. Five is enough to see a tie; this is not a gallery ranking.
 */
const MAX_SEARCH_MATCHES = 5;

/**
 * How far below the accept threshold Rekognition is still asked to return a
 * candidate. Without this band it would filter near-misses out server side and
 * LOW_CONFIDENCE could never be reported, so an operator would read "not
 * recognised" for a face the system very nearly recognised.
 */
const SEARCH_BAND_PPM = 100_000;

/**
 * The band never reaches below 50% similarity. Rekognition will happily return a
 * 45% "match", and putting an unrelated child's name in front of an operator as a
 * confirmable candidate is worse than reporting NO_MATCH. A consequence worth
 * being explicit about: at the lowest permitted `FACE_MATCH_MIN_CONFIDENCE_PPM`
 * (500_000) the band collapses and LOW_CONFIDENCE stops being reachable, because
 * there is no room left below it worth showing anyone.
 */
const MIN_SEARCH_THRESHOLD_PPM = 500_000;

/**
 * `ExternalImageId` accepts `[a-zA-Z0-9_.\-:]` only, up to 255 characters. Checked
 * at our boundary so an unusable id produces our own precise error instead of a
 * `ValidationException` naming an AWS field nobody above this file has heard of.
 */
const INDEXABLE_SUBJECT_REF = /^[a-zA-Z0-9_.:-]{1,255}$/;

/**
 * A Rekognition FaceId is a UUID. The shape is checked before a delete so a
 * reference minted by another driver (`mock-…`) is refused rather than sent to
 * AWS, which would answer 200 for an id it has never seen and let this
 * application report a biometric template as deleted when nothing was deleted.
 */
const REKOGNITION_FACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** AWS names for "these credentials cannot be used here". A configuration fault. */
const CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'ExpiredTokenException',
  'InvalidAccessKeyId',
]);

/** The same request is worth making again. Reported so a caller can decide to. */
const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'LimitExceededException',
  'InternalServerError',
  'ServiceUnavailableException',
  'RequestTimeout',
]);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RekognitionConfig {
  readonly collectionId: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

let cachedConfig: RekognitionConfig | null = null;

/**
 * Resolved lazily, exactly as the S3 driver does: `env` already refuses to boot
 * with `FACE_RECOGNITION_PROVIDER=aws-rekognition` and any of these missing, so
 * reaching the throw below means something asked for this driver while the
 * deployment is configured for another. That is a "not configured" state.
 */
function config(): RekognitionConfig {
  if (cachedConfig) return cachedConfig;

  const {
    AWS_REKOGNITION_COLLECTION_ID,
    AWS_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
  } = env;
  if (
    !AWS_REKOGNITION_COLLECTION_ID ||
    !AWS_REGION ||
    !AWS_ACCESS_KEY_ID ||
    !AWS_SECRET_ACCESS_KEY
  ) {
    throw new IntegrationNotConfiguredError(INTEGRATION, MISSING_CONFIG_MESSAGE);
  }

  cachedConfig = {
    collectionId: AWS_REKOGNITION_COLLECTION_ID,
    region: AWS_REGION,
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  };
  return cachedConfig;
}

const MISSING_CONFIG_MESSAGE =
  'AWS Rekognition is selected but not fully configured. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REKOGNITION_COLLECTION_ID.';

/**
 * `health` and `identify` are both contractually non-throwing, for the same
 * reason as in `not-configured.ts`: one backs a status badge and the other backs
 * an endpoint a wall-mounted terminal polls, so an incomplete environment has to
 * become a reported state rather than a stream of 503s. `enroll` and
 * `deleteEnrollment` keep the throw -- there is no result to return in their place.
 */
function configOrNull(): RekognitionConfig | null {
  try {
    return config();
  } catch {
    // The only reason config() throws.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signature V4
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20260927T091500Z` and its `20260927` date stamp, both UTC by definition. */
function timestamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * The four-step key derivation. Each step narrows the key's validity -- date,
 * then region, then service -- so a leaked signing key is useless tomorrow, for
 * another region, or against another AWS service.
 */
function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function canonicalHeaderEntries(headers: Record<string, string>): Array<readonly [string, string]> {
  return Object.entries(headers)
    .map(
      ([name, value]) =>
        // Canonical form: lower-case name, trimmed value, runs of internal
        // whitespace collapsed to one space.
        [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

type RekognitionAction =
  | 'IndexFaces'
  | 'SearchFacesByImage'
  | 'DeleteFaces'
  | 'DescribeCollection';

interface SignedRequest {
  readonly url: string;
  /** Ready for `fetch`. Deliberately excludes `host` -- see below. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

function signRequest(input: {
  configuration: RekognitionConfig;
  action: RekognitionAction;
  /** The exact JSON text that will be sent, because its hash is signed. */
  payload: string;
  now: Date;
}): SignedRequest {
  const { configuration, action, payload } = input;
  const { amzDate, dateStamp } = timestamps(input.now);

  const host = `${SERVICE}.${configuration.region}.amazonaws.com`;
  const payloadHash = sha256Hex(payload);
  const amzTarget = `${TARGET_PREFIX}.${action}`;

  // `x-amz-content-sha256` is only mandatory for S3, but every `x-amz-*` header
  // that is sent must be signed, and signing it costs nothing -- so the header
  // set stays identical to the S3 driver's and there is one canonical form to
  // reason about rather than two.
  const headersToSign: Record<string, string> = {
    'content-type': CONTENT_TYPE,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-target': amzTarget,
  };

  const entries = canonicalHeaderEntries(headersToSign);
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');

  const canonicalRequest = [
    'POST',
    CANONICAL_URI,
    // Rekognition takes no query string on any operation.
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${configuration.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(configuration.secretAccessKey, dateStamp, configuration.region),
    stringToSign,
  ).toString('hex');

  return {
    url: `https://${host}${CANONICAL_URI}`,
    headers: {
      'content-type': CONTENT_TYPE,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-target': amzTarget,
      // `host` is signed but never passed to fetch: it is a forbidden header
      // name, and the runtime sets it from the URL. The two agree because the
      // signature uses the same URL's host.
      authorization: `${ALGORITHM} Credential=${configuration.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

type RekognitionOutcome =
  | { readonly kind: 'OK'; readonly body: JsonObject }
  | {
      readonly kind: 'AWS_ERROR';
      readonly status: number;
      /** The exception name, e.g. `ResourceNotFoundException`. */
      readonly errorType: string;
      readonly errorMessage: string;
    }
  | {
      readonly kind: 'TRANSPORT';
      readonly errorCode: 'TIMEOUT' | 'NETWORK_ERROR';
      readonly errorMessage: string;
    };

type RekognitionFailure = Exclude<RekognitionOutcome, { kind: 'OK' }>;

/**
 * One Rekognition call. Never throws for an HTTP status or a dead socket: both are
 * outcomes the callers have to map -- `identify` onto a result union, `enroll` and
 * `deleteEnrollment` onto the right `AppError` -- and an exception here would
 * flatten the distinction between "AWS refused this image" and "AWS is down".
 *
 * Nothing about the request is logged but the action: the body carries a
 * base64 photograph and the headers carry a signature.
 */
async function call(action: RekognitionAction, payload: JsonObject): Promise<RekognitionOutcome> {
  const configuration = config();
  const body = JSON.stringify(payload);
  const signed = signRequest({ configuration, action, payload: body, now: new Date() });

  let response: Response;
  try {
    response = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A signed request is scoped to one host and one instant. Replaying it at
      // a redirect target would leak the Authorization header and fail anyway.
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (error) {
    return transportFailure(action, error);
  }

  const text = await response.text().catch(() => '');
  const parsed = parseJsonObject(text);

  if (response.ok) {
    if (parsed) return { kind: 'OK', body: parsed };
    // 200 with something that is not a JSON object: a proxy in the way, not AWS.
    logger.error('face.rekognition.malformed_response', { action, status: response.status });
    return {
      kind: 'AWS_ERROR',
      status: response.status,
      errorType: 'MALFORMED_RESPONSE',
      errorMessage: 'Rekognition answered with a body that is not a JSON object.',
    };
  }

  const failure: Extract<RekognitionOutcome, { kind: 'AWS_ERROR' }> = {
    kind: 'AWS_ERROR',
    status: response.status,
    errorType: awsErrorType(response, parsed),
    errorMessage: truncate(stringField(parsed, 'message') ?? stringField(parsed, 'Message') ?? ''),
  };
  logger.warn('face.rekognition.request_failed', {
    action,
    status: failure.status,
    errorType: failure.errorType,
    // Safe to log: AWS error prose names a collection or a parameter, never a key.
    errorMessage: failure.errorMessage,
  });
  return failure;
}

function transportFailure(action: RekognitionAction, error: unknown): RekognitionOutcome {
  // AbortSignal.timeout aborts with a TimeoutError; `redirect: 'error'` and a dead
  // socket both surface as a TypeError from fetch.
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';

  logger.warn('face.rekognition.transport_error', {
    action,
    reason: timedOut ? 'timeout' : 'network',
    // A fetch failure message names a host and a port, never a credential.
    detail: truncate(error instanceof Error ? error.message : String(error)),
  });

  return timedOut
    ? {
        kind: 'TRANSPORT',
        errorCode: 'TIMEOUT',
        errorMessage: 'AWS Rekognition did not answer in time.',
      }
    : {
        kind: 'TRANSPORT',
        errorCode: 'NETWORK_ERROR',
        errorMessage: 'AWS Rekognition could not be reached.',
      };
}

/**
 * The exception name, from wherever AWS put it. The header form is
 * `ResourceNotFoundException:http://internal…` and the body form is
 * `com.amazonaws.rekognition#ResourceNotFoundException`; both reduce to the name.
 */
function awsErrorType(response: Response, body: JsonObject | null): string {
  const raw =
    response.headers.get('x-amzn-errortype') ??
    stringField(body, '__type') ??
    stringField(body, 'code') ??
    '';
  const name = raw.split(':')[0]?.split('#').pop()?.trim() ?? '';
  return name === '' ? `HTTP_${response.status}` : name;
}

/**
 * A frame with nobody in it is the routine case for a wall-mounted terminal, and
 * Rekognition reports it as an `InvalidParameterException` rather than an empty
 * result set. Matched on the prose because the API offers no distinct code for it,
 * which is fragile by construction -- so a message that does not match falls
 * through to ERROR, where it is logged and surfaced, rather than to a silent
 * NO_MATCH that would hide a real misconfiguration.
 */
function isNoFaceDetected(failure: RekognitionFailure): boolean {
  return (
    failure.kind === 'AWS_ERROR' &&
    failure.errorType === 'InvalidParameterException' &&
    /no faces? in the image/i.test(failure.errorMessage)
  );
}

// ---------------------------------------------------------------------------
// Confidence conversion
// ---------------------------------------------------------------------------

/**
 * Rekognition reports `Similarity` and `Confidence` as a percentage in [0, 100]
 * with decimals (99.87). Everything above this boundary stores confidence as
 * integer parts-per-million, so the percentage is multiplied by 10_000:
 * 99.87% -> 998_700 ppm. Rounded rather than truncated so a value sitting exactly
 * on the configured threshold is not pushed under it by the conversion itself,
 * and clamped because a float from a vendor is not a proof of range.
 */
function percentToPpm(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(1_000_000, Math.max(0, Math.round(percent * 10_000)));
}

/** The inverse, for `FaceMatchThreshold` -- the one field AWS wants as a percent. */
function ppmToPercent(ppm: number): number {
  return ppm / 10_000;
}

function searchThresholdPercent(thresholdPpm: number): number {
  return ppmToPercent(Math.max(MIN_SEARCH_THRESHOLD_PPM, thresholdPpm - SEARCH_BAND_PPM));
}

// ---------------------------------------------------------------------------
// Reading untrusted JSON
//
// A vendor response is unknown input. Each field is narrowed one at a time so a
// missing or differently-typed field degrades to `undefined` instead of throwing
// inside the attendance path.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): JsonObject | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function objectField(source: JsonObject | null, key: string): JsonObject | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

function arrayField(source: JsonObject | null, key: string): readonly unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function stringField(source: JsonObject | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(source: JsonObject | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringItems(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value as readonly unknown[]) {
    if (typeof item === 'string' && item !== '') out.push(item);
  }
  return out;
}

const MAX_MESSAGE_CHARS = 400;

function truncate(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Rekognition takes an inline image as base64 of the raw JPEG/PNG bytes. */
function toBase64(image: Uint8Array): string {
  return Buffer.from(image.buffer as ArrayBuffer, image.byteOffset, image.byteLength).toString(
    'base64',
  );
}

interface RekognitionMatch {
  readonly subjectRef: string;
  readonly similarityPpm: number;
}

function readFaceMatches(body: JsonObject): readonly RekognitionMatch[] {
  const matches: RekognitionMatch[] = [];
  let unattributable = 0;

  for (const entry of arrayField(body, 'FaceMatches')) {
    if (!isRecord(entry)) continue;
    const face = objectField(entry, 'Face');
    const subjectRef = stringField(face, 'ExternalImageId');
    const similarity = numberField(entry, 'Similarity');

    if (!subjectRef || similarity === undefined) {
      // A face indexed into this collection by something other than this
      // application carries no ExternalImageId we can resolve. Dropping it is the
      // only safe reading: a match that cannot be named is not a match.
      unattributable += 1;
      continue;
    }
    matches.push({ subjectRef, similarityPpm: percentToPpm(similarity) });
  }

  if (unattributable > 0) {
    // Worth an operator's attention: it means the collection is shared with
    // something else, and recognition is running against faces we did not enrol.
    logger.warn('face.rekognition.unattributable_matches', { count: unattributable });
  }
  return matches;
}

/** Why Rekognition declined to index a face it did detect. */
function readUnindexedReasons(body: JsonObject): readonly string[] {
  const reasons = new Set<string>();
  for (const entry of arrayField(body, 'UnindexedFaces')) {
    if (!isRecord(entry)) continue;
    for (const reason of stringItems(entry['Reasons'])) reasons.add(reason);
  }
  return [...reasons];
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

/**
 * `identify` returns verdicts, so a failure has to become one. The two mapped
 * away from ERROR are both configuration faults rather than incidents, and the
 * settings badge and the terminal need to say so: a missing collection or a
 * rejected key means this deployment has no working biometrics, which is exactly
 * what NOT_CONFIGURED means.
 */
function identifyFailure(failure: RekognitionFailure, collectionId: string): FaceIdentifyResult {
  if (failure.kind === 'TRANSPORT') {
    return { result: 'ERROR', errorCode: failure.errorCode, errorMessage: failure.errorMessage };
  }
  if (failure.errorType === 'ResourceNotFoundException') {
    return {
      result: 'NOT_CONFIGURED',
      reason: `The Rekognition collection "${collectionId}" does not exist in this region. Create it before enabling face attendance.`,
    };
  }
  if (CREDENTIAL_ERRORS.has(failure.errorType)) {
    return {
      result: 'NOT_CONFIGURED',
      reason: `AWS rejected this deployment's Rekognition credentials (${failure.errorType}). Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION and the key's rekognition permissions.`,
    };
  }
  if (isNoFaceDetected(failure)) return { result: 'NO_MATCH' };

  return {
    result: 'ERROR',
    errorCode: failure.errorType,
    errorMessage: RETRYABLE_ERRORS.has(failure.errorType)
      ? 'AWS Rekognition is busy. Try again in a moment.'
      : `AWS Rekognition refused the request (${failure.errorType}).`,
  };
}

/**
 * `enroll` and `deleteEnrollment` throw, so a failure has to become the right
 * `AppError` -- the wrapper in `@/server/http/api` maps each to its own status,
 * and an operator whose photo was rejected for being 6 MB must not be told the
 * integration is down.
 */
function writeFailure(
  action: RekognitionAction,
  failure: RekognitionFailure,
  collectionId: string,
): Error {
  if (failure.kind === 'TRANSPORT') {
    return new IntegrationFailedError(INTEGRATION, {
      details: { action, errorCode: failure.errorCode },
    });
  }
  if (failure.errorType === 'ResourceNotFoundException') {
    return new IntegrationNotConfiguredError(
      INTEGRATION,
      `The Rekognition collection "${collectionId}" does not exist in this region (AWS_REKOGNITION_COLLECTION_ID). Create it before enrolling anyone.`,
    );
  }
  if (CREDENTIAL_ERRORS.has(failure.errorType)) {
    return new IntegrationNotConfiguredError(
      INTEGRATION,
      `AWS rejected this deployment's Rekognition credentials (${failure.errorType}). Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION.`,
    );
  }
  if (failure.errorType === 'InvalidImageFormatException') {
    return new UnsupportedMediaTypeError(
      'AWS could not read this image. Use a JPEG or PNG photo straight from the camera.',
    );
  }
  if (failure.errorType === 'ImageTooLargeException') {
    return new LimitExceededError('This photo is too large for AWS Rekognition. Use a smaller one.');
  }
  if (isNoFaceDetected(failure)) {
    return new BadRequestError(
      'No face was detected in this photo. Take a new one with the face clearly visible and facing the camera.',
    );
  }
  return new IntegrationFailedError(INTEGRATION, {
    details: { action, errorType: failure.errorType },
  });
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export interface AwsRekognitionProviderOptions {
  /**
   * The bar a similarity must clear to be reported as MATCHED. Defaults to the
   * deployment's configured threshold; overridable so a test can drive both sides
   * of the boundary without rewriting `env`.
   */
  readonly minConfidencePpm?: number;
}

export class AwsRekognitionFaceProvider implements FaceRecognitionProvider {
  readonly key = 'aws-rekognition' as const;
  /** Rekognition compares biometric templates. This one is the real thing. */
  readonly isRealRecognition = true;

  private readonly minConfidencePpm: number;

  /**
   * A one-way latch. Once the collection is known to hold at least one face, a
   * later empty search is a genuine NO_MATCH and needs no extra round trip to say
   * so. One-way on purpose: re-checking on every miss would add a
   * DescribeCollection call to the hot path of a terminal that is polling, and the
   * only cost of a stale reading is that a collection emptied mid-process reports
   * NO_MATCH where NOT_ENROLLED would have been more precise -- a wording
   * difference, not a wrong attendance record.
   */
  private collectionHasFaces = false;

  constructor(options: AwsRekognitionProviderOptions = {}) {
    this.minConfidencePpm = options.minConfidencePpm ?? env.FACE_MATCH_MIN_CONFIDENCE_PPM;
  }

  /**
   * Probed with DescribeCollection rather than by checking that the environment
   * variables are non-empty: "the keys are set" and "the keys work against a
   * collection that exists" are different claims, and the badge this backs is read
   * as the second one.
   */
  async health(): Promise<FaceProviderHealth> {
    const configuration = configOrNull();
    if (!configuration) return { configured: false, message: MISSING_CONFIG_MESSAGE };

    const outcome = await call('DescribeCollection', {
      CollectionId: configuration.collectionId,
    });

    if (outcome.kind === 'OK') {
      const faceCount = numberField(outcome.body, 'FaceCount') ?? 0;
      if (faceCount > 0) this.collectionHasFaces = true;
      const model = stringField(outcome.body, 'FaceModelVersion') ?? 'unknown';
      return {
        configured: true,
        message: `Connected to collection "${configuration.collectionId}" in ${configuration.region}: ${faceCount} enrolled face(s), face model ${model}. Matches are accepted at ${ppmToPercent(this.minConfidencePpm)}% similarity or above.`,
      };
    }

    if (outcome.kind === 'TRANSPORT') {
      return {
        configured: false,
        message: `AWS Rekognition is configured but could not be reached (${outcome.errorCode}). Credentials and collection are unverified.`,
      };
    }
    if (outcome.errorType === 'ResourceNotFoundException') {
      return {
        configured: false,
        message: `The collection "${configuration.collectionId}" does not exist in ${configuration.region}. Create it, or correct AWS_REKOGNITION_COLLECTION_ID.`,
      };
    }
    if (CREDENTIAL_ERRORS.has(outcome.errorType)) {
      return {
        configured: false,
        message: `AWS rejected the credentials (${outcome.errorType}). Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION and that the key may call rekognition:DescribeCollection.`,
      };
    }
    // Reported as not configured even for a transient fault: nothing here verified
    // that recognition works, and a badge reading "Connected" after a failed probe
    // is the one answer this method must never give.
    return {
      configured: false,
      message: `AWS Rekognition answered ${outcome.errorType} (HTTP ${outcome.status}) when the collection was checked, so it is unverified.`,
    };
  }

  async enroll(input: FaceEnrollInput): Promise<FaceEnrollResult> {
    assertUsableFaceImage(input);
    if (!INDEXABLE_SUBJECT_REF.test(input.subjectRef)) {
      throw new BadRequestError(
        'This subject id cannot be used with AWS Rekognition: it accepts letters, digits, and the characters _ . - : only, up to 255 characters.',
      );
    }

    const configuration = config();
    const outcome = await call('IndexFaces', {
      CollectionId: configuration.collectionId,
      // The only thing about the person that reaches AWS: our own opaque id. No
      // name, no date of birth, nothing a breach of the collection could read.
      ExternalImageId: input.subjectRef,
      Image: { Bytes: toBase64(input.image) },
      // One face per enrolment. A template that could belong to either of two
      // people in the frame is not an enrolment -- see EXCEEDS_MAX_FACES below.
      MaxFaces: 1,
      QualityFilter: 'AUTO',
      // No FaceDetail is requested: age, gender and emotion estimates are data
      // this application has no purpose for and therefore must not collect.
      DetectionAttributes: [],
    });

    if (outcome.kind !== 'OK') throw writeFailure('IndexFaces', outcome, configuration.collectionId);

    const reasons = readUnindexedReasons(outcome.body);
    const first = arrayField(outcome.body, 'FaceRecords')[0];
    if (!isRecord(first)) {
      throw new BadRequestError(
        reasons.length > 0
          ? `No face in this photo could be enrolled. AWS rejected it: ${reasons.join(', ')}. Take another in even light, with the face square to the camera.`
          : 'No face was detected in this photo. Take another with the face clearly visible and facing the camera.',
      );
    }

    const faceId = stringField(objectField(first, 'Face'), 'FaceId');
    if (!faceId) {
      // A record with no FaceId cannot be stored, deleted or matched later.
      throw new IntegrationFailedError(INTEGRATION, {
        details: { action: 'IndexFaces', reason: 'the indexed record carried no FaceId' },
      });
    }

    // AWS has stored a template. Latched here rather than on the success path
    // below, because it is true even when this enrolment is about to be rejected
    // and the orphan removal fails -- the latch must describe the collection, not
    // the outcome of this call.
    this.collectionHasFaces = true;

    if (reasons.includes('EXCEEDS_MAX_FACES')) {
      // More than one face was in the frame. Rekognition indexed the largest,
      // so the template just created may belong to whoever stood closest to the
      // camera rather than to the person being enrolled. That has to be undone,
      // not reported as a success.
      const removed = await this.tryRemoveOrphan(faceId);
      throw new BadRequestError(
        `More than one face is visible in this photo, so it is not clear whose template would be stored. Enrol from a photo with one person in the frame.${
          removed
            ? ''
            : ' The template AWS already created could not be removed automatically; an administrator must delete it from the collection.'
        }`,
      );
    }

    logger.info('face.rekognition.enrolled', { collectionId: configuration.collectionId });
    return { externalRef: faceId };
  }

  async identify(input: FaceIdentifyInput): Promise<FaceIdentifyResult> {
    const thresholdPpm = this.minConfidencePpm;

    // The caller narrowed the search to nobody, so there is nothing to match
    // against and no request worth paying for.
    if (input.candidateRefs && input.candidateRefs.length === 0) {
      return { result: 'NOT_ENROLLED' };
    }

    // Throws, like the mock: an unusable upload is the caller's 415, not a verdict
    // about a person, and both drivers must answer a bad request identically.
    assertUsableFaceImage(input);

    // A configuration fault is a verdict here, not a throw -- `env` only enforces
    // these variables when this provider is the selected one, so a driver
    // constructed directly must still be able to report its own state.
    const configuration = configOrNull();
    if (!configuration) return { result: 'NOT_CONFIGURED', reason: MISSING_CONFIG_MESSAGE };

    const outcome = await call('SearchFacesByImage', {
      CollectionId: configuration.collectionId,
      Image: { Bytes: toBase64(input.image) },
      FaceMatchThreshold: searchThresholdPercent(thresholdPpm),
      MaxFaces: MAX_SEARCH_MATCHES,
      QualityFilter: 'AUTO',
    });

    if (outcome.kind !== 'OK') return identifyFailure(outcome, configuration.collectionId);

    const found = readFaceMatches(outcome.body);
    // Anything at all came back, so the collection demonstrably holds faces. Latched
    // before the roster filter: otherwise a match belonging to another lesson's
    // student would leave the latch unset and send `emptySearchResult` to ask AWS a
    // question this response has already answered.
    if (found.length > 0) this.collectionHasFaces = true;

    const roster = input.candidateRefs ? new Set(input.candidateRefs) : null;
    const matches = roster ? found.filter((match) => roster.has(match.subjectRef)) : found;
    if (matches.length === 0) return this.emptySearchResult();

    // Best similarity per DISTINCT subject. One person enrolled from three photos
    // is three FaceIds and one subject, and must not read as an ambiguous match.
    const bySubject = new Map<string, number>();
    for (const match of matches) {
      const best = bySubject.get(match.subjectRef);
      if (best === undefined || match.similarityPpm > best) {
        bySubject.set(match.subjectRef, match.similarityPpm);
      }
    }

    const ranked = [...bySubject.entries()].sort(([, left], [, right]) => right - left);
    const above = ranked.filter(([, ppm]) => ppm >= thresholdPpm);
    if (above.length > 1) {
      // Refused rather than resolved by taking the top score: the cost of guessing
      // is attributing a lesson to the wrong student.
      return { result: 'MULTIPLE_MATCHES', candidateCount: above.length };
    }

    const top = ranked[0];
    // Unreachable -- `matches` was non-empty -- but the compiler cannot see that,
    // and NO_MATCH is the only safe thing to say when no subject is in hand.
    if (!top) return { result: 'NO_MATCH' };

    const [subjectRef, confidencePpm] = top;
    return confidencePpm >= thresholdPpm
      ? { result: 'MATCHED', subjectRef, confidencePpm, thresholdPpm }
      : // The highest near-miss is offered for a human to confirm. Taking the top
        // candidate is safe here only because LOW_CONFIDENCE is never
        // auto-acceptable (`isFaceAutoAcceptable`).
        { result: 'LOW_CONFIDENCE', subjectRef, confidencePpm, thresholdPpm };
  }

  async deleteEnrollment(externalRef: string): Promise<void> {
    if (!REKOGNITION_FACE_ID.test(externalRef)) {
      throw new BadRequestError(
        'This enrolment reference was not created by AWS Rekognition (a FaceId is a UUID), so it cannot be deleted through this provider. Select the provider it was enrolled with.',
      );
    }

    const configuration = config();
    const outcome = await call('DeleteFaces', {
      CollectionId: configuration.collectionId,
      FaceIds: [externalRef],
    });

    if (outcome.kind !== 'OK') throw writeFailure('DeleteFaces', outcome, configuration.collectionId);

    const unsuccessful = arrayField(outcome.body, 'UnsuccessfulFaceDeletions');
    if (unsuccessful.length > 0) {
      const reasons = new Set<string>();
      for (const entry of unsuccessful) {
        if (isRecord(entry)) for (const reason of stringItems(entry['Reasons'])) reasons.add(reason);
      }
      // AWS was reached and said it did not delete. Resolving here would tell a
      // person their biometric template was removed when it is still there.
      logger.error('face.rekognition.delete_refused', { reasons: [...reasons] });
      throw new IntegrationFailedError(INTEGRATION, {
        details: { action: 'DeleteFaces', reasons: [...reasons] },
      });
    }

    // An empty `DeletedFaces` with no refusal means the FaceId was not in the
    // collection: already in the desired state, which is what idempotent means
    // here. AWS was still reached, so this is not a claim made without checking.
    const alreadyAbsent = stringItems(outcome.body['DeletedFaces']).length === 0;
    logger.info('face.rekognition.enrollment_deleted', { alreadyAbsent });
  }

  /**
   * Distinguish "nobody matched" from "nothing to match against". Only asked when
   * the latch is unset, so an in-use collection pays for it once.
   */
  private async emptySearchResult(): Promise<FaceNoMatch | FaceNotEnrolled> {
    if (this.collectionHasFaces) return { result: 'NO_MATCH' };

    const configuration = config();
    const outcome = await call('DescribeCollection', {
      CollectionId: configuration.collectionId,
    });
    // The search itself succeeded and found nothing, so NO_MATCH is true whatever
    // this probe says. All that is lost when it fails is the more precise wording.
    if (outcome.kind !== 'OK') return { result: 'NO_MATCH' };

    const faceCount = numberField(outcome.body, 'FaceCount') ?? 0;
    if (faceCount === 0) return { result: 'NOT_ENROLLED' };

    this.collectionHasFaces = true;
    return { result: 'NO_MATCH' };
  }

  private async tryRemoveOrphan(faceId: string): Promise<boolean> {
    try {
      await this.deleteEnrollment(faceId);
      return true;
    } catch (error) {
      // Logged at error: a biometric template now exists at the provider that no
      // row in this database points at, which only a human can clear up.
      logger.error('face.rekognition.orphan_template', { faceId, error });
      return false;
    }
  }
}

/**
 * Exposed so the signature can be unit-tested against the published AWS test
 * vectors without credentials or a network, and so the result mapping can be
 * driven from recorded Rekognition responses. Every intermediate string the SigV4
 * spec names is reachable, because "the signature is wrong somewhere" is
 * otherwise undebuggable.
 *
 * STILL OWED, and worth stating plainly because the failure mode is a permanent
 * 403 that reads like bad credentials: `signingKey` has been checked against the
 * key-derivation vector in the AWS documentation (`20150830`/`us-east-1`, secret
 * `wJalrXUtnFEMI/...EXAMPLEKEY` -> `c4afb1cc5771d871...c154a4b9`, with `iam`
 * substituted for SERVICE) and reproduces it, but no test yet pins
 * `signRequest`'s canonical request and string-to-sign against a full published
 * vector. Add one from the AWS SigV4 test suite's `post-header-key-case` case
 * before trusting this against a live collection.
 */
export const __testing = {
  sha256Hex,
  hmac,
  timestamps,
  signingKey,
  signRequest,
  canonicalHeaderEntries,
  percentToPpm,
  ppmToPercent,
  searchThresholdPercent,
  awsErrorType,
  isNoFaceDetected,
  readFaceMatches,
  readUnindexedReasons,
  identifyFailure,
  writeFailure,
  toBase64,
  INDEXABLE_SUBJECT_REF,
  REKOGNITION_FACE_ID,
  resetConfigCache: () => {
    cachedConfig = null;
  },
};
