/**
 * S3 storage driver, spoken over the REST API with `fetch` and signed with AWS
 * Signature Version 4 computed here from `node:crypto`.
 *
 * WHY NO SDK: `@aws-sdk/client-s3` is not a dependency of this project, and the
 * five requests we need (PUT, GET, HEAD, DELETE, presigned GET) are a thin layer
 * over HTTP. The part worth care is the signature, and it is implemented in full
 * below -- canonical request, string to sign, the four-step HMAC chain -- rather
 * than approximated. A half-signed request does not fail loudly: it returns 403
 * from AWS with `SignatureDoesNotMatch` and looks like a credentials problem
 * forever, which is exactly why this is written out explicitly and kept testable
 * (`__testing` exposes every intermediate string).
 *
 * Reference: AWS "Signature Version 4 signing process", the SigV4 spec for S3.
 * Also works against S3-compatible endpoints (MinIO, Ceph, Wasabi) via
 * `S3_ENDPOINT`, which switches to path-style addressing.
 */

import { createHash, createHmac } from 'node:crypto';
import { env } from '@/server/env';
import {
  BadRequestError,
  IntegrationFailedError,
  IntegrationNotConfiguredError,
  NotFoundError,
} from '@/server/errors';
import { logger } from '@/server/observability/logger';
import type { GetResult, PutOptions, PutResult, StorageProvider } from './types';
import { assertDeclaredLength, checksumOf } from './validate';

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
/** A presigned URL carries no body hash; the literal below is what S3 expects. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** S3's hard ceiling for a presigned URL. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

interface S3Config {
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Absolute origin of an S3-compatible service, or null for AWS itself. */
  readonly endpoint: string | null;
}

let cachedConfig: S3Config | null = null;

/**
 * Resolved lazily rather than at module load: `env` already refuses to boot with
 * `STORAGE_DRIVER=s3` and missing credentials, so reaching the throw below means
 * something asked for the S3 driver while the deployment is configured for local
 * disk. That is a "not configured" state, not a crash.
 */
function config(): S3Config {
  if (cachedConfig) return cachedConfig;

  const { S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT } = env;
  if (!S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new IntegrationNotConfiguredError(
      'S3 storage',
      'S3 storage is not configured. Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
    );
  }
  if (S3_ENDPOINT && !/^https?:\/\//.test(S3_ENDPOINT)) {
    throw new IntegrationNotConfiguredError(
      'S3 storage',
      'S3_ENDPOINT must be an absolute URL, e.g. https://minio.example.uz:9000.',
    );
  }

  cachedConfig = {
    bucket: S3_BUCKET,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    endpoint: S3_ENDPOINT ?? null,
  };
  return cachedConfig;
}

// ---------------------------------------------------------------------------
// Signature V4 primitives
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

const EMPTY_PAYLOAD_SHA256 = sha256Hex('');

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone, and AWS
 * includes them in the set that must be escaped -- a key containing an
 * apostrophe would otherwise produce a canonical request that disagrees with the
 * URI actually sent, and the request would 403 with no clue why.
 */
function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
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

interface RequestTarget {
  readonly url: string;
  /** The percent-encoded path, exactly as it must appear in the canonical request. */
  readonly canonicalUri: string;
  /** Includes the port when it is not the scheme default, as the Host header does. */
  readonly host: string;
  readonly origin: string;
}

/**
 * Virtual-hosted addressing (`bucket.s3.region.amazonaws.com`) for AWS, path
 * style (`endpoint/bucket/key`) for anything else: a self-hosted MinIO almost
 * never has per-bucket DNS, and getting this wrong changes the canonical URI and
 * therefore the signature.
 */
