# Plan: browse domain architecture refactor

> Generated: 2026-03-28
> Branch: refactor/domain-architecture
> Mode: HOLD
> Review tool: claude

## Overview

Restructure `browse` around execution contracts and domain directories before roadmap `v1.5-v2.2` lands. This plan keeps product behavior stable while replacing browser-centric wiring with reusable abstractions for future browser, app, workflow, and plugin work.

## Scope Challenge

This is a structural refactor, not product expansion. `HOLD` mode is the correct shape because most product behavior already exists; the work is mainly architecture, command plumbing, and file layout. The plan establishes a safe cut line after shared contracts and executor wiring so the branch can stop before large file moves if needed.

## Architecture Decision

- Add `src/automation/` for durable execution contracts instead of placing core architecture in `src/shared/`.
- Use `src/engine/` instead of `src/runtime/` to avoid a naming collision with future browser-vs-app runtime concepts.
- Make `CommandSpec` the single source of truth for command category, availability, context, recording, CLI help, and MCP schema.
- Retarget command handlers to `AutomationTarget` plus explicit capability interfaces before server and MCP wiring is declared complete.
- Make `executeCommand()` the single execution pipeline for HTTP, MCP, and later `flow` / `retry` / `watch`.
- Keep root-level compatibility shims temporarily while internal imports migrate to domain entrypoints.

## Target Structure

```text
src/
├── automation/
│   ├── target.ts
│   ├── command.ts
│   ├── events.ts
│   ├── executor.ts
│   └── index.ts
├── browser/
│   ├── index.ts
│   ├── manager.ts
│   ├── tabs.ts
│   ├── refs.ts
│   ├── events.ts
│   ├── emulation.ts
│   ├── profiles.ts
│   ├── snapshot.ts
│   └── react-devtools.ts
├── network/
│   ├── index.ts
│   ├── buffers.ts
│   └── har.ts
├── session/
│   ├── index.ts
│   ├── manager.ts
│   ├── persist.ts
│   └── encryption.ts
├── security/
│   ├── index.ts
│   ├── domain-filter.ts
│   ├── policy.ts
│   ├── auth-vault.ts
│   └── sanitize.ts
├── engine/
│   ├── index.ts
│   ├── chrome.ts
│   └── providers.ts
├── export/
│   ├── index.ts
│   ├── record.ts
│   ├── replay.ts
│   └── browse.ts
├── commands/
│   ├── read.ts
│   ├── write.ts
│   └── meta/
│       ├── index.ts
│       ├── tabs.ts
│       ├── screenshots.ts
│       ├── recording.ts
│       ├── sessions.ts
│       ├── inspection.ts
│       ├── auth.ts
│       ├── system.ts
│       └── profile.ts
└── mcp/
    ├── index.ts
    └── tools/
        ├── index.ts
        ├── read.ts
        ├── write.ts
        └── meta.ts
```

## Prerequisites

- Current main-branch build and tests are green before the refactor starts.
- `codemap` index is healthy and available for dependency and cycle checks.
- Published package surface remains the current CLI during the shim phase.
- No roadmap feature work lands on top of the old structure while this branch is open.

## Non-Goals

- Do not implement `AppManager`, `flow` / `retry` / `watch`, plugins, or SDK behavior in this refactor.
- Do not add new end-user commands or intentionally change command semantics.
- Do not change persistence paths, profile paths, auth vault storage, or wire protocol formats.
- Do not remove backward-compatibility shims until direct imports and guards are already in place.

## Contracts

- `BrowserManager` becomes one implementation of `AutomationTarget`; future `AppManager` must fit the same contract instead of branching callers.
- `Session` stores target-oriented state, not a `BrowserManager` concrete type.
- `CommandSpec` / registry is the only authority for command identity, category, MCP exposure, and future plugin registration.
- Generic command handlers do not import `BrowserManager` directly; browser-only behavior is isolated behind explicit capability interfaces.
- `executeCommand()` owns lifecycle hooks, action context, recording hooks, policy gates, and common error shaping.
- Compatibility shims are pass-through exports only; no new business logic may be added to legacy root files.
- Internal source imports must migrate to domain entrypoints before shim deletion.

## No-Wiggle Execution Rules

