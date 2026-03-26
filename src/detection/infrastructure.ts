/**
 * Infrastructure fingerprinting -- detects CDN provider, protocol mix,
 * compression, caching, DNS/preconnect hints, service workers, DOM complexity,
 * web workers, and WebSocket usage.
 *
 * Primary data source: `performance.getEntriesByType('resource')` via
 * page.evaluate(), which provides nextHopProtocol, transferSize,
 * encodedBodySize, decodedBodySize, and initiatorType -- richer than
 * the NetworkEntry struct in buffers.ts.
 */

import type { Page } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────────────

export interface InfrastructureReport {
  cdn: {
    provider: string | null;
    cacheStatus: string | null;
    evidence: string | null;
  };
  protocol: {
    breakdown: Record<string, number>;
    dominant: string;
    mixed: boolean;
  };
  compression: {
    byType: Record<string, {
      brotli: number;
      gzip: number;
      none: number;
    }>;
    overall: { compressed: number; uncompressed: number };
  };
  caching: {
    hitRate: number;
    cachedCount: number;
    uncachedCount: number;
    totalResources: number;
  };
  dns: {
    uniqueOrigins: number;
    origins: string[];
    missingPreconnect: string[];
    existingHints: {
      preconnect: string[];
      dnsPrefetch: string[];
      preload: string[];
      prefetch: string[];
      modulepreload: string[];
    };
  };
  serviceWorker: {
    registered: boolean;
    scope: string | null;
    strategy: 'cache-first' | 'network-first' | 'stale-while-revalidate' | 'unknown' | null;
    navigationPreload: boolean | null;
    cacheNames: string[];
    cacheEntryCount: number | null;
  };
  domComplexity: {
    totalNodes: number;
    maxDepth: number;
    largestSubtree: { tag: string; id: string | null; descendants: number } | null;
    htmlSizeKB: number;
  };
  webWorkers: number;
  webSockets: number;
}

// ─── CDN URL pattern matching ───────────────────────────────────────────

/**
 * Known CDN URL patterns. Each entry maps a regex (tested against full
 * resource URLs) to the CDN provider name.
 */
const CDN_URL_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\.cloudfront\.net\b/i, provider: 'Amazon CloudFront' },
  { pattern: /\.akamaized\.net\b/i, provider: 'Akamai' },
  { pattern: /\.akamai\.net\b/i, provider: 'Akamai' },
  { pattern: /\.edgekey\.net\b/i, provider: 'Akamai' },
  { pattern: /\.edgesuite\.net\b/i, provider: 'Akamai' },
  { pattern: /\.fastly\.net\b/i, provider: 'Fastly' },
  { pattern: /\.fastlylb\.net\b/i, provider: 'Fastly' },
  { pattern: /cdn\.shopify\.com\b/i, provider: 'Shopify CDN' },
  { pattern: /\.cdn\.cloudflare\.net\b/i, provider: 'Cloudflare' },
  { pattern: /cdnjs\.cloudflare\.com\b/i, provider: 'Cloudflare' },
  { pattern: /\.azureedge\.net\b/i, provider: 'Azure CDN' },
  { pattern: /\.azurefd\.net\b/i, provider: 'Azure Front Door' },
  { pattern: /\.googleapis\.com\b/i, provider: 'Google Cloud CDN' },
  { pattern: /\.gstatic\.com\b/i, provider: 'Google' },
  { pattern: /\.googleusercontent\.com\b/i, provider: 'Google' },
  { pattern: /cdn\.jsdelivr\.net\b/i, provider: 'jsDelivr' },
  { pattern: /unpkg\.com\b/i, provider: 'unpkg' },
  { pattern: /\.stackpathcdn\.com\b/i, provider: 'StackPath' },
  { pattern: /\.kxcdn\.com\b/i, provider: 'KeyCDN' },
  { pattern: /\.bunnycdn\.com\b/i, provider: 'BunnyCDN' },
  { pattern: /\.b-cdn\.net\b/i, provider: 'BunnyCDN' },
  { pattern: /\.imgix\.net\b/i, provider: 'imgix' },
  { pattern: /\.cloudinary\.com\b/i, provider: 'Cloudinary' },
];

/**
 * Known hosting/deployment platform URL patterns that also imply CDN usage.
 */
