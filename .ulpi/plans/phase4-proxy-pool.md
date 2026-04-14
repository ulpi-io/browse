# Plan: Phase 4 — Proxy Pool

> Generated: 2026-04-12
> Branch: `feat/proxy-pool`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase2-real-web-browsing-quality, phase3-snapshot-large-pages, phase5-concurrency-lifecycle, phase6-new-commands

## Overview

Add a proxy pool system with sticky session rotation and pluggable provider abstraction to browse_cli. Currently browse_cli only supports a single static proxy via `BROWSE_PROXY=server` pass-through (server.ts line 531-536). This phase adds: (1) a proxy pool that assigns different proxies to different browser contexts, supporting round-robin (fixed port list) and backconnect (rotating sticky sessions via provider gateway); (2) a provider abstraction where each provider shapes credentials and declares capabilities (`canRotateSessions`, `launchRetries`, `launchTimeoutMs`), shipping with Decodo and generic providers; (3) per-context proxy assignment so each multiplexed session gets a unique proxy from the pool; (4) auto-rotate on Google blocks (Phase 2 prerequisite) that destroys the blocked session and creates a fresh one with a new proxy. Phase 4 of 6 in the camoufox integration roadmap.

## Scope Challenge

The current proxy implementation is a simple pass-through: server.ts reads `BROWSE_PROXY` and passes it to `browser.launch()` as a single proxy option (line 531-536). This means all sessions share the same proxy IP. The proxy pool requires changing where proxy options are applied: from the browser level to the context level.

Playwright supports per-context proxy when the browser is launched with a proxy, but per-context proxy assignment requires the pool to provide a proxy for each new BrowserContext created by the `SessionTargetFactory`. The key architectural change is threading proxy options through the factory pattern: `createBrowserTargetFactory` currently receives only a `Browser`, but now needs access to the proxy pool so it can call `pool.getNext()` when creating each BrowserContext.

Two constraints:
1. Per-context proxy is Chromium-only in Playwright — Firefox (camoufox) falls back to browser-level proxy
2. The auto-rotate feature depends on Phase 2's Google block detection — if not yet merged, TASK-005 must be deferred

## Prerequisites

- SessionTargetFactory pattern exists with `create()` method that provisions BrowserContext per session (verified: `src/session/target-factory.ts:37-44`)
- BrowserManager.launchWithBrowser() creates a new BrowserContext via `browser.newContext()` (verified: `src/browser/manager.ts:222`)
- server.ts reads `BROWSE_PROXY` and passes to `browser.launch()` as proxy option (verified: `src/server.ts:531-536`)
- Playwright supports per-context proxy via `browser.newContext({ proxy: {...} })` — Chromium only (external: Playwright docs)
- camofox-browser `lib/proxy.js` (278 lines) provides reference implementation (external: reference codebase)
- Phase 2 Google block detection exists for auto-rotate trigger (not yet: TASK-005 depends on this)

## Non-Goals

