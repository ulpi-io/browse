/**
 * Diff engine for perf-audit reports.
 *
 * Compares two PerfAuditReport snapshots (baseline vs current) and produces
 * a structured diff with regression/improvement detection. Thresholds are
 * aligned with Web Vitals "good" boundaries so small natural variance does
 * not trigger false positives.
 */

import type { PerfAuditReport, CoverageResult } from './index';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MetricDelta {
  metric: string;
  baseline: number | null;
  current: number | null;
  /** Absolute change (current - baseline) for timing/size metrics */
  deltaMs?: number;
  /** Percentage change ((current - baseline) / baseline * 100) */
  deltaPct?: number;
  verdict: 'regression' | 'improvement' | 'unchanged' | 'new' | 'missing';
}

export interface AuditDiff {
  webVitals: MetricDelta[];
  resourceSize: MetricDelta[];
  coverage: MetricDelta[];
  fixableCount: { baseline: number; current: number; delta: number };
  summary: { regressions: number; improvements: number; unchanged: number };
}

// ---------------------------------------------------------------------------
// Thresholds — aligned with Web Vitals "good" boundaries
// ---------------------------------------------------------------------------

/**
 * Per-metric threshold that must be exceeded (in either direction) before a
 * change is classified as a regression or improvement.  Values are absolute
 * (ms for timing metrics, unitless for CLS, percentage-points for coverage,
 * and fractional for resource-size percentage).
 */
interface Threshold {
  /** Absolute threshold for timing metrics (ms) or unitless for CLS */
  absolute: number;
}

const WEB_VITALS_THRESHOLDS: Record<string, Threshold> = {
  ttfb: { absolute: 100 },
  fcp: { absolute: 100 },
  lcp: { absolute: 200 },
  cls: { absolute: 0.05 },
  tbt: { absolute: 100 },
  inp: { absolute: 50 },
};

/** Resource size regression/improvement threshold: 10% change */
const RESOURCE_SIZE_PCT_THRESHOLD = 10;

/** Coverage regression/improvement threshold: 5 percentage-point change */
const COVERAGE_PP_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a MetricDelta for two nullable numeric values using an absolute
 * threshold to decide the verdict.
 */
function compareMetric(
  metric: string,
  baseline: number | null,
  current: number | null,
  threshold: number,
): MetricDelta {
  // Both null -- nothing to compare
  if (baseline === null && current === null) {
    return { metric, baseline, current, verdict: 'unchanged' };
  }

  // Baseline missing, current present -- new metric
  if (baseline === null) {
    return { metric, baseline, current, verdict: 'new' };
  }

  // Baseline present, current missing -- metric disappeared
  if (current === null) {
    return { metric, baseline, current, verdict: 'missing' };
  }

  const deltaMs = current - baseline;
  const deltaPct = baseline !== 0 ? (deltaMs / baseline) * 100 : current !== 0 ? 100 : 0;

  let verdict: MetricDelta['verdict'] = 'unchanged';
  if (deltaMs > threshold) {
    verdict = 'regression';
  } else if (deltaMs < -threshold) {
    verdict = 'improvement';
  }

  return {
    metric,
    baseline,
    current,
    deltaMs: round(deltaMs),
    deltaPct: round(deltaPct),
    verdict,
  };
}

/**
 * Build a MetricDelta for resource sizes using a percentage threshold.
 * A >10% increase is a regression, a >10% decrease is an improvement.
 */
function compareResourceSize(
  metric: string,
  baseline: number | null,
  current: number | null,
): MetricDelta {
  if (baseline === null && current === null) {
    return { metric, baseline, current, verdict: 'unchanged' };
  }
  if (baseline === null) {
    return { metric, baseline, current, verdict: 'new' };
  }
  if (current === null) {
    return { metric, baseline, current, verdict: 'missing' };
  }

  const deltaMs = current - baseline;
  const deltaPct = baseline !== 0 ? (deltaMs / baseline) * 100 : current !== 0 ? 100 : 0;

  let verdict: MetricDelta['verdict'] = 'unchanged';
  if (deltaPct > RESOURCE_SIZE_PCT_THRESHOLD) {
    verdict = 'regression';
  } else if (deltaPct < -RESOURCE_SIZE_PCT_THRESHOLD) {
    verdict = 'improvement';
  }

  return {
    metric,
    baseline,
    current,
    deltaMs: round(deltaMs),
    deltaPct: round(deltaPct),
    verdict,
  };
}

/**
 * Build a MetricDelta for coverage unused-percentage using a
 * percentage-point threshold.  Higher unused% is worse (regression).
 */
