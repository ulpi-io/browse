# Plan: Phase 1 — Camoufox Runtime

> Generated: 2026-04-12
> Branch: `feat/camoufox-runtime`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase2-real-web-browsing-quality, phase3-snapshot-large-pages, phase4-proxy-pool, phase5-concurrency-lifecycle, phase6-new-commands

## Overview

Add Camoufox (anti-detection Firefox fork) as a new browser runtime in browse_cli's pluggable engine system. This gives all 99 browse commands C++ fingerprint spoofing — navigator, canvas, WebGL, WebRTC, audio, fonts, screen, timezone, media devices, geolocation, speech voices, per-context identity, humanized cursor, and virtual display — by adding camoufox-js as a dependency and registering it alongside playwright, rebrowser, lightpanda, and chrome in the runtime registry. Phase 1 of 6 in the camoufox integration roadmap.

## Scope Challenge

The runtime registry (`src/engine/resolver.ts`) already supports 4 pluggable runtimes via a lazy-loaded registry pattern. Camoufox fits this pattern exactly: `camoufox-js` provides `launchOptions()` that returns Playwright-compatible Firefox launch config. The `BrowserRuntime.chromium` field accepts any Playwright `BrowserType` including `firefox`.

Two integration issues found:
1. `BrowserManager.launchPersistent()` hardcodes `chromium.launchPersistentContext()` — profile mode won't work without threading the runtime's BrowserType through
2. CLI help text and error messages hardcode `playwright|rebrowser|lightpanda` — need updating

All Phase 2-8 features (consent dismiss, search macros, proxy pool, etc.) are runtime-agnostic and will be separate plans.

## Prerequisites

- Runtime registry pattern exists in `src/engine/resolver.ts` with `BrowserRuntime` interface (verified: line 20)
- `camoufox-js` npm package (v0.9.3) provides `launchOptions()` and Firefox BrowserType (external dep)
- Playwright `ariaSnapshot()` works on Firefox — confirmed by camofox-browser usage and Playwright docs
- esbuild build pipeline supports `--external` flags (verified: `package.json:56`)

## Non-Goals

- Proxy pool rotation (Phase 4)
- Consent dialog auto-dismiss (Phase 2)
- Search macros (Phase 2)
- Google block detection (Phase 2)
- Snapshot windowing (Phase 3)
- Prometheus metrics (skipped)
- Fly.io deployment (skipped)
- Per-context fingerprint rotation via browse commands (comes free with camoufox-js, no CLI needed yet)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Runtime registry → server | `resolver.ts getRuntime('camoufox')` | `server.ts start()` (line 466-538) | `BrowserRuntime { name: 'camoufox', chromium: firefox, launchOptions: {...} }` | Server merges camoufox launchOptions with its own (headless, proxy) before calling launch() |
| CLI → server spawn | `cli.ts --runtime flag` | `server.ts BROWSE_RUNTIME env` | `BROWSE_RUNTIME='camoufox'` in spawn env | CLI validates name in AVAILABLE_RUNTIMES before spawning |
| Doctor → camoufox | `system.ts doctor` | User terminal | Text: `Camoufox: installed (v0.9.3)` or `NOT INSTALLED` | Does not require camoufox to be the active runtime |

## Architecture

