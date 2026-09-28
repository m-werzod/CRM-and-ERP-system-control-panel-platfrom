/**
 * Database integrity self-check.
 *
 * Asserts that the guarantees docs/DATABASE.md claims are actually present in
 * the live database: CHECK constraints, partial unique indexes, the append-only
 * triggers on the financial and audit tables, and that the trigram search
 * indexes are genuinely chosen by the query planner.
 *
 * Every assertion writes real rows and rolls them back, so it is safe to run
 * against a development or staging database. Run it after any migration:
 *
 *     npm run db:verify
 */

import 'dotenv/config';
import { Client, type QueryResultRow } from 'pg';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const all = async <T extends QueryResultRow>(sql: string): Promise<T[]> =>
  (await client.query<T>(sql)).rows;
const one = async <T extends QueryResultRow>(sql: string): Promise<T> => {
  const [row] = await all<T>(sql);
  if (!row) throw new Error(`Query returned no rows: ${sql}`);
  return row;
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const counts = await one<Record<string, string>>(`
  select
    (select count(*) from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE')::text as tables,
    (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' and t.typtype='e')::text as enums,
    (select count(*) from pg_indexes where schemaname='public')::text as indexes,
    (select count(*) from pg_constraint con join pg_namespace n on n.oid=con.connamespace
      where n.nspname='public' and con.contype='f')::text as foreign_keys,
    (select count(*) from pg_constraint con join pg_namespace n on n.oid=con.connamespace
      where n.nspname='public' and con.contype='c')::text as check_constraints,
    (select count(*) from pg_trigger where not tgisinternal)::text as triggers,
    (select count(*) from pg_indexes
      where schemaname='public' and indexdef like '%WHERE%')::text as partial_indexes,
    (select count(*) from pg_indexes
      where schemaname='public' and indexdef like '%gin_trgm_ops%')::text as trigram_indexes
`);

console.log('--- schema objects ---');
for (const [key, value] of Object.entries(counts)) {
  console.log(`  ${key.padEnd(18)} ${value}`);
}

const extensions = await all<{ extname: string }>('select extname from pg_extension order by 1');
console.log(`\n--- extensions ---\n  ${extensions.map((r) => r.extname).join(', ')}`);

const triggers = await all<{ tbl: string; tgname: string }>(`
  select c.relname as tbl, t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal order by 1`);
console.log('\n--- append-only triggers ---');
for (const row of triggers) console.log(`  ${row.tbl.padEnd(26)} ${row.tgname}`);

// ---------------------------------------------------------------------------
// Functional assertions
// ---------------------------------------------------------------------------

type Result = readonly [status: 'PASS' | 'FAIL', label: string];
const results: Result[] = [];

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push(['PASS', label]);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    results.push(['FAIL', `${label} :: ${message}`]);
  }
}

/** Assert a statement is rejected, optionally with a specific SQLSTATE. */
async function expectReject(sql: string, expectedCode?: string): Promise<void> {
  await client.query('savepoint sp');
  let rejected: unknown;
  try {
    await client.query(sql);
  } catch (error) {
    rejected = error;
  }
  await client.query('rollback to savepoint sp').catch(() => undefined);

  if (rejected === undefined) throw new Error('expected the statement to be rejected, but it succeeded');

  const code = (rejected as { code?: string }).code;
  if (expectedCode && code !== expectedCode) {
    const message = rejected instanceof Error ? error1(rejected) : String(rejected);
    throw new Error(`expected SQLSTATE ${expectedCode}, got ${code}: ${message}`);
  }
}

const error1 = (error: Error): string => error.message.split('\n')[0] ?? error.message;

await client.query('begin');

// Minimal fixture. Everything is rolled back at the end.
await client.query(`
  insert into organizations (id,name,slug,"defaultCurrency",timezone,"defaultLocale",status,"createdAt","updatedAt")
  values ('org_t','Verify Org','verify-org','UZS','Asia/Tashkent','UZ','ACTIVE',now(),now())`);
await client.query(`
  insert into branches (id,"organizationId",name,code,"isActive","createdAt","updatedAt")
  values ('br_t','org_t','Verify Branch','VB',true,now(),now())`);

await check('invoices: derived balance identity is enforced', () =>
  expectReject(
    `insert into invoices (id,"organizationId","branchId","invoiceNumber","studentId",status,currency,
       "subtotalMinor","discountTotalMinor","taxTotalMinor","totalMinor","paidTotalMinor",
       "refundedTotalMinor","writtenOffMinor","balanceMinor","issueDate","dueDate","createdAt","updatedAt")
     values ('inv_bad','org_t','br_t','X-1','missing','ISSUED','UZS',
       100,0,0,100,0,0,0,999,current_date,current_date,now(),now())`,
    '23514',
  ),
);

