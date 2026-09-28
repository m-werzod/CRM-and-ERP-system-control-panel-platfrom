/**
 * Test environment bootstrap.
 *
 * Loads .env so integration tests reach the development cluster, then fills in
 * anything src/server/env.ts insists on. The secrets here are deliberately
 * obvious test values -- env.ts rejects placeholders that start with "change-me"
 * or "your-", so they are named as test fixtures instead.
 */

import { config } from 'dotenv';

config({ quiet: true });

// `NODE_ENV` is declared read-only by @types/node, but Vitest does not always set
// it before setup files run and src/server/env.ts requires a valid value.
// Writing through the index signature is the sanctioned escape.
(process.env as Record<string, string | undefined>).NODE_ENV ??= 'test';

process.env.APP_URL ??= 'http://localhost:3000';
process.env.SESSION_SECRET ??= 'test-session-secret-0123456789abcdef0123456789abcdef';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-fedcba9876543210fedcba9876543210';
process.env.LOG_LEVEL ??= 'error';

// Every integration point stays off unless a test switches it on, so a test can
// never accidentally send a real SMS or call a paid API.
process.env.STORAGE_DRIVER ??= 'local';
process.env.QUEUE_DRIVER ??= 'database';
process.env.RATE_LIMIT_DRIVER ??= 'memory';
process.env.FACE_RECOGNITION_PROVIDER ??= 'mock';
process.env.EMAIL_PROVIDER ??= 'none';
process.env.SMS_PROVIDER ??= 'none';
process.env.TELEGRAM_PROVIDER ??= 'none';
process.env.WHATSAPP_PROVIDER ??= 'none';
process.env.PAYMENT_PROVIDER ??= 'manual';
