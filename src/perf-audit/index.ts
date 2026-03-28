/**
 * Performance audit orchestrator -- ties together Web Vitals collection,
 * resource analysis, DOM complexity measurement, coverage, and stack
 * detection into a single actionable report.
 *
 * The audit flow:
 *   1. Inject Web Vitals init script into the browser context
 *   2. Optionally start code coverage (JS + CSS)
 *   3. Reload the page to trigger fresh observers
 *   4. Collect all metrics in parallel (web vitals, resources, DOM)
 *   5. Optionally detect the technology stack
 *   6. Stop coverage and compute unused bytes
 *   7. Cross-reference metrics into a correlation report
 *   8. Separate findings into fixable items vs platform limitations
 */

import type { BrowserTarget } from '../browser/target';
import type { CoverageEntry } from '../browser/manager';
import type { NetworkEntry } from '../network/buffers';
import type { WebVitalsReport } from './web-vitals';
import type { ResourceReport } from './resource-analyzer';
import type { DOMComplexityReport, CorrelationReport } from './dom-analysis';
import type { StackFingerprint, DetectedSaaS } from '../detection';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PerfAuditOptions {
  /** Collect JS and CSS coverage data (default: true) */
  includeCoverage?: boolean;
  /** Run stack/framework/SaaS detection (default: true) */
  includeDetection?: boolean;
}

// ---------------------------------------------------------------------------
// Budget types and pure evaluator
// ---------------------------------------------------------------------------

/**
 * Performance budget thresholds.
 * Keys are metric names (case-insensitive), values are numeric thresholds.
 * Supported keys: lcp, cls, tbt, fcp, ttfb, inp
 */
export type PerfBudget = Record<string, number>;

export interface BudgetLineResult {
  /** Metric key (lowercase), e.g. "lcp" */
  key: string;
  /** The measured value (null means metric was not available — skipped) */
  measured: number | null;
  /** The budget threshold */
  threshold: number;
  /** true = metric was not measured, skip rather than fail */
  skipped: boolean;
  /** true = metric passes budget, false = exceeds budget */
  passed: boolean;
}

export interface BudgetEvalResult {
  lines: BudgetLineResult[];
  /** true when all non-skipped metrics pass their budgets */
  allPassed: boolean;
}

/** Supported budget metric keys (lowercase). */
const BUDGET_KEYS = new Set(['lcp', 'cls', 'tbt', 'fcp', 'ttfb', 'inp']);

/**
 * Parse a budget string like "lcp:2500,cls:0.1,tbt:300" into a Record.
 * Unknown keys are silently ignored. Throws on malformed numeric values.
 */
export function parseBudget(raw: string): PerfBudget {
  const budget: PerfBudget = {};
  const parts = raw.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 1) throw new Error(`Invalid budget entry "${trimmed}" — expected key:value`);
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const rawVal = trimmed.slice(colon + 1).trim();
    const val = Number(rawVal);
    if (!isFinite(val)) throw new Error(`Invalid budget value for "${key}": "${rawVal}"`);
    if (BUDGET_KEYS.has(key)) {
      budget[key] = val;
    }
    // silently skip unknown keys
  }
  return budget;
}

/**
 * Evaluate measured web vitals against a budget.
 * Pure function — deterministic, no I/O, safe to unit-test with fixed fixtures.
 *
 * @param vitals - Partial map of metric key -> measured value (null = not measured)
 * @param budget - Budget thresholds (from parseBudget)
 */
export function evaluateBudget(
  vitals: Partial<Record<string, number | null>>,
  budget: PerfBudget,
): BudgetEvalResult {
  const lines: BudgetLineResult[] = [];
  let allPassed = true;

  for (const [key, threshold] of Object.entries(budget)) {
    const measured = Object.prototype.hasOwnProperty.call(vitals, key)
      ? (vitals[key] ?? null)
      : null;

    if (measured === null) {
      // Metric not available — skip, do not fail
      lines.push({ key, measured: null, threshold, skipped: true, passed: true });
      continue;
    }

    const passed = measured <= threshold;
    if (!passed) allPassed = false;
    lines.push({ key, measured, threshold, skipped: false, passed });
  }

  return { lines, allPassed };
}

export interface CoverageResult {
  js: Array<{
    url: string;
    totalBytes: number;
    usedBytes: number;
    unusedBytes: number;
    unusedPct: number;
  }>;
  css: Array<{
    url: string;
    totalBytes: number;
    usedBytes: number;
    unusedBytes: number;
    unusedPct: number;
  }>;
}

