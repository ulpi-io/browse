# Plan: Phase 7 — Safety, Flags & Skill Integration

> Generated: 2026-04-13
> Branch: `feat/safety-skill-integration`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-6 (all)

## Overview

Ensure all Phases 1-6 features are safe by default, have opt-in/opt-out flags, are documented in the browse skill, and are covered by backward-compatibility regression tests. This phase runs AFTER all feature phases land. It adds no new functionality — it hardens behavioral contracts, wires env var flags, updates SKILL.md and commands.md, creates a regression test suite that proves existing agent workflows are unbroken, and creates a new `browse-stealth` skill for anti-detection workflows.

## Scope Challenge

Phases 1-6 introduce 5 features that change existing behavior:

| Feature | Risk | Default | Flag |
|---------|------|---------|------|
| Consent dialog dismiss | Could click non-consent buttons | ON (improves correctness) | `BROWSE_CONSENT_DISMISS=0` to disable |
| Click fallback chain | Auto-force-clicks through overlays | OFF (breaking change) | `BROWSE_CLICK_FORCE=1` or `--force` flag |
| Page readiness wait | Adds latency to every goto | OFF (perf regression) | `BROWSE_READINESS=1` or `--ready` flag |
| Google SERP fast-path | Changes snapshot format on Google | OFF (output change) | `BROWSE_SERP_FASTPATH=1` or `--serp` flag |
| Session commandLock | Serializes concurrent requests | ON (correctness) | `BROWSE_COMMAND_LOCK=0` to disable |
| Tab inactivity reaper | Closes idle tabs | 30min (not 5min) | `BROWSE_TAB_INACTIVITY_MS` |

Rule: features that **improve correctness** default ON with opt-out. Features that **change output or add latency** default OFF with opt-in.

## Prerequisites

- Phases 1-6 features implemented and merged to main
- Browse skill exists at `skill/browse/SKILL.md` with `references/commands.md`
- Test suite exists in `test/` with integration tests against real browser

## Non-Goals

- New features beyond Phases 1-6
- Rewriting existing test files
- Changing the browse skill's triggers or argument-hint
- MCP tool schema changes (already in Phase 2/3 plans)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Safety flags → features | `src/constants.ts` DEFAULTS | Feature modules | 6 env vars with documented defaults | Default-off for output changes, default-on for correctness fixes |
| Skill docs → agents | `skill/browse/SKILL.md` | AI agents | Markdown with command tables, flags, env vars | Every new command/flag/env var documented |
| Regression suite → CI | `test/regression.test.ts` | `npm test` | 7 test cases proving core workflow unchanged | Tests fail if behavioral change leaks through defaults |

## Architecture

```
Phase 1-6 features (already merged)
  │
  ├── src/constants.ts ◄── TASK-001 (add 6 safety flag defaults)
  │     │
  │     ▼
  ├── Feature modules ◄── TASK-002 (gate behavior behind flags)
  │     ├── src/browser/consent.ts       (BROWSE_CONSENT_DISMISS)
  │     ├── src/commands/write.ts click   (BROWSE_CLICK_FORCE / --force)
  │     ├── src/browser/readiness.ts      (BROWSE_READINESS)
  │     ├── src/browser/serp.ts           (BROWSE_SERP_FASTPATH)
  │     ├── src/session/manager.ts lock   (BROWSE_COMMAND_LOCK)
  │     └── src/session/manager.ts reaper (BROWSE_TAB_INACTIVITY_MS)
  │
  ├── skill/browse/SKILL.md ◄── TASK-003 (new features, flags, env vars)
  ├── skill/browse/references/commands.md ◄── TASK-004 (new commands, flags)
  ├── skill/browse-stealth/ ◄── TASK-006 (anti-detection skill)
  │
  └── test/regression.test.ts ◄── TASK-005 (backward-compat proof)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Skill documentation | `skill/browse/SKILL.md` | Extend |
| Command reference | `skill/browse/references/commands.md` | Extend |
| Integration test patterns | `test/commands.test.ts` | Extend pattern |
| Constants/env vars | `src/constants.ts` | Extend |
| Config loader | `src/config.ts` | Extend |

## Tasks

### TASK-001: Wire safety flags into constants and config

Add env var flags to `src/constants.ts` and `src/config.ts` for all risky Phase 2-5 features.

| Flag | Default | Rationale |
|------|---------|-----------|
| `BROWSE_CONSENT_DISMISS` | 1 (ON) | Improves correctness. Opt-out via 0. |
| `BROWSE_CLICK_FORCE` | 0 (OFF) | Changes click semantics. Opt-in only. |
| `BROWSE_READINESS` | 0 (OFF) | Adds goto latency. Opt-in only. |
| `BROWSE_SERP_FASTPATH` | 0 (OFF) | Changes snapshot output. Opt-in only. |
| `BROWSE_COMMAND_LOCK` | 1 (ON) | Prevents CDP corruption. Escape hatch via 0. |
| `BROWSE_TAB_INACTIVITY_MS` | 1800000 | Matches session timeout (30min). |

Also add to `BrowseConfig` in `src/config.ts` so they can be set in `browse.json`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] All 6 flags in DEFAULTS with documented defaults
- [ ] Each read from `process.env` with DEFAULTS fallback
- [ ] With `BROWSE_CLICK_FORCE=0` (default), click on obscured element throws existing error
- [ ] With `BROWSE_READINESS=0` (default), goto is identical to current code

**Write Scope:** `src/constants.ts`, `src/config.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-002: Gate Phase 2-5 features behind safety flags

