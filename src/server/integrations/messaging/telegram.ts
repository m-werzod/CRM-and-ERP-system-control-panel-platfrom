/**
 * Telegram Bot API.
 *
 * `to` is a numeric chat id, not a phone number and not a @username. A bot cannot
 * open a conversation: the user (parent, student, teacher) must message the bot or
 * follow a deep link first, and only then does an incoming update reveal their
 * chat id. So the platform has to capture that id -- through the bot's webhook,
 * against a linking code -- and store it on the person before this driver can
 * reach them. A send to an id nobody has confirmed fails with 400 "chat not
 * found", which is permanent: the fix is re-linking the account, not a retry.
 *
 * The bot token is part of the URL path. It is therefore never logged; see the
 * note at the top of ./http.ts.
 */

import { env } from '@/server/env';
import {
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
import type {
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const TELEGRAM_PROVIDER_KEY = 'telegram-bot-api';

const API_ROOT = 'https://api.telegram.org';

/** Telegram truncates beyond this; splitting is the notification layer's call. */
const MAX_TEXT_CHARS = 4_096;

export function createTelegramProvider(): MessageProvider {
  return {
    channel: 'TELEGRAM',
    key: TELEGRAM_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return { configured: false, message: 'Telegram is missing TELEGRAM_BOT_TOKEN.' };
      }
      return {
        configured: true,
        message:
          'Recipients must start a chat with the bot before they can be messaged; unlinked accounts are skipped.',
      };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        return { status: 'SKIPPED', reason: 'Telegram is missing TELEGRAM_BOT_TOKEN' };
      }

      const chatId = message.to.trim();
      // A chat id is an integer, negative for groups and channels. Anything else
      // (a phone number, an @username, an empty string) cannot be delivered and
      // means the recipient was never linked.
      if (!/^-?\d+$/.test(chatId)) {
        return {
          status: 'FAILED',
          errorCode: 'TELEGRAM_NOT_LINKED',
          errorMessage:
            'The recipient has no Telegram chat id. They must start a chat with the bot first.',
          retryable: false,
        };
      }

      // HTML is preferred when present because Telegram's own formatting is far
      // more forgiving than Markdown, which fails the whole send on an unescaped
      // underscore in a student name.
      const html = message.html?.trim();
      const usingHtml = html !== undefined && html !== '';

      const outcome = await providerFetch({
        label: 'Telegram',
        url: `${API_ROOT}/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: (usingHtml ? html : message.body).slice(0, MAX_TEXT_CHARS),
          parse_mode: usingHtml ? 'HTML' : undefined,
          link_preview_options: { is_disabled: true },
        }),
      });

      const result = interpret(outcome);
      logSendOutcome(TELEGRAM_PROVIDER_KEY, 'TELEGRAM', message.to, result);
      return result;
    },
  };
}

function interpret(outcome: HttpOutcome): SendResult {
  if (outcome.kind === 'TRANSPORT') return transportFailure(outcome);

  const payload = parseJsonObject(outcome.body);

  // The Bot API reports its own success separately from the HTTP status, so `ok`
  // decides rather than the 200.
  if (outcome.status >= 200 && outcome.status < 300 && payload?.['ok'] === true) {
    return {
      status: 'SENT',
      providerRef: stringField(objectField(payload, 'result'), 'message_id'),
    };
  }

  const description = stringField(payload, 'description');
  const errorCode = numberField(payload, 'error_code') ?? outcome.status;
  const retryAfter = numberField(objectField(payload, 'parameters'), 'retry_after');

  return statusFailure(outcome.status, {
    errorCode: `TELEGRAM_${errorCode}`,
    errorMessage: description ?? `Telegram answered HTTP ${outcome.status}.`,
    retryable: classify(errorCode, retryAfter),
  });
}

/** `undefined` leaves the decision to the HTTP status. */
function classify(errorCode: number, retryAfter: number | undefined): boolean | undefined {
  // A flood-wait names how long to wait, so it is by definition recoverable.
  if (retryAfter !== undefined) return true;
  // 400 (chat not found, chat deactivated) and 403 (the user blocked the bot)
  // stay true until the person re-links their account, so a retry can only fail
  // the same way.
  if (errorCode === 400 || errorCode === 403) return false;
  return undefined;
}
