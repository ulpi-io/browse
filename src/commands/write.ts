/**
 * Write commands — navigate and interact with pages (side effects)
 *
 * goto, back, forward, reload, click, dblclick, fill, select, hover,
 * focus, check, uncheck, type, press, scroll, wait, viewport, cookie,
 * header, useragent, drag, keydown, keyup
 */

import type { BrowserContext } from 'playwright';
import type { BrowserTarget } from '../browser/target';
import { resolveDevice, listDevices } from '../browser/emulation';
import type { DomainFilter } from '../security/domain-filter';
import { DEFAULTS } from '../constants';
import * as fs from 'fs';

/**
 * Clear all routes and re-register them in correct order:
 * user routes first, domain filter last (Playwright checks last-registered first).
 */
async function rebuildRoutes(context: BrowserContext, bm: BrowserTarget, domainFilter?: DomainFilter | null): Promise<void> {
  await context.unrouteAll();
  // User routes first (checked last by Playwright)
  for (const r of bm.getUserRoutes()) {
    if (r.action === 'block') {
      await context.route(r.pattern, (route) => route.abort('blockedbyclient'));
    } else {
      await context.route(r.pattern, (route) => route.fulfill({ status: r.status || 200, body: r.body || '', contentType: 'text/plain' }));
    }
  }
  // Domain filter last (checked first by Playwright)
  if (domainFilter) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (domainFilter.isAllowed(url)) { route.fallback(); } else { route.abort('blockedbyclient'); }
    });
  }
}

