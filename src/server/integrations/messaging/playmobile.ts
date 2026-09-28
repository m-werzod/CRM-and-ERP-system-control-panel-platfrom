/**
 * Play Mobile UZ SMS broker.
 *
 * A single Basic-authenticated JSON POST carrying an envelope of messages. Only
 * one message per call is sent here on purpose: the broker reports errors for the
 * batch rather than per message, so a batch of fifty would leave forty-nine
 * recipients in an unknown state after one bad number.
 *
 * Provider notes that are not obvious from the API:
 * - The recipient is digits with the country code and no `+`.
 * - `message-id` is ours to choose and must be unique per message; the broker
 *   uses it for its delivery reports, and a duplicate silently collides with an
 *   older send. It is generated here and returned as the `providerRef`, because
 *   the broker's success answer carries no id of its own.
 * - `originator` is the approved sender name, which Play Mobile provisions per
 *   contract. Without SMS_SENDER there is nothing valid to send.
 */

import { randomUUID } from 'node:crypto';
import { env } from '@/server/env';
import {
  basicAuth,
  logSendOutcome,
  parseJsonObject,
  providerFetch,
  statusFailure,
  stringField,
  transportFailure,
  type HttpOutcome,
} from './http';
import { estimateSmsSegments, toMsisdn } from './sms';
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const PLAYMOBILE_PROVIDER_KEY = 'playmobile';

const ENDPOINT = 'https://send.smsxabar.uz/broker-api/send';

/** The broker rejects an id longer than this. */
const MAX_MESSAGE_ID_CHARS = 20;

function newMessageId(): string {
  return randomUUID().replace(/-/g, '').slice(0, MAX_MESSAGE_ID_CHARS);
}

export function createPlayMobileProvider(): MessageProvider {
  return {
    channel: 'SMS',
    key: PLAYMOBILE_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      const missing: string[] = [];
      if (!env.PLAYMOBILE_LOGIN) missing.push('PLAYMOBILE_LOGIN');
      if (!env.PLAYMOBILE_PASSWORD) missing.push('PLAYMOBILE_PASSWORD');
      if (!env.SMS_SENDER) missing.push('SMS_SENDER');
      if (missing.length > 0) {
        return { configured: false, message: `Play Mobile is missing ${missing.join(', ')}.` };
      }
      return { configured: true };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const login = env.PLAYMOBILE_LOGIN;
      const password = env.PLAYMOBILE_PASSWORD;
      const originator = env.SMS_SENDER;

      if (!login || !password || !originator) {
        return {
          status: 'SKIPPED',
          reason: 'Play Mobile is missing PLAYMOBILE_LOGIN, PLAYMOBILE_PASSWORD or SMS_SENDER',
        };
      }

      const recipient = toMsisdn(message.to);
      if (recipient.length < 9) {
        return {
          status: 'FAILED',
          errorCode: 'INVALID_RECIPIENT',
          errorMessage: 'The recipient is not a usable phone number.',
          retryable: false,
        };
      }

      const messageId = newMessageId();

      const outcome = await providerFetch({
        label: 'Play Mobile',
        url: ENDPOINT,
        method: 'POST',
        headers: {
          authorization: basicAuth(login, password),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              recipient,
              'message-id': messageId,
              sms: { originator, content: { text: message.body } },
            },
          ],
        }),
      });

      const result = interpret(outcome, messageId, message);
      logSendOutcome(PLAYMOBILE_PROVIDER_KEY, 'SMS', message.to, result);
      return result;
    },
  };
}

function interpret(
  outcome: HttpOutcome,
  messageId: string,
  message: OutboundMessage,
): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  if (outcome.status >= 200 && outcome.status < 300) {
    // The broker acknowledges with an empty body. Our own message-id is the only
    // handle that exists, and it is what their delivery report will quote.
    return {
      status: 'SENT',
      providerRef: messageId,
      segments: estimateSmsSegments(message.body),
    };
  }

  const payload = parseJsonObject(outcome.body);

  if (outcome.status === 401 || outcome.status === 403) {
    return {
      status: 'FAILED',
      errorCode: 'PLAYMOBILE_UNAUTHORIZED',
      errorMessage: 'Play Mobile rejected the configured login or password.',
      retryable: false,
    };
  }

  return statusFailure(outcome.status, {
    errorCode: `PLAYMOBILE_HTTP_${outcome.status}`,
    errorMessage:
      stringField(payload, 'error-description') ??
      stringField(payload, 'error') ??
      (outcome.body.trim() === ''
        ? `Play Mobile answered HTTP ${outcome.status}.`
        : outcome.body),
  });
}
