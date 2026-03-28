# Plan: browse roadmap v1.5–v2.2

> Generated: 2026-03-28
> Branch: per-version feature branches
> Mode: EXPANSION

## Overview

Full product roadmap from v1.5 through v2.2 — 6 versions spanning network intelligence, verification/CI, visual intelligence, native app automation, agent workflows, and ecosystem/SDK. Each version builds on the previous, compounding agent capability: network bodies enable assertions, assertions enable CI, CI proves enterprise value, proven patterns transfer to app automation, workflows compose everything, ecosystem multiplies everything.

## Scope Challenge

All 8 previous plans shipped (cloud-providers, handoff, mcp-server, perf-audit, persistent-profiles, port-to-node, react-devtools, record-export). Current state: 31K lines, 99 commands, v1.4.5. This plan covers the next ~18 months of development.

Ruled out: Lighthouse integration (perf-audit already better), AI-powered selectors (non-deterministic), visual regression service (screenshot-diff exists), browser cloud (partnered with Browserbase/Browserless), full test framework (browse is a tool, generates Playwright tests instead).

## Architecture

```
v1.5 Network Intelligence                v1.6 Verify                    v1.7 Visual Intelligence
┌─────────────────────────┐     ┌───────────────────────────┐     ┌──────────────────────────┐
│ buffers.ts              │     │ src/expect.ts       [011] │     │ src/visual.ts      [020] │
│   NetworkEntry + bodies │     │   condition parser        │     │   landmark scan          │
│                   [001] │     │   check loop              │     │   contrast check         │
│                         │     │                     [012] │     │   overlap detection      │
│ browser-manager.ts      │     │                           │     │   overflow detection     │
│   body capture    [002] │     │ perf-audit/index.ts       │     │   viewport bleed         │
│   header capture  [003] │     │   --budget logic    [013] │     │                    [021] │
│                         │     │                           │     │                          │
│ commands/read.ts        │     │ record-export.ts          │     │ commands/read.ts         │
│   request cmd     [005] │     │   replay + expects  [014] │     │   layout cmd       [024] │
│                         │     │   playwright export [015] │     │                          │
│ commands/meta.ts        │     │                           │     │ commands/meta.ts         │
│   api cmd         [006] │     │ commands/meta.ts          │     │   visual cmd       [023] │
│                         │     │   expect cmd        [012] │     │   a11y-audit cmd   [022] │
│ cli.ts                  │     │                           │     │                          │
│   --network-bodies[004] │     │                           │     │                          │
└─────────────────────────┘     └───────────────────────────┘     └──────────────────────────┘
         │                                │                                │
         └────────────────────────────────┼────────────────────────────────┘
                                          │
v2.0 App Automation                       │              v2.1 Workflows         v2.2 Ecosystem
┌─────────────────────────┐               │     ┌─────────────────────┐  ┌──────────────────┐
│ browse-ax/ (Swift)      │               │     │ src/flow-parser.ts  │  │ src/plugin.ts    │
│   tree retrieval  [025] │               │     │              [035]  │  │            [040] │
│   actions         [026] │               │     │                     │  │                  │
│   properties      [027] │               │     │ commands/meta.ts    │  │ src/sdk.ts       │
│                         │               │     │   flow        [036] │  │            [042] │
│ src/app-manager.ts      │               │     │   retry       [037] │  │                  │
│   connect/snapshot[029] │               │     │   watch       [038] │  │ detection/       │
│   tap/fill/type   [030] │               │     │                     │  │  custom     [043]│
│   text/screenshot [027] │               │     └─────────────────────┘  └──────────────────┘
│                         │               │
│ commands/app.ts   [031] │               │
│ --app flag        [031] │               │
└─────────────────────────┘               │
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Network event capture | `browser-manager.ts:1495-1527` — page.on('request/response/requestfinished') | Extend with body capture |
| Network buffer storage | `buffers.ts:14-21` — NetworkEntry interface | Extend with body/header fields |
| Network output format | `commands/read.ts:247-257` — network command | Reuse pattern for request command |
| HAR export with bodies | `har.ts:21-66` — formatAsHar() | Extend with optional bodies |
| Command registration | `command-registry.ts:7-38` — READ/WRITE/META sets | Extend for all new commands |
| MCP tool definitions | `mcp-tools.ts:30+` — ToolDefinition pattern | Extend for all new commands |
| Chain sets | `commands/meta.ts:385-425` — WRITE_SET/READ_SET | Extend for new commands |
| perf-audit orchestrator | `perf-audit/index.ts:1-86` — PerfAuditReport | Extend with budget check |
| perf-audit formatter | `perf-audit/formatter.ts:96-102` — formatPerfAudit | Extend with budget output |
| Recording system | `record-export.ts:220-242` — exportReplay | Extend with expect steps |
| Ref selector resolution | `record-export.ts:43-145` — resolveRefSelectors | Reuse for Playwright test export |
| page.evaluate pattern | `perf-audit/index.ts` — large evaluate for metrics | Reuse for visual/a11y evaluate |
| Detection evaluate | `detection/frameworks.ts` — single evaluate, structured return | Reuse pattern for visual scan |
| ARIA snapshot | `snapshot.ts:330-400` — tree + ref assignment | Reuse pattern for app snapshot |
| Init script injection | `react-devtools.ts:46` — context.addInitScript | Reuse pattern for watch MutationObserver |
| Session multiplexing | `session-manager.ts:62-157` — getOrCreate | Extend for app sessions |
| Domain filter pattern | `domain-filter.ts` — class with init script generation | Model for AppManager |
| Action context | `action-context.ts:266-349` — prepare/finalize pattern | Reuse for app action context |
| Test infrastructure | `test/setup.ts` + `test/test-server.ts` + `test/fixtures/` | Extend with API + visual fixtures |
| CLI flag pattern | `cli.ts:631-669` — flag extraction + env var + config | Reuse for --network-bodies, --app |
| RequestOptions | `server.ts:221-226` — interface for per-request config | Extend with networkBodies |

## Tasks

---

### v1.5 — Network Intelligence

---

### TASK-001: Extend NetworkEntry with body and header fields

Add optional body and header fields to the `NetworkEntry` interface in `src/buffers.ts`. This is the foundation type change that all v1.5 features build on.

**Files:** `src/buffers.ts`, `src/types.ts`

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

### TASK-002: Capture request bodies in browser-manager.ts

Extend the `page.on('request', ...)` handler (line ~1495) to capture request bodies via `req.postData()` for POST/PUT/PATCH methods. Only when body capture is enabled (new `captureNetworkBodies` flag on BrowserManager).

**Files:** `src/browser-manager.ts`

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

### TASK-003: Capture response bodies in browser-manager.ts

Extend the `page.on('response', ...)` handler (line ~1506) to capture response bodies. Only for text-like content types (json, text, xml, html, javascript, css). Binary responses stored as `[binary N bytes]`. Body size capped at 256KB per entry (configurable via `BROWSE_NETWORK_BODY_LIMIT`).

**Files:** `src/browser-manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Text response bodies captured for json/text/xml/html/javascript/css content types
- [ ] Binary responses stored as `[binary N bytes]` (no data capture)
- [ ] Bodies truncated at 256KB with `...(truncated at 262144B)` suffix
- [ ] `response.text()` called inside try/catch — redirects, aborted requests don't throw
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

