/**
 * Validated server-side environment.
 *
 * Parsed once at module load so a misconfigured deployment fails at boot with a
 * precise message, rather than at 2am inside a payment handler. Importing this
 * module from client code is a build error by construction: it reads
 * `process.env` and is referenced only from `src/server/**`.
 *
 * Secrets live here and NOWHERE else. Nothing in this file may be re-exported
 * to the browser; values the client legitimately needs are exposed through
 * `src/lib/public-config.ts` with an explicit allow-list.
 */

import { z } from 'zod';

/** Rejects the placeholder values shipped in .env.example. */
const notPlaceholder = (value: string) =>
  !/^(change-?me|replace-?me|your-|xxx+|todo)/i.test(value.trim());

const secret = (minLength: number, label: string) =>
  z
    .string()
    .min(minLength, `${label} must be at least ${minLength} characters`)
    .refine(notPlaceholder, `${label} still holds a placeholder value from .env.example`);

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['true', '1', 'yes'].includes(value),
  );

const intFromString = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // --- database ---------------------------------------------------------
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
        message: 'DATABASE_URL must be a postgresql:// connection string',
      }),
    SHADOW_DATABASE_URL: z.string().optional(),
    DATABASE_POOL_MAX: intFromString(10, 1, 100),

    // --- application ------------------------------------------------------
    APP_URL: z.string().url('APP_URL must be an absolute URL, e.g. https://crm.example.uz'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // --- security ---------------------------------------------------------
    /** Signs and verifies the session cookie's integrity tag. */
    SESSION_SECRET: secret(32, 'SESSION_SECRET'),
    /** Encrypts data at rest that must be reversible (TOTP secrets). */
    ENCRYPTION_KEY: secret(32, 'ENCRYPTION_KEY'),
    SESSION_IDLE_TIMEOUT_MINUTES: intFromString(60 * 8, 5, 60 * 24 * 7),
    SESSION_ABSOLUTE_TIMEOUT_HOURS: intFromString(24 * 7, 1, 24 * 90),
    /** Consecutive failures before an account is temporarily locked. */
    LOGIN_MAX_ATTEMPTS: intFromString(8, 3, 50),
    LOGIN_LOCKOUT_MINUTES: intFromString(15, 1, 24 * 60),
    /** Trust X-Forwarded-For. Only enable behind a proxy you control. */
    TRUST_PROXY: booleanish.default(false),

    // --- pluggable drivers ------------------------------------------------
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('.storage'),
    STORAGE_MAX_UPLOAD_MB: intFromString(12, 1, 200),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    QUEUE_DRIVER: z.enum(['database', 'redis']).default('database'),
    RATE_LIMIT_DRIVER: z.enum(['database', 'memory', 'redis']).default('database'),
    REDIS_URL: z.string().optional(),

    FACE_RECOGNITION_PROVIDER: z.enum(['none', 'mock', 'aws-rekognition']).default('none'),
    AWS_REKOGNITION_COLLECTION_ID: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    /** Minimum match confidence, parts-per-million. 0.92 == 920000. */
    FACE_MATCH_MIN_CONFIDENCE_PPM: intFromString(920_000, 500_000, 1_000_000),

    EMAIL_PROVIDER: z.enum(['none', 'console', 'smtp', 'resend']).default('none'),
    EMAIL_FROM: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    SMS_PROVIDER: z.enum(['none', 'console', 'eskiz', 'playmobile', 'twilio']).default('none'),
    SMS_SENDER: z.string().optional(),
    ESKIZ_EMAIL: z.string().optional(),
    ESKIZ_PASSWORD: z.string().optional(),
    PLAYMOBILE_LOGIN: z.string().optional(),
    PLAYMOBILE_PASSWORD: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),

    TELEGRAM_PROVIDER: z.enum(['none', 'console', 'bot-api']).default('none'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),

    WHATSAPP_PROVIDER: z.enum(['none', 'console', 'cloud-api']).default('none'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),

    PAYMENT_PROVIDER: z.enum(['manual', 'payme', 'click', 'stripe']).default('manual'),
    PAYME_MERCHANT_ID: z.string().optional(),
    PAYME_SECRET_KEY: z.string().optional(),
    CLICK_MERCHANT_ID: z.string().optional(),
    CLICK_SECRET_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    /** Set by the worker/cron processes so jobs are attributable in the audit log. */
    WORKER_ID: z.string().optional(),
  })
  // Cross-field rules: a driver that is switched on must have its credentials.
  .superRefine((value, ctx) => {
    const require = (condition: boolean, keys: readonly string[], because: string) => {
      if (condition) return;
      ctx.addIssue({
        code: 'custom',
        path: [keys[0] ?? 'env'],
        message: `${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'} required ${because}`,
      });
    };

    if (value.STORAGE_DRIVER === 's3') {
      require(
        Boolean(value.S3_BUCKET && value.S3_REGION && value.S3_ACCESS_KEY_ID && value.S3_SECRET_ACCESS_KEY),
        ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
        'when STORAGE_DRIVER=s3',
      );
    }
    if (value.QUEUE_DRIVER === 'redis' || value.RATE_LIMIT_DRIVER === 'redis') {
      require(Boolean(value.REDIS_URL), ['REDIS_URL'], 'when a redis driver is selected');
    }
    if (value.FACE_RECOGNITION_PROVIDER === 'aws-rekognition') {
      require(
        Boolean(value.AWS_REGION && value.AWS_ACCESS_KEY_ID && value.AWS_SECRET_ACCESS_KEY && value.AWS_REKOGNITION_COLLECTION_ID),
        ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REKOGNITION_COLLECTION_ID'],
        'when FACE_RECOGNITION_PROVIDER=aws-rekognition',
      );
    }
    if (value.EMAIL_PROVIDER === 'smtp') {
      require(Boolean(value.SMTP_HOST && value.SMTP_PORT), ['SMTP_HOST', 'SMTP_PORT'], 'when EMAIL_PROVIDER=smtp');
    }
    if (value.EMAIL_PROVIDER === 'resend') {
      require(Boolean(value.RESEND_API_KEY), ['RESEND_API_KEY'], 'when EMAIL_PROVIDER=resend');
    }
    if (value.EMAIL_PROVIDER !== 'none' && value.EMAIL_PROVIDER !== 'console') {
      require(Boolean(value.EMAIL_FROM), ['EMAIL_FROM'], 'when a real email provider is configured');
    }
    if (value.SMS_PROVIDER === 'eskiz') {
      require(Boolean(value.ESKIZ_EMAIL && value.ESKIZ_PASSWORD), ['ESKIZ_EMAIL', 'ESKIZ_PASSWORD'], 'when SMS_PROVIDER=eskiz');
    }
    if (value.SMS_PROVIDER === 'playmobile') {
      require(
        Boolean(value.PLAYMOBILE_LOGIN && value.PLAYMOBILE_PASSWORD),
        ['PLAYMOBILE_LOGIN', 'PLAYMOBILE_PASSWORD'],
        'when SMS_PROVIDER=playmobile',
      );
    }
    if (value.SMS_PROVIDER === 'twilio') {
      require(
        Boolean(value.TWILIO_ACCOUNT_SID && value.TWILIO_AUTH_TOKEN),
        ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
        'when SMS_PROVIDER=twilio',
      );
    }
    if (value.TELEGRAM_PROVIDER === 'bot-api') {
      require(Boolean(value.TELEGRAM_BOT_TOKEN), ['TELEGRAM_BOT_TOKEN'], 'when TELEGRAM_PROVIDER=bot-api');
    }
    if (value.WHATSAPP_PROVIDER === 'cloud-api') {
      require(
        Boolean(value.WHATSAPP_PHONE_NUMBER_ID && value.WHATSAPP_ACCESS_TOKEN),
        ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
        'when WHATSAPP_PROVIDER=cloud-api',
      );
    }
    if (value.PAYMENT_PROVIDER === 'payme') {
      require(Boolean(value.PAYME_MERCHANT_ID && value.PAYME_SECRET_KEY), ['PAYME_MERCHANT_ID', 'PAYME_SECRET_KEY'], 'when PAYMENT_PROVIDER=payme');
    }
    if (value.PAYMENT_PROVIDER === 'click') {
      require(Boolean(value.CLICK_MERCHANT_ID && value.CLICK_SECRET_KEY), ['CLICK_MERCHANT_ID', 'CLICK_SECRET_KEY'], 'when PAYMENT_PROVIDER=click');
    }
    if (value.PAYMENT_PROVIDER === 'stripe') {
      require(Boolean(value.STRIPE_SECRET_KEY && value.STRIPE_WEBHOOK_SECRET), ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], 'when PAYMENT_PROVIDER=stripe');
    }

    // Production-only hardening.
    if (value.NODE_ENV === 'production') {
      require(value.APP_URL.startsWith('https://'), ['APP_URL'], 'and must use https in production');
      require(
        value.SESSION_SECRET !== value.ENCRYPTION_KEY,
        ['SESSION_SECRET'],
        'and must differ from ENCRYPTION_KEY',
      );
      require(
        value.FACE_RECOGNITION_PROVIDER !== 'mock',
        ['FACE_RECOGNITION_PROVIDER'],
        'and must not be "mock" in production -- the mock provider never performs real recognition',
      );
    }
  });

export type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  const result = schema.safeParse(process.env);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `  ${key}: ${issue.message}`;
  });
  throw new Error(
    `Invalid environment configuration:\n${lines.join('\n')}\n\n` +
      `See .env.example for what each variable does and where to obtain it.`,
  );
}

export const env: Env = parseEnv();

/** True when a given integration point has a working provider configured. */
export const integrationEnabled = {
  faceRecognition: env.FACE_RECOGNITION_PROVIDER !== 'none',
  /** The mock provider is functional for development but never performs real recognition. */
  faceRecognitionIsReal: !['none', 'mock'].includes(env.FACE_RECOGNITION_PROVIDER),
  email: env.EMAIL_PROVIDER !== 'none',
  sms: env.SMS_PROVIDER !== 'none',
  telegram: env.TELEGRAM_PROVIDER !== 'none',
  whatsapp: env.WHATSAPP_PROVIDER !== 'none',
  onlinePayments: env.PAYMENT_PROVIDER !== 'manual',
} as const;
