/**
 * DEVELOPMENT ONLY. Writes the message to the log and reports it as sent.
 *
 * Nothing leaves the process. The point is that the entire notification pipeline
 * -- template rendering, recipient resolution, the outbox, retries, the
 * communication log -- can be exercised end to end on a laptop with no vendor
 * account, no credentials and no risk of texting a real parent while seeding test
 * data.
 *
 * The `console:` prefix on every `providerRef` is deliberate and load-bearing: a
 * `CommunicationLog` row that claims a delivery can be recognised as a local
 * fiction at a glance, and a production database that somehow contains one is
 * self-evidently misconfigured rather than quietly wrong. `env.ts` is what keeps
 * this driver out of production.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/server/observability/logger';
import { estimateSmsSegments } from './sms';
import {
  maskAddress,
  type MessageChannel,
  type MessageProvider,
  type OutboundMessage,
  type ProviderHealth,
  type SendResult,
} from './types';

export const CONSOLE_PROVIDER_KEY = 'console';

/** Unlike every real driver, the body is logged -- reading it is the feature. */
function logMessage(channel: MessageChannel, message: OutboundMessage): void {
  logger.info('messaging.console.send', {
    channel,
    provider: CONSOLE_PROVIDER_KEY,
    // Masked even here: a developer log still ends up pasted into an issue.
    to: maskAddress(channel, message.to),
    subject: message.subject,
    body: message.body,
    hasHtml: message.html !== undefined,
    metadata: message.metadata,
  });
}

export function createConsoleProvider(channel: MessageChannel): MessageProvider {
  return {
    channel,
    key: CONSOLE_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      return {
        // Configured in the sense that it will run. The message says what it is
        // so no settings screen can present this as a working integration.
        configured: true,
        message: 'Development driver: messages are written to the server log, not delivered.',
      };
    },

    async send(message: OutboundMessage): Promise<SendResult> {
      logMessage(channel, message);

      return {
        status: 'SENT',
        providerRef: `console:${randomUUID()}`,
        // Reported for SMS so the segment arithmetic is exercised in development
        // too, where getting it wrong is free.
        segments: channel === 'SMS' ? estimateSmsSegments(message.body) : undefined,
      };
    },
  };
}
