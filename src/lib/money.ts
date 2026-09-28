/**
 * Money handling.
 *
 * Every monetary amount in this system is an integer count of MINOR UNITS
 * (tiyin for UZS, cents for USD/EUR) carried alongside an ISO-4217 currency
 * code. Floating point never touches money: `0.1 + 0.2 !== 0.3` is not an
 * acceptable property for an invoice balance.
 *
 * At the database boundary minor units are `BigInt`. At the HTTP boundary they
 * are decimal STRINGS, because JSON has no integer type wide enough to be safe
 * and `JSON.stringify` throws on BigInt. `serializeMoney` / `parseMoneyInput`
 * are the only sanctioned crossings.
 */

/** Currencies the platform knows how to format. Extend via settings, not code. */
export const SUPPORTED_CURRENCIES = ['UZS', 'USD', 'EUR', 'RUB', 'KZT', 'GBP'] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

interface CurrencyMeta {
  /** Number of decimal places the currency subdivides into. */
  readonly exponent: number;
  readonly symbol: string;
  readonly name: string;
}

/**
 * UZS has a nominal exponent of 2 but is quoted in whole som in practice. We
 * still store tiyin so a 3-way split of 1 000 som loses nothing, and simply
 * format with 0 decimals.
 */
const CURRENCY_META: Record<CurrencyCode, CurrencyMeta> = {
  UZS: { exponent: 2, symbol: "so'm", name: 'Uzbek som' },
  USD: { exponent: 2, symbol: '$', name: 'US dollar' },
  EUR: { exponent: 2, symbol: '€', name: 'Euro' },
  RUB: { exponent: 2, symbol: '₽', name: 'Russian rouble' },
  KZT: { exponent: 2, symbol: '₸', name: 'Kazakhstani tenge' },
  GBP: { exponent: 2, symbol: '£', name: 'Pound sterling' },
};

/** Display precision, which may be narrower than the stored exponent. */
const DISPLAY_FRACTION_DIGITS: Record<CurrencyCode, number> = {
  UZS: 0,
  USD: 2,
  EUR: 2,
  RUB: 2,
  KZT: 0,
  GBP: 2,
};

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: string): CurrencyCode {
  if (!isSupportedCurrency(value)) {
    throw new RangeError(`Unsupported currency code: ${value}`);
  }
  return value;
}

export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_META[currency].exponent;
}

export function currencySymbol(currency: CurrencyCode): string {
  return CURRENCY_META[currency].symbol;
}

/**
 * An amount and the currency it is denominated in. Kept as a plain object so it
 * survives a React server/client boundary; arithmetic lives in the functions
 * below rather than on a class.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: bigint | number, currency: string): Money {
  const minor = typeof amountMinor === 'bigint' ? amountMinor : BigInt(Math.trunc(amountMinor));
  if (typeof amountMinor === 'number' && !Number.isInteger(amountMinor)) {
    throw new TypeError(
      `money() takes minor units as an integer, received ${amountMinor}. Use parseMoneyInput for human input.`,
    );
  }
  return { amountMinor: minor, currency: assertCurrency(currency) };
}

export function zero(currency: string): Money {
  return { amountMinor: 0n, currency: assertCurrency(currency) };
}

function sameCurrency(a: Money, b: Money): CurrencyCode {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Refusing to combine ${a.currency} with ${b.currency}. Convert explicitly with a recorded exchange rate.`,
    );
  }
  return a.currency;
}

export function add(a: Money, b: Money): Money {
  return { amountMinor: a.amountMinor + b.amountMinor, currency: sameCurrency(a, b) };
}

export function subtract(a: Money, b: Money): Money {
  return { amountMinor: a.amountMinor - b.amountMinor, currency: sameCurrency(a, b) };
}

export function sum(items: readonly Money[], currency: string): Money {
  const code = assertCurrency(currency);
  let total = 0n;
  for (const item of items) {
    if (item.currency !== code) {
      throw new TypeError(`sum() received ${item.currency} while accumulating ${code}.`);
    }
    total += item.amountMinor;
  }
  return { amountMinor: total, currency: code };
}

export function negate(value: Money): Money {
  return { amountMinor: -value.amountMinor, currency: value.currency };
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0n;
}

export function isNegative(value: Money): boolean {
  return value.amountMinor < 0n;
}

export function isPositive(value: Money): boolean {
  return value.amountMinor > 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

/** Clamps a negative amount to zero. Used for balances that must not go below 0. */
export function clampAtZero(value: Money): Money {
  return value.amountMinor < 0n ? zero(value.currency) : value;
}

