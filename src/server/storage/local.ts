/**
 * Local-disk storage driver. The default, and what development and small
 * single-server installations run on.
 *
 * Objects are written under `env.STORAGE_LOCAL_PATH` at their key, so the
 * directory tree mirrors the key structure and an operator can find a tenant's
 * files with `ls`. Nothing else is written: no sidecar metadata, because
 * `Document` already holds the type, size and checksum and a second copy would
 * be free to drift from the row that authorisation reads.
 */

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/server/env';
import { ConflictError, InternalError, NotFoundError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import { isSafeStorageKey } from './keys';
import type { GetResult, PutOptions, PutResult, StorageProvider } from './types';
import { assertDeclaredLength, checksumOf } from './validate';

/** Relative paths resolve against the process working directory (the repo root in dev). */
const ROOT = path.resolve(env.STORAGE_LOCAL_PATH);

function errorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown };
  return typeof candidate?.code === 'string' ? candidate.code : undefined;
}

/**
 * Turn a key into an absolute path, and refuse to return one that is not inside
 * the store.
 *
 * THE ATTACK: a key is a string that reaches `path.resolve`. Given
 * `../../../../etc/passwd` -- or `C:\Windows\win.ini`, or a key smuggling a
 * `..%2f` that some intermediary decoded -- `resolve` cheerfully produces a path
 * outside the store, and the same call sites that read a student's photo now read
 * the server's private key or overwrite a systemd unit.
 *
 * Two independent layers stop it. `isSafeStorageKey` only admits keys in the
 * shape we generate, whose character classes cannot express a traversal. Then
 * the resolved path is checked to be a descendant of the root, which holds even
 * if the pattern is widened later or a symlink is involved -- the prefix test is
 * on the *resolved* path, so `a/b/../../..` has already collapsed.
 */
function resolveWithinRoot(key: string): string {
  if (!isSafeStorageKey(key)) {
    // Not a client-facing error: the request layer validates keys with
    // `assertStorageKeyForOrganization` long before a driver is reached, so
    // arriving here means our own code built a bad key.
    logger.error('storage.local.unsafe_key', { keyLength: key.length });
    throw new InternalError('Storage key rejected.');
  }

  const resolved = path.resolve(ROOT, key);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    logger.error('storage.local.escaped_root', { keyLength: key.length });
    throw new InternalError('Storage key rejected.');
  }
  return resolved;
}

async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  options: PutOptions,
): Promise<PutResult> {
  assertDeclaredLength(body, options.contentLength);
  const target = resolveWithinRoot(key);
  await mkdir(path.dirname(target), { recursive: true });

  try {
    // `wx` fails if the file exists. Keys carry 128 bits of randomness, so a
    // collision is a bug in the caller (reusing a key), and `Document.storageKey`
    // is UNIQUE precisely so one object can never be aliased by two rows --
    // silently overwriting here would defeat that.
    await writeFile(target, body, { flag: 'wx' });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new ConflictError('That file has already been stored.', { cause: error });
    }
    throw error;
  }

  return { key, size: body.byteLength, checksum: checksumOf(body) };
}

async function getObject(key: string): Promise<GetResult> {
  const target = resolveWithinRoot(key);
  try {
    const bytes = await readFile(target);
    return {
      stream: bytes,
      // See `GetResult.contentType`: the local store keeps no object metadata,
      // and inventing a type by re-sniffing here would give callers a second,
      // quietly different answer from `Document.mimeType`.
      contentType: 'application/octet-stream',
      size: bytes.byteLength,
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new NotFoundError('File');
    throw error;
  }
}

async function deleteObject(key: string): Promise<void> {
  const target = resolveWithinRoot(key);
  try {
    await unlink(target);
  } catch (error) {
    // Deleting an object that is already gone is the outcome the caller wanted.
    // Empty directories are left behind: pruning them races concurrent writes
    // into the same yyyy/mm partition for no benefit.
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

async function objectExists(key: string): Promise<boolean> {
  const target = resolveWithinRoot(key);
  try {
    await access(target, fsConstants.R_OK);
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

export const LocalStorageProvider: StorageProvider = {
  name: 'local',
  put: putObject,
  get: getObject,
  delete: deleteObject,
  exists: objectExists,
  /**
   * The local store has no public origin to sign for, so there is no URL to
   * hand back. The caller streams the bytes through its own authorised route --
   * which is the safer arrangement anyway, because every byte served stays
   * behind a permission check and lands in `DocumentAccessLog`.
   */
  signedUrl: async () => null,
};

export const __testing = { ROOT, resolveWithinRoot };