- A task is not complete until code changes, listed required evidence, and the `Validate` command all land together.
- “No behavior change” is not acceptable by inspection alone; each such claim must be backed by a named automated test or a guard script in the same task.
- Structural move tasks must prove both sides: the new domain file owns the behavior and the legacy root file is export-only.
- Registry-owned surfaces must be parity-tested across server routing, MCP exposure, and CLI help output.
- Every acceptance criterion must map to at least one `Required Evidence` item in the same task; if the mapping is unclear, the task is incomplete.
- Phrases such as “add or update”, “or equivalent”, “etc.”, or “works as before” are not acceptable proof language; each evidence item must name the exact test file, guard, or command output.
- Migration tasks must prove zero deprecated imports with a named `rg` command or a checked-in guard script, not by manual review.
- Doc and roadmap tasks are incomplete unless paired markdown/JSON artifacts remain synchronized and machine-parseable.

## Cut Line

Safe stop after the foundation tranche (`TASK-001`, `TASK-002`, `TASK-003`, `TASK-004`, `TASK-021`, `TASK-005`, `TASK-006`): the repo keeps the old file layout, but the architecture is already future-proofed around `AutomationTarget`, target-neutral handler signatures, `CommandSpec`, and `executeCommand()`. The remaining tasks are then mechanical domain extraction, shims, and cleanup.

## Tasks

### TASK-001: Create automation target and lifecycle contracts

Add `src/automation/` contracts for target-neutral automation and action lifecycle hooks. This creates the architectural seam that later browser/app runtimes and flow execution will share.

**Files:** `src/automation/target.ts` (new), `src/automation/events.ts` (new), `src/automation/index.ts` (new)

**Type:** foundation  
**Effort:** S  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `src/automation/target.ts` defines a browser-neutral `AutomationTarget` surface and typed unsupported-capability result path.
- [ ] `src/automation/events.ts` defines before/after lifecycle hook contracts without importing server-specific code.
- [ ] Edge case: automation contracts do not import `BrowserManager`, `SessionManager`, or raw Playwright `Page` / `Locator` types as public API.

**Required Evidence:**
- [ ] `rg -n "BrowserManager|SessionManager|Page|Locator" src/automation` shows no forbidden runtime imports in public automation contracts.
- [ ] `npm run build` passes with no new `as any` or `unknown as` casts inside `src/automation/`.

### TASK-002: Replace static command sets with typed command specs

Introduce `CommandSpec` and rebuild `command-registry.ts` around typed registration instead of hard-coded category sets. The registry must be capable of serving server routing, MCP exposure, CLI help, and later plugin registration.

**Files:** `src/automation/command.ts` (new), `src/command-registry.ts`, `src/cli.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `src/automation/command.ts` defines `CommandSpec` with metadata for category, availability, context behavior, recording behavior, help text, and MCP schema.
- [ ] `src/command-registry.ts` exposes lookup-by-name and derives category sets from specs instead of hand-maintained duplicated sets.
- [ ] CLI help output is generated from or validated against registry-backed help metadata instead of a separate hand-maintained command inventory.
- [ ] Edge case: duplicate command registration or alias collision fails deterministically during startup/tests.

**Required Evidence:**
- [ ] `test/features.test.ts` fails on duplicate command registration or alias collision.
- [ ] `test/features.test.ts` asserts every registered command spec includes category, help, and MCP metadata.
- [ ] `test/features.test.ts` snapshots or string-matches the registry-backed CLI help output so help drift cannot pass silently.

### TASK-003: Create shared command executor pipeline

Add `executeCommand()` as the single execution path for server, MCP, and future flow execution. It should centralize lifecycle hooks, action context, recording hooks, and common error shaping.

**Files:** `src/automation/executor.ts` (new), `src/action-context.ts`, `src/types.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001, TASK-002  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] `src/automation/executor.ts` executes commands from `CommandSpec` and applies lifecycle hooks and action context in one place.
- [ ] Read/write/meta execution differences are driven by spec metadata rather than separate ad-hoc branching pipelines.
- [ ] Edge case: commands marked `skipContext` or `skipRecording` preserve current behavior when run through `executeCommand()`.

**Required Evidence:**
- [ ] `test/features.test.ts` covers before/after lifecycle ordering for one read, one write, and one meta command path.
- [ ] `test/features.test.ts` proves `skipContext` and `skipRecording` commands do not accidentally trigger those paths.
- [ ] `test/features.test.ts` asserts the exact response text for one representative command executed through `executeCommand()`.

### TASK-004: Adapt sessions and BrowserManager to AutomationTarget

Make sessions store target-oriented state and have `BrowserManager` implement the new `AutomationTarget` contract without changing browser behavior.

**Files:** `src/session-manager.ts`, `src/browser-manager.ts`, `src/types.ts`

**Type:** foundation  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001  
**Validate:** `npm test -- test/sessions.test.ts`

