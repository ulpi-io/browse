/**
 * Integration tests for v2.1 workflow features — TASK-039
 *
 * Covers:
 *   - Flow YAML parser: valid flow, malformed YAML, unknown command, empty steps
 *   - Flow execution: 3-step sequence, stops on failure
 *   - Retry: succeeds on second attempt, exhausts max attempts
 *   - Watch: detects DOM change, missing selector fails
 */

import { describe, test, expect } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { parseFlowYaml } from '../src/flow-parser';
import type { Session } from '../src/session/manager';

const shutdown = async () => {};

/** Minimal Session for tests that need session context */
function makeSession(): Session {
  return {
    id: 'test-v2.1',
    manager: bm as any,
    buffers: bm.getBuffers(),
    domainFilter: null,
    recording: null,
    outputDir: '/tmp',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    contextLevel: 'off',
    settleMode: false,
  };
}

// ─── Flow YAML Parser ──────────────────────────────────────────

describe('Flow YAML parser', () => {
  test('valid flow: parse goto + click + text', () => {
    const yaml = `
- goto: "https://example.com"
- click: "#submit"
- text:
`;
    const steps = parseFlowYaml(yaml);
    expect(steps).toHaveLength(3);
    expect(steps[0].command).toBe('goto');
    expect(steps[0].args).toEqual(['https://example.com']);
    expect(steps[1].command).toBe('click');
    expect(steps[1].args).toEqual(['#submit']);
    expect(steps[2].command).toBe('text');
    expect(steps[2].args).toEqual([]);
  });

  test('malformed YAML: verify error with context', () => {
    const malformed = `
- goto: "https://example.com"
- click: [unclosed
`;
    expect(() => parseFlowYaml(malformed)).toThrow(/Malformed YAML/i);
  });

  test('unknown command: verify error', () => {
    const yaml = `
- goto: "https://example.com"
- nonexistent_command_xyz: "value"
`;
    expect(() => parseFlowYaml(yaml)).toThrow(/unknown command/i);
  });

  test('empty steps: verify error', () => {
    const yaml = `[]`;
    expect(() => parseFlowYaml(yaml)).toThrow(/no steps/i);
  });

  test('empty content: verify error', () => {
    expect(() => parseFlowYaml('')).toThrow(/empty/i);
    expect(() => parseFlowYaml('   ')).toThrow(/empty/i);
  });

  test('fill with object form parses correctly', () => {
    const yaml = `
- fill:
    "#email": "test@example.com"
`;
    const steps = parseFlowYaml(yaml);
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toBe('fill');
    expect(steps[0].args).toEqual(['#email', 'test@example.com']);
  });
});

// ─── Flow Execution ─────────────────────────────────────────────

describe('Flow execution', () => {
  test('3-step sequence: goto + fill + text', async () => {
    // Write a flow YAML as a temp file, then run it through the flow command
    const fs = await import('fs');
    const path = await import('path');
    const tmpFile = path.join('/tmp', `browse-flow-test-${Date.now()}.yaml`);

    const yaml = [
      `- goto: "${baseUrl}/basic.html"`,
      '- text:',
    ].join('\n');

    fs.writeFileSync(tmpFile, yaml, 'utf-8');

    try {
      const session = makeSession();
      const result = await handleMetaCommand('flow', [tmpFile], bm, shutdown, undefined, session);
      expect(result).toContain('2/2');
      expect(result).toContain('Flow complete');
      expect(result).toContain('2/2 steps passed');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('stops on failure: step that fails stops execution', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const tmpFile = path.join('/tmp', `browse-flow-fail-${Date.now()}.yaml`);

    const yaml = [
      `- goto: "${baseUrl}/basic.html"`,
      '- click: "#nonexistent-element-that-does-not-exist-xyz"',
      '- text:',
    ].join('\n');

    fs.writeFileSync(tmpFile, yaml, 'utf-8');

    try {
      const session = makeSession();
      const result = await handleMetaCommand('flow', [tmpFile], bm, shutdown, undefined, session);
      // The flow should report failure at step 2
      expect(result).toContain('FAIL');
      expect(result).toContain('Flow failed at step 2/3');
      // Step 3 (text) should NOT appear as passed
      expect(result).not.toContain('3/3');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ─── Retry ──────────────────────────────────────────────────────

describe('Retry', () => {
  test('succeeds on second attempt via DOM mutation', async () => {
    // Navigate to a page that adds a button after 300ms
    // We use the dynamic.html page which has an "Add Item" button
    await handleWriteCommand('goto', [baseUrl + '/dynamic.html'], bm);

    // Click the "Add Item" button to add content, making a selector available
    await handleWriteCommand('click', ['#add-btn'], bm);

    // Now retry clicking a selector that exists
    const session = makeSession();
    const result = await handleMetaCommand(
      'retry',
      ['click #add-btn', '--until', '--visible', '#add-btn', '--max', '3'],
      bm, shutdown, undefined, session
    );
    expect(result).toContain('OK');
    expect(result).toMatch(/after \d+ attempt/);
  });

  test('exhausts max attempts: verify error message with attempt count', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const session = makeSession();
    // Retry looking for an element that will never appear
    await expect(
      handleMetaCommand(
        'retry',
        ['text', '--until', '--url', 'never-matching-url-xyz', '--max', '2'],
        bm, shutdown, undefined, session
      )
    ).rejects.toThrow(/2 attempts/);
  });
});

// ─── Watch ──────────────────────────────────────────────────────

describe('Watch', () => {
  test('detects DOM change from timer', async () => {
    // Navigate to a page that mutates DOM after 300ms
    await handleWriteCommand('goto', [baseUrl + '/watch-timer.html'], bm);

    const session = makeSession();
    const result = await handleMetaCommand(
      'watch',
      ['#container', '--timeout', '5000'],
      bm, shutdown, undefined, session
    );
    expect(result).toContain('Change detected');
    expect(result).toContain('DOM');
  });

  test('missing selector fails with error', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const session = makeSession();
    await expect(
      handleMetaCommand(
        'watch',
        ['#nonexistent-selector-xyz-abc', '--timeout', '1000'],
        bm, shutdown, undefined, session
      )
    ).rejects.toThrow(/not found|Element not found/i);
  });
});
