/**
 * SDK mode — programmatic API for direct browser automation.
 *
 * Usage:
 *   import { createBrowser } from '@ulpi/browse';
 *   const browser = await createBrowser();
 *   await browser.goto('https://example.com');
 *   const text = await browser.text();
 *   await browser.close();
 *
 * No HTTP server is spawned. Direct BrowserManager access.
 */

import { BrowserManager } from './browser/manager';
import { SessionBuffers } from './network/buffers';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';

export interface BrowseSDK {
  goto(url: string): Promise<string>;
  text(): Promise<string>;
  html(selector?: string): Promise<string>;
  click(selector: string): Promise<string>;
  fill(selector: string, value: string): Promise<string>;
  type(text: string): Promise<string>;
  press(key: string): Promise<string>;
  snapshot(opts?: { interactive?: boolean }): Promise<string>;
  screenshot(path?: string): Promise<string>;
  evaluate(expression: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Create a new headless browser instance for programmatic use.
 * No HTTP server — direct Playwright access.
 */
export async function createBrowser(options?: {
  headless?: boolean;
}): Promise<BrowseSDK> {
  const buffers = new SessionBuffers();
  const bm = new BrowserManager(buffers);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: options?.headless !== false });
  await bm.launchWithBrowser(browser);

  const noopShutdown = async () => {};

  return {
    async goto(url: string) {
      return handleWriteCommand('goto', [url], bm);
    },
    async text() {
      return handleReadCommand('text', [], bm, buffers);
    },
    async html(selector?: string) {
      return handleReadCommand('html', selector ? [selector] : [], bm, buffers);
    },
    async click(selector: string) {
      return handleWriteCommand('click', [selector], bm);
    },
    async fill(selector: string, value: string) {
      return handleWriteCommand('fill', [selector, value], bm);
    },
    async type(text: string) {
      return handleWriteCommand('type', [text], bm);
    },
    async press(key: string) {
      return handleWriteCommand('press', [key], bm);
    },
    async snapshot(opts?: { interactive?: boolean }) {
      const args = opts?.interactive ? ['-i'] : [];
      return handleMetaCommand('snapshot', args, bm, noopShutdown);
    },
    async screenshot(path?: string) {
      return handleMetaCommand('screenshot', path ? [path] : [], bm, noopShutdown);
    },
    async evaluate(expression: string) {
      return handleReadCommand('js', [expression], bm, buffers);
    },
    async close() {
      await bm.close();
      await browser.close();
    },
  };
}