export type SectionStatus = 'ok' | 'partial' | 'skipped' | 'failed';

export interface PerfAuditReport {
  webVitals: WebVitalsReport;
  resources: ResourceReport;
  domComplexity: DOMComplexityReport;
  correlations: CorrelationReport;
  detection: StackFingerprint | null;
  coverage: CoverageResult | null;
  /** Actionable items the developer can fix */
  fixable: string[];
  /** Things constrained by the platform (SaaS/hosted) */
  platformLimitations: string[];
  /** Per-section status — tells agents exactly what worked and what didn't */
  status: {
    reload: SectionStatus;
    webVitals: SectionStatus;
    resources: SectionStatus;
    domComplexity: SectionStatus;
    detection: SectionStatus;
    coverage: SectionStatus;
    correlations: SectionStatus;
  };
  /** Human-readable warnings about partial failures or fallbacks */
  warnings: string[];
  /** Timing breakdown in ms — how long each phase took */
  timing: {
    totalMs: number;
    reloadMs: number;
    settleMs: number;
    collectMs: number;
    detectionMs: number;
    coverageMs: number;
  };
}

// ---------------------------------------------------------------------------
// Coverage conversion
// ---------------------------------------------------------------------------

/**
 * Convert raw CoverageEntry arrays from BrowserManager into the
 * CoverageResult shape expected by the report.
 */
function toCoverageResult(raw: {
  js: CoverageEntry[];
  css: CoverageEntry[];
}): CoverageResult {
  const map = (entries: CoverageEntry[]) =>
    entries.map((e) => ({
      url: e.url,
      totalBytes: e.totalBytes,
      usedBytes: e.usedBytes,
      unusedBytes: e.unusedBytes,
      unusedPct: e.unusedPct,
    }));

  return { js: map(raw.js), css: map(raw.css) };
}

// ---------------------------------------------------------------------------
// Fixable / Platform-limitation builder
// ---------------------------------------------------------------------------

/** Size threshold (bytes) above which a third-party script is "large". */
const LARGE_THIRD_PARTY_KB = 100;

/** Coverage threshold: flag files with more than 50% unused bytes. */
const UNUSED_COVERAGE_PCT = 50;

/**
 * Separate audit findings into things the developer can fix vs things
 * constrained by the hosting platform.
 *
 * When a SaaS platform is detected its `constraints.canFix` and
 * `constraints.cannotFix` arrays drive the split. When no SaaS is
 * detected everything is considered fixable.
 */
