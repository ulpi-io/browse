# Plan: browse roadmap v1.5–v2.2

> Generated: 2026-03-28
> Branch: per-version feature branches
> Mode: EXPANSION

## Overview

Full product roadmap from v1.5 through v2.2 — 6 versions spanning network intelligence, verification/CI, visual intelligence, native app automation, agent workflows, and an agent toolkit/SDK. Each version builds on the previous, compounding agent capability: network bodies enable assertions, assertions enable CI, CI proves enterprise value, proven patterns transfer to app automation, workflows compose everything, and project-local toolkit files make behavior reusable and version-controlled.

## Scope Challenge

All 8 previous plans shipped (cloud-providers, handoff, mcp-server, perf-audit, persistent-profiles, port-to-node, react-devtools, record-export). Current state: ~23.5K `src/` lines, 103 commands, v1.5.0. This plan covers the next ~18 months of development.

Ruled out: Lighthouse integration (perf-audit already better), AI-powered selectors (non-deterministic), visual regression service (screenshot-diff exists), browser cloud (partnered with Browserbase/Browserless), full test framework (browse is a tool, generates Playwright tests instead).

## Roadmap Shape

- **v1.5-v1.7 Core Browser Intelligence** — deepen the existing browser CLI/MCP product with network inspection, assertions, export, visual diagnostics, accessibility checks, and lower-round-trip agent ergonomics.
- **v2.0 Runtime Expansion** — add native app automation as a second runtime behind the same session/dispatch surface: macOS first, then Android, then iOS simulator, all behind one browse command model; browser behavior must remain unchanged.
- **v2.1 Thin Agent Workflows** — add orchestration helpers (`flow`, `retry`, `watch`) as a thin layer over existing commands, not as a competing full test framework.
- **v2.2 Agent Toolkit** — add SDK mode plus checked-in project files for detections, audit rules, saved flows, and config. Everything is local, version-controlled, and agent-editable; npm plugins are explicitly out of scope.

## Anti-Drift Rules

- Markdown and JSON are a paired artifact. Task IDs, file paths, dependencies, priorities, acceptance criteria, and coverage entries must stay isomorphic.
- Every acceptance criterion must be backed by at least one explicit test bullet in the owning test task or coverage map. No untested promises.
- Any task that changes shared runtime behavior must own the shared wiring files (`session/manager.ts`, `server.ts`, `automation/registry.ts`, `mcp/tools/index.ts`) instead of assuming they will be updated implicitly later.
- Parser, formatter, generator, and diff logic require unit/contract tests in addition to integration tests.
- Platform-specific features require mocked contract tests plus gated real-environment integration tests. Smoke coverage alone is insufficient.
- Packaging and distribution tasks require `npm pack`-level verification so shipped artifacts, `files`, `exports`, and bundled binaries are proven from the actual package output.

## Architecture

```
v1.5 Network Intelligence                v1.6 Verify                    v1.7 Visual Intelligence
┌─────────────────────────┐     ┌───────────────────────────┐     ┌──────────────────────────┐
│ network/buffers.ts      │     │ src/expect.ts       [011] │     │ src/visual.ts      [020] │
│   NetworkEntry + bodies │     │   condition parser        │     │   landmark scan          │
│                   [001] │     │   check loop              │     │   contrast check         │
│                         │     │                     [012] │     │   overlap detection      │
│ browser/manager.ts      │     │                           │     │   overflow detection     │
│   body capture    [002] │     │ perf-audit/index.ts       │     │   viewport bleed         │
│   header capture  [003] │     │   --budget logic    [013] │     │                    [021] │
│                         │     │                           │     │                          │
│ commands/read.ts        │     │ export/record.ts          │     │ commands/read.ts         │
│   request cmd     [005] │     │   replay + expects  [014] │     │   layout cmd       [024] │
│                         │     │   playwright export [015] │     │                          │
│ commands/meta/index.ts  │     │                           │     │ commands/meta/index.ts   │
│   api cmd         [006] │     │ commands/meta/index.ts    │     │   visual cmd       [023] │
│                         │     │   expect cmd        [012] │     │   a11y-audit cmd   [022] │
│ automation/action-      │     │ commands/write.ts         │     │                          │
│   context.ts      [046] │     │   request wait     [050] │     │                          │
│ commands/write.ts [047] │     │                           │     │                          │
│ settle mode       [048] │     │                           │     │                          │
│ cli.ts                  │     │                           │     │                          │
│   --network-bodies[004] │     │                           │     │                          │
└─────────────────────────┘     └───────────────────────────┘     └──────────────────────────┘
         │                                │                                │
         └────────────────────────────────┼────────────────────────────────┘
                                          │
v2.0 App Automation + Mobile Follow-on    │              v2.1 Workflows         v2.2 Agent Toolkit
┌──────────────────────────────┐          │     ┌─────────────────────┐  ┌──────────────────┐
│ browse-ax/ (Swift)           │          │     │ src/flow-parser.ts  │  │ automation/      │
│   tree/actions/state   [025] │          │     │              [035]  │  │   rules     [040]│
│   screenshot/input     [027] │          │     │                     │  │                  │
│ src/app/macos/         [028] │          │     │ commands/meta/      │  │ commands/meta/   │
│ src/app/manager.ts     [029] │          │     │   flow        [036] │  │   flows     [041]│
│ app target select      [031] │          │     │   retry       [037] │  │                  │
│ context + tests  [032][034]  │          │     │   watch       [038] │  │ src/sdk.ts [042] │
│                              │          │     └─────────────────────┘  │ detection/       │
│ browse-android/        [051] │          │                               │  custom     [043]│
│ src/app/android/       [052] │          │                               │                  │
│ browse-ios-runner/     [053] │          │                               │ -- browse.json   │
│ src/app/ios/           [054] │          │                               │    .browse/*[045]│
│ mobile select/tests [055][056]│         │                               └──────────────────┘
└──────────────────────────────┘          │
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Network event capture | `browser/manager.ts:1495-1527` — page.on('request/response/requestfinished') | Extend with body capture |
| Network buffer storage | `network/buffers.ts:14-21` — NetworkEntry interface | Extend with body/header fields |
| Network output format | `commands/read.ts:247-257` — network command | Reuse pattern for request command |
| HAR export with bodies | `network/har.ts:21-66` — formatAsHar() | Extend with optional bodies |
| Command registration | `automation/registry.ts` — registry-derived category sets | Extend for all new commands |
| MCP tool definitions | `mcp/tools/index.ts` — registry-derived tool definitions | Extend for all new commands |
| Chain sets | `commands/meta/system.ts` — chain command dispatch | Extend for new commands |
| perf-audit orchestrator | `perf-audit/index.ts:1-86` — PerfAuditReport | Extend with budget check |
| perf-audit formatter | `perf-audit/formatter.ts:96-102` — formatPerfAudit | Extend with budget output |
| Recording system | `export/record.ts:220-242` — exportReplay | Extend with expect steps |
| Ref selector resolution | `export/record.ts:43-145` — resolveRefSelectors | Reuse for Playwright test export |
| page.evaluate pattern | `perf-audit/index.ts` — large evaluate for metrics | Reuse for visual/a11y evaluate |
| Detection evaluate | `detection/frameworks.ts` — single evaluate, structured return | Reuse pattern for visual scan |
| ARIA snapshot | `browser/snapshot.ts:330-400` — tree + ref assignment | Reuse pattern for app snapshot |
| Init script injection | `browser/react-devtools.ts:46` — context.addInitScript | Reuse pattern for watch MutationObserver |
| Session multiplexing | `session/manager.ts:62-157` — getOrCreate | Extend for app sessions |
| Domain filter pattern | `security/domain-filter.ts` — class with init script generation | Model for AppManager |
| Action context | `automation/action-context.ts:266-349` — prepare/finalize pattern | Reuse for app action context |
| Test infrastructure | `test/setup.ts` + `test/test-server.ts` + `test/fixtures/` | Extend with API + visual fixtures |
| CLI flag pattern | `cli.ts:631-669` — flag extraction + env var + config | Reuse for --network-bodies, --app |
| RequestOptions | `server.ts:221-226` — interface for per-request config | Extend with networkBodies |

## Tasks

---

### v1.5 — Network Intelligence

---

### TASK-001: Extend NetworkEntry with body and header fields

Add optional body and header fields to the `NetworkEntry` interface in `network/buffers.ts`. This is the foundation type change that all v1.5 features build on.

**Files:** `network/buffers.ts`, `src/types.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `NetworkEntry` has optional fields: `requestBody?: string`, `requestHeaders?: Record<string, string>`, `responseBody?: string`, `responseHeaders?: Record<string, string>`
- [ ] TypeScript compiles cleanly — no existing code broken by optional field additions
- [ ] Edge case: large body strings don't affect ring buffer shift() performance (they're just string references)

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Capture request bodies in browser/manager.ts

Extend the `page.on('request', ...)` handler (line ~1495) to capture request bodies via `req.postData()` for POST/PUT/PATCH methods. Only when body capture is enabled (new `captureNetworkBodies` flag on BrowserManager).

**Files:** `browser/manager.ts`, `network/buffers.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] POST/PUT/PATCH requests have `requestBody` populated with `req.postData()` output
- [ ] GET/HEAD/DELETE requests have no requestBody (not wasted on empty bodies)
- [ ] Request headers captured via `req.headers()` when body mode enabled
- [ ] Edge case: `req.postData()` returns null for binary uploads — stored as `[binary upload]`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Capture response bodies in browser/manager.ts

Extend the `page.on('response', ...)` handler (line ~1506) to capture response bodies. Only for text-like content types (json, text, xml, html, javascript, css). Binary responses stored as `[binary N bytes]`. Body size capped at 256KB per entry (configurable via `BROWSE_NETWORK_BODY_LIMIT`).

**Files:** `browser/manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Text response bodies captured for json/text/xml/html/javascript/css content types
- [ ] Binary responses stored as `[binary N bytes]` (no data capture)
- [ ] Bodies truncated at 256KB with `...(truncated at 262144B)` suffix
- [ ] `response.text()` called inside try/catch — redirects, aborted requests don't throw
- [ ] Captured bodies obey a per-session byte budget in addition to the per-entry cap; oldest captured bodies are evicted first while request metadata remains available
- [ ] Edge case: concurrent responses don't block each other (async body reads)
- [ ] Edge case: response body unavailable after redirect (caught gracefully)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-001
**Priority:** P1

