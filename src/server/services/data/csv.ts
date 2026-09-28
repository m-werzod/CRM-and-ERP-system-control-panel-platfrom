/**
 * RFC 4180 CSV parsing, with no dependency and no I/O.
 *
 * Written by hand rather than pulled from a package because the failure modes of
 * a CSV import are all in the details this file exists to get right, and because
 * the import pipeline needs the ROW NUMBER of every problem — a parser that
 * hands back `string[][]` has already thrown that away.
 *
 * What the real files look like:
 *
 *   * Excel on a Russian or Uzbek locale writes SEMICOLONS, not commas, and
 *     prefixes the file with a UTF-8 BOM. Both are auto-handled: refusing them
 *     would mean telling an operator to re-save a file that opens correctly in
 *     the program they exported it from.
 *   * A quoted field may contain the delimiter, a quote (doubled), and newlines.
 *   * Line endings are CRLF, LF, or — from an old Mac export — a bare CR.
 *   * Rows are RAGGED. A short or long row is not a parse failure, it is a data
 *     problem to be reported against that row number, so the parser preserves
 *     the count it actually found and says nothing about it.
 *
 * `rowNumber` counts RECORDS as a spreadsheet numbers its rows — the header is 1
 * and the first data row is 2 — not physical lines. With an embedded newline the
 * two diverge, and the number an operator can act on is the one their editor
 * shows next to the row, not the byte offset of a line break.
 */

import { BadRequestError } from '@/server/errors';

/** Delimiters we will detect. Anything else must be passed explicitly. */
export const DETECTABLE_DELIMITERS = [',', ';', '\t'] as const;

export type CsvDelimiter = string;

export interface ParseCsvOptions {
  /** Skips detection. Must be exactly one character. */
  readonly delimiter?: CsvDelimiter;
  /**
   * Trim surrounding whitespace from every value. Only ever applied to UNQUOTED
   * fields: quoting is how a file says "these spaces are part of the value".
   */
  readonly trimUnquoted?: boolean;
}

export interface CsvRow {
  /** 1-based record number, header included. First data row is 2. */
  readonly rowNumber: number;
  readonly values: readonly string[];
}

export interface ParsedCsv {
  readonly delimiter: CsvDelimiter;
  /** Row 1, trimmed. An empty file yields an empty header and no rows. */
  readonly header: readonly string[];
  /** Every record after the header, blank ones included — see `isBlankRow`. */
  readonly rows: readonly CsvRow[];
}

// ---------------------------------------------------------------------------
// Delimiter detection
// ---------------------------------------------------------------------------

/**
 * Count each candidate in the first record, outside quotes, and take the winner.
 *
 * Only the first record is examined: it is the header, whose fields are short
 * names unlikely to contain a stray delimiter, whereas a data row full of
 * addresses ("Tashkent, Chilonzor") would skew the count toward the comma. Ties
 * go to the comma because that is what the format is named after.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DETECTABLE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) break;

    if (character === '"') {
      // A doubled quote inside a quoted field is an escaped quote, not a close.
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (character === '\n' || character === '\r') break;

    const seen = counts.get(character);
    if (seen !== undefined) counts.set(character, seen + 1);
  }

  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of DETECTABLE_DELIMITERS) {
    const count = counts.get(candidate) ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Strip a UTF-8 byte-order mark. Left in place it becomes part of the first
 * header name, so `﻿firstName` never matches the column the import expects
 * and the operator is told their file has no first-name column.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Every record in the file, header included, in order.
 *
 * Throws only for an unterminated quoted field. That one is fatal rather than
 * lenient on purpose: the alternative is silently absorbing the entire rest of
 * the file into one value, which turns a truncated upload into an import that
 * "succeeded" with one enormous row.
 */
export function parseCsvRecords(input: string, options: ParseCsvOptions = {}): CsvRow[] {
  const text = stripBom(input);
  return scan(text, resolveDelimiter(text, options.delimiter), options.trimUnquoted ?? true);
}

