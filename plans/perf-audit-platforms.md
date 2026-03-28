# SaaS Platform Detection Reference — Performance Audit System

> Referenced from: plans/perf-audit-system.md (TASK-007)
> Total: 55 platforms across 6 categories

## Detection Philosophy

SaaS platform detection serves a different purpose than framework detection:
1. **Constraint identification** — developers can't change the platform itself, only work within it
2. **"Fixable vs Platform" separation** — every finding must be classified
3. **App/plugin/extension enumeration** — the #1 source of bloat on SaaS platforms
4. **Platform-specific deep metrics** — Liquid render time (Shopify), RequireJS waterfall (Magento), FPC status (Magento/WordPress)

## Detection Return Shape

```typescript
interface DetectedSaaS {
  name: string;                          // e.g., "Shopify"
  category: SaaSCategory;
  version: string | null;
  config: PlatformConfig;               // Platform-specific config details
  apps: PlatformApp[];                  // Installed apps/plugins/extensions
  constraints: {
    canFix: string[];                   // What developers CAN optimize
    cannotFix: string[];                // Platform limitations
  };
  perfHints: PerfHint[];
  platformMetrics: Record<string, any>; // Platform-specific perf metrics
}

interface PlatformApp {
  name: string;                         // App/plugin name
  scriptUrls: string[];                 // Associated JS files
  styleUrls: string[];                  // Associated CSS files
  totalSizeKB: number;                  // Combined asset size
  usedOnPage: boolean;                  // Whether app is active on current page
  loadTiming: 'sync' | 'async' | 'defer' | 'unknown';
}

type SaaSCategory = 'ecommerce' | 'website-builder' | 'cms-hosted' | 'cms-headless' | 'marketing' | 'hosting';
```

---

## E-Commerce Platforms (15)

### 1. Shopify
```
Detect:     !!window.Shopify || document.querySelector('link[href*="cdn.shopify.com"]')
Version:    null (platform version not exposed)
Config:     {
              theme: {
                name: window.Shopify?.theme?.name,
                id: window.Shopify?.theme?.id,
                role: window.Shopify?.theme?.role  // main, unpublished, demo
              },
              checkout: window.Shopify?.checkout?.token ? 'standard' : null,
              currency: window.Shopify?.currency?.active,
              locale: window.Shopify?.locale,
              routes: window.Shopify?.routes,
              cdnHost: window.Shopify?.cdnHost
            }
Apps:       (detected by scanning scripts NOT from cdn.shopify.com or the theme):
            - Script src patterns: apps often load from their own CDN
            - Known app domains: klaviyo.com, judge.me, loox.io, bold.com, recharge.com, etc.
            - data-* attributes injected by apps
            - Shopify.loadFeatures() calls

Platform Metrics:
  - liquidRenderMs: x-shopify-stage header (if exposed), or Server-Timing header
  - themeJsSize: size of theme.js/theme.min.js from network entries
  - appScriptCount: count of non-theme, non-Shopify-core scripts
  - sectionRenderingAPI: !!document.querySelector('[data-section-type]')

Constraints:
  canFix:
    - Theme Liquid template optimization
    - Image optimization and lazy loading
    - App selection (remove unused apps)
    - Section loading strategy (lazy sections)
    - Preload/prefetch hints in theme.liquid
    - Font loading strategy in theme CSS
    - Third-party script defer/async
  cannotFix:
    - Shopify platform JS (~200KB core runtime)
    - Shopify analytics/tracking scripts
    - Checkout page performance
    - CDN configuration (Shopify CDN)
    - HTTP/2 push settings
    - Server-side rendering pipeline
    - Content Security Policy headers

Perf hints:
  - App script count > 5: severity=critical "6+ apps inject frontend JS — audit each for necessity"
  - App not used on page type: severity=warning "App '{name}' ({size}KB) loaded but not active on this page template"
  - Theme.js > 200KB: severity=warning "Theme JS is {size}KB — check for unused features"
  - No lazy sections: severity=info "Shopify Sections Rendering API can lazy-load below-fold sections"
  - Liquid render > 500ms: severity=warning "Server-side Liquid render is {ms}ms — check for complex Liquid loops"
  - Liquid render > 1000ms: severity=critical
```

