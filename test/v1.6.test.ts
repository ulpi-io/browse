/**
 * Integration tests for v1.6 features
 *
 * Covers:
 *   - Expect command (URL, text, visible, hidden, count, timeout)
 *   - wait --request (network buffer matching, status filter, timeout)
 *   - perf-audit --budget (parseBudget, evaluateBudget — deterministic unit tests)
 *   - Playwright export (exportPlaywrightTest with expect assertions)
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { parseBudget, evaluateBudget } from '../src/perf-audit';
import { exportPlaywrightTest } from '../src/export/replay';
import type { RecordedStep } from '../src/export/record';
import type { Session } from '../src/session/manager';

const shutdown = async () => {};

// ─── Helper: minimal Session with buffers from shared BM ──────
function makeSession(): Session {
  return {
    id: 'test',
    manager: bm as any,
    buffers: bm.getBuffers(),
    domainFilter: null,
    recording: null,
    outputDir: '/tmp',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    contextLevel: 'off',
    settleMode: false,
  };
}

// ─── Expect command ───────────────────────────────────────────

describe('Expect command', () => {
  test('expect --url succeeds when URL matches', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('expect', ['--url', 'basic'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --url fails on timeout', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await expect(
      handleMetaCommand('expect', ['--url', 'nonexistent-page-xyz', '--timeout', '500'], bm, shutdown)
    ).rejects.toThrow(/FAIL|timed out/i);
  });

  test('expect --text finds visible text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('expect', ['--text', 'Hello World'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --visible works', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('expect', ['--visible', 'body'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --hidden works on actually hidden element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // basic.html has <p class="hidden"> with display:none
    const result = await handleMetaCommand('expect', ['--hidden', '.hidden'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --count with --eq', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // basic.html has 3 <a> links in nav
    const result = await handleMetaCommand('expect', ['--count', 'nav a', '--eq', '3'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --timeout 0 checks once', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Single check — should pass immediately for visible body
    const result = await handleMetaCommand('expect', ['--visible', 'body', '--timeout', '0'], bm, shutdown);
    expect(result).toBe('OK');
  });

  test('expect --timeout 0 fails immediately without polling', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Single check for something that will never exist
    const start = Date.now();
    await expect(
      handleMetaCommand('expect', ['--url', 'nonexistent-xyz', '--timeout', '0'], bm, shutdown)
    ).rejects.toThrow(/FAIL|Expect failed/i);
    const elapsed = Date.now() - start;
    // Should fail nearly instantly (no polling)
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── wait --request ───────────────────────────────────────────

describe('wait --request', () => {
  test('wait --request matches completed request', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    // Trigger a fetch to /api/data
    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/data');
    }, baseUrl);

    // Wait for the request to appear in buffer
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleWriteCommand('wait', ['--request', '/api/data', '--timeout', '3000'], bm);
    expect(result).toContain('Request matched');
    expect(result).toContain('/api/data');
  });

  test('wait --request with --status', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    // Trigger a fetch to /api/data (returns 200)
    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/data');
    }, baseUrl);

    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleWriteCommand('wait', ['--request', '/api/data', '--status', '200', '--timeout', '3000'], bm);
    expect(result).toContain('Request matched');
    expect(result).toContain('200');
  });

  test('wait --request timeout', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await expect(
      handleWriteCommand('wait', ['--request', '/nonexistent-api-endpoint', '--timeout', '500'], bm)
    ).rejects.toThrow(/timeout/i);
  });
});

// ─── perf-audit --budget (deterministic unit tests) ──────────

describe('perf-audit --budget', () => {
  test('budget evaluator passes when metrics under budget', () => {
    const vitals = { lcp: 1500, cls: 0.05, tbt: 100, fcp: 800, ttfb: 200 };
    const budget = parseBudget('lcp:2500,cls:0.1,tbt:300');
    const result = evaluateBudget(vitals, budget);

    expect(result.allPassed).toBe(true);
    expect(result.lines).toHaveLength(3);
    for (const line of result.lines) {
      expect(line.passed).toBe(true);
      expect(line.skipped).toBe(false);
    }
  });

  test('budget evaluator fails when LCP over budget', () => {
    const vitals = { lcp: 5000, cls: 0.05, tbt: 100 };
    const budget = parseBudget('lcp:2500,cls:0.1');
    const result = evaluateBudget(vitals, budget);

    expect(result.allPassed).toBe(false);
    const lcpLine = result.lines.find(l => l.key === 'lcp');
    expect(lcpLine).toBeDefined();
    expect(lcpLine!.passed).toBe(false);
    expect(lcpLine!.measured).toBe(5000);
    expect(lcpLine!.threshold).toBe(2500);

    const clsLine = result.lines.find(l => l.key === 'cls');
    expect(clsLine).toBeDefined();
    expect(clsLine!.passed).toBe(true);
  });

  test('budget evaluator skips unmeasured metrics', () => {
    const vitals: Record<string, number | null> = { lcp: 1500, cls: 0.05, inp: null };
    const budget = parseBudget('lcp:2500,inp:200');
    const result = evaluateBudget(vitals, budget);

    expect(result.allPassed).toBe(true);
    const inpLine = result.lines.find(l => l.key === 'inp');
    expect(inpLine).toBeDefined();
    expect(inpLine!.skipped).toBe(true);
    expect(inpLine!.passed).toBe(true);
    expect(inpLine!.measured).toBeNull();
  });

  test('parseBudget parses valid budget string', () => {
    const budget = parseBudget('lcp:2500,cls:0.1,tbt:300,fcp:1800');
    expect(budget).toEqual({ lcp: 2500, cls: 0.1, tbt: 300, fcp: 1800 });
  });

  test('parseBudget handles case insensitivity', () => {
    const budget = parseBudget('LCP:2500,CLS:0.1,TBT:300');
    expect(budget).toEqual({ lcp: 2500, cls: 0.1, tbt: 300 });
  });

  test('parseBudget ignores unknown keys', () => {
    const budget = parseBudget('lcp:2500,unknown:42,cls:0.1');
    expect(budget).toEqual({ lcp: 2500, cls: 0.1 });
    expect(budget).not.toHaveProperty('unknown');
  });

  test('parseBudget throws on malformed value', () => {
    expect(() => parseBudget('lcp:abc')).toThrow(/Invalid budget value/);
  });
});

// ─── Playwright export ───────────────────────────────────────

describe('Playwright export', () => {
  test('exportPlaywrightTest generates valid test file', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['#submit'], timestamp: 2 },
      { command: 'fill', args: ['#email', 'test@example.com'], timestamp: 3 },
    ];

    const output = exportPlaywrightTest(steps);
    expect(output).toContain("import { test, expect } from '@playwright/test'");
    expect(output).toContain("test('recorded flow'");
    expect(output).toContain("await page.goto('https://example.com')");
    expect(output).toContain(".click()");
    expect(output).toContain(".fill('test@example.com')");
  });

  test('expect --url exports as toHaveURL', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'expect', args: ['--url', '/dashboard'], timestamp: 2 },
    ];

    const output = exportPlaywrightTest(steps);
    expect(output).toContain('toHaveURL');
    expect(output).toContain('/dashboard');
  });

  test('expect --visible exports as toBeVisible', () => {
    const steps: RecordedStep[] = [
      { command: 'expect', args: ['--visible', '.banner'], timestamp: 1 },
    ];

    const output = exportPlaywrightTest(steps);
    expect(output).toContain('toBeVisible');
    expect(output).toContain('.banner');
  });

  test('expect --hidden exports as toBeHidden', () => {
    const steps: RecordedStep[] = [
      { command: 'expect', args: ['--hidden', '.modal'], timestamp: 1 },
    ];

    const output = exportPlaywrightTest(steps);
    expect(output).toContain('toBeHidden');
    expect(output).toContain('.modal');
  });

  test('recording without expects exports normally', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['button.submit'], timestamp: 2 },
      { command: 'type', args: ['hello world'], timestamp: 3 },
    ];

    const output = exportPlaywrightTest(steps);
    expect(output).toContain("import { test, expect } from '@playwright/test'");
    expect(output).toContain("await page.goto('https://example.com')");
    expect(output).toContain("page.keyboard.type('hello world')");
    // No expect/assert calls in the output
    expect(output).not.toContain('toHaveURL');
    expect(output).not.toContain('toBeVisible');
  });
});