Audit each feature module and gate behavioral changes behind their safety flag.

1. `src/browser/consent.ts` — early-return when `BROWSE_CONSENT_DISMISS=0`
2. `src/commands/write.ts` click — only force-fallback when `BROWSE_CLICK_FORCE=1` OR `--force` in args
3. `src/browser/readiness.ts` — skip when `BROWSE_READINESS=0`
4. `src/commands/meta/inspection.ts` — skip SERP when `BROWSE_SERP_FASTPATH=0`
5. `src/session/manager.ts` — skip commandLock when `BROWSE_COMMAND_LOCK=0` (with warning)
6. `src/session/manager.ts` — tab reaper uses `BROWSE_TAB_INACTIVITY_MS` (30min default)

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] With all flags at defaults: goto/snapshot/click/text behavior identical to pre-Phase-2
- [ ] `BROWSE_CONSENT_DISMISS=1` enables consent dismiss; `=0` disables completely
- [ ] Click with `--force` flag works regardless of `BROWSE_CLICK_FORCE` env var

**Write Scope:** `src/browser/consent.ts`, `src/commands/write.ts`, `src/browser/readiness.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-003: Update browse skill SKILL.md

Add all Phase 1-6 features to `skill/browse/SKILL.md`: runtime selection (`--runtime camoufox`), search macros, new commands (images, youtube-transcript), new flags, new env vars. Follow existing document structure.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] SKILL.md mentions `--runtime camoufox` with usage guidance
- [ ] All 14 search macros listed with syntax
- [ ] Every new env var from Phases 1-6 appears in env var section

**Write Scope:** `skill/browse/SKILL.md`
**Validation:** `grep -c 'camoufox' skill/browse/SKILL.md`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Update commands.md reference

Add all new commands and flags to `skill/browse/references/commands.md`. Cross-reference with `src/automation/registry.ts` to ensure every registered command appears.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Every command in registry.ts has a commands.md entry
- [ ] `images` and `youtube-transcript` documented with syntax and examples
- [ ] All new flags (`--force`, `--offset`, `--max-chars`, `--serp`, `--ready`, `--inline`) documented

**Write Scope:** `skill/browse/references/commands.md`
**Validation:** `grep -c 'youtube-transcript' skill/browse/references/commands.md`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-005: Backward-compatibility regression test suite

Create `test/regression.test.ts` with 7 test cases proving the core agent workflow is unbroken:

1. **Core workflow**: goto → snapshot -i → click @ref → text (default flags)
2. **Snapshot format stability**: snapshot -i output matches baseline format
3. **Click error preservation**: click obscured element throws overlay error (BROWSE_CLICK_FORCE=0)
4. **Goto latency baseline**: no extra wait with BROWSE_READINESS=0
5. **Concurrent commands**: 3 simultaneous reads serialize correctly with commandLock
6. **Consent dismiss safety**: form submit button NOT auto-clicked by consent dismiss
7. **Camoufox smoke** (skip if not installed): runtime launches, goto+snapshot work

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All 7 tests pass with default flag values
- [ ] Test 3 fails if BROWSE_CLICK_FORCE default changed to 1
- [ ] Test 7 skips gracefully when camoufox-js not installed

**Write Scope:** `test/regression.test.ts`, `test/test-server.ts`
**Validation:** `npm test -- test/regression`

**Depends on:** TASK-001, TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-006: Create browse-stealth skill

Create `skill/browse-stealth/` — a specialized skill for anti-detection browsing. Separate from main browse skill because most agents don't need it.

Covers: camoufox setup, recommended flags (CONSENT_DISMISS=1, SERP_FASTPATH=1, READINESS=1), proxy configuration, cookie import for authenticated browsing, search macro workflows, troubleshooting Google blocks.

References main browse skill for command syntax.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] `skill/browse-stealth/SKILL.md` exists with valid frontmatter
- [ ] Recommends BROWSE_RUNTIME=camoufox and lists all stealth env vars
- [ ] References main browse skill for syntax, no command duplication

**Write Scope:** `skill/browse-stealth/SKILL.md`, `skill/browse-stealth/references/setup.md`
**Validation:** `test -f skill/browse-stealth/SKILL.md`

**Depends on:** TASK-003
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Safety flag defaults wrong — risky feature ON by default | TASK-001 | Explicit default table with rationale. Review verifies each. |
| Skill docs out of sync with actual commands | TASK-003, TASK-004 | Cross-reference with registry.ts. AC requires every command present. |
| Regression tests too narrow | TASK-005 | Tests cover full agent workflow, not just individual commands. |

## Ship Cut

- **Minimum:** TASK-001 + TASK-002 + TASK-005 = safety flags + regression proof
- **Full value:** All 6 tasks = flags + docs + stealth skill + regression tests

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Default behavior unchanged after Phase 2-6 | TASK-005 | integration |
| Safety flags disable risky features | TASK-005 | integration |
| Safety flags enable features when set | TASK-005 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 6 |
| Layer Count | 3 |
| Critical Path | TASK-001 → TASK-002 → TASK-005 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-003, TASK-004 | Independent: flags, SKILL.md, commands.md |
| 1 | TASK-002, TASK-006 | Flag wiring + stealth skill |
| 2 | TASK-005 | Regression tests |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": [],
  "TASK-005": ["TASK-001", "TASK-002"],
  "TASK-006": ["TASK-003"]
}
```