---

### TASK-004: Add --network-bodies CLI flag and env var

Add `--network-bodies` flag to CLI (follows same pattern as `--json`, `--content-boundaries`). When set, sends `X-Browse-Network-Bodies: 1` header to server. Server reads header into `RequestOptions.networkBodies` and passes to session's BrowserManager. Also support `BROWSE_NETWORK_BODIES=1` env var and `browse.json` `{ "networkBodies": true }`.

**Files:** `src/cli.ts`, `src/server.ts`, `src/config.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `--network-bodies` flag parsed, spliced from args, sets `cliFlags.networkBodies`
- [ ] `X-Browse-Network-Bodies: 1` header sent in sendCommand() when flag is set
- [ ] Server reads header, sets `captureNetworkBodies` on BrowserManager for the session
- [ ] `BROWSE_NETWORK_BODIES=1` env var and `browse.json` `networkBodies: true` work as fallback
- [ ] Edge case: flag only enables on first command to session (bodies enabled from that point forward, not retroactive)

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-002, TASK-003
**Priority:** P1

---

### TASK-005: Add `request` read command

New read command: `browse request <index|url-pattern>` inspects a single network entry in full detail (headers, bodies, timing). Searches by buffer index (numeric) or URL pattern match (most recent match). Formats output as structured text.

**Files:** `src/commands/read.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse request 3` returns the 3rd entry with method, URL, request headers/body, response headers/body, status, duration
- [ ] `browse request /api/cart` returns the most recent entry matching that URL pattern
- [ ] Output format: method + URL, request headers, request body, response headers, response body, timing
- [ ] Returns clear error when bodies not captured: "Request bodies not available. Enable with --network-bodies or BROWSE_NETWORK_BODIES=1."
- [ ] Edge case: index out of range → "No request at index N. Buffer has M entries."
- [ ] Edge case: no URL match → "No request matching '/pattern'. Recent: GET /api/users, POST /api/cart"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-001
**Priority:** P1

---

### TASK-006: Add `api` meta command

New meta command: `browse api <method> <url> [--body <json>] [--header <k:v>]` runs `fetch()` inside the page context, inheriting cookies and auth. Returns status, headers, and parsed body.

**Files:** `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse api GET https://api.example.com/me` returns status + headers + body using page context cookies
- [ ] `browse api POST https://api.example.com/cart --body '{"id":1}'` sends JSON body with Content-Type: application/json
- [ ] `--header Authorization:Bearer\ token` adds custom headers
- [ ] Response body parsed as JSON (pretty-printed) when content-type is json, raw text otherwise
- [ ] Edge case: CORS error → clear message "CORS blocked: origin mismatch. Navigate to the API's origin first, or use the --header flag."
- [ ] Edge case: network error → "Connection refused: <url>. Is the API server running?"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-001
**Priority:** P1

---

### TASK-007: MCP tools + CLI help + chain for v1.5 commands

Register `request` and `api` commands: MCP tool definitions in `mcp/tools/index.ts`, CLI help generated from `automation/registry.ts`, chain command sets in `commands/meta/system.ts`, SAFE_TO_RETRY for `request` (read-only).

**Files:** `mcp/tools/index.ts`, `src/cli.ts`, `src/commands/meta/index.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_request` MCP tool with `query` param (index or URL pattern)
- [ ] `browse_api` MCP tool with `method`, `url`, `body`, `headers` params
- [ ] `request` added to SAFE_TO_RETRY set (read-only, safe to retry)
- [ ] `api` NOT in SAFE_TO_RETRY (has side effects — POST/PUT/DELETE)
- [ ] CLI help lists both commands under appropriate categories

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-005, TASK-006
**Priority:** P1

---

### TASK-008: Extend HAR export with optional bodies

When body capture is enabled, include request/response bodies in HAR export. Bodies go into `request.postData.text` and `response.content.text` per HAR 1.2 spec.

**Files:** `src/network/har.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] HAR entries include `request.postData.text` when requestBody is present
- [ ] HAR entries include `response.content.text` when responseBody is present
- [ ] HAR entries without bodies (capture disabled) still export correctly (backward compatible)
- [ ] Edge case: truncated bodies include truncation suffix in HAR

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-001
**Priority:** P2

---

### TASK-009: Test fixtures and integration tests for v1.5

Add JSON API fixture routes plus a small SPA-style mutation fixture. Write integration tests covering network body capture, the `request` command, the `api` command, HAR export with bodies, action-context readiness, guarded writes, selector suggestions, and settle mode.

**Files:** `test/test-server.ts`, `test/features.test.ts`, `test/action-context.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test fixture: `POST /api/echo` route that returns request body as JSON response
- [ ] Test fixture: `GET /api/data` route that returns a known JSON payload
- [ ] Test: network buffer captures request body for POST to echo endpoint
- [ ] Test: network buffer captures response body for GET data endpoint
- [ ] Test: `request /api/data` returns full entry with body
- [ ] Test: `api GET <baseUrl>/api/data` returns parsed JSON
- [ ] Test: response-body byte-budget eviction keeps latest captured bodies while older body payloads fall back gracefully
- [ ] Test: body truncation at limit works correctly
- [ ] Test: `api GET` with a session cookie set earlier sends the cookie through page-context fetch
- [ ] Edge case test: binary response body stored as `[binary N bytes]`
- [ ] Test: `api GET` with session cookie set via `cookie` command → verify cookie appears in request sent by fetch
- [ ] Test: action-context marks `settled:false` while a delayed mutation or matching request is still pending, then `settled:true` once the page quiets
- [ ] Test: `click --if-exists` skips cleanly when a dismissible element is absent
- [ ] Test: `fill --if-empty` skips when the target already has a value
- [ ] Test: selector-not-found error includes up to 3 concrete suggestions when close matches exist
- [ ] Test: `set settle on` causes a write command to wait for the quiet window before returning

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-004, TASK-005, TASK-006, TASK-046, TASK-047, TASK-048
**Priority:** P2

---

### TASK-046: Add page readiness signal to action-context

Extend action-context so write-command responses report whether the page is settled after the action. Readiness is based on both pending network requests and recent DOM mutation activity, giving agents a cheap signal for “act now” vs “wait”.

**Files:** `src/automation/action-context.ts`, `src/browser/manager.ts`, `src/browser/target.ts`, `src/types.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Context-enabled write responses include `settled:true|false`
- [ ] Readiness combines `networkPendingCount === 0` with a 300ms DOM-mutation quiet window
- [ ] When unsettled, context output includes the blocking reason(s): pending request count and/or recent mutation age
- [ ] DOM-mutation tracking resets correctly on navigation and tab switch
- [ ] Edge case: long-lived sockets / streaming requests do not keep the page permanently unsettled

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-047: Add guarded write flags and selector suggestions

Reduce guard snapshots by adding conditional flags to common write commands. When an action is skipped, return a deterministic skip result instead of throwing. When an unguarded selector fails, surface close-match suggestions so the agent can recover without a full snapshot round-trip.

**Files:** `src/commands/write.ts`, `src/automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `click`, `hover`, `focus`, and `tap` support `--if-exists` and `--if-visible`
- [ ] `fill` supports `--if-empty`
- [ ] `check` supports `--if-unchecked`
- [ ] Skipped guarded actions return a deterministic `SKIP:` result instead of throwing
- [ ] Unguarded selector-not-found errors include up to 3 concrete suggestions when close matches exist
- [ ] Edge case: invalid selector syntax or malformed usage still throws immediately (guard flags do not swallow usage bugs)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-048: Add session-scoped settle mode

Add an opt-in settle mode for sessions: `browse set settle on|off`. When enabled, write commands automatically wait for the page readiness signal to report settled before returning, eliminating many manual `wait --network-idle` calls.

**Files:** `src/commands/write.ts`, `src/session/manager.ts`, `src/types.ts`, `src/automation/action-context.ts`, `src/automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse set settle on` enables post-write settling for the active session and `browse set settle off` disables it
- [ ] When enabled, navigation and interaction write commands wait for the readiness signal before returning
- [ ] Default settle quiet window is 300ms with a documented timeout guard
- [ ] `wait` and `set settle` do not recursively trigger settle mode
- [ ] On settle timeout, the command returns its normal result plus an explicit `settled:false (timeout)` context note instead of hanging indefinitely

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-046
**Priority:** P1

---

### v1.6 — Verify

---

### TASK-010: Implement expect condition parser

Create `src/expect.ts` with `parseExpectArgs(args: string[]): ExpectConditions` that parses `--url`, `--text`, `--visible`, `--hidden`, `--count <sel> --eq/--gt/--lt N`, `--request <pattern> --status N`, `--timeout N` flags. Also export `checkConditions()` that evaluates all conditions against current page state.

**Files:** `src/expect.ts` (new)

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Parses `--url "/checkout"` into URL contain check
- [ ] Parses `--text "Order confirmed"` into text visibility check
- [ ] Parses `--visible ".banner"` / `--hidden ".modal"` into visibility checks
- [ ] Parses `--count ".item" --eq 3` into element count assertion
- [ ] Parses `--request "POST /api" --status 200` into network buffer search
- [ ] Parses `--timeout 5000` (default 3000ms)
- [ ] `checkConditions()` returns array of `{ passed: boolean, description: string, actual: string }`
- [ ] Edge case: invalid comparator or malformed `--request/--status` combination throws a clear usage error
- [ ] Edge case: no conditions → throws "Usage: browse expect <conditions>"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-011: Implement `expect` meta command