### 2. BigCommerce
```
Detect:     document.querySelector('script[src*="bigcommerce.com"]') || !!window.BCData || document.querySelector('link[href*="bigcommerce"]')
Version:    null
Config:     {
              stencil: !!document.querySelector('[data-stencil-component]'),
              cornerstone: document.querySelector('link[href*="cornerstone"]') ? true : false
            }
Apps:       (detected via script patterns from app CDNs)

Constraints:
  canFix: [theme code, app selection, image optimization]
  cannotFix: [platform runtime, checkout, CDN config]

Perf hints:
  - Stencil theme weight: severity=info "Check for unused Cornerstone components"
```

### 3. WooCommerce
```
Detect:     !!window.wc_add_to_cart_params || !!document.querySelector('.woocommerce') || document.querySelector('script[src*="woocommerce"]')
Version:    null
Config:     {
              cartFragments: !!document.querySelector('script[src*="cart-fragments"]'),
              blocks: !!document.querySelector('[class*="wc-block-"]'),
              paymentGateways: document.querySelectorAll('[class*="payment_method_"]').length,
              ajaxAddToCart: !!window.wc_add_to_cart_params?.ajax_url
            }
Apps:       (detected same as WordPress plugins — via /wp-content/plugins/ paths)

Constraints:
  canFix: [full control — self-hosted WordPress]
  cannotFix: []

Platform Metrics:
  - cartFragmentsEnabled: whether wc-cart-fragments.js is loaded
  - cartFragmentsOnEveryPage: whether it loads on non-shop pages

Perf hints:
  - Cart fragments on every page: severity=critical, metric=TTFB "wc-cart-fragments.js fires AJAX on EVERY page load — disable on non-shop pages"
  - Many payment gateways (>3): severity=info "Each gateway may load its own JS"
  - WooCommerce blocks loaded on non-shop page: severity=warning "WooCommerce block CSS/JS loaded where not needed"
```

### 4. Magento / Adobe Commerce
```
(Already detailed in frameworks.md as #42 — but SaaS-hosted Magento Cloud adds constraints)
Detect:     Same as framework detection
Config:     {
              ...frameworkConfig,
              cloud: document.querySelector('meta[name="x-magento-cloud"]') || !!window.magentoCloud,
              varnish: null,  // detected via X-Magento-Cache-Control header
              elasticsearch: null  // detected via search behavior
            }

Platform Metrics:
  - requirejsModuleCount: count of loaded AMD modules
  - requirejsWaterfallDepth: longest sequential module chain
  - knockoutBindingCount: document.querySelectorAll('[data-bind]').length
  - customerSectionCount: number of customer/section/load AJAX calls
  - customerSectionPayloadKB: total size of section responses
  - fpcStatus: 'HIT' | 'MISS' | 'none' from X-Magento-Cache-Control header

Constraints (Adobe Commerce Cloud):
  canFix: [theme code, module configuration, JS bundling config, image optimization]
  cannotFix: [Varnish config (managed), infrastructure scaling, PHP version]

Perf hints:
  - RequireJS waterfall > 2s: severity=critical "Sequential module loading takes {time}ms — enable bundling"
  - Customer sections > 5: severity=warning "Each section triggers a separate AJAX call on page load"
  - Customer section payload > 100KB: severity=warning "Section data is {size}KB — reduce section data"
  - FPC MISS: severity=warning "Full Page Cache MISS — page rendered from scratch"
  - Knockout bindings > 30: severity=warning "Heavy Knockout.js rendering — consider removing unused UI components"
```

### 5. PrestaShop
```
Detect:     !!window.prestashop || document.querySelector('meta[name="generator"][content*="PrestaShop"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/PrestaShop ([\d.]+)/)?.[1]
Config:     { modules: document.querySelectorAll('script[src*="/modules/"]').length }
Constraints:
  canFix: [module selection, theme code, image optimization]
  cannotFix: [core JS requirements]
Perf hints:
  - Many modules loading frontend assets: severity=warning
```

