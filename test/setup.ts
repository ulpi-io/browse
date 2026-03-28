/**
 * Shared test globals — single BrowserManager + test server for all test files.
 *
 * Usage: import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
 */

import { beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/manager';
import { startTestServer } from './test-server';

export let sharedBm: BrowserManager;
export let sharedBaseUrl: string;
export let sharedServer: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  sharedServer = await startTestServer(0);
  sharedBaseUrl = sharedServer.url;
  sharedBm = new BrowserManager();
  await sharedBm.launch();
});

afterAll(async () => {
  try { sharedServer.server.close(); } catch {}
  await Promise.race([
    sharedBm.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
});
