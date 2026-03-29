# Plan: Unified Flows, Recording, and Replay

> Generated: 2026-03-29
> Branch: `feat/unified-flows`
> Mode: EXPANSION

## Overview

Flows, recording, chain, and replay are four related but disconnected systems. Flows bypass `executeCommand()`, are browser-coupled via `BrowserTarget`, and can't record sub-steps. The meta dispatch layer hardcodes which commands work on app targets, blocking flows from Android/iOS/macOS. Recording has an untyped `_lastRecording` hack. This plan wires them together: recording becomes the canonical capture model, all execution goes through `executeCommand()`, and flows work on any `AutomationTarget`.

## Scope Challenge

**What exists:** `executeCommand()` pipeline with lifecycle hooks, recording after-hook in server.ts, flow YAML parsing, 3 export formats (browse/replay/playwright). All the pieces exist — they just aren't connected.

**What's ruled out:** Redesigning the lifecycle system, changing the YAML flow format, merging flows and chain into one concept, adding new commands, or touching the browser/app bridge layers.

**Mode rationale:** EXPANSION — comprehensive test coverage for nested recording, app target flows, and edge cases (recursive flows, export format restrictions).

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ Transport Layer                                                       │
│  server.ts: lifecycle = { before, after(recording+context), onError } │
│  mcp/server.ts: lifecycle = { before, after(context), onError }       │
│                                                                       │
│  TASK-002: both transports pass lifecycle into context.lifecycle       │
│            so nested calls can forward it                             │
│                                                                       │
│           executeCommand(cmd, args, { context, lifecycle })           │
│                             │                                         │
│        ┌────────────────────┼────────────────────┐                    │
│        ▼                    ▼                    ▼                    │
│   Read Defs            Write Defs           Meta Defs                 │
│   (registry)           (registry)           (registry)                │
│                                                │                      │
│                          TASK-004: widen appMetaCommands               │
│                          (flow,chain,record,doctor,sessions,           │
│                           session-close added for app targets)         │
│                                                │                      │
│                    ┌───────┼───────┐───────┐                          │
│                    ▼       ▼       ▼       ▼                          │
│                  flow    chain   record  sessions                      │
│                    │       │       │                                   │
│                    ▼       ▼       │     TASK-005/006                  │
│         ┌──────────────────────┐   │                                  │
│         │ executeFlowSteps()   │   │     TASK-009                     │
│         │ / chain loop         │   │                                  │
│         │   per sub-step:      │   ▼                                  │
│         │   executeCommand(    │  Export Pipeline (TASK-008/009):      │
│         │     cmd, args,       │  Session.recording/.lastRecording    │
│         │     { context,       │    ├── browse    → exportBrowse()    │
│         │       lifecycle }    │    ├── flow      → exportFlowYaml()  │ ← NEW
│         │   )                  │    ├── replay    → exportReplay()    │ browser-only
│         │   ↑ recording fires  │    └── playwright→ exportPlaywright()│ browser-only
│         │     via after-hook   │                                      │
│         └──────────────────────┘  TASK-007: skipRecording on wrappers │
│                                   TASK-001: typed lastRecording       │
│         TASK-003/010: findProjectRoot() for flowPaths                 │
└───────────────────────────────────────────────────────────────────────┘

Recursive flow rule (TASK-005/013):
  flow run inside a flow → allowed, max depth 10, rejects with
  "flow nesting depth exceeded (max 10)" on violation
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Command execution pipeline | `src/automation/executor.ts` `executeCommand()` | Reuse as-is |
| Lifecycle hooks | `src/automation/events.ts` `CommandLifecycle` | Reuse as-is |
| Recording after-hook | `src/server.ts:314-333` | Reuse — flows forward it via `ctx.lifecycle` |
| YAML flow parsing | `src/flow-parser.ts` `parseFlowYaml()` | Reuse as-is |
| Browse chain export | `src/export/record.ts` `exportBrowse()` | Reuse as-is |
| Replay/Playwright export | `src/export/replay.ts` | Reuse — add browser-only guard |
| YAML serialization in flow save | `src/commands/meta/flows.ts:87-99` | Extract to `exportFlowYaml()` |
| Config project root detection | `src/config.ts` `loadConfig()` | Extend — also export root path |
| Target capability gating | `src/automation/executor.ts:56-72` | Reuse — already in executor |

