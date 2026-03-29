# Changelog

## v2.3.3

**Publish fixes:**

- `browse enable android|ios|macos|all` — one command to verify/build native drivers
- Pre-built binaries ship in `bin/` (browse-ax, Android APKs, iOS runner source)
- `enable` checks pre-built first, only builds from source if missing
- Fixed native binary path resolution for npm global installs (dev vs bundled paths)
- `build:all` script builds all native components alongside Node.js bundle
- Package includes iOS runner source, Android APKs, macOS browse-ax binary

## v2.3.0

**Simulator lifecycle and zero-setup native app automation:**

**Simulator/Emulator management:**
- `browse sim start --platform ios|android --app <id> [--visible]` — boot, launch app, start driver
- `browse sim stop --platform ios|android` — clean shutdown (kills emulator on Android, stops runner on iOS)
- `browse sim status --platform ios|android` — health and connection info
- `--visible` flag opens the simulator/emulator window (default: headless)
- iOS app switching: reconfigures runner in-place via `/configure` without restarting
- Android app switching: restarts driver with new target, keeps emulator running

**Android zero-setup bootstrap:**
- Auto-installs entire Android toolchain when missing: adb, JDK 21, Android SDK, emulator, system image, AVD
- All via Homebrew on macOS — single `sim start` command from blank machine to running emulator
- Build-tools, platform, and system image auto-installed via sdkmanager
- Driver APK auto-built from source when gradlew is available

**iOS runner fixes:**
- `ConfigureHandler` calls `.activate()` on target app — fixes runner crash on app switch
- Coordinate-based swipe (`press+drag`) instead of `element.swipeUp()` — reliably scrolls WebViews
- Smart swipe target: auto-finds first scrollable descendant (webView, scrollView, table)

**macOS bridge improvements:**
- Coordinate-based click fallback when `AXPress` isn't supported (sidebar items, static text)
- Modifier key combos: `cmd+n`, `cmd+shift+s`, `ctrl+c` via CGEvent
- Text element labels: uses value for AXStaticText/AXCell when title/description are missing
- `walkToElement` falls back to app element when no window exists (menu bar interactions)

**Android driver fixes:**
- INTERNET permission + `usesCleartextTraffic` in manifest — fixes EPERM on server socket
- WebView tree: `UiDevice.getWindowRoots()` via reflection + invisible-node workaround inside WebViews
- `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS` for broader tree coverage
- Smart scroll target: finds deepest scrollable node instead of using root
- Friendly boundary messages: "Already at top" instead of "scrollForward returned false"

