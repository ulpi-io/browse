# Plan: User Handoff Mode

> Generated: 2026-03-21
> Branch: `feat/handoff`
> Mode: HOLD

## Overview

Add `handoff [reason]` and `resume` commands that let AI agents transfer browser control to a human when stuck (CAPTCHA, MFA, complex auth). Swaps the browser in-place: headless → headed on handoff, headed → headless on resume. State (cookies, localStorage, tabs) preserved across both swaps. Auto-suggests handoff after 3 consecutive command failures.

## Scope Challenge

Studied gstack's implementation. Key insight: single-browser swap (not two browsers alive simultaneously). `handoff` launches headed, restores state, closes headless. `resume` does the reverse. Launch-first-close-second for safe rollback. Our `recreateContext()` already does most of this — save cookies/tabs → new context → restore. The difference: we need to swap the entire `Browser` object, not just the context. Added auto-handoff hint (consecutive failure counter on server). HOLD mode — 3 tasks, builds on existing patterns.

## Architecture

```
browse handoff "stuck on CAPTCHA"
  │
  ▼
TASK-001: BrowserManager.handoff(message)
  │  1. saveState() → cookies, tabs, localStorage, sessionStorage
  │  2. chromium.launch({ headless: false }) → new headed browser
  │  3. newContext() → restoreState(state)
  │  4. Remove old browser 'disconnected' listener
  │  5. Close old headless browser (fire-and-forget)
  │  6. Swap: this.browser = newBrowser, isHeaded = true
  │
  ▼
User solves CAPTCHA in visible Chrome...
  │
  ▼
browse resume
  │
  ▼
TASK-001: BrowserManager.resume()
  │  1. saveState() → capture state after user interaction
  │  2. chromium.launch({ headless: true }) → new headless browser
  │  3. newContext() → restoreState(state)
  │  4. Remove old browser 'disconnected' listener
  │  5. Close old headed browser (fire-and-forget)
  │  6. Swap: this.browser = newBrowser, isHeaded = false
  │  7. clearRefs(), resetFailures()
  │
  ▼
TASK-002: meta.ts commands + auto-suggest + disable flag
  │  handoff → bm.handoff(reason) → return instructions
  │  resume → bm.resume() → return fresh snapshot -i
  │  Server: increment/reset failures, append hint after 3
  │
  ▼
TASK-003: tests
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Save cookies + localStorage + tabs | Need new `saveState()` / `restoreState()` methods | Build (inspired by gstack's pattern, adapted to our BrowserManager) |
| Context creation with options | `recreateContext()` at browser-manager.ts:700 | Reuse pattern (headers, offline, initScript, userRoutes) |
| Headed browser launch | `server.ts:503` (`headless: false`) | Reuse launch pattern |
| Fresh snapshot on resume | `handleSnapshot()` from snapshot.ts | Call after resume |
| Command registration | `server.ts:129-139` META_COMMANDS | Extend |
| Error response path | `server.ts` catch block | Extend with failure counter |

## Tasks

### TASK-001: Add handoff/resume lifecycle to BrowserManager

Refactor `recreateContext()` to extract shared state-transfer logic, then add handoff/resume on top. Modify `src/browser-manager.ts`.

**Step 1 — Extract `saveState()` / `restoreState()` from `recreateContext()`:**

The existing `recreateContext()` (line 700-780) already does: save cookies → save tab URLs → create new context → restore cookies/headers/offline/initScript/userRoutes/domainFilter → recreate tabs. Extract this into two reusable methods:

`private async saveState(): Promise<BrowserState>` — extract from recreateContext lines 720-730. Capture cookies, tab URLs (with active flag). ALSO add localStorage/sessionStorage per page (recreateContext doesn't do this — handoff needs it). Skip pages that fail storage reads.

`private async restoreState(state: BrowserState, context: BrowserContext): Promise<void>` — extract from recreateContext lines 735-768. Restore cookies, extraHeaders, offline, initScript, userRoutes, domainFilter into the given context. Recreate pages with `wirePageEvents()`, navigate to saved URLs. ALSO inject localStorage/sessionStorage (new for handoff). Restore active tab.

Then **refactor `recreateContext()` to use `saveState()` / `restoreState()`** — same behavior, less duplication. Verify all existing tests still pass after refactor.

**Step 2 — New private fields:**
```typescript
private isHeaded = false;
private consecutiveFailures = 0;
```

`async handoff(message: string): Promise<string>` — swap headless → headed:
1. If `isHeaded`, return "Already in headed mode"
2. If `isPersistent`, throw "Handoff not supported in profile mode"
3. `saveState()` → capture current state
4. `chromium.launch({ headless: false, timeout: 15000 })` — if this fails, return error, headless untouched
5. `newBrowser.newContext()` with viewport + userAgent
6. Swap `this.browser` and `this.context`, clear `this.pages`
7. Register crash handler on new browser
8. `restoreState(state)`
9. Set `this.isHeaded = true`
10. Remove old browser's `disconnected` listener, close old browser (fire-and-forget, don't await — can hang)
11. Return formatted message with URL + reason + instructions

`async resume(onCrash?: () => void): Promise<string>` — swap headed → headless:
1. If not `isHeaded`, throw "Not in handoff mode"
2. `saveState()` → capture state after user interaction
3. `chromium.launch({ headless: true })` — if fails, return error, headed stays
4. `newBrowser.newContext()` with viewport + userAgent
5. Swap `this.browser` and `this.context`, clear `this.pages`
6. Register crash handler on new browser (use `onCrash` callback)
7. `restoreState(state)`
8. Set `this.isHeaded = false`
9. Remove old browser's `disconnected` listener, close old browser (fire-and-forget)
10. `clearRefs()`, `resetFailures()`
11. Return final URL

`incrementFailures()` / `resetFailures()` / `getFailureHint(): string | null` — consecutive failure counter. After 3 failures in non-headed mode, return hint suggesting handoff. Reset on any successful command.

`getIsHeaded(): boolean` — expose headed state.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `recreateContext()` refactored to use `saveState()`/`restoreState()` — all existing tests pass (no behavior change)
- [ ] `handoff()` swaps to headed browser with cookies/tabs/storage preserved
- [ ] `resume()` swaps back to headless with user's new state preserved
- [ ] Old browser is closed after swap (no orphan processes)
- [ ] If headed launch fails, headless stays untouched (safe rollback)
- [ ] If headless launch on resume fails, headed stays (safe rollback)
- [ ] `handoff()` in profile mode throws clear error
- [ ] `handoff()` while already headed returns "Already in headed mode"
- [ ] `resume()` while not headed throws clear error
- [ ] `getFailureHint()` returns hint after 3 consecutive failures

**Agent:** general-purpose

**Priority:** P0

---

### TASK-002: Add meta commands, server failure tracking, disable flag, SKILL.md

Modify `src/commands/meta.ts`, `src/server.ts`, `src/cli.ts`, `skill/SKILL.md`.

**Meta commands (`src/commands/meta.ts`):**

`handoff [reason]`:
1. Check if handoff is disabled (`opts.noHandoff`) — throw "Handoff is disabled"
2. Call `bm.handoff(args.join(' ') || 'User takeover requested')`
3. Return the formatted message from BrowserManager

`resume`:
1. Call `bm.resume(onCrash)` — pass the server's crash callback
2. Take fresh snapshot: `handleSnapshot(bm, ['-i'])`
3. Return `"Resumed — back to headless.\n\n" + snapshot`

**Server failure tracking (`src/server.ts`):**
- On successful command (before response): `session.manager.resetFailures()`
- On error (catch block): `session.manager.incrementFailures()`
- Append `session.manager.getFailureHint()` to error message if non-null

**Disable flag (`src/cli.ts` + `src/server.ts`):**
- `--no-handoff` CLI flag → `X-Browse-No-Handoff: 1` header
- `BROWSE_HANDOFF=0` env var
- Pass through `RequestOptions` → meta command handler

**Registration:**
- Add `'handoff'`, `'resume'` to `META_COMMANDS` in `src/server.ts`
- Add to CLI help under `Handoff:` section
- Note: do NOT add to `SAFE_TO_RETRY` — these change browser state

**SKILL.md (`skill/SKILL.md`):**
Add handoff section with:
- Commands: `browse handoff [reason]` / `browse resume`
- When to use: CAPTCHA, MFA, OAuth, 2-3 failed attempts at same step
- When NOT to use: normal failures (retry/different selector), slow pages (wait), auth issues (cookie-import/auth login)
- Two-step protocol using AskUserQuestion:
  ```
  Step 1: Ask permission to handoff
    AskUserQuestion: "I'm stuck on [CAPTCHA/MFA/etc] at [URL].
    Can I open a visible browser so you can solve it?"
    Options: "Yes, open browser" / "No, try something else"

  Step 2: If yes → run `browse handoff "reason"`
    Then immediately ask:
    AskUserQuestion: "Browser is open at [URL].
    Solve the [CAPTCHA/MFA/etc], then click Done."
    Options: "Done" / "Cancel (close browser)"

  Step 3: If Done → run `browse resume` → continue with fresh snapshot
          If Cancel → run `browse resume` → try alternative approach
  ```
- Never run handoff without the two-step ask flow
- Add `"Bash(browse handoff:*)"`, `"Bash(browse resume:*)"` to permissions list

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse handoff` opens headed browser with instructions
- [ ] `browse resume` returns to headless with fresh snapshot
- [ ] After 3 consecutive failures, error includes handoff hint
- [ ] Successful command resets failure counter
- [ ] `--no-handoff` / `BROWSE_HANDOFF=0` disables handoff command
- [ ] SKILL.md has handoff guidance with when/when-not/protocol
- [ ] Both commands in `browse --help`

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Tests for handoff/resume

