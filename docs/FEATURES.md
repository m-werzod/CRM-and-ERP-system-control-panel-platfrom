# Features

Status is stated per layer, because "the feature exists" means different things for
a service, an API route and a screen.

| Legend | Meaning |
| --- | --- |
| **Service** | Business logic, permission checks, transactions, audit — the thing that enforces the rule |
| **API** | HTTP route handler over it |
| **UI** | Screens |
| ✅ | Built |
| 🧪 | Built **and** covered by automated tests |
| ◻ | Not built |

## Platform foundation

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Multi-tenancy (`organizationId` on every model) | 🧪 | — | — |
| Multi-branch with per-branch scope enforcement | 🧪 | ◻ | ◻ |
| Configurable settings (branch → org → default) | ✅ | ◻ | ◻ |
| Audit log (append-only, per-field diffs) | 🧪 | ◻ | ◻ |
| Activity timeline | ✅ | ◻ | ◻ |
| Structured logging with mandatory redaction | ✅ | — | — |
| Error taxonomy → predictable HTTP envelope | ✅ | ✅ | ◻ |
| Rate limiting (3 drivers) | ✅ | ✅ | — |
| Request idempotency | ✅ | ✅ | — |
| Background jobs (DB queue, `SKIP LOCKED`) | ✅ | — | ◻ |
| Cron scheduler (own 5-field parser) | 🧪 | — | ◻ |
| i18n — Uzbek / Russian / English | 🧪 | — | ◻ |
| Storage abstraction (local + S3 with own SigV4) | ✅ | ◻ | ◻ |

## Authentication & access control

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Login, Argon2id, no enumeration oracle | 🧪 | ◻ | ◻ |
| Server sessions, idle **and** absolute expiry | 🧪 | ◻ | ◻ |
| Per-account lockout | 🧪 | ◻ | ◻ |
| Logout, session revocation | 🧪 | ◻ | ◻ |
| Password change (revokes other sessions) | 🧪 | ◻ | ◻ |
| Forced password change on first login | 🧪 | ◻ | ◻ |
| TOTP two-factor + recovery codes | 🧪 | ◻ | ◻ |
| Password reset (token architecture) | ✅ | ◻ | ◻ |
| CSRF (double-submit, session-bound) | 🧪 | ✅ | — |
| RBAC — 11 roles, 180+ granular permissions | 🧪 | ✅ | ◻ |
| Custom roles (roles are data, not code) | ✅ | ◻ | ◻ |
| Privilege-escalation guards | ✅ | ◻ | ◻ |
| Branch isolation | 🧪 | ◻ | ◻ |
| Account activation / deactivation | ✅ | ◻ | ◻ |
| Login attempt log | 🧪 | ◻ | ◻ |

## CRM

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Leads with the 9-status pipeline | ✅ | ◻ | ◻ |
| Status-transition validation | 🧪 | ◻ | ◻ |
| Duplicate detection (phone + email, normalised) | 🧪 | ◻ | ◻ |
| Lead assignment and transfer | ✅ | ◻ | ◻ |
| Activity timeline (calls, notes, meetings) | ✅ | ◻ | ◻ |
| Follow-up tasks with SLA | ✅ | ◻ | ◻ |
| Trial lesson booking and outcome | ✅ | ◻ | ◻ |
| **Lead → student conversion, CRM history preserved** | ✅ | ◻ | ◻ |
| Merge duplicates | ✅ | ◻ | ◻ |
| Pipeline value, conversion funnel, agent performance | ✅ | ◻ | ◻ |

## Admissions

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Applications with numbering | ✅ | ◻ | ◻ |
| Review gates (document / test / interview / finance / approval) | ✅ | ◻ | ◻ |
| Interview scheduling with interviewer conflict check | ✅ | ◻ | ◻ |
| Accept / reject / waitlist, gates enforced | ✅ | ◻ | ◻ |
| **Application → student, person created exactly once** | ✅ | ◻ | ◻ |
| Admissions funnel + stage bottlenecks | ✅ | ◻ | ◻ |

