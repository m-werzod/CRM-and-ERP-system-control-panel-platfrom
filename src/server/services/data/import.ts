/**
 * Two-phase CSV import.
 *
 *   validateImport   parses and validates EVERY row and writes NOTHING to the
 *                    domain tables. One `ImportRowError` per problem, each
 *                    carrying the row number and the offending field, so an
 *                    operator can fix their spreadsheet instead of guessing.
 *   commitImport     re-reads the stored file, re-validates, and writes the valid
 *                    rows in batches inside a transaction.
 *
 * WHY THE FILE IS STORED BETWEEN THE PHASES. Validation cannot keep the parsed
 * rows anywhere a second request can reach — there is no session state to hold
 * them, and putting ten thousand candidate rows in a database table would be
 * building a second copy of the very tables we are importing into. So the raw
 * bytes go to object storage under `ImportJob.storageKey` and the commit phase
 * reads them back.
 *
 * WHY THE COMMIT RE-VALIDATES. Time passes between the two phases. A receptionist
 * may have created one of these students by hand in the meantime, a group may
 * have been archived, a branch may have closed. Trusting the first pass would let
 * the import write rows that were valid five minutes ago.
 *
 * `allOrNothing` is honoured exactly as the schema documents it: when true, a
 * single bad row aborts everything and the job ends FAILED with the full error
 * list; when false, the valid rows commit and the failures are reported as
 * COMPLETED_WITH_ERRORS. There is no third behaviour — a partial import with no
 * report is the one outcome this design exists to make impossible.
 *
 * Rows are written through the REAL use-cases (`createStudent`, `createLead`), not
 * through `createMany`. An import that skipped them would skip the student code
 * sequence, the audit row, the timeline entry and the duplicate warning — and
 * would be a second, quietly different way to create a student.
 */

import { z } from 'zod';
import type { ImportStatus, ImportType, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db, type Tx } from '@/server/db/client';
import {
  BusinessRuleError,
  NotFoundError,
  StateInvalidError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit } from '@/server/audit';
import {
  assertBranchAccess,
  organizationFilter,
  requireAnyPermission,
  requirePermission,
  resolveWriteBranch,
  type AccessContext,
} from '@/server/rbac/access';
import type { PermissionKey } from '@/server/rbac/permissions';
import { logger } from '@/server/observability/logger';
import {
  assertStorageKeyForOrganization,
  generateStorageKey,
  getStorage,
  validateUpload,
} from '@/server/storage';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  normalizePhone,
  optionalDateOnlySchema,
  optionalEmailSchema,
  optionalPersonNameSchema,
  optionalPhoneSchema,
  personNameSchema,
  toFieldIssues,
} from '@/lib/validation';
import { createStudent, type CreateStudentInput } from '@/server/services/students/students';
import { createLead, type CreateLeadInput } from '@/server/services/crm/leads';
import {
  indexHeader,
  isBlankRow,
  parseCsv,
  readColumn,
  rowToRecord,
  type CsvRow,
} from '@/server/services/data/csv';

/**
 * Rows per transaction on the commit path. Big enough that a 5 000-row import is
 * a hundred transactions rather than five thousand; small enough that one failing
 * row does not roll back the whole file in partial-commit mode.
 */
const BATCH_SIZE = 50;

/**
 * Cap on stored `ImportRowError` rows. A 50 000-row file of garbage would
 * otherwise write 50 000 error rows to report a problem the first twenty lines
 * already made obvious. The count is always exact; only the detail is capped, and
 * the job says so.
 */
const MAX_STORED_ROW_ERRORS = 1_000;

/** Problems returned inline for the confirmation screen. */
const PROBLEM_PREVIEW_LIMIT = 50;

// ---------------------------------------------------------------------------
// Supported types
// ---------------------------------------------------------------------------

/**
 * The import types this service implements. `ImportType` in the schema is wider
 * (guardians, employees, groups, attendance, payments) and those are honestly
 * unimplemented rather than half-supported: `commitImport` refuses them by name
 * instead of importing an empty set and reporting success.
 */
export type SupportedImportType = Extract<ImportType, 'STUDENTS' | 'LEADS'>;

const IMPORT_PERMISSION: Record<SupportedImportType, PermissionKey> = {
  STUDENTS: 'students.import',
  LEADS: 'leads.import',
};

/** Actions for this domain; `AUDIT_ACTIONS` covers the completion only. */
const IMPORT_AUDIT = {
  VALIDATED: 'import.validated',
  FAILED: 'import.failed',
} as const;

