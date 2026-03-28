# Framework Detection Reference — Performance Audit System

> Referenced from: plans/perf-audit-system.md (TASK-006)
> Total: 108 frameworks across 12 categories

## Detection Philosophy

Each framework detection follows these rules:
1. **Verify, don't just check** — e.g., React hook must have renderers attached, not just exist
2. **Extract depth** — version, config, build mode, not just boolean presence
3. **Graceful fallback** — every `detect` expression must handle missing globals without throwing
4. **Performance disease identification** — each framework has known perf anti-patterns to flag

## Detection Return Shape

```typescript
interface DetectedFramework {
  name: string;                    // e.g., "React"
  version: string | null;         // e.g., "18.2.0"
  category: FrameworkCategory;
  buildMode: 'production' | 'development' | null;
  config: Record<string, any>;    // Framework-specific config/state
  perfHints: PerfHint[];          // Known performance diseases detected
}

interface PerfHint {
  severity: 'critical' | 'warning' | 'info';
  message: string;                // Human-readable description
  metric: string;                 // Which metric this affects (LCP, CLS, TBT, etc.)
  evidence: string;               // What we found that triggered this hint
}
```

## Categories

| Category | Count | Description |
|----------|-------|-------------|
| js-framework | 22 | Client-side JS frameworks |
| meta-framework | 14 | Full-stack/SSR frameworks built on top of JS frameworks |
| php-framework | 15 | Server-rendered PHP frameworks and CMS |
| python-framework | 6 | Python web frameworks |
| ruby-framework | 4 | Ruby web frameworks |
| java-dotnet | 7 | Java, Kotlin, and .NET frameworks |
| css-framework | 10 | CSS libraries and CSS-in-JS solutions |
| ssg | 9 | Static site generators |
| mobile-hybrid | 4 | Mobile-first and hybrid web frameworks |
| emerging | 6 | Newer/experimental frameworks |
| state-management | 8 | State management libraries (detected alongside frameworks) |
| build-tools | 6 | Build tool detection from output patterns |

---

## JS Frameworks (22)

### 1. React
```
Detect:     __REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size > 0
Version:    __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values().next().value?.version
Build mode: Look for __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values().next().value?.bundleType
            0 = production, 1 = development
Config:     {
              concurrent: !!document.querySelector('[data-reactroot]')?.['_reactRootContainer']?._internalRoot?.current?.mode,
              strictMode: <check for double-render pattern>,
              roots: __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.size
            }
Perf hints:
  - Development build in production (bundleType=1): severity=critical, metric=TBT
  - Multiple React roots (>1): severity=warning, metric=TBT "Multiple React roots increase bundle + hydration cost"
  - Missing React.memo on list items: detect via fiber tree if available
```

### 2. Vue
```
Detect:     window.__VUE__ || window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.Vue
Version:    Vue 3: __VUE__[0]?.version || document.querySelector('[data-v-app]') && 'Vue 3'
            Vue 2: Vue?.version
Build mode: Vue.config?.devtools (true = dev), Vue.config?.productionTip !== undefined (dev)
Config:     { version: 2|3, devtools: boolean, componentCount: <count app components> }
Perf hints:
  - Vue 2 in use: severity=info, metric=TBT "Vue 2 has larger runtime than Vue 3"
  - Devtools enabled in production: severity=warning, metric=TBT
```

### 3. Angular
```
Detect:     document.querySelector('[ng-version]') || window.ng?.probe || window.getAllAngularRootElements
Version:    document.querySelector('[ng-version]')?.getAttribute('ng-version')
Build mode: window.ng?.probe exists = dev mode (Ivy dev tools)
Config:     {
              ivy: !document.querySelector('[_nghost-]') === false,  // Ivy uses _nghost-
              zonejs: !!window.Zone,
              components: document.querySelectorAll('[_ngcontent-]').length
            }
Perf hints:
  - Zone.js detected: severity=warning, metric=TBT "Zone.js patches all async APIs, adds overhead to every event"
  - Dev mode (ng.probe available): severity=critical, metric=TBT "Angular dev mode runs change detection twice"
  - Large component count (>100): severity=warning, metric=TBT
```

### 4. Svelte
```
Detect:     document.querySelector('[class*="svelte-"]') || window.__svelte
Version:    window.__svelte?.v || 'detected'
Config:     { componentCount: document.querySelectorAll('[class*="svelte-"]').length }
Perf hints: (Minimal — Svelte compiles away the framework)
  - Large number of components (>50): severity=info "Consider lazy-loading below-fold sections"
```

### 5. Solid.js
```
Detect:     window._$HY || document.querySelector('[data-hk]')
Version:    'detected' (no version global)
Config:     { hydrated: !!window._$HY, islands: document.querySelectorAll('[data-hk]').length }
Perf hints: (Minimal — fine-grained reactivity)
```

