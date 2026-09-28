/**
 * Browser-side calls into the JSON API.
 *
 * Two jobs. It echoes the CSRF cookie back in the header, which is the contract
 * `verifyCsrf` enforces on every unsafe method. And it never throws: a network
 * failure comes back in the same envelope as a 422, so a form has one code path
 * for "it did not work" instead of a try/catch wrapped around every submit.
 */

import { CSRF_COOKIE, CSRF_HEADER } from '@/lib/auth-tokens';
import type { PlainTranslationKey, Translator } from '@/lib/i18n';
import type { ApiFailure, ApiResponse } from '@/server/http/api';

/** Synthesised locally, so it cannot collide with a server `ErrorCode`. */
const NETWORK_FAILURE = 'NETWORK';

function readCookie(name: string): string | null {
  // Guarded rather than assumed: this module is plain TypeScript and nothing
  // stops a server component from importing it by mistake.
  if (typeof document === 'undefined') return null;

  for (const part of document.cookie.split('; ')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }
  return null;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<ApiResponse<T>> {
  const csrfToken = readCookie(CSRF_COOKIE);

  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Absent before the first sign-in, which is correct: a PUBLIC route
        // takes no CSRF check because there is no session to protect yet.
        ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
      },
      body: JSON.stringify(body ?? {}),
      // The session cookie is same-origin and httpOnly; this is explicit so a
      // future change of `fetch` defaults cannot quietly drop it.
      credentials: 'same-origin',
    });

    // The envelope is the same on success and failure, so the status code is
    // only consulted when the body is not JSON at all (a proxy error page).
    const parsed: unknown = await response.json();
    if (isApiResponse<T>(parsed)) return parsed;

    return networkFailure(`Unexpected response (HTTP ${response.status})`);
  } catch {
    return networkFailure('fetch failed');
  }
}

function isApiResponse<T>(value: unknown): value is ApiResponse<T> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

function networkFailure(message: string): ApiFailure {
  return { ok: false, error: { code: NETWORK_FAILURE, message }, requestId: '' };
}

/**
 * Server `ErrorCode` to dictionary key.
 *
 * Only codes whose meaning is fixed are listed. `BUSINESS_RULE_VIOLATED` and
 * friends are absent on purpose: their message is written by the rule that
 * failed and says something a generic string cannot.
 */
const MESSAGE_KEYS: Readonly<Record<string, PlainTranslationKey>> = {
  [NETWORK_FAILURE]: 'errors.network',
  VALIDATION_FAILED: 'errors.validation',
  UNAUTHENTICATED: 'auth.invalidCredentials',
  SESSION_EXPIRED: 'errors.sessionExpired',
  FORBIDDEN: 'errors.forbidden',
  PERMISSION_DENIED: 'errors.forbidden',
  OUT_OF_SCOPE: 'errors.forbiddenBranch',
  CSRF_FAILED: 'errors.csrf',
  ACCOUNT_INACTIVE: 'auth.accountInactive',
  NOT_FOUND: 'errors.notFound',
  CONFLICT: 'errors.conflict',
  DATABASE_UNAVAILABLE: 'errors.databaseUnavailable',
  INTERNAL: 'errors.serverError',
};

/**
 * The sentence to show a user for a failed call.
 *
 * A server `publicMessage` is already human-readable but always English, so a
 * mapped key wins where one exists. Where none does, the specific English
 * message beats a vague translated one -- "That code is not valid" tells the
 * user what to do; "Something went wrong" does not.
 */
export function failureMessage(t: Translator, failure: ApiFailure): string {
  // Handled ahead of the table because it is the one mapped message that
  // interpolates, and the table is deliberately typed to reject such keys.
  if (failure.error.code === 'RATE_LIMITED') {
    const seconds = failure.error.details?.['retryAfterSeconds'];
    return t.t('errors.rateLimited', { seconds: typeof seconds === 'number' ? seconds : 60 });
  }

  const key = MESSAGE_KEYS[failure.error.code];
  if (key) return t.t(key);
  if (failure.error.message) return failure.error.message;
  return t.t('errors.generic');
}

/**
 * Field name to message, for attaching server-side issues to inputs.
 *
 * `apiRoute` prefixes every path with the part of the request it validated
 * (`body.newPassword`, `query.page`), which a form does not know about -- its
 * inputs are named after the schema. The prefix is stripped here rather than at
 * each call site, so a form looks up `newPassword` and gets it.
 */
const SOURCE_PREFIX = /^(?:body|query|params)\./;

export function fieldIssuesOf(failure: ApiFailure): Readonly<Record<string, string>> {
  const issues: Record<string, string> = {};

  for (const issue of failure.error.fieldIssues ?? []) {
    const field = issue.path.replace(SOURCE_PREFIX, '');
    // A whole-object refine carries no field of its own; its message is already
    // the one shown at the top of the form.
    if (!field) continue;
    // First issue per field wins: three messages under one input is noise, and
    // the first is the one the schema reached first.
    issues[field] ??= issue.message;
  }

  return issues;
}
