# Plan: React DevTools Integration

> Generated: 2026-03-22
> Branch: `feat/react-devtools`
> Mode: HOLD

## Overview

Add `react-devtools` meta command with subcommands for React inspection — component tree, props/state, suspense boundaries, error boundaries, hydration timing, render profiling. Uses React DevTools' `installHook.js` injected via `context.addInitScript()`. Lazy-downloaded on first `enable`. Agents enable it when debugging React apps, disable when done.

## Scope Challenge

next-browser (`/Users/ciprian/work_cip/next-browser`) already implements this pattern:
- Vendors `extensions/react-devtools-chrome/build/installHook.js` (~50KB)
- Injects via `context.addInitScript(installHook)` before page JS runs
- Queries `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` via `page.evaluate()`
- No Chrome extension UI — purely programmatic

We adapt: lazy download instead of vendoring, CLI subcommands instead of programmatic API. No env var — purely on-demand via `react-devtools enable`.

HOLD mode: builds on existing `addInitScript` pattern. 5 tasks.

## Architecture

```
browse react-devtools enable
      │
      ▼
  src/react-devtools.ts
      │
      ├── TASK-001: ensureHook()    → download installHook.js to ~/.cache/browse/
      │             injectHook()   → context.addInitScript(hookScript)
      │             removeHook()   → clear flag
      │             isEnabled()    → check flag
      │
      ├── TASK-002: getTree(page)        → fiber tree walk
      │             getProps(page, sel)  → inspectElement
      │             getSuspense(page)    → suspense boundaries
      │             getErrors(page)      → error boundaries
      │             getProfiler(page)    → render timing
      │             getHydration(page)   → hydration timing
      │             getRenders(page)     → re-render tracking
      │             getOwners(page, sel) → parent chain
      │             getContext(page, sel)→ context values
      │
      ▼
  src/commands/meta.ts ──── TASK-003 (case 'react-devtools' with all subcommands)
  src/server.ts ─────────── TASK-003 (add to META_COMMANDS)
  src/cli.ts ────────────── TASK-003 (add to SAFE_TO_RETRY)
      │
  test/features.test.ts ─── TASK-004 (integration tests)
  test/fixtures/react-app.html
      │
  skill/SKILL.md ─────────── TASK-005 (docs)
  README.md
  CHANGELOG.md
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Init script injection | `src/browser-manager.ts:227` `setInitScript()` + `addInitScript()` | Reuse — same pattern for hook injection |
| Subcommand dispatch | `src/commands/meta.ts` `case 'record':`, `case 'profile':` | Reuse pattern — switch on `args[0]` |
| Page evaluate | `src/commands/read.ts` `case 'js':` | Reuse — `page.evaluate()` |
| Cache directory | `~/.cache/browse/` | Reuse directory |
| Hook API (fiber tree) | `next-browser/src/tree.ts:69-175` | Study + adapt |
| Hook API (suspense) | `next-browser/src/suspense.ts:736-740` | Study + adapt |
| Hook API (hydration) | `next-browser/src/browser.ts:308-393` | Study + adapt |
| BrowserManager flag | `src/browser-manager.ts` `isPersistent` pattern | Reuse — add `reactDevToolsEnabled` |

## Tasks

### TASK-001: Hook download + injection

Create `src/react-devtools.ts` with setup functions:

**`ensureHook()`:**
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'browse', 'react-devtools');
const HOOK_PATH = path.join(CACHE_DIR, 'installHook.js');
const HOOK_URL = 'https://unpkg.com/react-devtools-core@latest/dist/installHook.js';

export async function ensureHook(): Promise<string> {
  if (fs.existsSync(HOOK_PATH)) return fs.readFileSync(HOOK_PATH, 'utf8');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(HOOK_URL);
  if (!res.ok) throw new Error(
    `Failed to download React DevTools hook: ${res.status}.\n` +
    `Manual fallback: npm install -g react-devtools-core, then copy installHook.js to ${HOOK_PATH}`
  );
  const script = await res.text();
  fs.writeFileSync(HOOK_PATH, script);
  return script;
}
```

**`injectHook(bm: BrowserManager)`:**
- Get context via `bm.getContext()`
- Call `context.addInitScript(hookScript)`
- Set `bm.setReactDevToolsEnabled(true)`

**`removeHook(bm: BrowserManager)`:**
- Set `bm.setReactDevToolsEnabled(false)`
- Note: can't remove init scripts — takes effect on next navigation

**`isEnabled(bm: BrowserManager)`:**
- Return `bm.getReactDevToolsEnabled()`

