# Plan: Phase 5 — Concurrency & Lifecycle Robustness

> Generated: 2026-04-12
> Branch: `feat/concurrency-lifecycle`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase2-real-web-browsing-quality, phase3-snapshot-large-pages, phase4-proxy-pool, phase6-new-commands

## Overview

Add concurrency control and lifecycle robustness features to browse_cli's session and server layers. Tab lock mutex prevents CDP state corruption when concurrent requests target the same tab. Per-user concurrency limits cap parallel requests per session with queued overflow. Tab inactivity reaper closes idle tabs to reclaim resources. Browser warm retry recovers from launch failures with exponential backoff instead of leaving the server dead. All features are runtime-agnostic and integrate with the existing SessionManager and server.ts infrastructure. Phase 5 of 6 in the camoufox integration roadmap.

## Scope Challenge

The server's `handleCommand()` function (`src/server.ts:205`) currently dispatches commands directly to `executeCommand()` with no serialization or concurrency gating. Multiple concurrent HTTP requests targeting the same tab can interleave CDP protocol messages, causing state corruption (e.g. click + fill racing on the same element, ref map getting overwritten mid-snapshot). The SessionManager tracks `lastActivity` per session but has no per-tab activity tracking for reaping. Browser launch in `start()` (`src/server.ts:538`) is fire-once with no retry — if Chromium fails to launch, the server sits idle with no browser.

Four integration points:
1. Tab lock: new TabLock class wraps tab operations with per-tab mutex (acquire/release/drain pattern)
2. Concurrency limiter: new `withUserLimit()` wraps `handleCommand()` dispatch to cap per-session parallelism
3. Tab reaper: SessionManager gets periodic interval checking per-tab lastActivity timestamps
4. Warm retry: `server.ts start()` wraps browser launch in exponential backoff loop

## Prerequisites

- SessionManager exists with session lifecycle and `lastActivity` tracking (verified: `src/session/manager.ts` — Session interface with lastActivity field)
- `server.ts handleCommand()` dispatches to `executeCommand()` pipeline (verified: `src/server.ts:337`)
- TabManager tracks per-tab pages with `Map<number, Page>` (verified: `src/browser/tabs.ts:13`)
- Browser launch in `start()` uses `runtime.chromium.launch()` with no retry (verified: `src/server.ts:538`)
- DEFAULTS constants object in `src/constants.ts` for default config values (verified: existing pattern)

## Non-Goals

- Cross-session tab locking (each session has independent tabs — no cross-session contention)
- Distributed locking (single-process server — no need for Redis/file-based locks)
- Rate limiting by IP or API key (CLI is localhost-only with token auth)
- Tab pooling or pre-warming (tabs are created on demand by user commands)
- Automatic browser version upgrades on retry failure
- Graceful degradation to headful mode on headless failure

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| TabLock -> command handlers | `tab-lock.ts TabLock` on `session.commandLock` | `server.ts handleCommand()` via session | `TabLock { acquire(timeoutMs?): Promise<() => void>, isLocked(): boolean }` | Session-level lock — ALL commands serialize per session. acquire() returns release function. Caller MUST call release() in finally. Queue drains FIFO. Different sessions run in parallel. |
| ConcurrencyLimiter -> server dispatch | `concurrency.ts withUserLimit()` | `server.ts handleCommand()` | `withUserLimit<T>(limiter, sessionId, operation, timeoutMs?): Promise<T>` | Max N concurrent ops per session (default 6). Excess queue with timeout. Session close drains with rejection. |
| Tab reaper -> SessionManager | `SessionManager.reapInactiveTabs()` periodic interval | TabManager pages (closes idle tabs) | `reapInactiveTabs(maxInactiveMs): Promise<string[]>` returns closed tab descriptions | Never close last tab. Never close locked tabs. Activity tracked per command execution. |
| Warm retry -> server start() | `launchWithRetry()` in server.ts | `start()` browser init | `launchWithRetry(runtime, opts, maxAttempts, baseDelayMs): Promise<Browser>` | Exponential backoff: delay * 2^attempt. Max 3 attempts. /health returns HTTP 200 with browserReady:false during retry (preserves CLI contract). Command endpoints return 503. Final failure triggers shutdown. |

