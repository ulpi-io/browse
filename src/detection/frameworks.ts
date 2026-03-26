import type { Page } from 'playwright';

export type FrameworkCategory =
  | 'js-framework'
  | 'meta-framework'
  | 'php-framework'
  | 'python-framework'
  | 'ruby-framework'
  | 'java-dotnet'
  | 'css-framework'
  | 'ssg'
  | 'mobile-hybrid'
  | 'emerging'
  | 'state-management'
  | 'build-tool';

export interface PerfHint {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  metric: string;
  evidence: string;
}

export interface DetectedFramework {
  name: string;
  version: string | null;
  category: FrameworkCategory;
  buildMode: 'production' | 'development' | null;
  config: Record<string, unknown>;
  perfHints: PerfHint[];
}

/**
 * Detect web frameworks, libraries, and build tools on the current page.
 *
 * All detections run inside a single page.evaluate() call for performance.
 * Each framework detection is wrapped in its own try/catch so a failure
 * in one detection cannot block others.
 *
 * Returns an array of DetectedFramework objects for every framework found.
 */
export async function detectFrameworks(page: Page): Promise<DetectedFramework[]> {
  return page.evaluate(() => {
    const detected: DetectedFramework[] = [];
    const w = window as any;
    const doc = document;

    // Helper: safely query a selector and return the element or null
    const qs = (sel: string): Element | null => {
      try { return doc.querySelector(sel); } catch { return null; }
    };
    // Helper: safely queryAll and return array
    const qsa = (sel: string): Element[] => {
      try { return [...doc.querySelectorAll(sel)]; } catch { return []; }
    };

    // =========================================================================
    // JS FRAMEWORKS (22)
    // =========================================================================

    // 1. React
    try {
      const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook?.renderers?.size > 0) {
        const renderer = hook.renderers.values().next().value;
        const hints: PerfHint[] = [];
        const bundleType = renderer?.bundleType;
        if (bundleType === 1) {
          hints.push({
            severity: 'critical',
            message: 'React development build detected in production',
            metric: 'TBT',
            evidence: 'bundleType=1',
          });
        }
        const rootCount = hook.renderers.size;
        if (rootCount > 1) {
          hints.push({
            severity: 'warning',
            message: 'Multiple React roots increase bundle + hydration cost',
            metric: 'TBT',
            evidence: `${rootCount} renderer roots`,
          });
        }
        detected.push({
          name: 'React',
          version: renderer?.version || null,
          category: 'js-framework',
          buildMode: bundleType === 0 ? 'production' : (bundleType === 1 ? 'development' : null),
          config: { roots: rootCount },
          perfHints: hints,
        });
      }
    } catch {}

    // 2. Vue
    try {
      const vue3 = w.__VUE__;
      const vue2 = w.Vue;
      const vueDevtools = w.__VUE_DEVTOOLS_GLOBAL_HOOK__;
      if (vue3 || vue2 || vueDevtools?.Vue) {
        const hints: PerfHint[] = [];
        let version: string | null = null;
        let isVue2 = false;
        if (vue3 && Array.isArray(vue3) && vue3[0]?.version) {
          version = vue3[0].version;
        } else if (qs('[data-v-app]')) {
          version = 'Vue 3';
        } else if (vue2?.version) {
          version = vue2.version;
          isVue2 = true;
        }
        if (isVue2) {
          hints.push({
            severity: 'info',
            message: 'Vue 2 has larger runtime than Vue 3',
            metric: 'TBT',
            evidence: `version=${version}`,
          });
        }
        const devtools = vue2?.config?.devtools || vue2?.config?.productionTip !== undefined;
        if (devtools && !isVue2) {
          hints.push({
            severity: 'warning',
            message: 'Vue devtools enabled in production',
            metric: 'TBT',
            evidence: 'Vue.config.devtools=true',
          });
        }
        detected.push({
          name: 'Vue',
          version,
          category: 'js-framework',
          buildMode: devtools ? 'development' : null,
          config: {
            version: isVue2 ? 2 : 3,
            devtools: !!devtools,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 3. Angular
    try {
      const ngVersion = qs('[ng-version]');
      if (ngVersion || w.ng?.probe || w.getAllAngularRootElements) {
        const hints: PerfHint[] = [];
        const version = ngVersion?.getAttribute('ng-version') || null;
        const devMode = !!w.ng?.probe;
        if (devMode) {
          hints.push({
            severity: 'critical',
            message: 'Angular dev mode runs change detection twice',
            metric: 'TBT',
            evidence: 'ng.probe available',
          });
        }
        if (w.Zone) {
          hints.push({
            severity: 'warning',
            message: 'Zone.js patches all async APIs, adds overhead to every event',
            metric: 'TBT',
            evidence: 'window.Zone detected',
          });
        }
        const componentCount = qsa('[_ngcontent-]').length;
        if (componentCount > 100) {
          hints.push({
            severity: 'warning',
            message: `Large Angular component count: ${componentCount}`,
            metric: 'TBT',
            evidence: `${componentCount} [_ngcontent-] elements`,
          });
        }
        detected.push({
          name: 'Angular',
          version,
          category: 'js-framework',
          buildMode: devMode ? 'development' : 'production',
          config: {
            ivy: qsa('[_nghost-]').length > 0,
            zonejs: !!w.Zone,
            components: componentCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 4. Svelte
    try {
      const svelteElements = qsa('[class*="svelte-"]');
      if (svelteElements.length > 0 || w.__svelte) {
        const hints: PerfHint[] = [];
        const componentCount = svelteElements.length;
        if (componentCount > 50) {
          hints.push({
            severity: 'info',
            message: 'Consider lazy-loading below-fold sections',
            metric: 'LCP',
            evidence: `${componentCount} svelte components`,
          });
        }
        detected.push({
          name: 'Svelte',
          version: w.__svelte?.v || null,
          category: 'js-framework',
          buildMode: null,
          config: { componentCount },
          perfHints: hints,
        });
      }
    } catch {}

    // 5. Solid.js
    try {
      if (w._$HY || qs('[data-hk]')) {
        detected.push({
          name: 'Solid.js',
          version: null,
          category: 'js-framework',
          buildMode: null,
          config: {
            hydrated: !!w._$HY,
            islands: qsa('[data-hk]').length,
          },
          perfHints: [],
        });
      }
    } catch {}

    // 6. Qwik
    try {
      const qContainer = qs('[q\\:container]');
      const qwikLoader = qs('script[src*="qwikloader"]');
      if (qContainer || qwikLoader) {
        const hints: PerfHint[] = [];
        const lazyBoundaries = qsa('[on\\:qvisible]').length;
        if (lazyBoundaries > 20) {
          hints.push({
            severity: 'warning',
            message: 'Excessive lazy boundaries can cause interaction delay',
            metric: 'INP',
            evidence: `${lazyBoundaries} on:qvisible elements`,
          });
        }
        detected.push({
          name: 'Qwik',
          version: qs('[q\\:version]')?.getAttribute('q:version') || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            resumable: !!qContainer,
            lazyBoundaries,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 7. Preact
    try {
      if (w.__PREACT_DEVTOOLS__ || qs('[__k]')) {
        detected.push({
          name: 'Preact',
          version: w.__PREACT_DEVTOOLS__?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 8. Lit / Web Components
    try {
      const shadowRoots = qsa('*').filter(el => el.shadowRoot);
      const hasPart = !!qs('[part]');
      if (shadowRoots.length > 0 || hasPart) {
        const hints: PerfHint[] = [];
        if (shadowRoots.length > 10) {
          hints.push({
            severity: 'warning',
            message: 'Shadow DOM style duplication increases CSS parsing',
            metric: 'LCP',
            evidence: `${shadowRoots.length} shadow roots`,
          });
        }
        detected.push({
          name: 'Lit / Web Components',
          version: null,
          category: 'js-framework',
          buildMode: null,
          config: {
            shadowRoots: shadowRoots.length,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 9. Alpine.js
    try {
      const alpineComponents = qsa('[x-data]');
      if (alpineComponents.length > 0) {
        const hints: PerfHint[] = [];
        const initCount = qsa('[x-init]').length;
        if (initCount > 10) {
          hints.push({
            severity: 'warning',
            message: 'Each x-init evaluates JS on load',
            metric: 'TBT',
            evidence: `${initCount} x-init attributes`,
          });
        }
        detected.push({
          name: 'Alpine.js',
          version: w.Alpine?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            components: alpineComponents.length,
            initCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 10. HTMX
    try {
      const htmxEls = qsa('[hx-get],[hx-post],[hx-trigger]');
      if (htmxEls.length > 0 || w.htmx) {
        const hints: PerfHint[] = [];
        const count = qsa('[hx-get],[hx-post],[hx-put],[hx-delete]').length;
        if (count > 20) {
          hints.push({
            severity: 'info',
            message: 'Each interaction is a server round-trip',
            metric: 'TTFB',
            evidence: `${count} HTMX elements`,
          });
        }
        if (!qs('[hx-indicator]')) {
          hints.push({
            severity: 'info',
            message: 'Without loading indicators, users may click repeatedly',
            metric: 'CLS',
            evidence: 'No hx-indicator found',
          });
        }
        detected.push({
          name: 'HTMX',
          version: w.htmx?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            elements: count,
            boostEnabled: !!qs('[hx-boost="true"]'),
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 11. Stimulus (Hotwire)
    try {
      const controllers = qsa('[data-controller]');
      if (controllers.length > 0) {
        const uniqueControllers = [...new Set(controllers.map(el => (el as HTMLElement).dataset.controller))];
        detected.push({
          name: 'Stimulus',
          version: w.Stimulus?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            controllers: uniqueControllers.length,
          },
          perfHints: [],
        });
      }
    } catch {}

    // 12. Turbo (Hotwire)
    try {
      if (qs('turbo-frame') || w.Turbo) {
        const hints: PerfHint[] = [];
        const frameCount = qsa('turbo-frame').length;
        if (frameCount > 5) {
          hints.push({
            severity: 'warning',
            message: 'Each frame triggers a separate HTTP request',
            metric: 'TTFB',
            evidence: `${frameCount} turbo-frames`,
          });
        }
        detected.push({
          name: 'Turbo',
          version: w.Turbo?.session?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            frames: frameCount,
            streams: qsa('turbo-stream').length,
            driveEnabled: w.Turbo?.session?.drive !== false,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 13. Ember
    try {
      if (w.Ember || qs('.ember-view')) {
        const hints: PerfHint[] = [];
        hints.push({
          severity: 'info',
          message: 'Ember has a large runtime (~400KB min)',
          metric: 'TBT',
          evidence: 'Ember framework detected',
        });
        detected.push({
          name: 'Ember',
          version: w.Ember?.VERSION || null,
          category: 'js-framework',
          buildMode: w.Ember?.Debug ? 'development' : null,
          config: { debugMode: !!w.Ember?.Debug },
          perfHints: hints,
        });
      }
    } catch {}

    // 14. Backbone.js
    try {
      if (w.Backbone) {
        detected.push({
          name: 'Backbone.js',
          version: w.Backbone?.VERSION || null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Backbone is no longer maintained, consider migration',
            metric: 'TBT',
            evidence: 'Backbone.js detected',
          }],
        });
      }
    } catch {}

    // 15. jQuery
    try {
      const jq = w.jQuery || w.$;
      if (jq?.fn?.jquery) {
        const hints: PerfHint[] = [];
        const hasMigrate = !!jq.migrateVersion;
        if (hasMigrate) {
          hints.push({
            severity: 'warning',
            message: 'jQuery Migrate adds ~20KB for backward compat',
            metric: 'TBT',
            evidence: `migrateVersion=${jq.migrateVersion}`,
          });
        }
        const builtinKeys = ['jquery', 'constructor', 'init', 'toArray', 'get', 'pushStack',
          'each', 'map', 'slice', 'first', 'last', 'even', 'odd', 'eq', 'end',
          'push', 'sort', 'splice'];
        const pluginCount = Object.keys(jq.fn || {}).filter(
          (k: string) => !builtinKeys.includes(k)
        ).length;
        if (pluginCount > 5) {
          hints.push({
            severity: 'warning',
            message: 'Each jQuery plugin adds weight',
            metric: 'TBT',
            evidence: `${pluginCount} jQuery plugins loaded`,
          });
        }
        // Check if jQuery loaded with modern framework
        const hasModernFw = detected.some(d =>
          ['React', 'Vue', 'Angular', 'Svelte', 'Solid.js'].includes(d.name)
        );
        if (hasModernFw) {
          hints.push({
            severity: 'warning',
            message: 'Redundant -- framework handles DOM manipulation',
            metric: 'TBT',
            evidence: 'jQuery loaded alongside modern framework',
          });
        }
        detected.push({
          name: 'jQuery',
          version: jq.fn.jquery,
          category: 'js-framework',
          buildMode: null,
          config: {
            migrate: hasMigrate,
            migrateVersion: jq.migrateVersion || null,
            plugins: pluginCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 16. Mithril
    try {
      if (w.m?.version) {
        detected.push({
          name: 'Mithril',
          version: w.m.version,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 17. Inferno
    try {
      if (w.__INFERNO_DEVTOOLS__) {
        detected.push({
          name: 'Inferno',
          version: w.__INFERNO_DEVTOOLS__?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 18. Marko
    try {
      if (w.$marko || qs('script[src*="marko"]')) {
        detected.push({
          name: 'Marko',
          version: null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Marko supports streaming SSR -- verify it is enabled',
            metric: 'TTFB',
            evidence: 'Marko detected',
          }],
        });
      }
    } catch {}

    // 19. Meteor
    try {
      if (w.__meteor_runtime_config__) {
        const cfg = w.__meteor_runtime_config__;
        const hints: PerfHint[] = [];
        hints.push({
          severity: 'warning',
          message: "Meteor's DDP protocol adds persistent connection overhead",
          metric: 'TBT',
          evidence: 'DDP WebSocket connection',
        });
        hints.push({
          severity: 'warning',
          message: 'Meteor ships the full app bundle -- no code splitting by default',
          metric: 'LCP',
          evidence: 'Full bundle shipped',
        });
        detected.push({
          name: 'Meteor',
          version: cfg.meteorRelease?.split('@')[1] || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            ddpUrl: cfg.DDP_DEFAULT_CONNECTION_URL || null,
            rootUrl: cfg.ROOT_URL || null,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 20. Ionic
    try {
      if (qs('ion-app') || w.Ionic) {
        detected.push({
          name: 'Ionic',
          version: w.Ionic?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {
            capacitor: !!w.Capacitor,
            mode: doc.documentElement.getAttribute('mode'),
          },
          perfHints: [{
            severity: 'warning',
            message: 'Ionic web components add significant runtime',
            metric: 'TBT',
            evidence: 'Ionic framework detected',
          }],
        });
      }
    } catch {}

    // 21. Riot.js
    try {
      if (w.riot) {
        detected.push({
          name: 'Riot.js',
          version: w.riot?.version || null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 22. Aurelia
    try {
      if (qs('[aurelia-app]') || qs('[au-target-id]')) {
        detected.push({
          name: 'Aurelia',
          version: null,
          category: 'js-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'warning',
            message: "Aurelia's module system can create loading waterfalls",
            metric: 'LCP',
            evidence: 'Aurelia framework detected',
          }],
        });
      }
    } catch {}

    // =========================================================================
    // META-FRAMEWORKS (14)
    // =========================================================================

    // 23. Next.js
    try {
      if (w.__NEXT_DATA__ || qs('script[src*="/_next/"]')) {
        const hints: PerfHint[] = [];
        const payloadSizeKB = Math.round(JSON.stringify(w.__NEXT_DATA__ || '').length / 1024);
        const devMode = !!w.__NEXT_DATA__?.err || !!qs('#__next-build-watcher');
        if (payloadSizeKB > 50) {
          hints.push({
            severity: 'critical',
            message: `__NEXT_DATA__ is ${payloadSizeKB}KB -- serialized in HTML, blocks TTFB and hydration`,
            metric: 'TTFB',
            evidence: `${payloadSizeKB}KB payload`,
          });
        } else if (payloadSizeKB > 20) {
          hints.push({
            severity: 'warning',
            message: `__NEXT_DATA__ is ${payloadSizeKB}KB -- consider reducing page props`,
            metric: 'TTFB',
            evidence: `${payloadSizeKB}KB payload`,
          });
        }
        if (devMode) {
          hints.push({
            severity: 'critical',
            message: 'Next.js dev mode detected -- rebuild for production',
            metric: 'TBT',
            evidence: devMode ? '__next-build-watcher or error in __NEXT_DATA__' : '',
          });
        }
        const router = w.__next_f ? 'app' : 'pages';
        if (router === 'pages' && payloadSizeKB > 20) {
          hints.push({
            severity: 'warning',
            message: 'Consider ISR/SSG for static content with Pages Router',
            metric: 'TTFB',
            evidence: `Pages Router with ${payloadSizeKB}KB getServerSideProps data`,
          });
        }
        if (router === 'app' && !qs('template[data-react-suspense-fallback]')) {
          hints.push({
            severity: 'info',
            message: 'Add Suspense boundaries for streaming SSR',
            metric: 'LCP',
            evidence: 'App Router without detected Suspense boundaries',
          });
        }
        const webpackScript = qs('script[src*="/_next/static/chunks/webpack"]') as HTMLScriptElement | null;
        detected.push({
          name: 'Next.js',
          version: webpackScript?.src?.match(/(\d+\.\d+\.\d+)/)?.[1] || null,
          category: 'meta-framework',
          buildMode: devMode ? 'development' : 'production',
          config: {
            router,
            buildId: w.__NEXT_DATA__?.buildId || null,
            payloadSizeKB,
            rsc: !!w.__next_f,
            ssr: !!w.__NEXT_DATA__?.props,
            isr: qs('meta[http-equiv="x-nextjs-cache"]')?.getAttribute('content') || null,
            devMode,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 24. Nuxt
    try {
      if (w.__NUXT__ || qs('script[src*="/_nuxt/"]')) {
        const hints: PerfHint[] = [];
        const payloadSizeKB = Math.round(JSON.stringify(w.__NUXT__ || '').length / 1024);
        if (payloadSizeKB > 50) {
          hints.push({
            severity: 'critical',
            message: `__NUXT__ payload is ${payloadSizeKB}KB -- blocks TTFB`,
            metric: 'TTFB',
            evidence: `${payloadSizeKB}KB payload`,
          });
        }
        const pluginCount = w.__NUXT__?.config?.public
          ? Object.keys(w.__NUXT__.config.public).length
          : 0;
        if (pluginCount > 10) {
          hints.push({
            severity: 'warning',
            message: 'Nuxt plugins run on every navigation',
            metric: 'TBT',
            evidence: `${pluginCount} public config keys`,
          });
        }
        detected.push({
          name: 'Nuxt',
          version: w.__NUXT__?.config?.public?.nuxtVersion ||
            (w.__NUXT__?.serverRendered !== undefined ? '2.x' : '3.x'),
          category: 'meta-framework',
          buildMode: w.__NUXT__?.config?.app?.buildId?.includes?.('dev') ? 'development' : null,
          config: {
            payloadSizeKB,
            ssr: !!w.__NUXT__?.serverRendered,
            pluginCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 25. SvelteKit
    try {
      // window.__sveltekit_* globals or /_app/ script patterns
      const hasSvelteKit = Object.keys(w).some(k => k.startsWith('__sveltekit')) ||
        !!qs('script[src*="/_app/"]');
      if (hasSvelteKit) {
        detected.push({
          name: 'SvelteKit',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: {
            ssr: !!qs('[data-sveltekit-hydrate]'),
          },
          perfHints: [{
            severity: 'info',
            message: 'Check for sequential load() calls creating data waterfalls',
            metric: 'LCP',
            evidence: 'SvelteKit detected',
          }],
        });
      }
    } catch {}

    // 26. Remix
    try {
      if (w.__remixContext || w.__remixManifest) {
        const hints: PerfHint[] = [];
        const routeCount = Object.keys(w.__remixManifest?.routes || {}).length;
        if (routeCount > 20) {
          hints.push({
            severity: 'warning',
            message: 'Route module preloading can block',
            metric: 'TBT',
            evidence: `${routeCount} routes loaded`,
          });
        }
        detected.push({
          name: 'Remix',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: {
            routes: routeCount,
            deferred: !!w.__remixContext?.state?.loaderData,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 27. Astro
    try {
      const astroIslands = qsa('astro-island');
      const astroCid = qs('[data-astro-cid]');
      if (astroIslands.length > 0 || astroCid) {
        const hints: PerfHint[] = [];
        const clientLoad = qsa('astro-island[client="load"]').length;
        const clientIdle = qsa('astro-island[client="idle"]').length;
        const clientVisible = qsa('astro-island[client="visible"]').length;
        const clientMedia = qsa('astro-island[client="media"]').length;
        const clientOnly = qsa('astro-island[client="only"]').length;
        if (clientLoad > 3) {
          hints.push({
            severity: 'warning',
            message: 'client:load hydrates immediately -- use client:visible for below-fold',
            metric: 'TBT',
            evidence: `${clientLoad} client:load islands`,
          });
        }
        if (clientVisible === 0 && astroIslands.length > 0) {
          hints.push({
            severity: 'info',
            message: 'Consider lazy hydration for non-critical islands',
            metric: 'TBT',
            evidence: 'No client:visible usage found',
          });
        }
        const generatorMeta = qs('meta[name="generator"][content*="Astro"]');
        detected.push({
          name: 'Astro',
          version: generatorMeta?.getAttribute('content')?.match(/Astro v?([\d.]+)/)?.[1] || null,
          category: 'meta-framework',
          buildMode: null,
          config: {
            islands: astroIslands.length,
            clientDirectives: {
              load: clientLoad,
              idle: clientIdle,
              visible: clientVisible,
              media: clientMedia,
              only: clientOnly,
            },
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 28. Gatsby
    try {
      if (w.___gatsby || w.__GATSBY || qs('#___gatsby')) {
        const hints: PerfHint[] = [];
        const dataScript = qs('#___gatsby script[type="application/json"]');
        const dataSizeKB = Math.round((dataScript?.textContent?.length || 0) / 1024);
        if (dataSizeKB > 50) {
          hints.push({
            severity: 'warning',
            message: 'Large inline data delays HTML parsing',
            metric: 'TTFB',
            evidence: `${dataSizeKB}KB inline GraphQL data`,
          });
        }
        detected.push({
          name: 'Gatsby',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: {
            dataInPage: !!dataScript,
            dataSizeKB,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 29. Docusaurus
    try {
      if (qs('[class*="docusaurus"]') || w.docusaurus) {
        const generatorMeta = qs('meta[name="generator"][content*="Docusaurus"]');
        detected.push({
          name: 'Docusaurus',
          version: generatorMeta?.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'meta-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Docusaurus downloads search index on first search',
            metric: 'LCP',
            evidence: 'Docusaurus detected',
          }],
        });
      }
    } catch {}

    // 30. VitePress
    try {
      if (qs('[class*="vp-"]') || qs('script[type="module"][src*="/@vitepress/"]')) {
        detected.push({
          name: 'VitePress',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 31. Gridsome
    try {
      if (w.__GRIDSOME__ || qs('script[src*="/assets/js/app."]')) {
        detected.push({
          name: 'Gridsome',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Check for over-fetching in page queries',
            metric: 'TTFB',
            evidence: 'Gridsome GraphQL data layer',
          }],
        });
      }
    } catch {}

    // 32. Fresh (Deno)
    try {
      if (qs('script[src*="/_frsh/"]')) {
        detected.push({
          name: 'Fresh',
          version: null,
          category: 'meta-framework',
          buildMode: null,
          config: { islands: qsa('[data-fresh-key]').length },
          perfHints: [],
        });
      }
    } catch {}

    // 33. Eleventy (11ty)
    try {
      const eleventyMeta = qs('meta[name="generator"][content*="Eleventy"]');
      if (eleventyMeta) {
        detected.push({
          name: 'Eleventy',
          version: eleventyMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 34. Hugo
    try {
      const hugoMeta = qs('meta[name="generator"][content*="Hugo"]');
      if (hugoMeta) {
        detected.push({
          name: 'Hugo',
          version: hugoMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: "Hugo doesn't optimize images by default -- check for unoptimized images",
            metric: 'LCP',
            evidence: 'Hugo SSG detected',
          }],
        });
      }
    } catch {}

    // 35. Jekyll
    try {
      const jekyllMeta = qs('meta[name="generator"][content*="Jekyll"]');
      if (jekyllMeta) {
        detected.push({
          name: 'Jekyll',
          version: jekyllMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: "Jekyll doesn't optimize images -- consider external optimization",
            metric: 'LCP',
            evidence: 'Jekyll SSG detected',
          }],
        });
      }
    } catch {}

    // 36. Hexo
    try {
      const hexoMeta = qs('meta[name="generator"][content*="Hexo"]');
      if (hexoMeta) {
        detected.push({
          name: 'Hexo',
          version: hexoMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // PHP FRAMEWORKS (15)
    // =========================================================================

    // 37. Laravel
    try {
      const hasCsrf = !!qs('meta[name="csrf-token"]');
      const hasLaravelCookie = doc.cookie.includes('laravel_session') || doc.cookie.includes('XSRF-TOKEN');
      if (hasCsrf && hasLaravelCookie) {
        const hints: PerfHint[] = [];
        const livewireComponents = qsa('[wire\\:id]').length;
        const livewireInitCalls = qsa('[wire\\:init]').length;
        const hasDebugBar = !!qs('.phpdebugbar') || !!w.phpdebugbar;
        const hasInertia = !!qs('[data-page]');
        const inertiaPayloadKB = Math.round(
          (qs('[data-page]')?.getAttribute('data-page')?.length || 0) / 1024
        );
        const hasVite = !!qs('script[type="module"][src*="@vite"]');
        const hasMix = !!qs('script[src*="/js/app.js"]') && !hasVite;

        if (hasDebugBar) {
          hints.push({
            severity: 'critical',
            message: 'Laravel Debug Bar exposes query data + adds ~280KB',
            metric: 'TBT+security',
            evidence: '.phpdebugbar element found',
          });
        }
        if (livewireInitCalls > 3) {
          hints.push({
            severity: 'warning',
            message: 'Each wire:init fires an AJAX round-trip on page load',
            metric: 'TBT',
            evidence: `${livewireInitCalls} wire:init elements`,
          });
        }
        if (livewireComponents > 10) {
          hints.push({
            severity: 'warning',
            message: 'Many Livewire components increase server processing time',
            metric: 'TTFB',
            evidence: `${livewireComponents} wire:id components`,
          });
        }
        if (hasInertia && inertiaPayloadKB > 50) {
          hints.push({
            severity: 'warning',
            message: 'Large Inertia data-page attribute bloats HTML',
            metric: 'TTFB',
            evidence: `${inertiaPayloadKB}KB Inertia payload`,
          });
        }
        if (hasMix) {
          hints.push({
            severity: 'info',
            message: 'Mix uses Webpack 4 -- Vite offers faster builds and ES module output',
            metric: 'LCP',
            evidence: 'Laravel Mix detected (no @vite script)',
          });
        }
        detected.push({
          name: 'Laravel',
          version: null,
          category: 'php-framework',
          buildMode: hasDebugBar ? 'development' : null,
          config: {
            livewire: livewireComponents > 0,
            livewireComponents,
            livewireInitCalls,
            inertia: hasInertia,
            inertiaPayloadKB,
            vite: hasVite,
            mix: hasMix,
            debugBar: hasDebugBar,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 38. Symfony
    try {
      const sfToolbar = !!qs('.sf-toolbar');
      const sfWdt = !!qs('script[src*="_wdt"]');
      if (sfToolbar || sfWdt) {
        const hints: PerfHint[] = [];
        if (sfToolbar) {
          hints.push({
            severity: 'critical',
            message: 'Symfony debug toolbar in production exposes internals',
            metric: 'TBT+security',
            evidence: '.sf-toolbar element found',
          });
        }
        const versionMatch = qs('.sf-toolbar-info-piece')?.textContent?.match(/Symfony ([\d.]+)/);
        detected.push({
          name: 'Symfony',
          version: versionMatch?.[1] || null,
          category: 'php-framework',
          buildMode: sfToolbar ? 'development' : null,
          config: {
            debugToolbar: sfToolbar,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 39. WordPress
    try {
      const wpDetected = w.wp || qs('meta[name="generator"][content*="WordPress"]') ||
        qs('link[rel="https://api.w.org/"]');
      if (wpDetected) {
        const hints: PerfHint[] = [];
        const generatorMeta = qs('meta[name="generator"]');
        const version = generatorMeta?.getAttribute('content')?.match(/WordPress ([\d.]+)/)?.[1] || null;

        // Extract plugins from script and link URLs
        const pluginEls = qsa('script[src*="/wp-content/plugins/"],link[href*="/wp-content/plugins/"]');
        const plugins = [...new Set(
          pluginEls.map(el => {
            const url = (el as HTMLScriptElement).src || (el as HTMLLinkElement).href;
            return url.match(/plugins\/([^/]+)/)?.[1];
          }).filter(Boolean)
        )] as string[];

        const hasGutenberg = !!qs('.wp-block-');
        const hasElementor = !!qs('[data-elementor-type]');
        const hasWoo = !!w.wc_add_to_cart_params || !!qs('.woocommerce');
        const hasJquery = !!w.jQuery;
        const hasJqMigrate = !!w.jQuery?.migrateVersion;
        const blockLibCss = qsa('link[href*="wp-includes/css/dist/block-library"]').length;

        // Extract theme from stylesheet URL
        const themeLink = qs('link[rel="stylesheet"][href*="/wp-content/themes/"]') as HTMLLinkElement | null;
        const theme = themeLink?.href?.match(/themes\/([^/]+)/)?.[1] || null;

        if (plugins.length > 10) {
          hints.push({
            severity: 'warning',
            message: 'Each plugin may add JS/CSS -- audit for unused plugins',
            metric: 'TBT',
            evidence: `${plugins.length} plugins detected`,
          });
        }
        if (hasJquery && hasJqMigrate) {
          hints.push({
            severity: 'warning',
            message: 'jQuery Migrate is compatibility overhead',
            metric: 'TBT',
            evidence: `jQuery Migrate ${w.jQuery.migrateVersion}`,
          });
        }
        if (blockLibCss > 1) {
          hints.push({
            severity: 'warning',
            message: 'Block library CSS loaded on pages without blocks',
            metric: 'LCP',
            evidence: `${blockLibCss} block-library CSS files`,
          });
        }
        if (hasElementor) {
          hints.push({
            severity: 'warning',
            message: 'Elementor adds ~500KB+ CSS/JS',
            metric: 'LCP',
            evidence: 'data-elementor-type attribute found',
          });
        }
        if (hasWoo) {
          hints.push({
            severity: 'warning',
            message: 'Cart fragments AJAX fires on every page load',
            metric: 'TTFB',
            evidence: 'WooCommerce detected',
          });
        }
        detected.push({
          name: 'WordPress',
          version,
          category: 'php-framework',
          buildMode: null,
          config: {
            theme,
            plugins,
            pluginCount: plugins.length,
            gutenberg: hasGutenberg,
            elementor: hasElementor,
            woocommerce: hasWoo,
            jquery: hasJquery,
            jqueryMigrate: hasJqMigrate,
            restApi: !!qs('link[rel="https://api.w.org/"]'),
            blockLibraryCSS: blockLibCss,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 40. Drupal
    try {
      if (w.Drupal || qs('[data-drupal-selector]') || w.drupalSettings) {
        const hints: PerfHint[] = [];
        const hasAggregation = !!qs('link[href*="/files/css/"]');
        const moduleCount = Object.keys(w.drupalSettings || {}).length;
        if (!hasAggregation) {
          hints.push({
            severity: 'warning',
            message: 'Enable aggregation in admin > performance',
            metric: 'LCP',
            evidence: 'No aggregated CSS files found',
          });
        }
        if (moduleCount > 20) {
          hints.push({
            severity: 'warning',
            message: `${moduleCount} Drupal modules detected`,
            metric: 'TBT',
            evidence: `${moduleCount} drupalSettings keys`,
          });
        }
        detected.push({
          name: 'Drupal',
          version: w.drupalSettings?.version || null,
          category: 'php-framework',
          buildMode: null,
          config: {
            aggregation: hasAggregation,
            modules: moduleCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 41. Joomla
    try {
      if (w.Joomla || qs('meta[name="generator"][content*="Joomla"]')) {
        const hints: PerfHint[] = [];
        // Check for MooTools
        if (w.MooTools) {
          hints.push({
            severity: 'warning',
            message: 'Legacy MooTools library adds weight',
            metric: 'TBT',
            evidence: 'MooTools detected',
          });
        }
        const generatorMeta = qs('meta[name="generator"]');
        detected.push({
          name: 'Joomla',
          version: generatorMeta?.getAttribute('content')?.match(/Joomla[!]? ([\d.]+)/)?.[1] || null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: hints,
        });
      }
    } catch {}

    // 42. Magento / Adobe Commerce
    try {
      const hasRequireJs = w.require?.s?.contexts?._;
      const hasFormKey = doc.cookie.includes('form_key');
      const hasRequireScript = !!qs('script[src*="requirejs"]');
      if (hasRequireJs || hasFormKey || hasRequireScript) {
        const hints: PerfHint[] = [];
        const requirejsModules = Object.keys(w.require?.s?.contexts?._?.defined || {}).length;
        const knockoutBindings = qsa('[data-bind]').length;
        const bundlingEnabled = !!qs('script[src*="bundles/"]');
        const themeLink = qs('link[rel="stylesheet"][href*="/static/"]') as HTMLLinkElement | null;

        if (requirejsModules > 30) {
          hints.push({
            severity: 'critical',
            message: `RequireJS waterfall: ${requirejsModules} modules loaded sequentially -- enable JS bundling`,
            metric: 'LCP',
            evidence: `${requirejsModules} defined modules`,
          });
        } else if (requirejsModules > 15) {
          hints.push({
            severity: 'warning',
            message: `${requirejsModules} RequireJS modules loaded`,
            metric: 'LCP',
            evidence: `${requirejsModules} defined modules`,
          });
        }
        if (knockoutBindings > 20) {
          hints.push({
            severity: 'warning',
            message: 'Knockout.js observable subscriptions add overhead',
            metric: 'TBT',
            evidence: `${knockoutBindings} data-bind attributes`,
          });
        }
        if (!bundlingEnabled && requirejsModules > 0) {
          hints.push({
            severity: 'critical',
            message: 'Enable Stores > Configuration > Advanced > Developer > JS Bundling',
            metric: 'LCP',
            evidence: 'No bundles/ scripts found',
          });
        }
        const generatorMeta = qs('meta[name="generator"]');
        detected.push({
          name: 'Magento',
          version: generatorMeta?.getAttribute('content')?.match(/Magento ([\d.]+)/)?.[1] || null,
          category: 'php-framework',
          buildMode: null,
          config: {
            requirejsModules,
            knockoutBindings,
            bundlingEnabled,
            theme: themeLink?.href?.match(/static\/([^/]+\/[^/]+)/)?.[1] || null,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 43. CodeIgniter
    try {
      if (doc.cookie.includes('ci_session') || qs('input[name="ci_csrf_token"]')) {
        detected.push({
          name: 'CodeIgniter',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 44. CakePHP
    try {
      if (doc.cookie.includes('cakephp') || qs('input[name="_csrfToken"]')) {
        detected.push({
          name: 'CakePHP',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 45. Yii
    try {
      if (qs('input[name="_csrf"]') && qs('input[name="_csrf"]')?.getAttribute('value')?.length === 88) {
        detected.push({
          name: 'Yii',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 46. TYPO3
    try {
      const typo3Meta = qs('meta[name="generator"][content*="TYPO3"]');
      if (typo3Meta || qs('script[src*="typo3"]')) {
        detected.push({
          name: 'TYPO3',
          version: typo3Meta?.getAttribute('content')?.match(/TYPO3.*?(\d[\d.]+)/)?.[1] || null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 47. Craft CMS
    try {
      if (qs('input[name="CRAFT_CSRF_TOKEN"]') || w.Craft) {
        detected.push({
          name: 'Craft CMS',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 48. Statamic
    try {
      if (qs('meta[name="generator"][content*="Statamic"]')) {
        detected.push({
          name: 'Statamic',
          version: qs('meta[name="generator"]')?.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 49. October CMS
    try {
      if (qs('script[src*="october"]') || qs('link[href*="october"]') || w.oc) {
        detected.push({
          name: 'October CMS',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 50. Phalcon
    try {
      // Phalcon leaves few client-side traces; check for its CSRF naming convention
      if (doc.cookie.includes('phalcon') || qs('input[name="phalcon_csrf"]')) {
        detected.push({
          name: 'Phalcon',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 51. Slim
    try {
      // Slim PHP is extremely minimal; check for Slim's default error handler pattern
      if (qs('.slim-error') || (doc.cookie.includes('slim_session'))) {
        detected.push({
          name: 'Slim',
          version: null,
          category: 'php-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // PYTHON FRAMEWORKS (6)
    // =========================================================================

    // 52. Django
    try {
      const hasCsrf = !!qs('input[name="csrfmiddlewaretoken"]');
      const hasDebugScript = !!qs('script[src*="__debug__"]');
      if (hasCsrf || hasDebugScript) {
        const hints: PerfHint[] = [];
        const hasDebugToolbar = !!qs('#djDebug') || hasDebugScript;
        if (hasDebugToolbar) {
          hints.push({
            severity: 'critical',
            message: 'Django Debug Toolbar in production exposes internals',
            metric: 'TBT+security',
            evidence: 'djDebug element or __debug__ script',
          });
        }
        const hasAdminCSS = !!qs('link[href*="/admin/css/"]');
        if (hasAdminCSS) {
          hints.push({
            severity: 'warning',
            message: 'Admin CSS/JS loaded on public pages',
            metric: 'LCP',
            evidence: '/admin/css/ stylesheet loaded',
          });
        }
        detected.push({
          name: 'Django',
          version: null,
          category: 'python-framework',
          buildMode: hasDebugToolbar ? 'development' : null,
          config: {
            debugToolbar: hasDebugToolbar,
            adminLoaded: hasAdminCSS,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 53. Flask
    try {
      // Flask uses signed session cookies; weak signal without corroboration
      const hasFlaskSession = doc.cookie.includes('session=') &&
        !doc.cookie.includes('laravel_session') &&
        !doc.cookie.includes('JSESSIONID') &&
        !doc.cookie.includes('ci_session');
      // Look for Werkzeug debugger as stronger signal
      const hasWerkzeug = !!qs('#traceback_content') || !!qs('.debugger');
      if (hasWerkzeug) {
        detected.push({
          name: 'Flask',
          version: null,
          category: 'python-framework',
          buildMode: hasWerkzeug ? 'development' : null,
          config: {},
          perfHints: hasWerkzeug ? [{
            severity: 'critical',
            message: 'Werkzeug debugger exposed in production',
            metric: 'security',
            evidence: 'Werkzeug traceback elements found',
          }] : [],
        });
      }
    } catch {}

    // 54. Streamlit
    try {
      if (qs('[class*="stApp"]') || qs('script[src*="streamlit"]')) {
        detected.push({
          name: 'Streamlit',
          version: null,
          category: 'python-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'warning',
            message: 'Streamlit re-runs entire script on every interaction',
            metric: 'TBT',
            evidence: 'WebSocket-heavy architecture',
          }],
        });
      }
    } catch {}

    // 55. Dash (Plotly)
    try {
      if (qs('#_dash-app-content') || w.dash_clientside) {
        const hints: PerfHint[] = [];
        if (w.Plotly) {
          hints.push({
            severity: 'warning',
            message: 'Plotly.js is ~3MB+ -- consider lazy loading charts',
            metric: 'LCP',
            evidence: 'window.Plotly global loaded',
          });
        }
        hints.push({
          severity: 'info',
          message: 'Each interaction triggers server callback',
          metric: 'INP',
          evidence: 'Dash callback round-trip architecture',
        });
        detected.push({
          name: 'Dash',
          version: null,
          category: 'python-framework',
          buildMode: null,
          config: { plotly: !!w.Plotly },
          perfHints: hints,
        });
      }
    } catch {}

    // 56. Wagtail
    try {
      // Wagtail is Django-based; detect via admin patterns or wagtail-specific classes
      if (qs('[class*="wagtail"]') || qs('link[href*="wagtail"]')) {
        detected.push({
          name: 'Wagtail',
          version: null,
          category: 'python-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'First load of new image sizes triggers server-side resize',
            metric: 'TTFB',
            evidence: 'Wagtail image rendition generation',
          }],
        });
      }
    } catch {}

    // 57. FastAPI
    try {
      if (qs('link[rel="stylesheet"][href*="swagger-ui"]') ||
          w.location.pathname === '/docs' ||
          qs('#swagger-ui')) {
        detected.push({
          name: 'FastAPI',
          version: null,
          category: 'python-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // RUBY FRAMEWORKS (4)
    // =========================================================================

    // 58. Ruby on Rails
    try {
      const hasCsrfToken = !!qs('meta[name="csrf-token"]');
      const hasAuthToken = !!qs('meta[name="csrf-param"][content="authenticity_token"]');
      if (hasCsrfToken && hasAuthToken) {
        const hints: PerfHint[] = [];
        const hasTurbo = !!w.Turbo;
        const hasStimulus = !!qs('[data-controller]');
        const hasWebpacker = !!qs('script[src*="/packs/"]');
        const hasImportmaps = !!qs('script[type="importmap"]');
        const hasJquery = !!w.jQuery;
        if (hasWebpacker) {
          hints.push({
            severity: 'info',
            message: 'Consider migrating to importmaps or jsbundling-rails',
            metric: 'LCP',
            evidence: 'Webpacker /packs/ scripts detected',
          });
        }
        if (hasJquery && hasTurbo) {
          hints.push({
            severity: 'warning',
            message: 'Redundant DOM manipulation libraries',
            metric: 'TBT',
            evidence: 'Both jQuery and Turbo loaded',
          });
        }
        detected.push({
          name: 'Ruby on Rails',
          version: null,
          category: 'ruby-framework',
          buildMode: null,
          config: {
            turbo: hasTurbo,
            stimulus: hasStimulus,
            hotwire: hasTurbo || hasStimulus,
            assetPipeline: !!qs('link[href*="/assets/"]'),
            webpacker: hasWebpacker,
            importmaps: hasImportmaps,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 59. Sinatra
    try {
      // Sinatra has very few client-side fingerprints; check for Sinatra error page
      if (qs('.sinatra-error') || doc.title?.includes('Sinatra')) {
        detected.push({
          name: 'Sinatra',
          version: null,
          category: 'ruby-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 60. Hanami
    try {
      if (qs('meta[name="hanami"]') || qs('script[src*="hanami"]')) {
        detected.push({
          name: 'Hanami',
          version: null,
          category: 'ruby-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 61. Phoenix LiveView
    try {
      if (qs('[data-phx-main]') || qs('[phx-click]')) {
        const hints: PerfHint[] = [];
        const componentCount = qsa('[data-phx-component]').length;
        hints.push({
          severity: 'info',
          message: 'Every interaction is a WebSocket round-trip',
          metric: 'INP',
          evidence: 'Phoenix LiveView detected',
        });
        if (componentCount > 10) {
          hints.push({
            severity: 'warning',
            message: 'Server-side rendering cost increases with component count',
            metric: 'TTFB',
            evidence: `${componentCount} LiveView components`,
          });
        }
        detected.push({
          name: 'Phoenix LiveView',
          version: w.liveSocket?.version || null,
          category: 'ruby-framework',
          buildMode: null,
          config: {
            components: componentCount,
            liveSocket: !!w.liveSocket,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // =========================================================================
    // JAVA / .NET (7)
    // =========================================================================

    // 62. Spring Boot
    try {
      if (doc.cookie.includes('JSESSIONID') || qs('script[src*="/webjars/"]')) {
        const hints: PerfHint[] = [];
        const hasWebjars = !!qs('script[src*="/webjars/"]');
        if (hasWebjars) {
          hints.push({
            severity: 'info',
            message: 'WebJars may be outdated -- check versions',
            metric: 'LCP',
            evidence: '/webjars/ script detected',
          });
        }
        detected.push({
          name: 'Spring Boot',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: {
            webjars: hasWebjars,
            thymeleaf: !!qs('[th\\:text]'),
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 63. Vaadin
    try {
      if (qs('.v-app') || qs('script[src*="VAADIN"]')) {
        detected.push({
          name: 'Vaadin',
          version: qs('meta[name="vaadin-version"]')?.getAttribute('content') || null,
          category: 'java-dotnet',
          buildMode: null,
          config: {},
          perfHints: [
            {
              severity: 'warning',
              message: 'Every UI interaction requires server round-trip',
              metric: 'INP',
              evidence: 'Vaadin server-driven model',
            },
            {
              severity: 'warning',
              message: 'Vaadin client runtime is ~800KB+',
              metric: 'LCP',
              evidence: 'Vaadin framework detected',
            },
          ],
        });
      }
    } catch {}

    // 64. JSF (JavaServer Faces)
    try {
      const viewState = qs('input[name="javax.faces.ViewState"]') as HTMLInputElement | null;
      if (viewState || qs('[id*="javax.faces"]')) {
        const hints: PerfHint[] = [];
        const viewStateSize = viewState?.value?.length || 0;
        if (viewStateSize > 10000) {
          hints.push({
            severity: 'critical',
            message: 'ViewState is serialized in HTML -- can be megabytes',
            metric: 'TTFB',
            evidence: `ViewState is ${Math.round(viewStateSize / 1024)}KB`,
          });
        }
        hints.push({
          severity: 'warning',
          message: 'JSF full postback model adds interaction overhead',
          metric: 'INP',
          evidence: 'JavaServer Faces detected',
        });
        detected.push({
          name: 'JSF',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: { viewStateSize },
          perfHints: hints,
        });
      }
    } catch {}

    // 65. ASP.NET
    try {
      const viewState = qs('input[name="__VIEWSTATE"]') as HTMLInputElement | null;
      const reqVerification = qs('input[name="__RequestVerificationToken"]');
      if (viewState || reqVerification) {
        const hints: PerfHint[] = [];
        const viewStateSizeKB = Math.round((viewState?.value?.length || 0) / 1024);
        const isWebForms = !!viewState;
        const isMvc = !!reqVerification && !viewState;
        if (viewStateSizeKB > 50) {
          hints.push({
            severity: 'critical',
            message: `ASP.NET ViewState is ${viewStateSizeKB}KB -- serialized in HTML`,
            metric: 'TTFB+LCP',
            evidence: `${viewStateSizeKB}KB ViewState`,
          });
        } else if (viewStateSizeKB > 10) {
          hints.push({
            severity: 'warning',
            message: `ASP.NET ViewState is ${viewStateSizeKB}KB`,
            metric: 'TTFB',
            evidence: `${viewStateSizeKB}KB ViewState`,
          });
        }
        detected.push({
          name: 'ASP.NET',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: {
            viewStateSizeKB,
            webForms: isWebForms,
            mvc: isMvc,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 66. Blazor
    try {
      const blazorWasm = qs('script[src*="blazor.webassembly"]');
      const blazorServer = qs('script[src*="blazor.server"]');
      if (blazorWasm || blazorServer) {
        const hints: PerfHint[] = [];
        const mode = blazorWasm ? 'webassembly' : 'server';
        if (mode === 'webassembly') {
          hints.push({
            severity: 'warning',
            message: 'WASM runtime is 2MB+ download on first visit',
            metric: 'LCP',
            evidence: 'blazor.webassembly.js loaded',
          });
        } else {
          hints.push({
            severity: 'info',
            message: 'SignalR WebSocket required for all interactions',
            metric: 'INP',
            evidence: 'blazor.server.js loaded',
          });
        }
        detected.push({
          name: 'Blazor',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: { mode },
          perfHints: hints,
        });
      }
    } catch {}

    // 67. Razor Pages
    try {
      // Razor Pages is ASP.NET MVC without ViewState; detected if we have ASP.NET antiforgery
      // but no ViewState and no Blazor — only add if not already detected as ASP.NET
      const hasAntiforgery = !!qs('input[name="__RequestVerificationToken"]');
      const noViewState = !qs('input[name="__VIEWSTATE"]');
      const noBlazor = !qs('script[src*="blazor"]');
      const aspNetAlreadyDetected = detected.some(d => d.name === 'ASP.NET');
      if (hasAntiforgery && noViewState && noBlazor && !aspNetAlreadyDetected) {
        detected.push({
          name: 'Razor Pages',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 68. Thymeleaf
    try {
      if (qs('[th\\:text]') || qs('[th\\:each]') || qs('[data-th-text]')) {
        detected.push({
          name: 'Thymeleaf',
          version: null,
          category: 'java-dotnet',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // CSS FRAMEWORKS (10)
    // =========================================================================

    // 69. Tailwind CSS
    try {
      const tailwindPattern = /\b(flex|pt-\d|bg-\w+-\d{3}|text-\w+-\d{3})\b/;
      const hasTailwind = qsa('[class]').some(el => tailwindPattern.test(el.className));
      if (hasTailwind) {
        const hints: PerfHint[] = [];
        // Check for large unpurged CSS by examining stylesheet sizes
        const stylesheets = qsa('link[rel="stylesheet"]') as HTMLLinkElement[];
        const largeCss = stylesheets.some(link => {
          try {
            // Try to check if it's a large Tailwind file from URL patterns
            return link.href?.includes('tailwind') || link.href?.includes('output');
          } catch { return false; }
        });
        detected.push({
          name: 'Tailwind CSS',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: hints,
        });
      }
    } catch {}

    // 70. Bootstrap
    try {
      const bootstrapLink = qs('link[href*="bootstrap"]') as HTMLLinkElement | null;
      const hasBootstrapClasses = !!qs('.btn.btn-primary');
      if (bootstrapLink || hasBootstrapClasses) {
        const hints: PerfHint[] = [];
        hints.push({
          severity: 'warning',
          message: 'Bootstrap CSS is ~200KB -- consider loading only used components',
          metric: 'LCP',
          evidence: 'Full Bootstrap CSS loaded',
        });
        detected.push({
          name: 'Bootstrap',
          version: bootstrapLink?.href?.match(/bootstrap[@/]([\d.]+)/)?.[1] || null,
          category: 'css-framework',
          buildMode: null,
          config: { js: !!qs('script[src*="bootstrap"]') },
          perfHints: hints,
        });
      }
    } catch {}

    // 71. Material UI (MUI)
    try {
      if (qs('[class*="MuiButton"]') || qs('[class*="css-"][class*="Mui"]')) {
        detected.push({
          name: 'Material UI',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'CSS-in-JS runtime style injection adds overhead at scale',
            metric: 'TBT',
            evidence: 'MUI class patterns detected',
          }],
        });
      }
    } catch {}

    // 72. Chakra UI
    try {
      if (qs('[class*="chakra-"]') || w.__chakra__) {
        detected.push({
          name: 'Chakra UI',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'CSS-in-JS runtime style injection adds overhead at scale',
            metric: 'TBT',
            evidence: 'Chakra UI class patterns detected',
          }],
        });
      }
    } catch {}

    // 73. Ant Design
    try {
      if (qs('[class*="ant-btn"]') || qs('[class*="antd"]') || qs('.ant-layout')) {
        detected.push({
          name: 'Ant Design',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'warning',
            message: 'Ant Design full CSS can be 1MB+ -- ensure tree-shaking is configured',
            metric: 'LCP',
            evidence: 'Ant Design class patterns detected',
          }],
        });
      }
    } catch {}

    // 74. Bulma
    try {
      if (qs('link[href*="bulma"]') || (qs('.column.is-')  && qs('.button.is-'))) {
        detected.push({
          name: 'Bulma',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 75. Foundation
    try {
      if (qs('link[href*="foundation"]') || qs('.cell.small-') || w.Foundation) {
        detected.push({
          name: 'Foundation',
          version: w.Foundation?.version || null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 76. Styled Components
    try {
      // Styled Components generates style tags with data-styled attribute
      const styledCount = qsa('style[data-styled]').length;
      if (styledCount > 0 || w.__STYLED_COMPONENTS_STYLESHEET__) {
        detected.push({
          name: 'Styled Components',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: { styleTags: styledCount },
          perfHints: [{
            severity: 'info',
            message: 'Runtime CSS-in-JS style injection adds overhead per component mount',
            metric: 'TBT',
            evidence: `${styledCount} data-styled style tags`,
          }],
        });
      }
    } catch {}

    // 77. Emotion
    try {
      const emotionStyles = qsa('style[data-emotion]').length;
      if (emotionStyles > 0) {
        detected.push({
          name: 'Emotion',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: { styleTags: emotionStyles },
          perfHints: [{
            severity: 'info',
            message: 'Runtime CSS-in-JS style injection adds overhead per component mount',
            metric: 'TBT',
            evidence: `${emotionStyles} data-emotion style tags`,
          }],
        });
      }
    } catch {}

    // 78. CSS Modules
    try {
      // CSS Modules produce hashed class names like _component_hash
      const hasCssModules = qsa('[class]').some(el => {
        const cls = el.className;
        return typeof cls === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*_[a-zA-Z0-9]{5,}$/.test(cls.split(' ')[0]);
      });
      if (hasCssModules) {
        detected.push({
          name: 'CSS Modules',
          version: null,
          category: 'css-framework',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // MOBILE / HYBRID (4)
    // =========================================================================

    // 79. React Native Web
    try {
      const hasRNW = qs('[data-testid][class*="r-"]') && w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hasRNW) {
        detected.push({
          name: 'React Native Web',
          version: null,
          category: 'mobile-hybrid',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'React Native Web adds a style abstraction layer',
            metric: 'TBT',
            evidence: 'RNW class patterns with React devtools',
          }],
        });
      }
    } catch {}

    // 80. Flutter Web
    try {
      const flutterScript = qs('script[src*="flutter"]');
      const flutterGlass = qs('flt-glass-pane');
      if (flutterScript || flutterGlass) {
        const hints: PerfHint[] = [];
        const isCanvasKit = !!flutterGlass;
        const hasCanvasKitWasm = !!qs('script[src*="canvaskit"]');
        if (isCanvasKit || hasCanvasKitWasm) {
          hints.push({
            severity: 'warning',
            message: 'CanvasKit WASM is ~2MB download -- consider HTML renderer for faster initial load',
            metric: 'LCP',
            evidence: 'CanvasKit renderer detected',
          });
        }
        hints.push({
          severity: 'warning',
          message: 'Flutter Web renders to canvas -- not indexable by search engines',
          metric: 'LCP',
          evidence: 'Flutter canvas rendering',
        });
        detected.push({
          name: 'Flutter Web',
          version: null,
          category: 'mobile-hybrid',
          buildMode: null,
          config: {
            renderer: isCanvasKit ? 'canvaskit' : 'html',
            canvaskitWasm: hasCanvasKitWasm,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 81. Capacitor
    try {
      if (w.Capacitor) {
        detected.push({
          name: 'Capacitor',
          version: null,
          category: 'mobile-hybrid',
          buildMode: null,
          config: {
            plugins: Object.keys(w.Capacitor?.Plugins || {}).length,
          },
          perfHints: [],
        });
      }
    } catch {}

    // 82. Cordova
    try {
      if (w.cordova) {
        detected.push({
          name: 'Cordova',
          version: w.cordova?.version || null,
          category: 'mobile-hybrid',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Cordova is legacy -- consider Capacitor migration',
            metric: 'TBT',
            evidence: 'window.cordova detected',
          }],
        });
      }
    } catch {}

    // =========================================================================
    // EMERGING FRAMEWORKS (6)
    // =========================================================================

    // 83. Leptos (Rust WASM)
    try {
      if (qs('script[src*="leptos"]') || qs('link[rel="modulepreload"][href*="leptos"]')) {
        detected.push({
          name: 'Leptos',
          version: null,
          category: 'emerging',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'WASM binary download may delay initial render',
            metric: 'LCP',
            evidence: 'Leptos WASM framework detected',
          }],
        });
      }
    } catch {}

    // 84. Yew (Rust WASM)
    try {
      if (qs('script[src*="yew"]') || qs('link[rel="modulepreload"][href*="yew"]') ||
          qs('script[src*="wasm-bindgen"]')) {
        // Only detect as Yew if no other WASM frameworks already detected
        const hasOtherWasm = detected.some(d => d.name === 'Leptos');
        if (!hasOtherWasm) {
          detected.push({
            name: 'Yew',
            version: null,
            category: 'emerging',
            buildMode: null,
            config: {},
            perfHints: [{
              severity: 'info',
              message: 'WASM binary download may delay initial render',
              metric: 'LCP',
              evidence: 'Yew WASM framework detected',
            }],
          });
        }
      }
    } catch {}

    // 85. Dioxus (Rust WASM)
    try {
      if (qs('script[src*="dioxus"]') || qs('link[rel="preload"][href*="dioxus"]')) {
        detected.push({
          name: 'Dioxus',
          version: null,
          category: 'emerging',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'WASM binary download may delay initial render',
            metric: 'LCP',
            evidence: 'Dioxus WASM framework detected',
          }],
        });
      }
    } catch {}

    // 86. Percy (Rust WASM)
    try {
      if (qs('script[src*="percy"]')) {
        detected.push({
          name: 'Percy',
          version: null,
          category: 'emerging',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'WASM binary download may delay initial render',
            metric: 'LCP',
            evidence: 'Percy WASM framework detected',
          }],
        });
      }
    } catch {}

    // 87. Seed (Rust WASM)
    try {
      if (qs('script[src*="seed"]') && qs('script[src*=".wasm"]')) {
        detected.push({
          name: 'Seed',
          version: null,
          category: 'emerging',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'WASM binary download may delay initial render',
            metric: 'LCP',
            evidence: 'Seed WASM framework detected',
          }],
        });
      }
    } catch {}

    // 88. Sycamore (Rust WASM)
    try {
      if (qs('script[src*="sycamore"]')) {
        detected.push({
          name: 'Sycamore',
          version: null,
          category: 'emerging',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'WASM binary download may delay initial render',
            metric: 'LCP',
            evidence: 'Sycamore WASM framework detected',
          }],
        });
      }
    } catch {}

    // =========================================================================
    // STATE MANAGEMENT (8)
    // =========================================================================

    // 89. Redux
    try {
      if (w.__REDUX_DEVTOOLS_EXTENSION__ || w.__REDUX_STATE__ || w.__PRELOADED_STATE__) {
        const hints: PerfHint[] = [];
        const storeData = w.__REDUX_STATE__ || w.__PRELOADED_STATE__ || {};
        const storeSizeKB = Math.round(JSON.stringify(storeData).length / 1024);
        if (storeSizeKB > 500) {
          hints.push({
            severity: 'critical',
            message: `Redux store is ${storeSizeKB}KB -- serialized in HTML for hydration`,
            metric: 'TTFB+TBT',
            evidence: `${storeSizeKB}KB serialized store`,
          });
        } else if (storeSizeKB > 100) {
          hints.push({
            severity: 'warning',
            message: `Redux store is ${storeSizeKB}KB -- serialized in HTML for hydration`,
            metric: 'TTFB',
            evidence: `${storeSizeKB}KB serialized store`,
          });
        }
        detected.push({
          name: 'Redux',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: { storeSizeKB },
          perfHints: hints,
        });
      }
    } catch {}

    // 90. MobX
    try {
      if (w.__mobxGlobals || w.__mobxInstanceCount) {
        detected.push({
          name: 'MobX',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 91. Zustand
    try {
      // Zustand uses React hooks internally; detect via devtools or store inspection
      if (w.__ZUSTAND_DEVTOOLS__) {
        detected.push({
          name: 'Zustand',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 92. Jotai
    try {
      if (w.__JOTAI_DEVTOOLS__) {
        detected.push({
          name: 'Jotai',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 93. Recoil
    try {
      if (w.__recoilDebugStates || w.RecoilRoot) {
        detected.push({
          name: 'Recoil',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 94. XState
    try {
      if (w.__xstate__) {
        detected.push({
          name: 'XState',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 95. Pinia (Vue)
    try {
      if (w.__pinia) {
        detected.push({
          name: 'Pinia',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 96. Vuex (Vue)
    try {
      if (w.__VUEX__) {
        detected.push({
          name: 'Vuex',
          version: null,
          category: 'state-management',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Vuex is in maintenance mode -- consider migrating to Pinia',
            metric: 'TBT',
            evidence: 'Vuex store detected',
          }],
        });
      }
    } catch {}

    // =========================================================================
    // BUILD TOOLS (6)
    // =========================================================================

    // 97. Webpack
    try {
      const hasWebpackChunk = w.webpackChunk || w.webpackJsonp;
      const bundleScript = qs('script[src*="bundle"]') as HTMLScriptElement | null;
      const hashPattern = bundleScript?.src?.match(/\.[a-f0-9]{8,}\.js/);
      if (hasWebpackChunk || hashPattern) {
        const hints: PerfHint[] = [];
        const version = w.__webpack_modules__ ? 5 : (w.webpackJsonp ? 4 : null);
        const chunkCount = qsa('script[src*="chunk"]').length;
        const moduleCount = Object.keys(w.__webpack_modules__ || {}).length;

        // Check for exposed source maps
        let sourceMapsExposed = false;
        try {
          sourceMapsExposed = !!performance.getEntriesByType('resource').find(
            (r: any) => r.name.endsWith('.map')
          );
        } catch {}
        if (sourceMapsExposed) {
          hints.push({
            severity: 'warning',
            message: 'Source maps publicly accessible -- exposes source code',
            metric: 'security',
            evidence: '.map file detected in resource timing',
          });
        }

        detected.push({
          name: 'Webpack',
          version: version ? String(version) : null,
          category: 'build-tool',
          buildMode: null,
          config: {
            chunks: chunkCount,
            sourceMapsExposed,
            moduleCount,
          },
          perfHints: hints,
        });
      }
    } catch {}

    // 98. Vite
    try {
      const viteDevClient = qs('script[type="module"][src*="/@vite/"]');
      const viteSrc = qs('script[type="module"][src*="/src/"]');
      if (viteDevClient || viteSrc) {
        const hints: PerfHint[] = [];
        const devMode = !!viteDevClient;
        if (devMode) {
          hints.push({
            severity: 'critical',
            message: 'Vite dev server detected in production',
            metric: 'TBT',
            evidence: '/@vite/ client script loaded',
          });
        }
        detected.push({
          name: 'Vite',
          version: null,
          category: 'build-tool',
          buildMode: devMode ? 'development' : null,
          config: { devMode },
          perfHints: hints,
        });
      }
    } catch {}

    // 99. Parcel
    try {
      if (qs('script[src*=".parcel-cache"]') || qs('script[src*="parcel"]')) {
        detected.push({
          name: 'Parcel',
          version: null,
          category: 'build-tool',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 100. esbuild
    try {
      // esbuild output is hard to detect; look for characteristic patterns
      // esbuild-generated chunks often use a specific naming scheme
      const esbuildMarker = qs('script[src*="chunk-"][src$=".js"]');
      if (esbuildMarker && !w.webpackChunk) {
        detected.push({
          name: 'esbuild',
          version: null,
          category: 'build-tool',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // 101. Turbopack
    try {
      if (qs('script[src*="/_next/static/chunks/turbopack"]')) {
        detected.push({
          name: 'Turbopack',
          version: null,
          category: 'build-tool',
          buildMode: null,
          config: {},
          perfHints: [{
            severity: 'info',
            message: 'Using Turbopack bundler (experimental in Next.js)',
            metric: 'LCP',
            evidence: 'Turbopack chunk detected',
          }],
        });
      }
    } catch {}

    // 102. Rollup
    try {
      // Rollup output is hard to detect from client-side alone
      // Look for Rollup's typical chunk naming pattern when no Webpack/Vite detected
      const moduleScripts = qsa('script[type="module"]');
      const hasRollupPattern = moduleScripts.some(el => {
        const src = (el as HTMLScriptElement).src;
        return src && /\/assets\/[a-zA-Z]+-[a-f0-9]{8}\.js/.test(src);
      });
      const noOtherBundler = !detected.some(d =>
        d.category === 'build-tool' && ['Webpack', 'Vite', 'Parcel', 'esbuild'].includes(d.name)
      );
      if (hasRollupPattern && noOtherBundler) {
        detected.push({
          name: 'Rollup',
          version: null,
          category: 'build-tool',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // =========================================================================
    // ADDITIONAL SSGs (detected via meta generator)
    // =========================================================================

    // Pelican (Python SSG)
    try {
      const pelicanMeta = qs('meta[name="generator"][content*="Pelican"]');
      if (pelicanMeta) {
        detected.push({
          name: 'Pelican',
          version: pelicanMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // Zola (Rust SSG)
    try {
      const zolaMeta = qs('meta[name="generator"][content*="Zola"]');
      if (zolaMeta) {
        detected.push({
          name: 'Zola',
          version: zolaMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // Middleman (Ruby SSG)
    try {
      const middlemanMeta = qs('meta[name="generator"][content*="Middleman"]');
      if (middlemanMeta) {
        detected.push({
          name: 'Middleman',
          version: middlemanMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // Metalsmith (Node SSG)
    try {
      const metalsmithMeta = qs('meta[name="generator"][content*="Metalsmith"]');
      if (metalsmithMeta) {
        detected.push({
          name: 'Metalsmith',
          version: null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    // Bridgetown (Ruby SSG)
    try {
      const bridgetownMeta = qs('meta[name="generator"][content*="Bridgetown"]');
      if (bridgetownMeta) {
        detected.push({
          name: 'Bridgetown',
          version: bridgetownMeta.getAttribute('content')?.match(/[\d.]+/)?.[0] || null,
          category: 'ssg',
          buildMode: null,
          config: {},
          perfHints: [],
        });
      }
    } catch {}

    return detected;
  });
}
