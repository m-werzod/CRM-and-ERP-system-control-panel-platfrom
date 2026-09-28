import { describe, expect, it } from 'vitest';

import { BadRequestError } from '@/server/errors';
import {
  TOTP_DEFAULTS,
  base32Decode,
  base32Encode,
  buildOtpAuthUrl,
  generateSecret,
  stepAt,
  totpCodeForStep,
  verifyTotp,
} from '@/server/security/totp';

// ---------------------------------------------------------------------------
// base32, RFC 4648 section 10
// ---------------------------------------------------------------------------

const RFC_4648: ReadonlyArray<readonly [string, string, string]> = [
  ['', '', ''],
  ['f', 'MY', 'MY======'],
  ['fo', 'MZXQ', 'MZXQ===='],
  ['foo', 'MZXW6', 'MZXW6==='],
  ['foob', 'MZXW6YQ', 'MZXW6YQ='],
  ['fooba', 'MZXW6YTB', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI', 'MZXW6YTBOI======'],
];

describe('base32Encode', () => {
  it.each(RFC_4648)('encodes %j unpadded', (plain, unpadded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(unpadded);
  });

  it.each(RFC_4648)('encodes %j padded when asked', (plain, _unpadded, padded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'), { pad: true })).toBe(padded);
  });

  it('defaults to unpadded, because otpauth URLs carry no "="', () => {
    expect(base32Encode(Buffer.from('f', 'ascii'))).not.toContain('=');
  });
});

describe('base32Decode', () => {
  it.each(RFC_4648)('decodes the unpadded form of %j', (plain, unpadded) => {
    expect(base32Decode(unpadded).toString('ascii')).toBe(plain);
  });

  it.each(RFC_4648)('decodes the padded form of %j', (plain, _unpadded, padded) => {
    expect(base32Decode(padded).toString('ascii')).toBe(plain);
  });

  it('accepts what a human actually pastes', () => {
    // Authenticator apps group the secret for readability and users lower-case it.
    const expected = base32Decode('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi').equals(expected)).toBe(true);
    expect(base32Decode('MZXW 6YTB OI').equals(expected)).toBe(true);
    expect(base32Decode('MZXW-6YTB-OI').equals(expected)).toBe(true);
    expect(base32Decode('  mzxw-6ytb oi  ').equals(expected)).toBe(true);
  });

  it.each(['1', '0', '8', '9', 'MZXW6YTB!', 'MZXW6YTB+A'])(
    'rejects the non-alphabet input %j',
    (text) => {
      // 0/1/8/9 are excluded from the alphabet precisely because they are the
      // characters people confuse with O/I/B/g.
      expect(() => base32Decode(text)).toThrow(BadRequestError);
    },
  );

  it.each(['M', 'MZX', 'MZXW6Y'])('rejects the truncated length %j', (text) => {
    // A length leaving five or more bits over cannot be produced by any encoder.
    expect(() => base32Decode(text)).toThrow(/incomplete/i);
  });

  it('rejects leftover bits that are not zero', () => {
    // MZXW6YTBOI is valid; the same length with a final character whose low bits
    // are set means the string was cut inside a group.
    expect(() => base32Decode('MZXW6YTBOI')).not.toThrow();
    expect(() => base32Decode('MZXW6YTBOJ')).toThrow(/incomplete/i);
  });

  it('round-trips arbitrary byte lengths', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Buffer.alloc(length, 0);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
      expect(base32Decode(base32Encode(bytes, { pad: true })).equals(bytes)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// RFC 6238 test vectors
//
// The SHA-1 seed is the ASCII string "12345678901234567890". Only the SHA-1
// vectors are exercised: the RFC's SHA-256 and SHA-512 rows use different,
// longer seeds, and no mainstream authenticator app offers either algorithm, so
// SHA-1 is the only configuration a real enrolment can produce.
// ---------------------------------------------------------------------------

const RFC_SEED_ASCII = '12345678901234567890';
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC_6238: ReadonlyArray<{
  readonly unixSeconds: number;
  readonly step: number;
  readonly code8: string;
}> = [
  { unixSeconds: 59, step: 1, code8: '94287082' },
  { unixSeconds: 1_111_111_109, step: 37_037_036, code8: '07081804' },
  { unixSeconds: 1_111_111_111, step: 37_037_037, code8: '14050471' },
  { unixSeconds: 1_234_567_890, step: 41_152_263, code8: '89005924' },
  { unixSeconds: 2_000_000_000, step: 66_666_666, code8: '69279037' },
  { unixSeconds: 20_000_000_000, step: 666_666_666, code8: '65353130' },
];

describe('RFC 6238 vectors', () => {
  it('agrees with the published base32 form of the test seed', () => {
    // Pins the seed independently, so the vectors below are not merely checking
    // base32Encode against itself.
    expect(base32Encode(Buffer.from(RFC_SEED_ASCII, 'ascii'))).toBe(RFC_SEED_BASE32);
  });

  it.each(RFC_6238)('derives step $step from unix time $unixSeconds', ({ unixSeconds, step }) => {
    expect(stepAt(unixSeconds * 1000)).toBe(step);
    expect(stepAt(unixSeconds * 1000, TOTP_DEFAULTS.stepSeconds)).toBe(step);
  });

  it.each(RFC_6238)('produces the 8-digit code $code8 at step $step', ({ step, code8 }) => {
    expect(totpCodeForStep(RFC_SEED_BASE32, step, { digits: 8 })).toBe(code8);
  });

  it.each(RFC_6238)('produces the 6-digit code an authenticator shows at step $step', ({
    step,
    code8,
  }) => {
    // Six digits is the same dynamic truncation modulo 10^6, i.e. the low six
    // digits of the RFC's eight.
    expect(totpCodeForStep(RFC_SEED_BASE32, step, { digits: 6 })).toBe(code8.slice(2));
  });

  it.each(RFC_6238)('verifies the code live at unix time $unixSeconds', ({
    unixSeconds,
    step,
    code8,
  }) => {
    expect(
      verifyTotp(RFC_SEED_BASE32, code8.slice(2), { atMs: unixSeconds * 1000, window: 0 }),
    ).toEqual({ valid: true, step });
  });
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/** An arbitrary fixed instant, so nothing here depends on the wall clock. */
const AT_MS = 1_700_000_000_000;
const NOW_STEP = stepAt(AT_MS);
const SECRET = RFC_SEED_BASE32;

const codeFor = (step: number) => totpCodeForStep(SECRET, step);

describe('verifyTotp', () => {
  it('accepts the current code and reports the step it matched', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP), { atMs: AT_MS })).toEqual({
      valid: true,
      step: NOW_STEP,
    });
  });

  it('rejects a wrong code and reports no step', () => {
    expect(verifyTotp(SECRET, '000000', { atMs: AT_MS, window: 0 })).toEqual({
      valid: false,
      step: null,
    });
  });

  it('rejects a code for the wrong secret', () => {
    const other = base32Encode(Buffer.from('09876543210987654321', 'ascii'));
    expect(verifyTotp(other, codeFor(NOW_STEP), { atMs: AT_MS }).valid).toBe(false);
  });

  it('tolerates a phone that is one step behind or ahead', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 1), { atMs: AT_MS, window: 1 })).toEqual({
      valid: true,
      step: NOW_STEP - 1,
    });
    expect(verifyTotp(SECRET, codeFor(NOW_STEP + 1), { atMs: AT_MS, window: 1 })).toEqual({
      valid: true,
      step: NOW_STEP + 1,
    });
  });

  it('stops tolerating at the edge of the window', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 2), { atMs: AT_MS, window: 1 }).valid).toBe(false);
    expect(verifyTotp(SECRET, codeFor(NOW_STEP + 2), { atMs: AT_MS, window: 1 }).valid).toBe(false);
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 2), { atMs: AT_MS, window: 2 }).valid).toBe(true);
  });

  it('accepts only the exact step when the window is zero', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP), { atMs: AT_MS, window: 0 }).valid).toBe(true);
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 1), { atMs: AT_MS, window: 0 }).valid).toBe(false);
  });

  it('defaults to a one-step window', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 1), { atMs: AT_MS })).toEqual({
      valid: true,
      step: NOW_STEP - 1,
    });
    expect(verifyTotp(SECRET, codeFor(NOW_STEP - 2), { atMs: AT_MS }).valid).toBe(false);
    expect(TOTP_DEFAULTS.window).toBe(1);
  });

  it('accepts a code the user typed with grouping', () => {
    const code = codeFor(NOW_STEP);
    const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(SECRET, grouped, { atMs: AT_MS }).valid).toBe(true);
    expect(verifyTotp(SECRET, `${code.slice(0, 3)}-${code.slice(3)}`, { atMs: AT_MS }).valid).toBe(
      true,
    );
  });

  it('rejects a short, long or non-numeric guess without throwing', () => {
    for (const guess of ['', '12345', '1234567', 'abcdef']) {
      expect(verifyTotp(SECRET, guess, { atMs: AT_MS }).valid).toBe(false);
    }
  });

  it('honours a non-default step length', () => {
    const step = stepAt(AT_MS, 60);
    const code = totpCodeForStep(SECRET, step, { stepSeconds: 60 });
    expect(verifyTotp(SECRET, code, { atMs: AT_MS, stepSeconds: 60, window: 0 }).valid).toBe(true);
    // The same digits mean nothing under the default step length.
    expect(verifyTotp(SECRET, code, { atMs: AT_MS, stepSeconds: 30, window: 0 }).valid).toBe(false);
  });
});

