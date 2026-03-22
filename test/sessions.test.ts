/**
 * Integration tests for session multiplexing
 *
 * Verifies that multiple sessions sharing a single Chromium browser
 * have fully isolated state: navigation, tabs, refs, buffers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { SessionManager } from '../src/session-manager';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { handleSnapshot } from '../src/snapshot';
import { startTestServer } from './test-server';
import { encrypt, decrypt, resolveEncryptionKey } from '../src/encryption';
import { saveSessionState, loadSessionState, hasPersistedState, cleanOldStates } from '../src/session-persist';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testServer: Awaited<ReturnType<typeof startTestServer>>;
let browser: Browser;
let sm: SessionManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = await startTestServer(0);
  baseUrl = testServer.url;

  browser = await chromium.launch({ headless: true });
  sm = new SessionManager(browser);
});

afterAll(async () => {
  try { testServer.server.close(); } catch {}
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
    await expect(sm.closeSession('nonexistent')).rejects.toThrow('not found');
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

// ─── Session Persistence ────────────────────────────────────

describe('Session Persistence', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-persist-test-'));
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  test('encryption roundtrip', () => {
    const key = crypto.randomBytes(32);
    const original = 'Hello, encrypted world! Special chars: {}[]@#$%';
    const { ciphertext, iv, authTag } = encrypt(original, key);

    // Ciphertext should differ from plaintext
    expect(ciphertext).not.toBe(original);

    const decrypted = decrypt(ciphertext, iv, authTag, key);
    expect(decrypted).toBe(original);
  });

  test('encryption with wrong key fails', () => {
    const key = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const { ciphertext, iv, authTag } = encrypt('secret', key);

    expect(() => decrypt(ciphertext, iv, authTag, wrongKey)).toThrow();
  });

  test('resolveEncryptionKey generates and persists key', () => {
    const keyDir = path.join(tmpDir, 'key-test');
    fs.mkdirSync(keyDir, { recursive: true });

    const key1 = resolveEncryptionKey(keyDir);
    expect(key1).toBeInstanceOf(Buffer);
    expect(key1.length).toBe(32);

    // Calling again returns the same key (reads from file)
    const key2 = resolveEncryptionKey(keyDir);
    expect(key1.equals(key2)).toBe(true);

    // Key file should exist
    expect(fs.existsSync(path.join(keyDir, '.encryption-key'))).toBe(true);
  });

  test('session state save/load roundtrip', async () => {
    const sessionDir = path.join(tmpDir, 'state-roundtrip');

    // Use existing shared browser for the first context
    const bm1 = new BrowserManager();
    await bm1.launchWithBrowser(browser);
    await bm1.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });

    // Set a cookie on the context
    const ctx1 = bm1.getContext()!;
    await ctx1.addCookies([{
      name: 'persist-test',
      value: 'roundtrip-value',
      domain: '127.0.0.1',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }]);

    // Save state
    await saveSessionState(sessionDir, ctx1);

    // Create a new BrowserManager + context
    const bm2 = new BrowserManager();
    await bm2.launchWithBrowser(browser);
    const ctx2 = bm2.getContext()!;

    // Load state into the new context
    const loaded = await loadSessionState(sessionDir, ctx2);
    expect(loaded).toBe(true);

    // Verify the cookie was restored
    const cookies = await ctx2.cookies();
    const restored = cookies.find(c => c.name === 'persist-test');
    expect(restored).toBeDefined();
    expect(restored!.value).toBe('roundtrip-value');

    await bm1.close().catch(() => {});
    await bm2.close().catch(() => {});
  });

  test('encrypted state roundtrip', async () => {
    const sessionDir = path.join(tmpDir, 'state-encrypted');
    const key = crypto.randomBytes(32);

    // Create first context and set a cookie
    const bm1 = new BrowserManager();
    await bm1.launchWithBrowser(browser);
    await bm1.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });
    const ctx1 = bm1.getContext()!;
    await ctx1.addCookies([{
      name: 'encrypted-cookie',
      value: 'secret-value-42',
      domain: '127.0.0.1',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }]);

    // Save with encryption
    await saveSessionState(sessionDir, ctx1, key);

    // Verify the file on disk is encrypted (has "encrypted" field)
    const raw = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    expect(raw.encrypted).toBe(true);
    expect(raw.iv).toBeDefined();
    expect(raw.authTag).toBeDefined();
    // The plaintext cookie value should NOT appear in the raw file
    expect(JSON.stringify(raw)).not.toContain('secret-value-42');

    // Load into new context with the same key
    const bm2 = new BrowserManager();
    await bm2.launchWithBrowser(browser);
    const ctx2 = bm2.getContext()!;
    const loaded = await loadSessionState(sessionDir, ctx2, key);
    expect(loaded).toBe(true);

    const cookies = await ctx2.cookies();
    const restored = cookies.find(c => c.name === 'encrypted-cookie');
    expect(restored).toBeDefined();
    expect(restored!.value).toBe('secret-value-42');

    await bm1.close().catch(() => {});
    await bm2.close().catch(() => {});
  });

  test('loadSessionState returns false for encrypted file without key', async () => {
    const sessionDir = path.join(tmpDir, 'state-nokey');
    const key = crypto.randomBytes(32);

    // Save encrypted state
    const bm1 = new BrowserManager();
    await bm1.launchWithBrowser(browser);
    await bm1.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });
    await saveSessionState(sessionDir, bm1.getContext()!, key);

    // Try loading without a key
    const bm2 = new BrowserManager();
    await bm2.launchWithBrowser(browser);
    const loaded = await loadSessionState(sessionDir, bm2.getContext()!);
    expect(loaded).toBe(false);

    await bm1.close().catch(() => {});
    await bm2.close().catch(() => {});
  });

  test('missing state file returns false', async () => {
    const emptyDir = path.join(tmpDir, 'state-empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const bm1 = new BrowserManager();
    await bm1.launchWithBrowser(browser);
    const loaded = await loadSessionState(emptyDir, bm1.getContext()!);
    expect(loaded).toBe(false);

    await bm1.close().catch(() => {});
  });

  test('hasPersistedState detects saved state', async () => {
    const sessionDir = path.join(tmpDir, 'state-has');

    // Before saving: no state
    expect(hasPersistedState(sessionDir)).toBe(false);

    // Save state
    const bm1 = new BrowserManager();
    await bm1.launchWithBrowser(browser);
    await bm1.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });
    await saveSessionState(sessionDir, bm1.getContext()!);

    // After saving: state exists
    expect(hasPersistedState(sessionDir)).toBe(true);

    await bm1.close().catch(() => {});
  });

  test('hasPersistedState returns false for empty dir', () => {
    const emptyDir = path.join(tmpDir, 'state-no-file');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(hasPersistedState(emptyDir)).toBe(false);
  });

  test('cleanOldStates deletes old files and keeps recent ones', () => {
    const localDir = path.join(tmpDir, 'clean-test');
    const statesDir = path.join(localDir, 'states');
    const sessionsDir = path.join(localDir, 'sessions');
    fs.mkdirSync(statesDir, { recursive: true });

    // Create an "old" state file in states/
    const oldFile = path.join(statesDir, 'old-session.json');
    fs.writeFileSync(oldFile, JSON.stringify({ cookies: [] }));
    // Backdate it by 10 days
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    // Create a "recent" state file in states/
    const recentFile = path.join(statesDir, 'recent-session.json');
    fs.writeFileSync(recentFile, JSON.stringify({ cookies: [] }));

    // Create an "old" session state in sessions/old-sess/state.json
    const oldSessDir = path.join(sessionsDir, 'old-sess');
    fs.mkdirSync(oldSessDir, { recursive: true });
    const oldSessFile = path.join(oldSessDir, 'state.json');
    fs.writeFileSync(oldSessFile, JSON.stringify({ cookies: [] }));
    fs.utimesSync(oldSessFile, tenDaysAgo, tenDaysAgo);

    // Create a "recent" session state in sessions/new-sess/state.json
    const newSessDir = path.join(sessionsDir, 'new-sess');
    fs.mkdirSync(newSessDir, { recursive: true });
    const newSessFile = path.join(newSessDir, 'state.json');
    fs.writeFileSync(newSessFile, JSON.stringify({ cookies: [] }));

    // Clean files older than 7 days
    const result = cleanOldStates(localDir, 7);
    expect(result.deleted).toBe(2); // old-session.json + old-sess/state.json

    // Old files should be gone
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(oldSessFile)).toBe(false);

    // Recent files should still exist
    expect(fs.existsSync(recentFile)).toBe(true);
    expect(fs.existsSync(newSessFile)).toBe(true);
  });

  test('cleanOldStates with no state dirs returns zero', () => {
    const emptyLocalDir = path.join(tmpDir, 'clean-empty');
    fs.mkdirSync(emptyLocalDir, { recursive: true });
    const result = cleanOldStates(emptyLocalDir, 7);
    expect(result.deleted).toBe(0);
  });
});
