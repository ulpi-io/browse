/**
 * Unified workflow path tests — verify that flow, retry, watch, and chain
 * all route through the executeCommand() pipeline with proper behavior.
 *
 * Tests cover:
 *   - TASK-011: Flow execution through executor, sub-step recording, app target gating
 *   - TASK-012: Chain through executor, record export flow round-trip, export format restrictions
 *   - TASK-013: Edge cases — nesting depth, retry/watch on app target, HAR/video on app target,
 *               findProjectRoot, record export browse on app session
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registry, ensureDefinitionsRegistered, RECORDING_SKIP } from '../src/automation/registry';
import { executeCommand } from '../src/automation/executor';
import { parseFlowYaml } from '../src/flow-parser';
import { exportFlowYaml, exportBrowse } from '../src/export/record';
import type { RecordedStep } from '../src/export/record';
import { handleRecordingCommand } from '../src/commands/meta/recording';
import { findProjectRoot } from '../src/config';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { SessionBuffers } from '../src/network/buffers';
import type { Session } from '../src/session/manager';
import type { CommandLifecycle, AfterCommandEvent } from '../src/automation/events';
import type { AutomationTarget } from '../src/automation/target';

const SRC = path.join(__dirname, '..', 'src');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

// ─── Test Helpers ──────────────────────────────────────────────────

/** Build a minimal Session for tests */
function makeSession(target: AutomationTarget, overrides?: Partial<Session>): Session {
  return {
    id: 'test-unified',
    manager: target,
    buffers: new SessionBuffers(),
    domainFilter: null,
    recording: null,
    lastRecording: null,
    outputDir: '/tmp/test-unified',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    contextLevel: 'off',
    settleMode: false,
    ...overrides,
  };
}

/**
 * Build a mock app target that is NOT a browser.
 * Has no getPage, no startHarRecording, no startVideoRecording.
 */
function createMockAppTarget(type: 'app' | 'android-app' | 'ios-app' = 'app'): AutomationTarget {
  return {
    targetType: type,
    getCapabilities: () => ({
      navigation: false,
      tabs: false,
      refs: true,
      screenshots: true,
      javascript: false,
      deviceEmulation: false,
      frames: false,
    }),
    getCurrentLocation: () => `mock-${type}://TestApp`,
    isReady: () => true,
    close: async () => {},
  } as AutomationTarget;
}

/**
 * Create a recording lifecycle that captures recorded steps,
 * mirroring the server's after-hook behavior:
 *   - Checks session.recording is active
 *   - Checks spec.skipRecording to exclude wrapper commands
 *   - Pushes sub-step commands into the recording array
 */
function createRecordingLifecycle(session: Session): CommandLifecycle {
  return {
    after: [async (event: AfterCommandEvent): Promise<string> => {
      if (session.recording && !event.spec?.skipRecording) {
        session.recording.push({
          command: event.command,
          args: [...event.args],
          timestamp: Date.now(),
        });
      }
      return event.result;
    }],
  };
}

// ─── Source-level structural invariants ─────────────────────────

