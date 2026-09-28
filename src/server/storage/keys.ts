/**
 * Storage key generation and validation.
 *
 * A key is the only thing a driver ever receives, so its shape carries the whole
 * defence: it is unguessable, it encodes its tenant, and it cannot express a path
 * outside the store.
 *
 *   {organizationId}/{ownerType}/{yyyy}/{mm}/{32-hex}{ext}
 *
 * The random component is 128 bits from the CSPRNG. That is not a substitute for
 * the authorisation check on the download route -- it is the reason a leaked or
 * brute-forced key is not a second way in.
 *
 * NOTHING in a key comes from the client. Not the name, not the directory, not
 * even the extension: a filename is attacker-controlled data, and the moment it
 * reaches a path we are relying on every downstream `path.join` to be perfect.
 * The extension is looked up from the validated MIME type's allow-list instead,
 * purely so an operator browsing the bucket can tell a PDF from a JPEG.
 */

import { randomBytes } from 'node:crypto';
import { DocumentOwnerType } from '@/generated/prisma/client';
import { ALLOWED_UPLOAD_MIME_TYPES, isAllowedMimeType } from '@/lib/validation';
import { BadRequestError, NotFoundError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import type { StorageKeyParts, StorageOwnerSegment } from './types';

/** 16 bytes -- 128 bits, hex-encoded to 32 characters. */
const RANDOM_BYTES = 16;

/** Generous, but a key this long can only be a probe or a bug. */
const MAX_KEY_LENGTH = 512;

const OWNER_SEGMENTS: ReadonlySet<string> = new Set(
  Object.values(DocumentOwnerType).map((value) => value.toLowerCase()),
);

/**
 * Deliberately narrow: lower-case hex for the id, digits for the date, and an
 * organisation id in the cuid alphabet. Anything a traversal payload needs --
 * a dot-dot, a backslash, a colon, a percent sign, a NUL -- is outside the
 * character classes rather than blocked by a list of known-bad strings.
 */
const KEY_PATTERN =
  /^(?<organizationId>[A-Za-z0-9]{1,40})\/(?<ownerType>[a-z_]{1,40})\/(?<year>\d{4})\/(?<month>\d{2})\/(?<id>[0-9a-f]{32})(?<extension>\.[a-z0-9]{1,12})?$/;

export interface GenerateStorageKeyInput {
  readonly organizationId: string;
  readonly ownerType: DocumentOwnerType;
  /**
   * The validated MIME type. An unrecognised type yields an extension-less key
   * rather than an error, because the type allow-list is enforced in
   * `./validate`, not here.
   */
  readonly mimeType?: string;
  /** Injectable so tests can pin the yyyy/mm partition. */
  readonly now?: Date;
}

/**
 * The canonical extension for a MIME type, from the same allow-list the upload
 * validator uses. First entry wins: `.jpg`, not `.jpeg`.
 */
function canonicalExtension(mimeType: string | undefined): string {
  if (mimeType === undefined || !isAllowedMimeType(mimeType)) return '';
  return ALLOWED_UPLOAD_MIME_TYPES[mimeType][0] ?? '';
}

export function generateStorageKey(input: GenerateStorageKeyInput): string {
  const organizationId = input.organizationId.trim();
  if (!/^[A-Za-z0-9]{1,40}$/.test(organizationId)) {
    // An organisation id that is not in the cuid alphabet means the caller is
    // passing something other than a tenant id, and that something would become
    // a directory name.
    throw new BadRequestError('Cannot build a storage key for an invalid organisation id.');
  }

  // UTC, like every other instant in the platform. A key partitioned by the
  // server's local month would reshuffle when the deployment's timezone changes.
  const now = input.now ?? new Date();
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');

  const ownerType = input.ownerType.toLowerCase();
  const id = randomBytes(RANDOM_BYTES).toString('hex');

  return `${organizationId}/${ownerType}/${year}/${month}/${id}${canonicalExtension(input.mimeType)}`;
}

/**
 * True when `key` is shaped like something we generated. Callers that only need
 * a boolean (a cleanup job walking the store, say) use this; request paths use
 * `assertStorageKeyForOrganization`, which also pins the tenant.
 */
export function isSafeStorageKey(key: string): boolean {
  return parseStorageKey(key) !== null;
}

export function parseStorageKey(key: string): StorageKeyParts | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;

  // Redundant given KEY_PATTERN, and kept anyway: these two are the payloads a
  // traversal attempt actually uses, and an explicit rejection makes the
  // intent legible to the next person who widens the pattern.
  if (key.includes('..') || key.startsWith('/')) return null;

  const match = KEY_PATTERN.exec(key);
  const groups = match?.groups;
  if (!groups) return null;

  const ownerType = groups['ownerType'];
  const organizationId = groups['organizationId'];
  const year = groups['year'];
  const month = groups['month'];
  const id = groups['id'];
  if (
    organizationId === undefined ||
    ownerType === undefined ||
    year === undefined ||
    month === undefined ||
    id === undefined
  ) {
    return null;
  }
  if (!OWNER_SEGMENTS.has(ownerType)) return null;

  return {
    organizationId,
    ownerType: ownerType as StorageOwnerSegment,
    year,
    month,
    id,
    extension: groups['extension'] ?? '',
  };
}

export function storageKeyBelongsToOrganization(key: string, organizationId: string): boolean {
  return parseStorageKey(key)?.organizationId === organizationId;
}

/**
 * The gate every read and delete goes through.
 *
 * Two distinct failures, reported differently on purpose. A malformed key is a
 * client bug or a traversal probe -- 400, and nothing about our storage layout
 * in the response. A well-formed key belonging to another tenant is 404 rather
 * than 403: answering "forbidden" would confirm that the file exists, which is
 * exactly what an attacker replaying a key from another organisation wants to
 * learn. Both are logged, because both mean someone sent a key they were not
 * given.
 */
export function assertStorageKeyForOrganization(
  key: string,
  organizationId: string,
): StorageKeyParts {
  const parts = parseStorageKey(key);
  if (!parts) {
    logger.warn('storage.key_rejected', { organizationId, keyLength: key.length });
    throw new BadRequestError('That file reference is not valid.');
  }
  if (parts.organizationId !== organizationId) {
    logger.warn('storage.key_cross_tenant', {
      organizationId,
      keyOrganizationId: parts.organizationId,
    });
    throw new NotFoundError('File');
  }
  return parts;
}

/** Exposed so unit tests can assert the pattern without going through a driver. */
export const __testing = { KEY_PATTERN, OWNER_SEGMENTS, MAX_KEY_LENGTH };