export async function handleWriteCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  domainFilter?: DomainFilter | null
): Promise<string> {
  const page = bm.getPage();

  switch (command) {
    case 'goto': {
      const url = args[0];
      if (!url) throw new Error('Usage: browse goto <url>');
      if (domainFilter && !domainFilter.isAllowed(url)) {
        throw new Error(domainFilter.blockedMessage(url));
      }
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULTS.COMMAND_TIMEOUT_MS });
      const status = response?.status() || 'unknown';
      return `Navigated to ${url} (${status})`;
    }

    case 'back': {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULTS.COMMAND_TIMEOUT_MS });
      return `Back → ${page.url()}`;
    }

    case 'forward': {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: DEFAULTS.COMMAND_TIMEOUT_MS });
      return `Forward → ${page.url()}`;
    }

    case 'reload': {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: DEFAULTS.COMMAND_TIMEOUT_MS });
      return `Reloaded ${page.url()}`;
    }

    case 'click': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse click <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.click({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.click(resolved.selector, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      // Wait briefly for any navigation/DOM update
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return `Clicked ${selector} → now at ${page.url()}`;
    }

    case 'fill': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector) throw new Error('Usage: browse fill <selector> <value>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.fill(value, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.fill(resolved.selector, value, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Filled ${selector}`;
    }

    case 'select': {
      const [selector, ...valueParts] = args;
      const value = valueParts.join(' ');
      if (!selector) throw new Error('Usage: browse select <selector> <value>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.selectOption(value, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.selectOption(resolved.selector, value, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Selected "${value}" in ${selector}`;
    }

    case 'hover': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse hover <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.hover({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.hover(resolved.selector, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Hovered ${selector}`;
    }

    case 'type': {
      const text = args.join(' ');
      if (!text) throw new Error('Usage: browse type <text>');
      await page.keyboard.type(text);
      return `Typed "${text}"`;
    }

    case 'press': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse press <key> (e.g., Enter, Tab, Escape)');
      await page.keyboard.press(key);
      return `Pressed ${key}`;
    }

    case 'scroll': {
      const selector = args[0];
      if (selector === 'up') {
        const scrollCtx = await bm.getFrameContext() || page;
        await scrollCtx.evaluate(() => window.scrollBy(0, -window.innerHeight));
        return 'Scrolled up one viewport';
      }
      if (selector === 'down') {
        const scrollCtx = await bm.getFrameContext() || page;
        await scrollCtx.evaluate(() => window.scrollBy(0, window.innerHeight));
        return 'Scrolled down one viewport';
      }
      if (selector && selector !== 'bottom') {
        const resolved = bm.resolveRef(selector);
        if ('locator' in resolved) {
          await resolved.locator.scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        } else {
          await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        }
        return `Scrolled ${selector} into view`;
      }
      // Scroll to bottom (default or explicit "bottom")
      const scrollCtx = await bm.getFrameContext() || page;
      await scrollCtx.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return 'Scrolled to bottom';
    }

    case 'wait': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse wait <selector|ms|--url|--text|--fn|--load|--network-idle> [args]');

      // wait --network-idle [timeout] — wait for network to settle
      if (selector === '--network-idle') {
        const timeout = args[1] ? parseInt(args[1], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
        await page.waitForLoadState('networkidle', { timeout });
        return 'Network idle';
      }

      // wait --url <pattern> [timeout] — wait for URL to match
      if (selector === '--url') {
        const pattern = args[1];
        if (!pattern) throw new Error('Usage: browse wait --url <pattern> [timeout]');
        const timeout = args[2] ? parseInt(args[2], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
        await page.waitForURL(pattern, { timeout });
        return `URL matched: ${page.url()}`;
      }

      // wait --text "text" [timeout] — wait for text to appear in page body
      if (selector === '--text') {
        const text = args[1];
        if (!text) throw new Error('Usage: browse wait --text <text> [timeout]');
        const timeout = args[2] ? parseInt(args[2], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
        await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
        return `Text found: "${text}"`;
      }

      // wait --fn "expression" [timeout] — wait for JS condition to be truthy
      if (selector === '--fn') {
        const expr = args[1];
        if (!expr) throw new Error('Usage: browse wait --fn <js-expression> [timeout]');
        const timeout = args[2] ? parseInt(args[2], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
        await page.waitForFunction(expr, undefined, { timeout });
        return `Condition met: ${expr}`;
      }

      // wait --load <state> [timeout] — wait for load state
      if (selector === '--load') {
        const state = args[1] as 'load' | 'domcontentloaded' | 'networkidle';
        if (!state || !['load', 'domcontentloaded', 'networkidle'].includes(state)) {
          throw new Error('Usage: browse wait --load <load|domcontentloaded|networkidle> [timeout]');
        }
        const timeout = args[2] ? parseInt(args[2], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
        await page.waitForLoadState(state, { timeout });
        return `Load state reached: ${state}`;
      }

      // wait --download [path] [timeout] — wait for download to complete
      if (selector === '--download') {
        const pathOrTimeout = args[1];
        const timeout = args[2] ? parseInt(args[2], 10) : (pathOrTimeout && /^\d+$/.test(pathOrTimeout) ? parseInt(pathOrTimeout, 10) : 30000);
        const savePath = pathOrTimeout && !/^\d+$/.test(pathOrTimeout) ? pathOrTimeout : null;
        const download = await page.waitForEvent('download', { timeout });
        const filename = download.suggestedFilename();
        // Wait for download to finish (not just start)
        const failure = await download.failure();
        if (failure) return `Download failed: ${filename} — ${failure}`;
        if (savePath) {
          await download.saveAs(savePath);
          return `Downloaded: ${savePath} (${filename})`;
        }
        const tmpPath = await download.path();
        return `Downloaded: ${filename} (saved to ${tmpPath})`;
      }

      // wait <ms> — wait for milliseconds (numeric first arg)
      if (/^\d+$/.test(selector)) {
        const ms = parseInt(selector, 10);
        await page.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      }

      // wait <sel> [--state hidden] [timeout] — wait for element
      const stateIdx = args.indexOf('--state');
      const state = stateIdx >= 0 ? args[stateIdx + 1] as 'visible' | 'hidden' | 'attached' | 'detached' : 'visible';
      const timeoutArgs = args.filter((a, i) => i !== 0 && a !== '--state' && (stateIdx < 0 || i !== stateIdx + 1));
      const timeout = timeoutArgs[0] ? parseInt(timeoutArgs[0], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;

      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.waitFor({ state, timeout });
      } else {
        await page.waitForSelector(resolved.selector, { state, timeout });
      }
      return state === 'hidden' ? `Element ${selector} hidden` : `Element ${selector} appeared`;
    }

    case 'viewport': {
      const size = args[0];
      if (!size || !size.includes('x')) throw new Error('Usage: browse viewport <WxH> (e.g., 375x812)');
      const [w, h] = size.split('x').map(Number);
      await bm.setViewport(w, h);
      return `Viewport set to ${w}x${h}`;
    }

    case 'cookie': {
      const cookieStr = args[0];
      if (!cookieStr) throw new Error('Usage: browse cookie <name>=<value> | cookie clear | cookie set <n> <v> [opts] | cookie export <file> | cookie import <file>');

      // cookie clear — remove all cookies
      if (cookieStr === 'clear') {
        await page.context().clearCookies();
        return 'All cookies cleared';
      }

      // cookie export <file> — save cookies to JSON file
      if (cookieStr === 'export') {
        const file = args[1];
        if (!file) throw new Error('Usage: browse cookie export <file>');
        const cookies = await page.context().cookies();
        fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
        return `Exported ${cookies.length} cookie(s) to ${file}`;
      }

      // cookie import <file> — load cookies from JSON file
      if (cookieStr === 'import') {
        const file = args[1];
        if (!file) throw new Error('Usage: browse cookie import <file>');
        if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
        const cookies = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (!Array.isArray(cookies)) throw new Error('Cookie file must contain a JSON array of cookie objects');
        await page.context().addCookies(cookies);
        return `Imported ${cookies.length} cookie(s) from ${file}`;
      }

      // cookie set <name> <value> [--domain <d>] [--secure] [--expires <ts>] [--sameSite <s>]
      if (cookieStr === 'set') {
        const name = args[1];
        const value = args[2];
        if (!name || !value) throw new Error('Usage: browse cookie set <name> <value> [--domain <d>] [--secure] [--expires <ts>] [--sameSite <s>]');
        const url = new URL(page.url());
        const cookie: any = { name, value, domain: url.hostname, path: '/' };
        for (let i = 3; i < args.length; i++) {
          if (args[i] === '--domain' && args[i + 1]) { cookie.domain = args[++i]; }
          else if (args[i] === '--secure') { cookie.secure = true; }
          else if (args[i] === '--expires' && args[i + 1]) { cookie.expires = parseInt(args[++i], 10); }
          else if (args[i] === '--sameSite' && args[i + 1]) { cookie.sameSite = args[++i]; }
          else if (args[i] === '--path' && args[i + 1]) { cookie.path = args[++i]; }
        }
        await page.context().addCookies([cookie]);
        return `Cookie set: ${name}=${value}${cookie.domain !== url.hostname ? ` (domain: ${cookie.domain})` : ''}`;
      }

      // Legacy: cookie <name>=<value>
      if (!cookieStr.includes('=')) throw new Error('Usage: browse cookie <name>=<value> | cookie clear | cookie set <n> <v> [opts] | cookie export <file> | cookie import <file>');
      const eq = cookieStr.indexOf('=');
      const name = cookieStr.slice(0, eq);
      const value = cookieStr.slice(eq + 1);
      const url = new URL(page.url());
      await page.context().addCookies([{
        name,
        value,
        domain: url.hostname,
        path: '/',
      }]);
      return `Cookie set: ${name}=${value}`;
    }

    case 'header': {
      const headerStr = args[0];
      if (!headerStr || !headerStr.includes(':')) throw new Error('Usage: browse header <name>:<value>');
      const sep = headerStr.indexOf(':');
      const name = headerStr.slice(0, sep).trim();
      const value = headerStr.slice(sep + 1).trim();
      await bm.setExtraHeader(name, value);
      return `Header set: ${name}: ${value}`;
    }

    case 'useragent': {
      const ua = args.join(' ');
      if (!ua) throw new Error('Usage: browse useragent <string>');
      const prevUA = bm.getUserAgent();
      bm.setUserAgent(ua);
      try {
        await bm.applyUserAgent();
      } catch (err) {
        // Rollback: restore previous UA so stored state matches the live context
        bm.setUserAgent(prevUA || '');
        throw err;
      }
      return `User agent set: ${ua}\nNote: Cookies and tab URLs preserved. localStorage/sessionStorage were reset (Playwright limitation).`;
    }

    case 'upload': {
      const [selector, ...filePaths] = args;
      if (!selector || filePaths.length === 0) throw new Error('Usage: browse upload <selector> <file1> [file2] ...');
      for (const fp of filePaths) {
        if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
      }
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.setInputFiles(filePaths, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.locator(resolved.selector).setInputFiles(filePaths, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Uploaded ${filePaths.length} file(s) to ${selector}`;
    }

    case 'dialog-accept': {
      const value = args.join(' ') || undefined;
      bm.setAutoDialogAction('accept', value);
      return `Dialog auto-action set to: accept${value ? ` (with value: "${value}")` : ''}`;
    }

    case 'dialog-dismiss': {
      bm.setAutoDialogAction('dismiss');
      return 'Dialog auto-action set to: dismiss';
    }

    case 'emulate': {
      const deviceName = args.join(' ');
      if (!deviceName) {
        throw new Error(
          'Usage: browse emulate <device>\n' +
          'Examples: browse emulate iPhone 15, browse emulate Pixel 7, browse emulate reset\n' +
          'Run "browse devices" to see all available devices.'
        );
      }

      // Reset to desktop
      if (deviceName.toLowerCase() === 'reset' || deviceName.toLowerCase() === 'desktop') {
        await bm.emulateDevice(null);
        return 'Device emulation reset to desktop (1920x1080)';
      }

      const device = resolveDevice(deviceName);
      if (!device) {
        // Find close matches
        const all = listDevices();
        const lower = deviceName.toLowerCase();
        const suggestions = all.filter(d => d.toLowerCase().includes(lower)).slice(0, 5);
        throw new Error(
          `Unknown device: "${deviceName}"\n` +
          (suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}?\n`
            : '') +
          'Run "browse devices" to see all available devices.'
        );
      }

      await bm.emulateDevice(device);
      return [
        `Emulating: ${deviceName}`,
        `  Viewport: ${device.viewport.width}x${device.viewport.height}`,
        `  Scale: ${device.deviceScaleFactor}x`,
        `  Mobile: ${device.isMobile}`,
        `  Touch: ${device.hasTouch}`,
        `  UA: ${device.userAgent.slice(0, 80)}...`,
        'Note: Cookies and tab URLs preserved. localStorage/sessionStorage were reset (Playwright limitation).',
      ].join('\n');
    }

    case 'dblclick': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse dblclick <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.dblclick({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.dblclick(resolved.selector, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Double-clicked ${selector}`;
    }

    case 'focus': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse focus <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.focus({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.locator(resolved.selector).focus({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Focused ${selector}`;
    }

    case 'check': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse check <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.check({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.locator(resolved.selector).check({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Checked ${selector}`;
    }

    case 'uncheck': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse uncheck <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.uncheck({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.locator(resolved.selector).uncheck({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Unchecked ${selector}`;
    }

    case 'drag': {
      const [srcSel, tgtSel] = args;
      if (!srcSel || !tgtSel) throw new Error('Usage: browse drag <source> <target>');
      const srcResolved = bm.resolveRef(srcSel);
      const tgtResolved = bm.resolveRef(tgtSel);
      const srcLocator = 'locator' in srcResolved ? srcResolved.locator : page.locator(srcResolved.selector);
      const tgtLocator = 'locator' in tgtResolved ? tgtResolved.locator : page.locator(tgtResolved.selector);
      await srcLocator.dragTo(tgtLocator, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      return `Dragged ${srcSel} to ${tgtSel}`;
    }

    case 'keydown': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse keydown <key>');
      await page.keyboard.down(key);
      return `Key down: ${key}`;
    }

    case 'keyup': {
      const key = args[0];
      if (!key) throw new Error('Usage: browse keyup <key>');
      await page.keyboard.up(key);
      return `Key up: ${key}`;
    }

    case 'highlight': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse highlight <selector>');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      await locator.evaluate((el) => {
        el.style.outline = '3px solid #e11d48';
        el.style.outlineOffset = '2px';
      });
      return `Highlighted ${selector}`;
    }

    case 'download': {
      const [selector, savePath] = args;
      if (!selector) throw new Error('Usage: browse download <selector> [path]');
      const resolved = bm.resolveRef(selector);
      const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: DEFAULTS.COMMAND_TIMEOUT_MS }),
        locator.click({ timeout: DEFAULTS.ACTION_TIMEOUT_MS }),
      ]);
      const finalPath = savePath || download.suggestedFilename();
      await download.saveAs(finalPath);
      return `Downloaded: ${finalPath}`;
    }

    case 'offline': {
      const mode = args[0];
      if (mode === 'on') {
        await bm.setOffline(true);
        return 'Offline mode: ON';
      }
      if (mode === 'off') {
        await bm.setOffline(false);
        return 'Offline mode: OFF';
      }
      // Toggle
      const newState = !bm.isOffline();
      await bm.setOffline(newState);
      return `Offline mode: ${newState ? 'ON' : 'OFF'}`;
    }

    case 'rightclick': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse rightclick <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.click({ button: 'right', timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.click(resolved.selector, { button: 'right', timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Right-clicked ${selector}`;
    }

    case 'tap': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse tap <selector>');
      const resolved = bm.resolveRef(selector);
      try {
        if ('locator' in resolved) {
          await resolved.locator.tap({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        } else {
          await page.locator(resolved.selector).tap({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        }
      } catch (err: any) {
        if (err.message?.includes('hasTouch') || err.message?.includes('touch')) {
          throw new Error(
            `Tap requires a touch-enabled context. Run 'browse emulate "iPhone 14"' (or any mobile device) first to enable touch.`
          );
        }
        throw err;
      }
      return `Tapped ${selector}`;
    }

    case 'swipe': {
      const dir = args[0];
      if (!dir || !['up', 'down', 'left', 'right'].includes(dir)) {
        throw new Error('Usage: browse swipe <up|down|left|right> [pixels]');
      }
      const distance = args[1] ? parseInt(args[1], 10) : undefined;
      const vp = page.viewportSize() || { width: 1920, height: 1080 };
      const cx = Math.floor(vp.width / 2);
      const cy = Math.floor(vp.height / 2);
      const dx = dir === 'left' ? -(distance || vp.width * 0.7) : dir === 'right' ? (distance || vp.width * 0.7) : 0;
      const dy = dir === 'up' ? -(distance || vp.height * 0.7) : dir === 'down' ? (distance || vp.height * 0.7) : 0;
      // Use evaluate to dispatch synthetic touch events for maximum compatibility
      await page.evaluate(({ cx, cy, dx, dy }) => {
        const start = new Touch({ identifier: 1, target: document.elementFromPoint(cx, cy) || document.body, clientX: cx, clientY: cy });
        const end = new Touch({ identifier: 1, target: document.elementFromPoint(cx, cy) || document.body, clientX: cx + dx, clientY: cy + dy });
        const el = document.elementFromPoint(cx, cy) || document.body;
        el.dispatchEvent(new TouchEvent('touchstart', { touches: [start], changedTouches: [start], bubbles: true }));
        el.dispatchEvent(new TouchEvent('touchmove', { touches: [end], changedTouches: [end], bubbles: true }));
        el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [end], bubbles: true }));
      }, { cx, cy, dx, dy });
      return `Swiped ${dir}${distance ? ` ${distance}px` : ''}`;
    }

    case 'mouse': {
      const sub = args[0];
      if (!sub) throw new Error('Usage: browse mouse <move|click|down|up|wheel> [args]\n  move <x> <y>\n  click <x> <y> [left|right|middle]\n  down [left|right|middle]\n  up [left|right|middle]\n  wheel <dy> [dx]');
      switch (sub) {
        case 'move': {
          const x = parseInt(args[1], 10);
          const y = parseInt(args[2], 10);
          if (isNaN(x) || isNaN(y)) throw new Error('Usage: browse mouse move <x> <y>');
          await page.mouse.move(x, y);
          return `Mouse moved to ${x},${y}`;
        }
        case 'down': {
          const button = (args[1] || 'left') as 'left' | 'right' | 'middle';
          await page.mouse.down({ button });
          return `Mouse down (${button})`;
        }
        case 'up': {
          const button = (args[1] || 'left') as 'left' | 'right' | 'middle';
          await page.mouse.up({ button });
          return `Mouse up (${button})`;
        }
        case 'wheel': {
          const dy = parseInt(args[1], 10);
          const dx = args[2] ? parseInt(args[2], 10) : 0;
          if (isNaN(dy)) throw new Error('Usage: browse mouse wheel <dy> [dx]');
          await page.mouse.wheel(dx, dy);
          return `Mouse wheel dx=${dx} dy=${dy}`;
        }
        case 'click': {
          const x = parseInt(args[1], 10);
          const y = parseInt(args[2], 10);
          if (isNaN(x) || isNaN(y)) throw new Error('Usage: browse mouse click <x> <y> [left|right|middle]');
          const button = (args[3] || 'left') as 'left' | 'right' | 'middle';
          await page.mouse.click(x, y, { button });
          return `Mouse ${button}-clicked at ${x},${y}`;
        }
        default:
          throw new Error(`Unknown mouse subcommand: ${sub}. Use move|down|up|click|wheel`);
      }
    }

    case 'keyboard': {
      const sub = args[0];
      if (!sub) throw new Error('Usage: browse keyboard <inserttext> <text>');
      if (sub === 'inserttext' || sub === 'insertText') {
        const text = args.slice(1).join(' ');
        if (!text) throw new Error('Usage: browse keyboard inserttext <text>');
        await page.keyboard.insertText(text);
        return `Inserted text: "${text}"`;
      }
      throw new Error(`Unknown keyboard subcommand: ${sub}. Use inserttext`);
    }

    case 'scrollinto':
    case 'scrollintoview': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse scrollinto <selector>');
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      } else {
        await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      }
      return `Scrolled ${selector} into view`;
    }

    case 'set': {
      const sub = args[0];
      if (!sub) throw new Error('Usage: browse set <geo|media|context> [args]\n  geo <lat> <lng>\n  media <dark|light|no-preference>\n  context <on|off>');
      switch (sub) {
        case 'geo': {
          const lat = parseFloat(args[1]);
          const lng = parseFloat(args[2]);
          if (isNaN(lat) || isNaN(lng)) throw new Error('Usage: browse set geo <latitude> <longitude>');
          const context = bm.getContext();
          if (!context) throw new Error('No browser context');
          await context.grantPermissions(['geolocation']);
          await context.setGeolocation({ latitude: lat, longitude: lng });
          return `Geolocation set to ${lat}, ${lng}`;
        }
        case 'media': {
          const scheme = args[1];
          if (!scheme || !['dark', 'light', 'no-preference'].includes(scheme)) {
            throw new Error('Usage: browse set media <dark|light|no-preference>');
          }
          await page.emulateMedia({ colorScheme: scheme as 'dark' | 'light' | 'no-preference' });
          return `Color scheme set to ${scheme}`;
        }
        case 'context': {
          const val = args[1]?.toLowerCase();
          if (!val) {
            // No value — return current level hint (server.ts resolves actual level)
            return 'Context query — check session level';
          }
          const validLevels = ['off', 'on', 'state', 'delta', 'full'];
          if (!validLevels.includes(val)) {
            throw new Error('Usage: browse set context <off|on|state|delta|full>');
          }
          // Map 'on' to 'state' for backward compat
          const level = val === 'on' ? 'state' : val;
          if (level === 'off') return 'Context disabled';
          const descriptions: Record<string, string> = {
            state: 'state — write commands will include page state changes',
            delta: 'delta — write commands will include ARIA snapshot diff with refs',
            full: 'full — write commands will include complete ARIA snapshot with refs',
          };
          return `Context level set to ${descriptions[level]}`;
        }
        default:
          throw new Error(`Unknown set subcommand: ${sub}. Use geo|media|context`);
      }
    }

    case 'initscript': {
      const sub = args[0];
      if (!sub || !['set', 'clear', 'show'].includes(sub)) {
        throw new Error('Usage: browse initscript <set|clear|show> [code]\n  set <code>   Register a script to run before every page load\n  clear        Remove the init script\n  show         Display the current init script');
      }
      switch (sub) {
        case 'set': {
          const code = args.slice(1).join(' ');
          if (!code) throw new Error('Usage: browse initscript set <code>');
          const context = bm.getContext();
          if (!context) throw new Error('No browser context');
          await context.addInitScript(code);
          bm.setInitScript(code);
          return 'Init script set. Will run before every page load.';
        }
        case 'clear': {
          bm.setInitScript(null as unknown as string);
          return 'Init script cleared. Note: already-injected scripts remain active until the next context recreation (e.g. emulate or restart).';
        }
        case 'show': {
          const script = bm.getInitScript();
          return script ? script : 'No init script set.';
        }
        default:
          throw new Error('Usage: browse initscript <set|clear|show> [code]');
      }
    }

    case 'route': {
      // route <pattern> block — abort matching requests
      // route <pattern> fulfill <status> [body] — respond with custom data
      // route clear — remove all routes
      const pattern = args[0];
      if (!pattern) throw new Error('Usage: browse route <url-pattern> block | browse route <url-pattern> fulfill <status> [body] | browse route clear');

      const context = bm.getContext();
      if (!context) throw new Error('No browser context');

      if (pattern === 'clear') {
        await context.unrouteAll();
        bm.clearUserRoutes();
        // Re-apply domain filter route if active
        if (domainFilter) {
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (domainFilter!.isAllowed(url)) { route.fallback(); } else { route.abort('blockedbyclient'); }
          });
        }
        return domainFilter ? 'All routes cleared (domain filter preserved)' : 'All routes cleared';
      }

      const action = args[1] || 'block';

      if (action === 'block') {
        bm.addUserRoute(pattern, 'block');
        await rebuildRoutes(context, bm, domainFilter);
        return `Blocking requests matching: ${pattern}`;
      }

      if (action === 'fulfill') {
        const status = parseInt(args[2] || '200', 10);
        const body = args[3] || '';
        bm.addUserRoute(pattern, 'fulfill', status, body);
        await rebuildRoutes(context, bm, domainFilter);
        return `Mocking requests matching: ${pattern} → ${status}${body ? ` "${body}"` : ''}`;
      }

      throw new Error('Usage: browse route <pattern> block | browse route <pattern> fulfill <status> [body]');
    }

    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}
