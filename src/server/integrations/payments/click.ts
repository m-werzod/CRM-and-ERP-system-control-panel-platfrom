/**
 * Click (Uzbekistan) Merchant API -- the SHOP-API two-stage callback.
 *
 *   Prepare  (action=0)  "a payer wants to pay this order" -- we answer with a
 *                        merchant_prepare_id and nothing is settled.
 *   Complete (action=1)  "the money moved" -- this is the one that settles, and
 *                        it echoes back the merchant_prepare_id we issued.
 *
 * Authentication is an md5 digest of a fixed concatenation that includes the
 * shared secret. md5 is not our choice; it is what the protocol specifies. What
 * saves the scheme is that the secret is inside the digested string, so the
 * digest cannot be produced without it -- but only if the comparison is done in
 * constant time, which is why `timingSafeEqualString` is used below.
 *
 * Click quotes amounts in som (major units) with decimals, unlike Payme. The
 * conversion to tiyin happens here, through `parseMoneyInput`, so no float ever
 * touches it -- and the signature is computed over the amount string exactly as
 * Click sent it, never over a reformatted number.
 */

import { money, parseMoneyInput, toMajorString } from '@/lib/money';
import { env } from '@/server/env';
import { BusinessRuleError, IntegrationNotConfiguredError } from '@/server/errors';
import { logger } from '@/server/observability/logger';
import { md5Hex, parseFormOrJsonFields, timingSafeEqualString } from './signature';
import type {
  CheckoutSession,
  CreateCheckoutInput,
  PaymentEventType,
  PaymentGatewayProvider,
  ProviderHealth,
  WebhookInput,
  WebhookVerification,
} from './types';

export const CLICK_PROVIDER_KEY = 'click';

/** Click settles in som only. */
const CLICK_CURRENCY = 'UZS';

const CHECKOUT_BASE_URL = 'https://my.click.uz/services/pay';

const ACTION_PREPARE = '0';
const ACTION_COMPLETE = '1';

/**
 * Codes Click expects in the `error` field of our reply. It branches on these,
 * not on the HTTP status, so a handler that answers 500 leaves Click retrying.
 */
export const CLICK_ERROR_CODES = {
  success: 0,
  signCheckFailed: -1,
  incorrectAmount: -2,
  actionNotFound: -3,
  alreadyPaid: -4,
  userNotFound: -5,
  transactionNotFound: -6,
  failedToUpdate: -7,
  badRequest: -8,
  transactionCancelled: -9,
} as const;

interface ClickCredentials {
  /**
   * Click's redirect form requires the numeric *Service ID* from the merchant
   * cabinet, and the validated environment exposes exactly one Click identifier
   * (`CLICK_MERCHANT_ID`), so that variable must hold the Service ID. The
   * optional `merchant_id` parameter is omitted rather than guessed from the same
   * value: a wrong merchant_id makes Click reject the link, and guessing would
   * trade a clear configuration error for a confusing gateway one. A deployment
   * whose two identifiers differ needs a CLICK_SERVICE_ID added to the env
   * schema, which lives outside this module.
   */
  readonly serviceId: string;
  readonly secretKey: string;
}

function credentials(): ClickCredentials | null {
  const serviceId = env.CLICK_MERCHANT_ID;
  const secretKey = env.CLICK_SECRET_KEY;
  if (!serviceId || !secretKey) return null;
  return { serviceId, secretKey };
}

/**
 * The digested string differs per stage: Complete inserts the
 * `merchant_prepare_id` we returned at Prepare, which is what binds the two
 * halves of one payment together.
 *
 * Every component is taken as the raw string Click sent. Re-deriving `amount`
 * from a parsed number would turn "1000.00" into "1000" and fail every
 * signature.
 */
function expectedSignature(fields: Record<string, string>, secretKey: string): string | null {
  const action = fields['action'];
  const clickTransId = fields['click_trans_id'];
  const serviceId = fields['service_id'];
  const merchantTransId = fields['merchant_trans_id'];
  const amount = fields['amount'];
  const signTime = fields['sign_time'];

  if (
    action === undefined ||
    clickTransId === undefined ||
    serviceId === undefined ||
    merchantTransId === undefined ||
    amount === undefined ||
    signTime === undefined
  ) {
    return null;
  }

  if (action === ACTION_PREPARE) {
    return md5Hex(
      `${clickTransId}${serviceId}${secretKey}${merchantTransId}${amount}${action}${signTime}`,
    );
  }

  if (action === ACTION_COMPLETE) {
    const merchantPrepareId = fields['merchant_prepare_id'];
    if (merchantPrepareId === undefined) return null;
    return md5Hex(
      `${clickTransId}${serviceId}${secretKey}${merchantTransId}${merchantPrepareId}${amount}${action}${signTime}`,
    );
  }

  // An action we have no documented concatenation for cannot be verified, and an
  // unverifiable request is not an authentic one.
  return null;
}

