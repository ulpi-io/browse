# Plan: Snapshot Context — ARIA Delta After Write Commands

> Generated: 2026-03-27
> Branch: `feat/snapshot-context`
> Mode: HOLD

## Overview

Extend action-context to optionally include ARIA snapshot deltas or full snapshots after write commands. Agents choose a context level per-request or per-session: `state` (existing — URL/title/dialog), `delta` (state + ARIA diff with refs for added elements), or `full` (state + complete new snapshot with refs). Eliminates the snapshot→action→snapshot round-trip, saving ~500-2000 tokens and one HTTP call per interaction step.

## Scope Challenge

Considered persistent/stable refs (fragile — DOM mutations silently invalidate nth-based locators), MutationObserver-based dirty tracking (too many false positives), and structural tree diffing with node matching (complex, EXPANSION territory). HOLD approach: reuse existing `handleSnapshot` + `Diff.diffLines` to produce a line-level delta with refs on added elements. The agent's last snapshot serves as the baseline — no extra ARIA capture before the write, no ref-overwrite risk.

## Prerequisites

- **Action-context landed** (TASK-001–006 from action-context plan) — `src/action-context.ts` exists with `capturePageState`, `buildContextDelta`, `formatContextLine` ✓
- **diff library available** — already imported in `src/commands/meta.ts` ✓
- **handleSnapshot exported** from `src/snapshot.ts` ✓
- **BrowserManager stores last snapshot per-tab** — `getLastSnapshot()`, `getLastSnapshotOpts()`, `setLastSnapshot()` ✓

## Non-Goals

- Persistent/stable element refs across DOM mutations
- Structural tree diffing with node matching or moved-element detection
- MutationObserver-based DOM change tracking
- Automatic context level selection (agent always chooses explicitly)
- Per-tool-call context level in MCP (uses session-level setting)

## Contracts

| Boundary | Producer | Consumer | Shape | Rule |
|----------|----------|----------|-------|------|
| Context level header | CLI (cli.ts) | Server (server.ts) | `X-Browse-Context: state\|delta\|full` | `1` maps to `state` for backward compat; per-request overrides session |
| Write context orchestration | action-context.ts | server.ts, mcp.ts | `prepareWriteContext()` → capture; `finalizeWriteContext()` → enriched result | `finalizeWriteContext` calls `handleSnapshot` which updates `bm.refMap` |
| ARIA delta format | action-context.ts | Agents | `[snapshot-delta] +N -M =K\n+ @eN [role] "name"\n- [role] "name"` | Refs on added lines are valid Locators; empty string when identical |
| Session context level | set context (write.ts) | server.ts handleCommand | `session.contextLevel: ContextLevel` | Per-request header overrides; `on` → `state` for compat |

## Architecture