// ---------------------------------------------------------------------------
// Percentages
//
// Rates are integer PARTS PER MILLION: 10% == 100_000 ppm, 12.5% == 125_000 ppm.
// This keeps a percentage exact and lets it round-trip through JSON as a plain
// number.
// ---------------------------------------------------------------------------

export const PPM_SCALE = 1_000_000n;

export function percentToPpm(percent: number): number {
  const ppm = Math.round(percent * 10_000);
  if (!Number.isFinite(ppm)) throw new RangeError(`Invalid percentage: ${percent}`);
  return ppm;
}

export function ppmToPercent(ppm: number): number {
  return ppm / 10_000;
}

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

/**
 * Divide two bigints with an explicit rounding mode. Integer division in JS
 * truncates toward zero, which silently loses money on every discount, so every
 * rounding decision in this codebase is made here and named.
 */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let rounded: bigint;
  switch (mode) {
    case 'down':
      rounded = quotient;
      break;
    case 'up':
      rounded = quotient + 1n;
      break;
    case 'half-up':
      rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
      break;
    case 'half-even': {
      const twice = remainder * 2n;
      if (twice > absDen) rounded = quotient + 1n;
      else if (twice < absDen) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }
  return negative ? -rounded : rounded;
}

/**
 * Apply a ppm rate to an amount. Default rounding is half-up, which is what
 * invoices and tax lines are expected to do.
 */
export function applyPpm(value: Money, ppm: number, mode: RoundingMode = 'half-up'): Money {
  if (!Number.isInteger(ppm)) throw new TypeError(`ppm must be an integer, received ${ppm}`);
  return {
    amountMinor: divideRounded(value.amountMinor * BigInt(ppm), PPM_SCALE, mode),
    currency: value.currency,
  };
}

/** What fraction, in ppm, `part` is of `whole`. Returns 0 when `whole` is 0. */
export function ratioPpm(part: Money, whole: Money): number {
  sameCurrency(part, whole);
  if (whole.amountMinor === 0n) return 0;
  return Number(divideRounded(part.amountMinor * PPM_SCALE, whole.amountMinor, 'half-up'));
}

/**
 * Split an amount into `parts` shares that sum EXACTLY back to the original.
 * The remainder is distributed one minor unit at a time across the leading
 * shares, so splitting 100 into 3 gives 34/33/33 and never loses a tiyin.
 */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`parts must be a positive integer, received ${parts}`);
  }
  const count = BigInt(parts);
  const base = value.amountMinor / count;
  let remainder = value.amountMinor - base * count;
  const step = remainder < 0n ? -1n : 1n;

  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder !== 0n) {
      share += step;
      remainder -= step;
    }
    return { amountMinor: share, currency: value.currency };
  });
}

/**
 * Split by integer weights, preserving the exact total. Used to spread a
 * payment or a discount across invoice lines proportionally.
 */
export function allocateByWeights(value: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new RangeError('weights must be non-negative integers');
  }
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);
  if (totalWeight === 0) return allocate(value, weights.length);

  const shares: bigint[] = [];
  let allocated = 0n;
  for (const weight of weights) {
    const share = divideRounded(value.amountMinor * BigInt(weight), BigInt(totalWeight), 'down');
    shares.push(share);
    allocated += share;
  }

  // Hand the truncation remainder to the heaviest weights first.
  let remainder = value.amountMinor - allocated;
  const step = remainder < 0n ? -1n : 1n;
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  let cursor = 0;
  while (remainder !== 0n && order.length > 0) {
    const target = order[cursor % order.length]!;
    shares[target.index] = shares[target.index]! + step;
    remainder -= step;
    cursor += 1;
  }

  return shares.map((amountMinor) => ({ amountMinor, currency: value.currency }));
}

