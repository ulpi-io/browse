/**
 * React DevTools integration — lazy download, hook injection, and fiber tree queries.
 *
 * Uses React DevTools' installHook.js to install __REACT_DEVTOOLS_GLOBAL_HOOK__
 * before page JS runs. React auto-discovers the hook and registers renderers.
 * All queries use page.evaluate() against the hook — no Chrome extension needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BrowserManager } from './browser-manager';
import type { Page } from 'playwright';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'browse', 'react-devtools');
const HOOK_PATH = path.join(CACHE_DIR, 'installHook.js');
const HOOK_URL = 'https://unpkg.com/react-devtools-core@latest/dist/installHook.js';

/**
 * Download installHook.js if not cached. Returns the script content.
 */
export async function ensureHook(): Promise<string> {
  if (fs.existsSync(HOOK_PATH)) {
    return fs.readFileSync(HOOK_PATH, 'utf8');
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const res = await fetch(HOOK_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download React DevTools hook (HTTP ${res.status}).\n` +
      `Manual fallback: npm install -g react-devtools-core, then copy installHook.js to ${HOOK_PATH}`
    );
  }

  const script = await res.text();
  fs.writeFileSync(HOOK_PATH, script);
  return script;
}

/**
 * Inject the hook into the browser context via addInitScript.
 * The hook runs before any page JS, so React discovers it on load.
 */
export async function injectHook(bm: BrowserManager): Promise<void> {
  const hookScript = await ensureHook();
  const context = bm.getContext();
  if (!context) throw new Error('No browser context available');
  await context.addInitScript(hookScript);
  bm.setReactDevToolsEnabled(true);
}

/**
 * Mark DevTools as disabled. Can't remove init scripts —
 * takes effect on next context creation or page reload without the hook.
 */
export function removeHook(bm: BrowserManager): void {
  bm.setReactDevToolsEnabled(false);
}

/**
 * Check if React DevTools hook is currently injected.
 */
export function isEnabled(bm: BrowserManager): boolean {
  return bm.getReactDevToolsEnabled();
}

/**
 * Helper: check that DevTools is enabled, throw actionable error if not.
 */
export function requireEnabled(bm: BrowserManager): void {
  if (!isEnabled(bm)) {
    throw new Error(
      'React DevTools not enabled. Run "browse react-devtools enable" first.'
    );
  }
}

/**
 * Helper: check that React is detected on the page.
 * Returns the renderer interface or throws.
 */
export async function requireReact(page: Page): Promise<void> {
  const hasReact = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return false;
    // Check if any renderer is attached
    if (hook.rendererInterfaces && hook.rendererInterfaces.size > 0) return true;
    if (hook.renderers && hook.renderers.size > 0) return true;
    return false;
  });

  if (!hasReact) {
    throw new Error('No React detected on this page.');
  }
}

// ---------------------------------------------------------------------------
// Query functions — fiber tree introspection via page.evaluate()
// ---------------------------------------------------------------------------

/**
 * Walk the fiber tree from root and return a formatted component tree.
 */
export async function getTree(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const tree = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;

    const walkFiber = (fiber: any, depth: number): string[] => {
      const lines: string[] = [];
      if (!fiber) return lines;

      const name = fiber.type?.displayName || fiber.type?.name ||
                   (typeof fiber.type === 'string' ? fiber.type : null);

      if (name) {
        const indent = '  '.repeat(depth);
        let extra = '';
        // Suspense boundary (tag 13 = SuspenseComponent)
        if (fiber.tag === 13) {
          const resolved = fiber.memoizedState === null;
          extra = resolved ? ' (resolved)' : ' (pending)';
        }
        lines.push(`${indent}${name}${extra}`);
      }

      // Walk children via child → sibling linked list
      let child = fiber.child;
      while (child) {
        lines.push(...walkFiber(child, name ? depth + 1 : depth));
        child = child.sibling;
      }

      return lines;
    };

    const rendererID = hook.renderers?.keys().next().value ?? 1;
    const roots = hook.getFiberRoots?.(rendererID);
    if (!roots || roots.size === 0) return '(no fiber roots found)';

    const root = roots.values().next().value;
    const current = root.current;
    if (!current) return '(no current fiber)';

    const lines = walkFiber(current, 0);
    return lines.join('\n') || '(empty tree)';
  });

  return tree || '(no component tree available)';
}

/**
 * Get props and hook state of the React component that owns the given element.
 */
export async function getProps(bm: BrowserManager, page: Page, selector: string): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const resolved = bm.resolveRef(selector);
  const element = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);

  const handle = await element.elementHandle();
  if (!handle) throw new Error(`Element not found: ${selector}`);

  const result = await page.evaluate((el) => {
    // Find the fiber attached to this DOM element
    let fiber: any = null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        fiber = (el as any)[key];
        break;
      }
    }
    if (!fiber) return 'No React fiber found for this element';

    // Walk up to nearest component (skip host elements like div, span)
    while (fiber && typeof fiber.type === 'string') {
      fiber = fiber.return;
    }
    if (!fiber) return 'No React component found';

    const name = fiber.type?.displayName || fiber.type?.name || 'Anonymous';
    const props = fiber.memoizedProps || {};
    const state = fiber.memoizedState;

    // Format props (skip children, functions show as [Function])
    const propEntries: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      if (k === 'children') continue;
      if (typeof v === 'function') { propEntries.push(`${k}: [Function]`); continue; }
      try { propEntries.push(`${k}: ${JSON.stringify(v)}`); } catch { propEntries.push(`${k}: [Complex]`); }
    }

    // Format state (hooks are a linked list via .next)
    const stateEntries: string[] = [];
    let hookNode = state;
    let hookIdx = 0;
    while (hookNode && typeof hookNode === 'object' && 'memoizedState' in hookNode) {
      const val = hookNode.memoizedState;
      if (val !== undefined && val !== null) {
        try { stateEntries.push(`hook[${hookIdx}]: ${JSON.stringify(val)}`); } catch { stateEntries.push(`hook[${hookIdx}]: [Complex]`); }
      }
      hookNode = hookNode.next;
      hookIdx++;
    }

    let output = `Component: ${name}\n`;
    if (propEntries.length) output += `\nProps:\n${propEntries.map(e => `  ${e}`).join('\n')}\n`;
    if (stateEntries.length) output += `\nState:\n${stateEntries.map(e => `  ${e}`).join('\n')}\n`;

    return output;
  }, handle);

  await handle.dispose();
  return result;
}

/**
 * Find all Suspense boundaries and report their resolution status.
 */
export async function getSuspense(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const result = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const rendererID = hook.renderers?.keys().next().value ?? 1;
    const roots = hook.getFiberRoots?.(rendererID);
    if (!roots || roots.size === 0) return 'No fiber roots found';

    const root = roots.values().next().value;
    const boundaries: string[] = [];

    const walk = (fiber: any, path: string[]) => {
      if (!fiber) return;
      if (fiber.tag === 13) { // SuspenseComponent
        const resolved = fiber.memoizedState === null;
        const parent = path.length > 0 ? path[path.length - 1] : 'root';
        boundaries.push(`Suspense in ${parent} — ${resolved ? 'resolved (children visible)' : 'pending (showing fallback)'}`);
      }
      const name = fiber.type?.displayName || fiber.type?.name || null;
      const newPath = name ? [...path, name] : path;
      let child = fiber.child;
      while (child) {
        walk(child, newPath);
        child = child.sibling;
      }
    };

    walk(root.current, []);
    return boundaries.length > 0 ? boundaries.join('\n') : 'No Suspense boundaries found';
  });

  return result;
}

/**
 * Find all error boundaries and report whether they have caught errors.
 */
export async function getErrors(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const result = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const rendererID = hook.renderers?.keys().next().value ?? 1;
    const roots = hook.getFiberRoots?.(rendererID);
    if (!roots || roots.size === 0) return 'No fiber roots found';

    const root = roots.values().next().value;
    const errors: string[] = [];

    const walk = (fiber: any) => {
      if (!fiber) return;
      // Error boundaries are class components (tag 1) with componentDidCatch
      if (fiber.tag === 1 && fiber.type?.prototype?.componentDidCatch) {
        const name = fiber.type.displayName || fiber.type.name || 'ErrorBoundary';
        const hasError = fiber.memoizedState?.error;
        errors.push(`${name} — ${hasError ? 'caught: ' + String(hasError) : 'no error caught'}`);
      }
      let child = fiber.child;
      while (child) { walk(child); child = child.sibling; }
    };

    walk(root.current);
    return errors.length > 0 ? errors.join('\n') : 'No error boundaries found';
  });

  return result;
}

/**
 * Report React Profiler timing data (actualDuration / selfBaseDuration).
 * Requires React profiling build (react-dom/profiling).
 */
export async function getProfiler(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const result = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const rendererID = hook.renderers?.keys().next().value ?? 1;
    const roots = hook.getFiberRoots?.(rendererID);
    if (!roots || roots.size === 0) return 'No fiber roots found';

    const root = roots.values().next().value;
    const timings: string[] = [];

    const walk = (fiber: any) => {
      if (!fiber) return;
      const name = fiber.type?.displayName || fiber.type?.name;
      if (name && fiber.actualDuration !== undefined) {
        timings.push(`${name}: ${fiber.actualDuration.toFixed(1)}ms (self: ${fiber.selfBaseDuration?.toFixed(1) || '?'}ms)`);
      }
      let child = fiber.child;
      while (child) { walk(child); child = child.sibling; }
    };

    walk(root.current);
    return timings.length > 0 ? timings.join('\n') : 'No profiling data (requires React profiling build)';
  });

  return result;
}

/**
 * Report hydration timing from performance entries or Next.js instrumentation.
 */
export async function getHydration(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const result = await page.evaluate(() => {
    // Check Next.js-style timing instrumentation first
    const timing = (window as any).__NEXT_BROWSER_REACT_TIMING__;
    if (timing && timing.length > 0) {
      const hydrationEntries = timing
        .filter((t: any) => t.label.includes('hydrat') || t.label.includes('Hydrat'))
        .map((t: any) => `${t.label}: ${(t.endTime - t.startTime).toFixed(1)}ms`);
      if (hydrationEntries.length > 0) return hydrationEntries.join('\n');
    }

    // Fallback: standard Performance API measure entries
    const entries = performance.getEntriesByType('measure')
      .filter(e => e.name.toLowerCase().includes('hydrat'));
    if (entries.length > 0) {
      return entries.map(e => `${e.name}: ${e.duration.toFixed(1)}ms`).join('\n');
    }

    return 'No hydration timing data. Requires React profiling build or Next.js dev mode.';
  });

  return result;
}

/**
 * Report which components re-rendered in the most recent commit.
 * Uses actualDuration > 0 with an alternate fiber as the signal.
 */
export async function getRenders(bm: BrowserManager, page: Page): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const result = await page.evaluate(() => {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const rendererID = hook.renderers?.keys().next().value ?? 1;
    const roots = hook.getFiberRoots?.(rendererID);
    if (!roots || roots.size === 0) return 'No fiber roots found';

    const root = roots.values().next().value;
    const rendered: string[] = [];

    const walk = (fiber: any) => {
      if (!fiber) return;
      const name = fiber.type?.displayName || fiber.type?.name;
      // A fiber with an alternate and positive actualDuration rendered this commit
      if (name && fiber.alternate && fiber.actualDuration > 0) {
        rendered.push(`${name} (${fiber.actualDuration.toFixed(1)}ms)`);
      }
      let child = fiber.child;
      while (child) { walk(child); child = child.sibling; }
    };

    walk(root.current);
    return rendered.length > 0 ? `Re-rendered:\n${rendered.join('\n')}` : 'No components re-rendered since last commit';
  });

  return result;
}

/**
 * Walk up the fiber tree from an element to show the parent component chain.
 */
export async function getOwners(bm: BrowserManager, page: Page, selector: string): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const resolved = bm.resolveRef(selector);
  const element = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
  const handle = await element.elementHandle();
  if (!handle) throw new Error(`Element not found: ${selector}`);

  const result = await page.evaluate((el) => {
    let fiber: any = null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        fiber = (el as any)[key];
        break;
      }
    }
    if (!fiber) return 'No React fiber found for this element';

    const chain: string[] = [];
    let current = fiber;
    while (current) {
      const name = current.type?.displayName || current.type?.name;
      if (name && typeof current.type !== 'string') {
        chain.push(name);
      }
      current = current.return;
    }

    return chain.length > 0 ? chain.join(' \u2192 ') : 'No component owners found';
  }, handle);

  await handle.dispose();
  return result;
}

/**
 * Read React Context values consumed by the component at the given element.
 */
export async function getContext(bm: BrowserManager, page: Page, selector: string): Promise<string> {
  requireEnabled(bm);
  await requireReact(page);

  const resolved = bm.resolveRef(selector);
  const element = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
  const handle = await element.elementHandle();
  if (!handle) throw new Error(`Element not found: ${selector}`);

  const result = await page.evaluate((el) => {
    let fiber: any = null;
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
        fiber = (el as any)[key];
        break;
      }
    }
    if (!fiber) return 'No React fiber found for this element';

    // Walk up to nearest component (skip host elements)
    while (fiber && typeof fiber.type === 'string') fiber = fiber.return;
    if (!fiber) return 'No React component found';

    // Read context dependencies from the fiber
    const deps = fiber.dependencies;
    if (!deps || !deps.firstContext) return 'No context consumed by this component';

    const contexts: string[] = [];
    let ctx = deps.firstContext;
    while (ctx) {
      const name = ctx.context?.displayName || ctx.context?._debugLabel || 'UnnamedContext';
      const value = ctx.context?._currentValue;
      try {
        contexts.push(`${name}: ${JSON.stringify(value, null, 2)}`);
      } catch {
        contexts.push(`${name}: [Complex value]`);
      }
      ctx = ctx.next;
    }

    return contexts.length > 0 ? contexts.join('\n\n') : 'No context consumed';
  }, handle);

  await handle.dispose();
  return result;
}