```
                       ┌───────────────────────────────┐
                       │         cli.ts                 │
                       │  --context [state|delta|full]  │  TASK-006
                       │  X-Browse-Context header       │
                       └──────────┬────────────────────┘
                                  │
                       ┌──────────▼────────────────────┐
                       │         server.ts              │
                       │  handleCommand()               │  TASK-004
                       │                                │
                       │  ┌─ prepareWriteContext() ─────┤  TASK-003
                       │  │  (store baseline snapshot)  │
                       │  │                             │
                       │  │  execute write command      │
                       │  │                             │
                       │  │  finalizeWriteContext() ────┤  TASK-003
                       │  │  ├─ state: context line     │
                       │  │  ├─ delta: handleSnapshot   │
                       │  │  │   + formatAriaDelta()    │  TASK-002
                       │  │  └─ full: handleSnapshot    │
                       │  │                             │
                       │  └─ append to result ──────────┤
                       └────────────────────────────────┘
                                  │
      ┌───────────────────────────┼──────────────────────────┐
      │                           │                          │
┌─────▼──────────┐   ┌───────────▼───────────┐   ┌──────────▼──────┐
│ BrowserManager  │   │      mcp.ts           │   │    tests         │
│ getLastSnapshot │   │  same orchestration   │   │                  │
│ refMap updated  │   │  via prepare/finalize │   │  TASK-008/009    │
│ by handleSnap   │   │       TASK-005        │   │                  │
└─────────────────┘   └───────────────────────┘   └─────────────────┘
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| ARIA tree capture + ref building | `src/snapshot.ts` — `handleSnapshot()` | Reuse as-is |
| Line-level text diffing | `src/commands/meta.ts` — `Diff.diffLines()` in `snapshot-diff` | Reuse pattern |
| Page state capture (URL/title/dialog) | `src/action-context.ts` — `capturePageState`, `buildContextDelta`, `formatContextLine` | Reuse as-is |
| Per-tab snapshot storage | `src/browser-manager.ts` — `tabSnapshots`, `getLastSnapshot()`, `getLastSnapshotOpts()` | Reuse as-is |
| Opt-in header pattern | `src/server.ts:655-659` — `RequestOptions`, `X-Browse-Context` parsing | Extend |
| CLI flag pattern | `src/cli.ts:653-660` — `--context` flag parsing | Extend |
| Set context command | `src/commands/write.ts:680-688` — `set context on/off` handler | Extend |

## Tasks

### TASK-001: Define ContextLevel type and update Session interface

Add the `ContextLevel` union type to `src/types.ts` alongside the existing action-context types. Add `contextLevel: ContextLevel` to the `Session` interface in `src/session-manager.ts` **alongside** the existing `contextEnabled` field (keep both — TASK-004 removes `contextEnabled` when it rewires server.ts). Update session creation in `getOrCreate()` to initialize `contextLevel: 'off'`. Add `WriteContextCapture` interface to types.ts for the before/after orchestration pattern.

**Files:** `src/types.ts`, `src/session-manager.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `ContextLevel = 'off' | 'state' | 'delta' | 'full'` exported from types.ts
- [ ] `Session` interface has both `contextEnabled` (kept temporarily) and `contextLevel` fields
- [ ] TypeScript compiles cleanly: `tsc --noEmit` succeeds

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Implement ARIA delta formatter

Add `formatAriaDelta(baseline: string, current: string): string` to `src/action-context.ts`. This function takes two snapshot outputs (both with @refs), strips refs from both for comparison using `Diff.diffLines()`, then rebuilds the output with refs preserved on added lines from the "current" text. Removed lines are shown without refs. Returns a summary line (`[snapshot-delta] +N -M =K`) followed by the diff lines, or empty string if identical. Import `diff` library (already in the bundle via meta.ts). Edge cases: empty baseline returns all lines as added; identical snapshots return empty string; large changes (>80% added+removed) prepend a note suggesting full snapshot.

**Files:** `src/action-context.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `formatAriaDelta` with identical inputs returns empty string
- [ ] `formatAriaDelta` with added elements returns `+` lines with @refs from current text
- [ ] `formatAriaDelta` with empty baseline returns full current text prefixed with `+` markers

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Implement write context orchestrator (prepare/finalize)

Add `prepareWriteContext(level, bm, buffers)` and `finalizeWriteContext(capture, bm, buffers, result, command)` to `src/action-context.ts`. These replace the inline before/after logic in server.ts and mcp.ts.

`prepareWriteContext`: For `state` — captures PageState only. For `delta` — captures PageState + stores baseline text from `bm.getLastSnapshot()`. For `full` — captures PageState. For `off` — returns null-like capture.

`finalizeWriteContext`: For `state` — existing behavior (capturePageState, buildContextDelta, formatContextLine). For `delta` — run `handleSnapshot(opts, bm)`, call `formatAriaDelta(baseline, newSnapshot)`, prepend state context line. For `full` — run `handleSnapshot(opts, bm)`, prepend state context line, append full snapshot. For `off` — return result unchanged.

Import `handleSnapshot` from `../snapshot`. Use `bm.getLastSnapshotOpts()` defaulting to `['-i']`. If delta mode has no baseline, fall back to full mode. `finalizeWriteContext` must wrap all snapshot/delta work in try/catch — context capture failures must never break the write command response (preserve the existing `// Don't let context capture failures break the command` pattern from server.ts and mcp.ts).