**Acceptance Criteria:**
- [ ] Session state no longer exposes `BrowserManager` as the primary cross-module contract; it stores target-oriented state instead.
- [ ] `BrowserManager` satisfies `AutomationTarget` while preserving the existing browser command behavior and public methods needed during migration.
- [ ] `src/automation/target.ts` exposes narrower browser capability interfaces so browser-only commands have an explicit typed boundary after handler retargeting.
- [ ] Edge case: session listing and current URL/tab-count logic continue to work without unsafe casting inside `session-manager.ts`.

**Required Evidence:**
- [ ] `test/sessions.test.ts` covers session creation, session listing, current URL, and tab count after the type migration.
- [ ] `npm run build` passes with `BrowserManager` assigned to `AutomationTarget` in typed code and no adapter casts introduced for that assignment.
- [ ] `rg -n "manager: BrowserManager|: BrowserManager" src/session-manager.ts src/types.ts` shows the generic session contract is no longer browser-concrete.

### TASK-021: Retarget command handlers to AutomationTarget and explicit capability interfaces

Change the read, write, and meta handler signatures so they no longer use `BrowserManager` as the generic contract. Target-neutral commands should consume `AutomationTarget` or a typed execution context; browser-only behavior should be isolated behind explicit browser capability interfaces.

**Files:** `src/commands/read.ts`, `src/commands/write.ts`, `src/commands/meta.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-001, TASK-004  
**Validate:** `npm test -- test/commands.test.ts`

**Acceptance Criteria:**
- [ ] `handleReadCommand`, `handleWriteCommand`, and `handleMetaCommand` no longer import `BrowserManager` as their generic handler type.
- [ ] Target-neutral commands run through `AutomationTarget` or typed execution context contracts; browser-only behavior is isolated behind explicit capability boundaries.
- [ ] Edge case: browser-only commands fail with clear unsupported-capability errors instead of type-casting or branching on concrete manager type.

**Required Evidence:**
- [ ] `rg -n "import type \\{ BrowserManager \\}" src/commands/read.ts src/commands/write.ts src/commands/meta.ts` returns no handler-level generic imports.
- [ ] `test/commands.test.ts` covers one target-neutral command in each handler and one unsupported browser-only command failure path.
- [ ] `rg -n "instanceof BrowserManager|as BrowserManager" src/commands/read.ts src/commands/write.ts src/commands/meta.ts` returns zero matches.

### TASK-005: Wire HTTP server through registry and executor

Remove local command-set duplication from `server.ts` and route all HTTP command execution through `CommandSpec` lookup plus `executeCommand()`.

**Files:** `src/server.ts`, `src/command-registry.ts`, `src/automation/executor.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002, TASK-003, TASK-004, TASK-021  
**Validate:** `npm test -- test/session-e2e.test.ts`

**Acceptance Criteria:**
- [ ] `server.ts` no longer maintains independent `READ` / `WRITE` / `META` routing tables; it uses `command-registry.ts` lookup instead.
- [ ] HTTP command execution flows through `executeCommand()` for read, write, and meta commands.
- [ ] Edge case: unknown commands, policy failures, and action-context output preserve current HTTP status-code and hint behavior.

**Required Evidence:**
- [ ] `test/session-e2e.test.ts` covers one read, one write, and one meta command executing through the shared server pipeline.
- [ ] `test/session-e2e.test.ts` covers unknown-command and policy-denial behavior through the HTTP surface.
- [ ] `test/session-e2e.test.ts` asserts write-command context output is appended exactly once after the executor migration.

### TASK-006: Wire MCP through registry and executor

Replace MCP-specific dispatch branching with shared command lookup and shared execution. Tool definitions and tool-call mapping must derive from the same command spec surface.

**Files:** `src/mcp.ts`, `src/mcp-tools.ts`, `src/command-registry.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P0  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-002, TASK-003, TASK-004, TASK-021  
**Validate:** `npm test -- test/mcp.test.ts`

**Acceptance Criteria:**
- [ ] `mcp.ts` uses shared command lookup plus `executeCommand()` instead of bespoke read/write/meta branching.
- [ ] MCP list-tools and tool-call mapping derive from the same command spec metadata as server routing.
- [ ] Snapshot resource responses, JSON wrapping, and `set context` behavior continue to work when MCP runs through shared execution.
- [ ] Edge case: a command not registered in the registry cannot be exposed silently through MCP.

**Required Evidence:**
- [ ] `test/mcp.test.ts` proves list-tools output is registry-backed and matches command metadata.
- [ ] `test/mcp.test.ts` covers snapshot resource output, JSON wrapping, and `set context` behavior after the executor migration.
- [ ] `test/mcp.test.ts` proves unregistered and malformed tool calls fail without implicit fallback.

### TASK-007: Create browser domain entrypoint and legacy BrowserManager shim

Move the `BrowserManager` implementation entry into `src/browser/` while preserving `src/browser-manager.ts` as a temporary re-export shim.

**Files:** `src/browser/manager.ts` (new), `src/browser/index.ts` (new), `src/browser-manager.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-004  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `src/browser/manager.ts` becomes the real `BrowserManager` implementation entrypoint and `src/browser/index.ts` re-exports browser-domain public APIs.
- [ ] `src/browser-manager.ts` is reduced to a compatibility shim with no business logic.
- [ ] Edge case: existing root imports continue to build and test through the shim during the migration phase.