```
CLI (--runtime camoufox)                   TASK-003
  │
  ├─ BROWSE_RUNTIME=camoufox ──► server.ts
  │                                  │
  │                             getRuntime('camoufox')
  │                                  │
  │                            resolver.ts ◄── TASK-002
  │                                  │
  │                          ┌───────┴────────┐
  │                          │  camoufox-js   │ ◄── TASK-001 (dependency)
  │                          │  launchOptions │
  │                          └───────┬────────┘
  │                                  │
  │                          firefox.launch(opts)
  │                                  │
  │                          Camoufox (Firefox)
  │                          C++ anti-detection
  │
  ├─ browse doctor ──► system.ts ◄── TASK-004
  │                    (camoufox status check)
  │
  └─ test suite ──► features.test.ts ◄── TASK-005
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Runtime registration pattern | `src/engine/resolver.ts` | Extend (add camoufox loader) |
| CLI flag parsing | `src/cli.ts:670-681` | Extend (update help text) |
| Doctor diagnostics | `src/commands/meta/system.ts:131-210` | Extend (add camoufox section) |
| Runtime test patterns | `test/features.test.ts:1219-1267` | Extend (add camoufox tests) |
| Build --external flags | `package.json:56` | Extend (add camoufox-js) |
| Camoufox launch config | `camoufox-js` npm package | Reuse (external) |
| Profile mode persistent context | `src/browser/manager.ts:239-265` | Extend (parameterize BrowserType) |

## Tasks

### TASK-001: Add camoufox-js dependency and build config

Install `camoufox-js` as an `optionalDependency` in package.json (same category as rebrowser-playwright — not required for default operation). Add `--external:camoufox-js` to the esbuild build script so the optional dep is not bundled into `dist/browse.cjs`. This mirrors how playwright and playwright-core are handled.

The optionalDependency pattern means `npm install` won't fail if camoufox-js can't download its binary (e.g. unsupported platform). The runtime loader (TASK-002) catches the import failure gracefully.

**Type:** infra
**Effort:** S

**Acceptance Criteria:**
- [ ] `camoufox-js` appears in `package.json` optionalDependencies
- [ ] Build script (`npm run build`) includes `--external:camoufox-js` and completes without error
- [ ] `npm install` succeeds even if camoufox-js binary download fails (optionalDependency graceful failure)

**Write Scope:** `package.json`
**Validation:** `npm run build && node -e "const pkg = require('./package.json'); if (!pkg.optionalDependencies?.['camoufox-js']) throw 'missing'"`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Register camoufox runtime in engine resolver

Add a `camoufox` entry to the registry in `src/engine/resolver.ts`. The loader:
1. Dynamically imports `camoufox-js` (catches ImportError → throws `'camoufox-js not installed. Run: npm install camoufox-js'`)
2. Calls `launchOptions({ headless: true, humanize: true, enable_cache: true })` to get Playwright-compatible Firefox launch config
3. Dynamically imports `playwright-core`'s `firefox` BrowserType
4. Returns `{ name: 'camoufox', chromium: firefox }` — note: `chromium` field is misnamed but accepts any BrowserType
5. Stores the camoufox launch options on the runtime object so server.ts can merge them

Also add a `findCamoufox()` helper (exported, like `findLightpanda()`) that checks if camoufox-js is importable.

Update barrel export in `src/engine/index.ts` to export `findCamoufox`.

Pattern to follow: the rebrowser loader (line 64-72) for import-failure handling.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `getRuntime('camoufox')` returns `BrowserRuntime` with `name='camoufox'` and a valid BrowserType
- [ ] `AVAILABLE_RUNTIMES` array includes `'camoufox'`
- [ ] When camoufox-js is not installed, `getRuntime('camoufox')` throws error containing `'camoufox-js not installed'` and install command

**Write Scope:** `src/engine/resolver.ts`, `src/engine/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Wire camoufox runtime through server and CLI

Update the server, CLI, target factory, and BrowserManager to handle the camoufox runtime correctly:

1. **server.ts (line 525-538)**: When runtime.name is 'camoufox', merge camoufox-js launchOptions with server's launchOptions (headless flag, proxy). The camoufox runtime stores its options object; server.ts spreads them into the launch call. Specifically: merge args arrays, merge env objects, preserve camoufox's firefoxUserPrefs.

2. **server.ts CDP guard (line 512-516)**: Before connecting via CDP, check if `runtime.name === 'camoufox'`. If so, throw: `'Camoufox (Firefox) does not support Chrome DevTools Protocol. Remove --cdp or use --runtime playwright.'`

3. **server.ts profile mode (line 474-499)**: Currently calls `createPersistentBrowserTarget(profileDir, onCrash)`. Update to pass the runtime's BrowserType: `createPersistentBrowserTarget(profileDir, onCrash, runtime.chromium)`.

4. **src/session/target-factory.ts (line 50-66)**: `createPersistentBrowserTarget()` currently only accepts `(profileDir, onCrash)` and calls `bm.launchPersistent(profileDir, onCrash)`. Add an optional third parameter `browserType?: BrowserType` and pass it through to `bm.launchPersistent(profileDir, onCrash, browserType)`. This is the critical path -- without this change, the runtime's BrowserType never reaches the persistent launch.

5. **BrowserManager.launchPersistent (line 239-265)**: This method hardcodes `chromium.launchPersistentContext()`. Add optional `browserType` parameter. When provided, use it instead of hardcoded `chromium`. Default to `chromium` import for backward compatibility.