### 6. Qwik
```
Detect:     document.querySelector('[q\\:container]') || document.querySelector('script[src*="qwikloader"]')
Version:    document.querySelector('[q\\:version]')?.getAttribute('q:version')
Config:     {
              resumable: !!document.querySelector('[q\\:container]'),
              lazyBoundaries: document.querySelectorAll('[on\\:qvisible]').length
            }
Perf hints:
  - Too many lazy boundaries (>20): severity=warning, metric=INP "Excessive lazy boundaries can cause interaction delay"
```

### 7. Preact
```
Detect:     window.__PREACT_DEVTOOLS__ || document.querySelector('[__k]')
Version:    window.__PREACT_DEVTOOLS__?.version || 'detected'
Config:     {}
Perf hints: (Minimal — Preact is lightweight by design)
```

### 8. Lit / Web Components
```
Detect:     customElements.get('lit-element') || document.querySelector('[part]') ||
            [...document.querySelectorAll('*')].some(el => el.shadowRoot)
Version:    'detected'
Config:     {
              shadowRoots: [...document.querySelectorAll('*')].filter(el => el.shadowRoot).length,
              customElements: Object.keys(customElements).length || 'unknown'
            }
Perf hints:
  - Many Shadow DOM roots (>10): severity=warning, metric=LCP "Shadow DOM style duplication increases CSS parsing"
```

### 9. Alpine.js
```
Detect:     !!document.querySelector('[x-data]')
Version:    window.Alpine?.version
Config:     {
              components: document.querySelectorAll('[x-data]').length,
              initCount: document.querySelectorAll('[x-init]').length
            }
Perf hints:
  - Many x-init (>10): severity=warning, metric=TBT "Each x-init evaluates JS on load"
```

### 10. HTMX
```
Detect:     !!document.querySelector('[hx-get],[hx-post],[hx-trigger]') || !!window.htmx
Version:    window.htmx?.version
Config:     {
              elements: document.querySelectorAll('[hx-get],[hx-post],[hx-put],[hx-delete]').length,
              boostEnabled: !!document.querySelector('[hx-boost="true"]')
            }
Perf hints:
  - Many HTMX elements (>20): severity=info, metric=TTFB "Each interaction is a server round-trip"
  - No hx-indicator found: severity=info, metric=CLS "Without loading indicators, users may click repeatedly"
```

### 11. Stimulus (Hotwire)
```
Detect:     !!document.querySelector('[data-controller]')
Version:    window.Stimulus?.version || 'detected'
Config:     {
              controllers: [...new Set([...document.querySelectorAll('[data-controller]')].map(el => el.dataset.controller))].length
            }
Perf hints: (Minimal overhead)
```

### 12. Turbo (Hotwire)
```
Detect:     !!document.querySelector('turbo-frame') || !!window.Turbo
Version:    window.Turbo?.session?.version || 'detected'
Config:     {
              frames: document.querySelectorAll('turbo-frame').length,
              streams: document.querySelectorAll('turbo-stream').length,
              driveEnabled: window.Turbo?.session?.drive !== false
            }
Perf hints:
  - Many turbo-frames (>5): severity=warning, metric=TTFB "Each frame triggers a separate HTTP request"
```

### 13. Ember
```
Detect:     !!window.Ember || !!document.querySelector('.ember-view')
Version:    window.Ember?.VERSION
Config:     { debugMode: !!window.Ember?.Debug }
Perf hints:
  - Ember runtime: severity=info, metric=TBT "Ember has a large runtime (~400KB min)"
```

### 14. Backbone.js
```
Detect:     !!window.Backbone
Version:    window.Backbone?.VERSION
Config:     {}
Perf hints:
  - Legacy framework: severity=info "Backbone is no longer maintained, consider migration"
```

### 15. jQuery
```
Detect:     !!window.jQuery || !!window.$?.fn?.jquery
Version:    window.jQuery?.fn?.jquery || window.$?.fn?.jquery
Config:     {
              migrate: !!window.jQuery?.migrateVersion,
              migrateVersion: window.jQuery?.migrateVersion,
              plugins: Object.keys(window.jQuery?.fn || {}).filter(k => !['jquery','constructor','init','toArray','get','pushStack','each','map','slice','first','last','even','odd','eq','end','push','sort','splice'].includes(k)).length
            }
Perf hints:
  - jQuery Migrate loaded: severity=warning, metric=TBT "jQuery Migrate adds ~20KB for backward compat"
  - Many plugins (>5): severity=warning, metric=TBT "Each jQuery plugin adds weight"
  - jQuery loaded with modern framework: severity=warning "Redundant — framework handles DOM manipulation"
```

### 16. Mithril
```
Detect:     !!window.m?.version
Version:    window.m?.version
Config:     {}
Perf hints: (Minimal)
```

### 17. Inferno
```
Detect:     !!window.__INFERNO_DEVTOOLS__
Version:    window.__INFERNO_DEVTOOLS__?.version || 'detected'
Config:     {}
Perf hints: (Minimal — Inferno is performance-focused)
```