**Files:** `src/commands/read.ts`, `src/command-registry.ts`

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

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

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

Register `request` and `api` commands: MCP tool definitions in `mcp-tools.ts`, CLI help text in `cli.ts`, chain command sets in `meta.ts`, SAFE_TO_RETRY for `request` (read-only).

**Files:** `src/mcp-tools.ts`, `src/cli.ts`, `src/commands/meta.ts`

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

**Files:** `src/har.ts`

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

Add JSON API fixture routes to test-server.ts. Write integration tests covering network body capture, the `request` command, the `api` command, and HAR export with bodies.

**Files:** `test/test-server.ts`, `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test fixture: `POST /api/echo` route that returns request body as JSON response
- [ ] Test fixture: `GET /api/data` route that returns a known JSON payload
- [ ] Test: network buffer captures request body for POST to echo endpoint
- [ ] Test: network buffer captures response body for GET data endpoint
- [ ] Test: `request /api/data` returns full entry with body
- [ ] Test: `api GET <baseUrl>/api/data` returns parsed JSON
- [ ] Test: body truncation at limit works correctly
- [ ] Edge case test: binary response body stored as `[binary N bytes]`
- [ ] Test: `api GET` with session cookie set via `cookie` command → verify cookie appears in request sent by fetch

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-004, TASK-005, TASK-006
**Priority:** P2

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
- [ ] Edge case: no conditions → throws "Usage: browse expect <conditions>"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-011: Implement `expect` meta command

Add `case 'expect':` to `src/commands/meta.ts`. Polls conditions in a loop (100ms interval) until all pass or timeout. Exit with clear error on failure, silent OK on success.

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

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

### TASK-012: Add --budget flag to perf-audit

Parse `--budget lcp:2500,cls:0.1,tbt:300` flag in perf-audit command. After audit completes, compare each metric against budget. If any budget exceeded, format a pass/fail report and throw an error (server returns 500 → CLI exits with code 1).

**Files:** `src/perf-audit/index.ts`, `src/perf-audit/formatter.ts`, `src/commands/meta.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--budget lcp:2500,cls:0.1,tbt:300` parsed into `Record<string, number>`
- [ ] Supported metric keys: `lcp`, `cls`, `tbt`, `fcp`, `ttfb`, `inp` (case-insensitive)
- [ ] Budget exceeded → error thrown with per-metric pass/fail breakdown
- [ ] Budget passed → normal perf-audit output + "All budgets met." suffix
- [ ] Exit code 1 on failure (CLI propagates server 500 as exit(1))
- [ ] Edge case: metric not measured (e.g., INP on page with no interaction) → skipped, not failed

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-013: Extend exportReplay with expect assertion steps

Extend `exportReplay()` in `src/record-export.ts` to serialize recorded `expect` commands as `waitForElement` or `waitForExpression` steps in the Chrome DevTools Recorder format. When an expect command is recorded, it should produce a proper assertion step.

**Files:** `src/record-export.ts`

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

Add `exportPlaywrightTest(steps: RecordedStep[]): string` to `src/record-export.ts`. Maps recorded commands to Playwright Test API calls with proper `expect()` assertions. Uses resolved selectors from recording.

**Files:** `src/record-export.ts`, `src/commands/meta.ts`

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
- [ ] Edge case: commands without resolved selectors fall back to CSS selectors

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-013
**Priority:** P1

---

### TASK-015: MCP tools + CLI help + chain for v1.6 commands

Register `expect` command: MCP tool definition, CLI help text, chain set, SAFE_TO_RETRY. Update perf-audit MCP tool description to mention `--budget`.

**Files:** `src/mcp-tools.ts`, `src/cli.ts`, `src/commands/meta.ts`

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

### TASK-016: Integration tests for expect + budget

Test expect command with all condition types (url, text, visible, count, timeout). Test perf-audit budget mode with known metrics.

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `expect --url` succeeds when URL matches
- [ ] Test: `expect --url` fails with FAIL message when timeout
- [ ] Test: `expect --text` finds visible text
- [ ] Test: `expect --visible` / `--hidden` work on visible/hidden elements
- [ ] Test: `expect --count ".item" --eq N` counts correctly
- [ ] Test: multiple conditions (--url + --text) require all to pass
- [ ] Test: budget pass — all metrics under budget
- [ ] Test: budget fail — LCP over budget → error thrown with breakdown
- [ ] Edge case test: timeout 0 checks once without polling

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-011, TASK-012
**Priority:** P2

---

### TASK-017: Integration tests for export (replay expects + playwright)

Test that recorded sessions with expect commands export correctly to both Puppeteer Replay and Playwright Test formats.

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test: recorded expect --url exports as waitForExpression in replay format
- [ ] Test: recorded expect --text exports as waitForElement in replay format
- [ ] Test: recorded session exports valid Playwright test file with `test()` wrapper
- [ ] Test: generated Playwright test includes `expect(page).toHaveURL()` for URL assertions
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

**Files:** `src/visual.ts`, `src/commands/meta.ts`, `src/command-registry.ts`

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
**Depends on:** TASK-019
**Priority:** P1

---

### TASK-021: Add `layout` read command

New read command: `browse layout <selector>` returns computed layout properties for one element and its positioning ancestors.

**Files:** `src/visual.ts`, `src/commands/read.ts`, `src/command-registry.ts`

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

**Files:** `src/visual.ts`, `src/commands/meta.ts`, `src/command-registry.ts`

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

**Files:** `src/mcp-tools.ts`, `src/cli.ts`, `src/commands/meta.ts`

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

Create HTML fixtures with known visual issues and accessibility problems. Write integration tests verifying detection.

**Files:** `test/fixtures/visual-issues.html` (new), `test/fixtures/a11y-issues.html` (new), `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Fixture: visual-issues.html with low-contrast text, overlapping positioned elements, overflow, viewport bleed
- [ ] Fixture: a11y-issues.html with missing alt, missing labels, skipped headings, small touch targets, generic links, no lang
- [ ] Test: `visual` detects contrast failure in fixture
- [ ] Test: `visual` detects overlap in fixture
- [ ] Test: `visual` detects overflow in fixture
- [ ] Test: `layout` returns correct computed properties for known element
- [ ] Test: `a11y-audit` score < 100 on issues fixture, identifies specific findings
- [ ] Test: `a11y-audit` score = 100 on clean fixture (basic.html)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-020, TASK-021, TASK-022
**Priority:** P2

