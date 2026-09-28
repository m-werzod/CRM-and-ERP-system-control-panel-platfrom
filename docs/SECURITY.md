# Security

## Authentication

**Server-side sessions, not JWTs.** A login mints a 32-byte opaque token; only its
SHA-256 hash is stored, so a leaked database yields no usable session. A stateless
JWT cannot be revoked, and "deactivate this user" has to mean it immediately.

Two expiries, both enforced on every request:

- `expiresAt` — idle timeout, slid forward on use. The slide only writes once a
  quarter of the window has elapsed, so a page view is not also a database write.
- `absoluteExpiresAt` — hard ceiling, never extended.

An expired session is **revoked**, not deleted, so the security log keeps the record
that it existed.

### Passwords

Argon2id at the OWASP-recommended parameters (19 MiB, t=2, p=1) via
`@node-rs/argon2`. Chosen over bcrypt for memory-hardness: bcrypt's 4 KiB working
set parallelises cheaply on a GPU, 19 MiB does not.

`needsRehash()` detects a hash produced with weaker parameters, so raising the cost
factor later reaches existing accounts transparently on next login rather than
needing a forced reset.

Policy weights length far above character classes, because length is what actually
resists guessing and a class requirement pushes people toward `Password1!`.

### Account enumeration

`fakeVerifyForTiming()` performs a dummy Argon2 verify against a real hash when the
submitted email does not exist. Without it, "unknown email" returns in ~1 ms while
"wrong password" takes ~15 ms — a reliable oracle for harvesting valid addresses.
Login failures return one indistinguishable message regardless of cause.

Every attempt, successful or not, is recorded in `LoginAttempt` — including the
submitted email when no such user exists, because that is exactly the signal an
enumeration attempt produces.

### Brute force

Per-account lockout after `LOGIN_MAX_ATTEMPTS` consecutive failures for
`LOGIN_LOCKOUT_MINUTES`. This is the control that matters, and it is separate from
rate limiting: the per-IP login limit is deliberately generous because a whole
school shares one NAT address.

### Two-factor

TOTP (RFC 6238) implemented on `node:crypto`. Secrets are encrypted at rest with
AES-256-GCM (see below), never stored in plaintext. Verification checks adjacent
time steps for clock skew using a timing-safe comparison, and **returns the accepted
step** so the caller can record it and reject replay — a code is otherwise valid for
its whole 30-second window.

Recovery codes are single-use and stored hashed.

## Authorisation

