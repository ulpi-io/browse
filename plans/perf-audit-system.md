# Plan: Performance Audit System (Revised)

> Generated: 2026-03-26
> Revised: 2026-03-26 (founder review — addressed 13 concerns, 3 observations)
> Branch: `feat/perf-audit`
> Mode: EXPANSION

## Overview

Add four new commands to browse (`initscript`, `coverage`, `detect`, `perf-audit`) that give AI coding agents — and especially Claude Code — the ability to fully diagnose web performance bottlenecks on any website. The system detects 108 frameworks (with version, build mode, hydration analysis, state management, data payload sizes), 55 SaaS platforms (with app/plugin enumeration, per-app sizing, platform constraints), collects Core Web Vitals via pre-navigation observers, measures JS/CSS coverage, reconstructs the critical rendering path, and produces a structured report separating fixable issues from platform limitations with platform-specific actionable recommendations.

## Reference Documents

| Document | Purpose |
|----------|---------|
| [perf-audit-frameworks.md](perf-audit-frameworks.md) | 108 framework detection signatures with detection expressions, version extraction, config depth, and perf disease detection |
| [perf-audit-platforms.md](perf-audit-platforms.md) | 55 SaaS platform detection signatures with app enumeration, constraint mapping, and platform metrics |

## Scope Challenge

**What already exists:**
- `perf` command with navigation timing (TTFB, load, domReady) in `src/commands/read.ts:278`
- `network` command capturing requests with `{ timestamp, method, url, status?, duration?, size? }` in `src/buffers.ts:14`
- `BrowserManager.setInitScript()` + `context.addInitScript()` (internal only, stacks with domain filter) in `src/browser-manager.ts:1308`
- `react-devtools` command with React-specific profiling (fiber tree, hydration timing, render profiling) in `src/react-devtools.ts`
- `js`/`eval` commands for arbitrary JS execution in `src/commands/read.ts:117`
- `context.addInitScript()` STACKS multiple scripts (confirmed via Playwright docs) — domain filter, perf observers, and user scripts can coexist using IIFE namespacing
- Response headers available via `res.headers()` in Playwright request/response events (`src/browser-manager.ts:1400`) but NOT currently captured in `NetworkEntry`

**Key data source decision:**
Infrastructure detection and resource analysis will use `performance.getEntriesByType('resource')` via `page.evaluate()` as the primary data source (provides `nextHopProtocol`, `transferSize`, `encodedBodySize`, `decodedBodySize`, `initiatorType`), with `NetworkEntry[]` from the network buffer as secondary source for timing/status data. This avoids modifying the NetworkEntry struct while getting richer data.

**What was ruled out:**
- Lighthouse integration (too heavy, fights for Chrome control)
- Performance budget/CI gate (future add-on built on top of perf-audit output)
- Tracking/diff across runs (future — save snapshots to .browse/perf/)
- Source map resolution (Claude reads actual source files directly)
- Modifying `NetworkEntry` struct (use Resource Timing API instead — richer data, no breaking change)

**Why EXPANSION:** The detection database depth is the moat. Not just "React detected" but "React 18.2.0, production build, concurrent mode, 3 roots, Redux store 847KB, hydration took 423ms, __NEXT_DATA__ is 124KB." That depth is what lets Claude fix the right thing.

## Architecture

```
                                      browse CLI
                                          │
                      ┌───────────────────┼───────────────────────┐
                      │                   │                        │
                 initscript            coverage                perf-audit
              (write command)       (meta command)           (meta command)
                      │                   │                        │
                      ▼                   ▼                        ▼
             BrowserManager       Playwright Coverage     ┌────────┴────────┐
             .setInitScript()     .startJSCoverage()      │                 │
             context.add          .startCSSCoverage()     │   orchestrator  │
             InitScript()         .stopJSCoverage()       │  src/perf-audit │
                                  .stopCSSCoverage()      │   /index.ts     │
             [TASK-001]           [TASK-003/004]           │  [TASK-013]     │
                                                          └────────┬────────┘
                                                                   │
                                          ┌────────────────────────┼────────────────────────┐
                                          │                        │                        │
                                   detection system         web-vitals              resource-analyzer
                                          │                collector                + DOM + fonts + images
                                          │                [TASK-010]               [TASK-011/012]
                                          │                     │                        │
                              ┌───────────┼───────────┐         │              ┌─────────┼─────────┐
                              │           │           │         │              │         │         │
                        frameworks    saas.ts    infra.ts       │          resources  DOM audit  correlation
                        .ts           [TASK-007] [TASK-008]     │          by type   complexity  engine
                        [TASK-006]        │           │         │          [TASK-011] [TASK-012] [TASK-013]
                              │           │           │         │              │         │         │
                              └───────────┼───────────┘         │              └─────────┼─────────┘
                                          │                     │                        │
                                   detection/index.ts           │                        │
                                   + build tools                │                        │
                                   + third-party inventory      │                        │
                                   + state mgmt detection       │                        │
                                   [TASK-009]                   │                        │
                                          │                     │                        │
                                          └─────────────────────┼────────────────────────┘
                                                                │
                                                         formatter.ts
                                                         + platform-aware recommendations
                                                         + fixable vs constraint separation
                                                         [TASK-014]
                                                                │
                                                    ┌───────────┼───────────┐
                                                    │           │           │
                                              detect cmd   perf-audit   tests
                                              [TASK-015]   cmd          [TASK-017-024]
                                                           [TASK-016]
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Pre-navigation script injection | `BrowserManager.setInitScript()` in `src/browser-manager.ts:1308` — stacks via `context.addInitScript()` | Extend — expose as CLI command |
| Network request data | `NetworkEntry` in `src/buffers.ts:14` — has timing/url/status/size | Reuse as secondary data source |
| Resource metadata (headers, compression, protocol) | `performance.getEntriesByType('resource')` via `page.evaluate()` — has transferSize, encodedBodySize, nextHopProtocol, initiatorType | Use as primary data source for infra/resource analysis |
| Navigation timing | `perf` command in `src/commands/read.ts:278` — TTFB, load, domReady | Reuse — incorporate into perf-audit output |
| React profiling | `src/react-devtools.ts` — fiber tree, hydration timing, render profiling, component props/state | Reuse — call `getProfiler()`, `getHydration()`, `getRenders()` when React detected |
| Init script pattern | `react-devtools.ts:46` — injects hook via `context.addInitScript()`, queries via `page.evaluate()` | Reuse pattern — same approach for web vitals observers |
| Command registration | `READ/WRITE/META_COMMANDS` in `src/server.ts:142-173` | Extend — add new commands to sets |
| Command dispatch | `handleReadCommand`/`handleWriteCommand`/`handleMetaCommand` | Extend — add cases |
| Chain command sets | `WRITE_SET`/`READ_SET` in `src/commands/meta.ts:394-395` | Extend — add new commands |
| CLI help text | `src/cli.ts` main() help | Extend — add new commands |
| SAFE_TO_RETRY | `src/cli.ts:415` | Extend — add read-only commands |
| Test infrastructure | `test/setup.ts`, `test/test-server.ts`, `test/fixtures/` | Reuse — same BrowserManager pattern, add new fixtures |

## Tasks

### TASK-001: Add `initscript` write command

Expose `BrowserManager.setInitScript()` as a CLI command. This is a write command because it modifies browser state (the init script persists across navigations). Supports `set <code>`, `clear`, and `show` subcommands.

The init script runs before every page load via Playwright's `context.addInitScript()`. Multiple init scripts STACK (domain filter + user script + perf-audit script can coexist). User init scripts MUST use IIFE pattern `(function(){ ... })()` to avoid global namespace collision with the domain filter init script.

Implementation: add `case 'initscript':` to switch in `src/commands/write.ts`. For `set`: call `bm.setInitScript(code)` then `bm.getContext().addInitScript(code)`. For `clear`: call `bm.setInitScript(null)`. For `show`: call `bm.getInitScript()` and return it.

Register `'initscript'` in WRITE_COMMANDS set in `src/server.ts:150`.

**Files to modify:** `src/commands/write.ts`, `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse initscript set "window.__TEST=1"` registers the script, confirmed by navigating and running `browse js "window.__TEST"` returning `1`
- [ ] `browse initscript clear` removes the script; subsequent navigations don't run it
- [ ] `browse initscript show` returns the current script or "No init script set"
- [ ] Init script persists across `emulate` (context recreation) — verified by emulating a device and checking the script still runs
- [ ] Init script coexists with domain filter — when `--allowed-domains` is set AND an init script is registered, both execute without conflict

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Register `initscript` in chain, CLI help

Add `initscript` to the WRITE_SET in chain command (`src/commands/meta.ts:394`). Add to CLI help text in `src/cli.ts`. Do NOT add to SAFE_TO_RETRY (it's a write command — modifies browser state).

**Files to modify:** `src/commands/meta.ts`, `src/cli.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse chain '[["initscript","set","window.x=1"],["goto","url"],["js","window.x"]]'` works end-to-end
- [ ] `browse --help` lists `initscript` under Write commands
- [ ] `initscript` is NOT in SAFE_TO_RETRY set (write commands must not auto-retry)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Add coverage methods to BrowserManager

Add `startCoverage()`, `stopCoverage()`, and `isCoverageActive()` methods to `BrowserManager` class in `src/browser-manager.ts`.

Uses Playwright's `page.coverage.startJSCoverage({ resetOnNavigation: false })` and `page.coverage.startCSSCoverage({ resetOnNavigation: false })`. Note `resetOnNavigation: false` — we need coverage to persist across the perf-audit reload cycle.

`stopCoverage()` processes raw V8 coverage data: for each entry, calculates `totalBytes` from source length, `usedBytes` by summing executed ranges (ranges with `count > 0`), `unusedBytes = totalBytes - usedBytes`, `unusedPct = unusedBytes / totalBytes * 100`. Returns `{ js: ProcessedCoverageEntry[], css: ProcessedCoverageEntry[] }`.

Coverage state tracked via `private coverageActive: boolean = false`. Must reset to `false` on context recreation (`recreateContext()`).

**Files to modify:** `src/browser-manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `bm.startCoverage()` enables JS+CSS coverage on the active page without throwing
- [ ] `bm.stopCoverage()` returns `{ js: CoverageEntry[], css: CoverageEntry[] }` with `url`, `totalBytes`, `usedBytes`, `unusedBytes`, `unusedPct` per file
- [ ] Calling `stopCoverage()` without `startCoverage()` throws clear error: "Coverage not started. Run 'browse coverage start' first."
- [ ] Coverage works after context recreation (emulate device) — `coverageActive` flag resets, user must restart coverage
- [ ] `resetOnNavigation: false` ensures coverage persists across page reloads (needed for perf-audit flow)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-004: Add `coverage` meta command

