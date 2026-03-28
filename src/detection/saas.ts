/**
 * SaaS platform detection — 55 platforms across 6 categories.
 *
 * Detection runs a single page.evaluate() call with each platform wrapped in
 * try/catch. Network entry correlation (app enumeration, sizing) runs in
 * Node.js land outside the evaluate since networkEntries aren't available
 * inside the browser context.
 */

import type { Page } from 'playwright';
import type { NetworkEntry } from '../network/buffers';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SaaSCategory =
  | 'ecommerce'
  | 'website-builder'
  | 'cms-hosted'
  | 'cms-headless'
  | 'marketing'
  | 'hosting';

export interface PlatformApp {
  name: string;
  scriptUrls: string[];
  styleUrls: string[];
  totalSizeKB: number;
  usedOnPage: boolean;
  loadTiming: 'sync' | 'async' | 'defer' | 'unknown';
}

export interface DetectedSaaS {
  name: string;
  category: SaaSCategory;
  version: string | null;
  config: Record<string, unknown>;
  apps: PlatformApp[];
  constraints: {
    canFix: string[];
    cannotFix: string[];
  };
  perfHints: Array<{
    severity: 'critical' | 'warning' | 'info';
    message: string;
    metric: string;
    evidence: string;
  }>;
  platformMetrics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal types — raw detection result from page.evaluate()
// ---------------------------------------------------------------------------

interface RawDetection {
  name: string;
  category: SaaSCategory;
  version: string | null;
  config: Record<string, unknown>;
  /** Marker lists for app enumeration done in Node.js land */
  appHints: Record<string, unknown>;
  constraints: { canFix: string[]; cannotFix: string[] };
  platformMetrics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Known Shopify app domains -> app name mapping
// ---------------------------------------------------------------------------

const SHOPIFY_APP_DOMAINS: Record<string, string> = {
  'klaviyo.com': 'Klaviyo',
  'judge.me': 'Judge.me',
  'loox.io': 'Loox',
  'bold.com': 'Bold',
  'boldcommerce.com': 'Bold Commerce',
  'recharge.com': 'ReCharge',
  'rechargepayments.com': 'ReCharge',
  'privy.com': 'Privy',
  'yotpo.com': 'Yotpo',
  'stamped.io': 'Stamped.io',
  'aftership.com': 'AfterShip',
  'gorgias.com': 'Gorgias',
  'omnisend.com': 'Omnisend',
  'justuno.com': 'Justuno',
  'smile.io': 'Smile.io',
  'vitals.co': 'Vitals',
  'pagefly.io': 'PageFly',
  'shogun.io': 'Shogun',
  'oberlo.com': 'Oberlo',
  'dsers.com': 'DSers',
  'langify-app.com': 'Langify',
  'tidio.co': 'Tidio',
  'zendesk.com': 'Zendesk',
  'intercom.io': 'Intercom',
  'helpscout.net': 'Help Scout',
  'sealsubscriptions.com': 'Seal Subscriptions',
  'shopifycdn.com': 'Shopify App',
  'orderlyemails.com': 'OrderlyEmails',
  'back-in-stock.io': 'Back In Stock',
  'returnly.com': 'Returnly',
  'fera.ai': 'Fera.ai',
  'rivyo.com': 'Rivyo',
  'ali-reviews.com': 'Ali Reviews',
  'opinew.com': 'Opinew',
  'spocket.co': 'Spocket',
  'goaffpro.com': 'GoAffPro',
  'referralcandy.com': 'ReferralCandy',
  'widgetic.com': 'Widgetic',
  'hextom.com': 'Hextom',
  'nosto.com': 'Nosto',
  'growave.io': 'Growave',
  'loyalty-program.io': 'LoyaltyLion',
  'loyaltylion.com': 'LoyaltyLion',
  'bundleapp.com': 'Bundle',
  'fast.com': 'Fast',
  'sezzle.com': 'Sezzle',
  'quadpay.com': 'QuadPay',
  'afterpay.com': 'Afterpay',
  'klarna.com': 'Klarna',
};

// ---------------------------------------------------------------------------
// WordPress plugin extraction from URL paths
// ---------------------------------------------------------------------------

function extractWpPluginName(url: string): string | null {
  const m = url.match(/\/wp-content\/plugins\/([^/]+)\//);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Script load timing detection helper
// ---------------------------------------------------------------------------

function getScriptLoadTiming(
  url: string,
  scriptTags: Array<{ src: string; async: boolean; defer: boolean }>,
): 'sync' | 'async' | 'defer' | 'unknown' {
  const tag = scriptTags.find((t) => url.includes(t.src) || t.src.includes(url));
  if (!tag) return 'unknown';
  if (tag.async) return 'async';
  if (tag.defer) return 'defer';
  return 'sync';
}

// ---------------------------------------------------------------------------
// App domain matcher — extracts a readable name from a URL
// ---------------------------------------------------------------------------

function extractShopifyAppName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    for (const [domain, appName] of Object.entries(SHOPIFY_APP_DOMAINS)) {
      if (hostname.includes(domain)) return appName;
    }
    // Fall back to second-level domain
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return hostname;
  } catch {
    return 'Unknown App';
  }
}

// ---------------------------------------------------------------------------
// Network entries helpers (run in Node.js land)
// ---------------------------------------------------------------------------

function sizeKB(entries: NetworkEntry[]): number {
  return Math.round(
    entries.reduce((sum, e) => sum + (e.size || 0), 0) / 1024,
  );
}

function filterByUrlPattern(
  entries: NetworkEntry[],
  pattern: string | RegExp,
): NetworkEntry[] {
  if (typeof pattern === 'string') {
    return entries.filter((e) => e.url.includes(pattern));
  }
  return entries.filter((e) => pattern.test(e.url));
}

function filterScripts(entries: NetworkEntry[]): NetworkEntry[] {
  return entries.filter(
    (e) => e.url.endsWith('.js') || e.url.includes('.js?'),
  );
}

function filterStyles(entries: NetworkEntry[]): NetworkEntry[] {
  return entries.filter(
    (e) => e.url.endsWith('.css') || e.url.includes('.css?'),
  );
}

// ---------------------------------------------------------------------------
// page.evaluate() — browser-side detection for all 55 platforms
// ---------------------------------------------------------------------------

async function runBrowserDetection(page: Page): Promise<RawDetection[]> {
  return page.evaluate(() => {
    const results: RawDetection[] = [];
    const w = window as unknown as Record<string, unknown>;

    // Helper: query selector existence
    const qs = (sel: string): boolean => !!document.querySelector(sel);
    const qsa = (sel: string): number =>
      document.querySelectorAll(sel).length;
    const attr = (sel: string, a: string): string | null =>
      document.querySelector(sel)?.getAttribute(a) ?? null;
    const metaGenerator = (): string | null =>
      (document.querySelector('meta[name="generator"]') as HTMLMetaElement | null)
        ?.content ?? null;

    // Navigation entry for response headers (limited in browser context)
    const navEntry = performance.getEntriesByType(
      'navigation',
    )[0] as PerformanceNavigationTiming | undefined;
    const serverTiming = navEntry
      ? (navEntry as unknown as { serverTiming?: Array<{ name: string; duration: number }> })
          .serverTiming ?? []
      : [];

    // Resource entries for API call detection
    const resourceEntries = performance.getEntriesByType('resource');

    // =====================================================================
    // E-COMMERCE (15)
    // =====================================================================

    // 1. Shopify
    try {
      const shopify = w.Shopify as Record<string, unknown> | undefined;
      if (shopify || qs('link[href*="cdn.shopify.com"]')) {
        const theme = shopify?.theme as Record<string, unknown> | undefined;
        const currency = shopify?.currency as Record<string, unknown> | undefined;

        // Liquid render time from Server-Timing
        let liquidRenderMs: number | null = null;
        const liquidTiming = serverTiming.find(
          (t) => t.name === 'liquid' || t.name === 'processing',
        );
        if (liquidTiming) liquidRenderMs = liquidTiming.duration;

        results.push({
          name: 'Shopify',
          category: 'ecommerce',
          version: null,
          config: {
            theme: {
              name: theme?.name ?? null,
              id: theme?.id ?? null,
              role: theme?.role ?? null,
            },
            checkout: (shopify?.checkout as Record<string, unknown>)?.token
              ? 'standard'
              : null,
            currency: currency?.active ?? null,
            locale: shopify?.locale ?? null,
            routes: shopify?.routes ?? null,
            cdnHost: shopify?.cdnHost ?? null,
          },
          appHints: {
            cdnHost: (shopify?.cdnHost as string) ?? '',
            sectionRendering: qs('[data-section-type]'),
          },
          constraints: {
            canFix: [
              'Theme Liquid template optimization',
              'Image optimization and lazy loading',
              'App selection (remove unused apps)',
              'Section loading strategy (lazy sections)',
              'Preload/prefetch hints in theme.liquid',
              'Font loading strategy in theme CSS',
              'Third-party script defer/async',
            ],
            cannotFix: [
              'Shopify platform JS (~200KB core runtime)',
              'Shopify analytics/tracking scripts',
              'Checkout page performance',
              'CDN configuration (Shopify CDN)',
              'HTTP/2 push settings',
              'Server-side rendering pipeline',
              'Content Security Policy headers',
            ],
          },
          platformMetrics: {
            liquidRenderMs,
            appScriptCount: 0, // populated later from network entries
            sectionRenderingAPI: qs('[data-section-type]'),
            themeJsSize: 0, // populated later
          },
        });
      }
    } catch { /* skip */ }

    // 2. BigCommerce
    try {
      if (
        qs('script[src*="bigcommerce.com"]') ||
        w.BCData ||
        qs('link[href*="bigcommerce"]')
      ) {
        results.push({
          name: 'BigCommerce',
          category: 'ecommerce',
          version: null,
          config: {
            stencil: qs('[data-stencil-component]'),
            cornerstone: qs('link[href*="cornerstone"]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Theme code optimization',
              'App selection and removal',
              'Image optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'Checkout performance',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 3. WooCommerce
    try {
      if (
        w.wc_add_to_cart_params ||
        qs('.woocommerce') ||
        qs('script[src*="woocommerce"]')
      ) {
        const cartFragments = qs('script[src*="cart-fragments"]');
        const wcParams = w.wc_add_to_cart_params as Record<string, unknown> | undefined;

        results.push({
          name: 'WooCommerce',
          category: 'ecommerce',
          version: null,
          config: {
            cartFragments,
            blocks: qs('[class*="wc-block-"]'),
            paymentGateways: qsa('[class*="payment_method_"]'),
            ajaxAddToCart: !!(wcParams?.ajax_url),
          },
          appHints: {
            isWordPress: true,
          },
          constraints: {
            canFix: [
              'Full server control (self-hosted WordPress)',
              'Plugin selection and removal',
              'Theme optimization',
              'Database query optimization',
              'Caching configuration',
              'Image optimization',
            ],
            cannotFix: [],
          },
          platformMetrics: {
            cartFragmentsEnabled: cartFragments,
            cartFragmentsOnEveryPage: cartFragments, // will refine with URL check
          },
        });
      }
    } catch { /* skip */ }

    // 4. Magento / Adobe Commerce
    try {
      if (
        w.require &&
        (w.Mage || w.magentoCloud || qs('script[src*="mage/"]') || qs('script[src*="requirejs"]'))
      ) {
        const knockoutBindings = qsa('[data-bind]');
        const isCloud =
          qs('meta[name="x-magento-cloud"]') || !!w.magentoCloud;

        // Count RequireJS modules
        let requirejsModuleCount = 0;
        try {
          const req = w.require as Record<string, unknown>;
          const s = req?.s as Record<string, unknown>;
          const contexts = s?.contexts as Record<string, Record<string, unknown>>;
          const defCtx = contexts?._ as Record<string, unknown>;
          const defined = defCtx?.defined as Record<string, unknown>;
          if (defined) {
            requirejsModuleCount = Object.keys(defined).length;
          }
        } catch { /* skip */ }

        results.push({
          name: 'Magento',
          category: 'ecommerce',
          version: null,
          config: {
            cloud: isCloud,
            varnish: null, // detected via headers in Node.js
            elasticsearch: null,
          },
          appHints: {},
          constraints: isCloud
            ? {
                canFix: [
                  'Theme code optimization',
                  'Module configuration',
                  'JS bundling configuration',
                  'Image optimization',
                ],
                cannotFix: [
                  'Varnish configuration (managed)',
                  'Infrastructure scaling',
                  'PHP version',
                ],
              }
            : {
                canFix: [
                  'Full server control',
                  'Theme code optimization',
                  'Module configuration',
                  'JS bundling configuration',
                  'Image optimization',
                  'Varnish/FPC configuration',
                  'PHP version and OPcache',
                ],
                cannotFix: [],
              },
          platformMetrics: {
            requirejsModuleCount,
            knockoutBindingCount: knockoutBindings,
            customerSectionCount: 0, // populated from network entries
            fpcStatus: null, // populated from response headers
          },
        });
      }
    } catch { /* skip */ }

    // 5. PrestaShop
    try {
      if (w.prestashop || metaGenerator()?.includes('PrestaShop')) {
        const gen = metaGenerator();
        const version = gen?.match(/PrestaShop ([\d.]+)/)?.[1] ?? null;
        results.push({
          name: 'PrestaShop',
          category: 'ecommerce',
          version,
          config: {
            moduleCount: qsa('script[src*="/modules/"]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Module selection and removal',
              'Theme code optimization',
              'Image optimization',
            ],
            cannotFix: ['Core JS requirements'],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 6. OpenCart
    try {
      if (
        qs('script[src*="catalog/view"]') ||
        qs('link[href*="catalog/view"]')
      ) {
        results.push({
          name: 'OpenCart',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Template code optimization',
              'Extension selection',
            ],
            cannotFix: [
              'Core architecture',
              'Lack of modern asset bundling',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 7. Salesforce Commerce Cloud (SFCC / Demandware)
    try {
      if (
        qs('script[src*="demandware"]') ||
        w.dw ||
        location.hostname.includes('.demandware.net')
      ) {
        results.push({
          name: 'Salesforce Commerce Cloud',
          category: 'ecommerce',
          version: null,
          config: {
            sfra: qs('[data-action]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Controller code optimization',
              'Template optimization',
              'Content slot configuration',
            ],
            cannotFix: [
              'Platform runtime',
              'OCAPI latency',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 8. SAP Commerce (Hybris)
    try {
      if (
        qs('script[src*="/_ui/"]') ||
        w.ACC ||
        qs('[class*="yCmsComponent"]')
      ) {
        const smartEditInProd = qs('script[src*="smartedit"]');
        results.push({
          name: 'SAP Commerce',
          category: 'ecommerce',
          version: null,
          config: {
            smartEdit: smartEditInProd,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Template code optimization',
              'Component rendering',
            ],
            cannotFix: [
              'Platform runtime',
              'SmartEdit overhead',
            ],
          },
          platformMetrics: {
            smartEditInProduction: smartEditInProd,
          },
        });
      }
    } catch { /* skip */ }

    // 9. Saleor (headless e-commerce)
    try {
      if (
        resourceEntries.some((r) => r.name.includes('saleor')) ||
        qs('meta[name="generator"][content*="Saleor"]')
      ) {
        results.push({
          name: 'Saleor',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Full frontend control (headless)',
              'Query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'GraphQL API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 10. Medusa
    try {
      if (
        resourceEntries.some((r) => r.name.includes('medusa')) ||
        qs('meta[name="generator"][content*="Medusa"]')
      ) {
        results.push({
          name: 'Medusa',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Full frontend control (headless)',
              'API query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'API server latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 11. Ecwid
    try {
      if (qs('script[src*="ecwid"]') || w.Ecwid || qs('.ecwid')) {
        results.push({
          name: 'Ecwid',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Product image optimization',
              'Content above the widget',
            ],
            cannotFix: [
              'Ecwid widget runtime',
              'CDN configuration',
              'Widget rendering performance',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 12. Volusion
    try {
      if (qs('script[src*="volusion"]') || w.volusion || qs('link[href*="volusion"]')) {
        results.push({
          name: 'Volusion',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Content structure',
            ],
            cannotFix: [
              'Platform runtime',
              'Legacy architecture',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 13. Shift4Shop (3dcart)
    try {
      if (
        qs('script[src*="3dcart"]') ||
        qs('script[src*="shift4shop"]') ||
        qs('link[href*="3dcart"]')
      ) {
        results.push({
          name: 'Shift4Shop',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Template code optimization',
              'Image optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 14. Swell
    try {
      if (
        resourceEntries.some((r) => r.name.includes('swell.store')) ||
        resourceEntries.some((r) => r.name.includes('api.swell.store'))
      ) {
        results.push({
          name: 'Swell',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Full frontend control (headless)',
              'API query optimization',
              'Image optimization',
            ],
            cannotFix: [
              'Swell API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 15. CommerceTools
    try {
      if (
        resourceEntries.some((r) => r.name.includes('commercetools')) ||
        resourceEntries.some((r) => r.name.includes('sphere.io'))
      ) {
        results.push({
          name: 'CommerceTools',
          category: 'ecommerce',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Full frontend control (headless)',
              'API query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'CommerceTools API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // =====================================================================
    // WEBSITE BUILDERS (13)
    // =====================================================================

    // 16. Webflow
    try {
      if (
        w.Webflow ||
        qs('html[data-wf-site]') ||
        qs('script[src*="webflow"]')
      ) {
        results.push({
          name: 'Webflow',
          category: 'website-builder',
          version: null,
          config: {
            siteId: attr('html', 'data-wf-site'),
            pageId: attr('html', 'data-wf-page'),
            interactions: qs('script[src*="webflow"][src*="ix2"]'),
            ecommerce: qs('[data-wf-cart-type]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Custom code placement',
              'Page structure',
              'Font selection',
              'Interaction complexity',
            ],
            cannotFix: [
              'Webflow runtime JS (~300KB)',
              'No code splitting',
              'Interaction engine overhead',
              'Server/CDN configuration',
              'HTML structure generated by designer',
            ],
          },
          platformMetrics: {
            customCodeBlocks: qsa('[class*="w-embed"]'),
            interactionsEnabled: qs('script[src*="webflow"][src*="ix2"]'),
            webflowJsSize: 0, // populated from network entries
            interactionsJsSize: 0, // populated from network entries
          },
        });
      }
    } catch { /* skip */ }

    // 17. Squarespace
    try {
      const sqCtx = (w.Static as Record<string, unknown>)
        ?.SQUARESPACE_CONTEXT as Record<string, unknown> | undefined;
      if (
        sqCtx ||
        qs('link[href*="squarespace"]') ||
        qs('script[src*="squarespace"]')
      ) {
        const wsSettings = sqCtx?.websiteSettings as Record<string, unknown> | undefined;
        results.push({
          name: 'Squarespace',
          category: 'website-builder',
          version: (sqCtx?.templateVersion as string) ?? null,
          config: {
            template: sqCtx?.templateId ?? null,
            templateVersion: sqCtx?.templateVersion ?? null,
            commerce: !!(wsSettings?.storeSettings),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Image sizes',
              'Content structure',
              'Custom CSS/JS injection',
              'Page count',
            ],
            cannotFix: [
              'Platform runtime (~500KB)',
              'jQuery dependency',
              'Template engine',
              'CDN configuration',
              'Bundling strategy',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 18. Wix
    try {
      if (
        metaGenerator()?.includes('Wix') ||
        w.wixBiSession ||
        qs('script[src*="wix"]')
      ) {
        results.push({
          name: 'Wix',
          category: 'website-builder',
          version: null,
          config: {
            thunderbolt: qs('script[src*="thunderbolt"]'),
            viewer: !!w.viewerModel,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization (via Wix media manager)',
              'Page structure',
              'App selection',
              'Font selection',
              'Content above fold',
            ],
            cannotFix: [
              'Platform runtime (1MB+ JS)',
              'Rendering engine (Thunderbolt/Santa)',
              'No custom code splitting',
              'Server infrastructure',
              'HTML structure',
              'CSS architecture',
            ],
          },
          platformMetrics: {
            thunderboltChunks: qsa('script[src*="thunderbolt"]'),
            platformRuntimeKB: 0, // populated from network entries
          },
        });
      }
    } catch { /* skip */ }

    // 19. Weebly
    try {
      if (qs('script[src*="weebly"]') || qs('[class*="wsite-"]')) {
        results.push({
          name: 'Weebly',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image sizes',
              'Content optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'Legacy codebase',
              'No modern optimization tools',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 20. GoDaddy Website Builder
    try {
      if (
        qs('script[src*="godaddy"]') ||
        qs('[class*="godaddy"]') ||
        qs('meta[name="generator"][content*="GoDaddy"]')
      ) {
        results.push({
          name: 'GoDaddy Website Builder',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Content structure',
            ],
            cannotFix: [
              'Platform runtime',
              'Template engine',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 21. Duda
    try {
      if (
        qs('script[src*="duda"]') ||
        qs('[class*="duda"]') ||
        qs('meta[name="generator"][content*="Duda"]')
      ) {
        results.push({
          name: 'Duda',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Content structure',
              'Widget selection',
            ],
            cannotFix: [
              'Platform runtime',
              'CDN configuration',
              'Template rendering',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 22. Strikingly
    try {
      if (qs('script[src*="strikingly"]') || w.s_) {
        results.push({
          name: 'Strikingly',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Section management',
            ],
            cannotFix: [
              'Single-page architecture (all sections loaded)',
              'Platform runtime',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 23. Carrd
    try {
      if (
        metaGenerator()?.includes('Carrd') ||
        location.hostname.includes('.carrd.co')
      ) {
        results.push({
          name: 'Carrd',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Content size',
            ],
            cannotFix: [
              'Platform runtime (minimal)',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 24. Framer
    try {
      if (
        qs('script[src*="framer"]') ||
        w.__framer_importFromPackage
      ) {
        results.push({
          name: 'Framer',
          category: 'website-builder',
          version: null,
          config: {
            motionRuntime: !!w.__framer_importFromPackage,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Component configuration',
              'Image optimization',
              'Page structure',
            ],
            cannotFix: [
              'Framer motion runtime',
              'Canvas rendering approach',
              'Bundling strategy',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 25. Bubble
    try {
      if (
        w.bubble_fn ||
        qs('script[src*="bubble.io"]') ||
        qs('.bubble-element')
      ) {
        results.push({
          name: 'Bubble',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Workflow optimization',
              'Data query simplification',
              'Page decomposition',
            ],
            cannotFix: [
              'No-code runtime (2MB+ JS)',
              'Every interaction = server round-trip',
              'Rendering engine',
              'HTML output quality',
              'CSS architecture',
            ],
          },
          platformMetrics: {
            bubbleRuntimeKB: 0, // populated from network entries
          },
        });
      }
    } catch { /* skip */ }

    // 26. Typedream
    try {
      if (
        qs('script[src*="typedream"]') ||
        qs('meta[name="generator"][content*="Typedream"]')
      ) {
        results.push({
          name: 'Typedream',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
            ],
            cannotFix: [
              'Notion API latency (TTFB)',
              'Platform runtime',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 27. Super.so (Notion-based)
    try {
      if (
        qs('script[src*="super.so"]') ||
        qs('meta[name="generator"][content*="Super"]') ||
        location.hostname.includes('.super.site')
      ) {
        results.push({
          name: 'Super.so',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Custom code placement',
            ],
            cannotFix: [
              'Notion API latency (TTFB)',
              'Platform runtime',
              'Rendering pipeline',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 28. Jimdo
    try {
      if (
        qs('script[src*="jimdo"]') ||
        qs('[class*="jimdo"]') ||
        qs('meta[name="generator"][content*="Jimdo"]')
      ) {
        results.push({
          name: 'Jimdo',
          category: 'website-builder',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Image optimization',
              'Content structure',
            ],
            cannotFix: [
              'Platform runtime',
              'Template engine',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // =====================================================================
    // CMS - HOSTED (8)
    // =====================================================================

    // 29. WordPress.com (hosted)
    try {
      if (
        (w.wp || qs('meta[name="generator"][content*="WordPress"]')) &&
        (location.hostname.includes('.wordpress.com') ||
          qs('link[href*="wp.com"]'))
      ) {
        results.push({
          name: 'WordPress.com',
          category: 'cms-hosted',
          version:
            metaGenerator()?.match(/WordPress ([\d.]+)/)?.[1] ?? null,
          config: {
            hosted: true,
          },
          appHints: { isWordPress: true },
          constraints: {
            canFix: [
              'Theme selection',
              'Image optimization',
              'Content structure',
              'Limited plugin selection',
            ],
            cannotFix: [
              'Plugin restrictions (Business plan only)',
              'No server access',
              'Caching configuration',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 30. Ghost
    try {
      if (
        metaGenerator()?.includes('Ghost') ||
        qs('link[href*="ghost"]')
      ) {
        const gen = metaGenerator();
        const version = gen?.match(/Ghost ([\d.]+)/)?.[1] ?? null;

        // Theme detection
        const themeLink = document.querySelector(
          'link[rel="stylesheet"][href*="assets/"]',
        ) as HTMLLinkElement | null;
        const theme =
          themeLink?.href?.match(/themes\/([^/]+)/)?.[1] ?? null;

        const memberPortal = qs('[data-portal]');

        results.push({
          name: 'Ghost',
          category: 'cms-hosted',
          version,
          config: {
            theme,
            memberships: memberPortal,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Theme code optimization',
              'Image optimization',
              'Custom integrations',
            ],
            cannotFix: [
              'Ghost core runtime',
              'Ember admin panel',
              'Member portal widget',
            ],
          },
          platformMetrics: {
            isCasperTheme: theme === 'casper',
            memberPortalLoaded: memberPortal,
          },
        });
      }
    } catch { /* skip */ }

    // 31. HubSpot CMS
    try {
      if (
        qs('script[src*="hs-scripts.com"]') ||
        w._hsq ||
        metaGenerator()?.includes('HubSpot')
      ) {
        const trackingScript = document.querySelector(
          'script[src*="hs-scripts"]',
        ) as HTMLScriptElement | null;
        const portalId =
          trackingScript?.src?.match(/\/(\d+)\.js/)?.[1] ?? null;

        results.push({
          name: 'HubSpot CMS',
          category: 'cms-hosted',
          version: null,
          config: {
            trackingPortalId: portalId,
            forms: qsa('[class*="hs-form"]'),
            ctaWidgets: qsa('[class*="hs-cta"]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Module selection',
              'Template code optimization',
              'Image optimization',
              'Custom code',
            ],
            cannotFix: [
              'HubSpot tracking scripts (~500KB)',
              'Analytics overhead',
              'Form widget runtime',
              'CDN configuration',
            ],
          },
          platformMetrics: {
            hubspotScriptsKB: 0, // populated from network entries
            trackingScriptCount: qsa('script[src*="hs-scripts"], script[src*="hubspot"]'),
            formCount: qsa('[class*="hs-form"]'),
            ctaCount: qsa('[class*="hs-cta"]'),
          },
        });
      }
    } catch { /* skip */ }

    // 32. Kentico
    try {
      if (
        qs('meta[name="generator"][content*="Kentico"]') ||
        qs('script[src*="kentico"]') ||
        w.CMS
      ) {
        results.push({
          name: 'Kentico',
          category: 'cms-hosted',
          version:
            metaGenerator()?.match(/Kentico ([\d.]+)/)?.[1] ?? null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Template code optimization',
              'Widget configuration',
              'Image optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'Admin/editor artifacts in production',
              'Client library loading',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 33. Sitecore
    try {
      if (
        qs('meta[name="generator"][content*="Sitecore"]') ||
        qs('script[src*="sitecore"]') ||
        qs('[class*="scWeb"]')
      ) {
        results.push({
          name: 'Sitecore',
          category: 'cms-hosted',
          version: null,
          config: {
            experienceEditor: qs('[class*="scWebEdit"]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Component rendering optimization',
              'Layout service configuration',
              'Image optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'Personalization JS overhead',
              'Experience Editor artifacts',
            ],
          },
          platformMetrics: {
            experienceEditorInProduction: qs('[class*="scWebEdit"]'),
          },
        });
      }
    } catch { /* skip */ }

    // 34. Adobe Experience Manager (AEM)
    try {
      if (
        qs('script[src*="/etc.clientlibs/"]') ||
        qs('[class*="cq-"]') ||
        qs('meta[name="generator"][content*="AEM"]') ||
        qs('meta[name="generator"][content*="Adobe Experience Manager"]')
      ) {
        results.push({
          name: 'Adobe Experience Manager',
          category: 'cms-hosted',
          version: null,
          config: {
            clientLibsCount: qsa('script[src*="/etc.clientlibs/"], link[href*="/etc.clientlibs/"]'),
            editMode: qs('[class*="cq-editor"]'),
          },
          appHints: {},
          constraints: {
            canFix: [
              'Client library consolidation',
              'Component optimization',
              'Image optimization (Dynamic Media)',
            ],
            cannotFix: [
              'Platform runtime',
              'Client library architecture',
              'Dispatcher/CDN configuration (often managed)',
            ],
          },
          platformMetrics: {
            clientLibCount: qsa('script[src*="/etc.clientlibs/"], link[href*="/etc.clientlibs/"]'),
            editModeInProduction: qs('[class*="cq-editor"]'),
          },
        });
      }
    } catch { /* skip */ }

    // 35. Contentstack
    try {
      if (
        resourceEntries.some((r) => r.name.includes('contentstack.io')) ||
        resourceEntries.some((r) => r.name.includes('contentstack.com'))
      ) {
        results.push({
          name: 'Contentstack',
          category: 'cms-hosted',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'Query optimization',
              'Image CDN configuration',
            ],
            cannotFix: [
              'Contentstack API latency',
              'CDN configuration (managed)',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 36. Bloomreach
    try {
      if (
        qs('script[src*="bloomreach"]') ||
        qs('[class*="br-"]') ||
        w.BrTrk
      ) {
        results.push({
          name: 'Bloomreach',
          category: 'cms-hosted',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Component optimization',
              'Personalization rules',
              'Image optimization',
            ],
            cannotFix: [
              'Platform runtime',
              'Personalization engine overhead',
              'Search/merchandising JS',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // =====================================================================
    // CMS - HEADLESS (8)
    // =====================================================================

    // 37. Contentful
    try {
      if (
        resourceEntries.some(
          (r) =>
            r.name.includes('cdn.contentful.com') ||
            r.name.includes('graphql.contentful.com'),
        )
      ) {
        const hasGraphQL = resourceEntries.some((r) =>
          r.name.includes('graphql.contentful.com'),
        );
        results.push({
          name: 'Contentful',
          category: 'cms-headless',
          version: null,
          config: {
            deliveryApi: true,
            graphql: hasGraphQL,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'Query optimization',
              'Image CDN configuration',
              'Caching headers',
            ],
            cannotFix: [
              'Contentful API latency',
              'Rate limits',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 38. Sanity
    try {
      if (
        resourceEntries.some(
          (r) =>
            r.name.includes('cdn.sanity.io') ||
            r.name.includes('apicdn.sanity.io'),
        ) ||
        qs('script[src*="sanity"]')
      ) {
        results.push({
          name: 'Sanity',
          category: 'cms-headless',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'GROQ query optimization',
              'Image pipeline configuration',
              'Caching strategy',
            ],
            cannotFix: [
              'Sanity API latency',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 39. Strapi
    try {
      if (
        resourceEntries.some((r) => r.name.includes('/api/') && r.name.includes('strapi')) ||
        qs('meta[name="generator"][content*="Strapi"]')
      ) {
        results.push({
          name: 'Strapi',
          category: 'cms-headless',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'API query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'Strapi API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 40. Prismic
    try {
      if (
        resourceEntries.some((r) => r.name.includes('prismic.io')) ||
        qs('script[src*="prismic"]') ||
        w.PrismicPreview
      ) {
        results.push({
          name: 'Prismic',
          category: 'cms-headless',
          version: null,
          config: {
            previewMode: !!w.PrismicPreview,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'Query optimization (GraphQL/REST)',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'Prismic API latency',
              'Preview toolbar overhead (in preview mode)',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 41. DatoCMS
    try {
      if (
        resourceEntries.some(
          (r) =>
            r.name.includes('graphql.datocms.com') ||
            r.name.includes('site-api.datocms.com'),
        )
      ) {
        results.push({
          name: 'DatoCMS',
          category: 'cms-headless',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'GraphQL query optimization',
              'Image optimization (DatoCMS imgix integration)',
              'Caching strategy',
            ],
            cannotFix: [
              'DatoCMS API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 42. Storyblok
    try {
      if (
        resourceEntries.some((r) => r.name.includes('storyblok.com')) ||
        qs('script[src*="storyblok"]')
      ) {
        const bridgeLoaded = qs('script[src*="storyblok-v2-latest"]') ||
          qs('script[src*="bridge"]');
        results.push({
          name: 'Storyblok',
          category: 'cms-headless',
          version: null,
          config: {
            bridgeLoaded,
          },
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'API query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'Storyblok API latency',
              'Visual editor bridge overhead (in preview)',
            ],
          },
          platformMetrics: {
            bridgeInProduction: bridgeLoaded,
          },
        });
      }
    } catch { /* skip */ }

    // 43. Hygraph (GraphCMS)
    try {
      if (
        resourceEntries.some(
          (r) =>
            r.name.includes('graphcms.com') ||
            r.name.includes('hygraph.com'),
        )
      ) {
        results.push({
          name: 'Hygraph',
          category: 'cms-headless',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'GraphQL query optimization',
              'Image optimization',
              'Caching strategy',
            ],
            cannotFix: [
              'Hygraph API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 44. Directus
    try {
      if (
        resourceEntries.some(
          (r) =>
            r.name.includes('/items/') &&
            r.name.includes('directus'),
        ) ||
        qs('meta[name="generator"][content*="Directus"]')
      ) {
        results.push({
          name: 'Directus',
          category: 'cms-headless',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Frontend code (full control)',
              'API query optimization',
              'Image transformation configuration',
              'Caching strategy',
            ],
            cannotFix: [
              'Directus API latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // =====================================================================
    // MARKETING / LANDING PAGES (7)
    // =====================================================================

    // 45. Unbounce
    try {
      if (
        qs('script[src*="unbounce"]') ||
        qs('[class*="lp-pom-"]')
      ) {
        results.push({
          name: 'Unbounce',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Form complexity',
            ],
            cannotFix: [
              'Builder runtime',
              'Form widget',
              'A/B testing overhead',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 46. Leadpages
    try {
      if (
        qs('script[src*="leadpages"]') ||
        qs('[class*="lp-"]') ||
        qs('meta[name="generator"][content*="Leadpages"]')
      ) {
        results.push({
          name: 'Leadpages',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
            ],
            cannotFix: [
              'Builder runtime',
              'Template engine',
              'Analytics overhead',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 47. Instapage
    try {
      if (
        qs('script[src*="instapage"]') ||
        qs('[class*="instapage"]')
      ) {
        results.push({
          name: 'Instapage',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Form simplification',
            ],
            cannotFix: [
              'Builder runtime',
              'A/B testing overhead',
              'Analytics scripts',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 48. ClickFunnels
    try {
      if (
        qs('script[src*="clickfunnels"]') ||
        qs('[class*="clickfunnels"]') ||
        w.cfCdn
      ) {
        results.push({
          name: 'ClickFunnels',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Funnel step reduction',
            ],
            cannotFix: [
              'Funnel chain loading',
              'Tracking overhead',
              'Platform runtime',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 49. Kajabi
    try {
      if (
        qs('script[src*="kajabi"]') ||
        qs('[class*="kajabi"]') ||
        qs('meta[name="generator"][content*="Kajabi"]')
      ) {
        results.push({
          name: 'Kajabi',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Video player configuration',
            ],
            cannotFix: [
              'Platform runtime',
              'Video player overhead',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 50. Teachable
    try {
      if (
        qs('script[src*="teachable"]') ||
        qs('[class*="teachable"]') ||
        qs('meta[name="generator"][content*="Teachable"]')
      ) {
        results.push({
          name: 'Teachable',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Video player configuration',
            ],
            cannotFix: [
              'Platform runtime',
              'Video player overhead',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 51. Thinkific
    try {
      if (
        qs('script[src*="thinkific"]') ||
        qs('[class*="thinkific"]') ||
        qs('meta[name="generator"][content*="Thinkific"]')
      ) {
        results.push({
          name: 'Thinkific',
          category: 'marketing',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'Content optimization',
              'Image optimization',
              'Course page structure',
            ],
            cannotFix: [
              'Platform runtime',
              'Video player overhead',
              'CDN configuration',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // =====================================================================
    // HOSTING PLATFORMS (4)
    // =====================================================================

    // 52. Vercel
    try {
      // Browser-side: check for Vercel-specific scripts
      const vercelAnalytics = qs('script[src*="/_vercel/insights"]');
      const vercelSpeedInsights = qs('script[src*="/_vercel/speed-insights"]');
      const vercelScripts = qs('script[src*="/_vercel/"]');
      // Note: response headers (x-vercel-id, x-vercel-cache) checked in Node.js
      if (vercelScripts || vercelAnalytics || vercelSpeedInsights) {
        results.push({
          name: 'Vercel',
          category: 'hosting',
          version: null,
          config: {
            analytics: vercelAnalytics,
            speedInsights: vercelSpeedInsights,
          },
          appHints: {
            needsHeaderCheck: true,
          },
          constraints: {
            canFix: [
              'Application code',
              'Caching config (vercel.json)',
              'Image optimization',
              'Edge function logic',
            ],
            cannotFix: [
              'Edge function cold start (~50ms)',
              'Vercel CDN routing',
              'Bandwidth pricing',
            ],
          },
          platformMetrics: {
            analyticsLoaded: vercelAnalytics,
            speedInsightsLoaded: vercelSpeedInsights,
            edgeCacheStatus: null, // populated from response headers
            region: null, // populated from response headers
          },
        });
      }
    } catch { /* skip */ }

    // 53. Netlify
    try {
      if (qs('script[src*=".netlify"]')) {
        results.push({
          name: 'Netlify',
          category: 'hosting',
          version: null,
          config: {},
          appHints: {
            needsHeaderCheck: true,
          },
          constraints: {
            canFix: [
              'Application code',
              'netlify.toml configuration',
              'Image CDN',
              'Caching headers',
              'Redirect rules',
            ],
            cannotFix: [
              'Function cold starts',
              'CDN routing',
              'Edge handler latency',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 54. Cloudflare Pages — browser-side can only check for Workers scripts
    try {
      if (qs('script[src*="cloudflareinsights"]') || qs('script[src*="beacon.min.js"]')) {
        results.push({
          name: 'Cloudflare Pages',
          category: 'hosting',
          version: null,
          config: {},
          appHints: {
            needsHeaderCheck: true,
          },
          constraints: {
            canFix: [
              'Application code',
              '_headers configuration',
              'Caching rules',
              'Workers logic',
            ],
            cannotFix: [
              'CDN edge network',
              'Cloudflare core overhead (minimal)',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    // 55. Firebase Hosting
    try {
      if (
        qs('script[src*="firebase"]') ||
        qs('script[src*="firebaseapp"]')
      ) {
        results.push({
          name: 'Firebase Hosting',
          category: 'hosting',
          version: null,
          config: {},
          appHints: {},
          constraints: {
            canFix: [
              'firebase.json configuration',
              'Application code',
            ],
            cannotFix: [
              'Firebase CDN',
              'Hosting cold starts',
            ],
          },
          platformMetrics: {},
        });
      }
    } catch { /* skip */ }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Network entry correlation (Node.js land) — response header checks for
// hosting platforms
// ---------------------------------------------------------------------------

function detectHostingFromHeaders(
  networkEntries: NetworkEntry[],
): RawDetection[] {
  const results: RawDetection[] = [];
  // We check the first document-level request (status 200, no .js/.css extension)
  // In practice, response headers from networkEntries don't include custom headers
  // from the server — the browse tool captures method/url/status/duration/size.
  // Hosting detection from headers would require access to response headers,
  // which are not in NetworkEntry. We rely on browser-side detection and
  // supplement with URL pattern matching here.

  // Vercel: detect via /_vercel/ paths in network entries
  if (
    networkEntries.some((e) => e.url.includes('/_vercel/'))
  ) {
    // Already detected browser-side; no duplicate needed
  }

  // Netlify: detect via .netlify paths
  if (
    networkEntries.some((e) => e.url.includes('.netlify'))
  ) {
    // Already detected browser-side; no duplicate needed
  }

  return results;
}

// ---------------------------------------------------------------------------
// Shopify app enumeration from network entries
// ---------------------------------------------------------------------------

function enumerateShopifyApps(
  detection: RawDetection,
  networkEntries: NetworkEntry[],
  scriptTags: Array<{ src: string; async: boolean; defer: boolean }>,
): PlatformApp[] {
  const cdnHost = (detection.config.cdnHost as string) || '';
  const apps = new Map<string, PlatformApp>();

  const scripts = filterScripts(networkEntries);
  const styles = filterStyles(networkEntries);

  for (const entry of scripts) {
    // Skip Shopify core and theme scripts
    if (entry.url.includes('cdn.shopify.com')) continue;
    if (cdnHost && entry.url.includes(cdnHost)) continue;
    // Skip same-origin scripts (likely theme code)
    try {
      const u = new URL(entry.url);
      if (u.pathname.startsWith('/cdn/')) continue;
    } catch { /* skip */ }

    const appName = extractShopifyAppName(entry.url);
    const existing = apps.get(appName);

    if (existing) {
      existing.scriptUrls.push(entry.url);
      existing.totalSizeKB += Math.round((entry.size || 0) / 1024);
    } else {
      apps.set(appName, {
        name: appName,
        scriptUrls: [entry.url],
        styleUrls: [],
        totalSizeKB: Math.round((entry.size || 0) / 1024),
        usedOnPage: true, // if the script loaded, the app is active
        loadTiming: getScriptLoadTiming(entry.url, scriptTags),
      });
    }
  }

  // Associate CSS with known apps
  for (const entry of styles) {
    if (entry.url.includes('cdn.shopify.com')) continue;
    if (cdnHost && entry.url.includes(cdnHost)) continue;

    const appName = extractShopifyAppName(entry.url);
    const existing = apps.get(appName);
    if (existing) {
      existing.styleUrls.push(entry.url);
      existing.totalSizeKB += Math.round((entry.size || 0) / 1024);
    }
  }

  return Array.from(apps.values());
}

// ---------------------------------------------------------------------------
// WordPress plugin enumeration from network entries
// ---------------------------------------------------------------------------

function enumerateWordPressPlugins(
  networkEntries: NetworkEntry[],
  scriptTags: Array<{ src: string; async: boolean; defer: boolean }>,
): PlatformApp[] {
  const plugins = new Map<string, PlatformApp>();

  const scripts = filterScripts(networkEntries);
  const styles = filterStyles(networkEntries);

  for (const entry of [...scripts, ...styles]) {
    const pluginName = extractWpPluginName(entry.url);
    if (!pluginName) continue;

    const isScript = entry.url.endsWith('.js') || entry.url.includes('.js?');
    const existing = plugins.get(pluginName);

    if (existing) {
      if (isScript) {
        existing.scriptUrls.push(entry.url);
      } else {
        existing.styleUrls.push(entry.url);
      }
      existing.totalSizeKB += Math.round((entry.size || 0) / 1024);
    } else {
      plugins.set(pluginName, {
        name: pluginName,
        scriptUrls: isScript ? [entry.url] : [],
        styleUrls: isScript ? [] : [entry.url],
        totalSizeKB: Math.round((entry.size || 0) / 1024),
        usedOnPage: true,
        loadTiming: isScript
          ? getScriptLoadTiming(entry.url, scriptTags)
          : 'unknown',
      });
    }
  }

  return Array.from(plugins.values());
}

// ---------------------------------------------------------------------------
// Script tag info extraction (for load timing detection)
// ---------------------------------------------------------------------------

async function extractScriptTags(
  page: Page,
): Promise<Array<{ src: string; async: boolean; defer: boolean }>> {
  return page.evaluate(() => {
    const tags: Array<{ src: string; async: boolean; defer: boolean }> = [];
    for (const el of Array.from(document.querySelectorAll('script[src]'))) {
      const script = el as HTMLScriptElement;
      tags.push({
        src: script.src,
        async: script.async,
        defer: script.defer,
      });
    }
    return tags;
  });
}

// ---------------------------------------------------------------------------
// Perf hints generation
// ---------------------------------------------------------------------------

function generatePerfHints(
  detection: RawDetection,
  apps: PlatformApp[],
  networkEntries: NetworkEntry[],
): DetectedSaaS['perfHints'] {
  const hints: DetectedSaaS['perfHints'] = [];
  const pm = detection.platformMetrics;

  switch (detection.name) {
    case 'Shopify': {
      const appCount = apps.length;
      if (appCount > 5) {
        hints.push({
          severity: 'critical',
          message: `${appCount} apps inject frontend JS -- audit each for necessity`,
          metric: 'TBT',
          evidence: `${appCount} third-party app scripts detected`,
        });
      }
      // Check for apps loaded but possibly not needed on this page type
      for (const app of apps) {
        if (!app.usedOnPage && app.totalSizeKB > 10) {
          hints.push({
            severity: 'warning',
            message: `App '${app.name}' (${app.totalSizeKB}KB) loaded but not active on this page template`,
            metric: 'LCP',
            evidence: app.scriptUrls[0] || '',
          });
        }
      }
      const themeJsSize = pm.themeJsSize as number;
      if (themeJsSize > 200) {
        hints.push({
          severity: 'warning',
          message: `Theme JS is ${themeJsSize}KB -- check for unused features`,
          metric: 'TBT',
          evidence: 'theme.js bundle size',
        });
      }
      if (!pm.sectionRenderingAPI) {
        hints.push({
          severity: 'info',
          message: 'Shopify Sections Rendering API can lazy-load below-fold sections',
          metric: 'LCP',
          evidence: 'No [data-section-type] elements found',
        });
      }
      const liquidMs = pm.liquidRenderMs as number | null;
      if (liquidMs !== null && liquidMs > 1000) {
        hints.push({
          severity: 'critical',
          message: `Server-side Liquid render is ${liquidMs}ms -- check for complex Liquid loops`,
          metric: 'TTFB',
          evidence: `Server-Timing: liquid=${liquidMs}ms`,
        });
      } else if (liquidMs !== null && liquidMs > 500) {
        hints.push({
          severity: 'warning',
          message: `Server-side Liquid render is ${liquidMs}ms -- check for complex Liquid loops`,
          metric: 'TTFB',
          evidence: `Server-Timing: liquid=${liquidMs}ms`,
        });
      }
      break;
    }

    case 'BigCommerce': {
      if (detection.config.stencil) {
        hints.push({
          severity: 'info',
          message: 'Check for unused Cornerstone components in Stencil theme',
          metric: 'TBT',
          evidence: 'Stencil theme detected',
        });
      }
      break;
    }

    case 'WooCommerce': {
      if (pm.cartFragmentsEnabled) {
        hints.push({
          severity: 'critical',
          message: 'wc-cart-fragments.js fires AJAX on EVERY page load -- disable on non-shop pages',
          metric: 'TTFB',
          evidence: 'cart-fragments.js script detected',
        });
      }
      const gateways = detection.config.paymentGateways as number;
      if (gateways > 3) {
        hints.push({
          severity: 'info',
          message: `${gateways} payment gateways detected -- each may load its own JS`,
          metric: 'TBT',
          evidence: `${gateways} [class*="payment_method_"] elements`,
        });
      }
      if (detection.config.blocks) {
        hints.push({
          severity: 'warning',
          message: 'WooCommerce block CSS/JS loaded -- verify it is needed on this page',
          metric: 'LCP',
          evidence: '[class*="wc-block-"] elements detected',
        });
      }
      break;
    }

    case 'Magento': {
      const moduleCount = pm.requirejsModuleCount as number;
      if (moduleCount > 50) {
        hints.push({
          severity: 'critical',
          message: `${moduleCount} RequireJS modules loaded -- enable JS bundling to reduce waterfall`,
          metric: 'TBT',
          evidence: `require.s.contexts._.defined has ${moduleCount} entries`,
        });
      }
      const sectionCount = pm.customerSectionCount as number;
      if (sectionCount > 5) {
        hints.push({
          severity: 'warning',
          message: `${sectionCount} customer sections trigger separate AJAX calls on page load`,
          metric: 'TTFB',
          evidence: `${sectionCount} customer/section/load requests`,
        });
      }
      const fpc = pm.fpcStatus as string | null;
      if (fpc === 'MISS') {
        hints.push({
          severity: 'warning',
          message: 'Full Page Cache MISS -- page rendered from scratch',
          metric: 'TTFB',
          evidence: 'X-Magento-Cache-Control: MISS',
        });
      }
      const koBindings = pm.knockoutBindingCount as number;
      if (koBindings > 30) {
        hints.push({
          severity: 'warning',
          message: `${koBindings} Knockout.js bindings -- consider removing unused UI components`,
          metric: 'TBT',
          evidence: `${koBindings} [data-bind] elements`,
        });
      }
      break;
    }

    case 'PrestaShop': {
      const modCount = detection.config.moduleCount as number;
      if (modCount > 10) {
        hints.push({
          severity: 'warning',
          message: `${modCount} modules loading frontend assets -- audit for necessity`,
          metric: 'TBT',
          evidence: `${modCount} scripts from /modules/ paths`,
        });
      }
      break;
    }

    case 'OpenCart': {
      hints.push({
        severity: 'warning',
        message: 'OpenCart has no built-in asset bundling',
        metric: 'LCP',
        evidence: 'OpenCart platform detected',
      });
      break;
    }

    case 'Salesforce Commerce Cloud': {
      hints.push({
        severity: 'info',
        message: 'SFCC controller pipeline adds server latency',
        metric: 'TTFB',
        evidence: 'SFCC/Demandware platform detected',
      });
      break;
    }

    case 'SAP Commerce': {
      if (pm.smartEditInProduction) {
        hints.push({
          severity: 'warning',
          message: 'SmartEdit JS loaded in production -- adds overhead',
          metric: 'TBT',
          evidence: 'script[src*="smartedit"] detected',
        });
      }
      break;
    }

    case 'Webflow': {
      if (pm.interactionsEnabled) {
        hints.push({
          severity: 'info',
          message: 'Webflow IX2 engine is ~100KB -- only load on pages with interactions',
          metric: 'TBT',
          evidence: 'ix2.min.js script detected',
        });
      }
      const customBlocks = pm.customCodeBlocks as number;
      if (customBlocks > 5) {
        hints.push({
          severity: 'warning',
          message: `${customBlocks} custom code embeds can introduce render-blocking scripts`,
          metric: 'LCP',
          evidence: `${customBlocks} [class*="w-embed"] elements`,
        });
      }
      hints.push({
        severity: 'warning',
        message: 'Webflow images may not use srcset -- check responsive image settings',
        metric: 'LCP',
        evidence: 'Webflow platform detected',
      });
      break;
    }

    case 'Squarespace': {
      hints.push({
        severity: 'info',
        message: 'Squarespace requires jQuery -- cannot remove',
        metric: 'TBT',
        evidence: 'Squarespace platform detected',
      });
      hints.push({
        severity: 'info',
        message: 'Squarespace ships template CSS as single file',
        metric: 'LCP',
        evidence: 'Monolithic CSS bundle',
      });
      break;
    }

    case 'Wix': {
      const runtimeKB = pm.platformRuntimeKB as number;
      if (runtimeKB > 800) {
        hints.push({
          severity: 'critical',
          message: `Wix platform JS is ${runtimeKB}KB -- this is a platform constraint, not fixable`,
          metric: 'TBT',
          evidence: `${runtimeKB}KB of Wix runtime scripts`,
        });
      }
      const thunderbolt = pm.thunderboltChunks as number;
      if (thunderbolt > 0) {
        hints.push({
          severity: 'warning',
          message: 'Each Wix app adds frontend code',
          metric: 'TBT',
          evidence: `${thunderbolt} Thunderbolt chunks loaded`,
        });
      }
      break;
    }

    case 'Weebly': {
      hints.push({
        severity: 'info',
        message: 'Weebly has limited performance optimization options',
        metric: 'LCP',
        evidence: 'Legacy platform detected',
      });
      break;
    }

    case 'Strikingly': {
      hints.push({
        severity: 'warning',
        message: 'Strikingly loads all page sections -- no lazy loading',
        metric: 'LCP',
        evidence: 'Single-page architecture detected',
      });
      break;
    }

    case 'Framer': {
      if (detection.config.motionRuntime) {
        hints.push({
          severity: 'info',
          message: 'Framer motion runtime adds animation overhead',
          metric: 'TBT',
          evidence: '__framer_importFromPackage detected',
        });
      }
      break;
    }

    case 'Bubble': {
      const bubbleKB = pm.bubbleRuntimeKB as number;
      if (bubbleKB > 1500) {
        hints.push({
          severity: 'critical',
          message: `Bubble runtime is ${bubbleKB}KB -- platform constraint, not fixable`,
          metric: 'TBT',
          evidence: `${bubbleKB}KB of Bubble runtime scripts`,
        });
      }
      hints.push({
        severity: 'warning',
        message: 'Every user interaction triggers server processing',
        metric: 'INP',
        evidence: 'Bubble no-code platform detected',
      });
      break;
    }

    case 'WordPress.com': {
      hints.push({
        severity: 'info',
        message: 'WordPress.com hosted -- some optimizations require Business plan',
        metric: 'LCP',
        evidence: 'WordPress.com hosting detected',
      });
      break;
    }

    case 'Ghost': {
      if (pm.isCasperTheme) {
        hints.push({
          severity: 'info',
          message: 'Default Casper theme -- check for unused features',
          metric: 'LCP',
          evidence: 'Casper theme detected',
        });
      }
      if (pm.memberPortalLoaded) {
        hints.push({
          severity: 'info',
          message: 'Ghost member portal script loaded -- ~80KB',
          metric: 'TBT',
          evidence: '[data-portal] element detected',
        });
      }
      break;
    }

    case 'HubSpot CMS': {
      const hsKB = pm.hubspotScriptsKB as number;
      if (hsKB > 300) {
        hints.push({
          severity: 'warning',
          message: `HubSpot tracking + analytics scripts total ${hsKB}KB`,
          metric: 'TBT',
          evidence: `${hsKB}KB of HubSpot scripts`,
        });
      }
      const ctaCount = pm.ctaCount as number;
      if (ctaCount > 3) {
        hints.push({
          severity: 'info',
          message: `${ctaCount} CTA widgets -- each adds script overhead`,
          metric: 'TBT',
          evidence: `${ctaCount} [class*="hs-cta"] elements`,
        });
      }
      const formCount = pm.formCount as number;
      if (formCount > 0) {
        hints.push({
          severity: 'info',
          message: `HubSpot form runtime adds ~100KB per form (${formCount} forms detected)`,
          metric: 'TBT',
          evidence: `${formCount} [class*="hs-form"] elements`,
        });
      }
      break;
    }

    case 'Sitecore': {
      if (pm.experienceEditorInProduction) {
        hints.push({
          severity: 'warning',
          message: 'Experience Editor artifacts detected in production',
          metric: 'TBT',
          evidence: '[class*="scWebEdit"] elements found',
        });
      }
      break;
    }

    case 'Adobe Experience Manager': {
      if (pm.editModeInProduction) {
        hints.push({
          severity: 'warning',
          message: 'AEM editor-mode resources detected in production',
          metric: 'TBT',
          evidence: '[class*="cq-editor"] elements found',
        });
      }
      const clientLibs = pm.clientLibCount as number;
      if (clientLibs > 10) {
        hints.push({
          severity: 'warning',
          message: `${clientLibs} AEM client library includes -- consolidate to reduce requests`,
          metric: 'LCP',
          evidence: `${clientLibs} /etc.clientlibs/ resources`,
        });
      }
      break;
    }

    case 'Contentful': {
      hints.push({
        severity: 'warning',
        message: 'Check Contentful query for over-fetching (include depth, linked entries)',
        metric: 'TTFB',
        evidence: 'Contentful API requests detected',
      });
      hints.push({
        severity: 'warning',
        message: 'Use Contentful Image API for responsive images (f=webp, w=, q=)',
        metric: 'LCP',
        evidence: 'Contentful CDN detected',
      });
      break;
    }

    case 'Storyblok': {
      if (pm.bridgeInProduction) {
        hints.push({
          severity: 'warning',
          message: 'Storyblok bridge.js (~50KB) detected -- ensure it is only loaded in preview mode',
          metric: 'TBT',
          evidence: 'storyblok bridge script detected in page',
        });
      }
      break;
    }

    case 'Vercel': {
      if (pm.analyticsLoaded) {
        hints.push({
          severity: 'info',
          message: 'Vercel Analytics adds ~5KB',
          metric: 'TBT',
          evidence: '/_vercel/insights script loaded',
        });
      }
      if (pm.speedInsightsLoaded) {
        hints.push({
          severity: 'info',
          message: 'Vercel Speed Insights adds ~10KB',
          metric: 'TBT',
          evidence: '/_vercel/speed-insights script loaded',
        });
      }
      const cacheStatus = pm.edgeCacheStatus as string | null;
      if (cacheStatus === 'MISS') {
        hints.push({
          severity: 'info',
          message: 'Vercel edge cache MISS -- page rendered on demand',
          metric: 'TTFB',
          evidence: 'x-vercel-cache: MISS',
        });
      }
      hints.push({
        severity: 'info',
        message: 'Edge functions have ~50ms cold start -- use Edge Config for static data',
        metric: 'TTFB',
        evidence: 'Vercel hosting detected',
      });
      break;
    }

    case 'Netlify': {
      hints.push({
        severity: 'warning',
        message: 'Check _redirects / netlify.toml for unnecessary redirect chains',
        metric: 'TTFB',
        evidence: 'Netlify hosting detected',
      });
      break;
    }

    case 'Cloudflare Pages': {
      hints.push({
        severity: 'info',
        message: 'Cloudflare cache -- configure cache rules for static content',
        metric: 'TTFB',
        evidence: 'Cloudflare Pages detected',
      });
      break;
    }
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Enrich platform metrics from network entries
// ---------------------------------------------------------------------------

function enrichPlatformMetrics(
  detection: RawDetection,
  networkEntries: NetworkEntry[],
): void {
  const pm = detection.platformMetrics;

  switch (detection.name) {
    case 'Shopify': {
      // Theme JS size
      const themeScripts = networkEntries.filter(
        (e) =>
          (e.url.includes('theme.js') || e.url.includes('theme.min.js')) &&
          e.url.includes('cdn.shopify.com'),
      );
      pm.themeJsSize = sizeKB(themeScripts);
      break;
    }

    case 'Magento': {
      // Customer section AJAX calls
      const sectionCalls = networkEntries.filter((e) =>
        e.url.includes('customer/section/load'),
      );
      pm.customerSectionCount = sectionCalls.length;
      pm.customerSectionPayloadKB = sizeKB(sectionCalls);

      // FPC status from network patterns (heuristic: check for varnish indicators)
      // Since we don't have response headers in NetworkEntry, use URL heuristics
      const cacheBusters = networkEntries.filter(
        (e) => e.url.includes('_=') && e.url.includes('customer/section'),
      );
      if (cacheBusters.length > 0) {
        pm.fpcStatus = 'active'; // sections loading suggests FPC is used
      }
      break;
    }

    case 'Webflow': {
      const wfScripts = filterByUrlPattern(
        filterScripts(networkEntries),
        'webflow',
      );
      pm.webflowJsSize = sizeKB(wfScripts);

      const ix2Scripts = filterByUrlPattern(
        filterScripts(networkEntries),
        'ix2',
      );
      pm.interactionsJsSize = sizeKB(ix2Scripts);
      break;
    }

    case 'Wix': {
      const wixScripts = filterByUrlPattern(
        filterScripts(networkEntries),
        /wix|thunderbolt|parastorage/,
      );
      pm.platformRuntimeKB = sizeKB(wixScripts);
      break;
    }

    case 'Bubble': {
      const bubbleScripts = filterByUrlPattern(
        filterScripts(networkEntries),
        'bubble.io',
      );
      pm.bubbleRuntimeKB = sizeKB(bubbleScripts);
      break;
    }

    case 'HubSpot CMS': {
      const hsScripts = filterByUrlPattern(
        filterScripts(networkEntries),
        /hs-scripts|hubspot|hs-analytics|hs-banner/,
      );
      pm.hubspotScriptsKB = sizeKB(hsScripts);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectSaaS(
  page: Page,
  networkEntries?: NetworkEntry[],
): Promise<DetectedSaaS[]> {
  const entries = networkEntries ?? [];

  // 1. Run browser-side detection
  const rawDetections = await runBrowserDetection(page);

  // 2. Also check for hosting platforms via network URL patterns
  const headerDetections = detectHostingFromHeaders(entries);
  const allRaw = [...rawDetections, ...headerDetections];

  // 3. Get script tag info for load timing analysis
  const scriptTags = await extractScriptTags(page);

  // 4. Process each detection: enrich metrics, enumerate apps, generate hints
  const results: DetectedSaaS[] = [];

  for (const raw of allRaw) {
    // Enrich platform metrics from network entries
    if (entries.length > 0) {
      enrichPlatformMetrics(raw, entries);
    }

    // Enumerate apps/plugins
    let apps: PlatformApp[] = [];
    if (entries.length > 0) {
      if (raw.name === 'Shopify') {
        apps = enumerateShopifyApps(raw, entries, scriptTags);
        raw.platformMetrics.appScriptCount = apps.length;
      } else if (
        raw.name === 'WooCommerce' ||
        raw.name === 'WordPress.com' ||
        raw.appHints.isWordPress
      ) {
        apps = enumerateWordPressPlugins(entries, scriptTags);
      }
    }

    // Generate perf hints
    const perfHints = generatePerfHints(raw, apps, entries);

    results.push({
      name: raw.name,
      category: raw.category,
      version: raw.version,
      config: raw.config,
      apps,
      constraints: raw.constraints,
      perfHints,
      platformMetrics: raw.platformMetrics,
    });
  }

  return results;
}
