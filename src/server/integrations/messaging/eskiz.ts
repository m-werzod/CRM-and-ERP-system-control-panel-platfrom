/**
 * Eskiz.uz SMS -- the usual gateway for an Uzbek institution.
 *
 * Two-step protocol: `POST /api/auth/login` exchanges the account email and
 * password for a bearer token, then `POST /api/message/sms/send` sends with it.
 * The token is valid for weeks, so logging in per message would be both slow and
 * a good way to get the account rate-limited; it is cached in the closure below.
 *
 * The cache is invalidated by a 401 rather than by trusting an expiry, because
 * Eskiz also invalidates tokens when the password is changed or the account is
 * touched in their panel. One re-login and one retry per send: if the second
 * attempt is also unauthorised, the credentials are wrong and that is a
 * configuration failure a retry cannot fix.
 *
 * Provider notes that are not obvious from the API:
 * - The phone must be digits with the country code and no `+` (`998901234512`).
 * - `from` must be a nickname Eskiz has approved for the account; the default
 *   `4546` is their shared test sender and only delivers pre-approved texts.
 * - Eskiz answers 200 with `status: "waiting"` -- accepted, not delivered. Real
 *   delivery arrives later on their callback, which is the outbox's concern.
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
  truncate,
  type HttpOutcome,
} from './http';
import { estimateSmsSegments, toMsisdn } from './sms';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const ESKIZ_PROVIDER_KEY = 'eskiz';

const BASE_URL = 'https://notify.eskiz.uz';
const LOGIN_PATH = '/api/auth/login';
const SEND_PATH = '/api/message/sms/send';

/**
 * Eskiz documents both endpoints as multipart form data. JSON is accepted by some
 * of their releases and not others, so the documented encoding is used.
 */
function formData(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

export function createEskizProvider(): MessageProvider {
  /**
   * Per-provider-instance, which is why `index.ts` memoises the provider: a new
   * instance per send would re-authenticate per send.
   */
  let cachedToken: string | null = null;

  async function login(): Promise<{ token: string } | SendResult> {
    const email = env.ESKIZ_EMAIL;
    const password = env.ESKIZ_PASSWORD;
    if (!email || !password) {
      return { status: 'SKIPPED', reason: 'Eskiz is missing ESKIZ_EMAIL or ESKIZ_PASSWORD' };
    }

    const outcome = await providerFetch({
      label: 'Eskiz (login)',
      url: `${BASE_URL}${LOGIN_PATH}`,
      method: 'POST',
      body: formData({ email, password }),
    });

    if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

    if (outcome.status === 401 || outcome.status === 400) {
      return {
        status: 'FAILED',
        errorCode: 'ESKIZ_BAD_CREDENTIALS',
        errorMessage: 'Eskiz rejected the configured account email or password.',
        // A wrong password is wrong on every attempt. Retrying would also walk
        // the account into Eskiz's own login throttle.
        retryable: false,
      };
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      return statusFailure(outcome.status, {
        errorCode: `ESKIZ_LOGIN_HTTP_${outcome.status}`,
        errorMessage: `Eskiz login answered HTTP ${outcome.status}.`,
      });
    }

    const payload = parseJsonObject(outcome.body);
    const token = stringField(objectField(payload, 'data'), 'token');
    if (!token) {
      return {
        status: 'FAILED',
        errorCode: 'ESKIZ_LOGIN_MALFORMED',
        errorMessage: 'Eskiz login succeeded but returned no token.',
        // The shape of their response changed, or a proxy rewrote it. Worth one
        // more attempt later rather than losing the message.
        retryable: true,
      };
    }

    cachedToken = token;
    return { token };
  }

  async function tokenOrFailure(): Promise<{ token: string } | SendResult> {
    if (cachedToken) return { token: cachedToken };
    return login();
  }

  async function post(token: string, message: OutboundMessage): Promise<HttpOutcome> {
    return providerFetch({
      label: 'Eskiz',
      url: `${BASE_URL}${SEND_PATH}`,
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: formData({
        mobile_phone: toMsisdn(message.to),
        message: message.body,
        // Their shared test sender. An account with an approved nickname sets
        // SMS_SENDER and delivers arbitrary text.
        from: env.SMS_SENDER ?? '4546',
      }),
    });
  }

  return {
    channel: 'SMS',
    key: ESKIZ_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      const missing: string[] = [];
      if (!env.ESKIZ_EMAIL) missing.push('ESKIZ_EMAIL');
      if (!env.ESKIZ_PASSWORD) missing.push('ESKIZ_PASSWORD');
      if (missing.length > 0) {
        return { configured: false, message: `Eskiz is missing ${missing.join(' and ')}.` };
      }
      return {
        configured: true,
        message: env.SMS_SENDER
          ? undefined
          : 'No SMS_SENDER is set, so the shared Eskiz test sender is used and only pre-approved texts are delivered.',
      };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const result = await attempt(message);
      logSendOutcome(ESKIZ_PROVIDER_KEY, 'SMS', message.to, result);
      return result;
    },
  };

  async function attempt(message: OutboundMessage): Promise<SendResult> {
    const phone = toMsisdn(message.to);
    // Eskiz would answer 400; rejecting locally keeps a malformed contact record
    // out of the retry queue and names the real problem.
    if (phone.length < 9) {
      return {
        status: 'FAILED',
        errorCode: 'INVALID_RECIPIENT',
        errorMessage: 'The recipient is not a usable phone number.',
        retryable: false,
      };
    }

    const first = await tokenOrFailure();
    if (!('token' in first)) return first;

    let outcome = await post(first.token, message);

    if (outcome.kind === 'RESPONSE' && outcome.status === 401) {
      // The cached token was revoked or expired. Exactly one re-login, so a
      // permanently bad credential cannot become an infinite loop.
      cachedToken = null;
      const renewed = await tokenOrFailure();
      if (!('token' in renewed)) return renewed;
      outcome = await post(renewed.token, message);
    }

    return interpret(outcome, message);
  }
}

function interpret(outcome: HttpOutcome, message: OutboundMessage): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  const payload = parseJsonObject(outcome.body);

  if (outcome.status >= 200 && outcome.status < 300) {
    const status = stringField(payload, 'status');
    // Eskiz returns 200 with an error status for a rejected text (an unapproved
    // sender nickname, a blocked keyword). A 200 alone is not a send.
    if (status !== undefined && status !== 'waiting' && status !== 'success') {
      return {
        status: 'FAILED',
        errorCode: `ESKIZ_${status.toUpperCase()}`,
        errorMessage: truncate(
          stringField(payload, 'message') ?? `Eskiz reported status "${status}".`,
        ),
        retryable: false,
      };
    }
    return {
      status: 'SENT',
      providerRef: stringField(payload, 'id'),
      segments: estimateSmsSegments(message.body),
    };
  }

  return statusFailure(outcome.status, {
    errorCode: `ESKIZ_HTTP_${outcome.status}`,
    errorMessage: stringField(payload, 'message') ?? `Eskiz answered HTTP ${outcome.status}.`,
  });
}
