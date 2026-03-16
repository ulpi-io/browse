/**
 * Shared test globals — single BrowserManager + test server for all test files.
 *
 * Bun test runs all files in the same process, so module-level state
 * is shared. This eliminates Chrome resource contention from 10 parallel
 * Chrome launches across 6 test files.
 *
 * Usage: import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
 */

import { beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { startTestServer } from './test-server';

export let sharedBm: BrowserManager;
export let sharedBaseUrl: string;
export let sharedServer: ReturnType<typeof startTestServer>;

beforeAll(async () => {
  sharedServer = startTestServer(0);
  sharedBaseUrl = sharedServer.url;
  sharedBm = new BrowserManager();
  await sharedBm.launch();
});

afterAll(async () => {
  try { sharedServer.server.stop(); } catch {}
  await Promise.race([
    sharedBm.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
});