Add `coverage` meta command with subcommands: `start`, `stop`. `start` begins JS+CSS coverage collection. `stop` stops collection and returns a structured report.

Register `'coverage'` in META_COMMANDS set in `src/server.ts:162`. Add case in `src/commands/meta.ts`.

Output format for `stop`:
```
JS Coverage:
  vendor.js           680KB   used: 218KB (32%)   wasted: 462KB
  analytics.js         84KB   used: 46KB  (55%)   wasted: 38KB
  ...
  Total JS:           1.8MB   used: 890KB (49%)   wasted: 910KB

CSS Coverage:
  styles.css          120KB   used: 58KB  (48%)   wasted: 62KB
  ...
  Total CSS:          240KB   used: 130KB (54%)   wasted: 110KB

Total wasted: 1020KB (47% of all JS/CSS)
```

Files sorted by wasted bytes descending. Inline scripts/styles (empty URL) grouped as "[inline]".

**Files to modify:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse coverage start` → `browse goto <url>` → `browse coverage stop` returns per-file coverage with used/unused bytes and percentages
- [ ] Output groups by type (JS Coverage / CSS Coverage) with per-type totals and grand total
- [ ] Files sorted by wasted bytes descending (biggest waste first)
- [ ] Running `browse coverage stop` without `start` returns clear error message, not crash
- [ ] Inline scripts (no URL) displayed as "[inline]" with their size

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-003
**Priority:** P1

---

### TASK-005: Register `coverage` in chain, CLI help, SAFE_TO_RETRY

Add `coverage` to CLI help text. Add `coverage` to SAFE_TO_RETRY (the report output is idempotent). Chain already dispatches unknown commands to handleMetaCommand as fallthrough, but verify it works.

**Files to modify:** `src/cli.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse chain '[["coverage","start"],["goto","url"],["coverage","stop"]]'` works
- [ ] `browse --help` lists `coverage` under Meta commands
- [ ] `coverage` is in SAFE_TO_RETRY set

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-004
**Priority:** P1

---

### TASK-006: Create detection module — frameworks.ts

Create `src/detection/frameworks.ts` with detection signatures for 108 web frameworks. Reference document: `plans/perf-audit-frameworks.md` contains every framework with exact detection expressions, version extraction, config depth, and perf disease detection logic.

**IMPORTANT: This is NOT a list of boolean flags.** Each detection must extract:
- **Version** — exact version string where available (e.g., `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values().next().value?.version`)
- **Build mode** — production vs development (e.g., React `bundleType`, Next.js `__NEXT_DATA__.err`, Vite HMR client)
- **Config depth** — framework-specific configuration that affects performance:
  - React: concurrent mode, root count, strict mode
  - Next.js: router type (app/pages), `__NEXT_DATA__` payload size in KB, RSC detection, ISR cache status, dev indicators
  - Vue: version 2 vs 3, devtools enabled, component count
  - Angular: Zone.js presence, Ivy vs ViewEngine, dev mode (ng.probe)
  - Magento: RequireJS module count, Knockout binding count, JS bundling enabled/disabled, customer section count
  - Laravel: Livewire component count, wire:init count, Inertia payload size, Debug Bar presence, Vite vs Mix
  - WordPress: theme name, plugin list from `/wp-content/plugins/` script URLs, Gutenberg/Elementor/WooCommerce detection, jQuery Migrate
  - Django: Debug Toolbar presence, admin assets on public pages
- **Perf hints** — not static strings but DETECTED anti-patterns with evidence:
  - "Next.js __NEXT_DATA__ payload is 124KB (critical >50KB)" — measured, not assumed
  - "RequireJS loads 47 modules sequentially" — counted, not guessed
  - "React development build detected (bundleType=1)" — checked, not assumed
  - "Livewire fires 6 wire:init AJAX calls on page load" — counted from DOM

All 108 framework detections run in a single batched `page.evaluate()` call for performance. Each detection wrapped in try/catch to prevent one failure from blocking others. Total detection time target: <200ms.

Categories: js-framework (22), meta-framework (14), php-framework (15), python-framework (6), ruby-framework (4), java-dotnet (7), css-framework (10), ssg (9), mobile-hybrid (4), emerging (6), state-management (8), build-tools (6).

**Files to create:** `src/detection/frameworks.ts`

**Type:** feature
**Effort:** XL

**Acceptance Criteria:**
- [ ] Exports `detectFrameworks(page): Promise<DetectedFramework[]>` that runs all detections in a single `page.evaluate()` call
- [ ] Each detected framework returns `{ name, version?, category, buildMode?, config: Record<string, any>, perfHints: PerfHint[] }` where config contains framework-specific depth (not empty objects)
- [ ] React detection extracts: version, production/dev build mode, concurrent mode, root count
- [ ] Next.js detection extracts: `__NEXT_DATA__` payload size in KB, router type (app/pages), RSC presence, ISR status, dev mode indicators
- [ ] WordPress detection extracts: theme name, plugin names array from script URLs, jQuery/Migrate presence, Elementor/WooCommerce/Gutenberg flags
- [ ] Magento detection extracts: RequireJS module count, Knockout binding count, JS bundling status, customer section detection
- [ ] Laravel detection extracts: Livewire component count + wire:init count, Inertia payload size, Debug Bar presence, Vite vs Mix
- [ ] State management detection: Redux store size in KB (from `__REDUX_STATE__` or `__PRELOADED_STATE__`), MobX/Zustand/Pinia presence
- [ ] Build tool detection: Webpack (version 4 vs 5, chunk count, source maps exposed), Vite (dev mode HMR), Parcel, esbuild, Turbopack
- [ ] Detection handles missing globals gracefully — returns empty array on plain static HTML page, no uncaught exceptions
- [ ] Contains at least 100 framework detection signatures covering all 12 categories
- [ ] All detections run in <200ms on a typical page

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-007: Create detection module — saas.ts

Create `src/detection/saas.ts` with detection signatures for 55 SaaS web platforms. Reference document: `plans/perf-audit-platforms.md` contains every platform with detection expressions, app enumeration logic, constraint mapping, and platform-specific metrics.

**IMPORTANT: This is NOT just "platform detected."** Each detection must extract:
- **App/plugin/extension enumeration** with per-app sizing:
  - Shopify: enumerate non-theme, non-core scripts by CDN domain → app name, script URLs, total size per app, whether app is active on current page type
  - WordPress: enumerate plugins from `/wp-content/plugins/<name>/` in script/style URLs → plugin name, total asset size per plugin
  - Magento: enumerate RequireJS modules from `require.s.contexts._.defined` → module count, waterfall depth
- **Platform-specific metrics**:
  - Shopify: Liquid render time from `x-shopify-stage` or Server-Timing header, theme.js size
  - Magento: RequireJS waterfall duration, customer section AJAX count and payload size, FPC status from X-Magento-Cache-Control header
  - WooCommerce: cart-fragments.js presence and whether loaded on non-shop pages
  - WordPress: block-library CSS loaded on pages without blocks
- **Constraint classification** — static per platform:
  - `canFix[]`: what developers CAN optimize (theme code, app selection, images)
  - `cannotFix[]`: platform limitations (platform runtime JS, checkout, CDN config)
- **Platform config depth**:
  - Shopify: theme name/id/role, cdnHost, currency, locale
  - Squarespace: template name/version, commerce enabled
  - Wix: Thunderbolt vs Santa viewer, runtime size
  - Webflow: site/page IDs, interactions engine loaded, ecommerce
  - Bubble: no-code runtime size

All 55 platform detections run in a single batched `page.evaluate()` call. Response headers for platform metrics (Liquid render time, FPC status, Vercel cache) extracted via `performance.getEntriesByType('navigation')[0].serverTiming` or DOM meta tags where headers aren't accessible from JS.

**Files to create:** `src/detection/saas.ts`

**Type:** feature
**Effort:** XL

**Acceptance Criteria:**
- [ ] Exports `detectSaaS(page, networkEntries?): Promise<DetectedSaaS[]>` that identifies platforms with deep config
- [ ] Each detection returns `{ name, category, version?, config, apps: PlatformApp[], constraints: { canFix[], cannotFix[] }, perfHints[], platformMetrics }`
- [ ] Shopify detection extracts: theme name, enumerates apps with per-app script URLs and sizes, calculates total app JS, detects Liquid render time from headers
- [ ] WordPress detection extracts: theme name, plugin names array from `/wp-content/plugins/` paths with per-plugin asset size, WooCommerce cart-fragments detection
- [ ] Magento detection extracts: RequireJS module count + waterfall depth estimation, Knockout binding count, customer section AJAX count, FPC status
- [ ] Wix detection reports: total platform runtime KB (typically 1MB+), marks it as `cannotFix`
- [ ] Each platform has `constraints.canFix` and `constraints.cannotFix` arrays populated
- [ ] Contains at least 50 SaaS platform detection signatures across all 6 categories
- [ ] No false positive detections on plain HTML pages

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-008: Create detection module — infrastructure.ts

Create `src/detection/infrastructure.ts` for infrastructure fingerprinting. Uses `performance.getEntriesByType('resource')` via `page.evaluate()` as primary data source (provides `nextHopProtocol`, `transferSize`, `encodedBodySize`, `decodedBodySize`, `initiatorType`).

**Detects:**

**CDN** (from response headers via Resource Timing + navigation entry):
- Cloudflare (`cf-ray`, `cf-cache-status`)
- Fastly (`x-served-by`, `x-cache` with Fastly patterns)
- Akamai (`x-akamai-*`, `x-cache` with Akamai patterns)
- CloudFront (`x-amz-cf-id`, `x-amz-cf-pop`)
- Vercel Edge (`x-vercel-id`, `x-vercel-cache`)
- Netlify (`x-nf-request-id`)
- Bunny CDN, KeyCDN, StackPath, Imperva
- CDN cache status: HIT / MISS / STALE / BYPASS / DYNAMIC

**Protocol** (per-resource, not just page level):
- HTTP/1.1 vs h2 vs h3 via `PerformanceResourceTiming.nextHopProtocol`
- Breakdown: X% of resources on h2, Y% on h1.1
- Flag mixed protocols as concern

**Compression** (per-resource-type aggregation):
- Detect gzip/brotli/none via `transferSize` vs `decodedBodySize` ratio
- Group by resource type: JS compression rate, CSS compression rate, image compression, HTML compression
- Flag: uncompressed JS/CSS as critical concern

**Caching:**
- Per-resource cache analysis via `transferSize === 0` (cached) vs `transferSize > 0` (fetched)
- Cache hit rate: cached resources / total resources
- Flag resources with `transferSize > 0` that should be cached (static assets without cache headers)

**DNS & Connection:**
- Unique origins count from resource URLs
- Missing `<link rel="preconnect">` for non-primary origins with multiple resources
- Missing `<link rel="dns-prefetch">` recommendations
- Existing resource hints: count `preconnect`, `prefetch`, `preload`, `dns-prefetch`, `modulepreload`

**Service Worker:**
- Registration status: `!!navigator.serviceWorker?.controller`
- Caching strategy detection via `page.evaluate()`:
  - Inspect registered SW scope
  - Check CacheStorage API: `caches.keys()` for cache names (cache-first patterns often use versioned cache names)
  - Check for navigation preload: `registration.navigationPreload?.getState()`
  - Check for offline support: attempt to detect offline fallback page in cache
- SW boot time: `performance.getEntriesByType('navigation')[0].workerStart` vs `fetchStart`
- Cache storage size: sum of cache entries if accessible

**Web Workers:** count via `performance.getEntriesByType('resource').filter(r => r.initiatorType === 'worker')`

**WebSocket connections:** detect via `performance.getEntriesByType('resource').filter(r => r.name.startsWith('wss://'))` or DOM inspection for known WebSocket patterns

**DOM Complexity:**
- Total node count: `document.querySelectorAll('*').length`
- Max tree depth: walk DOM measuring depth
- Largest subtree: identify element with most descendants
- Document size: `document.documentElement.outerHTML.length`

**Files to create:** `src/detection/infrastructure.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Exports `detectInfrastructure(page): Promise<InfrastructureReport>` using Resource Timing API + DOM inspection via `page.evaluate()`
- [ ] CDN detection checks at least 6 CDN providers and returns cache status (HIT/MISS/STALE)
- [ ] Protocol detection returns per-resource breakdown (e.g., "85% h2, 15% h1.1") not just the document protocol
- [ ] Compression analysis returns per-resource-type rates (JS: brotli 92%, CSS: gzip 100%, Images: none 60%)
- [ ] Cache hit rate calculated from `transferSize === 0` heuristic with percentage
- [ ] Missing preconnect analysis: lists origins with 2+ resources that lack `<link rel="preconnect">`
- [ ] Service Worker detection: registration status, caching strategy name (cache-first/network-first/stale-while-revalidate/unknown), navigation preload enabled, cache storage summary
- [ ] DOM complexity: total node count, max depth, largest subtree element + size, document HTML size in KB
- [ ] Returns valid (zeroed/null) results on minimal local test server page, no errors

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-009: Create detection module — index.ts (orchestrator + types)