- Proxy authentication UI or interactive credential input (use env vars only)
- Proxy health checking or automatic failover on non-Google blocks
- Proxy usage metrics or Prometheus integration
- SOCKS5 proxy support (HTTP/HTTPS proxies only, matching Playwright support)
- Per-command proxy switching (proxy is per-session, not per-command)
- Proxy chain or cascading proxy support
- Fly.io deployment or cloud proxy management
- Profile mode proxy support (profile mode has no session multiplexing)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| ProxyPool -> SessionTargetFactory | `pool.ts createProxyPool(config)` | `target-factory.ts createBrowserTargetFactory(browser, proxyPool?)` | `ProxyPool { mode, getNext(sessionId?): ProxyConfig, getLaunchProxy(sessionId?): ProxyConfig, canRotateSessions, provider }` | Factory calls pool.getNext(sessionId) per BrowserContext. If pool is null, no per-context proxy (falls back to browser-level). |
| ProxyProvider -> ProxyPool | `providers.ts decodoProvider, genericProvider` | `pool.ts createProxyPool({ providerName })` | `ProxyProvider { name, canRotateSessions, launchRetries, launchTimeoutMs, buildSessionUsername(base, opts), buildProxyUrl(proxy, config) }` | Provider shapes username for backconnect sticky sessions. Unknown provider falls back to decodoProvider. |
| server.ts -> ProxyPool init | `server.ts reads BROWSE_PROXY_* env vars` | `SessionManager via createBrowserTargetFactory(browser, proxyPool)` | Env vars: BROWSE_PROXY_STRATEGY, BROWSE_PROXY_PROVIDER, BROWSE_PROXY_HOST, BROWSE_PROXY_PORTS, etc. | When BROWSE_PROXY_STRATEGY set, creates pool and passes to factory. Legacy BROWSE_PROXY unchanged when strategy not set. |
| Auto-rotate -> SessionManager | `write.ts goto handler detects Google block` | `SessionManager.closeSession() + getOrCreate()` | On Google block: close session, create new (gets new proxy from pool) | Only when pool.canRotateSessions is true. Max 3 retries. Context-level rotation only. |

## Architecture

```
  BROWSE_PROXY_STRATEGY=backconnect          Env vars (TASK-003)
  BROWSE_PROXY_PROVIDER=decodo
  BROWSE_PROXY_BACKCONNECT_HOST=gate.proxy.com
  BROWSE_PROXY_BACKCONNECT_PORT=7000
  BROWSE_PROXY_USERNAME=sp6incny2a
  BROWSE_PROXY_PASSWORD=secret
  BROWSE_PROXY_COUNTRY=us
      |
      v
  server.ts start()                          TASK-003
      |
      +-- createProxyPool(config)
      |       |
      |       v
      |   src/proxy/pool.ts                  TASK-002
      |       |
      |       +-- getProvider('decodo')
      |       |       |
      |       |       v
      |       |   src/proxy/providers.ts     TASK-001
      |       |   (decodoProvider, genericProvider)
      |       |
      |       v
      |   ProxyPool { getNext(), getLaunchProxy() }
      |
      +-- browser.launch({ proxy: pool.getLaunchProxy() })
      |
      +-- createBrowserTargetFactory(browser, proxyPool)
              |
              v
          target-factory.ts                  TASK-004
              |
              +-- create(buffers, reuseContext)
              |       |
              |       +-- proxyPool.getNext(sessionId)
              |       |       -> { server, username, password }
              |       |
              |       +-- bm.launchWithBrowser(browser, reuseCtx, { proxy })
              |               -> browser.newContext({ proxy, viewport })
              |
              +-- Session A: proxy session-a (gate.proxy.com:7000)
              +-- Session B: proxy session-b (gate.proxy.com:7000)
              +-- Session C: proxy session-c (gate.proxy.com:7000)

  goto handler (Google block detected)       TASK-005
      |
      +-- pool.canRotateSessions? -> yes
      +-- SessionManager.closeSession(id)
      +-- SessionManager.getOrCreate(id)  -> new proxy from pool
      +-- retry goto
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Proxy pool with round-robin and backconnect | `camofox-browser/lib/proxy.js:175-241` | Adapt to TypeScript |
| Decodo provider with username DSL | `camofox-browser/lib/proxy.js:66-104` | Adapt to TypeScript |
| Generic backconnect provider | `camofox-browser/lib/proxy.js:111-132` | Adapt to TypeScript |
| Provider registry pattern | `camofox-browser/lib/proxy.js:134-146` | Adapt to TypeScript |
| Session target factory for context creation | `src/session/target-factory.ts:72-89` | Extend (add proxyPool param) |
| Server startup with proxy env var reading | `src/server.ts:531-536` | Extend (add pool creation) |
| BrowserManager.launchWithBrowser context creation | `src/browser/manager.ts:201-232` | Extend (add contextOptions) |
| Constants for defaults | `src/constants.ts` | Extend (add proxy defaults) |
| Proxy rotation test patterns | `camofox-browser/tests/unit/proxyRotation.test.js` | Adapt to TypeScript |

## Tasks

### TASK-001: Proxy provider interface and implementations

Create `src/proxy/` directory and `src/proxy/providers.ts` with the ProxyProvider interface and two built-in implementations: Decodo and generic backconnect.

First create the directory: `mkdir -p src/proxy`.

Adapt from camofox-browser/lib/proxy.js (lines 36-146), converting to TypeScript with proper types:

1. **ProxyProvider interface**: `{ name, canRotateSessions, launchRetries, launchTimeoutMs, buildSessionUsername(base, opts), buildProxyUrl(proxy, config) }`
2. **SessionOptions type**: `{ country?, state?, city?, zip?, sessionId?, sessionDurationMinutes? }`
3. **decodoProvider**: Residential proxy. Username DSL: `user-{base}-country-{cc}-state-{st}-session-{id}-sessionduration-{min}`. Sanitizes inputs.
4. **genericProvider**: Pass-through. Username: `{base}-{sessionId}`. Works with any backconnect proxy.
5. **Provider registry**: `getProvider(name)`, `registerProvider(name, provider)`.
6. **normalizePlaywrightProxy()**: Decodes percent-encoded credentials.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] ProxyProvider interface exported with name, canRotateSessions, launchRetries, launchTimeoutMs, buildSessionUsername, buildProxyUrl
- [ ] `decodoProvider.buildSessionUsername('user', { country: 'us', sessionId: 'abc' })` returns `'user-user-country-us-session-abc'`
- [ ] `genericProvider.buildSessionUsername('user', { sessionId: 'abc' })` returns `'user-abc'`
- [ ] `getProvider('decodo')` returns decodoProvider, `getProvider('unknown')` returns null
- [ ] `normalizePlaywrightProxy` decodes percent-encoded credentials

**Write Scope:** `src/proxy/providers.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Proxy pool factory and barrel exports

