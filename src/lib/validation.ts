/**
 * Shared Zod schemas.
 *
 * Every API route and every form validates against schemas built from these
 * primitives, so "what is a valid phone number" has exactly one answer on the
 * client and the server. Client-side validation is for feedback; the server
 * re-validates the same shape because client input is never trusted.
 */

import { z } from 'zod';
import { isDateOnly } from '@/lib/dates';
import { SUPPORTED_CURRENCIES, parseMoneyInput } from '@/lib/money';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** A cuid produced by Prisma's `@default(cuid())`. */
export const cuidSchema = z
  .string()
  .trim()
  .min(20, 'Not a valid id')
  .max(40, 'Not a valid id')
  .regex(/^[a-z0-9]+$/i, 'Not a valid id');

/** Human-entered codes: student codes, branch codes, invoice numbers. */
export const codeSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(40, 'Must be 40 characters or fewer')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Use letters, digits, dot, dash, slash or underscore');

// ---------------------------------------------------------------------------
// Names and free text
// ---------------------------------------------------------------------------

/**
 * Person names. Allows Latin and Cyrillic letters, apostrophes (O'Rahmonov),
 * hyphens and spaces -- an English-letters-only rule would reject most real
 * Uzbek and Russian names.
 */
export const personNameSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(80, 'Must be 80 characters or fewer')
  .regex(
    /^[\p{L}\p{M}][\p{L}\p{M}\s'’.-]*$/u,
    'Use letters, spaces, apostrophes, dots or hyphens',
  );

export const optionalPersonNameSchema = z
  .union([personNameSchema, z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/** Short free text: titles, subjects, labels. */
export const shortTextSchema = (max = 160) => z.string().trim().min(1, 'Required').max(max);

/** Long free text: notes, descriptions, reasons. Empty collapses to null. */
export const longTextSchema = (max = 4000) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${max} characters or fewer`)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** A mandatory human explanation, required for corrections and adjustments. */
export const reasonSchema = z
  .string()
  .trim()
  .min(5, 'Please give a reason of at least 5 characters')
  .max(1000, 'Must be 1000 characters or fewer');

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

/**
 * Normalise a phone number to E.164-ish digits with a leading `+`.
 *
 * Deliberately permissive about input formatting (spaces, dashes, parentheses,
 * a leading `00`) and strict about output, because the normalised form is what
 * duplicate detection and search compare. Uzbek numbers entered as 9 local
 * digits or with a leading 0 are expanded to +998.
 */
export function normalizePhone(input: string, defaultCountryCode = '998'): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits === '') return null;

  let value = digits.startsWith('+') ? digits.slice(1) : digits;
  if (value.startsWith('00')) value = value.slice(2);

  // Local Uzbek forms: "901234567" (9 digits) or "0901234567".
  if (value.length === 9 && !value.startsWith(defaultCountryCode)) {
    value = defaultCountryCode + value;
  } else if (value.length === 10 && value.startsWith('0')) {
    value = defaultCountryCode + value.slice(1);
  }

  if (value.length < 8 || value.length > 15) return null;
  if (!/^\d+$/.test(value)) return null;
  return `+${value}`;
}

export const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Required')
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid phone number' });
      return z.NEVER;
    }
    return normalized;
  });

export const optionalPhoneSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === '') return null;
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid phone number' });
      return z.NEVER;
    }
    return normalized;
  })
  .nullable()
  .optional();

/** Lower-cased and trimmed, because email comparison must be case-insensitive. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Required')
  .max(254, 'Must be 254 characters or fewer')
  .email('Not a valid email address');

export const optionalEmailSchema = z
  .union([emailSchema, z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** A calendar date as "YYYY-MM-DD". */
export const dateOnlySchema = z
  .string()
  .trim()
  .refine(isDateOnly, 'Use the format YYYY-MM-DD');

export const optionalDateOnlySchema = z
  .union([dateOnlySchema, z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/** An instant, accepted as ISO-8601 and returned as a Date. */
export const instantSchema = z
  .string()
  .trim()
  .datetime({ offset: true, message: 'Use an ISO-8601 timestamp' })
  .transform((value) => new Date(value));

export const optionalInstantSchema = z
  .union([instantSchema, z.literal('')])
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/** A date of birth: a real past date, and a plausible human age. */
export const dateOfBirthSchema = dateOnlySchema.superRefine((value, ctx) => {
  const date = new Date(`${value}T00:00:00Z`);
  const now = new Date();
  if (date > now) {
    ctx.addIssue({ code: 'custom', message: 'Date of birth cannot be in the future' });
  }
  const years = (now.getTime() - date.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (years > 120) {
    ctx.addIssue({ code: 'custom', message: 'Date of birth is implausibly far in the past' });
  }
});

/** A `[from, to]` calendar range where `to` is not before `from`. */
export const dateRangeSchema = z
  .object({ from: dateOnlySchema, to: dateOnlySchema })
  .refine((v) => v.to >= v.from, {
    message: 'The end date cannot be before the start date',
    path: ['to'],
  });

// ---------------------------------------------------------------------------
// Money and percentages
// ---------------------------------------------------------------------------

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/**
 * Human money input ("1 500 000", "1500000.50") validated into minor units.
 * Returns a string so the value survives JSON; `BigInt` is reconstituted at the
 * service boundary. Never a float.
 */
export const moneyInputSchema = (currencyKey = 'currency') =>
  z
    .object({
      amount: z.union([z.string(), z.number()]),
      currency: currencySchema,
    })
    .transform((value, ctx) => {
      try {
        const parsed = parseMoneyInput(value.amount, value.currency);
        if (parsed.amountMinor < 0n) {
          ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Amount cannot be negative' });
          return z.NEVER;
        }
        return { amountMinor: parsed.amountMinor.toString(), currency: parsed.currency };
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          message: error instanceof Error ? error.message : 'Not a valid amount',
        });
        return z.NEVER;
      }
    })
    .describe(`money amount with ${currencyKey}`);

/** Minor units supplied directly as a digit string (internal / API-to-API). */
export const minorUnitsSchema = z
  .union([z.string().regex(/^\d{1,19}$/, 'Must be a whole number of minor units'), z.number().int().nonnegative()])
  .transform((value) => BigInt(value));

/** A percentage entered as a human number (12.5) stored as ppm (125000). */
export const percentSchema = z
  .number()
  .min(0, 'Cannot be negative')
  .max(100, 'Cannot exceed 100%')
  .transform((value) => Math.round(value * 10_000));

export const ppmSchema = z.number().int().min(0).max(1_000_000);

// ---------------------------------------------------------------------------
// Pagination, sorting, filtering
// ---------------------------------------------------------------------------

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

/**
 * Offset pagination for screens with page numbers. `limit` is capped so a client
 * cannot ask for 10 000 students and exhaust the server's memory.
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Cursor pagination for large append-only lists (audit log, attendance history,
 * ledger) where OFFSET would get slower the deeper you scroll.
 */
export const cursorPaginationSchema = z.object({
  cursor: cuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');

/**
 * Sort input restricted to an explicit allow-list. Taking a raw column name from
 * the client and passing it to `orderBy` lets a caller sort by `passwordHash`
 * and learn things from the ordering, so the allow-list is mandatory.
 */
export function sortSchema<T extends readonly [string, ...string[]]>(fields: T, fallback: T[number]) {
  return z.object({
    sortBy: z.enum(fields).default(fallback as T[number]),
    sortDir: sortDirectionSchema,
  });
}

/** Free-text search term. Trimmed, length-capped, empty collapses to undefined. */
export const searchTermSchema = z
  .string()
  .trim()
  .max(100)
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/** Comma-separated list of ids from a query string, e.g. `?branchIds=a,b,c`. */
export const idListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => {
    const raw = Array.isArray(value) ? value : value.split(',');
    return raw.map((v) => v.trim()).filter((v) => v.length > 0);
  })
  .pipe(z.array(cuidSchema).max(200, 'Too many ids'));

/** Filters shared by nearly every list endpoint. */
export const commonListFiltersSchema = z.object({
  q: searchTermSchema,
  branchId: cuidSchema.optional(),
  from: optionalDateOnlySchema,
  to: optionalDateOnlySchema,
  includeArchived: z.coerce.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Password policy. Length is weighted far above character classes because
 * length is what actually resists guessing; the class requirement is kept modest
 * so it does not push people toward "Password1!".
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(256, 'Must be 256 characters or fewer')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Include both upper and lower case letters')
  .refine((v) => /\d/.test(v) || /[^A-Za-z0-9]/.test(v), 'Include a digit or a symbol')
  .refine((v) => !/^(.)\1+$/.test(v), 'Do not use a single repeated character');

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Required').max(254),
  password: z.string().min(1, 'Required').max(256),
  /** 6-digit TOTP code, supplied on the second step when 2FA is enabled. */
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code')
    .optional(),
  rememberMe: z.coerce.boolean().default(false),
});

/**
 * A TOTP code on its own, for the second step of a two-factor sign-in. Distinct
 * from `loginSchema.totpCode`: by this point the password has already been
 * proved and the caller carries a partial session, so there is nothing else to
 * send.
 */
export const twoFactorCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Required'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Required'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'The passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });

// ---------------------------------------------------------------------------
// File uploads
// ---------------------------------------------------------------------------

/**
 * Accepted upload types, as an allow-list. Anything not listed is rejected --
 * a deny-list would let the next novel executable container through.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
} as const satisfies Record<string, readonly string[]>;

export type AllowedMimeType = keyof typeof ALLOWED_UPLOAD_MIME_TYPES;

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return value in ALLOWED_UPLOAD_MIME_TYPES;
}

/**
 * Strip every path component and dangerous character from a client-supplied
 * filename. The result is used for DISPLAY and download only -- the storage key
 * is always generated server-side, so a crafted name cannot escape the store.
 */
export function sanitizeFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    // Control characters and characters Windows forbids.
    .replace(/[ -<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 200) || 'file';
}

export function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index === -1 ? '' : fileName.slice(index).toLowerCase();
}

/**
 * Validate an upload's declared type against its extension. A mismatch means the
 * client is confused or lying; either way it is rejected. Magic-byte sniffing
 * happens in the storage service, which is the only place that sees the bytes.
 */
export const uploadMetadataSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    if (!isAllowedMimeType(value.mimeType)) {
      ctx.addIssue({ code: 'custom', path: ['mimeType'], message: 'This file type is not accepted' });
      return;
    }
    const allowedExtensions: readonly string[] = ALLOWED_UPLOAD_MIME_TYPES[value.mimeType];
    const extension = fileExtension(sanitizeFileName(value.fileName));
    if (!allowedExtensions.includes(extension)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fileName'],
        message: `A ${value.mimeType} file should end in ${allowedExtensions.join(' or ')}`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Zod -> AppError bridge
// ---------------------------------------------------------------------------

/** Flatten a ZodError into the FieldIssue shape the API envelope uses. */
export function toFieldIssues(error: z.ZodError): Array<{ path: string; message: string; code?: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '_root',
    message: issue.message,
    code: issue.code,
  }));
}