// ---------------------------------------------------------------------------
// Boundaries: database (BigInt), HTTP (string), human input (decimal text)
// ---------------------------------------------------------------------------

/** Shape money takes on the wire. Amount is a decimal string in MAJOR units. */
export interface SerializedMoney {
  /** Minor units as a base-10 string, e.g. "150000000". Lossless. */
  readonly amountMinor: string;
  readonly currency: CurrencyCode;
  /** Major-unit decimal string for display, e.g. "1500000.00". */
  readonly amount: string;
  /** Locale-independent pre-formatted label, e.g. "1 500 000 so'm". */
  readonly formatted: string;
}

export function serializeMoney(value: Money): SerializedMoney {
  return {
    amountMinor: value.amountMinor.toString(),
    currency: value.currency,
    amount: toMajorString(value),
    formatted: formatMoney(value),
  };
}

export function deserializeMoney(value: SerializedMoney | { amountMinor: string; currency: string }): Money {
  return { amountMinor: BigInt(value.amountMinor), currency: assertCurrency(value.currency) };
}

/** Exact major-unit decimal representation, e.g. 150000000n UZS -> "1500000.00". */
export function toMajorString(value: Money): string {
  const exponent = currencyExponent(value.currency);
  if (exponent === 0) return value.amountMinor.toString();

  const negative = value.amountMinor < 0n;
  const abs = (negative ? -value.amountMinor : value.amountMinor).toString().padStart(exponent + 1, '0');
  const whole = abs.slice(0, abs.length - exponent);
  const fraction = abs.slice(abs.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Parse human or API input into minor units WITHOUT going through a float.
 * Accepts "1500000", "1 500 000", "1,500,000.50", "1500000.5", 1500000.
 * Rejects anything else rather than guessing.
 */
export function parseMoneyInput(input: string | number, currency: string): Money {
  const code = assertCurrency(currency);
  const exponent = currencyExponent(code);

  const text = typeof input === 'number' ? formatNumberExactly(input) : input.trim();
  if (text === '') throw new RangeError('Amount is required');

  // Strip thousands separators (space, NBSP, apostrophe, comma used as a group
  // separator) but keep a single decimal point.
  const normalised = text
    .replace(/[\s  ']/g, '')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(/,/g, '.');

  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(normalised);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new RangeError(`Not a valid amount: ${input}`);
  }

  const [, sign, wholeRaw, fractionRaw = ''] = match;
  if (fractionRaw.length > exponent) {
    throw new RangeError(
      `${code} supports at most ${exponent} decimal place(s); received "${input}".`,
    );
  }

  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const fraction = fractionRaw.padEnd(exponent, '0');
  const amountMinor = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n);
  return { amountMinor, currency: code };
}

/** Render a JS number without exponent notation so parsing stays exact. */
function formatNumberExactly(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a valid amount: ${value}`);
  if (Number.isInteger(value)) return value.toFixed(0);
  // toFixed(10) then trim: enough precision for any supported currency and it
  // avoids "1e-7" style output reaching the parser.
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Human-readable amount. Uses Intl when a locale is given, otherwise a stable
 * space-grouped form so server-rendered output does not depend on the host's
 * ICU data.
 */
export function formatMoney(
  value: Money,
  options: { locale?: string; withSymbol?: boolean } = {},
): string {
  const { locale, withSymbol = true } = options;
  const digits = DISPLAY_FRACTION_DIGITS[value.currency];

  if (locale) {
    try {
      return new Intl.NumberFormat(locale, {
        style: withSymbol ? 'currency' : 'decimal',
        currency: value.currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(Number(toMajorString(value)));
    } catch {
      // Fall through to the deterministic representation below.
    }
  }

  const major = toMajorString(value);
  const negative = major.startsWith('-');
  const unsigned = negative ? major.slice(1) : major;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');
  const grouped = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const shown = digits > 0 ? `${grouped}.${fractionPart.slice(0, digits).padEnd(digits, '0')}` : grouped;
  const body = `${negative ? '-' : ''}${shown}`;
  return withSymbol ? `${body} ${currencySymbol(value.currency)}` : body;
}
