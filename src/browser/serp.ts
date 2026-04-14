/**
 * Google SERP fast-path — DOM-based extraction of search results.
 * Skips ariaSnapshot entirely for ~2x speed on Google search pages.
 * Opt-in only: activated via --serp flag or BROWSE_SERP_FASTPATH=1.
 */

import type { Page } from 'playwright';

/**
 * Check if a URL is a Google SERP (search results page).
 */
export function isGoogleSerp(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // Only match www.google.TLD or google.TLD — not mail.google.com, docs.google.com, etc.
    const isGoogleHost = host.startsWith('www.google.') || /^google\.[a-z.]+$/.test(host);
    return isGoogleHost && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

/**
 * Extract structured Google search results via DOM evaluation.
 * Returns formatted text or null on failure.
 */
export async function extractGoogleSerp(page: Page): Promise<string | null> {
  try {
    // Wait briefly for results to render
    await page.waitForSelector('#rso h3, #search h3', { timeout: 5000 }).catch(() => {});

    const results = await page.evaluate(() => {
      const lines: string[] = [];
      lines.push('- heading "' + document.title.replace(/"/g, '\\"') + '"');

      // Search input
      const input = document.querySelector('input[name="q"], textarea[name="q"]') as HTMLInputElement | null;
      if (input) {
        lines.push('- searchbox "Search": ' + (input.value || ''));
      }

      // Result blocks
      const container = document.querySelector('#rso') || document.querySelector('#search');
      if (container) {
        const blocks = container.querySelectorAll(':scope > div');
        for (const block of blocks) {
          const h3 = block.querySelector('h3');
          const link = h3 ? h3.closest('a') : null;
          if (h3 && link) {
            const title = h3.textContent?.trim().replace(/"/g, '\\"') || '';
            const href = (link as HTMLAnchorElement).href;
            const cite = block.querySelector('cite');
            const displayUrl = cite?.textContent?.trim() || '';

            let snippet = '';
            for (const sel of ['[data-sncf]', '[data-content-feature="1"]', '.VwiC3b', 'div[style*="-webkit-line-clamp"]']) {
              const el = block.querySelector(sel);
              if (el) { snippet = el.textContent?.trim().slice(0, 300) || ''; break; }
            }

            lines.push('- link "' + title + '":');
            lines.push('  - /url: ' + href);
            if (displayUrl) lines.push('  - cite: ' + displayUrl);
            if (snippet) lines.push('  - text: ' + snippet);
          }
        }
      }

      // People also ask
      const paa = document.querySelectorAll('[jsname="Cpkphb"], div.related-question-pair');
      if (paa.length > 0) {
        lines.push('- heading "People also ask"');
        paa.forEach(q => {
          const text = q.textContent?.trim().replace(/"/g, '\\"').slice(0, 150) || '';
          if (text) lines.push('  - button "' + text + '"');
        });
      }

      // Next page
      const next = document.querySelector('#botstuff a[aria-label="Next page"], td.d6cvqb a, a#pnnext');
      if (next) {
        lines.push('- navigation "pagination":');
        lines.push('  - link "Next"');
      }

      return lines.join('\n');
    });

    return results && results.length > 10 ? results : null;
  } catch {
    return null;
  }
}
