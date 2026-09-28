# Education CRM + ERP — engineering conventions

Read this before writing code. It describes contracts that already exist and are
**not** to be reinvented. If something here seems wrong, say so rather than
quietly diverging — a second implementation of an existing contract is the worst
outcome.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript 5.9 (strict, `noUncheckedIndexedAccess`)
· Tailwind CSS 4 · Prisma 7 with the `@prisma/adapter-pg` driver adapter ·
PostgreSQL 17 · Zod 4 · TanStack Query 5 · Vitest 3 · Playwright.

ESM only (`"type": "module"`). Prisma client is generated to
`src/generated/prisma` — import from `@/generated/prisma/client`.

## Hard rules

1. **No `any`.** ESLint fails the build on it. Use `unknown` and narrow.
2. **Money is `BigInt` minor units + an ISO-4217 `currency`.** Never a float,
   never a bare number. Use `@/lib/money`. Percentages are integer
   parts-per-million (`10% === 100_000`).
3. **Every instant is UTC.** Calendar days are computed in an explicit timezone
   via `@/lib/dates`. Never `new Date().toISOString().slice(0,10)`.
4. **Server-side authorisation on every sensitive operation.** Hiding a button is
   not a control. See "Authorisation" below.
5. **Never trust client input.** Validate with Zod at the boundary, using the
   primitives in `@/lib/validation`.
6. **No secrets outside `src/server/env.ts`.** Never import `env` from client
   code, never inline a key.
7. **Transactions for multi-row invariants.** Use `withTransaction`; money paths
   use `withSerializableRetry`.
8. **Never fake a feature.** If a provider is unconfigured, surface that state
   honestly (`IntegrationNotConfiguredError`, a "Not configured" UI state). Do
   not stub a successful payment, a successful face match, or invented metrics.

## Existing contracts — use, don't rewrite

| Concern | Module | Key exports |
| --- | --- | --- |
| Errors | `@/server/errors` | `AppError` subclasses, `mapDatabaseError` |
| Env | `@/server/env` | `env`, `integrationEnabled` |
| Database | `@/server/db/client` | `prisma`, `Tx`, `Db`, `withTransaction`, `withSerializableRetry` |
| Permissions | `@/server/rbac/permissions` | `PERMISSIONS`, `ROLE_TEMPLATES`, `perm()` |
| Authorisation | `@/server/rbac/access` | `AccessContext`, `requirePermission`, `scopeFilter`, `composeReadFilter`, `assertBranchAccess`, `resolveWriteBranch` |
| Auth | `@/server/auth/*` | `hashPassword`, `verifyPassword`, `createSession`, `requireAuth`, `buildAccessContext` |
| Settings | `@/server/settings` | `getSetting`, `getSettings`, `setSetting` |
| Audit | `@/server/audit` | `record`, `recordActivity`, `AUDIT_ACTIONS`, `diffFields` |
| HTTP | `@/server/http/api` | `apiRoute`, `ok`, `pageMeta`, `toSkipTake`, `cursorPage` |
| Rate limit | `@/server/security/rate-limit` | `RATE_LIMITS`, `consumeRateLimit` |
| Logging | `@/server/observability/logger` | `logger` (auto-redacting) |
| Money | `@/lib/money` | `money`, `add`, `applyPpm`, `allocate`, `allocateByWeights`, `formatMoney` |
| Dates | `@/lib/dates` | `todayIn`, `dayRangeToInstants`, `zonedWallClockToInstant`, `intervalsOverlap` |
| Validation | `@/lib/validation` | `phoneSchema`, `moneyInputSchema`, `paginationSchema`, `normalizePhone` |

## Layering

```
app/ (pages, route handlers)   thin. parse, call a service, render.
  └── server/services/*        business logic. ALL of it.
        └── server/db          prisma
```

- **No business logic in a React component or a route handler.** A route handler
  validates, calls one service function, and shapes the response.
- A service function takes `(ctx: AccessContext, input: ValidatedInput, db?: Db)`
  and returns plain data. It checks its own permission — never assume the caller
  did.
- Services accept an optional `db` so they compose into a caller's transaction.

## Authorisation — two axes

**Permissions** = what action. Checked imperatively, first thing in a service:

```ts
requirePermission(ctx, 'payments.refund');
```

