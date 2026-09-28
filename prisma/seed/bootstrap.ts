/**
 * Imported FIRST by the seed, before anything that reads the environment.
 *
 * `src/server/env.ts` parses `process.env` at module-evaluation time, and ESM
 * evaluates imports in source order — so the only way to influence it from the
 * seed is a module that runs ahead of it. Setting `process.env.LOG_LEVEL` inside
 * `index.ts` would be too late: the import of `@/server/db/client` at the top of
 * that file has already pulled in `env.ts`.
 *
 * The seed writes through real use-cases, each of which emits an audit line per
 * write. At INFO that is several thousand lines of noise that buries the actual
 * progress report, so the seed runs at `warn` unless the operator asks otherwise.
 */

import 'dotenv/config';

// Overridden unconditionally, not with `??=`: .env sets LOG_LEVEL=debug for normal
// development, which would still bury the report. `SEED_VERBOSE=1` opts back in
// when you actually want to watch each audit line.
if (!process.env.SEED_VERBOSE) {
  process.env.LOG_LEVEL = 'warn';
}

// A seed against a production database would be destructive; refuse early, before
// a connection is even opened.
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'Refusing to seed with NODE_ENV=production. This data is fabricated and would corrupt a live tenant.',
  );
}
