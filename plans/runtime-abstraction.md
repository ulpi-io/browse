# Plan: Browser Runtime Provider Abstraction

> Generated: 2026-03-20
> Branch: `feat/runtime-abstraction`
> Mode: EXPANSION

## Overview

Introduce a runtime abstraction layer so the browser engine is swappable at runtime. Three runtimes: `playwright` (default), `rebrowser` (stealth — patches CDP leaks), `lightpanda` (10x faster Zig-based headless engine via CDP). Selected via `--runtime` CLI flag, `BROWSE_RUNTIME` env var, or `browse.json` config.

## Scope Challenge

Playwright is imported in 3 source files (`server.ts`, `browser-manager.ts`, `session-manager.ts`). The launch/connect logic is in `server.ts:365-396`. `browser-manager.ts:206` has a standalone `chromium.launch()` for tests. The abstraction needs to intercept both launch points and route through a runtime registry. Existing `BROWSE_CDP_URL` mechanism stays as-is — it's orthogonal (connects to an already-running browser). EXPANSION mode selected: all 3 runtimes, lightpanda process spawning, comprehensive tests, full docs.

## Architecture

```
CLI (--runtime flag)
 │
 ├─ env: BROWSE_RUNTIME=<name>
 │
 ▼
Server (src/server.ts)
 │
 ├── getRuntime(name) ──────────────────────┐
 │                                          │
 ▼                                          ▼
src/runtime.ts                     Runtime Registry
 │                           ┌──────────┼──────────┐
 │                           │          │          │
 ▼                           ▼          ▼          ▼
PlaywrightRuntime      RebrowserRT   LightpandaRT
[TASK-001]             [TASK-001]    [TASK-002]
 │                      │             │
 │ chromium.launch()    │ same API    │ spawn binary
 │ chromium.connectCDP  │             │ poll /json/version
 │                      │             │ connectOverCDP(wsUrl)
 ▼                      ▼             ▼
         Browser (Playwright API)
              │
              ▼
    BrowserManager (unchanged)
    SessionManager (unchanged)
    All Commands (unchanged)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Browser launch/connect | `src/server.ts:365-396` | Modify — route through runtime |
| Standalone launch (tests) | `src/browser-manager.ts:206` | Modify — accept runtime param |
| CLI flag parsing | `src/cli.ts:510-576` | Extend — add `--runtime` |
| Config loading | `src/config.ts` | Extend — add `runtime` field |
| Env var passing to server | `src/cli.ts:255` | Extend — add `BROWSE_RUNTIME` |
| CDP connect | `src/server.ts:369-374` | Reuse as-is (orthogonal) |
| Device descriptors | `src/browser-manager.ts:10` `playwrightDevices` | Keep — works with all runtimes |
| SKILL.md docs | `skill/SKILL.md` | Extend — add `--runtime` flag |
| Feature tests | `test/features.test.ts` | Extend — add runtime tests |

## Tasks

### TASK-001: Create runtime registry with playwright and rebrowser runtimes

Create `src/runtime.ts` with the `BrowserRuntime` interface and registry for `playwright` and `rebrowser` runtimes. Both are library runtimes that return a Playwright-compatible `chromium` object via dynamic `import()`.

The registry uses lazy loading — `rebrowser-playwright` is only imported when selected, so it doesn't need to be installed for the default runtime to work. If selected but not installed, throw a clear error with install instructions.

Export `getRuntime(name?)`, `AVAILABLE_RUNTIMES`, and the `BrowserRuntime` interface.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `getRuntime('playwright')` returns a runtime with a valid `chromium` BrowserType
- [ ] `getRuntime('rebrowser')` throws with install instructions when `rebrowser-playwright` is not installed
- [ ] `getRuntime('invalid')` throws with list of available runtimes

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Add lightpanda process runtime

Add the `lightpanda` runtime to `src/runtime.ts`. This is a process runtime — it spawns the `lightpanda` binary, waits for its CDP endpoint, then connects Playwright to it.

Implementation:
1. `findLightpanda()` — search PATH, `~/.lightpanda/lightpanda`, `~/.local/bin/lightpanda`
2. Find a free port via `Bun.listen()` on port 0 (or `net.createServer`)
3. Spawn: `lightpanda serve --host 127.0.0.1 --port <port> --timeout 604800`
4. Poll `GET http://127.0.0.1:<port>/json/version` every 100ms (10s timeout)
5. Extract `webSocketDebuggerUrl` from JSON response
6. Connect: `playwright.chromium.connectOverCDP(wsUrl)`
7. Store child process for cleanup via `close()`