function isSupportedImportType(type: ImportType): type is SupportedImportType {
  return type === 'STUDENTS' || type === 'LEADS';
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

interface ColumnSpec {
  /** Field name in the row schema. */
  readonly field: string;
  /**
   * Header spellings that map to this field, compared with punctuation and case
   * removed. The first is the canonical name quoted back in error messages.
   */
  readonly aliases: readonly string[];
  readonly required: boolean;
}

const STUDENT_COLUMNS: readonly ColumnSpec[] = [
  { field: 'firstName', aliases: ['firstName', 'first name', 'name', 'ism'], required: true },
  { field: 'lastName', aliases: ['lastName', 'last name', 'surname', 'familiya'], required: true },
  { field: 'middleName', aliases: ['middleName', 'middle name', 'patronymic'], required: false },
  { field: 'dateOfBirth', aliases: ['dateOfBirth', 'date of birth', 'birthDate', 'dob'], required: false },
  { field: 'gender', aliases: ['gender', 'sex'], required: false },
  { field: 'phone', aliases: ['phone', 'phone number', 'mobile', 'telefon'], required: false },
  { field: 'email', aliases: ['email', 'e-mail'], required: false },
  { field: 'addressLine', aliases: ['addressLine', 'address'], required: false },
  { field: 'city', aliases: ['city', 'town'], required: false },
  { field: 'postalCode', aliases: ['postalCode', 'postal code', 'zip'], required: false },
  { field: 'status', aliases: ['status'], required: false },
  { field: 'notes', aliases: ['notes', 'comment', 'comments'], required: false },
  {
    field: 'emergencyContactName',
    aliases: ['emergencyContactName', 'emergency contact', 'emergency contact name'],
    required: false,
  },
  {
    field: 'emergencyContactPhone',
    aliases: ['emergencyContactPhone', 'emergency phone', 'emergency contact phone'],
    required: false,
  },
  {
    field: 'emergencyContactRelation',
    aliases: ['emergencyContactRelation', 'emergency relation', 'relationship'],
    required: false,
  },
];

const LEAD_COLUMNS: readonly ColumnSpec[] = [
  { field: 'firstName', aliases: ['firstName', 'first name', 'name', 'ism'], required: true },
  { field: 'lastName', aliases: ['lastName', 'last name', 'surname', 'familiya'], required: false },
  { field: 'phone', aliases: ['phone', 'phone number', 'mobile', 'telefon'], required: true },
  { field: 'email', aliases: ['email', 'e-mail'], required: false },
  { field: 'source', aliases: ['source', 'lead source'], required: false },
  { field: 'sourceDetail', aliases: ['sourceDetail', 'source detail', 'campaign'], required: false },
  { field: 'priority', aliases: ['priority'], required: false },
  { field: 'notes', aliases: ['notes', 'comment', 'comments'], required: false },
];

function columnsFor(type: SupportedImportType): readonly ColumnSpec[] {
  return type === 'STUDENTS' ? STUDENT_COLUMNS : LEAD_COLUMNS;
}

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

/**
 * An enum column as a human types it: `walk in`, `Walk-In` and `WALK_IN` are the
 * same value. Rejecting the first two would make the operator translate the
 * database's vocabulary by hand.
 */
function enumColumn<const T extends readonly [string, ...string[]]>(values: T) {
  return z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replace(/[\s-]+/g, '_'))
    .pipe(z.enum(values))
    .optional();
}