## Architecture

```
HTTP Request (concurrent)
  |
  v
server.ts handleCommand()
  |
  +-- ConcurrencyLimiter.acquire(sessionId)          TASK-004
  |     Max 6 per session, excess queues
  |
  +-- session.commandLock.acquire()                    TASK-003
  |     Per-tab serialization (write commands only)
  |
  +-- executeCommand(command, args, context)
  |
  +-- session.commandLock.release()
  |
  +-- ConcurrencyLimiter.release()
  |
  +-- touchTab(sessionId, tabId)                      TASK-005
        Update per-tab activity timestamp

                                                      TASK-005
Tab Reaper (every 60s)
  |
  +-- SessionManager.reapInactiveTabs(300_000)
        Close tabs idle > 5min (skip locked, keep last)

                                                      TASK-006
server.ts start()
  |
  +-- HTTP listener start (before browser)
  |
  +-- launchWithRetry(runtime, opts, 3, 1000)
        Attempt 1 -> fail -> 1s -> Attempt 2 -> fail -> 2s -> Attempt 3
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Per-tab state tracking | `src/browser/tabs.ts` TabManager (Map<number, Page>) | extend |
| Session lifecycle and lastActivity | `src/session/manager.ts` SessionManager | extend |
| Command dispatch pipeline | `src/server.ts` handleCommand() line 205 | extend |
| Browser launch logic | `src/server.ts` start() line 525-546 | extend |
| Default constants pattern | `src/constants.ts` DEFAULTS | extend |
| Session barrel exports | `src/session/index.ts` | extend |
| Idle session cleanup interval pattern | `src/server.ts` sessionCleanupInterval | reuse |

## Tasks

### TASK-001: TabLock class with acquire/release/drain

Create `src/session/tab-lock.ts` with a TabLock class that provides per-tab serialization to prevent CDP state corruption when concurrent requests target the same tab.

The class uses a proper mutex pattern with a queue — NOT a Promise-chain lock. Each tab ID maps to a queue of waiting resolvers. `acquire(tabId, timeoutMs)` returns a Promise that resolves to a release() function when the lock is obtained. The caller MUST call release() in a finally block.

Key design:
- `locks: Map<number, { active: boolean; queue: Array<{ resolve, reject, timer }> }>` — per-tab lock state
- `acquire(tabId: number, timeoutMs?: number): Promise<() => void>` — returns release function
- `release()` — dequeues next waiter or marks lock inactive
- `drain(): void` — rejects all waiters (for session close)
- `isLocked(tabId: number): boolean` — check if tab has active lock (for reaper)
- `TabLockTimeoutError extends Error` — thrown when acquire times out
- Default timeout: 30000ms (DEFAULTS.TAB_LOCK_TIMEOUT_MS)

Add `TAB_LOCK_TIMEOUT_MS: 30_000` to DEFAULTS in `src/constants.ts`.

Export TabLock and TabLockTimeoutError from `src/session/index.ts` barrel.

Reference: camofox-browser server.js lines 274-340 for mutex pattern inspiration.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] TabLock.acquire(tabId) returns a release function that, when called, allows the next queued waiter to proceed
- [ ] Two concurrent acquire() calls on the same tabId serialize — second waiter resolves only after first release()
- [ ] acquire() with timeout rejects with TabLockTimeoutError after timeoutMs if lock not obtained
- [ ] drain() rejects all queued waiters and resets lock state
- [ ] isLocked(tabId) returns true when a lock is held, false otherwise
- [ ] TAB_LOCK_TIMEOUT_MS added to DEFAULTS in constants.ts

**Write Scope:** `src/session/tab-lock.ts`, `src/constants.ts`, `src/session/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-002: Per-user concurrency limiter

Create `src/session/concurrency.ts` with a ConcurrencyLimiter class and a `withUserLimit()` utility that caps the number of concurrent operations per session.

