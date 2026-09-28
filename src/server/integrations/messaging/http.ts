/**
 * Shared HTTP plumbing for the messaging providers.
 *
 * No vendor SDK is installed and none is needed: each provider here is a single
 * HTTP call, and a call written in this repository is easier to audit than a
 * dependency that brings its own retry policy, its own logging and its own idea
 * of a timeout.
 *
 * Two rules every provider inherits from this module:
 *
 * 1. Every request carries `AbortSignal.timeout`. A gateway that accepts the
 *    connection and then never answers would otherwise pin a queue worker until
 *    the process restarts, so one unreachable provider stalls every channel.
 * 2. Nothing about the request is logged except the label the caller passes. The
 *    Telegram Bot API puts its token in the URL path, and headers carry bearer
 *    tokens and Basic credentials. The logger redacts by key name, which cannot
 *    help it when the secret is a substring of a URL -- so neither the URL nor
 *    the headers are ever handed to it.
 */

import { logger } from '@/server/observability/logger';
import { maskAddress, type MessageChannel, type SendFailure, type SendResult } from './types';

/**
 * Long enough for a slow Uzbek gateway on a bad day, short enough that a stuck
 * provider does not outlive the job waiting on it.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Provider error bodies are frequently a whole HTML error page. Keep a sample. */
const MAX_BODY_CHARS = 1_000;
const MAX_MESSAGE_CHARS = 400;

export interface HttpRequest {
  /** Appears in logs in place of the URL. Must never contain a credential. */
  readonly label: string;
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
  readonly timeoutMs?: number;
}

export type HttpOutcome =
  | { readonly kind: 'RESPONSE'; readonly status: number; readonly body: string }
  | {
      readonly kind: 'TRANSPORT';
      readonly errorCode: 'TIMEOUT' | 'NETWORK_ERROR';
      readonly errorMessage: string;
    };

/**
 * Perform one provider call. Never throws for an HTTP status or a dead socket:
 * both are outcomes a provider has to map onto a `SendResult`, and an exception
 * here would lose the distinction between "retry later" and "never retry".
 */
export async function providerFetch(request: HttpRequest): Promise<HttpOutcome> {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs ?? PROVIDER_TIMEOUT_MS),
      // Provider endpoints are not cacheable, and a stale 200 replayed from a
      // cache would be recorded as a delivered message.
      cache: 'no-store',
      redirect: 'follow',
    });

    const text = await response.text().catch(() => '');
    return { kind: 'RESPONSE', status: response.status, body: truncate(text, MAX_BODY_CHARS) };
  } catch (error) {
    return classifyTransportError(request.label, error);
  }
}

function classifyTransportError(label: string, error: unknown): HttpOutcome {
  // AbortSignal.timeout aborts with a TimeoutError; an explicit abort or an older
  // runtime surfaces AbortError. Both mean the same thing to the caller.
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';

  logger.warn('messaging.provider.transport_error', {
    provider: label,
    reason: timedOut ? 'timeout' : 'network',
    // A fetch failure message names a host and a port, never a credential.
    detail: truncate(error instanceof Error ? error.message : String(error), MAX_MESSAGE_CHARS),
  });

  return timedOut
    ? { kind: 'TRANSPORT', errorCode: 'TIMEOUT', errorMessage: `${label} did not answer in time.` }
    : {
        kind: 'TRANSPORT',
        errorCode: 'NETWORK_ERROR',
        errorMessage: `${label} could not be reached.`,
      };
}

// ---------------------------------------------------------------------------
// Status -> retryable
// ---------------------------------------------------------------------------

/**
 * 5xx is the provider's problem, 429 and 408 are explicitly "come back later".
 * Every other 4xx is a statement about the request itself and will be rejected
 * identically on every future attempt.
 */
export function retryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408 || status === 425;
}

export function transportFailure(
  outcome: Extract<HttpOutcome, { kind: 'TRANSPORT' }>,
): SendFailure {
  return {
    status: 'FAILED',
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    retryable: true,
  };
}

export function statusFailure(
  status: number,
  options: {
    readonly errorCode?: string;
    readonly errorMessage?: string;
    /** Override only when the provider's own code is more precise than the status. */
    readonly retryable?: boolean;
  } = {},
): SendFailure {
  return {
    status: 'FAILED',
    errorCode: options.errorCode ?? `HTTP_${status}`,
    errorMessage: truncate(
      options.errorMessage ?? `The provider answered HTTP ${status}.`,
      MAX_MESSAGE_CHARS,
    ),
    retryable: options.retryable ?? retryableStatus(status),
  };
}

export function truncate(value: string, max = MAX_MESSAGE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/** Built here so no provider hand-rolls base64 against its own credentials. */
export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Reading untrusted JSON
//
// A provider response is unknown input. These helpers narrow one field at a time
// so a missing or differently-typed field degrades to `undefined` rather than
// throwing inside a queue worker halfway through a batch.
// ---------------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(text: string): JsonObject | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A load balancer answering with HTML is a routine shape here, not an
    // exception worth propagating.
    return null;
  }
}

export function objectField(source: JsonObject | null, key: string): JsonObject | null {
  const value = source?.[key];
  return isRecord(value) ? value : null;
}

export function firstArrayObject(source: JsonObject | null, key: string): JsonObject | null {
  const value = source?.[key];
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return isRecord(first) ? first : null;
}

/** Numbers are accepted because provider ids arrive as both `7` and `"7"`. */
export function stringField(source: JsonObject | null, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

export function numberField(source: JsonObject | null, key: string): number | undefined {
  const value = source?.[key];
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * One line per attempt, with the address already masked -- a provider must not be
 * the place a full phone number enters the log stream. Successes log at `debug`
 * because the outbox records them durably anyway; failures log at `warn` because
 * they are what someone is eventually paged about.
 */
export function logSendOutcome(
  provider: string,
  channel: MessageChannel,
  to: string,
  result: SendResult,
): void {
  const base = { provider, channel, to: maskAddress(channel, to) };

  if (result.status === 'FAILED') {
    logger.warn('messaging.send.failed', {
      ...base,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      retryable: result.retryable,
    });
    return;
  }

  if (result.status === 'SKIPPED') {
    logger.debug('messaging.send.skipped', { ...base, reason: result.reason });
    return;
  }

  logger.debug('messaging.send.sent', {
    ...base,
    providerRef: result.providerRef,
    segments: result.segments,
  });
}
