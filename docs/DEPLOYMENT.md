# Deployment

## Shape of a deployment

Three processes, one database:

```
web      next start            HTTP. Stateless. Scale horizontally.
worker   npm run worker        Background jobs. At least one; scale for throughput.
cron     npm run cron          Schedule evaluator. EXACTLY ONE.
```

Only one cron process: two would enqueue every scheduled job twice. Jobs themselves
are idempotent where it matters (`idempotencyKey`), but duplicate reminder SMS costs
money and annoys parents.

The web tier is stateless — sessions live in PostgreSQL, not in memory — so it scales
horizontally without sticky sessions.

## Choosing a target

| Target | Works? | Notes |
| --- | --- | --- |
| **A Node host** (Fly, Railway, Render, a VPS) | **Recommended** | Runs all three processes. `QUEUE_DRIVER=database` and `STORAGE_DRIVER=local` both work. Simplest correct deployment. |
| **Vercel** | Web tier only | Serverless has no long-lived process, so the worker and cron must run elsewhere, and `STORAGE_DRIVER=local` is wrong (each invocation gets a different disk) — use `s3`. Set `DATABASE_POOL_MAX` low and put a pooler (PgBouncer, Neon pooling) in front of PostgreSQL. |
| **Docker / Kubernetes** | Yes | Three deployments from one image with different commands. Cron gets `replicas: 1`. |

## Prerequisites

- Node ≥ 20.11 (developed on 24).
- PostgreSQL ≥ 15; 17 recommended and what this is tested against.
- Object storage if `STORAGE_DRIVER=s3`.
- Redis only if you deliberately choose a Redis driver — the database drivers are the
  default and need nothing.

## Environment

Copy `.env.example`, which documents every variable: what it does, where to obtain
it, and whether it is required. `src/server/env.ts` validates everything at boot, so
a misconfiguration fails immediately with a precise message rather than at 2am inside
a payment handler.

In production it additionally enforces:

- `APP_URL` must be `https://`
- `SESSION_SECRET !== ENCRYPTION_KEY`
- `FACE_RECOGNITION_PROVIDER` must not be `mock` — the mock performs no recognition,
  and shipping it to production would mean pretending a biometric system works
- no placeholder values left from `.env.example`

Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Set `TRUST_PROXY=true` **only** behind a proxy you control. Otherwise any client can
spoof `X-Forwarded-For` and defeat IP-based rate limiting.

## First deploy

```bash
# 1. Install and generate the client.
npm ci
npx prisma generate

# 2. Apply migrations. `deploy`, never `dev` — `dev` can prompt, reset, or
#    generate a new migration against production.
npx prisma migrate deploy

# 3. Assert the database's own guarantees landed.
npm run db:verify          # expects 18/18

# 4. Build.
npm run build

# 5. Bootstrap the first organisation and SUPER_ADMIN.
#    DO NOT run `npm run db:seed` — that is fabricated development data and it
#    TRUNCATES every table. It refuses to run with NODE_ENV=production.
npm run bootstrap -- --org "Your Institution" --email admin@your-domain.uz

# 6. Start.
npm start &                # web
npm run worker &           # worker
npm run cron &             # cron — exactly one
```

Step 5 is deliberately a different script from the seed. Pointing a seed at
production is the single most destructive mistake available here, so the seed refuses
outright rather than relying on care.

## Migrating on subsequent deploys

`prisma migrate deploy` before starting the new code, never after. New code against
an old schema fails at the first query.

The safe order for a schema change that is not backward compatible:

1. Deploy a migration that **adds** the new shape, leaving the old one.
2. Deploy code that writes both and reads the new.
3. Backfill.
4. Deploy code that reads and writes only the new shape.
5. Deploy a migration that drops the old shape.

Slower than one step, and it means a rollback never leaves the schema ahead of the
code.

**Test every migration against a restored copy of production first.** See
[BACKUP.md](BACKUP.md).

## Health checks

```
GET /api/health    liveness  — process is up
GET /api/ready     readiness — database reachable, migrations applied
```

