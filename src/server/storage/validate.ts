/**
 * Upload safety checks, run on the bytes before anything is stored.
 *
 * `@/lib/validation` can only judge the metadata a client sends. This module is
 * the only place that sees the actual content, so it is where the declared type
 * is held to account.
 *
 * WHY SNIFFING MATTERS: the declared MIME type is attacker-controlled. A file
 * uploaded as `image/jpeg` whose bytes are really `<html><script>` becomes
 * stored XSS the moment any code path serves it inline -- the browser sniffs the
 * markup, renders it on our origin, and the script runs with the victim's
 * session cookie. `./index` forces `attachment` plus `nosniff` on the way out,
 * but two independent controls is the point: the download route may be
 * bypassed by a future feature, whereas bytes rejected at upload are never
 * there to serve.
 */

import { createHash } from 'node:crypto';
import {
  ALLOWED_UPLOAD_MIME_TYPES,
  fileExtension,
  isAllowedMimeType,
  sanitizeFileName,
  type AllowedMimeType,
} from '@/lib/validation';
import { env } from '@/server/env';
import { BadRequestError, LimitExceededError, UnsupportedMediaTypeError } from '@/server/errors';

/**
 * What the leading bytes prove, not what the file claims to be. `zip` and `ole2`
 * are container formats: they prove "this is an Office container", which is as
 * far as a magic-byte check can honestly go -- see `SNIFF_EXPECTATIONS`.
 */
export type SniffedFormat = 'jpeg' | 'png' | 'webp' | 'pdf' | 'zip' | 'ole2' | 'text' | 'unknown';

/**
 * Every accepted type must have a positive signature. `unknown` is never
 * acceptable: an allow-list that falls through to "we could not tell" is a
 * deny-list again.
 */
const SNIFF_EXPECTATIONS: Record<AllowedMimeType, readonly SniffedFormat[]> = {
  'image/jpeg': ['jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  // Word 97-2003 and Excel 97-2003 are OLE2 compound files. A .doc that sniffs
  // as `zip` is really a .docx and is rejected, which is the correct answer:
  // the stored type would not match what the file is.
  'application/msword': ['ole2'],
  'application/vnd.ms-excel': ['ole2'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'text/csv': ['text'],
  'text/plain': ['text'],
};

interface Signature {
  readonly format: SniffedFormat;
  readonly offset: number;
  readonly bytes: readonly number[];
}

const SIGNATURES: readonly Signature[] = [
  { format: 'jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { format: 'png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // "%PDF-"
  { format: 'pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // Local file header. 0x0506 (empty archive) and 0x0708 (spanned) are not
  // accepted: neither is a usable OOXML document.
  { format: 'zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'ole2', offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** "RIFF" at 0 and "WEBP" at 8 -- the size field sits between them. */
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

function matches(bytes: Uint8Array, signature: readonly number[], offset: number): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/**
 * Plain text and CSV have no signature, so the check is inverted: we prove the
 * bytes are *not* something binary pretending to be text. A NUL byte or a
 * stray C0 control character means the payload is binary, and a binary blob
 * stored as `text/plain` is how a polyglot gets past a type check.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  // A UTF-8 BOM is legitimate in exports from Excel.
  const start = matches(bytes, [0xef, 0xbb, 0xbf], 0) ? 3 : 0;
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return false;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  // Reject invalid UTF-8 outright: a lone continuation byte is the classic way
  // to smuggle bytes past a decoder that is more forgiving than ours.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return false;
  }
  return true;
}

export function sniffFormat(bytes: Uint8Array): SniffedFormat {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature.bytes, signature.offset)) return signature.format;
  }
  if (matches(bytes, RIFF, 0) && matches(bytes, WEBP, 8)) return 'webp';
  if (bytes.length > 0 && looksLikeText(bytes)) return 'text';
  return 'unknown';
}

/** Lower-case hex SHA-256, the form stored in `Document.checksum`. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A declared length that disagrees with the bytes means the caller built its
 * metadata from something other than the buffer it is storing -- a truncated
 * multipart read, or a deliberate attempt to have the row claim a size the
 * object does not have.
 */
export function assertDeclaredLength(bytes: Uint8Array, contentLength: number): void {
  if (contentLength !== bytes.byteLength) {
    throw new BadRequestError('The uploaded file is incomplete. Please try again.', {
      details: { declaredBytes: contentLength, actualBytes: bytes.byteLength },
    });
  }
}

export function maxUploadBytes(): number {
  return env.STORAGE_MAX_UPLOAD_MB * 1024 * 1024;
}

export interface UploadCandidate {
  /** As supplied by the client. Used for display and the extension cross-check. */
  readonly fileName: string;
  /** As supplied by the client. Never trusted without the sniff below. */
  readonly declaredMimeType: string;
  readonly bytes: Uint8Array;
}

export interface ValidatedUpload {
  /** The type to store and to serve. Proven consistent with the bytes. */
  readonly mimeType: AllowedMimeType;
  readonly sniffed: SniffedFormat;
  readonly sizeBytes: number;
  /** Path components and control characters stripped; for display only. */
  readonly fileName: string;
  readonly extension: string;
  readonly checksum: string;
}

/**
 * The single entry point for "may these bytes be stored?". Throws rather than
 * returning a union, because every caller is a request path that should abort,
 * and `apiRoute` already maps these errors to the right status.
 */
export function validateUpload(candidate: UploadCandidate): ValidatedUpload {
  const { bytes } = candidate;
  const sizeBytes = bytes.byteLength;

  if (sizeBytes === 0) {
    throw new BadRequestError('The uploaded file is empty.');
  }

  // Size first: refusing a 2 GB upload should not cost a hash of 2 GB.
  const limit = maxUploadBytes();
  if (sizeBytes > limit) {
    throw new LimitExceededError(
      `This file is larger than the ${env.STORAGE_MAX_UPLOAD_MB} MB limit.`,
      { maxBytes: limit, sizeBytes },
    );
  }

  const declared = candidate.declaredMimeType.trim().toLowerCase();
  // A browser sends "text/csv; charset=utf-8"; the allow-list holds bare types.
  const mimeType = declared.split(';')[0]?.trim() ?? '';
  if (!isAllowedMimeType(mimeType)) {
    throw new UnsupportedMediaTypeError('This file type is not accepted.', {
      details: { declaredMimeType: mimeType },
    });
  }

  const fileName = sanitizeFileName(candidate.fileName);
  const extension = fileExtension(fileName);
  const allowedExtensions: readonly string[] = ALLOWED_UPLOAD_MIME_TYPES[mimeType];
  if (!allowedExtensions.includes(extension)) {
    throw new UnsupportedMediaTypeError(
      `A ${mimeType} file should end in ${allowedExtensions.join(' or ')}.`,
      { details: { declaredMimeType: mimeType, extension } },
    );
  }

  const sniffed = sniffFormat(bytes);
  if (!SNIFF_EXPECTATIONS[mimeType].includes(sniffed)) {
    throw new UnsupportedMediaTypeError(
      `This file is not a valid ${mimeType}. Its contents do not match its type.`,
      { details: { declaredMimeType: mimeType, sniffed } },
    );
  }

  return {
    mimeType,
    sniffed,
    sizeBytes,
    fileName,
    extension,
    checksum: checksumOf(bytes),
  };
}

export const __testing = { SNIFF_EXPECTATIONS, looksLikeText };
