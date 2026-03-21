/**
 * Integration tests for v0.2.0 interaction and iframe features
 *
 * Tests run against a local test server serving fixture HTML files.
 * Covers: dblclick, check/uncheck, focus, value, count, scroll up/down,
 * highlight, wait --network-idle, and iframe targeting (frame command).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
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

// ─── rightclick ─────────────────────────────────────────────────

describe('rightclick', () => {
  test('right-click changes button text', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('rightclick', ['#ctx-btn'], bm);
    expect(result).toContain('Right-clicked');

    const text = await handleReadCommand('js', ['document.querySelector("#ctx-btn").textContent'], bm);
    expect(text).toBe('right-clicked');
  });
});

// ─── mouse ──────────────────────────────────────────────────────

describe('mouse', () => {
  test('mouse move dispatches mousemove event', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // Scroll the mouse-tracker element into view first (it's below a 3000px spacer)
    await handleWriteCommand('scroll', ['#mouse-tracker'], bm);

    // Get the element's bounding box so we can move the mouse over it
    const bbox = await handleReadCommand('js', ['JSON.stringify(document.querySelector("#mouse-tracker").getBoundingClientRect())'], bm);
    const rect = JSON.parse(bbox);
    const targetX = Math.round(rect.left + rect.width / 2);
    const targetY = Math.round(rect.top + rect.height / 2);

    const result = await handleWriteCommand('mouse', ['move', String(targetX), String(targetY)], bm);
    expect(result).toContain(`Mouse moved to ${targetX},${targetY}`);

    const x = await handleReadCommand('js', ['document.querySelector("#mouse-tracker").dataset.x'], bm);
    const y = await handleReadCommand('js', ['document.querySelector("#mouse-tracker").dataset.y'], bm);
    expect(x).toBe(String(targetX));
    expect(y).toBe(String(targetY));
  });

  test('mouse wheel scrolls the page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // Reset scroll position
    await handleReadCommand('js', ['window.scrollTo(0, 0), "ok"'], bm);

    const result = await handleWriteCommand('mouse', ['wheel', '300'], bm);
    expect(result).toContain('Mouse wheel');

    // Give the browser a moment to process the wheel event
    await handleWriteCommand('wait', ['100'], bm);
    const scrollY = await handleReadCommand('js', ['window.scrollY'], bm);
    expect(Number(scrollY)).toBeGreaterThan(0);
  });

  test('invalid subcommand throws error', async () => {
    try {
      await handleWriteCommand('mouse', ['invalid'], bm);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Unknown mouse subcommand');
    }
  });
});

// ─── wait extensions ────────────────────────────────────────────

describe('wait extensions', () => {
  test('wait --text finds text after delayed render', async () => {
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], bm);
    const result = await handleWriteCommand('wait', ['--text', 'SPA Content Loaded'], bm);
    expect(result).toContain('Text found');
    expect(result).toContain('SPA Content Loaded');
  });

  test('wait --fn waits for JS condition', async () => {
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], bm);
    const result = await handleWriteCommand('wait', ['--fn', 'document.title.length > 0'], bm);
    expect(result).toContain('Condition met');
  });

  test('wait <ms> completes after timeout', async () => {
    const result = await handleWriteCommand('wait', ['100'], bm);
    expect(result).toBe('Waited 100ms');
  });

  test('wait --state hidden detects element disappearance', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // First make sure the element exists and is visible
    await handleWriteCommand('wait', ['#highlight-target'], bm);

    // Hide the element via JS
    await handleReadCommand('js', ['document.querySelector("#highlight-target").style.display = "none"'], bm);

    // Wait for it to become hidden
    const result = await handleWriteCommand('wait', ['#highlight-target', '--state', 'hidden'], bm);
    expect(result).toContain('hidden');
  });

  test('wait --load domcontentloaded succeeds', async () => {
    await handleWriteCommand('goto', [baseUrl + '/spa.html'], bm);
    const result = await handleWriteCommand('wait', ['--load', 'domcontentloaded'], bm);
    expect(result).toContain('Load state reached');
    expect(result).toContain('domcontentloaded');
  });
});

// ─── set geo ────────────────────────────────────────────────────

describe('set geo', () => {
  test('sets geolocation coordinates', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('set', ['geo', '37.7749', '-122.4194'], bm);
    expect(result).toContain('Geolocation set to 37.7749, -122.4194');

    const lat = await handleReadCommand('js', ['new Promise(r => navigator.geolocation.getCurrentPosition(p => r(p.coords.latitude)))'], bm);
    expect(Number(lat)).toBeCloseTo(37.7749, 4);
  });
});

// ─── set media ──────────────────────────────────────────────────

describe('set media', () => {
  test('sets color scheme to dark', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('set', ['media', 'dark'], bm);
    expect(result).toContain('Color scheme set to dark');

    const isDark = await handleReadCommand('js', ["window.matchMedia('(prefers-color-scheme: dark)').matches"], bm);
    expect(isDark).toBe('true');
  });
});

// ─── cookie clear ───────────────────────────────────────────────

describe('cookie clear', () => {
  test('clears all cookies', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // Set a cookie first
    await handleWriteCommand('cookie', ['test=value'], bm);
    const before = await handleReadCommand('cookies', [], bm);
    expect(before).toContain('test');

    // Clear all cookies
    const result = await handleWriteCommand('cookie', ['clear'], bm);
    expect(result).toContain('All cookies cleared');

    const after = await handleReadCommand('cookies', [], bm);
    expect(after).toBe('[]');
  });
});

// ─── cookie set with options ────────────────────────────────────

describe('cookie set with options', () => {
  test('sets cookie with --domain option', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // Clear any existing cookies first
    await handleWriteCommand('cookie', ['clear'], bm);

    const result = await handleWriteCommand('cookie', ['set', 'auth', 'token123', '--domain', 'localhost'], bm);
    expect(result).toContain('Cookie set: auth=token123');

    const cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toContain('auth');
    expect(cookies).toContain('token123');
  });
});

// ─── keyboard inserttext ───────────────────────────────────

describe('keyboard inserttext', () => {
  test('inserts text at cursor without key events', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    await handleWriteCommand('click', ['#inserttext-target'], bm);
    const result = await handleWriteCommand('keyboard', ['inserttext', 'hello world'], bm);
    expect(result).toContain('Inserted text');

    const value = await handleReadCommand('value', ['#inserttext-target'], bm);
    expect(value).toBe('hello world');
  });

  test('no subcommand throws usage error', async () => {
    await expect(handleWriteCommand('keyboard', [], bm)).rejects.toThrow('Usage');
  });

  test('inserttext with no text throws usage error', async () => {
    await expect(handleWriteCommand('keyboard', ['inserttext'], bm)).rejects.toThrow('Usage');
  });
});

// ─── scrollinto / scrollintoview ────────────────────────────

describe('scrollinto', () => {
  test('scrollinto scrolls element into view', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // Scroll to top first
    await handleWriteCommand('scroll', ['up'], bm);

    const result = await handleWriteCommand('scrollinto', ['#bottom-marker'], bm);
    expect(result).toContain('Scrolled');
    expect(result).toContain('into view');

    // Verify bottom-marker is now in viewport
    const inView = await handleReadCommand('js', [
      'document.querySelector("#bottom-marker").getBoundingClientRect().top < window.innerHeight'
    ], bm);
    expect(inView).toBe('true');
  });

  test('scrollintoview alias works', async () => {
    await handleWriteCommand('scroll', ['up'], bm);
    const result = await handleWriteCommand('scrollintoview', ['#bottom-marker'], bm);
    expect(result).toContain('Scrolled');
  });

  test('no selector throws usage error', async () => {
    await expect(handleWriteCommand('scrollinto', [], bm)).rejects.toThrow('Usage');
  });
});

// ─── mouse down / up ───────────────────────────────────────

describe('mouse down/up', () => {
  test('mouse down and up fire events', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);

    const downResult = await handleWriteCommand('mouse', ['down'], bm);
    expect(downResult).toContain('Mouse down');

    const upResult = await handleWriteCommand('mouse', ['up'], bm);
    expect(upResult).toContain('Mouse up');
  });

  test('mouse down with right button', async () => {
    const result = await handleWriteCommand('mouse', ['down', 'right'], bm);
    expect(result).toContain('Mouse down (right)');
    await handleWriteCommand('mouse', ['up', 'right'], bm);
  });
});

// ─── tap (requires touch context) ──────────────────────────

describe('tap', () => {
  test('tap works on touch-enabled context', async () => {
    // Enable touch via device emulation
    await handleWriteCommand('emulate', ['iPhone', '14'], bm);
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);

    const result = await handleWriteCommand('tap', ['#tap-target'], bm);
    expect(result).toContain('Tapped');

    // Reset to desktop
    await handleWriteCommand('emulate', ['reset'], bm);
  });

  test('tap on non-touch context throws actionable error', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    await expect(handleWriteCommand('tap', ['#tap-target'], bm)).rejects.toThrow(/emulate|touch/i);
  });

  test('no selector throws usage error', async () => {
    await expect(handleWriteCommand('tap', [], bm)).rejects.toThrow('Usage');
  });
});

// ─── swipe ─────────────────────────────────────────────────

describe('swipe', () => {
  test('swipe down dispatches touch events', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    const result = await handleWriteCommand('swipe', ['down'], bm);
    expect(result).toContain('Swiped down');
  });

  test('swipe with custom distance', async () => {
    const result = await handleWriteCommand('swipe', ['up', '500'], bm);
    expect(result).toContain('Swiped up 500px');
  });

  test('swipe with invalid direction throws', async () => {
    await expect(handleWriteCommand('swipe', ['diagonal'], bm)).rejects.toThrow('Usage');
  });

  test('swipe with no direction throws', async () => {
    await expect(handleWriteCommand('swipe', [], bm)).rejects.toThrow('Usage');
  });
});

// ─── cookie export / import ────────────────────────────────

describe('cookie export/import', () => {
  test('export and import roundtrip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    await handleWriteCommand('cookie', ['clear'], bm);

    // Set a test cookie
    await handleWriteCommand('cookie', ['testexport=exportvalue'], bm);

    // Export to file
    const tmpFile = '/tmp/browse-test-cookies.json';
    const exportResult = await handleWriteCommand('cookie', ['export', tmpFile], bm);
    expect(exportResult).toContain('Exported');
    expect(fs.existsSync(tmpFile)).toBe(true);

    // Verify file content
    const exported = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    expect(Array.isArray(exported)).toBe(true);
    expect(exported.some((c: any) => c.name === 'testexport')).toBe(true);

    // Clear and reimport
    await handleWriteCommand('cookie', ['clear'], bm);
    const cookies = await handleReadCommand('cookies', [], bm);
    expect(cookies).toBe('[]');

    const importResult = await handleWriteCommand('cookie', ['import', tmpFile], bm);
    expect(importResult).toContain('Imported');

    // Verify cookie restored
    const restored = await handleReadCommand('cookies', [], bm);
    expect(restored).toContain('testexport');

    // Cleanup
    fs.unlinkSync(tmpFile);
  });

  test('export with no file throws', async () => {
    await expect(handleWriteCommand('cookie', ['export'], bm)).rejects.toThrow('Usage');
  });

  test('import nonexistent file throws', async () => {
    await expect(handleWriteCommand('cookie', ['import', '/tmp/nonexistent.json'], bm)).rejects.toThrow('not found');
  });
});