Point the load balancer at `/api/ready`. A process that is up but cannot reach the
database should not receive traffic.

## Worker and cron

```bash
npm run worker -- --queues=default,notifications --concurrency=4
npm run cron
```

The worker claims jobs with `FOR UPDATE SKIP LOCKED`, so several workers cooperate
safely; that clause, not application logic, is what stops two workers processing the
same job. It shuts down gracefully on `SIGINT`/`SIGTERM` — it stops claiming and
finishes what it holds — so a rolling deploy does not abandon work mid-flight. Give
it a termination grace period of at least 30 seconds.

Set `WORKER_ID` per instance so job leases and audit rows are attributable.

A crashed worker's leases are reclaimed after the visibility timeout, so its jobs are
not stranded.

## Rollback

The application rolls back by redeploying the previous image. The database does not
roll back automatically, which is why the expand/contract order above matters.

```bash
# 1. Redeploy the previous application version.
# 2. Only if that version cannot run against the current schema:
npx prisma migrate resolve --rolled-back <migration_name>
#    then restore from backup or PITR to before the migration.
```

Never edit a migration that has been applied anywhere. Write a new one.

## Scaling

**Web** — stateless; add instances. Keep `DATABASE_POOL_MAX × instances` below
PostgreSQL's `max_connections`, and use a pooler on serverless.

**Database** — the indexes are in place for the access patterns this application
actually has (see [DATABASE.md](DATABASE.md)). When it is time to tune:

- `pg_stat_statements` to find the real cost, not the assumed one.
- Attendance and ledger tables grow fastest. When attendance passes a few tens of
  millions of rows, partition `attendance_records` by `lessonDate` range — the
  existing indexes are already lesson-date-leading, so queries need no change.
- `AuditLog` is append-only and grows forever by design.
  `security.auditRetentionDays` exists for a retention policy; 0 keeps everything.
  Before enabling it, check your statutory retention period.

**Worker** — add instances; `SKIP LOCKED` handles the coordination.

## Observability

Structured JSON logs to stdout in production; ship them with whatever your platform
provides. A `requestId` correlates every log line, audit row, notification and job
from one request — it is also returned in the `x-request-id` header and quoted in
user-facing 500s, so a support ticket maps to exactly one trace.

Worth alerting on:

- HTTP 5xx rate
- `http.unhandled_error` (an error outside the taxonomy — always a bug)
- `audit.write_failed`
- `rate_limit.driver_failed` (the limiter fails open; a silent failure is an incident)
- Job queue depth, and any job reaching `DEAD`
- `notifications` stuck in `PENDING`
- No successful backup in 26 hours (see [BACKUP.md](BACKUP.md))
- `npm run verify:ledger` reporting drift — run it on a schedule

## Pre-flight checklist

Before the first production deploy:

- [ ] Every secret generated fresh; none from `.env.example`
- [ ] `APP_URL` is https
- [ ] `TRUST_PROXY` correct for the actual topology
- [ ] `FACE_RECOGNITION_PROVIDER` is not `mock`
- [ ] `STORAGE_DRIVER=s3` if the web tier is serverless or multi-instance
- [ ] TLS on the database connection (`?sslmode=require`)
- [ ] `npx prisma migrate deploy` run, `npm run db:verify` passing 18/18
- [ ] Backups configured **and one restore rehearsed**
- [ ] Exactly one cron process
- [ ] Worker running, graceful-shutdown grace period ≥ 30s
- [ ] Log shipping and alerts wired
- [ ] First `SUPER_ADMIN` created via `bootstrap-production.ts`, its temporary
      password changed
- [ ] Verified that `npm run db:seed` cannot reach production

## Known deployment gaps

Stated rather than implied:

- **No Dockerfile or CI pipeline is included.** The commands above are what either
  would run, but the files are not written.
- **`/api/health` and `/api/ready` are specified here but not yet implemented** as
  routes.
- **No Content-Security-Policy** (see [SECURITY.md](SECURITY.md)).