Validate incompatible options: headed mode, extensions, custom Chrome args → clear error messages.

Reference: `/Users/ciprian/work_cip/agent-browser/cli/src/native/cdp/lightpanda.rs` for the spawn/poll pattern.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `getRuntime('lightpanda')` returns a runtime that spawns the binary and connects via CDP
- [ ] If lightpanda binary is not found, throws with install URL: `https://lightpanda.io/docs/open-source/installation`
- [ ] `close()` kills the spawned lightpanda process

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Wire runtime into server.ts

Replace `import { chromium } from 'playwright'` in `src/server.ts` with the runtime abstraction.

Changes:
1. `import { getRuntime } from './runtime'` (line 12)
2. Read runtime name: `process.env.BROWSE_RUNTIME` or config (around line 365)
3. Replace `chromium.launch(launchOptions)` (line 388) and `chromium.connectOverCDP(cdpUrl)` (line 372) with runtime calls
4. Store runtime reference for cleanup on shutdown (lightpanda needs `close()`)

The `start()` function (line 365) becomes:
```typescript
const runtime = await getRuntime(process.env.BROWSE_RUNTIME);
if (cdpUrl) {
  browser = await runtime.chromium.connectOverCDP(cdpUrl);
} else {
  browser = await runtime.chromium.launch(launchOptions);
}
```

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Server launches with default runtime (playwright) when `BROWSE_RUNTIME` is not set
- [ ] Server launches with `BROWSE_RUNTIME=rebrowser` when rebrowser-playwright is installed
- [ ] `BROWSE_CDP_URL` still works regardless of runtime selection

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-004: Wire runtime into browser-manager.ts and update test imports

`browser-manager.ts` imports `chromium` directly (line 10) for the standalone `launch()` method (line 206) and `playwrightDevices` for device descriptors. Additionally, `test/sessions.test.ts` (line 9) imports `chromium` directly for session tests.

Changes:
1. Remove `chromium` from the import on line 10 (keep `devices as playwrightDevices` and all types)
2. Add `import { getRuntime } from './runtime'`
3. In `launch()` method (line 205-212): replace `chromium.launch({ headless: true })` with runtime-aware launch
4. Accept optional `runtimeName` parameter in `launch()`
5. Update `test/sessions.test.ts`: replace direct `chromium.launch()` (line 26) with `BrowserManager.launch()` or `getRuntime()` to remove hardcoded playwright import

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `BrowserManager.launch()` works without arguments (defaults to playwright)
- [ ] `BrowserManager.launch(onCrash, 'rebrowser')` uses rebrowser runtime
- [ ] Device descriptors (`playwrightDevices`) continue to work for all runtimes
- [ ] `test/sessions.test.ts` no longer imports `chromium` directly from `playwright`

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-005: Add --runtime CLI flag and env var propagation

Add `--runtime <name>` as a global CLI flag in `src/cli.ts`. Follow the exact pattern of `--session` (value-flag with splice).

Changes to `src/cli.ts`:
1. Add `'--runtime'` to `findCommandIndex()` value-flag list (line 514)
2. Extract `--runtime` flag (same pattern as `--session`, lines 519-530)
3. Merge with `BROWSE_RUNTIME` env var and `config.runtime`
4. Pass to server spawn env (line 255): `...(runtime ? { BROWSE_RUNTIME: runtime } : {})`
5. Update help text (line 628+): add `--runtime <name>` to global flags section

Changes to `src/config.ts`:
1. Add `runtime?: string` to `BrowseConfig` interface (line 9)

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --runtime rebrowser goto https://example.com` passes `BROWSE_RUNTIME=rebrowser` to server
- [ ] `browse.json` with `{"runtime":"rebrowser"}` is used as default when no flag/env set
- [ ] Help text shows `--runtime <name>` in the flags section

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-006: Add rebrowser-playwright as optional dependency

Add `rebrowser-playwright` to `package.json` as an optional dependency. This ensures it's available for users who want stealth mode but doesn't break base install.