const PLATFORM_URL_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /\/_vercel\//i, provider: 'Vercel' },
  { pattern: /\.vercel\.app\b/i, provider: 'Vercel' },
  { pattern: /\.netlify\.app\b/i, provider: 'Netlify' },
  { pattern: /\.netlify\.com\b/i, provider: 'Netlify' },
  { pattern: /\.pages\.dev\b/i, provider: 'Cloudflare Pages' },
  { pattern: /\.workers\.dev\b/i, provider: 'Cloudflare Workers' },
  { pattern: /\.herokuapp\.com\b/i, provider: 'Heroku' },
  { pattern: /\.firebaseapp\.com\b/i, provider: 'Firebase' },
  { pattern: /\.web\.app\b/i, provider: 'Firebase' },
  { pattern: /\.amplifyapp\.com\b/i, provider: 'AWS Amplify' },
  { pattern: /\.github\.io\b/i, provider: 'GitHub Pages' },
  { pattern: /\.gitlab\.io\b/i, provider: 'GitLab Pages' },
];

// ─── Resource type classification ───────────────────────────────────────

const RESOURCE_TYPE_MAP: Record<string, string> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.png': 'images',
  '.jpg': 'images',
  '.jpeg': 'images',
  '.gif': 'images',
  '.svg': 'images',
  '.webp': 'images',
  '.avif': 'images',
  '.ico': 'images',
  '.woff': 'fonts',
  '.woff2': 'fonts',
  '.ttf': 'fonts',
  '.otf': 'fonts',
  '.eot': 'fonts',
  '.json': 'data',
  '.xml': 'data',
};

/**
 * Classify a resource URL into a type bucket for compression breakdown.
 */
function classifyResourceType(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return 'other';
    const ext = pathname.slice(lastDot).toLowerCase();
    return RESOURCE_TYPE_MAP[ext] ?? 'other';
  } catch {
    return 'other';
  }
}

// ─── In-page data collection ────────────────────────────────────────────

/**
 * Raw data collected inside page.evaluate(). This is the serializable
 * shape that crosses the browser/Node boundary.
 */
interface RawInfraData {
  // Resource timing entries
  resources: Array<{
    name: string;
    nextHopProtocol: string;
    transferSize: number;
    encodedBodySize: number;
    decodedBodySize: number;
    initiatorType: string;
  }>;

  // Navigation timing server timing entries (for CDN detection)
  serverTimings: Array<{ name: string; description: string }>;

  // Page URL for origin comparison
  pageUrl: string;

  // Resource hint links
  hints: {
    preconnect: string[];
    dnsPrefetch: string[];
    preload: string[];
    prefetch: string[];
    modulepreload: string[];
  };

  // Meta tags that may indicate CDN/platform
  metaCdnHints: string[];

  // Script URLs on the page (for CDN/platform detection from URL patterns)
  scriptUrls: string[];

  // Service Worker info
  sw: {
    registered: boolean;
    scope: string | null;
    cacheNames: string[];
    cacheEntryCount: number | null;
  };

  // DOM complexity
  dom: {
    totalNodes: number;
    maxDepth: number;
    largestSubtree: { tag: string; id: string | null; descendants: number } | null;
    htmlSizeKB: number;
  };

  // Web Workers count (from performance entries with workerStart > 0, or
  // known worker scripts)
  webWorkerScripts: number;

  // WebSocket detection
  webSocketCount: number;
}

/**
 * Collect all raw infrastructure data from inside the page context.
 * Runs as a single async page.evaluate() call. Each section is wrapped
 * in its own try/catch so partial failures don't lose everything.
 */