function buildFixableList(
  detection: StackFingerprint | null,
  webVitals: WebVitalsReport,
  resources: ResourceReport,
  correlations: CorrelationReport,
  coverage: CoverageResult | null,
): { fixable: string[]; platformLimitations: string[] } {
  const fixable: string[] = [];
  const platformLimitations: string[] = [];

  // Collect all detected SaaS platforms (may be empty)
  const saasItems: DetectedSaaS[] = detection?.saas ?? [];
  const hasSaaS = saasItems.length > 0;

  // Aggregate cannotFix items from all detected SaaS platforms
  const cannotFixSet = new Set<string>();
  for (const saas of saasItems) {
    for (const item of saas.constraints.cannotFix) {
      cannotFixSet.add(item);
    }
  }

  // Helper: route a finding to fixable or platformLimitations
  const addFinding = (finding: string): void => {
    if (hasSaaS && cannotFixSet.has(finding)) {
      platformLimitations.push(finding);
    } else {
      fixable.push(finding);
    }
  };

  // ── Framework / SaaS perf hints (critical + warning only) ──────────

  if (detection) {
    for (const fw of detection.frameworks) {
      for (const hint of fw.perfHints) {
        if (hint.severity === 'critical' || hint.severity === 'warning') {
          addFinding(hint.message);
        }
      }
    }

    for (const saas of detection.saas) {
      for (const hint of saas.perfHints) {
        if (hint.severity === 'critical' || hint.severity === 'warning') {
          addFinding(hint.message);
        }
      }

      // SaaS canFix items are always fixable
      for (const item of saas.constraints.canFix) {
        fixable.push(item);
      }

      // SaaS cannotFix items are always platform limitations
      for (const item of saas.constraints.cannotFix) {
        // Avoid duplicates -- only add if not already added by the set
        if (!platformLimitations.includes(item)) {
          platformLimitations.push(item);
        }
      }
    }
  }

  // ── Image audit issues ─────────────────────────────────────────────

  for (const img of resources.imageAudit) {
    for (const issue of img.issues) {
      addFinding(`Image "${urlFilename(img.src)}": ${issue}`);
    }
  }

  // ── Render-blocking resources ──────────────────────────────────────

  for (const rb of resources.renderBlocking) {
    const typeLabel = rb.type === 'stylesheet' ? 'CSS' : 'JS';
    const sizeLabel =
      rb.sizeBytes != null
        ? ` (${(rb.sizeBytes / 1024).toFixed(0)}KB)`
        : '';
    addFinding(
      `Render-blocking ${typeLabel}: ${urlFilename(rb.url)}${sizeLabel}`,
    );
  }

  // ── Unused coverage (>50% unused) ──────────────────────────────────

  if (coverage) {
    const allCoverage = [...coverage.js, ...coverage.css];
    for (const entry of allCoverage) {
      if (
        entry.unusedPct > UNUSED_COVERAGE_PCT &&
        entry.totalBytes > 1024 // skip tiny files
      ) {
        const isJS = coverage.js.includes(entry);
        const typeLabel = isJS ? 'JS' : 'CSS';
        addFinding(
          `${typeLabel} "${urlFilename(entry.url)}": ${entry.unusedPct.toFixed(0)}% unused (${(entry.unusedBytes / 1024).toFixed(0)}KB wasted)`,
        );
      }
    }
  }

  // ── Large third-party scripts ──────────────────────────────────────

  for (const [domain, stats] of Object.entries(
    resources.thirdPartyByDomain,
  )) {
    const sizeKB = stats.totalSizeBytes / 1024;
    if (sizeKB > LARGE_THIRD_PARTY_KB) {
      addFinding(
        `Large third-party: ${domain} (${sizeKB.toFixed(0)}KB across ${stats.count} requests)`,
      );
    }
  }

  // ── Missing preconnect for third-party origins ─────────────────────

  const thirdPartyDomains = Object.keys(resources.thirdPartyByDomain);
  if (thirdPartyDomains.length > 0) {
    // Only flag the top 3 heaviest third-party domains
    const sortedDomains = thirdPartyDomains
      .map((d) => ({
        domain: d,
        size: resources.thirdPartyByDomain[d].totalSizeBytes,
      }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 3);

    for (const { domain } of sortedDomains) {
      addFinding(
        `Consider <link rel="preconnect"> for ${domain}`,
      );
    }
  }

  // ── Font FOIT risks ────────────────────────────────────────────────

  for (const font of resources.fontAudit) {
    if (font.foitRisk) {
      const displayHint = font.fontDisplay
        ? `font-display: ${font.fontDisplay}`
        : 'no font-display set';
      addFinding(
        `Font "${font.family}" (${font.weight}): FOIT risk (${displayHint})`,
      );
    }
  }

  // ── DOM complexity warnings ────────────────────────────────────────

  // Thresholds from Lighthouse recommendations
  if (webVitals.tbt != null && webVitals.tbt > 300) {
    addFinding(
      `High Total Blocking Time: ${webVitals.tbt}ms (target: <300ms)`,
    );
  }

  if (webVitals.lcp != null && webVitals.lcp > 2500) {
    addFinding(
      `Slow Largest Contentful Paint: ${webVitals.lcp}ms (target: <2500ms)`,
    );
  }

  if (webVitals.cls != null && webVitals.cls > 0.1) {
    addFinding(
      `High Cumulative Layout Shift: ${webVitals.cls} (target: <0.1)`,
    );
  }

  // ── Platform runtime JS that cannot be removed ─────────────────────

  if (detection) {
    for (const saas of detection.saas) {
      // Check for platform runtime scripts in third-party inventory
      for (const tp of detection.thirdParty) {
        // If the third-party domain matches the SaaS platform name
        // (heuristic), flag its JS as a platform limitation
        if (
          tp.domain
            .toLowerCase()
            .includes(saas.name.toLowerCase().replace(/\s+/g, ''))
        ) {
          if (tp.totalSizeKB > 0) {
            const msg = `Platform runtime JS: ${tp.domain} (${tp.totalSizeKB.toFixed(0)}KB) -- required by ${saas.name}`;
            if (!platformLimitations.includes(msg)) {
              platformLimitations.push(msg);
            }
          }
        }
      }
    }
  }

  return { fixable, platformLimitations };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract just the filename from a URL pathname, or return the full URL. */
function urlFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const i = pathname.lastIndexOf('/');
    return i !== -1 && i < pathname.length - 1 ? pathname.slice(i + 1) : url;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run a full performance audit on the current page. Collects Web Vitals,
 * analyzes resources, measures DOM complexity, optionally collects
 * coverage and detects the technology stack, then cross-references
 * everything into a single actionable report.
 *
 * The page is reloaded as part of the audit to inject the Web Vitals
 * init script and collect fresh data.
 *
 * @param bm - BrowserManager with an active page
 * @param networkEntries - Network entries from the session buffer
 * @param options - Optional flags to skip coverage or detection
 */
export async function runPerfAudit(
  bm: BrowserTarget,
  networkEntries: NetworkEntry[],
  options: PerfAuditOptions = {},
): Promise<PerfAuditReport> {
  const { includeCoverage = true, includeDetection = true } = options;
  const page = bm.getPage();
  const context = bm.getContext();

  const savedUrl = page.url();
  const warnings: string[] = [];
  const status: PerfAuditReport['status'] = {
    reload: 'failed',
    webVitals: 'failed',
    resources: 'failed',
    domComplexity: 'failed',
    detection: includeDetection ? 'failed' : 'skipped',
    coverage: includeCoverage ? 'failed' : 'skipped',
    correlations: 'failed',
  };
  const timing: PerfAuditReport['timing'] = {
    totalMs: 0, reloadMs: 0, settleMs: 0,
    collectMs: 0, detectionMs: 0, coverageMs: 0,
  };
  const totalStart = Date.now();

  // Lazy imports — only loaded when perf-audit runs, not on server startup
  const { WEB_VITALS_INIT_SCRIPT, collectWebVitals } = await import('./web-vitals');
  const { analyzeResources } = await import('./resource-analyzer');
  const { analyzeDOMComplexity, buildCorrelationReport } = await import('./dom-analysis');

  // Defaults for sections that might fail — ensures we always return a report
  let webVitals!: WebVitalsReport;
  let resources!: ResourceReport;
  let domComplexity!: DOMComplexityReport;
  let correlations!: CorrelationReport;
  let detection: StackFingerprint | null = null;
  let coverage: CoverageResult | null = null;

  try {
    // ── 1. Inject Web Vitals observers ──────────────────────────────
    if (context) {
      await context.addInitScript(WEB_VITALS_INIT_SCRIPT);
    }

    // ── 2. Start coverage (before reload so it captures everything) ─
    let coverageStarted = false;
    if (includeCoverage) {
      try {
        await bm.startCoverage();
        coverageStarted = true;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Coverage start failed: ${msg}`);
        status.coverage = 'failed';
      }
    }

    // ── 3. Reload ───────────────────────────────────────────────────
    //    Race networkidle against a 10s cap. Real-world pages with
    //    analytics/ads/WebSockets never reach idle — this ensures we
    //    always proceed. Fully automatic, no agent input needed.
    const reloadStart = Date.now();
    let networkIdleReached = false;
    try {
      await Promise.race([
        page.reload({ waitUntil: 'networkidle' }).then(() => { networkIdleReached = true; }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('networkidle timeout')), 10000)
        ),
      ]);
      status.reload = 'ok';
    } catch {
      // networkidle timed out — page has continuous network activity
      await page.waitForLoadState('load').catch(() => {});
      status.reload = 'partial';
      warnings.push('networkidle timed out after 10s (page has continuous analytics/tracking) — fell back to load event. Web Vitals data may be slightly less complete.');
    }
    timing.reloadMs = Date.now() - reloadStart;

    // ── 4. Settle ───────────────────────────────────────────────────
    //    LCP is finalized after a quiet period, font swaps cause late
    //    layout shifts, lazy images trigger observations. 2s if network
    //    settled, 3s if it didn't (more time for late observers).
    const settleMs = networkIdleReached ? 2000 : 3000;
    const settleStart = Date.now();
    await page.waitForTimeout(settleMs);
    timing.settleMs = Date.now() - settleStart;

    // ── 5. Collect all analysis in parallel ──────────────────────────
    const collectStart = Date.now();
    const results = await Promise.allSettled([
      collectWebVitals(page),
      analyzeResources(networkEntries, page),
      analyzeDOMComplexity(page),
    ]);

    // Web Vitals
    if (results[0].status === 'fulfilled') {
      webVitals = results[0].value;
      status.webVitals = webVitals.lcp !== null ? 'ok' : 'partial';
      if (status.webVitals === 'partial') {
        warnings.push('LCP not captured — page may not have had a contentful paint during measurement window.');
      }
    } else {
      warnings.push(`Web Vitals collection failed: ${results[0].reason?.message || results[0].reason}`);
      webVitals = { ttfb: 0, fcp: null, lcp: null, cls: null, tbt: null, inp: null, lcpElement: null, layoutShifts: [], longTasks: [], paintTimings: { fp: null, fcp: null } };
    }

    // Resources
    if (results[1].status === 'fulfilled') {
      resources = results[1].value;
      status.resources = 'ok';
    } else {
      warnings.push(`Resource analysis failed: ${results[1].reason?.message || results[1].reason}`);
      resources = { categories: {} as any, thirdPartyByDomain: {}, imageAudit: [], fontAudit: [], renderBlocking: [] };
    }

    // DOM Complexity
    if (results[2].status === 'fulfilled') {
      domComplexity = results[2].value;
      status.domComplexity = 'ok';
    } else {
      warnings.push(`DOM analysis failed: ${results[2].reason?.message || results[2].reason}`);
      domComplexity = { totalNodes: 0, maxDepth: 0, largestSubtree: null, htmlSizeKB: 0 };
    }
    timing.collectMs = Date.now() - collectStart;

    // ── 6. Detection (optional, non-fatal) ──────────────────────────
    if (includeDetection) {
      const detectStart = Date.now();
      try {
        const { detectStack } = await import('../detection');
        detection = await detectStack(page, networkEntries);
        status.detection = 'ok';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Stack detection failed: ${msg}`);
        status.detection = 'failed';
      }
      timing.detectionMs = Date.now() - detectStart;
    }

    // ── 7. Stop coverage ────────────────────────────────────────────
    if (coverageStarted) {
      const covStart = Date.now();
      try {
        const rawCoverage = await bm.stopCoverage();
        coverage = toCoverageResult(rawCoverage);
        status.coverage = 'ok';
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Coverage collection failed: ${msg}`);
        status.coverage = 'failed';
      }
      timing.coverageMs = Date.now() - covStart;
    }

    // ── 8. Correlations ─────────────────────────────────────────────
    try {
      correlations = buildCorrelationReport(webVitals, resources, networkEntries);
      status.correlations = correlations.lcpAnalysis ? 'ok' : 'partial';
      if (status.correlations === 'partial' && webVitals.lcpElement) {
        warnings.push('LCP correlation incomplete: LCP element found but could not be matched to a network entry. Resource timing data may be limited.');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`Correlation analysis failed: ${msg}`);
      correlations = { lcpAnalysis: null, clsAttribution: [], longTaskAttribution: [], fontBlockingFcp: [] };
    }

    // ── 9. Fixable vs platform limitations ──────────────────────────
    const { fixable, platformLimitations } = buildFixableList(
      detection, webVitals, resources, correlations, coverage,
    );

    timing.totalMs = Date.now() - totalStart;

    return {
      webVitals, resources, domComplexity, correlations,
      detection, coverage, fixable, platformLimitations,
      status, warnings, timing,
    };
  } catch (e: unknown) {
    // Total failure — try to recover the page, return what we have
    try {
      if (savedUrl && savedUrl !== 'about:blank') {
        await page.goto(savedUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    } catch {}

    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`Audit aborted: ${msg}`);
    timing.totalMs = Date.now() - totalStart;

    // Return partial report with whatever we collected
    return {
      webVitals: webVitals || { ttfb: 0, fcp: null, lcp: null, cls: null, tbt: null, inp: null, lcpElement: null, layoutShifts: [], longTasks: [], paintTimings: { fp: null, fcp: null } },
      resources: resources || { categories: {} as any, thirdPartyByDomain: {}, imageAudit: [], fontAudit: [], renderBlocking: [] },
      domComplexity: domComplexity || { totalNodes: 0, maxDepth: 0, largestSubtree: null, htmlSizeKB: 0 },
      correlations: correlations || { lcpAnalysis: null, clsAttribution: [], longTaskAttribution: [], fontBlockingFcp: [] },
      detection, coverage, fixable: [], platformLimitations: [],
      status, warnings, timing,
    };
  }
}
