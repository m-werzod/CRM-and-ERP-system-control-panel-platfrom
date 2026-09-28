/**
 * Cron sweep entrypoint.
 *
 * Usage:
 *   tsx scripts/cron.ts                run a tick every 30s until stopped
 *   tsx scripts/cron.ts --once         one tick, then exit
 *   tsx scripts/cron.ts --interval=60000
 *
 * The sweep only ENQUEUES: it reads `CronSchedule` rows, decides which are due in
 * their own timezone, and hands the work to a job. Nothing happens unless a
 * worker is also running (`npm run worker`).
 *
 * `--once` is the mode for an external scheduler -- a Kubernetes CronJob, or the
 * host's own crontab calling this every minute. The default loop is for a
 * long-lived process where there is nothing else to drive the tick. Both are safe
 * to run simultaneously: each due slot is enqueued under an idempotency key
 * derived from the slot, so a second sweep finds the first one's job rather than
 * creating a duplicate.
 */

import 'dotenv/config';
import process from 'node:process';
import { prisma } from '@/server/db/client';
import { runCron, runCronLoop } from '@/server/jobs/cron';

function fail(message: string): never {
  console.error(`\n  cron: ${message}\n`);
  process.exit(1);
}

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

const flags = parseFlags(process.argv.slice(2));

const intervalRaw = flags.get('interval');
let intervalMs: number | undefined;
if (intervalRaw !== undefined) {
  intervalMs = Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    fail(`--interval must be an integer of at least 1000 ms, got "${intervalRaw}"`);
  }
}

try {
  if (flags.get('once') === 'true') {
    const result = await runCron();
    console.log(
      `  cron tick: ${result.evaluated} schedule(s) evaluated, ${result.enqueued} enqueued, ` +
        `${result.deduplicated} already queued, ${result.notDue} not due, ` +
        `${result.invalid} invalid, ${result.failed} failed`,
    );
    // An invalid schedule is a configuration error an operator has to fix, so an
    // external scheduler should see a non-zero exit rather than a silent success.
    if (result.invalid > 0 || result.failed > 0) process.exitCode = 1;
  } else {
    await runCronLoop({ intervalMs });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => {});
}