### 6. OpenCart
```
Detect:     document.querySelector('script[src*="catalog/view"]') || document.querySelector('link[href*="catalog/view"]')
Version:    null
Config:     {}
Constraints:
  canFix: [template code, extension selection]
  cannotFix: [core architecture, lack of modern bundling]
Perf hints:
  - No bundling: severity=warning "OpenCart has no built-in asset bundling"
```

### 7. Salesforce Commerce Cloud (SFCC)
```
Detect:     document.querySelector('script[src*="demandware"]') || !!window.dw || location.hostname.includes('.demandware.net')
Version:    null
Config:     { sfra: !!document.querySelector('[data-action]') }
Constraints:
  canFix: [controller code, template optimization, content slot config]
  cannotFix: [platform runtime, OCAPI latency, CDN config]
Perf hints:
  - SFRA overhead: severity=info "SFCC controller pipeline adds server latency"
```

### 8. SAP Commerce (Hybris)
```
Detect:     document.querySelector('script[src*="/_ui/"]') || !!window.ACC || document.querySelector('[class*="yCmsComponent"]')
Version:    null
Config:     {}
Constraints:
  canFix: [template code, component rendering]
  cannotFix: [platform runtime, SmartEdit overhead]
Perf hints:
  - SmartEdit markers in production: severity=warning "SmartEdit JS loaded in production — adds overhead"
```

### 9-15: Saleor, Medusa, Ecwid, Volusion, Shift4Shop, Swell, CommerceTools
```
(Saleor/Medusa/Swell/CommerceTools: headless — full frontend control)
(Ecwid/Volusion/Shift4Shop: hosted — limited control like Shopify)
Each with appropriate constraint mapping.
```

---

## Website Builders (13)

### 16. Webflow
```
Detect:     !!window.Webflow || document.querySelector('html[data-wf-site]') || document.querySelector('script[src*="webflow"]')
Version:    null
Config:     {
              siteId: document.documentElement.getAttribute('data-wf-site'),
              pageId: document.documentElement.getAttribute('data-wf-page'),
              interactions: !!document.querySelector('script[src*="webflow"][src*="ix2"]'),
              ecommerce: !!document.querySelector('[data-wf-cart-type]')
            }

Platform Metrics:
  - webflowJsSize: total size of webflow.*.js scripts
  - interactionsJsSize: size of ix2.min.js (interaction engine)
  - customCodeBlocks: document.querySelectorAll('[class*="w-embed"]').length

Constraints:
  canFix: [image optimization, custom code placement, page structure, font selection, interaction complexity]
  cannotFix: [Webflow runtime JS (~300KB), no code splitting, interaction engine overhead, server/CDN config, HTML structure generated by designer]

Perf hints:
  - Interactions engine loaded: severity=info "Webflow IX2 engine is ~100KB — only load on pages with interactions"
  - No responsive images: severity=warning "Webflow images may not use srcset — check responsive image settings"
  - Many custom code embeds (>5): severity=warning "Custom code blocks can introduce render-blocking scripts"
```

### 17. Squarespace
```
Detect:     !!window.Static?.SQUARESPACE_CONTEXT || document.querySelector('link[href*="squarespace"]') || document.querySelector('script[src*="squarespace"]')
Version:    window.Static?.SQUARESPACE_CONTEXT?.templateVersion
Config:     {
              template: window.Static?.SQUARESPACE_CONTEXT?.templateId,
              templateVersion: window.Static?.SQUARESPACE_CONTEXT?.templateVersion,
              commerce: !!window.Static?.SQUARESPACE_CONTEXT?.websiteSettings?.storeSettings
            }

Constraints:
  canFix: [image sizes, content structure, custom CSS/JS injection, page count]
  cannotFix: [platform runtime (~500KB), jQuery dependency, template engine, CDN config, bundling strategy]

Perf hints:
  - jQuery required: severity=info "Squarespace requires jQuery — cannot remove"
  - Monolithic CSS: severity=info "Squarespace ships template CSS as single file"
```