Add `case 'expect':` to `src/commands/meta/index.ts`. Polls conditions in a loop (100ms interval) until all pass or timeout. Exit with clear error on failure, silent OK on success.

**Files:** `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse expect --url "/checkout" --timeout 5000` waits up to 5s for URL match
- [ ] On success: returns "OK" (or verbose output with `--verbose`)
- [ ] On failure: throws error with "FAIL: Expected URL to contain '/checkout' but got '/cart' after 5000ms"
- [ ] Multiple conditions: all must pass (AND logic)
- [ ] Condition check interval: 100ms (not burning CPU)
- [ ] Edge case: timeout 0 → check once and return immediately (no polling)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-010
**Priority:** P1

---

### TASK-050: Add request-matching mode to `wait`

Extend `wait` with `--request <pattern> [--status N]` so agents can wait for a specific API request to complete before proceeding. This should reuse the same request/status matcher semantics as `expect --request`.

**Files:** `src/commands/write.ts`, `src/expect.ts`, `src/automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse wait --request "POST /api/order" --status 200 --timeout 10000` returns when a matching completed request exists in the buffer or arrives before timeout
- [ ] If `--status` is omitted, the first completed matching request satisfies the wait
- [ ] Request matcher semantics are shared with `expect --request` so method/path/status parsing does not diverge
- [ ] Timeout error includes the most recent matching request(s) or last seen matching status for debugging
- [ ] Edge case: `--status` without `--request` throws a clear usage error
- [ ] Edge case: a matching request that started but did not finish before timeout does not satisfy the wait

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-010
**Priority:** P1

---

### TASK-012: Add --budget flag to perf-audit

Parse `--budget lcp:2500,cls:0.1,tbt:300` flag in perf-audit command. After audit completes, compare each metric against budget. If any budget exceeded, format a pass/fail report and throw an error (server returns 500 → CLI exits with code 1).

**Files:** `src/perf-audit/index.ts`, `src/perf-audit/formatter.ts`, `src/commands/meta/index.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--budget lcp:2500,cls:0.1,tbt:300` parsed into `Record<string, number>`
- [ ] Supported metric keys: `lcp`, `cls`, `tbt`, `fcp`, `ttfb`, `inp` (case-insensitive)
- [ ] Budget exceeded → error thrown with per-metric pass/fail breakdown
- [ ] Budget passed → normal perf-audit output + "All budgets met." suffix
- [ ] Exit code 1 on failure (CLI propagates server 500 as exit(1))
- [ ] Budget evaluation is implemented as a deterministic, directly testable unit over collected metric values rather than only through live-browser timing assertions
- [ ] Edge case: metric not measured (e.g., INP on page with no interaction) → skipped, not failed

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-013: Extend exportReplay with expect assertion steps

Extend `exportReplay()` in `src/export/record.ts` to serialize recorded `expect` commands as `waitForElement` or `waitForExpression` steps in the Chrome DevTools Recorder format. When an expect command is recorded, it should produce a proper assertion step.

**Files:** `src/export/record.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `expect --url "/checkout"` → `{ type: 'waitForExpression', expression: 'window.location.href.includes("/checkout")' }`
- [ ] `expect --text "Order"` → `{ type: 'waitForElement', selectors: ['text/Order'] }`
- [ ] `expect --visible ".banner"` → `{ type: 'waitForElement', selectors: ['.banner'] }`
- [ ] Non-expect commands export unchanged (backward compatible)
- [ ] Edge case: expect with --timeout maps to step timeout property

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-010
**Priority:** P1

---

### TASK-014: Add exportPlaywrightTest function

Add `exportPlaywrightTest(steps: RecordedStep[]): string` to `src/export/record.ts`. Maps recorded commands to Playwright Test API calls with proper `expect()` assertions. Uses resolved selectors from recording.

**Files:** `src/export/record.ts`, `src/commands/meta/index.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `goto url` → `await page.goto('url');`
- [ ] `click @e3` (with resolved ARIA selector) → `await page.getByRole('button', { name: 'Submit' }).click();`
- [ ] `fill @e4 "value"` → `await page.getByRole('textbox', { name: 'Email' }).fill('value');`
- [ ] `expect --url "/checkout"` → `await expect(page).toHaveURL(/checkout/);`
- [ ] `expect --text "Order"` → `await expect(page.getByText('Order')).toBeVisible();`
- [ ] `record export playwright [path]` subcommand registered in meta.ts
- [ ] Generated file imports `{ test, expect }` from `@playwright/test` and wraps in `test('recorded flow', ...)`
- [ ] Generated Playwright source parses without syntax errors and is safe to hand to `tsc --noEmit`
- [ ] Edge case: commands without resolved selectors fall back to CSS selectors

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-013
**Priority:** P1

---

### TASK-015: MCP tools + CLI help + chain for v1.6 commands

Register `expect` command: MCP tool definition, CLI help text, chain set, SAFE_TO_RETRY. Update perf-audit MCP tool description to mention `--budget`.

**Files:** `mcp/tools/index.ts`, `src/cli.ts`, `src/commands/meta/index.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_expect` MCP tool with url, text, visible, hidden, count, timeout params
- [ ] `expect` added to SAFE_TO_RETRY (read-only assertions, safe to retry)
- [ ] CLI help lists `expect` under Verification category
- [ ] `browse_perf_audit` description updated to mention `--budget`
- [ ] `record export playwright` listed in CLI help alongside `replay` and `browse`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-011, TASK-012, TASK-014
**Priority:** P2

---

### TASK-016: Integration tests for expect + wait-request + budget

Test expect command with all condition types (url, text, visible, count, request/status, timeout), the new request-matching wait mode, and perf-audit budget mode with deterministic metric fixtures.

**Files:** `test/features.test.ts`, `test/expect.test.ts` (new), `test/perf-audit-budget.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `expect --url` succeeds when URL matches
- [ ] Test: `expect --url` fails with FAIL message when timeout
- [ ] Test: `expect --text` finds visible text
- [ ] Test: `expect --visible` / `--hidden` work on visible/hidden elements
- [ ] Unit test: parser accepts valid flag combinations and rejects malformed comparator / request-status combinations with actionable errors
- [ ] Test: `expect --count ".item" --eq N` counts correctly
- [ ] Test: `expect --request "POST /api" --status 200` succeeds when matching request is present
- [ ] Test: `expect --request "POST /api" --status 500` fails with clear actual-status output
- [ ] Test: multiple conditions (--url + --text) require all to pass
- [ ] Test: `wait --request "POST /api" --status 200` succeeds when the matching request completes
- [ ] Test: `wait --request "POST /api" --status 500` times out with clear last-seen-status output
- [ ] Test: `wait --request "POST /api"` succeeds without a status filter
- [ ] Unit test: budget evaluator supports `lcp`, `cls`, `tbt`, `fcp`, `ttfb`, `inp` and skips unmeasured metrics deterministically
- [ ] Test: budget pass — deterministic metric fixture stays under budget
- [ ] Test: budget fail — LCP over budget → error thrown with pass/fail breakdown
- [ ] Edge case test: timeout 0 checks once without polling

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-011, TASK-012, TASK-050
**Priority:** P2

---

### TASK-017: Integration tests for export (replay expects + playwright)

Test that recorded sessions with expect commands export correctly to both Puppeteer Replay and Playwright Test formats.

**Files:** `test/features.test.ts`, `test/record-export.test.ts` (new)

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test: recorded expect --url exports as waitForExpression in replay format
- [ ] Test: recorded expect --text exports as waitForElement in replay format
- [ ] Test: recorded session exports valid Playwright test file with `test()` wrapper
- [ ] Test: generated Playwright test includes `expect(page).toHaveURL()` for URL assertions
- [ ] Test: generated Playwright test parses as valid TypeScript/JavaScript source
- [ ] Edge case test: recording with no expects exports without assertion steps

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-013, TASK-014
**Priority:** P2

---

### v1.7 — Visual Intelligence

---

### TASK-018: Implement visual evaluate script — core infrastructure

Create `src/visual.ts` with the `page.evaluate()` function that captures page layout structure: viewport dimensions, body scroll height, landmark elements (header, nav, main, footer, section, article, [role=dialog/alert]) with bounding boxes, position type, z-index, background color, and child summaries. Also implement helper functions: `parseColor()`, `luminance()`, `getEffectiveBg()`, `overlaps()`, `summarizeChildren()`.

**Files:** `src/visual.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `captureVisualState(page)` returns `VisualReport` with viewport, landmarks[], issues[]
- [ ] Landmark scan finds header/nav/main/footer/section/article and ARIA-role landmarks
- [ ] Each landmark has: tag, y position, height, position type, z-index, background, child summary
- [ ] `parseColor()` handles rgb(), rgba(), hex (#fff, #ffffff), and named colors (red, blue)
- [ ] `luminance()` implements WCAG relative luminance formula correctly
- [ ] `getEffectiveBg()` walks ancestor chain to find first non-transparent background
- [ ] `overlaps()` checks bounding box intersection
- [ ] Edge case: page with no landmarks returns empty landmarks array (no crash)
- [ ] Edge case: element with `display: none` excluded from scan

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-019: Implement visual evaluate script — anomaly detection

Extend `src/visual.ts` evaluate with 5 anomaly detectors: contrast failures (WCAG 2.1 AA), element overlap (positioned elements with intersecting bounds), horizontal overflow (scrollWidth > clientWidth), vertical overflow with clipping (overflow:hidden + content exceeds), and viewport bleed (element right edge > viewport width).

**Files:** `src/visual.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Contrast: flags text elements below 4.5:1 ratio (3.0:1 for large text ≥24px or ≥18.66px bold)
- [ ] Overlap: detects positioned elements with intersecting bounding boxes where z-index suggests unintended stacking
- [ ] Overflow-x: detects elements where scrollWidth > clientWidth + 2
- [ ] Overflow-hidden: detects content clipped by overflow:hidden parent
- [ ] Viewport bleed: detects elements extending past window.innerWidth
- [ ] Each issue includes: type, element description, specific values (ratio, overlap px, overflow px), y position
- [ ] Edge case: gradient backgrounds → skip contrast check (can't compute single color)
- [ ] Edge case: iframe content not scanned (stays within main document)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-018
**Priority:** P1

---

### TASK-020: Implement visual formatter and `visual` meta command

Add text formatter for VisualReport: viewport summary line, landmark structure with indentation, issues list with severity markers. Register `visual` as META command.

**Files:** `src/visual.ts`, `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse visual` returns formatted report: viewport line, landmark tree, issues list
- [ ] Landmarks indented by nesting (main > hero section > grid)
- [ ] Issues formatted as: `⚠ type  element  details  y-position`
- [ ] `--json` flag returns raw VisualReport as JSON
- [ ] Report generated in <200ms for typical pages (single evaluate call)
- [ ] Edge case: page with zero issues shows "No visual issues detected."

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-018, TASK-019
**Priority:** P1

---

### TASK-021: Add `layout` read command

New read command: `browse layout <selector>` returns computed layout properties for one element and its positioning ancestors.

**Files:** `src/visual.ts`, `src/commands/read.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] Returns: display, position, z-index, box (WxH at X,Y), margin, padding, overflow, font, color+bg with contrast ratio
- [ ] Walks ancestor chain showing only positioning ancestors (skips static elements)
- [ ] Supports @ref selectors (resolves via bm.resolveRef)
- [ ] Edge case: selector not found → "Element not found: <selector>"
- [ ] Edge case: element is `display: none` → shows properties but notes "hidden"

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-018
**Priority:** P1

