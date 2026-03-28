/**
 * Action context — captures page state before/after write commands
 * and produces a compact delta showing what changed.
 *
 * Pure functions, no side effects, no logging.
 * prepareWriteContext / finalizeWriteContext orchestrate the full
 * before/after lifecycle for write commands at any context level.
 */

import * as Diff from 'diff';
import type { Page } from 'playwright';
import type { PageState, ContextDelta, ContextLevel, WriteContextCapture } from './types';
import type { BrowserManager } from './browser-manager';
import type { SessionBuffers } from './buffers';
import { handleSnapshot } from './snapshot';

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

  return {
    url,
    title,
    tabCount: bm.getTabCount(),
    dialog: bm.getLastDialog(),
    consoleErrorCount: buffers.consoleErrorCount,
    networkPendingCount: buffers.networkPendingCount,
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
      displayPath = parsed.pathname;
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
    const msg = delta.dialogAppeared.message.replace(/"/g, '\\"').replace(/\n/g, ' ');
    parts.push(`dialog: [${delta.dialogAppeared.type}] "${msg}"`);
  }

  if (delta.dialogDismissed === true) {
    parts.push('dialog dismissed');
  }

  return `[context] ${parts.join(' | ')}`;
}

// ─── Ref-stripping helper ──────────────────────────────────────

const REF_PATTERN = /@e\d+ /g;

function stripRefs(text: string): string {
  return text.replace(REF_PATTERN, '');
}

/**
 * Compare two ARIA snapshot outputs and produce a compact delta.
 *
 * Both `baseline` and `current` may contain @refs like `@e1`, `@e2`.
 * The comparison is done on ref-stripped text (so renumbered refs don't
 * cause false diffs). Added lines preserve @refs from `current`;
 * removed lines are shown without refs (the element is gone).
 *
 * Returns a summary line + diff lines, or empty string if identical.
 *
 * Example output:
 * ```
 * [snapshot-delta] +2 -1 =12
 * + @e14 [button] "Place Order"
 * + @e15 [textbox] "Promo Code"
 * - [button] "Add to Cart"
 * ```
 */
export function formatAriaDelta(baseline: string | null | undefined, current: string): string {
  // Both empty → no delta
  if (!current && !baseline) return '';

  // Identical inputs → no delta
  if (baseline === current) return '';

  // Empty baseline → everything is "added"
  if (!baseline) {
    const lines = current.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return '';
    const summary = `[snapshot-delta] +${lines.length} -0 =0`;
    const body = lines.map(l => `+ ${l}`).join('\n');
    return `${summary}\n${body}`;
  }

  // Strip refs for comparison
  const strippedBaseline = stripRefs(baseline);
  const strippedCurrent = stripRefs(current);

  // After stripping, identical → no delta (only ref numbers changed)
  if (strippedBaseline === strippedCurrent) return '';

  // Build map: stripped line → original ref'd line (from current text)
  // Multiple lines may strip to the same text, so map to array and consume in order
  const currentRefMap = new Map<string, string[]>();
  for (const line of current.split('\n')) {
    if (line.length === 0) continue;
    const stripped = stripRefs(line);
    let arr = currentRefMap.get(stripped);
    if (!arr) {
      arr = [];
      currentRefMap.set(stripped, arr);
    }
    arr.push(line);
  }

  // Diff the ref-stripped texts
  const changes = Diff.diffLines(strippedBaseline, strippedCurrent);

  let added = 0;
  let removed = 0;
  let unchanged = 0;
  const diffLines: string[] = [];

  for (const part of changes) {
    const lines = part.value.split('\n').filter(l => l.length > 0);

    if (part.added) {
      added += lines.length;
      for (const line of lines) {
        // Recover the ref'd version from current text
        const candidates = currentRefMap.get(line);
        const refLine = candidates && candidates.length > 0 ? candidates.shift()! : line;
        diffLines.push(`+ ${refLine}`);
      }
    } else if (part.removed) {
      removed += lines.length;
      for (const line of lines) {
        // No refs — element is gone
        diffLines.push(`- ${line}`);
      }
    } else {
      unchanged += lines.length;
      // Don't output unchanged lines (compact delta)
    }
  }

  // No actual diff lines → no delta
  if (added === 0 && removed === 0) return '';

  const total = added + removed + unchanged;
  const changedPct = total > 0 ? (added + removed) / total : 0;

  let summary = `[snapshot-delta] +${added} -${removed} =${unchanged}`;
  if (changedPct > 0.8) {
    summary = `(major change — consider full snapshot)\n${summary}`;
  }

  return `${summary}\n${diffLines.join('\n')}`;
}