Create `src/detection/index.ts` that exports all shared types and the orchestrator function `detectStack(page, networkEntries?): Promise<StackFingerprint>`.

**Types exported:**
- `DetectedFramework` — `{ name, version?, category, buildMode?, config, perfHints[] }`
- `DetectedSaaS` — `{ name, category, version?, config, apps[], constraints, perfHints[], platformMetrics }`
- `InfrastructureReport` — CDN, protocol, compression, caching, dns, resourceHints, serviceWorker, webWorkers, webSockets, domComplexity
- `PerfHint` — `{ severity, message, metric, evidence }`
- `PlatformApp` — `{ name, scriptUrls[], styleUrls[], totalSizeKB, usedOnPage, loadTiming }`
- `StackFingerprint` — the combined result type

**Orchestrator logic:**
1. Call `detectFrameworks(page)`, `detectSaaS(page, networkEntries)`, `detectInfrastructure(page)` in parallel (`Promise.all`)
2. Post-process: if React detected AND `react-devtools` is enabled on the BrowserManager, call `getProfiler()` / `getHydration()` from `src/react-devtools.ts` and merge into React framework config
3. Third-party inventory: group `networkEntries` by domain, classify known domains:
   - Analytics: google-analytics.com, googletagmanager.com, analytics.*, segment.com, mixpanel.com, amplitude.com, plausible.io, matomo.*, hotjar.com
   - Ads: doubleclick.net, googlesyndication.com, facebook.net/tr, ads.*, criteo.com, taboola.com, outbrain.com
   - Social: facebook.net (non-ad), twitter.com, linkedin.com, pinterest.com, tiktok.com
   - Chat: intercom.io, drift.com, zendesk.com, crisp.chat, tawk.to, livechat.com, freshchat.com
   - Monitoring: sentry.io, datadoghq.com, newrelic.com, logrocket.com, bugsnag.com, rollbar.com
   - Consent: onetrust.com, cookiebot.com, trustarc.com, cookieinformation.com
   - Other: everything else not from the page origin
   - Per-domain: total size KB, script count, Long Task attribution (if available from web vitals data)