6. **cli.ts (line 676)**: Update the error message for --runtime to include camoufox in the list.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `BROWSE_RUNTIME=camoufox browse goto https://example.com` works end-to-end (server launches Firefox via camoufox-js)
- [ ] `BROWSE_RUNTIME=camoufox` with `--cdp` flag produces clear error about Firefox CDP incompatibility
- [ ] Profile mode (`--profile test`) with `BROWSE_RUNTIME=camoufox` uses `firefox.launchPersistentContext` -- verified by checking that `createPersistentBrowserTarget` receives and threads the runtime BrowserType through to `BrowserManager.launchPersistent`

**Write Scope:** `src/server.ts`, `src/cli.ts`, `src/browser/manager.ts`, `src/session/target-factory.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Add camoufox to doctor command diagnostics

Extend the doctor command in `src/commands/meta/system.ts` (line 131+) to check camoufox availability. Add after the Playwright/Chromium checks:

1. Try dynamic import of `camoufox-js`
2. If importable, report version and binary status
3. If not importable, report `'Camoufox: NOT INSTALLED — run npm install camoufox-js (optional)'`
4. Mark clearly as optional (unlike Playwright which is required)

Follow existing pattern: try/catch import, report status line.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse doctor` output includes a `Camoufox:` line showing installed/not-installed status
- [ ] When camoufox-js is installed, doctor shows version
- [ ] When camoufox-js is NOT installed, doctor shows install command and marks it as optional

**Write Scope:** `src/commands/meta/system.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P2

---

### TASK-005: Add camoufox runtime tests

Extend test suite in `test/features.test.ts`:

1. **Unit tests** (existing 'Runtime resolver' block, line 1215+):
   - `AVAILABLE_RUNTIMES` includes `'camoufox'`
   - `findCamoufox()` returns null or valid status
   - `getRuntime('camoufox')` either succeeds or throws with install instructions

2. **Integration test** (new 'Camoufox runtime integration' block):
   - Skip if camoufox-js not installed (`test.skipIf`)
   - Launch via runtime system, navigate to test server, verify page loads
   - Run snapshot, verify @refs generated
   - Click a ref, verify state changes
   - Extract text, verify content
   - Close cleanly

3. **CLI flag test** (extend '--runtime CLI flag' block, line 1249+):
   - `AVAILABLE_RUNTIMES` includes `'camoufox'`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All new tests pass when camoufox-js IS installed
- [ ] All new tests skip gracefully when camoufox-js is NOT installed (no failures, just skips)
- [ ] Integration test covers goto → snapshot → click → text flow on camoufox runtime

**Write Scope:** `test/features.test.ts`
**Validation:** `npm test`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| camoufox-js postinstall downloads ~300MB binary — may fail in CI | TASK-001 | optionalDependency pattern; runtime loader catches import failure |
| Firefox ariaSnapshot format differs from Chromium | TASK-005 | Integration test validates. snapshot.ts parser is format-agnostic. |
| --cdp flag used with camoufox (Firefox has no CDP) | TASK-003 | Explicit guard with clear error message before CDP connection |
| Profile mode hardcodes chromium.launchPersistentContext | TASK-003 | Thread BrowserType parameter through launchPersistent() |
| Camoufox binary not available on all platforms | TASK-004 | Doctor reports availability; runtime error includes platform guidance |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 = camoufox runtime works end-to-end with `BROWSE_RUNTIME=camoufox`
- **Not shippable without Phase 2:** anti-detection browsing that actually handles consent dialogs and Google blocks

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `getRuntime('camoufox')` returns valid BrowserRuntime | TASK-005 | unit |
| `AVAILABLE_RUNTIMES` includes 'camoufox' | TASK-005 | unit |
| camoufox-js not installed → clear error | TASK-005 | unit |
| CDP mode + camoufox → graceful error | TASK-005 | unit |
| Doctor shows camoufox status | TASK-005 | unit |
| Full browsing flow on camoufox runtime | TASK-005 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 5 |
| Layer Count | 3 |
| Critical Path | TASK-002 → TASK-003 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002, TASK-004 | Independent foundation: dependency, runtime loader, doctor |
| 1 | TASK-003, TASK-005 | Wiring + tests (both depend on TASK-002) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-002"],
  "TASK-004": [],
  "TASK-005": ["TASK-002"]
}
```
