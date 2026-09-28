/**
 * Webhook authentication primitives shared by the gateway drivers.
 *
 * All three gateways authenticate their callbacks with a pre-shared secret -- an
 * HMAC, an md5 digest, an HTTP Basic header. The comparison is the part that is
 * easy to get subtly and invisibly wrong, so it lives in one place with the
 * reasoning attached rather than being retyped in each driver.
 *
 * Also here: the tolerant readers each driver needs to pull fields out of a body
 * an attacker wrote. Nothing in this file trusts its input's shape.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison.
 *
 * `a === b` stops at the first differing byte, so a caller who can measure the
 * response can recover a signature -- or the signing key itself -- one byte at a
 * time: submit a guess, keep the prefix that took longest, repeat. That is a
 * practical attack over a network for a secret this short.
 *
 * `crypto.timingSafeEqual` compares every byte, but it throws when the buffers
 * differ in length, and the length would itself be a signal. Hashing both sides
 * first sidesteps both problems: two fixed-width 32-byte digests, no early exit,
 * and a difference anywhere in the input changes the whole digest.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * md5 is broken for anything that needs collision resistance and is used here
 * only because Click's Merchant API specifies it. It is not a choice; do not
 * copy this into new code.
 */
export function md5Hex(payload: string): string {
  return createHash('md5').update(payload, 'utf8').digest('hex');
}

export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * HTTP header names are case-insensitive and every runtime in the path normalises
 * them differently, so never index the record directly.
 */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parses a body into an object, or null for anything that is not one. */
export function parseJsonObject(rawBody: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

/**
 * Reads a field as a string, accepting the number a JSON body would carry where
 * a form-encoded one carries digits. Anything else is absent rather than coerced,
 * because `String({})` is never the value a gateway meant to send.
 */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * An integer count of minor units, refusing anything that would have to be
 * rounded. A gateway sending `1500.5` tiyin is either mis-scaled or malicious;
 * silently truncating it would put the error into the ledger.
 */
export function readMinorUnits(source: Record<string, unknown>, key: string): bigint | undefined {
  const value = source[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return undefined;
}

/**
 * Click posts `application/x-www-form-urlencoded`; deployments that route its
 * callback through an API gateway sometimes re-present it as JSON. Both are
 * accepted, and the form branch is preferred because it preserves the exact
 * digits the signature was computed over -- `1000.00` and `1000` are the same
 * number and different bytes.
 */
export function parseFormOrJsonFields(rawBody: string): Record<string, string> | null {
  const trimmed = rawBody.trim();
  if (trimmed === '') return null;

  if (trimmed.startsWith('{')) {
    const object = parseJsonObject(trimmed);
    if (!object) return null;
    const out: Record<string, string> = {};
    for (const key of Object.keys(object)) {
      const value = readString(object, key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  const params = new URLSearchParams(trimmed);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return Object.keys(out).length > 0 ? out : null;
}
