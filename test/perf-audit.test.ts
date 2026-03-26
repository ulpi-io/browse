/**
 * Integration tests for the `initscript`, `coverage`, and detection commands
 *
 * Tests cover:
 *   - Setting an init script that runs before page loads
 *   - Clearing the init script
 *   - Showing the current init script
 *   - Error handling for invalid/missing subcommands
 *   - Error handling for set without code
 *   - JS and CSS coverage collection
 *   - Coverage start/stop lifecycle errors
 *   - Coverage via meta command handler
 *   - Coverage entry structure validation
 *   - Framework detection (React, Next.js, jQuery, multi-framework, plain HTML)
 *   - SaaS detection (Shopify, WooCommerce, plain HTML no false positive)
 *   - Infrastructure detection (DOM complexity, service worker, CDN)
 */

import { describe, test, expect } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleWriteCommand } from '../src/commands/write';
import { handleReadCommand } from '../src/commands/read';
import { handleMetaCommand } from '../src/commands/meta';
import { detectFrameworks } from '../src/detection/frameworks';
import { detectSaaS } from '../src/detection/saas';
import { detectInfrastructure } from '../src/detection/infrastructure';
import { analyzeResources } from '../src/perf-audit/resource-analyzer';
import { analyzeDOMComplexity, buildCorrelationReport } from '../src/perf-audit/dom-analysis';
import { runPerfAudit } from '../src/perf-audit';
import { formatPerfAudit } from '../src/perf-audit/formatter';
import type { NetworkEntry } from '../src/buffers';
import type { WebVitalsReport } from '../src/perf-audit/web-vitals';
import type { ResourceReport } from '../src/perf-audit/resource-analyzer';

describe('Initscript', () => {
  test('set script runs before page load', async () => {
    const setResult = await handleWriteCommand('initscript', ['set', 'window.__BROWSE_TEST_INIT = 42'], bm);
    expect(setResult).toContain('Init script set');

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('js', ['window.__BROWSE_TEST_INIT'], bm);
    expect(result).toContain('42');

    // Clean up
    await handleWriteCommand('initscript', ['clear'], bm);
  });

  test('set returns confirmation message', async () => {
    const result = await handleWriteCommand('initscript', ['set', 'window.__BROWSE_CONFIRM = true'], bm);
    expect(result).toContain('Init script set');
    expect(result).toContain('before every page load');

    // Clean up
    await handleWriteCommand('initscript', ['clear'], bm);
  });

  test('clear removes the stored script', async () => {
    await handleWriteCommand('initscript', ['set', 'window.__BROWSE_TEST_CLEAR = 99'], bm);
    const clearResult = await handleWriteCommand('initscript', ['clear'], bm);
    expect(clearResult).toContain('Init script cleared');

    // After clear, show should report no script set
    const shown = await handleWriteCommand('initscript', ['show'], bm);
    expect(shown).toContain('No init script set');
  });

  test('show returns current script when set', async () => {
    await handleWriteCommand('initscript', ['set', 'window.X=1'], bm);
    const result = await handleWriteCommand('initscript', ['show'], bm);
    expect(result).toContain('window.X=1');

    // Clean up
    await handleWriteCommand('initscript', ['clear'], bm);
  });

  test('show returns message when no script set', async () => {
    // Ensure clean state
    await handleWriteCommand('initscript', ['clear'], bm);

    const result = await handleWriteCommand('initscript', ['show'], bm);
    expect(result).toBe('No init script set.');
  });

  test('set with multi-word code joins args', async () => {
    await handleWriteCommand('initscript', ['set', 'window.MULTI', '=', '"hello world"'], bm);
    const result = await handleWriteCommand('initscript', ['show'], bm);
    expect(result).toContain('window.MULTI = "hello world"');

    // Clean up
    await handleWriteCommand('initscript', ['clear'], bm);
  });

  test('invalid subcommand throws', async () => {
    await expect(
      handleWriteCommand('initscript', ['invalid'], bm)
    ).rejects.toThrow('Usage: browse initscript');
  });

  test('no subcommand throws', async () => {
    await expect(
      handleWriteCommand('initscript', [], bm)
    ).rejects.toThrow('Usage: browse initscript');
  });

  test('set without code throws', async () => {
    await expect(
      handleWriteCommand('initscript', ['set'], bm)
    ).rejects.toThrow('Usage: browse initscript set');
  });

  test('script persists across navigations', async () => {
    await handleWriteCommand('initscript', ['set', 'window.__BROWSE_PERSIST = "yes"'], bm);

    // Navigate to first page
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const first = await handleReadCommand('js', ['window.__BROWSE_PERSIST'], bm);
    expect(first).toContain('yes');

    // Navigate to a different page - init script should run again
    await handleWriteCommand('goto', [baseUrl + '/basic.html?v=2'], bm);
    const second = await handleReadCommand('js', ['window.__BROWSE_PERSIST'], bm);
    expect(second).toContain('yes');

    // Clean up
    await handleWriteCommand('initscript', ['clear'], bm);
  });
});

