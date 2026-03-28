# Plan: browse final architecture closeout

> Generated: 2026-03-28
> Branch: refactor/final-architecture-closeout
> Mode: HOLD
> Review tool: claude

## Overview

Finish the last structural refactor before roadmap `v1.5-v2.2` implementation starts. The goal is not another round of file shuffling; it is to lock the execution model so browser automation, future app automation (`v2.0`), workflow commands (`v2.1`), and plugin/SDK registration (`v2.2`) all fit without another architecture rewrite.

## Scope Challenge

The repo is already partially refactored into domain directories. The remaining risk is not folder layout; it is ownership drift:

- sessions still construct browser targets directly
- command metadata is centralized but execution is still transport-owned
- CLI help and MCP tool exposure still drift away from the registry
- plans and docs still reference deleted paths

This plan uses `HOLD` mode: keep the current directory strategy, finish the missing execution seams, and explicitly freeze the canonical source tree. Do not start roadmap feature work until every task here is complete.

## Architecture Decision

- Keep the current domain tree: `automation/`, `browser/`, `commands/`, `engine/`, `export/`, `mcp/`, `network/`, `security/`, `session/`.
- Keep `src/cli.ts` and `src/server.ts` as stable package/dev entrypoints. They are public launch surfaces by design, not architecture failures.
- Do not rename `src/browser/` to `src/targets/browser/`. Add future `src/app/` as a sibling target implementation under the same `AutomationTarget` contract.
- Add `SessionTargetFactory` so `SessionManager` no longer constructs `BrowserManager` directly.
- Replace metadata-only `CommandSpec` registration with executable `CommandDefinition` registration so the registry owns both metadata and dispatch.
- Make `executeCommand()` resolve command definitions itself. HTTP, MCP, future `flow` / `retry` / `watch`, and future plugins must all call the same executor.
- Make registry metadata the only source for CLI help and MCP tool definitions.
- Make MCP arg decoding data-driven from command definitions, not from a transport-local switch.
- Make `src/mcp/index.ts` the canonical MCP public module; `src/mcp/server.ts` remains the implementation file behind it.

## Canonical Structure

```text
src/
├── automation/                # execution contracts, registry, executor
├── browser/                   # browser target implementation
├── commands/                  # command implementations + registration
├── engine/                    # browser engine / provider resolution
├── export/
├── mcp/                       # MCP transport
├── network/
├── security/
├── session/                   # session orchestration + target factory
├── cli.ts                     # stable external CLI entrypoint
├── server.ts                  # stable external HTTP server entrypoint
├── config.ts
├── constants.ts
├── types.ts
└── *.d.ts
```

## Prerequisites

- `npm run build` and `npm test` are green before this refactor starts.
- No roadmap feature work lands on top of the pre-closeout structure.
- `src/cli.ts` and `src/server.ts` remain the package/dev entrypoints during this refactor.
- Browser behavior, session persistence, and MCP wire format must remain backward-compatible.

## Non-Goals

- Do not implement `AppManager`, `flow`, `retry`, `watch`, plugin loading, or SDK packaging in this refactor.
- Do not add new user-facing commands.
- Do not rename major domain directories again after this plan starts.
- Do not move `src/install-skill.ts`; it is intentionally CLI tooling.
- Do not broaden this into a product rewrite or behavior redesign.

## Contracts

- `SessionManager` depends on a `SessionTargetFactory`, not on `BrowserManager`.
- `CommandRegistry` stores `CommandDefinition`, not metadata-only specs.
- `CommandDefinition` is the durable shape for built-in commands now and plugin commands later.
- `CommandDefinition` owns optional MCP schema plus MCP arg-decoding so tool exposure and tool-call decoding come from the same source.
- `executeCommand()` is the only command execution pipeline. Transports may format responses, but they do not dispatch categories.
- `CommandSpec.mcp` metadata drives tool-definition exposure; commands without `mcp` metadata are not exposed to MCP.
- CLI help output is generated from registry metadata, not from a second hand-maintained command inventory.
- `src/mcp/index.ts` is the only public MCP import path inside the repo.
- Root launchers (`src/cli.ts`, `src/server.ts`) may stay at root, but they must stay thin and metadata-free.

## No-Wiggle Execution Rules

