/**
 * Integration tests for session multiplexing
 *
 * Verifies that multiple sessions sharing a single Chromium browser
 * have fully isolated state: navigation, tabs, refs, buffers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { SessionManager } from '../src/session-manager';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { handleSnapshot } from '../src/snapshot';
import { startTestServer } from './test-server';

let testServer: ReturnType<typeof startTestServer>;
let browser: Browser;
let sm: SessionManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  browser = await chromium.launch({ headless: true });
  sm = new SessionManager(browser);
});

afterAll(async () => {
  try { testServer.server.stop(); } catch {}
  await sm.closeAll().catch(() => {});
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
});

// ─── Navigation Isolation ────────────────────────────────────

describe('Navigation isolation', () => {
  test('two sessions navigate to different URLs independently', async () => {
    const a = await sm.getOrCreate('nav-a');
    const b = await sm.getOrCreate('nav-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    expect(a.manager.getCurrentUrl()).toContain('basic.html');
    expect(b.manager.getCurrentUrl()).toContain('forms.html');
  });

  test('navigating session A does not affect session B', async () => {
    const a = await sm.getOrCreate('nav-a');
    const b = await sm.getOrCreate('nav-b');

    // A navigates elsewhere
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], a.manager);

    // B should still be on forms.html
    expect(b.manager.getCurrentUrl()).toContain('forms.html');
    expect(a.manager.getCurrentUrl()).toContain('spa.html');
  });

  test('text content is isolated per session', async () => {
    const a = await sm.getOrCreate('nav-a2');
    const b = await sm.getOrCreate('nav-b2');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    const textA = await handleReadCommand('text', [], a.manager);
    const textB = await handleReadCommand('text', [], b.manager);

    expect(textA).toContain('Hello World');
    expect(textB).toContain('Form Test Page');
    expect(textA).not.toContain('Form Test Page');
    expect(textB).not.toContain('Hello World');
  });
});

// ─── Buffer Isolation ────────────────────────────────────────

describe('Buffer isolation', () => {
  test('console buffers are independent per session', async () => {
    const a = await sm.getOrCreate('buf-a');
    const b = await sm.getOrCreate('buf-b');

    // SPA page logs to console
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], a.manager);
    await handleWriteCommand('wait', ['.loaded'], a.manager);

    // B navigates to a page without console output
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], b.manager);

    const consoleA = await handleReadCommand('console', [], a.manager, a.buffers);
    const consoleB = await handleReadCommand('console', [], b.manager, b.buffers);

    expect(consoleA).toContain('[SPA]');
    expect(consoleB).not.toContain('[SPA]');
  });

  test('network buffers are independent per session', async () => {
    const a = await sm.getOrCreate('net-a');
    const b = await sm.getOrCreate('net-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    const networkA = await handleReadCommand('network', [], a.manager, a.buffers);
    const networkB = await handleReadCommand('network', [], b.manager, b.buffers);

    expect(networkA).toContain('basic.html');
    expect(networkA).not.toContain('forms.html');
    expect(networkB).toContain('forms.html');
    expect(networkB).not.toContain('basic.html');
  });

  test('clearing one session buffer does not affect another', async () => {
    const a = await sm.getOrCreate('clear-a');
    const b = await sm.getOrCreate('clear-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    // Clear A's network buffer
    await handleReadCommand('network', ['--clear'], a.manager, a.buffers);

    const networkA = await handleReadCommand('network', [], a.manager, a.buffers);
    const networkB = await handleReadCommand('network', [], b.manager, b.buffers);

    expect(networkA).toBe('(no network requests)');
    expect(networkB).toContain('forms.html');
  });
});

// ─── Ref Isolation ──────────────────────────────────────────

describe('Ref isolation', () => {
  test('snapshot refs are independent per session', async () => {
    const a = await sm.getOrCreate('ref-a');
    const b = await sm.getOrCreate('ref-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    const snapA = await handleSnapshot(['-i'], a.manager);
    const snapB = await handleSnapshot(['-i'], b.manager);

    // Both have refs but for different pages
    expect(snapA).toContain('@e');
    expect(snapB).toContain('@e');

    // Ref counts may differ (forms page has more interactive elements)
    expect(a.manager.getRefCount()).toBeGreaterThan(0);
    expect(b.manager.getRefCount()).toBeGreaterThan(0);
  });
});

// ─── Tab Isolation ──────────────────────────────────────────

describe('Tab isolation', () => {
  test('tabs are independent per session', async () => {
    const a = await sm.getOrCreate('tab-a');
    const b = await sm.getOrCreate('tab-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);

    // Open extra tabs in session A
    await a.manager.newTab(baseUrl + '/forms.html');
    await a.manager.newTab(baseUrl + '/spa.html');

    // Session B should have only its initial tab
    expect(a.manager.getTabCount()).toBe(3);
    expect(b.manager.getTabCount()).toBe(1);
  });
});

// ─── Session Lifecycle ──────────────────────────────────────

describe('Session lifecycle', () => {
  test('closing one session does not affect another', async () => {
    const a = await sm.getOrCreate('life-a');
    const b = await sm.getOrCreate('life-b');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);

    await sm.closeSession('life-a');

    // B should still work
    const text = await handleReadCommand('text', [], b.manager);
    expect(text).toContain('Form Test Page');
  });

  test('closeSession throws on non-existent session', async () => {
    expect(sm.closeSession('nonexistent')).rejects.toThrow('not found');
  });

  test('listSessions returns correct info', async () => {
    const list = sm.listSessions();
    expect(list.length).toBeGreaterThan(0);
    // Each entry should have the expected shape
    const entry = list[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('tabs');
    expect(entry).toHaveProperty('url');
    expect(entry).toHaveProperty('idleSeconds');
  });

  test('closeIdleSessions removes only idle sessions', async () => {
    const fresh = await sm.getOrCreate('idle-test');
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], fresh.manager);

    // All sessions are fresh — none should be closed with a long timeout
    const closed = await sm.closeIdleSessions(999_999_999);
    expect(closed).not.toContain('idle-test');

    // With 0ms timeout, everything is "idle"
    const closedAll = await sm.closeIdleSessions(0);
    expect(closedAll.length).toBeGreaterThan(0);
  });
});