describe('Unified workflow: source structure', () => {
  test('flows.ts does not import handleReadCommand or handleWriteCommand', () => {
    const flows = readSrc('commands/meta/flows.ts');
    expect(flows).not.toContain("from '../read'");
    expect(flows).not.toContain("from '../write'");
    expect(flows).not.toContain('handleReadCommand');
    expect(flows).not.toContain('handleWriteCommand');
  });

  test('flows.ts uses executeCommand from the executor (lazy import)', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // Uses dynamic import to avoid circular deps
    expect(flows).toContain("import('../../automation/executor')");
    expect(flows).toContain('executeCommand');
  });

  test('flows.ts uses a shared executeFlowSteps for file and saved flows', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // The shared helper should be defined once
    expect(flows).toContain('async function executeFlowSteps(');
    // Both flow file and flow run paths call it
    const callCount = (flows.match(/executeFlowSteps\(/g) || []).length;
    // At least 3: definition + 2 call sites (flow file, flow run)
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test('flows.ts has recursion depth protection via WeakMap', () => {
    const flows = readSrc('commands/meta/flows.ts');
    expect(flows).toContain('MAX_FLOW_DEPTH');
    expect(flows).toContain('flowDepthMap');
    expect(flows).toContain('WeakMap');
    // No module-global counter
    expect(flows).not.toMatch(/^let flowDepth\s*=/m);
  });

  test('system.ts chain routes through executeCommand, not inline dispatch', () => {
    const system = readSrc('commands/meta/system.ts');
    expect(system).toContain('executeCommand(');
    expect(system).not.toContain('handleReadCommand');
    expect(system).not.toContain('handleWriteCommand');
  });

  test('flows.ts retry routes through executeCommand', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // retry block should use executeCommand, not direct handlers
    const retrySection = flows.slice(flows.indexOf("case 'retry':"));
    expect(retrySection).toContain('executeCommand(');
  });

  test('flows.ts watch --on-change routes through executeCommand', () => {
    const flows = readSrc('commands/meta/flows.ts');
    const watchSection = flows.slice(flows.indexOf("case 'watch':"));
    expect(watchSection).toContain('executeCommand(');
  });

  test('retry and watch use requireBrowserTarget guard', () => {
    const flows = readSrc('commands/meta/flows.ts');
    const retrySection = flows.slice(
      flows.indexOf("case 'retry':"),
      flows.indexOf("case 'watch':"),
    );
    expect(retrySection).toContain('requireBrowserTarget(');

    const watchSection = flows.slice(flows.indexOf("case 'watch':"));
    expect(watchSection).toContain('requireBrowserTarget(');
  });
});

// ─── skipRecording flags ────────────────────────────────────────

describe('Unified workflow: skipRecording', () => {
  test('flow, chain, retry, watch are skipRecording', () => {
    const wrapperCommands = ['flow', 'chain', 'retry', 'watch'];
    for (const name of wrapperCommands) {
      const spec = registry.get(name);
      expect(spec, `${name} should be registered`).toBeDefined();
      expect(spec!.skipRecording, `${name} should have skipRecording=true`).toBe(true);
    }
  });

  test('RECORDING_SKIP set includes flow, chain, retry, watch', () => {
    expect(RECORDING_SKIP.has('flow')).toBe(true);
    expect(RECORDING_SKIP.has('chain')).toBe(true);
    expect(RECORDING_SKIP.has('retry')).toBe(true);
    expect(RECORDING_SKIP.has('watch')).toBe(true);
  });

  test('substep commands (goto, click, text) are NOT skipRecording', () => {
    const substeps = ['goto', 'click', 'text', 'fill', 'snapshot'];
    for (const name of substeps) {
      const spec = registry.get(name);
      expect(spec, `${name} should be registered`).toBeDefined();
      expect(spec!.skipRecording, `${name} should not be skipRecording`).toBeFalsy();
    }
  });
});

// ─── targetSupport flags ────────────────────────────────────────

describe('Unified workflow: target support', () => {
  test('retry and watch are browser-only', () => {
    const retrySpec = registry.get('retry');
    const watchSpec = registry.get('watch');
    expect(retrySpec?.targetSupport).toBe('browser');
    expect(watchSpec?.targetSupport).toBe('browser');
  });

  test('flow is not restricted to browser (works on all targets)', () => {
    const flowSpec = registry.get('flow');
    // Should be 'any' (default) or undefined
    expect(flowSpec?.targetSupport ?? 'any').toBe('any');
  });

  test('executor rejects browser-only commands for non-browser targets', async () => {
    await ensureDefinitionsRegistered();

    const mockAppTarget = createMockAppTarget();

    // retry has targetSupport: 'browser', should be rejected for app targets
    await expect(
      executeCommand('retry', ['"click .btn"', '--until', '--text', 'done'], {
        context: {
          args: ['"click .btn"', '--until', '--text', 'done'],
          target: mockAppTarget,
          buffers: new SessionBuffers(),
        },
      }),
    ).rejects.toThrow(/not available for app targets/);
  });
});

// ─── Flow YAML round-trip ───────────────────────────────────────

