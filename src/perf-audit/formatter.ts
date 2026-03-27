/**
 * Performance audit report formatter -- converts PerfAuditReport into
 * human-readable text output (14 sections) or JSON output.
 *
 * The text formatter uses Google's Web Vitals thresholds for rating each
 * metric, generates platform-aware recommendations when a SaaS platform
 * is detected, and separates fixable items from platform constraints.
 */

import type { PerfAuditReport, CoverageResult } from './index';
import type { WebVitalsReport } from './web-vitals';
import type {
  ImageAuditItem,
  FontAuditItem,
  RenderBlockingItem,
  ResourceReport,
} from './resource-analyzer';
import type { DOMComplexityReport, CorrelationReport } from './dom-analysis';
import type { StackFingerprint } from '../detection';
import { generateRecommendations } from './recommendations';

// ---------------------------------------------------------------------------
// Thresholds (Google Web Vitals)
// ---------------------------------------------------------------------------

type Rating = 'good' | 'needs improvement' | 'poor';

interface ThresholdPair {
  good: number;
  needsImprovement: number;
}

const THRESHOLDS: Record<string, ThresholdPair> = {
  lcp: { good: 2500, needsImprovement: 4000 },
  cls: { good: 0.1, needsImprovement: 0.25 },
  inp: { good: 200, needsImprovement: 500 },
  fcp: { good: 1800, needsImprovement: 3000 },
  ttfb: { good: 800, needsImprovement: 1800 },
  tbt: { good: 200, needsImprovement: 600 },
};