## Tasks

### TASK-001: Type `lastRecording` on Session and deduplicate `RecordedStep`

Remove the `_lastRecording` property-bag hack. Add a typed `lastRecording` field to the `Session` interface. Deduplicate the `RecordedStep` interface — it's defined in both `src/session/manager.ts:21-26` and `src/export/record.ts:10-15`.

**Files:** `src/session/manager.ts`, `src/commands/meta/recording.ts`, `src/commands/meta/flows.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `Session` interface has `lastRecording: RecordedStep[] | null` field
- [ ] Zero occurrences of `(currentSession as any)._lastRecording` in codebase
- [ ] `RecordedStep` imported from `src/export/record.ts`, re-exported from `src/session/manager.ts`

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Add `lifecycle` field to `CommandContext` and thread it in transports

Add a `lifecycle?: CommandLifecycle` field to `CommandContext` in `src/automation/command.ts`. Update `src/server.ts` to include the lifecycle object in the context it passes to `executeCommand()`, so that when a command definition (e.g., flow, chain) receives `ctx.lifecycle`, it can forward it to nested `executeCommand()` calls as `opts.lifecycle`. This is the mechanism that makes sub-step recording work: nested `executeCommand(step.command, step.args, { context: {...}, lifecycle: ctx.lifecycle })` causes the transport's after-hook (which pushes to `session.recording`) to fire for each sub-step.

Note: `src/mcp/server.ts` also constructs a lifecycle but does not currently support recording. It should also pass its lifecycle into context for forward-compatibility, even though MCP recording is not the target of this plan.

**Files:** `src/automation/command.ts`, `src/server.ts`, `src/mcp/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `CommandContext` has `lifecycle?: CommandLifecycle` field
- [ ] `src/server.ts` passes `lifecycle` into context: `context: { ..., lifecycle }`
- [ ] `src/mcp/server.ts` also passes its lifecycle into context (forward-compat)
- [ ] `npx tsc --noEmit` passes

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-003: Export `findProjectRoot()` from config

Extract the project-root detection logic from `loadConfig()` in `src/config.ts` into a separate exported `findProjectRoot()` function. `loadConfig()` calls it internally. Flow and recording commands use it to resolve `flowPaths` relative to the project root, not `process.cwd()`.

