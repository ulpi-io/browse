/**
 * RefManager — owns @ref state and per-tab snapshot baselines.
 *
 * Refs are tab-scoped: the refTabId records which tab produced them.
 * BrowserManager must pass the current activeTabId to methods that
 * need it (setRefMap, resolveRef, snapshot accessors).
 */

import type { Locator } from 'playwright';

export class RefManager {
  // ─── @ref map ────────────────────────────────────────────────
  private refMap: Map<string, Locator> = new Map();
  /** Which tab owns the current refMap. */
  private refTabId: number = 0;

  // ─── Per-tab snapshot baselines ──────────────────────────────
  private tabSnapshots: Map<number, { text: string; opts: string[] }> = new Map();

  // ─── Ref operations ──────────────────────────────────────────

  setRefMap(refs: Map<string, Locator>, activeTabId: number): void {
    this.refMap = refs;
    this.refTabId = activeTabId;
  }

  clearRefs(): void {
    this.refMap.clear();
  }

  getRefMap(): Map<string, Locator> {
    return this.refMap;
  }

  getRefCount(): number {
    return this.refMap.size;
  }

  getRefTabId(): number {
    return this.refTabId;
  }

  /**
   * Returns true if the ref belongs to the given active tab.
   * Used by wirePageEvents to decide whether navigation should clear refs.
   */
  isRefTab(tabId: number): boolean {
    return tabId === this.refTabId;
  }

  areRefsValidForActiveTab(activeTabId: number): boolean {
    return this.refMap.size > 0 && this.refTabId === activeTabId;
  }

  /**
   * Resolve a selector that may be a @ref (e.g. "@e3") or a plain CSS selector.
   * Returns { locator } for @refs, or { selector } for CSS selectors.
   *
   * `frameScopedLocator` should be non-null when a frame is active; it will be
   * used to scope plain CSS selectors into the frame.
   */
  resolveRef(
    selector: string,
    activeTabId: number,
    frameScopedLocator?: Locator | null,
  ): { locator: Locator } | { selector: string } {
    if (selector.startsWith('@e')) {
      if (this.refTabId !== activeTabId) {
        throw new Error(
          `Refs were created on tab ${this.refTabId}, but active tab is ${activeTabId}. ` +
          `Run 'snapshot' on the current tab to get fresh refs.`,
        );
      }
      const ref = selector.slice(1); // "e3"
      const locator = this.refMap.get(ref);
      if (!locator) {
        throw new Error(
          `Ref ${selector} not found. Page may have changed — run 'snapshot' to get fresh refs.`,
        );
      }
      return { locator };
    }

    if (frameScopedLocator) {
      return { locator: frameScopedLocator };
    }

    return { selector };
  }

  // ─── Per-tab snapshot baselines ──────────────────────────────

  setLastSnapshot(text: string, activeTabId: number, opts?: string[]): void {
    this.tabSnapshots.set(activeTabId, { text, opts: opts || [] });
  }

  getLastSnapshot(activeTabId: number): string | null {
    return this.tabSnapshots.get(activeTabId)?.text ?? null;
  }

  getLastSnapshotOpts(activeTabId: number): string[] {
    return this.tabSnapshots.get(activeTabId)?.opts ?? [];
  }

  deleteSnapshot(tabId: number): void {
    this.tabSnapshots.delete(tabId);
  }

  clearSnapshots(): void {
    this.tabSnapshots.clear();
  }

  /**
   * Migrate snapshot entries from old tab IDs to new tab IDs.
   * Used by recreateContext after tabs are rebuilt in the new context.
   */
  migrateSnapshots(idMap: Map<number, number>): void {
    const old = new Map(this.tabSnapshots);
    this.tabSnapshots.clear();
    for (const [oldId, snapshot] of old) {
      const newId = idMap.get(oldId);
      if (newId !== undefined) {
        this.tabSnapshots.set(newId, snapshot);
      }
    }
  }

  /**
   * Save snapshot map for rollback (e.g. recreateContext failure).
   */
  snapshotState(): Map<number, { text: string; opts: string[] }> {
    return new Map(this.tabSnapshots);
  }

  /**
   * Restore snapshot map from a saved copy (rollback).
   */
  restoreState(saved: Map<number, { text: string; opts: string[] }>): void {
    this.tabSnapshots = saved;
  }

  /**
   * Save refMap for rollback.
   */
  snapshotRefMap(): Map<string, Locator> {
    return new Map(this.refMap);
  }

  /**
   * Restore refMap from a saved copy (rollback).
   */
  restoreRefMap(saved: Map<string, Locator>): void {
    this.refMap = saved;
  }
}
