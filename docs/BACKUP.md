# Backup and disaster recovery

This system holds financial records and an audit trail that is append-only *by
design*. Losing it is not a recoverable inconvenience — an institution cannot
reconstruct who paid what from memory. Treat the database as the only thing here
that genuinely matters; the application is redeployable from git in minutes.

## What has to be backed up

| Asset | Why | Recoverable without a backup? |
| --- | --- | --- |
| **PostgreSQL database** | Every invoice, payment, ledger entry, attendance record and audit row | **No.** This is the irreplaceable asset. |
| **Object storage** (documents) | Contracts, ID scans, certificates, receipts | No. Scans cannot be re-created. |
| `.env` / secret store | `ENCRYPTION_KEY` decrypts TOTP secrets | Rotating it is survivable (users re-enrol 2FA), losing it silently is not |
| Application code | — | Yes, from git |
| `node_modules`, `.next` | — | Yes, rebuild |

**A database backup without the matching object storage is an incomplete backup.**
A `Document` row whose bytes are gone is a broken link on a student's record.

## Frequency and retention

Sized to the risk, not to a habit. An education provider's write volume is modest but
its tolerance for losing a payment record is near zero.

| What | Frequency | Retention |
| --- | --- | --- |
| Continuous WAL archiving / PITR | streaming | 7 days |
| Full logical dump | daily, off-peak | 30 daily |
| Full logical dump | weekly | 12 weekly |
| Full logical dump | monthly | 24 monthly |
| Object storage | daily incremental | 30 days + versioning |
| Restore rehearsal | **quarterly** | — |

**Targets:** RPO ≤ 5 minutes (with PITR), RTO ≤ 1 hour.

Monthly retention is 24 months because tuition disputes and tax enquiries surface
late. Check your jurisdiction's statutory retention period for financial records and
extend if it is longer.

### Managed PostgreSQL

If you use Neon, Supabase, RDS or Cloud SQL, PITR is a checkbox — turn it on and set
the window. **Then still take your own logical dumps.** A provider-side backup does
not protect you from losing the account, and a dump you hold is the only backup you
can restore somewhere else.

## Taking a backup

### Logical dump (portable, the one to keep off-site)

```bash
pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner --no-privileges \
  --file="edu-crm-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$DATABASE_URL"
```

`--format=custom` allows selective restore and parallel restore.
`--no-owner --no-privileges` makes the dump restorable as a different role, which
matters when restoring into a staging environment.

Verify every dump — an unverified backup is a hope:

```bash
pg_restore --list "edu-crm-....dump" > /dev/null && echo "dump readable"
```

### Physical / PITR

```bash
pg_basebackup -D /backup/base -Ft -z -P -X stream -d "$DATABASE_URL"
```

Requires `wal_level = replica` (or higher), `archive_mode = on` and an
`archive_command` shipping WAL off the machine. PITR is what turns "we lost today"
into "we lost five minutes".

### Object storage

- **S3/R2:** enable **versioning** plus a replication rule to a second bucket in
  another region. Versioning is what saves you from a deletion, which a replica
  faithfully copies.
- **Local driver:** `restic` or `borg` to off-site storage, snapshotting
  `STORAGE_LOCAL_PATH`. Note the local driver is unsuitable for multi-instance
  deployments in the first place.

### Encryption and off-site

Encrypt at rest and in transit, and keep at least one copy in a different failure
domain — a backup on the same host as the database does not survive the host.

```bash
pg_dump --format=custom "$DATABASE_URL" \
  | age -r "$AGE_RECIPIENT" \
  | aws s3 cp - "s3://edu-crm-backups/$(date -u +%Y/%m/%d)/db.dump.age"
```

Store the decryption key somewhere you can reach **when the database is down** — not
in the database, and not only in the same secret manager the app uses.

## Restoring

### Full restore

