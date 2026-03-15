# Plan: WebSocket/Beacon/EventSource Domain Interception

> Generated: 2026-03-15
> Branch: `feat/v0.2.0`
> Mode: HOLD

## Overview

Close the last network interception gap vs agent-browser. Currently, `DomainFilter` blocks HTTP requests via Playwright's `context.route()`, but WebSocket connections, `navigator.sendBeacon()`, and `EventSource` bypass the filter entirely. Fix by injecting a JS init script that wraps these APIs with domain checks before the page loads.

## Scope Challenge

- **Existing code:** `DomainFilter` class handles URL validation. `session-manager.ts` applies it via `context.route('**/*')`.
- **What's missing:** JS-level APIs (`WebSocket`, `sendBeacon`, `EventSource`) are not intercepted by Playwright's route system.
- **Ruled out:** CDP-level `Fetch.enable` interception (would require raw CDP calls, breaks Playwright abstraction). JS injection is simpler and covers all three APIs.
- **Mode:** HOLD — clean implementation with proper separation (script generation on `DomainFilter`, application in `session-manager`), plus tests.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  session-manager.ts                             │
│  ┌───────────────────────┐                      │
│  │ context.route('**/*') │ ← HTTP interception  │
│  │ (existing)            │   (unchanged)        │
│  └───────────────────────┘                      │
│  ┌─────────────────────────────┐                │
│  │ context.addInitScript(...)  │ ← TASK-001     │
│  │ Wraps: WebSocket,           │                │
│  │   EventSource, sendBeacon   │                │
│  └─────────────────────────────┘                │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  domain-filter.ts                  TASK-001     │
│  ┌──────────────┐  ┌──────────────────────┐     │
│  │ isAllowed()  │  │ generateInitScript() │     │
│  │ (existing)   │  │ (new — returns JS    │     │
│  │              │  │  that wraps WS/Beacon│     │
│  │              │  │  /EventSource)       │     │
│  └──────────────┘  └──────────────────────┘     │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  test/features.test.ts             TASK-002     │
│  - WebSocket blocked by domain filter           │
│  - EventSource blocked by domain filter         │
│  - sendBeacon blocked by domain filter          │
│  - Allowed domains still work                   │
│                                                 │
│  test/fixtures/websocket.html      TASK-002     │
│  - Test fixture that opens WebSocket            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  browser-manager.ts                TASK-003     │
│  recreateContext() — re-apply init script       │
│  after device/UA change                         │
└─────────────────────────────────────────────────┘
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Domain matching logic | `src/domain-filter.ts` `isAllowed()` | Reuse — embed same logic in generated JS |
| HTTP request blocking | `src/session-manager.ts:64` `context.route()` | Keep as-is — still needed for HTTP |
| Context recreation | `src/browser-manager.ts` `recreateContext()` | Extend — re-apply init script on new context |
| Test patterns | `test/features.test.ts` | Extend — add new describe block |

## Tasks

### TASK-001: Add `generateInitScript()` to DomainFilter and apply in SessionManager

Add a method to `DomainFilter` that returns a JS string wrapping `WebSocket`, `EventSource`, and `navigator.sendBeacon` with domain checks. Apply it via `context.addInitScript()` in `session-manager.ts` where the domain filter is already set up. Also apply it in `browser-manager.ts` `recreateContext()` so the script survives device/UA changes.

**Files to modify:**
- `src/domain-filter.ts` — add `generateInitScript(): string` method
- `src/session-manager.ts` — call `context.addInitScript(script)` after route setup
- `src/browser-manager.ts` — re-apply init script in `recreateContext()` (store script on instance)

**Implementation notes:**
- The generated JS must replicate the `isAllowed()` logic in pure browser JS (no Node imports)
- Wrap the original constructors/functions, check the URL domain, throw `Error` if blocked
- `WebSocket`: wrap constructor, extract hostname from `ws://` or `wss://` URL
- `EventSource`: wrap constructor, extract hostname from URL
- `sendBeacon`: wrap `navigator.sendBeacon`, check first arg URL
- Pass the allowed domains list as a JSON array embedded in the script string
- Non-HTTP URLs (data:, blob:) should be allowed through

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `generateInitScript()` returns valid JS that wraps WebSocket, EventSource, and sendBeacon
- [ ] Allowed domains pass through (WebSocket to allowed host connects normally)
- [ ] Blocked domains throw an Error with a message containing the blocked hostname

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Add integration tests for WebSocket/Beacon/EventSource interception

Create a test fixture and integration tests that verify the domain filter blocks WebSocket, EventSource, and sendBeacon to disallowed domains while allowing them to allowed domains.

**Files to create:**
- `test/fixtures/websocket.html` — HTML page that attempts WebSocket + sendBeacon + EventSource

**Files to modify:**
- `test/features.test.ts` — add describe block with 4+ tests

**Implementation notes:**
- Test fixture should attempt `new WebSocket('ws://...')`, `navigator.sendBeacon(url)`, `new EventSource(url)` and catch errors
- Use `page.evaluate()` in tests to verify the wrappers throw for blocked domains
- Test that allowed domains still work (WebSocket constructor doesn't throw)
- Use the existing test server's hostname as the allowed domain

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] WebSocket to blocked domain throws error (caught in page.evaluate)
- [ ] sendBeacon to blocked domain returns false or throws
- [ ] EventSource to blocked domain throws error
- [ ] WebSocket to allowed domain does NOT throw (constructor succeeds)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Preserve init script across context recreation

Ensure that when `recreateContext()` is called (device emulation, user-agent change), the domain filter init script is re-applied to the new context. Store the script string on `BrowserManager` and call `addInitScript()` on the new context.

**Files to modify:**
- `src/browser-manager.ts` — add `initScript` field, `setInitScript()` method, apply in `recreateContext()`
- `src/session-manager.ts` — call `manager.setInitScript(script)` when setting up domain filter

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] After `emulate iPhone 15` with domain filter active, WebSocket to blocked domain still throws
- [ ] After `useragent <string>` with domain filter active, init script still applied
- [ ] Without domain filter, no init script is injected (no overhead)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Page overrides `WebSocket` after our wrapper | TASK-001 | Use `Object.defineProperty` with `configurable: false` to lock the wrapper |
| Init script runs after page JS (race) | TASK-001 | `addInitScript` runs before any page JS by design (Playwright guarantee) |
| Allowed WebSocket connections break due to wrapper | TASK-001, TASK-002 | Wrapper must call original constructor with all args for allowed domains |
| Init script lost on context recreation | TASK-003 | Store script on BrowserManager, re-apply in recreateContext |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `DomainFilter.generateInitScript()` | TASK-002 | integration |
| WebSocket wrapper blocks disallowed domain | TASK-002 | integration |
| sendBeacon wrapper blocks disallowed domain | TASK-002 | integration |
| EventSource wrapper blocks disallowed domain | TASK-002 | integration |
| Init script survives context recreation | TASK-003 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"]
}
```
