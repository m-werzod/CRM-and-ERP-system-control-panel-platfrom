/**
 * Resend email over the HTTP API.
 *
 * Chosen as the real email driver because it is a single JSON POST, so it needs
 * no SDK and no SMTP client -- see `./smtp.ts` for why that matters here.
 *
 * Resend's failure taxonomy maps cleanly onto `retryable`: a 422 means the
 * address or the payload is wrong and will be wrong forever, a 403 means the
 * sending domain is not verified (an administrator's job, not a retry), while 429
 * and 5xx are rate and capacity problems that resolve on their own. Getting this
 * wrong in the retryable direction is expensive: Resend counts rejected attempts
 * against the quota.
 */

import { env } from '@/server/env';
import {
  logSendOutcome,
  objectField,
  parseJsonObject,
  providerFetch,
  statusFailure,
  stringField,
  transportFailure,
} from './http';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const RESEND_PROVIDER_KEY = 'resend';

const ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend rejects a request with neither `text` nor `html`, and a body-less
 * notification is a bug upstream rather than something to discover at the
 * gateway.
 */
function missingBody(message: OutboundMessage): boolean {
  return message.body.trim() === '' && (message.html ?? '').trim() === '';
}

export function createResendProvider(): MessageProvider {
  return {
    channel: 'EMAIL',
    key: RESEND_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      const missing: string[] = [];
      if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
      if (!env.EMAIL_FROM) missing.push('EMAIL_FROM');

      if (missing.length > 0) {
        return { configured: false, message: `Resend is missing ${missing.join(' and ')}.` };
      }
      return { configured: true };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const apiKey = env.RESEND_API_KEY;
      const from = env.EMAIL_FROM;
      if (!apiKey || !from) {
        return { status: 'SKIPPED', reason: 'Resend is missing RESEND_API_KEY or EMAIL_FROM' };
      }
      if (missingBody(message)) {
        return {
          status: 'FAILED',
          errorCode: 'EMPTY_BODY',
          errorMessage: 'The message has neither a text nor an HTML body.',
          retryable: false,
        };
      }

      const outcome = await providerFetch({
        label: 'Resend',
        url: ENDPOINT,
        method: 'POST',
        headers: {
          // Built inline and never logged; see the note in ./http.ts.
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject ?? '',
          text: message.body,
          html: message.html,
          // Resend echoes these back on its webhooks, which is how a delivery or
          // bounce event is matched to the notification that caused it.
          tags: toTags(message.metadata),
        }),
      });

      const result = interpret(outcome);
      logSendOutcome(RESEND_PROVIDER_KEY, 'EMAIL', message.to, result);
      return result;
    },
  };
}

/** Resend tags accept `[A-Za-z0-9_-]` only, so anything else is dropped. */
function toTags(
  metadata: Readonly<Record<string, string>> | undefined,
): readonly { name: string; value: string }[] | undefined {
  if (!metadata) return undefined;
  const tags = Object.entries(metadata)
    .map(([name, value]) => ({
      name: name.replace(/[^A-Za-z0-9_-]/g, '_'),
      value: value.replace(/[^A-Za-z0-9_-]/g, '_'),
    }))
    .filter((tag) => tag.name !== '' && tag.value !== '');
  return tags.length > 0 ? tags : undefined;
}

function interpret(outcome: Awaited<ReturnType<typeof providerFetch>>): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  const payload = parseJsonObject(outcome.body);

  if (outcome.status >= 200 && outcome.status < 300) {
    return { status: 'SENT', providerRef: stringField(payload, 'id') };
  }

  // Resend answers `{ "name": "validation_error", "message": "...", "statusCode": 422 }`,
  // and occasionally nests the same shape under `error`.
  const error = objectField(payload, 'error') ?? payload;
  const name = stringField(error, 'name');
  const detail = stringField(error, 'message');

  return statusFailure(outcome.status, {
    errorCode: name ?? `HTTP_${outcome.status}`,
    errorMessage: detail ?? `Resend answered HTTP ${outcome.status}.`,
    // 403 is an unverified sending domain or a revoked key: a person has to act,
    // so retrying only burns quota.
    retryable: outcome.status === 403 ? false : undefined,
  });
}
