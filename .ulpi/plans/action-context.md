# Plan: Action Context — Enriched Write Command Responses

> Generated: 2026-03-28
> Branch: `feat/action-context`
> Mode: EXPANSION

## Overview

Add an opt-in "action context" mode to browse that appends a compact state delta to every write command response. When enabled, agents receive a one-line summary of what changed (URL, title, dialog, tab count, console errors) after each action — eliminating the need for expensive snapshot calls between steps. Reduces agent token consumption by ~3x for typical multi-step workflows.

## Scope Challenge

Considered: live dashboard (agent-browser style), session memory commands, terminal-rendered viewport. All rejected — the highest-value, lowest-friction approach is enriching existing command responses. The agent already gets a result from every command; we just make that result carry more information. No new commands to learn, no new workflow. Opt-in via existing `X-Browse-*` header pattern and `--context` CLI flag.

## Architecture

```
                          ┌─────────────────────────┐
                          │      cli.ts              │
                          │  --context flag           │
                          │  X-Browse-Context header  │
                          └──────────┬──────────────┘
                                     │
                          ┌──────────▼──────────────┐
                          │      server.ts           │
                          │  handleCommand()         │
                          │                          │
                          │  ┌─ capturePageState() ──┤ TASK-002
                          │  │  (before write cmd)   │
                          │  │                       │
                          │  │  execute write cmd    │
                          │  │                       │
                          │  │  capturePageState()   │
                          │  │  (after write cmd)    │
                          │  │                       │
                          │  │  buildContextDelta()  │ TASK-003
                          │  │  (diff before/after)  │
                          │  │                       │
                          │  └─ append to result ────┤ TASK-004
                          │                          │
                          └──────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
┌────────▼─────────┐   ┌─────────────▼────────────┐   ┌────────▼─────────┐
│  BrowserManager   │   │    mcp.ts                │   │   tests          │
│  getPage()        │   │    context injection     │   │                  │
│  getCurrentUrl()  │   │    for MCP tool calls    │   │  commands.test   │
│  getTabCount()    │   │                          │   │  features.test   │
│  lastDialog       │   │         TASK-006         │   │  context.test    │
│  (existing)       │   └──────────────────────────┘   │                  │
│                   │                                   │  TASK-007/008   │
│  TASK-001 types   │                                   └────────────────┘
└───────────────────┘
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Page state getters (URL, title, tabs, dialog) | `browser-manager.ts` — `getCurrentUrl()`, `getTabCount()`, `lastDialog`, `getPage().title()` | Reuse as-is |
| Opt-in header pattern | `server.ts:622-625` — `X-Browse-Json`, `X-Browse-Boundaries`, `RequestOptions` | Extend with `X-Browse-Context` |
| CLI flag pattern | `cli.ts:442-458` — `cliFlags.json`, `cliFlags.contentBoundaries` | Extend with `cliFlags.context` |
| Command result pipeline | `server.ts:308-372` — result → recording → truncation → boundaries → json → response | Extend with context injection step |
| Console/network buffers | `buffers.ts` — `SessionBuffers.consoleBuffer`, `networkBuffer`, counters | Reuse for error/network delta |
| Write command set | `command-registry.ts:15-25` — `WRITE_COMMANDS` set | Reuse to gate context gathering |
| MCP tool call handler | `mcp.ts:57-141` — `CallToolRequestSchema` handler | Extend with context injection |
| Test setup | `test/setup.ts` — shared `BrowserManager` + test server | Reuse for context tests |

## Tasks

### TASK-001: Define PageState interface and context types

Create the TypeScript types that define what page state is captured and what the context delta looks like. Add to the existing `src/types.ts` file which already has `CommandContext` and `CommandResult`. Also add `contextEnabled?: boolean` to the `Session` interface in `src/session-manager.ts` so it's available for all downstream tasks.

**Files:** `src/types.ts`, `src/session-manager.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `PageState` interface defined with fields: `url`, `title`, `tabCount`, `dialog` (type+message | null), `consoleErrorCount`, `networkPendingCount`, `timestamp`
- [ ] `ContextDelta` interface defined with fields: `urlChanged?`, `titleChanged?`, `dialogAppeared?`, `dialogDismissed?`, `tabsChanged?`, `consoleErrors?`, `navigated?`
- [ ] `Session` interface in `session-manager.ts` extended with `contextEnabled?: boolean` (default undefined/false)
- [ ] Session creation in `getOrCreate()` initializes `contextEnabled: false`
- [ ] TypeScript compiles cleanly with `tsc --noEmit`
- [ ] Edge case: interfaces handle null/undefined dialog state correctly

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Implement capturePageState() function

