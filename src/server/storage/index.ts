/**
 * Storage entry point: driver selection, and the response headers a download
 * route must send.
 *
 * Callers import `getStorage()` rather than a driver, so switching a deployment
 * from local disk to S3 is an environment change and nothing else.
 */

import { sanitizeFileName } from '@/lib/validation';
import { env } from '@/server/env';
import { LocalStorageProvider } from './local';
import { S3StorageProvider } from './s3';
import type { StorageProvider } from './types';

export type {
  GetResult,
  PutOptions,
  PutResult,
  StorageDriverName,
  StorageKeyParts,
  StorageOwnerSegment,
  StorageProvider,
} from './types';
export {
  assertStorageKeyForOrganization,
  generateStorageKey,
  isSafeStorageKey,
  parseStorageKey,
  storageKeyBelongsToOrganization,
} from './keys';
export {
  checksumOf,
  maxUploadBytes,
  sniffFormat,
  validateUpload,
  type SniffedFormat,
  type UploadCandidate,
  type ValidatedUpload,
} from './validate';

let cached: StorageProvider | null = null;

/**
 * Memoised because a driver is stateless configuration, and because the S3
 * driver validates its credentials on first use -- re-deriving that per request
 * would turn a misconfiguration into a per-request surprise instead of a
 * consistent one. The modules are imported eagerly: both are small, and a
 * dynamic import would make `getStorage()` async for every caller for no gain.
 */
export function getStorage(): StorageProvider {
  if (cached) return cached;
  cached = selectDriver();
  return cached;
}

function selectDriver(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case 's3':
      return S3StorageProvider;
    case 'local':
    default:
      return LocalStorageProvider;
  }
}

// ---------------------------------------------------------------------------
// Download response headers
// ---------------------------------------------------------------------------

/**
 * The only types we are willing to let a browser render in our own origin.
 *
 * Everything else is forced to `application/octet-stream`. WHY: a stored file
 * served inline with a type the browser will execute is stored XSS -- a `.csv`
 * of `<script>fetch('/api/...')</script>` served as `text/csv` is sniffed as
 * HTML by some browsers and runs on our origin with the viewer's session cookie,
 * and SVG and HTML need no sniffing at all. Images and PDF are safe enough to
 * preview and are what users actually expect to see inline (a receipt, a passport
 * scan), so they keep their real type; the CSP below sandboxes them anyway.
 */
const INLINE_SAFE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export interface DownloadHeaderInput {
  /** The original filename, for what the user sees in their downloads folder. */
  readonly fileName: string;
  /** `Document.mimeType` -- the validated type, not one from the request. */
  readonly mimeType: string;
  readonly sizeBytes?: number | null;
  /** `Document.checksum`, used as a strong ETag when present. */
  readonly checksum?: string | null;
  /**
   * `inline` is a request, not a guarantee: it is downgraded to `attachment`
   * for any type outside `INLINE_SAFE_TYPES`.
   */
  readonly disposition?: 'attachment' | 'inline';
}

/**
 * RFC 5987 `ext-value` encoding for the `filename*` parameter. Non-ASCII names
 * are the normal case here (Cyrillic and Uzbek Latin with diacritics), and
 * `filename=` alone cannot carry them.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the header set for streaming a stored file back.
 *
 * `Content-Disposition` carries both parameters on purpose: `filename` for
 * clients that predate RFC 5987 and `filename*` for everything else, per
 * RFC 6266. The ASCII fallback is transliteration-free -- an unrepresentable
 * character becomes `_` rather than being dropped, so the name cannot collapse
 * into something misleading like `report.pdf.exe` losing a component.
 */
export function buildDownloadHeaders(input: DownloadHeaderInput): Headers {
  const safeName = sanitizeFileName(input.fileName);
  const inlineRequested = input.disposition === 'inline';
  const renderable = INLINE_SAFE_TYPES.has(input.mimeType);

  const disposition = inlineRequested && renderable ? 'inline' : 'attachment';
  const contentType = renderable ? input.mimeType : 'application/octet-stream';

  // A quote or a backslash in the quoted-string parameter would let the name end
  // the parameter early and inject another one.
  const asciiName =
    safeName.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_') || 'download';

  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(safeName)}`,
    // Without this, a browser is free to ignore the octet-stream above and
    // render what it thinks the bytes are, which is the whole attack this
    // function exists to prevent.
    'X-Content-Type-Options': 'nosniff',
    // Defence in depth for the types we do render inline: no scripts, no
    // subresources, no same-origin privileges for the document itself.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    // Documents are tenant data behind a permission check. A shared cache
    // holding one would serve it to the next person asking for the same URL.
    'Cache-Control': 'private, no-store',
  });

  if (typeof input.sizeBytes === 'number' && input.sizeBytes >= 0) {
    headers.set('Content-Length', String(input.sizeBytes));
  }
  if (input.checksum) {
    // A SHA-256 of the contents is a strong validator by construction, so
    // conditional requests can be answered without reading the object.
    headers.set('ETag', `"${input.checksum}"`);
  }

  return headers;
}

/** Exposed so tests can reselect the driver after changing the environment. */
export const __testing = {
  INLINE_SAFE_TYPES,
  encodeRfc5987,
  resetStorage: () => {
    cached = null;
  },
};