### 18. Marko
```
Detect:     !!window.$marko || document.querySelector('script[src*="marko"]')
Version:    'detected'
Config:     {}
Perf hints:
  - Check for streaming: severity=info "Marko supports streaming SSR — verify it's enabled"
```

### 19. Meteor
```
Detect:     !!window.__meteor_runtime_config__
Version:    window.__meteor_runtime_config__?.meteorRelease?.split('@')[1]
Config:     {
              ddpUrl: window.__meteor_runtime_config__?.DDP_DEFAULT_CONNECTION_URL,
              rootUrl: window.__meteor_runtime_config__?.ROOT_URL
            }
Perf hints:
  - DDP WebSocket: severity=warning, metric=TBT "Meteor's DDP protocol adds persistent connection overhead"
  - Full bundle shipped: severity=warning, metric=LCP "Meteor ships the full app bundle — no code splitting by default"
```

### 20. Ionic
```
Detect:     !!document.querySelector('ion-app') || !!window.Ionic
Version:    window.Ionic?.version
Config:     { capacitor: !!window.Capacitor, mode: document.documentElement.getAttribute('mode') }
Perf hints:
  - Heavy web components: severity=warning, metric=TBT "Ionic web components add significant runtime"
```

### 21. Riot.js
```
Detect:     !!window.riot
Version:    window.riot?.version
Config:     {}
Perf hints: (Minimal)
```

### 22. Aurelia
```
Detect:     !!document.querySelector('[aurelia-app]') || !!document.querySelector('[au-target-id]')
Version:    window.au?.container?.getAll?.[0]?.version || 'detected'
Config:     {}
Perf hints:
  - Module loading waterfall: severity=warning, metric=LCP "Aurelia's module system can create loading waterfalls"
```

---

## Meta-Frameworks (14)

### 23. Next.js
```
Detect:     !!window.__NEXT_DATA__ || !!document.querySelector('script[src*="/_next/"]')
Version:    window.__NEXT_DATA__?.buildId ? (document.querySelector('script[src*="/_next/static/chunks/webpack"]')?.src?.match(/(\d+\.\d+\.\d+)/)?.[1] || 'detected') : null
Config:     {
              router: window.__next_f ? 'app' : 'pages',
              buildId: window.__NEXT_DATA__?.buildId,
              payloadSizeKB: Math.round(JSON.stringify(window.__NEXT_DATA__ || '').length / 1024),
              rsc: !!window.__next_f,
              ssr: !!window.__NEXT_DATA__?.props,
              isr: document.querySelector('meta[http-equiv="x-nextjs-cache"]')?.content || null,
              devMode: !!window.__NEXT_DATA__?.err || !!document.querySelector('#__next-build-watcher')
            }
Perf hints:
  - __NEXT_DATA__ payload > 50KB: severity=critical, metric=TTFB "__NEXT_DATA__ is {payloadSizeKB}KB — serialized in HTML, blocks TTFB and hydration"
  - __NEXT_DATA__ payload > 20KB: severity=warning, metric=TTFB
  - Dev mode in production: severity=critical, metric=TBT "Next.js dev mode detected — rebuild for production"
  - Pages Router with large getServerSideProps: severity=warning, metric=TTFB "Consider ISR/SSG for static content"
  - App Router without Suspense boundaries: severity=info, metric=LCP "Add Suspense for streaming SSR"
```

### 24. Nuxt
```
Detect:     !!window.__NUXT__ || document.querySelector('script[src*="/_nuxt/"]')
Version:    window.__NUXT__?.config?.public?.nuxtVersion || (window.__NUXT__?.serverRendered !== undefined ? '2.x' : '3.x')
Config:     {
              payloadSizeKB: Math.round(JSON.stringify(window.__NUXT__ || '').length / 1024),
              ssr: !!window.__NUXT__?.serverRendered,
              devMode: !!window.__NUXT__?.config?.app?.buildId?.includes('dev'),
              pluginCount: window.__NUXT__?.config?.public ? Object.keys(window.__NUXT__.config.public).length : 0
            }
Perf hints:
  - __NUXT__ payload > 50KB: severity=critical, metric=TTFB
  - Many plugins: severity=warning, metric=TBT "Nuxt plugins run on every navigation"
```

### 25. SvelteKit
```
Detect:     !!window.__sveltekit_* || document.querySelector('script[src*="/_app/"]')
Version:    'detected'
Config:     { ssr: !!document.querySelector('[data-sveltekit-hydrate]') }
Perf hints:
  - Data loading waterfall: severity=info, metric=LCP "Check for sequential load() calls"
```

### 26. Remix
```
Detect:     !!window.__remixContext || !!window.__remixManifest
Version:    'detected'
Config:     {
              routes: Object.keys(window.__remixManifest?.routes || {}).length,
              deferred: !!window.__remixContext?.state?.loaderData
            }
Perf hints:
  - Many routes loaded: severity=warning, metric=TBT "Route module preloading can block"
  - Deferred data stalls: severity=info, metric=LCP "Check for slow deferred loaders"
```

