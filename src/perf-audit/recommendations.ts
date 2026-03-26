/**
 * Recommendation engine for performance audit reports.
 *
 * Generates 3-5 prioritized, actionable recommendations from actual measured
 * data. When a SaaS platform is detected, includes platform-specific
 * suggestions tailored to Shopify, WordPress, Magento, and Wix.
 *
 * Recommendations are scored by estimated impact (bytes saved or ms reduced)
 * and returned sorted by priority.
 */

import type { PerfAuditReport, CoverageResult } from './index';
import type { ResourceReport } from './resource-analyzer';
import type { DetectedSaaS } from '../detection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScoredRec {
  text: string;
  /** Estimated impact in bytes saved or ms reduced */
  impact: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function urlFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const i = pathname.lastIndexOf('/');
    return i !== -1 && i < pathname.length - 1 ? pathname.slice(i + 1) : url;
  } catch {
    return url;
  }
}

function extractExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return '';
    return pathname.slice(lastDot).toLowerCase();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main recommendation generator
// ---------------------------------------------------------------------------

/**
 * Analyze the full PerfAuditReport and produce a prioritized list of
 * actionable recommendation strings. Returns up to ~15 candidates
 * sorted by estimated impact; the caller should cap at 3-5.
 */
export function generateRecommendations(report: PerfAuditReport): string[] {
  const candidates: ScoredRec[] = [];

  const { webVitals, resources, correlations, detection, coverage } = report;

  // ── LCP image optimization ─────────────────────────────────────────

  if (correlations.lcpAnalysis?.networkEntry) {
    const lcpNet = correlations.lcpAnalysis.networkEntry;
    const lcpEl = webVitals.lcpElement;

    // Check if LCP is a large image that could use modern format
    if (lcpNet.sizeBytes > 50_000 && lcpEl?.url) {
      const ext = extractExtension(lcpEl.url);
      if (['.png', '.jpg', '.jpeg', '.bmp', '.gif'].includes(ext)) {
        const savings = Math.round(lcpNet.sizeBytes * 0.6); // ~60% savings with WebP
        const formatName =
          ext === '.png' ? 'PNG' : ext === '.gif' ? 'GIF' : 'JPEG';
        candidates.push({
          text: `Convert ${urlFilename(lcpEl.url)} from ${formatName} to WebP (-${formatBytes(savings)} estimated)`,
          impact: savings,
        });
      }
    }

    // Missing fetchpriority on LCP image
    if (lcpEl && !lcpEl.fetchpriority && lcpEl.url) {
      candidates.push({
        text: `Add fetchpriority="high" to LCP image <${lcpEl.tag} src="${urlFilename(lcpEl.url)}">`,
        impact: 500_000, // High priority -- can improve LCP significantly
      });
    }

    // Missing loading attribute (should NOT be lazy for LCP element)
    if (lcpEl?.loading === 'lazy') {
      candidates.push({
        text: 'Remove loading="lazy" from LCP element -- lazy-loading the LCP image delays it',
        impact: 800_000,
      });
    }
  }

  // ── Render-blocking resources ──────────────────────────────────────

  for (const rb of resources.renderBlocking) {
    if (
      rb.type === 'script' &&
      rb.sizeBytes != null &&
      rb.sizeBytes > 10_000
    ) {
      candidates.push({
        text: `Defer or async ${urlFilename(rb.url)} (${formatBytes(rb.sizeBytes)} render-blocking script)`,
        impact: rb.sizeBytes,
      });
    }
  }

  // ── Code splitting based on coverage ───────────────────────────────

  if (coverage) {
    addCoverageRecs(coverage, candidates);
  }

  // ── Font optimization ──────────────────────────────────────────────

  for (const font of resources.fontAudit) {
    if (font.foitRisk) {
      candidates.push({
        text: `Add font-display:swap to ${font.family} font (FOIT risk)`,
        impact: 100_000, // Moderate impact on perceived performance
      });
    }
    if (!font.preloaded && font.foitRisk) {
      candidates.push({
        text: `Preload ${font.family} font to avoid late discovery`,
        impact: 80_000,
      });
    }
  }

  // ── Image audit issues (non-LCP) ──────────────────────────────────

  for (const img of resources.imageAudit) {
    for (const issue of img.issues) {
      if (issue.includes('Oversized')) {
        candidates.push({
          text: `Resize ${urlFilename(img.src)}: ${issue}`,
          impact: 150_000,
        });
      }
    }
  }

  // ── Missing preconnect for heavy third-party domains ───────────────

  if (detection?.infrastructure.dns.missingPreconnect.length) {
    const missing = detection.infrastructure.dns.missingPreconnect;
    if (missing.length > 0) {
      const domains = missing.slice(0, 3).join(', ');
      candidates.push({
        text: `Add <link rel="preconnect"> for ${domains}`,
        impact: 50_000,
      });
    }
  }

  // ── Platform-specific recommendations ──────────────────────────────

  if (detection?.saas) {
    for (const saas of detection.saas) {
      generatePlatformRecs(saas, resources, candidates);
    }
  }

  // Sort by estimated impact (descending) and return text only
  candidates.sort((a, b) => b.impact - a.impact);

  // Deduplicate similar recommendations
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of candidates) {
    // Simple dedup key: first 40 chars lowercase
    const key = c.text.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c.text);
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// Coverage-based recommendations
// ---------------------------------------------------------------------------

