/**
 * Payment gateway selection, and the barrel every caller imports from.
 *
 * THREE RULES. This is the file someone opens when they add a gateway, so they
 * are written out here rather than left to be rediscovered in a driver:
 *
 *   1. SIGNATURE VERIFICATION IS MANDATORY, AND THE COMPARISON MUST BE
 *      TIMING-SAFE. A callback is an unauthenticated POST from the internet that
 *      claims an invoice was paid; the signature is the only thing separating it
 *      from a stranger with our webhook URL. Compare digests with
 *      `timingSafeEqualString` from ./signature, never `===`: an ordinary
 *      comparison returns at the first differing byte, and an attacker who can
 *      time the response recovers the signature -- or the signing key -- one byte
 *      at a time.
 *
 *   2. WEBHOOK PROCESSING MUST BE IDEMPOTENT ON (provider, externalId). Every
 *      gateway redelivers: on our timeout, on our 500, and sometimes for no
 *      reason at all. `WebhookEvent` already carries a unique constraint on that
 *      pair, so processing is idempotent exactly as long as `eventId` is
 *      deterministic and distinguishes genuinely different events. Where a
 *      gateway numbers transactions rather than events it will send one id for
 *      several stages, and the stage has to be folded into `eventId` -- or the
 *      settling callback looks like a replay of the reservation and the payment
 *      is silently dropped. Nothing else stops a replay: Click's protocol has no
 *      nonce, and a signed Stripe body stays valid for the whole tolerance
 *      window.
 *
 *   3. SIGNATURES ARE COMPUTED OVER THE RAW REQUEST BODY, NEVER A RE-SERIALISED
 *      JSON OBJECT. `JSON.stringify(JSON.parse(body))` is a different byte string
 *      -- key order, whitespace, number formatting all move -- so it verifies
 *      against nothing. Read the body once as text, verify those bytes, and only
 *      then parse. A verifier that parses first and signs the result is not
 *      verifying anything.
 *
 * What this module does NOT do: decide whether to take a payment, record one, or
 * touch the ledger. It answers "which gateway, and is it real". Recording money
 * is `@/server/services`, which owns the transaction and the derived caches.
 */

import { env, type Env } from '@/server/env';
import { clickPaymentProvider, CLICK_PROVIDER_KEY } from './click';
import { manualPaymentProvider, MANUAL_PROVIDER_KEY } from './manual';
import { paymePaymentProvider, PAYME_PROVIDER_KEY } from './payme';
import { stripePaymentProvider, STRIPE_PROVIDER_KEY } from './stripe';
import type {
  PaymentGatewayProvider,
  PaymentProviderDescription,
  ProviderHealth,
} from './types';

export type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentEventType,
  PaymentGatewayProvider,
  PaymentProviderDescription,
  ProviderHealth,
  WebhookInput,
  WebhookRejected,
  WebhookVerification,
  WebhookVerified,
} from './types';

export { CLICK_PROVIDER_KEY } from './click';
export { MANUAL_PROVIDER_KEY } from './manual';
export { PAYME_PROVIDER_KEY } from './payme';
export { STRIPE_PROVIDER_KEY } from './stripe';

/**
 * The JSON-RPC and SHOP-API codes the route handlers must answer with. Both
 * gateways branch on the code in the body rather than the HTTP status, so a
 * handler that returns a bare 401 leaves them retrying forever. Re-exported so a
 * handler never has to reach past this barrel into a driver.
 */
export { PAYME_ERROR_CODES } from './payme';
export { CLICK_ERROR_CODES } from './click';

/**
 * Tied to the env enum rather than declared again, so adding a gateway to
 * `PAYMENT_PROVIDER` without registering a driver below is a type error instead
 * of a runtime fall-through.
 */
export type PaymentProviderKey = Env['PAYMENT_PROVIDER'];

/** Gateways are pointed at `${APP_URL}${webhookPath}`. */
const WEBHOOK_BASE = '/api/webhooks';

interface RegistryEntry {
  readonly provider: PaymentGatewayProvider;
  /**
   * The gateway's own name. Not translated and not an i18n key: these are brand
   * names, and a settings screen that needs descriptive prose around a row keys
   * it off `key` in the dictionaries.
   */
  readonly label: string;
  readonly supportsCheckout: boolean;
  readonly supportsWebhooks: boolean;
  /**
   * Display copy of what the driver enforces. The driver is authoritative -- it
   * throws `BusinessRuleError` on a currency it cannot settle -- so a row here
   * that drifted would mislead an operator without ever mis-billing anyone.
   */
  readonly currencies: readonly string[];
}