## Students, guardians, groups

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Student CRUD, soft delete, restore | ✅ | ◻ | ◻ |
| Withdraw / graduate (closes enrolments) | ✅ | ◻ | ◻ |
| Assembled student profile with per-section permissions | ✅ | ◻ | ◻ |
| Guardians, many-to-many, one primary enforced | ✅ | ◻ | ◻ |
| Groups with live capacity | ✅ | ◻ | ◻ |
| **Enrolment (capacity + branch checked in transaction)** | 🧪 | ◻ | ◻ |
| **Transfer preserving both enrolments** | 🧪 | ◻ | ◻ |
| Dated roster (`getGroupRoster(groupId, onDate)`) | 🧪 | ◻ | ◻ |
| Subjects, programmes, curriculum | ✅ | ◻ | ◻ |
| Teacher assignment as dated history | ✅ | ◻ | ◻ |
| Teacher workload vs capacity | ✅ | ◻ | ◻ |

## Scheduling

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Weekly timetable (wall-clock minutes, DST-safe) | ✅ | ◻ | ◻ |
| **Conflict detection — teacher / room / group** | 🧪 | ◻ | ◻ |
| Lesson generation from the pattern (idempotent) | ✅ | ◻ | ◻ |
| Ad-hoc lessons, cancel, reschedule | ✅ | ◻ | ◻ |
| Teacher's "today" query (the mobile entry point) | ✅ | ◻ | ◻ |
| Rooms and utilisation | ✅ | ◻ | ◻ |
| Daily / weekly / monthly views | — | ◻ | ◻ |

## Attendance

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| **One record per (lesson, student) — unique index** | 🧪 | ◻ | ◻ |
| Teacher register + submit | ✅ | ◻ | ◻ |
| Admin manual marking | ✅ | ◻ | ◻ |
| **Corrections with reason, actor and approval** | ✅ | ◻ | ◻ |
| Configurable late / absent thresholds | ✅ | ◻ | ◻ |
| **Configurable status weights** for percentages | 🧪 | ◻ | ◻ |
| Student / group / branch / daily statistics | ✅ | ◻ | ◻ |
| At-risk detection (rate + consecutive absences) | ✅ | ◻ | ◻ |
| Face recognition — **provider boundary** | ✅ | ◻ | ◻ |
| Mock face provider (**declares itself simulated**) | ✅ | ◻ | ◻ |
| AWS Rekognition driver | ✅ | ◻ | ◻ |
| Biometric consent, guardian consent for minors | ✅ | ◻ | ◻ |
| QR attendance (single-use, rotating, hashed) | ✅ | ◻ | ◻ |
| Device terminals (hashed API key, branch-bound) | ✅ | ◻ | ◻ |

## Finance

The most complete module, and the most heavily tested.

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| **Append-only ledger as source of truth** | 🧪 | — | ◻ |
| **Derived caches + DB-enforced balance identity** | 🧪 | — | ◻ |
| Fee plans, dated student assignment | ✅ | ◻ | ◻ |
| Invoices: draft → issue → pay, frozen at issue | 🧪 | ◻ | ◻ |
| Line items, tax after discount, proportional spread | 🧪 | — | ◻ |
| Discounts: fixed, percentage, scholarship, approval | ✅ | ◻ | ◻ |
| **Payments with idempotency keys** | 🧪 | ◻ | ◻ |
| Allocation across invoices, oldest due first | 🧪 | ◻ | ◻ |
| **Overpayment → student credit, spendable** | 🧪 | ◻ | ◻ |
| Payment reversal (compensating entry) | 🧪 | ◻ | ◻ |
| **Refunds: request → approve → process, four-eyes** | 🧪 | ◻ | ◻ |
| Refund as account credit | 🧪 | ◻ | ◻ |
| Write-off with approved adjustment | 🧪 | ◻ | ◻ |
| Debt ageing (configurable, non-overlapping buckets) | 🧪 | ◻ | ◻ |
| Students-in-debt worklist (SQL aggregate) | 🧪 | ◻ | ◻ |
| Payment schedules / instalments | ✅ | ◻ | ◻ |
| Currency resolution with one precedence | 🧪 | — | ◻ |
| Payment gateways: Payme, Click, Stripe | ✅ | ◻ | ◻ |
| Manual payment mode (a real mode, not a stub) | ✅ | ◻ | ◻ |