Create `src/proxy/pool.ts` with the ProxyPool interface and `createProxyPool()` factory, plus `src/proxy/index.ts` barrel.

Adapt from camofox-browser/lib/proxy.js (lines 148-278), converting to TypeScript:

1. **ProxyConfig type**: `{ server, username?, password?, sessionId? }`
2. **ProxyPoolConfig type**: All config fields for pool creation
3. **ProxyPool interface**: `{ mode, provider, canRotateSessions, launchRetries, launchTimeoutMs, size, getLaunchProxy(sessionId?), getNext(sessionId?) }`
4. **createProxyPool(config)**: Factory. Returns null when required config missing.
   - `round_robin`: cycles through `host:ports[i]`, no session rotation
   - `backconnect`: uses provider.buildSessionUsername() for sticky sessions
5. **buildProxyUrl(pool, config)**: Build proxy URL string for CLI tools.
6. **Barrel export** `src/proxy/index.ts`: Re-exports all types and functions.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `createProxyPool({ strategy: 'round_robin', host, ports: [10001,10002], ... })` returns pool with `mode='round_robin'`, `size=2`
- [ ] Round-robin `pool.getNext()` cycles through ports: 10001, 10002, 10001, ...
- [ ] `createProxyPool({ strategy: 'backconnect', ... })` returns pool with `mode='backconnect'`
- [ ] Backconnect `pool.getNext('session-1')` returns proxy with session-specific username
- [ ] `createProxyPool` with missing required fields returns null
- [ ] `src/proxy/index.ts` re-exports all types and functions

