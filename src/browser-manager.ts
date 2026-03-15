/**
 * Browser lifecycle manager
 *
 * Chromium crash handling:
 *   browser.on('disconnected') → log error → process.exit(1)
 *   CLI detects dead server → auto-restarts on next command
 *   We do NOT try to self-heal — don't hide failure.
 */

import { chromium, devices as playwrightDevices, type Browser, type BrowserContext, type Page, type Locator, type Request as PlaywrightRequest } from 'playwright';
import { addConsoleEntry, addNetworkEntry, type LogEntry, type NetworkEntry } from './buffers';

/** Shorthand aliases for common devices → Playwright device names */
const DEVICE_ALIASES: Record<string, string> = {
  'iphone': 'iPhone 15',
  'iphone-12': 'iPhone 12',
  'iphone-13': 'iPhone 13',
  'iphone-14': 'iPhone 14',
  'iphone-15': 'iPhone 15',
  'iphone-14-pro': 'iPhone 14 Pro Max',
  'iphone-15-pro': 'iPhone 15 Pro Max',
  'iphone-16': 'iPhone 16',
  'iphone-16-pro': 'iPhone 16 Pro',
  'iphone-16-pro-max': 'iPhone 16 Pro Max',
  'iphone-17': 'iPhone 17',
  'iphone-17-pro': 'iPhone 17 Pro',
  'iphone-17-pro-max': 'iPhone 17 Pro Max',
  'iphone-se': 'iPhone SE',
  'pixel': 'Pixel 7',
  'pixel-7': 'Pixel 7',
  'pixel-5': 'Pixel 5',
  'samsung': 'Galaxy S9+',
  'galaxy': 'Galaxy S9+',
  'ipad': 'iPad (gen 7)',
  'ipad-pro': 'iPad Pro 11',
  'ipad-mini': 'iPad Mini',
};