Add tests in `test/features.test.ts`:

1. **handoff swaps to headed** — call `bm.handoff('test')`, verify `bm.getIsHeaded()` is true, verify returned string contains URL
2. **resume swaps back to headless** — call `bm.resume()`, verify `bm.getIsHeaded()` is false
3. **cookie roundtrip** — set cookie, handoff, resume, verify cookie still present
4. **URL preserved** — navigate to a URL, handoff, resume, verify URL matches
5. **double handoff returns already-headed** — handoff twice, verify second returns "Already in headed mode"
6. **resume without handoff throws** — call resume() without prior handoff, verify throws
7. **failure counter** — call `incrementFailures()` 3 times, verify `getFailureHint()` returns hint. Call `resetFailures()`, verify hint is null
8. **meta handler integration** — call `handleMetaCommand('handoff', ...)` then `handleMetaCommand('resume', ...)`, verify responses

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All handoff lifecycle tests pass
- [ ] Cookie and URL roundtrip preserved
- [ ] Error cases covered (double handoff, resume-without-handoff)
- [ ] Failure counter logic verified
- [ ] No orphan Chromium processes after tests
- [ ] No regressions in existing tests

**Agent:** general-purpose

**Depends on:** TASK-001, TASK-002
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Old browser's `close()` hangs when new Playwright instance active | TASK-001 | Remove `disconnected` listener first, close fire-and-forget (don't await) — gstack's proven pattern |
| Headed launch fails (no display, CI environment) | TASK-001 | Return error message, headless stays untouched. Do not throw — let agent handle gracefully |
| Headless launch on resume fails | TASK-001 | Return error message, headed stays running. User can continue manually |
| localStorage restore fails for unreachable origin | TASK-001 | 3s timeout per origin, skip on failure, swallow error |
| Profile mode tries handoff | TASK-001 | Guard: return clear error (profiles already have real browser, handoff is meaningless) |
| CI tests can't launch headed browser | TASK-003 | Skip headed-specific tests if `process.env.CI` is set |
| `onCrash` callback not passed to resume | TASK-002 | Pass the server's shutdown function through to `resume()` for crash handler registration |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| BrowserManager.saveState() | TASK-003 | integration |
| BrowserManager.restoreState() | TASK-003 | integration |
| BrowserManager.handoff() | TASK-003 | integration |
| BrowserManager.resume() | TASK-003 | integration |
| Cookie/URL roundtrip across handoff | TASK-003 | integration |
| Failure counter + hint | TASK-003 | unit |
| Meta command handler wiring | TASK-003 | integration |
| Safe rollback on launch failure | (manual — hard to force Chromium launch failure) | manual |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001", "TASK-002"]
}
```