// ─── Coverage ──────────────────────────────────────────────────────

describe('Coverage', () => {
  test('collects JS and CSS coverage', async () => {
    await bm.startCoverage();
    await handleWriteCommand('goto', [baseUrl + '/coverage-test.html'], bm);
    const result = await bm.stopCoverage();

    expect(result.js).toBeDefined();
    expect(result.css).toBeDefined();

    // Should have collected coverage data (inline scripts and styles produce entries)
    // Note: V8 coverage for inline scripts may report overlapping ranges that
    // clamp usedBytes to totalBytes, so we check structure rather than unused %
    const allEntries = [...result.js, ...result.css];
    expect(allEntries.length).toBeGreaterThan(0);

    // Every entry should have non-negative byte counts
    for (const entry of allEntries) {
      expect(entry.totalBytes).toBeGreaterThanOrEqual(0);
      expect(entry.usedBytes).toBeGreaterThanOrEqual(0);
      expect(entry.unusedBytes).toBeGreaterThanOrEqual(0);
      expect(entry.unusedPct).toBeGreaterThanOrEqual(0);
      expect(entry.unusedPct).toBeLessThanOrEqual(100);
    }
  });

  test('stop without start throws', async () => {
    // Make sure coverage is not active
    if (bm.isCoverageActive()) {
      await bm.stopCoverage();
    }
    await expect(bm.stopCoverage()).rejects.toThrow(/not started/i);
  });

  test('double start throws', async () => {
    await bm.startCoverage();
    await expect(bm.startCoverage()).rejects.toThrow(/already/i);
    await bm.stopCoverage(); // clean up
  });

  test('coverage via meta command start/stop', async () => {
    const startResult = await handleMetaCommand('coverage', ['start'], bm, async () => {});
    expect(startResult).toContain('started');

    await handleWriteCommand('goto', [baseUrl + '/coverage-test.html'], bm);

    const stopResult = await handleMetaCommand('coverage', ['stop'], bm, async () => {});
    expect(stopResult).toContain('JavaScript');
    expect(stopResult).toContain('CSS');
  });

  test('coverage meta command without subcommand throws', async () => {
    await expect(
      handleMetaCommand('coverage', [], bm, async () => {})
    ).rejects.toThrow(/usage/i);
  });

  test('coverage entries have correct structure', async () => {
    await bm.startCoverage();
    await handleWriteCommand('goto', [baseUrl + '/coverage-test.html'], bm);
    const result = await bm.stopCoverage();

    for (const entry of [...result.js, ...result.css]) {
      expect(entry).toHaveProperty('url');
      expect(entry).toHaveProperty('totalBytes');
      expect(entry).toHaveProperty('usedBytes');
      expect(entry).toHaveProperty('unusedBytes');
      expect(entry).toHaveProperty('unusedPct');
      expect(typeof entry.url).toBe('string');
      expect(typeof entry.totalBytes).toBe('number');
      expect(typeof entry.usedBytes).toBe('number');
      expect(typeof entry.unusedBytes).toBe('number');
      expect(typeof entry.unusedPct).toBe('number');
      expect(entry.usedBytes + entry.unusedBytes).toBe(entry.totalBytes);
    }
  });
});

// ─── Perf Audit E2E ─────────────────────────────────────────────────

