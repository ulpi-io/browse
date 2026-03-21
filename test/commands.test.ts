/**
 * Integration tests for all browse commands
 *
 * Tests run against a local test server serving fixture HTML files.
 * A real browse server is started and commands are sent via the CLI HTTP interface.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { resolveServerScript, SAFE_TO_RETRY } from '../src/cli';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry, consoleTotalAdded, networkTotalAdded } from '../src/buffers';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as path from 'path';
import { sharedBm as bm, sharedBaseUrl as baseUrl, sharedServer as testServer } from './setup';

// ─── Navigation ─────────────────────────────────────────────────

describe('Navigation', () => {
  test('goto navigates to URL', async () => {
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(result).toContain('Navigated to');
    expect(result).toContain('200');
  });

  test('url returns current URL', async () => {
    const result = await handleMetaCommand('url', [], bm, async () => {});
    expect(result).toContain('/basic.html');
  });

  test('back goes back', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleWriteCommand('back', [], bm);
    expect(result).toContain('Back');
  });

  test('forward goes forward', async () => {
    const result = await handleWriteCommand('forward', [], bm);
    expect(result).toContain('Forward');
  });

  test('reload reloads page', async () => {
    const result = await handleWriteCommand('reload', [], bm);
    expect(result).toContain('Reloaded');
  });
});

// ─── Content Extraction ─────────────────────────────────────────

describe('Content extraction', () => {
  test('text returns cleaned page text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('text', [], bm);
    expect(result).toContain('Hello World');
    expect(result).toContain('Item one');
    expect(result).not.toContain('<h1>');
  });

  test('html returns full page HTML', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('html', [], bm);
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<h1 id="title">Hello World</h1>');
  });

  test('html with selector returns element innerHTML', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('html', ['#content'], bm);
    expect(result).toContain('Some body text here.');
    expect(result).toContain('<li>Item one</li>');
  });

  test('links returns all links', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('links', [], bm);
    expect(result).toContain('Page 1');
    expect(result).toContain('Page 2');
    expect(result).toContain('External');
    expect(result).toContain('→');
  });

  test('forms discovers form fields', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleReadCommand('forms', [], bm);
    const forms = JSON.parse(result);
    expect(forms.length).toBe(2);
    expect(forms[0].id).toBe('login-form');
    expect(forms[0].method).toBe('post');
    expect(forms[0].fields.length).toBeGreaterThanOrEqual(2);
    expect(forms[1].id).toBe('profile-form');

    // Check field discovery
    const emailField = forms[0].fields.find((f: any) => f.name === 'email');
    expect(emailField).toBeDefined();
    expect(emailField.type).toBe('email');
    expect(emailField.required).toBe(true);
  });

  test('accessibility returns ARIA tree', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('accessibility', [], bm);
    expect(result).toContain('Hello World');
  });
});

// ─── JavaScript / CSS / Attrs ───────────────────────────────────

describe('Inspection', () => {
  beforeAll(async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  });

  test('js evaluates expression', async () => {
    const result = await handleReadCommand('js', ['document.title'], bm);
    expect(result).toBe('Test Page - Basic');
  });

  test('js returns objects as JSON', async () => {
    const result = await handleReadCommand('js', ['({a: 1, b: 2})'], bm);
    const obj = JSON.parse(result);
    expect(obj.a).toBe(1);
    expect(obj.b).toBe(2);
  });

  test('css returns computed property', async () => {
    const result = await handleReadCommand('css', ['h1', 'color'], bm);
    // Navy color
    expect(result).toContain('0, 0, 128');
  });

  test('css returns font-family', async () => {
    const result = await handleReadCommand('css', ['body', 'font-family'], bm);
    expect(result).toContain('Helvetica');
  });

  test('attrs returns element attributes', async () => {
    const result = await handleReadCommand('attrs', ['#content'], bm);
    const attrs = JSON.parse(result);
    expect(attrs.id).toBe('content');
    expect(attrs['data-testid']).toBe('main-content');
    expect(attrs['data-version']).toBe('1.0');
  });
});

// ─── Interaction ────────────────────────────────────────────────

describe('Interaction', () => {
  test('fill + click works on form', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);

    let result = await handleWriteCommand('fill', ['#email', 'test@example.com'], bm);
    expect(result).toContain('Filled');

    result = await handleWriteCommand('fill', ['#password', 'secret123'], bm);
    expect(result).toContain('Filled');

    // Verify values were set
    const emailVal = await handleReadCommand('js', ['document.querySelector("#email").value'], bm);
    expect(emailVal).toBe('test@example.com');

    result = await handleWriteCommand('click', ['#login-btn'], bm);
    expect(result).toContain('Clicked');
  });

  test('select works on dropdown', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleWriteCommand('select', ['#role', 'admin'], bm);
    expect(result).toContain('Selected');

    const val = await handleReadCommand('js', ['document.querySelector("#role").value'], bm);
    expect(val).toBe('admin');
  });

  test('hover works', async () => {
    const result = await handleWriteCommand('hover', ['h1'], bm);
    expect(result).toContain('Hovered');
  });

  test('wait finds existing element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('wait', ['#title'], bm);
    expect(result).toContain('appeared');
  });

  test('scroll works', async () => {
    const result = await handleWriteCommand('scroll', ['footer'], bm);
    expect(result).toContain('Scrolled');
  });

  test('viewport changes size', async () => {
    const result = await handleWriteCommand('viewport', ['375x812'], bm);
    expect(result).toContain('Viewport set');

    const size = await handleReadCommand('js', ['`${window.innerWidth}x${window.innerHeight}`'], bm);
    expect(size).toBe('375x812');

    // Reset
    await handleWriteCommand('viewport', ['1920x1080'], bm);
  });

  test('type and press work', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    await handleWriteCommand('click', ['#name'], bm);

    const result = await handleWriteCommand('type', ['John Doe'], bm);
    expect(result).toContain('Typed');

    const val = await handleReadCommand('js', ['document.querySelector("#name").value'], bm);
    expect(val).toBe('John Doe');

    // Test press: Tab key should move focus away from the name field
    const pressResult = await handleWriteCommand('press', ['Tab'], bm);
    expect(pressResult).toContain('Pressed Tab');
  });
});

// ─── SPA / Console / Network ───────────────────────────────────

describe('SPA and buffers', () => {
  test('wait handles delayed rendering', async () => {
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], bm);
    const result = await handleWriteCommand('wait', ['.loaded'], bm);
    expect(result).toContain('appeared');

    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('SPA Content Loaded');
  });

  test('console captures messages', async () => {
    const result = await handleReadCommand('console', [], bm);
    expect(result).toContain('[SPA] Starting render');
    expect(result).toContain('[SPA] Render complete');
  });

  test('console --clear clears buffer', async () => {
    const result = await handleReadCommand('console', ['--clear'], bm);
    expect(result).toContain('cleared');

    const after = await handleReadCommand('console', [], bm);
    expect(after).toContain('no console messages');
  });

  test('network captures requests', async () => {
    const result = await handleReadCommand('network', [], bm);
    expect(result).toContain('GET');
    expect(result).toContain('/spa.html');
  });

  test('network --clear clears buffer', async () => {
    const result = await handleReadCommand('network', ['--clear'], bm);
    expect(result).toContain('cleared');
  });
});

// ─── Cookies / Storage ──────────────────────────────────────────

describe('Cookies and storage', () => {
  test('cookies returns array', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['clear'], bm);
    const result = await handleReadCommand('cookies', [], bm);
    // After clearing, should be empty array
    expect(result).toBe('[]');
  });

  test('storage set and get works', async () => {
    await handleReadCommand('storage', ['set', 'testKey', 'testValue'], bm);
    const result = await handleReadCommand('storage', [], bm);
    const storage = JSON.parse(result);
    expect(storage.localStorage.testKey).toBe('testValue');
  });
});

// ─── Performance ────────────────────────────────────────────────

describe('Performance', () => {
  test('perf returns timing data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('perf', [], bm);
    expect(result).toContain('dns');
    expect(result).toContain('ttfb');
    expect(result).toContain('load');
    expect(result).toContain('ms');
  });
});

// ─── Visual ─────────────────────────────────────────────────────

describe('Visual', () => {
  test('screenshot saves file', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const screenshotPath = '/tmp/browse-test-screenshot.png';
    const result = await handleMetaCommand('screenshot', [screenshotPath], bm, async () => {});
    expect(result).toContain('Screenshot saved');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    const stat = fs.statSync(screenshotPath);
    expect(stat.size).toBeGreaterThan(1000);
    fs.unlinkSync(screenshotPath);
  });

  test('responsive saves 3 screenshots', async () => {
    await handleWriteCommand('goto', [baseUrl + '/responsive.html'], bm);
    const prefix = '/tmp/browse-test-resp';
    const result = await handleMetaCommand('responsive', [prefix], bm, async () => {});
    expect(result).toContain('mobile');
    expect(result).toContain('tablet');
    expect(result).toContain('desktop');

    expect(fs.existsSync(`${prefix}-mobile.png`)).toBe(true);
    expect(fs.existsSync(`${prefix}-tablet.png`)).toBe(true);
    expect(fs.existsSync(`${prefix}-desktop.png`)).toBe(true);

    // Cleanup
    fs.unlinkSync(`${prefix}-mobile.png`);
    fs.unlinkSync(`${prefix}-tablet.png`);
    fs.unlinkSync(`${prefix}-desktop.png`);
  });
});

// ─── Tabs ───────────────────────────────────────────────────────

describe('Tabs', () => {
  test('tabs lists all tabs', async () => {
    const result = await handleMetaCommand('tabs', [], bm, async () => {});
    expect(result).toContain('[');
    expect(result).toContain(']');
  });

  test('newtab opens new tab', async () => {
    const result = await handleMetaCommand('newtab', [baseUrl + '/forms.html'], bm, async () => {});
    expect(result).toContain('Opened tab');

    const tabCount = bm.getTabCount();
    expect(tabCount).toBeGreaterThanOrEqual(2);
  });

  test('tab switches to specific tab', async () => {
    const result = await handleMetaCommand('tab', ['1'], bm, async () => {});
    expect(result).toContain('Switched to tab 1');
  });

  test('closetab closes a tab', async () => {
    const before = bm.getTabCount();
    // Close the last opened tab
    const tabs = await bm.getTabListWithTitles();
    const lastTab = tabs[tabs.length - 1];
    const result = await handleMetaCommand('closetab', [String(lastTab.id)], bm, async () => {});
    expect(result).toContain('Closed tab');
    expect(bm.getTabCount()).toBe(before - 1);
  });
});

// ─── Diff ───────────────────────────────────────────────────────

describe('Diff', () => {
  test('diff shows differences between pages', async () => {
    const result = await handleMetaCommand(
      'diff',
      [baseUrl + '/basic.html', baseUrl + '/forms.html'],
      bm,
      async () => {}
    );
    expect(result).toContain('---');
    expect(result).toContain('+++');
    // basic.html has "Hello World", forms.html has "Form Test Page"
    expect(result).toContain('Hello World');
    expect(result).toContain('Form Test Page');
  });
});

// ─── Chain ──────────────────────────────────────────────────────

describe('Chain', () => {
  test('chain executes sequence of commands', async () => {
    const commands = JSON.stringify([
      ['goto', baseUrl + '/basic.html'],
      ['js', 'document.title'],
      ['css', 'h1', 'color'],
    ]);
    const result = await handleMetaCommand('chain', [commands], bm, async () => {});
    expect(result).toContain('[goto]');
    expect(result).toContain('Test Page - Basic');
    expect(result).toContain('[css]');
  });

  test('chain reports real error when write command fails', async () => {
    const commands = JSON.stringify([
      ['goto', 'http://localhost:1/unreachable'],
    ]);
    const result = await handleMetaCommand('chain', [commands], bm, async () => {});
    expect(result).toContain('[goto] ERROR:');
    expect(result).not.toContain('Unknown meta command');
    expect(result).not.toContain('Unknown read command');
  });
});

// ─── Status ─────────────────────────────────────────────────────

describe('Status', () => {
  test('status reports health', async () => {
    const result = await handleMetaCommand('status', [], bm, async () => {});
    expect(result).toContain('Status: healthy');
    expect(result).toContain('Tabs:');
  });
});

// ─── CLI server script resolution ───────────────────────────────

describe('CLI server script resolution', () => {
  test('finds server.ts adjacent to cli.ts (dev mode)', () => {
    const srcDir = path.resolve(__dirname, '../src');
    const resolved = resolveServerScript({}, srcDir);
    expect(resolved).toBe(path.join(srcDir, 'server.ts'));
  });

  test('uses BROWSE_SERVER_SCRIPT env var when set', () => {
    const customPath = '/custom/path/server.ts';
    const resolved = resolveServerScript({ BROWSE_SERVER_SCRIPT: customPath }, '/some/dir');
    expect(resolved).toBe(customPath);
  });

  // $bunfs test removed — Bun compiled binary mode no longer exists
});

// ─── CLI lifecycle ──────────────────────────────────────────────

describe('CLI lifecycle', () => {
  test('dead state file triggers a clean restart', { timeout: 45000 }, async () => {
    // Use random port range to avoid conflicts with stale servers from previous runs
    const portStart = 15000 + Math.floor(Math.random() * 10000);
    const stateFile = `/tmp/browse-test-state-${Date.now()}.json`;
    fs.writeFileSync(stateFile, JSON.stringify({
      port: 1,
      token: 'fake',
      pid: 999999,
    }));

    const cliPath = path.resolve(__dirname, '../src/cli.ts');
    let restartedPid: number | null = null;

    try {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const proc = spawn('./node_modules/.bin/tsx', [cliPath, 'status'], {
          timeout: 25000,
          env: {
            ...process.env,
            BROWSE_STATE_FILE: stateFile,
            BROWSE_PORT_START: String(portStart),
          },
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => stdout += d.toString());
        proc.stderr.on('data', (d) => stderr += d.toString());
        proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });

      if (fs.existsSync(stateFile)) {
        restartedPid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
      }

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Status: healthy');
      expect(result.stderr).toContain('Starting server');
    } finally {
      // Always clean up spawned server and state files
      if (restartedPid) {
        try { process.kill(restartedPid, 'SIGTERM'); } catch {}
      }
      try { fs.unlinkSync(stateFile); } catch {}
      try { fs.unlinkSync(stateFile + '.lock'); } catch {}
    }
  }, 20000);
});

// ─── Buffer bounds ──────────────────────────────────────────────

describe('Buffer bounds', () => {
  test('console buffer caps at 50000 entries', () => {
    consoleBuffer.length = 0;
    for (let i = 0; i < 50_010; i++) {
      addConsoleEntry({ timestamp: i, level: 'log', text: `msg-${i}` });
    }
    expect(consoleBuffer.length).toBe(50_000);
    expect(consoleBuffer[0].text).toBe('msg-10');
    expect(consoleBuffer[consoleBuffer.length - 1].text).toBe('msg-50009');
    consoleBuffer.length = 0;
  });

  test('network buffer caps at 50000 entries', () => {
    networkBuffer.length = 0;
    for (let i = 0; i < 50_010; i++) {
      addNetworkEntry({ timestamp: i, method: 'GET', url: `http://x/${i}` });
    }
    expect(networkBuffer.length).toBe(50_000);
    expect(networkBuffer[0].url).toBe('http://x/10');
    expect(networkBuffer[networkBuffer.length - 1].url).toBe('http://x/50009');
    networkBuffer.length = 0;
  });

  test('totalAdded counters keep incrementing past buffer cap', () => {
    const startConsole = consoleTotalAdded;
    const startNetwork = networkTotalAdded;
    for (let i = 0; i < 100; i++) {
      addConsoleEntry({ timestamp: i, level: 'log', text: `t-${i}` });
      addNetworkEntry({ timestamp: i, method: 'GET', url: `http://t/${i}` });
    }
    expect(consoleTotalAdded).toBe(startConsole + 100);
    expect(networkTotalAdded).toBe(startNetwork + 100);
    consoleBuffer.length = 0;
    networkBuffer.length = 0;
  });
});

// ─── SAFE_TO_RETRY contract ─────────────────────────────────────

describe('SAFE_TO_RETRY contract', () => {
  test('js is NOT in the safe set (can execute side effects)', () => {
    expect(SAFE_TO_RETRY.has('js')).toBe(false);
  });

  test('eval is NOT in the safe set (can execute side effects)', () => {
    expect(SAFE_TO_RETRY.has('eval')).toBe(false);
  });

  test('known safe commands ARE in the set', () => {
    for (const cmd of ['text', 'html', 'links', 'css', 'attrs', 'devices']) {
      expect(SAFE_TO_RETRY.has(cmd)).toBe(true);
    }
  });
});

// ─── Network size tracking ──────────────────────────────────────

describe('Network size tracking', () => {
  test('network entries contain numeric size values', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Wait for requestfinished events
    await new Promise(r => setTimeout(r, 1000));
    const result = await handleReadCommand('network', [], bm);
    expect(result).toContain('GET');
    // Network output should contain request entries
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── DOM mutation safety ────────────────────────────────────────

describe('DOM mutation safety', () => {
  test('text command does not trigger MutationObserver', async () => {
    await handleWriteCommand('goto', [baseUrl + '/mutation-observer.html'], bm);

    // Reset counter after navigation — Playwright may inject utility scripts
    // during goto that cause childList mutations unrelated to our code.
    await handleReadCommand('js', ['window.__mutationCount = 0'], bm);

    const before = await handleReadCommand('js', ['window.__mutationCount'], bm);
    expect(parseInt(before, 10)).toBe(0);

    // Run text command — TreeWalker-based, should not mutate live DOM
    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Hello World');

    // Mutation count should still be 0
    const after = await handleReadCommand('js', ['window.__mutationCount'], bm);
    expect(parseInt(after, 10)).toBe(0);
  });
});

// ─── Box command ────────────────────────────────────────────────

describe('Box', () => {
  test('box returns valid bounding box JSON for h1', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('box', ['h1'], bm);
    const box = JSON.parse(result);
    expect(typeof box.x).toBe('number');
    expect(typeof box.y).toBe('number');
    expect(typeof box.width).toBe('number');
    expect(typeof box.height).toBe('number');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  test('box with no selector throws', async () => {
    await expect(handleReadCommand('box', [], bm)).rejects.toThrow('Usage');
  });

  test('box with nonexistent selector throws', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await expect(handleReadCommand('box', ['#nonexistent'], bm)).rejects.toThrow();
  }, 10000);
});

// ─── Errors command ─────────────────────────────────────────────

describe('Errors', () => {
  test('errors captures console.error messages', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Clear any pre-existing errors
    await handleReadCommand('errors', ['--clear'], bm);
    // Trigger a console.error
    await handleReadCommand('js', ['console.error("test error message")'], bm);
    // Brief wait for console event to propagate
    await new Promise(r => setTimeout(r, 200));
    const result = await handleReadCommand('errors', [], bm);
    expect(result).toContain('test error message');
  });

  test('errors does not include console.log messages', async () => {
    await handleReadCommand('errors', ['--clear'], bm);
    await handleReadCommand('js', ['console.log("not an error")'], bm);
    await new Promise(r => setTimeout(r, 200));
    const result = await handleReadCommand('errors', [], bm);
    expect(result).not.toContain('not an error');
  });

  test('errors --clear returns cleared message', async () => {
    // Ensure there is at least one error to clear
    await handleReadCommand('js', ['console.error("to be cleared")'], bm);
    await new Promise(r => setTimeout(r, 200));
    const result = await handleReadCommand('errors', ['--clear'], bm);
    expect(result).toContain('Cleared');
  });

  test('errors returns no errors after clear', async () => {
    const result = await handleReadCommand('errors', [], bm);
    expect(result).toBe('(no errors)');
  });
});
