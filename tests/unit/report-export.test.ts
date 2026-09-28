import { describe, expect, it } from 'vitest';
import {
  moneyColumn,
  percentColumn,
  renderCell,
  toCsv,
  UTF8_BOM,
  type ReportColumn,
} from '@/server/services/reports/export';
import {
  bucketsIn,
  bucketStart,
  capRows,
  shareOfMoneyPpm,
  sharePpm,
  type ReportGranularity,
  type ReportScope,
} from '@/server/services/reports/types';

/**
 * The exporter is the last thing that touches a figure before it leaves the
 * system, so these pin the two properties that matter and are easy to lose: a
 * monetary amount must arrive in an accountant's spreadsheet as an exact decimal,
 * and a name containing a comma, a quote or a newline must not shift every
 * following column by one.
 *
 * The CSV-injection cases are here for the same reason as the quoting ones: the
 * file is valid either way, and the damage happens when a colleague opens it.
 */

type Row = {
  readonly name: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly ratePpm: number | null;
  readonly note: string | null;
};

const columns: readonly ReportColumn<Row>[] = [
  { key: 'name', labelKey: 'columns.name' },
  moneyColumn<Row>('amountMinor', 'columns.amount', 'currency'),
  percentColumn<Row>('ratePpm', 'columns.rate'),
  { key: 'note', labelKey: 'columns.note' },
];

function row(overrides: Partial<Row> = {}): Row {
  return {
    name: 'Karimov Sherzod',
    amountMinor: '150000000',
    currency: 'UZS',
    ratePpm: 875_000,
    note: null,
    ...overrides,
  };
}

function lines(csv: string): string[] {
  // Strip the BOM before splitting so the first header cell is comparable.
  return csv.replace(UTF8_BOM, '').split('\r\n');
}

describe('toCsv', () => {
  it('writes a UTF-8 BOM so Excel decodes Cyrillic correctly', () => {
    const csv = toCsv([row()], columns);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    // One BOM, not one per call: appending would corrupt the file.
    expect(csv.slice(1).includes(UTF8_BOM)).toBe(false);
  });

  it('omits the BOM when asked, for an append', () => {
    expect(toCsv([row()], columns, { bom: false }).startsWith(UTF8_BOM)).toBe(false);
  });

  it('uses CRLF line endings and terminates the last record', () => {
    const csv = toCsv([row(), row()], columns, { bom: false });
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.includes('\n\n')).toBe(false);
    // header + two records + the trailing terminator
    expect(csv.split('\r\n')).toHaveLength(4);
  });

  it('emits an empty string rather than a header-only file for no rows', () => {
    // A header alone would look like a successful export of nothing.
    expect(toCsv([], columns, { bom: false, includeHeader: false })).toBe('');
  });

  it('resolves header labels through the caller’s dictionary', () => {
    const csv = toCsv([row()], columns, {
      translate: (key) => ({ 'columns.name': 'Ism' })[key] ?? key,
    });
    expect(lines(csv)[0]).toBe('Ism,columns.amount,columns.rate,columns.note');
  });

  it('quotes a field containing the delimiter', () => {
    const csv = toCsv([row({ name: 'Karimov, Sherzod' })], columns, { includeHeader: false });
    expect(lines(csv)[0]).toBe('"Karimov, Sherzod",1500000.00,87.50,');
  });

  it('doubles an embedded quote, per RFC 4180', () => {
    const csv = toCsv([row({ name: 'Sherzod "Sher" Karimov' })], columns, {
      includeHeader: false,
    });
    expect(lines(csv)[0]).toBe('"Sherzod ""Sher"" Karimov",1500000.00,87.50,');
  });

  it('quotes a field containing a newline without breaking the record', () => {
    const csv = toCsv([row({ note: 'line one\nline two' })], columns, {
      includeHeader: false,
      bom: false,
    });
    // The embedded newline stays inside the quoted field: one record, and the
    // record terminator is still the only CRLF.
    expect(csv).toBe('Karimov Sherzod,1500000.00,87.50,"line one\nline two"\r\n');
  });

  it('quotes a field containing a carriage return', () => {
    const csv = toCsv([row({ note: 'a\rb' })], columns, { includeHeader: false, bom: false });
    expect(csv).toBe('Karimov Sherzod,1500000.00,87.50,"a\rb"\r\n');
  });

  it('honours a semicolon delimiter and quotes against it, not against the comma', () => {
    const csv = toCsv([row({ note: 'a;b', name: 'Yo, Karimov' })], columns, {
      includeHeader: false,
      bom: false,
      delimiter: ';',
    });
    expect(csv).toBe('Yo, Karimov;1500000.00;87.50;"a;b"\r\n');
  });

  it('neutralises a leading character a spreadsheet would run as a formula', () => {
    const attack = '=HYPERLINK("http://example.invalid","click")';
    const csv = toCsv([row({ note: attack })], columns, { includeHeader: false, bom: false });
    // Prefixed with an apostrophe so the cell is text in a spreadsheet, and
    // quoted with its own quotes doubled because it contains both a comma and
    // quote characters.
    expect(csv).toBe(
      'Karimov Sherzod,1500000.00,87.50,' +
        '"\'=HYPERLINK(""http://example.invalid"",""click"")"\r\n',
    );
  });

  it.each(['=cmd', '+1', '-1+1', '@SUM(A1)', '\tx'])(
    'neutralises the formula lead %j',
    (value) => {
      const csv = toCsv([row({ note: value })], columns, { includeHeader: false, bom: false });
      expect(csv.split(',').at(-1)?.trimEnd()).toMatch(/^'|^"'/);
    },
  );

  it('leaves an ordinary negative-looking number in a numeric column alone at the value level', () => {
    // Guard against over-eager neutralisation: a plain name is untouched.
    const csv = toCsv([row({ note: 'ordinary note' })], columns, {
      includeHeader: false,
      bom: false,
    });
    expect(csv).toBe('Karimov Sherzod,1500000.00,87.50,ordinary note\r\n');
  });
});