### 18. Wix
```
Detect:     document.querySelector('meta[name="generator"][content*="Wix"]') || !!window.wixBiSession || document.querySelector('script[src*="wix"]')
Version:    null
Config:     {
              thunderbolt: !!document.querySelector('script[src*="thunderbolt"]'),
              viewer: !!window.viewerModel
            }

Platform Metrics:
  - platformRuntimeKB: total Wix runtime JS (typically 1MB+)
  - thunderboltChunks: document.querySelectorAll('script[src*="thunderbolt"]').length

Constraints:
  canFix: [image optimization (via Wix media manager), page structure, app selection, font selection, content above fold]
  cannotFix: [platform runtime (1MB+ JS), rendering engine (Thunderbolt/Santa), no custom code splitting, server infrastructure, HTML structure, CSS architecture]

Perf hints:
  - Platform runtime > 800KB: severity=critical "Wix platform JS is {size}KB — this is a platform constraint, not fixable"
  - Many Wix apps: severity=warning "Each Wix app adds frontend code"
  - Editor artifacts in production: severity=warning "Editor-mode resources detected in production"
```

### 19. Weebly
```
Detect:     document.querySelector('script[src*="weebly"]') || document.querySelector('[class*="wsite-"]')
Version:    null
Constraints:
  canFix: [image sizes, content]
  cannotFix: [platform runtime, legacy codebase, no modern optimization tools]
Perf hints:
  - Legacy platform: severity=info "Weebly has limited performance optimization options"
```

### 20-22: GoDaddy Website Builder, Jimdo, Duda
```
(Each with similar detection via script/class patterns)
(Limited optimization control — mostly content/image focused)
```

### 23. Strikingly
```
Detect:     document.querySelector('script[src*="strikingly"]') || !!window.s_
Version:    null
Constraints:
  canFix: [content, images, section management]
  cannotFix: [single-page architecture (all sections loaded), platform runtime]
Perf hints:
  - All sections loaded: severity=warning "Strikingly loads all page sections — no lazy loading"
```

### 24. Carrd
```
Detect:     document.querySelector('meta[name="generator"][content*="Carrd"]') || location.hostname.includes('.carrd.co')
Version:    null
Constraints: (Minimal site — usually fast)
Perf hints: (Rarely an issue)
```

### 25. Framer
```
Detect:     document.querySelector('script[src*="framer"]') || !!window.__framer_importFromPackage
Version:    null
Config:     { motionRuntime: !!window.__framer_importFromPackage }
Constraints:
  canFix: [component config, image optimization, page structure]
  cannotFix: [Framer motion runtime, canvas rendering approach, bundling]
Perf hints:
  - Motion runtime loaded: severity=info "Framer motion runtime adds animation overhead"
```

### 26. Bubble
```
Detect:     !!window.bubble_fn || document.querySelector('script[src*="bubble.io"]') || !!document.querySelector('.bubble-element')
Version:    null
Config:     {}

Constraints:
  canFix: [workflow optimization, data query simplification, page decomposition]
  cannotFix: [no-code runtime (2MB+ JS), every interaction = server round-trip, rendering engine, HTML output quality, CSS architecture]

Perf hints:
  - No-code runtime > 1.5MB: severity=critical "Bubble runtime is {size}KB — platform constraint, not fixable"
  - Server round-trips per interaction: severity=warning "Every user interaction triggers server processing"
```

### 27-28: Typedream, Super.so (Notion-based)
```
(Notion API latency as TTFB constraint)
```

---

## CMS — Hosted (8)

### 29. WordPress.com (hosted)
```
Detect:     WordPress detection + (location.hostname.includes('.wordpress.com') || document.querySelector('link[href*="wp.com"]'))
Version:    Same as WordPress
Config:     { ...wordpressConfig, hosted: true }
Constraints:
  canFix: [theme selection, image optimization, content structure, limited plugin selection]
  cannotFix: [plugin restrictions (Business plan only), no server access, caching config, CDN config]
Perf hints:
  - Same as WordPress but: severity=info "WordPress.com hosted — some optimizations require Business plan"
```

