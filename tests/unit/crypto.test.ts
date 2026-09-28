import { describe, expect, it, vi } from 'vitest';

import { AppError, InternalError } from '@/server/errors';
import {
  ENCRYPTION_PURPOSES,
  __testing,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  isCiphertext,
} from '@/server/security/crypto';

const { totpSecret, integrationCredential } = ENCRYPTION_PURPOSES;

/** Flip one bit inside a single envelope segment, leaving the framing intact. */
function tamper(token: string, segment: 1 | 2 | 3): string {
  const parts = token.split('.');
  const raw = Buffer.from(parts[segment] ?? '', 'base64url');
  const last = raw.length - 1;
  const byte = raw[last];
  if (byte === undefined) throw new Error('segment is empty; nothing to tamper with');
  raw[last] = byte ^ 0x01;
  parts[segment] = raw.toString('base64url');
  return parts.join('.');
}

function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('encrypt / decrypt round trip', () => {
  it('returns the original plaintext', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(decrypt(encrypt(secret, totpSecret), totpSecret)).toBe(secret);
  });

  it('handles an empty string and multi-byte text', () => {
    expect(decrypt(encrypt('', totpSecret), totpSecret)).toBe('');
    // A TOTP secret is ASCII, but integration credentials are not: the envelope
    // must be byte-exact, not merely string-shaped.
    const text = 'Toshkent filiali — ключ 🔐';
    expect(decrypt(encrypt(text, integrationCredential), integrationCredential)).toBe(text);
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A fresh IV per message is what stops an observer with database access from
    // seeing that two users enrolled the same secret.
    const first = encrypt('same-input', totpSecret);
    const second = encrypt('same-input', totpSecret);
    expect(first).not.toBe(second);
    expect(decrypt(first, totpSecret)).toBe(decrypt(second, totpSecret));
  });
});

describe('envelope format', () => {
  it('is v1.{iv}.{ciphertext}.{tag} with base64url segments of the declared length', () => {
    const parts = encrypt('payload', totpSecret).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(__testing.FORMAT_VERSION);
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(__testing.IV_BYTES);
    expect(Buffer.from(parts[3] ?? '', 'base64url')).toHaveLength(__testing.TAG_BYTES);
    // base64url only: these strings travel through URLs, JSON and log lines.
    expect(parts.slice(1).join('')).toMatch(/^[A-Za-z0-9_-]*$/);
  });

  it('recognises its own shape and rejects plaintext', () => {
    expect(isCiphertext(encrypt('x', totpSecret))).toBe(true);
    // Legacy plaintext in a column mid-migration must not be mistaken for an
    // envelope, and vice versa.
    expect(isCiphertext('JBSWY3DPEHPK3PXP')).toBe(false);
    expect(isCiphertext('v1.only.three')).toBe(false);
  });
});

describe('tamper rejection', () => {
  it('rejects a modified ciphertext', () => {
    const token = encrypt('transfer-approved', totpSecret);
    expect(() => decrypt(tamper(token, 2), totpSecret)).toThrow(InternalError);
  });

  it('rejects a modified authentication tag', () => {
    const token = encrypt('transfer-approved', totpSecret);
    expect(() => decrypt(tamper(token, 3), totpSecret)).toThrow(InternalError);
  });

  it('rejects a modified IV', () => {
    // Without the tag this would decrypt to different-but-plausible bytes.
    const token = encrypt('transfer-approved', totpSecret);
    expect(() => decrypt(tamper(token, 1), totpSecret)).toThrow(InternalError);
  });

  it('rejects a swapped version prefix, which is covered by the AAD', () => {
    const token = encrypt('payload', totpSecret);
    const forged = ['v2', ...token.split('.').slice(1)].join('.');
    expect(() => decrypt(forged, totpSecret)).toThrow(InternalError);
  });

  it.each([
    ['empty', ''],
    ['not an envelope', 'just-a-string'],
    ['too few segments', 'v1.AAAA.BBBB'],
    ['too many segments', 'v1.AAAA.BBBB.CCCC.DDDD'],
    ['short IV', 'v1.AAAA.BBBBBBBB.CCCCCCCCCCCCCCCCCCCCCC'],
  ])('rejects a malformed envelope (%s)', (_label, token) => {
    expect(() => decrypt(token, totpSecret)).toThrow(InternalError);
  });
});

