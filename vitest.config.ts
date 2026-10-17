import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Many suites spin up real git repos, SQLite files, HTTP servers and child processes. Under
    // full-suite load on Windows the 5 s default caused rare, non-reproducible timeouts, so the
    // limits are generous; a genuinely hung test still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'daemon', environment: 'node', include: ['packages/{core,daemon,cli}/src/**/*.test.ts'] },
      },
      {
        // The cockpit: its logic and its Svelte components, rendered in a simulated browser.
        extends: true,
        plugins: [svelte(), svelteTesting()],
        test: { name: 'dashboard', environment: 'jsdom', include: ['packages/dashboard/src/**/*.test.ts'] },
      },
    ],
  },
});
