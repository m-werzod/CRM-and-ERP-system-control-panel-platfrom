/**
 * Background worker entrypoint.
 *
 * Usage:
 *   tsx scripts/worker.ts
 *   tsx scripts/worker.ts --queues=notifications --concurrency=8
 *   tsx scripts/worker.ts --drain            process what is queued, then exit
 *
 * Flags:
 *   --queues=a,b            queues to serve (default: all of them)
 *   --concurrency=N         jobs in flight at once (default 4)
 *   --poll=MS               idle poll interval (default 2000)
 *   --visibility-timeout=MS lease age after which a job is presumed abandoned
 *   --max-jobs=N            stop claiming after N jobs
 *   --drain                 exit when the queues are empty instead of polling
 *
 * A deployment runs one of these per queue whose latency profile differs:
 * `--queues=notifications --concurrency=16` next to
 * `--queues=reports --concurrency=2`, so a four-minute export cannot delay an
 * absence SMS. SIGTERM (what a container runtime sends) stops claiming and waits
 * for in-flight handlers; a second one gives up on them.
 */

import 'dotenv/config';
import process from 'node:process';
import { prisma } from '@/server/db/client';
import { ALL_JOB_QUEUES } from '@/server/jobs/registry';
import { runWorker } from '@/server/jobs/worker';

// ---------------------------------------------------------------------------
// HANDLERS ARE NOT WIRED UP YET.
//
// `src/server/jobs/handlers/` does not exist in this build, so there is nothing
// to import here. When it lands, these two lines complete this script:
//
//     import { registerBuiltInHandlers } from '@/server/jobs/handlers';
//     registerBuiltInHandlers();
//
// Until then `runWorker()` refuses to start rather than claiming jobs it cannot
// run -- a worker with an empty registry would mark every job it claimed as
// permanently failed, emptying the queue into the dead-letter state. The refusal
// is deliberate and its message says exactly this.
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n  worker: ${message}\n`);
  process.exit(1);
}

/** `--key=value` and bare `--flag`. Deliberately not a CLI framework. */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) fail(`Unexpected argument "${arg}". Flags look like --key=value.`);
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.set(body, 'true');
    else flags.set(body.slice(0, eq), body.slice(eq + 1));
  }
  return flags;
}

function readInt(flags: Map<string, string>, key: string): number | undefined {
  const raw = flags.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`--${key} must be a positive integer, got "${raw}"`);
  return value;
}

const flags = parseFlags(process.argv.slice(2));

const queuesRaw = flags.get('queues');
const queues = queuesRaw
  ?.split(',')
  .map((queue) => queue.trim())
  .filter((queue) => queue !== '');

if (queues) {
  const unknown = queues.filter((queue) => !(ALL_JOB_QUEUES as readonly string[]).includes(queue));
  if (unknown.length > 0) {
    fail(`Unknown queue(s): ${unknown.join(', ')}. Known queues: ${ALL_JOB_QUEUES.join(', ')}`);
  }
}

try {
  const summary = await runWorker({
    queues,
    concurrency: readInt(flags, 'concurrency'),
    pollIntervalMs: readInt(flags, 'poll'),
    visibilityTimeoutMs: readInt(flags, 'visibility-timeout'),
    maxJobs: readInt(flags, 'max-jobs'),
    drain: flags.get('drain') === 'true',
  });
  console.log(
    `  worker ${summary.workerId} stopped: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.claimed} claimed`,
  );
} catch (error) {
  // Startup refusals (no handlers registered, unreachable database) land here.
  // The loop itself does not throw -- it logs and keeps going.
  console.error(error);
  process.exitCode = 1;
} finally {
  // Without this the pool's idle connections keep the event loop alive and the
  // process hangs after a --drain run instead of exiting.
  await prisma.$disconnect().catch(() => {});
}