**Write Scope:** `src/proxy/pool.ts`, `src/proxy/index.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-003: Env var configuration and constants for proxy pool

Wire proxy pool initialization into server.ts by reading BROWSE_PROXY_* env vars, and add default values to constants.ts.

1. **src/constants.ts**: Add proxy defaults: `PROXY_LAUNCH_RETRIES`, `PROXY_LAUNCH_TIMEOUT_MS`, `PROXY_SESSION_DURATION_MINUTES`, `PROXY_MAX_ROTATE_RETRIES`.

2. **src/server.ts** (`start()` function, after line 530):
   - Read env vars: `BROWSE_PROXY_STRATEGY`, `BROWSE_PROXY_PROVIDER`, `BROWSE_PROXY_HOST`, `BROWSE_PROXY_PORTS`, `BROWSE_PROXY_USERNAME`, `BROWSE_PROXY_PASSWORD`, `BROWSE_PROXY_BACKCONNECT_HOST`, `BROWSE_PROXY_BACKCONNECT_PORT`, `BROWSE_PROXY_COUNTRY`, `BROWSE_PROXY_STATE`, `BROWSE_PROXY_CITY`
   - Create pool via `createProxyPool(config)`, log mode/size
   - Use `pool.getLaunchProxy()` for browser-level proxy
   - Pass pool to `createBrowserTargetFactory(browser, proxyPool)` (TASK-004 handles factory)
   - Warning when both `BROWSE_PROXY` and `BROWSE_PROXY_STRATEGY` are set

3. **Backward compatibility**: Legacy `BROWSE_PROXY` unchanged when `BROWSE_PROXY_STRATEGY` not set.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] DEFAULTS includes `PROXY_LAUNCH_RETRIES`, `PROXY_LAUNCH_TIMEOUT_MS`, `PROXY_SESSION_DURATION_MINUTES`, `PROXY_MAX_ROTATE_RETRIES`
- [ ] `BROWSE_PROXY_STRATEGY=round_robin` with host/ports creates pool, logs mode/size
- [ ] `BROWSE_PROXY_STRATEGY=backconnect` with backconnect host/port creates backconnect pool
- [ ] When `BROWSE_PROXY_STRATEGY` not set, existing `BROWSE_PROXY` behavior unchanged
- [ ] When both set, strategy takes precedence with warning log

**Write Scope:** `src/constants.ts`, `src/server.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Wire proxy pool into session target factory

Update the session target factory interface, its implementation, and BrowserManager to accept and apply per-context proxy options from the proxy pool.

CRITICAL SEAM: The current `SessionTargetFactory.create(buffers, reuseContext)` interface (target-factory.ts:43) does not accept a session identifier or proxy pool. `SessionManager.getOrCreate()` (manager.ts:131) calls this. The plan must widen both the interface and the call site.

1. **src/session/target-factory.ts**: Widen the `SessionTargetFactory.create()` interface to accept an options object: `create(buffers, reuseContext, opts?: { sessionId?: string, proxyPool?: ProxyPool })`. This is a non-breaking change since opts is optional. Update `createBrowserTargetFactory(browser, proxyPool?)` to capture the pool. In `create()`: when proxyPool is provided, generate a sessionId from `opts.sessionId` or a UUID fallback, call `proxyPool.getNext(sessionId)` to get per-context proxy config. Pass the proxy config to `BrowserManager.launchWithBrowser()` as a new optional parameter.

2. **src/session/manager.ts** `getOrCreate()`: Update the call to `factory.create(buffers, reuseContext)` to pass the session id: `factory.create(buffers, reuseContext, { sessionId: id })`. The session id is already available as the key parameter of `getOrCreate()`. Also add `proxyPool: ProxyPool | null` field to the Session interface. After factory.create() returns, store the pool reference on the session: `session.proxyPool = proxyPool`. This enables TASK-005 (auto-rotate) to access the pool via `ctx.session.proxyPool` at command execution time.

3. **src/browser/manager.ts** `launchWithBrowser()`: Add optional `contextOptions?: { proxy?: { server: string; username?: string; password?: string } }` parameter. When `contextOptions.proxy` is provided, spread it into the `browser.newContext()` call. This enables Playwright's per-context proxy: each BrowserContext can have a different proxy while sharing the same Browser process.