### 27. Astro
```
Detect:     !!document.querySelector('astro-island') || !!document.querySelector('[data-astro-cid]')
Version:    document.querySelector('meta[name="generator"][content*="Astro"]')?.content?.match(/Astro v?([\d.]+)/)?.[1]
Config:     {
              islands: document.querySelectorAll('astro-island').length,
              clientDirectives: {
                load: document.querySelectorAll('astro-island[client="load"]').length,
                idle: document.querySelectorAll('astro-island[client="idle"]').length,
                visible: document.querySelectorAll('astro-island[client="visible"]').length,
                media: document.querySelectorAll('astro-island[client="media"]').length,
                only: document.querySelectorAll('astro-island[client="only"]').length
              }
            }
Perf hints:
  - Many client:load islands (>3): severity=warning, metric=TBT "client:load hydrates immediately — use client:visible for below-fold"
  - No client:visible usage: severity=info, metric=TBT "Consider lazy hydration for non-critical islands"
```

### 28. Gatsby
```
Detect:     !!window.___gatsby || !!window.__GATSBY || document.querySelector('#___gatsby')
Version:    'detected'
Config:     {
              dataInPage: !!document.querySelector('#___gatsby script[type="application/json"]'),
              dataSizeKB: Math.round((document.querySelector('#___gatsby script[type="application/json"]')?.textContent?.length || 0) / 1024)
            }
Perf hints:
  - Inline GraphQL data > 50KB: severity=warning, metric=TTFB "Large inline data delays HTML parsing"
```

### 29. Docusaurus
```
Detect:     !!document.querySelector('[class*="docusaurus"]') || !!window.docusaurus
Version:    document.querySelector('meta[name="generator"][content*="Docusaurus"]')?.content?.match(/[\d.]+/)?.[0]
Config:     {}
Perf hints:
  - Search index download: severity=info, metric=LCP "Docusaurus downloads search index on first search"
```

### 30. VitePress
```
Detect:     !!document.querySelector('[class*="vp-"]') || document.querySelector('script[type="module"][src*="/@vitepress/"]')
Version:    'detected'
Config:     {}
Perf hints: (Minimal — VitePress is well-optimized)
```

### 31. Gridsome
```
Detect:     !!window.__GRIDSOME__ || document.querySelector('script[src*="/assets/js/app."]')
Version:    'detected'
Config:     {}
Perf hints:
  - GraphQL data layer: severity=info, metric=TTFB "Check for over-fetching in page queries"
```

### 32. Fresh (Deno)
```
Detect:     document.querySelector('script[src*="/_frsh/"]')
Version:    'detected'
Config:     { islands: document.querySelectorAll('[data-fresh-key]').length }
Perf hints: (Minimal — Fresh uses island architecture like Astro)
```

### 33. Eleventy (11ty)
```
Detect:     document.querySelector('meta[name="generator"][content*="Eleventy"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/[\d.]+/)?.[0]
Config:     {}
Perf hints: (Usually fast — static output)
```

### 34. Hugo
```
Detect:     document.querySelector('meta[name="generator"][content*="Hugo"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/[\d.]+/)?.[0]
Config:     {}
Perf hints:
  - Missing image pipeline: severity=info, metric=LCP "Hugo doesn't optimize images by default — check for unoptimized images"
```

### 35. Jekyll
```
Detect:     document.querySelector('meta[name="generator"][content*="Jekyll"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/[\d.]+/)?.[0]
Config:     {}
Perf hints:
  - No image pipeline: severity=info, metric=LCP "Jekyll doesn't optimize images — consider external optimization"
```

### 36. Hexo
```
Detect:     document.querySelector('meta[name="generator"][content*="Hexo"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/[\d.]+/)?.[0]
Config:     {}
Perf hints: (Minimal)
```

---

## PHP Frameworks (15)

### 37. Laravel
```
Detect:     !!document.querySelector('meta[name="csrf-token"]') && (document.cookie.includes('laravel_session') || document.cookie.includes('XSRF-TOKEN'))
Version:    null (server-side, not exposed to client)
Config:     {
              livewire: !!document.querySelector('[wire\\:id]'),
              livewireComponents: document.querySelectorAll('[wire\\:id]').length,
              livewireInitCalls: document.querySelectorAll('[wire\\:init]').length,
              inertia: !!document.querySelector('[data-page]'),
              inertiaPayloadKB: Math.round((document.querySelector('[data-page]')?.getAttribute('data-page')?.length || 0) / 1024),
              vite: !!document.querySelector('script[type="module"][src*="@vite"]'),
              mix: !!document.querySelector('script[src*="/js/app.js"]') && !document.querySelector('script[type="module"][src*="@vite"]'),
              debugBar: !!document.querySelector('.phpdebugbar') || !!window.phpdebugbar
            }
Perf hints:
  - Debug Bar in production: severity=critical, metric=TBT+security "Laravel Debug Bar exposes query data + adds ~280KB"
  - Livewire wire:init (>3): severity=warning, metric=TBT "Each wire:init fires an AJAX round-trip on page load"
  - Livewire components (>10): severity=warning, metric=TTFB "Many Livewire components increase server processing time"
  - Inertia payload > 50KB: severity=warning, metric=TTFB "Large Inertia data-page attribute bloats HTML"
  - Laravel Mix (legacy): severity=info, metric=LCP "Mix uses Webpack 4 — Vite offers faster builds and ES module output"
```

