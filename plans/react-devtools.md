# Plan: React DevTools Integration

> Generated: 2026-03-22
> Branch: `feat/react-devtools`
> Mode: HOLD

## Overview

Add React DevTools integration to browse — component tree inspection, suspense boundary tracking, props/state inspection, and render profiling. Uses React DevTools' `installHook.js` injected via `context.addInitScript()`. Lazy-downloaded on first use (~50KB).

## Scope Challenge

next-browser (at `/Users/ciprian/work_cip/next-browser`) already implements this pattern. We can study their approach:
- They vendor `extensions/react-devtools-chrome/build/installHook.js` (~50KB)
- Inject via `context.addInitScript(installHook)` before page JS runs
- Query `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` via `page.evaluate()`
- No Chrome extension UI needed — purely programmatic

We differ: we lazy-download instead of vendoring, and we add CLI commands instead of programmatic API. Core logic (hook injection + evaluate queries) is the same.

HOLD mode: builds on existing `addInitScript` pattern, moderate scope (~5 tasks).

## Architecture

```
browse react-tree
      │
      ▼
  src/react-devtools.ts ──── TASK-001 (lazy download + hook injection)
      │
      ├── ensureHook()      → download installHook.js to ~/.cache/browse/
      ├── injectHook(ctx)   → context.addInitScript(hookScript)
      ├── getTree(page)     → page.evaluate() → __REACT_DEVTOOLS_GLOBAL_HOOK__
      ├── getProps(page,id) → page.evaluate() → inspectElement
      ├── getSuspense(page) → page.evaluate() → suspense boundaries
      └── getProfiler(page) → page.evaluate() → render timing
      │
  src/commands/meta.ts ──── TASK-002 (react-tree, react-props, react-suspense, react-profiler)
      │
  src/server.ts ──────────── TASK-003 (hook injection on context creation)
      │
  test/features.test.ts ──── TASK-004 (tests)
      │
  docs ────────────────────── TASK-005 (SKILL.md, README, CHANGELOG)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Init script injection | `src/browser-manager.ts` addInitScript pattern | Reuse |
| Context creation hook | `src/session-manager.ts` domain filter injection | Reuse pattern |
| Page evaluate | All read commands use `page.evaluate()` | Reuse |
| Lazy download cache | `~/.cache/browse/` (compile cache pattern) | Reuse directory |
| Hook script queries | `next-browser/src/tree.ts` and `src/suspense.ts` | Study + adapt |
| CLI command pattern | `src/commands/meta.ts` existing commands | Reuse |

## Tasks

### TASK-001: React DevTools module (lazy download + hook + queries)

Create `src/react-devtools.ts` with:

1. **`ensureHook()`** — Check if `~/.cache/browse/react-devtools/installHook.js` exists. If not, download from npm (`react-devtools-core` package) or fetch from unpkg CDN. Cache locally.

2. **`injectHook(context)`** — Read the cached hook script and call `context.addInitScript(hookScript)`. Must run before any page JS.

3. **`getTree(page)`** — `page.evaluate()` that reads `__REACT_DEVTOOLS_GLOBAL_HOOK__`, gets the renderer, calls `flushInitialOperations()` on the fiber tree, and returns a formatted component tree string.

4. **`getProps(page, selector)`** — `page.evaluate()` that finds a fiber node matching a selector/ref and returns its props and state.

5. **`getSuspense(page)`** — `page.evaluate()` that walks the fiber tree for Suspense boundaries and returns their status (resolved/pending/fallback).

6. **`getProfiler(page)`** — `page.evaluate()` that reads React's performance timing entries (`console.timeStamp` intercept) and returns render durations.

Study `next-browser/src/tree.ts` (lines 69-175) and `next-browser/src/suspense.ts` (lines 736-740) for the exact DevTools hook API calls.

**Files:** `src/react-devtools.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `ensureHook()` downloads installHook.js on first call, caches at `~/.cache/browse/react-devtools/`
- [ ] `injectHook()` installs the hook via `addInitScript()` — React discovers it on page load
- [ ] `getTree()` returns a formatted component tree when React is on the page
- [ ] `getTree()` returns clear "No React detected" message on non-React pages
- [ ] `getSuspense()` returns suspense boundary status

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: React meta commands

Add `react-tree`, `react-props`, `react-suspense`, `react-profiler` commands to `src/commands/meta.ts`. Each calls the corresponding function from `src/react-devtools.ts`.

Also add these to `META_COMMANDS` in `src/server.ts`.

**Files:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse react-tree` returns component tree with indentation
- [ ] `browse react-props @e3` returns props/state of component at ref (or CSS selector)
- [ ] `browse react-suspense` returns suspense boundaries with status
- [ ] `browse react-profiler` returns render timing data
- [ ] All four return clear error when React is not detected on page
- [ ] All four return clear error when hook is not yet injected (hint: re-navigate)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Auto-inject hook on context creation

When `BROWSE_REACT_DEVTOOLS=1` env var is set (or `--react-devtools` flag), automatically inject the hook on every new BrowserContext. This way the hook is ready before the first `goto`.

Modify `src/server.ts` or `src/session-manager.ts` to call `injectHook(context)` after context creation when the flag is set. Without the flag, the hook is injected lazily on first `react-*` command (requires page reload to take effect).

**Files:** `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `BROWSE_REACT_DEVTOOLS=1` auto-injects hook on context creation
- [ ] Without the flag, hook injected lazily on first `react-*` command
- [ ] Lazy injection tells user "Hook injected. Reload the page or re-navigate for it to take effect."
- [ ] Hook injection survives context recreation (emulate, useragent changes)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-004: Integration tests

Test the React DevTools commands against a simple React page. Create a test fixture (`test/fixtures/react-app.html`) with inline React from CDN.

**Files:** `test/features.test.ts`, `test/fixtures/react-app.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `react-tree` on a React page returns component names
- [ ] Test: `react-tree` on a non-React page returns "No React detected"
- [ ] Test: `react-suspense` returns boundary status
- [ ] Test: `ensureHook()` downloads and caches the hook
- [ ] All existing tests still pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-003
**Priority:** P2

---

### TASK-005: Documentation

Update SKILL.md, README, CHANGELOG with React DevTools commands.

**Files:** `skill/SKILL.md`, `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] React commands documented in command reference
- [ ] `BROWSE_REACT_DEVTOOLS` env var documented
- [ ] CHANGELOG updated
- [ ] "When to Use What" table includes React debugging use case

**Agent:** general-purpose

**Depends on:** TASK-004
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| installHook.js download fails (network) | TASK-001 | Cache permanently after first download. Clear error with manual install instructions. |
| React version mismatch (old React, new hook) | TASK-001 | The hook is backward-compatible. React DevTools supports React 16+. |
| Hook not injected before page load | TASK-003 | Lazy mode tells user to reload. `BROWSE_REACT_DEVTOOLS=1` avoids this. |
| Non-React page queries fail | TASK-002 | Check for `__REACT_DEVTOOLS_GLOBAL_HOOK__` existence before querying. Return clear message. |
| Production React builds strip DevTools info | TASK-001 | Tree and suspense still work. Profiler needs React profiling build. Document this. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Lazy download + cache | TASK-004 | integration |
| Hook injection | TASK-004 | integration |
| Component tree query | TASK-004 | integration |
| Non-React page handling | TASK-004 | integration |
| Suspense boundary query | TASK-004 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-004"]
}
```