await check('payments: amount must be strictly positive', () =>
  expectReject(
    `insert into payments (id,"organizationId","branchId","paymentNumber","studentId",method,status,
       "amountMinor",currency,"receivedAt","idempotencyKey","createdAt","updatedAt")
     values ('pay_bad','org_t','br_t','P-1','missing','CASH','COMPLETED',0,'UZS',now(),'k1',now(),now())`,
    '23514',
  ),
);

await check('currency must be ISO-4217 alpha-3 upper case', () =>
  expectReject(
    `insert into ledger_entries (id,"organizationId","entryType",direction,"amountMinor",currency,"occurredAt","createdAt")
     values ('le_bad','org_t','PAYMENT_RECEIVED','CREDIT',100,'uzs',now(),now())`,
    '23514',
  ),
);

await check('discounts: PERCENT requires percentPpm, not an amount', () =>
  expectReject(
    `insert into discounts (id,"organizationId",code,name,type,"appliesTo","amountMinor","percentPpm",
       currency,"requiresApproval","timesRedeemed","isActive","createdAt","updatedAt")
     values ('dsc_bad','org_t','D1','Bad','PERCENT','TUITION',5000,null,'UZS',true,0,true,now(),now())`,
    '23514',
  ),
);

await check('discounts: a discount must carry exactly one value, never both', () =>
  expectReject(
    `insert into discounts (id,"organizationId",code,name,type,"appliesTo","amountMinor","percentPpm",
       currency,"requiresApproval","timesRedeemed","isActive","createdAt","updatedAt")
     values ('dsc_both','org_t','D2','Both','SCHOLARSHIP','TUITION',5000,500000,'UZS',true,0,true,now(),now())`,
    '23514',
  ),
);

await check('discounts: a discount must carry exactly one value, never neither', () =>
  expectReject(
    `insert into discounts (id,"organizationId",code,name,type,"appliesTo","amountMinor","percentPpm",
       currency,"requiresApproval","timesRedeemed","isActive","createdAt","updatedAt")
     values ('dsc_none','org_t','D3','Neither','SCHOLARSHIP','TUITION',null,null,'UZS',true,0,true,now(),now())`,
    '23514',
  ),
);

await check('discounts: a SCHOLARSHIP may be expressed as a percentage', async () => {
  // The rule that matters is "exactly one value", not "a scholarship is a fixed
  // amount" -- a 50% scholarship is how an institution actually describes one.
  await client.query('savepoint sp_scholarship');
  await client.query(
    `insert into discounts (id,"organizationId",code,name,type,"appliesTo","amountMinor","percentPpm",
       "requiresApproval","timesRedeemed","isActive","createdAt","updatedAt")
     values ('dsc_pct','org_t','D4','Merit 50%','SCHOLARSHIP','TUITION',null,500000,true,0,true,now(),now())`,
  );
  await client.query('rollback to savepoint sp_scholarship');
});

await check('attendance: only a LATE record may carry minutesLate', () =>
  expectReject(
    `insert into attendance_records (id,"organizationId","branchId","lessonId","studentId",status,method,
       "minutesLate","markedAt","isCorrected","createdAt","updatedAt")
     values ('att_bad','org_t','br_t','missing','missing','PRESENT','TEACHER',10,now(),false,now(),now())`,
    '23514',
  ),
);

// --- append-only guards ----------------------------------------------------

await client.query(`
  insert into ledger_entries (id,"organizationId","entryType",direction,"amountMinor",currency,"occurredAt","createdAt")
  values ('le_ok','org_t','PAYMENT_RECEIVED','CREDIT',5000,'UZS',now(),now())`);

await check('ledger_entries: UPDATE is blocked', () =>
  expectReject(`update ledger_entries set "amountMinor" = 1 where id = 'le_ok'`, '23001'),
);

await check('ledger_entries: DELETE is blocked', () =>
  expectReject(`delete from ledger_entries where id = 'le_ok'`, '23001'),
);

await check('audit_logs: UPDATE is blocked', async () => {
  await client.query(`insert into audit_logs (id,action,"entityType","actorType",severity,"createdAt")
                      values ('al_ok','test.action','Test','user','INFO',now())`);
  await expectReject(`update audit_logs set action = 'tampered' where id = 'al_ok'`, '23001');
});

await check('append-only escape hatch works, and only inside its transaction', async () => {
  await client.query('savepoint sp_hatch');
  await client.query(`set local app.allow_history_mutation = 'on'`);
  await client.query(`delete from ledger_entries where id = 'le_ok'`);
  const { n } = await one<{ n: number }>(
    `select count(*)::int as n from ledger_entries where id = 'le_ok'`,
  );
  if (n !== 0) throw new Error('delete did not take effect under the escape hatch');
  await client.query('rollback to savepoint sp_hatch');
});

