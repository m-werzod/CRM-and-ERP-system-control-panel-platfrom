/**
 * WhatsApp through the Meta Cloud API.
 *
 * The constraint that shapes everything here is the 24-hour customer service
 * window: a free-form text message is only permitted within 24 hours of the
 * recipient's last message to the business. Outside it Meta requires a
 * pre-approved template, and a plain text send is rejected with 131047. Since an
 * absence alert or a payment reminder is almost always outside that window, this
 * driver is honest about its scope -- it sends free-form text, and reports the
 * template requirement as a permanent failure rather than retrying it forever.
 * Template sends need a per-organisation template catalogue, which belongs with
 * the notification templates, not in a transport driver.
 *
 * The recipient is a phone number in international digits without `+`.
 */

import { env } from '@/server/env';
import {
  firstArrayObject,
  logSendOutcome,
  numberField,
  objectField,
  parseJsonObject,
  providerFetch,
  statusFailure,
  stringField,
  transportFailure,
  type HttpOutcome,
} from './http';
import { toMsisdn } from './sms';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const WHATSAPP_PROVIDER_KEY = 'whatsapp-cloud-api';

const GRAPH_ROOT = 'https://graph.facebook.com';

/**
 * Pinned rather than tracking "latest": Meta deprecates versions on a schedule
 * and an unpinned call changes behaviour under a deployment that did not ship.
 */
const API_VERSION = 'v21.0';

/**
 * Meta codes that no retry can resolve: the window has closed and a template is
 * required, the number is not on WhatsApp, or the recipient blocked the business.
 */
const PERMANENT_CODES = new Set([
  131047, // re-engagement required: outside the 24h window
  131026, // message undeliverable (recipient not on WhatsApp / incapable)
  131051, // unsupported message type
  131052, // media download error
  132000, // template parameter count mismatch
  470, // legacy re-engagement error
]);

export function createWhatsAppProvider(): MessageProvider {
  return {
    channel: 'WHATSAPP',
    key: WHATSAPP_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      const missing: string[] = [];
      if (!env.WHATSAPP_PHONE_NUMBER_ID) missing.push('WHATSAPP_PHONE_NUMBER_ID');
      if (!env.WHATSAPP_ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
      if (missing.length > 0) {
        return { configured: false, message: `WhatsApp is missing ${missing.join(' and ')}.` };
      }
      return {
        configured: true,
        message:
          'Free-form text only: outside the 24-hour customer service window WhatsApp requires an approved message template.',
      };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
      const accessToken = env.WHATSAPP_ACCESS_TOKEN;

      if (!phoneNumberId || !accessToken) {
        return {
          status: 'SKIPPED',
          reason: 'WhatsApp is missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN',
        };
      }

      const to = toMsisdn(message.to);
      if (to.length < 9) {
        return {
          status: 'FAILED',
          errorCode: 'INVALID_RECIPIENT',
          errorMessage: 'The recipient is not a usable phone number.',
          retryable: false,
        };
      }

      const outcome = await providerFetch({
        label: 'WhatsApp',
        url: `${GRAPH_ROOT}/${API_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          // Link previews are disabled because a rendered card of a payment link
          // in a parent's chat list leaks the invoice to anyone glancing at it.
          text: { preview_url: false, body: message.body },
        }),
      });

      const result = interpret(outcome);
      logSendOutcome(WHATSAPP_PROVIDER_KEY, 'WHATSAPP', message.to, result);
      return result;
    },
  };
}

function interpret(outcome: HttpOutcome): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  const payload = parseJsonObject(outcome.body);

  if (outcome.status >= 200 && outcome.status < 300) {
    // `messages[0].id` is the wamid, which is also what delivery and read
    // webhooks quote.
    return {
      status: 'SENT',
      providerRef: stringField(firstArrayObject(payload, 'messages'), 'id'),
    };
  }

  const error = objectField(payload, 'error');
  const code = numberField(error, 'code');
  const subcode = numberField(error, 'error_subcode');
  const detail =
    stringField(objectField(error, 'error_data'), 'details') ?? stringField(error, 'message');

  return statusFailure(outcome.status, {
    errorCode: code === undefined ? `WHATSAPP_HTTP_${outcome.status}` : `WHATSAPP_${code}`,
    errorMessage: detail ?? `WhatsApp answered HTTP ${outcome.status}.`,
    retryable: classify(code, subcode),
  });
}

/** `undefined` leaves the decision to the HTTP status. */
function classify(code: number | undefined, subcode: number | undefined): boolean | undefined {
  if (code !== undefined && PERMANENT_CODES.has(code)) return false;
  if (subcode !== undefined && PERMANENT_CODES.has(subcode)) return false;
  // Meta's own throttles arrive as a 400, so the status alone would wrongly mark
  // them permanent and drop the message.
  if (code === 4 || code === 80_007 || code === 130_429) return true;
  return undefined;
}
