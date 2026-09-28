import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Two projects with different needs:
 *
 *   unit         pure functions -- money, dates, validation, RBAC, payroll maths.
 *                No database, so they run in parallel threads and finish fast.
 *
 *   integration  real PostgreSQL. Each file gets its own transaction-wrapped
 *                fixture and they must NOT run concurrently against one
 *                database, so the pool is single-forked.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    setupFiles: ['tests/setup/env.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/server/**/*.ts', 'src/lib/**/*.ts'],
      exclude: ['src/generated/**', '**/*.d.ts'],
    },
    poolOptions: {
      // Integration tests share one database; running files in parallel would
      // make them fight over the same rows.
      forks: { singleFork: true },
    },
    pool: 'forks',
  },
});