function compareCoverage(
  metric: string,
  baseline: number | null,
  current: number | null,
): MetricDelta {
  if (baseline === null && current === null) {
    return { metric, baseline, current, verdict: 'unchanged' };
  }
  if (baseline === null) {
    return { metric, baseline, current, verdict: 'new' };
  }
  if (current === null) {
    return { metric, baseline, current, verdict: 'missing' };
  }

  // Delta in percentage-points (e.g. 45% -> 52% = +7pp)
  const deltaPP = current - baseline;
  const deltaPct = baseline !== 0 ? (deltaPP / baseline) * 100 : current !== 0 ? 100 : 0;

  let verdict: MetricDelta['verdict'] = 'unchanged';
  if (deltaPP > COVERAGE_PP_THRESHOLD) {
    verdict = 'regression';
  } else if (deltaPP < -COVERAGE_PP_THRESHOLD) {
    verdict = 'improvement';
  }

  return {
    metric,
    baseline,
    current,
    deltaMs: round(deltaPP),
    deltaPct: round(deltaPct),
    verdict,
  };
}

/**
 * Compute weighted-average unused percentage across coverage entries.
 * Returns null when the array is empty.
 */
function avgUnusedPct(
  entries: CoverageResult['js'] | CoverageResult['css'],
): number | null {
  if (entries.length === 0) return null;

  let totalBytes = 0;
  let unusedBytes = 0;
  for (const e of entries) {
    totalBytes += e.totalBytes;
    unusedBytes += e.unusedBytes;
  }

  return totalBytes > 0 ? round((unusedBytes / totalBytes) * 100) : 0;
}

/** Round a number to 2 decimal places. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main diff function
// ---------------------------------------------------------------------------

/**
 * Compare two PerfAuditReport snapshots and produce a structured diff.
 *
 * @param baseline - The earlier (reference) report
 * @param current  - The later (comparison) report
 * @returns AuditDiff with per-metric verdicts and a summary
 */
export function diffAuditReports(
  baseline: PerfAuditReport,
  current: PerfAuditReport,
): AuditDiff {
  // ── Web Vitals ─────────────────────────────────────────────────────────
  const webVitals: MetricDelta[] = [
    compareMetric('ttfb', baseline.webVitals.ttfb, current.webVitals.ttfb, WEB_VITALS_THRESHOLDS.ttfb.absolute),
    compareMetric('fcp', baseline.webVitals.fcp, current.webVitals.fcp, WEB_VITALS_THRESHOLDS.fcp.absolute),
    compareMetric('lcp', baseline.webVitals.lcp, current.webVitals.lcp, WEB_VITALS_THRESHOLDS.lcp.absolute),
    compareMetric('cls', baseline.webVitals.cls, current.webVitals.cls, WEB_VITALS_THRESHOLDS.cls.absolute),
    compareMetric('tbt', baseline.webVitals.tbt, current.webVitals.tbt, WEB_VITALS_THRESHOLDS.tbt.absolute),
    compareMetric('inp', baseline.webVitals.inp, current.webVitals.inp, WEB_VITALS_THRESHOLDS.inp.absolute),
  ];

  // ── Resource sizes by category ─────────────────────────────────────────
  const allCategoryKeys = new Set([
    ...Object.keys(baseline.resources.categories),
    ...Object.keys(current.resources.categories),
  ]);

  const resourceSize: MetricDelta[] = [];
  for (const key of allCategoryKeys) {
    const baselineBytes = baseline.resources.categories[key]?.totalSizeBytes ?? null;
    const currentBytes = current.resources.categories[key]?.totalSizeBytes ?? null;
    resourceSize.push(compareResourceSize(key, baselineBytes, currentBytes));
  }

  // ── Coverage (weighted average unused%) ────────────────────────────────
  const coverageDeltas: MetricDelta[] = [];

  const baselineJsUnused = baseline.coverage ? avgUnusedPct(baseline.coverage.js) : null;
  const currentJsUnused = current.coverage ? avgUnusedPct(current.coverage.js) : null;
  coverageDeltas.push(compareCoverage('js-unused-pct', baselineJsUnused, currentJsUnused));

  const baselineCssUnused = baseline.coverage ? avgUnusedPct(baseline.coverage.css) : null;
  const currentCssUnused = current.coverage ? avgUnusedPct(current.coverage.css) : null;
  coverageDeltas.push(compareCoverage('css-unused-pct', baselineCssUnused, currentCssUnused));

  // ── Fixable count ──────────────────────────────────────────────────────
  const fixableCount = {
    baseline: baseline.fixable.length,
    current: current.fixable.length,
    delta: current.fixable.length - baseline.fixable.length,
  };

  // ── Summary ────────────────────────────────────────────────────────────
  const allDeltas = [...webVitals, ...resourceSize, ...coverageDeltas];

  let regressions = 0;
  let improvements = 0;
  let unchanged = 0;

  for (const d of allDeltas) {
    switch (d.verdict) {
      case 'regression':
        regressions++;
        break;
      case 'improvement':
        improvements++;
        break;
      case 'unchanged':
        unchanged++;
        break;
      // 'new' and 'missing' are not counted in the summary totals
    }
  }

  return {
    webVitals,
    resourceSize,
    coverage: coverageDeltas,
    fixableCount,
    summary: { regressions, improvements, unchanged },
  };
}