describe('Unified workflow: YAML round-trip', () => {
  test('exportFlowYaml produces parseable YAML', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'snapshot', args: ['-i'], timestamp: 2 },
      { command: 'click', args: ['@e3'], timestamp: 3 },
      { command: 'text', args: [], timestamp: 4 },
    ];

    const yaml = exportFlowYaml(steps);
    const parsed = parseFlowYaml(yaml);

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ command: 'goto', args: ['https://example.com'] });
    expect(parsed[1]).toEqual({ command: 'snapshot', args: ['-i'] });
    expect(parsed[2]).toEqual({ command: 'click', args: ['@e3'] });
    expect(parsed[3]).toEqual({ command: 'text', args: [] });
  });

  test('exportFlowYaml handles multi-arg commands', () => {
    const steps: RecordedStep[] = [
      { command: 'fill', args: ['@e5', 'search term'], timestamp: 1 },
    ];

    const yaml = exportFlowYaml(steps);
    const parsed = parseFlowYaml(yaml);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].command).toBe('fill');
    expect(parsed[0].args).toEqual(['@e5', 'search term']);
  });

  test('exportBrowse and exportFlowYaml produce equivalent step sequences', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['@e1'], timestamp: 2 },
      { command: 'text', args: [], timestamp: 3 },
    ];

    // Both formats should round-trip to the same logical steps
    const browseJson = exportBrowse(steps);
    const flowYaml = exportFlowYaml(steps);

    const browseSteps = JSON.parse(browseJson) as string[][];
    const flowSteps = parseFlowYaml(flowYaml);

    expect(browseSteps).toHaveLength(flowSteps.length);
    for (let i = 0; i < browseSteps.length; i++) {
      const [cmd, ...args] = browseSteps[i];
      expect(cmd).toBe(flowSteps[i].command);
      expect(args).toEqual(flowSteps[i].args);
    }
  });

  test('record export flow round-trip: export then parse produces matching steps', () => {
    const originalSteps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com/login'], timestamp: 100 },
      { command: 'fill', args: ['#email', 'user@test.com'], timestamp: 200 },
      { command: 'fill', args: ['#password', 'secret'], timestamp: 300 },
      { command: 'click', args: ['button[type=submit]'], timestamp: 400 },
      { command: 'expect', args: ['--url', '/dashboard'], timestamp: 500 },
      { command: 'text', args: [], timestamp: 600 },
    ];

    const yaml = exportFlowYaml(originalSteps);
    const parsed = parseFlowYaml(yaml);

    expect(parsed).toHaveLength(originalSteps.length);
    for (let i = 0; i < originalSteps.length; i++) {
      expect(parsed[i].command).toBe(originalSteps[i].command);
      expect(parsed[i].args).toEqual(originalSteps[i].args);
    }
  });
});

// ─── TASK-011: Flow execution through executor ──────────────────

