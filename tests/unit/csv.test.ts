import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import {
  detectDelimiter,
  indexHeader,
  isBlankRow,
  normalizeHeaderName,
  parseCsv,
  parseCsvRecords,
  readColumn,
  rowToRecord,
  stripBom,
} from '@/server/services/data/csv';

/**
 * The import pipeline reports every problem against a row number, so the parser's
 * contract is not just "which values" but "which row" — both are pinned here.
 * The cases are the ones real uploads actually produce: Excel's semicolons and
 * BOM, addresses with commas inside quotes, quotes doubled by an export, and
 * rows that are short because somebody deleted a cell.
 */

describe('detectDelimiter', () => {
  it('prefers the delimiter that appears most in the header row', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('ignores delimiters inside quoted header fields', () => {
    // One real semicolon; the two commas are inside a quoted name.
    expect(detectDelimiter('"last, first";phone')).toBe(';');
  });

  it('only looks at the first record, so a comma-rich data row cannot win', () => {
    expect(detectDelimiter('name;city\n"Ali";"Tashkent, Chilonzor, 12"')).toBe(';');
  });

  it('falls back to a comma when nothing is found', () => {
    expect(detectDelimiter('justoneheader')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });
});

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM and nothing else', () => {
    expect(stripBom('\uFEFFfirstName,lastName')).toBe('firstName,lastName');
    expect(stripBom('firstName')).toBe('firstName');
    // A BOM that is not at the start is data.
    expect(stripBom('a\uFEFFb')).toBe('a\uFEFFb');
  });

  it('keeps a BOM out of the first header name', () => {
    const parsed = parseCsv('\uFEFFfirstName,phone\nAli,901234567');
    expect(parsed.header).toEqual(['firstName', 'phone']);
    expect(indexHeader(parsed.header).get('firstname')).toBe(0);
  });
});

describe('parseCsv', () => {
  it('splits a plain file into a header and numbered rows', () => {
    const parsed = parseCsv('firstName,lastName\nAli,Valiyev\nOlima,Karimova');

    expect(parsed.delimiter).toBe(',');
    expect(parsed.header).toEqual(['firstName', 'lastName']);
    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: ['Ali', 'Valiyev'] },
      { rowNumber: 3, values: ['Olima', 'Karimova'] },
    ]);
  });

  it('handles a quoted field containing both a newline and a delimiter', () => {
    const text = 'name,address\n"Ali","Chilonzor 12, apt 5\nTashkent"\n"Olima","Yunusobod 3"';
    const parsed = parseCsv(text);

    expect(parsed.rows).toEqual([
      { rowNumber: 2, values: ['Ali', 'Chilonzor 12, apt 5\nTashkent'] },
      { rowNumber: 3, values: ['Olima', 'Yunusobod 3'] },
    ]);
  });

  it('numbers rows as a spreadsheet does, not by physical line', () => {
    // The embedded newline puts row 3 on the fourth physical line.
    const parsed = parseCsv('a\n"one\ntwo"\nthree');
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(parsed.rows[1]?.values).toEqual(['three']);
  });

  it('unescapes doubled quotes and keeps a quote at the field edge', () => {
    const parsed = parseCsv('note\n"She said ""hello"" twice"\n"""quoted"""');

    expect(parsed.rows[0]?.values).toEqual(['She said "hello" twice']);
    expect(parsed.rows[1]?.values).toEqual(['"quoted"']);
  });

  it('treats a quote inside an unquoted field as a literal character', () => {
    const parsed = parseCsv('size\n5" nail');
    expect(parsed.rows[0]?.values).toEqual(['5" nail']);
  });

  it('accepts CRLF, LF and a bare CR as record terminators', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4').rows).toEqual([
      { rowNumber: 2, values: ['1', '2'] },
      { rowNumber: 3, values: ['3', '4'] },
    ]);
    expect(parseCsv('a,b\r1,2').rows).toEqual([{ rowNumber: 2, values: ['1', '2'] }]);
  });

  it('normalises a CRLF inside a quoted field to a single newline', () => {
    const parsed = parseCsv('note\r\n"line one\r\nline two"\r\n');
    expect(parsed.rows[0]?.values).toEqual(['line one\nline two']);
  });

  it('preserves a ragged row exactly as found, short or long', () => {
    const parsed = parseCsv('a,b,c\n1,2\n1,2,3,4');

    expect(parsed.header).toHaveLength(3);
    expect(parsed.rows[0]?.values).toEqual(['1', '2']);
    expect(parsed.rows[1]?.values).toEqual(['1', '2', '3', '4']);
  });

  it('does not invent a record for a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toHaveLength(1);
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toHaveLength(1);
  });

  it('keeps a blank record so later row numbers stay correct', () => {
    const parsed = parseCsv('a\n1\n\n3');

    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    expect(isBlankRow(parsed.rows[1]!)).toBe(true);
    expect(parsed.rows[2]?.values).toEqual(['3']);
  });

  it('auto-detects semicolons as written by a European Excel export', () => {
    const parsed = parseCsv('\uFEFFfirstName;phone;city\nAli;901234567;"Tashkent, Chilonzor"');

    expect(parsed.delimiter).toBe(';');
    expect(parsed.rows[0]?.values).toEqual(['Ali', '901234567', 'Tashkent, Chilonzor']);
  });

  it('honours an explicit delimiter over detection', () => {
    const parsed = parseCsv('a;b,c\n1;2,3', { delimiter: ',' });
    expect(parsed.header).toEqual(['a;b', 'c']);
  });

  it('rejects a delimiter that is not one character', () => {
    expect(() => parseCsv('a,b', { delimiter: '||' })).toThrow(AppError);
  });

  it('trims unquoted values but not quoted ones', () => {
    const parsed = parseCsv('a,b\n  x  ,"  y  "');
    expect(parsed.rows[0]?.values).toEqual(['x', '  y  ']);
  });

  it('can be told to keep unquoted whitespace', () => {
    const parsed = parseCsv('a\n  x  ', { trimUnquoted: false });
    expect(parsed.rows[0]?.values).toEqual(['  x  ']);
  });

  it('returns an empty header and no rows for an empty file', () => {
    expect(parseCsv('')).toEqual({ delimiter: ',', header: [], rows: [] });
    expect(parseCsv('\uFEFF').rows).toEqual([]);
  });

  it('preserves empty fields, including a trailing one', () => {
    expect(parseCsv('a,b,c\n1,,3').rows[0]?.values).toEqual(['1', '', '3']);
    expect(parseCsv('a,b\n1,').rows[0]?.values).toEqual(['1', '']);
  });

  it('refuses a file whose quoted field is never closed', () => {
    // Silently absorbing the rest of the file is how a truncated upload becomes
    // a "successful" one-row import.
    expect(() => parseCsv('a,b\n"oops,2\n3,4')).toThrow(AppError);
    expect(() => parseCsv('a\n"unclosed')).toThrow(/unclosed quoted field/i);
  });
});

