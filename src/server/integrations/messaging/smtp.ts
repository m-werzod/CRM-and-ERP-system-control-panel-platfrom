/**
 * SMTP email -- NOT IMPLEMENTED, and cannot be from this codebase as it stands.
 *
 * SMTP is a stateful TCP conversation (EHLO, STARTTLS negotiation, AUTH, MAIL
 * FROM, RCPT TO, DATA, dot-stuffing, QUIT) plus MIME assembly for the HTML part.
 * `fetch` cannot speak it, and the one dependency that would -- nodemailer -- is
 * not installed. Writing a raw `node:net`/`node:tls` client here would be a
 * fortnight of subtle work (TLS verification, pipelining, 4xx-vs-5xx reply codes,
 * enhanced status codes, header injection defence) and the result would be worse
 * than the library.
 *
 * So this driver does not pretend. `health()` reports the missing dependency and
 * `send()` throws `IntegrationNotConfiguredError`. It reports rather than throws
 * on the health path on purpose: the settings screen has to be able to render the
 * state "EMAIL_PROVIDER=smtp, but this deployment cannot do SMTP" without the
 * page itself failing.
 *
 * To make SMTP work: install nodemailer, replace the body of `send` with a
 * transport built from SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD, and map
 * its errors onto `SendResult` -- a 4xx SMTP reply is retryable, a 5xx reply is a
 * hard bounce and is not. Until then, use `resend` or `console`.
 */

import { IntegrationNotConfiguredError } from '@/server/errors';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const SMTP_PROVIDER_KEY = 'smtp';

const UNAVAILABLE_MESSAGE =
  'SMTP email requires the nodemailer package, which is not installed in this deployment. ' +
  'Select the Resend provider, or install nodemailer and implement the SMTP transport.';

export function createSmtpProvider(): MessageProvider {
  return {
    channel: 'EMAIL',
    key: SMTP_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      return { configured: false, message: UNAVAILABLE_MESSAGE };
    },

    async send(_message: OutboundMessage): Promise<SendResult> {
      // Not a SendResult: FAILED would put the message back in a retry loop for a
      // condition no retry can fix, and SKIPPED would suggest an intentional
      // no-op. This is a deployment that is configured for something it cannot
      // do, which is exactly what this error class is for.
      throw new IntegrationNotConfiguredError('SMTP email', UNAVAILABLE_MESSAGE);
    },
  };
}