When a session exceeds its limit, excess requests queue with a configurable timeout. This prevents a single agent from monopolizing the browser with many parallel requests.

Key design:
- `ConcurrencyLimiter` class:
  - `sessions: Map<string, { active: number; queue: Array<{ resolve, reject, timer }> }>` — per-session state
  - `constructor(maxConcurrent?: number, queueTimeoutMs?: number)` — defaults from DEFAULTS
  - `acquire(sessionId: string): Promise<() => void>` — returns release function, queues if at limit
  - `drain(sessionId: string): void` — reject all queued operations (for session close)
  - `getStats(sessionId: string): { active: number; queued: number }` — for status reporting
- `withUserLimit<T>(limiter, sessionId, operation): Promise<T>` — convenience wrapper
- `ConcurrencyLimitError extends Error` — thrown when queue times out

Add `MAX_CONCURRENT_PER_SESSION: 6` and `CONCURRENCY_QUEUE_TIMEOUT_MS: 30_000` to DEFAULTS in `src/constants.ts`.

Export ConcurrencyLimiter, ConcurrencyLimitError, and withUserLimit from `src/session/index.ts` barrel.

Reference: camofox-browser server.js lines 356-387 for concurrency limit pattern.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] ConcurrencyLimiter.acquire(sessionId) allows up to maxConcurrent simultaneous operations per session
- [ ] When at limit, additional acquire() calls queue and resolve when a slot frees up
- [ ] Queue timeout rejects with ConcurrencyLimitError after queueTimeoutMs
- [ ] drain(sessionId) rejects all queued operations for that session
- [ ] getStats(sessionId) returns accurate active/queued counts
- [ ] MAX_CONCURRENT_PER_SESSION and CONCURRENCY_QUEUE_TIMEOUT_MS added to DEFAULTS

**Write Scope:** `src/session/concurrency.ts`, `src/constants.ts`, `src/session/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Wire tab lock into session manager and command dispatch

Integrate TabLock into the command execution path so that ALL commands within a session serialize through a single session-level lock.

CRITICAL DESIGN NOTE: The current runtime has one mutable `activeTabId` per session (`TabManager._activeTabId` in tabs.ts:14). Command handlers call `bm.getPage()` which reads this shared pointer. Two concurrent requests -- even targeting different tabs -- would race on `activeTabId` and the ref map. Per-tab parallelism requires per-request tab pinning (passing a specific page/tab reference through the command context instead of reading `activeTabId`), which is a larger refactor. For this phase, use a SESSION-LEVEL lock that serializes ALL commands within a session. This is safe and correct. Per-tab parallelism is a future optimization.

Integration points:

1. **Session interface** (`src/session/manager.ts`): Add `commandLock: TabLock` field to the Session interface. Initialize a new TabLock() when creating each session in getOrCreate().

2. **server.ts handleCommand()** (line 205): Before calling executeCommand(), acquire the session's `commandLock`. Wrap the executeCommand() call in a try/finally that releases the lock. ALL commands (read, write, meta) serialize through this lock per session. Different sessions still run in parallel.

3. **Session close** (`src/session/manager.ts`): Call `session.commandLock.drain()` in closeSession() and closeAll() before closing the automation target. This rejects any queued waiters cleanly.

**ESCAPE HATCH:** Read `BROWSE_COMMAND_LOCK` env var (default '1'). When set to '0', skip lock acquire/release entirely (log a warning that CDP corruption is possible). Add `BROWSE_COMMAND_LOCK` to `src/constants.ts` DEFAULTS.

Future optimization (NOT this phase): Per-request tab pinning -- pass the target page directly through CommandContext instead of reading `activeTabId`. This would allow different-tab requests within one session to run in parallel. Requires threading a Page reference through the entire command handler chain.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Session interface includes commandLock: TabLock field, initialized in getOrCreate()
- [ ] ALL commands acquire session commandLock before executeCommand() and release in finally block
- [ ] Two concurrent commands to the same session serialize (second waits for first to complete)
- [ ] Two concurrent commands to DIFFERENT sessions execute in parallel (no cross-session blocking)
- [ ] Session close calls commandLock.drain() before closing automation target

**Write Scope:** `src/session/manager.ts`, `src/server.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Wire concurrency limiter into server command dispatch