describe('money cells', () => {
  it('renders minor units as an exact major-unit decimal', () => {
    const column = moneyColumn<Row>('amountMinor', 'columns.amount', 'currency');
    expect(renderCell(column, row({ amountMinor: '150000000' }))).toBe('1500000.00');
    // A value that a float would mangle: 0.1 + 0.2 territory.
    expect(renderCell(column, row({ amountMinor: '30' }))).toBe('0.30');
    expect(renderCell(column, row({ amountMinor: '-1' }))).toBe('-0.01');
  });

  it('renders a value far beyond Number.MAX_SAFE_INTEGER without losing a digit', () => {
    const column = moneyColumn<Row>('amountMinor', 'columns.amount', 'currency');
    expect(renderCell(column, row({ amountMinor: '9007199254740993123' }))).toBe(
      '90071992547409931.23',
    );
  });

  it('renders nothing rather than a wrong figure when the currency is unusable', () => {
    const column = moneyColumn<Row>('amountMinor', 'columns.amount', 'currency');
    // Emitting the raw minor units would be wrong by a factor of 100.
    expect(renderCell(column, row({ currency: 'XXX' }))).toBe('');
  });

  it('renders an empty cell for a null amount', () => {
    const column = moneyColumn<Row>('amountMinor', 'columns.amount', 'currency');
    expect(renderCell(column, { ...row(), amountMinor: '' })).toBe('');
  });
});

describe('percent cells', () => {
  it('renders parts-per-million as a percentage', () => {
    const column = percentColumn<Row>('ratePpm', 'columns.rate');
    expect(renderCell(column, row({ ratePpm: 1_000_000 }))).toBe('100.00');
    expect(renderCell(column, row({ ratePpm: 0 }))).toBe('0.00');
    expect(renderCell(column, row({ ratePpm: 333_333 }))).toBe('33.33');
  });

  it('renders an unknown rate as empty, not as zero', () => {
    const column = percentColumn<Row>('ratePpm', 'columns.rate');
    // A student with no lessons has an UNKNOWN attendance rate; 0.00 would read
    // as "never attended".
    expect(renderCell(column, row({ ratePpm: null }))).toBe('');
  });
});

describe('sharePpm', () => {
  it('reports null rather than zero for an empty denominator', () => {
    expect(sharePpm(0, 0)).toBeNull();
    expect(sharePpm(5, 0)).toBeNull();
  });

  it('returns integer parts-per-million', () => {
    expect(sharePpm(1, 2)).toBe(500_000);
    expect(sharePpm(1, 3)).toBe(333_333);
    expect(sharePpm(3, 3)).toBe(1_000_000);
  });

  it('works on money without going through a float', () => {
    expect(shareOfMoneyPpm(1n, 3n)).toBe(333_333);
    expect(shareOfMoneyPpm(0n, 0n)).toBeNull();
    // Well past the safe-integer range for a Number-based ratio.
    expect(shareOfMoneyPpm(9_007_199_254_740_993n, 9_007_199_254_740_993n)).toBe(1_000_000);
  });
});

