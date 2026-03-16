# Plan: Shared Browser Test Infrastructure

> Generated: 2026-03-16
> Branch: `main`
> Mode: HOLD

## Overview

Refactor test infrastructure to share a single Chromium browser across test files. Currently 10 Chrome launches across 6 files cause resource contention — Chrome crashes under pressure, failing 22 tests. Fix: create a shared test globals module with one BrowserManager + one test server. 4 test files import from it. Sessions test keeps its own (tests isolation). E2E unchanged.

## Scope Challenge

No feature code changes. Pure test infrastructure. The shared globals pattern is standard (Playwright's own test runner does this). The key constraint: features.test.ts has a `filteredBm` that needs its own BrowserContext with domain filter — it should use `launchWithBrowser()` on the shared Chrome instead of launching a new one.

## Architecture

```
┌─────────────────────────────────────────────────┐
│ test/setup.ts (NEW)                   TASK-001  │
│  Exports: sharedBm, sharedBaseUrl, sharedServer │
│  Creates ONE BrowserManager + ONE test server   │
│  Lazily initialized on first import             │
└────────┬────────────────────────────────────────┘
         │ imports
    ┌────┴────┬──────────┬──────────────┐
    ▼         ▼          ▼              ▼
commands  snapshot  interactions   features
.test.ts  .test.ts  .test.ts      .test.ts
TASK-002  TASK-002  TASK-002      TASK-003
(remove   (remove   (remove       (remove bm,
 own bm)   own bm)   own bm)      keep filteredBm
                                   as launchWithBrowser)

sessions.test.ts — unchanged (needs own SessionManager)
session-e2e.test.ts — unchanged (spawns CLI processes)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| BrowserManager creation | Every test file's beforeAll | Extract to shared module |
| Test server creation | Every test file's beforeAll | Extract to shared module |
| filteredBm | features.test.ts:508 | Change from launch() to launchWithBrowser() |
| Cleanup | Every test file's afterAll | Remove from files that use shared, add global teardown |

## Tasks

### TASK-001: Create test/setup.ts shared globals

Create `test/setup.ts` that exports a shared BrowserManager, test server URL, and test server instance. Use `beforeAll`/`afterAll` at the module level so it initializes once before any test file runs and cleans up after all complete.

Since bun test runs all files in the same process, module-level state IS shared across files. Use `beforeAll` and `afterAll` from bun:test at module scope.

**Files to create:** `test/setup.ts`

```typescript
import { beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { startTestServer } from './test-server';

export let sharedBm: BrowserManager;
export let sharedBaseUrl: string;
export let sharedServer: ReturnType<typeof startTestServer>;

beforeAll(async () => {
  sharedServer = startTestServer(0);
  sharedBaseUrl = sharedServer.url;
  sharedBm = new BrowserManager();
  await sharedBm.launch();
});

afterAll(async () => {
  try { sharedServer.server.stop(); } catch {}
  await Promise.race([
    sharedBm.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
});
```

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `test/setup.ts` exports sharedBm, sharedBaseUrl, sharedServer
- [ ] Single BrowserManager launched once, shared across importing files
- [ ] Cleanup runs after all tests complete
- [ ] Importing the module from multiple files doesn't create duplicate browsers

**Agent:** general-purpose

**Priority:** P0

---

### TASK-002: Refactor commands, snapshot, interactions to use shared browser

Update 3 test files to import from `test/setup.ts` instead of creating their own BrowserManager and test server.

For each file:
1. Remove `let testServer`, `let bm`, `let baseUrl` declarations
2. Remove `beforeAll` that creates BrowserManager and test server
3. Remove `afterAll` that closes them
4. Add `import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup'`
5. Keep all test cases unchanged — they reference `bm` and `baseUrl` which are now aliases

**Files to modify:**
- `test/commands.test.ts`
- `test/snapshot.test.ts`
- `test/interactions.test.ts`

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] All 3 files import from setup.ts, no own BrowserManager launch
- [ ] `bun test test/commands.test.ts` passes (all 53 tests)
- [ ] `bun test test/snapshot.test.ts` passes (all 35 tests)
- [ ] `bun test test/interactions.test.ts` passes (all 25 tests)
- [ ] No `new BrowserManager` or `bm.launch()` in these 3 files

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Refactor features.test.ts — shared bm + scoped filteredBm

Update features.test.ts:
1. Replace main `bm` with import from setup.ts (same as TASK-002)
2. Change `filteredBm` from `new BrowserManager(); await filteredBm.launch()` to `new BrowserManager(); await filteredBm.launchWithBrowser(sharedBm.getBrowser())` — shares Chrome, own BrowserContext
3. Wait — BrowserManager doesn't expose `getBrowser()`. Need to add it or use the shared browser directly.

Actually, `filteredBm` needs its own BrowserContext with domain filter applied. It can't share the main bm's context. But it CAN share the same Chrome process. The fix: add a `getBrowser()` method to BrowserManager that returns the underlying Browser instance, then `filteredBm.launchWithBrowser(bm.getBrowser())`.

But `getBrowser()` doesn't exist and `browser` is private. Two options:
- Add `getBrowser()` to BrowserManager
- Create filteredBm using sessions (SessionManager pattern)

Simplest: just keep `filteredBm.launch()` as a separate Chrome. That's only 2 Chromes total (shared + filtered) instead of 10. Good enough.

Actually no — the user said "comprehensive not shitty." Add the getter.

**Files to modify:**
- `test/features.test.ts` — import shared bm, change filteredBm to use shared Chrome
- `src/browser-manager.ts` — add `getBrowser(): Browser | null` getter

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] features.test.ts main bm imported from setup.ts
- [ ] filteredBm uses `launchWithBrowser()` on shared Chrome (1 Chrome, 2 contexts)
- [ ] `bun test test/features.test.ts` passes (all 83 tests)
- [ ] Domain filter init script tests still pass with the shared Chrome

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-004: Verify full suite — 212 tests, 0 fail, 0 FATAL

Run `bun test` with all 6 files. Verify:
- 212 tests pass
- 0 failures
- No FATAL/crash messages
- Exit code 0
- Chrome count reduced from 10 to ~3 (shared + sessions + e2e)

**Files to modify:** none (verification only)

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] `bun test` exits 0 with 0 failures
- [ ] No "FATAL" or "Chromium crashed" in output
- [ ] Total Chrome launches <= 3 (verify via ps or log)

**Agent:** general-purpose

**Depends on:** TASK-002, TASK-003
**Priority:** P2

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Module-level beforeAll in setup.ts runs per-file not once | TASK-001 | Bun runs all files in same process — module cache ensures single init. Verify with a counter. |
| Shared bm state leaks between test files | TASK-002 | Each test navigates to its own page via goto before testing. Existing tests already do this. |
| filteredBm's domain filter affects shared Chrome | TASK-003 | filteredBm uses launchWithBrowser() which creates its own BrowserContext — isolated from shared bm's context |
| Test ordering matters with shared state | TASK-002 | Bun test runs files in parallel, tests within a file sequentially. Shared bm is thread-safe (single JS thread). |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Shared browser initialization | TASK-004 | integration (full suite run) |
| getBrowser() getter | TASK-003 | integration (filteredBm tests) |
| Cross-file browser sharing | TASK-004 | integration (all 6 files together) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002", "TASK-003"]
}
```