Integrate ConcurrencyLimiter into the server's command dispatch path to cap per-session parallelism.

Integration points:

1. **server.ts module scope**: Create a single ConcurrencyLimiter instance at module level (alongside policyChecker, sessionManager). Read limit from `BROWSE_MAX_CONCURRENT` env var, falling back to `DEFAULTS.MAX_CONCURRENT_PER_SESSION`.

2. **server.ts handleCommand()** (line 205): Wrap the entire command execution (policy check through executeCommand) in `withUserLimit(limiter, session.id, async () => { ... })`. This ensures the concurrency limit applies to the full command lifecycle including context capture and finalization.

3. **server.ts shutdown()**: When closing sessions, call `limiter.drain(sessionId)` for each session being closed. This rejects any queued requests with a clear error.

4. **Status command enrichment**: In the status/health endpoint response, include concurrency stats: `{ ...existing, concurrency: limiter.getStats(sessionId) }`. This helps agents understand if they're being throttled.

The limiter is per-session, not per-tab. A session with 6 concurrent requests hitting different tabs still counts as 6. The tab lock (TASK-003) handles per-tab serialization separately.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Server creates ConcurrencyLimiter at startup with configurable max from BROWSE_MAX_CONCURRENT env var
- [ ] handleCommand() wraps dispatch in withUserLimit() — excess requests queue and wait
- [ ] When max concurrent reached, next request queues and resolves when a slot opens
- [ ] Server shutdown drains limiter for all sessions
- [ ] BROWSE_MAX_CONCURRENT env var overrides default limit

**Write Scope:** `src/server.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Tab inactivity reaper in session manager

Add per-tab activity tracking and an automatic reaper that closes tabs idle beyond a configurable threshold. This reclaims browser resources in long-running sessions where agents open many tabs and forget to close them.

Integration points:

1. **src/session/manager.ts**: Add `tabActivity: Map<number, number>` to Session interface — maps tab ID to last activity timestamp. Update the timestamp in getOrCreate() when session.lastActivity is updated, and expose a `touchTab(sessionId, tabId)` method for the server to call after each command.

2. **src/session/manager.ts**: Add `reapInactiveTabs(maxInactiveMs: number): Promise<string[]>` method. For each session, iterate tabActivity map. Close tabs whose last activity exceeds the threshold. NEVER close the last tab in a session. Skip tabs whose session commandLock is currently held (session.commandLock.isLocked() — a session-level check, not per-tab, since TASK-003 uses a session-level lock). If the lock is held, skip the entire session's tabs for this reap cycle. Returns descriptions of closed tabs for logging.

3. **src/server.ts**: Add a periodic interval (every 60s) that calls `sessionManager.reapInactiveTabs(TAB_INACTIVITY_MS)`. Read `BROWSE_TAB_INACTIVITY_MS` env var, defaulting to `DEFAULTS.TAB_INACTIVITY_MS` (1800000 = 30 min, matching session timeout). Log closed tabs. Clear interval in shutdown().

4. **src/server.ts handleCommand()**: After executeCommand(), call `sessionManager.touchTab(session.id, activeTabId)` to update the tab's activity timestamp.

5. **src/constants.ts**: Add `TAB_INACTIVITY_MS: 1_800_000` (30 min, matching session timeout) and `TAB_REAP_INTERVAL_MS: 60_000` (1 min) to DEFAULTS.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Session interface includes tabActivity: Map<number, number> for per-tab timestamps
- [ ] touchTab(sessionId, tabId) updates the tab's last activity timestamp
- [ ] reapInactiveTabs() closes tabs idle beyond threshold, never closes last tab
- [ ] reapInactiveTabs() skips entire session when commandLock is held
- [ ] Server runs reaper on periodic interval, reads BROWSE_TAB_INACTIVITY_MS env var
- [ ] TAB_INACTIVITY_MS and TAB_REAP_INTERVAL_MS added to DEFAULTS

**Write Scope:** `src/session/manager.ts`, `src/server.ts`, `src/constants.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-006: Browser launch warm retry with exponential backoff