- A task is incomplete until code changes, named tests, and the listed validate command all pass together.
- “No behavior change” is not valid proof by itself; each claim must cite a concrete automated test or grep/guard command.
- If a task removes a duplicate source of truth, the duplicate must be deleted or reduced to a non-canonical adapter in the same task.
- Any task that claims plugin-readiness must prove registration and discovery are data-driven, not transport-local.
- Any task that claims app-readiness must prove `SessionManager` and transports no longer construct or require `BrowserManager` directly.
- Every user-visible surface must have an anti-drift check: CLI help, MCP tool list, legacy-path references, and transport coupling.
- If a task requires a test file for proof, that test file must appear in `Files` and in the task write scope.

## Cut Line

Safe stop after `TASK-011`: the execution model, registry ownership, session factory, transport boundaries, and code-surface anti-drift enforcement are all stable through roadmap `v2.2`. The remaining tasks are roadmap/doc synchronization.

## Tasks

### TASK-001: Introduce SessionTargetFactory and remove browser construction from SessionManager

Replace direct `BrowserManager` construction with a factory-owned target creation seam. This is the structural prerequisite for `v2.0` app automation.

**Files:** `src/session/manager.ts`, `src/session/target-factory.ts` (new), `src/session/index.ts`, `src/browser/index.ts`, `test/sessions.test.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Validate:** `npm test -- test/sessions.test.ts`

**Acceptance Criteria:**
- [ ] `src/session/manager.ts` no longer calls `new BrowserManager(...)`.
- [ ] `src/session/manager.ts` no longer stores a private `browserManagers` map; target creation and any target-specific lookup move behind the factory.
- [ ] The default factory path still creates browser-backed sessions with the current `reuseContext`, domain-filter, persistence, and output-dir behavior.
- [ ] Edge case: named session restore and idle-session close still work when sessions are created through the factory.

**Required Evidence:**
- [ ] `rg -n "new BrowserManager|browserManagers" src/session/manager.ts` returns zero matches.
- [ ] `test/sessions.test.ts` covers browser session creation, named-session restore, session listing, and idle-session close through the factory path.
- [ ] `npm test -- test/sessions.test.ts` passes.

### TASK-002: Upgrade CommandRegistry to executable CommandDefinition registration

Make the registry own both metadata and execution. This is the seam that must last through built-in commands, workflow commands, and plugins.

**Files:** `src/automation/command.ts`, `src/automation/registry.ts`, `src/automation/executor.ts`, `src/automation/index.ts`, `test/features.test.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] `src/automation/command.ts` defines `CommandDefinition` with `spec`, `execute`, optional target-support narrowing, and optional MCP arg-decoding metadata for tool-call translation.
- [ ] `src/automation/registry.ts` can register and retrieve command definitions instead of metadata-only command specs.
- [ ] `src/automation/executor.ts` supports definition-backed execution for migrated commands and a clearly temporary adapter path for not-yet-migrated commands.
- [ ] Edge case: duplicate command registration and unsupported-capability execution fail with deterministic errors from the registry/executor path.

**Required Evidence:**
- [ ] `test/features.test.ts` covers duplicate registration failure, unsupported-capability failure, and one definition-backed command executing through `executeCommand()`.
- [ ] `test/features.test.ts` proves MCP arg-decoding metadata is part of the command-definition shape for at least one registered command.
- [ ] `npm test -- test/features.test.ts` passes.

### TASK-003: Register all read commands as CommandDefinition entries

Move read-command ownership into the command layer so the registry, not the transports, is the authoritative inventory.

**Files:** `src/commands/read.ts`, `src/automation/registry.ts`, `test/commands.test.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002  
**Validate:** `npm test -- test/commands.test.ts`

**Acceptance Criteria:**
- [ ] `src/commands/read.ts` exports the registered read command definitions and their execution paths.
- [ ] Every existing read command name in the registry is registered from `src/commands/read.ts`, not hand-entered separately in the registry file.
- [ ] Read command metadata for `safeToRetry`, `skipRecording`, and `pageContent` stays attached to the registered definition.
- [ ] Edge case: read commands that use buffers (`console`, `network`, `errors`) still work through the definition path.

**Required Evidence:**
- [ ] `test/commands.test.ts` executes representative read commands (`text`, `html`, `console`, `network`) through the registry/executor path.
- [ ] `test/features.test.ts` verifies every registered read command definition carries the expected category and metadata flags.
- [ ] `npm test -- test/commands.test.ts` passes.

### TASK-004: Register all write commands as CommandDefinition entries

Move write-command ownership into the command layer so write semantics are defined once and reused across HTTP, MCP, and future workflows.

**Files:** `src/commands/write.ts`, `src/automation/registry.ts`, `test/commands.test.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002  
**Validate:** `npm test -- test/commands.test.ts`