function addCoverageRecs(
  coverage: CoverageResult,
  candidates: ScoredRec[],
): void {
  const allCoverage = [...coverage.js, ...coverage.css];
  const sorted = allCoverage
    .filter((e) => e.unusedPct > 40 && e.unusedBytes > 10_000)
    .sort((a, b) => b.unusedBytes - a.unusedBytes);

  for (const entry of sorted.slice(0, 3)) {
    const name = entry.url ? urlFilename(entry.url) : '[inline]';
    const isJS = coverage.js.includes(entry);
    const typeLabel = isJS ? 'Code-split' : 'Purge unused CSS from';
    candidates.push({
      text: `${typeLabel} ${name} (${formatBytes(entry.unusedBytes)} unused / ${entry.unusedPct.toFixed(0)}%)`,
      impact: entry.unusedBytes,
    });
  }
}

// ---------------------------------------------------------------------------
// Platform-specific recommendation generators
// ---------------------------------------------------------------------------

/**
 * Route to the correct platform-specific recommendation generator based
 * on the detected SaaS platform name.
 */
function generatePlatformRecs(
  saas: DetectedSaaS,
  resources: ResourceReport,
  candidates: ScoredRec[],
): void {
  const platformName = saas.name.toLowerCase();

  if (platformName.includes('shopify')) {
    generateShopifyRecs(saas, candidates);
  } else if (
    platformName.includes('wordpress') ||
    platformName.includes('wp')
  ) {
    generateWordPressRecs(saas, candidates);
  } else if (platformName.includes('magento')) {
    generateMagentoRecs(saas, candidates);
  } else if (platformName.includes('wix')) {
    generateWixRecs(saas, resources, candidates);
  }
}

function generateShopifyRecs(
  saas: DetectedSaaS,
  candidates: ScoredRec[],
): void {
  // Flag unused apps with size estimates
  const unusedApps = saas.apps.filter(
    (a) => !a.usedOnPage && a.totalSizeKB > 5,
  );
  for (const app of unusedApps) {
    candidates.push({
      text: `Remove ${app.name} app from this template (-${app.totalSizeKB.toFixed(0)}KB)`,
      impact: app.totalSizeKB * 1024,
    });
  }

  // Flag apps that overlap functionality
  const reviewApps = saas.apps.filter((a) =>
    /judge\.me|loox|stamped|rivyo|opinew|ali.review|fera/i.test(a.name),
  );
  if (reviewApps.length > 1) {
    const names = reviewApps.map((a) => a.name).join(', ');
    const totalKB = reviewApps.reduce((sum, a) => sum + a.totalSizeKB, 0);
    candidates.push({
      text: `Audit overlapping review apps: ${names} (-${totalKB.toFixed(0)}KB combined)`,
      impact: totalKB * 1024,
    });
  }

  // Vitals app overlap check
  const vitalsApp = saas.apps.find((a) => /vitals/i.test(a.name));
  if (vitalsApp) {
    const overlapping = saas.apps.filter(
      (a) =>
        a !== vitalsApp &&
        /judge\.me|currency|countdown|announcement|reviews/i.test(a.name),
    );
    if (overlapping.length > 0) {
      const names = overlapping.map((a) => a.name).join(', ');
      const totalKB = overlapping.reduce((sum, a) => sum + a.totalSizeKB, 0);
      candidates.push({
        text: `Audit Vitals app features for overlap with ${names} (-${totalKB.toFixed(0)}KB)`,
        impact: totalKB * 1024,
      });
    }
  }

  // Total unused apps summary
  if (unusedApps.length >= 3) {
    const totalKB = unusedApps.reduce((sum, a) => sum + a.totalSizeKB, 0);
    candidates.push({
      text: `${unusedApps.length} unused Shopify apps loaded on this page (-${totalKB.toFixed(0)}KB total)`,
      impact: totalKB * 1024,
    });
  }
}

