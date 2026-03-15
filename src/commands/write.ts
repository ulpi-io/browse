/**
 * Write commands — navigate and interact with pages (side effects)
 *
 * goto, back, forward, reload, click, fill, select, hover, type,
 * press, scroll, wait, viewport, cookie, header, useragent
 */

import type { BrowserManager } from '../browser-manager';
import { resolveDevice, listDevices } from '../browser-manager';
import { DEFAULTS } from '../constants';
import * as fs from 'fs';

export async function handleWriteCommand(
  command: string,
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const page = bm.getPage();

  switch (command) {
    case 'goto': {
      const url = args[0];
      if (!url) throw new Error('Usage: browse goto <url>');
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
      if (!selector || !value) throw new Error('Usage: browse fill <selector> <value>');
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
      if (!selector || !value) throw new Error('Usage: browse select <selector> <value>');
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
      if (selector) {
        const resolved = bm.resolveRef(selector);
        if ('locator' in resolved) {
          await resolved.locator.scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        } else {
          await page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
        }
        return `Scrolled ${selector} into view`;
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      return 'Scrolled to bottom';
    }

    case 'wait': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse wait <selector>');
      const timeout = args[1] ? parseInt(args[1], 10) : DEFAULTS.COMMAND_TIMEOUT_MS;
      const resolved = bm.resolveRef(selector);
      if ('locator' in resolved) {
        await resolved.locator.waitFor({ state: 'visible', timeout });
      } else {
        await page.waitForSelector(resolved.selector, { timeout });
      }
      return `Element ${selector} appeared`;
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
      if (!cookieStr || !cookieStr.includes('=')) throw new Error('Usage: browse cookie <name>=<value>');
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

    default:
      throw new Error(`Unknown write command: ${command}`);
  }
}