## Academic delivery

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Exams with validated scores | ✅ | ◻ | ◻ |
| Bulk result entry, re-runnable, snapshotted maxScore | ✅ | ◻ | ◻ |
| **Exam statistics (absences excluded from average)** | 🧪 | ◻ | ◻ |
| Grading scales: numeric / percentage / letter / pass-fail | 🧪 | ◻ | ◻ |
| Unified gradebook, weighted term averages | ✅ | ◻ | ◻ |
| Homework, submissions, late detection, grading | ✅ | ◻ | ◻ |
| Certificates: issue, revoke, public verify | ✅ | ◻ | ◻ |

## HR

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Employees (User + Employee in one transaction) | ✅ | ◻ | ◻ |
| Termination (revokes sessions, closes assignments) | ✅ | ◻ | ◻ |
| Staff check-in / check-out, one row per day | ✅ | ◻ | ◻ |
| Leave types, requests, four-eyes approval | ✅ | ◻ | ◻ |
| Salary components as dated history | ✅ | ◻ | ◻ |
| **Pluggable payroll calculator** | 🧪 | ◻ | ◻ |
| Payroll runs with snapshotted breakdown | ✅ | ◻ | ◻ |

## Communication

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Event-driven notification engine | ✅ | ◻ | ◻ |
| Templates per channel per locale (no inline text) | ✅ | ◻ | ◻ |
| **Enqueue in-transaction, send out-of-transaction** | ✅ | — | ◻ |
| Recipient preferences, quiet hours, dedupe | ✅ | ◻ | ◻ |
| Email: Resend | ✅ | ◻ | ◻ |
| SMS: Eskiz, Play Mobile, Twilio | ✅ | ◻ | ◻ |
| Telegram Bot API, WhatsApp Cloud API | ✅ | ◻ | ◻ |
| Console drivers for every channel | ✅ | — | ◻ |
| Announcements with audience targeting | ✅ | ◻ | ◻ |
| Masked-address communication log | ✅ | ◻ | ◻ |

## Reporting, search, documents, data

| Capability | Service | API | UI |
| --- | --- | --- | --- |
| Student reports | ✅ | ◻ | ◻ |
| Attendance reports (shared percentage rule) | ✅ | ◻ | ◻ |
| Finance reports (**from the ledger, not payments**) | ✅ | ◻ | ◻ |
| CRM reports | ✅ | ◻ | ◻ |
| Academic reports | ✅ | ◻ | ◻ |
| HR reports | ✅ | ◻ | ◻ |
| Global search (trigram + reversed-phone indexes) | ✅ | ◻ | ◻ |
| CSV export (RFC 4180, BOM for Excel) | ✅ | ◻ | ◻ |
| **Two-phase CSV import with per-row errors** | ✅ | ◻ | ◻ |
| Documents: authorised access, access log | ✅ | ◻ | ◻ |
| Users, roles, branches, settings administration | ✅ | ◻ | ◻ |
| Integration status (honest NOT_CONFIGURED) | ✅ | ◻ | ◻ |

## What is deliberately honest rather than faked

- **Face recognition** is a provider boundary. `none` reports "not configured";
  `mock` performs no recognition and declares `isRealRecognition: false`; the AWS
  driver is real. `env.ts` refuses production with `mock`.
- **SMTP email** throws `IntegrationNotConfiguredError` explaining that nodemailer
  is not a dependency. It does not silently drop mail.
- **The Redis queue and rate-limit drivers** throw rather than pretending, because
  no Redis client is bundled.
- **Manual payments** are a fully supported mode, not a placeholder — most Uzbek
  institutions take cash and bank transfer.
- Nothing returns a hard-coded statistic. Every dashboard figure traces to a query.

## The honest gap: HTTP and UI layers

The service layer is substantially complete and the load-bearing parts of it are
tested against a real database. **The API routes and the React screens are almost
entirely unbuilt.** Two primitives and the design system exist (`button`, `field`,
`card`, `badge`, `states`, `table`, design tokens, navigation tree); the `apiRoute`
wrapper exists and is ready to mount handlers on.

That means today this is a verified backend with a scaffolded front end, not a
usable product. The remaining work is mechanical relative to what is done — each
route is a validate-and-delegate shim, each screen is a list or a form over an
existing use-case — but it is a substantial amount of it, and calling the system
"complete" would be false.

See the final implementation report for the ordered list.
