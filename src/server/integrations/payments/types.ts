/**
 * The payment gateway contract.
 *
 * One interface for every gateway, and an honest `manual` implementation for the
 * institutions -- most of them -- that take cash and bank transfers and have no
 * gateway at all. Code that records money never branches on the provider name:
 * it asks for a checkout, or hands a raw callback body over to be verified, and
 * the provider either does the job or says plainly that it cannot.
 *
 * Money crosses this boundary as `bigint` minor units plus an ISO-4217 code,
 * exactly as everywhere else (see `@/lib/money`). A gateway that quotes amounts
 * in major units -- Click does -- converts at its own edge so that no float ever
 * reaches the ledger.
 */

/**
 * What a callback means for the money, reduced to the four cases the finance
 * layer can act on. Gateways send far more event types than this; everything
 * that does not move money is `OTHER` and exists only to be stored and
 * acknowledged.
 */
export type PaymentEventType = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'REFUNDED' | 'OTHER';

export interface CreateCheckoutInput {
  /** Our invoice id. Sent to the gateway so its callback can name the invoice. */
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  /** ISO-4217. A gateway that cannot settle it must refuse, not approximate. */
  readonly currency: string;
  /** Where the payer's browser lands afterwards. Never a source of truth. */
  readonly returnUrl: string;
  /**
   * Caller-supplied key that makes a retried creation safe. Stripe accepts one
   * and is given it, so a retry returns the first session instead of opening a
   * second.
   *
   * Payme and Click accept no such key and deliberately ignore this one: their
   * order reference is the only value that comes back on the callback, so it has
   * to stay the bare invoice id or the callback can no longer be matched to an
   * invoice. For them a retried creation simply mints another link to the same
   * order, which settles once because the gateway numbers the transaction and
   * `(provider, externalId)` is unique.
   */
  readonly idempotencyKey: string;
  /** Shown to the payer on the gateway's own page. */
  readonly description: string;
  /** Echoed back on the callback where the gateway supports it. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CheckoutSession {
  /** Absolute URL to redirect the payer to. */
  readonly checkoutUrl: string;
  /** The gateway's id for this attempt, stored on `Payment.providerRef`. */
  readonly providerRef: string;
}

export interface WebhookInput {
  /**
   * The body EXACTLY as received. Signatures cover these bytes, so a
   * re-serialised object -- different key order, different whitespace -- verifies
   * against nothing.
   */
  readonly rawBody: string;
  /** Header names are matched case-insensitively; any casing is accepted. */
  readonly headers: Record<string, string>;
}

/** A callback whose signature checked out and whose meaning we understood. */
export interface WebhookVerified {
  readonly valid: true;
  /**
   * Stable identity of this event, unique per logical occurrence. Stored as
   * `WebhookEvent.externalId`, which is unique together with `provider` -- so
   * this value is what makes redelivery a no-op. Where a gateway numbers
   * transactions rather than events, the stage is folded in (Payme sends the
   * same transaction id for CreateTransaction and PerformTransaction, which are
   * two different events about one transaction).
   */
  readonly eventId: string;
  readonly type: PaymentEventType;
  /** The gateway's transaction id, to reconcile against `Payment.providerRef`. */
  readonly providerRef: string;
  /**
   * Minor units. `0n` when the gateway sent no amount on this particular
   * callback -- Payme's PerformTransaction carries only a transaction id, for
   * instance. `0n` therefore means "not stated", never "nothing was paid": the
   * authoritative amount is the one already recorded against `providerRef`.
   */
  readonly amountMinor: bigint;
  /** ISO-4217, upper case. Empty string when the gateway sent no amount. */
  readonly currency: string;
  /** Our own reference as the gateway echoed it back, usually the invoice id. */
  readonly invoiceRef?: string;
  /** The parsed body, stored verbatim on `WebhookEvent.payload`. */
  readonly raw: unknown;
}

export interface WebhookRejected {
  readonly valid: false;
  /**
   * Why verification failed, for the log and for `WebhookEvent.error`. Safe to
   * store: it never quotes the secret or the presented signature.
   */
  readonly reason: string;
}

/**
 * Discriminated so a caller cannot read `amountMinor` off an unverified event --
 * the fields simply do not exist until `valid` has been narrowed to `true`.
 */
export type WebhookVerification = WebhookVerified | WebhookRejected;

export interface ProviderHealth {
  readonly configured: boolean;
  /** Present when not configured, or when configured with a caveat. */
  readonly message?: string;
}

export interface PaymentGatewayProvider {
  /** Matches the `PAYMENT_PROVIDER` env value and `Payment.providerKey`. */
  readonly key: string;

  /**
   * Whether this provider could actually transact right now. Cheap and offline:
   * it inspects configuration only, so the settings screen can render a row per
   * provider without issuing network calls.
   */
  health(): Promise<ProviderHealth>;

  /**
   * Start a hosted payment. Throws `IntegrationNotConfiguredError` when the
   * provider has no credentials and `IntegrationFailedError` when the gateway
   * refuses -- never returns a fabricated URL.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;

  /**
   * Authenticate a callback and translate it. Returns a rejection rather than
   * throwing for anything an untrusted caller controls -- a bad signature is a
   * normal, expected event and the route handler answers it with the gateway's
   * own error shape.
   */
  verifyWebhook(input: WebhookInput): Promise<WebhookVerification>;
}

/** Shape `describePaymentProvider()` returns for the settings screen. */
export interface PaymentProviderDescription extends ProviderHealth {
  readonly key: string;
  readonly label: string;
  /** False for `manual`: there is nothing to redirect a payer to. */
  readonly supportsCheckout: boolean;
  readonly supportsWebhooks: boolean;
  /** Route the gateway must be pointed at, relative to `APP_URL`. */
  readonly webhookPath: string | null;
  /** Currencies this gateway can settle; empty means "whatever the org uses". */
  readonly currencies: readonly string[];
}
