# Plan: Record & Export Command Recipes

> Generated: 2026-03-21
> Branch: `feat/record-export`
> Mode: EXPANSION

## Overview

Add a `record` meta command that captures browse commands executed during a session and exports them as replayable scripts in JSON (chain-compatible), Playwright, or Puppeteer format. This lets agents figure out browser workflows interactively, then export them as standalone automation scripts.

## Scope Challenge

Existing code already provides most building blocks:
- `chain` command accepts `[["goto","url"],["text"]]` JSON — this is already a recipe format
- HAR/video recording use the same `start/stop` UX pattern we'll follow
- The command dispatch in `server.ts:263-283` is a single chokepoint for all commands — easy hook
- `Session` interface already stores per-session state (buffers, domain filter, recording)

What's truly new: a recording buffer on Session, the `record` subcommands in meta.ts, and three script generator functions. No new dependencies needed.

## Architecture

```
  browse record start
        │
        ▼
  Session.recording = []     ←── TASK-001 (Session type + recording buffer)
        │
  browse goto / click / fill / ...
        │
        ▼
  server.ts handleCommand()  ←── TASK-002 (hook: push {command,args} to buffer)
        │
        ▼
  Session.recording.push({command, args, timestamp})
        │
  browse record stop
        │
        ▼
  browse record export <format> [path]
        │
        ├── json       → chain-compatible JSON       ┐
        ├── playwright  → standalone .js script       ├── TASK-003 (generators)
        └── puppeteer   → standalone .js script       ┘
        │
        ▼
  Write to file / stdout     ←── TASK-004 (meta.ts record command)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Recording state on session | `session-manager.ts` Session interface | Extend — add `recording` field |
| Start/stop UX pattern | `har start/stop` in `meta.ts:595-623` | Reuse pattern |
| Command capture hook | `server.ts:263-283` handleCommand dispatch | Extend — add 2 lines after dispatch |
| Chain-compatible JSON | `chain` command in `meta.ts:331` | Reuse format exactly |
| Script file output | `har stop` writes to disk in `meta.ts:617` | Reuse pattern |
| Command sets (READ/WRITE/META) | `server.ts:109-135` | Reference for filtering |
| CLI help text | `cli.ts:620` Recording section | Extend |
| SAFE_TO_RETRY set | `cli.ts:373` | Extend with `record` |

## Tasks

### TASK-001: Add recording state to Session

Add `RecordedStep` interface and `recording` field to the `Session` interface in `session-manager.ts`. The recording buffer is `null` when not recording, an array of `{command, args, timestamp}` when active.

**Files:** `src/session-manager.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `RecordedStep` interface exported with `command: string`, `args: string[]`, `timestamp: number`
- [ ] `Session` interface has `recording: RecordedStep[] | null` field, defaults to `null` in `getOrCreate()`
- [ ] Existing session tests still pass (no breaking changes to Session shape)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Hook command dispatch to capture recorded steps

In `server.ts` `handleCommand()`, after a command executes successfully, push `{command, args, timestamp}` to `session.recording` if recording is active. Skip recording meta commands like `record`, `status`, `stop`, `restart` to avoid noise.

**Files:** `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] When `session.recording` is not null, every successfully executed command (except `record`, `status`, `stop`, `restart`, `sessions`, `session-close`) is appended to the buffer
- [ ] Failed commands (those that throw) are NOT recorded
- [ ] The recording hook adds zero overhead when recording is inactive (`if (!session.recording) skip`)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Script generators (JSON, Playwright, Puppeteer)

Create `src/record-export.ts` with three export functions:
- `exportJSON(steps)` → chain-compatible `[["goto","url"],["click","@e3"]]`
- `exportPlaywright(steps)` → standalone Node.js script using `@playwright/test`
- `exportPuppeteer(steps)` → standalone Node.js script using `puppeteer`

Each generator maps browse commands to the target library's API calls. Commands that don't map cleanly (like `snapshot`, `chain`) are emitted as comments.

**Files:** `src/record-export.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `exportJSON` returns valid JSON parseable by the `chain` command
- [ ] `exportPlaywright` generates a runnable script: `goto` → `page.goto()`, `click` → `page.click()`, `fill` → `page.fill()`, `type` → `page.keyboard.type()`, `press` → `page.keyboard.press()`, `wait` → `page.waitForSelector()`, `scroll` → `page.evaluate(scroll)`, `select` → `page.selectOption()`, `screenshot` → `page.screenshot()`
- [ ] `exportPuppeteer` generates equivalent Puppeteer script: `goto` → `page.goto()`, `click` → `page.click()`, `type` → `page.type()`, `press` → `page.keyboard.press()`, `screenshot` → `page.screenshot()`
- [ ] Unmapped commands (snapshot, console, network, etc.) are emitted as `// browse <command> <args>` comments so the user knows what was skipped
- [ ] `@ref` selectors in args are emitted with a `// TODO: replace @ref with CSS selector` comment

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-004: `record` meta command (start/stop/status/export)