**Required Evidence:**
- [ ] `test/features.test.ts` contains a shim-purity assertion proving `src/browser-manager.ts` contains exports only and no executable business logic.
- [ ] `npm run build` passes with both root-shim and new domain entrypoint imports.

### TASK-008: Extract browser tab and ref collaborators

Carve tab management and `@ref` state out of `BrowserManager` into focused browser-domain collaborators while preserving the `BrowserManager` public API.

**Files:** `src/browser/tabs.ts` (new), `src/browser/refs.ts` (new), `src/browser/manager.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-007  
**Validate:** `npm test -- test/snapshot.test.ts`

**Acceptance Criteria:**
- [ ] Tab and ref logic move into `src/browser/tabs.ts` and `src/browser/refs.ts` with `BrowserManager` delegating to them.
- [ ] Public methods such as `newTab()`, `switchTab()`, `resolveRef()`, and snapshot-baseline access remain stable for callers.
- [ ] Edge case: refs remain tab-scoped and invalidate correctly across navigation and tab switches.

**Required Evidence:**
- [ ] `test/snapshot.test.ts` covers ref invalidation across navigation and tab switches after extraction.
- [ ] `test/commands.test.ts` proves tab commands still work through the delegated `BrowserManager` API.

### TASK-009: Extract browser event, emulation, and profile collaborators

Move network/dialog event wiring, device emulation, and profile lifecycle logic into dedicated browser-domain modules while keeping `BrowserManager` as the compatibility facade.

**Files:** `src/browser/events.ts` (new), `src/browser/emulation.ts` (new), `src/browser/profiles.ts` (new), `src/browser/manager.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-007  
**Validate:** `npm test -- test/interactions.test.ts`

**Acceptance Criteria:**
- [ ] `src/browser/events.ts`, `src/browser/emulation.ts`, and `src/browser/profiles.ts` own their current responsibilities with `BrowserManager` delegating.
- [ ] Device emulation and profile management preserve current `BrowserManager` API and behavior.
- [ ] Edge case: context recreation after emulation still preserves init scripts, headers, routes, offline state, and other browser session settings.

**Required Evidence:**
- [ ] `test/interactions.test.ts` covers device emulation with preserved init scripts, headers, routes, and offline state.
- [ ] `test/features.test.ts` covers profile list/delete/persistent launch behavior after extraction.

### TASK-010: Move snapshot logic into browser domain with shim

Relocate `snapshot.ts` into `src/browser/snapshot.ts` and keep `src/snapshot.ts` as a pure compatibility shim until direct imports are migrated.

**Files:** `src/browser/snapshot.ts` (new), `src/snapshot.ts`, `src/browser/index.ts`

**Type:** refactor  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-007, TASK-008  
**Validate:** `npm test -- test/snapshot.test.ts`

**Acceptance Criteria:**
- [ ] Snapshot implementation lives under `src/browser/snapshot.ts` and `src/browser/index.ts` exports it.
- [ ] `src/snapshot.ts` becomes a pass-through shim with no embedded snapshot logic.
- [ ] Edge case: `snapshot -i` ref assignment and tab-local snapshot baseline behavior remain unchanged.

**Required Evidence:**
- [ ] `test/snapshot.test.ts` continues to cover `snapshot -i` ref assignment and tab-local snapshot baselines after the move.
- [ ] `test/snapshot.test.ts` contains a shim-purity assertion proving `src/snapshot.ts` is export-only.

### TASK-011: Move React DevTools integration into browser domain with shim

Relocate `react-devtools.ts` into `src/browser/react-devtools.ts` and keep the root file as a compatibility shim during migration.

**Files:** `src/browser/react-devtools.ts` (new), `src/react-devtools.ts`, `src/browser/index.ts`

**Type:** refactor  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-007  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] React DevTools implementation lives under `src/browser/react-devtools.ts` and `src/browser/index.ts` exports it.
- [ ] `src/react-devtools.ts` becomes a pass-through shim with no embedded business logic.
- [ ] Edge case: lazy import paths and the disabled React DevTools path still work when the feature is unused.

