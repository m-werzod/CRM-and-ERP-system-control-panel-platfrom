/**
 * Provider selection.
 *
 * One getter per channel, each resolving the driver named by `env` exactly once.
 * The memoisation is not a micro-optimisation: `createEskizProvider` keeps its
 * bearer token in the closure it returns, so a fresh instance per send would
 * re-authenticate against Eskiz on every message and walk the account into their
 * login throttle. Selection is safe to freeze because `env` is parsed once at
 * module load -- a provider change is a deploy, not a runtime toggle.
 *
 * Nothing here decides *whether* to notify anyone. Recipient resolution, template
 * rendering, quiet hours and the outbox live in `@/server/notifications`; this
 * module only answers "which transport, and is it real".
 */

import { env } from '@/server/env';
import { createConsoleProvider, CONSOLE_PROVIDER_KEY } from './console';
import { createEskizProvider } from './eskiz';
import { createPlayMobileProvider } from './playmobile';
import { createResendProvider } from './resend';
import { createSmtpProvider, SMTP_PROVIDER_KEY } from './smtp';
import { createTelegramProvider } from './telegram';
import { createTwilioProvider } from './twilio';
import { createUnconfiguredProvider, UNCONFIGURED_PROVIDER_KEY } from './none';
import { createWhatsAppProvider } from './whatsapp';
import type { MessageChannel, MessageProvider } from './types';

export type {
  MessageChannel,
  MessageProvider,
  OutboundMessage,
  ProviderHealth,
  SendFailure,
  SendResult,
  SendSkipped,
  SendSuccess,
} from './types';
export { maskAddress } from './types';
export { estimateSmsSegments, toMsisdn } from './sms';
export { NOT_CONFIGURED_REASON } from './none';

// ---------------------------------------------------------------------------
// Memoised getters
// ---------------------------------------------------------------------------

let emailProvider: MessageProvider | undefined;
let smsProvider: MessageProvider | undefined;
let telegramProvider: MessageProvider | undefined;
let whatsappProvider: MessageProvider | undefined;

export function getEmailProvider(): MessageProvider {
  emailProvider ??= selectEmail();
  return emailProvider;
}

export function getSmsProvider(): MessageProvider {
  smsProvider ??= selectSms();
  return smsProvider;
}

export function getTelegramProvider(): MessageProvider {
  telegramProvider ??= selectTelegram();
  return telegramProvider;
}

export function getWhatsAppProvider(): MessageProvider {
  whatsappProvider ??= selectWhatsApp();
  return whatsappProvider;
}

function selectEmail(): MessageProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'console':
      return createConsoleProvider('EMAIL');
    case 'resend':
      return createResendProvider();
    case 'smtp':
      // Constructing it is safe; sending throws. See ./smtp.ts -- the settings
      // screen has to be able to render this state without failing.
      return createSmtpProvider();
    case 'none':
      return createUnconfiguredProvider('EMAIL');
  }
}

function selectSms(): MessageProvider {
  switch (env.SMS_PROVIDER) {
    case 'console':
      return createConsoleProvider('SMS');
    case 'eskiz':
      return createEskizProvider();
    case 'playmobile':
      return createPlayMobileProvider();
    case 'twilio':
      return createTwilioProvider();
    case 'none':
      return createUnconfiguredProvider('SMS');
  }
}

function selectTelegram(): MessageProvider {
  switch (env.TELEGRAM_PROVIDER) {
    case 'console':
      return createConsoleProvider('TELEGRAM');
    case 'bot-api':
      return createTelegramProvider();
    case 'none':
      return createUnconfiguredProvider('TELEGRAM');
  }
}

function selectWhatsApp(): MessageProvider {
  switch (env.WHATSAPP_PROVIDER) {
    case 'console':
      return createConsoleProvider('WHATSAPP');
    case 'cloud-api':
      return createWhatsAppProvider();
    case 'none':
      return createUnconfiguredProvider('WHATSAPP');
  }
}

/** Look a provider up by the channel a notification row names. */
export function getProviderForChannel(channel: MessageChannel): MessageProvider {
  switch (channel) {
    case 'EMAIL':
      return getEmailProvider();
    case 'SMS':
      return getSmsProvider();
    case 'TELEGRAM':
      return getTelegramProvider();
    case 'WHATSAPP':
      return getWhatsAppProvider();
  }
}

// ---------------------------------------------------------------------------
// Honest status for the settings UI
// ---------------------------------------------------------------------------

/**
 * What a channel actually does, which `configured` alone cannot express. The
 * console driver is configured and will happily report every message as sent
 * while delivering nothing, and an administrator looking at a settings page has
 * to be able to tell that apart from a working gateway.
 */
export type ProviderDelivery =
  /** Reaches real recipients. */
  | 'REAL'
  /** Development only: written to the server log and discarded. */
  | 'CONSOLE'
  /** Nothing is attempted; sends are skipped. */
  | 'NONE'
  /** Selected, but this deployment cannot run it. Every send fails. */
  | 'UNAVAILABLE';

export interface MessagingChannelStatus {
  readonly channel: MessageChannel;
  /** The value stored in `CommunicationLog.provider`. */
  readonly provider: string;
  readonly delivery: ProviderDelivery;
  readonly configured: boolean;
  /** Names what is missing, or what the driver will and will not do. */
  readonly message?: string;
}

function deliveryOf(key: string): ProviderDelivery {
  if (key === UNCONFIGURED_PROVIDER_KEY) return 'NONE';
  if (key === CONSOLE_PROVIDER_KEY) return 'CONSOLE';
  // The only selectable driver that cannot run: SMTP needs nodemailer, which is
  // not installed.
  if (key === SMTP_PROVIDER_KEY) return 'UNAVAILABLE';
  return 'REAL';
}

async function describe(provider: MessageProvider): Promise<MessagingChannelStatus> {
  const health = await provider.health();
  return {
    channel: provider.channel,
    provider: provider.key,
    delivery: deliveryOf(provider.key),
    configured: health.configured,
    message: health.message,
  };
}

/**
 * Per-channel status for the integrations settings page. Reports what is true,
 * including the awkward truths: a channel with no provider, a channel wired to
 * the console driver, and a channel selected for a transport this build cannot
 * perform.
 */
export async function describeMessagingProviders(): Promise<readonly MessagingChannelStatus[]> {
  return Promise.all([
    describe(getEmailProvider()),
    describe(getSmsProvider()),
    describe(getTelegramProvider()),
    describe(getWhatsAppProvider()),
  ]);
}

/**
 * Drop the memoised providers. For tests that swap `env` between cases -- a
 * request handler must never call this, because it would discard the Eskiz token
 * mid-run.
 */
export function __resetMessagingProviders(): void {
  emailProvider = undefined;
  smsProvider = undefined;
  telegramProvider = undefined;
  whatsappProvider = undefined;
}
