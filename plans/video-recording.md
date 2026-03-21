# Plan: Video Recording via Playwright recordVideo

> Generated: 2026-03-16
> Branch: `feat/video-recording` (create from `main`)
> Mode: HOLD

## Overview

Add `video start [dir]`, `video stop`, and `video status` commands to browse CLI. Uses Playwright's `recordVideo` context option which records at the Chrome compositor level — zero CDP overhead, no external deps, WebM output. Requires context recreation on start/stop (same proven pattern as `emulate device`).

## Scope Challenge

The feature builds entirely on two existing patterns:
1. **Context recreation** (`browser-manager.ts:553`) — already handles cookies, tabs, headers, routes, domain filters, init scripts, snapshots, frame targeting. Battle-tested by `emulate` and `useragent` commands.
2. **HAR start/stop** (`meta.ts:593-620`) — identical command structure with subcommands, state tracking on BrowserManager, output path defaulting.

No new modules needed. No new deps. The hard part (context recreation with full state preservation + rollback) is already done. This is a thin integration layer.

## Architecture

```
  CLI (src/cli.ts)                                         ← TASK-003 (help text)
         |
         v
  Server (src/server.ts)  META_COMMANDS.has('video')       ← TASK-002 (registration)
         |
         v
  meta.ts case 'video'                                     ← TASK-002 (handler)
    ├── start [dir]:
    │        |
    │        v
    │   bm.startVideoRecording(dir)                        ← TASK-001 (method)
    │        |
    │   ┌────┴────┐
    │   │ Save    │  videoRecording = { dir, startedAt }
    │   │ state   │  mkdir -p dir
    │   └────┬────┘
    │        |
    │        v
    │   recreateContext({                                   ← reuse existing
    │     ...currentDeviceOptions,
    │     recordVideo: { dir, size: viewport }
    │   })
    │        |
    │   ┌────┴────┐
    │   │ Context │  Pages auto-record (compositor-level)
    │   │ active  │  Screenshots/clicks/fill all work
    │   └─────────┘
    │
    ├── stop:
    │        |
    │        v
    │   bm.stopVideoRecording()                            ← TASK-001 (method)
    │        |
    │   ┌────┴────┐
    │   │ Collect │  Save page.video() refs for all tabs
    │   │ videos  │  (before pages are closed)
    │   └────┬────┘
    │        |
    │        v
    │   recreateContext({                                   ← strips recordVideo option
    │     ...currentDeviceOptions                             (closes old pages → finalizes)
    │   })
    │        |
    │        v
    │   video.saveAs(dir/tab-N.webm)                       ← works local + remote CDP
    │        |
    │        v
    │   Return paths + duration
    │
    └── status:
             |
             v
        bm.getVideoRecording()                             ← TASK-001 (method)
             |
             v
        Return { active, dir, duration } or "No active recording"

  Tests: test/features.test.ts                             ← TASK-004
  Docs:  CLAUDE.md, SKILL.md, exports-reference.md         ← TASK-005
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Context recreation with state preservation | `browser-manager.ts:553` `recreateContext()` | Extend — pass `recordVideo` in contextOptions |
| Start/stop subcommand pattern | `meta.ts:593-620` HAR commands | Reuse pattern |
| Video state tracking | `browser-manager.ts:168` HAR recording field | Reuse pattern (new field) |
| Default output path | `meta.ts:222,297` screenshot/pdf path logic | Reuse pattern |
| Command registration (6 places) | `server.ts:124`, `meta.ts:348`, `cli.ts:591` | Extend |
| Retry safety | `cli.ts:373` SAFE_TO_RETRY | Extend |

## Tasks

### TASK-001: Add video recording state and methods to BrowserManager

Add `videoRecording` state field and `startVideoRecording()` / `stopVideoRecording()` / `getVideoRecording()` methods to `BrowserManager`. The start method calls `recreateContext` with `recordVideo: { dir, size }` added to context options. The stop method uses `video.saveAs()` (not `video.path()`) to save videos with predictable names — this works for both local and remote CDP browsers. The `recreateContext` method already handles all state preservation — no changes needed to it.

Key implementation details:
- `startVideoRecording(dir: string)`: store `{ dir, startedAt: Date.now(), active: true }`, then `recreateContext` with `recordVideo: { dir, size: currentViewport }`
- `stopVideoRecording()`: collect `page.video()` refs from all pages, then `recreateContext` without `recordVideo` (closes old pages, finalizes videos), then call `video.saveAs(dir/tab-N.webm)` for each video. Return `{ dir, startedAt, paths: string[] }`. Uses `saveAs` instead of `path()` because: (a) works with both local and remote CDP browsers, (b) gives us predictable filenames instead of Playwright's internal temp paths
- `getVideoRecording()`: return current state or null
- Add `videoRecording` to the state fields that survive `recreateContext` (it already survives — it's a field on BrowserManager, not on the context)
- If recording is active during `emulateDevice` or `useragent` changes (which also call `recreateContext`), pass `recordVideo` through so recording continues in the new context

**Files:** `src/browser-manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `startVideoRecording(dir)` creates a new context with `recordVideo` option and preserves all tabs/cookies/state
- [ ] `stopVideoRecording()` saves videos via `video.saveAs()` with predictable names (`tab-N.webm`) and recreates context without `recordVideo`
- [ ] Calling `startVideoRecording` while already recording throws an error ("Video recording already active")
- [ ] `emulateDevice` while recording passes `recordVideo` through to new context

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Add `video` command handler in meta.ts