Create the state capture function that reads current page state from BrowserManager into a `PageState` object. This runs before and after each write command to enable diffing. Must be fast (<5ms). The function is async because `page.title()` requires await — use a 100ms timeout with empty string fallback. URL from `bm.getCurrentUrl()`, tabs from `bm.getTabCount()`, dialog from `bm.getLastDialog()`.

**Files:** `src/action-context.ts` (new)

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `async capturePageState(bm: BrowserManager, buffers: SessionBuffers): Promise<PageState>` captures all PageState fields
- [ ] Execution time <5ms typical (page.title() with 100ms timeout, fallback to empty string)
- [ ] Uses `bm.getLastDialog()` (not getDialog) for dialog state
- [ ] Gracefully handles edge cases: about:blank pages, closed pages, crashed contexts — returns partial state with defaults
- [ ] Returns `consoleErrorCount` by counting entries with level 'error' in buffer since last capture

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0
**Depends on:** TASK-001

---

### TASK-003: Implement buildContextDelta() function

Create the diffing function that compares two PageState snapshots and produces a compact `ContextDelta`. Then implement `formatContextLine()` that turns a ContextDelta into a single-line string for appending to command results.

**Files:** `src/action-context.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `buildContextDelta(before: PageState, after: PageState): ContextDelta` correctly detects URL change, title change, dialog appearance/dismissal, tab count change, new console errors
- [ ] `formatContextLine(delta: ContextDelta): string` produces compact output like `" | /cart → /checkout | title: Checkout | +dialog: confirm"` — returns empty string when nothing changed
- [ ] Output is token-efficient: <100 characters for typical single-change scenarios
- [ ] Edge case: handles both states being identical (returns empty string / no-op delta)
- [ ] Edge case: multiple changes in one action (URL + title + dialog) all included in one line

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1
**Depends on:** TASK-001

---

### TASK-004: Wire action context into server.ts command pipeline

Inject the before/after state capture and context delta formatting into the `handleCommand()` function in server.ts. Add `actionContext` to `RequestOptions`. Only activate for write commands when the `X-Browse-Context` header is set.

**Files:** `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `RequestOptions` extended with `actionContext: boolean`, read from `req.headers.get('x-browse-context') === '1'`
- [ ] Before write command execution: `capturePageState()` called and stored
- [ ] After write command execution: second `capturePageState()`, delta computed, formatted line appended to result string
- [ ] Context is NOT gathered for read commands or meta commands (performance: no overhead when not needed)
- [ ] Context is NOT gathered when `actionContext` option is false (zero overhead when opt-out)
- [ ] Edge case: if write command throws an error, context is still not gathered (no try/catch complexity)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1
**Depends on:** TASK-002, TASK-003

---

### TASK-005: Add --context CLI flag

Add the `--context` flag to the CLI client that sets the `X-Browse-Context: 1` header on every request. Follow the existing pattern used by `--json` and `--content-boundaries`.

**Files:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `--context` flag parsed in CLI flags section alongside `--json`, `--max-output`, etc.
- [ ] When set, adds `X-Browse-Context: 1` header to all requests in `sendCommand()`
- [ ] Help text includes `--context` in the flags list
- [ ] Edge case: flag works in combination with `--json` (context appended to result before JSON wrapping)

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1
**Depends on:** TASK-004

---

### TASK-006: Add action context support to MCP server

Wire action context into the MCP server's tool call handler. Since MCP is the primary way AI agents interact with browse, this is critical. Context should be always-on for MCP write commands (agents always benefit), or toggled via an MCP resource/config.

