/**
 * DOM complexity analysis and cross-metric correlation engine.
 *
 * analyzeDOMComplexity() evaluates the page DOM for node count, nesting
 * depth, and largest subtree -- all factors that affect rendering cost.
 *
 * buildCorrelationReport() cross-references Web Vitals, resource data,
 * and network entries to produce actionable attribution for LCP, CLS,
 * TBT, and font-blocking issues.
 */

import type { Page } from 'playwright';
import type { WebVitalsReport } from './web-vitals';
import type { ResourceReport } from './resource-analyzer';
import type { NetworkEntry } from '../buffers';

// ---------------------------------------------------------------------------
// DOM Complexity Types
// ---------------------------------------------------------------------------

export interface DOMComplexityReport {
  totalNodes: number;
  maxDepth: number;
  largestSubtree: {
    tag: string;
    id: string | null;
    className: string | null;
    descendants: number;
  } | null;
  htmlSizeKB: number;
}

// ---------------------------------------------------------------------------
// Correlation Types
// ---------------------------------------------------------------------------

export interface CorrelationReport {
  lcpAnalysis: {
    element: string;
    networkEntry: { url: string; sizeBytes: number; durationMs: number } | null;
    blockingResources: string[];
    criticalPath: string;
  } | null;

  clsAttribution: Array<{
    time: number;
    value: number;
    reason: string;
    sourceElement: string;
  }>;

  longTaskAttribution: Array<{
    domain: string;
    totalTbtMs: number;
    taskCount: number;
    scripts: string[];
  }>;

