# Plan: React DevTools Integration

> Generated: 2026-03-22
> Branch: `feat/react-devtools`
> Mode: HOLD

## Overview

Add `react-devtools` meta command with subcommands for React inspection — component tree, props/state, suspense boundaries, error boundaries, hydration timing, render profiling. Uses React DevTools' `installHook.js` injected via `context.addInitScript()`. Lazy-downloaded on first `enable`.

## Scope Challenge

next-browser implements this pattern. We adapt: lazy download instead of vendoring, CLI subcommands instead of programmatic API. Core logic (hook injection + evaluate queries) is identical. No env var — purely on-demand via `react-devtools enable`.

HOLD mode: builds on existing `addInitScript` pattern, moderate scope (~4 tasks).

## Architecture

```
browse react-devtools enable
      |
      v
  src/react-devtools.ts ---- TASK-001 (lazy download + hook + all query functions)
      |
      +-- ensureHook()         -> download installHook.js to ~/.cache/browse/
      +-- injectHook(ctx)      -> context.addInitScript(hookScript) + reload
      +-- removeHook(bm)       -> clear init script + reload
      +-- getTree(page)        -> fiber tree walk
      +-- getProps(page, sel)  -> inspectElement
      +-- getSuspense(page)    -> suspense boundaries
      +-- getErrors(page)      -> error boundaries
      +-- getProfiler(page)    -> render timing
      +-- getHydration(page)   -> hydration timing/mismatches
      +-- getRenders(page)     -> what re-rendered
      +-- getOwners(page, sel) -> parent component chain
      +-- getContext(page, sel) -> consumed context values
      |
  src/commands/meta.ts ---- TASK-002 (react-devtools command + all subcommands)
  src/server.ts ----------- TASK-002 (add 'react-devtools' to META_COMMANDS)
      |
  test/ ------------------- TASK-003 (tests)
      |
  docs -------------------- TASK-004 (SKILL.md, README, CHANGELOG)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Init script injection | `src/browser-manager.ts` addInitScript | Reuse |
| Subcommand pattern | `src/commands/meta.ts` record/profile/auth | Reuse pattern |
| Page evaluate queries | `src/commands/read.ts` | Reuse |
| Cache directory | `~/.cache/browse/` | Reuse |
| Hook script API | `next-browser/src/tree.ts` + `src/suspense.ts` | Study + adapt |

## Tasks

### TASK-001: React DevTools module

Create `src/react-devtools.ts` with all functions:

**Setup:**
- `ensureHook()` -- Check `~/.cache/browse/react-devtools/installHook.js`. If missing, download from unpkg CDN. Cache permanently.
- `injectHook(context)` -- Read cached hook, `context.addInitScript(hookScript)`. Store flag on BrowserManager.
- `removeHook(bm)` -- Clear stored init script, reload page.
- `isEnabled(bm)` -- Check if hook is injected.

**Queries (all via `page.evaluate()` against `__REACT_DEVTOOLS_GLOBAL_HOOK__`):**
- `getTree(page)` -- Walk fiber tree, return formatted component tree. Study `next-browser/src/tree.ts:69-175`.
- `getProps(page, selector)` -- Find fiber matching selector, return props + state + hooks.
- `getSuspense(page)` -- Walk fiber tree for Suspense boundaries, return status.
- `getErrors(page)` -- Walk fiber tree for error boundaries, return caught errors.
- `getProfiler(page)` -- Read React performance timing entries.
- `getHydration(page)` -- Read hydration timing from React's Performance Track entries.
- `getRenders(page)` -- Track what re-rendered since last call.
- `getOwners(page, selector)` -- Walk fiber `_debugOwner` chain to root.
- `getContext(page, selector)` -- Read context values from fiber's dependencies.

All query functions return "React DevTools not enabled. Run 'browse react-devtools enable' first." if hook not injected.

**Files:** `src/react-devtools.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `ensureHook()` downloads and caches installHook.js
- [ ] `injectHook()` installs hook via `addInitScript()`
- [ ] `getTree()` returns formatted component tree on React pages
- [ ] `getTree()` returns "not enabled" when hook missing
- [ ] All queries return "No React detected" on non-React pages

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: react-devtools meta command with subcommands

Add `react-devtools` to `META_COMMANDS` in `src/server.ts`. Implement handler in `src/commands/meta.ts`:

```
browse react-devtools enable      -- download hook, inject, reload
browse react-devtools disable     -- remove hook, reload
browse react-devtools tree        -- component tree
browse react-devtools props @e3   -- props/state of component
browse react-devtools suspense    -- suspense boundaries + status
browse react-devtools errors      -- error boundaries + caught errors
browse react-devtools profiler    -- render timing per component
browse react-devtools hydration   -- hydration timing + mismatches
browse react-devtools renders     -- what re-rendered since last check
browse react-devtools owners @e3  -- parent component chain
browse react-devtools context @e3 -- context values consumed
```

**Files:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `react-devtools enable` downloads hook, injects, reloads
- [ ] `react-devtools disable` removes hook, reloads
- [ ] `react-devtools tree` returns component tree
- [ ] `react-devtools props @e3` returns props/state
- [ ] All subcommands error clearly when not enabled

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Integration tests

Test react-devtools commands against a React page fixture with inline React from CDN.

**Files:** `test/features.test.ts`, `test/fixtures/react-app.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] `react-devtools enable` injects hook successfully
- [ ] `react-devtools tree` on React page returns component names
- [ ] `react-devtools tree` without enable returns "not enabled" error
- [ ] `react-devtools tree` on non-React page returns "No React detected"
- [ ] `react-devtools disable` removes hook
- [ ] All existing tests pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002
**Priority:** P2

---

### TASK-004: Documentation

Update SKILL.md, README, CHANGELOG with react-devtools command and all subcommands.

**Files:** `skill/SKILL.md`, `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `react-devtools` documented with all subcommands
- [ ] CHANGELOG updated
- [ ] "When to Use What" table updated
- [ ] Quick reference example showing enable -> tree -> props flow

**Agent:** general-purpose

**Depends on:** TASK-003
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Download fails (network) | TASK-001 | Cache permanently. Clear error with manual fallback. |
| React version mismatch | TASK-001 | Hook supports React 16+. |
| Non-React page | TASK-002 | Check hook existence. Return "No React detected". |
| Production builds strip fiber info | TASK-001 | Tree/suspense work. Profiler needs profiling build. Document. |
| No reload after inject | TASK-002 | `enable` auto-reloads. |
| Multiple enable calls | TASK-002 | Idempotent -- second enable is no-op. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Lazy download + cache | TASK-003 | integration |
| Hook injection + reload | TASK-003 | integration |
| Component tree query | TASK-003 | integration |
| Non-React page handling | TASK-003 | integration |
| Enable/disable lifecycle | TASK-003 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-003"]
}
```
