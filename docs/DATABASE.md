# Database

PostgreSQL 17. Schema lives in `prisma/schema/` as one file per domain rather than
one 3 000-line file; Prisma collects every `*.prisma` in that folder and relations
cross files freely.

## Current shape

| | |
| --- | --- |
| Tables | 101 |
| Enums | 92 |
| Indexes | 416 |
| Foreign keys | 326 |
| CHECK constraints | 51 |
| Partial (filtered) indexes | 18 |
| Append-only triggers | 3 |
| Migrations | 4 |

Verify any of this yourself: `npm run db:verify` asserts the guarantees below
against the live database and fails if one is missing.

## Domain files

| File | Contents |
| --- | --- |
| `00-config.prisma` | Generator, datasource, and the conventions every other file follows |
| `01-tenancy.prisma` | Organization, Branch, Department, Room, AcademicYear, Term, Setting |
| `02-auth.prisma` | User, Role, Permission, RolePermission, UserRole, UserBranch, Session, PasswordResetToken, TwoFactorRecoveryCode, LoginAttempt |
| `03-people.prisma` | Student, Guardian, StudentGuardian, Employee, Teacher, TeacherSubject |
| `04-academics.prisma` | Subject, Program, ProgramSubject, Group, GroupTeacher, Enrollment, GradingScale, GradingScaleBand |
| `05-scheduling.prisma` | ScheduleSlot, Lesson |
| `06-attendance.prisma` | AttendanceRecord, AttendanceCorrection, AttendanceDevice, BiometricEnrollment, BiometricConsent, FaceRecognitionEvent, QrToken |
| `07-crm.prisma` | Lead, LeadActivity, LeadStatusHistory, FollowUpTask, TrialLesson |
| `08-admissions.prisma` | Application, ApplicationReview, Interview |
| `09-finance.prisma` | FeePlan, StudentFeePlan, Invoice, InvoiceItem, Discount, StudentDiscount, InvoiceDiscount, Payment, PaymentAllocation, Refund, StudentCredit, LedgerEntry, FinancialAdjustment, PaymentSchedule, PaymentScheduleInstallment, PaymentMethodConfig, TaxRate, DocumentCounter |
| `10-assessment.prisma` | Homework, HomeworkSubmission, Exam, ExamResult, Grade, Certificate |
| `11-hr.prisma` | EmployeeAttendance, LeaveType, LeaveRequest, SalaryComponent, PayrollRun, PayrollItem |
| `12-communication.prisma` | NotificationTemplate, Notification, NotificationPreference, Announcement, AnnouncementTarget, AnnouncementRead, CommunicationLog |
| `13-documents.prisma` | Document, DocumentAccessLog |
| `14-platform.prisma` | AuditLog, ActivityEvent, Job, CronSchedule, WebhookEndpoint, WebhookEvent, IdempotencyKey, RateLimitCounter, ImportJob, ImportRowError, ExportJob, SavedReport, IntegrationConfig |

## Conventions

- **Tenancy.** `organizationId` on every tenant-scoped model; `branchId` on
  branch-scoped ones.
- **Money.** `BigInt` minor units in a `*Minor` column, always paired with an
  ISO-4217 `currency`. Never a float, never a bare number.
- **Percentages.** Integer parts-per-million in a `*Ppm` column — 10% is
  `100_000`. Exact, and no rounding drift.
- **Instants.** `timestamptz(3)` — 292 columns. Calendar dates that are genuinely
  dates (`lessonDate`, `dueDate`, `startDate`) are `date`.
- **Soft delete.** `deletedAt DateTime?` on anything an operator can "delete".
  Queries filter it.
- **History.** Assignment-style models carry `startDate`/`endDate` rows instead of
  being mutated.
- **Derived caches.** Fields documented as such are recomputed inside the
  transaction that writes their source rows and are never writable from a request
  payload.
- **Table names** are `snake_case` via `@@map`; columns stay `camelCase`.

## Guarantees the database enforces

The application also validates all of this, with friendlier messages. These exist so
a bug, a migration script or a manual `psql` session cannot corrupt the data.

### Append-only history

`ledger_entries`, `audit_logs` and `attendance_corrections` carry a
`BEFORE UPDATE OR DELETE` trigger that raises `restrict_violation` (SQLSTATE
`23001`). There is no application code path that mutates them, but "we promise not
to" is not a guarantee.

**The escape hatch.** The trigger yields when the transaction sets:

```sql
SET LOCAL app.allow_history_mutation = 'on';
```

`SET LOCAL` means the permission dies with the transaction, and any use of it is
visible in the code that sets it. Exactly two operations may use it:

1. **Purging a tenant** — hard-deleting an `Organization` cascades into these
   tables. Use `withHistoryMutationAllowed` from `src/server/db/client.ts`.
2. **Test teardown** — and the test fixtures use `TRUNCATE`, which is a
   statement-level operation that row triggers never see, so they do not need it.

Never call it from a request handler.

### Financial integrity

```sql
-- the identity the derived caches must satisfy
balanceMinor = totalMinor - paidTotalMinor - writtenOffMinor + refundedTotalMinor
```

Plus: payment, refund and allocation amounts strictly positive; ledger amounts
non-negative (sign lives in `direction`, never in the amount); credit balance
within its original amount; currency codes matching `^[A-Z]{3}$`; a discount
carrying **exactly one** of `percentPpm`/`amountMinor`.