// ─── Write Context Orchestrator ───────────────────────────────

/**
 * Capture page state before a write command executes.
 *
 * The returned `WriteContextCapture` is passed to `finalizeWriteContext`
 * after the write command completes.
 *
 * - `'off'`: no capture, no overhead
 * - `'state'`: capture PageState only (URL, title, dialog, etc.)
 * - `'delta'`: capture PageState + store baseline snapshot text
 * - `'full'`: capture PageState (snapshot taken in finalize phase)
 */
export async function prepareWriteContext(
  level: ContextLevel,
  bm: BrowserManager,
  buffers: SessionBuffers,
): Promise<WriteContextCapture> {
  if (level === 'off') {
    return { level: 'off', beforeState: null, beforeSnapshot: null };
  }

  // All non-off levels need page state
  let beforeState: PageState | null = null;
  try {
    beforeState = await capturePageState(bm.getPage(), bm, buffers);
  } catch {
    // Page may be closed or navigating — proceed with null state
  }

  if (level === 'state') {
    return { level: 'state', beforeState, beforeSnapshot: null };
  }

  if (level === 'delta') {
    // Store the last snapshot as baseline for diffing after the write
    const beforeSnapshot = bm.getLastSnapshot();
    return { level: 'delta', beforeState, beforeSnapshot };
  }

  // level === 'full'
  return { level: 'full', beforeState, beforeSnapshot: null };
}

/**
 * Enrich write command result with context based on the capture level.
 *
 * - `'off'`: return result unchanged
 * - `'state'`: append `[context]` line with state delta (URL, title, etc.)
 * - `'delta'`: append state context line + ARIA snapshot delta with refs
 * - `'full'`: append state context line + full ARIA snapshot with refs
 *
 * **Error safety:** All snapshot/delta work is wrapped in try/catch.
 * Context capture failures never break the write command response.
 * If anything fails, the original result is returned unchanged.
 */
export async function finalizeWriteContext(
  capture: WriteContextCapture,
  bm: BrowserManager,
  buffers: SessionBuffers,
  result: string,
  command: string,
): Promise<string> {
  if (capture.level === 'off') {
    return result;
  }

  try {
    // State context line (shared by all non-off levels)
    let contextLine = '';
    if (capture.beforeState) {
      const afterState = await capturePageState(bm.getPage(), bm, buffers);
      const delta = buildContextDelta(capture.beforeState, afterState);
      if (delta) {
        contextLine = '\n' + formatContextLine(delta, command);
      }
    }

    if (capture.level === 'state') {
      return contextLine ? result + contextLine : result;
    }

    // delta and full modes need a fresh snapshot
    const snapshotOpts = bm.getLastSnapshotOpts();
    const snapshotArgs = snapshotOpts.length > 0 ? snapshotOpts : ['-i'];

    // Determine effective level: delta with no baseline falls back to full
    const effectiveLevel = (capture.level === 'delta' && capture.beforeSnapshot != null)
      ? 'delta'
      : 'full';

    const newSnapshot = await handleSnapshot(snapshotArgs, bm);

    if (effectiveLevel === 'delta') {
      const ariaDelta = formatAriaDelta(capture.beforeSnapshot, newSnapshot);
      if (ariaDelta) {
        return result + contextLine + '\n' + ariaDelta;
      }
      // No ARIA changes — just return with state context line
      return contextLine ? result + contextLine : result;
    }

    // effectiveLevel === 'full'
    return result + contextLine + '\n[snapshot]\n' + newSnapshot;
  } catch {
    // Don't let context capture failures break the command
    return result;
  }
}