---

### TASK-022: Implement a11y-audit evaluate and `a11y-audit` meta command

Add WCAG 2.1 AA audit: contrast ratio check (all text), missing alt on images, inputs without labels, heading hierarchy (no skips), focus order (tabindex vs DOM order), touch targets (<44x44px), links with generic text, missing lang attribute. Returns score (0-100) + critical/warning findings.

**Files:** `src/visual.ts`, `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Score calculation: 100 minus deductions (critical -10, warning -3, info -1, capped at 0)
- [ ] Contrast: count of elements below threshold, threshold varies by text size
- [ ] Missing alt: images without alt attribute (decorative images with alt="" excluded)
- [ ] No label: inputs/selects/textareas without associated label element or aria-label
- [ ] Heading hierarchy: h1→h3 skipping h2 flagged as warning
- [ ] Touch targets: interactive elements <44x44px flagged as warning
- [ ] Generic link text: "click here", "read more", "learn more" flagged
- [ ] Missing lang: `<html>` without lang attribute → critical
- [ ] Edge case: page in iframe → only audit main frame

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-018
**Priority:** P1

---

### TASK-023: MCP tools + CLI help + chain for v1.7 commands

Register `visual`, `layout`, `a11y-audit`: MCP tools, CLI help, chain sets, SAFE_TO_RETRY (all read-only).

**Files:** `mcp/tools/index.ts`, `src/cli.ts`, `src/commands/meta/index.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_visual` MCP tool (no params, returns formatted report)
- [ ] `browse_layout` MCP tool with `selector` param
- [ ] `browse_a11y_audit` MCP tool (no params, returns score + findings)
- [ ] All three added to SAFE_TO_RETRY (read-only)
- [ ] CLI help lists under Visual/Accessibility category

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-020, TASK-021, TASK-022
**Priority:** P2

---

### TASK-024: Test fixtures and integration tests for v1.7

Create HTML fixtures with known visual issues and accessibility problems. Write integration tests verifying detection plus unit tests for visual helpers.

**Files:** `test/fixtures/visual-issues.html` (new), `test/fixtures/a11y-issues.html` (new), `test/features.test.ts`, `test/visual.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Fixture: visual-issues.html with low-contrast text, overlapping positioned elements, overflow, viewport bleed
- [ ] Fixture: a11y-issues.html with missing alt, missing labels, skipped headings, small touch targets, generic links, no lang
- [ ] Test: `visual` detects contrast failure in fixture
- [ ] Test: `visual` detects overlap in fixture
- [ ] Test: `visual` detects overflow in fixture
- [ ] Unit test: `parseColor()`, `luminance()`, `overlaps()`, and effective-background resolution handle the documented edge cases
- [ ] Test: `layout` returns correct computed properties for known element
- [ ] Test: `a11y-audit` score < 100 on issues fixture, identifies alt/label/heading/touch-target/generic-link/missing-lang findings
- [ ] Test: focus-order warning triggers for tabindex-vs-DOM-order mismatch
- [ ] Test: gradient background skips contrast check rather than emitting a false failure
- [ ] Test: `a11y-audit` score = 100 on clean fixture (basic.html)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-020, TASK-021, TASK-022
**Priority:** P2

---

### v2.0 — Beyond the Browser (Native App Automation, macOS first)

This version extends browse from "browser automation" into "UI automation with one interaction model." The product goal is not to bolt on a separate desktop-testing tool. The goal is to let an agent use the same browse primitives against native apps that it already uses against web pages: inspect structure, get refs, act on elements, read resulting state, and route everything through the same executor, session, MCP, and CLI surfaces.

The architecture choice is deliberate: learn from Maestro's runtime split, but do not copy its product shape. Browse owns the user-facing model. Platform runtimes stay behind a narrow adapter boundary.
- host-side session/orchestration stays inside browse
- each platform provides a target-local runtime/controller
- browse normalizes tree/action/state into refs, snapshots, action-context, MCP, and CLI output

`v2.0` ships `macOS` first because it is the most believable first-party native target. Future `iOS` and `Android` support should plug into the same app-runtime contract with runner-based transports where needed, but browse must keep one command model, one registry, and one transport surface. No second DSL. No duplicated `browse_app_*` namespace. No mobile-specific fork of the product.

#### Mobile follow-on design (Android first, iOS simulator second)

This follow-on is grounded in Maestro's runtime lessons, but browse improves on them rather than copying them.
- Android uses a browse-owned on-device instrumentation service reached through `adb` port-forwarding and a typed host protocol. Browse, not the device runtime, owns ref assignment, snapshot formatting, action-context, and MCP/CLI semantics.
- iOS uses a browse-owned simulator-controller + XCTest-runner split. `simctl` manages boot/install/launch, the runner exposes a narrow tree/action/state protocol, and browse again owns normalization, refs, and command semantics.
- Android lands before iOS because the instrumentation path is more scriptable and cheaper to support. iOS scope is simulator-only in this roadmap window. Real iOS devices are explicitly out of scope until the simulator contract is proven.
- The improvement over Maestro is structural: browse standardizes one host-side app-runtime contract across `macOS`, `Android`, and `iOS` instead of letting each platform grow its own command vocabulary, transport surface, or DSL.

---

### TASK-025: App runtime contract + macOS AX tree bridge

Create `src/app/types.ts` with the normalized app-node / app-state contract browse will own, and create `browse-ax/` as a Swift CLI that reads the accessibility tree of a running macOS application by PID. The bridge stays narrow: raw JSON tree in, raw JSON tree out. Browse owns ref assignment, snapshot formatting, and command semantics.

