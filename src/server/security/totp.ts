/**
 * Time-based one-time passwords (RFC 6238) on top of HMAC-OTP (RFC 4226).
 *
 * Implemented directly on node:crypto rather than pulling in otplib: the whole
 * algorithm is an HMAC, a big-endian counter and a modulo, and the parts that
 * actually decide whether it is safe -- the comparison being constant-time, the
 * accepted step being returned so a code cannot be replayed -- are exactly the
 * parts a library wrapper tends to hide.
 *
 * Secrets are base32 because that is what authenticator apps and QR codes speak.
 * They are stored encrypted (`@/server/security/crypto`, purpose `totpSecret`);
 * nothing in this file touches the database.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { BadRequestError } from '@/server/errors';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/**
 * SHA-1 is the RFC 6238 default and the only algorithm every authenticator app
 * implements; an enrolment an operator cannot complete is not security. It is not
 * a weakness here either -- the collision attacks on SHA-1 say nothing about
 * HMAC-SHA1 as a MAC, and the output is six digits that live for thirty seconds.
 */
export const TOTP_DEFAULTS = {
  digits: 6,
  stepSeconds: 30,
  algorithm: 'SHA1',
  /** ±1 step: tolerates half a minute of clock drift on the user's phone. */
  window: 1,
} as const;

const NODE_DIGEST: Record<TotpAlgorithm, string> = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA512: 'sha512',
};

// ---------------------------------------------------------------------------
// base32, RFC 4648
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Padding is off by default: otpauth URLs carry the secret unpadded, and `=` in
 * a query string has to be percent-escaped, which more than one authenticator
 * app gets wrong. `pad` exists for interoperability with encoders that insist on
 * the padded form.
 */
export function base32Encode(bytes: Uint8Array, options: { pad?: boolean } = {}): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((buffer >>> bits) & 31);
    }
  }
  // Trailing partial group: the remaining bits are left-aligned and zero-filled.
  if (bits > 0) out += ALPHABET.charAt((buffer << (5 - bits)) & 31);

  if (options.pad ?? false) {
    while (out.length % 8 !== 0) out += '=';
  }
  return out;
}

/**
 * Accepts what a human is likely to paste: lower case, and the spaces or hyphens
 * that authenticator apps insert to make a 32-character secret readable.
 */
export function base32Decode(text: string): Buffer {
  const normalized = text
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of normalized) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) {
      // The realistic source of bad base32 is a hand-typed secret during
      // enrolment, so this is reported as a client error.
      throw new BadRequestError('That is not a valid base32 secret.');
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  // A length whose bit count leaves five or more bits over (length % 8 of 1, 3
  // or 6) cannot be produced by any encoder: the string was truncated. Leftover
  // bits that are not zero mean the same thing -- a cut inside a group.
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) {
    throw new BadRequestError('That base32 secret is incomplete.');
  }

  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// secrets and enrolment
// ---------------------------------------------------------------------------

/**
 * 160 bits, the RFC 4226 recommendation (it requires at least 128), which is also
 * exactly 32 base32 characters with no partial group.
 */
export function generateSecret(byteLength = 20): string {
  if (byteLength < 16) {
    throw new BadRequestError('A TOTP secret must be at least 128 bits.');
  }
  return base32Encode(randomBytes(byteLength));
}

export interface OtpAuthUrlInput {
  /** Shown as the account provider, e.g. the organisation name. */
  readonly issuer: string;
  /** Identifies which account within the issuer, e.g. the user's email. */
  readonly account: string;
  readonly secret: string;
  readonly digits?: number;
  readonly stepSeconds?: number;
  readonly algorithm?: TotpAlgorithm;
}

/**
 * The otpauth:// URI that becomes the enrolment QR code.
 *
 * The issuer appears twice -- as a label prefix and as a parameter -- because
 * older authenticators read only the label and newer ones only the parameter.
 * Built by hand rather than with URLSearchParams, which form-encodes a space as
 * `+`; several apps then display "My+School" verbatim.
 */
