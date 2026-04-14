/**
 * Consent dialog auto-dismiss -- clicks away cookie banners, GDPR overlays, etc.
 * Runtime-agnostic. Best-effort: never throws, never blocks navigation.
 * Gated by BROWSE_CONSENT_DISMISS env var (default '1' = enabled).
 */

import type { Page } from 'playwright';

/** CSS selectors for common consent/cookie dismiss buttons, ordered by prevalence. */
const DISMISS_SELECTORS = [
  // OneTrust (very common)
  '#onetrust-accept-btn-handler',
  '#onetrust-reject-all-handler',
  '#onetrust-close-btn-container button',
  // CookieBot
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  // Generic patterns
  'button[data-test="cookie-accept-all"]',
  'button[aria-label="Accept all"]',
  'button[aria-label="Accept All"]',
  'button[aria-label="Close"]',
  'button[aria-label="Dismiss"]',
  // Dialog close buttons
  'dialog button:has-text("Accept")',
  'dialog button:has-text("I Accept")',
  'dialog button:has-text("Got it")',
  'dialog button:has-text("OK")',
  // GDPR/CCPA specific
  '[class*="consent"] button[class*="accept"]',
  '[class*="consent"] button[class*="close"]',
  '[class*="cookie"] button[class*="accept"]',
  '[class*="cookie"] button[class*="close"]',
  // Overlay close buttons
  '[class*="modal"] button[class*="close"]',
  '[class*="overlay"] button[class*="close"]',
];

/**
 * Try to dismiss a consent dialog on the page. Best-effort, never throws.
 * Tries each selector with a 150ms visibility timeout. Clicks the first visible one and returns.
 * Only dismisses one dialog per call (avoid cascading clicks).
 */
export async function dismissConsentDialog(page: Page): Promise<boolean> {
  for (const selector of DISMISS_SELECTORS) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 150 })) {
        await button.click({ timeout: 1000 });
        // Brief pause after dismiss
        await page.waitForTimeout(200);
        return true;
      }
    } catch {
      // Selector not found or not clickable -- continue
    }
  }
  return false;
}