Also add to `src/browser-manager.ts`:
- `private reactDevToolsEnabled = false`
- `getReactDevToolsEnabled()` / `setReactDevToolsEnabled()` accessors

**Files:** `src/react-devtools.ts` (create), `src/browser-manager.ts` (add flag)

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `ensureHook()` downloads installHook.js from unpkg on first call
- [ ] Second call uses cache (no network)
- [ ] `injectHook()` calls `context.addInitScript()` with hook script
- [ ] Download failure returns clear error with manual fallback
- [ ] `isEnabled()` returns correct state

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Query functions

Add query functions to `src/react-devtools.ts`. All use `page.evaluate()` against `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`.

**Reference implementation** (agent MUST read these for the API):
- `/Users/ciprian/work_cip/next-browser/src/tree.ts` lines 69-175 — fiber tree walk
- `/Users/ciprian/work_cip/next-browser/src/suspense.ts` lines 736-740 — renderer access
- `/Users/ciprian/work_cip/next-browser/src/browser.ts` lines 308-393 — hydration timing

**Key pattern:**
```typescript
// Inside page.evaluate():
const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (!hook) throw new Error("React DevTools hook not installed");
const ri = hook.rendererInterfaces?.values().next().value;
if (!ri) throw new Error("no React renderer attached");

// ri methods:
// ri.flushInitialOperations() — triggers fiber tree serialization
// ri.getDisplayNameForFiberID(id) — component name
// ri.inspectElement(rendererID, fiberID) — props, state, hooks
// ri.getOwnersList(fiberID) — parent chain
```

**Functions:**

1. `getTree(page)` — Indented component tree:
   ```
   App
     Layout
       Header
       Suspense (resolved)
         MainContent
       Footer
   ```

2. `getProps(page, selector)` — Props + state + hooks of component at DOM element

3. `getSuspense(page)` — All Suspense boundaries with status (resolved/pending/fallback)

4. `getErrors(page)` — Error boundaries + caught errors

5. `getProfiler(page)` — Render timing per component (requires profiling build)

6. `getHydration(page)` — Hydration timing from React Performance Track entries

7. `getRenders(page)` — What re-rendered since last call

8. `getOwners(page, selector)` — `_debugOwner` chain: `Button → Form → App`

9. `getContext(page, selector)` — Context values from fiber `dependencies`

**All functions must:**
- Check `isEnabled()` → "React DevTools not enabled. Run 'browse react-devtools enable' first."
- Check renderer exists → "No React detected on this page."
- Handle production builds gracefully

**Files:** `src/react-devtools.ts`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `getTree()` returns formatted component tree with indentation
- [ ] `getTree()` returns "not enabled" when hook missing
- [ ] `getTree()` returns "No React detected" on non-React pages
- [ ] `getProps()` returns props/state for a DOM element
- [ ] `getSuspense()` returns boundary status (resolved/pending)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-003: react-devtools meta command

Add `'react-devtools'` to `META_COMMANDS` in `src/server.ts`. Add to `SAFE_TO_RETRY` in `src/cli.ts`. Implement handler in `src/commands/meta.ts`:

```typescript
case 'react-devtools': {
  const sub = args[0];
  if (!sub) throw new Error(
    'Usage: browse react-devtools enable|disable|tree|props|suspense|errors|profiler|hydration|renders|owners|context'
  );
  const rd = await import('../react-devtools');
  switch (sub) {
    case 'enable': {
      const hookScript = await rd.ensureHook();
      const context = bm.getContext();
      if (!context) throw new Error('No browser context');
      await context.addInitScript(hookScript);
      bm.setReactDevToolsEnabled(true);
      await bm.getPage().reload();
      return 'React DevTools enabled. Page reloaded.';
    }
    case 'disable': {
      bm.setReactDevToolsEnabled(false);
      return 'React DevTools disabled. Takes effect on next navigation.';
    }
    case 'tree': return await rd.getTree(bm.getPage());
    case 'props': {
      if (!args[1]) throw new Error('Usage: browse react-devtools props <selector|@ref>');
      return await rd.getProps(bm.getPage(), args[1]);
    }
    case 'suspense': return await rd.getSuspense(bm.getPage());
    case 'errors': return await rd.getErrors(bm.getPage());
    case 'profiler': return await rd.getProfiler(bm.getPage());
    case 'hydration': return await rd.getHydration(bm.getPage());
    case 'renders': return await rd.getRenders(bm.getPage());
    case 'owners': {
      if (!args[1]) throw new Error('Usage: browse react-devtools owners <selector|@ref>');
      return await rd.getOwners(bm.getPage(), args[1]);
    }
    case 'context': {
      if (!args[1]) throw new Error('Usage: browse react-devtools context <selector|@ref>');
      return await rd.getContext(bm.getPage(), args[1]);
    }
    default:
      throw new Error('Unknown: ' + sub + '. Use: enable|disable|tree|props|suspense|errors|profiler|hydration|renders|owners|context');
  }
}
```