describe('TASK-011: Flow execution through executor', () => {
  test('flow file executes steps through executeCommand pipeline', async () => {
    await ensureDefinitionsRegistered();

    // Navigate to a page first
    await executeCommand('goto', [baseUrl + '/basic.html'], {
      context: {
        args: [baseUrl + '/basic.html'],
        target: bm,
        buffers: new SessionBuffers(),
      },
    });

    // Create a minimal flow YAML in a temp location
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-flow-'));
    const flowFile = path.join(tmpDir, 'test.yaml');
    fs.writeFileSync(flowFile, '- text: null\n- url: null\n');

    try {
      const result = await executeCommand('flow', [flowFile], {
        context: {
          args: [flowFile],
          target: bm,
          buffers: new SessionBuffers(),
          shutdown: () => {},
        },
      });

      expect(result.output).toContain('Flow complete');
      expect(result.output).toContain('2/2 steps passed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('flow step failure reports step number and stops', async () => {
    await ensureDefinitionsRegistered();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-flow-'));
    const flowFile = path.join(tmpDir, 'fail.yaml');
    // "click" on a non-existent element will fail
    fs.writeFileSync(flowFile, '- text: null\n- click: ".does-not-exist-xyz"\n- text: null\n');

    try {
      const result = await executeCommand('flow', [flowFile], {
        context: {
          args: [flowFile],
          target: bm,
          buffers: new SessionBuffers(),
          shutdown: () => {},
        },
      });

      // Step 1 should pass, step 2 should fail, step 3 should not run
      expect(result.output).toContain('[1/3] text');
      expect(result.output).toContain('[2/3] click');
      expect(result.output).toContain('FAIL');
      expect(result.output).toContain('Flow failed at step 2/3');
      expect(result.output).not.toContain('[3/3]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('flow sub-steps are recorded individually (not the flow wrapper)', async () => {
    await ensureDefinitionsRegistered();

    // Navigate to a page first
    await executeCommand('goto', [baseUrl + '/basic.html'], {
      context: {
        args: [baseUrl + '/basic.html'],
        target: bm,
        buffers: new SessionBuffers(),
      },
    });

    // Set up a session with recording active
    const session = makeSession(bm, { recording: [] });
    const lifecycle = createRecordingLifecycle(session);

    // Create a flow with 2 steps
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-record-'));
    const flowFile = path.join(tmpDir, 'record-test.yaml');
    fs.writeFileSync(flowFile, '- text: null\n- url: null\n');

    try {
      await executeCommand('flow', [flowFile], {
        context: {
          args: [flowFile],
          target: bm,
          buffers: session.buffers,
          session,
          shutdown: () => {},
          lifecycle,
        },
        lifecycle,
      });

      // The 'flow' command itself should NOT be recorded (skipRecording: true)
      // But the sub-steps 'text' and 'url' should be recorded
      const recordedCommands = session.recording!.map(s => s.command);
      expect(recordedCommands).not.toContain('flow');
      expect(recordedCommands).toContain('text');
      expect(recordedCommands).toContain('url');
      expect(session.recording!.length).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('flow with unsupported command on mock app target fails at specific step', async () => {
    await ensureDefinitionsRegistered();

    const mockAppTarget = createMockAppTarget();
    const session = makeSession(mockAppTarget);

    // Create a flow with a browser-only command (retry has targetSupport: 'browser')
    // and a target-neutral command (status works on app targets)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-app-'));
    const flowFile = path.join(tmpDir, 'app-flow.yaml');
    // 'status' works on all targets (no targetSupport restriction)
    // 'retry' is browser-only and should fail
    fs.writeFileSync(flowFile, '- status: null\n- retry: "click .btn"\n');

    try {
      const result = await executeCommand('flow', [flowFile], {
        context: {
          args: [flowFile],
          target: mockAppTarget,
          buffers: session.buffers,
          session,
          shutdown: () => {},
        },
      });

      // Step 1 (status) should pass, step 2 (retry) should fail with capability error
      expect(result.output).toContain('[1/2] status');
      expect(result.output).toContain('[2/2] retry');
      expect(result.output).toContain('FAIL');
      expect(result.output).toMatch(/not available for app targets/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── TASK-012: Chain through executor + export formats ──────────

describe('TASK-012: Chain through executor', () => {
  test('chain routes sub-steps through executeCommand', async () => {
    await ensureDefinitionsRegistered();

    await executeCommand('goto', [baseUrl + '/basic.html'], {
      context: {
        args: [baseUrl + '/basic.html'],
        target: bm,
        buffers: new SessionBuffers(),
      },
    });

    const commands = JSON.stringify([['text'], ['url']]);
    const result = await executeCommand('chain', [commands], {
      context: {
        args: [commands],
        target: bm,
        buffers: new SessionBuffers(),
        shutdown: () => {},
      },
    });

    expect(result.output).toContain('[text]');
    expect(result.output).toContain('[url]');
  });

  test('chain sub-steps are recorded individually (not the chain wrapper)', async () => {
    await ensureDefinitionsRegistered();

    // Navigate first
    await executeCommand('goto', [baseUrl + '/basic.html'], {
      context: {
        args: [baseUrl + '/basic.html'],
        target: bm,
        buffers: new SessionBuffers(),
      },
    });

    // Set up session with recording
    const session = makeSession(bm, { recording: [] });
    const lifecycle = createRecordingLifecycle(session);

    const commands = JSON.stringify([['text'], ['url']]);
    await executeCommand('chain', [commands], {
      context: {
        args: [commands],
        target: bm,
        buffers: session.buffers,
        session,
        shutdown: () => {},
        lifecycle,
      },
      lifecycle,
    });

    // The 'chain' command itself should NOT be recorded (skipRecording: true)
    // But the sub-steps 'text' and 'url' should be recorded
    const recordedCommands = session.recording!.map(s => s.command);
    expect(recordedCommands).not.toContain('chain');
    expect(recordedCommands).toContain('text');
    expect(recordedCommands).toContain('url');
    expect(session.recording!.length).toBe(2);
  });

  test('record export flow produces valid YAML from recorded steps', () => {
    const steps: RecordedStep[] = [
      { command: 'goto', args: ['https://example.com'], timestamp: 1 },
      { command: 'click', args: ['#login'], timestamp: 2 },
      { command: 'fill', args: ['#email', 'user@test.com'], timestamp: 3 },
      { command: 'text', args: [], timestamp: 4 },
    ];

    // Export as flow YAML
    const yaml = exportFlowYaml(steps);

    // Parse it back
    const parsed = parseFlowYaml(yaml);

    // Verify round-trip
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ command: 'goto', args: ['https://example.com'] });
    expect(parsed[1]).toEqual({ command: 'click', args: ['#login'] });
    expect(parsed[2]).toEqual({ command: 'fill', args: ['#email', 'user@test.com'] });
    expect(parsed[3]).toEqual({ command: 'text', args: [] });
  });

  test('record export replay rejects on non-browser session', async () => {
    const mockAppTarget = createMockAppTarget();
    const session = makeSession(mockAppTarget, {
      recording: [
        { command: 'snapshot', args: ['-i'], timestamp: 1 },
      ],
    });

    await expect(
      handleRecordingCommand('record', ['export', 'replay'], mockAppTarget, session),
    ).rejects.toThrow(/browser session/);
  });

  test('record export playwright rejects on non-browser session', async () => {
    const mockAppTarget = createMockAppTarget();
    const session = makeSession(mockAppTarget, {
      recording: [
        { command: 'snapshot', args: ['-i'], timestamp: 1 },
      ],
    });

    await expect(
      handleRecordingCommand('record', ['export', 'playwright'], mockAppTarget, session),
    ).rejects.toThrow(/browser session/);
  });

  test('record export browse on app session succeeds', async () => {
    const mockAppTarget = createMockAppTarget();
    const session = makeSession(mockAppTarget, {
      recording: [
        { command: 'snapshot', args: ['-i'], timestamp: 1 },
        { command: 'click', args: ['@e1'], timestamp: 2 },
      ],
    });

    const result = await handleRecordingCommand('record', ['export', 'browse'], mockAppTarget, session);
    // Should produce valid JSON
    const parsed = JSON.parse(result) as string[][];
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(['snapshot', '-i']);
    expect(parsed[1]).toEqual(['click', '@e1']);
  });

  test('record export flow on app session succeeds', async () => {
    const mockAppTarget = createMockAppTarget();
    const session = makeSession(mockAppTarget, {
      recording: [
        { command: 'snapshot', args: ['-i'], timestamp: 1 },
        { command: 'click', args: ['@e1'], timestamp: 2 },
      ],
    });

    const result = await handleRecordingCommand('record', ['export', 'flow'], mockAppTarget, session);
    // Should produce valid YAML
    const parsed = parseFlowYaml(result);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].command).toBe('snapshot');
    expect(parsed[1].command).toBe('click');
  });
});

// ─── App target capability gating through executor ──────────────

describe('Unified workflow: app target gating', () => {
  test('executor blocks browser-only commands for app target type', async () => {
    await ensureDefinitionsRegistered();

    const mockTarget = createMockAppTarget('ios-app');

    // 'watch' has targetSupport: 'browser'
    await expect(
      executeCommand('watch', ['.selector'], {
        context: {
          args: ['.selector'],
          target: mockTarget,
          buffers: new SessionBuffers(),
        },
      }),
    ).rejects.toThrow(/not available for ios-app targets/);
  });

  test('executor blocks retry for android-app target', async () => {
    await ensureDefinitionsRegistered();

    const mockTarget = createMockAppTarget('android-app');

    await expect(
      executeCommand('retry', ['"click .btn"', '--until', '--text', 'done'], {
        context: {
          args: ['"click .btn"', '--until', '--text', 'done'],
          target: mockTarget,
          buffers: new SessionBuffers(),
        },
      }),
    ).rejects.toThrow(/not available for android-app targets/);
  });
});

// ─── TASK-013: Edge cases ───────────────────────────────────────

describe('TASK-013: Edge cases', () => {
  test('nested flow at depth 1 succeeds (shallow nesting)', async () => {
    await ensureDefinitionsRegistered();

    // Navigate first
    await executeCommand('goto', [baseUrl + '/basic.html'], {
      context: {
        args: [baseUrl + '/basic.html'],
        target: bm,
        buffers: new SessionBuffers(),
      },
    });

    // A single-level flow should work fine
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-nest-'));
    const flowFile = path.join(tmpDir, 'shallow.yaml');
    fs.writeFileSync(flowFile, '- text: null\n');

    try {
      const result = await executeCommand('flow', [flowFile], {
        context: {
          args: [flowFile],
          target: bm,
          buffers: new SessionBuffers(),
          shutdown: () => {},
        },
      });

      expect(result.output).toContain('Flow complete');
      expect(result.output).toContain('1/1 steps passed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('MAX_FLOW_DEPTH constant exists and is reasonable (5-20)', () => {
    const flows = readSrc('commands/meta/flows.ts');
    const match = flows.match(/MAX_FLOW_DEPTH\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const depth = parseInt(match![1], 10);
    expect(depth).toBeGreaterThanOrEqual(5);
    expect(depth).toBeLessThanOrEqual(20);
  });

  test('depth tracking uses per-session WeakMap, not module global', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // WeakMap keyed on session -- gc-friendly
    expect(flows).toContain('new WeakMap');
    expect(flows).toContain('flowDepthMap');
    // withFlowDepth is the RAII-style depth manager
    expect(flows).toContain('async function withFlowDepth');
    // Verify cleanup happens in finally block
    expect(flows).toContain('.finally(');
  });

  test('retry on app target fails with capability error from registry', async () => {
    await ensureDefinitionsRegistered();

    // Verify registry marks retry as browser-only
    const retrySpec = registry.get('retry');
    expect(retrySpec).toBeDefined();
    expect(retrySpec!.targetSupport).toBe('browser');

    // Verify executor enforces the restriction
    const mockTarget = createMockAppTarget();
    await expect(
      executeCommand('retry', ['"click .btn"', '--until', '--text', 'done'], {
        context: {
          args: ['"click .btn"', '--until', '--text', 'done'],
          target: mockTarget,
          buffers: new SessionBuffers(),
        },
      }),
    ).rejects.toThrow(/not available for app targets/);
  });

  test('watch on app target fails with capability error from registry', async () => {
    await ensureDefinitionsRegistered();

    // Verify registry marks watch as browser-only
    const watchSpec = registry.get('watch');
    expect(watchSpec).toBeDefined();
    expect(watchSpec!.targetSupport).toBe('browser');

    // Verify executor enforces the restriction
    const mockTarget = createMockAppTarget();
    await expect(
      executeCommand('watch', ['.selector'], {
        context: {
          args: ['.selector'],
          target: mockTarget,
          buffers: new SessionBuffers(),
        },
      }),
    ).rejects.toThrow(/not available for app targets/);
  });

  test('har start on app target rejects (no startHarRecording method)', async () => {
    const mockTarget = createMockAppTarget();

    await expect(
      handleRecordingCommand('har', ['start'], mockTarget),
    ).rejects.toThrow(/browser session/);
  });

  test('video start on app target rejects (no startVideoRecording method)', async () => {
    const mockTarget = createMockAppTarget();

    await expect(
      handleRecordingCommand('video', ['start'], mockTarget),
    ).rejects.toThrow(/browser session/);
  });

  test('record export browse on app session succeeds (target-neutral format)', async () => {
    const mockTarget = createMockAppTarget();
    const session = makeSession(mockTarget, {
      recording: [
        { command: 'snapshot', args: ['-i'], timestamp: 1 },
        { command: 'click', args: ['@e2'], timestamp: 2 },
        { command: 'text', args: [], timestamp: 3 },
      ],
    });

    // browse format is target-neutral -- it's just a JSON array of command arrays
    const result = await handleRecordingCommand('record', ['export', 'browse'], mockTarget, session);
    const parsed = JSON.parse(result) as string[][];
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual(['snapshot', '-i']);
    expect(parsed[1]).toEqual(['click', '@e2']);
    expect(parsed[2]).toEqual(['text']);
  });

  test('findProjectRoot returns a string in git repo', () => {
    // We are running in the browse_cli repo which has .git
    const root = findProjectRoot();
    expect(root).not.toBeNull();
    expect(typeof root).toBe('string');
    // Should be an absolute path
    expect(path.isAbsolute(root!)).toBe(true);
    // The project root should contain package.json
    expect(fs.existsSync(path.join(root!, 'package.json'))).toBe(true);
  });
});

// ─── Recursion depth tracking ───────────────────────────────────

describe('Unified workflow: recursion protection', () => {
  test('flow depth tracking is session-scoped via WeakMap', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // WeakMap ensures no memory leak across sessions
    expect(flows).toContain('new WeakMap');
    expect(flows).toContain('flowDepthMap');
    // getFlowDepth returns 0 when session has no entry
    expect(flows).toContain('getFlowDepth');
    expect(flows).toContain('?? 0');
    // withFlowDepth increments before and decrements after
    expect(flows).toMatch(/flowDepthMap\.set\([^,]+,\s*current \+ 1\)/);
  });
});

// ─── Meta handler: handleFlowsCommand accepts AutomationTarget ──

describe('Unified workflow: target-neutral handler signature', () => {
  test('handleFlowsCommand accepts AutomationTarget, not BrowserTarget', () => {
    const flows = readSrc('commands/meta/flows.ts');
    // The function signature should accept AutomationTarget
    expect(flows).toContain('target: AutomationTarget');
    // Should not accept bm: BrowserTarget as first target param
    expect(flows).not.toMatch(/handleFlowsCommand[\s\S]*?bm:\s*BrowserTarget/);
  });

  test('handleMetaCommand accepts AutomationTarget', () => {
    const index = readSrc('commands/meta/index.ts');
    expect(index).toContain('target: AutomationTarget');
    // The cast to BrowserTarget is lazy (only when needed for browser-specific handlers)
    expect(index).toContain('const bm = () => target as BrowserTarget');
  });
});

// ─── Recording lifecycle integration ─────────────────────────────

describe('Unified workflow: recording lifecycle integration', () => {
  test('record start/stop lifecycle works with session', async () => {
    const mockTarget = createMockAppTarget();
    const session = makeSession(mockTarget);

    // Start recording
    const startResult = await handleRecordingCommand('record', ['start'], mockTarget, session);
    expect(startResult).toContain('Recording started');
    expect(session.recording).toEqual([]);

    // Manually push steps (simulating what lifecycle hooks do)
    session.recording!.push(
      { command: 'snapshot', args: ['-i'], timestamp: 1 },
      { command: 'click', args: ['@e1'], timestamp: 2 },
    );

    // Check status
    const statusResult = await handleRecordingCommand('record', ['status'], mockTarget, session);
    expect(statusResult).toContain('2 steps captured');

    // Stop recording
    const stopResult = await handleRecordingCommand('record', ['stop'], mockTarget, session);
    expect(stopResult).toContain('2 steps captured');
    expect(session.recording).toBeNull();
    expect(session.lastRecording).toHaveLength(2);
  });

  test('export after stop uses lastRecording', async () => {
    const mockTarget = createMockAppTarget();
    const session = makeSession(mockTarget, {
      recording: null,
      lastRecording: [
        { command: 'goto', args: ['https://example.com'], timestamp: 1 },
        { command: 'text', args: [], timestamp: 2 },
      ],
    });

    // Export should use lastRecording when recording is null
    const result = await handleRecordingCommand('record', ['export', 'browse'], mockTarget, session);
    const parsed = JSON.parse(result) as string[][];
    expect(parsed).toHaveLength(2);
    expect(parsed[0][0]).toBe('goto');
    expect(parsed[1][0]).toBe('text');
  });

  test('export with no recording and no lastRecording throws', async () => {
    const mockTarget = createMockAppTarget();
    const session = makeSession(mockTarget);

    await expect(
      handleRecordingCommand('record', ['export', 'browse'], mockTarget, session),
    ).rejects.toThrow(/No recording to export/);
  });
});