**Files:** `browse-ax/Package.swift` (new), `browse-ax/Sources/main.swift` (new), `src/app/types.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `browse-ax --pid <pid> tree` outputs JSON tree for the target app/window
- [ ] Each node includes stable `path` plus role, label, value, frame, enabled, focused, selected, editable, actions, children
- [ ] Bridge output contains no browse `@refs` and no CLI formatting
- [ ] Supports deterministic frontmost-window targeting for the PID
- [ ] Tree depth limited to 30 levels (prevent infinite recursion on malformed trees)
- [ ] Edge case: app is not running → exit with clear error "No process with PID N"
- [ ] Edge case: no accessibility permission → exit with "Grant Accessibility permission in System Settings"

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-026: macOS AX bridge — action execution + value mutation

Add `browse-ax --pid <pid> action <node-path> <action-name>` and `browse-ax --pid <pid> set-value <node-path> <value>`. Node path is a JSON array of child indices. The bridge operates only on node paths, never on browse refs.

**Files:** `browse-ax/Sources/main.swift`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `action [0,2,1] AXPress` performs press action on resolved element
- [ ] `set-value [0,1,3] "test@example.com"` sets AXValue on editable controls
- [ ] Returns JSON `{ "success": true }` on success
- [ ] Returns JSON `{ "success": false, "error": "Action not supported" }` on unsupported action
- [ ] Element path resolution walks tree by child indices
- [ ] Edge case: path out of bounds → clear error with available children count
- [ ] Edge case: element no longer exists (stale path) → "Element not found at path"
- [ ] Edge case: target element is not editable → "Element is not editable"

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-027: macOS AX bridge — focused input, screenshot, and state probe

Add focused-element keyboard input commands (`type`, `press`), `browse-ax --pid <pid> screenshot <path>` for capturing the target window as PNG, and a lightweight `state` command for action-context / readiness (`windowTitle`, `focusedPath`, `elementCount`, `windowCount`, optional static/screen-stable hint).

**Files:** `browse-ax/Sources/main.swift`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `type "hello"` sends text input to the currently focused element
- [ ] `press Enter` sends a key event to the focused element
- [ ] Returns success/failure JSON
- [ ] `screenshot /tmp/app.png` captures the frontmost window of the target PID as PNG
- [ ] Uses CGWindowListCreateImage for window capture (no full-screen capture)
- [ ] `state` returns at least: windowTitle, focusedPath, elementCount, windowCount, appName
- [ ] If a static/screen-stable hint is cheaply available, `state` includes it; otherwise the field is omitted without failure
- [ ] Edge case: no focused element for `type` / `press` → clear error instead of silent drop
- [ ] Edge case: app window is minimized → "Window is minimized. Restore it first."

**Agent:** ios-macos-senior-engineer
**Review:** none
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-028: Build system + runtime resolution for macOS bridge

Configure build process: produce distributable macOS bridge artifacts, include them in the npm package (or lazily download them), and resolve the correct binary at runtime behind a macOS-specific module. Keep bootstrap and runtime resolution isolated from CLI/server transport code.

**Files:** `browse-ax/Package.swift`, `package.json`, `scripts/build-all.sh`, `src/app/macos/bridge.ts` (new), `src/app/index.ts` (new)

**Type:** infra
**Effort:** M

**Acceptance Criteria:**
- [ ] Build pipeline produces arm64 and x86_64 bridge artifacts and packages either a universal binary (`lipo`) or an explicit per-arch runtime selection strategy
- [ ] Binary included in npm package (or lazy-downloaded to `.browse/bin/browse-ax` on first use)
- [ ] `src/app/macos/bridge.ts` exports `ensureMacOSBridge(): Promise<string>` that returns path to binary (download if needed)
- [ ] Works on macOS arm64 and x86_64
- [ ] `npm pack` verification proves the shipped tarball contains the expected bridge artifact metadata or lazy-download bootstrap files
- [ ] Edge case: non-macOS platform → throws "App automation requires macOS (uses Accessibility API)"
- [ ] Bridge bootstrap is isolated to the app domain, not scattered across CLI/server code

**Agent:** ios-macos-senior-engineer
**Review:** none
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-029: App domain runtime — normalize tree, snapshot, text

Create the app domain runtime that spawns `browse-ax`, normalizes raw AX output into browse-owned node/state structures, assigns refs host-side, and implements `connect(appName)`, `snapshot(opts)`, and `text()`.

**Files:** `src/app/normalize.ts` (new), `src/app/manager.ts` (new), `src/app/index.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `connect("Simulator")` resolves the target app by exact app name or bundle id and spawns `browse-ax`
- [ ] Ambiguous matches fail with explicit choices instead of guessing
- [ ] `snapshot({ interactive: true })` returns text with @refs (same format as web snapshot)
- [ ] @refs are assigned host-side from normalized node paths, not by the bridge
- [ ] `text()` extracts visible AXTitle / AXValue / label strings as visible text
- [ ] Ref map stored for later tap/fill resolution
- [ ] Edge case: app not running → "App 'Simulator' is not running"
- [ ] Edge case: frontmost-window selection is deterministic and documented

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-025, TASK-028
**Priority:** P1

---

### TASK-030: App domain runtime — tap, fill, type, press, screenshot

Add interaction methods to the app runtime: `tap(ref)` → bridge action, `fill(ref, value)` → bridge set-value, `type(text)` / `press(key)` → focused input, `screenshot()` → bridge screenshot.

**Files:** `src/app/manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `tap(@e3)` resolves ref to node path, performs bridge action
- [ ] `fill(@e2, "test")` resolves ref, performs bridge set-value
- [ ] `type("hello")` sends keyboard input through the focused-element command
- [ ] `press("Enter")` sends key event through the focused-element command
- [ ] `screenshot()` captures the active target window through the bridge
- [ ] Each method returns confirmation string (same format as web commands)
- [ ] Edge case: stale ref → "Ref @e3 not found. Run 'snapshot' to refresh."
- [ ] Edge case: unsupported action on target element → clear error from the bridge/runtime

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-029
**Priority:** P1

---

### TASK-031: Unified target selection + capability gating

Integrate app targets through the existing registry / executor / session architecture. Add `--app <name>` as target selection, not as a second dispatcher surface. Keep the same commands across browser and app targets and reject unsupported capabilities centrally.

**Files:** `src/cli.ts`, `src/server.ts`, `src/session/target-factory.ts`, `src/session/manager.ts`, `src/automation/registry.ts`, `src/automation/command.ts`, `src/types.ts`, `src/app/manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse --app "Simulator" snapshot -i` routes through the same executor used by browser commands
- [ ] `browse --app "Simulator" tap @e3` routes through the same executor used by browser commands
- [ ] Shared session-target abstraction cleanly separates browser sessions from app sessions while preserving existing browser dispatch behavior
- [ ] Supported app-target commands: snapshot, text, tap, fill, type, press, screenshot
- [ ] Unsupported commands (html, css, js, etc.) → clear error "Command 'html' not available for app targets. Use 'text' or 'snapshot' instead."
- [ ] `--app` flag stored in `cliFlags.app`, sent as `X-Browse-App` header
- [ ] App targets are created through `SessionTargetFactory`, not ad hoc in transport code
- [ ] Unsupported-command gating happens centrally before command execution, not ad hoc in scattered handlers
- [ ] Edge case: `--app` and `--session` work together (isolated app sessions)
- [ ] The app-target contract is shaped so future iOS/Android runtimes can plug in without changing CLI or MCP semantics

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-029, TASK-030
**Priority:** P1

---

### TASK-032: Action context + readiness for app targets

Wire action context into app commands using lightweight before/after `state` probes from the bridge/runtime. State = current screen title, focused element, element count, optional static/screen-stable signal. Delta = screen changed, focus changed, element count changed, readiness changed.

**Files:** `src/app/manager.ts`, `src/automation/action-context.ts`, `src/app/types.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] After `tap @e3`, context line shows screen change: `[context] screen: "Login" | focus: @e4`
- [ ] After `fill @e2 "text"`, context line shows value set (or nothing if no screen change)
- [ ] State captured via lightweight bridge/runtime probe rather than full snapshot formatting
- [ ] When available, context includes `settled: true|false` for app-target writes
- [ ] Empty context line when nothing changes (same as web behavior)
- [ ] Edge case: app crash between before/after → context gracefully skipped
- [ ] Edge case: static/screen-stable hint unavailable → context still works without the readiness field

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-029, TASK-031
**Priority:** P2

---

### TASK-033: CLI, MCP, and doctor integration for app targets

Update help, MCP, and `doctor` to support app targets on the same command surface. Do not create a second `browse_app_*` namespace. Existing tools/commands must accept target selection and route through the same definitions.

**Files:** `src/mcp/tools/index.ts`, `src/cli.ts`, `src/commands/meta/index.ts`, `src/automation/registry.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] Existing MCP tools can target apps through session state or explicit target-selection params
- [ ] No duplicated `browse_app_*` MCP inventory is introduced
- [ ] CLI help shows `--app <name>` in Options section with description and macOS-only note
- [ ] `browse doctor` checks: browse-ax binary present, Accessibility permission granted
- [ ] `browse doctor` shows explicit next-step instructions when the bridge or permission is missing
- [ ] Edge case: non-macOS → doctor reports "App automation not available (macOS only)"

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-031
**Priority:** P2

---

### TASK-034: Integration tests + future mobile runtime contract harness

Test the app runtime with mocked bridge-protocol tests plus a gated real macOS integration target (TextEdit or a test Electron app). Also define a runtime-contract harness so future Android/iOS adapters can reuse the same host-side normalization, refs, actions, and context semantics without changing browse commands.

**Files:** `test/app.test.ts` (new), `test/app-manager.test.ts` (new), `test/app-runtime-contract.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: snapshot on TextEdit returns accessibility tree with @refs
- [ ] Test: text on TextEdit returns window content
- [ ] Test: fill on TextEdit text field sets value
- [ ] Test: action context reports changes after interaction
- [ ] Unit/contract test: mocked bridge returns permission denied / app-not-running / stale-ref / ambiguous-app failures with the documented messages
- [ ] Test: unsupported app command is rejected centrally with the documented guidance
- [ ] Test: browser session behavior is unchanged while an app session is active
- [ ] Test: runtime-contract harness covers `tree`, `action`, `set-value`, `type`, `press`, `screenshot`, and `state`
- [ ] Skip: real-macOS tests skip on non-macOS platforms (CI compatibility)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-031, TASK-032, TASK-033
**Priority:** P2

---

### TASK-051: Android driver workspace + on-device instrumentation protocol

Create `browse-android/` as a Kotlin/Gradle workspace that packages a browse-owned instrumentation driver for Android emulators. Follow the good lesson from Maestro's Android stack — host orchestration plus on-device runtime — but keep the browse app-runtime contract canonical. The on-device service speaks a narrow transport (`tree`, `action`, `set-value`, `type`, `press`, `screenshot`, `state`) and never emits browse refs or CLI/MCP formatting.

**Files:** `browse-android/settings.gradle.kts` (new), `browse-android/app/build.gradle.kts` (new), `browse-android/app/src/androidTest/java/io/ulpi/browse/driver/BrowseDriverService.kt` (new), `browse-android/app/src/androidTest/java/io/ulpi/browse/driver/ViewHierarchy.kt` (new), `src/app/android/protocol.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `browse-android` builds driver artifacts reproducibly for local development and CI
- [ ] Host can start the driver on a booted emulator through `adb shell am instrument ...` plus port-forwarding
- [ ] Driver exposes typed RPC endpoints for `tree`, `action`, `set-value`, `type`, `press`, `screenshot`, `state`
- [ ] Raw tree nodes include stable node paths plus role/class/text/content-desc/bounds/enabled/focused/selected/editable/checkable/clickable/children
- [ ] Driver output contains no browse `@refs`, no CLI formatting, and no platform-specific human strings beyond errors
- [ ] Missing `adb`, no booted emulator, multiple candidate devices, or missing target app fail with explicit remediation
- [ ] Scope is emulator-first; real-device-specific behavior is not required in this roadmap window

**Agent:** android-senior-engineer
**Review:** claude
**Depends on:** TASK-034
**Priority:** P2

---

### TASK-052: Android host adapter + app-runtime integration

Create the host-side Android adapter that installs or starts the driver, resolves emulator + package, normalizes the raw hierarchy into browse-owned app nodes, assigns refs host-side, and plugs into the existing `src/app/` runtime path. `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `screenshot`, and `state` must behave like other app targets and route through the same executor/session flow.

