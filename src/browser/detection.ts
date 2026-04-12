/**
 * Google block detection — detect when Google shows captcha/block page.
 * Runtime-agnostic. Used by goto handler and snapshot to warn agents.
 */

import type { Page } from 'playwright';

/**
 * Check if a URL is a Google Search page.
 * Narrow match: only www.google.* or google.* with /search path.
 * Does NOT match mail.google.com, docs.google.com, etc.
 */
export function isGoogleSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // Must be www.google.TLD or google.TLD — not other subdomains
    const isGoogleSearch = (host.startsWith('www.google.') || /^google\.[a-z.]+$/.test(host))
      && parsed.pathname === '/search';
    return isGoogleSearch;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is a Google block/sorry page.
 */
function isGoogleSorryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return (host.startsWith('www.google.') || /^google\.[a-z.]+$/.test(host))
      && parsed.pathname.startsWith('/sorry');
  } catch {
    return false;
  }
}

/**
 * Check if the current page is a Google block/captcha page.
 * Only runs DOM checks on actual Google Search or Sorry pages.
 * Best-effort, never throws.
 */
export async function isGoogleBlocked(page: Page): Promise<boolean> {
  try {
    const url = page.url();

    // Direct block URL
    if (isGoogleSorryUrl(url)) return true;

    // Only check body text on Google Search pages — not Gmail, Docs, etc.
    if (!isGoogleSearchUrl(url)) return false;

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '');
    return /Our systems have detected unusual traffic|About this page|If you're having trouble accessing Google Search/.test(bodyText);
  } catch {
    return false;
  }
}

/**
 * Format a user-friendly error message for a Google block.
 */
export function formatGoogleBlockError(url: string): string {
  return `Google has blocked this request (unusual traffic detected). ` +
    `Try: (1) wait and retry, (2) use a different IP/proxy, ` +
    `(3) use --runtime camoufox for anti-detection. URL: ${url}`;
}