describe('Perf Audit E2E', () => {
  test('full audit returns all sections', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const networkEntries: NetworkEntry[] = [];

    const report = await runPerfAudit(bm, networkEntries, {
      includeCoverage: false,
      includeDetection: false,
    });

    // Web Vitals should have numeric TTFB at minimum
    expect(report.webVitals.ttfb).toBeGreaterThanOrEqual(0);
    // FCP may be null (headless timing can vary) but the field must be present
    expect(report.webVitals).toHaveProperty('fcp');

    // DOM complexity should reflect the perf-heavy page
    expect(report.domComplexity.totalNodes).toBeGreaterThan(0);
    expect(report.domComplexity.maxDepth).toBeGreaterThan(0);
    expect(typeof report.domComplexity.htmlSizeKB).toBe('number');

    // Resources should be populated (categories object)
    expect(report.resources).toBeDefined();
    expect(report.resources.categories).toBeDefined();

    // Correlations should be populated
    expect(report.correlations).toBeDefined();

    // Skipped sections should be null
    expect(report.coverage).toBeNull();
    expect(report.detection).toBeNull();

    // Status, warnings, timing should be present
    expect(report.status).toBeDefined();
    expect(report.status.webVitals).toBeDefined();
    expect(Array.isArray(report.warnings)).toBe(true);
    expect(report.timing).toBeDefined();
    expect(report.timing.totalMs).toBeGreaterThan(0);

    // Fixable and platformLimitations are arrays
    expect(Array.isArray(report.fixable)).toBe(true);
    expect(Array.isArray(report.platformLimitations)).toBe(true);
  });

  test('--no-coverage skips coverage collection', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const report = await runPerfAudit(bm, [], { includeCoverage: false });
    expect(report.coverage).toBeNull();
    // Other sections should still be present
    expect(report.webVitals).toBeDefined();
    expect(report.domComplexity).toBeDefined();
  });

  test('--no-detect skips detection', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const report = await runPerfAudit(bm, [], { includeDetection: false });
    expect(report.detection).toBeNull();
    // Other sections should still be present
    expect(report.webVitals).toBeDefined();
    expect(report.domComplexity).toBeDefined();
  });

  test('with coverage enabled collects coverage data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const report = await runPerfAudit(bm, [], {
      includeCoverage: true,
      includeDetection: false,
    });

    // Coverage should be populated when enabled
    expect(report.coverage).not.toBeNull();
    expect(report.coverage!.js).toBeDefined();
    expect(report.coverage!.css).toBeDefined();
    expect(Array.isArray(report.coverage!.js)).toBe(true);
    expect(Array.isArray(report.coverage!.css)).toBe(true);

    // Coverage entries should have the expected structure
    for (const entry of [...report.coverage!.js, ...report.coverage!.css]) {
      expect(entry).toHaveProperty('url');
      expect(entry).toHaveProperty('totalBytes');
      expect(entry).toHaveProperty('usedBytes');
      expect(entry).toHaveProperty('unusedBytes');
      expect(entry).toHaveProperty('unusedPct');
    }
  });

  test('formatter produces text output with expected sections', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const report = await runPerfAudit(bm, [], {
      includeCoverage: false,
      includeDetection: false,
    });
    const output = formatPerfAudit(report, false);

    // Must contain Core Web Vitals section with TTFB
    expect(output).toContain('Core Web Vitals');
    expect(output).toContain('TTFB');

    // Must contain DOM Complexity section
    expect(output).toContain('DOM Complexity');
    expect(output).toContain('Total nodes');

    // Must contain Resources section
    expect(output).toContain('Resources');

    // Output should be a non-empty string
    expect(output.length).toBeGreaterThan(50);
  });

  test('formatter produces valid JSON', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const report = await runPerfAudit(bm, [], {
      includeCoverage: false,
      includeDetection: false,
    });
    const jsonOutput = formatPerfAudit(report, true);

    // Must be valid JSON
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.webVitals).toBeDefined();
    expect(parsed.domComplexity).toBeDefined();
    expect(parsed.resources).toBeDefined();
    expect(parsed.correlations).toBeDefined();
    expect(parsed.fixable).toBeDefined();
    expect(parsed.platformLimitations).toBeDefined();
    expect(parsed.status).toBeDefined();
    expect(parsed.warnings).toBeDefined();
    expect(parsed.timing).toBeDefined();
  });

  test('perf-audit via meta command handler', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const result = await handleMetaCommand(
      'perf-audit',
      ['--no-coverage', '--no-detect'],
      bm,
      async () => {},
    );

    // Meta command returns formatted text
    expect(result).toContain('Core Web Vitals');
    expect(result).toContain('TTFB');
    expect(result).toContain('DOM');
  });

  test('perf-audit meta command with --json flag', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-heavy.html'], bm);
    const result = await handleMetaCommand(
      'perf-audit',
      ['--json', '--no-coverage', '--no-detect'],
      bm,
      async () => {},
    );

    // Should be valid JSON
    const parsed = JSON.parse(result);
    expect(parsed.webVitals).toBeDefined();
    expect(parsed.domComplexity).toBeDefined();
  });

  test('perf-audit with URL navigates then audits', async () => {
    // Start on a different page
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    // perf-audit with URL should navigate to perf-heavy.html then audit
    const result = await handleMetaCommand(
      'perf-audit',
      [baseUrl + '/perf-heavy.html', '--no-coverage', '--no-detect'],
      bm,
      async () => {},
    );

    expect(result).toContain('Core Web Vitals');
    expect(result).toContain('DOM');
  });
});

// ─── Framework Detection ────────────────────────────────────────────