### 38. Symfony
```
Detect:     !!document.querySelector('.sf-toolbar') || document.querySelector('script[src*="_wdt"]') || document.cookie.includes('PHPSESSID')
Version:    document.querySelector('.sf-toolbar-info-piece')?.textContent?.match(/Symfony ([\d.]+)/)?.[1]
Config:     {
              debugToolbar: !!document.querySelector('.sf-toolbar'),
              twig: true  // assumed if Symfony detected
            }
Perf hints:
  - Debug toolbar in production: severity=critical, metric=TBT+security
```

### 39. WordPress
```
Detect:     !!window.wp || !!document.querySelector('meta[name="generator"][content*="WordPress"]') || !!document.querySelector('link[rel="https://api.w.org/"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/WordPress ([\d.]+)/)?.[1]
Config:     {
              theme: document.querySelector('link[rel="stylesheet"][href*="/wp-content/themes/"]')?.href?.match(/themes\/([^/]+)/)?.[1],
              plugins: [...new Set([...document.querySelectorAll('script[src*="/wp-content/plugins/"],link[href*="/wp-content/plugins/"]')].map(el => (el.src || el.href).match(/plugins\/([^/]+)/)?.[1]).filter(Boolean))],
              pluginCount: 0,  // calculated from above
              gutenberg: !!document.querySelector('.wp-block-'),
              elementor: !!document.querySelector('[data-elementor-type]'),
              woocommerce: !!window.wc_add_to_cart_params || !!document.querySelector('.woocommerce'),
              jquery: !!window.jQuery,
              jqueryMigrate: !!window.jQuery?.migrateVersion,
              restApi: !!document.querySelector('link[rel="https://api.w.org/"]'),
              blockLibraryCSS: document.querySelectorAll('link[href*="wp-includes/css/dist/block-library"]').length
            }
Perf hints:
  - Plugin count > 10: severity=warning, metric=TBT "Each plugin may add JS/CSS — audit for unused plugins"
  - jQuery + jQuery Migrate: severity=warning, metric=TBT "jQuery Migrate is compatibility overhead"
  - Block library CSS loaded (>1): severity=warning, metric=LCP "Block library CSS loaded on pages without blocks"
  - Elementor detected: severity=warning, metric=LCP "Elementor adds ~500KB+ CSS/JS"
  - WooCommerce cart fragments: severity=warning, metric=TTFB "Cart fragments AJAX fires on every page load"
  - Plugin loaded on wrong page: severity=warning "Contact Form 7 / Slider Revolution JS loaded on pages without forms/sliders"
```

### 40. Drupal
```
Detect:     !!window.Drupal || !!document.querySelector('[data-drupal-selector]') || !!window.drupalSettings
Version:    window.drupalSettings?.version
Config:     {
              aggregation: !!document.querySelector('link[href*="/files/css/"]'),
              modules: Object.keys(window.drupalSettings || {}).length
            }
Perf hints:
  - CSS/JS aggregation disabled: severity=warning, metric=LCP "Enable aggregation in admin > performance"
  - Many modules: severity=warning, metric=TBT
```

### 41. Joomla
```
Detect:     !!window.Joomla || document.querySelector('meta[name="generator"][content*="Joomla"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/Joomla[!]? ([\d.]+)/)?.[1]
Config:     {}
Perf hints:
  - MooTools loaded: severity=warning, metric=TBT "Legacy MooTools library adds weight"
```

### 42. Magento / Adobe Commerce
```
Detect:     !!window.require?.s?.contexts?._ || document.cookie.includes('form_key') || !!document.querySelector('script[src*="requirejs"]')
Version:    document.querySelector('meta[name="generator"]')?.content?.match(/Magento ([\d.]+)/)?.[1] || 'detected'
Config:     {
              requirejsModules: Object.keys(window.require?.s?.contexts?._?.defined || {}).length,
              knockoutBindings: document.querySelectorAll('[data-bind]').length,
              customerSections: null,  // detected via network XHR to /customer/section/load
              fpc: null,  // detected via X-Magento-Cache-Control header
              theme: document.querySelector('link[rel="stylesheet"][href*="/static/"]')?.href?.match(/static\/([^/]+\/[^/]+)/)?.[1],
              bundlingEnabled: !!document.querySelector('script[src*="bundles/"]')
            }
Perf hints:
  - RequireJS modules > 30: severity=critical, metric=LCP "RequireJS waterfall: {count} modules loaded sequentially — enable JS bundling"
  - RequireJS modules > 15: severity=warning, metric=LCP
  - Knockout bindings > 20: severity=warning, metric=TBT "Knockout.js observable subscriptions add overhead"
  - JS bundling disabled: severity=critical, metric=LCP "Enable Stores > Configuration > Advanced > Developer > JS Bundling"
  - Customer section AJAX: severity=warning, metric=TTFB "customer/section/load fires on every page for logged-in users"
```

