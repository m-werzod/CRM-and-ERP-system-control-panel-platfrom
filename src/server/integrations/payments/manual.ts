/**
 * The `manual` provider: there is no gateway.
 *
 * This is the default, and for most institutions it is also the correct final
 * answer. Fees arrive as cash at the front desk or as a bank transfer, and an
 * accountant records them against the invoice. Nothing about that flow needs a
 * provider -- the provider exists so the rest of the system has one shape to
 * program against, and so "no online payments" is a state the UI can render
 * instead of a branch every caller has to remember.
 *
 * Both gateway operations refuse. That refusal is the feature: a stub that
 * returned a plausible checkout URL, or answered a webhook with `valid: true`,
 * would turn a missing integration into a silently wrong ledger.
 */

import { IntegrationNotConfiguredError } from '@/server/errors';
import type {
  PaymentGatewayProvider,
  ProviderHealth,
  WebhookVerification,
} from './types';

export const MANUAL_PROVIDER_KEY = 'manual';

export const manualPaymentProvider: PaymentGatewayProvider = {
  key: MANUAL_PROVIDER_KEY,

  /**
   * Configured, deliberately. Manual collection is a working configuration, not
   * a broken one -- the message tells the settings screen what it means so the
   * operator is not left looking for credentials to fill in.
   */
  async health(): Promise<ProviderHealth> {
    return {
      configured: true,
      message:
        'Payments are recorded by hand. There is no online gateway, so no payment links can be issued.',
    };
  },

  async createCheckout(): Promise<never> {
    throw new IntegrationNotConfiguredError(
      'Online payments',
      'Online payment links are not available: this installation records payments manually. ' +
        'An administrator can enable a gateway by setting PAYMENT_PROVIDER.',
    );
  },

  /**
   * Rejects unconditionally. A callback reaching a manual installation is either
   * a stale gateway configuration pointing at us or someone probing the
   * endpoint; in both cases the only safe answer is "not verified".
   */
  async verifyWebhook(): Promise<WebhookVerification> {
    return {
      valid: false,
      reason: 'No payment gateway is configured, so no callback can be authenticated.',
    };
  },
};
