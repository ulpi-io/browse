/**
 * Integration tests for v2.2 toolkit features — TASK-044
 *
 * Covers:
 *   - SDK: createBrowser returns working API, goto + text returns content
 *   - Custom detection: loads from .browse/detections/, malformed JSON warns
 *   - Custom rules: loadCustomRules, evaluateMetricRules pass/fail/malformed
 *   - BrowseConfig: all new fields are optional
 *   - Flow save/run roundtrip
 */

import { describe, test, expect, afterAll } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { loadCustomRules, evaluateMetricRules } from '../src/automation/rules';
import type { CustomRule } from '../src/automation/rules';
import type { BrowseConfig } from '../src/config';
import type { Session } from '../src/session/manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const shutdown = async () => {};

// Track temp directories for cleanup
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** Create a temp directory and track it for cleanup */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `browse-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** Minimal Session for tests that need session context */
function makeSession(recording?: { command: string; args: string[] }[]): Session {
  const session: Session = {
    id: 'test-v2.2',
    manager: bm as any,
    buffers: bm.getBuffers(),
    domainFilter: null,
    recording: recording ?? null,
    outputDir: '/tmp',
    lastActivity: Date.now(),
    createdAt: Date.now(),
    contextLevel: 'off',
    settleMode: false,
  };
  return session;
}

// ─── SDK tests ──────────────────────────────────────────────────

describe('SDK', () => {
  test('createBrowser returns working API', async () => {
    const { createBrowser } = await import('../src/sdk');
    const browser = await createBrowser();

    try {
      // goto test server page
      const gotoResult = await browser.goto(baseUrl + '/basic.html');
      expect(gotoResult).toBeTruthy();

      // text returns page content
      const text = await browser.text();
      expect(text).toContain('Hello World');

      // close completes without error
    } finally {
      await browser.close();
    }
  });

  test('goto + text returns page content', async () => {
    const { createBrowser } = await import('../src/sdk');
    const browser = await createBrowser();

    try {
      await browser.goto(baseUrl + '/basic.html');
      const text = await browser.text();

      expect(text).toContain('Hello World');
      expect(text).toContain('highlighted paragraph');
      expect(text).toContain('Item one');
    } finally {
      await browser.close();
    }
  });
});

// ─── Custom detection ───────────────────────────────────────────

describe('Custom detection', () => {
  test('loads from .browse/detections/', async () => {
    const tmpDir = makeTempDir('detect');
    const detectionsDir = path.join(tmpDir, 'detections');
    fs.mkdirSync(detectionsDir, { recursive: true });

    // Write a valid custom detection signature
    const sig = {
      version: 1,
      name: 'TestFramework',
      detect: 'true',  // always detected
      versionExpr: '"1.0.0"',
      category: 'test-framework',
    };
    fs.writeFileSync(path.join(detectionsDir, 'test-fw.json'), JSON.stringify(sig), 'utf-8');

    // Use the detectStack function with our temp dir
    const { detectStack } = await import('../src/detection/index');

    // Navigate first to have a page
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();

    const fingerprint = await detectStack(page, [], tmpDir);
    // Custom detection should have found our test framework
    const customEntry = fingerprint.custom.find(c => c.name === 'TestFramework');
    expect(customEntry).toBeDefined();
    expect(customEntry!.version).toBe('1.0.0');
    expect(customEntry!.category).toBe('test-framework');
    expect(customEntry!.label).toBe('[custom]');
  });

  test('malformed JSON warns but does not crash', async () => {
    const tmpDir = makeTempDir('detect-bad');
    const detectionsDir = path.join(tmpDir, 'detections');
    fs.mkdirSync(detectionsDir, { recursive: true });

    // Write malformed JSON
    fs.writeFileSync(path.join(detectionsDir, 'bad.json'), '{ this is not valid json }', 'utf-8');
    // Write valid but missing required fields
    fs.writeFileSync(path.join(detectionsDir, 'incomplete.json'), '{"version": 1}', 'utf-8');

    // Capture stderr
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as any;

    try {
      const { detectStack } = await import('../src/detection/index');
      await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
      const page = bm.getPage();

      // This should not throw
      const fingerprint = await detectStack(page, [], tmpDir);
      expect(fingerprint).toBeDefined();
      expect(fingerprint.custom).toEqual([]); // No valid customs

      // Warnings should have been emitted to stderr
      const warnings = stderrChunks.join('');
      expect(warnings).toContain('bad.json');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ─── Custom rules ───────────────────────────────────────────────

describe('Custom rules', () => {
  test('loadCustomRules loads valid rules', () => {
    const tmpDir = makeTempDir('rules');
    const rulesDir = path.join(tmpDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });

    const rule: CustomRule = {
      version: 1,
      name: 'LCP Budget',
      target: 'perf-audit',
      kind: 'metric-threshold',
      metric: 'lcp',
      threshold: 2000,
      severity: 'critical',
    };
    fs.writeFileSync(path.join(rulesDir, 'lcp-budget.json'), JSON.stringify(rule), 'utf-8');

    const { rules, warnings } = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe('LCP Budget');
    expect(rules[0].metric).toBe('lcp');
    expect(rules[0].threshold).toBe(2000);
    expect(warnings).toHaveLength(0);
  });

  test('evaluateMetricRules passes under budget', () => {
    const rules: CustomRule[] = [
      {
        version: 1,
        name: 'LCP Budget',
        target: 'perf-audit',
        kind: 'metric-threshold',
        metric: 'lcp',
        threshold: 2500,
      },
      {
        version: 1,
        name: 'CLS Budget',
        target: 'perf-audit',
        kind: 'metric-threshold',
        metric: 'cls',
        threshold: 0.1,
      },
    ];
    // Set __source for test
    (rules[0] as any).__source = 'lcp.json';
    (rules[1] as any).__source = 'cls.json';

    const metrics = { lcp: 1500, cls: 0.05 };
    const results = evaluateMetricRules(rules, metrics);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.passed)).toBe(true);
  });

  test('evaluateMetricRules fails over budget', () => {
    const rules: CustomRule[] = [
      {
        version: 1,
        name: 'LCP Budget',
        target: 'perf-audit',
        kind: 'metric-threshold',
        metric: 'lcp',
        threshold: 2000,
      },
    ];
    (rules[0] as any).__source = 'lcp.json';

    const metrics = { lcp: 5000 };
    const results = evaluateMetricRules(rules, metrics);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].actual).toBe('5000');
  });

  test('malformed JSON warns but does not crash', () => {
    const tmpDir = makeTempDir('rules-bad');
    const rulesDir = path.join(tmpDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });

    // Malformed JSON
    fs.writeFileSync(path.join(rulesDir, 'bad.json'), '{ not valid }', 'utf-8');
    // Valid JSON but wrong version
    fs.writeFileSync(path.join(rulesDir, 'wrong-ver.json'), '{"version": 99, "name": "test", "target": "perf-audit", "kind": "metric-threshold"}', 'utf-8');
    // Valid JSON but missing required fields
    fs.writeFileSync(path.join(rulesDir, 'incomplete.json'), '{"version": 1}', 'utf-8');

    const { rules, warnings } = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(0);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some(w => w.includes('bad.json'))).toBe(true);
    expect(warnings.some(w => w.includes('wrong-ver.json'))).toBe(true);
    expect(warnings.some(w => w.includes('incomplete.json'))).toBe(true);
  });

  test('loadCustomRules returns empty for missing directory', () => {
    const tmpDir = makeTempDir('rules-empty');
    // No rules/ subdirectory exists
    const { rules, warnings } = loadCustomRules(tmpDir);
    expect(rules).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

// ─── BrowseConfig ───────────────────────────────────────────────

describe('BrowseConfig', () => {
  test('all new fields are optional', () => {
    // Type-level check: an empty config object must be assignable to BrowseConfig
    const config: BrowseConfig = {};
    expect(config).toBeDefined();

    // All v2.2 fields should be optional (no required fields)
    const fullConfig: BrowseConfig = {
      session: 'test',
      json: true,
      contentBoundaries: true,
      allowedDomains: ['example.com'],
      idleTimeout: 5000,
      viewport: '1920x1080',
      device: 'iPhone 15',
      context: true,
      networkBodies: false,
      defaultSession: 'default',
      defaultContext: 'full',
      startupFlows: ['init.yaml'],
      detectionPaths: ['/custom/detections'],
      rulePaths: ['/custom/rules'],
      flowPaths: ['/custom/flows'],
    };
    expect(fullConfig.detectionPaths).toEqual(['/custom/detections']);
    expect(fullConfig.rulePaths).toEqual(['/custom/rules']);
    expect(fullConfig.flowPaths).toEqual(['/custom/flows']);
    expect(fullConfig.startupFlows).toEqual(['init.yaml']);
  });
});

// ─── Flow save/run roundtrip ────────────────────────────────────

describe('Flow save/run roundtrip', () => {
  test('save a recording then run it back', async () => {
    // The flows module reads BROWSE_LOCAL_DIR at import time as a module-level
    // constant, so we must use the same directory it resolves to.
    // When BROWSE_LOCAL_DIR is unset, it defaults to '/tmp'.
    const localDir = process.env.BROWSE_LOCAL_DIR || '/tmp';
    const flowName = `roundtrip-${Date.now()}`;
    const savedPath = path.join(localDir, 'flows', `${flowName}.yaml`);

    try {
      // Create a session with a recording
      const recording = [
        { command: 'goto', args: [baseUrl + '/basic.html'], timestamp: 1 },
        { command: 'text', args: [], timestamp: 2 },
      ];
      const session = makeSession(recording);

      // Save the recording as a named flow
      const saveResult = await handleMetaCommand('flow', ['save', flowName], bm, shutdown, undefined, session);
      expect(saveResult).toContain('Flow saved');
      expect(saveResult).toContain('2 steps');

      // Verify the file exists
      expect(fs.existsSync(savedPath)).toBe(true);

      // Run the saved flow back
      const runResult = await handleMetaCommand('flow', ['run', flowName], bm, shutdown, undefined, session);
      expect(runResult).toContain('Flow complete');
      expect(runResult).toContain('2/2 steps passed');
    } finally {
      // Clean up the saved flow file
      try { fs.unlinkSync(savedPath); } catch {}
    }
  });
});
