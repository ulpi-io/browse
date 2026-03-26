/**
 * Web Vitals observer injection and collection for performance auditing.
 *
 * WEB_VITALS_INIT_SCRIPT is a plain string IIFE injected via context.addInitScript()
 * before any page JS runs. It sets up buffered PerformanceObservers for LCP, CLS,
 * INP, long tasks, and paint timings on window.__BROWSE_PERF_METRICS.
 *
 * collectWebVitals() reads the accumulated metrics after navigation completes.
 */

import type { Page } from 'playwright';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebVitalsReport {
  /** Time to First Byte (ms) from Navigation Timing API */
  ttfb: number;
  /** First Contentful Paint (ms), null if not observed */
  fcp: number | null;
  /** Largest Contentful Paint (ms), null if not observed */
  lcp: number | null;
  /** Cumulative Layout Shift (unitless), null if not observed */
  cls: number | null;
  /** Total Blocking Time (ms), null if no long tasks */
  tbt: number | null;
  /** Interaction to Next Paint (ms) -- p98 of interaction durations, null if none */
  inp: number | null;
  /** Details about the LCP element */
  lcpElement: {
    tag: string;
    id?: string;
    url?: string;
    size: number;
    fetchpriority?: string;
    loading?: string;
  } | null;
  /** Individual layout shift entries (excluding input-driven shifts) */
  layoutShifts: Array<{
    time: number;
    value: number;
    sources: Array<{ tag: string; id?: string; shift: string }>;
  }>;
  /** Long tasks (>50ms) observed during page load */
  longTasks: Array<{
    time: number;
    duration: number;
    scriptUrl: string | null;
  }>;
  /** Raw paint timing entries */
  paintTimings: { fp: number | null; fcp: number | null };
}

// ---------------------------------------------------------------------------
// Init script -- injected as a string via context.addInitScript()
// ---------------------------------------------------------------------------

/**
 * IIFE string that installs buffered PerformanceObservers on
 * window.__BROWSE_PERF_METRICS. Each observer type is wrapped in its own
 * try/catch so unsupported entry types degrade gracefully.
 *
 * Must be a plain string (not a function reference) because Playwright's
 * addInitScript serialises string arguments directly into the page context.
 */
export const WEB_VITALS_INIT_SCRIPT = `(function() {
  if (window.__BROWSE_PERF_METRICS) return;

  var m = window.__BROWSE_PERF_METRICS = {
    lcp: null,
    lcpElement: null,
    cls: 0,
    clsShifts: [],
    inp: null,
    _interactions: [],
    longTasks: [],
    tbt: 0,
    paintFP: null,
    paintFCP: null
  };

  // 1. Largest Contentful Paint -------------------------------------------
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        m.lcp = e.startTime;
        var el = e.element;
        m.lcpElement = {
          tag: el ? el.tagName.toLowerCase() : 'unknown',
          id: el && el.id ? el.id : undefined,
          className: el && el.className ? String(el.className) : undefined,
          url: e.url || undefined,
          size: e.size || 0,
          fetchpriority: el ? el.getAttribute('fetchpriority') || undefined : undefined,
          loading: el ? el.getAttribute('loading') || undefined : undefined
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch(_) {}

  // 2. Layout Shift (CLS) -------------------------------------------------
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var sources = [];
        if (e.sources) {
          for (var j = 0; j < e.sources.length; j++) {
            var s = e.sources[j];
            var node = s.node;
            sources.push({
              tag: node ? node.tagName.toLowerCase() : 'unknown',
              id: node && node.id ? node.id : undefined,
              currentRect: s.currentRect
                ? s.currentRect.x + ',' + s.currentRect.y + ' ' + s.currentRect.width + 'x' + s.currentRect.height
                : null,
              previousRect: s.previousRect
                ? s.previousRect.x + ',' + s.previousRect.y + ' ' + s.previousRect.width + 'x' + s.previousRect.height
                : null
            });
          }
        }
        m.clsShifts.push({
          value: e.value,
          startTime: e.startTime,
          hadRecentInput: e.hadRecentInput,
          sources: sources
        });
        // CLS excludes input-driven shifts
        if (!e.hadRecentInput) {
          m.cls += e.value;
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch(_) {}

  // 3. Event timing (INP) -------------------------------------------------
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        m._interactions.push(e.duration);
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch(_) {}

  // 4. Long Tasks (TBT) ---------------------------------------------------
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var attr = e.attribution && e.attribution[0];
        m.longTasks.push({
          startTime: e.startTime,
          duration: e.duration,
          containerSrc: attr ? attr.containerSrc || null : null,
          containerName: attr ? attr.containerName || null : null
        });
        // TBT = sum of (duration - 50ms) for each long task
        if (e.duration > 50) {
          m.tbt += (e.duration - 50);
        }
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch(_) {}

  // 5. Paint (FP + FCP) ---------------------------------------------------
  try {
    new PerformanceObserver(function(list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.name === 'first-paint') m.paintFP = e.startTime;
        if (e.name === 'first-contentful-paint') m.paintFCP = e.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
  } catch(_) {}
})();`;