**Files:** `src/commands/meta.ts`, `src/server.ts`, `src/cli.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `react-devtools enable` downloads hook, injects, reloads page
- [ ] `react-devtools disable` clears flag, returns message
- [ ] `react-devtools tree` returns component tree after enable
- [ ] `react-devtools props @e3` returns props/state after enable
- [ ] All subcommands return clear error when not enabled
- [ ] Unknown subcommand returns usage with all options

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-002
**Priority:** P1

---

### TASK-004: Integration tests

Create `test/fixtures/react-app.html` with inline React 18:

```html
<!DOCTYPE html>
<html>
<head><title>React Test</title></head>
<body>
  <div id="root"></div>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script>
    const { useState, Suspense } = React;
    function App() {
      const [count, setCount] = useState(0);
      return React.createElement('div', null,
        React.createElement('h1', null, 'React Test App'),
        React.createElement('button', { onClick: () => setCount(c => c + 1) }, 'Count: ' + count),
        React.createElement(Suspense, { fallback: 'Loading...' },
          React.createElement('p', null, 'Content loaded')
        )
      );
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  </script>
</body>
</html>
```

Add tests in `test/features.test.ts`:

**Files:** `test/features.test.ts`, `test/fixtures/react-app.html`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `react-devtools enable` on React page succeeds
- [ ] Test: `react-devtools tree` returns component names (App, Suspense)
- [ ] Test: `react-devtools tree` without enable returns "not enabled" error
- [ ] Test: `react-devtools tree` on non-React page returns "No React detected"
- [ ] Test: `react-devtools disable` sets flag to false
- [ ] Test: `react-devtools props` with no selector throws usage error
- [ ] All existing tests pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-003
**Priority:** P2

---

### TASK-005: Documentation

**skill/SKILL.md:**
- Quick reference:
  ```bash
  # React debugging
  browse react-devtools enable
  browse react-devtools tree
  browse react-devtools props @e3
  browse react-devtools suspense
  browse react-devtools disable
  ```
- Command reference section for all 11 subcommands
- "When to Use What" entries:
  ```
  | Debug React components | react-devtools enable → tree → props @e3 |
  | Debug hydration issues | react-devtools enable → hydration |
  | Find suspense blockers | react-devtools enable → suspense |
  ```

**README.md:** Add to command reference section

**CHANGELOG.md:** Add v1.1.0 entry

**Files:** `skill/SKILL.md`, `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `react-devtools` documented with all 11 subcommands
- [ ] CHANGELOG has v1.1.0 entry
- [ ] "When to Use What" table has React debugging entries
- [ ] Quick reference shows enable → tree → props → disable flow

**Agent:** general-purpose

**Depends on:** TASK-004
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| unpkg CDN down or rate-limited | TASK-001 | Cache permanently after first download. Error includes manual fallback: `npm install -g react-devtools-core` |
| React version too old (<16) | TASK-002 | Hook supports React 16+. Return "React version not supported" if renderer interface missing |
| Non-React page (jQuery, vanilla) | TASK-002 | Check `__REACT_DEVTOOLS_GLOBAL_HOOK__` → "No React detected" |
| Production React build (minified) | TASK-002 | Tree still works. Props may show minified names. Profiler needs profiling build. Document. |
| Hook injected but page not reloaded | TASK-003 | `enable` auto-reloads. Subsequent navigations get hook automatically (init script persists). |
| Multiple `enable` calls | TASK-003 | Idempotent — second call is no-op: "React DevTools already enabled" |
| Test fixture React CDN unavailable | TASK-004 | Inline React dev build in fixture or accept network dependency in tests |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Hook download + cache | TASK-004 | integration |
| Hook injection via addInitScript | TASK-004 | integration |
| Component tree query (getTree) | TASK-004 | integration |
| Non-React page handling | TASK-004 | integration |
| Not-enabled error path | TASK-004 | integration |
| Enable/disable lifecycle | TASK-004 | integration |
| Props query (getProps) | TASK-004 | integration |
| Suspense query | TASK-004 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-003"],
  "TASK-005": ["TASK-004"]
}
```