describe('replay', () => {
  it('refuses a step that has already been spent', () => {
    // The point of returning the step: a six-digit code stays valid for its whole
    // 30-second window (three windows, with drift tolerance), so verifying it
    // once is not enough -- anyone who reads it over a shoulder can spend the
    // remaining seconds unless the caller records and rejects the step.
    const accepted = verifyTotp(SECRET, codeFor(NOW_STEP), { atMs: AT_MS });
    expect(accepted).toEqual({ valid: true, step: NOW_STEP });

    const replay = verifyTotp(SECRET, codeFor(NOW_STEP), {
      atMs: AT_MS,
      afterStep: accepted.step,
    });
    expect(replay).toEqual({ valid: false, step: null });
  });

  it('still accepts the next code after one has been spent', () => {
    expect(
      verifyTotp(SECRET, codeFor(NOW_STEP + 1), { atMs: AT_MS, afterStep: NOW_STEP }),
    ).toEqual({ valid: true, step: NOW_STEP + 1 });
  });

  it('rejects an earlier code inside the window once a later one is spent', () => {
    expect(
      verifyTotp(SECRET, codeFor(NOW_STEP - 1), { atMs: AT_MS, afterStep: NOW_STEP }).valid,
    ).toBe(false);
  });

  it('treats a null afterStep as "nothing spent yet"', () => {
    expect(verifyTotp(SECRET, codeFor(NOW_STEP), { atMs: AT_MS, afterStep: null }).valid).toBe(true);
  });
});

