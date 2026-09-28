/**
 * The names of the two session cookies and the CSRF header.
 *
 * In `@/lib` rather than beside the session code because the browser needs the
 * CSRF names too -- it reads that cookie and echoes the value back in the
 * header. Importing `@/server/auth/session` from a client bundle to get them
 * would drag prisma and the environment parser along with it, and a second copy
 * of the literals is a contract waiting to drift.
 */

export const SESSION_COOKIE = 'edu_session';
export const CSRF_COOKIE = 'edu_csrf';
export const CSRF_HEADER = 'x-csrf-token';