function scan(text: string, delimiter: CsvDelimiter, trim: boolean): CsvRow[] {
  if (text === '') return [];

  const records: CsvRow[] = [];
  let values: string[] = [];
  let field = '';
  /** True once the current field opened with a quote; suppresses trimming. */
  let quoted = false;
  let inQuotes = false;
  let rowNumber = 1;

  const endField = (): void => {
    values.push(quoted || !trim ? field : field.trim());
    field = '';
    quoted = false;
  };
  const endRecord = (): void => {
    endField();
    records.push({ rowNumber, values });
    rowNumber += 1;
    values = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) break;

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      // The file's line terminator is a transport detail; a value that spans two
      // lines means "\n" whichever convention wrote it.
      if (character === '\r') {
        if (text[index + 1] === '\n') index += 1;
        field += '\n';
        continue;
      }
      field += character;
      continue;
    }

    // A quote is an opening quote only at the start of a field. Elsewhere it is
    // a literal character: `5" nail` is not malformed CSV, it is a nail.
    if (character === '"' && field === '' && !quoted) {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      endField();
      continue;
    }
    if (character === '\n') {
      endRecord();
      continue;
    }
    if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      endRecord();
      continue;
    }
    field += character;
  }

  if (inQuotes) {
    throw new BadRequestError(
      `The file has an unclosed quoted field starting at row ${rowNumber}. Check for a missing quote.`,
      { details: { rowNumber } },
    );
  }

  // A trailing newline is a terminator, not an empty record. Anything else left
  // in the buffer is a final record with no terminator, which is legal.
  if (field !== '' || values.length > 0) endRecord();

  return records;
}

/** Records split into the header and the data rows beneath it. */
export function parseCsv(input: string, options: ParseCsvOptions = {}): ParsedCsv {
  const text = stripBom(input);
  const delimiter = resolveDelimiter(text, options.delimiter);
  const records = scan(text, delimiter, options.trimUnquoted ?? true);
  const first = records[0];

  return {
    delimiter,
    header: first ? first.values.map((value) => value.trim()) : [],
    rows: records.slice(1),
  };
}

function resolveDelimiter(text: string, requested: CsvDelimiter | undefined): CsvDelimiter {
  if (requested === undefined) return detectDelimiter(text);
  if (requested.length !== 1) {
    throw new BadRequestError('A CSV delimiter must be a single character.');
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Working with rows
// ---------------------------------------------------------------------------

/**
 * True for a record that carries no data. Excel appends these when a user has
 * ever clicked into a row below the data, so they are the norm, not an anomaly —
 * an importer that reported them as errors would report noise on most real files.
 */
export function isBlankRow(row: CsvRow): boolean {
  return row.values.every((value) => value.trim() === '');
}

/**
 * Comparison form for a column name: case, spaces, underscores and dashes all
 * dropped, so `First Name`, `first_name` and `firstName` are one column.
 */
export function normalizeHeaderName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Index a header by comparison form. A duplicate column name keeps the FIRST
 * occurrence: a file with two `phone` columns is ambiguous, and quietly reading
 * the second would make the import disagree with what the operator sees on the
 * left of their spreadsheet.
 */
export function indexHeader(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const key = normalizeHeaderName(name);
    if (key !== '' && !index.has(key)) index.set(key, position);
  });
  return index;
}

/**
 * Read one named column out of a row, trying each alias in order.
 *
 * Returns `undefined` when the column is absent from the header and `''` when it
 * is present but empty on this row — the caller needs that distinction to tell
 * "this file has no email column" from "this person has no email".
 */
export function readColumn(
  row: CsvRow,
  headerIndex: ReadonlyMap<string, number>,
  aliases: readonly string[],
): string | undefined {
  for (const alias of aliases) {
    const position = headerIndex.get(normalizeHeaderName(alias));
    if (position === undefined) continue;
    return row.values[position] ?? '';
  }
  return undefined;
}

/** A row as an object keyed by the file's own header names, for `rawRow`. */
export function rowToRecord(
  row: CsvRow,
  header: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  header.forEach((name, position) => {
    if (name === '') return;
    out[name] = row.values[position] ?? '';
  });
  // A ragged row with MORE fields than the header would otherwise lose its tail,
  // and the tail is usually the clue to what went wrong.
  for (let position = header.length; position < row.values.length; position += 1) {
    out[`column${position + 1}`] = row.values[position] ?? '';
  }
  return out;
}