export function buildOtpAuthUrl(input: OtpAuthUrlInput): string {
  const { digits, stepSeconds, algorithm } = resolveParameters(input);
  const issuer = input.issuer.trim();
  const account = input.account.trim();
  if (!issuer || !account) {
    throw new BadRequestError('An otpauth URL needs both an issuer and an account.');
  }

  const secret = input.secret.replace(/=+$/, '');
  // Fail at enrolment rather than handing the user a QR code that scans into a
  // secret no verification will ever match.
  base32Decode(secret);

  const query = [
    `secret=${encodeURIComponent(secret)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    `algorithm=${algorithm}`,
    `digits=${digits}`,
    `period=${stepSeconds}`,
  ].join('&');

  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`;
}

// ---------------------------------------------------------------------------
// code generation and verification
// ---------------------------------------------------------------------------

export interface TotpParameters {
  readonly digits?: number;
  readonly stepSeconds?: number;
  readonly algorithm?: TotpAlgorithm;
}

interface ResolvedParameters {
  readonly digits: number;
  readonly stepSeconds: number;
  readonly algorithm: TotpAlgorithm;
}

function resolveParameters(params: TotpParameters): ResolvedParameters {
  const digits = params.digits ?? TOTP_DEFAULTS.digits;
  const stepSeconds = params.stepSeconds ?? TOTP_DEFAULTS.stepSeconds;
  const algorithm = params.algorithm ?? TOTP_DEFAULTS.algorithm;

  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new BadRequestError('A TOTP code must be between 6 and 10 digits.');
  }
  if (!Number.isInteger(stepSeconds) || stepSeconds < 1 || stepSeconds > 300) {
    throw new BadRequestError('A TOTP step must be between 1 and 300 seconds.');
  }
  return { digits, stepSeconds, algorithm };
}

/** The RFC 6238 counter `T`: whole steps since the Unix epoch. */
export function stepAt(atMs: number, stepSeconds: number = TOTP_DEFAULTS.stepSeconds): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/** The code for one specific counter value. Exported so tests can pin vectors. */
export function totpCodeForStep(
  secret: string,
  step: number,
  params: TotpParameters = {},
): string {
  const { digits, algorithm } = resolveParameters(params);
  if (!Number.isInteger(step) || step < 0) {
    throw new BadRequestError('A TOTP step must be a non-negative whole number.');
  }

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac(NODE_DIGEST[algorithm], base32Decode(secret)).update(counter).digest();

  // RFC 4226 dynamic truncation: the low nibble of the last byte picks where to
  // read four bytes, and the top bit is cleared so the result is sign-agnostic
  // across implementations.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export interface VerifyTotpOptions extends TotpParameters {
  /** Steps accepted either side of now. 1 means ±30 seconds at the default step. */
  readonly window?: number;
  /** Injected by tests and by replay checks against a recorded instant. */
  readonly atMs?: number;
  /**
   * Reject any step at or below this one.
   *
   * A code is valid for its entire step, and with a window for three of them, so
   * verifying it once is not enough: anyone who reads the six digits over a
   * shoulder or out of a phishing proxy can spend the remaining seconds. The
   * caller persists the `step` this function returns and passes it back here, so
   * a code can be used exactly once.
   */
  readonly afterStep?: number | null;
}

export type TotpVerification =
  | { readonly valid: true; readonly step: number }
  | { readonly valid: false; readonly step: null };

export function verifyTotp(
  secret: string,
  code: string,
  options: VerifyTotpOptions = {},
): TotpVerification {
  const params = resolveParameters(options);
  const window = options.window ?? TOTP_DEFAULTS.window;
  if (!Number.isInteger(window) || window < 0 || window > 10) {
    // A wide window is a silent downgrade: window=20 keeps every code alive for
    // twenty minutes.
    throw new BadRequestError('The TOTP window must be between 0 and 10 steps.');
  }

  const candidate = code.replace(/[\s-]/g, '');
  const current = stepAt(options.atMs ?? Date.now(), params.stepSeconds);
  const afterStep = options.afterStep ?? null;

  let accepted: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;

    const matches = constantTimeEquals(totpCodeForStep(secret, step, params), candidate);
    // Deliberately no early exit. Stopping at the first match would make the
    // response time reveal which step matched, which is a direct read-out of the
    // offset between the attacker's clock and the server's -- and, with a
    // per-account lockout counting attempts, a way to aim them.
    if (matches && accepted === null && (afterStep === null || step > afterStep)) {
      accepted = step;
    }
  }

  return accepted === null ? { valid: false, step: null } : { valid: true, step: accepted };
}

function constantTimeEquals(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(candidate, 'utf8');
  if (left.length !== right.length) {
    // timingSafeEqual throws on a length mismatch. The length of a TOTP code is
    // public, but comparing against ourselves keeps a wrong-length guess costing
    // the same as a wrong-value one, so the loop above stays uniform.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