**Files:** `src/config.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `findProjectRoot()` exported from `src/config.ts`, returns `string | null`
- [ ] `loadConfig()` uses `findProjectRoot()` internally (same behavior)
- [ ] No change to existing `loadConfig()` return values

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-004: Widen meta dispatch `appMetaCommands` for flow/chain/record

In `src/commands/meta/index.ts`, the `appMetaCommands` set at line 104 hardcodes `['snapshot', 'screenshot', 'status']`. Expand it to include `flow`, `chain`, `doctor`, `record`. Do NOT include `state` (browser storage — uses `getContext()`), `retry`, `watch` (call `getPage()`), `har`, `video` (browser API), `handoff`, `resume` (browser-only).

For `sessions` and `session-close`: these are safe for app targets (`handleSessionsCommand` uses `sessionManager`, not `bm`, for those two cases). Add them to `appMetaCommands`. The `sessions.ts` handler signature stays `BrowserTarget` for now — the `bm` parameter is only used by `state`/`handoff`/`resume` cases, and the meta dispatch passes it via cast. No changes needed in `src/commands/meta/sessions.ts` itself.

Change `handleMetaCommand` signature from `bm: BrowserTarget` to `target: AutomationTarget`. Thread `lifecycle?: CommandLifecycle` parameter to `handleFlowsCommand` and `handleSystemCommand`.

**Files:** `src/commands/meta/index.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--platform android --app com.example flow <file>` reaches `handleFlowsCommand` without "not available for app targets" error
- [ ] `sessions` and `session-close` work on app targets (they use sessionManager, not bm)
- [ ] `state save`, `har start`, `video start` still blocked for app targets with clear error
- [ ] `handleMetaCommand` accepts `AutomationTarget` — browser sub-handlers cast internally

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002
**Priority:** P1

---

### TASK-005: Make flows target-neutral + route through `executeCommand()`

In `src/commands/meta/flows.ts`, change `bm: BrowserTarget` to `target: AutomationTarget`. Accept `lifecycle?: CommandLifecycle` parameter. Replace all direct `handleReadCommand`/`handleWriteCommand`/`handleMetaCommand` dispatch with `executeCommand()` calls that explicitly forward the lifecycle:

```typescript
const { executeCommand } = await import('../../automation/executor');
const { output } = await executeCommand(step.command, step.args, {
  context: { args: step.args, target, buffers, domainFilter, session, shutdown, sessionManager, lifecycle },
  lifecycle,  // ← explicitly passed so transport after-hooks (recording) fire for each sub-step
});
```

Extract a shared `executeFlowSteps()` helper (currently duplicated between `flow <file>` at lines 222-256 and `flow run <name>` at lines 136-169).

**Recursive flow rule:** `flow run` inside a flow is allowed with a depth cap of 10. Track depth via a `depth` parameter on `executeFlowSteps()` (default 0, incremented per nested call). If depth exceeds 10, reject with `"flow nesting depth exceeded (max 10)"`. Do NOT use a module-level counter — that is not safe in a multi-session server where concurrent sessions would share state.

For `retry` (line 274) and `watch` (line 334): add runtime guard `if (!('getPage' in target)) throw new Error('retry/watch requires a browser target')`.

**Files:** `src/commands/meta/flows.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Flow sub-steps go through `executeCommand()` with `lifecycle` explicitly forwarded
- [ ] `flow run <name>` and `flow <file>` share the same `executeFlowSteps()` helper
- [ ] Nested `flow run` works up to depth 10, rejects at depth 11 with clear error
- [ ] `retry` and `watch` throw clear error on non-browser targets
- [ ] Existing flow YAML files execute identically (no format change)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-002, TASK-004
**Priority:** P1

---

### TASK-006: Make chain target-neutral + route through `executeCommand()`

In `src/commands/meta/system.ts`, change `bm: BrowserTarget` to `target: AutomationTarget`. Accept `lifecycle?: CommandLifecycle` parameter. In the `chain` case, replace the hardcoded `WRITE_SET`/`READ_SET` category dispatch (lines 69-70) with `executeCommand()` calls that explicitly forward `lifecycle`:

```typescript
const { executeCommand } = await import('../../automation/executor');
const { output } = await executeCommand(name, cmdArgs, {
  context: { args: cmdArgs, target, buffers, domainFilter, session, shutdown, sessionManager, lifecycle },
  lifecycle,  // ← explicitly passed so recording after-hooks fire per sub-step
});
```

Keep the policy check (chain-specific). For `status` and `url`: add runtime guard since they call `bm.getPage()`.

**Files:** `src/commands/meta/system.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Chain sub-steps go through `executeCommand()` with `lifecycle` explicitly forwarded
- [ ] Hardcoded `WRITE_SET`/`READ_SET` removed — command routing derived from registry
- [ ] `status`/`url` still work on browser targets, throw clear error on app targets

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-004
**Priority:** P1

---

### TASK-007: Add `skipRecording` + `targetSupport: 'browser'` to registry

In `src/automation/registry.ts`, add `skipRecording: true` to `flow`, `chain`, `retry`, `watch` specs. This prevents wrapper commands from being recorded — only their sub-steps get recorded.

Mark `retry` and `watch` as `targetSupport: 'browser'` so the executor gates them with proper capability errors on app targets (instead of runtime `getPage()` crashes).

**Files:** `src/automation/registry.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `flow` command itself is not recorded when recording is active — only sub-steps
- [ ] `retry` on an Android session fails with "not available for android-app targets" from executor
- [ ] `chain` command itself not recorded — sub-steps are

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-005
**Priority:** P1

---

### TASK-008: Split recording into target-neutral and browser-only