**Files:** `src/action-context.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `prepareWriteContext('off', ...)` returns a capture that causes `finalizeWriteContext` to return result unchanged
- [ ] `finalizeWriteContext` in delta mode calls `handleSnapshot` and `formatAriaDelta`, appending delta to result
- [ ] Edge case: delta mode with no baseline (null `getLastSnapshot`) falls back to full mode

**Depends on:** TASK-001, TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Wire context levels into server.ts command pipeline

Refactor `src/server.ts` to use context levels. Change `RequestOptions.contextEnabled: boolean` to `RequestOptions.contextLevel: ContextLevel`. Parse `X-Browse-Context` header: `1` or `state` → `'state'`, `delta` → `'delta'`, `full` → `'full'`, absent → `'off'`. Resolve effective level: per-request header overrides `session.contextLevel`. Replace the inline before/after `capturePageState` + `buildContextDelta` logic in the `WRITE_COMMANDS` branch with `prepareWriteContext()` / `finalizeWriteContext()`. Update profileSession creation to use `contextLevel: 'off'`. Remove the deprecated `contextEnabled` field from Session usage and `RequestOptions` (completing the migration started in TASK-001).

**Files:** `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `X-Browse-Context: delta` header causes write commands to return ARIA diff with refs after the action result
- [ ] `X-Browse-Context: 1` header continues to work (backward compatible, state-only context)
- [ ] Read and meta commands are not affected by any context level (zero overhead)

**Depends on:** TASK-001, TASK-003
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Wire context levels into MCP server

Refactor `src/mcp.ts` to use the shared `prepareWriteContext()` / `finalizeWriteContext()` instead of inline logic. Add a module-level `mcpContextLevel: ContextLevel` (default: `'state'`) that can be changed via `set context`. When a write command runs: call `prepareWriteContext(mcpContextLevel, ...)` before, `finalizeWriteContext(capture, ...)` after. Detect `set context` in write results to update `mcpContextLevel`.

**Files:** `src/mcp.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] MCP write commands append ARIA delta when mcpContextLevel is `'delta'`
- [ ] MCP read and meta commands have zero context overhead regardless of level
- [ ] Edge case: `set context full` via MCP changes subsequent write responses to include full snapshot

**Depends on:** TASK-003
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-006: Update --context CLI flag to accept levels

Modify `src/cli.ts` context flag parsing (line ~653-660). Currently `--context` is boolean. Change to accept optional value: `--context` (no value) → `state`, `--context delta` → `delta`, `--context full` → `full`. The next arg is consumed as the level only if it matches `state|delta|full`. Set `X-Browse-Context` header to the string value. Update `cliFlags.context` from boolean to string. Update help text. Support env var: `BROWSE_CONTEXT=delta`.

**Files:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `--context` without value sets `X-Browse-Context: state` header (backward compat)
- [ ] `--context delta` sets `X-Browse-Context: delta` header
- [ ] Edge case: `--context` followed by a command name (not a level) defaults to `state`, does not consume the command as the level

**Depends on:** TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-007: Extend set context command for levels

Update `src/commands/write.ts` case `'context'` (line ~680-688) to accept: `set context off|on|state|delta|full`. `on` maps to `state` for backward compat. Return descriptive message per level. Update detection in `src/server.ts` (line ~338-340) to parse the level from the result and set `session.contextLevel`. `set context` with no value returns current level.

**Files:** `src/commands/write.ts`, `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `set context delta` returns descriptive message and sets session level to `delta`
- [ ] `set context on` returns backward-compatible message and sets level to `state`
- [ ] Edge case: `set context` (no value) returns current context level

**Depends on:** TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-008: Integration tests for snapshot context

Create `test/action-context.test.ts` with integration tests. Create fixture `test/fixtures/dynamic.html` with a button that adds/removes DOM elements on click.

Test cases: (1) Delta mode: goto → snapshot -i → click button that adds element → verify [snapshot-delta] with + @ref lines. (2) Full mode: click → verify [snapshot] with complete ARIA tree and refs. (3) State mode: click → verify [context] line only. (4) No-change: fill input → verify empty delta. (5) No baseline: first write with delta → falls back to full. (6) Ref validity: use @ref from delta in subsequent click. (7) Backward compat: X-Browse-Context: 1 → state-only.

**Files:** `test/action-context.test.ts` (new), `test/fixtures/dynamic.html` (new)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: click in delta mode produces `[snapshot-delta]` output with `+ @eN` lines for added elements
- [ ] Test: fill in delta mode produces no snapshot-delta section (nothing changed in DOM)
- [ ] Test: refs from delta output resolve to valid elements for subsequent commands

**Depends on:** TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-009: MCP integration tests for snapshot context

Add a test section to `test/mcp.test.ts` verifying context levels work through MCP. Test write commands return ARIA delta when context level is `delta`. Test read/meta commands never include context. Test `set context full` changes subsequent responses.

