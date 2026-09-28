/**
 * Stripe Checkout Sessions.
 *
 * Implemented against the REST API with `fetch` and `node:crypto` rather than the
 * `stripe` SDK, which is not a dependency of this project. That costs us nothing
 * here: a Checkout Session is one form-encoded POST, and webhook verification is
 * an HMAC. It does mean the request shape is pinned by hand -- hence the explicit
 * `Stripe-Version` header, so that a future default-version change at Stripe
 * cannot silently alter the fields we read.
 *
 * `unit_amount` is Stripe's smallest currency unit, the same convention as our
 * `amountMinor`, so amounts pass through unscaled. That equivalence holds only
 * while a currency's exponent in `@/lib/money` matches Stripe's: for a
 * zero-decimal currency (JPY, KRW...) Stripe expects whole units, and adding one
 * to `SUPPORTED_CURRENCIES` without an exponent of 0 would overcharge by 100x.
 */

import { env } from '@/server/env';
import { BusinessRuleError, IntegrationFailedError, IntegrationNotConfiguredError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import {
  asRecord,
  headerValue,
  hmacSha256Hex,
  parseJsonObject,
  readMinorUnits,
  readString,
  timingSafeEqualString,
} from './signature';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentEventType,
  PaymentGatewayProvider,
  ProviderHealth,
  WebhookInput,
  WebhookVerification,
} from './types';

export const STRIPE_PROVIDER_KEY = 'stripe';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Pinned deliberately. Stripe versions its API per account, and an account
 * upgraded in the dashboard would otherwise start sending a different event
 * payload to code that was never changed.
 */
const STRIPE_API_VERSION = '2024-06-20';

/** A gateway that has stopped answering must not hold a request open forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How far a webhook's own timestamp may be from ours.
 *
 * This window is the entire replay defence. The signature proves the body came
 * from Stripe, but a signed body stays valid forever -- so anyone who captures
 * one (a log aggregator, a proxy, a misconfigured mirror) could re-post it and
 * have a payment recorded again. Because the timestamp is inside the signed
 * payload it cannot be edited, so refusing old timestamps bounds the replay
 * window to a few minutes. Stripe's own libraries use 300 seconds; widening it
 * widens exactly that hole.
 *
 * Note that the tolerance does not make processing idempotent by itself -- a
 * replay inside the window is still possible, which is what the unique
 * `(provider, externalId)` on WebhookEvent is for.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Metadata keys this driver sets itself; a caller cannot overwrite them. */
const RESERVED_METADATA_KEYS: readonly string[] = ['invoiceId', 'idempotencyKey'];

interface StripeCredentials {
  readonly secretKey: string;
  readonly webhookSecret: string;
}

function credentials(): StripeCredentials | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

interface ParsedSignatureHeader {
  readonly timestamp: number;
  /** Stripe sends several during a secret rotation; any one matching is enough. */
  readonly signatures: readonly string[];
}

/**
 * Parses `t=1492774577,v1=5257a869...,v1=...`. Only the `v1` scheme is accepted:
 * `v0` covers a different payload and treating it as interchangeable would accept
 * a signature over bytes we never checked.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1' && value !== '') {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * What kind of money event this is.
 *
 * `payment_intent.succeeded` is deliberately NOT a success here. Stripe emits it
 * alongside `checkout.session.completed` for the same money, and treating both as
 * settlement would post the payment twice -- the unique
 * `(provider, externalId)` guard cannot help, because they are two genuinely
 * different events. The checkout session is the one that carries our
 * `client_reference_id`, so it is the one that settles.
 */
function classify(eventType: string, object: Record<string, unknown>): PaymentEventType {
  switch (eventType) {
    case 'checkout.session.completed':
      // A bank-debit or voucher method completes the session while still unpaid;
      // its money arrives later as async_payment_succeeded.
      return readString(object, 'payment_status') === 'paid' ? 'PAYMENT_SUCCEEDED' : 'OTHER';
    case 'checkout.session.async_payment_succeeded':
      return 'PAYMENT_SUCCEEDED';
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled':
      return 'PAYMENT_FAILED';
    case 'charge.refunded':
      return 'REFUNDED';
    case 'refund.created':
    case 'refund.updated':
    case 'charge.refund.updated':
      // A refund object also travels here while pending, and after it fails.
      return readString(object, 'status') === 'succeeded' ? 'REFUNDED' : 'OTHER';
    default:
      return 'OTHER';
  }
}