### 43-51: CodeIgniter, CakePHP, Yii, TYPO3, Craft CMS, Statamic, October CMS, Phalcon, Slim
```
(Each detected via specific cookie names, meta tags, or script patterns)
(Server-rendered PHP — primary perf focus is TTFB and asset delivery)
```

---

## Python Frameworks (6)

### 52. Django
```
Detect:     !!document.querySelector('input[name="csrfmiddlewaretoken"]') || document.querySelector('script[src*="__debug__"]')
Version:    null (server-side)
Config:     {
              debugToolbar: !!document.querySelector('#djDebug') || !!document.querySelector('script[src*="__debug__"]'),
              adminLoaded: !!document.querySelector('link[href*="/admin/css/"]')
            }
Perf hints:
  - Debug toolbar in production: severity=critical, metric=TBT+security
  - Admin CSS/JS loaded on public pages: severity=warning, metric=LCP
```

### 53. Flask
```
Detect:     document.cookie.includes('session=') && !document.cookie.includes('laravel_session')
            (weak signal — needs corroborating evidence like Werkzeug headers)
Version:    null
Config:     {}
Perf hints: (Minimal frontend impact)
```

### 54. Streamlit
```
Detect:     !!document.querySelector('[class*="stApp"]') || document.querySelector('script[src*="streamlit"]')
Version:    'detected'
Config:     {}
Perf hints:
  - WebSocket heavy: severity=warning, metric=TBT "Streamlit re-runs entire script on every interaction"
```

### 55. Dash (Plotly)
```
Detect:     !!document.querySelector('#_dash-app-content') || !!window.dash_clientside
Version:    'detected'
Config:     { plotly: !!window.Plotly }
Perf hints:
  - Plotly.js loaded: severity=warning, metric=LCP "Plotly.js is ~3MB+ — consider lazy loading charts"
  - Callback round-trips: severity=info, metric=INP "Each interaction triggers server callback"
```

### 56. Wagtail
```
Detect:     Django signals + document.querySelector('[class*="wagtail"]') or wagtail admin patterns
Version:    null
Config:     {}
Perf hints:
  - Image rendition generation: severity=info, metric=TTFB "First load of new image sizes triggers server-side resize"
```

### 57. FastAPI
```
Detect:     document.querySelector('link[rel="stylesheet"][href*="swagger-ui"]') || window.location.pathname === '/docs'
Version:    null
Config:     {}
Perf hints: (API-only — N/A for frontend unless serving SPA)
```

---

## Ruby Frameworks (4)

### 58. Ruby on Rails
```
Detect:     !!document.querySelector('meta[name="csrf-token"]') && !!document.querySelector('meta[name="csrf-param"][content="authenticity_token"]')
Version:    null
Config:     {
              turbo: !!window.Turbo,
              stimulus: !!document.querySelector('[data-controller]'),
              hotwire: !!window.Turbo || !!document.querySelector('[data-controller]'),
              assetPipeline: !!document.querySelector('link[href*="/assets/"]'),
              webpacker: !!document.querySelector('script[src*="/packs/"]'),
              importmaps: !!document.querySelector('script[type="importmap"]')
            }
Perf hints:
  - Webpacker (legacy): severity=info "Consider migrating to importmaps or jsbundling-rails"
  - Both jQuery and Turbo loaded: severity=warning, metric=TBT "Redundant DOM manipulation libraries"
```

### 59. Sinatra
```
Detect:     (weak — server header or specific patterns)
Version:    null
Config:     {}
Perf hints: (Minimal)
```

### 60. Hanami
```
Detect:     (weak — specific patterns)
Version:    null
Config:     {}
Perf hints: (Minimal)
```

### 61. Phoenix LiveView
```
Detect:     !!document.querySelector('[data-phx-main]') || !!document.querySelector('[phx-click]')
Version:    window.liveSocket?.version
Config:     {
              components: document.querySelectorAll('[data-phx-component]').length,
              liveSocket: !!window.liveSocket
            }
Perf hints:
  - WebSocket-dependent: severity=info, metric=INP "Every interaction is a WebSocket round-trip"
  - Many LiveView components (>10): severity=warning "Server-side rendering cost increases with component count"
```

---

## Java / .NET (7)

### 62. Spring Boot
```
Detect:     document.cookie.includes('JSESSIONID') || !!document.querySelector('script[src*="/webjars/"]')
Version:    null
Config:     { webjars: !!document.querySelector('script[src*="/webjars/"]'), thymeleaf: !!document.querySelector('[th\\:text]') }
Perf hints:
  - WebJars: severity=info, metric=LCP "WebJars may be outdated — check versions"
```