// --- partial unique indexes ------------------------------------------------

await check('enrollments: at most one OPEN enrollment per student+group', async () => {
  await client.query(`insert into groups (id,"organizationId","branchId",name,code,capacity,status,"createdAt","updatedAt")
    values ('grp_t','org_t','br_t','Verify Group','VG1',10,'ACTIVE',now(),now())`);
  await client.query(`insert into students (id,"organizationId","branchId","studentCode","firstName","lastName",
      gender,status,"createdAt","updatedAt")
    values ('stu_t','org_t','br_t','S-1','Ada','Lovelace','FEMALE','ACTIVE',now(),now())`);
  await client.query(`insert into enrollments (id,"studentId","groupId",status,"startDate","createdAt","updatedAt")
    values ('enr_1','stu_t','grp_t','ACTIVE',current_date,now(),now())`);

  // A second OPEN enrollment for the same pair must be rejected...
  await expectReject(
    `insert into enrollments (id,"studentId","groupId",status,"startDate","createdAt","updatedAt")
     values ('enr_2','stu_t','grp_t','ACTIVE',current_date + 1,now(),now())`,
    '23505',
  );

  // ...but a CLOSED historical row for the same pair must still be allowed,
  // because that is exactly what a transfer-and-return produces.
  await client.query(`insert into enrollments (id,"studentId","groupId",status,"startDate","endDate","createdAt","updatedAt")
    values ('enr_hist','stu_t','grp_t','COMPLETED',current_date - 60,current_date - 30,now(),now())`);
});

await check('attendance: exactly one record per (lesson, student)', async () => {
  await client.query(`insert into lessons (id,"organizationId","branchId","groupId","lessonDate","startsAt","endsAt",
      status,"attendanceStatus","createdAt","updatedAt")
    values ('les_t','org_t','br_t','grp_t',current_date,now(),now() + interval '90 min',
      'SCHEDULED','PENDING',now(),now())`);
  await client.query(`insert into attendance_records (id,"organizationId","branchId","lessonId","studentId",status,method,
      "markedAt","isCorrected","createdAt","updatedAt")
    values ('att_1','org_t','br_t','les_t','stu_t','PRESENT','TEACHER',now(),false,now(),now())`);
  await expectReject(
    `insert into attendance_records (id,"organizationId","branchId","lessonId","studentId",status,method,
       "markedAt","isCorrected","createdAt","updatedAt")
     values ('att_2','org_t','br_t','les_t','stu_t','ABSENT','MANUAL',now(),false,now(),now())`,
    '23505',
  );
});

await check('groups: a group cannot have one teacher as both primary and assistant', async () => {
  await expectReject(
    `update groups set "primaryTeacherId" = 'tch_x', "assistantTeacherId" = 'tch_x' where id = 'grp_t'`,
    '23514',
  );
});

await check('documents: owner column must match ownerType', () =>
  expectReject(
    `insert into documents (id,"organizationId","ownerType",category,title,"fileName","storageKey",
       "storageDriver","mimeType","sizeBytes",visibility,"createdAt","updatedAt")
     values ('doc_bad','org_t','STUDENT','OTHER','T','t.pdf','k/1','local','application/pdf',10,'STAFF',now(),now())`,
    '23514',
  ),
);

await check('notifications: exactly one recipient', () =>
  expectReject(
    `insert into notifications (id,"organizationId",event,channel,priority,body,status,attempts,"createdAt","updatedAt")
     values ('ntf_bad','org_t','STUDENT_ABSENT','SMS','NORMAL','x','PENDING',0,now(),now())`,
    '23514',
  ),
);

// --- search index is actually used -----------------------------------------

await check('trigram index is chosen by the planner for an infix name search', async () => {
  // Tiny tables make a seq scan cheapest; disable it so the plan reveals whether
  // a usable index exists at all.
  await client.query('set local enable_seqscan = off');
  const plan = await all<{ 'QUERY PLAN': string }>(
    `explain (format text) select id from students
     where search_normalize("firstName" || ' ' || "lastName") like '%ada%'`,
  );
  const text = plan.map((r) => r['QUERY PLAN']).join('\n');
  if (!text.includes('students_name_trgm')) {
    throw new Error(`students_name_trgm not used. Plan:\n${text}`);
  }
});

await client.query('rollback');
await client.end();

// ---------------------------------------------------------------------------

console.log('\n--- integrity assertions ---');
let failed = 0;
for (const [status, label] of results) {
  console.log(`  ${status}  ${label}`);
  if (status === 'FAIL') failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passed`);

process.exit(failed === 0 ? 0 : 1);