**Scope** = which rows. Applied as a WHERE fragment, never as a UI filter:

```ts
// list
const where = composeReadFilter(ctx, {
  selfFilter: selfStudentFilter(ctx),
  escapeHatch: 'students.view',
});

// write
const branchId = resolveWriteBranch(ctx, input.branchId, 'student');
```

Every query that reads tenant data **must** include `organizationId`. There is no
legitimate query without it. For a single-row fetch, filter by scope in the same
`where` — do not fetch then check, because that leaks existence.

## Finance — read this before touching money

`LedgerEntry` is the append-only source of truth. A database trigger blocks
`UPDATE`/`DELETE` on `ledger_entries` and `audit_logs`.

`Invoice.paidTotalMinor` / `refundedTotalMinor` / `writtenOffMinor` /
`balanceMinor` and `StudentCredit.balanceMinor` are **derived caches**. They are
recomputed from ledger rows inside the same transaction that appends those rows.

- Never accept them from a request payload.
- Never `update` them outside the recalculation helper.
- A CHECK constraint enforces
  `balanceMinor = totalMinor - paidTotalMinor - writtenOffMinor + refundedTotalMinor`,
  so an inconsistent write fails loudly.

Corrections are new rows (`reversalOfId`), never edits. Payments and refunds carry
an `idempotencyKey`.

## History is preserved

Assignment-style records are dated, not mutated. Changing a student's group,
teacher, fee plan or salary **closes the current row** (`endDate` + reason) and
**opens a new one**. Attendance, grades and invoices stay attached to the
enrollment they were created under.

A partial unique index enforces at most one open enrollment per
`(studentId, groupId)`.

## Attendance

One `AttendanceRecord` per `(lessonId, studentId)` — a unique index, not a check.
Every capture method (manual, teacher, face, QR, device, import) writes the same
row shape through the **same** `markAttendance` use-case; `method` records how.

Corrections write an `AttendanceCorrection` row and set `isCorrected`, in one
transaction, with a reason.

**Biometrics:** store no raw biometric data — only an opaque provider reference
plus a consent link. Enrolment without live consent is rejected. The mock
provider never claims a real match.

## API routes

```ts
export const POST = apiRoute(
  {
    permission: 'students.create',      // or 'PUBLIC' / 'AUTHENTICATED_ONLY'
    body: createStudentSchema,
    rateLimit: RATE_LIMITS.write,
  },
  async ({ ctx, body, ok }) => ok(await createStudent(ctx, body), { status: 201 }),
);
```

`apiRoute` already does auth, CSRF, rate limiting, the permission check,
validation and error mapping. Do not re-implement any of it. Do not catch errors
just to re-throw a generic one — throw the right `AppError` and let the wrapper
map it.

## UI

- Desktop-first, information-dense, but **the teacher attendance flow must work
  well on a phone** (login → today's classes → class → mark → save).
- Every list: loading skeleton, empty state with a primary action, error state.
- Every destructive action: an explicit confirmation naming what will happen.
  Prefer archive/deactivate over deletion.
- Disable submit buttons during a mutation; never allow a double submit.
- No hard-coded statistics, no placeholder rows, no dead nav links.
- Accessibility: real labels, keyboard reachable, visible focus, adequate
  contrast, ARIA only where semantics need it.
- **No UI strings inline.** Use the i18n dictionaries (uz / ru / en).

## Testing

- `npm run test` — Vitest (unit + integration). `npm run test:e2e` — Playwright.
- Unit tests for pure logic: money, dates, attendance percentages, payroll,
  invoice arithmetic, RBAC decisions.
- Integration tests hit the real dev database. They must clean up with
  `TRUNCATE ... CASCADE` (row-level `DELETE` is blocked on append-only tables).
- Assert behaviour, not implementation. A test that would pass against a stub is
  not a test.

## Commands

```
npm run db:up        start the local PostgreSQL cluster
npm run db:migrate   create + apply a migration
npm run db:seed      load development data
npm run db:verify    assert the database integrity guarantees still hold
npm run verify       typecheck + lint + test
```

## Style

Match the surrounding code. Comments explain **why**, never what — the existing
files set the bar: they justify non-obvious choices (why Serializable, why a
partial index, why timing equalisation) and say nothing about the obvious.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