That last one was relaxed in migration `20260927140000_scholarship_percentage`: the
original grouped `SCHOLARSHIP` with `FIXED` and so demanded an amount, but "a 50%
scholarship" is how institutions actually describe one. The rule that matters —
exactly one value, so no code has to guess which field to read — is unchanged.

### Partial unique indexes

These express "at most one CURRENT x", which a plain `@@unique` cannot: it would
forbid the historical rows the design deliberately keeps.

| Index | Rule |
| --- | --- |
| `enrollments_one_open_per_student_group` | At most one open enrollment per (student, group) |
| `group_teachers_one_open_per_group_role` | One current primary teacher per group |
| `student_fee_plans_one_open_per_student_plan` | One active fee plan assignment |
| `student_guardians_one_primary_per_student` | One primary guardian |
| `user_branches_one_primary_per_user` | One primary branch |
| `academic_years_one_current_per_org` | One current academic year |
| `terms_one_current_per_year` | One current term |
| `grading_scales_one_default_per_org` | One default grading scale |
| `tax_rates_one_default_per_org` | One default tax rate |
| `students_live_code_unique` | A soft-deleted student does not permanently consume its code |

### Duplicate prevention

`attendance_records` is unique on `(lessonId, studentId)`. A teacher double-tapping
submit, or a face terminal retrying, cannot create two rows — even if both requests
pass an application-level check at the same instant.

`payments.idempotencyKey` and `refunds.idempotencyKey` are unique, so a replayed
request or webhook cannot post money twice.

`webhook_events` is unique on `(provider, externalId)`, making replay a no-op.

### Polymorphic consistency

`documents` has real nullable foreign keys per owner type rather than a
`(type, id)` string pair, plus CHECK constraints asserting exactly one owner is set
**and** that it matches `ownerType`. A deleted student cannot leave orphaned
documents, and cascade behaviour is declared rather than remembered.

Same pattern for `notifications` (exactly one recipient) and
`biometric_enrollments` (the subject matches the discriminator).

## Search

`pg_trgm` and `unaccent` are enabled. An `IMMUTABLE` helper does the folding:

```sql
search_normalize(value) = lower(unaccent('public.unaccent'::regdictionary, value))
```

GIN trigram indexes on student, guardian, lead, user and group names make an
**infix** match (`'zod'` finds `'Sherzod'`) index-backed rather than a sequential
scan. Phone search indexes `reverse(phoneNormalized)` so a suffix match — someone
typing the last four digits, the common case — becomes a prefix query.

`npm run db:verify` asserts with `EXPLAIN` that the planner actually chooses
`students_name_trgm`. An index nobody uses is not an optimisation.

## Operational partial indexes

Small regardless of how much settled history accumulates:

- `jobs_runnable` — `WHERE status = 'PENDING'`
- `invoices_outstanding` — `WHERE balanceMinor > 0 AND status NOT IN (...)`
- `notifications_dispatchable` — `WHERE status IN ('PENDING','QUEUED')`
- `follow_up_tasks_open` — `WHERE status = 'OPEN'`
- `students_live_listing`, `leads_live_pipeline` — `WHERE deletedAt IS NULL`

## Document numbering

`DocumentCounter` is an atomic counter per `(organizationId, scope, period)`,
incremented with a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the
caller's transaction. `SELECT max(n) + 1` would race: two concurrent invoices read
the same maximum and then either collide on the unique index or, under a weaker
isolation level, both commit.

Numbers may show gaps when a transaction rolls back after allocating one. That is
correct and preferable to reusing a number that appeared on a printed invoice.

## Local development

No Docker and no PostgreSQL service is required. `scripts/dev-db.ts` drives
`pg_ctl` against the real PostgreSQL 17 binaries shipped by
`@embedded-postgres/<platform>`:

```bash
npm run db:up        # initialise if needed, start, create both databases
npm run db:status    # is it running, is it reachable, how many tables
npm run db:down      # stop, keep the data
```

The cluster lives in `.dev-db/` (gitignored), binds to `127.0.0.1` only, and listens
on port 55432 to avoid clashing with any system PostgreSQL. A `docker-compose.yml`
is also provided, and setting `DATABASE_URL` to any external PostgreSQL works
without further change.

Two implementation notes, both learned the hard way:

- `pg_ctl start` must be spawned with `stdio: 'ignore'`. The detached server
  inherits its stdio handles, so with piped stdio the parent blocks forever waiting
  for EOF on a pipe the long-lived server is holding open — the cluster comes up
  fine and the script hangs.
- The bundled binaries include `initdb`, `pg_ctl` and `postgres` but **not `psql`**,
  so databases and roles are created through the `pg` Node client.

## Migrations

```bash
npm run db:migrate            # create + apply (development)
npm run db:migrate:deploy     # apply only (CI / production)
npm run db:reset              # drop, re-apply, re-seed
npm run db:verify             # assert the guarantees above still hold
npm run verify:ledger         # re-derive every invoice total from the ledger
```

| Migration | Contents |
| --- | --- |
| `…_init` | 99 tables, 92 enums, 289 indexes, 325 foreign keys |
| `…_integrity_search_guards` | Hand-written SQL: partial unique indexes, CHECK constraints, append-only triggers, `pg_trgm`/`unaccent`, search and operational indexes |
| `…_document_counters` | `DocumentCounter` |
| `…_scholarship_percentage` | Relaxed the discount value constraint so a scholarship may be a percentage |

`…_integrity_search_guards` is hand-written and Prisma never regenerates it. When
you add a model, add its constraints there — or in a new migration — rather than
assuming the schema language covers them.

## Backups

See [BACKUP.md](BACKUP.md).
