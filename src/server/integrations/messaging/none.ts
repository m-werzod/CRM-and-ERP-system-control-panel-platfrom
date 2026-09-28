/**
 * The provider for a channel nobody has configured.
 *
 * It returns SKIPPED instead of throwing, and that choice is the whole reason the
 * file exists. Notifications are a side effect of business work: an attendance
 * register, an issued invoice, a created account. An institution that has bought
 * no SMS package must still be able to submit a register, and a thrown
 * `IntegrationNotConfiguredError` propagating out of the notification path would
 * make a missing vendor contract look like an application outage -- or, worse,
 * roll back the attendance transaction that queued the message.
 *
 * SKIPPED is also honest in a way that a fake success is not: the notification
 * row stays visibly unsent with a reason, so "why did the parent not get the
 * absence alert" has an answer in the data.
 *
 * The exception is a channel the user asked for interactively (a test send from
 * the settings screen). That caller should check `health()` first and show the
 * "not configured" state, rather than reading a SKIPPED result as success.
 */

import type {
  MessageChannel,
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendResult,
} from './types';

export const UNCONFIGURED_PROVIDER_KEY = 'none';

/** The reason string is stable: callers and tests match on it. */
export const NOT_CONFIGURED_REASON = 'provider not configured';

export function createUnconfiguredProvider(channel: MessageChannel): MessageProvider {
  const label = channel.toLowerCase();

  return {
    channel,
    key: UNCONFIGURED_PROVIDER_KEY,

    async health(): Promise<ProviderHealth> {
      return {
        configured: false,
        message: `No ${label} provider is selected. Choose one in Settings to start delivering ${label} messages.`,
      };
    },

    async send(_message: OutboundMessage): Promise<SendResult> {
      return { status: 'SKIPPED', reason: NOT_CONFIGURED_REASON };
    },
  };
}