**Cross-platform alignment:**
- All three platforms expose: `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `swipe`, `screenshot`
- Standardized `targetType` to `'app'` across macOS, iOS, Android (was `'android-app'`)
- `read.ts` dispatch fixed for all app targets (was only checking `'app'`)
- Interactive snapshot shows labeled children of clickable containers (fixes Android Settings)
- `normalize.ts` strips `AXAndroid:` prefix from role names for cleaner output

## v2.2.1

**Unified flows, recording, and replay** — recording is the canonical capture model:

- Flow and chain sub-steps now route through `executeCommand()` with lifecycle hook forwarding
- Recording captures individual flow/chain sub-steps, not the wrapper command (`skipRecording` on flow/chain/retry/watch)
- `record export flow [path]` — new YAML export format, round-trips with `flow <file>`
- Flows work on all `AutomationTarget` types (browser, Android, iOS, macOS) — each step capability-gated
- `retry` and `watch` marked `targetSupport: 'browser'` — proper executor errors on app targets
- `record export replay` and `record export playwright` blocked on non-browser sessions with clear error
- `har` and `video` commands blocked on non-browser sessions with clear error
- `CommandContext.lifecycle` field threads transport hooks into nested execution
- `findProjectRoot()` exported from config — flows dir resolves relative to project root, never `/tmp`
- `Session.lastRecording` typed field replaces untyped `_lastRecording` hack
- `RecordedStep` deduplicated — single source in `src/export/record.ts`
- 46 new tests (unified-flows.test.ts) covering all new codepaths

## v2.2.0

**Project-local extensibility** — custom rules, detections, and flows from project config:

- Custom audit rules — load declarative JSON rules from `.browse/rules/*.json` or `browse.json` `rulePaths`
  - `metric-threshold`: perf-audit metrics (e.g., LCP must be under 2000ms)
  - `selector-count`: a11y-audit DOM validation (e.g., max images without alt)
  - Configurable severity (critical/warning), evaluated alongside built-in checks
- Custom detection signatures — load from `.browse/detections/*.json` or `browse.json` `detectionPaths`
  - Define `detect` JS expression, optional `versionExpr`, custom category
  - Results included in `detect` output alongside built-in framework/SaaS fingerprints
- Saved flows — `flow save <name>` / `flow run <name>` / `flow list` from `.browse/flows/` or `browse.json` `flowPaths`
- `browse.json` config: `detectionPaths`, `rulePaths`, `flowPaths`, `startupFlows`

## v2.1.0

**Workflow commands and SDK mode:**

- `flow <file.yaml>` — execute YAML automation scripts with steps, variables, conditionals
- `retry` — retry last failed command with backoff until condition met
- `watch` — watch DOM element for changes, optionally trigger callback
- SDK mode (`src/sdk.ts`) — programmatic API for embedding browse in Node.js applications
  - `createBrowser()` returns direct Playwright access — no HTTP server
  - Methods: `goto`, `text`, `html`, `click`, `fill`, `type`, `press`, `snapshot`, `screenshot`, `evaluate`, `close`

## v2.0.0

**Native app automation** — automate Android, iOS, and macOS apps through the same CLI:

**Android automation:**
- On-device instrumentation driver (`browse-android/`) — Kotlin NanoHTTPD server running as an Android instrumentation test
- Accessibility tree traversal via `UiAutomation` + `AccessibilityNodeInfo`, scoped to target package
- Full protocol: `/health`, `/tree`, `/action`, `/setValue`, `/type`, `/press`, `/screenshot`, `/state`
- Character-by-character key injection with clipboard-paste fallback for Unicode
- Host bridge with retry logic, stale instrumentation cleanup, port-forward lifecycle management
- `AndroidAppManager` implements `AutomationTarget` — same command surface as browser
- 24 mocked contract tests covering all protocol methods and error paths

**iOS automation:**
- iOS Simulator bridge via runner app + `simctl`
- `IOSAppManager` with snapshot, tap, fill, type, press, screenshot
- Simulator lifecycle: boot, install, launch, terminate, permissions, media, status bar
- Role normalization from iOS accessibility roles to AX-style roles

**macOS app automation:**
- Swift bridge binary (`browse-ax`) — communicates with macOS Accessibility API
- `AppManager` with snapshot, tap, fill, type, press, screenshot
- Auto-prompts Accessibility permission dialog on first use

**Unified platform surface:**
- `--platform android|ios|macos --app <name> --device <serial>` — single CLI entry point
- `SessionTargetFactory` abstraction — browser, Android, iOS, macOS targets created through same factory
- Capability gating — commands requiring `navigation`, `tabs`, or `javascript` blocked with clear errors on app targets
- `@ref` system works identically across all platforms
- MCP tools auto-register from registry — no platform-specific MCP namespaces

**App target infrastructure:**
- `AutomationTarget` interface (5 methods) + `TargetCapabilities` flags
- `AppNode` / `AppState` normalized types — platform bridges provide raw data, browse owns semantics
- `assignRefs()` / `extractText()` shared across all app platforms
- Tree normalization with role mapping (Android class names → AX roles, iOS roles → AX roles)

**Doctor diagnostics:**
- `browse doctor` now shows Android diagnostics: adb version, connected devices, AVDs, driver APK status
- `browse doctor --platform android` for focused output
- macOS app bridge check preserved

**Build pipeline:**
- `scripts/build-all.sh` builds Android instrumentation APK alongside Node.js bundle
- APK auto-resolved from local build, installed package, or lazy-download location

## v1.7.0

**Visual analysis and accessibility audit:**
- `visual` — visual layout inspection (spacing, alignment, overflow detection)
- `a11y-audit` — accessibility audit (WCAG violations, missing labels, contrast issues)
- `layout` — full computed layout with contrast ratio for any element

## v1.6.0

**Assertions, budgets, and export:**
- `expect <expression>` — assertion command with parser for text/element/attribute/count/url/title checks
- `perf-audit --budget <file>` — performance budgets with pass/fail per metric
- `wait --request <pattern>` — wait for a specific network request
- Playwright export format for recorded sessions
- MCP registration for all new commands

## v1.5.2

**Network body capture and API discovery:**
- `--network-bodies` flag / `BROWSE_NETWORK_BODIES=1` — capture request/response bodies (256KB per entry limit)
- `request <url-pattern>` — inspect captured request/response for a specific URL
- `api` — list discovered API endpoints from network traffic
- Guarded write behavior — write commands wait for network + DOM to settle before returning
- Settle mode — configurable via `browse set settle on|off`
- HAR recording now includes request/response bodies when capture is enabled

## v1.5.1

**Domain architecture closeout** — final pre-roadmap structural refactor:

- 9 domain directories: `automation/`, `browser/`, `commands/meta/`, `engine/`, `export/`, `mcp/`, `network/`, `security/`, `session/`
- `AutomationTarget` interface + `BrowserTarget` (48-method capability interface)
- `SessionTargetFactory` decouples session creation from `BrowserManager`
- `CommandDefinition` with `execute()` — registry owns both metadata and dispatch
- `executeCommand()` is the sole execution path for HTTP and MCP transports
- CLI help generated from registry metadata (no hand-maintained inventory)
- MCP tool definitions and arg decoding derived from registry (no switch, no static arrays)
- `src/mcp/index.ts` is the canonical MCP public module
- Anti-drift guard scripts (`check-architecture-drift.mjs`, `check-legacy-imports.mjs`)
- 530 tests, 31 architecture tests, `tsc --noEmit` clean
- Roadmap file paths synced to canonical domain structure
- All 99 CLI commands verified end-to-end against mumzworld.com

## v1.5.0

**Snapshot context** — ARIA delta and full snapshot after write commands:

- `--context delta` appends ARIA diff with refs: `[snapshot-delta] +2 -1 =12` + added/removed elements
- `--context full` appends complete ARIA snapshot with fresh refs — eliminates snapshot→action→snapshot round-trip
- `--context state` (or `--context` with no value) retains existing behavior (page state changes only)
- `browse set context off|state|delta|full` — per-session level toggle
- `BROWSE_CONTEXT=delta|full` env var, `X-Browse-Context: delta|full` header
- MCP: `browse_set` tool now supports `context` subcommand for level switching
- Refs from delta/full output are immediately usable for the next action
- Falls back to full when no baseline snapshot exists (first write in delta mode)
- 20 new tests (14 integration + 6 MCP)

## v1.4.5

**Action context** — enriched write command responses that show what changed:

- `--context` CLI flag, `BROWSE_CONTEXT=1` env var, or `browse.json` config to opt in
- `browse set context on/off` — per-session toggle at runtime
- `X-Browse-Context: 1` header for HTTP server
- Always-on in MCP mode (agents always benefit from context)
- Write commands append a compact `[context]` line: `[context] → /checkout | title: "Order Summary" | errors: +2`
- Reports: URL change (pathname only), title change, dialog appeared/dismissed, tab count change, console errors
- O(1) state capture via running counters on SessionBuffers
- Zero overhead when disabled
- 11 new tests (8 integration + 3 MCP)

## v1.4.4

**Audit persistence and comparison** — save audit reports for later comparison and regression detection:

- `perf-audit save [name]` — run audit and save report to `.browse/audits/` (auto-generates name from URL hostname + date if omitted)
- `perf-audit compare <baseline> [current]` — compare saved audit against current page (live) or another saved audit, with regression/improvement detection
- `perf-audit list` — list saved audit reports with name, size, and date
- `perf-audit delete <name>` — delete a saved audit report
- Regression thresholds aligned with Web Vitals "good" boundaries (TTFB +100ms, LCP +200ms, CLS +0.05, TBT +100ms, INP +50ms)
- Diff output shows per-metric deltas with ↑/↓ arrows and summary verdict
- MCP tools: `browse_perf_audit_save`, `browse_perf_audit_compare`, `browse_perf_audit_list`, `browse_perf_audit_delete`

## v1.4.3

- Added `perf-audit`, `detect`, `coverage`, `initscript`, `scrollintoview` to MCP server — 99/99 CLI commands now have MCP tool definitions (zero gap)
- Added `docs/supported-technologies.md` — reference list of all 162 detected technologies (107 frameworks, 55 SaaS platforms, 88 third-party domains)
- Added `homepage` field to package.json for npmjs.com

## v1.4.0 — Performance Audit System

**4 new commands** for web performance analysis:

**`perf-audit [url]`** — full performance audit in one command:
- Core Web Vitals (LCP, CLS, TBT, FCP, TTFB, INP) with Google's good/needs-improvement/poor thresholds
- LCP critical path reconstruction — traces the blocking chain from TTFB through render-blocking CSS/JS to the LCP element
- Layout shift attribution — each shift traced to font swap, missing image dimensions, ad injection, or dynamic content
- Long task script attribution — maps each blocking task to its source script URL and domain, with per-domain TBT
- Resource breakdown by type (JS, CSS, images, fonts, media, API) with sizes, counts, and largest files
- Render-blocking detection — sync scripts and blocking stylesheets in `<head>`
- Image audit — format (JPEG/PNG vs WebP/AVIF), missing width/height, missing lazy-load below fold, missing fetchpriority on LCP candidates, srcset usage, oversized images (natural > 2x display)
- Font audit — per-font font-display value, preload status, FOIT/FOUT risk assessment
- DOM complexity — node count, max depth, largest subtree (flags >1,500 and >3,000 thresholds)
- JS/CSS coverage — per-file used vs unused bytes via Playwright Coverage API
- Correlation engine — connects LCP to blocking CSS, Long Tasks to scripts, CLS to font swaps, fonts to FCP blocking
- Prioritized data-driven recommendations — platform-specific when SaaS detected (Shopify app removal, WordPress plugin deactivation, Magento RequireJS bundling)
- Flags: `--no-coverage` (skip coverage), `--no-detect` (skip detection), `--json` (structured output)
- Auto-handles analytics-heavy pages that never reach networkidle (10s race with fallback)
- Per-section status reporting — agents see exactly what succeeded, failed, or was skipped with timing breakdown

**`detect`** — tech stack fingerprint:
- 108 framework detection signatures across 12 categories: JS frameworks (React, Vue, Angular, Svelte, Solid, Qwik, Preact, Lit, Alpine, HTMX, Stimulus, Turbo, Ember, jQuery...), meta-frameworks (Next.js, Nuxt, SvelteKit, Remix, Astro, Gatsby...), PHP (Laravel/Livewire/Inertia, Symfony, WordPress, Drupal, Magento...), Python (Django, Flask, Streamlit, Dash...), Ruby (Rails, Phoenix LiveView...), Java/.NET (Spring Boot, Blazor, ASP.NET...), CSS (Tailwind, Bootstrap, MUI, Styled Components...), SSGs, mobile/hybrid, state management (Redux, MobX, Zustand...), build tools (Webpack, Vite, Turbopack...)
- Deep detection: version, build mode (dev/prod), config depth (Next.js `__NEXT_DATA__` payload size, Magento RequireJS module count, Laravel Livewire component count, WordPress plugin list from script URLs, Redux store size)
- 55 SaaS platform signatures: Shopify (theme, app enumeration with per-app sizing, Liquid render time), WordPress/WooCommerce (plugin list, cart-fragments detection), Magento (RequireJS waterfall, Knockout bindings, FPC status), Wix, Squarespace, Webflow, Bubble, and 48 more
- Fixable-vs-platform-constraint mapping for every SaaS platform
- Infrastructure: CDN detection (CloudFront, Cloudflare, Fastly, Akamai, Vercel, Netlify...), protocol breakdown (h2/h1.1 per-resource), compression per-type, cache hit rate, missing preconnect analysis, Service Worker caching strategy detection, DOM complexity
- Third-party inventory: 88 known domain classifications (analytics, ads, social, chat, monitoring, consent, CDN)
- All detections run in a single `page.evaluate()` call (<200ms)

**`coverage start|stop`** — JS/CSS code coverage:
- Wraps Playwright's Coverage API with `resetOnNavigation: false`
- Per-file used/unused bytes and percentages
- Sorted by wasted bytes descending
- Handles inline scripts, data URLs, and context recreation gracefully

**`initscript set|clear|show`** — pre-navigation script injection:
- Exposes `context.addInitScript()` as a CLI command
- IIFE-namespaced to coexist with domain filter init scripts
- Survives context recreation (emulate, useragent changes)

**Bug fixes:**
- Fixed esbuild `__name` injection crashing `page.evaluate()` calls — added browser-side polyfill for `__name` in all BrowserContext creation paths

## v1.3.2

- Fixed Chrome crash when using `--chrome` / `--runtime chrome` — Chrome validates profile integrity hashes against the data directory path, causing deliberate crashes when profile files are copied to a different location
- Solution: launch Chrome with a clean profile and auto-import cookies from the real Chrome profile via `cookie-import` (Keychain decryption)
- Cookies, login sessions, and cart state all preserved via programmatic import
- Works whether Chrome is running or not (quits existing Chrome if needed)

## v1.3.1 — Chrome Runtime & Replay Export

**Chrome runtime** (`--runtime chrome` or `--chrome`):
- Launch system Chrome with CDP instead of Playwright's Chromium
- Copies real Chrome profile on first launch — cookies, extensions, sessions preserved
- Excludes crash/session state files to prevent Chrome recovery dialogs
- Reuses Chrome's existing BrowserContext (user's cookies available immediately)
- `--chrome` is a shortcut for `--runtime chrome` (also implies `--headed`)
- Chrome opens normally after browse stops — no profile corruption

**Handoff to Chrome**:
- `handoff` now defaults to Chrome (bypasses Turnstile/bot detection)
- `handoff --chromium` for explicit fallback to Playwright Chromium
- `resume` kills Chrome process if handoff spawned one

**Replay export selector resolution**:
- `record export replay` resolves @e refs to real selectors (ARIA, CSS, XPath, text)
- `--selectors css,aria,xpath,text` flag to filter selector types in export
- Verified against `@puppeteer/replay` Schema.ts format

**Other**:
- Server startup error surfacing: CLI detects early process exit immediately
- Chrome runtime gets extended startup timeout (20s vs 8s)

## v1.2.1

- `--runtime <name>` CLI flag — select browser engine (playwright, rebrowser, lightpanda)
- Help text: added all 11 react-devtools subcommands, provider commands

## v1.2.0 — Cloud Providers

- `provider save/list/delete` — encrypted API key vault for cloud browsers
- `--provider browserless` — connect to Browserless (direct WebSocket)
- `--provider browserbase` — connect to Browserbase (REST API + CDP)
- API keys encrypted at rest (AES-256-GCM) — never visible to agents
- Browserbase session cleanup on server shutdown

## v1.1.2 — MCP Server Mode

- `--mcp` flag — run browse as a Model Context Protocol server over stdio
- Works with Cursor, Windsurf, Cline, and any MCP-compatible client
- All browse commands exposed as MCP tools
- Supports `--mcp --json` for JSON-wrapped responses

## v1.1.1

- `wait --download [path] [timeout]` — wait for download to complete (not just start), optionally save to path
- Updated skill structure with references (commands.md, guides.md, permissions.md)

## v1.1.0 — React DevTools Integration

- `react-devtools enable/disable` — on-demand React DevTools hook injection (lazy-downloaded, cached)
- `react-devtools tree` — component tree with indentation and Suspense status
- `react-devtools props <sel>` — inspect props, state, and hooks of any component
- `react-devtools suspense` — find pending Suspense boundaries
- `react-devtools errors` — find error boundaries and caught errors
- `react-devtools profiler` — render timing per component (requires profiling build)
- `react-devtools hydration` — hydration timing for Next.js apps
- `react-devtools renders` — track what re-rendered
- `react-devtools owners/context` — parent chain and context inspection
- 11 subcommands total, all work with @ref selectors

## v1.0.5 — Handoff (Human Takeover)

- `handoff [reason]` — swap to visible browser for user to solve CAPTCHA/MFA/OAuth
- `resume` — swap back to headless, returns fresh snapshot
- Two-step protocol: agent asks permission via AskUserQuestion, then hands off
- Server auto-suggests handoff after 3 consecutive command failures

## v1.0.4 — Bun CLI Shim (Performance)

- Auto-detect Bun for CLI execution — 40-60ms per command (vs 100-150ms with Node)
- Shell shim at `bin/browse`: uses Bun if installed, falls back to Node
- Server always spawns under Node for correct WebSocket/CDP handling
- Invisible to users — same `browse` command, just faster

## v1.0.3 — CJS Bundle (Performance Fix)

- Switched from ESM (.mjs) to CJS (.cjs) bundle — **30x faster CLI startup**
- ESM: ~350-550ms per command (Node ESM module resolution overhead)
- CJS: ~100-150ms per command (back to Bun-level speed)
- `import.meta.url` shimmed via esbuild `--define` + `--banner`

## v1.0.2 — Persistent Profiles

- `--profile <name>` — persistent browser profiles with full state (cookies, localStorage, IndexedDB, cache)
- Each profile gets its own Chromium with a real user data directory
- `profile list` | `profile delete <name>` | `profile clean` — profile management
- Mutually exclusive with `--session` (profiles own their Chromium, sessions share one)
- Auto-recovery: corrupted profile directories are detected and recreated

## v1.0.0 — Node.js Port

- **Ported from Bun to Node.js** — zero Bun runtime dependency, runs on Node 18+
- **Why:** Bun's WebSocket client sends `Connection: keep-alive` instead of `Connection: Upgrade`, breaking the CDP handshake required by Playwright's `connectOverCDP()`. This bug ([oven-sh/bun#9911](https://github.com/oven-sh/bun/issues/9911)) has been open since April 2024 and blocked all CDP-based features: `--connect`, `--cdp`, and LightPanda. Node.js handles WebSocket upgrades correctly.
- **All blocked features unblocked:**
  - `--connect` — auto-discover and connect to a running Chrome instance
  - `--cdp <port>` — connect to Chrome on a specific debugging port
  - `--runtime lightpanda` — LightPanda browser engine via CDP
- **Windows support** — Node.js runs everywhere
- Bun.serve → thin `nodeServe()` adapter (20 lines, zero deps, same Request/Response API)
- bun:test → vitest (same API, `pool: 'forks'` with `singleFork` for shared browser)
- bun:sqlite → better-sqlite3 (same `.prepare().all()` API)
- bun build --compile → esbuild bundle
- 304 tests pass on Node.js

## v0.10.0 — Feature Parity

**New commands:**
- `rightclick <sel>` — right-click element (context menu)
- `tap <sel>` — tap element (touch-enabled contexts)
- `swipe <up|down|left|right> [px]` — swipe gesture via touch events
- `mouse move|down|up|wheel` — low-level mouse control
- `keyboard inserttext <text>` — insert text without key events
- `scrollinto <sel>` / `scrollintoview <sel>` — explicit scroll-into-view
- `set geo <lat> <lng>` — set geolocation with permission grant
- `set media <dark|light|no-preference>` — emulate color scheme
- `box <sel>` — get element bounding box as JSON `{x, y, width, height}`
- `errors [--clear]` — view/clear page errors (filtered from console buffer)
- `doctor` — system check (Bun version, Playwright, Chromium path)
- `upgrade` — self-update via npm

**Extended commands:**
- `wait --text "..."` — wait for text to appear in page body
- `wait --fn "expr"` — wait for JavaScript condition
- `wait --load <state>` — wait for load state (load, domcontentloaded, networkidle)
- `wait <sel> --state hidden` — wait for element to disappear
- `wait <ms>` — wait for milliseconds
- `cookie clear` — clear all cookies
- `cookie set <n> <v> [--domain --secure --expires --sameSite --path]` — set cookie with options
- `cookie export <file>` — export cookies to JSON file
- `cookie import <file>` — import cookies from JSON file
- `find alt <text>` — find by alt text
- `find title <text>` — find by title attribute
- `find first|last <sel>` — find first/last matching element
- `find nth <n> <sel>` — find nth matching element (0-indexed)
- `screenshot <sel|@ref> [path]` — screenshot a specific element
- `screenshot --clip x,y,w,h [path]` — screenshot a clipped region

**New flag:**
- `--max-output <n>` — truncate output to N characters (also `BROWSE_MAX_OUTPUT` env var)

**Improvements:**
- Ref staleness detection — stale refs fail in ~5ms with actionable error instead of waiting for Playwright timeout
- 305 tests (31 new)

## v0.9.0 — Auth Persistence

- **Session auto-persistence** — named sessions (`--session myapp`) now automatically save cookies + localStorage on close and restore on next use. No extra commands needed. The `"default"` session is unaffected.
- **Cookie import from real browsers** — `cookie-import chrome --domain .example.com` reads and decrypts cookies from Chrome, Arc, Brave, or Edge on macOS. Import once, browse authenticated. Use `cookie-import --list` to see installed browsers. Supports `--profile` for multi-profile browsers.
- **Encrypted state at rest** — auto-persisted session state and manual state files are encrypted with AES-256-GCM when `BROWSE_ENCRYPTION_KEY` is set (same key as auth vault).
- **`--state <path>` flag** — load a saved state file before the first command: `browse --state auth.json goto https://app.com`
- **`state clean`** — garbage-collect old state files: `browse state clean` (7 days default) or `browse state clean --older-than 30`
- **`--connect` / `--cdp` flags** — discover and connect to a running Chrome instance (unblocked in v1.0.0 Node.js port)

## v0.8.0 — Command Recording & Export

- `record start` | `record stop` | `record status` — record browse commands as you go
- `record export browse [path]` — export as chain-compatible JSON (replay with `browse chain`)
- `record export replay [path]` — export as Chrome DevTools Recorder format (replay with `npx @puppeteer/replay` or Playwright)
- Tested end-to-end: record → export → `npx @puppeteer/replay` passes

## v0.7.5 — Token Optimization & Benchmarks

- `snapshot -i` now outputs terse flat list by default (no indentation, no props, names truncated to 30 chars)
- `-f` flag for full indented ARIA tree with props/children (the old `-i` behavior)
- `-V` flag for viewport-only snapshot — filters to elements visible in the current viewport (BBC: 189 → 28 elements, ~85% reduction)
- `browse version` / `--version` — print CLI version
- 2.4-2.8x fewer tokens than browser-use and agent-browser across real-world benchmarks

## v0.5.0–v0.7.0 — Runtime Abstraction (internal)

- Browser runtime provider registry (`src/runtime.ts`) — pluggable backend support
- `--runtime rebrowser` — stealth mode via rebrowser-playwright (bypasses bot detection)
- `--runtime lightpanda` — experimental LightPanda browser support
- `BROWSE_RUNTIME` env var for default runtime selection
- `screenshot --full` — full-page screenshots (entire scrollable page)
- Multiple internal package.json bumps during development

## v0.4.0 — Video Recording

- `video start [dir]` | `video stop` | `video status` — compositor-level WebM recording
- Works with local and remote (CDP) browsers

## v0.3.0 — Headed Mode, Clipboard, DevTools

- `--headed` flag — run browser in visible mode for debugging and demos
- `clipboard [write <text>]` — read and write clipboard contents
- `inspect` command — open DevTools debugger via `BROWSE_DEBUG_PORT`
- `screenshot --annotate` — pixel-annotated PNG with numbered badges
- `instances` command — list all running browse servers
- `BROWSE_DEBUG_PORT` env var for DevTools debugging

## v0.2.0 — Security, Interactions, DX

**Commands:**
- `dblclick`, `focus`, `check`, `uncheck`, `drag`, `keydown`, `keyup` — interaction commands
- `frame <sel>` / `frame main` — iframe targeting
- `value <sel>`, `count <sel>` — element inspection
- `scroll up/down` — viewport-relative scrolling
- `wait --url`, `wait --network-idle` — navigation/network wait variants
- `highlight <sel>` — visual element debugging
- `download <sel> [path]` — file download
- `route <pattern> block/fulfill` — network request interception and mocking
- `offline on/off` — offline mode toggle
- `state save/load` — persist and restore cookies + localStorage (all origins)
- `har start/stop` — HAR recording and export
- `screenshot-diff` — pixel-level visual regression testing
- `find role/text/label/placeholder/testid` — semantic element locators

**Security:**
- `--allowed-domains` — domain allowlist (HTTP + WebSocket/EventSource/sendBeacon)
- `browse-policy.json` — action policy gate (allow/deny/confirm per command)
- `auth save/login/list/delete` — AES-256-GCM encrypted credential vault
- `--content-boundaries` — CSPRNG nonce wrapping for prompt injection defense

**DX:**
- `--json` — structured output mode for agent frameworks
- `browse.json` config file support
- AI-friendly error messages — Playwright errors rewritten to actionable hints
- Per-session output folders (`.browse/sessions/{id}/`)

**Infrastructure:**
- Auto-instance servers via PPID — multi-Claude isolation
- CDP remote connection (`BROWSE_CDP_URL`)
- Proxy support (`BROWSE_PROXY`)
- Compiled binary self-spawn mode
- Orphaned server cleanup

## v0.1.0 — Foundation

**Commands:**
- `emulate` / `devices` — device emulation (100+ devices)
- `snapshot -C` — cursor-interactive detection
- `snapshot-diff` — before/after comparison with ref-number stripping
- `dialog` / `dialog-accept` / `dialog-dismiss` — dialog handling
- `upload` — file upload
- `screenshot --annotate` — numbered badge overlay with legend

**Infrastructure:**
- Session multiplexing — multiple agents share one Chromium
- Safe retry classification — read vs write commands
- TreeWalker text extraction — no MutationObserver triggers
