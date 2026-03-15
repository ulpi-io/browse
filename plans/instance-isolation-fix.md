# Plan: Drop PPID Instance Isolation + Add `browse instances` Command

> Generated: 2026-03-15
> Branch: `feat/v0.2.1-fixes`
> Mode: HOLD

## Overview

Remove broken PPID-based instance auto-detection. Default to one server per project directory — sessions (`--session`) handle agent isolation. Add `browse instances` command so agents can discover running servers. Clean up dead code and orphan cleanup logic.

## Scope Challenge

PPID auto-detection was architecturally wrong — it tried to solve multi-agent isolation at the server level, but sessions already solve it at the context level. Every CLI invocation from Claude Code/Codex/etc. forks a new shell with a different PPID, creating a new server each time. The fix is not to find a better auto-detection mechanism — it's to stop auto-detecting and let sessions do their job. For the rare case of wanting separate servers (fault isolation), `BROWSE_INSTANCE` env var is explicit and correct.

## Architecture

```
┌──────────────────────────────────────────────────┐
│ Agent Tool (Claude Code / Codex / Aider / etc.)  │
│                                                  │
│  Agent 1 ──→ browse --session a1 goto ...        │
│  Agent 2 ──→ browse --session a2 goto ...        │
│  Agent 3 ──→ browse --session a3 snapshot -i     │
│  Agent 4 ──→ browse --session a4 click @e3       │
│  Agent 5 ──→ browse --session a5 text            │
│                    │                             │
│                    ▼                             │
│         .browse/browse-server.json               │
│         (one server, one Chrome, 5 contexts)     │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ browse instances                       TASK-002  │
│  Scans .browse/browse-server*.json               │
│  Health-checks each via /health                  │
│  Reports: instance, PID, port, status, sessions  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ src/cli.ts                             TASK-001  │
│  - Remove IS_COMPILED (dead code)                │
│  - Simplify cleanOrphanedServers()               │
│  - Add listInstances() function                  │
│  - Register 'instances' as local command          │
└──────────────────────────────────────────────────┘
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| PPID removal | `src/cli.ts:28` already done (empty string default) | Clean up dead code |
| State file scanning | `cleanOrphanedServers()` at cli.ts:297 | Simplify — no PPID files to detect |
| Health check | `ensureServer()` at cli.ts:238 already does fetch /health | Reuse pattern |
| Help text | cli.ts help string | Extend |

## Tasks

### TASK-001: Clean up PPID dead code and simplify orphan cleanup

Remove `IS_COMPILED` variable (dead — only assigned, never read). Simplify `cleanOrphanedServers()` — the PPID-suffix comment/logic is no longer relevant since we don't create PPID-suffixed files. Keep the port-based suffix detection (`data.port === suffix`) for intentional `BROWSE_PORT` instances.

**Files to modify:** `src/cli.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `IS_COMPILED` variable removed from cli.ts
- [ ] `cleanOrphanedServers()` still preserves intentional `BROWSE_PORT` state files
- [ ] `cleanOrphanedServers()` removes dead state files (PID not alive)
- [ ] `bun test` passes, `bun run build` succeeds

**Agent:** general-purpose

**Priority:** P0

---

### TASK-002: Add `browse instances` local command

Add `listInstances()` function to cli.ts and register `instances` as a local command (runs without server, like `--help` and `install-skill`). Scans `.browse/` for all `browse-server*.json` files, reads each, health-checks via `fetch /health`, reports instance name + PID + port + healthy/dead + session count.

**Files to modify:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse instances` lists all running servers with instance name, PID, port, status
- [ ] Dead servers show as "dead" and get cleaned up
- [ ] No servers running returns "(no running instances)"
- [ ] Works without starting a server (local command, no server connection needed)

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Update help text and SKILL.md

Add `instances` to cli.ts help text. Update SKILL.md to document `browse instances` and the multi-instance model (one server default, `BROWSE_INSTANCE` for explicit separation, `--session` for agent isolation).

**Files to modify:** `src/cli.ts`, `.claude/skills/browse/SKILL.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --help` shows `instances` command
- [ ] SKILL.md documents `browse instances` in the command reference
- [ ] SKILL.md explains the session-based isolation model for multi-agent use

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P2

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Old PPID-suffixed state files remain on disk | TASK-001 | cleanOrphanedServers still cleans files with dead PIDs regardless of suffix pattern |
| Health check timeout on dead server | TASK-002 | Use AbortSignal.timeout(1000) — fast fail |
| fetch fails on dead server (ECONNREFUSED) | TASK-002 | try/catch → report as "dead" |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| IS_COMPILED removal (no regression) | TASK-001 | existing tests (bun test) |
| listInstances() function | TASK-002 | manual (browse instances) |
| Orphan cleanup simplified | TASK-001 | existing tests (bun test) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"]
}
```