interface ExtractedAmounts {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly providerRef: string;
  readonly invoiceRef: string | undefined;
}

/**
 * Pulls the fields the ledger needs out of whichever object the event carried.
 *
 * `providerRef` prefers the payment intent, because that is the id every later
 * event about the same money shares -- a refund arrives on the charge and knows
 * its payment intent, but has never heard of the checkout session. The session id
 * that `createCheckout` returned therefore identifies the *attempt*, while the
 * settling event names the *transaction*; the two are correlated by `invoiceRef`.
 */
function extract(eventType: string, object: Record<string, unknown>): ExtractedAmounts {
  const metadata = asRecord(object['metadata']);
  const invoiceRef =
    readString(object, 'client_reference_id') ??
    (metadata ? readString(metadata, 'invoiceId') : undefined);

  const paymentIntent = readString(object, 'payment_intent');
  const providerRef = paymentIntent ?? readString(object, 'id') ?? '';
  const currency = (readString(object, 'currency') ?? '').toUpperCase();

  // Each object type states the settled amount under a different key, and
  // picking the wrong one silently records the authorised amount instead.
  const amountMinor =
    eventType === 'charge.refunded'
      ? readMinorUnits(object, 'amount_refunded')
      : (readMinorUnits(object, 'amount_total') ??
        readMinorUnits(object, 'amount_received') ??
        readMinorUnits(object, 'amount'));

  return { amountMinor: amountMinor ?? 0n, currency: amountMinor === undefined ? '' : currency, providerRef, invoiceRef };
}

async function postForm(
  path: string,
  body: URLSearchParams,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API_BASE}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntegrationFailedError('Stripe', { cause: error, details: { path } });
  }

  const text = await response.text();
  const parsed = parseJsonObject(text);

  if (!response.ok) {
    const problem = asRecord(parsed?.['error']);
    // The message is Stripe's own and may name the account; it goes to the log,
    // never into the error shown to a payer.
    logger.error('payments.stripe.api_error', {
      path,
      status: response.status,
      stripeCode: problem ? readString(problem, 'code') : undefined,
      stripeMessage: problem ? readString(problem, 'message') : undefined,
    });
    throw new IntegrationFailedError('Stripe', {
      details: { status: response.status, code: problem ? readString(problem, 'code') : undefined },
    });
  }

  if (!parsed) {
    throw new IntegrationFailedError('Stripe', { details: { path, reason: 'response was not JSON' } });
  }
  return parsed;
}

