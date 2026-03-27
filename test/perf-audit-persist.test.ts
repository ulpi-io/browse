/**
 * Unit tests for perf-audit persistence (save/load/list/delete) and diff engine.
 *
 * These tests are self-contained — they use a temp directory for file I/O and
 * do not require a browser or test server.
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { saveAudit, loadAudit, listAudits, deleteAudit } from '../src/perf-audit/persist';
import { diffAuditReports } from '../src/perf-audit/diff';
import type { PerfAuditReport } from '../src/perf-audit/index';
import type { MetricDelta, AuditDiff } from '../src/perf-audit/diff';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PerfAuditReport.
 * Pass overrides for any top-level or nested fields you want to customise.
 */
function makeMockReport(overrides: {
  ttfb?: number;
  fcp?: number | null;
  lcp?: number | null;
  cls?: number | null;
  tbt?: number | null;
  inp?: number | null;
} = {}): PerfAuditReport {
  return {
    webVitals: {
      ttfb: overrides.ttfb ?? 120,
      fcp: overrides.fcp !== undefined ? overrides.fcp : 350,
      lcp: overrides.lcp !== undefined ? overrides.lcp : 1500,
      cls: overrides.cls !== undefined ? overrides.cls : 0.05,
      tbt: overrides.tbt !== undefined ? overrides.tbt : 80,
      inp: overrides.inp !== undefined ? overrides.inp : 40,
      lcpElement: null,
      layoutShifts: [],
      longTasks: [],
      paintTimings: { fp: null, fcp: null },
    },
    resources: {
      categories: {
        js: { count: 3, totalSizeBytes: 150_000, largest: null },
        css: { count: 2, totalSizeBytes: 30_000, largest: null },
      },
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    },
    domComplexity: {
      totalNodes: 500,
      maxDepth: 12,
      largestSubtree: null,
      htmlSizeKB: 25,
    },
    correlations: {
      lcpAnalysis: null,
      clsAttribution: [],
      longTaskAttribution: [],
      fontBlockingFcp: [],
    },
    detection: null,
    coverage: null,
    fixable: [],
    platformLimitations: [],
    status: {
      reload: 'ok',
      webVitals: 'ok',
      resources: 'ok',
      domComplexity: 'ok',
      detection: 'skipped',
      coverage: 'skipped',
      correlations: 'ok',
    },
    warnings: [],
    timing: {
      totalMs: 3500,
      reloadMs: 1200,
      settleMs: 2000,
      collectMs: 250,
      detectionMs: 0,
      coverageMs: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-persist-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ===========================================================================
// Persistence tests
// ===========================================================================

describe('perf-audit persistence', () => {
  test('saveAudit + loadAudit round-trip preserves all top-level keys', () => {
    const localDir = makeTmpDir();
    const report = makeMockReport();

    const filePath = saveAudit(localDir, 'round-trip', report);
    expect(fs.existsSync(filePath)).toBe(true);

    const loaded = loadAudit(localDir, 'round-trip');

    // Verify every top-level key matches
    expect(loaded.webVitals).toEqual(report.webVitals);
    expect(loaded.resources).toEqual(report.resources);
    expect(loaded.domComplexity).toEqual(report.domComplexity);
    expect(loaded.correlations).toEqual(report.correlations);
    expect(loaded.detection).toEqual(report.detection);
    expect(loaded.coverage).toEqual(report.coverage);
    expect(loaded.fixable).toEqual(report.fixable);
    expect(loaded.platformLimitations).toEqual(report.platformLimitations);
    expect(loaded.status).toEqual(report.status);
    expect(loaded.warnings).toEqual(report.warnings);
    expect(loaded.timing).toEqual(report.timing);
  });

  test('loadAudit throws with descriptive message for missing file', () => {
    const localDir = makeTmpDir();

    expect(() => loadAudit(localDir, 'nonexistent')).toThrowError(
      /Audit not found:.*nonexistent/,
    );
  });

  test('listAudits returns empty array when audits dir does not exist', () => {
    const localDir = makeTmpDir();
    // No audits saved, so the audits/ subdirectory does not exist
    const list = listAudits(localDir);
    expect(list).toEqual([]);
  });

  test('listAudits returns all saved audits sorted newest-first', () => {
    const localDir = makeTmpDir();
    const report = makeMockReport();

    // Save 3 audits with small delay so mtimes differ
    saveAudit(localDir, 'alpha', report);

    // Touch the file timestamp forward to guarantee ordering
    const alphaPath = path.join(localDir, 'audits', 'alpha.json');
    const past = new Date(Date.now() - 3000);
    fs.utimesSync(alphaPath, past, past);

    saveAudit(localDir, 'beta', report);
    const betaPath = path.join(localDir, 'audits', 'beta.json');
    const mid = new Date(Date.now() - 1000);
    fs.utimesSync(betaPath, mid, mid);

    saveAudit(localDir, 'gamma', report);
    // gamma is the newest (just written)

    const list = listAudits(localDir);
    expect(list).toHaveLength(3);

    // Verify sorted newest-first: gamma > beta > alpha
    expect(list[0].name).toBe('gamma');
    expect(list[1].name).toBe('beta');
    expect(list[2].name).toBe('alpha');

    // Each entry has the expected shape
    for (const entry of list) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('sizeBytes');
      expect(entry).toHaveProperty('date');
      expect(typeof entry.sizeBytes).toBe('number');
      expect(entry.sizeBytes).toBeGreaterThan(0);
      // date should be an ISO string
      expect(new Date(entry.date).toISOString()).toBe(entry.date);
    }
  });

  test('deleteAudit removes the file so loadAudit throws', () => {
    const localDir = makeTmpDir();
    const report = makeMockReport();

    saveAudit(localDir, 'to-delete', report);

    // Confirm it loads before deletion
    expect(() => loadAudit(localDir, 'to-delete')).not.toThrow();

    deleteAudit(localDir, 'to-delete');

    // Now loading should throw
    expect(() => loadAudit(localDir, 'to-delete')).toThrowError(
      /Audit not found/,
    );
  });

  test('deleteAudit throws when file does not exist', () => {
    const localDir = makeTmpDir();

    expect(() => deleteAudit(localDir, 'ghost')).toThrowError(
      /Audit not found:.*ghost/,
    );
  });
});

// ===========================================================================
// Diff tests
// ===========================================================================

describe('perf-audit diff', () => {
  /** Helper to find a MetricDelta by metric name in a delta array. */
  function findMetric(deltas: MetricDelta[], metric: string): MetricDelta {
    const found = deltas.find((d) => d.metric === metric);
    if (!found) throw new Error(`Metric "${metric}" not found in deltas`);
    return found;
  }

  test('identical reports produce zero regressions and all unchanged verdicts', () => {
    const report = makeMockReport();
    const diff = diffAuditReports(report, report);

    expect(diff.summary.regressions).toBe(0);
    expect(diff.summary.improvements).toBe(0);

    for (const delta of diff.webVitals) {
      expect(delta.verdict).toBe('unchanged');
    }
  });

  test('LCP regression: baseline 1500, current 2000 -> regression with deltaMs 500', () => {
    const baseline = makeMockReport({ lcp: 1500 });
    const current = makeMockReport({ lcp: 2000 });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('regression');
    expect(lcp.deltaMs).toBe(500);
    expect(lcp.baseline).toBe(1500);
    expect(lcp.current).toBe(2000);
  });

  test('LCP improvement: baseline 2500, current 1800 -> improvement', () => {
    const baseline = makeMockReport({ lcp: 2500 });
    const current = makeMockReport({ lcp: 1800 });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('improvement');
    expect(lcp.deltaMs).toBe(-700);
  });

  test('CLS regression: baseline 0.05, current 0.15 -> regression', () => {
    const baseline = makeMockReport({ cls: 0.05 });
    const current = makeMockReport({ cls: 0.15 });

    const diff = diffAuditReports(baseline, current);
    const cls = findMetric(diff.webVitals, 'cls');

    expect(cls.verdict).toBe('regression');
    // CLS threshold is 0.05, delta is 0.10 which exceeds threshold
    expect(cls.deltaMs).toBeCloseTo(0.1, 2);
  });

  test('null baseline metric: baseline LCP null, current 2000 -> new', () => {
    const baseline = makeMockReport({ lcp: null });
    const current = makeMockReport({ lcp: 2000 });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('new');
    expect(lcp.baseline).toBeNull();
    expect(lcp.current).toBe(2000);
  });

  test('null current metric: baseline LCP 2000, current null -> missing', () => {
    const baseline = makeMockReport({ lcp: 2000 });
    const current = makeMockReport({ lcp: null });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('missing');
    expect(lcp.baseline).toBe(2000);
    expect(lcp.current).toBeNull();
  });

  test('both null: baseline and current LCP both null -> unchanged', () => {
    const baseline = makeMockReport({ lcp: null });
    const current = makeMockReport({ lcp: null });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('unchanged');
    expect(lcp.baseline).toBeNull();
    expect(lcp.current).toBeNull();
    // No deltaMs or deltaPct when both are null
    expect(lcp.deltaMs).toBeUndefined();
    expect(lcp.deltaPct).toBeUndefined();
  });

  test('within threshold: LCP delta 100 < threshold 200 -> unchanged', () => {
    const baseline = makeMockReport({ lcp: 1500 });
    const current = makeMockReport({ lcp: 1600 });

    const diff = diffAuditReports(baseline, current);
    const lcp = findMetric(diff.webVitals, 'lcp');

    expect(lcp.verdict).toBe('unchanged');
    expect(lcp.deltaMs).toBe(100);
    // deltaPct should still be computed even though verdict is unchanged
    expect(lcp.deltaPct).toBeDefined();
  });
});
