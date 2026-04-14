/**
 * Integration tests for Phase 2 — real-web browsing quality features
 *
 * Tests cover:
 *   - Search macros (unit tests for expandMacro / listMacros)
 *   - Consent dialog dismiss (unit + fixture integration)
 *   - Google block detection (unit tests for URL detection + error formatting)
 *   - Page readiness (unit test for function existence)
 *   - Click fallback chain with --force (integration via fixture)
 */

import { describe, test, expect } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleReadCommand } from '../src/commands/read';
import { expandMacro, listMacros } from '../src/browser/macros';
import { dismissConsentDialog } from '../src/browser/consent';
import { isGoogleSearchUrl, formatGoogleBlockError } from '../src/browser/detection';
import { waitForPageReady } from '../src/browser/readiness';

// ─── Search Macros (unit) ───────────────────────────────────────

describe('Search macros', () => {
  test('expandMacro returns URL for @google', () => {
    const result = expandMacro('@google best coffee');
    expect(result).not.toBeNull();
    expect(result).toContain('google.com/search?q=');
    expect(result).toContain('best%20coffee');
  });

  test('expandMacro returns null for non-macro URL', () => {
    expect(expandMacro('https://example.com')).toBeNull();
  });

  test('expandMacro handles empty query', () => {
    const result = expandMacro('@google');
    expect(result).not.toBeNull();
    expect(result).toContain('google.com/search?q=');
  });

  test('listMacros returns all 14 macros', () => {
    const macros = listMacros();
    expect(macros.length).toBe(14);
    expect(macros).toContain('@google');
    expect(macros).toContain('@youtube');
    expect(macros).toContain('@reddit_subreddit');
  });

  test('expandMacro returns null for unknown macro', () => {
    expect(expandMacro('@unknown query')).toBeNull();
  });

  test('expandMacro handles @youtube', () => {
    const result = expandMacro('@youtube cat videos');
    expect(result).not.toBeNull();
    expect(result).toContain('youtube.com/results?search_query=');
    expect(result).toContain('cat%20videos');
  });

  test('expandMacro handles @amazon', () => {
    const result = expandMacro('@amazon wireless headphones');
    expect(result).not.toBeNull();
    expect(result).toContain('amazon.com/s?k=');
  });

  test('expandMacro handles @reddit', () => {
    const result = expandMacro('@reddit programming');
    expect(result).not.toBeNull();
    expect(result).toContain('reddit.com/search.json?q=');
  });

  test('expandMacro handles @reddit_subreddit', () => {
    const result = expandMacro('@reddit_subreddit javascript');
    expect(result).not.toBeNull();
    expect(result).toContain('reddit.com/r/javascript');
  });

  test('expandMacro handles @wikipedia', () => {
    const result = expandMacro('@wikipedia quantum computing');
    expect(result).not.toBeNull();
    expect(result).toContain('wikipedia.org/wiki/Special:Search');
  });

  test('expandMacro encodes special characters in query', () => {
    const result = expandMacro('@google hello world & friends');
    expect(result).not.toBeNull();
    expect(result).toContain('hello%20world%20%26%20friends');
  });

  test('expandMacro is case sensitive for macro name', () => {
    // @Google is not a valid macro (must be lowercase)
    expect(expandMacro('@Google test')).toBeNull();
  });
});

// ─── Consent Dialog Dismiss (unit) ──────────────────────────────

describe('Consent dismiss', () => {
  test('dismissConsentDialog is a function', () => {
    expect(typeof dismissConsentDialog).toBe('function');
  });

  test('dismissConsentDialog returns false on page with no consent banner', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const dismissed = await dismissConsentDialog(page);
    expect(dismissed).toBe(false);
  });

  test('dismissConsentDialog clicks OneTrust accept button on fixture', async () => {
    await handleWriteCommand('goto', [baseUrl + '/consent-dialog.html'], bm);
    const page = bm.getPage();
    const dismissed = await dismissConsentDialog(page);
    expect(dismissed).toBe(true);
  });
});