---

### v2.0 — Beyond the Browser (App Automation)

---

### TASK-025: Swift AX bridge — tree retrieval

Create `browse-ax/` Swift package with a CLI binary that reads the accessibility tree of any running macOS application. Accepts PID via `--pid`, outputs JSON tree via stdout. Each node: role, label, value, frame (x, y, width, height), children, actionNames.

**Files:** `browse-ax/Package.swift` (new), `browse-ax/Sources/main.swift` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `browse-ax --pid <pid> tree` outputs JSON array of AXUIElement nodes
- [ ] Each node has: role, label (AXTitle/AXDescription), value (AXValue), frame, children, actions
- [ ] Tree depth limited to 30 levels (prevent infinite recursion on malformed trees)
- [ ] Handles applications without accessibility tree (returns empty array)
- [ ] Edge case: app is not running → exit with clear error "No process with PID N"
- [ ] Edge case: no accessibility permission → exit with "Grant Accessibility permission in System Settings"

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-026: Swift AX bridge — action execution

Add `browse-ax --pid <pid> action <element-path> <action-name>` command. Element path is a JSON array of child indices (e.g., `[0, 2, 1]` = first window → third child → second child). Action names: AXPress, AXConfirm, AXCancel, AXRaise, AXShowMenu.

**Files:** `browse-ax/Sources/main.swift`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `action [0,2,1] AXPress` performs press action on resolved element
- [ ] Returns JSON `{ "success": true }` on success
- [ ] Returns JSON `{ "success": false, "error": "Action not supported" }` on unsupported action
- [ ] Element path resolution walks tree by child indices
- [ ] Edge case: path out of bounds → clear error with available children count
- [ ] Edge case: element no longer exists (stale path) → "Element not found at path"