### 30. Ghost
```
Detect:     document.querySelector('meta[name="generator"][content*="Ghost"]') || document.querySelector('link[href*="ghost"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/Ghost ([\d.]+)/)?.[1]
Config:     {
              theme: document.querySelector('link[rel="stylesheet"][href*="assets/"]')?.href?.match(/themes\/([^/]+)/)?.[1],
              memberships: !!document.querySelector('[data-portal]')
            }
Constraints:
  canFix: [theme code, image optimization, custom integrations]
  cannotFix: [Ghost core runtime, Ember admin, member portal widget]
Perf hints:
  - Casper theme: severity=info "Default Casper theme — check for unused features"
  - Member portal: severity=info "Ghost member portal script loaded — ~80KB"
```

### 31. HubSpot CMS
```
Detect:     document.querySelector('script[src*="hs-scripts.com"]') || !!window._hsq || document.querySelector('meta[name="generator"][content*="HubSpot"]')
Version:    null
Config:     {
              trackingPortalId: document.querySelector('script[src*="hs-scripts"]')?.src?.match(/\/(\d+)\.js/)?.[1],
              forms: document.querySelectorAll('[class*="hs-form"]').length,
              ctaWidgets: document.querySelectorAll('[class*="hs-cta"]').length
            }

Platform Metrics:
  - hubspotScriptsKB: total size of HubSpot scripts
  - trackingScriptCount: count of hs-* scripts

Constraints:
  canFix: [module selection, template code, image optimization, custom code]
  cannotFix: [HubSpot tracking scripts (~500KB), analytics overhead, form widget runtime, CDN config]

Perf hints:
  - Tracking scripts > 300KB: severity=warning "HubSpot tracking + analytics scripts total {size}KB"
  - Many CTA widgets (>3): severity=info "Each CTA widget adds script overhead"
  - Forms with validation: severity=info "HubSpot form runtime adds ~100KB per form"
```

### 32-36: Kentico, Sitecore, Adobe Experience Manager (AEM), Contentstack, Bloomreach
```
(Enterprise CMS platforms — detected via admin markers, client libraries, specific headers)
(Key concerns: client library duplication, personalization JS, admin/editor artifacts in production)
```

---

## CMS — Headless (8)

### 37. Contentful
```
Detect:     Performance API entries showing requests to cdn.contentful.com or graphql.contentful.com
Version:    null
Config:     { deliveryApi: true, graphql: !!performance.getEntriesByType('resource').find(r => r.name.includes('graphql.contentful.com')) }
Constraints:
  canFix: [frontend code — full control, query optimization, image CDN config, caching headers]
  cannotFix: [Contentful API latency, rate limits]
Perf hints:
  - Large API responses: severity=warning "Check Contentful query for over-fetching (include depth, linked entries)"
  - No image CDN transforms: severity=warning "Use Contentful Image API for responsive images (f=webp, w=, q=)"
```

### 38-44: Sanity, Strapi, Prismic, DatoCMS, Storyblok, Hygraph (GraphCMS), Directus
```
(Headless CMS — frontend is developer-controlled)
(Key concern: API query optimization, image pipeline config, preview mode overhead)
Each with CDN/API URL pattern detection.

Storyblok specific:
  - Visual editor bridge: severity=warning "Storyblok bridge.js (~50KB) detected — ensure it's only loaded in preview mode"
```

---

## Marketing / Landing Pages (7)

### 45. Unbounce
```
Detect:     document.querySelector('script[src*="unbounce"]') || document.querySelector('[class*="lp-pom-"]')
Version:    null
Constraints:
  canFix: [content, images, form complexity]
  cannotFix: [builder runtime, form widget, A/B testing overhead]
Perf hints:
  - Builder runtime: severity=info "Unbounce builder runtime adds overhead"
```

### 46-51: Leadpages, Instapage, ClickFunnels, Kajabi, Teachable, Thinkific
```
(Marketing/course platforms — detected via platform-specific scripts and class patterns)
(Limited optimization — mostly content/image focused)
(ClickFunnels: funnel chain loading, tracking overhead)
(Kajabi/Teachable: video player + platform runtime)
```

---

## Hosting Platforms (4) — affect infrastructure layer