**Required Evidence:**
- [ ] `test/features.test.ts` covers the disabled/lazy React DevTools path after the move.
- [ ] `test/features.test.ts` contains a shim-purity assertion proving `src/react-devtools.ts` is export-only.

### TASK-012: Move network module into `src/network` with compatibility shims

Move buffer and HAR logic into `src/network/` while preserving `src/buffers.ts` and `src/har.ts` as temporary re-export shims.

**Files:** `src/network/index.ts` (new), `src/network/buffers.ts` (new), `src/network/har.ts` (new), `src/buffers.ts`, `src/har.ts`

**Type:** refactor  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** None  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] `src/network/buffers.ts` and `src/network/har.ts` become the canonical implementations with `src/network/index.ts` as the domain entrypoint.
- [ ] Root files `src/buffers.ts` and `src/har.ts` are reduced to compatibility shims only.
- [ ] Edge case: legacy global buffer exports and HAR formatting keep the same public surface until final shim removal.

**Required Evidence:**
- [ ] `test/features.test.ts` covers HAR formatting and buffer-backed behavior after the move.
- [ ] `test/features.test.ts` contains shim-purity assertions proving `src/buffers.ts` and `src/har.ts` are export-only shims during migration.

### TASK-013: Move session module into `src/session` with compatibility shims

Move `session-manager`, `session-persist`, and `encryption` logic into `src/session/` while keeping the current root import paths as temporary shims.

**Files:** `src/session/index.ts` (new), `src/session/manager.ts` (new), `src/session/persist.ts` (new), `src/session/encryption.ts` (new), `src/session-manager.ts`, `src/session-persist.ts`, `src/encryption.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-004  
**Validate:** `npm test -- test/sessions.test.ts`

**Acceptance Criteria:**
- [ ] `src/session/manager.ts`, `src/session/persist.ts`, and `src/session/encryption.ts` become the canonical implementations and `src/session/index.ts` re-exports them.
- [ ] Root files `src/session-manager.ts`, `src/session-persist.ts`, and `src/encryption.ts` become pass-through shims only.
- [ ] Edge case: named-session auto-save/restore still uses the same on-disk paths and encryption-key resolution.

**Required Evidence:**
- [ ] `test/sessions.test.ts` covers named-session save/restore after the move.
- [ ] `test/sessions.test.ts` contains shim-purity assertions proving `src/session-manager.ts`, `src/session-persist.ts`, and `src/encryption.ts` are export-only shims during migration.

### TASK-014: Move security module into `src/security` with compatibility shims

Move `domain-filter`, `policy`, `auth-vault`, and `sanitize` into `src/security/` while keeping the current root import paths as temporary shims.

**Files:** `src/security/index.ts` (new), `src/security/domain-filter.ts` (new), `src/security/policy.ts` (new), `src/security/auth-vault.ts` (new), `src/security/sanitize.ts` (new), `src/domain-filter.ts`, `src/policy.ts`, `src/auth-vault.ts`, `src/sanitize.ts`

**Type:** refactor  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** None  
**Validate:** `npm test -- test/features.test.ts`

**Acceptance Criteria:**
- [ ] `src/security/` becomes the canonical home for `domain-filter`, `policy`, `auth-vault`, and `sanitize` with `src/security/index.ts` as the domain entrypoint.
- [ ] Root files for those features become pass-through shims only.
- [ ] Edge case: auth vault and domain filter keep the same filesystem and project-root resolution behavior after the move.

**Required Evidence:**
- [ ] `test/features.test.ts` covers auth-vault behavior and domain-filter behavior after the move.
- [ ] `test/features.test.ts` contains shim-purity assertions proving the four root security files are export-only shims during migration.

### TASK-015: Move engine and export modules into domain directories with shims

Rename the current runtime area to `src/engine/` and split `record-export.ts` into `src/export/`. Preserve existing root import paths through temporary compatibility shims.

**Files:** `src/engine/index.ts` (new), `src/engine/chrome.ts` (new), `src/engine/providers.ts` (new), `src/export/index.ts` (new), `src/export/record.ts` (new), `src/export/replay.ts` (new), `src/export/browse.ts` (new), `src/runtime.ts`, `src/chrome-discover.ts`, `src/cloud-providers.ts`, `src/record-export.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** None  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `src/engine/` becomes the canonical home for `runtime.ts`, `chrome-discover.ts`, and `cloud-providers.ts` using engine-oriented naming rather than runtime-oriented naming.
- [ ] `src/export/` becomes the canonical home for record-export helpers and output formats, with `record-export.ts` reduced to a shim.
- [ ] Edge case: build output and current CLI surface remain unchanged while old root paths still exist as shims.