/** Custom device descriptors for devices not yet in Playwright's built-in list */
const CUSTOM_DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 16': {
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 16 Pro': {
    viewport: { width: 402, height: 874 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 16 Pro Max': {
    viewport: { width: 440, height: 956 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17': {
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17 Pro': {
    viewport: { width: 402, height: 874 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17 Pro Max': {
    viewport: { width: 440, height: 956 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

export interface DeviceDescriptor {
  viewport: { width: number; height: number };
  userAgent: string;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

/** Resolve a device name (alias or Playwright name or custom) to a descriptor, or null */
export function resolveDevice(name: string): DeviceDescriptor | null {
  // Check aliases first (case-insensitive)
  const alias = DEVICE_ALIASES[name.toLowerCase()];
  const aliasTarget = alias || name;

  // Check custom devices
  if (CUSTOM_DEVICES[aliasTarget]) {
    return CUSTOM_DEVICES[aliasTarget];
  }
  // Direct Playwright device name lookup
  if (playwrightDevices[aliasTarget]) {
    return playwrightDevices[aliasTarget] as DeviceDescriptor;
  }
  // Fuzzy: try case-insensitive match across both lists
  const lower = name.toLowerCase();
  for (const [key, desc] of Object.entries(CUSTOM_DEVICES)) {
    if (key.toLowerCase() === lower) return desc;
  }
  for (const [key, desc] of Object.entries(playwrightDevices)) {
    if (key.toLowerCase() === lower) {
      return desc as DeviceDescriptor;
    }
  }
  return null;
}

/** List all available device names */
export function listDevices(): string[] {
  const all = new Set([
    ...Object.keys(CUSTOM_DEVICES),
    ...Object.keys(playwrightDevices),
  ]);
  return [...all].sort();
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<number, Page> = new Map();
  private activeTabId: number = 0;
  private nextTabId: number = 1;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;
  private currentDevice: DeviceDescriptor | null = null;

  // ─── Ref Map (snapshot → @e1, @e2, ...) ────────────────────
  // Refs are scoped per tab — switching tabs invalidates refs from the previous tab.
  private refMap: Map<string, Locator> = new Map();
  private refTabId: number = 0; // Which tab the current refs belong to

  // ─── Last Snapshot (for snapshot-diff) ─────────────────────
  // Per-tab so snapshot-diff compares the correct baseline after tab switches
  private tabSnapshots: Map<number, { text: string; opts: string[] }> = new Map();

  // ─── Dialog Handling ──────────────────────────────────────
  private lastDialog: { type: string; message: string; defaultValue?: string } | null = null;
  private autoDialogAction: 'accept' | 'dismiss' = 'dismiss';
  private dialogPromptValue: string | undefined;

  // ─── Network Correlation ────────────────────────────────────
  private requestEntryMap = new WeakMap<PlaywrightRequest, NetworkEntry>();

  async launch(onCrash?: () => void) {
    this.browser = await chromium.launch({ headless: true });

    // Chromium crash → flush what we can, then exit
    this.browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      if (onCrash) onCrash();
      process.exit(1);
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
    });

    // Create first tab
    await this.newTab();
  }

  async close() {
    if (this.browser) {
      // Remove disconnect handler to avoid exit during intentional close
      this.browser.removeAllListeners('disconnected');
      await this.browser.close();
      this.browser = null;
    }
  }

  isHealthy(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');

    const page = await this.context.newPage();

    // Wire up console/network capture before navigation so we capture everything
    this.wirePageEvents(page);

    // Navigate before committing the tab — if goto fails, close page and rethrow
    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    }

    // Only commit tab state after successful creation + navigation
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;

    return id;
  }

  async closeTab(id?: number): Promise<void> {
    const tabId = id ?? this.activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);
    this.tabSnapshots.delete(tabId);

    // Switch to another tab if we closed the active one
    if (tabId === this.activeTabId) {
      const remaining = [...this.pages.keys()];
      if (remaining.length > 0) {
        this.activeTabId = remaining[remaining.length - 1];
      } else {
        // No tabs left — create a new blank one
        await this.newTab();
      }
    }
  }

  switchTab(id: number): void {
    if (!this.pages.has(id)) throw new Error(`Tab ${id} not found`);
    this.activeTabId = id;
  }

  getActiveTabId(): number {
    return this.activeTabId;
  }

  hasTab(id: number): boolean {
    return this.pages.has(id);
  }

  getTabCount(): number {
    return this.pages.size;
  }

  getTabList(): Array<{ id: number; url: string; title: string; active: boolean }> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: '', // title requires await, populated by caller
        active: id === this.activeTabId,
      });
    }
    return tabs;
  }

  async getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    const tabs: Array<{ id: number; url: string; title: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === this.activeTabId,
      });
    }
    return tabs;
  }

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    const page = this.pages.get(this.activeTabId);
    if (!page) throw new Error('No active page. Use "browse goto <url>" first.');
    return page;
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── Ref Map ──────────────────────────────────────────────
  setRefMap(refs: Map<string, Locator>) {
    this.refMap = refs;
    this.refTabId = this.activeTabId;
  }

  clearRefs() {
    this.refMap.clear();
  }

  /**
   * Resolve a selector that may be a @ref (e.g., "@e3") or a CSS selector.
   * Returns { locator } for refs or { selector } for CSS selectors.
   */
  resolveRef(selector: string): { locator: Locator } | { selector: string } {
    if (selector.startsWith('@e')) {
      // Refs are scoped to the tab that created them — reject cross-tab usage
      if (this.refTabId !== this.activeTabId) {
        throw new Error(
          `Refs were created on tab ${this.refTabId}, but active tab is ${this.activeTabId}. ` +
          `Run 'snapshot' on the current tab to get fresh refs.`
        );
      }
      const ref = selector.slice(1); // "e3"
      const locator = this.refMap.get(ref);
      if (!locator) {
        throw new Error(
          `Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`
        );
      }
      return { locator };
    }
    return { selector };
  }

  getRefCount(): number {
    return this.refMap.size;
  }

  getRefMap(): Map<string, Locator> {
    return this.refMap;
  }

  /**
   * Check if refs are valid for the currently active tab.
   * Used by screenshot --annotate to avoid cross-tab ref leaks.
   */
  areRefsValidForActiveTab(): boolean {
    return this.refMap.size > 0 && this.refTabId === this.activeTabId;
  }

  setLastSnapshot(text: string, opts?: string[]) {
    this.tabSnapshots.set(this.activeTabId, { text, opts: opts || [] });
  }

  getLastSnapshot(): string | null {
    return this.tabSnapshots.get(this.activeTabId)?.text ?? null;
  }

  getLastSnapshotOpts(): string[] {
    return this.tabSnapshots.get(this.activeTabId)?.opts ?? [];
  }

  getLastDialog(): { type: string; message: string; defaultValue?: string } | null {
    return this.lastDialog;
  }

  setAutoDialogAction(action: 'accept' | 'dismiss', promptValue?: string) {
    this.autoDialogAction = action;
    this.dialogPromptValue = promptValue;
  }

  getAutoDialogAction(): 'accept' | 'dismiss' {
    return this.autoDialogAction;
  }

  // ─── Viewport ──────────────────────────────────────────────
  async setViewport(width: number, height: number) {
    await this.getPage().setViewportSize({ width, height });
  }

  // ─── Extra Headers ─────────────────────────────────────────
  async setExtraHeader(name: string, value: string) {
    this.extraHeaders[name] = value;
    if (this.context) {
      await this.context.setExtraHTTPHeaders(this.extraHeaders);
    }
  }

  // ─── User Agent ────────────────────────────────────────────
  setUserAgent(ua: string) {
    this.customUserAgent = ua || null;
  }

  getUserAgent(): string | null {
    return this.customUserAgent;
  }

  /**
   * Recreate the browser context with new options.
   * Playwright requires a new context to change UA/device — existing pages are closed.
   *
   * Preserves: cookies, all tab URLs (not just active), active tab selection.
   * Cannot preserve: localStorage/sessionStorage (bound to old context).
   */
  private async recreateContext(contextOptions: Record<string, any>): Promise<void> {
    if (!this.browser) return;

    // Save all tab URLs and which tab was active
    const tabUrls: Array<{ id: number; url: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      tabUrls.push({
        id,
        url: page.url(),
        active: id === this.activeTabId,
      });
    }

    // Save cookies from old context
    const savedCookies = this.context ? await this.context.cookies() : [];

    // Create new context FIRST — if this fails, old session is untouched
    const newContext = await this.browser.newContext(contextOptions);

    // Restore cookies and headers into new context before creating tabs
    try {
      if (savedCookies.length > 0) {
        await newContext.addCookies(savedCookies);
      }
      if (Object.keys(this.extraHeaders).length > 0) {
        await newContext.setExtraHTTPHeaders(this.extraHeaders);
      }
    } catch (err) {
      await newContext.close().catch(() => {});
      throw err;
    }

    // Save all mutable state before swapping — needed for rollback
    const oldContext = this.context;
    const oldPages = new Map(this.pages);
    const oldActiveTabId = this.activeTabId;
    const oldNextTabId = this.nextTabId;
    const oldTabSnapshots = new Map(this.tabSnapshots);

    // Swap to new context
    this.context = newContext;
    this.pages.clear();
    this.nextTabId = 1;
    this.refMap.clear();

    // Recreate all tabs in new context, building old→new ID map for snapshot migration
    const idMap = new Map<number, number>(); // oldTabId → newTabId
    let activeRestoredId: number | null = null;
    try {
      for (const tab of tabUrls) {
        const url = tab.url !== 'about:blank' ? tab.url : undefined;
        const newId = await this.newTab(url);
        idMap.set(tab.id, newId);
        if (tab.active) {
          activeRestoredId = newId;
        }
      }

      if (tabUrls.length === 0) {
        await this.newTab();
      } else if (activeRestoredId !== null) {
        this.activeTabId = activeRestoredId;
      }
    } catch (err) {
      // Full rollback — restore all mutable state including snapshots
      for (const [, page] of this.pages) {
        await page.close().catch(() => {});
      }
      await newContext.close().catch(() => {});
      this.context = oldContext;
      this.pages = oldPages;
      this.activeTabId = oldActiveTabId;
      this.nextTabId = oldNextTabId;
      this.tabSnapshots = oldTabSnapshots;
      this.refMap.clear();
      throw err;
    }

    // Migrate tabSnapshots: remap old tab IDs to new tab IDs
    this.tabSnapshots.clear();
    for (const [oldId, snapshot] of oldTabSnapshots) {
      const newId = idMap.get(oldId);
      if (newId !== undefined) {
        this.tabSnapshots.set(newId, snapshot);
      }
    }

    // Success — close old pages and context
    for (const [, page] of oldPages) {
      await page.close().catch(() => {});
    }
    if (oldContext) {
      await oldContext.close().catch(() => {});
    }
  }

  async applyUserAgent(): Promise<void> {
    if (!this.customUserAgent) return;
    await this.recreateContext({
      viewport: this.currentDevice?.viewport || { width: 1920, height: 1080 },
      userAgent: this.customUserAgent,
      ...(this.currentDevice ? {
        deviceScaleFactor: this.currentDevice.deviceScaleFactor,
        isMobile: this.currentDevice.isMobile,
        hasTouch: this.currentDevice.hasTouch,
      } : {}),
    });
  }

  /**
   * Emulate a device — recreates context with full device settings.
   * Pass null to reset to desktop defaults.
   */
  async emulateDevice(device: DeviceDescriptor | null): Promise<void> {
    // Save state before mutation so we can rollback on failure
    const prevDevice = this.currentDevice;
    const prevUA = this.customUserAgent;

    this.currentDevice = device;
    if (device) {
      this.customUserAgent = device.userAgent;
      try {
        await this.recreateContext({
          viewport: device.viewport,
          userAgent: device.userAgent,
          deviceScaleFactor: device.deviceScaleFactor,
          isMobile: device.isMobile,
          hasTouch: device.hasTouch,
        });
      } catch (err) {
        // Rollback device/UA state on failure
        this.currentDevice = prevDevice;
        this.customUserAgent = prevUA;
        throw err;
      }
    } else {
      // Reset to desktop
      this.customUserAgent = null;
      try {
        await this.recreateContext({
          viewport: { width: 1920, height: 1080 },
        });
      } catch (err) {
        this.currentDevice = prevDevice;
        this.customUserAgent = prevUA;
        throw err;
      }
    }
  }

  getCurrentDevice(): DeviceDescriptor | null {
    return this.currentDevice;
  }

  /**
   * Reverse-lookup: find the tab ID that owns this page.
   * Returns undefined if the page isn't committed to any tab yet (during newTab).
   */
  private getTabIdForPage(page: Page): number | undefined {
    for (const [id, p] of this.pages) {
      if (p === page) return id;
    }
    return undefined;
  }

  // ─── Console/Network/Ref Wiring ────────────────────────────
  private wirePageEvents(page: Page) {
    // Clear ref map on navigation — but ONLY if this page belongs to the tab
    // that owns the current refs. Otherwise, navigating tab B clears tab A's refs.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const tabId = this.getTabIdForPage(page);
        if (tabId !== undefined && tabId === this.refTabId) {
          this.clearRefs();
        }
      }
    });

    page.on('dialog', async (dialog) => {
      this.lastDialog = {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue() || undefined,
      };
      addConsoleEntry({
        timestamp: Date.now(),
        level: 'info',
        text: `[dialog] ${dialog.type()}: ${dialog.message()}`,
      });
      if (this.autoDialogAction === 'accept') {
        // Use user-supplied prompt value if set, otherwise fall back to browser default
        await dialog.accept(this.dialogPromptValue ?? dialog.defaultValue());
      } else {
        await dialog.dismiss();
      }
    });

    page.on('console', (msg) => {
      addConsoleEntry({
        timestamp: Date.now(),
        level: msg.type(),
        text: msg.text(),
      });
    });

    page.on('request', (req) => {
      const entry: NetworkEntry = {
        timestamp: Date.now(),
        method: req.method(),
        url: req.url(),
      };
      addNetworkEntry(entry);
      // Store direct reference for accurate correlation on duplicate URLs
      this.requestEntryMap.set(req, entry);
    });

    page.on('response', (res) => {
      const entry = this.requestEntryMap.get(res.request());
      if (entry) {
        entry.status = res.status();
        entry.duration = Date.now() - entry.timestamp;
      }
    });

    // Capture response sizes via Content-Length header (avoids reading full body into memory)
    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (res) {
          const entry = this.requestEntryMap.get(req);
          if (entry) {
            const cl = res.headers()['content-length'];
            entry.size = cl ? parseInt(cl, 10) : 0;
          }
        }
      } catch {}
    });
  }
}
