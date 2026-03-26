/**
 * Resource analyzer — categorizes network resources and audits images,
 * fonts, and render-blocking elements for performance issues.
 */

import type { Page } from 'playwright';
import type { NetworkEntry } from '../buffers';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ResourceCategory {
  count: number;
  totalSizeBytes: number;
  largest: { url: string; sizeBytes: number } | null;
}

export interface ImageAuditItem {
  src: string;
  issues: string[];
}

export interface FontAuditItem {
  family: string;
  weight: string;
  fontDisplay: string | null;
  preloaded: boolean;
  foitRisk: boolean;
}

export interface RenderBlockingItem {
  type: 'script' | 'stylesheet';
  url: string;
  sizeBytes: number | null;
}

export interface ResourceReport {
  categories: Record<string, ResourceCategory>;
  thirdPartyByDomain: Record<string, { count: number; totalSizeBytes: number }>;
  imageAudit: ImageAuditItem[];
  fontAudit: FontAuditItem[];
  renderBlocking: RenderBlockingItem[];
}

// ─── Extension-based categorization ─────────────────────────────────────

const EXTENSION_MAP: Record<string, string> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.tsx': 'js',
  '.css': 'css',
  '.png': 'images',
  '.jpg': 'images',
  '.jpeg': 'images',
  '.gif': 'images',
  '.svg': 'images',
  '.webp': 'images',
  '.avif': 'images',
  '.ico': 'images',
  '.bmp': 'images',
  '.woff': 'fonts',
  '.woff2': 'fonts',
  '.ttf': 'fonts',
  '.otf': 'fonts',
  '.eot': 'fonts',
  '.mp4': 'media',
  '.webm': 'media',
  '.mp3': 'media',
  '.ogg': 'media',
};

const ALL_CATEGORIES = ['js', 'css', 'images', 'fonts', 'media', 'api', 'other'];

/**
 * Extract file extension from a URL, ignoring query strings and fragments.
 * Returns lowercase extension including the dot, or empty string.
 */
function getExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1) return '';
    return pathname.slice(lastDot).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Determine whether a network entry looks like an API/XHR/fetch call
 * using heuristics: /api/ path segments, JSON content indicators, or
 * common REST-style paths without file extensions.
 */
