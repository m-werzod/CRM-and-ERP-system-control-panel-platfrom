import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 configuration.
 *
 * The schema lives in `prisma/schema/` as one file per domain rather than a
 * single 3000-line file. Prisma recursively collects every *.prisma in that
 * folder, so relations may cross files freely.
 */
export default defineConfig({
  schema: 'prisma/schema',

  datasource: {
    url: env('DATABASE_URL'),
    // Prisma needs a scratch database to diff migrations against. The embedded
    // development cluster exposes one alongside the main database; in CI and
    // production this is unset and `migrate deploy` is used, which needs no
    // shadow database.
    shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
  },

  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
});