In `src/commands/meta/recording.ts`, change `bm: BrowserTarget` to accept `AutomationTarget`. Guard `har` and `video` with browser-only check. Guard `record export replay` and `record export playwright` to reject for non-browser sessions with a clear error.

`record start`/`stop`/`status` and `record export browse` are target-neutral.

**Files:** `src/commands/meta/recording.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `record start`/`stop` works on Android sessions
- [ ] `record export browse` works on Android sessions
- [ ] `record export replay` on Android session → "replay export requires a browser session"
- [ ] `har start` on Android session → "HAR recording requires a browser session"

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-004
**Priority:** P1

---

### TASK-009: Add `flow` as a recording export format

Add `exportFlowYaml(steps: RecordedStep[]): string` to `src/export/record.ts`. This extracts the YAML serialization logic currently duplicated in `flows.ts` lines 87-99. Add `flow` format branch to `record export` in `src/commands/meta/recording.ts`. Update `flow save` in `src/commands/meta/flows.ts` to call `exportFlowYaml()`.

Also update `src/automation/registry.ts` — the `record` command spec's MCP schema, CLI help text, and usage string currently only advertise `browse|replay|playwright`. Add `flow` to those metadata strings so CLI help, MCP tool descriptions, and error messages all reflect the new format.

**Files:** `src/export/record.ts`, `src/commands/meta/recording.ts`, `src/commands/meta/flows.ts`, `src/automation/registry.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `record export flow` produces valid YAML that `flow <file>` can execute
- [ ] `flow save <name>` uses `exportFlowYaml()` — no inline YAML generation
- [ ] Round-trip: `record start` → commands → `record export flow out.yaml` → `flow out.yaml` succeeds
- [ ] CLI help / MCP schema / usage string for `record` includes `flow` as a format option

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-008
**Priority:** P2

---

### TASK-010: Fix flows dir to use config-root-aware resolution

Replace `BROWSE_LOCAL_DIR || '/tmp'` in `src/commands/meta/flows.ts` with proper resolution: (1) `browse.json` `flowPaths` resolved relative to project root via `findProjectRoot()`, (2) `BROWSE_LOCAL_DIR/flows`, (3) `.browse/flows` as last resort. Remove `/tmp` fallback for saved flows.

**Files:** `src/commands/meta/flows.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `flow save myflow` stores to `<project-root>/.browse/flows/myflow.yaml`
- [ ] `browse.json` with `"flowPaths": ["custom-flows"]` resolves relative to project root
- [ ] No flows saved to `/tmp` when project root exists

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-003, TASK-005
**Priority:** P2

---

### TASK-011: Integration tests — flow execution through executor

Test that flows route through `executeCommand()`, lifecycle hooks fire, and recording captures sub-steps. Test both browser and mock app targets.

**Files:** `test/unified-flows.test.ts`

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] Test: `record start` → `flow run <name>` → `record stop` → recording contains individual sub-steps, not the flow wrapper
- [ ] Test: flow with unsupported command on app target → fails with capability error at the specific step
- [ ] Test: nested flow (flow that calls another flow) doesn't create duplicate recordings

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-005, TASK-007
**Priority:** P2

---

### TASK-012: Integration tests — chain through executor + export formats

Test chain dispatch through `executeCommand()`, recording of chain sub-steps, and export format restrictions (replay/playwright blocked on app sessions).

**Files:** `test/unified-flows.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: chain on browser session — sub-steps recorded individually
- [ ] Test: `record export flow` produces valid YAML → `flow <file>` re-executes
- [ ] Test: `record export replay` on non-browser session → rejects with clear error

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-006, TASK-007, TASK-008, TASK-009
**Priority:** P2

---

### TASK-013: Edge case tests — nested flows, recursive recording, app targets

Test edge cases: recursive flow execution (depth cap), recording during flow on app target, `skipRecording` on wrapper commands, retry/watch browser-only gating, export format restrictions.

**Recursive flow rule under test:** `flow run` inside a flow is allowed up to depth 10. At depth 11, it must reject with `"flow nesting depth exceeded (max 10)"`.