**Files:** `src/app/android/bridge.ts` (new), `src/app/android/manager.ts` (new), `src/app/index.ts`, `src/app/normalize.ts`, `src/session/target-factory.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `browse --platform android --device emulator-5554 --app com.example.demo snapshot -i` resolves emulator + app and returns a browse-style snapshot with host-assigned refs
- [ ] `tap`, `fill`, `type`, `press`, `screenshot`, `state`, and `text` reuse the shared app-target command surface; no new Android-only command names are introduced
- [ ] Device selection supports exact serial and single-booted-emulator auto-resolution; ambiguity fails clearly
- [ ] App selection supports exact package name and deterministic error on missing package
- [ ] Host adapter manages `adb` port-forward lifecycle and driver boot/teardown without leaking global state
- [ ] Stale mobile node paths fail with the same refresh guidance used by macOS app refs
- [ ] Android adapter reuses the app-runtime contract harness from `TASK-034` rather than inventing Android-only semantics

**Agent:** android-senior-engineer
**Review:** claude
**Depends on:** TASK-051, TASK-034
**Priority:** P2

---

### TASK-053: iOS simulator runner workspace + controller split

Create `browse-ios-runner/` as an Xcode runner workspace for iOS Simulator and define the browse-owned split between simulator controller and UI runner. Learn from Maestro's XCTest pattern, but keep the browse contract canonical and simulator-first: `simctl` and Xcode manage lifecycle, the runner exposes `tree`, `action`, `set-value`, `type`, `press`, `screenshot`, `state`, and browse owns refs, formatting, and command semantics.

**Files:** `browse-ios-runner/BrowseRunner.xcodeproj/project.pbxproj` (new), `browse-ios-runner/BrowseRunnerUITests/BrowseDriverServer.swift` (new), `browse-ios-runner/BrowseRunnerUITests/BrowseRunnerUITests.swift` (new), `src/app/ios/protocol.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Runner boots on a selected simulator through `xcodebuild test-without-building` or an equivalent reproducible invocation
- [ ] Host can poll runner health before issuing commands
- [ ] Simulator lifecycle (boot/install/launch/permissions) is separate from UI-runner RPCs
- [ ] Runner exposes typed endpoints for `tree`, `action`, `set-value`, `type`, `press`, `screenshot`, `state` with raw node paths and node attributes
- [ ] Missing Xcode CLI tools, missing runtime, no booted simulator, multiple matching simulators, or missing app all fail clearly
- [ ] Scope is iOS Simulator only; real devices are explicitly out of scope

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Depends on:** TASK-034
**Priority:** P2

---

### TASK-054: iOS simulator host adapter + app-runtime integration

Create the host-side iOS simulator adapter that uses `simctl` for simulator lifecycle and a separate runner client for UI tree, actions, screenshot, and state. The adapter normalizes the raw simulator hierarchy into the browse-owned app contract and reuses the same command surface and executor/session flow as macOS and Android app targets.

**Files:** `src/app/ios/bridge.ts` (new), `src/app/ios/controller.ts` (new), `src/app/ios/manager.ts` (new), `src/app/index.ts`, `src/session/target-factory.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `browse --platform ios --device "iPhone 16" --app com.example.demo snapshot -i` resolves simulator + app and returns a browse-style snapshot with host-assigned refs
- [ ] Host adapter uses `simctl` for simulator lifecycle and a separate runner client for tree/actions/state
- [ ] `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `screenshot`, and `state` reuse the shared app-target semantics; no iOS-only command surface is introduced
- [ ] Simulator selection supports exact UDID and exact name/runtime matching; ambiguity fails clearly
- [ ] Runner startup timeout surfaces clear recovery steps
- [ ] iOS adapter passes the shared app-runtime contract harness from `TASK-034`

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Depends on:** TASK-053, TASK-034
**Priority:** P2

---

### TASK-055: Unified mobile target selection + doctor integration

Extend the existing app-target selection into explicit multi-platform selection: `--platform macos|android|ios`, optional `--device`, shared config/session/server/MCP transport fields, centralized capability gating, and doctor checks. Mobile remains one browse surface, not a second family of commands or tools.

**Files:** `src/cli.ts`, `src/server.ts`, `src/mcp/tools/index.ts`, `src/session/manager.ts`, `src/session/target-factory.ts`, `src/automation/registry.ts`, `src/automation/command.ts`, `src/types.ts`, `src/config.ts`, `src/app/index.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--platform` + `--app` + optional `--device` flow through CLI, HTTP, MCP, config, and session state consistently
- [ ] Existing app-target commands work across macOS, Android, and iOS with one definition surface
- [ ] `browse doctor --platform android` checks `adb`, emulator/device visibility, and driver artifacts
- [ ] `browse doctor --platform ios` checks Xcode CLI tools, simulator runtime, and runner artifacts
- [ ] Central capability gating rejects unsupported commands once, not per-platform handlers
- [ ] No duplicated `browse_android_*` or `browse_ios_*` MCP namespace is introduced
- [ ] Packaging/bootstrap logic for Android and iOS runtime artifacts is isolated inside `src/app/*`, not scattered through transports

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-052, TASK-054
**Priority:** P2

---

### TASK-056: Mobile contract coverage + emulator/simulator integration tests

Extend the shared app-runtime contract harness to Android and iOS adapters, then add gated emulator/simulator integration tests. The goal is not just "mobile works"; the goal is to prove mobile targets preserve the same browse semantics, error shapes, and command surface as browser and macOS targets.

**Files:** `test/app-runtime-contract.test.ts`, `test/app-android.test.ts` (new), `test/app-ios.test.ts` (new), `test/mobile-runtime-contract.test.ts` (new), `test/mobile-doctor.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Mocked Android and iOS adapters both pass the shared app-runtime contract tests for `tree`, `action`, `set-value`, `type`, `press`, `screenshot`, and `state`
- [ ] Android emulator integration tests cover `snapshot`, `text`, `tap`, and `fill`, and skip cleanly when `adb` or an emulator is unavailable
- [ ] iOS simulator integration tests cover `snapshot`, `text`, `tap`, and `fill`, and skip cleanly when Xcode or Simulator is unavailable
- [ ] Device/simulator ambiguity, missing app, stale ref, runner boot timeout, and setup errors are tested with explicit messages
- [ ] Browser and macOS app sessions remain stable while mobile sessions are active
- [ ] Test coverage proves mobile additions did not create a second command or MCP surface

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-052, TASK-054, TASK-055
**Priority:** P2

---

### v2.1 — Agent Workflows

---

### TASK-035: Flow YAML parser

Create `src/flow-parser.ts` that parses flow YAML files into `FlowStep[]`. Each step has: command, args, optional conditions (from expect syntax). Validate step format, reject unknown commands, and use an explicit YAML parser dependency with line/column errors.

**Files:** `src/flow-parser.ts` (new), `package.json`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Parses `- goto: https://example.com` into `{ command: 'goto', args: ['https://example.com'] }`
- [ ] Parses `- click: "@e3"` into `{ command: 'click', args: ['@e3'] }`
- [ ] Parses multi-arg fills: `- fill: { "@e4": "value" }` into fill command
- [ ] Parses expect blocks: `- expect: { url: "/checkout", timeout: 5000 }` into expect command args
- [ ] `package.json` adds an explicit YAML parser dependency rather than relying on ad hoc parsing
- [ ] Validates all commands exist in command registry
- [ ] Edge case: duplicate keys / unsupported step shape fail with line/column context
- [ ] Edge case: empty steps array → "Flow file has no steps"
- [ ] Edge case: malformed YAML → clear parse error with line number

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-036: Flow meta command

Add `case 'flow':` to `src/commands/meta/index.ts`. Reads YAML file, parses with flow-parser, executes steps sequentially through existing command handlers. Stops on first failure. Reports progress per step.

**Files:** `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse flow checkout.yaml` executes all steps sequentially
- [ ] Output: `✓ goto https://example.com` per successful step
- [ ] On failure: `✗ expect --url "/checkout" — FAIL: got "/cart"` then stops
- [ ] Final summary: "Flow complete: 8/8 steps passed" or "Flow failed at step 5/8"
- [ ] Expect steps use the same polling/timeout logic as standalone expect
- [ ] Edge case: file not found → "Flow file not found: <path>"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-035, TASK-011
**Priority:** P1

---

### TASK-037: Retry meta command

Add `case 'retry':` to `src/commands/meta/index.ts`. Wraps any command in a retry loop with configurable max attempts and exponential backoff. Uses expect's condition parser for `--until` conditions.

**Files:** `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse retry "click .dismiss" --until "hidden .modal" --max 3 --backoff` retries up to 3 times
- [ ] Backoff: 100ms, 200ms, 400ms (doubles each attempt)
- [ ] `--until` condition checked after each attempt using expect condition checker
- [ ] On success: returns command result
- [ ] On max retries exceeded: "Retry failed after 3 attempts. Last error: <error>"
- [ ] Edge case: command succeeds on first attempt → no retry, immediate return

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-010
**Priority:** P1

---

### TASK-038: Watch meta command

Add `case 'watch':` to `src/commands/meta/index.ts`. Injects MutationObserver via `page.evaluate()`, polls for changes, executes callback command when change detected.

**Files:** `src/commands/meta/index.ts`, `automation/registry.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse watch ".messages" --on-change "text"` monitors element for DOM changes
- [ ] Uses MutationObserver (childList + subtree) injected via page.evaluate
- [ ] Polls for change flag every 200ms (not blocking event loop)
- [ ] `--timeout 30000` stops watching after 30s (default: 30s)
- [ ] On change: executes callback command, returns result
- [ ] Edge case: selector doesn't exist → "Element not found: .messages"
- [ ] Edge case: page navigates during watch → watch terminates cleanly

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-011
**Priority:** P1