function generateWordPressRecs(
  saas: DetectedSaaS,
  candidates: ScoredRec[],
): void {
  // Flag unused apps/plugins
  const unusedApps = saas.apps.filter(
    (a) => !a.usedOnPage && a.totalSizeKB > 5,
  );
  for (const app of unusedApps) {
    candidates.push({
      text: `Deactivate ${app.name} on non-relevant pages (-${app.totalSizeKB.toFixed(0)}KB)`,
      impact: app.totalSizeKB * 1024,
    });
  }

  // WooCommerce cart-fragments optimization
  const wooApp = saas.apps.find((a) => /woocommerce|woo/i.test(a.name));
  if (wooApp) {
    candidates.push({
      text: `Disable WooCommerce cart-fragments on non-shop pages (-${Math.min(wooApp.totalSizeKB, 45).toFixed(0)}KB)`,
      impact: 45_000,
    });
  }

  // Contact Form 7 on non-contact pages
  const cf7App = saas.apps.find((a) => /contact.form.7|cf7/i.test(a.name));
  if (cf7App && !cf7App.usedOnPage) {
    candidates.push({
      text: `Deactivate Contact Form 7 on non-contact pages (-${cf7App.totalSizeKB.toFixed(0)}KB)`,
      impact: cf7App.totalSizeKB * 1024,
    });
  }
}

function generateMagentoRecs(
  saas: DetectedSaaS,
  candidates: ScoredRec[],
): void {
  // RequireJS bundling recommendation
  candidates.push({
    text: 'Enable JS bundling in Stores > Configuration > Advanced > Developer',
    impact: 300_000, // Large impact due to RequireJS waterfall
  });

  // Customer-data sections
  candidates.push({
    text: 'Reduce customer-data sections to minimize private content requests',
    impact: 100_000,
  });

  // Unused modules
  const unusedApps = saas.apps.filter(
    (a) => !a.usedOnPage && a.totalSizeKB > 10,
  );
  for (const app of unusedApps) {
    candidates.push({
      text: `Disable ${app.name} module on this page type (-${app.totalSizeKB.toFixed(0)}KB)`,
      impact: app.totalSizeKB * 1024,
    });
  }
}

function generateWixRecs(
  saas: DetectedSaaS,
  resources: ResourceReport,
  candidates: ScoredRec[],
): void {
  // Wix runtime is fixed -- flag it as a constraint and redirect focus
  const jsCategory = resources.categories['js'];
  const totalJsKB = jsCategory
    ? Math.round(jsCategory.totalSizeBytes / 1024)
    : 0;

  if (totalJsKB > 500) {
    candidates.push({
      text: `Platform runtime is ${totalJsKB}KB JS -- focus on image optimization and content structure`,
      impact: 10_000, // Low "fixable" impact since it's a constraint
    });
  }

  // Image optimization is the primary lever on Wix
  const imgCategory = resources.categories['images'];
  if (imgCategory && imgCategory.totalSizeBytes > 500_000) {
    candidates.push({
      text: `Optimize images (${formatBytes(imgCategory.totalSizeBytes)} total) -- primary optimization lever on Wix`,
      impact: Math.round(imgCategory.totalSizeBytes * 0.5),
    });
  }
}