const REGISTRY: { readonly [K in PaymentProviderKey]: RegistryEntry } = {
  [MANUAL_PROVIDER_KEY]: {
    provider: manualPaymentProvider,
    label: 'Manual',
    // Nothing to redirect a payer to and nothing to call us back, which is why
    // both operations refuse rather than returning a plausible URL.
    supportsCheckout: false,
    supportsWebhooks: false,
    currencies: [],
  },
  [PAYME_PROVIDER_KEY]: {
    provider: paymePaymentProvider,
    label: 'Payme',
    supportsCheckout: true,
    supportsWebhooks: true,
    currencies: ['UZS'],
  },
  [CLICK_PROVIDER_KEY]: {
    provider: clickPaymentProvider,
    label: 'Click',
    supportsCheckout: true,
    supportsWebhooks: true,
    currencies: ['UZS'],
  },
  [STRIPE_PROVIDER_KEY]: {
    provider: stripePaymentProvider,
    label: 'Stripe',
    supportsCheckout: true,
    supportsWebhooks: true,
    // Stripe settles whatever the account is enabled for, so the organisation's
    // own currency governs -- subject to the exponent caveat in ./stripe.ts.
    currencies: [],
  },
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let selected: PaymentGatewayProvider | undefined;

/**
 * The gateway this deployment transacts through.
 *
 * The drivers are stateless module singletons, so this caches a lookup rather
 * than a construction -- the point is that the resolution rule lives in exactly
 * one place, that every caller gets the same identity, and that tests have a
 * seam. Freezing the choice is safe because `env` is parsed once at module load:
 * changing the provider is a deploy, not a runtime toggle.
 */
export function getPaymentProvider(): PaymentGatewayProvider {
  selected ??= REGISTRY[env.PAYMENT_PROVIDER].provider;
  return selected;
}

function isPaymentProviderKey(value: string): value is PaymentProviderKey {
  return Object.hasOwn(REGISTRY, value);
}

/**
 * The driver for a webhook route, or null if that route must refuse.
 *
 * A callback naming a gateway this deployment did not select cannot be
 * authentic: nothing here could have issued a checkout through it. Verifying it
 * anyway would mean authenticating a stranger's POST against credentials that
 * happen to be left in the environment from a previous configuration, and then
 * posting the money it claims. So the check is "is this the selected provider",
 * not "do we have keys for it" -- and it lives here rather than being retyped,
 * subtly differently, in each of the three route handlers.
 */
export function getWebhookProvider(key: string): PaymentGatewayProvider | null {
  if (!isPaymentProviderKey(key)) return null;
  const provider = getPaymentProvider();
  return provider.key === key && REGISTRY[key].supportsWebhooks ? provider : null;
}

// ---------------------------------------------------------------------------
// Honest status for the settings UI
// ---------------------------------------------------------------------------

async function describe(key: PaymentProviderKey): Promise<PaymentProviderDescription> {
  const entry = REGISTRY[key];
  // `health()` is documented as configuration-only, so this stays cheap enough
  // to call while rendering and issues no network request.
  const health: ProviderHealth = await entry.provider.health();

  return {
    key: entry.provider.key,
    label: entry.label,
    configured: health.configured,
    message: health.message,
    supportsCheckout: entry.supportsCheckout,
    supportsWebhooks: entry.supportsWebhooks,
    webhookPath: entry.supportsWebhooks ? `${WEBHOOK_BASE}/${key}` : null,
    currencies: entry.currencies,
  };
}

/**
 * What the selected gateway actually is and whether it can transact.
 *
 * Honest in the awkward direction too: `manual` reports `configured: true`,
 * because recording payments by hand is a working configuration rather than a
 * broken one, and says in its message that no payment links exist. A gateway
 * selected without credentials reports `configured: false` and names the
 * variables that are missing. Neither state is dressed up as the other.
 */
export function describePaymentProvider(): Promise<PaymentProviderDescription> {
  return describe(env.PAYMENT_PROVIDER);
}

/**
 * Every known gateway, selected one first, for a settings screen that offers a
 * choice. Only the selected provider's `configured` reflects a gateway that can
 * actually be used right now -- the rest report whether their credentials happen
 * to be present, which is a readiness hint and nothing more.
 */
export function describePaymentProviders(): Promise<readonly PaymentProviderDescription[]> {
  const active = env.PAYMENT_PROVIDER;
  const keys = Object.keys(REGISTRY).filter(isPaymentProviderKey);
  const ordered = [active, ...keys.filter((key) => key !== active)];
  return Promise.all(ordered.map(describe));
}

/**
 * Drop the memoised selection. For tests that swap `env` between cases; a
 * request handler has no reason to call it.
 */
export function __resetPaymentProvider(): void {
  selected = undefined;
}