### 52. Vercel
```
Detect:     response headers include 'x-vercel-id' or 'x-vercel-cache' || document.querySelector('script[src*="/_vercel/"]')
Version:    null
Config:     {
              edge: !!responseHeaders?.['x-vercel-id']?.includes('::'),
              cache: responseHeaders?.['x-vercel-cache'],  // HIT, MISS, STALE
              region: responseHeaders?.['x-vercel-id']?.split('::')?.[0],
              analytics: !!document.querySelector('script[src*="/_vercel/insights"]'),
              speedInsights: !!document.querySelector('script[src*="/_vercel/speed-insights"]')
            }

Platform Metrics:
  - edgeCacheStatus: HIT/MISS/STALE from x-vercel-cache header
  - region: deployment region from x-vercel-id
  - isrStatus: from x-nextjs-cache header (if Next.js)

Constraints:
  canFix: [application code, caching config (vercel.json), image optimization, edge function logic]
  cannotFix: [edge function cold start (~50ms), Vercel CDN routing, bandwidth pricing]

Perf hints:
  - Cache MISS: severity=info "Vercel edge cache MISS — page rendered on demand"
  - Analytics script loaded: severity=info "Vercel Analytics adds ~5KB"
  - Speed Insights loaded: severity=info "Vercel Speed Insights adds ~10KB"
  - Edge function cold start: severity=info "Edge functions have ~50ms cold start — use Edge Config for static data"
```

### 53. Netlify
```
Detect:     response headers include 'x-nf-request-id' || document.querySelector('script[src*=".netlify"]')
Version:    null
Config:     {
              cache: responseHeaders?.['x-nf-request-id'] ? true : false,
              cdn: responseHeaders?.['server']?.includes('Netlify')
            }
Constraints:
  canFix: [application code, netlify.toml config, image CDN, caching headers, redirect rules]
  cannotFix: [function cold starts, CDN routing, edge handler latency]
Perf hints:
  - Redirect chains: severity=warning "Check _redirects / netlify.toml for unnecessary redirect chains"
```

### 54. Cloudflare Pages
```
Detect:     !!responseHeaders?.['cf-ray'] && !!responseHeaders?.['cf-cache-status']
Version:    null
Config:     {
              cacheStatus: responseHeaders?.['cf-cache-status'],  // HIT, MISS, DYNAMIC, BYPASS
              ray: responseHeaders?.['cf-ray'],
              workers: !!responseHeaders?.['cf-workers-subrequest']
            }
Constraints:
  canFix: [application code, _headers config, caching rules, Workers logic]
  cannotFix: [CDN edge network, Cloudflare core overhead (minimal)]
Perf hints:
  - Cache BYPASS/DYNAMIC: severity=info "Cloudflare cache bypassed — configure cache rules for static content"
```

### 55. Firebase Hosting
```
Detect:     document.querySelector('script[src*="firebase"]') || responseHeaders?.['x-firebase-hosting-version']
Version:    null
Config:     {}
Constraints:
  canFix: [firebase.json config, application code]
  cannotFix: [Firebase CDN, hosting cold starts]
```

---

## Detection Execution Strategy

Similar to frameworks, all SaaS detections run in a batched `page.evaluate()` call. Additionally:

1. **Response headers** are checked via `performance.getEntriesByType('navigation')[0]` for the document request
2. **App enumeration** (Shopify, WordPress) correlates script URLs against network buffer entries for sizing
3. **Platform metrics** (Liquid render time, RequireJS module count) require platform-specific extraction logic
4. **Constraint classification** is static per platform — defined in the signature, not detected at runtime

```typescript
// Example: Shopify app enumeration
const shopifyApps = networkEntries
  .filter(e => e.url.includes('.js') && !e.url.includes('cdn.shopify.com') && !e.url.includes(Shopify.cdnHost))
  .map(e => ({
    name: extractAppName(e.url),  // from known domain patterns
    scriptUrls: [e.url],
    totalSizeKB: Math.round((e.size || 0) / 1024),
    usedOnPage: checkAppActiveOnPage(e.url),  // check for DOM elements the app creates
    loadTiming: getScriptLoadTiming(e.url)    // check script tag attributes
  }));
```