function isApiRequest(entry: NetworkEntry): boolean {
  try {
    const parsed = new URL(entry.url);
    const pathname = parsed.pathname.toLowerCase();

    // Explicit /api/ path segment
    if (/\/api\//i.test(pathname)) return true;

    // GraphQL endpoints
    if (/\/graphql\b/i.test(pathname)) return true;

    // Common REST patterns without extensions (e.g., /users/123, /v1/data)
    if (/\/v\d+\//i.test(pathname) && getExtension(entry.url) === '') return true;

    // JSON response heuristic: .json extension is already categorized as 'other',
    // but requests to extensionless paths that returned a status look API-ish
    if (getExtension(entry.url) === '' && entry.method !== 'GET') return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * Categorize a single network entry into one of the known resource types.
 */
function categorizeEntry(entry: NetworkEntry): string {
  const ext = getExtension(entry.url);
  if (ext && EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];
  if (isApiRequest(entry)) return 'api';
  return 'other';
}

/**
 * Extract the origin (scheme + host) from a URL, returning null on failure.
 */
function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Extract the hostname from a URL, returning null on failure.
 */
function getHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── Empty scaffolding ─────────────────────────────────────────────────

function emptyCategories(): Record<string, ResourceCategory> {
  const cats: Record<string, ResourceCategory> = {};
  for (const cat of ALL_CATEGORIES) {
    cats[cat] = { count: 0, totalSizeBytes: 0, largest: null };
  }
  return cats;
}

// ─── Image audit ────────────────────────────────────────────────────────

/**
 * Audit all <img> elements on the page for common performance issues.
 * Runs entirely inside page.evaluate() so it works even with restrictive CSP.
 */
async function auditImages(
  page: Page,
  networkEntries: NetworkEntry[],
): Promise<ImageAuditItem[]> {
  // Build a size lookup from network entries keyed by URL
  const sizeByUrl = new Map<string, number>();
  for (const entry of networkEntries) {
    if (entry.size != null && entry.size > 0) {
      sizeByUrl.set(entry.url, entry.size);
    }
  }

  // Serialize the size map as a plain object for transfer into the page context
  const sizeMap: Record<string, number> = Object.fromEntries(sizeByUrl);

  try {
    const rawItems: Array<{
      src: string;
      hasWidth: boolean;
      hasHeight: boolean;
      hasLazyLoad: boolean;
      hasFetchPriority: boolean;
      hasSrcset: boolean;
      naturalWidth: number;
      naturalHeight: number;
      offsetWidth: number;
      offsetHeight: number;
      aboveFold: boolean;
      ext: string;
    }> = await page.evaluate((sizeLookup: Record<string, number>) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const viewportHeight = window.innerHeight;

      return imgs.map((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.src || img.getAttribute('src') || '';
        let ext = '';
        try {
          const pathname = new URL(src, document.baseURI).pathname;
          const dot = pathname.lastIndexOf('.');
          if (dot !== -1) ext = pathname.slice(dot).toLowerCase();
        } catch {
          // ignore malformed URLs
        }

        return {
          src,
          hasWidth: img.hasAttribute('width'),
          hasHeight: img.hasAttribute('height'),
          hasLazyLoad: img.getAttribute('loading') === 'lazy',
          hasFetchPriority: img.hasAttribute('fetchpriority'),
          hasSrcset: img.hasAttribute('srcset'),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          offsetWidth: img.offsetWidth,
          offsetHeight: img.offsetHeight,
          aboveFold: rect.top < viewportHeight,
          ext,
        };
      });
    }, sizeMap);

    const results: ImageAuditItem[] = [];

    for (const item of rawItems) {
      const issues: string[] = [];

      // Format check: PNG/JPG/BMP/GIF could use modern formats
      if (['.png', '.bmp'].includes(item.ext)) {
        issues.push(`${item.ext.slice(1).toUpperCase()} format (use WebP/AVIF)`);
      } else if (['.jpg', '.jpeg'].includes(item.ext)) {
        issues.push('JPEG format (consider WebP/AVIF)');
      } else if (item.ext === '.gif') {
        issues.push('GIF format (use WebP/AVIF or video for animations)');
      }

      // Missing dimensions
      if (!item.hasWidth || !item.hasHeight) {
        issues.push('Missing dimensions (set width and height attributes to prevent layout shift)');
      }

      // Missing lazy-load for below-fold images
      if (!item.hasLazyLoad && !item.aboveFold) {
        issues.push('Missing lazy-load (add loading="lazy" for below-fold images)');
      }

      // Missing fetchpriority for large above-fold images
      if (item.aboveFold && !item.hasFetchPriority) {
        // Only flag if the image is meaningfully sized (not tiny icons)
        if (item.offsetWidth > 100 && item.offsetHeight > 100) {
          issues.push('Missing fetchpriority="high" (large above-fold image)');
        }
      }

      // Missing srcset for large images (>100KB)
      const networkSize = sizeByUrl.get(item.src) ?? 0;
      if (!item.hasSrcset && networkSize > 100 * 1024) {
        issues.push(`Missing srcset (${(networkSize / 1024).toFixed(0)}KB image without responsive variants)`);
      }

      // Oversized: natural dimensions >> rendered dimensions
      if (
        item.naturalWidth > 0 &&
        item.naturalHeight > 0 &&
        item.offsetWidth > 0 &&
        item.offsetHeight > 0
      ) {
        const widthRatio = item.naturalWidth / item.offsetWidth;
        const heightRatio = item.naturalHeight / item.offsetHeight;
        if (widthRatio > 2 || heightRatio > 2) {
          const ratio = Math.max(widthRatio, heightRatio).toFixed(1);
          issues.push(
            `Oversized (${item.naturalWidth}x${item.naturalHeight} served for ${item.offsetWidth}x${item.offsetHeight} display, ${ratio}x larger)`,
          );
        }
      }

      if (issues.length > 0) {
        results.push({ src: item.src, issues });
      }
    }

    return results;
  } catch {
    // Gracefully handle CSP restrictions, about:blank, etc.
    return [];
  }
}

// ─── Font audit ─────────────────────────────────────────────────────────

/**
 * Audit loaded fonts for FOIT risk, missing font-display, and preload status.
 */
async function auditFonts(page: Page): Promise<FontAuditItem[]> {
  try {
    const rawFonts: Array<{
      family: string;
      weight: string;
      style: string;
      status: string;
      fontDisplay: string | null;
      preloaded: boolean;
    }> = await page.evaluate(() => {
      // 1. Gather font-display values from @font-face rules
      const fontDisplayMap = new Map<string, string>();
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            if (!rules) continue;
            for (const rule of Array.from(rules)) {
              if (rule instanceof CSSFontFaceRule) {
                const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
                const display = rule.style.getPropertyValue('font-display');
                if (family && display) {
                  fontDisplayMap.set(family.toLowerCase(), display);
                }
              }
            }
          } catch {
            // CORS-blocked stylesheet — skip silently
          }
        }
      } catch {
        // document.styleSheets access failed — skip
      }

      // 2. Check for font preload links
      const preloadedFonts = new Set<string>();
      const preloadLinks = document.querySelectorAll('link[rel="preload"][as="font"]');
      for (const link of Array.from(preloadLinks)) {
        const href = link.getAttribute('href');
        if (href) preloadedFonts.add(href);
      }

      // 3. Enumerate loaded fonts via document.fonts
      const results: Array<{
        family: string;
        weight: string;
        style: string;
        status: string;
        fontDisplay: string | null;
        preloaded: boolean;
      }> = [];

      try {
        document.fonts.forEach((face) => {
          const familyClean = face.family.replace(/['"]/g, '').trim();
          const display = fontDisplayMap.get(familyClean.toLowerCase()) ?? null;

          // Check if any preload link matches this font family
          // (heuristic: preload href contains the font family name)
          let isPreloaded = false;
          for (const href of preloadedFonts) {
            if (href.toLowerCase().includes(familyClean.toLowerCase().replace(/\s+/g, ''))) {
              isPreloaded = true;
              break;
            }
          }

          results.push({
            family: familyClean,
            weight: face.weight,
            style: face.style,
            status: face.status,
            fontDisplay: display,
            preloaded: isPreloaded,
          });
        });
      } catch {
        // document.fonts not available
      }

      return results;
    });

    return rawFonts.map((f) => {
      const safeFontDisplay = ['swap', 'optional', 'fallback'];
      const foitRisk = f.fontDisplay == null || !safeFontDisplay.includes(f.fontDisplay);

      return {
        family: f.family,
        weight: f.weight,
        fontDisplay: f.fontDisplay,
        preloaded: f.preloaded,
        foitRisk,
      };
    });
  } catch {
    // Gracefully handle empty/restricted pages
    return [];
  }
}

// ─── Render-blocking detection ──────────────────────────────────────────

/**
 * Detect render-blocking scripts and stylesheets in the <head>.
 */
async function detectRenderBlocking(
  page: Page,
  networkEntries: NetworkEntry[],
): Promise<RenderBlockingItem[]> {
  // Build size lookup for network entries
  const sizeByUrl = new Map<string, number>();
  for (const entry of networkEntries) {
    if (entry.size != null && entry.size > 0) {
      sizeByUrl.set(entry.url, entry.size);
    }
  }

  try {
    const rawItems: Array<{
      type: 'script' | 'stylesheet';
      url: string;
    }> = await page.evaluate(() => {
      const items: Array<{ type: 'script' | 'stylesheet'; url: string }> = [];
      const head = document.head;
      if (!head) return items;

      // Sync scripts in <head> without async/defer/type="module"
      const scripts = head.querySelectorAll('script[src]');
      for (const script of Array.from(scripts)) {
        const hasAsync = script.hasAttribute('async');
        const hasDefer = script.hasAttribute('defer');
        const typeAttr = script.getAttribute('type') || '';
        const isModule = typeAttr === 'module';

        if (!hasAsync && !hasDefer && !isModule) {
          items.push({
            type: 'script',
            url: (script as HTMLScriptElement).src,
          });
        }
      }

      // Blocking stylesheets in <head>
      const links = head.querySelectorAll('link[rel="stylesheet"]');
      for (const link of Array.from(links)) {
        const media = link.getAttribute('media') || '';
        // A stylesheet is non-blocking if it has media="print" or another
        // non-screen media query (media="not all", etc.)
        const nonBlocking = media === 'print' || media === 'not all';
        if (!nonBlocking) {
          items.push({
            type: 'stylesheet',
            url: (link as HTMLLinkElement).href,
          });
        }
      }

      return items;
    });

    return rawItems.map((item) => ({
      type: item.type,
      url: item.url,
      sizeBytes: sizeByUrl.get(item.url) ?? null,
    }));
  } catch {
    // Gracefully handle restricted pages
    return [];
  }
}

// ─── Main entry point ───────────────────────────────────────────────────

/**
 * Analyze network resources and audit images, fonts, and render-blocking
 * elements on the current page.
 */
export async function analyzeResources(
  networkEntries: NetworkEntry[],
  page: Page,
): Promise<ResourceReport> {
  // 1. Categorize resources by type
  const categories = emptyCategories();

  let pageOrigin: string | null = null;
  try {
    pageOrigin = getOrigin(page.url());
  } catch {
    // page.url() can fail on about:blank or crashed pages
  }

  const thirdPartyByDomain: Record<string, { count: number; totalSizeBytes: number }> = {};

  for (const entry of networkEntries) {
    const category = categorizeEntry(entry);
    const cat = categories[category];
    if (!cat) continue; // should not happen, but defensive

    const size = entry.size ?? 0;
    cat.count++;
    cat.totalSizeBytes += size;

    if (size > 0 && (cat.largest === null || size > cat.largest.sizeBytes)) {
      cat.largest = { url: entry.url, sizeBytes: size };
    }

    // Third-party grouping
    if (pageOrigin) {
      const entryOrigin = getOrigin(entry.url);
      if (entryOrigin && entryOrigin !== pageOrigin) {
        const hostname = getHostname(entry.url);
        if (hostname) {
          if (!thirdPartyByDomain[hostname]) {
            thirdPartyByDomain[hostname] = { count: 0, totalSizeBytes: 0 };
          }
          thirdPartyByDomain[hostname].count++;
          thirdPartyByDomain[hostname].totalSizeBytes += size;
        }
      }
    }
  }

  // 2. Run audits in parallel — they are independent page.evaluate() calls
  const [imageAudit, fontAudit, renderBlocking] = await Promise.all([
    auditImages(page, networkEntries),
    auditFonts(page),
    detectRenderBlocking(page, networkEntries),
  ]);

  return {
    categories,
    thirdPartyByDomain,
    imageAudit,
    fontAudit,
    renderBlocking,
  };
}