Wrap the browser launch in `server.ts start()` with retry logic so that transient launch failures (port conflicts, resource exhaustion, Chromium download incomplete) don't leave the server permanently dead.

CRITICAL CLIENT CONTRACT: The CLI (cli.ts:335-344) calls GET /health and checks `resp.ok` (HTTP 200). If the server returns non-200, the CLI considers it dead and tries to start a new server -- creating a race. The /health endpoint MUST return HTTP 200 during retry with a status field indicating startup state, NOT 503. This preserves the CLI contract while communicating the startup state.

Integration points:

1. **src/server.ts**: Extract browser launch (line 525-546) into a `launchWithRetry(runtime, launchOptions, maxAttempts, baseDelayMs)` function. The function:
   - Attempts `runtime.chromium.launch(launchOptions)` up to maxAttempts times
   - On failure, logs the error with attempt number and waits `baseDelayMs * 2^attempt` ms
   - Exponential backoff: 1s, 2s, 4s for default 3 attempts
   - On final failure, throws the last error (server.ts catch block handles shutdown)

2. **src/server.ts start()**: Replace the direct `runtime.chromium.launch(launchOptions)` call with `launchWithRetry(runtime, launchOptions, maxAttempts, baseDelayMs)`. Start the HTTP listener BEFORE the browser launch so the server can respond during retry. Read `BROWSE_LAUNCH_RETRIES` env var for max attempts, defaulting to `DEFAULTS.BROWSER_LAUNCH_RETRIES` (3).

3. **src/server.ts health endpoint**: During browser launch retry, health endpoint returns HTTP 200 with `{ status: 'healthy', browserReady: false, retryAttempt: N }`. The 200 status keeps the CLI happy (it won't try to start a new server). The `browserReady: false` field lets callers know commands will fail until launch completes. Command endpoints return 503 with `{ error: 'Browser starting, retry in a moment' }` during the retry window.

4. **src/constants.ts**: Add `BROWSER_LAUNCH_RETRIES: 3` and `BROWSER_LAUNCH_BASE_DELAY_MS: 1_000` to DEFAULTS.

This does NOT apply to CDP connections (remote browser) or profile mode (persistent context). Only the local browser launch path.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] launchWithRetry() retries browser launch up to maxAttempts with exponential backoff
- [ ] Launch failure on attempt 1 retries after 1s, attempt 2 after 2s, attempt 3 after 4s
- [ ] Server HTTP listener starts BEFORE browser launch -- can respond during retry
- [ ] Health endpoint returns HTTP 200 with { status: 'healthy', browserReady: false } during retry phase -- preserves CLI contract (cli.ts checks resp.ok)
- [ ] Final failure triggers server shutdown with clear error
- [ ] BROWSE_LAUNCH_RETRIES env var configures max attempts
- [ ] BROWSER_LAUNCH_RETRIES and BROWSER_LAUNCH_BASE_DELAY_MS added to DEFAULTS