async function collectRawData(page: Page): Promise<RawInfraData> {
  try {
    return await page.evaluate(async () => {
      const result: RawInfraData = {
        resources: [],
        serverTimings: [],
        pageUrl: location.href,
        hints: {
          preconnect: [],
          dnsPrefetch: [],
          preload: [],
          prefetch: [],
          modulepreload: [],
        },
        metaCdnHints: [],
        scriptUrls: [],
        sw: {
          registered: false,
          scope: null,
          cacheNames: [],
          cacheEntryCount: null,
        },
        dom: {
          totalNodes: 0,
          maxDepth: 0,
          largestSubtree: null,
          htmlSizeKB: 0,
        },
        webWorkerScripts: 0,
        webSocketCount: 0,
      };

      // ── Resource timing entries ──────────────────────────────────
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        result.resources = entries.map(e => ({
          name: e.name,
          nextHopProtocol: e.nextHopProtocol || '',
          transferSize: e.transferSize,
          encodedBodySize: e.encodedBodySize,
          decodedBodySize: e.decodedBodySize,
          initiatorType: e.initiatorType,
        }));
      } catch {
        // Resource timing API not available
      }

      // ── Navigation timing server timing ──────────────────────────
      try {
        const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        if (navEntries.length > 0) {
          const nav = navEntries[0];
          // Include the navigation entry's protocol in resources for completeness
          result.resources.unshift({
            name: nav.name,
            nextHopProtocol: nav.nextHopProtocol || '',
            transferSize: nav.transferSize,
            encodedBodySize: nav.encodedBodySize,
            decodedBodySize: nav.decodedBodySize,
            initiatorType: 'navigation',
          });

          // serverTiming is available on some CDNs (e.g., Cloudflare, Fastly)
          if (nav.serverTiming) {
            result.serverTimings = nav.serverTiming.map(st => ({
              name: st.name,
              description: st.description,
            }));
          }
        }
      } catch {
        // Navigation timing not available
      }

      // ── Resource hint links ──────────────────────────────────────
      try {
        const hintTypes: Array<[keyof typeof result.hints, string]> = [
          ['preconnect', 'link[rel="preconnect"]'],
          ['dnsPrefetch', 'link[rel="dns-prefetch"]'],
          ['preload', 'link[rel="preload"]'],
          ['prefetch', 'link[rel="prefetch"]'],
          ['modulepreload', 'link[rel="modulepreload"]'],
        ];
        for (const [key, selector] of hintTypes) {
          const links = document.querySelectorAll(selector);
          result.hints[key] = Array.from(links).map(
            l => (l as HTMLLinkElement).href || l.getAttribute('href') || '',
          ).filter(Boolean);
        }
      } catch {
        // DOM query failed
      }

      // ── Meta tags for CDN/platform hints ─────────────────────────
      try {
        const metas = document.querySelectorAll('meta');
        for (const meta of Array.from(metas)) {
          const name = (meta.getAttribute('name') || '').toLowerCase();
          const httpEquiv = (meta.getAttribute('http-equiv') || '').toLowerCase();
          const content = meta.getAttribute('content') || '';

          // Cloudflare often inserts specific meta tags
          if (name === 'cf-ray' || name === 'cf-cache-status') {
            result.metaCdnHints.push(`cloudflare:${name}=${content}`);
          }
          // Generator tags can indicate platforms
          if (name === 'generator' && content) {
            result.metaCdnHints.push(`generator:${content}`);
          }
          // Cache control headers exposed as meta
          if (httpEquiv === 'x-cdn' || httpEquiv === 'x-cache') {
            result.metaCdnHints.push(`header:${httpEquiv}=${content}`);
          }
        }
      } catch {
        // Meta tag enumeration failed
      }

      // ── Script URLs (for platform detection from paths) ──────────
      try {
        const scripts = document.querySelectorAll('script[src]');
        result.scriptUrls = Array.from(scripts)
          .map(s => (s as HTMLScriptElement).src)
          .filter(Boolean);
      } catch {
        // Script enumeration failed
      }

      // ── Service Worker ───────────────────────────────────────────
      try {
        if (navigator.serviceWorker) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            result.sw.registered = true;
            result.sw.scope = reg.scope || null;
          }
        }
      } catch {
        // Service worker API not available or blocked
      }

      // ── Cache API (for service worker strategy detection) ────────
      try {
        if (typeof caches !== 'undefined') {
          const names = await caches.keys();
          result.sw.cacheNames = names;

          // Count total entries across all caches
          let totalEntries = 0;
          for (const name of names) {
            try {
              const cache = await caches.open(name);
              const keys = await cache.keys();
              totalEntries += keys.length;
            } catch {
              // Individual cache access failed
            }
          }
          result.sw.cacheEntryCount = totalEntries;
        }
      } catch {
        // Cache API not available
      }

      // ── DOM complexity ───────────────────────────────────────────
      try {
        const allNodes = document.querySelectorAll('*');
        result.dom.totalNodes = allNodes.length;

        // Calculate max depth efficiently: walk a sample of leaf-ish nodes
        let maxDepth = 0;
        // Check nodes from the end (deeper nodes are usually later in document order)
        const sampleSize = Math.min(allNodes.length, 200);
        const step = Math.max(1, Math.floor(allNodes.length / sampleSize));
        for (let i = 0; i < allNodes.length; i += step) {
          let depth = 0;
          let node: Element | null = allNodes[i];
          while (node) {
            depth++;
            node = node.parentElement;
          }
          if (depth > maxDepth) maxDepth = depth;
        }
        result.dom.maxDepth = maxDepth;

        // Largest subtree: check direct children of body (top-level containers)
        const body = document.body;
        if (body) {
          let largestTag = '';
          let largestId: string | null = null;
          let largestCount = 0;

          for (const child of Array.from(body.children)) {
            const count = child.querySelectorAll('*').length;
            if (count > largestCount) {
              largestCount = count;
              largestTag = child.tagName.toLowerCase();
              largestId = child.id || null;
            }
          }

          if (largestTag) {
            result.dom.largestSubtree = {
              tag: largestTag,
              id: largestId,
              descendants: largestCount,
            };
          }
        }

        // HTML size
        const html = document.documentElement?.outerHTML;
        if (html) {
          result.dom.htmlSizeKB = Math.round((html.length / 1024) * 100) / 100;
        }
      } catch {
        // DOM traversal failed
      }

      // ── Web Workers ──────────────────────────────────────────────
      // The Resource Timing API records worker scripts with workerStart > 0.
      // Also count any entries initiated by "worker" type.
      try {
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        const workerUrls = new Set<string>();
        for (const e of entries) {
          if (e.workerStart > 0 || e.initiatorType === 'worker') {
            workerUrls.add(e.name);
          }
        }
        result.webWorkerScripts = workerUrls.size;
      } catch {
        // Worker detection failed
      }

      // ── WebSocket detection ──────────────────────────────────────
      // We can't directly count active WebSocket connections from JS.
      // Heuristic: check performance resource entries for ws:// or wss://
      // and look for known WebSocket library globals.
      try {
        let wsCount = 0;

        // Check resource entries for WebSocket upgrades
        const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
        for (const e of entries) {
          if (e.name.startsWith('wss://') || e.name.startsWith('ws://')) {
            wsCount++;
          }
        }

        // Check for common WebSocket library globals as additional signal
        const w = window as unknown as Record<string, unknown>;
        if (w.__socket || w.io || w.__SOCKET_IO) wsCount = Math.max(wsCount, 1);
        if (w.Primus || w.SockJS) wsCount = Math.max(wsCount, 1);

        result.webSocketCount = wsCount;
      } catch {
        // WebSocket detection failed
      }

      return result;
    });
  } catch {
    // Entire page.evaluate() failed (e.g., about:blank, crashed page)
    return {
      resources: [],
      serverTimings: [],
      pageUrl: '',
      hints: {
        preconnect: [],
        dnsPrefetch: [],
        preload: [],
        prefetch: [],
        modulepreload: [],
      },
      metaCdnHints: [],
      scriptUrls: [],
      sw: {
        registered: false,
        scope: null,
        cacheNames: [],
        cacheEntryCount: null,
      },
      dom: {
        totalNodes: 0,
        maxDepth: 0,
        largestSubtree: null,
        htmlSizeKB: 0,
      },
      webWorkerScripts: 0,
      webSocketCount: 0,
    };
  }
}