// ---------------------------------------------------------------------------
// Collection function
// ---------------------------------------------------------------------------

/**
 * Collect Web Vitals metrics from a page that had WEB_VITALS_INIT_SCRIPT
 * injected before navigation. Also reads TTFB from the Navigation Timing API.
 *
 * Returns a structured WebVitalsReport. Fields are null when the browser did
 * not emit the corresponding PerformanceObserver entries (e.g. no interactions
 * means INP is null).
 */
export async function collectWebVitals(page: Page): Promise<WebVitalsReport> {
  const raw = await page.evaluate(() => {
    // Navigation Timing -- TTFB
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const ttfb = nav ? nav.responseStart - nav.requestStart : 0;

    // Perf metrics namespace (may be absent if init script was not injected)
    const m = (window as any).__BROWSE_PERF_METRICS as {
      lcp: number | null;
      lcpElement: {
        tag: string;
        id?: string;
        className?: string;
        url?: string;
        size: number;
        fetchpriority?: string;
        loading?: string;
      } | null;
      cls: number;
      clsShifts: Array<{
        value: number;
        startTime: number;
        hadRecentInput: boolean;
        sources: Array<{
          tag: string;
          id?: string;
          currentRect: string | null;
          previousRect: string | null;
        }>;
      }>;
      _interactions: number[];
      longTasks: Array<{
        startTime: number;
        duration: number;
        containerSrc: string | null;
        containerName: string | null;
      }>;
      tbt: number;
      paintFP: number | null;
      paintFCP: number | null;
    } | undefined;

    if (!m) {
      return { ttfb, metrics: null };
    }

    return { ttfb, metrics: m };
  });

  // If the init script was never injected, return a minimal report
  if (!raw.metrics) {
    return {
      ttfb: Math.round(raw.ttfb),
      fcp: null,
      lcp: null,
      cls: null,
      tbt: null,
      inp: null,
      lcpElement: null,
      layoutShifts: [],
      longTasks: [],
      paintTimings: { fp: null, fcp: null },
    };
  }

  const m = raw.metrics;

  // Calculate INP as the p98 of interaction durations
  let inp: number | null = null;
  if (m._interactions.length > 0) {
    const sorted = m._interactions.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98));
    inp = sorted[idx];
  }

  // Map layout shifts to report format (exclude input-driven)
  const layoutShifts = m.clsShifts
    .filter((s) => !s.hadRecentInput)
    .map((s) => ({
      time: Math.round(s.startTime),
      value: s.value,
      sources: s.sources.map((src) => ({
        tag: src.tag,
        id: src.id,
        shift: [src.previousRect, src.currentRect].filter(Boolean).join(' -> '),
      })),
    }));

  // Map long tasks
  const longTasks = m.longTasks.map((t) => ({
    time: Math.round(t.startTime),
    duration: Math.round(t.duration),
    scriptUrl: t.containerSrc || null,
  }));

  // Build LCP element info
  let lcpElement: WebVitalsReport['lcpElement'] = null;
  if (m.lcpElement) {
    lcpElement = {
      tag: m.lcpElement.tag,
      size: m.lcpElement.size,
    };
    if (m.lcpElement.id) lcpElement.id = m.lcpElement.id;
    if (m.lcpElement.url) lcpElement.url = m.lcpElement.url;
    if (m.lcpElement.fetchpriority) lcpElement.fetchpriority = m.lcpElement.fetchpriority;
    if (m.lcpElement.loading) lcpElement.loading = m.lcpElement.loading;
  }

  return {
    ttfb: Math.round(raw.ttfb),
    fcp: m.paintFCP != null ? Math.round(m.paintFCP) : null,
    lcp: m.lcp != null ? Math.round(m.lcp) : null,
    cls: m.cls > 0 ? Math.round(m.cls * 1000) / 1000 : m.clsShifts.length > 0 ? 0 : null,
    tbt: m.longTasks.length > 0 ? Math.round(m.tbt) : null,
    inp,
    lcpElement,
    layoutShifts,
    longTasks,
    paintTimings: {
      fp: m.paintFP != null ? Math.round(m.paintFP) : null,
      fcp: m.paintFCP != null ? Math.round(m.paintFCP) : null,
    },
  };
}