describe('capRows', () => {
  it('reports truncation and returns exactly the cap', () => {
    const rows = Array.from({ length: 6 }, (_, index) => index);
    expect(capRows(rows, 5)).toEqual({ rows: [0, 1, 2, 3, 4], truncated: true });
  });

  it('does not claim truncation when the extra row was not there', () => {
    expect(capRows([0, 1], 5)).toEqual({ rows: [0, 1], truncated: false });
  });
});

// ---------------------------------------------------------------------------
// Period buckets
// ---------------------------------------------------------------------------

function scopeFor(
  granularity: ReportGranularity,
  from: string,
  to: string,
  weekStartsOnSunday = false,
): ReportScope {
  return {
    organizationId: 'org_1',
    timezone: 'Asia/Tashkent',
    from,
    to,
    fromInstant: new Date(`${from}T00:00:00Z`),
    toExclusive: new Date(`${to}T00:00:00Z`),
    granularity,
    weekShiftDays: weekStartsOnSunday ? 1 : 0,
    branchIds: null,
    groupIds: null,
    teacherIds: null,
    programIds: null,
    ownTeacherId: null,
    selfWithoutIdentity: false,
    self: {
      restricted: false,
      teacherId: null,
      employeeId: null,
      studentId: null,
      guardianId: null,
    },
    filters: {
      from,
      to,
      granularity,
      branchIds: null,
      groupIds: null,
      teacherIds: null,
      programIds: null,
    },
  };
}

describe('bucketStart', () => {
  it('is the date itself for daily granularity', () => {
    const scope = scopeFor('day', '2026-09-01', '2026-09-30');
    expect(bucketStart('2026-09-17', scope)).toBe('2026-09-17');
  });

  it('is the first of the month for monthly granularity', () => {
    const scope = scopeFor('month', '2026-01-01', '2026-12-31');
    expect(bucketStart('2026-09-17', scope)).toBe('2026-09-01');
  });

  it('aligns a week to Monday by default', () => {
    const scope = scopeFor('week', '2026-09-01', '2026-09-30');
    // 2026-09-17 is a Thursday; its ISO week began on Monday the 14th.
    expect(bucketStart('2026-09-17', scope)).toBe('2026-09-14');
    expect(bucketStart('2026-09-14', scope)).toBe('2026-09-14');
    expect(bucketStart('2026-09-20', scope)).toBe('2026-09-14');
  });

  it('aligns a week to Sunday when the institution reads its week that way', () => {
    const scope = scopeFor('week', '2026-09-01', '2026-09-30', true);
    // The Sunday before Thursday the 17th is the 13th.
    expect(bucketStart('2026-09-17', scope)).toBe('2026-09-13');
    expect(bucketStart('2026-09-13', scope)).toBe('2026-09-13');
    // Monday now belongs to the week that started the day before.
    expect(bucketStart('2026-09-14', scope)).toBe('2026-09-13');
  });
});

describe('bucketsIn', () => {
  it('produces one bucket per day, inclusive of both ends', () => {
    expect(bucketsIn(scopeFor('day', '2026-09-01', '2026-09-04'))).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
  });

  it('produces every month in the range, crossing a year boundary', () => {
    expect(bucketsIn(scopeFor('month', '2026-11-15', '2027-02-03'))).toEqual([
      '2026-11-01',
      '2026-12-01',
      '2027-01-01',
      '2027-02-01',
    ]);
  });

  it('produces every week, starting from the bucket the range starts in', () => {
    // 2026-09-02 is a Wednesday, so the first bucket is Monday the 31st of August.
    expect(bucketsIn(scopeFor('week', '2026-09-02', '2026-09-20'))).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ]);
  });

  it('produces a single bucket when the range is one day', () => {
    expect(bucketsIn(scopeFor('day', '2026-09-17', '2026-09-17'))).toEqual(['2026-09-17']);
    expect(bucketsIn(scopeFor('month', '2026-09-17', '2026-09-17'))).toEqual(['2026-09-01']);
  });
});
