/**
 * BrowserTarget — the explicit capability interface for browser commands.
 *
 * Handlers import this interface instead of the BrowserManager class.
 * This is the typed boundary the plan contract requires: "browser-only
 * behavior is isolated behind explicit capability interfaces."
 *
 * When AppTarget arrives (v2.0), commands that accept BrowserTarget are
 * explicitly browser-only, while target-neutral commands accept AutomationTarget.
 */

import type { Page, BrowserContext, Frame, FrameLocator, Locator } from 'playwright';
import type { AutomationTarget } from '../automation/target';
import type { SessionBuffers } from '../network/buffers';
import type { DomainFilter } from '../security/domain-filter';
import type { HarRecording } from '../network/har';
import type { CoverageEntry, DeviceDescriptor } from './manager';

/**
 * The 43 methods that command handlers actually call on the browser target.
 * Extracted from grep across src/commands/ and src/automation/action-context.ts.
 */
export interface BrowserTarget extends AutomationTarget {
  // ─── Page access ────────────────────────────────────────
  getPage(): Page;
  getPageById(id: number): Page | undefined;
  getContext(): BrowserContext | null;
  getBuffers(): SessionBuffers;
  getCurrentUrl(): string;

  // ─── Frame targeting ────────────────────────────────────
  getActiveFrameSelector(): string | null;
  getFrameContext(): Promise<Frame | null>;
  getLocatorRoot(): Page | FrameLocator;
  setFrame(selector: string): void;
  resetFrame(): void;

  // ─── @ref resolution ────────────────────────────────────
  resolveRef(selector: string): { locator: Locator } | { selector: string };
  setRefMap(refs: Map<string, Locator>): void;

  // ─── Tabs ───────────────────────────────────────────────
  newTab(url?: string): Promise<number>;
  closeTab(id?: number): Promise<void>;
  switchTab(id: number): void;
  getActiveTabId(): number;
  hasTab(id: number): boolean;
  getTabCount(): number;
  getTabListWithTitles(): Promise<Array<{ id: number; url: string; title: string; active: boolean }>>;

  // ─── Viewport / device ──────────────────────────────────
  setViewport(width: number, height: number): Promise<void>;
  emulateDevice(device: DeviceDescriptor | null): Promise<void>;

  // ─── Headers / UA ───────────────────────────────────────
  setExtraHeader(name: string, value: string): Promise<void>;
  getUserAgent(): string | null;
  setUserAgent(ua: string): void;
  applyUserAgent(): Promise<void>;

  // ─── Dialog ─────────────────────────────────────────────
  getLastDialog(): { type: string; message: string; defaultValue?: string } | null;
  setAutoDialogAction(action: 'accept' | 'dismiss', promptValue?: string): void;

  // ─── Network / routing ──────────────────────────────────
  isOffline(): boolean;
  setOffline(value: boolean): Promise<void>;
  getUserRoutes(): Array<{ pattern: string; action: 'block' | 'fulfill'; status?: number; body?: string }>;
  addUserRoute(pattern: string, action: 'block' | 'fulfill', status?: number, body?: string): void;
  clearUserRoutes(): void;
  setDomainFilter(filter: DomainFilter): void;
  setInitScript(script: string): void;
  getInitScript(): string | null;

  // ─── Snapshot ───────────────────────────────────────────
  getLastSnapshot(): string | null;
  getLastSnapshotOpts(): string[];
  setLastSnapshot(text: string, opts?: string[]): void;

  // ─── HAR recording ──────────────────────────────────────
  startHarRecording(): void;
  stopHarRecording(): HarRecording | null;

  // ─── Video recording ────────────────────────────────────
  startVideoRecording(dir: string): Promise<void>;
  stopVideoRecording(): Promise<{ dir: string; startedAt: number; paths: string[] } | null>;
  getVideoRecording(): { dir: string; startedAt: number } | null;

  // ─── Coverage ───────────────────────────────────────────
  startCoverage(): Promise<void>;
  stopCoverage(): Promise<{ js: CoverageEntry[]; css: CoverageEntry[] }>;

  // ─── Session handoff ────────────────────────────────────
  handoff(message: string, useChromium?: boolean): Promise<string>;
  resume(): Promise<string>;

  // ─── React DevTools ─────────────────────────────────────
  getReactDevToolsEnabled(): boolean;
  setReactDevToolsEnabled(enabled: boolean): void;

  // ─── Failure tracking ──────────────────────────────────
  resetFailures(): void;
  incrementFailures(): void;
  getFailureHint(): string | null;
}