describe('parameter guards', () => {
  it.each([-1, 11, 1.5])('rejects the window %p', (window) => {
    // A wide window is a silent downgrade, not a convenience.
    expect(() => verifyTotp(SECRET, '000000', { atMs: AT_MS, window })).toThrow(BadRequestError);
  });

  it.each([5, 11, 6.5])('rejects %p digits', (digits) => {
    expect(() => totpCodeForStep(SECRET, NOW_STEP, { digits })).toThrow(BadRequestError);
  });

  it.each([0, 301, 30.5])('rejects the step length %p', (stepSeconds) => {
    expect(() => totpCodeForStep(SECRET, NOW_STEP, { stepSeconds })).toThrow(BadRequestError);
  });

  it('rejects a negative or fractional step', () => {
    expect(() => totpCodeForStep(SECRET, -1)).toThrow(BadRequestError);
    expect(() => totpCodeForStep(SECRET, 1.5)).toThrow(BadRequestError);
  });
});

// ---------------------------------------------------------------------------
// enrolment
// ---------------------------------------------------------------------------

describe('generateSecret', () => {
  it('produces 160 bits as 32 base32 characters with no partial group', () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('produces a different secret every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(secrets.size).toBe(50);
  });

  it('refuses to mint a secret below the RFC 4226 minimum', () => {
    expect(() => generateSecret(15)).toThrow(BadRequestError);
    expect(base32Decode(generateSecret(16))).toHaveLength(16);
  });

  it('produces a secret that verifies against its own codes', () => {
    const secret = generateSecret();
    expect(verifyTotp(secret, totpCodeForStep(secret, NOW_STEP), { atMs: AT_MS }).valid).toBe(true);
  });
});

describe('buildOtpAuthUrl', () => {
  const url = buildOtpAuthUrl({
    issuer: 'Edu CRM',
    account: 'teacher@example.uz',
    secret: RFC_SEED_BASE32,
  });

  it('is an otpauth totp URI', () => {
    expect(url.startsWith('otpauth://totp/')).toBe(true);
  });

  it('names the issuer in both the label and the parameter', () => {
    // Older authenticators read only the label, newer ones only the parameter.
    expect(url).toContain('otpauth://totp/Edu%20CRM:teacher%40example.uz?');
    expect(url).toContain('issuer=Edu%20CRM');
  });

  it('percent-encodes a space rather than form-encoding it', () => {
    // URLSearchParams would write "Edu+CRM", which several apps display verbatim.
    expect(url).not.toContain('+');
  });

  it('carries the secret unpadded and the explicit parameters', () => {
    expect(url).toContain(`secret=${RFC_SEED_BASE32}`);
    expect(url).not.toContain('=&');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });

  it('strips padding a caller supplied', () => {
    const padded = buildOtpAuthUrl({
      issuer: 'A',
      account: 'b',
      secret: base32Encode(Buffer.from('foobar', 'ascii'), { pad: true }),
    });
    expect(padded).toContain('secret=MZXW6YTBOI&');
  });

  it('reflects non-default parameters', () => {
    const custom = buildOtpAuthUrl({
      issuer: 'A',
      account: 'b',
      secret: RFC_SEED_BASE32,
      digits: 8,
      stepSeconds: 60,
      algorithm: 'SHA256',
    });
    expect(custom).toContain('digits=8');
    expect(custom).toContain('period=60');
    expect(custom).toContain('algorithm=SHA256');
  });

  it('fails at enrolment rather than issuing a QR code nothing can verify', () => {
    expect(() =>
      buildOtpAuthUrl({ issuer: 'A', account: 'b', secret: 'not-base32-1' }),
    ).toThrow(BadRequestError);
  });

  it.each([
    ['', 'b'],
    ['A', ''],
    ['   ', 'b'],
  ])('requires both an issuer and an account (%j, %j)', (issuer, account) => {
    expect(() => buildOtpAuthUrl({ issuer, account, secret: RFC_SEED_BASE32 })).toThrow(
      BadRequestError,
    );
  });
});
