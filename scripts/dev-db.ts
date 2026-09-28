/**
 * Local development PostgreSQL manager.
 *
 * This machine has neither Docker nor a PostgreSQL service, so development runs
 * a real PostgreSQL 17 cluster from the binaries shipped by the
 * `@embedded-postgres/*` platform packages. We drive `pg_ctl` directly rather
 * than using the `embedded-postgres` wrapper class, because that wrapper
 * registers an exit hook that shuts the cluster down as soon as the managing
 * Node process ends -- fine for a test harness, useless for `npm run db:up`
 * followed by `npm run dev`.
 *
 * What this gives us is a genuine PostgreSQL server: real migrations, real
 * constraints, real transactions. It is a development convenience only --
 * staging and production use a managed PostgreSQL via DATABASE_URL, and
 * docker-compose.yml is provided for machines that have Docker.
 *
 * Usage:
 *   tsx scripts/dev-db.ts up       start (initialising the cluster if needed)
 *   tsx scripts/dev-db.ts down     stop the cluster, keep the data
 *   tsx scripts/dev-db.ts status   report whether it is running and reachable
 *   tsx scripts/dev-db.ts destroy  stop and delete the cluster entirely
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Client } from 'pg';
import 'dotenv/config';

const require = createRequire(import.meta.url);

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const CLUSTER_DIR = path.join(PROJECT_ROOT, '.dev-db', 'cluster');
const LOG_FILE = path.join(PROJECT_ROOT, '.dev-db', 'postgres.log');
const PW_FILE = path.join(PROJECT_ROOT, '.dev-db', '.initdb-password');

/** Parsed out of DATABASE_URL so there is exactly one source of truth. */
interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  shadowDatabase: string;
}

function readTarget(): DbTarget {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    fail(
      'DATABASE_URL is not set. Copy .env.example to .env (the default value points at this local cluster).',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`DATABASE_URL is not a valid URL: ${raw}`);
  }
  if (!url.protocol.startsWith('postgres')) {
    fail(`DATABASE_URL must be a postgresql:// URL, got ${url.protocol}`);
  }

  const database = url.pathname.replace(/^\//, '');
  const shadowRaw = process.env.SHADOW_DATABASE_URL;
  let shadowDatabase = `${database}_shadow`;
  if (shadowRaw) {
    try {
      shadowDatabase = new URL(shadowRaw).pathname.replace(/^\//, '') || shadowDatabase;
    } catch {
      // Fall back to the derived name; validate() surfaces a bad URL elsewhere.
    }
  }

  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username) || 'postgres',
    password: decodeURIComponent(url.password) || 'password',
    database: database || 'postgres',
    shadowDatabase,
  };
}

/**
 * Locate the platform's PostgreSQL binaries. The `embedded-postgres` package
 * declares the per-platform binary packages as optional dependencies, so npm
 * installs only the one matching this machine.
 */
function binDir(): string {
  const platformPackages: Record<string, string> = {
    'win32-x64': '@embedded-postgres/windows-x64',
    'darwin-x64': '@embedded-postgres/darwin-x64',
    'darwin-arm64': '@embedded-postgres/darwin-arm64',
    'linux-x64': '@embedded-postgres/linux-x64',
    'linux-arm64': '@embedded-postgres/linux-arm64',
    'linux-ia32': '@embedded-postgres/linux-ia32',
  };
  const key = `${process.platform}-${process.arch}`;
  const pkg = platformPackages[key];
  if (!pkg) {
    fail(
      `No bundled PostgreSQL binaries for ${key}. Set DATABASE_URL to an external PostgreSQL instance, or use docker-compose.yml.`,
    );
  }
  // Resolve without relying on the package exposing "./package.json" in its
  // exports map (it does not). Check the plain node_modules layout first, then
  // fall back to resolving the package entry point for hoisted/pnpm layouts.
  const candidates = [path.join(PROJECT_ROOT, 'node_modules', ...pkg.split('/'))];
  try {
    candidates.push(path.dirname(require.resolve(pkg)));
  } catch {
    // Entry point not resolvable either; the candidate list still has the
    // conventional location, and the error below covers both misses.
  }

  for (const root of candidates) {
    // The entry-point fallback lands in dist/, so also look one level up.
    for (const base of [root, path.dirname(root)]) {
      const dir = path.join(base, 'native', 'bin');
      if (fs.existsSync(dir)) return dir;
    }
  }
  return fail(`${pkg} is not installed (looked in ${candidates.join(', ')}). Run: npm install`);
}

function exe(name: string): string {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const full = path.join(binDir(), file);
  if (!fs.existsSync(full)) fail(`Missing PostgreSQL binary: ${full}`);
  return full;
}

function fail(message: string): never {
  console.error(`\n  dev-db: ${message}\n`);
  process.exit(1);
}

function clusterExists(): boolean {
  return fs.existsSync(path.join(CLUSTER_DIR, 'PG_VERSION'));
}

/** `pg_ctl status` exits 0 when running, 3 when stopped, 4 when there is no cluster. */
function isRunning(): boolean {
  const res = spawnSync(exe('pg_ctl'), ['status', '-D', CLUSTER_DIR], { encoding: 'utf8' });
  return res.status === 0;
}