Key constraint: Playwright per-context proxy is Chromium-only. Firefox (camoufox) uses browser-level proxy for all contexts. The factory should log a warning if pool is provided but runtime is Firefox.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `createBrowserTargetFactory(browser, proxyPool)` passes proxy from `pool.getNext()` to each new BrowserContext
- [ ] `BrowserManager.launchWithBrowser(browser, reuseContext, contextOptions)` spreads `contextOptions` into `browser.newContext()`
- [ ] When proxyPool is null, behavior identical to current code (no proxy per context)
- [ ] Each session created through SessionManager gets a different proxy from the pool (verifiable via `getNext()` call count)

**Write Scope:** `src/session/target-factory.ts`, `src/session/manager.ts`, `src/browser/manager.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Auto-rotate session on Google blocks

When Google block is detected during `goto` (Phase 2 prerequisite), destroy the session context and create a fresh one with a new proxy from the pool.

**CROSS-PHASE PREREQUISITE:** Requires Phase 2 TASK-003 (Google block detection in `src/browser/detection.ts`) and Phase 2 TASK-006 (wiring into goto handler) to be merged first. If Phase 2 is not yet available, skip this task entirely -- it can be added later.

**PROXY POOL ACCESS PATH:** The proxy pool is accessible at execution time via `ctx.session.proxyPool` (a `ProxyPool | null` field on Session). TASK-004 stores the proxy pool reference on the Session object when the SessionTargetFactory creates it. This task reads it; TASK-004 writes it. No changes to CommandContext needed.

**CRITICAL IMPLEMENTATION NOTE:** Auto-rotate CANNOT be implemented inside `handleWriteCommand()` because that function only receives `(args, BrowserTarget, domainFilter)` -- no session lifecycle access. Instead, implement it in the definition-backed execute wrapper in `registerWriteDefinitions()` (write.ts:1034). The execute function receives full `CommandContext` which has `ctx.session` (Session object with `.proxyPool`) and `ctx.sessionManager` (SessionManager).

Rotation flow:
1. Call `handleWriteCommand('goto', ...)` as normal
2. Check result for Google block signal (Phase 2 detection)
3. If blocked AND `ctx.session?.proxyPool?.canRotateSessions`: rotate
4. `ctx.sessionManager.closeSession(ctx.session.id)`
5. `ctx.sessionManager.getOrCreate(ctx.session.id)` -> fresh session with new proxy
6. Retry goto on new session's target
7. Track retry count per session (max `DEFAULTS.PROXY_MAX_ROTATE_RETRIES`)

1. **src/commands/write.ts** registerWriteDefinitions execute wrapper for 'goto':
   - After goto executes, check result for Google block signal and `ctx.session?.proxyPool?.canRotateSessions === true`
   - If rotatable: access the SessionManager through the command context, close the current session, and create a new one (which automatically gets a new proxy from the pool via the target factory)
   - Track retry count per session (max `DEFAULTS.PROXY_MAX_ROTATE_RETRIES`). After max retries, return the block error with a hint: 'Proxy rotation exhausted -- try a different proxy provider or country.'
   - The rotation is context-level only -- other sessions are not affected
   - Return a hint to the caller indicating rotation happened: 'Google block detected -- rotated proxy and retried.'

2. **Key invariant**: Context rotation destroys only the affected session. Other multiplexed sessions continue working with their existing proxies.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Google block + `pool.canRotateSessions` = session destroyed and recreated with new proxy
- [ ] Retry count tracked per session, max `DEFAULTS.PROXY_MAX_ROTATE_RETRIES` (3)
- [ ] After max retries, error with actionable hint
- [ ] Other sessions NOT affected by one session's rotation
- [ ] When pool is null or `canRotateSessions` is false, block returned as-is

**Write Scope:** `src/commands/write.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-006: Tests for proxy pool, providers, and rotation

