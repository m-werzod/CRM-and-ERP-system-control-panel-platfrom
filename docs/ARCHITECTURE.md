# Architecture

## What this is

A multi-branch education CRM + ERP: the operational lifecycle from first enquiry to
graduation, in one system. Lead → application → admission → student → group →
schedule → attendance → assessment → invoice → payment → reporting.

## Stack, and why

| Layer | Choice | Reasoning |
| --- | --- | --- |
| Framework | Next.js 16, App Router | Server components let a data-dense list render on the server with no client fetch waterfall. One deployable unit for UI and API. |
| Language | TypeScript 5.9, `strict` + `noUncheckedIndexedAccess` | `noUncheckedIndexedAccess` catches the `array[0]` that is actually `undefined` — the single most common source of runtime crashes in list handling. |
| Database | PostgreSQL 17 | CHECK constraints, partial unique indexes, triggers and `SERIALIZABLE` are load-bearing here (see [DATABASE.md](DATABASE.md)). This design does not port to MySQL or SQLite without losing guarantees. |
| ORM | Prisma 7 + `@prisma/adapter-pg` | Typed queries, a real migration history, and — via the driver adapter — a pool we configure rather than one hidden inside a query engine. Raw SQL where an aggregate needs it. |
| Validation | Zod 4 | One schema shared by the client form and the server handler, so "valid" means the same thing in both places. |
| Styling | Tailwind CSS 4 | Design tokens as CSS variables, so light/dark and density are one definition rather than a component-by-component decision. |
| Auth | Server-side sessions | Instant revocation. A stateless JWT cannot be revoked, and "deactivate this user" must mean it immediately. |
| Passwords | Argon2id (`@node-rs/argon2`) | Memory-hard. bcrypt's 4 KiB working set parallelises cheaply on a GPU; Argon2id's 19 MiB does not. |
| Tests | Vitest + Playwright | Unit tests for pure logic; integration tests against **real PostgreSQL**, because the constraints being tested exist only there. |

## Layering

```
src/app/                 pages + route handlers.  THIN.
      ├── parse input with a Zod schema
      ├── call exactly one service function
      └── shape the response
  │
src/server/services/     ALL business logic. One file per use-case family.
  │
src/server/{db,rbac,auth,settings,audit,http,…}   cross-cutting contracts
  │
src/generated/prisma     generated client
```

The rule that keeps this honest: **a route handler contains no business logic and a
React component contains none either.** A service function is
`(ctx: AccessContext, input: ValidatedInput, db?: Db) => Promise<Result>`. It checks
its own permission — it never assumes the caller did — and it accepts an optional
`db` so it composes into a caller's transaction rather than opening a second one.

That last point matters more than it looks. `convertLeadToStudent` calls
`enrollStudent`, which calls `createInvoice`. All three must commit or roll back
together, which is only possible if every one of them can be handed an ambient
transaction.

## Authorisation: two orthogonal axes

Conflating these is the usual source of access-control bugs, so they are separate
mechanisms with separate failure modes.

**PERMISSIONS — what action.** Granular dotted keys (`payments.refund`,
`attendance.correct`) attached to roles. Checked imperatively, first statement of
every use-case:

```ts
requirePermission(ctx, 'payments.refund');
```

The catalogue in `src/server/rbac/permissions.ts` is the single source of truth and
is seeded into the `permissions` table. `can()` **throws** on an unrecognised key
rather than returning false: a typo'd permission string that silently denied would
be a latent hole, and one that silently allowed would be a breach.

**SCOPE — which rows.** `Role.scope` is `ORGANIZATION`, `BRANCH` or `SELF`. Applied
as a WHERE fragment, never as a UI filter:

```ts
const where = composeReadFilter(ctx, {
  selfFilter: selfStudentFilter(ctx),
  escapeHatch: 'attendance.viewAll',
});
```

Scope is a *filter* rather than a *check* deliberately: a list endpoint must return
the caller's subset, not 403. And a branch admin assigned to no branch gets
`branchId: { in: [] }` — which matches nothing. Fail-closed by construction.

Every query that reads tenant data includes `organizationId`. There is no
legitimate query without it.

### Privilege escalation

`Role.level` ranks roles. `assertCanGrantRole` refuses to grant a role at or above
the granter's own level, and `assertCanAdministerUser` refuses to edit a peer or a
superior. Without these, anyone holding `users.manageRoles` could award themselves
`SUPER_ADMIN`.

## The money model

`LedgerEntry` is append-only and is the source of truth. A database trigger blocks
`UPDATE` and `DELETE` on it, so no code path — not a migration, not a hand-typed
`psql` statement — can rewrite financial history. A mistake is corrected by
appending a reversing entry that points at the original via `reversalOfId`.

`Invoice.paidTotalMinor` / `refundedTotalMinor` / `writtenOffMinor` /
`balanceMinor` are **derived caches**, recomputed from the ledger inside the same
transaction that appends those rows. They exist so a debt report over 100 000
invoices is a few indexed scans rather than a ledger fold. A CHECK constraint
enforces the balance identity, so a bug in the recalculation fails loudly at write
time instead of producing a wrong figure nobody notices for a month.

`npm run verify:ledger` re-derives every total independently and reports drift.

Money is `BigInt` minor units plus an ISO-4217 currency. Percentages are integer
parts-per-million. No float touches money anywhere — `0.1 + 0.2 !== 0.3` is not an
acceptable property for an invoice balance.

**Currency has exactly one resolver.** `currencyFor()` in
`services/finance/currency.ts` applies a fixed precedence (explicit → branch →
setting row → `Organization.defaultCurrency`). This exists because an earlier
version read the `finance.currency` *setting default*, which was `UZS`, and
silently contradicted an organisation configured as `USD` — producing UZS invoices
for a USD tenant. Two sources of truth for currency is how mixed-currency ledgers
happen.

