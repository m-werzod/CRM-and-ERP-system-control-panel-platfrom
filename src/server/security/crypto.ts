/**
 * Reversible encryption for data at rest.
 *
 * Almost nothing here needs to be reversible: passwords and session tokens are
 * hashed, biometric templates are never stored at all. The exception is a value
 * an algorithm must see in the clear again later -- today `User.twoFactorSecret`,
 * which HMAC needs on every verification.
 *
 * AES-256-GCM rather than CBC or a bare stream cipher: a TOTP secret that can be
 * silently flipped is worse than one that cannot be read, because a modified
 * secret still "works" -- it just no longer matches the authenticator, and the
 * failure looks like a user error. Authenticated encryption makes tampering a
 * loud failure instead.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '@/server/env';
import { InternalError } from '@/server/errors';

/** Envelope format marker. See `FORMAT` below for why it is stored. */
const FORMAT_VERSION = 'v1';

const KEY_BYTES = 32;
/** 96 bits: the nonce length AES-GCM is specified and hardware-optimised for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Every column that holds ciphertext names its own purpose here.
 *
 * Two values encrypted under the same key are interchangeable: a stolen TOTP
 * secret blob could be pasted into an integration-credential column and would
 * decrypt perfectly, because nothing in the bytes says what they were for.
 * Deriving a separate key per purpose makes that swap fail the GCM tag. The list
 * is a closed union so a typo cannot quietly mint a new key and orphan every
 * existing ciphertext in that column.
 */
export const ENCRYPTION_PURPOSES = {
  /** `User.twoFactorSecret` -- the base32 TOTP shared secret. */
  totpSecret: 'user.totp-secret',
  /** Per-organisation provider credentials stored in settings. */
  integrationCredential: 'integration.credential',
} as const;

export type EncryptionPurpose = (typeof ENCRYPTION_PURPOSES)[keyof typeof ENCRYPTION_PURPOSES];

/**
 * HKDF salt. Fixed rather than random because the key must be re-derivable from
 * the environment alone; a per-ciphertext salt would have to be stored next to
 * the ciphertext and buys nothing here -- the info string already separates
 * purposes, and the IV already separates messages.
 */
const HKDF_SALT = 'edu-crm.encryption-key.hkdf.v1';

/**
 * Derive the AES key from ENCRYPTION_KEY.
 *
 * HKDF rather than using the env string as key material directly: ENCRYPTION_KEY
 * is a human-supplied passphrase of arbitrary length, carrying roughly 6 bits of
 * entropy per printable character and often structure (words, dates). AES needs
 * exactly 32 uniformly random bytes. Truncating or zero-padding the string would
 * make the effective key length depend on how long the operator's passphrase is
 * and would feed that structure straight into the cipher. HKDF-Extract condenses
 * whatever entropy exists into a uniform 256-bit key, and HKDF-Expand then gives
 * each purpose an independent one for free.
 */
function deriveKey(purpose: EncryptionPurpose): Buffer {
  return Buffer.from(
    hkdfSync('sha256', env.ENCRYPTION_KEY, HKDF_SALT, `${FORMAT_VERSION}:${purpose}`, KEY_BYTES),
  );
}

// Derivation is cheap but not free, and its inputs never change within a
// process; a TOTP check on every login should not pay for it twice.
const keyCache = new Map<EncryptionPurpose, Buffer>();

function keyFor(purpose: EncryptionPurpose): Buffer {
  const cached = keyCache.get(purpose);
  if (cached) return cached;
  const derived = deriveKey(purpose);
  keyCache.set(purpose, derived);
  return derived;
}

/**
 * Authenticated but unencrypted header, bound into the GCM tag.
 *
 * The version and purpose travel in the clear (the version has to, or we could
 * not pick a decryption routine), so they must be authenticated too. Without
 * this, editing the `v1.` prefix of a stored value would be undetectable.
 */
function associatedData(purpose: EncryptionPurpose): Buffer {
  return Buffer.from(`${FORMAT_VERSION}.${purpose}`, 'utf8');
}

/**
 * `v1.{base64url(iv)}.{base64url(ciphertext)}.{base64url(tag)}`
 *
 * The version prefix is what makes rotation possible: a future v2 (new cipher,
 * new KDF, or simply a new ENCRYPTION_KEY) can be written for fresh values while
 * `decrypt` still reads every v1 row, so migration becomes a background re-write
 * rather than a flag day that invalidates everyone's two-factor enrolment.
 * base64url, because these strings end up in URLs, JSON and log lines where `+`
 * and `/` need escaping.
 */
export function encrypt(plaintext: string, purpose: EncryptionPurpose): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(purpose));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decrypt(token: string, purpose: EncryptionPurpose): string {
  try {
    const parts = token.split('.');
    const [version, ivPart, ciphertextPart, tagPart] = parts;
    if (
      parts.length !== 4 ||
      version === undefined ||
      ivPart === undefined ||
      ciphertextPart === undefined ||
      tagPart === undefined
    ) {
      throw new Error('malformed envelope');
    }
    if (version !== FORMAT_VERSION) {
      throw new Error('unsupported format version');
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    // Buffer.from is lenient about non-base64 input -- it drops what it cannot
    // decode -- so the lengths are checked rather than the characters.
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('malformed envelope');
    }

    const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(purpose));
    decipher.setAuthTag(tag);

    // `final()` is where a tag mismatch surfaces; `update()` alone would happily
    // return plausible-looking plaintext from a forged ciphertext.
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw decryptionFailed(cause);
  }
}

/**
 * One indistinguishable failure for every cause.
 *
 * Telling the caller "that was not valid base64" versus "the tag did not verify"
 * hands an attacker who can submit ciphertexts an oracle: it reports which of
 * their edits got past parsing, which is the shape that broke CBC padding. The
 * real cause is attached for the log -- `apiRoute` logs 5xx errors with their
 * cause -- and never reaches the response body.
 */
function decryptionFailed(cause: unknown): InternalError {
  return new InternalError('Stored encrypted data could not be read.', {
    cause,
    details: { reason: 'decrypt_failed' },
  });
}

/**
 * Cheap shape check, for code that must tolerate a column still holding legacy
 * plaintext during a migration. It proves nothing about authenticity -- only
 * `decrypt` does that.
 */
export function isCiphertext(value: string): boolean {
  return /^v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/.test(value);
}

/**
 * JSON helpers for the structured cases (a provider credential set, for
 * instance). `bigint` must be converted by the caller: JSON has no integer type
 * wide enough, and silently stringifying money here would let it come back as a
 * string and be compared against a bigint somewhere far away.
 */
export function encryptJson(value: unknown, purpose: EncryptionPurpose): string {
  return encrypt(JSON.stringify(value), purpose);
}

/**
 * Returns `unknown` deliberately: the bytes were trustworthy when we wrote them,
 * but the shape the code expects may have changed since. Narrow with a Zod
 * schema at the call site.
 */
export function decryptJson(token: string, purpose: EncryptionPurpose): unknown {
  const plaintext = decrypt(token, purpose);
  try {
    return JSON.parse(plaintext) as unknown;
  } catch (cause) {
    // Reached only if a value was written by `encrypt` and read by
    // `decryptJson`; report it the same way so the mismatch is not an oracle.
    throw decryptionFailed(cause);
  }
}

/** Exposed so unit tests can assert key separation without exporting keys. */
export const __testing = { deriveKey, FORMAT_VERSION, IV_BYTES, TAG_BYTES };