4. Return `StackFingerprint` with all sections

**Files to create:** `src/detection/index.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `detectStack(page)` returns complete `StackFingerprint` with frameworks, saas, infrastructure, and thirdParty sections
- [ ] Third-party inventory groups resources by domain and classifies at least 30 known domains into analytics/ads/social/chat/monitoring/consent/other
- [ ] Per-domain third-party summary includes: domain, category, script count, total size KB
- [ ] All three detection modules run in parallel via `Promise.all` for performance
- [ ] Returns valid results on minimal static HTML (empty arrays, null CDN, no frameworks detected)
- [ ] React DevTools profiling data merged into React framework config when available

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-006, TASK-007, TASK-008
**Priority:** P1

---

### TASK-010: Create Web Vitals collector

Create `src/perf-audit/web-vitals.ts` with the pre-navigation observer injection script and the post-navigation collection function.

**Init script** (injected via `context.addInitScript()` before page load):
Uses IIFE pattern `(function(){ ... })()` to avoid global collision with domain filter init script. Stores data on `window.__BROWSE_PERF_METRICS` namespace.

Sets up **buffered** PerformanceObservers for:
1. **LCP** (`largest-contentful-paint`, `buffered: true`):
   - Stores: `startTime`, `element.tagName`, `element.id`, `element.className`, `url` (for images), `size`, `element.getAttribute('fetchpriority')`, `element.getAttribute('loading')`
   - Overwrites on each entry (LCP is the LAST entry before user interaction)
2. **CLS** (`layout-shift`, `buffered: true`):
   - Stores each shift: `value`, `startTime`, `hadRecentInput`, sources array with `{ node.tagName, node.id, currentRect, previousRect }`
   - Calculates cumulative CLS excluding shifts with `hadRecentInput: true`
3. **INP/FID** (`event`, `buffered: true`, `durationThreshold: 16`):
   - Tracks worst interaction: `duration`, `startTime`, `processingStart`, `processingEnd`, `target.tagName`
   - INP = p98 of interaction durations
4. **Long Tasks** (`longtask`, `buffered: true`):
   - Stores each: `startTime`, `duration`, `attribution[0]?.containerSrc` (script URL), `attribution[0]?.containerName`
   - TBT = sum of (duration - 50ms) for each long task
5. **Paint Timing** (`paint`, `buffered: true`):
   - FP (first-paint) and FCP (first-contentful-paint) startTime
6. **Resource Timing** (`resource`, `buffered: true`):
   - Capture `initiatorType` to identify render-blocking resources
   - Capture `renderBlockingStatus` (Chrome 105+) for explicit render-blocking detection

**Collection function** `collectWebVitals(page): Promise<WebVitalsReport>`:
- Calls `page.evaluate(() => window.__BROWSE_PERF_METRICS)` after page load + 1s settle
- Also collects TTFB from `performance.getEntriesByType('navigation')[0].responseStart`
- Returns structured `WebVitalsReport`

**Return shape:**
```typescript
interface WebVitalsReport {
  ttfb: number;           // ms
  fcp: number | null;     // ms
  lcp: number | null;     // ms
  cls: number | null;     // unitless score
  tbt: number | null;     // ms (sum of long task excess)
  inp: number | null;     // ms
  lcpElement: {
    tag: string;
    id?: string;
    url?: string;         // src/href for images/iframes
    size: number;         // LCP element size
    fetchpriority?: string;
    loading?: string;
  } | null;
  layoutShifts: Array<{
    time: number;
    value: number;
    sources: Array<{ tag: string; id?: string; shift: string }>;
  }>;
  longTasks: Array<{
    time: number;
    duration: number;
    scriptUrl: string | null;  // attribution
  }>;
  paintTimings: { fp: number | null; fcp: number | null };
}
```

**Files to create:** `src/perf-audit/web-vitals.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Init script uses IIFE pattern, stores on `window.__BROWSE_PERF_METRICS`, sets up all 6 observer types with `buffered: true`
- [ ] `collectWebVitals(page)` returns `{ ttfb, fcp, lcp, cls, tbt, inp, lcpElement, layoutShifts[], longTasks[], paintTimings }`
- [ ] LCP element identification includes: tag name, id, URL (for images), size, fetchpriority attribute, loading attribute
- [ ] Layout shift entries include source element tag/id and shift magnitude
- [ ] Long Task entries include script URL attribution from `attribution[0]?.containerSrc`
- [ ] TBT calculated as sum of (duration - 50ms) for each long task
- [ ] Returns partial data gracefully if some observers have no entries (e.g., no layout shifts = empty array, not error)
- [ ] Init script does not throw on pages that don't support PerformanceObserver (graceful degradation)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-011: Create resource analyzer

