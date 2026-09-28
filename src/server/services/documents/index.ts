/**
 * Document surface.
 *
 * What a caller of this module has to know:
 *
 *   * A stored file is reachable ONLY through `getDocumentForDownload`. There is
 *     no public path, the storage key is unguessable and server-generated, and the
 *     authorisation check is part of the same query that finds the row. A route
 *     that streams bytes without going through this function is a hole.
 *   * `getDocumentForDownload` returns EITHER a `signedUrl` or a `body`. The local
 *     driver cannot sign, so a route must handle both: redirect when there is a
 *     URL, stream `body` with the returned `headers` otherwise. Those headers
 *     carry the `nosniff`, sandbox-CSP and `attachment` protections that stop a
 *     stored file executing on our own origin — do not rebuild them by hand.
 *   * `deleteDocument` is a soft delete of the row and a hard delete of the bytes.
 *     `objectRemoved: false` means the row is gone from every list but the object
 *     outlived it and a sweeper should collect it.
 */

export {
  deleteDocument,
  getDocumentForDownload,
  listDocumentAccessLog,
  listDocuments,
  uploadDocument,
  type DeleteDocumentInput,
  type DocumentAccessEntry,
  type DocumentDownload,
  type DocumentSummary,
  type DownloadDocumentInput,
  type ListDocumentsInput,
  type PageInput,
  type Paginated,
  type UploadDocumentInput,
  type UploadDocumentResult,
  type UploadFileInput,
} from '@/server/services/documents/documents';
