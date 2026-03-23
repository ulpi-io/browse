/**
 * Record export — converts recorded browse commands into replayable formats.
 * - browse: chain-compatible JSON (replay with `browse chain`)
 * - replay: Chrome DevTools Recorder format (replay with `npx @puppeteer/replay` or Playwright)
 */

import type { Locator } from 'playwright';

export interface RecordedStep {
  command: string;
  args: string[];
  timestamp: number;
  resolvedSelectors?: Record<string, string[]>;
}

// ─── Helpers ──────────────────────────────────────────

function escapeJS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function parseViewport(sizeArg: string): { width: number; height: number } | null {
  const match = sizeArg.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
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

// ─── Chrome DevTools Recorder (replay format) ────────

export type SelectorFilter = Set<'css' | 'aria' | 'xpath' | 'text'>;

function selectorMatchesFilter(s: string, filter: SelectorFilter | null): boolean {
  if (!filter) return true; // no filter = all
  if (s.startsWith('aria/')) return filter.has('aria');
  if (s.startsWith('text/')) return filter.has('text');
  if (s.startsWith('xpath/')) return filter.has('xpath');
  return filter.has('css'); // #id, [data-testid], tag.class — all CSS
}

let _selectorFilter: SelectorFilter | null = null;

function buildSelectors(step: RecordedStep, argRef: string): string[][] {
  if (step.resolvedSelectors?.[argRef]) {
    const filtered = step.resolvedSelectors[argRef]
      .filter(s => selectorMatchesFilter(s, _selectorFilter));
    if (filtered.length > 0) return filtered.map(s => [s]);
  }
  return [[argRef]];
}

function replayStep(step: RecordedStep): object | null {
  const { command, args } = step;
  const selector = args[0] || '';

  switch (command) {
    case 'goto':
      return { type: 'navigate', url: args[0] || '', assertedEvents: [{ type: 'navigation', url: args[0] || '', title: '' }] };
    case 'click':
      return { type: 'click', selectors: buildSelectors(step, selector), offsetX: 1, offsetY: 1 };
    case 'dblclick':
      return { type: 'doubleClick', selectors: buildSelectors(step, selector), offsetX: 1, offsetY: 1 };
    case 'fill':
      return { type: 'change', selectors: buildSelectors(step, selector), value: args.slice(1).join(' ') };
    case 'type':
      return null; // handled as individual key events in exportReplay
    case 'press':
      return { type: 'keyDown', key: args[0] || '' };
    case 'select':
      return { type: 'change', selectors: buildSelectors(step, selector), value: args.slice(1).join(' ') };
    case 'scroll':
      if (args[0] === 'down') return { type: 'scroll', x: 0, y: 500 };
      if (args[0] === 'up') return { type: 'scroll', x: 0, y: -500 };
      return { type: 'scroll', selectors: buildSelectors(step, selector), x: 0, y: 200 };
    case 'hover':
      return { type: 'hover', selectors: buildSelectors(step, selector) };
    case 'viewport': {
      const vp = parseViewport(args[0] || '');
      if (!vp) return null;
      return { type: 'setViewport', width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false };
    }
    case 'wait':
      if (args[0] === '--network-idle') return { type: 'waitForExpression', expression: 'new Promise(r => setTimeout(r, 2000))' };
      if (args[0] === '--url') return { type: 'waitForExpression', expression: `location.href.includes('${escapeJS(args[1] || '')}')` };
      return { type: 'waitForElement', selectors: buildSelectors(step, selector) };
    case 'back':
      return { type: 'waitForExpression', expression: '(window.history.back(), true)' };
    case 'forward':
      return { type: 'waitForExpression', expression: '(window.history.forward(), true)' };
    default:
      return null;
  }
}

export function exportReplay(steps: RecordedStep[], selectorFilter?: SelectorFilter): string {
  _selectorFilter = selectorFilter || null;
  const replaySteps: object[] = [
    { type: 'setViewport', width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: false },
  ];

  for (const step of steps) {
    if (step.command === 'type') {
      const text = step.args.join(' ');
      for (const char of text) {
        replaySteps.push({ type: 'keyDown', key: char });
        replaySteps.push({ type: 'keyUp', key: char });
      }
      continue;
    }
    const converted = replayStep(step);
    if (converted) {
      replaySteps.push(converted);
    }
  }

  return JSON.stringify({ title: 'browse recording', steps: replaySteps }, null, 2);
}