**Files:** `src/mcp.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] MCP write command results include context delta line when page state changes
- [ ] MCP read/meta commands do NOT include context (no overhead)
- [ ] Context line is appended to the text content, not as a separate content block (agents parse a single text response)
- [ ] Edge case: context works correctly with existing JSON mode wrapping in MCP
- [ ] Edge case: snapshot command returns refs resource + context is not added (snapshot is a meta command)

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1
**Depends on:** TASK-002, TASK-003

---

### TASK-007: Integration tests for action context

Write integration tests that verify context deltas are correct across all major write command scenarios: navigation, click that triggers navigation, fill (no state change), dialog trigger, tab open/close.

**Files:** `test/features.test.ts` (add section) or `test/action-context.test.ts` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `goto` produces context with URL and title
- [ ] Test: `click` on a link produces context with URL change
- [ ] Test: `fill` on an input produces empty context (no state change)
- [ ] Test: action that triggers dialog produces context with dialog info
- [ ] Test: context is empty string when nothing changes (no noise)
- [ ] Test: context works with `--json` mode (context in result before JSON wrapping)
- [ ] Edge case test: rapid sequential commands don't produce stale state

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2
**Depends on:** TASK-004

---

### TASK-008: MCP integration tests for action context

Write tests verifying action context works correctly through the MCP tool call handler, including interaction with existing MCP-specific behaviors (snapshot refs, JSON wrapping).

**Files:** `test/mcp.test.ts` (add section)

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test: MCP browse_click returns result with context line
- [ ] Test: MCP browse_snapshot does NOT include context
- [ ] Test: MCP browse_fill with no state change returns clean result (no trailing separator)
- [ ] Edge case: MCP JSON mode wraps context-enriched result correctly

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P2
**Depends on:** TASK-006

---

### TASK-009: Add `browse set context on/off` session command

Add a `set` sub-command that allows toggling context mode per-session at runtime without restarting. This lets agents enable context when entering a complex workflow and disable it for simple reads. The `contextEnabled` field is already on the Session interface (added in TASK-001). Read/write it via the session object. Session-level flag overrides the per-request header in server.ts.

**Files:** `src/commands/write.ts`, `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse set context on` enables action context for the current session
- [ ] `browse set context off` disables action context for the current session
- [ ] `browse set context` (no value) returns current status
- [ ] Session-level context flag overrides the per-request header (session ON + no header = context enabled)
- [ ] Edge case: `set context on` in one session doesn't affect other sessions

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P2
**Depends on:** TASK-004

---

### TASK-010: Update MCP tool descriptions for context awareness

Update the MCP tool definitions to document that write commands return enriched responses with state context. This helps AI agents understand and leverage the context information in their tool descriptions.

**Files:** `src/mcp-tools.ts`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Write command tool descriptions mention that responses include state context (URL changes, title, dialogs)
- [ ] `browse_click` description explicitly mentions: "Returns click confirmation plus any page state changes (navigation, title change, dialogs)"
- [ ] No read command descriptions are modified
- [ ] Edge case: descriptions stay under 300 chars to avoid bloating MCP tool listings

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P3
**Depends on:** TASK-006

---

### TASK-011: Documentation — action context guide

Create MDX documentation explaining the action context feature, why it matters for agents, how to enable it (CLI flag, MCP default, session command), and what information is included in the delta.

**Files:** `content/docs/guides/action-context.mdx` (new), `content/docs/guides/meta.json` (update)
**Note:** This is a cross-repo task — targets the website repo (`browse_cli_website`), not the CLI repo.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Explains the problem (agents waste tokens on snapshots between actions)
- [ ] Shows before/after examples of command output with and without context
- [ ] Documents all three activation methods: `--context` flag, MCP default, `browse set context on`
- [ ] Lists all fields in the context delta with examples
- [ ] Edge case: notes that context is only added when state actually changes (no noise)

**Agent:** general-purpose
**Review:** none
**Priority:** P3
**Depends on:** TASK-005, TASK-006, TASK-009

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `page.title()` is async and slow on complex pages | TASK-002 | Use `page.title()` with a 100ms timeout; fall back to empty string. Cache title in BrowserManager if needed. |
| Context capture adds latency to every write command | TASK-004 | Only capture when opt-in flag is set. Profile before/after. Target <5ms overhead. |
| Console error count can be very large (50K buffer) | TASK-002 | Count only errors added since last capture timestamp, not entire buffer scan. |
| MCP always-on context may surprise existing integrations | TASK-006 | Start with opt-in for MCP too (env var `BROWSE_MCP_CONTEXT=1`), make default in next major. |
| Context line parsing breaks JSON mode consumers | TASK-004, TASK-005 | Context is appended to the result string BEFORE JSON wrapping — JSON consumers get it in `data` field, no parsing change. |
| Stale state from concurrent commands in same session | TASK-002, TASK-007 | State capture is synchronous read of in-memory values; no race condition possible. Test with rapid sequential calls. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `capturePageState()` — state capture function | TASK-007 | integration |
| `buildContextDelta()` — state diffing | TASK-007 | integration |
| `formatContextLine()` — string formatting | TASK-007 | integration |
| server.ts context injection for write commands | TASK-007 | integration |
| server.ts no context for read/meta commands | TASK-007 | integration |
| CLI `--context` flag propagation | TASK-007 | integration |
| MCP context injection for write tools | TASK-008 | integration |
| MCP no context for read/meta tools | TASK-008 | integration |
| `browse set context on/off` toggle | TASK-007 | integration |
| Dialog-triggered context delta | TASK-007 | integration |
| No-change actions produce empty context | TASK-007, TASK-008 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-004"],
  "TASK-006": ["TASK-002", "TASK-003"],
  "TASK-007": ["TASK-004"],
  "TASK-008": ["TASK-006"],
  "TASK-009": ["TASK-004"],
  "TASK-010": ["TASK-006"],
  "TASK-011": ["TASK-005", "TASK-006", "TASK-009"]
}
```
