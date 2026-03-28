/**
 * TabManager — owns tab state (pages Map, activeTabId, nextTabId).
 *
 * BrowserManager delegates all tab lifecycle operations here and reads
 * activeTabId / pages from this class for its own logic.
 */

import type { BrowserContext, Page } from 'playwright';

export type TabEntry = { id: number; url: string; title: string; active: boolean };

export class TabManager {
  private pages: Map<number, Page> = new Map();
  private _activeTabId: number = 0;
  private nextTabId: number = 1;

  // ─── Read accessors ──────────────────────────────────────────

  get activeTabId(): number {
    return this._activeTabId;
  }

  set activeTabId(id: number) {
    this._activeTabId = id;
  }

  getPages(): Map<number, Page> {
    return this.pages;
  }

  getPage(): Page {
    const page = this.pages.get(this._activeTabId);
    if (!page) throw new Error('No active page. Use "browse goto <url>" first.');
    return page;
  }

  getPageById(id: number): Page | undefined {
    return this.pages.get(id);
  }

  hasTab(id: number): boolean {
    return this.pages.has(id);
  }

  getTabCount(): number {
    return this.pages.size;
  }

  getActiveTabId(): number {
    return this._activeTabId;
  }

  getTabList(): TabEntry[] {
    const tabs: TabEntry[] = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: '', // title requires await, populated by caller
        active: id === this._activeTabId,
      });
    }
    return tabs;
  }

  async getTabListWithTitles(): Promise<TabEntry[]> {
    const tabs: TabEntry[] = [];
    for (const [id, page] of this.pages) {
      tabs.push({
        id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: id === this._activeTabId,
      });
    }
    return tabs;
  }

  // ─── Mutating operations ─────────────────────────────────────

  /**
   * Create a new tab on the given context. Navigates to `url` if provided.
   * Throws if navigation fails (page is NOT committed to the map on failure).
   * Calls `wireEvents(page)` before navigating so all events are captured.
   */
  async newTab(
    context: BrowserContext,
    wireEvents: (page: Page) => void,
    url?: string,
  ): Promise<number> {
    const page = await context.newPage();

    wireEvents(page);

    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
    }

    const id = this.nextTabId++;
    this.pages.set(id, page);
    this._activeTabId = id;
    return id;
  }

  /**
   * Close a tab. If the closed tab was active, activates the most-recently-opened
   * remaining tab. If no tabs remain, creates a blank new tab.
   * Returns the ID of the closed tab.
   */
  async closeTab(
    context: BrowserContext,
    wireEvents: (page: Page) => void,
    id?: number,
  ): Promise<number> {
    const tabId = id ?? this._activeTabId;
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`Tab ${tabId} not found`);

    await page.close();
    this.pages.delete(tabId);

    if (tabId === this._activeTabId) {
      const remaining = [...this.pages.keys()];
      if (remaining.length > 0) {
        this._activeTabId = remaining[remaining.length - 1];
      } else {
        await this.newTab(context, wireEvents);
      }
    }

    return tabId;
  }

  switchTab(id: number): void {
    if (!this.pages.has(id)) throw new Error(`Tab ${id} not found`);
    this._activeTabId = id;
  }

  /**
   * Register an externally-created page (e.g. from an existing browser context).
   * Used during launchWithBrowser(reuseContext) and launchPersistent.
   */
  registerPage(page: Page, wireEvents: (page: Page) => void): number {
    const id = this.nextTabId++;
    wireEvents(page);
    this.pages.set(id, page);
    this._activeTabId = id;
    return id;
  }

  /**
   * Remove all pages from the map without closing them (used during context swap in
   * recreateContext / handoff / resume where pages are closed separately).
   */
  clearPages(): void {
    this.pages.clear();
  }

  /**
   * Reset the ID counter and clear pages — called when swapping to a new context.
   */
  reset(): void {
    this.pages.clear();
    this.nextTabId = 1;
    this._activeTabId = 0;
  }

  /**
   * Reverse-lookup: find the tab ID that owns a given Page.
   * Returns undefined if the page isn't committed yet.
   */
  getTabIdForPage(page: Page): number | undefined {
    for (const [id, p] of this.pages) {
      if (p === page) return id;
    }
    return undefined;
  }

  /** Snapshot the current tab→url mapping (used by recreateContext / saveState). */
  snapshotTabUrls(): Array<{ id: number; url: string; active: boolean }> {
    const result: Array<{ id: number; url: string; active: boolean }> = [];
    for (const [id, page] of this.pages) {
      result.push({ id, url: page.url(), active: id === this._activeTabId });
    }
    return result;
  }
}
