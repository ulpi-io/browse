import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
    globals: false,
    // Run all tests in the same thread — shared BrowserManager + test server
    // (same behavior as bun test which runs everything in one process)
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