**Acceptance Criteria:**
- [ ] `src/commands/write.ts` exports the registered write command definitions and their execution paths.
- [ ] Every existing write command name in the registry is registered from `src/commands/write.ts`, not hand-entered separately in the registry file.
- [ ] Write command metadata for context, recording, and retry safety stays attached to the registered definition.
- [ ] Edge case: `wait`, `set`, and route/header/user-agent commands preserve their current argument behavior through the definition path.

**Required Evidence:**
- [ ] `test/commands.test.ts` executes representative write commands (`goto`, `click`, `wait`, `set`) through the registry/executor path.
- [ ] `test/features.test.ts` verifies `skipContext` / `skipRecording` flags for representative write commands on the registered definitions.
- [ ] `npm test -- test/commands.test.ts` passes.

### TASK-005: Register all meta commands as CommandDefinition entries

Move meta-command ownership into the command layer so the registry, not server/MCP glue, is the only command inventory.

**Files:** `src/commands/meta/index.ts`, `src/automation/registry.ts`, `test/commands.test.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002  
**Validate:** `npm test -- test/commands.test.ts`

**Acceptance Criteria:**
- [ ] `src/commands/meta/index.ts` exports the registered meta command definitions and their execution paths.
- [ ] Every existing meta command name in the registry is registered from `src/commands/meta/index.ts`, not hand-entered separately in the registry file.
- [ ] Meta commands retain their current `skipRecording`, `safeToRetry`, and `pageContent` metadata on the registered definitions.
- [ ] Edge case: `snapshot`, `status`, `record`, and `session-close` preserve current behavior through the definition path.

**Required Evidence:**
- [ ] `test/commands.test.ts` executes representative meta commands (`tabs`, `snapshot`, `status`, `record`) through the registry/executor path.
- [ ] `test/features.test.ts` verifies meta command registration count and representative metadata flags.
- [ ] `npm test -- test/commands.test.ts` passes.

### TASK-006: Cut HTTP transport over to executor and BrowserTarget boundary

Make the HTTP server a thin transport. It may enforce policy and response formatting, but it must not own command-category dispatch or concrete browser casts.

**Files:** `src/server.ts`, `src/browser/target.ts`, `test/session-e2e.test.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001, TASK-002, TASK-003, TASK-004, TASK-005  
**Validate:** `npm test -- test/session-e2e.test.ts`

**Acceptance Criteria:**
- [ ] `src/server.ts` no longer imports `BrowserManager`.
- [ ] `src/server.ts` no longer defines or uses `sessionBm()`.
- [ ] `src/server.ts` performs one registry/executor call per command and does not pass a transport-owned read/write/meta dispatch callback.
- [ ] Edge case: policy denial, unknown command handling, `set context`, output truncation, and content-boundary wrapping preserve current HTTP behavior.

**Required Evidence:**
- [ ] `rg -n "BrowserManager|sessionBm\\(|handleReadCommand|handleWriteCommand|handleMetaCommand|cmdSpec\\.category|READ_COMMANDS|WRITE_COMMANDS|META_COMMANDS" src/server.ts` returns zero matches.
- [ ] `test/session-e2e.test.ts` covers one read, one write, and one meta command through the HTTP transport plus one failure-path assertion.
- [ ] `npm test -- test/session-e2e.test.ts` passes.

### TASK-007: Cut MCP transport over to executor and make `src/mcp/index.ts` the canonical public module

Make MCP a thin transport and remove ambiguity about the public module surface.