```bash
# 1. Stop writers so nothing races the restore.
#    Pause the web app and the worker; leave the database reachable.

# 2. Restore into a FRESH database. Never over a live one — a half-restored
#    database mixed with live rows is worse than no restore.
createdb edu_crm_erp_restored
pg_restore \
  --dbname="postgresql://…/edu_crm_erp_restored" \
  --no-owner --no-privileges \
  --jobs=4 \
  edu-crm-20260927T020000Z.dump

# 3. Verify BEFORE cutting over.
DATABASE_URL="postgresql://…/edu_crm_erp_restored" npm run db:verify
DATABASE_URL="postgresql://…/edu_crm_erp_restored" npm run verify:ledger

# 4. Confirm the migration state matches the code you are about to run.
DATABASE_URL="postgresql://…/edu_crm_erp_restored" npx prisma migrate status

# 5. Point DATABASE_URL at the restored database and restart.
```

Step 3 is the part people skip. `db:verify` confirms the constraints and triggers
survived the restore; `verify:ledger` confirms the money adds up. A restore that
brings back rows but loses the append-only triggers looks fine and has quietly
removed a guarantee.

### Point-in-time recovery

To just before a bad migration or a mistaken bulk update:

```bash
# recovery.signal + postgresql.conf
restore_command = 'cp /backup/wal/%f %p'
recovery_target_time = '2026-09-27 14:05:00+05'
recovery_target_action = 'promote'
```

Then run the same verification steps.

### Restoring one table

`ledger_entries` and `audit_logs` carry a trigger blocking `UPDATE`/`DELETE`, so a
partial restore into a live table needs the documented escape hatch — in **one
transaction**, so the permission dies with it:

```sql
BEGIN;
SET LOCAL app.allow_history_mutation = 'on';
-- targeted repair
COMMIT;
```

Prefer restoring to a separate database and copying rows forward. Reaching for the
escape hatch on a live financial table should feel uncomfortable; that is the point.

## Rehearse the restore

**Quarterly, restore the latest dump into a scratch database and run the
verification steps.** Record how long it took.

A backup you have never restored is a belief, not a control. The failure modes that
bite are the boring ones: the dump was truncated, the encryption key was rotated, the
object storage bucket was never in scope, `pg_restore` needed a role that does not
exist in the target. All of them are cheap to find in a rehearsal and expensive to
find during an outage.

## Disaster scenarios

| Scenario | Response |
| --- | --- |
| Accidental `DELETE`/`UPDATE` on a live table | PITR to just before it. Do **not** improvise a repair on the live table first — you will destroy the evidence of what the correct values were. |
| Bad migration | `prisma migrate resolve --rolled-back` then restore, or PITR to before it. Test every migration on a restored copy of production first. |
| Whole database lost | Restore the newest verified dump, replay WAL if available, verify, cut over. |
| Region outage | Restore into another region from the off-site copy. Redeploy the app there; it is stateless apart from `DATABASE_URL` and storage config. |
| Object storage lost | Restore from the versioned/replicated bucket. `Document` rows whose bytes are unrecoverable should be reported to staff, **not silently hidden** — a missing contract is something a person needs to know about. |
| `ENCRYPTION_KEY` lost | TOTP secrets become undecryptable. Clear `twoFactorSecret`/`twoFactorEnabled` for affected users and have them re-enrol. Nothing else is encrypted with it. **Passwords are unaffected** — Argon2 hashes are not encrypted. |
| Ransomware / compromise | Restore to a point before the compromise, rotate every secret in `.env`, revoke all sessions (`Session` rows), force a password reset, and review `AuditLog` and `LoginAttempt` for the entry point. |

## Monitoring

Silent backup failure is the worst outcome, so alert on the **absence** of success:

- No successful dump in 26 hours → page.
- Dump size deviating more than ~30% from the trailing median → investigate (a
  truncated dump often still exits 0).
- WAL archiving falling behind → page.
- `verify:ledger` reporting drift → investigate immediately; it means a derived
  cache and the ledger disagree.
- Quarterly rehearsal not recorded → chase it.

## Local development

The development cluster in `.dev-db/` is **not** backed up and does not need to be:
`npm run db:reset` rebuilds the schema and reseeds in under a minute. Nothing in it
is real — every person in the seed is invented.