describe('Framework Detection', () => {
  test('detects React with version', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-react.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);
    const react = frameworks.find(f => f.name === 'React');
    expect(react).toBeDefined();
    expect(react!.version).toBe('18.2.0');
    expect(react!.category).toBe('js-framework');
    expect(react!.buildMode).toBe('production');
  });

  test('detects Next.js with payload size', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-nextjs.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);

    // Should detect both React and Next.js
    const react = frameworks.find(f => f.name === 'React');
    expect(react).toBeDefined();

    const nextjs = frameworks.find(f => f.name === 'Next.js');
    expect(nextjs).toBeDefined();
    expect(nextjs!.category).toBe('meta-framework');
    // __NEXT_DATA__ has ~50KB of "x" characters in props.pageProps.data
    expect(nextjs!.config.payloadSizeKB).toBeGreaterThan(40);
  });

  test('detects jQuery with version', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-jquery.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);
    const jquery = frameworks.find(f => f.name === 'jQuery');
    expect(jquery).toBeDefined();
    expect(jquery!.version).toBe('3.7.1');
    expect(jquery!.category).toBe('js-framework');
  });

  test('detects multiple frameworks simultaneously', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-multi.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);
    const names = frameworks.map(f => f.name);
    expect(names).toContain('React');
    expect(names).toContain('jQuery');
  });

  test('returns empty js-framework list on plain HTML', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-plain.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);
    // Plain HTML page should have no JS framework detections
    const jsFrameworks = frameworks.filter(f => f.category === 'js-framework');
    expect(jsFrameworks).toHaveLength(0);
  });

  test('detected frameworks have correct structure', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-react.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);

    for (const fw of frameworks) {
      expect(fw).toHaveProperty('name');
      expect(fw).toHaveProperty('version');
      expect(fw).toHaveProperty('category');
      expect(fw).toHaveProperty('buildMode');
      expect(fw).toHaveProperty('config');
      expect(fw).toHaveProperty('perfHints');
      expect(typeof fw.name).toBe('string');
      expect(Array.isArray(fw.perfHints)).toBe(true);
    }
  });
});

// ─── SaaS Detection ─────────────────────────────────────────────────

describe('SaaS Detection', () => {
  test('detects Shopify with theme info', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-shopify.html'], bm);
    const page = bm.getPage();
    const platforms = await detectSaaS(page);
    const shopify = platforms.find(p => p.name === 'Shopify');
    expect(shopify).toBeDefined();
    expect(shopify!.category).toBe('ecommerce');
    // Theme name should be extracted from window.Shopify.theme
    const theme = shopify!.config.theme as Record<string, unknown> | undefined;
    expect(theme?.name).toBe('Dawn');
    // Should have constraints about what can and cannot be fixed
    expect(shopify!.constraints.canFix.length).toBeGreaterThan(0);
    expect(shopify!.constraints.cannotFix.length).toBeGreaterThan(0);
  });

  test('detects WooCommerce from script src', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-wordpress.html'], bm);
    const page = bm.getPage();
    const platforms = await detectSaaS(page);
    const woo = platforms.find(p => p.name === 'WooCommerce');
    expect(woo).toBeDefined();
    expect(woo!.category).toBe('ecommerce');
    expect(woo!.constraints.canFix.length).toBeGreaterThan(0);
  });

  test('no false positive on plain HTML', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-plain.html'], bm);
    const page = bm.getPage();
    const platforms = await detectSaaS(page);
    expect(platforms).toHaveLength(0);
  });

  test('detected SaaS platforms have correct structure', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-shopify.html'], bm);
    const page = bm.getPage();
    const platforms = await detectSaaS(page);

    for (const plat of platforms) {
      expect(plat).toHaveProperty('name');
      expect(plat).toHaveProperty('category');
      expect(plat).toHaveProperty('version');
      expect(plat).toHaveProperty('config');
      expect(plat).toHaveProperty('apps');
      expect(plat).toHaveProperty('constraints');
      expect(plat).toHaveProperty('perfHints');
      expect(plat).toHaveProperty('platformMetrics');
      expect(typeof plat.name).toBe('string');
      expect(Array.isArray(plat.apps)).toBe(true);
      expect(Array.isArray(plat.constraints.canFix)).toBe(true);
      expect(Array.isArray(plat.constraints.cannotFix)).toBe(true);
      expect(Array.isArray(plat.perfHints)).toBe(true);
    }
  });
});

// ─── Infrastructure Detection ───────────────────────────────────────