Create `test/proxy.test.ts` with comprehensive tests for the proxy pool system.

1. **Provider tests**: decodoProvider username DSL, sanitization, capabilities. genericProvider pass-through. Registry getProvider/registerProvider. normalizePlaywrightProxy.

2. **Pool factory tests**: round_robin cycling, backconnect sticky sessions, null for missing config, buildProxyUrl for both modes.

3. **Per-context assignment tests**: Unique session IDs per context. Context-level isolation on rotation. Round-robin has no sessionId. Null pool returns null proxy.

4. **Factory integration tests** (mock-based): Factory calls pool.getNext() per context. No proxy when pool is null.

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All provider tests pass: decodo, generic, registry, normalizePlaywrightProxy
- [ ] All pool factory tests pass: round_robin cycling, backconnect sticky sessions, null for missing config
- [ ] Per-context assignment tests pass: unique sessions, isolation on rotation
- [ ] Tests achieve 90%+ coverage of `src/proxy/providers.ts` and `src/proxy/pool.ts`
- [ ] `npm test` runs the new test file without errors

**Write Scope:** `test/proxy.test.ts`
**Validation:** `npm test`

**Depends on:** TASK-003, TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Playwright per-context proxy is Chromium-only -- Firefox (camoufox) cannot use per-context proxy | TASK-004 | When runtime is Firefox, pool falls back to browser-level proxy. Document limitation. |
| BROWSE_PROXY (legacy) conflicts with BROWSE_PROXY_STRATEGY | TASK-003 | Strategy takes precedence when set. Warning logged. Legacy behavior preserved when strategy unset. |
| Phase 2 Google block detection not yet merged -- TASK-005 has no trigger | TASK-005 | TASK-005 is P2 and deferred if Phase 2 not merged. Pool (TASK-001-004) is independently useful. |
| Backconnect credentials exposed in error messages or logs | TASK-001, TASK-003 | Logging redacts password fields. Error messages show server:port but never credentials. |
| Round-robin index wraps under concurrent session creation | TASK-002 | Simple counter with modulo. Concurrent skips are acceptable for proxy rotation. |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 + TASK-004 + TASK-006 = proxy pool with per-context rotation via env vars, tested
- **Not shippable without Phase 2:** TASK-005 (auto-rotate on Google blocks) requires Phase 2 Google block detection

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `createProxyPool('round_robin')` returns pool with cycling getNext() | TASK-006 | unit |
| `createProxyPool('backconnect')` returns pool with sticky session usernames | TASK-006 | unit |
| `decodoProvider.buildSessionUsername` shapes username with geo/session fields | TASK-006 | unit |
| `genericProvider.buildSessionUsername` passes through username with suffix | TASK-006 | unit |
| `getProvider()` returns built-in providers, null for unknown | TASK-006 | unit |
| `registerProvider()` adds custom provider | TASK-006 | unit |
| `createProxyPool` returns null for missing config | TASK-006 | unit |
| Factory passes proxy from pool to BrowserContext | TASK-006 | unit |
| Different sessions get different proxies | TASK-006 | unit |
| Context rotation destroys only affected session | TASK-006 | unit |
| Legacy BROWSE_PROXY works when BROWSE_PROXY_STRATEGY not set | TASK-006 | unit |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 6 |
| Layer Count | 4 |
| Critical Path | TASK-001 -> TASK-002 -> TASK-004 -> TASK-005 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001 | Provider interface and implementations (no dependencies) |
| 1 | TASK-002 | Pool factory depends on providers |
| 2 | TASK-003, TASK-004 | Server wiring and factory wiring (both depend on pool, independent of each other) |
| 3 | TASK-005, TASK-006 | Auto-rotate depends on factory; tests depend on both wiring tasks |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-004"],
  "TASK-006": ["TASK-003", "TASK-004"]
}
```