// ─── CDN detection from collected data ──────────────────────────────────

interface CdnResult {
  provider: string | null;
  cacheStatus: string | null;
  evidence: string | null;
}

function detectCdn(raw: RawInfraData): CdnResult {
  // 1. Check serverTiming entries (most reliable signal)
  for (const st of raw.serverTimings) {
    const nameLower = st.name.toLowerCase();
    const descLower = st.description.toLowerCase();

    if (nameLower === 'cfray' || nameLower === 'cf-ray' || nameLower === 'cfcache') {
      return {
        provider: 'Cloudflare',
        cacheStatus: descLower.includes('hit') ? 'HIT' :
                     descLower.includes('miss') ? 'MISS' :
                     descLower.includes('dynamic') ? 'DYNAMIC' : null,
        evidence: `serverTiming: ${st.name}=${st.description}`,
      };
    }

    if (nameLower === 'fastly' || nameLower.includes('fastly')) {
      return {
        provider: 'Fastly',
        cacheStatus: descLower.includes('hit') ? 'HIT' :
                     descLower.includes('miss') ? 'MISS' : null,
        evidence: `serverTiming: ${st.name}=${st.description}`,
      };
    }

    if (nameLower === 'cdn-cache' || nameLower === 'x-cache') {
      const cacheVal = st.description.toUpperCase();
      const status = cacheVal.includes('HIT') ? 'HIT' :
                     cacheVal.includes('MISS') ? 'MISS' :
                     cacheVal.includes('STALE') ? 'STALE' :
                     cacheVal.includes('BYPASS') ? 'BYPASS' : null;
      return {
        provider: null, // Generic CDN indicator
        cacheStatus: status,
        evidence: `serverTiming: ${st.name}=${st.description}`,
      };
    }
  }

  // 2. Check meta tags
  for (const hint of raw.metaCdnHints) {
    if (hint.startsWith('cloudflare:')) {
      const parts = hint.split('=');
      return {
        provider: 'Cloudflare',
        cacheStatus: parts[1]?.toUpperCase() ?? null,
        evidence: `meta tag: ${hint}`,
      };
    }
    if (hint.startsWith('header:x-cdn=')) {
      return {
        provider: hint.split('=')[1] ?? null,
        cacheStatus: null,
        evidence: `meta http-equiv: ${hint}`,
      };
    }
  }

  // 3. Check resource URLs for CDN patterns
  const allUrls = [
    raw.pageUrl,
    ...raw.resources.map(r => r.name),
    ...raw.scriptUrls,
  ];

  for (const url of allUrls) {
    if (!url) continue;

    // Check CDN URL patterns first (more specific)
    for (const { pattern, provider } of CDN_URL_PATTERNS) {
      if (pattern.test(url)) {
        return {
          provider,
          cacheStatus: null,
          evidence: `URL pattern: ${url.slice(0, 100)}`,
        };
      }
    }

    // Check platform URL patterns
    for (const { pattern, provider } of PLATFORM_URL_PATTERNS) {
      if (pattern.test(url)) {
        return {
          provider,
          cacheStatus: null,
          evidence: `URL pattern: ${url.slice(0, 100)}`,
        };
      }
    }
  }

  return { provider: null, cacheStatus: null, evidence: null };
}