**Files:** `src/mcp/index.ts`, `src/mcp/server.ts`, `src/cli.ts`, `test/mcp.test.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002, TASK-003, TASK-004, TASK-005  
**Validate:** `npm test -- test/mcp.test.ts`

**Acceptance Criteria:**
- [ ] `src/mcp/index.ts` exports `startMcpServer`, `getToolDefinitions`, and `mapToolCallToCommand`.
- [ ] `src/cli.ts` lazy-imports `./mcp` instead of `./mcp/server`.
- [ ] `src/mcp/server.ts` performs one registry/executor call per command and does not pass a transport-owned read/write/meta dispatch callback.
- [ ] Edge case: snapshot resource output, MCP JSON wrapping, and `set context` behavior remain unchanged.

**Required Evidence:**
- [ ] `rg -n "handleReadCommand|handleWriteCommand|handleMetaCommand|cmdSpec\\.category" src/mcp/server.ts` returns zero matches.
- [ ] `rg -n "import\\('./mcp/server'\\)" src/cli.ts` returns zero matches.
- [ ] `test/mcp.test.ts` covers snapshot resources, JSON-wrapped output, and `set context` persistence through the MCP transport.

### TASK-008: Generate CLI help from registry metadata

Remove the hand-maintained CLI command inventory and derive help from the registered command definitions.

**Files:** `src/automation/registry.ts`, `src/cli.ts`, `test/features.test.ts`

**Type:** hardening  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-003, TASK-004, TASK-005  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] The registry exposes a deterministic CLI help renderer grouped by command category.
- [ ] `src/cli.ts` prints registry-generated help and does not embed a hand-maintained full command inventory.
- [ ] Commands missing description or usage metadata fail tests instead of silently disappearing from help output.
- [ ] Edge case: aliases or non-MCP commands appear correctly in CLI help without requiring extra hand edits.

**Required Evidence:**
- [ ] `rg -n "console\\.log\\(`browse — Fast headless browser" src/cli.ts` returns zero matches.
- [ ] `test/features.test.ts` compares actual CLI help output against the registry-generated help text.
- [ ] `test/features.test.ts` fails if any registered command is missing description/usage metadata required for help rendering.

### TASK-009: Generate MCP tool definitions from registry metadata

Remove the second hand-maintained MCP schema inventory and derive tool definitions from registered command metadata.

**Files:** `src/automation/command.ts`, `src/automation/registry.ts`, `src/mcp/tools/index.ts`, `test/mcp.test.ts`

**Type:** hardening  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-003, TASK-004, TASK-005  
**Validate:** `npm test -- test/mcp.test.ts`

**Acceptance Criteria:**
- [ ] MCP-exposed command definitions carry `spec.mcp` metadata and command-owned MCP arg-decoding in the registry.
- [ ] `getToolDefinitions()` derives the MCP tool list from registry metadata, not from separate static arrays.
- [ ] `mapToolCallToCommand()` derives command/arg decoding from registered command definitions, not from a hard-coded command switch.
- [ ] Edge case: MCP tool ordering and names remain stable for existing commands after the source of truth change.

**Required Evidence:**
- [ ] `rg -n "READ_TOOL_DEFINITIONS|WRITE_TOOL_DEFINITIONS|META_TOOL_DEFINITIONS|switch \\(rawCommand\\)|case 'text'|case 'goto'|case 'snapshot'" src/mcp/tools/index.ts` returns zero matches.
- [ ] `test/mcp.test.ts` verifies every exposed tool comes from a registered command definition with MCP metadata and that tool-call decoding is definition-driven.
- [ ] `npm test -- test/mcp.test.ts` passes.

### TASK-010: Remove dead static MCP schema files

Delete the old category-based MCP schema modules once tool-definition ownership moves to the registry.

**Files:** `src/mcp/tools/read.ts`, `src/mcp/tools/write.ts`, `src/mcp/tools/meta.ts`

**Type:** cleanup  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-009  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `src/mcp/tools/read.ts`, `src/mcp/tools/write.ts`, and `src/mcp/tools/meta.ts` are deleted from the tree.
- [ ] No source file imports the deleted static MCP schema modules.
- [ ] Edge case: the build still passes after the deletions with no fallback import path.

**Required Evidence:**
- [ ] `rg -n "mcp/tools/(read|write|meta)" src test` returns zero matches after deletion.
- [ ] `find src/mcp/tools -maxdepth 1 -type f | sort` shows only canonical files after cleanup.
- [ ] `npm run build` passes.

### TASK-011: Add code-surface architecture anti-drift guards and tests

Add explicit checks so the repo fails fast if someone reintroduces concrete browser coupling or duplicate code-surface metadata inventories.

**Files:** `scripts/check-architecture-drift.mjs` (new), `test/architecture.test.ts`, `test/mcp.test.ts`

**Type:** hardening  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-006, TASK-007, TASK-008, TASK-009, TASK-010  
**Validate:** `node scripts/check-architecture-drift.mjs --scope code && npm test -- test/architecture.test.ts test/mcp.test.ts`

**Acceptance Criteria:**
- [ ] The guard script supports explicit scopes so code checks can run before roadmap/doc cleanup.
- [ ] The `code` scope fails if `src/server.ts` imports `BrowserManager` or reintroduces transport-owned category dispatch.
- [ ] The `code` scope fails if `src/cli.ts` contains a hand-maintained full help block, if `src/mcp/index.ts` stops exporting `startMcpServer`, or if `src/mcp/tools/index.ts` reintroduces hard-coded MCP command switching.
- [ ] Edge case: the guard script exits non-zero on the first violation and prints the offending file/path.

**Required Evidence:**
- [ ] `node scripts/check-architecture-drift.mjs --scope code` exits 0 on the refactored branch.
- [ ] `test/architecture.test.ts` asserts the canonical architecture contracts that cannot be expressed as pure grep.
- [ ] `npm test -- test/architecture.test.ts test/mcp.test.ts` passes.

### TASK-012: Sync roadmap file paths to the canonical architecture

Rewrite the roadmap so every file reference matches the final architecture that will carry the product to `v2.2`.

**Files:** `plans/roadmap-v1.5-v2.2.md`, `plans/roadmap-v1.5-v2.2.json`

**Type:** docs  
**Effort:** M  
**Priority:** P1  
**Agent:** general-purpose  
**Review:** claude  
**Depends on:** TASK-001, TASK-006, TASK-007, TASK-008, TASK-009, TASK-010, TASK-011  
**Validate:** `node scripts/check-architecture-drift.mjs --scope roadmap`

**Acceptance Criteria:**
- [ ] No roadmap task references deleted legacy files such as `src/browser-manager.ts`, `src/command-registry.ts`, `src/mcp-tools.ts`, `src/commands/meta.ts`, `src/session-manager.ts`, or `src/record-export.ts`.
- [ ] Roadmap tasks point at the canonical source files that will actually own each upcoming feature.
- [ ] The markdown and JSON roadmap artifacts remain synchronized after the path rewrite.
- [ ] Edge case: create-then-modify files are represented consistently across markdown and JSON.

**Required Evidence:**
- [ ] `rg -n "src/(browser-manager|command-registry|mcp-tools|commands/meta\\.ts|session-manager|record-export)\\.ts" plans/roadmap-v1.5-v2.2.md plans/roadmap-v1.5-v2.2.json` returns zero matches.
- [ ] `node -e "JSON.parse(require('fs').readFileSync('plans/roadmap-v1.5-v2.2.json','utf8')); console.log('ok')"` prints `ok`.
- [ ] `node scripts/check-architecture-drift.mjs --scope roadmap` exits 0 after the roadmap rewrite.
- [ ] A markdown/JSON task-id parity check is added or run and passes for the roadmap pair.

### TASK-013: Sync refactor docs and contributor guidance to the canonical architecture

Update the remaining internal guidance so contributors extend the frozen architecture instead of reintroducing the old one.

**Files:** `.ulpi/plans/domain-architecture-refactor-hold.md`, `CLAUDE.md`, `CONTRIBUTING.md`

**Type:** docs  
**Effort:** M  
**Priority:** P2  
**Agent:** general-purpose  
**Review:** claude  
**Depends on:** TASK-011, TASK-012  
**Validate:** `node scripts/check-architecture-drift.mjs --scope docs`

**Acceptance Criteria:**
- [ ] Internal docs describe the final architecture as command-definition + target-factory + registry-owned public surfaces.
- [ ] Contributor guidance no longer tells developers to edit deleted files, local command sets, or hand-maintained help/tool inventories.
- [ ] The old refactor plan is marked closed with the final architecture outcome, not with stale migration language.
- [ ] Edge case: docs explicitly state that `src/cli.ts` and `src/server.ts` stay as stable root entrypoints by design.

**Required Evidence:**
- [ ] `rg -n "src/(command-registry|mcp-tools|browser-manager|record-export|commands/meta\\.ts|session-manager)\\.ts|READ_COMMANDS|WRITE_COMMANDS|META_COMMANDS" CLAUDE.md CONTRIBUTING.md .ulpi/plans/domain-architecture-refactor-hold.md` returns zero matches for deprecated guidance.
- [ ] `node scripts/check-architecture-drift.mjs --scope docs` exits 0 after the doc updates.
- [ ] Manual diff review confirms the docs state the same canonical architecture as this plan.

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-002"],
  "TASK-006": ["TASK-001", "TASK-002", "TASK-003", "TASK-004", "TASK-005"],
  "TASK-007": ["TASK-002", "TASK-003", "TASK-004", "TASK-005"],
  "TASK-008": ["TASK-003", "TASK-004", "TASK-005"],
  "TASK-009": ["TASK-003", "TASK-004", "TASK-005"],
  "TASK-010": ["TASK-009"],
  "TASK-011": ["TASK-006", "TASK-007", "TASK-008", "TASK-009", "TASK-010"],
  "TASK-012": ["TASK-001", "TASK-006", "TASK-007", "TASK-008", "TASK-009", "TASK-010", "TASK-011"],
  "TASK-013": ["TASK-011", "TASK-012"]
}
```
