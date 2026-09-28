# Testing

## Commands

```bash
npm run test              # Vitest: unit + integration
npm run test:unit         # pure logic only — fast, no database
npm run test:integration  # real PostgreSQL
npm run test:e2e          # Playwright
npm run db:verify         # assert the database's own guarantees
npm run verify:ledger     # re-derive every invoice total from the ledger
npm run verify            # typecheck + lint + test
```

`npm run db:up` must be running for anything that touches the database.

## The principle

> A test that would pass against a stub is not a test.

Integration tests run against **real PostgreSQL**, not a mock. The things most
worth testing here — the append-only triggers, the partial unique indexes, the
CHECK constraints, `SERIALIZABLE` isolation — exist only in the database. A mocked
Prisma client would pass every one of them while the real database rejected the
same writes.

## Layers

### Unit — pure logic, no I/O

Vitest, parallel. Covers the arithmetic and the rules where a subtle error is
expensive and invisible:

| Suite | What it pins down |
| --- | --- |
| `money.test.ts` | BigInt minor units, half-up/half-even rounding, allocation that preserves the total exactly, parsing that never routes through a float, values beyond 2^53 |
| `invoice-arithmetic.test.ts` | The specification's worked example (100 − 10 = 90), discount stacking on the running remainder, tax computed **after** discount, proportional spreading across lines, clamping instead of a negative total, and every invoice-status precedence rule |
| `crypto.test.ts` | AES-256-GCM round-trip, tamper rejection, wrong-key rejection |
| `totp.test.ts` | RFC 6238 published test vectors, window tolerance, base32 edge cases |
| `cron.test.ts` | 5-field cron parsing, next-fire across a month boundary and across a DST transition |
| `i18n.test.ts` | Identical key sets across all three locales at runtime, Russian one/few/many plurals, **and `@ts-expect-error` assertions proving a missing translation is a compile error** |
| `schedule-conflicts.test.ts` | Half-open overlap: back-to-back lessons do not conflict; partial overlap, containment and identical times do |
| `exam-statistics.test.ts` | Median for odd and even counts, absences excluded from the average but counted separately, pass rate inclusive at the passing score |
| `grading-scale.test.ts` | Contiguous non-overlapping bands, boundary resolution |
| `crm-scoring.test.ts` | Legal and illegal lead status transitions, duplicate matching |
| `payroll.test.ts` | Percentage components computed on the base rather than a running total, deductions clamping net at zero with the shortfall recorded |
| `csv.test.ts` | RFC 4180: quoted fields containing newlines and commas, doubled quotes, BOM stripping, delimiter auto-detection |

The i18n suite is worth singling out. Its `@ts-expect-error` blocks assert that the
compiler *does* reject a dictionary missing a key — so if that guarantee ever
erodes, `tsc` fails rather than the erosion going unnoticed.

### Integration — real database

`tests/integration/`, single-forked (one database, so files must not race).
`tests/helpers/fixtures.ts` builds a complete world: organisation, two branches, the
seeded permission catalogue, real roles built from the real templates, and users
whose `AccessContext` is produced by the **actual `buildAccessContext`** — so a test
exercises the same permission and scope resolution the application does, rather than
a hand-assembled context that might be more permissive than reality.

Cleanup uses `TRUNCATE … CASCADE`. Row-level `DELETE` is blocked on the append-only
tables by their triggers; `TRUNCATE` is statement-level and those row triggers never
see it. It is also far faster across ~100 tables.

`tests/integration/finance.test.ts` — **29 tests, all passing**:

- **Specification FLOW 3** end to end: create invoice → receive payment → verify the
  remaining balance. 100 charged, 10 discount, 50 paid, **40 remaining**, read back
  from the database.
- Draft invoices raise no ledger entry until issued.
- Allocation across several invoices, oldest due date first; and honouring an
  explicit invoice order when the payer nominates one.
- Refusing to allocate to another student's invoice.
- **Idempotency**: a replayed key returns the original payment; two *concurrent*
  submissions of the same key post the money once.
- Overpayment becomes `StudentCredit`, and a later invoice consumes it; rejected
  outright when the organisation disallows it.
- Reversal appends a compensating entry (the original survives) and restores the
  balance; refuses when the credit it created has been partly spent.
- Refunds: request → approve → process, **including the assertion that the
  requester cannot approve their own refund**; refund-as-credit; never refunding
  more than the payment across several requests.
- Cancel refuses once money has been received; write-off records an approved
  `FinancialAdjustment` with a named approver and its ledger row.
- **The database refuses to UPDATE or DELETE a ledger entry** (asserted through both
  Prisma and raw SQL), and refuses an inconsistent balance written directly.
- Derived caches agree with the ledger after a full lifecycle
  (issue → pay → refund → write-off).