Create `src/perf-audit/resource-analyzer.ts` that categorizes resources and DOM elements into a structured report. Uses BOTH `NetworkEntry[]` from session buffer (for timing/status) AND `page.evaluate()` with Resource Timing API (for compression, protocol, initiator data).

**Resource categorization** (by content type from URL extension + Resource Timing `initiatorType`):
- JS: `.js`, `.mjs`, `.cjs`, `.jsx`, `.tsx` → count, total size, largest file, per-file compression
- CSS: `.css` → count, total size, largest file, render-blocking status
- Images: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.avif`, `.ico`, `.bmp` → count, total size, format breakdown
- Fonts: `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot` → count, total size, per-font details
- Media: `.mp4`, `.webm`, `.mp3`, `.ogg` → count, total size
- Documents: `.html`, `.htm`, `.xml`, `text/html` → count, total size
- API: XHR/fetch requests (not static assets) → count, total size, slowest
- Other: everything else → count, total size

**Third-party size breakdown**: group by origin domain, sum sizes per domain.

**Image audit** (via `page.evaluate()` querying all `<img>` elements):
- Format detection: check URL for `.png`, `.jpg` (when `.webp` or `.avif` would be better)
- Missing dimensions: `<img>` without `width` AND `height` attributes → causes CLS
- Missing lazy-load: `<img>` without `loading="lazy"` that is below-fold (check `getBoundingClientRect().top > window.innerHeight`)
- Missing fetchpriority: LCP image candidates without `fetchpriority="high"`
- Responsive images: check for `srcset` attribute usage, flag images without `srcset` that are large
- Oversized: intrinsic size vs display size via `naturalWidth/naturalHeight` vs `offsetWidth/offsetHeight` — flag if ratio > 2x

**Font audit** (via `page.evaluate()` + `document.fonts` API):
- Per-font face: family name, weight, style, status (loaded/loading/error)
- `font-display` value: extracted from `@font-face` rules in stylesheets via `document.styleSheets` iteration
- Preloaded: check if font URL has matching `<link rel="preload" as="font">`
- FOIT/FOUT risk: fonts without `font-display: swap` or `optional` are FOIT risk
- Font loading impact: fonts blocking FCP (loaded before first paint)

**Render-blocking detection** (via `page.evaluate()`):
- Sync scripts: `<script>` in `<head>` without `async`, `defer`, or `type="module"` attributes
- Blocking stylesheets: `<link rel="stylesheet">` without `media="print"` or other non-blocking media query
- Chrome 105+ `renderBlockingStatus`: use Resource Timing API's `renderBlockingStatus` field when available

**Files to create:** `src/perf-audit/resource-analyzer.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `analyzeResources(networkEntries, page)` returns categorized resources with per-type count, total size, largest file
- [ ] Image audit detects: PNG/JPG serving (when WebP/AVIF available), missing `width`/`height` attributes, missing `loading="lazy"` on below-fold images, missing `fetchpriority` on LCP candidates, `srcset` usage, oversized images (natural > 2x display)
- [ ] Font audit returns per-font: family, weight, `font-display` value, preloaded (yes/no), FOIT/FOUT risk assessment
- [ ] Render-blocking detection finds sync `<script>` without async/defer in `<head>` AND blocking `<link rel="stylesheet">` without non-blocking media
- [ ] Resource categorization uses URL extension for type + groups third-party by domain with per-domain size
- [ ] Handles pages with zero resources gracefully (empty categories with zero counts, not errors)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-012: Create DOM complexity and correlation utilities

Create `src/perf-audit/dom-analysis.ts` with two functions:

**1. `analyzeDOMComplexity(page): Promise<DOMComplexityReport>`**
- Total node count: `document.querySelectorAll('*').length`
- Max tree depth: recursive walk measuring deepest nesting level
- Largest subtree: element with most descendant nodes + its tag/id/class
- Document HTML size in KB
- Flag: node count > 1500 (warning), > 3000 (critical) per Google recommendations

**2. `buildCorrelationReport(webVitals, resources, infrastructure): CorrelationReport`**
Connects metrics to root causes:

**LCP correlation chain:**
- LCP element (from web vitals) → find its network entry (from resources) → identify what blocked it (render-blocking CSS/JS from resources) → measure the full chain:
  - "LCP is `<img src='hero.jpg'>` (420KB PNG, no fetchpriority)"
  - "Blocked by: styles.css (render-blocking, 240KB) → Inter-Bold.woff2 (font load, 85KB)"
  - "Critical path: DNS(42ms) → CSS(styles.css, 180ms) → Font(Inter, 120ms) → Image(hero.jpg, 340ms) → LCP(3800ms)"

**CLS source attribution:**
- Each layout shift → source element → reason (ad injection, font swap, image without dimensions, dynamic content insertion)

**Long Task → script attribution:**
- Each long task → script URL (from `containerSrc`) → domain (first-party or third-party name) → blocking duration
- Per-domain TBT contribution: "facebook.net: 220ms TBT across 1 long task"

**Font → FCP correlation:**
- Fonts loaded before FCP → potential FOIT/FOUT blocking
- Fonts without `font-display: swap` that loaded before FCP → "Font 'Inter' blocked FCP for 120ms"

