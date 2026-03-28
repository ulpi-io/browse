/**
 * Integration tests for snapshot context — ARIA delta after write commands
 *
 * Tests the prepareWriteContext/finalizeWriteContext orchestration and
 * formatAriaDelta diff engine against a real browser.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser/manager';
import { SessionBuffers } from '../src/network/buffers';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { handleSnapshot } from '../src/browser/snapshot';
import {
  prepareWriteContext,
  finalizeWriteContext,
  formatAriaDelta,
} from '../src/automation/action-context';
import { startTestServer } from './test-server';

let bm: BrowserManager;
let buffers: SessionBuffers;
let baseUrl: string;
let testServer: Awaited<ReturnType<typeof startTestServer>>;

const shutdown = async () => {};

beforeAll(async () => {
  testServer = await startTestServer(0);
  baseUrl = testServer.url;
  bm = new BrowserManager();
  buffers = new SessionBuffers();
  await bm.launch();
});

afterAll(async () => {
  try { testServer.server.close(); } catch {}
  await Promise.race([
    bm.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
});

// ─── formatAriaDelta unit tests ─────────────────────────────────

describe('formatAriaDelta', () => {
  test('identical inputs return empty string', () => {
    const snap = '@e1 [button] "Submit"\n@e2 [textbox] "Email"';
    expect(formatAriaDelta(snap, snap)).toBe('');
  });

  test('identical structure with different refs returns empty string', () => {
    const baseline = '@e1 [button] "Submit"\n@e2 [textbox] "Email"';
    const current  = '@e5 [button] "Submit"\n@e6 [textbox] "Email"';
    expect(formatAriaDelta(baseline, current)).toBe('');
  });

  test('empty baseline returns all lines as added with + and refs', () => {
    const current = '@e1 [button] "Submit"\n@e2 [textbox] "Email"';
    const result = formatAriaDelta('', current);

    expect(result).toContain('[snapshot-delta]');
    expect(result).toContain('+2');
    expect(result).toContain('+ @e1 [button] "Submit"');
    expect(result).toContain('+ @e2 [textbox] "Email"');
  });

  test('added elements show + with refs from current', () => {
    // Use trailing newlines to ensure diffLines matches lines correctly
    const baseline = '@e1 [heading] "Title"\n@e2 [button] "Submit"\n';
    const current  = '@e3 [heading] "Title"\n@e4 [button] "Submit"\n@e5 [button] "Add to Cart"\n';
    const result = formatAriaDelta(baseline, current);

    expect(result).toContain('[snapshot-delta]');
    // Added line should have + prefix with ref from current
    expect(result).toContain('+ @e5 [button] "Add to Cart"');
    // Summary should show unchanged count
    expect(result).toContain('=2');
  });

  test('removed elements show - without refs', () => {
    // Use trailing newlines for consistent diffLines behavior
    const baseline = '@e1 [heading] "Title"\n@e2 [button] "Submit"\n@e3 [button] "Cancel"\n';
    const current  = '@e4 [heading] "Title"\n@e5 [button] "Submit"\n';
    const result = formatAriaDelta(baseline, current);

    expect(result).toContain('[snapshot-delta]');
    // The removed line should appear with - prefix (no refs)
    expect(result).toContain('- [button] "Cancel"');
    // Summary should show unchanged count
    expect(result).toContain('=2');
  });

  test('major change (>80%) includes note', () => {
    const baseline = '@e1 [button] "A"\n@e2 [button] "B"\n@e3 [button] "C"';
    const current  = '@e4 [link] "X"\n@e5 [link] "Y"\n@e6 [link] "Z"';
    const result = formatAriaDelta(baseline, current);

    expect(result).toContain('major change');
  });
});

// ─── Integration: delta mode ──────────────────────────────────

describe('Delta mode', () => {
  test('click that changes DOM shows ARIA diff with refs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);
    // Establish baseline snapshot
    await handleSnapshot(['-i'], bm);

    // Prepare delta context, then click "Add Item" to add a new button
    const capture = await prepareWriteContext('delta', bm, buffers);
    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // Should contain the snapshot-delta section
    expect(result).toContain('[snapshot-delta]');
    // Should have at least one added line with an @e ref
    expect(result).toMatch(/\+ @e\d+/);
  });

  test('fill produces no snapshot-delta section (no DOM structure change)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);
    // Establish baseline
    await handleSnapshot(['-i'], bm);

    const capture = await prepareWriteContext('delta', bm, buffers);
    await handleWriteCommand('fill', ['input', 'hello'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Filled', 'fill');

    // Fill does not change DOM structure, so no snapshot-delta
    expect(result).not.toContain('[snapshot-delta]');
    // Should still start with the command result
    expect(result).toContain('Filled');
  });
});

// ─── Integration: full mode ───────────────────────────────────

describe('Full mode', () => {
  test('click returns full snapshot with refs', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);

    const capture = await prepareWriteContext('full', bm, buffers);
    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // Should contain [snapshot] section
    expect(result).toContain('[snapshot]');
    // Should contain @e refs in the snapshot
    expect(result).toMatch(/@e\d+/);
    // Should NOT contain [snapshot-delta]
    expect(result).not.toContain('[snapshot-delta]');
  });
});

// ─── Integration: state mode ──────────────────────────────────

describe('State mode', () => {
  test('backward compatible — produces [context] line, no ARIA', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);

    const capture = await prepareWriteContext('state', bm, buffers);
    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // State mode should NOT produce ARIA sections
    expect(result).not.toContain('[snapshot-delta]');
    expect(result).not.toContain('[snapshot]');
    // Result should start with the command output
    expect(result).toContain('Clicked');
  });

  test('navigation produces [context] with URL change', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const capture = await prepareWriteContext('state', bm, buffers);
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Navigated to ' + baseUrl + '/dynamic.html', 'goto');

    expect(result).toContain('[context]');
    expect(result).toContain('/dynamic.html');
    expect(result).not.toContain('[snapshot]');
    expect(result).not.toContain('[snapshot-delta]');
  });
});

// ─── Integration: off mode ────────────────────────────────────

describe('Off mode', () => {
  test('no context appended — result unchanged', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);

    const capture = await prepareWriteContext('off', bm, buffers);
    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // Result should be exactly the original
    expect(result).toBe('Clicked');
  });
});

// ─── Edge case: no baseline for delta ─────────────────────────

describe('No baseline fallback', () => {
  test('delta mode with no prior snapshot falls back to full', async () => {
    // Open a new tab — guarantees no prior snapshot on this tab
    await handleMetaCommand('newtab', [baseUrl + '/dynamic.html'], bm, shutdown);

    // No snapshot has been taken on this tab
    expect(bm.getLastSnapshot()).toBeNull();

    const capture = await prepareWriteContext('delta', bm, buffers);
    // beforeSnapshot should be null since no prior snapshot
    expect(capture.beforeSnapshot).toBeNull();

    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // Falls back to full mode — should contain [snapshot], not [snapshot-delta]
    expect(result).toContain('[snapshot]');
    expect(result).not.toContain('[snapshot-delta]');
    expect(result).toMatch(/@e\d+/);

    // Clean up: close the extra tab
    await handleMetaCommand('closetab', [], bm, shutdown);
  });
});

// ─── Ref validity from delta ──────────────────────────────────

describe('Ref validity', () => {
  test('refs from delta snapshot resolve to valid elements', async () => {
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);
    // Take initial snapshot to establish baseline
    await handleSnapshot(['-i'], bm);

    // Click to add a new button, capturing delta
    const capture = await prepareWriteContext('delta', bm, buffers);
    await handleWriteCommand('click', ['#add-btn'], bm);
    const result = await finalizeWriteContext(capture, bm, buffers, 'Clicked', 'click');

    // Extract an @e ref from the delta output
    const refMatch = result.match(/@(e\d+)/);
    expect(refMatch).not.toBeNull();

    // The ref should be resolvable on the BrowserManager
    const ref = refMatch![1];
    const resolved = bm.resolveRef(`@${ref}`);
    expect('locator' in resolved).toBe(true);
  });
});