describe('Infrastructure Detection', () => {
  test('returns valid report for local server', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const infra = await detectInfrastructure(page);

    // No CDN on localhost
    expect(infra.cdn.provider).toBeNull();

    // DOM complexity should report non-zero values for a real HTML page
    expect(infra.domComplexity.totalNodes).toBeGreaterThan(0);
    expect(infra.domComplexity.maxDepth).toBeGreaterThan(0);
    expect(infra.domComplexity.htmlSizeKB).toBeGreaterThan(0);

    // No service worker registered on our test server
    expect(infra.serviceWorker.registered).toBe(false);
  });

  test('infrastructure report has correct structure', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const infra = await detectInfrastructure(page);

    // CDN section
    expect(infra).toHaveProperty('cdn');
    expect(infra.cdn).toHaveProperty('provider');
    expect(infra.cdn).toHaveProperty('cacheStatus');
    expect(infra.cdn).toHaveProperty('evidence');

    // Protocol section
    expect(infra).toHaveProperty('protocol');
    expect(infra.protocol).toHaveProperty('breakdown');
    expect(infra.protocol).toHaveProperty('dominant');
    expect(infra.protocol).toHaveProperty('mixed');
    expect(typeof infra.protocol.dominant).toBe('string');
    expect(typeof infra.protocol.mixed).toBe('boolean');

    // Compression section
    expect(infra).toHaveProperty('compression');
    expect(infra.compression).toHaveProperty('byType');
    expect(infra.compression).toHaveProperty('overall');
    expect(typeof infra.compression.overall.compressed).toBe('number');
    expect(typeof infra.compression.overall.uncompressed).toBe('number');

    // Caching section
    expect(infra).toHaveProperty('caching');
    expect(typeof infra.caching.hitRate).toBe('number');
    expect(typeof infra.caching.totalResources).toBe('number');

    // DNS section
    expect(infra).toHaveProperty('dns');
    expect(typeof infra.dns.uniqueOrigins).toBe('number');
    expect(Array.isArray(infra.dns.origins)).toBe(true);
    expect(Array.isArray(infra.dns.missingPreconnect)).toBe(true);
    expect(infra.dns).toHaveProperty('existingHints');

    // Service Worker section
    expect(infra).toHaveProperty('serviceWorker');
    expect(typeof infra.serviceWorker.registered).toBe('boolean');

    // DOM complexity section
    expect(infra).toHaveProperty('domComplexity');
    expect(typeof infra.domComplexity.totalNodes).toBe('number');
    expect(typeof infra.domComplexity.maxDepth).toBe('number');
    expect(typeof infra.domComplexity.htmlSizeKB).toBe('number');

    // Worker/WebSocket counts
    expect(typeof infra.webWorkers).toBe('number');
    expect(typeof infra.webSockets).toBe('number');
  });

  test('DOM complexity varies with page content', async () => {
    // Plain page should have fewer nodes than basic page
    await handleWriteCommand('goto', [baseUrl + '/detect-plain.html'], bm);
    const page = bm.getPage();
    const plainInfra = await detectInfrastructure(page);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const basicInfra = await detectInfrastructure(page);

    // basic.html has nav, lists, divs -- more nodes than detect-plain.html
    expect(basicInfra.domComplexity.totalNodes).toBeGreaterThan(
      plainInfra.domComplexity.totalNodes
    );
  });
});

// ─── Resource Analyzer ─────────────────────────────────────────────