**Agent:** ios-macos-senior-engineer
**Review:** claude
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-027: Swift AX bridge — set value + screenshot

Add `browse-ax --pid <pid> set-value <element-path> <value>` for filling text fields. Add `browse-ax --pid <pid> screenshot <path>` that captures the app's window as PNG.

**Files:** `browse-ax/Sources/main.swift`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `set-value [0,1,3] "test@example.com"` sets AXValue on the target element
- [ ] Returns success/failure JSON
- [ ] `screenshot /tmp/app.png` captures the frontmost window of the target PID as PNG
- [ ] Uses CGWindowListCreateImage for window capture (no full-screen capture)
- [ ] Edge case: text field is not editable → "Element is not editable (AXEnabled: false)"
- [ ] Edge case: app window is minimized → "Window is minimized. Restore it first."

**Agent:** ios-macos-senior-engineer
**Review:** none
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-028: Build system for Swift binary

Configure build process: compile Swift binary to universal (arm64 + x86_64), include in npm package, auto-download on first use if not bundled. Add `postinstall` script or lazy-download pattern (like react-devtools hook download).

**Files:** `browse-ax/Package.swift`, `package.json`, `src/app-bridge.ts` (new)

**Type:** infra
**Effort:** M

**Acceptance Criteria:**
- [ ] `swift build -c release` produces universal binary in `browse-ax/.build/release/browse-ax`
- [ ] Binary included in npm package (or lazy-downloaded to `.browse/bin/browse-ax` on first use)
- [ ] `app-bridge.ts` exports `ensureBridge(): Promise<string>` that returns path to binary (download if needed)
- [ ] Works on macOS arm64 and x86_64
- [ ] Edge case: non-macOS platform → throws "App automation requires macOS (uses Accessibility API)"