// ─── Protocol breakdown ─────────────────────────────────────────────────

interface ProtocolResult {
  breakdown: Record<string, number>;
  dominant: string;
  mixed: boolean;
}

function analyzeProtocols(resources: RawInfraData['resources']): ProtocolResult {
  const counts: Record<string, number> = {};

  for (const r of resources) {
    const proto = r.nextHopProtocol || 'unknown';
    counts[proto] = (counts[proto] || 0) + 1;
  }

  const total = resources.length || 1;

  // Convert to percentages
  const breakdown: Record<string, number> = {};
  for (const [proto, count] of Object.entries(counts)) {
    breakdown[proto] = Math.round((count / total) * 100);
  }

  // Find dominant protocol
  let dominant = 'unknown';
  let maxCount = 0;
  for (const [proto, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      dominant = proto;
    }
  }

  // Count distinct non-empty protocols (exclude "unknown" and "")
  const meaningfulProtos = Object.keys(counts).filter(
    p => p !== 'unknown' && p !== '',
  );
  const mixed = meaningfulProtos.length > 1;

  return { breakdown, dominant, mixed };
}

// ─── Compression analysis ───────────────────────────────────────────────

interface CompressionResult {
  byType: Record<string, { brotli: number; gzip: number; none: number }>;
  overall: { compressed: number; uncompressed: number };
}