**Files to create:** `src/perf-audit/dom-analysis.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `analyzeDOMComplexity(page)` returns `{ totalNodes, maxDepth, largestSubtree: { tag, id?, descendants }, htmlSizeKB }`
- [ ] DOM node count > 1500 flagged as warning, > 3000 as critical (matching Google recommendations)
- [ ] LCP correlation: if LCP element is an image, report includes: the image's network entry (size, duration), render-blocking resources that delayed it, reconstructed critical path with timing
- [ ] Long Task attribution: each long task mapped to script URL and domain with per-domain TBT contribution
- [ ] CLS attribution: each shift source identified with reason (font swap, image dimensions, dynamic content)
- [ ] Font → FCP correlation: identifies fonts that loaded before FCP without font-display:swap

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-010, TASK-011
**Priority:** P1

---

### TASK-013: Create perf-audit orchestrator

Create `src/perf-audit/index.ts` that ties together all analysis modules into a single `runPerfAudit(bm, networkEntries?, options?)` function.

**Orchestration flow:**
1. Save current URL and cookies (for recovery on failure)
2. Inject web vitals init script via `context.addInitScript()` (stacks with existing init scripts)
3. If `options.includeCoverage !== false`: call `bm.startCoverage()`
4. Reload page: `page.reload()`, wait for `page.waitForLoadState('networkidle')`, then wait 1s settle for observers to collect
5. Collect web vitals via `collectWebVitals(page)`
6. Collect resources via `analyzeResources(networkEntries, page)`
7. Collect DOM complexity via `analyzeDOMComplexity(page)`
8. If `options.includeDetection !== false`: call `detectStack(page, networkEntries)` (from detection module)
9. If coverage was started: call `bm.stopCoverage()`
10. Build correlation report via `buildCorrelationReport(webVitals, resources, infrastructure)`
11. Assemble `PerfAuditReport` with all sections
12. Clean up: remove the web vitals init script (set back to previous or null)

**Options:** `{ includeCoverage?: boolean, includeDetection?: boolean }` (both default true)

**Return type:** `PerfAuditReport` containing: webVitals, resources, domComplexity, correlations, detection (optional), coverage (optional)

**Error recovery:** If any step fails after reload, catch the error, attempt to navigate back to saved URL, and return partial results with error field indicating what failed.

**Files to create:** `src/perf-audit/index.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `runPerfAudit(bm)` injects observers, reloads page, collects web vitals, analyzes resources, detects stack, builds correlations — all in one call
- [ ] LCP correlation present: if LCP is an image, report includes the image's network entry and render-blocking chain
- [ ] When `includeCoverage: true`, runs coverage alongside and includes unused code in report
- [ ] When `includeCoverage: false`, skips coverage (faster audit — no coverage start/stop)
- [ ] Report includes `fixable` vs `platformLimitation` arrays when a SaaS platform is detected
- [ ] Works correctly on a page that was already loaded (reload-based measurement)
- [ ] On failure after reload: returns partial results with error field, does not crash

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-009, TASK-010, TASK-011, TASK-012
**Priority:** P1

---

### TASK-014: Create perf-audit report formatter with platform-aware recommendations

Create `src/perf-audit/formatter.ts` that takes a `PerfAuditReport` and produces human-readable text output (default) and JSON output (when `--json` flag is set).

**Text output sections:**

1. **Core Web Vitals** — with Google's thresholds:
   - LCP: good <2500ms, needs improvement <4000ms, poor >=4000ms
   - CLS: good <0.1, needs improvement <0.25, poor >=0.25
   - INP: good <200ms, needs improvement <500ms, poor >=500ms
   - FCP: good <1800ms, needs improvement <3000ms, poor >=3000ms
   - TTFB: good <800ms, needs improvement <1800ms, poor >=1800ms
   - TBT: good <200ms, needs improvement <600ms, poor >=600ms
   - Each with pass/fail marker (good/needs-improvement/poor)

2. **LCP Analysis** — element, size, blocking chain, critical path reconstruction

3. **Layout Shifts** — each shift with source element, magnitude, reason

4. **Long Tasks** — each task with script URL, domain, duration, per-domain TBT summary

5. **Resource Breakdown** — per-type table (JS/CSS/Images/Fonts/Media/API/Other) with count, total size, largest

6. **Render-Blocking Resources** — list of blocking scripts and stylesheets with sizes

7. **Coverage Summary** (if collected) — per-file used/unused with totals

8. **Image Audit** — format issues, missing dimensions, missing lazy-load, oversized, missing fetchpriority, srcset usage

9. **Font Audit** — per-font: family, font-display value, preloaded, FOIT/FOUT risk

10. **DOM Complexity** — node count, depth, largest subtree

11. **Stack Detection** (if collected) — frameworks with version/config, SaaS with apps, infrastructure with CDN/protocol/compression/caching

12. **Third-Party Impact** — per-domain: category, script count, size, Long Task contribution

13. **Fixable vs Platform Constraints** (when SaaS detected):
    ```
    FIXABLE (you control this):
      ✗ Hero image 420KB PNG → convert to WebP, add fetchpriority="high"
      ✗ 3 unused Shopify apps loaded on this page
      ✗ Missing font-display:swap on Inter font

    PLATFORM LIMITATION (cannot change):
      ⚠ Shopify platform JS 200KB (unavoidable)
      ⚠ Shopify checkout performance
    ```

14. **Top Recommendations** — 3-5 prioritized, actionable items based on data and detected platform:
    - **Platform-specific recommendations when SaaS detected:**
      - Shopify: "Remove Bold Subscriptions app from non-cart templates (-80KB)", "Audit Vitals app overlap with Judge.me (-65KB)"
      - WordPress: "Deactivate Contact Form 7 on non-contact pages (-32KB)", "Disable WooCommerce cart-fragments on non-shop pages"
      - Magento: "Enable JS bundling in Stores > Configuration > Advanced > Developer (-2.3s waterfall)", "Reduce customer-data sections"
      - Wix: "Platform runtime is 1MB+ JS — this is a Wix constraint. Focus on image optimization and content structure."
    - **Generic recommendations when no SaaS:**
      - "Convert hero.jpg from PNG to WebP (-335KB estimated savings)"
      - "Add `fetchpriority='high'` to LCP image"
      - "Code-split vendor.js (462KB unused / 68%)"

**JSON output:** Valid JSON with all sections as structured objects. Same data, no formatting.

**Files to create:** `src/perf-audit/formatter.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Text output uses clear section headers, alignment, and pass/fail markers (good/needs-improvement/poor)
- [ ] Web Vitals thresholds match Google's standards exactly: LCP good <2.5s, CLS good <0.1, INP good <200ms, FCP good <1.8s, TTFB good <800ms
- [ ] JSON output is valid JSON with all sections as structured objects (parseable by Claude for automated fixing)
- [ ] Top Recommendations produces 3-5 prioritized, actionable items based on actual measured data (not generic advice)
- [ ] When Shopify detected: recommendations include app-specific removal suggestions with estimated size savings
- [ ] When WordPress detected: recommendations include plugin-specific deactivation suggestions
- [ ] When Magento detected: recommendations include RequireJS bundling and customer section reduction
- [ ] When no SaaS detected: recommendations are generic but data-driven (compress this image, code-split this bundle)
- [ ] Fixable vs Platform Constraints section only appears when SaaS platform detected

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-013
**Priority:** P1

---

### TASK-015: Add `detect` meta command

Add `detect` as a meta command in `src/commands/meta.ts`. Calls `detectStack(page)` from `src/detection/index.ts` via lazy import (`await import('../detection')`). Formats output with clear sections.

Register in META_COMMANDS (`src/server.ts:162`), SAFE_TO_RETRY (`src/cli.ts:415`), and CLI help.

Output format:
```
Stack:
  Framework:    React 18.2.0 (production, concurrent, 1 root)
  Meta:         Next.js 14.1.0 (App Router, ISR, __NEXT_DATA__ 124KB)
  Build:        Webpack 5 (12 chunks, source maps exposed)
  State:        Redux (847KB serialized store)
  CSS:          Tailwind CSS (purged, 42KB)