function objectTarget(configuration: S3Config, key: string): RequestTarget {
  // `false`: slashes are path separators here, not data.
  const encodedKey = uriEncode(key, false);

  if (configuration.endpoint) {
    const base = new URL(configuration.endpoint);
    const prefix = base.pathname.replace(/\/+$/, '');
    const canonicalUri = `${prefix}/${uriEncode(configuration.bucket, true)}/${encodedKey}`;
    return {
      url: `${base.origin}${canonicalUri}`,
      canonicalUri,
      host: base.host,
      origin: base.origin,
    };
  }

  const host = `${configuration.bucket}.s3.${configuration.region}.amazonaws.com`;
  const canonicalUri = `/${encodedKey}`;
  return { url: `https://${host}${canonicalUri}`, canonicalUri, host, origin: `https://${host}` };
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

interface SignedRequest {
  /** Ready for `fetch`. Deliberately excludes `host` -- see below. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

function signRequest(input: {
  configuration: S3Config;
  method: string;
  target: RequestTarget;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
  now: Date;
}): SignedRequest {
  const { configuration, method, target, payloadHash } = input;
  const { amzDate, dateStamp } = timestamps(input.now);

  const headersToSign: Record<string, string> = {
    ...input.extraHeaders,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  const entries = canonicalHeaderEntries(headersToSign);
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');

  const canonicalRequest = [
    method,
    target.canonicalUri,
    // No query string on any of the requests this driver makes.
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
    headers: {
      ...input.extraHeaders,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
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

/**
 * Query-string signing, for a URL the browser fetches without our credentials.
 * The payload hash is the `UNSIGNED-PAYLOAD` literal and `host` is the only
 * signed header, because a browser controls everything else it sends.
 */
function presignGet(input: {
  configuration: S3Config;
  key: string;
  expiresInSeconds: number;
  now: Date;
}): string {
  const { configuration } = input;
  const target = objectTarget(configuration, input.key);
  const { amzDate, dateStamp } = timestamps(input.now);
  const scope = `${dateStamp}/${configuration.region}/${SERVICE}/aws4_request`;

  const parameters: Array<readonly [string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${configuration.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  const canonicalQuery = parameters
    .map(([name, value]) => [uriEncode(name, true), uriEncode(value, true)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    target.canonicalUri,
    canonicalQuery,
    `host:${target.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(configuration.secretAccessKey, dateStamp, configuration.region),
    stringToSign,
  ).toString('hex');

  return `${target.origin}${target.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function send(
  operation: string,
  target: RequestTarget,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(target.url, init);
  } catch (error) {
    // Transport failure: DNS, TLS, timeout. Never the caller's fault, and never
    // a reason to lose the file silently.
    logger.error('storage.s3.transport_failed', { operation, error });
    throw new IntegrationFailedError('S3 storage', {
      cause: error,
      details: { operation },
    });
  }
}

/**
 * S3 answers a failure with an XML `<Error>` document naming the bucket and key.
 * It is worth logging and must not reach the client, which learns only that the
 * integration failed.
 */
async function failed(operation: string, response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  logger.error('storage.s3.request_failed', {
    operation,
    status: response.status,
    response: body.slice(0, 500),
  });
  throw new IntegrationFailedError('S3 storage', {
    details: { operation, status: response.status },
  });
}

async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  options: PutOptions,
): Promise<PutResult> {
  assertDeclaredLength(body, options.contentLength);
  const configuration = config();
  const target = objectTarget(configuration, key);

  // The body hash is part of the signature, so S3 rejects a payload altered in
  // flight -- integrity of the upload comes free with authentication.
  const payloadHash = sha256Hex(body);
  const signed = signRequest({
    configuration,
    method: 'PUT',
    target,
    payloadHash,
    extraHeaders: { 'content-type': options.contentType },
    now: new Date(),
  });

  const response = await send('put', target, {
    method: 'PUT',
    headers: signed.headers,
    // `BodyInit` rejects `Uint8Array<ArrayBufferLike>` because the backing store
    // could be a SharedArrayBuffer, which fetch cannot send. Re-viewing the bytes
    // over a plain ArrayBuffer satisfies the type without copying the payload.
    body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
  });
  if (!response.ok) await failed('put', response);
  // Drain so undici can release the connection back to the pool.
  await response.arrayBuffer().catch(() => undefined);

  return { key, size: body.byteLength, checksum: checksumOf(body) };
}

async function getObject(key: string): Promise<GetResult> {
  const configuration = config();
  const target = objectTarget(configuration, key);
  const signed = signRequest({
    configuration,
    method: 'GET',
    target,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now: new Date(),
  });

  const response = await send('get', target, { method: 'GET', headers: signed.headers });
  if (response.status === 404) throw new NotFoundError('File');
  if (!response.ok) await failed('get', response);
  if (!response.body) {
    throw new IntegrationFailedError('S3 storage', { details: { operation: 'get' } });
  }

  return {
    stream: response.body,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    size: Number(response.headers.get('content-length') ?? 0),
  };
}

async function deleteObject(key: string): Promise<void> {
  const configuration = config();
  const target = objectTarget(configuration, key);
  const signed = signRequest({
    configuration,
    method: 'DELETE',
    target,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now: new Date(),
  });

  const response = await send('delete', target, { method: 'DELETE', headers: signed.headers });
  // S3 answers 204 whether or not the key existed; 404 appears on some
  // S3-compatible services. Both mean the object is gone, which is what was asked.
  if (!response.ok && response.status !== 404) await failed('delete', response);
  await response.arrayBuffer().catch(() => undefined);
}

async function objectExists(key: string): Promise<boolean> {
  const configuration = config();
  const target = objectTarget(configuration, key);
  const signed = signRequest({
    configuration,
    method: 'HEAD',
    target,
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now: new Date(),
  });

  const response = await send('exists', target, { method: 'HEAD', headers: signed.headers });
  if (response.status === 404) return false;
  if (!response.ok) await failed('exists', response);
  return true;
}

async function signedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > MAX_PRESIGN_SECONDS
  ) {
    // Clamping silently would hand back a URL that expires at a time the caller
    // did not choose, and the caller is our own code.
    throw new BadRequestError(
      `A signed URL must expire between 1 and ${MAX_PRESIGN_SECONDS} seconds from now.`,
    );
  }
  const configuration = config();
  return presignGet({ configuration, key, expiresInSeconds, now: new Date() });
}

export const S3StorageProvider: StorageProvider = {
  name: 's3',
  put: putObject,
  get: getObject,
  delete: deleteObject,
  exists: objectExists,
  signedUrl,
};

/**
 * Exposed so the signature can be unit-tested against the vectors in the AWS
 * documentation without a bucket or a network. Every intermediate string the
 * spec names is reachable from here, because "the signature is wrong somewhere"
 * is otherwise undebuggable.
 */
export const __testing = {
  uriEncode,
  timestamps,
  signingKey,
  objectTarget,
  signRequest,
  presignGet,
  sha256Hex,
  EMPTY_PAYLOAD_SHA256,
  resetConfigCache: () => {
    cachedConfig = null;
  },
};