describe('parseCsvRecords', () => {
  it('includes the header as record 1', () => {
    expect(parseCsvRecords('a,b\n1,2')).toEqual([
      { rowNumber: 1, values: ['a', 'b'] },
      { rowNumber: 2, values: ['1', '2'] },
    ]);
  });
});

describe('column helpers', () => {
  it('normalises header names so spelling variants are one column', () => {
    expect(normalizeHeaderName('First Name')).toBe('firstname');
    expect(normalizeHeaderName('first_name')).toBe('firstname');
    expect(normalizeHeaderName('firstName')).toBe('firstname');
    expect(normalizeHeaderName('  FIRST-NAME ')).toBe('firstname');
  });

  it('keeps the first of two identically named columns', () => {
    const index = indexHeader(['phone', 'Phone']);
    expect(index.get('phone')).toBe(0);
  });

  it('distinguishes an absent column from an empty cell', () => {
    const parsed = parseCsv('firstName,email\nAli,');
    const index = indexHeader(parsed.header);
    const row = parsed.rows[0]!;

    expect(readColumn(row, index, ['email', 'e-mail'])).toBe('');
    expect(readColumn(row, index, ['phone'])).toBeUndefined();
  });

  it('reads a column through an alias', () => {
    const parsed = parseCsv('Given name\nAli');
    const index = indexHeader(parsed.header);
    expect(readColumn(parsed.rows[0]!, index, ['firstName', 'given name'])).toBe('Ali');
  });

  it('returns an empty string for a cell a short row never reached', () => {
    const parsed = parseCsv('a,b,c\n1');
    const index = indexHeader(parsed.header);
    expect(readColumn(parsed.rows[0]!, index, ['c'])).toBe('');
  });
});

describe('rowToRecord', () => {
  it('keys values by the file’s own header names', () => {
    const parsed = parseCsv('First Name,phone\nAli,901234567');
    expect(rowToRecord(parsed.rows[0]!, parsed.header)).toEqual({
      'First Name': 'Ali',
      phone: '901234567',
    });
  });

  it('keeps the tail of a row that is longer than the header', () => {
    const parsed = parseCsv('a,b\n1,2,3');
    expect(rowToRecord(parsed.rows[0]!, parsed.header)).toEqual({
      a: '1',
      b: '2',
      column3: '3',
    });
  });
});