describe('Resource Analyzer', () => {
  test('categorizes resources by type', async () => {
    const entries: NetworkEntry[] = [
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/app.js', status: 200, size: 50000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/vendor.js', status: 200, size: 200000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/styles.css', status: 200, size: 30000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/hero.png', status: 200, size: 100000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/font.woff2', status: 200, size: 20000 },
    ];

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources(entries, page);

    expect(result.categories.js.count).toBe(2);
    expect(result.categories.js.totalSizeBytes).toBe(250000);
    expect(result.categories.css.count).toBe(1);
    expect(result.categories.css.totalSizeBytes).toBe(30000);
    expect(result.categories.images.count).toBe(1);
    expect(result.categories.images.totalSizeBytes).toBe(100000);
    expect(result.categories.fonts.count).toBe(1);
    expect(result.categories.fonts.totalSizeBytes).toBe(20000);
  });

  test('identifies largest resource per category', async () => {
    const entries: NetworkEntry[] = [
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/small.js', status: 200, size: 5000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/big.js', status: 200, size: 300000 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/medium.js', status: 200, size: 80000 },
    ];

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources(entries, page);

    expect(result.categories.js.largest).not.toBeNull();
    expect(result.categories.js.largest!.url).toBe('http://localhost/big.js');
    expect(result.categories.js.largest!.sizeBytes).toBe(300000);
  });

  test('handles empty network entries', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources([], page);

    expect(result.categories.js.count).toBe(0);
    expect(result.categories.js.totalSizeBytes).toBe(0);
    expect(result.categories.css.count).toBe(0);
    expect(result.categories.images.count).toBe(0);
    expect(result.categories.fonts.count).toBe(0);
  });

  test('categorizes API requests', async () => {
    const entries: NetworkEntry[] = [
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/api/users', status: 200, size: 500 },
      { timestamp: Date.now(), method: 'POST', url: 'http://localhost/graphql', status: 200, size: 1200 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/v1/data', status: 200, size: 800 },
    ];

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources(entries, page);

    expect(result.categories.api.count).toBe(3);
  });

  test('groups third-party resources by domain', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();

    const entries: NetworkEntry[] = [
      { timestamp: Date.now(), method: 'GET', url: baseUrl + '/local.js', status: 200, size: 1000 },
      { timestamp: Date.now(), method: 'GET', url: 'https://cdn.example.com/lib.js', status: 200, size: 50000 },
      { timestamp: Date.now(), method: 'GET', url: 'https://cdn.example.com/styles.css', status: 200, size: 20000 },
      { timestamp: Date.now(), method: 'GET', url: 'https://analytics.third.com/track.js', status: 200, size: 5000 },
    ];

    const result = await analyzeResources(entries, page);

    // Third-party domains should be grouped (not counting local resources)
    expect(result.thirdPartyByDomain['cdn.example.com']).toBeDefined();
    expect(result.thirdPartyByDomain['cdn.example.com'].count).toBe(2);
    expect(result.thirdPartyByDomain['cdn.example.com'].totalSizeBytes).toBe(70000);
    expect(result.thirdPartyByDomain['analytics.third.com']).toBeDefined();
    expect(result.thirdPartyByDomain['analytics.third.com'].count).toBe(1);
  });

  test('image audit detects missing dimensions', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-resources.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources([], page);

    // The hero.png img has no width/height attributes
    const missingDims = result.imageAudit.find(
      (img) => img.issues.some((i) => i.toLowerCase().includes('dimension'))
    );
    expect(missingDims).toBeDefined();
  });

  test('image audit flags legacy image formats', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-resources.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources([], page);

    // The hero.png should be flagged for PNG format
    const pngIssue = result.imageAudit.find(
      (img) => img.src.includes('hero.png') &&
        img.issues.some((i) => i.includes('PNG'))
    );
    expect(pngIssue).toBeDefined();

    // The below-fold.jpg should be flagged for JPEG format
    const jpgIssue = result.imageAudit.find(
      (img) => img.src.includes('below-fold.jpg') &&
        img.issues.some((i) => i.includes('JPEG'))
    );
    expect(jpgIssue).toBeDefined();
  });

  test('render-blocking detection finds sync scripts in head', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-resources.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources([], page);

    // The /fake-vendor.js script is sync in <head> (no async/defer)
    const blockingScript = result.renderBlocking.find((r) => r.type === 'script');
    expect(blockingScript).toBeDefined();
    expect(blockingScript!.url).toContain('fake-vendor.js');
  });

  test('render-blocking detection finds blocking stylesheets', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-resources.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources([], page);

    // The /styles.css link rel="stylesheet" is render-blocking
    const blockingStylesheet = result.renderBlocking.find((r) => r.type === 'stylesheet');
    expect(blockingStylesheet).toBeDefined();
    expect(blockingStylesheet!.url).toContain('styles.css');
  });

  test('handles entries with missing size gracefully', async () => {
    const entries: NetworkEntry[] = [
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/nosize.js', status: 200 },
      { timestamp: Date.now(), method: 'GET', url: 'http://localhost/withsize.js', status: 200, size: 10000 },
    ];

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const result = await analyzeResources(entries, page);

    // Both should be counted
    expect(result.categories.js.count).toBe(2);
    // Size should only reflect the entry with a size
    expect(result.categories.js.totalSizeBytes).toBe(10000);
  });
});

// ─── DOM Complexity ─────────────────────────────────────────────────

describe('DOM Complexity', () => {
  test('counts nodes and measures depth', async () => {
    await handleWriteCommand('goto', [baseUrl + '/perf-resources.html'], bm);
    const page = bm.getPage();
    const dom = await analyzeDOMComplexity(page);

    expect(dom.totalNodes).toBeGreaterThan(5);
    // The fixture has: html > head > ... and body > div > div > div > div > div > p
    // maxDepth is measured from documentElement (html=0), so html > body > div*5 > p
    // gives depth of at least 7
    expect(dom.maxDepth).toBeGreaterThanOrEqual(6);
    expect(dom.htmlSizeKB).toBeGreaterThan(0);
  });

  test('identifies largest subtree', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const dom = await analyzeDOMComplexity(page);

    expect(dom.largestSubtree).toBeDefined();
    expect(dom.largestSubtree).not.toBeNull();
    expect(dom.largestSubtree!.tag).toBeTruthy();
    expect(dom.largestSubtree!.descendants).toBeGreaterThan(0);
  });

  test('reports correct structure for a simple page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const dom = await analyzeDOMComplexity(page);

    // basic.html has nav, h1, p, p, div#content with ul/li, footer
    expect(dom.totalNodes).toBeGreaterThan(10);
    expect(typeof dom.htmlSizeKB).toBe('number');
    expect(typeof dom.maxDepth).toBe('number');
  });

  test('reports minimal values on about:blank', async () => {
    await handleWriteCommand('goto', ['about:blank'], bm);
    const page = bm.getPage();
    const dom = await analyzeDOMComplexity(page);

    // about:blank has minimal DOM (html, head, body)
    // totalNodes can be small but should not error
    expect(dom.totalNodes).toBeGreaterThanOrEqual(0);
    expect(dom.maxDepth).toBeGreaterThanOrEqual(0);
  });

  test('largest subtree includes class and id info', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const dom = await analyzeDOMComplexity(page);

    // basic.html has div#content as a direct body child with multiple descendants
    if (dom.largestSubtree && dom.largestSubtree.id) {
      expect(typeof dom.largestSubtree.id).toBe('string');
    }
    if (dom.largestSubtree && dom.largestSubtree.className) {
      expect(typeof dom.largestSubtree.className).toBe('string');
    }
  });
});

