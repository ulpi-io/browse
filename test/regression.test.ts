/**
 * Regression tests -- prove core agent workflow is unbroken after Phases 1-6.
 * All tests use DEFAULT flag values (all behavior-changing features OFF).
 */
import { describe, test, expect } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleReadCommand } from '../src/commands/read';
import { handleSnapshot } from '../src/browser/snapshot';

describe('Regression: core workflow with default flags', () => {
  test('goto -> snapshot -> click -> text workflow unchanged', async () => {
    // Standard agent workflow
    const gotoResult = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    expect(gotoResult).toContain('Navigated to');
    expect(gotoResult).toContain('200');

    // Snapshot produces refs
    const snapshot = await handleSnapshot(['-i'], bm);
    expect(snapshot).toContain('@e');

    // Text extraction works
    const text = await handleReadCommand('text', [], bm);
    expect(text.length).toBeGreaterThan(0);
  });

  test('goto response shape preserved (no extra fields by default)', async () => {
    const result = await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Should match "Navigated to <url> (<status>)" -- no [warning], no [info]
    expect(result).toMatch(/^Navigated to .+ \(\d+\)$/);
  });

  test('click on obscured element throws without --force (default BROWSE_CLICK_FORCE=0)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/click-overlay.html'], bm);
    // Without --force, overlay interception should throw
    await expect(handleWriteCommand('click', ['#target'], bm)).rejects.toThrow();
  });

  test('consent dismiss does NOT run by default (BROWSE_CONSENT_DISMISS unset)', async () => {
    // Navigate to page with a consent banner -- consent dismiss should NOT auto-click it
    await handleWriteCommand('goto', [baseUrl + '/consent-dialog.html'], bm);
    const page = bm.getPage();
    // The OneTrust button should still be visible (not clicked away)
    const visible = await page.locator('#onetrust-accept-btn-handler').isVisible().catch(() => false);
    expect(visible).toBe(true);
  });

  test('snapshot on non-Google page is standard ARIA format (no SERP fast-path)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const snapshot = await handleSnapshot(['-i'], bm);
    // Should NOT contain SERP marker
    expect(snapshot).not.toContain('[Google SERP fast-path]');
    // Should contain standard @ref format
    expect(snapshot).toContain('@e');
  });
});

describe('Regression: new commands exist', () => {
  test('images command returns results or "No images found"', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('images', [], bm);
    expect(typeof result).toBe('string');
  });

  test('search macro expansion works', async () => {
    const { expandMacro, listMacros } = await import('../src/browser/macros');
    expect(listMacros().length).toBe(14);
    const url = expandMacro('@google test query');
    expect(url).toContain('google.com/search');
    expect(url).toContain('test%20query');
  });
});

describe('Regression: camoufox runtime registered', () => {
  test('AVAILABLE_RUNTIMES includes camoufox', async () => {
    const { AVAILABLE_RUNTIMES } = await import('../src/engine/resolver');
    expect(AVAILABLE_RUNTIMES).toContain('camoufox');
    expect(AVAILABLE_RUNTIMES).toContain('playwright');
  });
});