### 63. Vaadin
```
Detect:     !!document.querySelector('.v-app') || !!document.querySelector('script[src*="VAADIN"]')
Version:    document.querySelector('meta[name="vaadin-version"]')?.content
Config:     {}
Perf hints:
  - Full server round-trip model: severity=warning, metric=INP "Every UI interaction requires server round-trip"
  - Heavy JS runtime: severity=warning, metric=LCP "Vaadin client runtime is ~800KB+"
```

### 64. JSF (JavaServer Faces)
```
Detect:     !!document.querySelector('input[name="javax.faces.ViewState"]') || !!document.querySelector('[id*="javax.faces"]')
Version:    null
Config:     { viewStateSize: document.querySelector('input[name="javax.faces.ViewState"]')?.value?.length }
Perf hints:
  - Large ViewState: severity=critical, metric=TTFB "ViewState is serialized in HTML — can be megabytes"
  - Full postback model: severity=warning, metric=INP
```

### 65. ASP.NET
```
Detect:     !!document.querySelector('input[name="__VIEWSTATE"]') || !!document.querySelector('input[name="__RequestVerificationToken"]')
Version:    null
Config:     {
              viewStateSizeKB: Math.round((document.querySelector('input[name="__VIEWSTATE"]')?.value?.length || 0) / 1024),
              webForms: !!document.querySelector('input[name="__VIEWSTATE"]'),
              mvc: !!document.querySelector('input[name="__RequestVerificationToken"]') && !document.querySelector('input[name="__VIEWSTATE"]')
            }
Perf hints:
  - ViewState > 50KB: severity=critical, metric=TTFB+LCP "ASP.NET ViewState is {size}KB — serialized in HTML"
  - ViewState > 10KB: severity=warning, metric=TTFB
```

### 66. Blazor
```
Detect:     !!document.querySelector('script[src*="blazor.webassembly"]') || !!document.querySelector('script[src*="blazor.server"]')
Version:    null
Config:     {
              mode: document.querySelector('script[src*="blazor.webassembly"]') ? 'webassembly' : 'server',
              wasmSize: null  // detected from network
            }
Perf hints:
  - Blazor WebAssembly: severity=warning, metric=LCP "WASM runtime is 2MB+ download on first visit"
  - Blazor Server: severity=info, metric=INP "SignalR WebSocket required for all interactions"
```

### 67. Razor Pages
```
Detect:     ASP.NET signals without WebForms ViewState
Version:    null
Config:     {}
Perf hints: (Minimal — similar to MVC)
```

### 68. Thymeleaf
```
Detect:     Spring Boot + document.querySelector('[th\\:text]') patterns
Version:    null
Config:     {}
Perf hints: (Server-rendered — focus on TTFB)
```

---

## CSS Frameworks (10)

### 69. Tailwind CSS
```
Detect:     [...document.querySelectorAll('[class]')].some(el => /\b(flex|pt-\d|bg-\w+-\d{3}|text-\w+-\d{3})\b/.test(el.className))
Version:    null (detected from utility class patterns)
Config:     {
              purged: null,  // estimate from CSS file sizes
              jit: null      // can't detect from output
            }
Perf hints:
  - Unpurged CSS (>100KB): severity=critical, metric=LCP "Tailwind without purge/content config ships ~3MB CSS"
```

### 70. Bootstrap
```
Detect:     !!document.querySelector('link[href*="bootstrap"]') || !!document.querySelector('.btn.btn-primary')
Version:    document.querySelector('link[href*="bootstrap"]')?.href?.match(/bootstrap[@/]([\d.]+)/)?.[1]
Config:     { js: !!document.querySelector('script[src*="bootstrap"]') }
Perf hints:
  - Full CSS loaded: severity=warning, metric=LCP "Bootstrap CSS is ~200KB — consider loading only used components"
```

### 71-78: Material UI, Chakra UI, Ant Design, Bulma, Foundation, Styled Components, Emotion, CSS Modules
```
(Each detected via class name patterns, data attributes, or global objects)
(CSS-in-JS frameworks: key concern is runtime style injection overhead)
```

---

## Mobile / Hybrid (4)

### 79. React Native Web
```
Detect:     document.querySelector('[data-testid][class*="r-"]') && !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__
Version:    null
Config:     {}
Perf hints:
  - Abstraction overhead: severity=info, metric=TBT "React Native Web adds a style abstraction layer"
```

### 80. Flutter Web
```
Detect:     !!document.querySelector('script[src*="flutter"]') || !!document.querySelector('flt-glass-pane')
Version:    null
Config:     {
              renderer: document.querySelector('flt-glass-pane') ? 'canvaskit' : 'html',
              canvaskitWasm: !!document.querySelector('script[src*="canvaskit"]')
            }
Perf hints:
  - CanvasKit WASM: severity=warning, metric=LCP "CanvasKit WASM is ~2MB download — consider HTML renderer for faster initial load"
  - No SEO: severity=warning "Flutter Web renders to canvas — not indexable by search engines"
```

