/**
 * Replay export — converts recorded browse commands into Chrome DevTools Recorder format.
 * Replay with: `npx @puppeteer/replay` or Playwright.
 */

import type { RecordedStep } from './record';

// ─── Helpers ──────────────────────────────────────────

function escapeJS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function parseViewport(sizeArg: string): { width: number; height: number } | null {
  const match = sizeArg.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

// ─── Selector filtering ─────────────────────────────

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

// ─── Step conversion ─────────────────────────────────

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
    case 'expect': {
      // Map expect conditions to replay steps
      const urlIdx = args.indexOf('--url');
      if (urlIdx !== -1 && args[urlIdx + 1]) {
        return { type: 'waitForExpression', expression: `window.location.href.includes('${escapeJS(args[urlIdx + 1])}')` };
      }
      const textIdx = args.indexOf('--text');
      if (textIdx !== -1 && args[textIdx + 1]) {
        return { type: 'waitForElement', selectors: [[`text/${args[textIdx + 1]}`]] };
      }
      const visIdx = args.indexOf('--visible');
      if (visIdx !== -1 && args[visIdx + 1]) {
        return { type: 'waitForElement', selectors: [[args[visIdx + 1]]] };
      }
      const timeoutIdx = args.indexOf('--timeout');
      const timeout = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : undefined;
      // Generic fallback
      return { type: 'waitForExpression', expression: 'true', ...(timeout ? { timeout } : {}) };
    }
    default:
      return null;
  }
}

// ─── Chrome DevTools Recorder (replay format) ────────

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

// ─── Playwright Test Export ─────────────────────────────

function playwrightStep(step: RecordedStep): string | null {
  const { command, args } = step;
  const sel = args[0] || '';

  // Resolve best selector: prefer aria selectors from resolved
  function bestSelector(): string {
    if (step.resolvedSelectors?.[sel]) {
      const selectors = step.resolvedSelectors[sel];
      const aria = selectors.find(s => s.startsWith('aria/'));
      if (aria) {
        // aria/Submit[role="button"] → page.getByRole('button', { name: 'Submit' })
        const match = aria.match(/^aria\/(.+)\[role="(\w+)"\]$/);
        if (match) return `page.getByRole('${match[2]}', { name: '${escapeJS(match[1])}' })`;
        return `page.getByText('${escapeJS(aria.replace('aria/', ''))}')`;
      }
      const text = selectors.find(s => s.startsWith('text/'));
      if (text) return `page.getByText('${escapeJS(text.replace('text/', ''))}')`;
    }
    // Fall back to CSS
    return `page.locator('${escapeJS(sel)}')`;
  }

  switch (command) {
    case 'goto': return `  await page.goto('${escapeJS(args[0] || '')}');`;
    case 'click': return `  await ${bestSelector()}.click();`;
    case 'dblclick': return `  await ${bestSelector()}.dblclick();`;
    case 'fill': return `  await ${bestSelector()}.fill('${escapeJS(args.slice(1).join(' '))}');`;
    case 'select': return `  await ${bestSelector()}.selectOption('${escapeJS(args.slice(1).join(' '))}');`;
    case 'type': return `  await page.keyboard.type('${escapeJS(args.join(' '))}');`;
    case 'press': return `  await page.keyboard.press('${escapeJS(args[0] || '')}');`;
    case 'hover': return `  await ${bestSelector()}.hover();`;
    case 'check': return `  await ${bestSelector()}.check();`;
    case 'uncheck': return `  await ${bestSelector()}.uncheck();`;
    case 'scroll':
      if (args[0] === 'down') return `  await page.mouse.wheel(0, 500);`;
      if (args[0] === 'up') return `  await page.mouse.wheel(0, -500);`;
      return `  await ${bestSelector()}.scrollIntoViewIfNeeded();`;
    case 'wait':
      if (args[0] === '--network-idle') return `  await page.waitForLoadState('networkidle');`;
      if (args[0] === '--url' && args[1]) return `  await page.waitForURL(/${escapeJS(args[1])}/);`;
      return `  await ${bestSelector()}.waitFor();`;
    case 'expect': {
      const urlIdx = args.indexOf('--url');
      if (urlIdx !== -1 && args[urlIdx + 1]) return `  await expect(page).toHaveURL(/${escapeJS(args[urlIdx + 1])}/);`;
      const textIdx = args.indexOf('--text');
      if (textIdx !== -1 && args[textIdx + 1]) return `  await expect(page.getByText('${escapeJS(args[textIdx + 1])}')).toBeVisible();`;
      const visIdx = args.indexOf('--visible');
      if (visIdx !== -1 && args[visIdx + 1]) return `  await expect(page.locator('${escapeJS(args[visIdx + 1])}')).toBeVisible();`;
      const hidIdx = args.indexOf('--hidden');
      if (hidIdx !== -1 && args[hidIdx + 1]) return `  await expect(page.locator('${escapeJS(args[hidIdx + 1])}')).toBeHidden();`;
      return `  // expect: ${args.join(' ')}`;
    }
    case 'viewport': {
      const vp = parseViewport(args[0] || '');
      if (!vp) return null;
      return `  await page.setViewportSize({ width: ${vp.width}, height: ${vp.height} });`;
    }
    case 'back': return `  await page.goBack();`;
    case 'forward': return `  await page.goForward();`;
    case 'screenshot': return `  await page.screenshot({ path: '${escapeJS(args[0] || 'screenshot.png')}' });`;
    default: return null;
  }
}

export function exportPlaywrightTest(steps: RecordedStep[], selectorFilter?: SelectorFilter): string {
  _selectorFilter = selectorFilter || null;

  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('recorded flow', async ({ page }) => {`,
  ];

  for (const step of steps) {
    const line = playwrightStep(step);
    if (line) lines.push(line);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}