Two orthogonal axes. See [ARCHITECTURE.md](ARCHITECTURE.md#authorisation-two-orthogonal-axes)
for the mechanism; what matters here is where it is enforced.

**Every sensitive operation checks server-side.** Hiding a button is not a control.
The navigation tree filters itself by permission as a UX affordance, and
`src/components/layout/navigation.ts` says so explicitly in a comment — the server
re-checks the same permission on the page and on every API call behind it, so a
hand-typed URL gains nothing.

`can()` **throws** on a permission key not in the catalogue. A typo'd string that
silently denied would be a latent hole; one that silently allowed would be a breach.

### Scope is a WHERE clause

```ts
// list: filter, never 403 — a list endpoint returns the caller's subset
const where = composeReadFilter(ctx, { selfFilter: selfStudentFilter(ctx), escapeHatch: 'students.view' });

// write: assert, because a mis-scoped create must fail loudly
const branchId = resolveWriteBranch(ctx, input.branchId, 'student');
```

A `BRANCH`-scoped user with no branch assignment gets `branchId: { in: [] }` —
matching nothing. Fail-closed by construction.

**Single-row fetches filter by scope in the same `where`** and throw `NotFoundError`
on a miss. Never fetch-then-check: with guessable ids (invoice numbers, student
codes) distinguishing "exists elsewhere" from "does not exist" leaks across
branches. `OutOfScopeError` is reserved for cases where the id is *not* guessable
and the operational advice differs ("ask an admin to add you to that branch").

### Privilege escalation

- `assertCanGrantRole` — cannot grant a role at or above your own `Role.level`.
- `assertCanAdministerUser` — cannot edit a peer or a superior.

Without these, anyone holding `users.manageRoles` could award themselves
`SUPER_ADMIN`.

### Separation of duties

Enforced in code, not left to procedure:

- A refund cannot be approved by the person who requested it.
- An attendance correction cannot be approved by the person who made it.
- A payroll run cannot be approved by the person who calculated it.

## CSRF

Double-submit token plus an `Origin` check, both required for unsafe methods.

The token's expected value is bound to the **session row** (`Session.csrfTokenHash`)
rather than being a global secret, so a token lifted from one user is useless
against another. Both checks are kept because they fail independently: the token
defends against a forged cross-site form post; the `Origin` check catches the case
where an attacker can somehow read or fixate the cookie but cannot forge a
browser-set header.

The session cookie is `httpOnly` — that is what limits an XSS bug to actions rather
than credential theft. The CSRF cookie deliberately is **not** httpOnly, because the
client must read it to echo it back; knowing it is useless without the session
cookie.

`sameSite: 'lax'` blocks cross-site POSTs while still allowing a normal top-level
navigation into the app from an email link.

## Rate limiting

Fixed-window counters with three drivers (memory / database / Redis interface). The
database driver's increment is a **single** `INSERT … ON CONFLICT DO UPDATE …
RETURNING` statement — read-then-write would let two simultaneous requests both see
`count = limit - 1`.

Covered: login, password reset, 2FA verification, public lead capture, financial
writes, bulk import, export, device posts, search, notification sends.

A missing client IP (no proxy configured) shares one bucket rather than being
treated as unlimited — restrictive, but safe. `X-Forwarded-For` is honoured **only**
when `TRUST_PROXY` is on; trusting it unconditionally would let any client spoof its
address and defeat the limit entirely.

A broken limiter fails **open** but logs at `error`. Taking the application down
because a counter table is unavailable is the wrong trade; a silent limiter failure
is a real incident.

## Input validation

Zod at every boundary, from the shared primitives in `src/lib/validation.ts`. The
client validates for feedback; the server re-validates because client input is never
trusted.

Sort fields use an **allow-list**. Passing a raw column name from the client to
`orderBy` lets a caller sort by `passwordHash` and learn things from the ordering.

Pagination limits are capped so a client cannot request 10 000 rows.

SQL injection is prevented by Prisma's parameterisation. Raw SQL is used only for
aggregates and always with bound parameters; the one place a value is interpolated
(a database name in the dev-DB script) validates it against `^[A-Za-z0-9_]+$` first.

## File uploads

Defence in depth, because a file is the one thing a user hands you that runs:

1. MIME **allow-list** — anything not listed is rejected. A deny-list would let the
   next novel container through.
2. Extension must match the declared MIME type.
3. **Magic-byte sniffing** — a `.jpg` that is really HTML can be used for stored XSS
   when served inline.
4. Size cap from `STORAGE_MAX_UPLOAD_MB`.
5. Filename sanitised for display/download only. **The storage key is always
   generated server-side** — `{org}/{ownerType}/{yyyy}/{mm}/{32-hex-random}{ext}` —
   so a crafted name cannot escape the store. The local driver additionally
   resolves the final path and asserts it stays inside the root.

Downloads go through an authorised route that checks the owning entity **and** the
document's `visibility`, then streams the bytes or issues a short-lived signed URL.
**No document is reachable by a guessable public path.** Response headers force
`Content-Disposition: attachment` with an RFC 5987 `filename*`, set
`X-Content-Type-Options: nosniff`, and downgrade anything that is not an image or
PDF to `application/octet-stream`.

`DocumentAccessLog` records every view and download when
`security.documentAccessLogging` is on.

## Biometric data

This is the area where the temptation to cut corners is highest, so the rules are
absolute.

**No raw biometric data is stored.** `BiometricEnrollment` holds only an opaque
provider-side reference plus the provider key — no image, no embedding, no template.
Deleting an enrollment calls the provider's `deleteEnrollment` so the reference does
not outlive the record.

**Consent is required and revocable.** Enrollment without a live, unrevoked
`BiometricConsent` is rejected when `security.requireBiometricConsent` is on. Below
`security.biometricGuardianConsentUnderAge`, the consent must come from a guardian
rather than the student.

**Nothing is faked.** `FaceIdentifyResult` is a discriminated union over
`MATCHED | NO_MATCH | LOW_CONFIDENCE | MULTIPLE_MATCHES | NOT_ENROLLED | ERROR |
NOT_CONFIGURED`, modelled so a caller cannot read a subject reference off a
non-match without a type error. Every outcome — including the failures — writes a
`FaceRecognitionEvent`. The mock provider performs no recognition, reports
`isRealRecognition: false`, and `env.ts` refuses to boot production with
`FACE_RECOGNITION_PROVIDER=mock`.

The logger redacts any key matching `/biometric/`, `/embedding/` or `/template.?ref/`.

## QR and device attendance

QR tokens are single-use, hashed at rest, and expire after
`attendance.qrTokenTtlSeconds` with a rotating index. Single-use plus a short TTL is
the entire threat model: it stops one student screenshotting the code and sharing it
with the class.

Device API keys are stored hashed with only the last four characters kept for
display, and a device may submit attendance **only for its own branch** — the
authorisation boundary for an unattended terminal.

## Webhooks

Signature verification is mandatory and **timing-safe** — a plain `===` on an HMAC
leaks the expected value byte by byte.

Signatures are computed over the **raw request body**, never a re-serialised JSON
object: key order and whitespace change the bytes.

Processing is idempotent on `(provider, externalId)`, which is a unique index, so a
replay is a no-op. Stripe-style timestamp tolerance rejects a captured webhook
replayed later.

## Secrets

Everything lives in `src/server/env.ts`, validated once at boot so a misconfigured
deployment fails immediately rather than at 2am inside a payment handler. It rejects
placeholder values left over from `.env.example`, and in production additionally
requires HTTPS, refuses `SESSION_SECRET === ENCRYPTION_KEY`, and refuses the mock
face provider.

Nothing outside `src/server/**` imports it. `IntegrationConfig.config` holds
non-secret settings only; credentials are referenced by env var **name** in
`secretRefs`.

Reversible encryption (currently only TOTP secrets) uses AES-256-GCM with a key
derived from `ENCRYPTION_KEY` by HKDF-SHA256 with a purpose-specific `info` string,
so one env value can safely serve several purposes. Ciphertext carries a `v1.`
prefix, which is what makes key rotation possible later.

## Logging

**Redaction is not optional.** Every value passed to the logger is walked and any key
matching a credential pattern — password, secret, token, cookie, authorization,
csrf, totp, signature, biometric, embedding, `database_url` and others — is replaced
with `[redacted]`. Depth, string length and array length are bounded, and circular
references are handled.

A logger that *can* leak a password is worse than no logger, and "remember not to log
the request body" is not a control.

Stack traces are logged, never returned. An unexpected error reaches the client as a
generic 500 with a `requestId` to quote to support.

## Audit trail

Every sensitive action writes an `AuditLog` row with actor, action, entity,
per-field before/after, reason, IP, user agent and request id. The table is
append-only at the database level.

Fields that must never appear even as a "changed value" — `passwordHash`,
`twoFactorSecret`, any `*Hash`, `externalRef`, `templateRef` — are redacted in the
diff. A user-update audit legitimately includes `passwordHash` in its field set, and
storing its before/after would put two password hashes in a table many people can
read.

For elevated actions (refunds, permission changes, attendance corrections,
write-offs, setting changes, biometric enrolment, data export) the audit write is
**not** best-effort: if it cannot be recorded, the action fails. For routine actions
an audit failure is logged and the business action proceeds — the trade-off is
stated explicitly in `src/server/audit/index.ts`.

## Response headers

Set globally in `next.config.ts`: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(self), microphone=(), geolocation=()` — camera is
allowed same-origin because face attendance needs it, and nothing else is.

## Error taxonomy

Every expected failure is a typed `AppError` with an HTTP status, a stable machine
`code`, and a `publicMessage` safe to display. 401 means "we do not know who you
are"; 403 means "we know, and you may not". Database errors are mapped through
`mapDatabaseError`, which keeps constraint names and SQLSTATEs out of API responses
while still producing a precise, actionable message.

## What is not done

Stated plainly rather than implied:

- **No penetration test has been performed.** The controls above are designed and
  unit/integration tested; they have not been adversarially probed.
- **No dependency vulnerability scan** is wired into CI.
- **Content-Security-Policy is not yet set.** Next's inline bootstrap scripts need a
  nonce-based policy; the headers above are in place but CSP is outstanding and is
  the most significant remaining gap.
- **Field-level encryption** is applied only to TOTP secrets. Other personal data
  relies on database-level encryption at rest, which is a deployment concern.
- **2FA is implemented but not enforced.** `security.require2faForRoles` exists as a
  setting; the enforcement path on login is in place, but no role requires it by
  default.
