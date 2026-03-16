/**
 * Integration tests for v0.2.0 interaction and iframe features
 *
 * Tests run against a local test server serving fixture HTML files.
 * Covers: dblclick, check/uncheck, focus, value, count, scroll up/down,
 * highlight, wait --network-idle, and iframe targeting (frame command).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import * as fs from 'fs';
import { sharedBm as bm, sharedBaseUrl as baseUrl, sharedServer as testServer } from './setup';

// ─── dblclick ───────────────────────────────────────────────────

describe('dblclick', () => {
  test('double-click changes button text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('dblclick', ['#dbl-btn'], bm);
    expect(result).toContain('Double-clicked');

    const text = await handleReadCommand('js', ['document.querySelector("#dbl-btn").textContent'], bm);
    expect(text).toBe('double-clicked');
  });
});

// ─── check / uncheck ────────────────────────────────────────────

describe('check / uncheck', () => {
  test('check enables checkbox, uncheck disables it', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);

    // Check
    const checkResult = await handleWriteCommand('check', ['#cb1'], bm);
    expect(checkResult).toContain('Checked');
    const checkedState = await handleReadCommand('js', ['document.querySelector("#cb1").checked'], bm);
    expect(checkedState).toBe('true');

    // Uncheck
    const uncheckResult = await handleWriteCommand('uncheck', ['#cb1'], bm);
    expect(uncheckResult).toContain('Unchecked');
    const uncheckedState = await handleReadCommand('js', ['document.querySelector("#cb1").checked'], bm);
    expect(uncheckedState).toBe('false');
  });
});

// ─── focus ──────────────────────────────────────────────────────

describe('focus', () => {
  test('focus sets active element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('focus', ['#focus-input'], bm);
    expect(result).toContain('Focused');

    const isFocused = await handleReadCommand('js', ['document.activeElement === document.querySelector("#focus-input")'], bm);
    expect(isFocused).toBe('true');
  });
});

// ─── value ──────────────────────────────────────────────────────

describe('value', () => {
  test('value reads prefilled input value', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleReadCommand('value', ['#value-input'], bm);
    expect(result).toBe('prefilled');
  });
});

// ─── count ──────────────────────────────────────────────────────

describe('count', () => {
  test('count returns number of matching elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleReadCommand('count', ['.item'], bm);
    expect(result).toBe('3');
  });
});

// ─── scroll up / down ───────────────────────────────────────────

describe('scroll up / down', () => {
  test('scroll down increases scrollY, scroll up decreases it', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);

    // Ensure we start at top
    await handleReadCommand('js', ['window.scrollTo(0, 0), "ok"'], bm);

    const scrollDownResult = await handleWriteCommand('scroll', ['down'], bm);
    expect(scrollDownResult).toContain('Scrolled down');

    const scrollYAfterDown = await handleReadCommand('js', ['window.scrollY'], bm);
    expect(Number(scrollYAfterDown)).toBeGreaterThan(0);

    const scrollUpResult = await handleWriteCommand('scroll', ['up'], bm);
    expect(scrollUpResult).toContain('Scrolled up');

    const scrollYAfterUp = await handleReadCommand('js', ['window.scrollY'], bm);
    expect(Number(scrollYAfterUp)).toBeLessThan(Number(scrollYAfterDown));
  });
});

// ─── highlight ──────────────────────────────────────────────────

describe('highlight', () => {
  test('highlight applies outline style to element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);

    const result = await handleWriteCommand('highlight', ['#highlight-target'], bm);
    expect(result).toContain('Highlighted');

    // Verify the outline was applied via css command
    const outlineStyle = await handleReadCommand('css', ['#highlight-target', 'outline'], bm);
    expect(outlineStyle).toContain('3px');
    expect(outlineStyle).toContain('solid');
  });
});

// ─── wait --network-idle ────────────────────────────────────────

describe('wait --network-idle', () => {
  test('wait --network-idle succeeds after navigation', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('wait', ['--network-idle'], bm);
    expect(result).toContain('Network idle');
  });
});

// ─── iframe targeting ───────────────────────────────────────────

describe('iframe targeting', () => {
  // Helper: navigate to iframe page, wait for full load, and reset frame context
  async function setupIframePage() {
    bm.resetFrame();
    await handleWriteCommand('goto', [baseUrl + '/iframe.html'], bm);
    // Wait for full page load so srcdoc iframe is ready
    await handleWriteCommand('wait', ['#test-frame'], bm);
    await handleReadCommand('js', [
      'new Promise(resolve => { const f = document.querySelector("#test-frame"); if (f.contentDocument && f.contentDocument.readyState === "complete") resolve("ok"); else f.onload = () => resolve("ok"); })'
    ], bm);
  }

  test('frame + text returns iframe content', async () => {
    await setupIframePage();

    const frameResult = await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});
    expect(frameResult).toContain('Switched to frame');

    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Inside Frame');

    bm.resetFrame();
  });

  test('frame + click works inside iframe', async () => {
    await setupIframePage();
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    const clickResult = await handleWriteCommand('click', ['#frame-btn'], bm);
    expect(clickResult).toContain('Clicked');

    bm.resetFrame();
  });

  test('frame main returns to main page', async () => {
    await setupIframePage();
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    // Exit back to main
    const mainResult = await handleMetaCommand('frame', ['main'], bm, async () => {});
    expect(mainResult).toContain('Switched to main frame');

    const text = await handleReadCommand('text', [], bm);
    expect(text).toContain('Main Page');
  });

  test('value inside iframe returns frame input value', async () => {
    await setupIframePage();
    await handleMetaCommand('frame', ['#test-frame'], bm, async () => {});

    const value = await handleReadCommand('value', ['#frame-input'], bm);
    expect(value).toBe('frame-value');

    bm.resetFrame();
  });
});

// ─── find command ────────────────────────────────────────────────

describe('find command', () => {
  const shutdown = async () => {};

  test('find role heading returns matches', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('find', ['role', 'heading'], bm, shutdown);
    expect(result).toContain('Found');
    expect(result).not.toContain('Found 0');
    expect(result).toContain('Hello World');
  });

  test('find role with name filter narrows results', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('find', ['role', 'link', 'Page 1'], bm, shutdown);
    expect(result).toContain('Found 1 match(es)');
  });

  test('find text returns matching text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('find', ['text', 'Hello World'], bm, shutdown);
    expect(result).toContain('Found 1 match(es)');
  });

  test('find text with no matches returns zero', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('find', ['text', 'nonexistent-xyz'], bm, shutdown);
    expect(result).toBe('Found 0 match(es)');
  });

  test('find label returns labeled inputs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleMetaCommand('find', ['label', 'Email'], bm, shutdown);
    expect(result).toContain('Found');
    expect(result).not.toContain('Found 0');
  });

  test('find placeholder returns inputs with placeholder', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    const result = await handleMetaCommand('find', ['placeholder', 'your@email.com'], bm, shutdown);
    expect(result).toContain('Found 1 match(es)');
  });

  test('find testid returns matching element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('find', ['testid', 'main-content'], bm, shutdown);
    expect(result).toContain('Found 1 match(es)');
  });

  test('find with unknown type throws error', async () => {
    try {
      await handleMetaCommand('find', ['invalid-type', 'query'], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown find type');
    }
  });

  test('find with no subcommand throws usage error', async () => {
    try {
      await handleMetaCommand('find', [], bm, shutdown);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Usage');
    }
  });
});

// ─── drag ────────────────────────────────────────────────────────

describe('drag', () => {
  test('drags source element to target', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('drag', ['#drag-src', '#drag-tgt'], bm);
    expect(result).toContain('Dragged');
  });

  test('throws on missing args', async () => {
    expect(handleWriteCommand('drag', [], bm)).rejects.toThrow('Usage');
  });
});

// ─── download ────────────────────────────────────────────────────

describe('download', () => {
  const dlPath = `/tmp/browse-test-dl-${Date.now()}.txt`;
  afterAll(() => { try { fs.unlinkSync(dlPath); } catch {} });

  test('downloads file triggered by click', async () => {
    await handleWriteCommand('goto', [baseUrl + '/download-link.html'], bm);
    const result = await handleWriteCommand('download', ['#dl-link', dlPath], bm);
    expect(result).toContain('Downloaded');
    expect(fs.existsSync(dlPath)).toBe(true);
    expect(fs.readFileSync(dlPath, 'utf-8')).toBe('test file content');
  });

  test('throws on missing selector', async () => {
    expect(handleWriteCommand('download', [], bm)).rejects.toThrow('Usage');
  });
});
