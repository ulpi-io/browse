/**
 * Read commands — extract data from pages without side effects
 *
 * text, html, links, forms, accessibility, js, eval, css, attrs, state,
 * console, network, cookies, storage, perf
 */

import type { BrowserTarget } from '../browser/target';
import { listDevices } from '../browser/emulation';
import type { SessionBuffers } from '../network/buffers';
import { DEFAULTS } from '../constants';
import * as fs from 'fs';

export async function handleReadCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  buffers?: SessionBuffers
): Promise<string> {
  const page = bm.getPage();
  // When a frame is active, evaluate() calls run inside the frame context.
  // For locator-based commands, resolveRef already scopes through the frame.
  const evalCtx = await bm.getFrameContext() || page;

  switch (command) {
    case 'text': {
      // TreeWalker-based extraction — never appends to the live DOM,
      // so MutationObservers are not triggered.
      return await evalCtx.evaluate(() => {
        const body = document.body;
        if (!body) return '';
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);
        const lines: string[] = [];
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== body) {
              if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = (node.textContent || '').trim();
          if (text) lines.push(text);
        }
        return lines.join('\n');
      });
    }

    case 'html': {
      const selector = args[0];
      if (selector) {
        const resolved = bm.resolveRef(selector);
        if ('locator' in resolved) {
          return await resolved.locator.innerHTML({ timeout: 5000 });
        }
        return await page.innerHTML(resolved.selector);
      }
      // When a frame is active, return the frame's full HTML
      if (bm.getActiveFrameSelector()) {
        return await evalCtx.evaluate(() => document.documentElement.outerHTML);
      }
      return await page.content();
    }

    case 'links': {
      const links = await evalCtx.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim().slice(0, 120) || '',
          href: (a as HTMLAnchorElement).href,
        })).filter(l => l.text && l.href)
      );
      return links.map(l => `${l.text} → ${l.href}`).join('\n');
    }

    case 'forms': {
      const forms = await evalCtx.evaluate(() => {
        return [...document.querySelectorAll('form')].map((form, i) => {
          const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || undefined,
              name: input.name || undefined,
              id: input.id || undefined,
              placeholder: input.placeholder || undefined,
              required: input.required || undefined,
              value: input.value || undefined,
              options: el.tagName === 'SELECT'
                ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, text: o.text }))
                : undefined,
            };
          });
          return {
            index: i,
            action: form.action || undefined,
            method: form.method || 'get',
            id: form.id || undefined,
            fields,
          };
        });
      });
      return JSON.stringify(forms, null, 2);
    }

    case 'accessibility': {
      const root = bm.getLocatorRoot();
      const snapshot = await root.locator('body').ariaSnapshot();
      return snapshot;
    }

    case 'js': {
      const expr = args[0];
      if (!expr) throw new Error('Usage: browse js <expression>');
      const result = await evalCtx.evaluate(expr);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'eval': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse eval <js-file>');
      if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      const code = fs.readFileSync(filePath, 'utf-8');
      const result = await evalCtx.evaluate(code);
      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result ?? '');
    }

    case 'css': {
      const [selector, property] = args;
      if (!selector || !property) throw new Error('Usage: browse css <selector> <property>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        const value = await resolved.locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return value;
      }
      const value = await evalCtx.evaluate(
        ([sel, prop]) => {
          const el = document.querySelector(sel);
          if (!el) return { __notFound: true, selector: sel };
          return getComputedStyle(el).getPropertyValue(prop);
        },
        [resolved.selector, property]
      );
      if (typeof value === 'object' && value !== null && '__notFound' in value) {
        throw new Error(`Element not found: ${(value as any).selector}`);
      }
      return value as string;
    }

    case 'element-state': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse element-state <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved
        ? resolved.locator
        : page.locator(resolved.selector);

      const state: Record<string, unknown> = {};

      // Core state checks — each wrapped individually since not all
      // apply to every element type (e.g. isChecked only for checkbox/radio)
      try { state.visible = await locator.isVisible(); } catch { state.visible = null; }
      try { state.enabled = await locator.isEnabled(); } catch { state.enabled = null; }
      try { state.checked = await locator.isChecked(); } catch { state.checked = null; }
      try { state.editable = await locator.isEditable(); } catch { state.editable = null; }

      // Properties that require evaluate — grouped in one call for efficiency
      try {
        const domProps = await locator.evaluate((el) => {
          const input = el as HTMLInputElement;
          return {
            focused: document.activeElement === el,
            tag: el.tagName.toLowerCase(),
            type: input.type || null,
            value: input.value ?? null,
          };
        });
        Object.assign(state, domProps);
      } catch {
        state.focused = null;
        state.tag = null;
        state.type = null;
        state.value = null;
      }

      // Bounding box — null when element is not visible
      try { state.boundingBox = await locator.boundingBox(); } catch { state.boundingBox = null; }

      return JSON.stringify(state, null, 2);
    }

    case 'attrs': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse attrs <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        const attrs = await resolved.locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return JSON.stringify(attrs, null, 2);
      }
      const attrs = await evalCtx.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { __notFound: true, selector: sel };
        const result: Record<string, string> = {};
        for (const attr of el.attributes) {
          result[attr.name] = attr.value;
        }
        return result;
      }, resolved.selector);
      if (typeof attrs === 'object' && attrs !== null && '__notFound' in attrs) {
        throw new Error(`Element not found: ${(attrs as any).selector}`);
      }
      return JSON.stringify(attrs, null, 2);
    }

    case 'dialog': {
      const last = bm.getLastDialog();
      if (!last) return '(no dialog detected)';
      return JSON.stringify(last, null, 2);
    }

    case 'console': {
      const cb = (buffers || bm.getBuffers()).consoleBuffer;
      if (args[0] === '--clear') {
        cb.length = 0;
        return 'Console buffer cleared.';
      }
      if (cb.length === 0) return '(no console messages)';
      return cb.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
    }

    case 'network': {
      const nb = (buffers || bm.getBuffers()).networkBuffer;
      if (args[0] === '--clear') {
        nb.length = 0;
        return 'Network buffer cleared.';
      }
      if (nb.length === 0) return '(no network requests)';
      return nb.map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
    }

    case 'cookies': {
      const cookies = await page.context().cookies();
      return JSON.stringify(cookies, null, 2);
    }

    case 'storage': {
      if (args[0] === 'set' && args[1]) {
        const key = args[1];
        const value = args[2] || '';
        await evalCtx.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
        return `Set localStorage["${key}"] = "${value}"`;
      }
      const storage = await evalCtx.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      }));
      return JSON.stringify(storage, null, 2);
    }

    case 'perf': {
      const timings = await evalCtx.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return 'No navigation timing data available.';
        return {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domParse: Math.round(nav.domInteractive - nav.responseEnd),
          domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          total: Math.round(nav.loadEventEnd - nav.startTime),
        };
      });
      if (typeof timings === 'string') return timings;
      return Object.entries(timings)
        .map(([k, v]) => `${k.padEnd(12)} ${v}ms`)
        .join('\n');
    }

    case 'value': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse value <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      const value = await locator.inputValue({ timeout: 5000 });
      return value;
    }

    case 'count': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse count <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      const count = await locator.count();
      return String(count);
    }

    case 'clipboard': {
      if (args[0] === 'write') {
        const text = args.slice(1).join(' ');
        if (!text) throw new Error('Usage: browse clipboard write <text>');
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await evalCtx.evaluate((t) => navigator.clipboard.writeText(t), text);
        return `Clipboard set: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`;
      }
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      try {
        const text = await evalCtx.evaluate(() => navigator.clipboard.readText());
        return text || '(empty clipboard)';
      } catch {
        return '(clipboard not available)';
      }
    }

    case 'box': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse box <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      const box = await locator.boundingBox({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      if (!box) throw new Error(`Element ${selector} is not visible or has no bounding box`);
      return JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
    }

    case 'errors': {
      const cb = (buffers || bm.getBuffers()).consoleBuffer;
      if (args[0] === '--clear') {
        const before = cb.length;
        // Remove error entries in-place
        for (let i = cb.length - 1; i >= 0; i--) {
          if (cb[i].level === 'error') cb.splice(i, 1);
        }
        return `Cleared ${before - cb.length} error(s).`;
      }
      const errors = cb.filter(e => e.level === 'error');
      if (errors.length === 0) return '(no errors)';
      return errors.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.text}`
      ).join('\n');
    }

    case 'request': {
      const query = args[0];
      if (!query) throw new Error('Usage: browse request <index|url-pattern>');
      const nb = (buffers || bm.getBuffers()).networkBuffer;
      if (nb.length === 0) return 'No network entries. Navigate to a page first.';

      let entry: import('../network/buffers').NetworkEntry | undefined;
      const idx = parseInt(query, 10);
      if (!isNaN(idx) && String(idx) === query) {
        // Numeric index lookup
        if (idx < 0 || idx >= nb.length) return `No request at index ${idx}. Buffer has ${nb.length} entries.`;
        entry = nb[idx];
      } else {
        // URL pattern match (most recent)
        for (let i = nb.length - 1; i >= 0; i--) {
          if (nb[i].url.includes(query)) { entry = nb[i]; break; }
        }
        if (!entry) {
          const recent = nb.slice(-3).map(e => `${e.method} ${e.url}`).join(', ');
          return `No request matching '${query}'. Recent: ${recent}`;
        }
      }

      const lines: string[] = [];
      lines.push(`${entry.method} ${entry.url} → ${entry.status ?? 'pending'} (${entry.duration ?? '?'}ms)`);
      if (entry.requestHeaders) {
        lines.push('\nRequest Headers:');
        for (const [k, v] of Object.entries(entry.requestHeaders)) lines.push(`  ${k}: ${v}`);
      }
      if (entry.requestBody) {
        lines.push('\nRequest Body:');
        lines.push(entry.requestBody);
      }
      if (entry.responseHeaders) {
        lines.push('\nResponse Headers:');
        for (const [k, v] of Object.entries(entry.responseHeaders)) lines.push(`  ${k}: ${v}`);
      }
      if (entry.responseBody) {
        lines.push('\nResponse Body:');
        lines.push(entry.responseBody);
      }
      if (!entry.requestHeaders && !entry.responseHeaders) {
        lines.push('\nRequest bodies not available. Enable with --network-bodies or BROWSE_NETWORK_BODIES=1.');
      }
      return lines.join('\n');
    }

    case 'layout': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse layout <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      const props = await locator.evaluate((el: Element) => {
        const s = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const result: Record<string, string> = {
          display: s.display,
          position: s.position,
          'z-index': s.zIndex,
          box: `${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.x)},${Math.round(rect.y)})`,
          margin: s.margin,
          padding: s.padding,
          overflow: `${s.overflowX} / ${s.overflowY}`,
          font: `${s.fontSize} ${s.fontWeight} ${s.fontFamily.split(',')[0]}`,
          color: s.color,
          background: s.backgroundColor,
        };
        if (s.display === 'none') result.note = 'hidden (display: none)';
        // Walk positioning ancestors
        const ancestors: string[] = [];
        let parent = el.parentElement;
        while (parent && parent !== document.documentElement) {
          const ps = getComputedStyle(parent);
          if (ps.position !== 'static') {
            const pr = parent.getBoundingClientRect();
            ancestors.push(`${parent.tagName.toLowerCase()}${parent.id ? '#' + parent.id : ''} (${ps.position}, z:${ps.zIndex}, ${Math.round(pr.width)}x${Math.round(pr.height)})`);
          }
          parent = parent.parentElement;
        }
        if (ancestors.length > 0) result.ancestors = ancestors.join(' → ');
        return result;
      });
      return Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('\n');
    }

    case 'devices': {
      const filter = args.join(' ').toLowerCase();
      const all = listDevices();
      const filtered = filter ? all.filter(d => d.toLowerCase().includes(filter)) : all;
      if (filtered.length === 0) {
        return `No devices matching "${filter}". Run "browse devices" to see all.`;
      }
      return filtered.join('\n');
    }

    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}

// ─── Definition Registration ──────────────────────────────────────
// Each read command owns its definition — the registry is the single
// source of truth for both metadata and dispatch.

import type { CommandRegistry, CommandContext } from '../automation/command';

/**
 * Register all read command definitions in the registry.
 * Called once during lazy initialization from ensureDefinitionsRegistered().
 */
export function registerReadDefinitions(registry: CommandRegistry): void {
  for (const spec of registry.byCategory('read')) {
    registry.define({
      spec,
      mcpArgDecode: spec.mcp?.argDecode,
      execute: async (ctx: CommandContext) => {
        const bt = ctx.target as BrowserTarget;
        return handleReadCommand(spec.name, ctx.args, bt, ctx.buffers);
      },
    });
  }
}