Add `record` to `META_COMMANDS` in `server.ts` and implement the handler in `meta.ts`:
- `record start` — set `session.recording = []`
- `record stop` — set `session.recording = null`, return step count
- `record status` — return recording state + step count
- `record export json [path]` — call exportJSON, write to file or stdout
- `record export playwright [path]` — call exportPlaywright, write to file
- `record export puppeteer [path]` — call exportPuppeteer, write to file

Update CLI help text and add `record` to `SAFE_TO_RETRY`.

**Files:** `src/commands/meta.ts`, `src/server.ts`, `src/cli.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `record start` returns "Recording started" and subsequent commands are captured
- [ ] `record stop` returns "Recording stopped (N steps captured)" and clears the buffer
- [ ] `record status` returns step count when active, "No active recording" when inactive
- [ ] `record export json` writes valid chain-compatible JSON to file
- [ ] `record export playwright` writes a runnable .js file
- [ ] `record export puppeteer` writes a runnable .js file
- [ ] `record export` without active or stopped recording returns clear error
- [ ] Calling `record start` while already recording returns error (no silent reset)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-003
**Priority:** P1

---

### TASK-005: Integration tests

Add tests in `test/features.test.ts` covering the full record→export flow:
1. Start recording, execute commands (goto, click, fill), stop, export each format
2. Verify JSON output is chain-compatible
3. Verify Playwright script contains correct API calls
4. Verify Puppeteer script contains correct API calls
5. Edge cases: export with no recording, double start, status while active/inactive

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: record start → goto → click → fill → stop → export json produces valid chain JSON
- [ ] Test: export playwright output contains `page.goto()`, `page.click()`, `page.fill()`
- [ ] Test: export puppeteer output contains `page.goto()`, `page.click()`, `page.type()`
- [ ] Test: `record start` while recording throws error
- [ ] Test: `record export` with no recording throws error
- [ ] Test: `record status` returns correct state and count
- [ ] All existing tests still pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-004
**Priority:** P2

---

### TASK-006: Update SKILL.md and README

Add `record` command documentation to both SKILL.md files and README.md:
- Command reference section with all subcommands
- Add to "When to Use What" table
- Add permission rule for `Bash(browse record:*)`
- Update command count (76 → 77)

**Files:** `skill/SKILL.md`, `.claude/skills/browse/SKILL.md`, `README.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `record start|stop|status|export` documented in command reference
- [ ] Permission rule `Bash(browse record:*)` added to SKILL.md permissions list
- [ ] README changelog updated with record/export feature
- [ ] Missing or incorrect command counts are not introduced

**Agent:** general-purpose

**Depends on:** TASK-004
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Recording buffer grows unbounded on long sessions | TASK-001, TASK-002 | Cap at 10,000 steps (matches BUFFER_HIGH_WATER_MARK pattern). Return warning on cap. |
| @ref selectors in exported scripts won't work outside browse | TASK-003 | Emit TODO comments for @ref args. User must replace with CSS selectors. |
| `record start` called twice silently resets buffer | TASK-004 | Throw error if already recording — explicit `record stop` + `record start` required. |
| Exported Playwright/Puppeteer scripts have wrong API for edge commands | TASK-003 | Only map well-known commands (goto, click, fill, type, press, select, wait, scroll, screenshot). Everything else → comment. |
| Recording captures `record` commands themselves, creating noise | TASK-002 | Exclude `record` and other meta-noise commands from capture. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Session.recording buffer lifecycle | TASK-005 | integration |
| Command dispatch recording hook | TASK-005 | integration |
| JSON export (chain-compatible) | TASK-005 | integration |
| Playwright script generation | TASK-005 | integration |
| Puppeteer script generation | TASK-005 | integration |
| record start/stop/status/export commands | TASK-005 | integration |
| Double-start error | TASK-005 | integration |
| Export with no recording error | TASK-005 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": ["TASK-001", "TASK-003"],
  "TASK-005": ["TASK-002", "TASK-004"],
  "TASK-006": ["TASK-004"]
}
```
