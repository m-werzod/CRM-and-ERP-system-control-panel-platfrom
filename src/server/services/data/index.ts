/**
 * Bulk data surface: the CSV parser and the two-phase import.
 *
 * The HTTP layer imports from here rather than from the individual files. The
 * parser is exported too, because the UI's pre-upload preview must split a file
 * exactly the way the server will — a second parser in the client is how
 * "the preview showed four columns and the import found three" happens.
 *
 * Two things a caller has to know:
 *
 *   * `validateImport` WRITES NOTHING to the domain tables. It creates an
 *     `ImportJob`, stores the uploaded file, and records one `ImportRowError` per
 *     problem. `commitImport` is a second, explicit request.
 *   * only STUDENTS and LEADS are implemented. The other `ImportType` values
 *     exist in the schema and are refused by name, not silently ignored.
 */

export {
  detectDelimiter,
  indexHeader,
  isBlankRow,
  normalizeHeaderName,
  parseCsv,
  parseCsvRecords,
  readColumn,
  rowToRecord,
  stripBom,
  DETECTABLE_DELIMITERS,
  type CsvDelimiter,
  type CsvRow,
  type ParseCsvOptions,
  type ParsedCsv,
} from '@/server/services/data/csv';

export {
  commitImport,
  getImportJob,
  listImportJobs,
  validateImport,
  type CommitImportResult,
  type ImportFileInput,
  type ImportJobDetail,
  type ImportJobPage,
  type ImportJobSummary,
  type ImportRowProblem,
  type ListImportJobsInput,
  type SupportedImportType,
  type ValidateImportInput,
  type ValidateImportResult,
} from '@/server/services/data/import';
