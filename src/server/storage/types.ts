/**
 * The storage contract.
 *
 * Uploaded bytes never live in the database and never live at a path a client
 * chose. A driver only ever sees an opaque key produced by `./keys`, so the
 * provider interface can stay this small: it has no concept of tenants,
 * permissions or filenames. Authorisation happens in the service layer before a
 * driver is touched, which is why nothing here takes an `AccessContext` --
 * a driver that could enforce scope would invite callers to rely on it instead
 * of on `composeReadFilter`.
 */

import type { DocumentOwnerType } from '@/generated/prisma/client';

/** Mirrors `env.STORAGE_DRIVER`; a new driver must be added in both places. */
export type StorageDriverName = 'local' | 's3';

/**
 * The owner segment of a storage key, derived from the Prisma enum so the two
 * cannot drift. Lower-cased because keys end up in URLs and log lines, where
 * SCREAMING_SNAKE reads badly.
 */
export type StorageOwnerSegment = Lowercase<DocumentOwnerType>;

/** The decomposed form of a storage key. See `./keys` for the shape. */
export interface StorageKeyParts {
  readonly organizationId: string;
  readonly ownerType: StorageOwnerSegment;
  /** Four digits, UTC. */
  readonly year: string;
  /** Two digits, UTC. */
  readonly month: string;
  /** 32 lower-case hex characters of CSPRNG output. */
  readonly id: string;
  /** Canonical extension including the leading dot, or `''` when unknown. */
  readonly extension: string;
}

export interface PutOptions {
  /** The validated MIME type, not the one the client claimed. */
  readonly contentType: string;
  /**
   * Byte length the caller believes it is storing. Drivers reject a mismatch
   * rather than silently storing a truncated object.
   */
  readonly contentLength: number;
}

export interface PutResult {
  readonly key: string;
  readonly size: number;
  /** Lower-case hex SHA-256 of the stored bytes, for `Document.checksum`. */
  readonly checksum: string;
}

export interface GetResult {
  /**
   * A web stream when the driver can stream (S3), a `Buffer` when reading the
   * whole object is cheaper than wrapping it (local disk). Callers hand either
   * straight to a `Response`.
   */
  readonly stream: ReadableStream<Uint8Array> | Buffer;
  /**
   * ADVISORY. Only drivers that store object metadata (S3) can return the real
   * type; the local driver keeps no sidecar and reports
   * `application/octet-stream`. The authoritative type is `Document.mimeType`,
   * because a second copy of it in the object store could drift from the row
   * that authorisation and rendering decisions are made from.
   */
  readonly contentType: string;
  readonly size: number;
}

export interface StorageProvider {
  readonly name: StorageDriverName;

  put(
    key: string,
    body: Buffer | Uint8Array,
    options: PutOptions,
  ): Promise<PutResult>;

  get(key: string): Promise<GetResult>;

  /** Idempotent: deleting an absent key is not an error. */
  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  /**
   * A short-lived URL the browser may fetch directly, or `null` when the driver
   * cannot sign one. `null` is a normal answer, not a failure: the local driver
   * has no public origin, so the caller streams the bytes through its own
   * authorised route instead.
   */
  signedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
}
