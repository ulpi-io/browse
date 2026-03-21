# Plan: Persistent Browser Profiles

> Generated: 2026-03-21
> Branch: `feat/persistent-profiles`
> Mode: EXPANSION

## Overview

Add `--profile <name>` flag that launches Chromium with a persistent user data directory via Playwright's `launchPersistentContext()`. All browser state (cookies, localStorage, IndexedDB, cache, service workers) persists automatically between sessions. Mutually exclusive with `--session` (profiles own their Chromium, sessions share one).

## Scope Challenge

Existing code has two launch modes: `launch()` (own Chromium for single-session) and `launchWithBrowser()` (shared Chromium for sessions). We need a third: `launchPersistent(profileDir)` which uses `chromium.launchPersistentContext(userDataDir)`. This returns a `BrowserContext` directly (no `Browser` object), which changes the lifecycle slightly — `close()` must close the context which also closes the Chromium process.

Session multiplexing (`--session`) is incompatible because `launchPersistentContext()` creates exactly one context per Chromium. Users choose one or the other. Profile data lives in `.browse/profiles/<name>/`.

EXPANSION mode: full feature with profile management commands, validation, tests, docs.

## Architecture

```
CLI --profile mysite
      │
      ▼
  server.ts ────── TASK-003 (env var BROWSE_PROFILE, skip SessionManager)
      │
      ├── profile mode: chromium.launchPersistentContext(profileDir)  ←── TASK-002
      │     └── BrowserManager.launchPersistent(dir)  ←── TASK-001
      │
      └── session mode (existing): chromium.launch() → SessionManager
      │
  cli.ts ──────── TASK-004 (--profile flag, mutual exclusion with --session)
      │
  meta.ts ─────── TASK-005 (profile list/delete commands)
      │
  test/ ───────── TASK-006 (integration tests)
      │
  docs ────────── TASK-007 (SKILL.md, README, CHANGELOG)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Browser launch lifecycle | `src/browser-manager.ts` launch()/launchWithBrowser() | Extend — add launchPersistent() |
| Context creation | `src/browser-manager.ts` newContext() in launch() | Reuse — launchPersistentContext returns a context directly |
| Profile directory | `.browse/` local dir pattern | Extend — add `profiles/<name>/` subdirectory |
| CLI flag parsing | `src/cli.ts` --session extraction | Reuse pattern for --profile |
| Server routing | `src/server.ts` start() function | Extend — branch on BROWSE_PROFILE env var |
| Command dispatch | `src/server.ts` handleCommand() | Reuse as-is — works with any BrowserManager |
| Path sanitization | `src/sanitize.ts` sanitizeName() | Reuse for profile name validation |
| Profile listing | `src/commands/meta.ts` state list pattern | Reuse pattern |

## Tasks

### TASK-001: Add launchPersistent() to BrowserManager

Add a third launch mode to `src/browser-manager.ts` that uses `chromium.launchPersistentContext(userDataDir, options)`. This returns a `BrowserContext` directly — no `Browser` object. Store a flag `isPersistent` to adjust `close()` behavior.

Key difference from `launch()`:
- `launchPersistentContext()` returns `BrowserContext`, not `Browser`
- The context IS the browser — closing the context closes Chromium
- No `browser.newContext()` call needed
- The first page is auto-created by Playwright

```typescript
async launchPersistent(profileDir: string, onCrash?: () => void) {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1920, height: 1080 },
  });
  this.context = context;
  this.browser = context.browser()!;  // may be null for persistent contexts
  this.isPersistent = true;
  this.ownsBrowser = true;
  // Use existing pages or create one
  const pages = context.pages();
  if (pages.length > 0) {
    // Register existing page as tab
  } else {
    await this.newTab();
  }
}
```

Also update `close()` to handle persistent mode — closing the context is enough (it closes the browser too).

**Files:** `src/browser-manager.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `launchPersistent(dir)` creates a persistent context using `chromium.launchPersistentContext()`
- [ ] Existing pages from the profile are registered as tabs
- [ ] `close()` works correctly — closes context (which closes Chromium)
- [ ] `recreateContext()` (used by emulate/viewport) throws or handles persistent mode (can't recreate a persistent context)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Profile directory management

Create profile directories at `.browse/profiles/<name>/` using sanitizeName() for path safety. Add helper functions for listing and deleting profiles.

```typescript
// In a new section of browser-manager.ts or a small src/profiles.ts
function getProfileDir(localDir: string, name: string): string {
  return path.join(localDir, 'profiles', sanitizeName(name));
}
```

**Files:** `src/browser-manager.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] Profile directories are created at `.browse/profiles/<name>/`
- [ ] Profile names are sanitized via `sanitizeName()` (no path traversal)
- [ ] Invalid profile names (containing `/`, `..`) throw a clear error
- [ ] Profile directory persists between server restarts

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-003: Server profile mode — skip SessionManager

In `src/server.ts` `start()`, when `BROWSE_PROFILE` env var is set:
1. Create profile directory
2. Call `launchPersistentContext()` instead of `chromium.launch()`
3. Create a single `BrowserManager` with `launchPersistent(profileDir)` instead of a `SessionManager`
4. Route all commands to this single BrowserManager (no session multiplexing)

The `handleCommand()` function already accepts a `Session` — create a synthetic session object for profile mode.

**Files:** `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `BROWSE_PROFILE=mysite` starts server in profile mode with persistent context
- [ ] Session multiplexing is disabled — all commands go to the single profile BrowserManager
- [ ] State file records `profile: "mysite"` for debugging
- [ ] `BROWSE_PROFILE` and `--session` on the same command throws a clear error
- [ ] Server shuts down cleanly in profile mode

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001, TASK-002
**Priority:** P1

---

### TASK-004: CLI --profile flag

Add `--profile <name>` flag to `src/cli.ts`:
1. Extract `--profile` from args (same pattern as `--session`)
2. Validate mutual exclusion with `--session` — throw if both provided
3. Pass as `BROWSE_PROFILE` env var when spawning the server
4. Add to help text

**Files:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --profile mysite goto https://example.com` starts a profile-mode server
- [ ] `browse --profile mysite --session foo` throws error about mutual exclusion
- [ ] `BROWSE_PROFILE` env var works as alternative to `--profile` flag
- [ ] Help text documents `--profile <name>` with description

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-005: Profile management commands

Add `profile` meta command in `src/commands/meta.ts`:
- `profile list` — list all profiles in `.browse/profiles/` with size on disk
- `profile delete <name>` — delete a profile directory (with confirmation hint)
- `profile clean --older-than <days>` — remove profiles not used in N days

Also add `'profile'` to `META_COMMANDS` in `src/server.ts`.

**Files:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse profile list` shows all profiles with directory size
- [ ] `browse profile delete mysite` removes the profile directory
- [ ] `browse profile delete` with no name throws usage error
- [ ] `browse profile clean --older-than 30` removes old profiles
- [ ] Deleting a profile that's currently in use by a running server throws error

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002
**Priority:** P2

---

### TASK-006: Integration tests

Add tests for the persistent profile feature:
1. `launchPersistent()` creates a profile and persists state across restarts
2. Profile mode navigates, sets cookies, closes, relaunches — cookies still there
3. `--profile` and `--session` mutual exclusion
4. Profile list/delete commands
5. Invalid profile name handling

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: launchPersistent creates context, navigate works, cookies persist after close+relaunch
- [ ] Test: profile mode does not allow --session
- [ ] Test: profile list shows created profiles
- [ ] Test: profile delete removes directory
- [ ] Test: invalid profile name throws
- [ ] All existing tests still pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-003, TASK-004, TASK-005
**Priority:** P2

---

### TASK-007: Documentation

Update SKILL.md, README, CHANGELOG, ROADMAP:
- Add `--profile <name>` to CLI flags documentation
- Add profile commands to command reference
- Add "when to use profile vs session" guidance
- Move profiles from roadmap to done

**Files:** `skill/SKILL.md`, `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] `--profile` documented with usage examples
- [ ] Profile vs session trade-offs explained (memory, persistence, multiplexing)
- [ ] Profile commands (list/delete/clean) documented
- [ ] CHANGELOG updated

**Agent:** general-purpose

**Depends on:** TASK-006
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `launchPersistentContext()` returns no `Browser` object | TASK-001 | Use `context.browser()` which may return null — store context directly, don't depend on browser reference |
| `recreateContext()` breaks in profile mode (emulate/useragent) | TASK-001 | Throw clear error "Device emulation not supported in profile mode — use --session instead" or find workaround |
| Profile directory locked by running server | TASK-005 | Check for running server state file before allowing delete |
| Large profile directories (100MB+ cache) | TASK-005 | `profile list` shows size; `profile clean` has `--older-than` flag |
| User passes both `--profile` and `--session` | TASK-004 | Validate mutual exclusion early in CLI, before spawning server |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| launchPersistent() lifecycle | TASK-006 | integration |
| Cookie persistence across restarts | TASK-006 | integration |
| Profile mode server routing | TASK-006 | integration |
| --profile flag parsing + mutual exclusion | TASK-006 | integration |
| Profile list/delete commands | TASK-006 | integration |
| Invalid profile name validation | TASK-006 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": [],
  "TASK-005": ["TASK-002"],
  "TASK-006": ["TASK-003", "TASK-004", "TASK-005"],
  "TASK-007": ["TASK-006"]
}
```