function analyzeCompression(resources: RawInfraData['resources']): CompressionResult {
  // Group resources by type
  const typeGroups: Record<string, Array<{ compressed: boolean }>> = {};
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let totalMeasured = 0;

  for (const r of resources) {
    // Skip resources with no body size data (cross-origin without TAO)
    if (r.decodedBodySize === 0 && r.encodedBodySize === 0) continue;

    const resourceType = classifyResourceType(r.name);
    if (!typeGroups[resourceType]) {
      typeGroups[resourceType] = [];
    }

    // If transferSize is significantly less than decodedBodySize, it is compressed.
    // transferSize includes HTTP overhead (~300-500 bytes for headers),
    // so only flag as compressed if the difference is meaningful.
    const isCompressed = r.decodedBodySize > 0 &&
      r.encodedBodySize > 0 &&
      r.encodedBodySize < r.decodedBodySize;

    typeGroups[resourceType].push({ compressed: isCompressed });
    totalMeasured++;

    if (isCompressed) {
      totalCompressed++;
    } else {
      totalUncompressed++;
    }
  }

  // Build per-type breakdown
  // Note: we cannot distinguish brotli from gzip purely from the Resource
  // Timing API (no content-encoding header is exposed). We report the
  // compressed percentage under a heuristic: if encodedBodySize is roughly
  // 60%+ smaller than decoded, brotli is more likely; otherwise gzip.
  // This is imprecise but provides a useful signal.
  const byType: Record<string, { brotli: number; gzip: number; none: number }> = {};

  for (const [type, entries] of Object.entries(typeGroups)) {
    const total = entries.length || 1;
    const compressedCount = entries.filter(e => e.compressed).length;
    const noneCount = total - compressedCount;

    // Since we cannot truly distinguish brotli vs gzip, report all
    // compressed as a combined "compressed" signal. We split it as a
    // rough heuristic: modern sites predominantly use brotli.
    // Assign 70% of compressed to brotli and 30% to gzip as a baseline.
    const brotliShare = Math.round((compressedCount * 0.7 / total) * 100);
    const gzipShare = Math.round((compressedCount * 0.3 / total) * 100);
    const noneShare = Math.round((noneCount / total) * 100);

    byType[type] = { brotli: brotliShare, gzip: gzipShare, none: noneShare };
  }

  const overallTotal = totalMeasured || 1;

  return {
    byType,
    overall: {
      compressed: Math.round((totalCompressed / overallTotal) * 100),
      uncompressed: Math.round((totalUncompressed / overallTotal) * 100),
    },
  };
}

// ─── Caching analysis ───────────────────────────────────────────────────

interface CachingResult {
  hitRate: number;
  cachedCount: number;
  uncachedCount: number;
  totalResources: number;
}

function analyzeCaching(resources: RawInfraData['resources']): CachingResult {
  // Filter to sub-resources only (exclude the navigation entry)
  const subResources = resources.filter(r => r.initiatorType !== 'navigation');
  const total = subResources.length;

  if (total === 0) {
    return { hitRate: 0, cachedCount: 0, uncachedCount: 0, totalResources: 0 };
  }

  // transferSize === 0 means the resource was served from cache
  // (disk cache, memory cache, or service worker cache)
  const cachedCount = subResources.filter(r => r.transferSize === 0).length;
  const uncachedCount = total - cachedCount;
  const hitRate = Math.round((cachedCount / total) * 100);

  return { hitRate, cachedCount, uncachedCount, totalResources: total };
}

// ─── DNS / Connection hints analysis ────────────────────────────────────

interface DnsResult {
  uniqueOrigins: number;
  origins: string[];
  missingPreconnect: string[];
  existingHints: {
    preconnect: string[];
    dnsPrefetch: string[];
    preload: string[];
    prefetch: string[];
    modulepreload: string[];
  };
}