- Debt ageing places a 21-day-overdue invoice in the 8–30 bucket and keeps
  not-yet-due separate.
- **Branch isolation**: a branch-scoped accountant cannot invoice a student in
  another branch (reported as *not found*, not *forbidden* — see
  [SECURITY.md](SECURITY.md)); the debt report excludes other branches for that
  user while showing everything to an org-scoped admin; a teacher cannot record a
  payment at all.
- The audit trail records every financial action with its actor, and reversals carry
  `WARNING` severity so the audit write is not best-effort.

Test dates are derived from today, never hard-coded. A fixed `2026-03-11` silently
flips an invoice from `ISSUED` to `OVERDUE` once the clock passes it, and a test that
starts failing on a calendar boundary is worse than no test.

### Database guarantees — `npm run db:verify`

`scripts/verify-integrity.ts` asserts, against the live database, that every
guarantee [DATABASE.md](DATABASE.md) claims is actually present. **18/18 passing.**
Each assertion writes real rows and rolls back, so it is safe against development or
staging.

It also checks with `EXPLAIN` that the planner genuinely chooses
`students_name_trgm` for an infix name search. An index nobody uses is not an
optimisation.

Run it after every migration. If a constraint is dropped by accident, this is what
notices.

### Ledger consistency — `npm run verify:ledger`

Re-derives every invoice's cached totals from the append-only ledger and reports
drift. Against the seeded database: **240 invoices, zero drift.** It also sums the
ledger independently by direction and compares — two derivations agreeing is
stronger evidence than one.

Report-only by default; `-- --repair` recomputes. Silently rewriting financial rows
because someone ran a script would be worse than the drift it fixes.

### The seed is also a smoke test

`npm run db:seed` writes base data with Prisma but drives **transactional** data
through the real use-cases — `enrollStudent`, `markAttendance`, `createInvoice`,
`recordPayment`. If a ledger invariant breaks, the seed fails loudly instead of
producing a database full of plausible-looking but inconsistent rows.

This already earned its keep twice:

- The `discounts_value_matches_type` CHECK rejected a percentage scholarship,
  revealing that the constraint — not the data — was wrong. Fixed in a migration.
- `markAttendance` rejected students not yet enrolled on an old lesson date,
  revealing that the seed was reading *current* membership instead of the dated
  roster. The service was right.

## Current results

```
Unit         292 passing   (10 suites)
Integration   29 passing   (finance, against real PostgreSQL)
db:verify     18/18
verify:ledger 240 invoices, 0 drift
Typecheck     0 errors
Lint          0 errors
```

## End-to-end — Playwright

The specification names six flows. Their status is stated plainly rather than
implied:

| Flow | Status |
| --- | --- |
| 1. Admin: create teacher → group → assign → create student → enrol | Service layer covered by integration tests; **browser E2E outstanding** |
| 2. Teacher: login → see assigned class → mark attendance → submit | `markAttendance` + scope tested; **browser E2E outstanding** |
| 3. Admin: create invoice → receive payment → verify balance | **Covered** (`finance.test.ts`) |
| 4. Sales agent: create lead → follow up → convert to student | `convertLeadToStudent` built; **E2E outstanding** |
| 5. Branch admin: attempt access to another branch → denied | **Covered** (`finance.test.ts`, branch isolation) |
| 6. Admin: correct attendance → audit log created | `correctAttendance` writes the correction + audit; **E2E outstanding** |

Playwright is configured as a dependency but the browser specs are not written. That
is the largest outstanding gap in this document, and it is called out rather than
glossed.

## Writing a new test

- **Assert behaviour, not implementation.** `expect(stored.balanceMinor).toBe(4_000n)`
  read back from the database, not `expect(recalculateSpy).toHaveBeenCalled()`.
- **Test the rejection as well as the success.** Half the value of these suites is
  in what the system refuses.
- **Derive dates from today.**
- **Use the real `AccessContext`** from the fixtures, so scope and permissions are
  the ones production applies.
- **Reach for an integration test when a database guarantee is involved**, and a unit
  test when the logic is pure. Extracting a pure function to make it testable is
  usually the right refactor — `computeInvoiceTotals`, `attendancePercentagePpm`,
  `deriveInvoiceStatus`, `calculatePayrollItem` and the cron parser all exist in that
  shape for this reason.

## What is not tested

- Browser E2E flows (above).
- The real messaging, payment and Rekognition drivers. They are written against
  documented HTTP APIs but have not been exercised against live endpoints, because
  that needs credentials and would send real messages or move real money. The
  console and mock drivers are what the test suite uses.
- Load and concurrency beyond the two-concurrent-payments idempotency test.
- Accessibility is designed for (labels, focus, ARIA, contrast) but not asserted by
  an automated axe pass.