---

### TASK-039: MCP tools + CLI help + tests for v2.1

Register flow, retry, watch commands. Write unit + integration tests for parser and failure paths.

**Files:** `mcp/tools/index.ts`, `src/cli.ts`, `test/features.test.ts`, `test/flow-parser.test.ts` (new)

**Type:** chore
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse_flow`, `browse_retry`, `browse_watch` MCP tool definitions
- [ ] CLI help lists under Workflows category
- [ ] Unit test: flow parser returns actionable errors for malformed YAML, duplicate keys, and unknown commands
- [ ] Test: flow executes 3-step goto+fill+expect sequence
- [ ] Test: retry succeeds on second attempt (flaky fixture that fails once)
- [ ] Test: retry exhausts max attempts and reports the last error clearly
- [ ] Test: watch detects DOM change (timer-based mutation in fixture)
- [ ] Test: watch on missing selector fails immediately with the documented error
- [ ] Test: watch terminates cleanly when navigation replaces the observed page
- [ ] Test: flow stops on expect failure with clear step number

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-036, TASK-037, TASK-038
**Priority:** P2

---

### v2.2 — Agent Toolkit

---

### TASK-040: Custom audit rules

Add project-local audit rule loading from `.browse/rules/*.json`. Rules are declarative JSON artifacts checked into the project, not executable plugin code. They extend `perf-audit` and `a11y-audit` with project-specific checks without changing browse source.

**Files:** `src/automation/rules.ts` (new), `src/perf-audit/index.ts`, `src/commands/meta/inspection.ts`, `src/config.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `perf-audit` and `a11y-audit` load `.browse/rules/*.json` from the detected project root in addition to built-in rules
- [ ] Rule format is versioned and declarative: arbitrary JS / `eval` / plugin hooks are out of scope
- [ ] Supports at least two built-in rule kinds: metric-threshold rules for `perf-audit` and selector-count rules for `a11y-audit`
- [ ] Custom findings are labeled `[custom]` and include the rule name plus source file path
- [ ] Edge case: malformed JSON or unknown rule kind → warning with file name, file skipped, audit continues
- [ ] Edge case: invalid target (`perf-audit` vs `a11y-audit`) → warning with file name, file skipped

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-024
**Priority:** P1

---

### TASK-041: Saved flows in `.browse/flows/`

Add project-local saved flows on top of the v2.1 workflow engine. `browse flow save <name>` captures the current recording as canonical YAML in `.browse/flows/`. `browse flow run <name>` replays a saved flow. `browse flow list` enumerates available project flows.

**Files:** `src/commands/meta/index.ts`, `src/commands/meta/flows.ts` (new), `src/automation/registry.ts`, `src/config.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse flow save <name>` writes `.browse/flows/<name>.yaml` using a deterministic, canonical YAML format
- [ ] `browse flow run <name>` resolves the saved file from project-local flow directories and executes it through the same parser/executor path as file-based flows
- [ ] `browse flow list` prints saved flow names relative to the project flow root
- [ ] Saved flows are normal project files that can be committed and edited without any install step
- [ ] Edge case: saving without an active recording → clear error
- [ ] Edge case: missing named flow or path traversal (`../`) attempt → clear error, no filesystem escape

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-039
**Priority:** P1

---

### TASK-042: SDK mode — library entry point

Create `src/sdk.ts` that exports a clean, typed API for direct programmatic browser use. Publish alongside the CLI via `package.json` `exports`. SDK mode uses the same underlying browser/runtime primitives as browse commands but skips the HTTP server entirely.

**Files:** `src/sdk.ts` (new), `package.json`, `scripts/build-all.sh`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `import { createBrowser } from '@ulpi/browse'` works
- [ ] `createBrowser()` launches Chromium, returns typed API: goto, click, fill, text, snapshot, screenshot, close, etc.
- [ ] No HTTP server spawned (direct BrowserManager calls)
- [ ] TypeScript types exported for all return values
- [ ] package.json `exports` and `files` expose both CLI and SDK artifacts with matching types
- [ ] `npm pack` + install-into-temp-project verification proves `createBrowser()` is importable from the shipped tarball
- [ ] Edge case: calling CLI methods (stop, restart, status) throws "Not available in SDK mode"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-043: Custom detection signatures

Extend the detection loader to scan `.browse/detections/*.json` for project-local signatures. These files let agents teach browse about project-specific frameworks or stacks during normal repo work.

**Files:** `src/detection/index.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse detect` loads `.browse/detections/*.json` alongside built-in signatures
- [ ] Custom signature format is versioned and explicit: `{ version: 1, name, detect, version, category, perfHints[] }`
- [ ] `detect` and `version` are JS expressions evaluated via page.evaluate
- [ ] Custom detections appear in output with `[custom]` label and source file path
- [ ] Edge case: malformed JSON or invalid schema → warning with file name, file skipped
- [ ] Edge case: detect expression throws → caught, framework marked as not detected

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-044: Agent Toolkit integration, MCP, and packaging tests

Write integration and contract tests for the full v2.2 toolkit surface: SDK mode, custom detections, custom audit rules, saved flows, config expansion, and the CLI/MCP metadata that exposes them.

**Files:** `src/mcp/tools/index.ts`, `src/cli.ts`, `test/features.test.ts`, `test/agent-toolkit.test.ts` (new), `test/sdk-pack.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] CLI help lists `flow save`, `flow run`, `flow list` and documents the project-local `.browse/*` / `browse.json` toolkit surfaces
- [ ] If `flow` is MCP-exposed from v2.1, the MCP tool schema and arg decoding cover the new `save|run|list` actions without adding a second workflow tool
- [ ] Test: SDK mode createBrowser() returns working API, close() cleans up
- [ ] Test: SDK goto + text returns page content
- [ ] Test: packed tarball install exposes the SDK entry point from `exports`
- [ ] Test: custom detection JSON in temp .browse/detections/ directory detected by browse detect
- [ ] Test: custom rule JSON in temp .browse/rules/ directory is applied by `perf-audit` and `a11y-audit`
- [ ] Test: `flow save`, `flow run`, and `flow list` work from a temp project root
- [ ] Test: `browse.json` precedence is CLI flags > env vars > config defaults
- [ ] Test: startup flows run once per new session and can be disabled for a single invocation
- [ ] Edge case test: malformed detection/rule JSON → warning, not crash

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-040, TASK-041, TASK-042, TASK-043, TASK-045
**Priority:** P2

---

### TASK-045: Project config expansion

Expand `browse.json` into the project-local control plane for the agent toolkit. Project config should define defaults and file roots for detections, rules, and flows, while remaining subordinate to CLI flags and env vars.

**Files:** `src/config.ts`, `src/cli.ts`, `src/automation/rules.ts`, `src/detection/index.ts`, `src/commands/meta/flows.ts`, `docs/agent-toolkit.md` (new)

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse.json` supports: `defaultSession`, `defaultContext`, `startupFlows`, `detectionPaths`, `rulePaths`, and `flowPaths`
- [ ] Relative paths resolve from the detected project root
- [ ] Precedence is explicit and tested: CLI flags > env vars > `browse.json` > built-in defaults
- [ ] `startupFlows` run only when a session is first created, not on every subsequent command in the same session
- [ ] `--no-startup-flows` disables startup-flow execution for the current invocation
- [ ] `docs/agent-toolkit.md` explains the `.browse/` layout, config keys, precedence, and file-format expectations
- [ ] Edge case: missing configured flow/rule/detection path or unknown startup flow name → clear error naming the offending config field

**Agent:** general-purpose
**Review:** none
**Depends on:** TASK-040, TASK-041, TASK-043
**Priority:** P1

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Response body capture slows down page loads | TASK-003 | Only capture when opt-in (`--network-bodies`). Skip binary bodies. Cap per-entry body size and total session body bytes. |
| Memory pressure from captured bodies still grows too high | TASK-003, TASK-009 | Enforce a separate captured-body byte budget; evict oldest body payloads first while preserving request metadata. Cover with explicit eviction tests. |
| Readiness signal reports `settled:true` too early on SPA transitions | TASK-046, TASK-048, TASK-009 | Combine pending-network and DOM-mutation quiet-window signals, and cover delayed-mutation plus delayed-fetch fixtures before enabling settle mode. |
| Conditional flags hide real regressions by skipping too much | TASK-047, TASK-009 | Guard flags must return explicit `SKIP:` output and only suppress not-found / empty / unchecked states, never malformed selectors or usage errors. |
| Settle mode hangs on long-polling pages | TASK-048, TASK-009 | Add a timeout guard, exclude long-lived streaming/socket requests from readiness, and return an explicit timeout note instead of blocking indefinitely. |
| expect polling burns CPU | TASK-011, TASK-016 | 100ms interval. Use Playwright-native waits where possible and unit-test timeout / zero-timeout semantics. |
| `wait --request` and `expect --request` drift into different matcher semantics | TASK-050, TASK-016 | Reuse the same parser/helper for method/path/status matching and cover success, timeout, and status-mismatch cases in one shared test suite. |
| Budget tests flap because live browser metrics vary | TASK-012, TASK-016 | Extract deterministic budget evaluation logic and test it with fixed report fixtures instead of relying only on live perf runs. |
| Generated Playwright export is structurally present but syntactically broken | TASK-014, TASK-017 | Require parse / compile validation of generated source in tests. |
| WCAG contrast calculation wrong on gradients/images | TASK-019, TASK-024 | Skip contrast check when background is gradient or image. Document limitation and test the skip path explicitly. |
| macOS Accessibility permission UX is confusing | TASK-025, TASK-033 | `browse doctor` checks permission and prints step-by-step remediation with System Settings guidance. |
| User denies or can't find AX permission grant | TASK-025, TASK-031, TASK-034 | `browse --app` fails fast with "Accessibility permission required". Mocked bridge tests and doctor output verify the recovery path. |
| Raw AX node paths become stale after window changes | TASK-029, TASK-030, TASK-034 | Keep refs host-side, resolve bridge actions through normalized node paths, and fail with explicit stale-ref guidance instead of reusing invalid paths. |
| Runtime split breaks existing browser sessions | TASK-031, TASK-034 | Introduce shared session-target abstraction and require browser-regression coverage while app sessions are active. |
| Future Android/iOS targets force a second command or MCP surface | TASK-031, TASK-033, TASK-034, TASK-055, TASK-056 | Keep one command model and validate mobile adapters through the shared app-runtime contract harness plus multi-platform target-selection tests before adding any new transport surface. |
| Android driver boot or `adb` device selection is flaky | TASK-051, TASK-052, TASK-055, TASK-056 | Keep Android emulator-first, require exact serial override, own port-forward cleanup in the adapter, and cover boot + ambiguity failures in mocked and gated emulator tests. |
| iOS simulator runner boot is slow or Xcode tooling drifts | TASK-053, TASK-054, TASK-055, TASK-056 | Keep iOS simulator-only, split simulator control from the UI runner, poll runner health explicitly, and make `browse doctor --platform ios` print concrete remediation for Xcode/runtime issues. |
| Mobile adapters drift from shared app semantics | TASK-052, TASK-054, TASK-055, TASK-056 | Reuse the shared app-runtime contract harness and assert the same ref, snapshot, capability-gating, and error-shape behavior across macOS, Android, and iOS adapters. |
| Swift bridge packaging drifts from shipped npm artifact | TASK-028 | Verify bridge asset presence through `npm pack`, not only local source builds. |
| Flow YAML syntax errors confuse agents | TASK-035, TASK-039 | Use explicit YAML parser dependency with line/column errors. Cover malformed YAML, duplicate keys, and unknown commands in parser tests. |
| Custom rules become a second plugin system via arbitrary code execution | TASK-040, TASK-044 | Keep rule files declarative JSON only. Reject JS/eval-based rule shapes in schema validation and cover malformed/unknown rule types in contract tests. |
| Saved-flow serialization drifts from the v2.1 parser/runtime | TASK-041, TASK-044 | Use one canonical YAML serializer and route `flow run <name>` through the same parser/executor path as file-based flows. Cover save→run round trips. |
| Startup flows cause hidden side effects or rerun on every command | TASK-041, TASK-044, TASK-045 | Run startup flows only when a session is first created, print which flows ran, and support `--no-startup-flows` for the current invocation. |
| Project-local toolkit files are silently ignored or resolved from the wrong root | TASK-040, TASK-041, TASK-043, TASK-045 | Resolve all toolkit paths from the detected project root, and warn or fail with file names and config keys when paths or schemas are invalid. |
| SDK mode ships but `exports` / tarball contents are wrong | TASK-042, TASK-044 | Validate packed tarball import behavior in a temp install using the published `exports` surface. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| NetworkEntry body capture | TASK-009 | integration |
| request command (index + pattern) | TASK-009 | integration |
| api command (GET, POST, cookies) | TASK-009 | integration |
| HAR export with bodies | TASK-009 | integration |
| Body truncation at limit | TASK-009 | integration |
| Captured-body byte-budget eviction | TASK-009 | integration |
| action-context readiness signal | TASK-009 | integration |
| guarded write skip paths | TASK-009 | integration |
| selector suggestions on not-found | TASK-009 | integration |
| settle mode post-write waiting | TASK-009 | integration |
| expect parser flag validation | TASK-016 | unit |
| expect --url condition | TASK-016 | integration |
| expect --text condition | TASK-016 | integration |
| expect --visible/--hidden | TASK-016 | integration |
| expect --count | TASK-016 | integration |
| expect --request + --status | TASK-016 | integration |
| wait --request + --status | TASK-016 | integration |
| expect timeout failure | TASK-016 | integration |
| perf-audit budget evaluator | TASK-016 | unit |
| perf-audit --budget pass | TASK-016 | integration |
| perf-audit --budget fail | TASK-016 | integration |
| replay export with expects | TASK-017 | integration |
| playwright test export | TASK-017 | integration |
| generated Playwright source parses / compiles | TASK-017 | contract |
| visual helper functions (`parseColor`, `luminance`, `overlaps`, bg resolution) | TASK-024 | unit |
| visual landmark scan | TASK-024 | integration |
| visual contrast detection | TASK-024 | integration |
| visual overlap detection | TASK-024 | integration |
| visual overflow detection | TASK-024 | integration |
| layout computed properties | TASK-024 | integration |
| a11y-audit scoring | TASK-024 | integration |
| a11y-audit findings (alt, label, heading, touch target, generic link, missing lang) | TASK-024 | integration |
| a11y focus-order warning | TASK-024 | integration |
| AX bridge + normalized tree retrieval | TASK-034 | integration |
| App ref resolution + bridge action / set-value | TASK-034 | integration |
| App snapshot with host-assigned @refs | TASK-034 | integration |
| App action context + readiness | TASK-034 | integration |
| App mocked bridge failures (permission denied, stale ref, app missing, ambiguous app) | TASK-034 | contract |
| App runtime contract harness (`tree/action/set-value/type/press/screenshot/state`) | TASK-034 | contract |
| Browser sessions remain stable while app sessions are active | TASK-034 | integration |
| Android driver protocol (`tree/action/set-value/type/press/screenshot/state`) | TASK-056 | contract |
| Android host normalization + refs | TASK-056 | integration |
| Android device selection + `adb` bootstrap failures | TASK-056 | contract |
| iOS simulator runner protocol (`tree/action/set-value/type/press/screenshot/state`) | TASK-056 | contract |
| iOS host normalization + refs | TASK-056 | integration |
| iOS simulator selection + runner boot failures | TASK-056 | contract |
| Unified multi-platform app target selection + doctor | TASK-056 | integration |
| Flow parser malformed YAML / duplicate keys / unknown commands | TASK-039 | unit |
| Flow execution (pass) | TASK-039 | integration |
| Flow execution (fail at step) | TASK-039 | integration |
| Retry with backoff | TASK-039 | integration |
| Retry max-failure reporting | TASK-039 | integration |
| Watch DOM change | TASK-039 | integration |
| Watch selector-missing / navigation termination | TASK-039 | integration |
| custom audit rule schema validation | TASK-044 | contract |
| custom audit rule application (perf + a11y) | TASK-044 | integration |
| flow save canonical YAML output | TASK-044 | contract |
| flow run by saved name | TASK-044 | integration |
| flow list from project root | TASK-044 | integration |
| toolkit path resolution and invalid-path errors | TASK-044 | contract |
| config precedence (CLI > env > browse.json > defaults) | TASK-044 | contract |
| startup flows run once + disable flag | TASK-044 | integration |
| SDK createBrowser + commands | TASK-044 | integration |
| Packed tarball SDK import via `exports` | TASK-044 | packaging |
| Custom detection signatures | TASK-044 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-001"],
  "TASK-006": ["TASK-001"],
  "TASK-007": ["TASK-005", "TASK-006"],
  "TASK-008": ["TASK-001"],
  "TASK-009": ["TASK-004", "TASK-005", "TASK-006", "TASK-046", "TASK-047", "TASK-048"],
  "TASK-046": [],
  "TASK-047": [],
  "TASK-048": ["TASK-046"],
  "TASK-010": [],
  "TASK-011": ["TASK-010"],
  "TASK-050": ["TASK-010"],
  "TASK-012": [],
  "TASK-013": ["TASK-010"],
  "TASK-014": ["TASK-013"],
  "TASK-015": ["TASK-011", "TASK-012", "TASK-014"],
  "TASK-016": ["TASK-011", "TASK-012", "TASK-050"],
  "TASK-017": ["TASK-013", "TASK-014"],
  "TASK-018": [],
  "TASK-019": ["TASK-018"],
  "TASK-020": ["TASK-018", "TASK-019"],
  "TASK-021": ["TASK-018"],
  "TASK-022": ["TASK-018"],
  "TASK-023": ["TASK-020", "TASK-021", "TASK-022"],
  "TASK-024": ["TASK-020", "TASK-021", "TASK-022"],
  "TASK-025": [],
  "TASK-026": ["TASK-025"],
  "TASK-027": ["TASK-025"],
  "TASK-028": ["TASK-025"],
  "TASK-029": ["TASK-025", "TASK-028"],
  "TASK-030": ["TASK-029"],
  "TASK-031": ["TASK-029", "TASK-030"],
  "TASK-032": ["TASK-029", "TASK-031"],
  "TASK-033": ["TASK-031"],
  "TASK-034": ["TASK-031", "TASK-032", "TASK-033"],
  "TASK-051": ["TASK-034"],
  "TASK-052": ["TASK-051", "TASK-034"],
  "TASK-053": ["TASK-034"],
  "TASK-054": ["TASK-053", "TASK-034"],
  "TASK-055": ["TASK-052", "TASK-054"],
  "TASK-056": ["TASK-052", "TASK-054", "TASK-055"],
  "TASK-035": [],
  "TASK-036": ["TASK-035", "TASK-011"],
  "TASK-037": ["TASK-010"],
  "TASK-038": ["TASK-011"],
  "TASK-039": ["TASK-036", "TASK-037", "TASK-038"],
  "TASK-040": ["TASK-024"],
  "TASK-041": ["TASK-039"],
  "TASK-042": [],
  "TASK-043": [],
  "TASK-044": ["TASK-040", "TASK-041", "TASK-042", "TASK-043", "TASK-045"],
  "TASK-045": ["TASK-040", "TASK-041", "TASK-043"]
}
```