const studentRowSchema = z.object({
  firstName: personNameSchema,
  lastName: personNameSchema,
  middleName: optionalPersonNameSchema,
  dateOfBirth: optionalDateOnlySchema,
  gender: enumColumn(['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  addressLine: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(20).optional(),
  // GRADUATED and WITHDRAWN are deliberately absent: `createStudent` refuses
  // them, and a row that would be rejected downstream should be rejected here,
  // where the error can name the row.
  status: enumColumn(['PROSPECT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED']),
  notes: z.string().trim().max(2000).optional(),
  emergencyContactName: z.string().trim().max(120).optional(),
  emergencyContactPhone: optionalPhoneSchema,
  emergencyContactRelation: z.string().trim().max(60).optional(),
});

const leadRowSchema = z.object({
  firstName: personNameSchema,
  lastName: optionalPersonNameSchema,
  phone: z.string().trim().min(1, 'Required'),
  email: optionalEmailSchema,
  source: enumColumn([
    'WALK_IN',
    'PHONE_CALL',
    'WEBSITE',
    'INSTAGRAM',
    'TELEGRAM',
    'FACEBOOK',
    'GOOGLE_ADS',
    'REFERRAL',
    'EVENT',
    'PARTNER',
    'OTHER',
  ]),
  sourceDetail: z.string().trim().max(200).optional(),
  priority: enumColumn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
  notes: z.string().trim().max(2000).optional(),
});

type StudentRow = z.infer<typeof studentRowSchema>;
type LeadRow = z.infer<typeof leadRowSchema>;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ImportRowProblem {
  /** 1-based, as a spreadsheet numbers its rows: the header is 1. */
  readonly rowNumber: number;
  /** The header name of the offending column, or null for a whole-row problem. */
  readonly field: string | null;
  readonly code: string;
  readonly message: string;
}

export interface ImportFileInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ValidateImportInput {
  readonly type: SupportedImportType;
  readonly file: ImportFileInput;
  /** Default true: safest, and what the schema's column default says. */
  readonly allOrNothing?: boolean;
  /** Required for STUDENTS unless the caller is pinned to one branch. */
  readonly branchId?: string | null;
  /** Skips delimiter auto-detection. */
  readonly delimiter?: string;
}

export interface ImportJobSummary {
  readonly id: string;
  readonly type: ImportType;
  readonly status: ImportStatus;
  readonly fileName: string;
  readonly branchId: string | null;
  readonly totalRows: number;
  readonly validRows: number;
  readonly failedRows: number;
  readonly importedRows: number;
  readonly allOrNothing: boolean;
  readonly error: string | null;
  readonly createdById: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

export interface ValidateImportResult extends ImportJobSummary {
  /** First `PROBLEM_PREVIEW_LIMIT` problems; the rest are in `ImportRowError`. */
  readonly problems: readonly ImportRowProblem[];
  readonly problemsTruncated: boolean;
  /** True when the file can be committed as it stands. */
  readonly committable: boolean;
}

const IMPORT_JOB_SELECT = {
  id: true,
  type: true,
  status: true,
  fileName: true,
  branchId: true,
  totalRows: true,
  validRows: true,
  failedRows: true,
  importedRows: true,
  allOrNothing: true,
  error: true,
  createdById: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const satisfies Prisma.ImportJobSelect;

// ---------------------------------------------------------------------------
// Phase one: validate
// ---------------------------------------------------------------------------

export async function validateImport(
  ctx: AccessContext,
  input: ValidateImportInput,
  db?: Db,
): Promise<ValidateImportResult> {
  requirePermission(ctx, IMPORT_PERMISSION[input.type]);

  const client = db ?? prisma;
  const allOrNothing = input.allOrNothing ?? true;
  const branchId = resolveImportBranch(ctx, input.type, input.branchId);

  const text = decodeCsvUpload(input.file);
  const parsed = parseCsv(text, input.delimiter ? { delimiter: input.delimiter } : {});

  // The header is checked BEFORE anything is stored: a file with no usable columns
  // produces no job and no object, because there is nothing an operator could
  // confirm or retry.
  assertRequiredColumns(input.type, parsed.header);

  const validation = await validateRows(ctx, client, input.type, parsed, branchId);

  // Stored only now, once the file is known to be worth committing later.
  const storageKey = await storeSourceFile(ctx, input.file);

  const status = deriveValidationStatus(validation.validCount, validation.problems.length, allOrNothing);

  try {
    return await withTransaction(
      async (tx) => {
        const job = await tx.importJob.create({
          data: {
            organizationId: ctx.organizationId,
            branchId,
            type: input.type,
            status,
            fileName: input.file.fileName.slice(0, 255),
            storageKey,
            totalRows: validation.totalRows,
            validRows: validation.validCount,
            failedRows: validation.problemRowCount,
            importedRows: 0,
            allOrNothing,
            createdById: ctx.isSystem ? null : ctx.userId,
            startedAt: new Date(),
            ...(status === 'FAILED'
              ? {
                  finishedAt: new Date(),
                  error:
                    validation.validCount === 0
                      ? 'No row in the file could be imported.'
                      : 'The file contains errors and this import was set to all-or-nothing.',
                }
              : {}),
          },
          select: IMPORT_JOB_SELECT,
        });

        await writeRowErrors(tx, job.id, validation.problems, validation.rawByRow);

        await recordAudit(
          ctx,
          {
            action: status === 'FAILED' ? IMPORT_AUDIT.FAILED : IMPORT_AUDIT.VALIDATED,
            entityType: 'ImportJob',
            entityId: job.id,
            branchId,
            summary: `Validated ${input.type.toLowerCase()} import "${job.fileName}": ${validation.validCount} of ${validation.totalRows} rows ready`,
            severity: 'INFO',
            metadata: {
              totalRows: validation.totalRows,
              validRows: validation.validCount,
              failedRows: validation.problemRowCount,
              allOrNothing,
              delimiter: parsed.delimiter,
            },
          },
          tx,
        );

        return {
          ...job,
          problems: validation.problems.slice(0, PROBLEM_PREVIEW_LIMIT),
          problemsTruncated: validation.problems.length > PROBLEM_PREVIEW_LIMIT,
          committable: status === 'AWAITING_CONFIRMATION',
        };
      },
      { existing: db },
    );
  } catch (error) {
    // No job row references the object, so nothing can reach it. Same reasoning as
    // the document uploader: an unreferenced object is housekeeping, a row
    // pointing at a missing object is a broken feature.
    await getStorage()
      .delete(storageKey)
      .catch((cleanupError: unknown) => {
        logger.error('import.orphan_object', {
          organizationId: ctx.organizationId,
          storageKey,
          error: cleanupError,
        });
      });
    throw error;
  }
}

function deriveValidationStatus(
  validCount: number,
  problemCount: number,
  allOrNothing: boolean,
): ImportStatus {
  if (validCount === 0) return 'FAILED';
  if (allOrNothing && problemCount > 0) return 'FAILED';
  return 'AWAITING_CONFIRMATION';
}

// ---------------------------------------------------------------------------
// Phase two: commit
// ---------------------------------------------------------------------------

export interface CommitImportResult extends ImportJobSummary {
  readonly problems: readonly ImportRowProblem[];
  readonly problemsTruncated: boolean;
}

/**
 * Write the valid rows.
 *
 * NOTE on composition: when a caller passes its own transaction, partial-commit
 * mode degrades to all-or-nothing, because there is only one transaction to roll
 * back. That is the honest behaviour rather than a silent surprise — the returned
 * job still reports what happened.
 */
export async function commitImport(
  ctx: AccessContext,
  importJobId: string,
  db?: Db,
): Promise<CommitImportResult> {
  // The type-specific permission cannot be known before the job is loaded, so the
  // gate is "may this caller import anything at all", narrowed to the exact key
  // the moment the type is known, below.
  requireAnyPermission(ctx, ['students.import', 'leads.import']);

  const client = db ?? prisma;
  const job = await client.importJob.findFirst({
    // Scope in the same `where` as the id: fetching first and checking after would
    // reveal that another organisation has a job with this id.
    where: { id: importJobId, ...organizationFilter(ctx) },
    select: { ...IMPORT_JOB_SELECT, storageKey: true },
  });
  if (!job) throw new NotFoundError('Import job', importJobId);

  if (!isSupportedImportType(job.type)) {
    throw new BusinessRuleError(
      'import.type_unsupported',
      `Importing ${job.type.toLowerCase()} is not implemented yet.`,
      { details: { type: job.type } },
    );
  }
  requirePermission(ctx, IMPORT_PERMISSION[job.type]);

  if (job.status !== 'AWAITING_CONFIRMATION') {
    throw new StateInvalidError('import', job.status.toLowerCase(), 'committed');
  }
  if (!job.storageKey) {
    throw new BusinessRuleError(
      'import.source_missing',
      'The uploaded file for this import is no longer available. Upload it again.',
    );
  }

  const branchId = job.branchId;
  if (branchId) assertBranchAccess(ctx, branchId, 'import');

  assertStorageKeyForOrganization(job.storageKey, ctx.organizationId);
  const object = await getStorage().get(job.storageKey);
  const text = new TextDecoder('utf-8').decode(await toBytes(object.stream));
  const parsed = parseCsv(text);

  assertRequiredColumns(job.type, parsed.header);
  // Re-validated against the CURRENT state of the database: a duplicate created
  // between the two phases must not be imported now.
  const validation = await validateRows(ctx, client, job.type, parsed, branchId);

  if (job.allOrNothing && validation.problems.length > 0) {
    await failJob(
      ctx,
      client,
      job.id,
      parsed.header,
      validation,
      'The file no longer validates cleanly and this import was set to all-or-nothing. Nothing was imported.',
    );
    throw new BusinessRuleError(
      'import.revalidation_failed',
      `${validation.problemRowCount} row(s) no longer validate. Nothing was imported; review the row errors and upload a corrected file.`,
      { details: { failedRows: validation.problemRowCount } },
    );
  }

  const written = await writeValidRows(ctx, validation.candidates, job.allOrNothing, db);
  const problems = [...validation.problems, ...written.problems];
  // Rows, not problems: one row can produce three field errors, and "3 rows
  // failed" is the figure an operator can reconcile against their spreadsheet.
  const failedRows = new Set(problems.map((problem) => problem.rowNumber)).size;

  const finished = await withTransaction(
    async (tx) => {
      // The row errors are replaced, not appended: they describe this commit, and
      // two generations of errors on one job cannot be told apart by row number.
      await tx.importRowError.deleteMany({ where: { importJobId: job.id } });
      await writeRowErrors(tx, job.id, problems, validation.rawByRow);

      const status: ImportStatus = problems.length > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
      const updated = await tx.importJob.update({
        where: { id: job.id },
        data: {
          status,
          validRows: validation.validCount,
          failedRows,
          importedRows: written.imported,
          finishedAt: new Date(),
          error:
            failedRows > 0
              ? `${written.imported} row(s) imported, ${failedRows} row(s) reported as errors.`
              : null,
        },
        select: IMPORT_JOB_SELECT,
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.IMPORT_COMPLETED,
          entityType: 'ImportJob',
          entityId: job.id,
          branchId,
          summary: `Imported ${written.imported} ${job.type.toLowerCase()} row(s) from "${job.fileName}"`,
          // Bulk data entry is review-worthy: it is the fastest way to change a
          // lot of records with one click.
          severity: 'NOTICE',
          metadata: {
            type: job.type,
            importedRows: written.imported,
            failedRows,
            allOrNothing: job.allOrNothing,
          },
        },
        tx,
      );

      return updated;
    },
    { existing: db },
  );

  return {
    ...finished,
    problems: problems.slice(0, PROBLEM_PREVIEW_LIMIT),
    problemsTruncated: problems.length > PROBLEM_PREVIEW_LIMIT,
  };
}

/**
 * Record the failure of an all-or-nothing commit.
 *
 * In its own transaction, and before the error is thrown: the report is the whole
 * point of refusing, and throwing from inside a transaction would roll the report
 * back with it.
 */
async function failJob(
  ctx: AccessContext,
  db: Db,
  importJobId: string,
  header: readonly string[],
  validation: RowValidation,
  message: string,
): Promise<void> {
  await withTransaction(
    async (tx) => {
      await tx.importRowError.deleteMany({ where: { importJobId } });
      await writeRowErrors(tx, importJobId, validation.problems, validation.rawByRow);
      await tx.importJob.update({
        where: { id: importJobId },
        data: {
          status: 'FAILED',
          validRows: validation.validCount,
          failedRows: validation.problemRowCount,
          importedRows: 0,
          finishedAt: new Date(),
          error: message,
        },
      });
      await recordAudit(
        ctx,
        {
          action: IMPORT_AUDIT.FAILED,
          entityType: 'ImportJob',
          entityId: importJobId,
          summary: message,
          severity: 'NOTICE',
          metadata: { failedRows: validation.problemRowCount },
        },
        tx,
      );
    },
    { existing: db },
  );
}

interface WriteResult {
  readonly imported: number;
  readonly problems: readonly ImportRowProblem[];
}

/**
 * Write the candidates in batches.
 *
 * All-or-nothing puts every batch in ONE transaction, so a failure anywhere
 * leaves the database untouched. Partial-commit gives each batch its own
 * transaction, and when a batch fails it is retried row by row — that is how a
 * single bad row is reported by its own number instead of taking its forty-nine
 * neighbours down with it.
 */
async function writeValidRows(
  ctx: AccessContext,
  candidates: readonly RowCandidate[],
  allOrNothing: boolean,
  db?: Db,
): Promise<WriteResult> {
  if (candidates.length === 0) return { imported: 0, problems: [] };

  const batches: RowCandidate[][] = [];
  for (let index = 0; index < candidates.length; index += BATCH_SIZE) {
    batches.push([...candidates.slice(index, index + BATCH_SIZE)]);
  }

  if (allOrNothing) {
    const imported = await withTransaction(
      async (tx) => {
        let count = 0;
        for (const batch of batches) {
          for (const candidate of batch) {
            await writeOne(ctx, candidate, tx);
            count += 1;
          }
        }
        return count;
      },
      { existing: db },
    );
    return { imported, problems: [] };
  }

  let imported = 0;
  const problems: ImportRowProblem[] = [];

  for (const batch of batches) {
    try {
      await withTransaction(
        async (tx) => {
          for (const candidate of batch) await writeOne(ctx, candidate, tx);
        },
        { existing: db },
      );
      imported += batch.length;
      continue;
    } catch {
      // Fall through: the batch is replayed one row at a time so the failures can
      // be attributed. The successful rows of the rolled-back batch are simply
      // written again.
    }

    for (const candidate of batch) {
      try {
        await withTransaction(async (tx) => writeOne(ctx, candidate, tx), { existing: db });
        imported += 1;
      } catch (error) {
        problems.push({
          rowNumber: candidate.rowNumber,
          field: null,
          code: 'write_failed',
          message: describeWriteFailure(error),
        });
      }
    }
  }

  return { imported, problems };
}

async function writeOne(ctx: AccessContext, candidate: RowCandidate, tx: Tx): Promise<void> {
  if (candidate.kind === 'STUDENTS') {
    await createStudent(ctx, candidate.input, tx);
    return;
  }
  await createLead(ctx, candidate.input, tx);
}

/**
 * A message for one failed row. `AppError.publicMessage` is safe to show; anything
 * else is an unexpected fault whose text may name a constraint or a column, so it
 * is logged and replaced.
 */
function describeWriteFailure(error: unknown): string {
  const candidate = error as { publicMessage?: unknown; expected?: unknown };
  if (candidate?.expected === true && typeof candidate.publicMessage === 'string') {
    return candidate.publicMessage;
  }
  logger.error('import.row_write_failed', { error });
  return 'This row could not be imported. Check it against an existing record.';
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

/**
 * A row that passed validation, tagged with what it will become. A discriminated
 * union rather than two optional fields, so `writeOne` cannot be handed a
 * candidate with neither.
 */
type RowCandidate =
  | { readonly kind: 'STUDENTS'; readonly rowNumber: number; readonly input: CreateStudentInput }
  | { readonly kind: 'LEADS'; readonly rowNumber: number; readonly input: CreateLeadInput };

interface RowValidation {
  readonly totalRows: number;
  readonly validCount: number;
  /** Distinct rows with at least one problem. */
  readonly problemRowCount: number;
  readonly problems: readonly ImportRowProblem[];
  readonly candidates: readonly RowCandidate[];
  /** The raw row for each problem row, stored on `ImportRowError.rawRow`. */
  readonly rawByRow: ReadonlyMap<number, Record<string, string>>;
}

/**
 * Validate every row without writing anything.
 *
 * Duplicate detection is BATCHED: every phone in the file is normalised first and
 * checked against the database in one query. Asking per row would be an N+1 with
 * N in the thousands, on a path an operator is watching a spinner for.
 */
async function validateRows(
  ctx: AccessContext,
  db: Db,
  type: SupportedImportType,
  parsed: { readonly header: readonly string[]; readonly rows: readonly CsvRow[] },
  branchId: string | null,
): Promise<RowValidation> {
  const headerIndex = indexHeader(parsed.header);
  const columns = columnsFor(type);
  const problems: ImportRowProblem[] = [];
  const candidates: RowCandidate[] = [];
  const rawByRow = new Map<number, Record<string, string>>();
  const problemRows = new Set<number>();

  const dataRows = parsed.rows.filter((row) => !isBlankRow(row));

  interface Staged {
    readonly row: CsvRow;
    readonly values: Record<string, unknown>;
    readonly phone: string | null;
  }
  const staged: Staged[] = [];

  const addProblem = (row: CsvRow, problem: Omit<ImportRowProblem, 'rowNumber'>): void => {
    problems.push({ rowNumber: row.rowNumber, ...problem });
    problemRows.add(row.rowNumber);
    if (!rawByRow.has(row.rowNumber)) rawByRow.set(row.rowNumber, rowToRecord(row, parsed.header));
  };

  for (const row of dataRows) {
    // More values than headers means data would be silently dropped; a SHORT row
    // is tolerated and its missing cells read as empty, because a spreadsheet
    // routinely omits trailing empty columns.
    if (row.values.length > parsed.header.length) {
      addProblem(row, {
        field: null,
        code: 'ragged_row',
        message: `This row has ${row.values.length} values but the file has ${parsed.header.length} columns.`,
      });
      continue;
    }

    const raw: Record<string, string | undefined> = {};
    for (const column of columns) {
      const value = readColumn(row, headerIndex, column.aliases);
      // Empty and absent both become undefined: the schemas treat an omitted
      // optional column and a blank cell identically.
      raw[column.field] = value === undefined || value.trim() === '' ? undefined : value;
    }

    // Checked before the schema runs so a blank mandatory cell reads as "this
    // column is empty" rather than zod's "expected string, received undefined".
    const blankRequired = columns.filter(
      (column) => column.required && raw[column.field] === undefined,
    );
    if (blankRequired.length > 0) {
      for (const column of blankRequired) {
        addProblem(row, {
          field: column.aliases[0] ?? column.field,
          code: 'required',
          message: `"${column.aliases[0] ?? column.field}" is empty on this row.`,
        });
      }
      continue;
    }

    const result =
      type === 'STUDENTS' ? studentRowSchema.safeParse(raw) : leadRowSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of toFieldIssues(result.error)) {
        addProblem(row, {
          field: headerNameFor(columns, issue.path),
          code: issue.code ?? 'invalid',
          message: issue.message,
        });
      }
      continue;
    }

    const phoneSource =
      type === 'STUDENTS'
        ? ((result.data as StudentRow).phone ?? null)
        : (result.data as LeadRow).phone;
    const phone = phoneSource ? normalizePhone(phoneSource) : null;

    if (type === 'LEADS' && !phone) {
      addProblem(row, {
        field: headerNameFor(columns, 'phone'),
        code: 'invalid_phone',
        message: 'Not a valid phone number',
      });
      continue;
    }

    staged.push({ row, values: result.data as Record<string, unknown>, phone });
  }

  const existing = await findExistingByPhone(
    db,
    ctx.organizationId,
    type,
    staged.map((entry) => entry.phone).filter((value): value is string => value !== null),
  );

  const seenInFile = new Map<string, number>();

  for (const entry of staged) {
    if (entry.phone) {
      const already = existing.get(entry.phone);
      if (already) {
        addProblem(entry.row, {
          field: headerNameFor(columns, 'phone'),
          code: 'duplicate_existing',
          message: `This phone number already belongs to ${already}.`,
        });
        continue;
      }
      const firstSeenAt = seenInFile.get(entry.phone);
      if (firstSeenAt !== undefined) {
        addProblem(entry.row, {
          field: headerNameFor(columns, 'phone'),
          code: 'duplicate_in_file',
          message: `The same phone number appears on row ${firstSeenAt}.`,
        });
        continue;
      }
      seenInFile.set(entry.phone, entry.row.rowNumber);
    }

    candidates.push(
      type === 'STUDENTS'
        ? {
            kind: 'STUDENTS',
            rowNumber: entry.row.rowNumber,
            input: toStudentInput(entry.values, branchId),
          }
        : {
            kind: 'LEADS',
            rowNumber: entry.row.rowNumber,
            input: toLeadInput(entry.values, branchId),
          },
    );
  }

  return {
    totalRows: dataRows.length,
    validCount: candidates.length,
    problemRowCount: problemRows.size,
    problems,
    candidates,
    rawByRow,
  };
}

/**
 * Existing records keyed by normalised phone, with a label for the error message.
 * One query for the whole file.
 */
async function findExistingByPhone(
  db: Db,
  organizationId: string,
  type: SupportedImportType,
  phones: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (phones.length === 0) return out;
  const unique = [...new Set(phones)];

  if (type === 'STUDENTS') {
    const rows = await db.student.findMany({
      where: { organizationId, deletedAt: null, phoneNormalized: { in: unique } },
      select: { phoneNormalized: true, studentCode: true, firstName: true, lastName: true },
    });
    for (const row of rows) {
      if (row.phoneNormalized) {
        out.set(row.phoneNormalized, `${row.firstName} ${row.lastName} (${row.studentCode})`);
      }
    }
    return out;
  }

  const rows = await db.lead.findMany({
    where: { organizationId, deletedAt: null, phoneNormalized: { in: unique } },
    select: { phoneNormalized: true, firstName: true, lastName: true },
  });
  for (const row of rows) {
    out.set(row.phoneNormalized, [row.firstName, row.lastName].filter(Boolean).join(' '));
  }
  return out;
}

function toStudentInput(values: Record<string, unknown>, branchId: string | null): CreateStudentInput {
  const row = values as StudentRow;
  return {
    branchId,
    firstName: row.firstName,
    lastName: row.lastName,
    middleName: row.middleName ?? null,
    dateOfBirth: row.dateOfBirth ?? null,
    ...(row.gender ? { gender: row.gender } : {}),
    phone: row.phone ?? null,
    email: row.email ?? null,
    addressLine: row.addressLine ?? null,
    city: row.city ?? null,
    postalCode: row.postalCode ?? null,
    ...(row.status ? { status: row.status } : {}),
    notes: row.notes ?? null,
    emergencyContactName: row.emergencyContactName ?? null,
    emergencyContactPhone: row.emergencyContactPhone ?? null,
    emergencyContactRelation: row.emergencyContactRelation ?? null,
  };
}

function toLeadInput(values: Record<string, unknown>, branchId: string | null): CreateLeadInput {
  const row = values as LeadRow;
  return {
    branchId,
    firstName: row.firstName,
    lastName: row.lastName ?? null,
    phone: row.phone,
    email: row.email ?? null,
    ...(row.source ? { source: row.source } : {}),
    sourceDetail: row.sourceDetail ?? null,
    ...(row.priority ? { priority: row.priority } : {}),
    notes: row.notes ?? null,
    // An import has nobody watching to judge a near-match, so a duplicate is a
    // rejected row rather than a warning nobody reads.
    allowDuplicate: false,
  };
}

/**
 * The header spelling the operator used for a field, so the error names the column
 * as it appears in their file rather than our internal field name.
 */
function headerNameFor(columns: readonly ColumnSpec[], path: string): string | null {
  const field = path.split('.')[0];
  if (!field) return null;
  const spec = columns.find((column) => column.field === field);
  return spec?.aliases[0] ?? field;
}

// ---------------------------------------------------------------------------
// Row errors
// ---------------------------------------------------------------------------

async function writeRowErrors(
  tx: Tx,
  importJobId: string,
  problems: readonly ImportRowProblem[],
  rawByRow: ReadonlyMap<number, Record<string, string>>,
): Promise<void> {
  if (problems.length === 0) return;

  const stored = problems.slice(0, MAX_STORED_ROW_ERRORS);
  await tx.importRowError.createMany({
    data: stored.map((problem) => ({
      importJobId,
      rowNumber: problem.rowNumber,
      field: problem.field,
      code: problem.code,
      message: problem.message,
      // The offending row, so the operator can fix and re-upload just that line.
      rawRow: rawByRow.get(problem.rowNumber) ?? {},
    })),
  });

  if (problems.length > stored.length) {
    await tx.importRowError.create({
      data: {
        importJobId,
        rowNumber: 0,
        field: null,
        code: 'too_many_errors',
        message: `${problems.length - stored.length} further problems were found and are not listed individually. Fix the ones above and upload the file again.`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListImportJobsInput {
  readonly page?: number;
  readonly pageSize?: number;
  readonly type?: ImportType;
  readonly status?: readonly ImportStatus[];
}

export interface ImportJobPage {
  readonly items: readonly ImportJobSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export async function listImportJobs(
  ctx: AccessContext,
  input: ListImportJobsInput = {},
  db?: Db,
): Promise<ImportJobPage> {
  requireAnyPermission(ctx, ['students.import', 'leads.import']);

  const client = db ?? prisma;
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.pageSize ?? PAGE_SIZE_DEFAULT)),
  );

  const where: Prisma.ImportJobWhereInput = {
    ...organizationFilter(ctx),
    ...(ctx.scope === 'ORGANIZATION'
      ? {}
      : // An import job's branch is nullable: an organisation-wide import belongs
        // to no branch and is visible to anyone who may import.
        { OR: [{ branchId: { in: [...ctx.branchIds] } }, { branchId: null }] }),
    ...(input.type ? { type: input.type } : {}),
    ...(input.status && input.status.length > 0 ? { status: { in: [...input.status] } } : {}),
  };

  const [total, items] = await Promise.all([
    client.importJob.count({ where }),
    client.importJob.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: IMPORT_JOB_SELECT,
    }),
  ]);

  return { items, page, pageSize, total };
}

export interface ImportJobDetail extends ImportJobSummary {
  readonly problems: readonly ImportRowProblem[];
  readonly problemsTruncated: boolean;
}

export async function getImportJob(
  ctx: AccessContext,
  importJobId: string,
  input: { readonly problemLimit?: number } = {},
  db?: Db,
): Promise<ImportJobDetail> {
  requireAnyPermission(ctx, ['students.import', 'leads.import']);

  const client = db ?? prisma;
  const job = await client.importJob.findFirst({
    where: { id: importJobId, ...organizationFilter(ctx) },
    select: IMPORT_JOB_SELECT,
  });
  if (!job) throw new NotFoundError('Import job', importJobId);
  if (job.branchId) assertBranchAccess(ctx, job.branchId, 'import');

  const limit = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(input.problemLimit ?? PROBLEM_PREVIEW_LIMIT)),
  );
  const rows = await client.importRowError.findMany({
    where: { importJobId: job.id },
    orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: { rowNumber: true, field: true, code: true, message: true },
  });

  return {
    ...job,
    problems: rows.slice(0, limit).map((row) => ({
      rowNumber: row.rowNumber,
      field: row.field,
      code: row.code ?? 'invalid',
      message: row.message,
    })),
    problemsTruncated: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * Which branch the imported records land in.
 *
 * A student must have one, so `resolveWriteBranch` applies and an
 * organisation-scoped caller has to be explicit. A lead legitimately has none —
 * an enquiry arrives before anyone decides which site will serve it — so an
 * explicit choice is verified and an absent one is allowed.
 */
function resolveImportBranch(
  ctx: AccessContext,
  type: SupportedImportType,
  requested: string | null | undefined,
): string | null {
  if (type === 'STUDENTS') return resolveWriteBranch(ctx, requested, 'import');
  if (requested) {
    assertBranchAccess(ctx, requested, 'import');
    return requested;
  }
  if (ctx.scope === 'ORGANIZATION' || ctx.isSystem) return null;
  return ctx.primaryBranchId ?? ctx.branchIds[0] ?? null;
}

/**
 * Validate the upload with the same magic-byte, allow-list and size checks the
 * document uploader uses, then narrow to CSV.
 *
 * `validateUpload` accepts spreadsheets too, and a .xlsx is a ZIP container this
 * parser cannot read — accepting it and finding no columns would report "your file
 * has no firstName column" about a file that is full of them.
 */
function decodeCsvUpload(file: ImportFileInput): string {
  const validated = validateUpload({
    fileName: file.fileName,
    declaredMimeType: file.mimeType,
    bytes: file.bytes,
  });

  if (validated.mimeType !== 'text/csv' && validated.mimeType !== 'text/plain') {
    throw new UnsupportedMediaTypeError(
      'Import files must be CSV. Save your spreadsheet as CSV and upload it again.',
      { details: { mimeType: validated.mimeType } },
    );
  }

  // `validateUpload` has already proven the bytes decode as UTF-8, so this cannot
  // produce replacement characters.
  return new TextDecoder('utf-8').decode(file.bytes);
}

async function storeSourceFile(ctx: AccessContext, file: ImportFileInput): Promise<string> {
  const key = generateStorageKey({
    organizationId: ctx.organizationId,
    ownerType: 'ORGANIZATION',
    mimeType: 'text/csv',
  });
  const stored = await getStorage().put(key, file.bytes, {
    contentType: 'text/csv',
    contentLength: file.bytes.byteLength,
  });
  return stored.key;
}

/** The local driver returns a Buffer, S3 a web stream; both have to become bytes. */
async function toBytes(body: ReadableStream<Uint8Array> | Buffer): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;

  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fail the whole file when a required column is missing.
 *
 * A `ValidationError` rather than per-row errors: with no firstName column every
 * row is broken for the same reason, and ten thousand identical row errors bury
 * the one sentence that would fix it.
 */
function assertRequiredColumns(type: SupportedImportType, header: readonly string[]): void {
  const headerIndex = indexHeader(header);
  const missing = columnsFor(type)
    .filter((column) => column.required)
    .filter((column) => !column.aliases.some((alias) => headerIndex.has(normalizeAlias(alias))));

  if (missing.length > 0) {
    throw new ValidationError(
      missing.map((column) => ({
        path: column.field,
        message: `The file has no "${column.aliases[0]}" column. Accepted names: ${column.aliases.join(', ')}.`,
      })),
      'The file is missing required columns.',
    );
  }
}

function normalizeAlias(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9]/g, '');
}