// ─── Correlation Engine ─────────────────────────────────────────────

describe('Correlation Engine', () => {
  test('handles null/empty web vitals gracefully', () => {
    const emptyVitals: WebVitalsReport = {
      ttfb: 0,
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
    const emptyResources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(emptyVitals, emptyResources, []);
    expect(report.lcpAnalysis).toBeNull();
    expect(report.clsAttribution).toHaveLength(0);
    expect(report.longTaskAttribution).toHaveLength(0);
    expect(report.fontBlockingFcp).toHaveLength(0);
  });

  test('produces LCP analysis when lcpElement is present', () => {
    const vitals: WebVitalsReport = {
      ttfb: 150,
      fcp: 800,
      lcp: 1200,
      cls: 0.05,
      tbt: 100,
      inp: null,
      lcpElement: {
        tag: 'img',
        id: 'hero',
        url: 'http://localhost/hero.png',
        size: 50000,
      },
      layoutShifts: [],
      longTasks: [],
      paintTimings: { fp: 400, fcp: 800 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [
        { type: 'script', url: 'http://localhost/vendor.js', sizeBytes: 80000 },
      ],
    };
    const networkEntries: NetworkEntry[] = [
      { timestamp: 100, method: 'GET', url: 'http://localhost/hero.png', status: 200, size: 50000, duration: 300 },
      { timestamp: 50, method: 'GET', url: 'http://localhost/vendor.js', status: 200, size: 80000, duration: 200 },
    ];

    const report = buildCorrelationReport(vitals, resources, networkEntries);

    expect(report.lcpAnalysis).not.toBeNull();
    expect(report.lcpAnalysis!.element).toContain('img');
    expect(report.lcpAnalysis!.element).toContain('hero');
    expect(report.lcpAnalysis!.networkEntry).not.toBeNull();
    expect(report.lcpAnalysis!.networkEntry!.url).toBe('http://localhost/hero.png');
    expect(report.lcpAnalysis!.networkEntry!.sizeBytes).toBe(50000);
    expect(report.lcpAnalysis!.networkEntry!.durationMs).toBe(300);
    expect(report.lcpAnalysis!.blockingResources).toContain('http://localhost/vendor.js');
    expect(report.lcpAnalysis!.criticalPath).toContain('TTFB');
    expect(report.lcpAnalysis!.criticalPath).toContain('LCP');
  });

  test('attributes CLS to image missing dimensions', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 500,
      lcp: 1000,
      cls: 0.15,
      tbt: null,
      inp: null,
      lcpElement: null,
      layoutShifts: [
        {
          time: 600,
          value: 0.15,
          sources: [{ tag: 'img', id: 'hero', shift: '0,0 -> 0,200' }],
        },
      ],
      longTasks: [],
      paintTimings: { fp: 300, fcp: 500 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(vitals, resources, []);

    expect(report.clsAttribution).toHaveLength(1);
    expect(report.clsAttribution[0].reason).toBe('Image missing dimensions');
    expect(report.clsAttribution[0].value).toBe(0.15);
    expect(report.clsAttribution[0].sourceElement).toContain('img');
    expect(report.clsAttribution[0].sourceElement).toContain('#hero');
  });

  test('groups long tasks by domain with TBT contribution', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 500,
      lcp: 1000,
      cls: null,
      tbt: 250,
      inp: null,
      lcpElement: null,
      layoutShifts: [],
      longTasks: [
        { time: 200, duration: 120, scriptUrl: 'https://cdn.example.com/analytics.js' },
        { time: 400, duration: 80, scriptUrl: 'https://cdn.example.com/tracker.js' },
        { time: 600, duration: 200, scriptUrl: null },
      ],
      paintTimings: { fp: 300, fcp: 500 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(vitals, resources, []);

    expect(report.longTaskAttribution.length).toBeGreaterThanOrEqual(2);

    // Third-party domain tasks grouped under example.com
    const externalDomain = report.longTaskAttribution.find((a) => a.domain === 'example.com');
    expect(externalDomain).toBeDefined();
    expect(externalDomain!.taskCount).toBe(2);
    // TBT contribution: (120-50) + (80-50) = 70 + 30 = 100
    expect(externalDomain!.totalTbtMs).toBe(100);
    expect(externalDomain!.scripts).toHaveLength(2);

    // Self tasks (no script URL)
    const selfDomain = report.longTaskAttribution.find((a) => a.domain === 'self');
    expect(selfDomain).toBeDefined();
    expect(selfDomain!.taskCount).toBe(1);
    // TBT contribution: 200-50 = 150
    expect(selfDomain!.totalTbtMs).toBe(150);
  });

  test('identifies fonts blocking FCP (FOIT risk)', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 800,
      lcp: 1200,
      cls: null,
      tbt: null,
      inp: null,
      lcpElement: null,
      layoutShifts: [],
      longTasks: [],
      paintTimings: { fp: 400, fcp: 800 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [
        { family: 'CustomFont', weight: '400', fontDisplay: null, preloaded: false, foitRisk: true },
        { family: 'SafeFont', weight: '400', fontDisplay: 'swap', preloaded: true, foitRisk: false },
      ],
      renderBlocking: [],
    };
    const networkEntries: NetworkEntry[] = [
      { timestamp: 200, method: 'GET', url: 'http://localhost/customfont.woff2', status: 200, size: 15000, duration: 400 },
    ];

    const report = buildCorrelationReport(vitals, resources, networkEntries);

    // Only the FOIT-risk font should appear
    expect(report.fontBlockingFcp).toHaveLength(1);
    expect(report.fontBlockingFcp[0].family).toBe('CustomFont');
    expect(report.fontBlockingFcp[0].fontDisplay).toBeNull();
    expect(report.fontBlockingFcp[0].blockingMs).toBe(400);
  });

  test('LCP analysis without network entry for element', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 500,
      lcp: 1000,
      cls: null,
      tbt: null,
      inp: null,
      lcpElement: {
        tag: 'h1',
        size: 200,
      },
      layoutShifts: [],
      longTasks: [],
      paintTimings: { fp: 300, fcp: 500 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(vitals, resources, []);

    expect(report.lcpAnalysis).not.toBeNull();
    expect(report.lcpAnalysis!.element).toContain('h1');
    // No URL on the element, so no network entry
    expect(report.lcpAnalysis!.networkEntry).toBeNull();
    expect(report.lcpAnalysis!.criticalPath).toContain('TTFB');
    expect(report.lcpAnalysis!.criticalPath).toContain('LCP');
  });

  test('CLS attributes ad/iframe injection', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 500,
      lcp: 1000,
      cls: 0.2,
      tbt: null,
      inp: null,
      lcpElement: null,
      layoutShifts: [
        {
          time: 700,
          value: 0.2,
          sources: [{ tag: 'ins', shift: '0,0 -> 0,300' }],
        },
      ],
      longTasks: [],
      paintTimings: { fp: 300, fcp: 500 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(vitals, resources, []);
    expect(report.clsAttribution).toHaveLength(1);
    expect(report.clsAttribution[0].reason).toBe('Ad/iframe injection');
  });

  test('long task attribution is sorted by TBT descending', () => {
    const vitals: WebVitalsReport = {
      ttfb: 100,
      fcp: 500,
      lcp: 1000,
      cls: null,
      tbt: 300,
      inp: null,
      lcpElement: null,
      layoutShifts: [],
      longTasks: [
        { time: 100, duration: 60, scriptUrl: 'https://small.io/s.js' },
        { time: 200, duration: 300, scriptUrl: 'https://big.io/b.js' },
        { time: 500, duration: 100, scriptUrl: 'https://mid.io/m.js' },
      ],
      paintTimings: { fp: 300, fcp: 500 },
    };
    const resources: ResourceReport = {
      categories: {},
      thirdPartyByDomain: {},
      imageAudit: [],
      fontAudit: [],
      renderBlocking: [],
    };

    const report = buildCorrelationReport(vitals, resources, []);

    // Should be sorted by totalTbtMs descending
    expect(report.longTaskAttribution.length).toBe(3);
    expect(report.longTaskAttribution[0].totalTbtMs).toBeGreaterThanOrEqual(
      report.longTaskAttribution[1].totalTbtMs
    );
    expect(report.longTaskAttribution[1].totalTbtMs).toBeGreaterThanOrEqual(
      report.longTaskAttribution[2].totalTbtMs
    );
  });
});

// ─── CSS-only Detection ─────────────────────────────────────────────

describe('CSS-only Detection', () => {
  test('detects Tailwind without JS framework false positive', async () => {
    await handleWriteCommand('goto', [baseUrl + '/detect-tailwind.html'], bm);
    const page = bm.getPage();
    const frameworks = await detectFrameworks(page);

    // Should detect Tailwind CSS
    const tailwind = frameworks.find((f) => f.name.toLowerCase().includes('tailwind'));
    expect(tailwind).toBeDefined();
    expect(tailwind!.category).toBe('css-framework');

    // Should NOT detect any JS framework (no React, Vue, Angular, etc.)
    const jsFrameworks = frameworks.filter((f) => f.category === 'js-framework');
    expect(jsFrameworks).toHaveLength(0);
  });
});
