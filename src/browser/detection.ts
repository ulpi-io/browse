/**
 * Google block detection — detect when Google shows captcha/block page.
 * Runtime-agnostic. Used by goto handler and snapshot to warn agents.
 */

import type { Page } from 'playwright';

/**
 * Check if a URL is a Google search page.
 */
export function isGoogleSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

/**
 * Check if the current page is a Google block/captcha page.
 * Checks URL pattern and body text for known block signatures.
 * Best-effort, never throws.
 */
export async function isGoogleBlocked(page: Page): Promise<boolean> {
  try {
    const url = page.url();

    // Direct block URL
    if (url.includes('google.com/sorry/')) return true;

    // Check body text for block signatures
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
