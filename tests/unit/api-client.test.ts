/**
 * The browser's half of the error envelope.
 *
 * Worth unit-testing despite being small: `fieldIssuesOf` shipped once keyed on
 * the raw path, so every server-side field error was silently dropped and the
 * form showed only the generic banner. Nothing crashed, nothing logged -- the
 * messages simply never appeared, which is exactly the class of bug a test
 * catches and a click-through does not.
 */

import { describe, expect, it } from 'vitest';
import { failureMessage, fieldIssuesOf } from '@/lib/api-client';
import { createTranslator } from '@/lib/i18n';
import type { ApiFailure } from '@/server/http/api';

const t = createTranslator('EN', 'Asia/Tashkent');

function failure(error: ApiFailure['error']): ApiFailure {
  return { ok: false, error, requestId: 'test-request' };
}

describe('fieldIssuesOf', () => {
  it('strips the request-source prefix that apiRoute prepends', () => {
    const issues = fieldIssuesOf(
      failure({
        code: 'VALIDATION_FAILED',
        message: 'The submitted data is not valid.',
        fieldIssues: [{ path: 'body.newPassword', message: 'Use at least 10 characters' }],
      }),
    );

    expect(issues).toEqual({ newPassword: 'Use at least 10 characters' });
  });

  it('strips the query and params sources too', () => {
    const issues = fieldIssuesOf(
      failure({
        code: 'VALIDATION_FAILED',
        message: '',
        fieldIssues: [
          { path: 'query.page', message: 'Enter a whole number' },
          { path: 'params.id', message: 'Not a valid id' },
        ],
      }),
    );

    expect(issues).toEqual({ page: 'Enter a whole number', id: 'Not a valid id' });
  });

  it('keeps a nested path below the source segment', () => {
    const issues = fieldIssuesOf(
      failure({
        code: 'VALIDATION_FAILED',
        message: '',
        fieldIssues: [{ path: 'body.address.city', message: 'Required' }],
      }),
    );

    expect(issues).toEqual({ 'address.city': 'Required' });
  });

  it('keeps the first message when one field breaks several rules', () => {
    const issues = fieldIssuesOf(
      failure({
        code: 'VALIDATION_FAILED',
        message: '',
        fieldIssues: [
          { path: 'body.newPassword', message: 'Use at least 10 characters' },
          { path: 'body.newPassword', message: 'Include both upper and lower case letters' },
        ],
      }),
    );

    expect(issues['newPassword']).toBe('Use at least 10 characters');
  });

  it('drops a whole-object refine, which names no field to attach to', () => {
    const issues = fieldIssuesOf(
      failure({
        code: 'VALIDATION_FAILED',
        message: '',
        fieldIssues: [{ path: 'body.', message: 'The dates overlap' }],
      }),
    );

    expect(issues).toEqual({});
  });

  it('returns an empty map when the failure carries no field issues', () => {
    expect(fieldIssuesOf(failure({ code: 'FORBIDDEN', message: 'no' }))).toEqual({});
  });
});

describe('failureMessage', () => {
  it('translates a mapped error code rather than echoing the server English', () => {
    const message = failureMessage(t, failure({ code: 'FORBIDDEN', message: 'Nope.' }));
    expect(message).toBe('You do not have permission to do that.');
  });

  it('interpolates the retry delay a rate limit reports', () => {
    const message = failureMessage(
      t,
      failure({ code: 'RATE_LIMITED', message: '', details: { retryAfterSeconds: 42 } }),
    );

    expect(message).toBe('Too many requests. Try again in 42 seconds.');
  });

  it('still produces a sentence when a rate limit omits the delay', () => {
    const message = failureMessage(t, failure({ code: 'RATE_LIMITED', message: '' }));
    expect(message).toContain('Too many requests');
  });

  it('prefers the specific server message for a code with no mapping', () => {
    const message = failureMessage(
      t,
      failure({ code: 'BUSINESS_RULE_VIOLATED', message: 'Your current password is not correct.' }),
    );

    expect(message).toBe('Your current password is not correct.');
  });

  it('falls back to the generic sentence when there is nothing else to show', () => {
    expect(failureMessage(t, failure({ code: 'SOMETHING_NEW', message: '' }))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('reports a transport failure as a network problem, not a server error', () => {
    const message = failureMessage(t, failure({ code: 'NETWORK', message: 'fetch failed' }));
    expect(message).toBe('The server could not be reached. Check your connection.');
  });
});
