/**
 * Browser lifecycle manager
 *
 * Chromium crash handling:
 *   browser.on('disconnected') → log error → process.exit(1)
 *   CLI detects dead server → auto-restarts on next command
 *   We do NOT try to self-heal — don't hide failure.
 */

import { chromium, devices as playwrightDevices, type Browser, type BrowserContext, type Page, type Locator, type Frame, type FrameLocator, type Request as PlaywrightRequest } from 'playwright';
import { SessionBuffers, type LogEntry, type NetworkEntry } from './buffers';
import type { HarRecording } from './har';
import type { DomainFilter } from './domain-filter';

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

  // ─── iframe targeting ─────────────────────────────────────
  private activeFramePerTab: Map<number, string> = new Map();

  // ─── Per-session buffers ──────────────────────────────────
  private buffers: SessionBuffers;

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

  // ─── Offline Mode ─────────────────────────────────────────
  private offline = false;

  // ─── HAR Recording ────────────────────────────────────────
  private harRecording: HarRecording | null = null;

  // ─── Video Recording ────────────────────────────────────────
  private videoRecording: { dir: string; startedAt: number } | null = null;

  // ─── Init Script (domain filter JS injection) ─────────────
  private initScript: string | null = null;

  // ─── User Routes (survive context recreation) ─────────────
  private userRoutes: Array<{pattern: string; action: 'block' | 'fulfill'; status?: number; body?: string}> = [];

  // ─── Domain Filter (survive context recreation) ───────────
  private domainFilter: DomainFilter | null = null;

  // Whether this instance owns (and should close) the Browser process
  private ownsBrowser = false;

  constructor(buffers?: SessionBuffers) {
    this.buffers = buffers || new SessionBuffers();
  }

  getBuffers(): SessionBuffers {
    return this.buffers;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  getContext(): BrowserContext | null {
    return this.context;
  }

  /**
   * Launch a new Chromium browser (single-session / multi-process mode).
   * This instance owns the browser and will close it on close().
   */
  async launch(onCrash?: () => void) {
    this.browser = await chromium.launch({ headless: true });
    this.ownsBrowser = true;

    // Chromium crash → notify caller (server uses this to exit; tests ignore it)
    this.browser.on('disconnected', () => {
      if (onCrash) onCrash();
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
    });

    // Create first tab
    await this.newTab();
  }

  /**
   * Attach to an existing Browser instance (session multiplexing mode).
   * Creates a new BrowserContext on the shared browser.
   * This instance does NOT own the browser — close() only closes the context.
   */
  async launchWithBrowser(browser: Browser) {
    this.browser = browser;
    this.ownsBrowser = false;

    this.context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
    });

    // Create first tab
    await this.newTab();
  }

  async close() {
    // Close all pages first
    for (const [, page] of this.pages) {
      await page.close().catch(() => {});
    }
    this.pages.clear();
    this.tabSnapshots.clear();
    this.refMap.clear();

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }

    if (this.ownsBrowser && this.browser) {
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

  getPageById(id: number): Page | undefined {
    return this.pages.get(id);
  }

  getCurrentUrl(): string {
    try {
      return this.getPage().url();
    } catch {
      return 'about:blank';
    }
  }

  // ─── iframe Targeting ──────────────────────────────────────
  /**
   * Set the active frame by CSS selector (e.g., '#my-iframe', 'iframe[name="content"]').
   * Subsequent commands that use resolveRef, getLocatorRoot, or getFrameContext
   * will target this frame's content instead of the main page.
   */
  setFrame(selector: string) {
    this.activeFramePerTab.set(this.activeTabId, selector);
  }

  /**
   * Reset to main frame — clears the active frame selector for the current tab.
   */
  resetFrame() {
    this.activeFramePerTab.delete(this.activeTabId);
  }

  /**
   * Get the current active frame selector, or null if targeting main page.
   */
  getActiveFrameSelector(): string | null {
    return this.activeFramePerTab.get(this.activeTabId) ?? null;
  }

  /**
   * Get a FrameLocator for the active frame.
   * Returns null if no frame is active (targeting main page).
   */
  getFrameLocator(): FrameLocator | null {
    const sel = this.getActiveFrameSelector();
    if (!sel) return null;
    return this.getPage().frameLocator(sel);
  }

  /**
   * Get the Frame object for the active frame (needed for evaluate() calls).
   * Returns null if no frame is active.
   * Unlike FrameLocator, Frame supports evaluate(), querySelector, etc.
   */
  async getFrameContext(): Promise<Frame | null> {
    const sel = this.getActiveFrameSelector();
    if (!sel) return null;
    const page = this.getPage();
    const frameEl = page.locator(sel);
    const handle = await frameEl.elementHandle({ timeout: 5000 });
    if (!handle) throw new Error(`Frame element not found: ${sel}`);
    const frame = await handle.contentFrame();
    if (!frame) throw new Error(`Cannot access content of frame: ${sel}`);
    return frame;
  }

  /**
   * Get a locator root scoped to the active frame (if any) or the page.
   * Use this to create locators that respect the current frame context.
   * Example: bm.getLocatorRoot().locator('button.submit')
   */
  getLocatorRoot(): Page | FrameLocator {
    const sel = this.getActiveFrameSelector();
    if (sel) {
      return this.getPage().frameLocator(sel);
    }
    return this.getPage();
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
   *
   * When a frame is active and a CSS selector is passed, returns { locator }
   * scoped to the frame instead of { selector }, so callers automatically
   * interact with elements inside the iframe.
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
    // When a frame is active, scope CSS selectors through the frame
    const frameSel = this.getActiveFrameSelector();
    if (frameSel) {
      const frame = this.getPage().frameLocator(frameSel);
      return { locator: frame.locator(selector) };
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

    // Auto-inject recordVideo when video recording is active (so emulateDevice/applyUserAgent pass it through)
    if (this.videoRecording && !contextOptions.recordVideo) {
      contextOptions = {
        ...contextOptions,
        recordVideo: {
          dir: this.videoRecording.dir,
          size: contextOptions.viewport || this.currentDevice?.viewport || { width: 1920, height: 1080 },
        },
      };
    }

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
      if (this.offline) {
        await newContext.setOffline(true);
      }
      if (this.initScript) {
        await newContext.addInitScript(this.initScript);
      }
      // Re-apply user routes FIRST
      for (const r of this.userRoutes) {
        if (r.action === 'block') {
          await newContext.route(r.pattern, (route) => route.abort('blockedbyclient'));
        } else {
          await newContext.route(r.pattern, (route) => route.fulfill({ status: r.status || 200, body: r.body || '', contentType: 'text/plain' }));
        }
      }
      // Re-apply domain filter route LAST (Playwright: last registered = checked first)
      if (this.domainFilter) {
        const df = this.domainFilter;
        await newContext.route('**/*', (route) => {
          const url = route.request().url();
          if (df.isAllowed(url)) { route.fallback(); } else { route.abort('blockedbyclient'); }
        });
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
    const oldRefMap = new Map(this.refMap);
    const oldFramePerTab = new Map(this.activeFramePerTab);

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
      this.refMap = oldRefMap;
      this.activeFramePerTab = oldFramePerTab;
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

    // Migrate activeFramePerTab: remap old tab IDs to new tab IDs
    const oldFrames = new Map(this.activeFramePerTab);
    this.activeFramePerTab.clear();
    for (const [oldId, sel] of oldFrames) {
      const newId = idMap.get(oldId);
      if (newId !== undefined) {
        this.activeFramePerTab.set(newId, sel);
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

  // ─── Offline Mode ──────────────────────────────────────────
  isOffline(): boolean {
    return this.offline;
  }

  async setOffline(value: boolean): Promise<void> {
    this.offline = value;
    if (this.context) {
      await this.context.setOffline(value);
    }
  }

  // ─── HAR Recording ────────────────────────────────────────
  startHarRecording(): void {
    this.harRecording = { startTime: Date.now(), active: true };
  }

  stopHarRecording(): HarRecording | null {
    const recording = this.harRecording;
    this.harRecording = null;
    return recording;
  }

  getHarRecording(): HarRecording | null {
    return this.harRecording;
  }

  // ─── Video Recording ──────────────────────────────────────

  async startVideoRecording(dir: string): Promise<void> {
    if (this.videoRecording) throw new Error('Video recording already active');
    const fs = await import('fs');
    fs.mkdirSync(dir, { recursive: true });

    this.videoRecording = { dir, startedAt: Date.now() };
    const viewport = this.currentDevice?.viewport || { width: 1920, height: 1080 };
    await this.recreateContext({
      viewport,
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
      ...(this.currentDevice ? {
        deviceScaleFactor: this.currentDevice.deviceScaleFactor,
        isMobile: this.currentDevice.isMobile,
        hasTouch: this.currentDevice.hasTouch,
      } : {}),
      recordVideo: { dir, size: viewport },
    });
  }

  async stopVideoRecording(): Promise<{ dir: string; startedAt: number; paths: string[] } | null> {
    if (!this.videoRecording) return null;

    const recording = this.videoRecording;
    // Collect video objects before pages are closed by recreateContext
    const videos: Array<{ video: any; tabId: number }> = [];
    for (const [id, page] of this.pages) {
      const video = page.video();
      if (video) videos.push({ video, tabId: id });
    }

    // Clear state BEFORE recreateContext so auto-injection doesn't add recordVideo
    this.videoRecording = null;

    const viewport = this.currentDevice?.viewport || { width: 1920, height: 1080 };
    await this.recreateContext({
      viewport,
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
      ...(this.currentDevice ? {
        deviceScaleFactor: this.currentDevice.deviceScaleFactor,
        isMobile: this.currentDevice.isMobile,
        hasTouch: this.currentDevice.hasTouch,
      } : {}),
    });

    // Save videos with predictable names (saveAs works for both local and remote CDP)
    const paths: string[] = [];
    for (const { video, tabId } of videos) {
      const target = `${recording.dir}/tab-${tabId}.webm`;
      await video.saveAs(target);
      paths.push(target);
    }

    return { dir: recording.dir, startedAt: recording.startedAt, paths };
  }

  getVideoRecording(): { dir: string; startedAt: number } | null {
    return this.videoRecording;
  }

  // ─── Init Script ───────────────────────────────────────────
  setInitScript(script: string): void {
    this.initScript = script;
  }

  getInitScript(): string | null {
    return this.initScript;
  }

  // ─── User Routes ──────────────────────────────────────────
  addUserRoute(pattern: string, action: 'block' | 'fulfill', status?: number, body?: string) {
    this.userRoutes.push({pattern, action, status, body});
  }

  clearUserRoutes() {
    this.userRoutes = [];
  }

  getUserRoutes() {
    return this.userRoutes;
  }

  // ─── Domain Filter ────────────────────────────────────────
  setDomainFilter(filter: DomainFilter) {
    this.domainFilter = filter;
  }

  getDomainFilter(): DomainFilter | null {
    return this.domainFilter;
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
      this.buffers.addConsoleEntry({
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
      this.buffers.addConsoleEntry({
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
      this.buffers.addNetworkEntry(entry);
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
