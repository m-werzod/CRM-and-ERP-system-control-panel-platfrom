/**
 * Twilio SMS over the REST API.
 *
 * Form-encoded, Basic-authenticated, one message per call. The interesting part
 * is the error mapping: Twilio's numeric codes are far more precise than the HTTP
 * status, and several distinct 400s mean very different things to a retry policy.
 * 21610 (the recipient has replied STOP) must never be retried -- re-sending to a
 * number that has opted out is both billable and, in several jurisdictions,
 * unlawful. 30xxx codes are carrier-side and worth another attempt.
 *
 * Cost: `price` is usually null in the creation response because Twilio prices
 * asynchronously, so `costMinor` is only populated when it happens to be present.
 * A zero would be a lie, so absent stays absent.
 */

import { env } from '@/server/env';
import { currencyExponent, isSupportedCurrency } from '@/lib/money';
import {
  basicAuth,
  logSendOutcome,
  numberField,
  parseJsonObject,
  providerFetch,
  statusFailure,
  stringField,
  transportFailure,
  type HttpOutcome,
  type JsonObject,
} from './http';
import { estimateSmsSegments } from './sms';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const TWILIO_PROVIDER_KEY = 'twilio';

const API_ROOT = 'https://api.twilio.com/2010-04-01';

/**
 * Twilio codes that are permanent no matter how often they are retried: an
 * unroutable or non-mobile number, an opted-out recipient, a blocked message.
 */
const PERMANENT_CODES = new Set([
  21211, // invalid 'To' number
  21212, // invalid 'From' number
  21214, // 'To' number not mobile
  21606, // 'From' number cannot send to this recipient
  21610, // recipient has unsubscribed (STOP)
  21611, // queue for this number is full
  21614, // 'To' number is not SMS-capable
  30003, // unreachable handset
  30004, // message blocked
  30005, // unknown destination handset
  30006, // landline or unreachable carrier
]);

export function createTwilioProvider(): MessageProvider {
  return {
    channel: 'SMS',
    key: TWILIO_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      const missing: string[] = [];
      if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
      if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN');
      if (!env.SMS_SENDER) missing.push('SMS_SENDER');
      if (missing.length > 0) {
        return { configured: false, message: `Twilio is missing ${missing.join(', ')}.` };
      }
      return { configured: true };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const sid = env.TWILIO_ACCOUNT_SID;
      const token = env.TWILIO_AUTH_TOKEN;
      const from = env.SMS_SENDER;

      if (!sid || !token || !from) {
        return {
          status: 'SKIPPED',
          reason: 'Twilio is missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or SMS_SENDER',
        };
      }

      // Twilio wants E.164 with the leading '+', unlike the Uzbek gateways.
      const to = message.to.trim();
      if (!/^\+[1-9]\d{6,14}$/.test(to)) {
        return {
          status: 'FAILED',
          errorCode: 'INVALID_RECIPIENT',
          errorMessage: 'Twilio requires an E.164 number such as +998901234512.',
          retryable: false,
        };
      }

      const outcome = await providerFetch({
        label: 'Twilio',
        // The account SID is in the path. It is an identifier, not the secret --
        // the auth token is -- but the URL is still never logged.
        url: `${API_ROOT}/Accounts/${encodeURIComponent(sid)}/Messages.json`,
        method: 'POST',
        headers: {
          authorization: basicAuth(sid, token),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: message.body }).toString(),
      });

      const result = interpret(outcome, message);
      logSendOutcome(TWILIO_PROVIDER_KEY, 'SMS', message.to, result);
      return result;
    },
  };
}

function interpret(outcome: HttpOutcome, message: OutboundMessage): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  const payload = parseJsonObject(outcome.body);

  if (outcome.status >= 200 && outcome.status < 300) {
    const price = readPrice(payload);
    return {
      status: 'SENT',
      providerRef: stringField(payload, 'sid'),
      segments: numberField(payload, 'num_segments') ?? estimateSmsSegments(message.body),
      costMinor: price?.amountMinor,
      currency: price?.currency,
    };
  }

  const code = numberField(payload, 'code');
  const detail = stringField(payload, 'message');

  return statusFailure(outcome.status, {
    errorCode: code === undefined ? `TWILIO_HTTP_${outcome.status}` : `TWILIO_${code}`,
    errorMessage: detail ?? `Twilio answered HTTP ${outcome.status}.`,
    retryable: code !== undefined && PERMANENT_CODES.has(code) ? false : undefined,
  });
}

/**
 * `price` arrives as a negative decimal string in `price_unit` ("-0.07500",
 * "USD") because it is a debit. Stored as a positive minor-unit amount, matching
 * the `money` convention, and only when the currency is one the platform knows --
 * an unrecognised code would otherwise be written into a VARCHAR(3) column that
 * reporting later tries to aggregate.
 */
function readPrice(payload: JsonObject | null): { amountMinor: bigint; currency: string } | null {
  const price = numberField(payload, 'price');
  const unit = stringField(payload, 'price_unit');
  if (price === undefined || unit === undefined) return null;

  const currency = unit.toUpperCase();
  if (!isSupportedCurrency(currency)) return null;

  const minor = Math.round(Math.abs(price) * 10 ** currencyExponent(currency));
  return { amountMinor: BigInt(minor), currency };
}