**Required Evidence:**
- [ ] `npm run build` passes with the new `src/engine/` and `src/export/` paths.
- [ ] `test/features.test.ts` covers record-export behavior after the move and contains a shim-purity assertion proving `src/record-export.ts` is export-only during migration.

### TASK-016: Split `commands/meta.ts` into domain handlers and dispatcher

Replace the 1400+ line `meta.ts` with a meta directory containing a thin dispatcher and focused handler modules. Keep the current root import path as a temporary shim.

**Files:** `src/commands/meta/index.ts` (new), `src/commands/meta/tabs.ts` (new), `src/commands/meta/screenshots.ts` (new), `src/commands/meta/recording.ts` (new), `src/commands/meta/sessions.ts` (new), `src/commands/meta/inspection.ts` (new), `src/commands/meta/auth.ts` (new), `src/commands/meta/system.ts` (new), `src/commands/meta/profile.ts` (new), `src/commands/meta.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-005, TASK-010, TASK-011, TASK-012, TASK-014, TASK-015  
**Validate:** `npm test -- test/commands.test.ts`

**Acceptance Criteria:**
- [ ] `commands/meta/index.ts` becomes the dispatcher and handler modules are split by domain concern instead of one giant switch.
- [ ] `commands/meta.ts` becomes a thin compatibility shim or re-export with no new business logic.
- [ ] Edge case: nested chain/meta execution and shared helpers continue to work without duplicating command tables or helper logic.

**Required Evidence:**
- [ ] `test/commands.test.ts` covers nested `chain` recursive meta execution after the split.
- [ ] `test/commands.test.ts` covers one command each from tabs, sessions, inspection, and system handler groups after the split.
- [ ] `test/commands.test.ts` contains a shim-purity assertion proving `src/commands/meta.ts` is export-only during migration.

### TASK-017: Split `mcp-tools.ts` into domain tool-definition modules

Replace the large `mcp-tools.ts` file with `src/mcp/tools/*` backed by the shared command registry. Keep the current root import path as a temporary shim.

**Files:** `src/mcp/index.ts` (new), `src/mcp/tools/index.ts` (new), `src/mcp/tools/read.ts` (new), `src/mcp/tools/write.ts` (new), `src/mcp/tools/meta.ts` (new), `src/mcp.ts`, `src/mcp-tools.ts`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-006  
**Validate:** `npm test -- test/mcp.test.ts`

**Acceptance Criteria:**
- [ ] `src/mcp/index.ts` and `src/mcp/tools/{index,read,write,meta}.ts` become the canonical MCP implementation files.
- [ ] `src/mcp-tools.ts` becomes a thin compatibility shim with no authoritative tool-definition table left behind.
- [ ] Edge case: tool names, schemas, and command mapping do not drift from the shared command registry.

**Required Evidence:**
- [ ] `test/mcp.test.ts` covers tool-name, schema, and command-mapping parity after the split.
- [ ] `test/mcp.test.ts` contains a shim-purity assertion proving `src/mcp-tools.ts` is export-only during migration.

### TASK-018: Add architecture regression and anti-drift tests

Add explicit tests for registry parity, executor behavior, shim purity, and migration drift. These tests enforce the architecture, not just product behavior.

**Files:** `test/architecture.test.ts` (new), `test/features.test.ts`, `test/mcp.test.ts`

**Type:** test  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-005, TASK-006, TASK-008, TASK-009, TASK-010, TASK-011, TASK-012, TASK-013, TASK-014, TASK-015, TASK-016, TASK-017  
**Validate:** `npm test`

**Acceptance Criteria:**
- [ ] Tests prove server, MCP, and CLI help derive from the same command registry and fail if any surface drifts.
- [ ] Tests prove generic command handlers do not reintroduce direct `BrowserManager` imports after `TASK-021`.
- [ ] Tests prove legacy root files remain shim-only during migration and fail if new business logic is reintroduced there.

**Required Evidence:**
- [ ] `test/architecture.test.ts` includes explicit parity assertions for registry vs server vs MCP vs CLI help.
- [ ] `test/architecture.test.ts` fails on direct `BrowserManager` imports from generic command handlers.
- [ ] `test/architecture.test.ts` fails when a temporary shim file contains non-export logic.

### TASK-019: Migrate source imports to domain entrypoints

Replace internal shim-path imports in `src/` with direct domain entrypoint or direct domain-file imports once the new structure is stable.

**Files:** `src/*`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-016, TASK-017, TASK-018  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] Source imports under `src/` point at domain entrypoints or direct domain files rather than legacy root shim paths.
- [ ] No new source imports reach temporary root shim files except documented compatibility boundaries.
- [ ] Edge case: build stays green before any shim file is deleted.

**Required Evidence:**
- [ ] `rg -n "from '../?(browser-manager|buffers|har|session-manager|session-persist|encryption|domain-filter|policy|auth-vault|sanitize|runtime|chrome-discover|cloud-providers|record-export|snapshot|react-devtools|mcp-tools)'" src` returns zero matches outside the explicit compatibility allowlist documented in `scripts/check-legacy-imports.mjs`.
- [ ] `npm run build` passes after source import migration.

### TASK-020: Migrate test imports to domain entrypoints

Replace legacy root shim imports in `test/` with domain entrypoint or direct domain-file imports so the test suite no longer normalizes temporary root paths.

**Files:** `test/*`

**Type:** refactor  
**Effort:** M  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-019  
**Validate:** `npm test`

**Acceptance Criteria:**
- [ ] Test files import domain entrypoints or direct domain files rather than legacy root shim paths.
- [ ] No test helper or fixture depends on temporary root shim imports after migration.
- [ ] Edge case: full test suite stays green before shim deletion.

**Required Evidence:**
- [ ] `rg -n "from '../?(browser-manager|buffers|har|session-manager|session-persist|encryption|domain-filter|policy|auth-vault|sanitize|runtime|chrome-discover|cloud-providers|record-export|snapshot|react-devtools|mcp-tools)'" test` returns zero matches.
- [ ] `npm test` passes after test import migration.

### TASK-022: Add legacy-import and cycle guards

Add repeatable guards that fail if deprecated root imports or circular dependencies reappear after the import migration.

**Files:** `scripts/check-legacy-imports.mjs` (new), `test/architecture.test.ts`

**Type:** test  
**Effort:** S  
**Priority:** P1  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-018, TASK-019, TASK-020  
**Validate:** `npm test`

**Acceptance Criteria:**
- [ ] A repeatable guard fails if deprecated root imports are reintroduced under `src/` or `test/`.
- [ ] Architecture tests fail if circular dependencies or root-shim logic leakage are reintroduced.
- [ ] Edge case: the guard supports only an explicit documented allowlist for external compatibility boundaries.

**Required Evidence:**
- [ ] `node scripts/check-legacy-imports.mjs` is wired into the task and fails on deprecated root imports.
- [ ] Architecture test or guard output demonstrates cycle detection or root-shim leakage detection is part of CI-visible validation.

### TASK-023: Remove compatibility shims after guarded migration

Delete temporary root re-export shims only after direct imports and anti-drift guards are already green.

**Files:** legacy root shim files in `src/`

**Type:** refactor  
**Effort:** M  
**Priority:** P2  
**Agent:** nodejs-cli-senior-engineer  
**Review:** claude  
**Depends on:** TASK-022  
**Validate:** `npm test`

**Acceptance Criteria:**
- [ ] Temporary root shim files are removed only after source and test import migration plus guard coverage are green.
- [ ] No remaining `src/` or `test/` imports reference deleted shim files.
- [ ] Edge case: build and test pass after shim removal.

**Required Evidence:**
- [ ] `rg -n "(browser-manager|buffers|har|session-manager|session-persist|encryption|domain-filter|policy|auth-vault|sanitize|runtime|chrome-discover|cloud-providers|record-export|snapshot|react-devtools|mcp-tools)" src test` shows no deleted shim import paths remain.
- [ ] `npm run build` and `npm test` both pass after shim removal.

### TASK-024: Update CLAUDE and developer architecture docs

Update contributor-facing docs to reflect the new domain structure, command registry flow, and executor pipeline.

**Files:** `CLAUDE.md`, `.claude/claude-md-refs/architecture.md`, `.claude/claude-md-refs/development-guide.md`

**Type:** docs  
**Effort:** S  
**Priority:** P2  
**Agent:** general-purpose  
**Review:** claude  
**Depends on:** TASK-023  
**Validate:** `npm run build`

**Acceptance Criteria:**
- [ ] `CLAUDE.md`, architecture docs, and the development guide reflect the final domain structure and execution flow.
- [ ] Contributor guidance no longer tells engineers to maintain duplicated command tables or hand-edited CLI help if the registry owns those surfaces.
- [ ] Edge case: no stale deleted root-file paths remain in contributor-facing docs.

**Required Evidence:**
- [ ] `rg -n "(browser-manager|buffers|har|session-manager|session-persist|encryption|domain-filter|policy|auth-vault|sanitize|runtime|chrome-discover|cloud-providers|record-export|snapshot|react-devtools|mcp-tools)" CLAUDE.md .claude/claude-md-refs/architecture.md .claude/claude-md-refs/development-guide.md` returns no stale deleted root-file references.
- [ ] The updated docs explicitly describe the registry-driven command flow and executor pipeline.

### TASK-025: Update roadmap file paths for the refactored structure

Update the roadmap artifacts so future feature work targets the final domain paths rather than deleted root files.

**Files:** `plans/roadmap-v1.5-v2.2.md`, `plans/roadmap-v1.5-v2.2.json`

**Type:** docs  
**Effort:** S  
**Priority:** P2  
**Agent:** general-purpose  
**Review:** claude  
**Depends on:** TASK-023  
**Validate:** `node -e "JSON.parse(require('fs').readFileSync('plans/roadmap-v1.5-v2.2.json','utf8')); console.log('json-ok')"`

**Acceptance Criteria:**
- [ ] Roadmap file references point at final domain paths, not deleted shim files.
- [ ] Markdown and JSON roadmap artifacts remain isomorphic after path updates.
- [ ] Edge case: no roadmap task references a shim file removed by `TASK-023`.

**Required Evidence:**
- [ ] `rg -n "(browser-manager|buffers|har|session-manager|session-persist|encryption|domain-filter|policy|auth-vault|sanitize|runtime|chrome-discover|cloud-providers|record-export|snapshot|react-devtools|mcp-tools)" plans/roadmap-v1.5-v2.2.md plans/roadmap-v1.5-v2.2.json` returns no deleted shim-path references.
- [ ] Markdown/JSON roadmap parity check passes after the path rewrite.

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|----------------|------------|
| `AutomationTarget` is still too browser-specific and v2.0 app runtime cannot fit the contract cleanly | TASK-001, TASK-004, TASK-021 | Keep the contract minimal and target-neutral, add explicit capability sub-interfaces, and retarget command handlers before server and MCP wiring is declared complete. |
| Registry, server routing, MCP tool exposure, and CLI help drift apart again | TASK-002, TASK-005, TASK-006, TASK-017, TASK-018 | Use `CommandSpec` as the single source of truth and add explicit parity tests that fail when any surface diverges. |
| Compatibility shims become permanent and start collecting new business logic | TASK-007, TASK-010, TASK-011, TASK-012, TASK-013, TASK-014, TASK-015, TASK-018, TASK-019, TASK-020, TASK-022, TASK-023 | Add shim-purity tests, import guards, and make shim removal an explicit guarded task. |
| Barrel files introduce circular imports across domains | TASK-007, TASK-012, TASK-013, TASK-014, TASK-015, TASK-017, TASK-018 | Keep barrels to domain entrypoints only, prefer direct internal imports, and add cycle checks in architecture tests. |
| Session, security, or profile moves accidentally change filesystem paths and break persisted state | TASK-009, TASK-013, TASK-014 | Preserve existing path helpers and prove persisted-session/auth/profile behavior with targeted regression tests. |
| Docs and roadmap immediately drift from the refactored tree | TASK-024, TASK-025 | Make roadmap and contributor-doc updates part of the refactor DAG rather than a follow-up note. |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-001"],
  "TASK-005": ["TASK-002", "TASK-003", "TASK-004", "TASK-021"],
  "TASK-006": ["TASK-002", "TASK-003", "TASK-004", "TASK-021"],
  "TASK-007": ["TASK-004"],
  "TASK-008": ["TASK-007"],
  "TASK-009": ["TASK-007"],
  "TASK-010": ["TASK-007", "TASK-008"],
  "TASK-011": ["TASK-007"],
  "TASK-012": [],
  "TASK-013": ["TASK-004"],
  "TASK-014": [],
  "TASK-015": [],
  "TASK-016": ["TASK-005", "TASK-010", "TASK-011", "TASK-012", "TASK-014", "TASK-015"],
  "TASK-017": ["TASK-006"],
  "TASK-018": ["TASK-005", "TASK-006", "TASK-008", "TASK-009", "TASK-010", "TASK-011", "TASK-012", "TASK-013", "TASK-014", "TASK-015", "TASK-016", "TASK-017"],
  "TASK-019": ["TASK-016", "TASK-017", "TASK-018"],
  "TASK-020": ["TASK-019"],
  "TASK-021": ["TASK-001", "TASK-004"],
  "TASK-022": ["TASK-018", "TASK-019", "TASK-020"],
  "TASK-023": ["TASK-022"],
  "TASK-024": ["TASK-023"],
  "TASK-025": ["TASK-023"]
}
```