  fontBlockingFcp: Array<{
    family: string;
    fontDisplay: string | null;
    blockingMs: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// DOM Complexity Analysis
// ---------------------------------------------------------------------------

/**
 * Evaluate the page DOM for total node count, maximum nesting depth,
 * the largest direct-child subtree of <body>, and overall HTML size.
 *
 * Runs inside page.evaluate() to avoid serializing the entire DOM across
 * the Playwright wire. The subtree scan is limited to body > * children
 * to avoid O(n^2) cost on deeply nested pages.
 */
export async function analyzeDOMComplexity(page: Page): Promise<DOMComplexityReport> {
  try {
    return await page.evaluate(() => {
      const allNodes = document.querySelectorAll('*');
      const totalNodes = allNodes.length;

      // Walk DOM measuring maximum depth from <html>
      let maxDepth = 0;
      const measureDepth = (el: Element, depth: number): void => {
        if (depth > maxDepth) maxDepth = depth;
        for (const child of el.children) {
          measureDepth(child, depth + 1);
        }
      };
      measureDepth(document.documentElement, 0);

      // Find the direct child of <body> with the most descendants
      let largestEl: Element | null = null;
      let largestCount = 0;
      const sections = document.querySelectorAll('body > *');
      for (const section of sections) {
        const count = section.querySelectorAll('*').length;
        if (count > largestCount) {
          largestCount = count;
          largestEl = section;
        }
      }

      return {
        totalNodes,
        maxDepth,
        largestSubtree: largestEl
          ? {
              tag: largestEl.tagName.toLowerCase(),
              id: largestEl.id || null,
              className: largestEl.className
                ? String(largestEl.className).slice(0, 100)
                : null,
              descendants: largestCount,
            }
          : null,
        htmlSizeKB: Math.round(
          document.documentElement.outerHTML.length / 1024,
        ),
      };
    });
  } catch {
    // Gracefully handle about:blank, crashed pages, CSP restrictions
    return {
      totalNodes: 0,
      maxDepth: 0,
      largestSubtree: null,
      htmlSizeKB: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for correlation
// ---------------------------------------------------------------------------

/** Extract the registrable domain from a URL for grouping. */
function extractDomain(url: string): string {
  try {
    const parts = new URL(url).hostname.split('.');
    return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
  } catch {
    return 'unknown';
  }
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

/** Build a human-readable description like "<img src='hero.jpg'>". */
function describeLcpElement(
  el: NonNullable<WebVitalsReport['lcpElement']>,
): string {
  const attrs: string[] = [];
  if (el.id) attrs.push(`id='${el.id}'`);
  if (el.url) attrs.push(`src='${urlFilename(el.url)}'`);
  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  return `<${el.tag}${attrStr}>`;
}

/** Find a network entry matching a target URL (exact, pathname, or filename). */
function findNetworkEntry(targetUrl: string, entries: NetworkEntry[]): NetworkEntry | null {
  const exact = entries.find((e) => e.url === targetUrl);
  if (exact) return exact;

  try {
    const targetPath = new URL(targetUrl).pathname;
    const byPath = entries.find((e) => {
      try { return new URL(e.url).pathname === targetPath; } catch { return false; }
    });
    if (byPath) return byPath;
  } catch { /* ignore */ }

  const filename = urlFilename(targetUrl);
  if (filename && filename !== targetUrl) {
    return entries.find((e) => {
      try {
        const p = new URL(e.url).pathname;
        return p.endsWith('/' + filename) || p === '/' + filename;
      } catch { return false; }
    }) ?? null;
  }
  return null;
}

/** Determine the most likely reason for a layout shift. */
function classifyShiftReason(
  shift: WebVitalsReport['layoutShifts'][number],
  fontAudit: ResourceReport['fontAudit'],
  networkEntries: NetworkEntry[],
): string {
  const sources = shift.sources;

  for (const src of sources) {
    const tag = src.tag.toLowerCase();
    if (tag === 'img') return 'Image missing dimensions';
    if (tag === 'iframe' || tag === 'ins' || tag === 'amp-ad') return 'Ad/iframe injection';
    if (tag === 'video' || tag === 'embed' || tag === 'object') return 'Media element without dimensions';
  }

  // Check if the shift coincides with a font load
  const hasFoitFonts = fontAudit.some((f) => f.foitRisk);
  if (hasFoitFonts) {
    const fontExts = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
    const fontNetworkEntries = networkEntries.filter((e) => {
      try {
        const ext = new URL(e.url).pathname.split('.').pop()?.toLowerCase();
        return fontExts.has(ext ?? '');
      } catch { return false; }
    });

    for (const fe of fontNetworkEntries) {
      const completeTime = fe.timestamp + (fe.duration ?? 0);
      if (Math.abs(completeTime - shift.time) < 200 ||
          (shift.time >= fe.timestamp && shift.time <= completeTime + 200)) {
        return 'Font swap';
      }
    }
    if (shift.time < 3000) return 'Font swap (likely)';
  }

  return 'Dynamic content insertion';
}

/** Build a critical path string: TTFB -> blocking resources -> LCP resource -> LCP time. */
function buildCriticalPath(
  webVitals: WebVitalsReport,
  blockingResources: ResourceReport['renderBlocking'],
  lcpNetworkEntry: NetworkEntry | null,
  networkEntries: NetworkEntry[],
): string {
  const steps: string[] = [];

  if (webVitals.ttfb > 0) steps.push(`TTFB(${webVitals.ttfb}ms)`);

  // Blocking resources sorted by completion time
  const blocking = blockingResources
    .map((br) => {
      const entry = findNetworkEntry(br.url, networkEntries);
      if (!entry) return null;
      const typeLabel = br.type === 'stylesheet' ? 'CSS' : 'JS';
      return {
        label: `${typeLabel}(${urlFilename(br.url)}, ${entry.duration ?? '?'}ms)`,
        endTime: entry.timestamp + (entry.duration ?? 0),
      };
    })
    .filter((x): x is { label: string; endTime: number } => x !== null)
    .sort((a, b) => a.endTime - b.endTime);

  for (const item of blocking.slice(0, 3)) steps.push(item.label);
  if (blocking.length > 3) steps.push(`+${blocking.length - 3} more blocking`);

  if (lcpNetworkEntry) {
    steps.push(`Image(${urlFilename(lcpNetworkEntry.url)}, ${lcpNetworkEntry.duration ?? '?'}ms)`);
  }
  if (webVitals.lcp != null) steps.push(`LCP(${webVitals.lcp}ms)`);

  return steps.length > 0 ? steps.join(' -> ') : 'No data available';
}

// ---------------------------------------------------------------------------
// Correlation Engine
// ---------------------------------------------------------------------------

/**
 * Cross-reference Web Vitals, resource analysis, and raw network entries
 * to produce actionable attribution for each core metric:
 *
 * - LCP: identify the element, its network cost, blocking resources, critical path
 * - CLS: attribute each layout shift to images, fonts, ads, or dynamic content
 * - Long Tasks: group by domain with TBT contribution
 * - Font blocking: identify fonts that may have blocked FCP via FOIT
 */
export function buildCorrelationReport(
  webVitals: WebVitalsReport,
  resources: ResourceReport,
  networkEntries: NetworkEntry[],
): CorrelationReport {
  // ── LCP Analysis ──────────────────────────────────────────────────────

  let lcpAnalysis: CorrelationReport['lcpAnalysis'] = null;

  if (webVitals.lcpElement) {
    const lcpEl = webVitals.lcpElement;
    const element = describeLcpElement(lcpEl);

    // Find the LCP element's network entry (if it loaded a resource like an image)
    let lcpNetworkEntry: {
      url: string;
      sizeBytes: number;
      durationMs: number;
    } | null = null;
    let lcpRawEntry: NetworkEntry | null = null;

    if (lcpEl.url) {
      lcpRawEntry = findNetworkEntry(lcpEl.url, networkEntries);
      if (lcpRawEntry) {
        lcpNetworkEntry = {
          url: lcpRawEntry.url,
          sizeBytes: lcpRawEntry.size ?? 0,
          durationMs: lcpRawEntry.duration ?? 0,
        };
      }
    }

    // Render-blocking resources that completed before LCP
    const lcpTime = webVitals.lcp ?? Infinity;
    const blockingResources: string[] = [];
    for (const br of resources.renderBlocking) {
      const entry = findNetworkEntry(br.url, networkEntries);
      if (!entry) {
        blockingResources.push(br.url); // detected in DOM, no network entry
      } else if (entry.timestamp + (entry.duration ?? 0) <= lcpTime) {
        blockingResources.push(br.url);
      }
    }

    const criticalPath = buildCriticalPath(
      webVitals,
      resources.renderBlocking,
      lcpRawEntry,
      networkEntries,
    );

    lcpAnalysis = {
      element,
      networkEntry: lcpNetworkEntry,
      blockingResources,
      criticalPath,
    };
  }

  // ── CLS Attribution ───────────────────────────────────────────────────

  const clsAttribution: CorrelationReport['clsAttribution'] = [];

  for (const shift of webVitals.layoutShifts) {
    const reason = classifyShiftReason(shift, resources.fontAudit, networkEntries);

    // Build a description of the source elements
    let sourceElement = 'unknown';
    if (shift.sources.length > 0) {
      const src = shift.sources[0];
      const parts: string[] = [src.tag];
      if (src.id) parts.push(`#${src.id}`);
      sourceElement = parts.join('');
      if (src.shift) {
        sourceElement += ` (${src.shift})`;
      }
    }

    clsAttribution.push({
      time: shift.time,
      value: shift.value,
      reason,
      sourceElement,
    });
  }

  // ── Long Task Attribution ─────────────────────────────────────────────

  const domainMap = new Map<
    string,
    { totalTbtMs: number; taskCount: number; scripts: Set<string> }
  >();

  for (const task of webVitals.longTasks) {
    // TBT contribution = duration - 50ms (the "blocking" portion)
    const tbtContribution = Math.max(0, task.duration - 50);
    const scriptUrl = task.scriptUrl ?? '';
    const domain = scriptUrl ? extractDomain(scriptUrl) : 'self';

    let entry = domainMap.get(domain);
    if (!entry) {
      entry = { totalTbtMs: 0, taskCount: 0, scripts: new Set() };
      domainMap.set(domain, entry);
    }

    entry.totalTbtMs += tbtContribution;
    entry.taskCount++;
    if (scriptUrl) {
      entry.scripts.add(scriptUrl);
    }
  }

  // Convert to array sorted by TBT contribution (descending)
  const longTaskAttribution: CorrelationReport['longTaskAttribution'] =
    Array.from(domainMap.entries())
      .map(([domain, data]) => ({
        domain,
        totalTbtMs: Math.round(data.totalTbtMs),
        taskCount: data.taskCount,
        scripts: Array.from(data.scripts),
      }))
      .sort((a, b) => b.totalTbtMs - a.totalTbtMs);

  // ── Font Blocking FCP ─────────────────────────────────────────────────

  const fontBlockingFcp: CorrelationReport['fontBlockingFcp'] = [];

  for (const font of resources.fontAudit) {
    if (!font.foitRisk) continue;

    const familyLower = font.family.toLowerCase().replace(/\s+/g, '');
    const fontExts = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
    let blockingMs: number | null = null;

    const fontEntry = networkEntries.find((e) => {
      try {
        const ext = new URL(e.url).pathname.split('.').pop()?.toLowerCase();
        return fontExts.has(ext ?? '') && e.url.toLowerCase().includes(familyLower);
      } catch { return false; }
    });

    if (fontEntry) {
      const fontCompletedAt = fontEntry.timestamp + (fontEntry.duration ?? 0);
      if (webVitals.fcp == null || fontCompletedAt <= webVitals.fcp) {
        blockingMs = fontEntry.duration ?? null;
      }
    }

    fontBlockingFcp.push({
      family: font.family,
      fontDisplay: font.fontDisplay,
      blockingMs,
    });
  }

  return {
    lcpAnalysis,
    clsAttribution,
    longTaskAttribution,
    fontBlockingFcp,
  };
}