Changes:
1. `package.json`: add `"optionalDependencies": { "rebrowser-playwright": "^1.49.1" }`
2. Verify `bun install` still works without errors when optional dep is not resolved

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `bun install` succeeds (optional dep may or may not install)
- [ ] `bun run build` succeeds with `--external` flags unchanged
- [ ] Base functionality works without rebrowser-playwright installed

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-007: Add runtime registry tests

Add tests to `test/features.test.ts` for the runtime registry.

Tests:
1. `getRuntime()` (no arg) returns playwright runtime with valid `chromium`
2. `getRuntime('playwright')` returns playwright runtime
3. `getRuntime('invalid')` throws with available runtimes list
4. `AVAILABLE_RUNTIMES` contains `['playwright', 'rebrowser', 'lightpanda']`
5. Lightpanda runtime: `findLightpanda()` returns `null` when binary not on PATH (safe test)
6. Lightpanda runtime: validates incompatible options (headed mode → error)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All runtime registry tests pass with `bun test test/features`
- [ ] Tests don't require rebrowser-playwright or lightpanda to be installed
- [ ] Edge case: invalid runtime name produces actionable error message

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-002
**Priority:** P2

---

### TASK-008: Update SKILL.md and help text documentation

Update both `skill/SKILL.md` and `.claude/skills/browse/SKILL.md` with the `--runtime` flag documentation.

Changes:
1. Add `--runtime <name>` to the CLI Flags table
2. Add runtime section under Quick Reference with examples
3. Add to the "When to Use What" table: stealth browsing → `--runtime rebrowser`, fast scraping → `--runtime lightpanda`
4. Update Architecture section to mention runtime abstraction

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Both SKILL.md files are in sync (identical content)
- [ ] `--runtime` flag documented with all 3 runtime names
- [ ] Examples show env var, CLI flag, and browse.json config methods

**Agent:** general-purpose

**Depends on:** TASK-005
**Priority:** P2

---

### TASK-009: Update CLAUDE.md and reference docs

Update `CLAUDE.md` and `.claude/claude-md-refs/exports-reference.md` to document the new `runtime.ts` module.

Changes to `CLAUDE.md`:
1. Add `src/runtime.ts` to Project Structure table
2. Add `--runtime` to Environment Variables table

Changes to `.claude/claude-md-refs/exports-reference.md`:
1. Add `runtime.ts` to Source Files table
2. Add `getRuntime`, `AVAILABLE_RUNTIMES`, `BrowserRuntime` to Exported Functions/Types tables
3. Add `BROWSE_RUNTIME` to Environment Variables table

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `runtime.ts` appears in project structure and exports reference
- [ ] `BROWSE_RUNTIME` env var is documented
- [ ] All new exports are listed with correct types and file paths

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `rebrowser-playwright` API incompatibility with Playwright | TASK-001, TASK-003 | Dynamic import with try/catch; version-pin in optionalDependencies |
| `rebrowser-playwright` doesn't work with Bun build | TASK-006 | Test `bun run build` in CI; if fails, document manual install |
| Lightpanda binary not found on user's system | TASK-002 | Clear error with install URL; `findLightpanda()` checks multiple paths |
| Lightpanda CDP endpoint format differs from Chrome | TASK-002 | Poll `/json/version` like agent-browser does; handle missing `webSocketDebuggerUrl` |
| Lightpanda process left orphaned on crash | TASK-002 | `close()` kills child; process `exit` handler as safety net |
| Server spawn doesn't pass `BROWSE_RUNTIME` env var | TASK-005 | Follow exact pattern of `BROWSE_HEADED` which already works |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Runtime registry (`getRuntime`) | TASK-007 | unit |
| Invalid runtime error | TASK-007 | unit |
| Lightpanda binary discovery | TASK-007 | unit |
| Lightpanda incompatible options validation | TASK-007 | unit |
| Server launch with runtime | TASK-003 | integration (manual) |
| CLI `--runtime` flag parsing | TASK-005 | integration (manual) |
| Config `runtime` field | TASK-005 | unit (existing config test pattern) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-001"],
  "TASK-005": [],
  "TASK-006": [],
  "TASK-007": ["TASK-001", "TASK-002"],
  "TASK-008": ["TASK-005"],
  "TASK-009": ["TASK-001"]
}
```
