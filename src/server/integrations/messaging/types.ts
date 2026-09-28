/**
 * The messaging provider contract.
 *
 * Email, SMS, Telegram and WhatsApp are reduced to the same four members so the
 * notification outbox can dispatch a queued row without knowing which vendor is
 * behind it, and so replacing Eskiz with Play Mobile is a configuration change
 * rather than a code change.
 *
 * `send` does not throw when a message is rejected. A gateway refusing a message
 * is not an application bug, it is a fact about that message, and the outbox
 * needs it as data so it can choose between retrying, parking the row and giving
 * up. Exceptions are reserved for "this provider cannot run at all", which is an
 * `IntegrationNotConfiguredError` and a different operational problem.
 */

export type MessageChannel = 'EMAIL' | 'SMS' | 'TELEGRAM' | 'WHATSAPP';

export interface OutboundMessage {
  /** An email address, an E.164 phone number, or a Telegram chat id. */
  readonly to: string;
  /** Email only. Channels without a subject line ignore it. */
  readonly subject?: string;
  /** Plain text. Always required: it is the fallback every channel can carry. */
  readonly body: string;
  /** Rich alternative for the channels that accept markup (email, Telegram). */
  readonly html?: string;
  /**
   * Opaque correlation data for the provider's own dashboards -- a notification
   * id, an organisation id. Never PII and never a secret: some providers echo it
   * back in webhooks and store it indefinitely.
   */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SendSuccess {
  readonly status: 'SENT';
  /** The provider's own id, for reconciliation and webhook correlation. */
  readonly providerRef?: string;
  /** SMS only. Billable parts the text was split into. */
  readonly segments?: number;
  /** Only when the provider reports a price at send time; most do not. */
  readonly costMinor?: bigint;
  readonly currency?: string;
}

/**
 * `retryable` is the load-bearing field. A transport problem (5xx, 429, a
 * timeout) will probably succeed on a later attempt, while a malformed address,
 * a bot the user blocked or a hard bounce will fail identically forever. Without
 * the distinction the outbox either abandons recoverable sends or spends the
 * organisation's SMS quota re-sending to a number that cannot exist.
 */
export interface SendFailure {
  readonly status: 'FAILED';
  /** Stable machine code: the provider's own, or `HTTP_<status>`. */
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
}

/**
 * Nothing was attempted and nothing is wrong. A channel with no provider
 * configured reports this so a missing SMS gateway leaves the notification row
 * honestly unsent instead of failing the work that queued it.
 */
export interface SendSkipped {
  readonly status: 'SKIPPED';
  readonly reason: string;
}

export type SendResult = SendSuccess | SendFailure | SendSkipped;

export interface ProviderHealth {
  /** True when the provider has everything it needs to attempt a send. */
  readonly configured: boolean;
  /** Shown verbatim in the settings UI, so it must name what is missing. */
  readonly message?: string;
}

export interface MessageProvider {
  readonly channel: MessageChannel;
  /** Stable identifier persisted as `CommunicationLog.provider`. */
  readonly key: string;
  /**
   * Credential presence only -- deliberately no network call. A settings page
   * renders every channel at once, and a health check that reached out to five
   * gateways per page view would be a self-inflicted load test with a timeout
   * budget to match.
   */
  health(): Promise<ProviderHealth>;
  send(message: OutboundMessage): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// Address masking
// ---------------------------------------------------------------------------

/**
 * A fixed-width mask, not one character per hidden character, so the result
 * cannot be used to recover the length of the original.
 */
const DIGIT_MASK = '*****';
const HANDLE_MASK = '***';
const OPAQUE = '***';

/** Below this, revealing both ends would reveal most of the number. */
const MIN_DIGITS_FOR_PREFIX = 9;

/**
 * Reduce a recipient address to the form `CommunicationLog` stores.
 *
 * That table is a reconciliation and billing record: it needs to identify a send
 * well enough to match a delivery receipt, and it is queried by support staff
 * across the whole organisation. Storing full addresses would turn it into a
 * mirror of the contact database with none of its access controls -- the
 * notification row alongside already names the recipient for anyone entitled to
 * see it.
 */
export function maskAddress(channel: MessageChannel, to: string): string {
  const value = to.trim();
  if (value === '') return OPAQUE;

  switch (channel) {
    case 'EMAIL':
      return maskEmail(value);
    case 'TELEGRAM':
      // A chat id carries no country or operator prefix worth preserving, so
      // only the tail is kept -- enough to pair a send with its webhook.
      return value.startsWith('@') ? maskHandle(value) : maskTail(value);
    case 'SMS':
    case 'WHATSAPP':
      return maskDigits(value);
  }
}

function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  // `at === 0` would leave no local part to mask, so it is not an address.
  if (at <= 0 || at === value.length - 1) return maskHandle(value);
  return `${value.slice(0, 1)}${HANDLE_MASK}@${value.slice(at + 1)}`;
}

function maskHandle(value: string): string {
  const head = value.startsWith('@') ? value.slice(0, 2) : value.slice(0, 1);
  return `${head}${HANDLE_MASK}`;
}

function maskDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS_FOR_PREFIX) return maskTail(digits);
  // The country and operator prefix is not identifying and makes the log
  // readable at a glance; the subscriber part is what must not be stored.
  const plus = value.startsWith('+') ? '+' : '';
  return `${plus}${digits.slice(0, 4)}${DIGIT_MASK}${digits.slice(-4)}`;
}

function maskTail(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits === '') return OPAQUE;
  return `${DIGIT_MASK}${digits.slice(-4)}`;
}
