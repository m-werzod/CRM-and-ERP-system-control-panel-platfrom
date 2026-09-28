/**
 * Payme (Uzbekistan) Merchant API.
 *
 * Two halves that look nothing alike:
 *
 *   Checkout is a redirect, with no server call at all. The order is encoded as
 *   `m=<merchant>;ac.<field>=<value>;a=<amount>` and base64'd into the path of
 *   Payme's hosted page. Nothing is reserved at this point -- the link is an
 *   invitation, and an unpaid link simply expires.
 *
 *   The callback is JSON-RPC 2.0 over POST, authenticated by an HTTP Basic
 *   header rather than a body signature, and it is a small state machine:
 *   CheckPerformTransaction (may this order be paid?) -> CreateTransaction
 *   (money reserved) -> PerformTransaction (money captured) with
 *   CancelTransaction as the exit at either stage.
 *
 * Amounts are in tiyin, which is exactly our UZS minor unit (see `@/lib/money`),
 * so no scaling happens here -- and none should be introduced.
 */

import { env } from '@/server/env';
import { BusinessRuleError, IntegrationNotConfiguredError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import {
  asRecord,
  headerValue,
  parseJsonObject,
  readMinorUnits,
  readNumber,
  readString,
  sha256Hex,
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

export const PAYME_PROVIDER_KEY = 'payme';

/** Payme settles in som only; a checkout in anything else cannot be honoured. */
const PAYME_CURRENCY = 'UZS';

const CHECKOUT_BASE_URL = 'https://checkout.paycom.uz';

/**
 * The Basic login Payme authenticates as. Fixed by the protocol -- it is not the
 * merchant id, and it is not a secret.
 */
const PAYME_BASIC_LOGIN = 'Paycom';

/**
 * JSON-RPC error codes the route handler must answer with. Payme reads these,
 * not the HTTP status, so a handler that returns 401 with an empty body causes
 * Payme to retry forever.
 */
export const PAYME_ERROR_CODES = {
  transactionNotFound: -31003,
  cannotPerform: -31008,
  cannotCancel: -31007,
  invalidAmount: -31001,
  invalidAccount: -31050,
  /** Authentication failed: wrong or missing Basic header. */
  insufficientPrivilege: -32504,
  methodNotFound: -32601,
  parseError: -32700,
} as const;

/**
 * Cancellation reason 5 is "money returned" -- a refund of a transaction that was
 * already performed. Every other documented reason (1-4, 10) describes a
 * transaction that never completed.
 */
const PAYME_REASON_REFUND = 5;

interface PaymeCredentials {
  readonly merchantId: string;
  readonly secretKey: string;
}

function credentials(): PaymeCredentials | null {
  const merchantId = env.PAYME_MERCHANT_ID;
  const secretKey = env.PAYME_SECRET_KEY;
  if (!merchantId || !secretKey) return null;
  return { merchantId, secretKey };
}

function requireCredentials(): PaymeCredentials {
  const resolved = credentials();
  if (!resolved) {
    throw new IntegrationNotConfiguredError(
      'Payme',
      'Payme is selected but PAYME_MERCHANT_ID and PAYME_SECRET_KEY are not set.',
    );
  }
  return resolved;
}

/**
 * Builds the `key=value;...` payload Payme expects, base64'd into the checkout
 * path. Values are not URL-encoded: the whole string is encoded once as base64,
 * and encoding twice produces a link Payme parses into the wrong order id.
 */
function encodeCheckoutPayload(parts: readonly (readonly [string, string])[]): string {
  const payload = parts.map(([key, value]) => `${key}=${value}`).join(';');
  return Buffer.from(payload, 'utf8').toString('base64');
}

/** The JSON-RPC method, plus whatever `params` carried, with nothing trusted. */
interface PaymeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** The whole envelope, parsed once and stored verbatim on the event. */
  readonly body: Record<string, unknown>;
}

function parseCall(rawBody: string): PaymeCall | null {
  const body = parseJsonObject(rawBody);
  if (!body) return null;
  const method = readString(body, 'method');
  if (!method) return null;
  return { method, params: asRecord(body['params']) ?? {}, body };
}

/**
 * Checks the `Authorization: Basic base64("Paycom:<secret>")` header.
 *
 * The secret is compared in constant time. A plain `===` would return as soon as
 * two bytes differed, which over enough requests reveals the key one byte at a
 * time -- and this single header is the only thing standing between a stranger
 * and a PerformTransaction call that marks an invoice paid.
 */
function authenticate(headers: Record<string, string>, secretKey: string): string | null {
  const header = headerValue(headers, 'authorization');
  if (!header) return 'Missing Authorization header.';

  const [scheme, encoded] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !encoded) {
    return 'Authorization header is not Basic.';
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return 'Authorization header is not valid base64.';
  }

  // Split on the FIRST colon only: a secret containing colons is legal.
  const separator = decoded.indexOf(':');
  if (separator < 0) return 'Authorization credentials are not "login:key".';
  const login = decoded.slice(0, separator);
  const presented = decoded.slice(separator + 1);

  // The login is public protocol, so an ordinary comparison leaks nothing.
  if (login !== PAYME_BASIC_LOGIN) return 'Unexpected Authorization login.';
  if (!timingSafeEqualString(presented, secretKey)) return 'Authorization key does not match.';
  return null;
}