Add `case 'video'` to `handleMetaCommand` in `src/commands/meta.ts` with three subcommands: `start [dir]`, `stop`, `status`. Follow the HAR command pattern at line 593.

Implementation:
- `video start [dir]`: call `bm.startVideoRecording(dir)` where `dir` defaults to `currentSession.outputDir` or `LOCAL_DIR`. Return "Video recording started — output dir: {dir}"
- `video stop`: call `bm.stopVideoRecording()`. If no active recording, throw error. Return "Video saved: {paths} ({duration}s)"
- `video status`: call `bm.getVideoRecording()`. Return recording state or "No active recording"

Register `'video'` in `META_COMMANDS` set in `server.ts:124`.

**Files:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse video start` begins recording, returns confirmation with output directory
- [ ] `browse video stop` stops recording, returns paths of saved WebM files with duration
- [ ] `browse video stop` without active recording throws clear error: "No active video recording"
- [ ] `browse video status` returns recording state (active/inactive, dir, duration so far)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Register video command in CLI help, chain, and retry sets

Update all registration points for the new `video` command:
1. `src/cli.ts:614` — add `video start [dir] | video stop | video status` to the Recording line
2. `src/cli.ts:379` — do NOT add to `SAFE_TO_RETRY` (video start/stop are not safe to retry; video status could be but it's a meta command routed through meta handler)
3. `src/commands/meta.ts:348-349` — the chain command routes unknown commands to `handleMetaCommand` as fallback (line 371), so `video` will work in chain without explicit registration. Verify this.

**Files:** `src/cli.ts`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --help` shows video commands in the Recording line
- [ ] `browse chain '[{"command":"video","args":["start"]},{"command":"goto","args":["https://example.com"]},{"command":"video","args":["stop"]}]'` works end-to-end
- [ ] `video start` is NOT in SAFE_TO_RETRY (would cause duplicate context recreation)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002
**Priority:** P1

---

### TASK-004: Integration tests for video recording

Add tests in `test/features.test.ts` for video recording. Use the shared BrowserManager test infrastructure (import from `test/setup`).

Test cases:
1. **Happy path**: `video start` → navigate to page → `video stop` → verify WebM file exists at returned path
2. **Status check**: `video start` → `video status` returns active state → `video stop` → `video status` returns inactive
3. **Double start error**: `video start` → `video start` again → throws "already active" error
4. **Stop without start**: `video stop` → throws "no active recording" error
5. **Screenshots during recording**: `video start` → `screenshot` → verify screenshot works normally
6. **Emulate during recording**: `video start` → `emulate iphone` → verify recording continues after context recreation

Use a temp directory for video output to avoid polluting the workspace.

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All 6 test cases pass with real Chromium (no mocks)
- [ ] WebM files are actually written to disk and have non-zero size
- [ ] Double-start and stop-without-start produce clear error messages
- [ ] Temp video files are cleaned up in afterAll

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002
**Priority:** P2

---

### TASK-005: Update CLAUDE.md and SKILL.md documentation

Update command counts and command lists in project documentation:
1. `CLAUDE.md` — update total command count from 75 to 76 (line 84), Meta count from 24 to 25 (line 88), fix stale "23 meta commands" in Project Structure (line 49) to 25, add `video` to the Meta command list
2. `.claude/skills/browse/SKILL.md` — add `video start|stop|status` to the command reference, update any total/meta counts
3. `.claude/claude-md-refs/exports-reference.md` — add `video` to Meta Commands table, fix stale "23 meta commands" (line 25) and "Meta Commands (23)" heading (line 147) to 25

**Files:** `CLAUDE.md`, `.claude/skills/browse/SKILL.md`, `.claude/claude-md-refs/exports-reference.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Total command count is 76 and Meta command count is 25 in CLAUDE.md
- [ ] `video start [dir] | video stop | video status` appears in all three docs
- [ ] No stale command counts remain (check total, meta, and per-category counts in all files)

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `page.video()` returns null if page was created before recordVideo context | TASK-001 | recreateContext already creates new pages — video() will be set on the new pages |
| Video file not flushed until page/context close | TASK-001 | On stop, we recreate context (which closes old pages) — Playwright flushes video on page close |
| Emulate/useragent while recording drops recordVideo option | TASK-001 | Pass `recordVideo` through in recreateContext when videoRecording is active |
| Temp dir doesn't exist | TASK-002 | Use `fs.mkdirSync(dir, { recursive: true })` before starting |
| WebM file not fully written at assertion time | TASK-004 | `video.saveAs()` waits for video to be finalized before resolving — no race condition |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `startVideoRecording()` — context recreation with recordVideo | TASK-004 | integration |
| `stopVideoRecording()` — video path collection + context recreation | TASK-004 | integration |
| `getVideoRecording()` — state query | TASK-004 | integration |
| `video start` command handler | TASK-004 | integration |
| `video stop` command handler | TASK-004 | integration |
| `video status` command handler | TASK-004 | integration |
| Double-start error path | TASK-004 | integration |
| Stop-without-start error path | TASK-004 | integration |
| Recording survives emulateDevice | TASK-004 | integration |
| Screenshots work during recording | TASK-004 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-002"]
}
```
