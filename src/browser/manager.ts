/**
 * Browser lifecycle manager
 *
 * Chromium crash handling:
 *   browser.on('disconnected') → log error → process.exit(1)
 *   CLI detects dead server → auto-restarts on next command
 *   We do NOT try to self-heal — don't hide failure.
 */

import { chromium, type Browser, type BrowserContext, type BrowserType, type Page, type Locator, type Frame, type FrameLocator, type Request as PlaywrightRequest } from 'playwright';
import { SessionBuffers, type NetworkEntry } from '../network/buffers';
import type { HarRecording } from '../network/har';
import type { DomainFilter } from '../security/domain-filter';
import type { TargetCapabilities } from '../automation/target';
import type { BrowserTarget } from './target';
import { TabManager } from './tabs';
import { RefManager } from './refs';
import {
  resolveDevice,
  listDevices,
  type DeviceDescriptor,
} from './emulation';
import { getProfileDir, listProfiles, deleteProfile } from './profiles';

/**
 * Polyfill for esbuild/tsx keepNames helper.
 *
 * tsx (esbuild under the hood) wraps every named function-like binding with
 * `__name(fn, "name")`.  When those bindings appear inside page.evaluate()
 * callbacks the code is serialised and executed in the browser context where
 * `__name` does not exist, causing a ReferenceError.
 *
 * Injecting this no-op via context.addInitScript() before any evaluate() call
 * makes the helper available globally in the page.
 */
const ESBUILD_KEEPNAMES_POLYFILL =
  'if(typeof globalThis.__name==="undefined"){globalThis.__name=function(fn){return fn};}';

/**
 * DOM mutation tracking script.
 *
 * Installs a MutationObserver that records when the DOM last changed.
 * `window.__browseMutationAge` returns the milliseconds since the last observed
 * DOM mutation, or Infinity when no mutations have been observed on this page.
 *
 * Resets automatically on each page load because addInitScript() re-runs
 * on every navigation — no explicit reset needed.
 *
 * Keyed on `globalThis` so that the polyfill guard avoids double-registration
 * when addInitScript() is called multiple times on the same context.
 */
const MUTATION_OBSERVER_SCRIPT = `
(function() {
  if (typeof globalThis.__browseMutationTime !== 'undefined') return;
  globalThis.__browseMutationTime = null;
  var observer = new MutationObserver(function() {
    globalThis.__browseMutationTime = Date.now();
  });
  observer.observe(document.documentElement || document, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
  Object.defineProperty(globalThis, '__browseMutationAge', {
    get: function() {
      return globalThis.__browseMutationTime === null
        ? Infinity
        : (Date.now() - globalThis.__browseMutationTime);
    },
    configurable: true,
  });
})();
`;

// DeviceDescriptor, DEVICE_ALIASES, CUSTOM_DEVICES, resolveDevice, listDevices
// are defined in ./emulation and re-exported from there + from this file below.

export type { DeviceDescriptor };
export { resolveDevice, listDevices, getProfileDir, listProfiles, deleteProfile };

export interface CoverageEntry {
  url: string;
  totalBytes: number;
  usedBytes: number;
  unusedBytes: number;
  unusedPct: number;
}

export class BrowserManager implements BrowserTarget {
  readonly targetType = 'browser';
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private extraHeaders: Record<string, string> = {};
  private customUserAgent: string | null = null;
  private currentDevice: DeviceDescriptor | null = null;

  // ─── Tab management collaborator ──────────────────────────
  private tabs: TabManager = new TabManager();

  // ─── Ref / snapshot collaborator ──────────────────────────
  private refs: RefManager = new RefManager();

  // ─── iframe targeting ─────────────────────────────────────
  private activeFramePerTab: Map<number, string> = new Map();

  // ─── Per-session buffers ──────────────────────────────────
  private buffers: SessionBuffers;

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

  // ─── Coverage ──────────────────────────────────────────────
  private coverageActive: boolean = false;

