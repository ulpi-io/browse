/**
 * Action context — captures page state before/after write commands
 * and produces a compact delta showing what changed.
 *
 * Pure functions, no side effects, no logging.
 */

import type { Page } from 'playwright';
import type { PageState, ContextDelta } from './types';
import type { BrowserManager } from './browser-manager';
import type { SessionBuffers } from './buffers';

/**
 * Capture a snapshot of the current page state.
 * Called before and after each write command to detect changes.
 */
export async function capturePageState(
  page: Page,
  bm: BrowserManager,
  buffers: SessionBuffers,
): Promise<PageState> {
  let url = '';
  let title = '';

  try {
    url = page.url();
  } catch {
    // page may be closed
  }

  try {
    title = await page.title();
  } catch {
    // page may be closed or navigating
  }

  const consoleErrorCount = buffers.consoleBuffer.filter(
    (e) => e.level === 'error',
  ).length;

  const networkPendingCount = buffers.networkBuffer.filter(
    (e) => e.status == null,
  ).length;

  return {
    url,
    title,
    tabCount: bm.getTabCount(),
    dialog: bm.getLastDialog(),
    consoleErrorCount,
    networkPendingCount,
    timestamp: Date.now(),
  };
}

/**
 * Compare before/after page state and return only what changed.
 * Returns null if nothing changed.
 */
export function buildContextDelta(
  before: PageState,
  after: PageState,
): ContextDelta | null {
  const delta: ContextDelta = {};

  // URL change
  if (after.url !== before.url) {
    let displayPath = after.url;
    try {
      const parsed = new URL(after.url);
      displayPath = parsed.pathname + parsed.search;
    } catch {
      // e.g. about:blank — use raw url
    }
    delta.urlChanged = displayPath;
    delta.navigated = true;
  }

  // Title change
  if (after.title !== before.title) {
    delta.titleChanged = after.title;
  }

  // Dialog appeared
  if (after.dialog !== null && before.dialog === null) {
    delta.dialogAppeared = { type: after.dialog.type, message: after.dialog.message };
  }

  // Dialog dismissed
  if (after.dialog === null && before.dialog !== null) {
    delta.dialogDismissed = true;
  }

  // Tab count change
  if (after.tabCount !== before.tabCount) {
    delta.tabsChanged = after.tabCount;
  }

  // New console errors
  const newErrors = after.consoleErrorCount - before.consoleErrorCount;
  if (newErrors > 0) {
    delta.consoleErrors = newErrors;
  }

  if (Object.keys(delta).length === 0) {
    return null;
  }

  return delta;
}

/**
 * Format a context delta as a single-line human-readable string.
 * Appended to command output so the caller sees what changed.
 *
 * Example: `[context] -> /checkout | title: "Order Summary" | errors: +2`
 */
export function formatContextLine(delta: ContextDelta, _command: string): string {
  const parts: string[] = [];

  if (delta.navigated && delta.urlChanged != null) {
    parts.push(`-> ${delta.urlChanged}`);
  }

  if (delta.titleChanged != null) {
    parts.push(`title: "${delta.titleChanged}"`);
  }

  if (delta.tabsChanged != null) {
    parts.push(`tabs: ${delta.tabsChanged}`);
  }

  if (delta.consoleErrors != null) {
    parts.push(`errors: +${delta.consoleErrors}`);
  }

  if (delta.dialogAppeared != null) {
    parts.push(`dialog: [${delta.dialogAppeared.type}] "${delta.dialogAppeared.message}"`);
  }

  if (delta.dialogDismissed === true) {
    parts.push('dialog dismissed');
  }

  return `[context] ${parts.join(' | ')}`;
}