**Agent:** ios-macos-senior-engineer
**Review:** none
**Depends on:** TASK-025
**Priority:** P1

---

### TASK-029: AppManager class — connect, snapshot, text

Create `src/app-manager.ts` with AppManager class. Spawns browse-ax binary, communicates via JSON over stdin/stdout. Implements `connect(appName)`, `snapshot(opts)` (with @ref assignment), and `text()`.

**Files:** `src/app-manager.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `connect("Simulator")` finds PID by app name (via `pgrep`), spawns browse-ax
- [ ] `snapshot({ interactive: true })` returns text with @refs (same format as web snapshot)
- [ ] @refs assigned by role+label matching (same numbering scheme as web)
- [ ] `text()` extracts all AXValue and AXTitle strings as visible text
- [ ] Ref map stored for later tap/fill resolution
- [ ] Edge case: app not running → "App 'Simulator' is not running"
- [ ] Edge case: multiple windows → uses frontmost window

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-025, TASK-028
**Priority:** P1

---

### TASK-030: AppManager class — tap, fill, type, press, swipe

Add interaction methods to AppManager: `tap(ref)` → AXPress, `fill(ref, value)` → AXSetValue, `type(text)` → keyboard events, `press(key)` → key event, `swipe(direction)` → gesture.

**Files:** `src/app-manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `tap(@e3)` resolves ref to element path, performs AXPress
- [ ] `fill(@e2, "test")` resolves ref, sets AXValue
- [ ] `type("hello")` sends keyboard events character by character
- [ ] `press("Enter")` sends key event
- [ ] `swipe("down")` sends gesture via AX API
- [ ] Each method returns confirmation string (same format as web commands)
- [ ] Edge case: stale ref → "Ref @e3 not found. Run 'snapshot' to refresh."

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-029
**Priority:** P1

---

### TASK-031: App command dispatcher and --app CLI flag

Create `src/commands/app.ts` with `handleAppCommand()` that routes commands to AppManager. Add `--app <name>` flag to CLI and server routing.

**Files:** `src/commands/app.ts` (new), `src/cli.ts`, `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse --app "Simulator" snapshot -i` routes to AppManager.snapshot
- [ ] `browse --app "Simulator" tap @e3` routes to AppManager.tap
- [ ] Supported commands: snapshot, text, tap, fill, type, press, swipe, screenshot, expect, wait
- [ ] Unsupported commands (html, css, js, etc.) → clear error "Command 'html' not available for apps. Use 'text' or 'snapshot' instead."
- [ ] `--app` flag stored in `cliFlags.app`, sent as `X-Browse-App` header
- [ ] Server creates AppManager (alongside or instead of BrowserManager) when app header present
- [ ] Edge case: `--app` and `--session` work together (isolated app sessions)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-029, TASK-030
**Priority:** P1

---

### TASK-032: Action context for app commands

Wire action context (before/after state capture + delta) into app commands. State = current screen title, focused element, element count. Delta = screen changed, focus changed, element count changed.