Infrastructure:
  CDN:          Cloudflare (cache: HIT)
  Protocol:     h2 (95% of resources)
  Compression:  brotli (JS 92%, CSS 100%, Images 0%)
  Cache rate:   78% of resources cached
  DNS origins:  7 unique (5 missing preconnect)
  Service Worker: active (stale-while-revalidate, navigation preload enabled)
  DOM:          3,842 nodes, depth 28, largest: .product-grid (1,200 nodes)

Third-Party (397KB total):
  facebook.net     95KB   2 scripts   ads
  doubleclick.net  68KB   5 requests  ads
  hotjar.com       52KB   1 script    monitoring
  intercom.io     140KB   1 script    chat
  google-analytics 42KB   3 requests  analytics
```

**Files to modify:** `src/commands/meta.ts`, `src/server.ts`, `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse detect` returns detected frameworks (with version, config depth), SaaS platforms (with apps), infrastructure details, and third-party inventory
- [ ] Output structured with clear sections: Stack, Infrastructure, Third-Party
- [ ] Works on plain HTML page with no framework (returns "No framework detected" + infrastructure details)
- [ ] `detect` registered in META_COMMANDS, SAFE_TO_RETRY, and CLI help
- [ ] Uses lazy import for detection module (doesn't slow server startup)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-009
**Priority:** P1

---

### TASK-016: Add `perf-audit` meta command

Add `perf-audit` as a meta command in `src/commands/meta.ts`. Accepts optional `[url]` argument (navigates first if provided). Supports flags: `--no-coverage` (skip coverage — faster), `--no-detect` (skip stack detection), `--json` (JSON output).

Register in META_COMMANDS (`src/server.ts:162`) and CLI help. NOT in SAFE_TO_RETRY (it reloads the page — write side effect).

Uses `runPerfAudit()` from `src/perf-audit/index.ts` and `formatPerfAudit()` from `src/perf-audit/formatter.ts` via lazy imports.

**Files to modify:** `src/commands/meta.ts`, `src/server.ts`, `src/cli.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse perf-audit` runs full audit on current page and returns formatted report with all sections
- [ ] `browse perf-audit https://example.com` navigates first, then audits
- [ ] `--no-coverage` flag skips coverage collection (audit runs faster, no Coverage section in output)
- [ ] `--no-detect` flag skips stack detection (no Stack Detection section)
- [ ] `--json` flag returns JSON instead of formatted text
- [ ] `perf-audit` registered in META_COMMANDS, CLI help, and NOT in SAFE_TO_RETRY
- [ ] Uses lazy imports for perf-audit modules

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-013, TASK-014
**Priority:** P1

---

### TASK-017: Test — initscript command

Integration tests for the `initscript` command using the shared BrowserManager test setup.

**Files to create:** `test/perf-audit.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test verifies: set script → navigate → `page.evaluate()` confirms script ran
- [ ] Test verifies: `clear` removes the script — navigate → confirm not running
- [ ] Test verifies: `show` returns the current script text
- [ ] Test verifies: script persists across context recreation (`emulate` device then check)
- [ ] Test verifies: init script coexists with another `addInitScript()` call (both execute)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P2

---

### TASK-018: Test — coverage command

Integration tests for coverage. Creates a test fixture with known JS that has dead code branches.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/coverage-test.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test verifies: coverage collection on page with inline JS that has if/else where one branch never runs → unused % > 0
- [ ] Test verifies: CSS coverage on page with unused CSS rules → unused % > 0
- [ ] Test verifies: `stop` without `start` returns clear error, not crash
- [ ] Fixture has deliberately unused JS function and unused CSS class for deterministic testing

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-004, TASK-017
**Priority:** P2

---

### TASK-019: Test — framework detection

Integration tests for framework detection. Create fixtures simulating framework globals.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/detect-react.html`, `test/fixtures/detect-nextjs.html`, `test/fixtures/detect-jquery.html`, `test/fixtures/detect-multi.html`, `test/fixtures/detect-plain.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] `detect-react.html` sets `__REACT_DEVTOOLS_GLOBAL_HOOK__` with renderers → detects React with version
- [ ] `detect-nextjs.html` sets `__NEXT_DATA__` with buildId and large props → detects Next.js with payload size
- [ ] `detect-jquery.html` sets `window.jQuery` with version → detects jQuery with plugin count
- [ ] `detect-multi.html` sets React + jQuery + GTM globals → detects all three simultaneously
- [ ] `detect-plain.html` has no framework globals → returns empty frameworks array (no false positives)
- [ ] All fixtures register routes in test-server.ts

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-015
**Priority:** P2

---

### TASK-020: Test — SaaS detection

Integration tests for SaaS detection with platform-specific fixtures.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/detect-shopify.html`, `test/fixtures/detect-wordpress.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] `detect-shopify.html` sets `window.Shopify` with theme config → detects Shopify with theme name, has canFix/cannotFix arrays
- [ ] `detect-wordpress.html` sets WordPress globals + includes `/wp-content/plugins/` script tags → detects WordPress with plugin names extracted
- [ ] Constraint arrays are non-empty for both platforms
- [ ] No false positive SaaS detection on `detect-plain.html`

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-015
**Priority:** P2

---

### TASK-021: Test — infrastructure detection

Integration tests for infrastructure detection on the local test server.

**Files to modify:** `test/perf-audit.test.ts`

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Protocol detection returns a value (h1.1 for local test server)
- [ ] CDN detection returns null for localhost
- [ ] Compression analysis doesn't crash on uncompressed local responses
- [ ] DOM complexity returns node count > 0 and max depth > 0
- [ ] Service Worker detection returns `registered: false` for test page

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-015
**Priority:** P2

---

### TASK-022: Test — resource analyzer + DOM complexity

Tests for resource analysis with real browser data and mock data.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/perf-resources.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Fixture with inline CSS, inline JS, external script, and `<img>` elements → resource categorization returns correct types and counts
- [ ] Image audit: fixture has `<img>` without width/height → detected as "missing dimensions"
- [ ] Image audit: fixture has `<img>` without `loading="lazy"` below fold → detected
- [ ] Render-blocking: fixture has sync `<script>` in `<head>` → detected as render-blocking
- [ ] Font audit: fixture with @font-face without font-display → FOIT risk detected
- [ ] DOM complexity: returns node count matching fixture's element count
- [ ] Empty page (about:blank) returns zeroed categories, not errors

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-011, TASK-012
**Priority:** P2

---

### TASK-023: Test — perf-audit full integration

End-to-end test for `perf-audit` command.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/perf-heavy.html`

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] `perf-heavy.html` fixture has: sync script in head (render-blocking), images without dimensions (CLS trigger), inline JS with setTimeout (Long Task simulation), multiple external resources
- [ ] Test verifies perf-audit output contains Core Web Vitals section with numeric values
- [ ] Test verifies Resource Breakdown section with at least JS and Image categories populated
- [ ] Test verifies render-blocking detection identifies the sync script from fixture
- [ ] Test verifies `--no-coverage` produces output without Coverage section
- [ ] Test verifies `--no-detect` produces output without Stack Detection section
- [ ] Test verifies LCP correlation: LCP element is identified and linked to its resource

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-016
**Priority:** P2