/**
 * Payme numbers transactions, not events, and sends the same `params.id` for
 * CreateTransaction, PerformTransaction and CancelTransaction. Keying
 * `WebhookEvent.externalId` on the id alone would make the perform look like a
 * replay of the create and drop the payment, so the method is folded in.
 */
function transactionEventId(method: string, transactionId: string): string {
  return `${method}:${transactionId}`;
}

/**
 * CheckPerformTransaction arrives before a transaction exists, so there is no id
 * to key on. Hashing the body is the right fallback here precisely because it
 * makes an identical re-check collapse into one stored event: the call reserves
 * nothing and moves no money, so treating a repeat as the same event is correct
 * rather than merely convenient.
 */
function bodyEventId(method: string, rawBody: string): string {
  return `${method}:${sha256Hex(rawBody).slice(0, 32)}`;
}

function accountField(params: Record<string, unknown>, field: string): string | undefined {
  const account = asRecord(params['account']);
  return account ? readString(account, field) : undefined;
}

export const paymePaymentProvider: PaymentGatewayProvider = {
  key: PAYME_PROVIDER_KEY,

  async health(): Promise<ProviderHealth> {
    const resolved = credentials();
    if (!resolved) {
      return {
        configured: false,
        message: 'Set PAYME_MERCHANT_ID and PAYME_SECRET_KEY, then point Payme at /api/webhooks/payme.',
      };
    }
    return { configured: true };
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const { merchantId } = requireCredentials();

    if (input.currency !== PAYME_CURRENCY) {
      throw new BusinessRuleError(
        'payments.gateway_currency_unsupported',
        `Payme can only collect ${PAYME_CURRENCY}; this invoice is in ${input.currency}.`,
      );
    }
    if (input.amountMinor <= 0n) {
      throw new BusinessRuleError(
        'payments.checkout_amount_not_positive',
        'A payment link needs an amount greater than zero.',
      );
    }

    // `ac.order_id` is the only field that comes back on the callback, so it has
    // to be the thing we can look an invoice up by.
    const encoded = encodeCheckoutPayload([
      ['m', merchantId],
      ['ac.order_id', input.invoiceId],
      ['a', input.amountMinor.toString()],
      ['c', input.returnUrl],
    ]);

    return {
      checkoutUrl: `${CHECKOUT_BASE_URL}/${encoded}`,
      // Payme mints no id until the payer actually starts, so the best reference
      // we can hand back is the order key that will arrive in
      // `params.account.order_id`.
      providerRef: input.invoiceId,
    };
  },

  async verifyWebhook(input: WebhookInput): Promise<WebhookVerification> {
    const resolved = credentials();
    if (!resolved) {
      return { valid: false, reason: 'Payme is not configured; no callback can be authenticated.' };
    }

    const authFailure = authenticate(input.headers, resolved.secretKey);
    if (authFailure) {
      // Logged as a warning, not an error: an unauthenticated POST to a public
      // endpoint is expected background noise, but a burst of it is worth seeing.
      logger.warn('payments.payme.webhook_unauthenticated', { reason: authFailure });
      return { valid: false, reason: authFailure };
    }

    const call = parseCall(input.rawBody);
    if (!call) {
      return { valid: false, reason: 'Body is not a JSON-RPC request with a "method".' };
    }

    const { method, params, body } = call;
    const transactionId = readString(params, 'id');
    const amountMinor = readMinorUnits(params, 'amount');
    const orderId = accountField(params, 'order_id');

    const stated = (amount: bigint | undefined) => ({
      amountMinor: amount ?? 0n,
      currency: amount === undefined ? '' : PAYME_CURRENCY,
    });

    switch (method) {
      case 'CheckPerformTransaction':
        // A pre-flight question, not a payment. Answering it is the finance
        // layer's job; recording it as money moved would be wrong.
        return {
          valid: true,
          eventId: bodyEventId(method, input.rawBody),
          type: 'OTHER',
          providerRef: orderId ?? '',
          ...stated(amountMinor),
          invoiceRef: orderId,
          raw: body,
        };

      case 'CreateTransaction': {
        if (!transactionId) {
          return { valid: false, reason: 'CreateTransaction has no params.id.' };
        }
        // Money is reserved, not captured. Only PerformTransaction settles.
        return {
          valid: true,
          eventId: transactionEventId(method, transactionId),
          type: 'OTHER',
          providerRef: transactionId,
          ...stated(amountMinor),
          invoiceRef: orderId,
          raw: body,
        };
      }

      case 'PerformTransaction': {
        if (!transactionId) {
          return { valid: false, reason: 'PerformTransaction has no params.id.' };
        }
        // Payme sends only the transaction id here: no amount, no account. The
        // amount to post is the one recorded against this providerRef at
        // CreateTransaction time -- see `amountMinor` in ./types.ts.
        return {
          valid: true,
          eventId: transactionEventId(method, transactionId),
          type: 'PAYMENT_SUCCEEDED',
          providerRef: transactionId,
          ...stated(amountMinor),
          invoiceRef: orderId,
          raw: body,
        };
      }

      case 'CancelTransaction': {
        if (!transactionId) {
          return { valid: false, reason: 'CancelTransaction has no params.id.' };
        }
        const reason = readNumber(params, 'reason');
        // Payme does not say whether the transaction had been performed, so the
        // reason code is all we have to tell a refund from the abandonment of a
        // reservation. The finance layer must still reconcile against the stored
        // state of `providerRef` before reversing anything.
        const type: PaymentEventType =
          reason === PAYME_REASON_REFUND ? 'REFUNDED' : 'PAYMENT_FAILED';
        return {
          valid: true,
          eventId: transactionEventId(method, transactionId),
          type,
          providerRef: transactionId,
          ...stated(amountMinor),
          invoiceRef: orderId,
          raw: body,
        };
      }

      default:
        // CheckTransaction, GetStatement, and anything Payme adds later. The
        // request is authentic, so it is stored and acknowledged; the handler
        // answers unknown methods with PAYME_ERROR_CODES.methodNotFound.
        return {
          valid: true,
          eventId: transactionId
            ? transactionEventId(method, transactionId)
            : bodyEventId(method, input.rawBody),
          type: 'OTHER',
          providerRef: transactionId ?? orderId ?? '',
          ...stated(amountMinor),
          invoiceRef: orderId,
          raw: body,
        };
    }
  },
};

/** Exposed so unit tests can build a valid Basic header without the driver. */
export const __testing = { encodeCheckoutPayload, authenticate, PAYME_BASIC_LOGIN };