// ─── Google Block Detection (unit) ──────────────────────────────

describe('Google block detection', () => {
  test('isGoogleSearchUrl identifies Google search URLs', () => {
    expect(isGoogleSearchUrl('https://www.google.com/search?q=test')).toBe(true);
    expect(isGoogleSearchUrl('https://google.co.uk/search?q=test')).toBe(true);
    expect(isGoogleSearchUrl('https://google.com/search?q=test')).toBe(true);
  });

  test('isGoogleSearchUrl rejects non-Google URLs', () => {
    expect(isGoogleSearchUrl('https://example.com')).toBe(false);
    expect(isGoogleSearchUrl('https://www.google.com/')).toBe(false);
    expect(isGoogleSearchUrl('not a url')).toBe(false);
  });

  test('isGoogleSearchUrl rejects Google non-search pages', () => {
    expect(isGoogleSearchUrl('https://www.google.com/maps')).toBe(false);
    expect(isGoogleSearchUrl('https://www.google.com/images')).toBe(false);
    // mail.google.com is NOT Google Search — only www.google.* or google.* matches
    expect(isGoogleSearchUrl('https://mail.google.com/search?q=test')).toBe(false);
    expect(isGoogleSearchUrl('https://docs.google.com/search?q=test')).toBe(false);
  });

  test('isGoogleSearchUrl rejects non-search paths on google.com', () => {
    expect(isGoogleSearchUrl('https://www.google.com/about')).toBe(false);
    expect(isGoogleSearchUrl('https://www.google.com/')).toBe(false);
    expect(isGoogleSearchUrl('https://www.google.com/settings')).toBe(false);
  });

  test('formatGoogleBlockError returns actionable message', () => {
    const msg = formatGoogleBlockError('https://google.com/sorry/index');
    expect(msg).toContain('blocked');
    expect(msg).toContain('camoufox');
    expect(msg).toContain('google.com/sorry/index');
  });

  test('formatGoogleBlockError includes retry suggestion', () => {
    const msg = formatGoogleBlockError('https://www.google.com/sorry/123');
    expect(msg).toContain('retry');
  });

  test('formatGoogleBlockError includes proxy suggestion', () => {
    const msg = formatGoogleBlockError('https://www.google.com/sorry/123');
    expect(msg).toContain('proxy');
  });
});

// ─── Page Readiness (unit) ──────────────────────────────────────

describe('Page readiness', () => {
  test('waitForPageReady is a function', () => {
    expect(typeof waitForPageReady).toBe('function');
  });

  test('waitForPageReady completes without error on a loaded page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    // Should complete without throwing
    await waitForPageReady(page, { networkTimeout: 1000, settleMs: 50 });
  });

  test('waitForPageReady accepts custom options', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    // Very short timeouts should still not throw (best-effort)
    await waitForPageReady(page, { networkTimeout: 1, settleMs: 1 });
  });
});

// ─── Click Fallback Chain (integration) ─────────────────────────

describe('Click fallback with --force', () => {
  test('click without --force fails on overlay', async () => {
    await handleWriteCommand('goto', [baseUrl + '/click-overlay.html'], bm);
    await expect(handleWriteCommand('click', ['#target'], bm)).rejects.toThrow();
  });

  test('click with --force succeeds on overlay', async () => {
    await handleWriteCommand('goto', [baseUrl + '/click-overlay.html'], bm);
    const result = await handleWriteCommand('click', ['#target', '--force'], bm);
    expect(result).toContain('Clicked');
  });

  test('click with --force returns success message with selector', async () => {
    await handleWriteCommand('goto', [baseUrl + '/click-overlay.html'], bm);
    const result = await handleWriteCommand('click', ['#target', '--force'], bm);
    // Verify the success message includes the selector that was clicked
    expect(result).toContain('#target');
    expect(result).toContain('Clicked');
  });

  test('click without overlay works normally (no --force needed)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // basic.html has a link — click should work without --force
    const result = await handleWriteCommand('click', ['a'], bm);
    expect(result).toContain('Clicked');
  });
});