**Files:** `test/unified-flows.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: nested `flow run` at depth 2 → succeeds, sub-steps recorded
- [ ] Test: `flow run` at depth 11 → rejects with "flow nesting depth exceeded"
- [ ] Test: `retry` on app target → "not available for android-app targets" from executor
- [ ] Test: `record export playwright` on app session → rejects, `record export browse` → succeeds

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-007, TASK-008, TASK-011
**Priority:** P2

---

### TASK-014: Update docs — README workflow commands section

Update the README workflow commands section to document: `record export flow`, flow execution on app targets, which commands are browser-only. Update the CHANGELOG for this release.

**Files:** `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] README documents `record export flow` format
- [ ] README notes which workflow commands are browser-only (retry, watch, har, video)
- [ ] CHANGELOG has entry for unified flows/recording

**Agent:** general-purpose

**Depends on:** TASK-009, TASK-011
**Priority:** P3

---

### TASK-015: Update CLAUDE.md reference docs

Update architecture.md and exports-reference.md to reflect the lifecycle threading, `exportFlowYaml`, `findProjectRoot`, widened `appMetaCommands`, and new `CommandContext.lifecycle` field.

**Files:** `.claude/claude-md-refs/architecture.md`, `.claude/claude-md-refs/exports-reference.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Architecture doc shows lifecycle threading through flows/chain
- [ ] Exports reference lists `exportFlowYaml`, `findProjectRoot`
- [ ] Command context docs mention `lifecycle` field

**Agent:** general-purpose

**Depends on:** TASK-005, TASK-006
**Priority:** P3

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Circular imports: flows.ts → executor.ts → registry.ts → index.ts → flows.ts | TASK-005 | Use dynamic `await import()` for executor in flows.ts (same pattern as existing meta handler imports) |
| Lifecycle hooks fire for both outer flow + inner steps | TASK-005, TASK-007 | `skipRecording: true` on flow/chain/retry/watch prevents double-recording |
| `writeCapture` closure conflict in nested execution | TASK-005 | Sequential step execution means before/after hooks don't overlap — no conflict |
| App target gets browser-only export format | TASK-008 | Guard at export time, not at recording time — recording is target-neutral |
| `findProjectRoot()` returns null outside project | TASK-003, TASK-010 | Fall back to `BROWSE_LOCAL_DIR` or `.browse/` — never `/tmp` for saved flows |
| Recursive flow creates infinite loop | TASK-005, TASK-013 | Depth counter with cap of 10 — rejects with clear error at depth 11 |
| Lifecycle not forwarded → sub-steps not recorded | TASK-002, TASK-005, TASK-006 | Explicit `lifecycle` parameter forwarded to nested `executeCommand()` calls — not implicit, not inferred |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Flow sub-step via executeCommand() | TASK-011 | integration |
| Lifecycle forwarding to sub-steps | TASK-011 | integration |
| Recording captures flow sub-steps | TASK-011 | integration |
| Chain via executeCommand() | TASK-012 | integration |
| `record export flow` round-trip | TASK-012 | integration |
| App target flow execution | TASK-011 | integration |
| replay/playwright export blocked on app | TASK-013 | integration |
| retry/watch browser-only gating | TASK-013 | integration |
| Nested flow recording | TASK-013 | integration |
| `exportFlowYaml()` output validity | TASK-012 | unit |
| `findProjectRoot()` edge cases (no .git, nested projects) | TASK-011 | unit |
| Recursive flow depth cap enforcement | TASK-013 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": [],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-001", "TASK-002", "TASK-004"],
  "TASK-006": ["TASK-002", "TASK-004"],
  "TASK-007": ["TASK-005"],
  "TASK-008": ["TASK-001", "TASK-004"],
  "TASK-009": ["TASK-001", "TASK-008"],
  "TASK-010": ["TASK-003", "TASK-005"],
  "TASK-011": ["TASK-005", "TASK-007"],
  "TASK-012": ["TASK-006", "TASK-008", "TASK-009"],
  "TASK-013": ["TASK-007", "TASK-008", "TASK-011"],
  "TASK-014": ["TASK-009", "TASK-011"],
  "TASK-015": ["TASK-005", "TASK-006"]
}
```