---

### TASK-024: Test — correlation engine + edge cases

Tests for the correlation engine and detection edge cases.

**Files to modify:** `test/perf-audit.test.ts`
**Files to create:** `test/fixtures/detect-tailwind.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Long Task attribution: fixture with inline script that does a blocking loop → Long Task detected with script attribution
- [ ] CSS-only detection: `detect-tailwind.html` has Tailwind utility classes, no JS framework → detects Tailwind without false-positive JS framework detection
- [ ] DOM complexity: fixture with deeply nested divs → max depth correctly measured
- [ ] Correlation engine doesn't crash when web vitals return null values (no LCP, no CLS, no Long Tasks)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-012, TASK-019
**Priority:** P2

---

### TASK-025: Update CLAUDE.md and exports reference

Update project documentation with new commands, files, functions, types.

**Files to modify:** `CLAUDE.md`, `.claude/claude-md-refs/exports-reference.md`, `.claude/claude-md-refs/architecture.md`

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] CLAUDE.md lists `initscript`, `coverage`, `detect`, `perf-audit` in correct command categories with descriptions
- [ ] CLAUDE.md Command Categories updated: Write +1 (initscript), Meta +3 (coverage, detect, perf-audit)
- [ ] exports-reference.md lists all new source files (`src/detection/*`, `src/perf-audit/*`), exported functions, types, and classes
- [ ] architecture.md includes perf-audit system in the dependency graph and adds a "Performance Audit System" section

**Agent:** general-purpose

**Depends on:** TASK-016
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Init script conflicts with domain filter init script | TASK-001, TASK-010 | Both use IIFE pattern. Domain filter wraps WebSocket/EventSource in IIFE. Web vitals observers store on `window.__BROWSE_PERF_METRICS` namespace. Test both active simultaneously in TASK-017. |
| Coverage API unavailable in headless mode | TASK-003, TASK-004 | Playwright Coverage API works in Chromium headless (confirmed). Test early in TASK-003. If unavailable, `startCoverage()` throws clear error and perf-audit skips coverage gracefully. |
| Framework detection false positives | TASK-006, TASK-007 | Each detector verifies presence (React hook must have renderers with size > 0, not just exist). Each detection wrapped in try/catch. Test with plain HTML fixture in TASK-019. |
| Large detection module slows server startup | TASK-006, TASK-007 | Use lazy imports (`await import('../detection')`) in command handlers. Detection modules only loaded when detect/perf-audit commands are called. |
| PerformanceObserver entries lost before collection | TASK-010 | All observers use `buffered: true`. Collection waits for `loadState('networkidle')` + 1s settle. Init script uses IIFE so it runs synchronously before any page JS. |
| Page state changed after perf-audit reload | TASK-013 | Orchestrator saves URL and cookies before reload. On failure: attempts to navigate back to saved URL. Documents that perf-audit reloads the page. Returns partial results with error field. |
| NetworkEntry missing size for some requests | TASK-011 | Resource analyzer uses Resource Timing API (`performance.getEntriesByType('resource')`) as primary data source for sizes (has `transferSize`, `encodedBodySize`). NetworkEntry is secondary for timing/status. |
| Context recreation clears coverage state | TASK-003 | `coverageActive` flag resets to `false` on context recreation. Clear error message if user tries `coverage stop` after emulation change: "Coverage was reset by device emulation. Start coverage again." |
| Resource Timing API buffer overflow | TASK-008, TASK-011 | Chrome's Resource Timing buffer defaults to 250 entries. For pages with >250 resources, some entries may be missing. Mitigate by calling `performance.setResourceTimingBufferSize(500)` in the init script. |
| Third-party domain classification stale | TASK-009 | Known domain list is static — new analytics/ad services won't be classified. Accept "other" as fallback. Can update list in future versions. |
| Detection takes too long on complex pages | TASK-006, TASK-007 | All detections run in single `page.evaluate()` call. Each wrapped in try/catch with short-circuit. Target <200ms total. If >500ms, log warning. |
| SaaS app enumeration inaccurate | TASK-007 | App detection relies on script URL patterns. Unknown apps show as "unknown-app (domain.com)". Known app domain list covers top 50 Shopify/WordPress apps. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| initscript set/clear/show | TASK-017 | integration |
| initscript coexistence with domain filter | TASK-017 | integration |
| coverage start/stop lifecycle | TASK-018 | integration |
| coverage on page with dead code | TASK-018 | integration |
| framework detection (108 signatures) | TASK-019 | integration |
| multi-framework simultaneous detection | TASK-019 | integration |
| SaaS detection with app enumeration | TASK-020 | integration |
| SaaS constraint mapping | TASK-020 | integration |
| infrastructure fingerprinting (CDN, protocol, compression) | TASK-021 | integration |
| DOM complexity (node count, depth, subtree) | TASK-022 | integration |
| resource categorization (JS/CSS/image/font) | TASK-022 | integration |
| image audit (dimensions, lazy, format, srcset, fetchpriority) | TASK-022 | integration |
| font audit (font-display, preload, FOIT) | TASK-022 | integration |
| render-blocking detection | TASK-022 | integration |
| Long Task script attribution | TASK-024 | integration |
| CSS-only framework detection (no false positive) | TASK-024 | integration |
| correlation engine (LCP chain, CLS sources, TBT by domain) | TASK-024 | integration |
| perf-audit full orchestration (inject → reload → collect) | TASK-023 | e2e |
| perf-audit --no-coverage and --no-detect flags | TASK-023 | e2e |
| report formatting (text + JSON) | TASK-023 | e2e |
| platform-specific recommendations (Shopify/WordPress/Magento) | TASK-023 | e2e |
| fixable vs platform constraints separation | TASK-023 | e2e |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": ["TASK-003"],
  "TASK-005": ["TASK-004"],
  "TASK-006": [],
  "TASK-007": [],
  "TASK-008": [],
  "TASK-009": ["TASK-006", "TASK-007", "TASK-008"],
  "TASK-010": [],
  "TASK-011": [],
  "TASK-012": ["TASK-010", "TASK-011"],
  "TASK-013": ["TASK-009", "TASK-010", "TASK-011", "TASK-012"],
  "TASK-014": ["TASK-013"],
  "TASK-015": ["TASK-009"],
  "TASK-016": ["TASK-013", "TASK-014"],
  "TASK-017": ["TASK-001"],
  "TASK-018": ["TASK-004", "TASK-017"],
  "TASK-019": ["TASK-015"],
  "TASK-020": ["TASK-015"],
  "TASK-021": ["TASK-015"],
  "TASK-022": ["TASK-011", "TASK-012"],
  "TASK-023": ["TASK-016"],
  "TASK-024": ["TASK-012", "TASK-019"],
  "TASK-025": ["TASK-016"]
}
```