describe('failure is indistinguishable', () => {
  it('reports the same code and message whether parsing or authentication failed', () => {
    // Distinguishing the two hands an attacker who can submit ciphertexts an
    // oracle for which of their edits got past parsing.
    const malformed = caught(() => decrypt('not-an-envelope', totpSecret));
    const tampered = caught(() => decrypt(tamper(encrypt('payload', totpSecret), 2), totpSecret));

    expect(malformed.code).toBe(tampered.code);
    expect(malformed.publicMessage).toBe(tampered.publicMessage);
    expect(malformed.details).toEqual(tampered.details);
    // The real cause is kept for the log, not for the response.
    expect(malformed.publicMessage).not.toMatch(/base64|tag|auth|format/i);
  });
});

describe('key separation', () => {
  it('cannot decrypt a value written for a different purpose', () => {
    // A stolen TOTP blob pasted into the integration-credential column must not
    // decrypt, even though the master key is the same.
    const token = encrypt('JBSWY3DPEHPK3PXP', totpSecret);
    expect(() => decrypt(token, integrationCredential)).toThrow(InternalError);
  });

  it('derives a different key per purpose', () => {
    expect(__testing.deriveKey(totpSecret).equals(__testing.deriveKey(integrationCredential))).toBe(
      false,
    );
  });

  it('derives the same key every time from the same environment', () => {
    expect(__testing.deriveKey(totpSecret).equals(__testing.deriveKey(totpSecret))).toBe(true);
  });
});

describe('wrong master key', () => {
  it('cannot decrypt a value written under a different ENCRYPTION_KEY', async () => {
    const token = encrypt('JBSWY3DPEHPK3PXP', totpSecret);
    const original = process.env.ENCRYPTION_KEY;

    try {
      // env.ts parses process.env at module load, so a fresh module graph is the
      // only way to exercise a genuinely different master key in-process.
      process.env.ENCRYPTION_KEY = 'test-encryption-key-0011223344556677889900aabbccddee';
      vi.resetModules();
      const other = await import('@/server/security/crypto');

      expect(() => other.decrypt(token, other.ENCRYPTION_PURPOSES.totpSecret)).toThrow();
      // The rotated module is internally consistent -- it simply cannot read v1
      // rows written under the old key, which is what a rotation must survive.
      const reencrypted = other.encrypt('JBSWY3DPEHPK3PXP', other.ENCRYPTION_PURPOSES.totpSecret);
      expect(other.decrypt(reencrypted, other.ENCRYPTION_PURPOSES.totpSecret)).toBe(
        'JBSWY3DPEHPK3PXP',
      );
      expect(() => decrypt(reencrypted, totpSecret)).toThrow(InternalError);
    } finally {
      if (original === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = original;
      vi.resetModules();
    }
  });
});

describe('JSON helpers', () => {
  it('round-trips a structured value', () => {
    const credentials = { merchantId: 'm_123', secretKey: 'sk_test', endpoints: ['a', 'b'] };
    const token = encryptJson(credentials, integrationCredential);
    expect(decryptJson(token, integrationCredential)).toEqual(credentials);
  });

  it('round-trips null and nested structures', () => {
    const value = { nested: { list: [1, 2, { deep: true }] }, absent: null };
    expect(decryptJson(encryptJson(value, integrationCredential), integrationCredential)).toEqual(
      value,
    );
  });

  it('rejects a tampered JSON envelope rather than returning partial data', () => {
    const token = encryptJson({ merchantId: 'm_123' }, integrationCredential);
    expect(() => decryptJson(tamper(token, 2), integrationCredential)).toThrow(InternalError);
  });
});