### 81. Capacitor
```
Detect:     !!window.Capacitor
Version:    window.Capacitor?.Plugins?.Device?.getInfo?.()?.then?.(i => i.appVersion) || 'detected'
Config:     { plugins: Object.keys(window.Capacitor?.Plugins || {}).length }
Perf hints: (Minimal on web)
```

### 82. Cordova
```
Detect:     !!window.cordova
Version:    window.cordova?.version
Config:     {}
Perf hints:
  - Legacy: severity=info "Cordova is legacy — consider Capacitor migration"
```

---

## Emerging Frameworks (6)

### 83. Leptos (Rust WASM)
```
Detect:     document.querySelector('script[src*="leptos"]') || document.querySelector('link[rel="modulepreload"][href*="leptos"]')
Version:    null
Config:     {}
Perf hints:
  - WASM download: severity=info, metric=LCP "WASM binary download may delay initial render"
```

### 84-88: Yew, Dioxus, Percy, Seed, Sycamore (Rust/WASM frameworks)
```
(Each detected via WASM loader patterns and framework-specific markers)
(Primary concern: WASM download size)
```

---

## State Management (8) — detected alongside frameworks

### 89. Redux
```
Detect:     !!window.__REDUX_DEVTOOLS_EXTENSION__ || !!window.__REDUX_STATE__
Config:     { storeSizeKB: Math.round(JSON.stringify(window.__REDUX_STATE__ || window.__PRELOADED_STATE__ || {}).length / 1024) }
Perf hints:
  - Store > 100KB serialized: severity=warning, metric=TTFB "Redux store is {size}KB — serialized in HTML for hydration"
  - Store > 500KB: severity=critical, metric=TTFB+TBT
```

### 90. MobX
```
Detect:     !!window.__mobxGlobals || !!window.__mobxInstanceCount
Config:     {}
```

### 91. Zustand
```
Detect:     (detected via React DevTools fiber inspection — Zustand stores as hooks)
Config:     {}
```

### 92-96: Jotai, Recoil, XState, Pinia (Vue), Vuex (Vue)
```
(Each detected via specific globals or devtools hooks)
(Key concern: serialized store size affecting hydration)
```

---

## Build Tools (6) — detected from output patterns

### 97. Webpack
```
Detect:     !!window.webpackChunk || !!window.webpackJsonp || document.querySelector('script[src*="bundle"]')?.src?.match(/\.[a-f0-9]{8,}\.js/)
Version:    window.__webpack_modules__ ? 5 : (window.webpackJsonp ? 4 : null)
Config:     {
              chunks: document.querySelectorAll('script[src*="chunk"]').length,
              sourceMapsExposed: !!performance.getEntriesByType('resource').find(r => r.name.endsWith('.map')),
              moduleCount: Object.keys(window.__webpack_modules__ || {}).length
            }
Perf hints:
  - Source maps exposed: severity=warning, metric=security "Source maps publicly accessible — exposes source code"
  - Single large bundle (>500KB): severity=warning, metric=LCP "No code splitting detected"
```

### 98. Vite
```
Detect:     document.querySelector('script[type="module"][src*="/@vite/"]') || document.querySelector('script[type="module"][src*="/src/"]')
Version:    null
Config:     { devMode: !!document.querySelector('script[type="module"][src*="/@vite/"]') }
Perf hints:
  - Dev mode HMR client detected: severity=critical, metric=TBT "Vite dev server detected in production"
```

### 99. Parcel
```
Detect:     document.querySelector('script[src*=".parcel-cache"]') || document.querySelector('script[src*="parcel"]')
Version:    null
Config:     {}
```

### 100. esbuild
```
Detect:     (difficult to detect — look for specific output patterns)
Version:    null
Config:     {}
```

### 101. Turbopack
```
Detect:     document.querySelector('script[src*="/_next/static/chunks/turbopack"]')
Version:    null
Config:     {}
Perf hints:
  - Turbopack: severity=info "Using Turbopack bundler (experimental in Next.js)"
```

### 102. Rollup
```
Detect:     (difficult to detect from output alone)
Version:    null
Config:     {}
```

---

## Detection Execution Strategy

All detections run in a single `page.evaluate()` call to minimize round-trips:

```typescript
const results = await page.evaluate(() => {
  const detected = [];

  // React
  try {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook?.renderers?.size > 0) {
      const renderer = hook.renderers.values().next().value;
      detected.push({
        name: 'React',
        version: renderer?.version || null,
        category: 'js-framework',
        buildMode: renderer?.bundleType === 0 ? 'production' : 'development',
        config: { concurrent: /* ... */, roots: hook.renderers.size },
        perfHints: []
      });
    }
  } catch {}

  // ... repeat for each framework

  return detected;
});
```

Each framework detection is wrapped in try/catch to prevent one failure from blocking others. The entire detection runs in <100ms on typical pages.