**Files:** `test/mcp.test.ts`

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test: MCP write command returns ARIA diff when context is `delta`
- [ ] Test: MCP `browse_snapshot` does NOT include context (meta command)
- [ ] Edge case: MCP context-enriched result works correctly with JSON wrapping

**Depends on:** TASK-005
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P2

---

### TASK-010: Update MCP tool descriptions for context levels

Update write command tool descriptions in `src/mcp-tools.ts` to mention delta/full context levels. Update `browse_click` to mention: "When context is set to delta/full, response includes ARIA snapshot changes with clickable @refs." Keep under 300 chars. Do not modify read command descriptions.

**Files:** `src/mcp-tools.ts`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_click` description mentions delta/full context levels and @refs
- [ ] No read or meta command descriptions are modified
- [ ] Edge case: all descriptions stay under 300 characters

**Depends on:** TASK-005
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `handleSnapshot()` in `finalizeWriteContext` overwrites refMap — agent's pre-write refs invalid mid-command | TASK-003, TASK-004 | Snapshot runs AFTER write completes. Write command resolves refs from existing refMap first. New refs are for the agent's next action. |
| No baseline snapshot for delta (agent never ran `snapshot` before first write) | TASK-003 | If `bm.getLastSnapshot()` returns null, fall back to full mode. First write gives full, subsequent writes give deltas. |
| Delta output is large when page changes significantly (SPA navigation at same URL) | TASK-002 | If added+removed > 80% of total elements, prepend note: `[snapshot-delta] major change — consider full snapshot`. |
| `handleSnapshot` latency adds overhead to every write command in delta/full mode | TASK-003, TASK-004, TASK-005 | `handleSnapshot` is ~10-30ms typical. Acceptable for opt-in. State-only mode has zero snapshot overhead. |
| Snapshot options mismatch: baseline was `-i -V` but after snapshot uses `-i` only | TASK-003 | Always use `bm.getLastSnapshotOpts()` for the after snapshot, matching baseline's filter. Defaults to `['-i']`. |

## Ship Cut

- **Minimum shippable:** TASK-001 → TASK-004 → TASK-006 (types + delta engine + orchestrator + server wiring + CLI flag). Agents can use `--context delta` and `--context full` via HTTP.
- **Not shippable without:** TASK-005 (MCP), TASK-007 (set command) — these are important but the feature is usable via CLI without them.
- **Deferred:** TASK-010 (docs), TASK-011 (cross-repo website docs — out of scope for this plan).

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `formatAriaDelta()` — ARIA line diff with ref preservation | TASK-008 | integration |
| `prepareWriteContext()` — before-write state/snapshot capture | TASK-008 | integration |
| `finalizeWriteContext()` — after-write enrichment at each level | TASK-008 | integration |
| server.ts context level parsing from `X-Browse-Context` header | TASK-008 | integration |
| Delta mode: click that adds DOM elements → diff with refs | TASK-008 | integration |
| Full mode: click → full snapshot appended | TASK-008 | integration |
| State mode: backward compatible, no ARIA overhead | TASK-008 | integration |
| No-change action: fill → empty delta | TASK-008 | integration |
| No baseline: first write in delta → falls back to full | TASK-008 | integration |
| Refs from delta valid for subsequent commands | TASK-008 | integration |
| MCP write with delta context → ARIA diff | TASK-009 | integration |
| MCP read/meta → no context appended | TASK-009 | integration |
| `set context delta/full` session command | TASK-008 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 10 |
| Layer Count | 4 |
| Critical Path | TASK-001 → TASK-003 → TASK-004 → TASK-008 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002 | Independent foundation — types and delta formatter |
| 1 | TASK-003 | Orchestrator combining types + formatter |
| 2 | TASK-004, TASK-005 | Parallel server.ts and MCP wiring |
| 3 | TASK-006, TASK-007, TASK-008, TASK-009, TASK-010 | CLI, set command, tests, docs — all independent |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-001", "TASK-003"],
  "TASK-005": ["TASK-003"],
  "TASK-006": ["TASK-004"],
  "TASK-007": ["TASK-004"],
  "TASK-008": ["TASK-004"],
  "TASK-009": ["TASK-005"],
  "TASK-010": ["TASK-005"]
}
```
