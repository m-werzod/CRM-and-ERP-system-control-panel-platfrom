/**
 * Password hashing and credential-token handling.
 *
 * Passwords: Argon2id with the OWASP-recommended parameters (19 MiB, t=2, p=1).
 * Argon2id is chosen over bcrypt for its memory-hardness -- bcrypt's 4 KiB
 * working set is cheap to parallelise on a GPU, Argon2id's 19 MiB is not.
 *
 * Tokens (sessions, password resets, device keys, QR codes): a 256-bit random
 * value, transmitted once and stored ONLY as a SHA-256 hash. These are
 * high-entropy machine-generated secrets, so a fast hash is correct -- there is
 * nothing to brute-force, and a slow KDF would make every authenticated request
 * pay for nothing. That reasoning does NOT transfer to passwords.
 */

import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * `@node-rs/argon2` exports `Algorithm` and `Version` as ambient const enums,
 * which cannot be read under `isolatedModules` (the values exist only in the
 * type declarations, not at runtime). The numeric values are part of the
 * package's stable ABI, so they are inlined here with the names they stand for.
 */
const ALGORITHM_ARGON2ID = 2; // Algorithm.Argon2id
const VERSION_0X13 = 1; // Version.V0x13 -- Argon2 v19, the current default

/**
 * OWASP Password Storage Cheat Sheet, Argon2id row.
 * Raising memoryCost later is safe: existing hashes carry their own parameters
 * and `needsRehash` flags them for transparent upgrade on next login.
 */
const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  version: VERSION_0X13,
  memoryCost: 19_456, // KiB == 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) throw new Error('Refusing to hash an empty password');
  // Argon2 has no 72-byte truncation problem (bcrypt does), so long
  // passphrases are hashed in full.
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed stored
 * hash, so a corrupt row denies access instead of 500-ing and revealing that the
 * account exists.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  if (!storedHash || !plaintext) return false;
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker parameters than current
 * policy. Call after a successful login and re-hash if it returns true: that is
 * how a parameter increase reaches existing accounts without a forced reset.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true; // Unrecognised format: replace it.
  const [, variant, , memory, time, parallelism] = match;
  if (variant !== 'id') return true;
  return (
    Number(memory) < ARGON2_OPTIONS.memoryCost ||
    Number(time) < ARGON2_OPTIONS.timeCost ||
    Number(parallelism) < ARGON2_OPTIONS.parallelism
  );
}

/**
 * A dummy verify against a real hash, used to keep login timing flat when the
 * email does not exist. Without it, "unknown email" returns in ~1 ms while
 * "wrong password" takes ~15 ms, which is a reliable account-enumeration oracle.
 */
const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));

export async function fakeVerifyForTiming(): Promise<void> {
  await verifyPassword(DUMMY_HASH, 'timing-equalisation');
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

/** 256 bits of entropy, URL-safe. Shown to the client exactly once. */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * The stored form of a token. SHA-256 is right here: the input already has 256
 * bits of entropy, so there is no dictionary to defend against, and lookups must
 * be indexable.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for hex digests of equal length. */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A temporary password for an admin-created account. Excludes characters that
 * are ambiguous when read aloud or off a printout (O/0, I/l/1), because these
 * get dictated over the phone to new staff.
 */
export function generateTemporaryPassword(length = 14): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%*+-=?';
  const alphabet = lower + upper + digits + symbols;

  // Guarantee one of each class so the result always satisfies passwordSchema.
  const required = [
    lower[randomInt(lower.length)]!,
    upper[randomInt(upper.length)]!,
    digits[randomInt(digits.length)]!,
    symbols[randomInt(symbols.length)]!,
  ];
  const rest = Array.from(
    { length: Math.max(0, length - required.length) },
    () => alphabet[randomInt(alphabet.length)]!,
  );

  // Fisher-Yates with a CSPRNG; Math.random would make the result predictable.
  const characters = [...required, ...rest];
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j]!, characters[i]!];
  }
  return characters.join('');
}

/** Numeric code for SMS/email verification and 2FA recovery. */
export function generateNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return String(randomInt(max)).padStart(digits, '0');
}