**Files:** `src/app-manager.ts`, `src/action-context.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] After `tap @e3`, context line shows screen change: `[context] screen: "Login" | focus: @e4`
- [ ] After `fill @e2 "text"`, context line shows value set (or nothing if no screen change)
- [ ] State captured via browse-ax tree query (lightweight — just root window title + focused element)
- [ ] Empty context line when nothing changes (same as web behavior)
- [ ] Edge case: app crash between before/after → context gracefully skipped

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-031
**Priority:** P2

---

### TASK-033: MCP tools + CLI help for app commands

Register app-specific MCP tools, update CLI help with --app usage, add `doctor` check for browse-ax binary and Accessibility permission.

**Files:** `src/mcp-tools.ts`, `src/cli.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_app_snapshot`, `browse_app_tap`, `browse_app_fill`, `browse_app_text` MCP tools
- [ ] Each tool has `app` param (app name) + command-specific params
- [ ] CLI help shows `--app <name>` in Options section with description
- [ ] `browse doctor` checks: browse-ax binary present, Accessibility permission granted
- [ ] Edge case: non-macOS → doctor reports "App automation not available (macOS only)"

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-031
**Priority:** P2

---

### TASK-034: Integration tests for app automation

Test with a simple macOS app (TextEdit or a test Electron app). Verify snapshot, tap, fill, action context.

**Files:** `test/app.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: snapshot on TextEdit returns accessibility tree with @refs
- [ ] Test: text on TextEdit returns window content
- [ ] Test: fill on TextEdit text field sets value
- [ ] Test: action context reports changes after interaction
- [ ] Test: stale ref after window change → clear error
- [ ] Skip: tests skip on non-macOS platforms (CI compatibility)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-031, TASK-032
**Priority:** P2

---

### v2.1 — Agent Workflows

---

### TASK-035: Flow YAML parser

Create `src/flow-parser.ts` that parses flow YAML files into `FlowStep[]`. Each step has: command, args, optional conditions (from expect syntax). Validates step format, rejects unknown commands.

**Files:** `src/flow-parser.ts` (new)

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Parses `- goto: https://example.com` into `{ command: 'goto', args: ['https://example.com'] }`
- [ ] Parses `- click: "@e3"` into `{ command: 'click', args: ['@e3'] }`
- [ ] Parses multi-arg fills: `- fill: { "@e4": "value" }` into fill command
- [ ] Parses expect blocks: `- expect: { url: "/checkout", timeout: 5000 }` into expect command args
- [ ] Validates all commands exist in command registry
- [ ] Edge case: empty steps array → "Flow file has no steps"
- [ ] Edge case: malformed YAML → clear parse error with line number

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-036: Flow meta command

Add `case 'flow':` to `src/commands/meta.ts`. Reads YAML file, parses with flow-parser, executes steps sequentially through existing command handlers. Stops on first failure. Reports progress per step.

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

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

Add `case 'retry':` to `src/commands/meta.ts`. Wraps any command in a retry loop with configurable max attempts and exponential backoff. Uses expect's condition parser for `--until` conditions.

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

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

Add `case 'watch':` to `src/commands/meta.ts`. Injects MutationObserver via `page.evaluate()`, polls for changes, executes callback command when change detected.

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

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

Register flow, retry, watch commands. Write integration tests.

**Files:** `src/mcp-tools.ts`, `src/cli.ts`, `test/features.test.ts`