function ratingFor(metric: string, value: number): Rating {
  const t = THRESHOLDS[metric];
  if (!t) return 'good';
  if (value < t.good) return 'good';
  if (value < t.needsImprovement) return 'needs improvement';
  return 'poor';
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

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

/** Pad a string to a fixed width with spaces on the right. */
function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

/** Pad a string to a fixed width with spaces on the left. */
function padLeft(str: string, width: number): string {
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a PerfAuditReport for output. When `json` is true, returns the
 * report as pretty-printed JSON. Otherwise returns a human-readable text
 * report with 14 sections, platform-aware recommendations, and Google
 * Web Vitals ratings.
 */
export function formatPerfAudit(
  report: PerfAuditReport,
  json: boolean = false,
): string {
  if (json) return JSON.stringify(report, null, 2);
  return formatTextReport(report);
}

// ---------------------------------------------------------------------------
// Text report builder
// ---------------------------------------------------------------------------

function formatTextReport(report: PerfAuditReport): string {
  const sections: string[] = [];

  // 1. Core Web Vitals
  sections.push(formatWebVitals(report.webVitals));

  // 2. LCP Analysis
  const lcpSection = formatLcpAnalysis(report.correlations);
  if (lcpSection) sections.push(lcpSection);

  // 3. Layout Shifts
  const clsSection = formatLayoutShifts(report.correlations);
  if (clsSection) sections.push(clsSection);

  // 4. Long Tasks
  const longTaskSection = formatLongTasks(report.correlations);
  if (longTaskSection) sections.push(longTaskSection);

  // 5. Resource Breakdown
  sections.push(formatResources(report.resources));

  // 6. Render-Blocking
  const rbSection = formatRenderBlocking(report.resources.renderBlocking);
  if (rbSection) sections.push(rbSection);

  // 7. Coverage Summary
  const covSection = formatCoverage(report.coverage);
  if (covSection) sections.push(covSection);

  // 8. Image Audit
  const imgSection = formatImageAudit(report.resources.imageAudit);
  if (imgSection) sections.push(imgSection);

  // 9. Font Audit
  const fontSection = formatFontAudit(report.resources.fontAudit);
  if (fontSection) sections.push(fontSection);

  // 10. DOM Complexity
  sections.push(formatDOMComplexity(report.domComplexity));

  // 11. Stack Detection
  const stackSection = formatStackDetection(report.detection);
  if (stackSection) sections.push(stackSection);

  // 12. Third-Party Impact
  const tpSection = formatThirdParty(report.detection, report.correlations);
  if (tpSection) sections.push(tpSection);

  // 13. Fixable vs Platform Constraints
  const constraintSection = formatFixableVsConstraints(
    report.fixable,
    report.platformLimitations,
    report.detection,
  );
  if (constraintSection) sections.push(constraintSection);

  // 14. Top Recommendations
  const recSection = formatTopRecommendations(report);
  if (recSection) sections.push(recSection);

  // 15. Warnings (if any section had issues)
  if (report.warnings?.length) {
    const lines = ['Warnings:'];
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
    sections.push(lines.join('\n'));
  }

  // 16. Audit Timing
  if (report.timing) {
    const t = report.timing;
    const parts = [
      `reload: ${fmtMs(t.reloadMs)}`,
      `settle: ${fmtMs(t.settleMs)}`,
      `collect: ${fmtMs(t.collectMs)}`,
    ];
    if (t.detectionMs > 0) parts.push(`detection: ${fmtMs(t.detectionMs)}`);
    if (t.coverageMs > 0) parts.push(`coverage: ${fmtMs(t.coverageMs)}`);
    sections.push(`Audit completed in ${fmtMs(t.totalMs)} (${parts.join(', ')})`);
  }

  return sections.join('\n\n');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Section 1: Core Web Vitals
// ---------------------------------------------------------------------------

function formatWebVitals(wv: WebVitalsReport): string {
  const lines: string[] = ['Core Web Vitals:'];

  const metrics: Array<{
    label: string;
    key: string;
    value: number | null;
    format: (v: number) => string;
  }> = [
    { label: 'TTFB', key: 'ttfb', value: wv.ttfb, format: formatMs },
    { label: 'FCP', key: 'fcp', value: wv.fcp, format: formatMs },
    { label: 'LCP', key: 'lcp', value: wv.lcp, format: formatMs },
    { label: 'CLS', key: 'cls', value: wv.cls, format: (v) => v.toFixed(3) },
    { label: 'INP', key: 'inp', value: wv.inp, format: formatMs },
    { label: 'TBT', key: 'tbt', value: wv.tbt, format: formatMs },
  ];

  for (const m of metrics) {
    if (m.value == null) {
      lines.push(`  ${padRight(m.label, 10)}  ---     (no data)`);
    } else {
      const formatted = m.format(m.value);
      const rating = ratingFor(m.key, m.value);
      lines.push(`  ${padRight(m.label, 10)}${padLeft(formatted, 8)}    ${rating}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 2: LCP Analysis
// ---------------------------------------------------------------------------

function formatLcpAnalysis(corr: CorrelationReport): string | null {
  if (!corr.lcpAnalysis) return null;

  const lcp = corr.lcpAnalysis;
  const lines: string[] = ['LCP Analysis:'];

  lines.push(`  Element:        ${lcp.element}`);

  if (lcp.networkEntry) {
    lines.push(`  Size:           ${formatBytes(lcp.networkEntry.sizeBytes)}`);
    lines.push(`  Duration:       ${formatMs(lcp.networkEntry.durationMs)}`);
  }

  if (lcp.blockingResources.length > 0) {
    const blockNames = lcp.blockingResources.map(urlFilename).join(', ');
    lines.push(`  Blocked by:     ${blockNames}`);
  }

  if (lcp.criticalPath && lcp.criticalPath !== 'No data available') {
    lines.push(`  Critical path:  ${lcp.criticalPath}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 3: Layout Shifts
// ---------------------------------------------------------------------------

function formatLayoutShifts(corr: CorrelationReport): string | null {
  if (corr.clsAttribution.length === 0) return null;

  const lines: string[] = ['Layout Shifts:'];

  for (const shift of corr.clsAttribution) {
    const timeStr = formatMs(shift.time);
    const valueStr = shift.value.toFixed(4);
    lines.push(`  @${timeStr}: shift ${valueStr} -- ${shift.reason}`);
    lines.push(`    Source: ${shift.sourceElement}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 4: Long Tasks
// ---------------------------------------------------------------------------

function formatLongTasks(corr: CorrelationReport): string | null {
  if (corr.longTaskAttribution.length === 0) return null;

  const lines: string[] = ['Long Tasks (by domain):'];

  for (const entry of corr.longTaskAttribution) {
    lines.push(
      `  ${padRight(entry.domain, 30)} ${padLeft(entry.totalTbtMs + 'ms', 8)} TBT  ${entry.taskCount} task${entry.taskCount !== 1 ? 's' : ''}`,
    );
    for (const script of entry.scripts.slice(0, 3)) {
      lines.push(`    - ${urlFilename(script)}`);
    }
    if (entry.scripts.length > 3) {
      lines.push(`    + ${entry.scripts.length - 3} more`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 5: Resource Breakdown
// ---------------------------------------------------------------------------

function formatResources(res: ResourceReport): string {
  const lines: string[] = ['Resources:'];

  // Table header
  lines.push(
    `  ${padRight('Type', 12)} ${padLeft('Count', 6)} ${padLeft('Size', 10)}  Largest`,
  );

  // Display order
  const displayOrder = ['js', 'css', 'images', 'fonts', 'media', 'api', 'other'];
  const labels: Record<string, string> = {
    js: 'JS',
    css: 'CSS',
    images: 'Images',
    fonts: 'Fonts',
    media: 'Media',
    api: 'API',
    other: 'Other',
  };

  for (const key of displayOrder) {
    const cat = res.categories[key];
    if (!cat || cat.count === 0) continue;

    const largestStr = cat.largest
      ? `${urlFilename(cat.largest.url)} (${formatBytes(cat.largest.sizeBytes)})`
      : '--';

    lines.push(
      `  ${padRight(labels[key] ?? key, 12)} ${padLeft(String(cat.count), 6)} ${padLeft(formatBytes(cat.totalSizeBytes), 10)}  ${largestStr}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 6: Render-Blocking
// ---------------------------------------------------------------------------

function formatRenderBlocking(items: RenderBlockingItem[]): string | null {
  if (items.length === 0) return null;

  const lines: string[] = ['Render-Blocking Resources:'];

  for (const item of items) {
    const typeLabel = item.type === 'stylesheet' ? 'CSS' : 'JS';
    const sizeStr =
      item.sizeBytes != null ? ` (${formatBytes(item.sizeBytes)})` : '';
    lines.push(`  [${typeLabel}] ${urlFilename(item.url)}${sizeStr}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 7: Coverage Summary
// ---------------------------------------------------------------------------

function formatCoverage(coverage: CoverageResult | null): string | null {
  if (!coverage) return null;

  const allEntries = [...coverage.js, ...coverage.css];
  if (allEntries.length === 0) return null;

  const lines: string[] = ['Coverage:'];

  if (coverage.js.length > 0) {
    formatCoverageSection('JS', coverage.js, lines);
  }

  if (coverage.css.length > 0) {
    formatCoverageSection('CSS', coverage.css, lines);
  }

  return lines.join('\n');
}

function formatCoverageSection(
  label: string,
  entries: CoverageResult['js'],
  lines: string[],
): void {
  lines.push(`  ${label} Coverage:`);
  const sorted = [...entries].sort((a, b) => b.unusedBytes - a.unusedBytes);

  let totalBytes = 0;
  let unusedBytes = 0;

  for (const entry of sorted) {
    totalBytes += entry.totalBytes;
    unusedBytes += entry.unusedBytes;

    const name = entry.url ? urlFilename(entry.url) : '[inline]';
    lines.push(
      `    ${padRight(name, 40)} ${padLeft(formatBytes(entry.totalBytes), 8)} total  ${padLeft(formatBytes(entry.unusedBytes), 8)} unused (${entry.unusedPct.toFixed(0)}%)`,
    );
  }

  lines.push(
    `    ${''.padEnd(40, '-')}  ${''.padEnd(8, '-')}        ${''.padEnd(8, '-')}`,
  );
  const totalPct =
    totalBytes > 0 ? Math.round((unusedBytes / totalBytes) * 100) : 0;
  lines.push(
    `    ${padRight(`Total ${label}`, 40)} ${padLeft(formatBytes(totalBytes), 8)} total  ${padLeft(formatBytes(unusedBytes), 8)} unused (${totalPct}%)`,
  );
}

// ---------------------------------------------------------------------------
// Section 8: Image Audit
// ---------------------------------------------------------------------------

function formatImageAudit(items: ImageAuditItem[]): string | null {
  if (items.length === 0) return null;

  const lines: string[] = ['Image Audit:'];

  for (const img of items) {
    lines.push(`  ${urlFilename(img.src)}:`);
    for (const issue of img.issues) {
      lines.push(`    - ${issue}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 9: Font Audit
// ---------------------------------------------------------------------------

function formatFontAudit(items: FontAuditItem[]): string | null {
  if (items.length === 0) return null;

  const lines: string[] = ['Font Audit:'];

  for (const font of items) {
    const displayStr = font.fontDisplay
      ? `font-display: ${font.fontDisplay}`
      : 'no font-display';
    const preloadStr = font.preloaded ? 'preloaded' : 'not preloaded';
    const riskStr = font.foitRisk ? ' -- FOIT risk' : '';
    lines.push(
      `  ${font.family} (${font.weight}): ${displayStr}, ${preloadStr}${riskStr}`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 10: DOM Complexity
// ---------------------------------------------------------------------------

function formatDOMComplexity(dom: DOMComplexityReport): string {
  const lines: string[] = ['DOM Complexity:'];

  lines.push(`  Total nodes:    ${dom.totalNodes.toLocaleString()}`);
  lines.push(`  Max depth:      ${dom.maxDepth}`);
  lines.push(`  HTML size:      ${dom.htmlSizeKB}KB`);

  if (dom.largestSubtree) {
    const sub = dom.largestSubtree;
    const idStr = sub.id ? `#${sub.id}` : '';
    const classStr =
      sub.className && !sub.id
        ? `.${sub.className.split(/\s+/)[0]}`
        : '';
    lines.push(
      `  Largest:        <${sub.tag}${idStr}${classStr}> (${sub.descendants.toLocaleString()} descendants)`,
    );
  }

  // Warnings based on Google recommendations
  if (dom.totalNodes > 3000) {
    lines.push(
      `  WARNING: ${dom.totalNodes.toLocaleString()} nodes exceeds 3,000 threshold (poor)`,
    );
  } else if (dom.totalNodes > 1500) {
    lines.push(
      `  WARNING: ${dom.totalNodes.toLocaleString()} nodes exceeds 1,500 threshold (needs improvement)`,
    );
  }

  if (dom.maxDepth > 32) {
    lines.push(
      `  WARNING: depth ${dom.maxDepth} exceeds 32-level recommendation`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 11: Stack Detection
// ---------------------------------------------------------------------------

function formatStackDetection(
  detection: StackFingerprint | null,
): string | null {
  if (!detection) return null;

  const lines: string[] = ['Stack Detection:'];

  // Frameworks
  if (detection.frameworks.length > 0) {
    for (const fw of detection.frameworks) {
      const version = fw.version ? ` ${fw.version}` : '';
      const build = fw.buildMode ? `, ${fw.buildMode}` : '';

      // Summarize config highlights
      const configParts: string[] = [];
      for (const [key, val] of Object.entries(fw.config)) {
        if (val === true) {
          configParts.push(key);
        } else if (typeof val === 'number' || typeof val === 'string') {
          configParts.push(`${key}: ${val}`);
        }
      }
      const configStr =
        configParts.length > 0 ? ` (${configParts.join(', ')})` : '';

      lines.push(
        `  ${padRight(fw.category + ':', 20)} ${fw.name}${version}${build}${configStr}`,
      );
    }
  } else {
    lines.push('  No frameworks detected');
  }

  // SaaS platforms
  if (detection.saas.length > 0) {
    lines.push('');
    for (const saas of detection.saas) {
      const version = saas.version ? ` ${saas.version}` : '';
      lines.push(`  Platform:         ${saas.name}${version} (${saas.category})`);

      if (saas.apps.length > 0) {
        const activeApps = saas.apps.filter((a) => a.usedOnPage);
        const inactiveApps = saas.apps.filter((a) => !a.usedOnPage);

        if (activeApps.length > 0) {
          const appNames = activeApps
            .map((a) => `${a.name} (${a.totalSizeKB.toFixed(0)}KB)`)
            .join(', ');
          lines.push(`  Active apps:      ${appNames}`);
        }
        if (inactiveApps.length > 0) {
          const appNames = inactiveApps
            .map((a) => `${a.name} (${a.totalSizeKB.toFixed(0)}KB)`)
            .join(', ');
          lines.push(`  Unused apps:      ${appNames}`);
        }
      }
    }
  }

  // Infrastructure summary
  const infra = detection.infrastructure;

  lines.push('');
  lines.push('  Infrastructure:');

  if (infra.cdn.provider) {
    const cacheStr = infra.cdn.cacheStatus
      ? ` (cache: ${infra.cdn.cacheStatus})`
      : '';
    lines.push(`    CDN:            ${infra.cdn.provider}${cacheStr}`);
  }

  lines.push(
    `    Protocol:       ${infra.protocol.dominant}${infra.protocol.mixed ? ' (mixed)' : ''}`,
  );

  // Compression summary
  const comp = infra.compression.overall;
  const totalComp = comp.compressed + comp.uncompressed;
  if (totalComp > 0) {
    const compPct = Math.round((comp.compressed / totalComp) * 100);
    lines.push(`    Compression:    ${compPct}% of resources compressed`);
  }

  // Caching
  if (infra.caching.totalResources > 0) {
    lines.push(
      `    Cache rate:     ${infra.caching.hitRate}% (${infra.caching.cachedCount}/${infra.caching.totalResources})`,
    );
  }

  // DNS
  lines.push(
    `    DNS origins:    ${infra.dns.uniqueOrigins} unique${infra.dns.missingPreconnect.length > 0 ? ` (${infra.dns.missingPreconnect.length} missing preconnect)` : ''}`,
  );

  // Service Worker
  if (infra.serviceWorker.registered) {
    const swStrategy = infra.serviceWorker.strategy ?? 'unknown';
    const navPreload = infra.serviceWorker.navigationPreload
      ? ', navigation preload'
      : '';
    lines.push(`    Service Worker: active (${swStrategy}${navPreload})`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 12: Third-Party Impact
// ---------------------------------------------------------------------------

function formatThirdParty(
  detection: StackFingerprint | null,
  corr: CorrelationReport,
): string | null {
  if (!detection || detection.thirdParty.length === 0) return null;

  // Calculate total third-party size
  let totalSizeKB = 0;
  for (const tp of detection.thirdParty) {
    totalSizeKB += tp.totalSizeKB;
  }

  const lines: string[] = [
    `Third-Party Impact (${formatBytes(totalSizeKB * 1024)} total):`,
  ];

  // Build a TBT-by-domain lookup from long task attribution
  const tbtByDomain = new Map<string, number>();
  for (const lt of corr.longTaskAttribution) {
    if (lt.domain !== 'self') {
      tbtByDomain.set(lt.domain, lt.totalTbtMs);
    }
  }

  // Table header
  lines.push(
    `  ${padRight('Domain', 30)} ${padLeft('Size', 8)} ${padLeft('Reqs', 6)}  ${padRight('Category', 12)} TBT`,
  );

  for (const tp of detection.thirdParty.slice(0, 15)) {
    const tbt = tbtByDomain.get(tp.domain);
    const tbtStr = tbt != null && tbt > 0 ? `${tbt}ms` : '--';

    lines.push(
      `  ${padRight(tp.domain, 30)} ${padLeft(formatBytes(tp.totalSizeKB * 1024), 8)} ${padLeft(String(tp.scriptCount), 6)}  ${padRight(tp.category, 12)} ${tbtStr}`,
    );
  }

  if (detection.thirdParty.length > 15) {
    lines.push(`  + ${detection.thirdParty.length - 15} more`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 13: Fixable vs Platform Constraints
// ---------------------------------------------------------------------------

function formatFixableVsConstraints(
  fixable: string[],
  platformLimitations: string[],
  detection: StackFingerprint | null,
): string | null {
  // Only show this section when a SaaS platform is detected
  const hasSaaS = detection?.saas != null && detection.saas.length > 0;
  if (!hasSaaS) return null;
  if (fixable.length === 0 && platformLimitations.length === 0) return null;

  const lines: string[] = [];

  if (fixable.length > 0) {
    lines.push('Fixable (you control this):');
    for (const item of fixable) {
      lines.push(`  - ${item}`);
    }
  }

  if (platformLimitations.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Platform Limitation (cannot change):');
    for (const item of platformLimitations) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section 14: Top Recommendations
// ---------------------------------------------------------------------------

/**
 * Generate 3-5 prioritized, actionable recommendations from the actual
 * measured data. Delegates to the recommendation engine in
 * ./recommendations.ts.
 */
function formatTopRecommendations(report: PerfAuditReport): string | null {
  const recs = generateRecommendations(report);
  if (recs.length === 0) return null;

  const lines: string[] = ['Top Recommendations:'];
  const capped = recs.slice(0, 5);

  for (let i = 0; i < capped.length; i++) {
    lines.push(`  ${i + 1}. ${capped[i]}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diff formatter
// ---------------------------------------------------------------------------

import type { AuditDiff, MetricDelta } from './diff';

const VERDICT_SYMBOLS: Record<MetricDelta['verdict'], string> = {
  regression: '↑',
  improvement: '↓',
  unchanged: '=',
  new: '+',
  missing: '−',
};

/**
 * Format an AuditDiff for output. When `json` is true, returns the diff as
 * pretty-printed JSON. Otherwise returns a human-readable text report with
 * Web Vitals, Resources, Coverage, and a summary line.
 */
export function formatAuditDiff(
  diff: AuditDiff,
  json: boolean = false,
): string {
  if (json) return JSON.stringify(diff, null, 2);
  return formatTextDiff(diff);
}

function formatTextDiff(diff: AuditDiff): string {
  const sections: string[] = [];

  // 1. Web Vitals
  if (diff.webVitals.length > 0) {
    const lines: string[] = ['Web Vitals:'];
    lines.push(
      `  ${padRight('Metric', 10)} ${padLeft('Baseline', 10)} ${padLeft('Current', 10)} ${padLeft('Delta', 10)}  Verdict`,
    );
    for (const d of diff.webVitals) {
      const baseStr = d.baseline != null ? fmtVal(d.metric, d.baseline) : '---';
      const currStr = d.current != null ? fmtVal(d.metric, d.current) : '---';
      const deltaStr = d.deltaMs != null ? fmtDelta(d.metric, d.deltaMs) : '---';
      const symbol = VERDICT_SYMBOLS[d.verdict];
      lines.push(
        `  ${padRight(d.metric.toUpperCase(), 10)} ${padLeft(baseStr, 10)} ${padLeft(currStr, 10)} ${padLeft(deltaStr, 10)}  ${symbol} ${d.verdict}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  // 2. Resources
  if (diff.resourceSize.length > 0) {
    const lines: string[] = ['Resources:'];
    lines.push(
      `  ${padRight('Type', 10)} ${padLeft('Baseline', 10)} ${padLeft('Current', 10)} ${padLeft('Delta', 10)} ${padLeft('Change', 8)}  Verdict`,
    );
    for (const d of diff.resourceSize) {
      const baseStr = d.baseline != null ? formatBytes(d.baseline) : '---';
      const currStr = d.current != null ? formatBytes(d.current) : '---';
      const deltaStr = d.deltaMs != null ? fmtBytesDelta(d.deltaMs) : '---';
      const pctStr = d.deltaPct != null ? `${d.deltaPct > 0 ? '+' : ''}${d.deltaPct.toFixed(1)}%` : '---';
      const symbol = VERDICT_SYMBOLS[d.verdict];
      lines.push(
        `  ${padRight(d.metric, 10)} ${padLeft(baseStr, 10)} ${padLeft(currStr, 10)} ${padLeft(deltaStr, 10)} ${padLeft(pctStr, 8)}  ${symbol} ${d.verdict}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  // 3. Coverage
  const nonTrivialCoverage = diff.coverage.filter(
    (d) => d.verdict !== 'unchanged' || d.baseline != null || d.current != null,
  );
  if (nonTrivialCoverage.length > 0) {
    const lines: string[] = ['Coverage:'];
    lines.push(
      `  ${padRight('Metric', 16)} ${padLeft('Baseline', 10)} ${padLeft('Current', 10)} ${padLeft('Delta', 10)}  Verdict`,
    );
    for (const d of nonTrivialCoverage) {
      const baseStr = d.baseline != null ? `${d.baseline.toFixed(1)}%` : '---';
      const currStr = d.current != null ? `${d.current.toFixed(1)}%` : '---';
      const deltaStr = d.deltaMs != null ? `${d.deltaMs > 0 ? '+' : ''}${d.deltaMs.toFixed(1)}pp` : '---';
      const symbol = VERDICT_SYMBOLS[d.verdict];
      lines.push(
        `  ${padRight(d.metric, 16)} ${padLeft(baseStr, 10)} ${padLeft(currStr, 10)} ${padLeft(deltaStr, 10)}  ${symbol} ${d.verdict}`,
      );
    }
    sections.push(lines.join('\n'));
  }

  // 4. Summary
  const s = diff.summary;
  sections.push(
    `${s.regressions} regression${s.regressions !== 1 ? 's' : ''}, ` +
    `${s.improvements} improvement${s.improvements !== 1 ? 's' : ''}, ` +
    `${s.unchanged} unchanged`,
  );

  return sections.join('\n\n');
}

/** Format a web vitals value with appropriate units. */
function fmtVal(metric: string, value: number): string {
  if (metric === 'cls') return value.toFixed(3);
  return formatMs(value);
}

/** Format a web vitals delta with sign. */
function fmtDelta(metric: string, delta: number): string {
  const sign = delta > 0 ? '+' : '';
  if (metric === 'cls') return `${sign}${delta.toFixed(3)}`;
  return `${sign}${formatMs(delta)}`;
}

/** Format a byte delta with sign. */
function fmtBytesDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${formatBytes(Math.abs(delta))}`;
}