export const stripePaymentProvider: PaymentGatewayProvider = {
  key: STRIPE_PROVIDER_KEY,

  async health(): Promise<ProviderHealth> {
    const resolved = credentials();
    if (!resolved) {
      return {
        configured: false,
        message:
          'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, then add /api/webhooks/stripe as an endpoint in the Stripe dashboard.',
      };
    }
    if (resolved.secretKey.startsWith('sk_test_')) {
      return { configured: true, message: 'Using Stripe test keys: no real money will move.' };
    }
    return { configured: true };
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const resolved = credentials();
    if (!resolved) {
      throw new IntegrationNotConfiguredError(
        'Stripe',
        'Stripe is selected but STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set.',
      );
    }
    if (input.amountMinor <= 0n) {
      throw new BusinessRuleError(
        'payments.checkout_amount_not_positive',
        'A payment link needs an amount greater than zero.',
      );
    }

    const body = new URLSearchParams();
    body.set('mode', 'payment');
    // One return URL is all the caller gives us, and that is enough: which URL
    // the browser lands on is not evidence of payment, so both outcomes go to the
    // same page and the page reads state the webhook wrote.
    body.set('success_url', input.returnUrl);
    body.set('cancel_url', input.returnUrl);
    body.set('client_reference_id', input.invoiceId);
    body.set('line_items[0][quantity]', '1');
    body.set('line_items[0][price_data][currency]', input.currency.toLowerCase());
    body.set('line_items[0][price_data][unit_amount]', input.amountMinor.toString());
    body.set('line_items[0][price_data][product_data][name]', input.description);
    body.set('metadata[invoiceId]', input.invoiceId);
    body.set('metadata[idempotencyKey]', input.idempotencyKey);
    // Copied onto the payment intent as well, because a refund event arrives on
    // the charge and never carries the session's metadata.
    body.set('payment_intent_data[metadata][invoiceId]', input.invoiceId);

    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (RESERVED_METADATA_KEYS.includes(key)) continue;
      body.set(`metadata[${key}]`, value);
    }

    const session = await postForm('/checkout/sessions', body, {
      Authorization: `Bearer ${resolved.secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      // Stripe's own replay protection: a retried creation returns the first
      // session instead of opening a second one for the same invoice.
      'Idempotency-Key': input.idempotencyKey,
    });

    const checkoutUrl = readString(session, 'url');
    const providerRef = readString(session, 'id');
    if (!checkoutUrl || !providerRef) {
      throw new IntegrationFailedError('Stripe', {
        details: { reason: 'checkout session came back without an id or url' },
      });
    }

    return { checkoutUrl, providerRef };
  },

  async verifyWebhook(input: WebhookInput): Promise<WebhookVerification> {
    const resolved = credentials();
    if (!resolved) {
      return { valid: false, reason: 'Stripe is not configured; no callback can be authenticated.' };
    }

    const header = headerValue(input.headers, 'stripe-signature');
    if (!header) return { valid: false, reason: 'Missing Stripe-Signature header.' };

    const parsedHeader = parseSignatureHeader(header);
    if (!parsedHeader) {
      return { valid: false, reason: 'Stripe-Signature header has no t= and v1= pair.' };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const age = Math.abs(nowSeconds - parsedHeader.timestamp);
    if (age > SIGNATURE_TOLERANCE_SECONDS) {
      logger.warn('payments.stripe.webhook_outside_tolerance', { ageSeconds: age });
      return {
        valid: false,
        reason: `Signature timestamp is ${age}s away from now, outside the ${SIGNATURE_TOLERANCE_SECONDS}s tolerance.`,
      };
    }

    // The signed payload is the timestamp, a dot, and the body BYTES AS SENT.
    // Re-serialising the parsed JSON first would change key order and whitespace
    // and produce a digest that matches nothing.
    const expected = hmacSha256Hex(
      resolved.webhookSecret,
      `${parsedHeader.timestamp}.${input.rawBody}`,
    );
    const matched = parsedHeader.signatures.some((candidate) =>
      timingSafeEqualString(candidate.toLowerCase(), expected),
    );
    if (!matched) {
      logger.warn('payments.stripe.webhook_signature_mismatch', {
        presentedCount: parsedHeader.signatures.length,
      });
      return { valid: false, reason: 'No v1 signature matches the body.' };
    }

    const event = parseJsonObject(input.rawBody);
    if (!event) return { valid: false, reason: 'Body is not a JSON object.' };

    const eventId = readString(event, 'id');
    const eventType = readString(event, 'type');
    if (!eventId || !eventType) {
      return { valid: false, reason: 'Event has no id or type.' };
    }

    const object = asRecord(asRecord(event['data'])?.['object']) ?? {};
    const { amountMinor, currency, providerRef, invoiceRef } = extract(eventType, object);

    return {
      valid: true,
      // Stripe's own event id, which it reuses on every redelivery of the same
      // event -- exactly the property `(provider, externalId)` needs.
      eventId,
      type: classify(eventType, object),
      providerRef,
      amountMinor,
      currency,
      invoiceRef,
      raw: event,
    };
  },
};

/** Exposed for unit tests, which need to sign a body the way Stripe does. */
export const __testing = {
  parseSignatureHeader,
  classify,
  extract,
  SIGNATURE_TOLERANCE_SECONDS,
  STRIPE_API_VERSION,
};