**Write Scope:** `src/server.ts`, `src/constants.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-007: Tests for tab lock, concurrency, reaper, and retry

Add comprehensive tests for all Phase 5 features. Create a new test file `test/concurrency.test.ts` focused on concurrency and lifecycle.

Test groups:

**TabLock unit tests:**
- acquire() returns release function, calling it allows next waiter
- Two concurrent acquire() on same tabId serialize correctly
- acquire() on different tabIds execute in parallel
- acquire() with timeout rejects with TabLockTimeoutError
- drain() rejects all queued waiters
- isLocked() returns correct state

**ConcurrencyLimiter unit tests:**
- Allows up to maxConcurrent simultaneous acquires per session
- Queues excess requests, resolves when slot frees
- Queue timeout rejects with ConcurrencyLimitError
- drain(sessionId) rejects all queued for that session
- getStats() returns accurate active/queued counts
- Different sessions have independent limits

**Tab reaper unit tests:**
- Closes tabs idle beyond threshold
- Never closes last tab
- Skips tabs with active locks
- Updates tabActivity on touchTab()

**Browser launch retry unit tests:**
- launchWithRetry succeeds on first attempt — no delay
- launchWithRetry succeeds on second attempt after backoff
- launchWithRetry fails after maxAttempts and throws last error
- Backoff delays are exponential (1s, 2s, 4s)

**Integration tests:**
- Concurrent write commands to same tab serialize via tab lock
- Per-session concurrency limit queues excess requests

Follow existing test patterns: use vitest, BrowserManager for integration tests, mock timers for retry/timeout tests.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All TabLock unit tests pass: serialization, timeout, drain, isLocked
- [ ] All ConcurrencyLimiter unit tests pass: limit enforcement, queue, timeout, drain, stats
- [ ] All tab reaper unit tests pass: idle close, last-tab protection, lock-skip
- [ ] All launch retry unit tests pass: success, retry, final failure, backoff timing
- [ ] Integration tests verify concurrent requests serialize per-tab and cap per-session
- [ ] All tests pass with `npm test`

**Write Scope:** `test/concurrency.test.ts`
**Validation:** `npm test`

**Depends on:** TASK-003, TASK-004, TASK-005, TASK-006
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Tab lock deadlock — release() never called due to uncaught exception | TASK-001, TASK-003 | acquire() returns release function used in finally block. Lock has built-in timeout (30s) that auto-releases and rejects. drain() on session close releases all waiters. |
| Concurrency limiter starvation — slow request blocks all N slots | TASK-002, TASK-004 | Individual request timeout (BROWSE_TIMEOUT) still applies. Queue timeout (30s) rejects waiting requests. Session close drains all pending. |
| Tab reaper closes tab during active command execution | TASK-005 | Reaper checks TabLock — skips entire session when commandLock is held. lastActivity updated at command start. |
| Browser warm retry delays server readiness — CLI times out | TASK-006 | Server starts HTTP listener BEFORE browser launch. Health endpoint returns { status: 'starting' } during retry. CLI health check timeout (2s) already handles slow starts. |
| Memory leak from abandoned lock queues if sessions not properly closed | TASK-001, TASK-002 | Both TabLock and ConcurrencyLimiter have drain() methods called from SessionManager.closeSession(). Map + explicit cleanup. |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 + TASK-004 = tab locking and concurrency limits protect against concurrent request corruption
- **Full value:** All 7 tasks = complete concurrency control with tab reaping, launch resilience, and test coverage

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| TabLock acquire/release serialization | TASK-007 | unit |
| TabLock timeout rejection | TASK-007 | unit |
| TabLock drain() releases all waiters | TASK-007 | unit |
| ConcurrencyLimiter enforces max concurrent limit | TASK-007 | unit |
| ConcurrencyLimiter queues excess and drains on timeout | TASK-007 | unit |
| Tab inactivity reaper closes idle tabs, preserves last | TASK-007 | unit |
| Tab reaper skips locked tabs | TASK-007 | unit |
| Browser launch retry with exponential backoff | TASK-007 | unit |
| Concurrent requests serialized per-tab via lock | TASK-007 | integration |
| Per-session concurrency cap queues excess requests | TASK-007 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 7 |
| Layer Count | 3 |
| Critical Path | TASK-001 -> TASK-003 -> TASK-007 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002, TASK-005, TASK-006 | Independent foundation: tab lock, concurrency limiter, reaper, retry |
| 1 | TASK-003, TASK-004 | Wiring: tab lock into dispatch (depends TASK-001), limiter into server (depends TASK-002) |
| 2 | TASK-007 | Tests for all features (depends on all wiring tasks) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002"],
  "TASK-005": [],
  "TASK-006": [],
  "TASK-007": ["TASK-003", "TASK-004", "TASK-005", "TASK-006"]
}
```