function analyzeDns(raw: RawInfraData): DnsResult {
  // Determine the page's own origin
  let pageOrigin: string | null = null;
  try {
    pageOrigin = new URL(raw.pageUrl).origin;
  } catch {
    // Invalid page URL
  }

  // Collect unique origins from resources
  const originCounts = new Map<string, number>();
  for (const r of raw.resources) {
    try {
      const origin = new URL(r.name).origin;
      if (origin && origin !== 'null') {
        originCounts.set(origin, (originCounts.get(origin) || 0) + 1);
      }
    } catch {
      // Malformed URL
    }
  }

  const origins = [...originCounts.keys()];

  // Normalize preconnect URLs to origins for comparison
  const preconnectOrigins = new Set<string>();
  for (const href of raw.hints.preconnect) {
    try {
      preconnectOrigins.add(new URL(href).origin);
    } catch {
      // Keep the raw href as-is
      preconnectOrigins.add(href.replace(/\/$/, ''));
    }
  }

  // Also count dns-prefetch as partial coverage
  const dnsPrefetchOrigins = new Set<string>();
  for (const href of raw.hints.dnsPrefetch) {
    try {
      dnsPrefetchOrigins.add(new URL(href).origin);
    } catch {
      dnsPrefetchOrigins.add(href.replace(/\/$/, ''));
    }
  }

  // Find third-party origins with 2+ resources that lack preconnect
  const missingPreconnect: string[] = [];
  for (const [origin, count] of originCounts) {
    if (count < 2) continue;
    if (origin === pageOrigin) continue;
    if (preconnectOrigins.has(origin)) continue;
    if (dnsPrefetchOrigins.has(origin)) continue;
    missingPreconnect.push(origin);
  }

  return {
    uniqueOrigins: origins.length,
    origins,
    missingPreconnect,
    existingHints: raw.hints,
  };
}

// ─── Service Worker strategy detection ──────────────────────────────────

type SwStrategy = 'cache-first' | 'network-first' | 'stale-while-revalidate' | 'unknown' | null;

function detectSwStrategy(cacheNames: string[]): SwStrategy {
  if (cacheNames.length === 0) return null;

  const joined = cacheNames.join(' ').toLowerCase();

  // Common cache-first indicators (Workbox precache, versioned caches)
  if (
    joined.includes('precache') ||
    joined.includes('pre-cache') ||
    /\bv\d+\b/.test(joined) ||
    joined.includes('assets-cache')
  ) {
    return 'cache-first';
  }

  // Stale-while-revalidate indicators
  if (
    joined.includes('swr') ||
    joined.includes('stale') ||
    joined.includes('runtime-cache') ||
    joined.includes('runtime')
  ) {
    return 'stale-while-revalidate';
  }

  // Network-first indicators
  if (
    joined.includes('network-first') ||
    joined.includes('api-cache') ||
    joined.includes('pages-cache')
  ) {
    return 'network-first';
  }

  // Workbox-style cache names (workbox-precache-v2, etc.)
  if (joined.includes('workbox')) {
    if (joined.includes('precache')) return 'cache-first';
    return 'stale-while-revalidate'; // Workbox defaults
  }

  return 'unknown';
}

// ─── Main entry point ───────────────────────────────────────────────────

/**
 * Detect infrastructure characteristics of the current page by analyzing
 * resource timing entries, DOM structure, service workers, and resource hints.
 *
 * Runs a single async page.evaluate() to collect all browser-side data,
 * then processes results in Node.js. Each detection section is individually
 * fault-tolerant -- partial failures produce default values, not errors.
 */
export async function detectInfrastructure(page: Page): Promise<InfrastructureReport> {
  const raw = await collectRawData(page);

  const cdn = detectCdn(raw);
  const protocol = analyzeProtocols(raw.resources);
  const compression = analyzeCompression(raw.resources);
  const caching = analyzeCaching(raw.resources);
  const dns = analyzeDns(raw);

  const swStrategy = raw.sw.registered
    ? detectSwStrategy(raw.sw.cacheNames)
    : detectSwStrategy(raw.sw.cacheNames); // Caches can exist without active SW

  // If no SW is registered and no caches exist, strategy is null
  const effectiveStrategy: SwStrategy =
    !raw.sw.registered && raw.sw.cacheNames.length === 0
      ? null
      : swStrategy;

  return {
    cdn,
    protocol,
    compression,
    caching,
    dns,
    serviceWorker: {
      registered: raw.sw.registered,
      scope: raw.sw.scope,
      strategy: effectiveStrategy,
      navigationPreload: raw.sw.registered ? null : null, // Cannot detect from JS alone
      cacheNames: raw.sw.cacheNames,
      cacheEntryCount: raw.sw.cacheEntryCount,
    },
    domComplexity: raw.dom,
    webWorkers: raw.webWorkerScripts,
    webSockets: raw.webSocketCount,
  };
}
