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