## History is preserved, not overwritten

Assignment-style records are dated, never mutated. Moving a student between groups
**closes** the current `Enrollment` (`endDate` + `endReason`, linked via
`transferredToId`) and **opens** a new one. The same pattern governs teacher
assignments, fee plans and salary components.

Attendance, grades and invoices stay attached to the enrollment they were created
under, so last term stays reportable exactly as it happened. This is why
`AttendanceRecord.enrollmentId` exists, and why the register is resolved
**per lesson date** (`getGroupRoster(groupId, onDate)`) rather than from current
membership — a student who transferred out must not appear absent from a class they
had already left.

A partial unique index guarantees at most one open enrollment per
`(studentId, groupId)`, making a double-submitted "enrol" impossible rather than
merely unlikely.

## Attendance: one write path

Manual entry, a teacher's register, a face terminal, a QR scan, an external device
and a CSV import all funnel into the **same** `markAttendance` use-case; `method`
records which. The alternative — a write path per provider — is how one of them
ends up skipping the duplicate check, the late-threshold rule, or the audit entry.

Duplicate prevention is a unique index on `(lessonId, studentId)`, not an
application check, so a double-tap on a slow connection cannot produce two rows.

Corrections update the record **and** append an `AttendanceCorrection` row in one
transaction, with a reason and an actor. `attendance_corrections` is append-only at
the database level.

## Configuration, not hard-coding

Every business rule an institution might disagree about is a setting in
`src/server/settings/registry.ts` with a type, a default and a validator:
late thresholds, attendance weights (does a late arrival count as a full
attendance, a half, or nothing?), payment due days, refund approval thresholds,
grading scales, quiet hours, biometric consent age.

Resolution is branch → organisation → registry default. A stored value that fails
its own schema is logged and discarded in favour of the default, so a hand-edited
row cannot feed a bad threshold into an attendance calculation.

## Providers are abstractions

Face recognition, email, SMS, Telegram, WhatsApp, payments, storage, queue and rate
limiting each sit behind an interface with a selectable driver
(`src/server/integrations/**`, `src/server/storage`, `src/server/jobs`).

The core never imports a vendor. More importantly: **an unconfigured provider says
so.** `IntegrationNotConfiguredError` and the `NOT_CONFIGURED` result variant are
first-class, and the UI renders an honest "not configured" state. The mock face
provider reports `isRealRecognition: false`, and `env.ts` refuses to boot
production with `FACE_RECOGNITION_PROVIDER=mock`. Nothing in this system fakes a
successful payment or a successful biometric match.

## Notifications: enqueue inside, send outside

A domain event names a template key; the engine renders it and writes
`Notification` rows **inside the caller's transaction**, then enqueues a delivery
job. Sending happens in a worker.

The invariant, stated because it is easy to break: enqueueing is part of the
business transaction, sending is not. A dead SMS gateway must never roll back an
attendance submission or a payment.

## Jobs

A `QueueProvider` interface with a database-backed default driver, so durable
background work needs no extra infrastructure. The claim query uses
`FOR UPDATE SKIP LOCKED` — that clause, not application logic, is what stops two
workers processing the same job. Failures retry with exponential backoff **and
jitter**; without jitter every retry of a batch re-collides.

## Observability

Structured logging with **mandatory redaction**: every value is walked and any key
matching a credential pattern is replaced. A logger that *can* leak a password is
worse than no logger, and "remember not to log the request body" is not a control.

A `requestId` correlates every log line, audit row, notification and job produced
by one request.

## Auditability

Two records, deliberately separate:

- **`AuditLog`** — compliance. Actor, action, entity, per-field before/after,
  reason, IP, request id. Append-only. Written for every sensitive action whether
  or not a human would find it interesting. Elevated actions (refunds, permission
  changes, attendance corrections, write-offs) are recorded at `WARNING`/`NOTICE`,
  and at those severities the audit write is **not** best-effort — if it cannot be
  recorded, the action fails.
- **`ActivityEvent`** — the operational timeline on a student or lead page. Curated,
  human-readable, safe to show a receptionist.

## Multi-tenancy

`organizationId` is on every tenant-scoped model from the start, even though the
first deployment is a single institution. Retrofitting tenancy into a live schema
means touching every query and every index; carrying it from day one costs a column.

## Decisions worth recording

- **Server sessions over JWT.** Revocation must be immediate.
- **`SERIALIZABLE` for money paths.** `READ COMMITTED` permits write skew — two
  concurrent payments each read the same unpaid balance and both allocate against
  it, with no constraint violated. Idempotency keys stop a *double-submit of the
  same request*; serialisable isolation stops *two different requests racing*.
  Neither substitutes for the other.
- **`timestamptz` everywhere** (292 columns), not `timestamp`. Reporting SQL that
  buckets by day must not depend on the server's timezone.
- **Wall-clock minutes for recurring schedule patterns**, real instants for
  lessons. A DST transition should move a class with the local clock, not shift
  every class by an hour.
- **Native `<select>` for enum choices.** Keyboard- and screen-reader-correct for
  free, and on a phone it opens the OS picker. A custom popover is reserved for
  where search or multi-select is genuinely needed.
- **Tests against real PostgreSQL.** A mocked Prisma client passes every
  constraint test while the real database rejects the same writes.

## Known limitations

See the "Known limitations" section of the final implementation report and
[TESTING.md](TESTING.md) for current coverage. The honest summary of the provider
layer: drivers written against a real HTTP API are marked as such, and drivers that
could not be implemented (SMTP needs a library that is not installed) throw
`IntegrationNotConfiguredError` with a precise message rather than pretending.
