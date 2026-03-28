/**
 * Record export — shared types and browse chain export.
 * - RecordedStep: shared recording step type
 * - resolveRefSelectors: extract real selectors from Playwright Locators
 * - exportBrowse: chain-compatible JSON (replay with `browse chain`)
 */

import type { Locator } from 'playwright';

export interface RecordedStep {
  command: string;
  args: string[];
  timestamp: number;
  resolvedSelectors?: Record<string, string[]>;
}

// ─── Ref → real selector resolution ──────────────────

const TAG_ROLE_MAP: Record<string, string> = {
  button: 'button', a: 'link', input: 'textbox', select: 'combobox',
  textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation',
  main: 'main', form: 'form', img: 'img', table: 'table',
};

/**
 * Extract real selectors from a live Playwright Locator.
 * Returns an array of @puppeteer/replay-compatible selectors:
 *   aria/<name>[role="<role>"], #id, [data-testid="x"], text/<text>, tag.class, xpath/<path>
 * All extracted in a single evaluate() call.
 */
export async function resolveRefSelectors(locator: Locator): Promise<string[]> {
  try {
    // Quick bail: element gone? count() returns immediately (no wait).
    if (await locator.count() === 0) return [];

    const info = await locator.evaluate((el: Element) => {
      const tag = el.tagName.toLowerCase();

      // Accessible name: aria-label > aria-labelledby > alt > title > direct text
      let name = el.getAttribute('aria-label') || '';
      if (!name) {
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) name = (labelEl.textContent || '').trim();
        }
      }
      if (!name && tag === 'img') name = (el as HTMLImageElement).alt || '';
      if (!name) name = el.getAttribute('title') || '';
      if (!name) name = (el.textContent || '').trim();

      // Role: explicit > implicit from tag
      const explicitRole = el.getAttribute('role') || '';

      // CSS id
      const id = el.id || '';

      // data-testid
      const testId = el.getAttribute('data-testid') || '';

      // Classes
      const classes = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean);

      // Uniqueness check for tag+class selector
      let tagClassUnique = false;
      if (classes.length > 0) {
        const cssSel = tag + classes.slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
        tagClassUnique = document.querySelectorAll(cssSel).length === 1;
      }

      // XPath: absolute path from root with position indices
      const xpathParts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === current!.tagName);
          const idx = siblings.indexOf(current) + 1;
          const part = current.tagName.toLowerCase() + (siblings.length > 1 ? `[${idx}]` : '');
          // Include id as predicate if present (for readability)
          if (current.id) {
            xpathParts.unshift(`${current.tagName.toLowerCase()}[@id="${current.id}"]`);
          } else {
            xpathParts.unshift(part);
          }
        } else {
          xpathParts.unshift(current.tagName.toLowerCase());
        }
        current = parent;
      }
      xpathParts.unshift('html');

      return { tag, name: name.slice(0, 80), explicitRole, id, testId, classes: classes.slice(0, 3), tagClassUnique, xpathParts };
    }, { timeout: 1000 });

    const selectors: string[] = [];

    // 1. ARIA selector
    const role = info.explicitRole || TAG_ROLE_MAP[info.tag] || '';
    if (role && info.name) {
      selectors.push(`aria/${info.name}[role="${role}"]`);
    }

    // 2. CSS ID
    if (info.id) {
      selectors.push(`#${info.id}`);
    }

    // 3. data-testid
    if (info.testId) {
      selectors.push(`[data-testid="${info.testId}"]`);
    }

    // 4. text selector (short text only)
    if (info.name && info.name.length <= 40 && !info.name.includes('\n')) {
      selectors.push(`text/${info.name}`);
    }

    // 5. CSS tag+class (only if unique)
    if (info.tagClassUnique && info.classes.length > 0) {
      selectors.push(info.tag + info.classes.map(c => `.${c}`).join(''));
    }

    // 6. XPath (absolute path)
    if (info.xpathParts.length > 0) {
      selectors.push(`xpath//${info.xpathParts.join('/')}`);
    }

    return selectors;
  } catch {
    return [];
  }
}

// ─── Browse JSON (chain-compatible) ──────────────────

export function exportBrowse(steps: RecordedStep[]): string {
  const commands = steps.map(step => [step.command, ...step.args]);
  return JSON.stringify(commands);
}