**Type:** chore
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse_flow`, `browse_retry`, `browse_watch` MCP tool definitions
- [ ] CLI help lists under Workflows category
- [ ] Test: flow executes 3-step goto+fill+expect sequence
- [ ] Test: retry succeeds on second attempt (flaky fixture that fails once)
- [ ] Test: watch detects DOM change (timer-based mutation in fixture)
- [ ] Test: flow stops on expect failure with clear step number

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-036, TASK-037, TASK-038
**Priority:** P2

---

### v2.2 — Ecosystem

---

### TASK-040: Plugin loader and registry

Create `src/plugin.ts` with plugin discovery (scan `node_modules/browse-plugin-*`), loading (`require(pkg).register(context)`), and registry. Context object exposes `addCommand()`, `addDetection()`, `addAuditRule()`.

**Files:** `src/plugin.ts` (new)

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Scans `node_modules/browse-plugin-*` for installed plugins on server startup
- [ ] Each plugin's `register(ctx)` called with context providing addCommand, addDetection, addAuditRule
- [ ] `addCommand(name, category, handler)` registers command in appropriate set + dispatch
- [ ] `addDetection(signature)` adds to detection database
- [ ] `addAuditRule(rule)` adds to a11y-audit or perf-audit
- [ ] Plugin errors caught and logged (don't crash server)
- [ ] Edge case: duplicate command name → warning logged, first registration wins

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-041: Plugin install/remove/list commands

Add `browse plugin install <name>`, `browse plugin remove <name>`, `browse plugin list` subcommands. Wraps `npm install browse-plugin-<name>` in the project directory.

**Files:** `src/commands/meta.ts`, `src/command-registry.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse plugin install shopify-audit` runs `npm install browse-plugin-shopify-audit`
- [ ] `browse plugin remove shopify-audit` runs `npm uninstall browse-plugin-shopify-audit`
- [ ] `browse plugin list` scans node_modules and lists installed browse-plugin-* packages with version
- [ ] Server restart required after install/remove (or lazy reload on next command)
- [ ] Edge case: npm not found → "npm is required for plugin management"

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Depends on:** TASK-040
**Priority:** P1

---

### TASK-042: SDK mode — library entry point

Create `src/sdk.ts` that exports a clean, typed API wrapping BrowserManager. Publish alongside CLI via package.json `exports` field. Library mode skips HTTP server — direct function calls.

**Files:** `src/sdk.ts` (new), `package.json`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `import { createBrowser } from '@ulpi/browse'` works
- [ ] `createBrowser()` launches Chromium, returns typed API: goto, click, fill, text, snapshot, screenshot, close, etc.
- [ ] No HTTP server spawned (direct BrowserManager calls)
- [ ] TypeScript types exported for all return values
- [ ] package.json `exports`: `{ ".": "./dist/sdk.js", "./cli": "./dist/browse.cjs" }`
- [ ] Edge case: calling CLI methods (stop, restart, status) throws "Not available in SDK mode"

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-040
**Priority:** P1

---

### TASK-043: Custom detection signatures

Extend detection loader to scan `.browse/detections/` for JSON signature files. Each file defines name, detect expression, version expression, and optional perfHints.

**Files:** `src/detection/index.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse detect` loads `.browse/detections/*.json` alongside built-in signatures
- [ ] Custom signature format: `{ name, detect, version, category, perfHints[] }`
- [ ] `detect` and `version` are JS expressions evaluated via page.evaluate
- [ ] Custom detections appear in output with `[custom]` label
- [ ] Edge case: malformed JSON → warning logged, file skipped
- [ ] Edge case: detect expression throws → caught, framework marked as not detected

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-044: MCP tools + tests for v2.2

Register plugin commands as MCP tools. Write integration tests for plugin loading, SDK mode, and custom detections.

**Files:** `src/mcp-tools.ts`, `src/cli.ts`, `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse_plugin_list` MCP tool
- [ ] CLI help lists plugin commands
- [ ] Test: plugin list returns empty array when no plugins installed
- [ ] Test: SDK mode createBrowser() returns working API, close() cleans up
- [ ] Test: SDK goto + text returns page content
- [ ] Test: custom detection JSON in temp .browse/detections/ directory detected by browse detect
- [ ] Edge case test: malformed custom detection JSON → warning, not crash

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Depends on:** TASK-040, TASK-042, TASK-043
**Priority:** P2

---

### TASK-045: Plugin API documentation

Document plugin API: how to create a browse plugin, register function interface, addCommand/addDetection/addAuditRule methods, publishing to npm.

**Files:** `docs/plugin-api.md` (new)

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Explains plugin naming convention (browse-plugin-*)
- [ ] Shows complete register function signature with TypeScript types
- [ ] Example: creating a custom perf-audit rule
- [ ] Example: creating a custom command
- [ ] Publishing instructions (npm publish)

**Agent:** general-purpose
**Review:** none
**Depends on:** TASK-040
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Response body capture slows down page loads | TASK-003 | Only capture when opt-in (--network-bodies). Skip binary bodies. Cap at 256KB. |
| Memory pressure from large response bodies in ring buffer | TASK-003 | Bodies are strings — GC handles references. Ring buffer eviction (50K cap) prevents unbounded growth. |
| expect polling burns CPU | TASK-011 | 100ms interval. Use page.waitForFunction for URL/text conditions (Playwright-native, no polling). |
| WCAG contrast calculation wrong on gradients/images | TASK-019 | Skip contrast check when background is gradient or image. Document limitation. |
| macOS Accessibility permission UX is confusing | TASK-025 | Doctor command checks permission. Clear error message with System Settings deep link. |
| User denies or can't find AX permission grant | TASK-025, TASK-031 | `browse --app` fails fast with "Accessibility permission required" + `open x-apple.systempreferences:...` deep link URL. `browse doctor` shows step-by-step instructions. |
| Swift binary doesn't compile on user's machine | TASK-028 | Ship pre-compiled universal binary in npm package. Lazy-download fallback. |
| AX tree too deep/wide for iOS Simulator | TASK-025 | Depth limit (30). Filter non-interactive elements in snapshot -i mode. |
| Flow YAML syntax errors confuse agents | TASK-035 | Validate all commands against command registry. Report errors with line numbers. |
| Plugin API breaking changes | TASK-040 | Version the plugin API. Start at v1. Only break in major versions. |
| SDK mode API surface too large | TASK-042 | Export minimal API. Only expose commands that make sense without a server. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| NetworkEntry body capture | TASK-009 | integration |
| request command (index + pattern) | TASK-009 | integration |
| api command (GET, POST, cookies) | TASK-009 | integration |
| HAR export with bodies | TASK-009 | integration |
| Body truncation at limit | TASK-009 | integration |
| expect --url condition | TASK-016 | integration |
| expect --text condition | TASK-016 | integration |
| expect --visible/--hidden | TASK-016 | integration |
| expect --count | TASK-016 | integration |
| expect timeout failure | TASK-016 | integration |
| perf-audit --budget pass | TASK-016 | integration |
| perf-audit --budget fail | TASK-016 | integration |
| replay export with expects | TASK-017 | integration |
| playwright test export | TASK-017 | integration |
| visual landmark scan | TASK-024 | integration |
| visual contrast detection | TASK-024 | integration |
| visual overlap detection | TASK-024 | integration |
| visual overflow detection | TASK-024 | integration |
| layout computed properties | TASK-024 | integration |
| a11y-audit scoring | TASK-024 | integration |
| a11y-audit findings (alt, label, heading) | TASK-024 | integration |
| AX bridge tree retrieval | TASK-034 | integration |
| AX bridge tap/fill actions | TASK-034 | integration |
| App snapshot with @refs | TASK-034 | integration |
| App action context | TASK-034 | integration |
| Flow execution (pass) | TASK-039 | integration |
| Flow execution (fail at step) | TASK-039 | integration |
| Retry with backoff | TASK-039 | integration |
| Watch DOM change | TASK-039 | integration |
| Plugin loading | TASK-044 | integration |
| SDK createBrowser + commands | TASK-044 | integration |
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
  "TASK-009": ["TASK-004", "TASK-005", "TASK-006"],
  "TASK-010": [],
  "TASK-011": ["TASK-010"],
  "TASK-012": [],
  "TASK-013": ["TASK-010"],
  "TASK-014": ["TASK-013"],
  "TASK-015": ["TASK-011", "TASK-012", "TASK-014"],
  "TASK-016": ["TASK-011", "TASK-012"],
  "TASK-017": ["TASK-013", "TASK-014"],
  "TASK-018": [],
  "TASK-019": ["TASK-018"],
  "TASK-020": ["TASK-019"],
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
  "TASK-032": ["TASK-031"],
  "TASK-033": ["TASK-031"],
  "TASK-034": ["TASK-031", "TASK-032"],
  "TASK-035": [],
  "TASK-036": ["TASK-035", "TASK-011"],
  "TASK-037": ["TASK-010"],
  "TASK-038": ["TASK-011"],
  "TASK-039": ["TASK-036", "TASK-037", "TASK-038"],
  "TASK-040": [],
  "TASK-041": ["TASK-040"],
  "TASK-042": ["TASK-040"],
  "TASK-043": [],
  "TASK-044": ["TASK-040", "TASK-042", "TASK-043"],
  "TASK-045": ["TASK-040"]
}
```