  // ─── Network body capture ─────────────────────────────
  private captureNetworkBodies: boolean = false;
  /** Per-session byte budget for captured response bodies (default 5MB) */
  private bodyBudgetBytes = 5 * 1024 * 1024;
  private bodyBudgetUsed = 0;
  /** Per-entry body size limit (default 256KB) */
  private bodyLimitBytes = parseInt(process.env.BROWSE_NETWORK_BODY_LIMIT || '262144', 10);

  // ─── Init Script (domain filter JS injection) ─────────────
  private initScript: string | null = null;

  // ─── User Routes (survive context recreation) ─────────────
  private userRoutes: Array<{pattern: string; action: 'block' | 'fulfill'; status?: number; body?: string}> = [];

  // ─── Domain Filter (survive context recreation) ───────────
  private domainFilter: DomainFilter | null = null;

  // Whether this instance owns (and should close) the Browser process
  private ownsBrowser = false;

  // Whether this instance uses a persistent browser context (profile mode)
  private isPersistent = false;

  // ─── Handoff state ──────────────────────────────────────
  private isHeaded = false;
  private consecutiveFailures = 0;
  private onCrashCallback: (() => void) | undefined;

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
    this.onCrashCallback = onCrash;

    // Chromium crash → notify caller (server uses this to exit; tests ignore it)
    this.browser.on('disconnected', () => {
      if (onCrash) onCrash();
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
    });
    await this.context.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
    await this.context.addInitScript(MUTATION_OBSERVER_SCRIPT);