export const clickPaymentProvider: PaymentGatewayProvider = {
  key: CLICK_PROVIDER_KEY,

  async health(): Promise<ProviderHealth> {
    const resolved = credentials();
    if (!resolved) {
      return {
        configured: false,
        message:
          'Set CLICK_MERCHANT_ID (the Service ID from the Click cabinet) and CLICK_SECRET_KEY, then register /api/webhooks/click as both the Prepare and Complete URL.',
      };
    }
    return { configured: true };
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const resolved = credentials();
    if (!resolved) {
      throw new IntegrationNotConfiguredError(
        'Click',
        'Click is selected but CLICK_MERCHANT_ID and CLICK_SECRET_KEY are not set.',
      );
    }

    if (input.currency !== CLICK_CURRENCY) {
      throw new BusinessRuleError(
        'payments.gateway_currency_unsupported',
        `Click can only collect ${CLICK_CURRENCY}; this invoice is in ${input.currency}.`,
      );
    }
    if (input.amountMinor <= 0n) {
      throw new BusinessRuleError(
        'payments.checkout_amount_not_positive',
        'A payment link needs an amount greater than zero.',
      );
    }

    // `transaction_param` is the only value that returns as `merchant_trans_id`,
    // so it has to be the key an invoice can be found by.
    const url = new URL(CHECKOUT_BASE_URL);
    url.searchParams.set('service_id', resolved.serviceId);
    url.searchParams.set('amount', toMajorString(money(input.amountMinor, input.currency)));
    url.searchParams.set('transaction_param', input.invoiceId);
    url.searchParams.set('return_url', input.returnUrl);

    return {
      checkoutUrl: url.toString(),
      // Click mints its click_trans_id only once the payer commits, so the order
      // key is the best reference available at this point.
      providerRef: input.invoiceId,
    };
  },

  async verifyWebhook(input: WebhookInput): Promise<WebhookVerification> {
    const resolved = credentials();
    if (!resolved) {
      return { valid: false, reason: 'Click is not configured; no callback can be authenticated.' };
    }

    const fields = parseFormOrJsonFields(input.rawBody);
    if (!fields) {
      return { valid: false, reason: 'Body is neither form-encoded nor a JSON object.' };
    }

    const presented = fields['sign_string'];
    if (!presented) {
      return { valid: false, reason: 'Callback carries no sign_string.' };
    }

    const expected = expectedSignature(fields, resolved.secretKey);
    if (!expected) {
      return {
        valid: false,
        reason: 'Callback is missing fields the signature covers, or uses an unsupported action.',
      };
    }

    // Hex case is not secret, so normalising before the constant-time compare
    // costs nothing and tolerates a gateway that upper-cases its digest.
    if (!timingSafeEqualString(presented.toLowerCase(), expected.toLowerCase())) {
      logger.warn('payments.click.webhook_signature_mismatch', {
        clickTransId: fields['click_trans_id'],
        action: fields['action'],
      });
      return { valid: false, reason: 'sign_string does not match.' };
    }

    const action = fields['action'];
    const clickTransId = fields['click_trans_id'] ?? '';
    const merchantTransId = fields['merchant_trans_id'];
    const rawAmount = fields['amount'] ?? '';

    let amountMinor: bigint;
    try {
      amountMinor = parseMoneyInput(rawAmount, CLICK_CURRENCY).amountMinor;
    } catch {
      // The signature checked out, so this is a scaling or format change on
      // Click's side rather than an attack -- and guessing the amount is the one
      // thing we must not do.
      return { valid: false, reason: 'Amount is not a value this currency can represent.' };
    }

    // Click's `error` is its own verdict on the attempt: 0 means it went through,
    // anything negative means it did not. A Complete carrying a negative error
    // for a payment that already settled is Click reversing it, and the finance
    // layer has to recognise a failure against a settled payment as exactly that
    // -- Click sends no prior state, and it reports refunds through the merchant
    // cabinet rather than as a distinct callback type.
    const errorCode = Number(fields['error'] ?? '0');
    const failed = Number.isFinite(errorCode) && errorCode < 0;

    const stage = action === ACTION_PREPARE ? 'Prepare' : 'Complete';
    const type: PaymentEventType = failed
      ? 'PAYMENT_FAILED'
      : action === ACTION_COMPLETE
        ? 'PAYMENT_SUCCEEDED'
        : // Prepare settles nothing; answering it is the finance layer's job.
          'OTHER';

    return {
      valid: true,
      // Click numbers transactions, not events, and sends the same
      // click_trans_id for both stages -- so the stage is part of the identity,
      // or Complete would look like a replay of Prepare and the payment would be
      // dropped.
      eventId: `${stage}:${clickTransId}`,
      type,
      providerRef: clickTransId,
      amountMinor,
      currency: CLICK_CURRENCY,
      invoiceRef: merchantTransId,
      raw: fields,
    };
  },
};

/**
 * Exposed for unit tests, which need to produce a valid digest without importing
 * the secret handling.
 *
 * Note for whoever writes the route handler: Click's signature covers `sign_time`
 * but the protocol defines no tolerance window and no nonce, so a captured
 * callback stays replayable forever. The only thing that stops a replay is the
 * unique `(provider, externalId)` on WebhookEvent -- which is why the event id
 * above must stay deterministic.
 */
export const __testing = { expectedSignature };
