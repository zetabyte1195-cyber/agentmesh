import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Many suites spin up real git repos, SQLite files, HTTP servers and child processes. Under
    // full-suite load on Windows the 5 s default caused rare, non-reproducible timeouts, so the
    // limits are generous; a genuinely hung test still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