    // Create first tab
    await this.newTab();
  }

  /**
   * Attach to an existing Browser instance (session multiplexing mode).
   * Creates a new BrowserContext on the shared browser.
   * This instance does NOT own the browser — close() only closes the context.
   */
  async launchWithBrowser(browser: Browser, reuseContext = false) {
    this.browser = browser;
    this.ownsBrowser = false;

    if (reuseContext) {
      // CDP-connected Chrome: use the existing default context (has user's cookies, extensions)
      const contexts = browser.contexts();
      this.context = contexts[0] || await browser.newContext({
        viewport: { width: 1920, height: 1080 },
      });
      await this.context.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
      await this.context.addInitScript(MUTATION_OBSERVER_SCRIPT);
      // Register existing pages
      const pages = this.context.pages();
      if (pages.length > 0) {
        for (const page of pages) {
          this.tabs.registerPage(page, (p) => this.wirePageEvents(p));
        }
        return; // Already have tabs, don't create a new one
      }
    } else {
      this.context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
      });
      await this.context.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
      await this.context.addInitScript(MUTATION_OBSERVER_SCRIPT);
    }

    // Create first tab
    await this.newTab();
  }

  /**
   * Launch with a persistent browser profile directory.
   * Data (cookies, localStorage, cache) persists across restarts.
   * The context IS the browser — closing it closes everything.
   */
  async launchPersistent(profileDir: string, onCrash?: () => void, browserType?: BrowserType, extraLaunchOptions?: Record<string, unknown>) {
    const launcher = browserType ?? chromium;
    // Merge runtime-specific launch options (e.g. camoufox args/env/firefoxUserPrefs)
    const runtimeOpts = extraLaunchOptions ?? {};
    const baseOpts = {
      ...runtimeOpts,
      headless: process.env.BROWSE_HEADED !== '1',
      viewport: { width: 1920, height: 1080 },
      ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
      // Concatenate args arrays from both sources
      args: [...(Array.isArray(runtimeOpts.args) ? runtimeOpts.args as string[] : [])],
      // Merge env objects (ours take precedence)
      ...(runtimeOpts.env ? { env: { ...(runtimeOpts.env as Record<string, string>) } } : {}),
    };
    let context: BrowserContext;
    try {
      context = await launcher.launchPersistentContext(profileDir, baseOpts);
    } catch (err: any) {
      // Profile might be corrupted — delete and retry once
      if (err.message?.includes('Failed to launch') || err.message?.includes('Target closed')) {
        const fs = await import('fs');
        console.error(`[browse] Profile directory corrupted, recreating: ${profileDir}`);
        fs.rmSync(profileDir, { recursive: true, force: true });
        context = await launcher.launchPersistentContext(profileDir, baseOpts);
      } else {
        throw err;
      }
    }

    this.context = context;
    this.browser = context.browser();
    this.isPersistent = true;
    this.ownsBrowser = true;
    await this.context.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
    await this.context.addInitScript(MUTATION_OBSERVER_SCRIPT);

    // Crash handler
    if (this.browser) {
      this.browser.on('disconnected', () => {
        if (onCrash) onCrash();
      });
    }

    // Register existing pages as tabs, or create first tab
    const pages = context.pages();
    if (pages.length > 0) {
      for (const page of pages) {
        this.tabs.registerPage(page, (p) => this.wirePageEvents(p));
      }
    } else {
      await this.newTab();
    }
  }

  async close() {
    // Persistent contexts: closing the context closes browser + all pages
    if (this.isPersistent) {
      this.tabs.clearPages();
      this.refs.clearSnapshots();
      this.refs.clearRefs();
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
        this.browser = null;
      }
      return;
    }

    // Close all pages first
    for (const [, page] of this.tabs.getPages()) {
      await page.close().catch(() => {});
    }
    this.tabs.clearPages();
    this.refs.clearSnapshots();
    this.refs.clearRefs();

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

  // ─── AutomationTarget implementation ─────────────────────

  getCapabilities(): TargetCapabilities {
    return {
      navigation: true,
      tabs: true,
      refs: true,
      screenshots: true,
      javascript: true,
      deviceEmulation: true,
      frames: true,
    };
  }

  getCurrentLocation(): string {
    return this.getCurrentUrl();
  }

  isReady(): boolean {
    return this.isHealthy() && this.context !== null;
  }

  getIsPersistent(): boolean {
    return this.isPersistent;
  }

  // ─── React DevTools ──────────────────────────────────
  private reactDevToolsEnabled = false;

  getReactDevToolsEnabled(): boolean {
    return this.reactDevToolsEnabled;
  }

  setReactDevToolsEnabled(enabled: boolean): void {
    this.reactDevToolsEnabled = enabled;
  }

  getIsHeaded(): boolean {
    return this.isHeaded;
  }

  // ─── Failure tracking (auto-suggest handoff) ────────────
  incrementFailures(): void {
    this.consecutiveFailures++;
  }

  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  getFailureHint(): string | null {
    if (this.consecutiveFailures >= 3 && !this.isHeaded) {
      return `HINT: ${this.consecutiveFailures} consecutive failures. Consider using 'handoff' to let the user help.`;
    }
    return null;
  }

  // ─── State save/restore (shared by handoff/resume) ──────
  private async saveState(): Promise<{ cookies: any[]; pages: Array<{ url: string; isActive: boolean; storage: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null }> }> {
    if (!this.context) throw new Error('Browser not launched');

    const cookies = await this.context.cookies();
    const pages: Array<{ url: string; isActive: boolean; storage: any }> = [];

    for (const [id, page] of this.tabs.getPages()) {
      const url = page.url();
      let storage = null;
      try {
        storage = await page.evaluate(() => ({
          localStorage: { ...localStorage },
          sessionStorage: { ...sessionStorage },
        }));
      } catch {}
      pages.push({
        url: url === 'about:blank' ? '' : url,
        isActive: id === this.tabs.activeTabId,
        storage,
      });
    }

    return { cookies, pages };
  }

  private async applyContextOptions(context: BrowserContext): Promise<void> {
    await context.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
    await context.addInitScript(MUTATION_OBSERVER_SCRIPT);
    if (Object.keys(this.extraHeaders).length > 0) {
      await context.setExtraHTTPHeaders(this.extraHeaders);
    }
    if (this.offline) {
      await context.setOffline(true);
    }
    if (this.initScript) {
      await context.addInitScript(this.initScript);
    }
    for (const r of this.userRoutes) {
      if (r.action === 'block') {
        await context.route(r.pattern, (route) => route.abort('blockedbyclient'));
      } else {
        await context.route(r.pattern, (route) => route.fulfill({ status: r.status || 200, body: r.body || '', contentType: 'text/plain' }));
      }
    }
    if (this.domainFilter) {
      const df = this.domainFilter;
      await context.route('**/*', (route) => {
        const url = route.request().url();
        if (df.isAllowed(url)) { route.fallback(); } else { route.abort('blockedbyclient'); }
      });
    }
  }

  private async restoreState(state: { cookies: any[]; pages: Array<{ url: string; isActive: boolean; storage: any }> }): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');

    if (state.cookies.length > 0) {
      await this.context.addCookies(state.cookies);
    }

    await this.applyContextOptions(this.context);

    let activeId: number | null = null;
    for (const saved of state.pages) {
      const id = await this.tabs.newTab(this.context, (p) => this.wirePageEvents(p));

      const page = this.tabs.getPageById(id)!;
      if (saved.url) {
        await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }

      if (saved.storage) {
        try {
          await page.evaluate((s: { localStorage: Record<string, string>; sessionStorage: Record<string, string> }) => {
            if (s.localStorage) {
              for (const [k, v] of Object.entries(s.localStorage)) localStorage.setItem(k, v);
            }
            if (s.sessionStorage) {
              for (const [k, v] of Object.entries(s.sessionStorage)) sessionStorage.setItem(k, v);
            }
          }, saved.storage);
        } catch {}
      }

      if (saved.isActive) activeId = id;
    }

    if (this.tabs.getTabCount() === 0) {
      await this.newTab();
    } else if (activeId !== null) {
      this.tabs.activeTabId = activeId;
    }

    this.clearRefs();
  }

  // ─── Handoff: headless ↔ headed swap ─────────────────────
  private handoffCleanup: (() => Promise<void>) | null = null;

  async handoff(message: string, useChromium = false): Promise<string> {
    if (this.isHeaded) {
      return `Already in headed mode at ${this.getCurrentUrl()}`;
    }
    if (this.isPersistent) {
      throw new Error('Handoff not supported in profile mode — the browser is already visible. Use cookie-import or auth login instead.');
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    const state = await this.saveState();
    const currentUrl = this.getCurrentUrl();

    // Try Chrome first (bypasses bot detection), fall back to Playwright Chromium
    let newBrowser: Browser;
    let cleanup: (() => Promise<void>) | null = null;
    let usingChrome = false;

    if (!useChromium) {
      try {
        const { launchChrome } = await import('../engine/chrome');
        const result = await launchChrome();
        newBrowser = result.browser;
        cleanup = result.close;
        usingChrome = true;
      } catch {
        // Chrome not available — fall back to Chromium
        try {
          newBrowser = await chromium.launch({ headless: false, timeout: 15000 });
        } catch (err: any) {
          return `Cannot open browser — ${err.message}. Headless browser still running.`;
        }
      }
    } else {
      try {
        newBrowser = await chromium.launch({ headless: false, timeout: 15000 });
      } catch (err: any) {
        return `Cannot open headed browser — ${err.message}. Headless browser still running.`;
      }
    }

    try {
      const newContext = await newBrowser.newContext({
        viewport: this.currentDevice?.viewport || { width: 1920, height: 1080 },
        ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
        ...(this.currentDevice ? {
          deviceScaleFactor: this.currentDevice.deviceScaleFactor,
          isMobile: this.currentDevice.isMobile,
          hasTouch: this.currentDevice.hasTouch,
        } : {}),
      });

      // Swap browser/context — keep old browser alive (server owns it, other sessions may use it)
      const oldContext = this.context;
      this.browser = newBrowser;
      this.context = newContext;
      this.tabs.reset();
      this.refs.clearSnapshots();
      this.activeFramePerTab.clear();
      this.handoffCleanup = cleanup;

      // Crash handler on new browser
      const onCrash = this.onCrashCallback;
      this.browser.on('disconnected', () => {
        if (onCrash) onCrash();
      });

      await this.restoreState(state);
      this.isHeaded = true;
      this.ownsBrowser = true;

      // Close old context only — don't close the browser (server owns it)
      if (oldContext) {
        await oldContext.close().catch(() => {});
      }

      const browserType = usingChrome ? 'Chrome' : 'Chromium';
      return [
        `Handoff active — ${browserType} opened in visible mode.`,
        `Reason: ${message || 'manual intervention needed'}`,
        `URL: ${currentUrl}`,
        ``,
        `The user can now interact with the visible browser.`,
        `When done, run: browse resume`,
      ].join('\n');
    } catch (err: any) {
      // Restore failed — close new browser, keep old
      if (cleanup) await cleanup().catch(() => {});
      else await newBrowser!.close().catch(() => {});
      return `Handoff failed during state restore — ${err.message}. Headless browser still running.`;
    }
  }

  async resume(): Promise<string> {
    if (!this.isHeaded) {
      throw new Error('Not in handoff mode — run "handoff" first.');
    }
    if (!this.browser || !this.context) {
      throw new Error('Browser not launched');
    }

    const state = await this.saveState();
    const userUrl = this.getCurrentUrl();

    // Launch headless browser — if fails, headed stays
    let newBrowser: Browser;
    try {
      newBrowser = await chromium.launch({ headless: true });
    } catch (err: any) {
      return `Cannot launch headless browser — ${err.message}. Headed browser still running.`;
    }

    try {
      const newContext = await newBrowser.newContext({
        viewport: this.currentDevice?.viewport || { width: 1920, height: 1080 },
        ...(this.customUserAgent ? { userAgent: this.customUserAgent } : {}),
        ...(this.currentDevice ? {
          deviceScaleFactor: this.currentDevice.deviceScaleFactor,
          isMobile: this.currentDevice.isMobile,
          hasTouch: this.currentDevice.hasTouch,
        } : {}),
      });

      const oldBrowser = this.browser;
      this.browser = newBrowser;
      this.context = newContext;
      this.tabs.reset();
      this.refs.clearSnapshots();
      this.activeFramePerTab.clear();

      const onCrash = this.onCrashCallback;
      this.browser.on('disconnected', () => {
        if (onCrash) onCrash();
      });

      await this.restoreState(state);
      this.isHeaded = false;
      this.consecutiveFailures = 0;

      oldBrowser.removeAllListeners('disconnected');
      oldBrowser.close().catch(() => {});

      // Clean up Chrome process if handoff spawned one
      if (this.handoffCleanup) {
        await this.handoffCleanup().catch(() => {});
        this.handoffCleanup = null;
      }

      return userUrl;
    } catch (err: any) {
      await newBrowser.close().catch(() => {});
      return `Resume failed during state restore — ${err.message}. Headed browser still running.`;
    }
  }

  // ─── Tab Management ────────────────────────────────────────
  async newTab(url?: string): Promise<number> {
    if (!this.context) throw new Error('Browser not launched');
    return this.tabs.newTab(this.context, (p) => this.wirePageEvents(p), url);
  }

  async closeTab(id?: number): Promise<void> {
    if (!this.context) throw new Error('Browser not launched');
    const tabId = await this.tabs.closeTab(this.context, (p) => this.wirePageEvents(p), id);
    this.refs.deleteSnapshot(tabId);
  }

  switchTab(id: number): void {
    this.tabs.switchTab(id);
  }

  getActiveTabId(): number {
    return this.tabs.getActiveTabId();
  }

  hasTab(id: number): boolean {
    return this.tabs.hasTab(id);
  }

  getTabCount(): number {
    return this.tabs.getTabCount();
  }

  getTabList(): Array<{ id: number; url: string; title: string; active: boolean }> {
    return this.tabs.getTabList();
  }

  async getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>> {
    return this.tabs.getTabListWithTitles();
  }

  // ─── Page Access ───────────────────────────────────────────
  getPage(): Page {
    return this.tabs.getPage();
  }

  getPageById(id: number): Page | undefined {
    return this.tabs.getPageById(id);
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
    this.activeFramePerTab.set(this.tabs.activeTabId, selector);
  }

  /**
   * Reset to main frame — clears the active frame selector for the current tab.
   */
  resetFrame() {
    this.activeFramePerTab.delete(this.tabs.activeTabId);
  }

  /**
   * Get the current active frame selector, or null if targeting main page.
   */
  getActiveFrameSelector(): string | null {
    return this.activeFramePerTab.get(this.tabs.activeTabId) ?? null;
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
    this.refs.setRefMap(refs, this.tabs.activeTabId);
  }

  clearRefs() {
    this.refs.clearRefs();
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
    // When a frame is active, pass a frame-scoped locator for CSS selectors
    let frameScopedLocator: Locator | null = null;
    if (!selector.startsWith('@e')) {
      const frameSel = this.getActiveFrameSelector();
      if (frameSel) {
        const frame = this.getPage().frameLocator(frameSel);
        frameScopedLocator = frame.locator(selector);
      }
    }
    return this.refs.resolveRef(selector, this.tabs.activeTabId, frameScopedLocator);
  }

  /**
   * Resolve a ref with staleness detection. Throws immediately if the ref's
   * element no longer exists in the DOM, instead of waiting for action timeout.
   */
  async resolveRefChecked(selector: string): Promise<{ locator: Locator } | { selector: string }> {
    const resolved = this.resolveRef(selector);
    if ('locator' in resolved) {
      const count = await resolved.locator.count();
      if (count === 0) {
        throw new Error(
          `Ref ${selector} is stale (element no longer exists). Re-run 'snapshot' to get fresh refs.`
        );
      }
    }
    return resolved;
  }

  getRefCount(): number {
    return this.refs.getRefCount();
  }

  getRefMap(): Map<string, Locator> {
    return this.refs.getRefMap();
  }

  /**
   * Check if refs are valid for the currently active tab.
   * Used by screenshot --annotate to avoid cross-tab ref leaks.
   */
  areRefsValidForActiveTab(): boolean {
    return this.refs.areRefsValidForActiveTab(this.tabs.activeTabId);
  }

  setLastSnapshot(text: string, opts?: string[]) {
    this.refs.setLastSnapshot(text, this.tabs.activeTabId, opts);
  }

  getLastSnapshot(): string | null {
    return this.refs.getLastSnapshot(this.tabs.activeTabId);
  }

  getLastSnapshotOpts(): string[] {
    return this.refs.getLastSnapshotOpts(this.tabs.activeTabId);
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
    if (this.isPersistent) {
      throw new Error(
        'Cannot change device/viewport/user-agent in profile mode — profiles use a fixed browser context. Use --session instead.'
      );
    }
    if (!this.browser) return;

    // Coverage cannot survive context recreation — reset the flag
    this.coverageActive = false;

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
    const tabUrls = this.tabs.snapshotTabUrls();

    // Save cookies from old context
    const savedCookies = this.context ? await this.context.cookies() : [];

    // Create new context FIRST — if this fails, old session is untouched
    const newContext = await this.browser.newContext(contextOptions);

    // Restore cookies and headers into new context before creating tabs
    try {
      await newContext.addInitScript(ESBUILD_KEEPNAMES_POLYFILL);
      await newContext.addInitScript(MUTATION_OBSERVER_SCRIPT);
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
    const oldPages = new Map(this.tabs.getPages());
    const oldActiveTabId = this.tabs.activeTabId;
    const oldTabSnapshots = this.refs.snapshotState();
    const oldRefMap = this.refs.snapshotRefMap();
    const oldFramePerTab = new Map(this.activeFramePerTab);

    // Swap to new context; reset tabs (nextTabId=1) and clear refs
    this.context = newContext;
    this.tabs.reset();
    this.refs.clearRefs();

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
        this.tabs.activeTabId = activeRestoredId;
      }
    } catch (err) {
      // Full rollback — restore all mutable state including snapshots
      for (const [, page] of this.tabs.getPages()) {
        await page.close().catch(() => {});
      }
      await newContext.close().catch(() => {});
      this.context = oldContext;
      this.tabs.reset();
      for (const [id, page] of oldPages) {
        this.tabs.getPages().set(id, page);
      }
      this.tabs.activeTabId = oldActiveTabId;
      this.refs.restoreState(oldTabSnapshots);
      this.refs.restoreRefMap(oldRefMap);
      this.activeFramePerTab = oldFramePerTab;
      throw err;
    }

    // Migrate tabSnapshots: remap old tab IDs to new tab IDs
    this.refs.migrateSnapshots(idMap);

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
    for (const [id, page] of this.tabs.getPages()) {
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

  // ─── Coverage ──────────────────────────────────────────────

  async startCoverage(): Promise<void> {
    if (this.coverageActive) {
      throw new Error('Coverage already active. Stop current coverage first.');
    }
    const page = this.getPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    this.coverageActive = true;
  }

  async stopCoverage(): Promise<{ js: CoverageEntry[]; css: CoverageEntry[] }> {
    if (!this.coverageActive) {
      throw new Error("Coverage not started. Run 'browse coverage start' first.");
    }
    const page = this.getPage();
    const [jsCov, cssCov] = await Promise.all([
      page.coverage.stopJSCoverage(),
      page.coverage.stopCSSCoverage(),
    ]);
    this.coverageActive = false;

    return {
      js: this.processJSCoverage(jsCov),
      css: this.processCSSCoverage(cssCov),
    };
  }

  isCoverageActive(): boolean {
    return this.coverageActive;
  }

  private processJSCoverage(entries: Array<{ url: string; source?: string; functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> }>): CoverageEntry[] {
    return entries
      .filter(e => e.url && !e.url.startsWith('data:'))
      .map(entry => {
        const totalBytes = entry.source?.length ?? 0;
        // Calculate used bytes by summing ranges with count > 0
        let usedBytes = 0;
        for (const fn of entry.functions) {
          for (const range of fn.ranges) {
            if (range.count > 0) {
              usedBytes += range.endOffset - range.startOffset;
            }
          }
        }
        // Clamp usedBytes to totalBytes (overlapping ranges can exceed total)
        if (usedBytes > totalBytes) usedBytes = totalBytes;
        const unusedBytes = totalBytes - usedBytes;
        const unusedPct = totalBytes > 0 ? Math.round((unusedBytes / totalBytes) * 1000) / 10 : 0;
        return { url: entry.url, totalBytes, usedBytes, unusedBytes, unusedPct };
      });
  }

  private processCSSCoverage(entries: Array<{ url: string; text?: string; ranges: Array<{ start: number; end: number }> }>): CoverageEntry[] {
    return entries
      .filter(e => e.url && !e.url.startsWith('data:'))
      .map(entry => {
        const totalBytes = entry.text?.length ?? 0;
        // Calculate used bytes by summing all range lengths
        let usedBytes = 0;
        for (const range of entry.ranges) {
          usedBytes += range.end - range.start;
        }
        if (usedBytes > totalBytes) usedBytes = totalBytes;
        const unusedBytes = totalBytes - usedBytes;
        const unusedPct = totalBytes > 0 ? Math.round((unusedBytes / totalBytes) * 1000) / 10 : 0;
        return { url: entry.url, totalBytes, usedBytes, unusedBytes, unusedPct };
      });
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

  setCaptureNetworkBodies(enabled: boolean): void {
    this.captureNetworkBodies = enabled;
  }

  getCaptureNetworkBodies(): boolean {
    return this.captureNetworkBodies;
  }

  // ─── DOM mutation tracking ──────────────────────────────────

  /**
   * Returns the milliseconds since the last observed DOM mutation on the
   * current page, or Infinity if no mutations have been seen since page load.
   *
   * Reads `window.__browseMutationAge` which is kept up-to-date by the
   * MutationObserver injected via MUTATION_OBSERVER_SCRIPT.
   */
  async getLastMutationAge(): Promise<number> {
    try {
      const age = await this.getPage().evaluate(
        () => (globalThis as any).__browseMutationAge as number | undefined
      );
      return age ?? Infinity;
    } catch {
      // Page closed / navigating — treat as no mutations known
      return Infinity;
    }
  }

  /**
   * Reverse-lookup: find the tab ID that owns this page.
   * Returns undefined if the page isn't committed to any tab yet (during newTab).
   */
  private getTabIdForPage(page: Page): number | undefined {
    return this.tabs.getTabIdForPage(page);
  }

  // ─── Console/Network/Ref Wiring ────────────────────────────
  /** Evict oldest captured response bodies to stay within the per-session byte budget */
  private evictOldestBodies(): void {
    const entries = this.buffers.networkBuffer;
    for (let i = 0; i < entries.length && this.bodyBudgetUsed > this.bodyBudgetBytes; i++) {
      const e = entries[i];
      if (e.responseBody && !e.responseBody.startsWith('[binary')) {
        this.bodyBudgetUsed -= e.responseBody.length;
        e.responseBody = '[evicted]';
      }
    }
  }

  private wirePageEvents(page: Page) {
    // Clear ref map on navigation — but ONLY if this page belongs to the tab
    // that owns the current refs. Otherwise, navigating tab B clears tab A's refs.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const tabId = this.getTabIdForPage(page);
        if (tabId !== undefined && this.refs.isRefTab(tabId)) {
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
      // Capture request headers + body when body capture is enabled
      if (this.captureNetworkBodies) {
        entry.requestHeaders = req.headers();
        const method = req.method().toUpperCase();
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
          const postData = req.postData();
          entry.requestBody = postData ?? '[binary upload]';
        }
      }
      this.buffers.addNetworkEntry(entry);
      this.requestEntryMap.set(req, entry);
    });

    page.on('response', (res) => {
      const entry = this.requestEntryMap.get(res.request());
      if (entry) {
        entry.status = res.status();
        entry.duration = Date.now() - entry.timestamp;
        // Capture response headers when body capture is enabled
        if (this.captureNetworkBodies) {
          entry.responseHeaders = res.headers();
        }
        // Decrement pending count — request has received a response
        this.buffers.resolveNetworkEntry();
      }
    });

    // Decrement pending count for failed requests (no response arrives)
    page.on('requestfailed', (req) => {
      const entry = this.requestEntryMap.get(req);
      if (entry) {
        entry.duration = Date.now() - entry.timestamp;
        // Mark as failed so it doesn't linger as pending
        if (entry.status == null) {
          this.buffers.resolveNetworkEntry();
        }
      }
    });

    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (res) {
          const entry = this.requestEntryMap.get(req);
          if (entry) {
            const cl = res.headers()['content-length'];
            entry.size = cl ? parseInt(cl, 10) : 0;

            // Capture response body when body capture is enabled
            if (this.captureNetworkBodies) {
              const contentType = res.headers()['content-type'] || '';
              const isText = /json|text|xml|html|javascript|css/i.test(contentType);
              if (isText) {
                try {
                  let body = await res.text();
                  if (body.length > this.bodyLimitBytes) {
                    body = body.slice(0, this.bodyLimitBytes) + `...(truncated at ${this.bodyLimitBytes}B)`;
                  }
                  // Enforce per-session byte budget — evict oldest bodies when over budget
                  this.bodyBudgetUsed += body.length;
                  entry.responseBody = body;
                  if (this.bodyBudgetUsed > this.bodyBudgetBytes) {
                    this.evictOldestBodies();
                  }
                } catch {
                  // Body unavailable (redirect, abort) — skip gracefully
                }
              } else {
                entry.responseBody = `[binary ${entry.size || 0} bytes]`;
              }
            }
          }
        }
      } catch {}
    });
  }
}