function initCluster(target: DbTarget): void {
  console.log(`  initialising a new PostgreSQL cluster in ${path.relative(PROJECT_ROOT, CLUSTER_DIR)}`);
  fs.mkdirSync(path.dirname(CLUSTER_DIR), { recursive: true });

  // initdb reads the superuser password from a file rather than argv, so it
  // never appears in the process list. Removed immediately afterwards.
  fs.writeFileSync(PW_FILE, target.password, { encoding: 'utf8', mode: 0o600 });
  try {
    const res = spawnSync(
      exe('initdb'),
      [
        '-D', CLUSTER_DIR,
        '-U', target.user,
        `--pwfile=${PW_FILE}`,
        '-A', 'scram-sha-256',
        '-E', 'UTF8',
        '--locale=C',
      ],
      { encoding: 'utf8' },
    );
    if (res.status !== 0) {
      fail(`initdb failed (exit ${res.status}):\n${res.stderr || res.stdout}`);
    }
  } finally {
    fs.rmSync(PW_FILE, { force: true });
  }

  // Bind to loopback only: a development database must not be reachable from
  // the local network.
  fs.appendFileSync(
    path.join(CLUSTER_DIR, 'postgresql.conf'),
    [
      '',
      '# --- appended by scripts/dev-db.ts ---',
      "listen_addresses = '127.0.0.1'",
      `port = ${target.port}`,
      'max_connections = 100',
      "log_timezone = 'UTC'",
      "timezone = 'UTC'",
      'log_min_duration_statement = 500',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log('  cluster initialised');
}

async function waitUntilReachable(target: DbTarget, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: 'postgres',
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(
    `cluster did not become reachable within ${timeoutMs / 1000}s: ${String(lastError)}\n  See ${LOG_FILE}`,
  );
}

async function ensureDatabases(target: DbTarget): Promise<void> {
  const client = new Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: 'postgres',
  });
  await client.connect();
  try {
    for (const name of [target.database, target.shadowDatabase]) {
      const existing = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (existing.rowCount === 0) {
        // Database names cannot be parameterised; the value comes from our own
        // DATABASE_URL and is validated to be a plain identifier first.
        if (!/^[A-Za-z0-9_]+$/.test(name)) {
          fail(`Refusing to create database with unsafe name: ${name}`);
        }
        try {
          await client.query(`create database "${name}" encoding 'UTF8'`);
          console.log(`  created database ${name}`);
        } catch (error) {
          // 42P04 = duplicate_database. Two concurrent `db:up` runs can both
          // pass the existence check; losing that race is success, not failure.
          if ((error as { code?: string }).code !== '42P04') throw error;
          console.log(`  database ${name} already present`);
        }
      } else {
        console.log(`  database ${name} already present`);
      }
    }
  } finally {
    await client.end();
  }
}

async function up(): Promise<void> {
  const target = readTarget();
  if (!clusterExists()) initCluster(target);

  if (isRunning()) {
    console.log('  cluster already running');
  } else {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // stdio MUST be 'ignore' here. `pg_ctl start` leaves a detached postgres
    // server running, and that server inherits whatever stdio handles it was
    // given. With piped stdio, spawnSync blocks forever waiting for EOF on a
    // pipe the long-lived server is still holding open -- the parent hangs even
    // though the cluster came up fine. Diagnostics come from -l LOG_FILE, which
    // we tail on failure below.
    const res = spawnSync(
      exe('pg_ctl'),
      ['start', '-D', CLUSTER_DIR, '-l', LOG_FILE, '-w', '-t', '30', '-o', `-p ${target.port}`],
      { stdio: 'ignore' },
    );
    if (res.status !== 0) {
      const log = fs.existsSync(LOG_FILE)
        ? fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')
        : '(no log file)';
      fail(`pg_ctl start failed (exit ${res.status}). Log tail:\n${log}`);
    }
    console.log(`  cluster started on 127.0.0.1:${target.port}`);
  }

  await waitUntilReachable(target);
  await ensureDatabases(target);
  console.log('\n  PostgreSQL is ready. Next: npm run db:migrate && npm run db:seed\n');
}

function down(): void {
  if (!clusterExists()) {
    console.log('  no cluster to stop');
    return;
  }
  if (!isRunning()) {
    console.log('  cluster is not running');
    return;
  }
  const res = spawnSync(exe('pg_ctl'), ['stop', '-D', CLUSTER_DIR, '-m', 'fast', '-w', '-t', '30'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) fail(`pg_ctl stop failed:\n${res.stderr || res.stdout}`);
  console.log('  cluster stopped (data retained)');
}

async function status(): Promise<void> {
  const target = readTarget();
  console.log(`  cluster dir : ${CLUSTER_DIR}`);
  console.log(`  initialised : ${clusterExists() ? 'yes' : 'no'}`);
  console.log(`  running     : ${isRunning() ? 'yes' : 'no'}`);
  if (!isRunning()) return;

  const client = new Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const version = await client.query<{ version: string }>('select version()');
    const tables = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
    );
    console.log(`  reachable   : yes`);
    console.log(`  server      : ${version.rows[0]?.version.split(',')[0] ?? 'unknown'}`);
    console.log(`  public tables: ${tables.rows[0]?.count ?? '0'}`);
  } catch (error) {
    console.log(`  reachable   : no (${String(error)})`);
  } finally {
    await client.end().catch(() => {});
  }
}

function destroy(): void {
  down();
  if (fs.existsSync(CLUSTER_DIR)) {
    fs.rmSync(CLUSTER_DIR, { recursive: true, force: true });
    console.log('  cluster directory deleted');
  }
}

const command = process.argv[2] ?? 'up';
const commands: Record<string, () => void | Promise<void>> = { up, down, status, destroy };
const handler = commands[command];
if (!handler) fail(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(', ')}`);

await handler();
