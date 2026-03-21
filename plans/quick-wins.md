# Plan: Quick-Win Feature Parity

> Generated: 2026-03-21
> Branch: `feat/quick-wins`
> Mode: REDUCTION

## Overview

Close 30 feature gaps identified in `features-comparison.md` against agent-browser, gstack, and browser-use. All S-effort Playwright API calls. Batched by file to prevent merge conflicts during parallel agent execution.

## Scope Challenge

Explored the codebase — every feature maps directly to an existing Playwright API and follows the exact same pattern as existing commands (resolveRef, case block, register in server.ts, update CLI help). Original EXPANSION plan (27 per-feature tasks) was reviewed and REVISED: batch-by-file grouping eliminates merge conflicts since 15+ tasks all touch the same 3 files (write.ts, server.ts, cli.ts). Added ref staleness detection. Dropped numeric index refs (we use `@e5`). Merged `set geo` + `set media` into single task.

## Architecture

```
TASK-001: src/commands/write.ts + src/server.ts WRITE_COMMANDS + meta.ts WRITE_SET
├── rightclick, tap, swipe                  (new interaction commands)
├── mouse move|down|up|wheel                (new mouse subcommand block)
├── keyboard inserttext                     (new keyboard subcommand block)
├── scrollinto / scrollintoview             (alias for scroll <sel>)
├── set geo / set media                     (new set subcommand block)
├── wait --text/--fn/--load/--state/ms      (extend existing wait case)
├── cookie clear + cookie set with options  (extend existing cookie case)
└── cookie export/import file              (new: storageState → file, file → addCookies)

TASK-002: src/commands/read.ts + src/server.ts READ_COMMANDS + meta.ts READ_SET
├── box <sel>                               (new: locator.boundingBox())
└── errors [--clear]                        (new: filter console buffer for errors)

TASK-003: src/commands/meta.ts
├── find alt/title/first/last/nth           (extend existing find case)
├── screenshot <sel|@ref> [path]            (extend screenshot case)
├── screenshot --clip x,y,w,h              (extend screenshot case)
├── doctor                                  (new meta command)
└── upgrade                                 (new: npm update -g @ulpi/browse)

TASK-004: src/browser-manager.ts
└── Ref staleness detection                 (count check in resolveRef)

TASK-005: src/cli.ts + src/server.ts
├── --max-output <n> flag + truncation      (new CLI flag + server response)
├── SAFE_TO_RETRY updates                   (box, errors, doctor)
└── CLI help text updates                   (all new commands)

TASK-006: test/fixtures/interactions.html
└── New HTML elements for testing           (contextmenu, alt, title attrs)

TASK-007: test/interactions.test.ts
└── Tests for: rightclick, mouse, wait extensions, find extensions

TASK-008: test/commands.test.ts
└── Tests for: box, errors, cookie clear/set

TASK-009: test/features.test.ts
└── Tests for: set geo, set media, --max-output, screenshot element/clip, ref staleness
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Ref resolution for selectors | `bm.resolveRef()` in write.ts:77-82 | Reuse pattern |
| Frame context for scrolling | `bm.getFrameContext()` in write.ts:143 | Reuse pattern |
| Console buffer filtering | `read.ts:234-244` console case | Filter for errors |
| Cookie setting | `write.ts:205-219` cookie case | Extend with options |
| Wait command | `write.ts:167-195` wait case | Extend with new flags |
| Find command | `meta.ts:735-774` find case | Extend with new types |
| Screenshot command | `meta.ts:233-308` screenshot case | Extend with selector/clip |
| Command registration | `server.ts:109-135` command sets | Add to existing sets |
| Chain command sets | `meta.ts:364-365` READ_SET/WRITE_SET | Keep in sync |
| CLI help | `cli.ts:597-653` help text | Extend |
| Ref resolution | `browser-manager.ts:resolveRef()` | Add staleness check |

## Tasks

### TASK-001: Add all write commands (write.ts + server.ts registration + chain sets)

Add the following commands to `src/commands/write.ts`, register in `WRITE_COMMANDS` in `src/server.ts`, and add to `WRITE_SET` in `src/commands/meta.ts:364`:

**New commands:**
- `rightclick <sel>` — `locator.click({ button: 'right' })`. Same pattern as `click`.
- `tap <sel>` — `locator.tap()`. Requires `hasTouch` context. Catch error and suggest `emulate` if touch not enabled.
- `swipe <dir> [px]` — Directions: `up`, `down`, `left`, `right`. Get viewport center, use `page.touchscreen` API or `page.evaluate` with synthetic TouchEvent dispatch. Default distance: one viewport height/width.
- `mouse move|down|up|wheel` — New case with sub-switch. `move <x> <y>` → `page.mouse.move(x,y)`. `down [button]` → `page.mouse.down({button})`. `up [button]` → `page.mouse.up({button})`. `wheel <dy> [dx]` → `page.mouse.wheel(dx,dy)`.
- `keyboard inserttext <text>` — `page.keyboard.insertText(text)`. Different from `type` (no key events).
- `scrollinto <sel>` / `scrollintoview <sel>` — `locator.scrollIntoViewIfNeeded()`. Alias for existing `scroll <sel>` behavior but explicit command name.
- `set geo <lat> <lng>` — `context.setGeolocation({latitude,longitude})` + `context.grantPermissions(['geolocation'])`.
- `set media dark|light|no-preference` — `context.emulateMedia({ colorScheme })`.

**Extended commands:**
- `wait` — Add five new modes before the existing selector fallback:
  - `wait --text "Welcome"` → `page.waitForFunction(() => document.body.innerText.includes(text), {timeout})`
  - `wait --fn "expr"` → `page.waitForFunction(expr, {timeout})`
  - `wait --load networkidle|load|domcontentloaded` → `page.waitForLoadState(state, {timeout})`
  - `wait <sel> --state hidden` → `page.waitForSelector(sel, { state: 'hidden', timeout })`
  - `wait <ms>` (numeric first arg) → `page.waitForTimeout(ms)`
- `cookie` — Add before the existing `name=value` handler:
  - `cookie clear` → `page.context().clearCookies()`
  - `cookie set <name> <value> [--domain <d>] [--secure] [--expires <ts>] [--sameSite <s>]` → `page.context().addCookies([{...}])`
  - `cookie export <file>` → `const state = await page.context().storageState(); fs.writeFileSync(file, JSON.stringify(state.cookies, null, 2))`
  - `cookie import <file>` → `const cookies = JSON.parse(fs.readFileSync(file)); await page.context().addCookies(cookies)`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] All new commands return expected output format (e.g., "Right-clicked @e1", "Mouse moved to 100,200")
- [ ] All extended commands (wait, cookie) preserve backward compatibility with existing argument formats
- [ ] All new commands are registered in `WRITE_COMMANDS` (server.ts), `WRITE_SET` (meta.ts chain), and support `@ref` selectors where applicable
- [ ] `cookie export cookies.json` writes current cookies to file, `cookie import cookies.json` loads them back
- [ ] `tap` on non-touch context throws actionable error ("use emulate to enable touch")
- [ ] `wait --text` with no text arg, `mouse` with no subcommand, `set` with no subcommand — all throw usage errors
- [ ] `cookie clear` followed by `cookies` read returns empty

**Agent:** general-purpose

**Priority:** P1

---

### TASK-002: Add all read commands (read.ts + server.ts registration + chain sets)

Add to `src/commands/read.ts`, register in `READ_COMMANDS` in `src/server.ts`, and add to `READ_SET` in `src/commands/meta.ts:365`:

- `box <sel>` — Resolve ref or CSS selector. `locator.boundingBox()` → return JSON `{ x, y, width, height }`. Throw if element not found or not visible (null boundingBox).
- `errors [--clear]` — Filter `(buffers || bm.getBuffers()).consoleBuffer` for entries where `level === 'error'`. Same output format as `console` command. `--clear` removes error entries from buffer. Return `(no errors)` when empty.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse box #target` returns valid JSON with numeric x, y, width, height
- [ ] `browse box @e1` works with ref selectors
- [ ] `browse box` with no selector or nonexistent element throws clear error
- [ ] `browse errors` returns only error-level entries, not log/warn/info
- [ ] `browse errors --clear` clears error entries, subsequent `errors` returns `(no errors)`

**Agent:** general-purpose

**Priority:** P1

---

### TASK-003: Extend meta commands (meta.ts)

Modify `src/commands/meta.ts` only — no server.ts changes needed (find, screenshot, doctor already registered or will be registered by TASK-005).

**Extend `find` (meta.ts:735-774):**
- `find alt <text>` → `root.getByAltText(text)`. Count + first text content.
- `find title <text>` → `root.getByTitle(text)`. Count + first text content.
- `find first <sel>` → `page.locator(sel).first()`. Report count + first text content.
- `find last <sel>` → `page.locator(sel).last()`. Report count + last text content.
- `find nth <n> <sel>` → `page.locator(sel).nth(parseInt(n))`. Report text content.
- Update error message to include new types: `role|text|label|placeholder|testid|alt|title|first|last|nth`

**Extend `screenshot` (meta.ts:233-308):**
- Element/ref screenshot: detect if first arg is a selector (`@e` prefix, or starts with `.`, `#`, `[`). If selector, resolve via `bm.resolveRef()` or `page.locator()`, use `locator.screenshot({ path })`. If arg contains `/` or ends in `.png`/`.jpg`/`.webp` → treat as output path (existing behavior).
- `--clip x,y,w,h` flag: parse comma-separated values, pass as `page.screenshot({ clip: { x, y, width, height } })`. Mutual exclusion: `--clip` + element selector → error. `--clip` + `--full` → error.

**Add `doctor` command:**
- Report: Bun version (`Bun.version`), Playwright status (try import), Chromium path (try `chromium.executablePath()`), server running status.
- Register `'doctor'` in `META_COMMANDS` in server.ts (done by TASK-005).

**Add `upgrade` command:**
- Detect installation method: check if running from npm global (`which browse` resolves to a node_modules path) or compiled binary.
- npm: run `npm update -g @ulpi/browse` via `Bun.spawn` or `child_process.execSync`.
- Compiled binary: print message with download URL or suggest `npm install -g @ulpi/browse`.
- Register `'upgrade'` in `META_COMMANDS` in server.ts (done by TASK-005).

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse find alt "Logo"` finds elements by alt text, reports count
- [ ] `browse find first .item` returns first match text, `find last .item` returns last
- [ ] `browse find nth 2 .item` returns third element (0-indexed)
- [ ] `browse screenshot @e1 shot.png` screenshots just the ref element (PNG smaller than full page)
- [ ] `browse screenshot --clip 0,0,400,300 region.png` captures clipped region
- [ ] `browse upgrade` attempts to update the package
- [ ] `browse screenshot --clip ... --full` throws mutual exclusion error
- [ ] `browse doctor` reports Bun version and Chromium path
- [ ] Existing `find role|text|label|placeholder|testid` unchanged
- [ ] Existing `screenshot path.png` unchanged

**Agent:** general-purpose

**Priority:** P1

---

### TASK-004: Add ref staleness detection (browser-manager.ts)

Modify `resolveRef()` in `src/browser-manager.ts`. After looking up the ref in the map and getting the locator, add an async count check:

```typescript
const count = await locator.count();
if (count === 0) {
  throw new Error(`Ref ${ref} is stale (element no longer exists). Re-run 'snapshot' to get fresh refs.`);
}
```

This fails fast (~5ms) instead of waiting for Playwright's action timeout (5-30 seconds) when an SPA has mutated the DOM since the last snapshot.

Note: `resolveRef()` is currently synchronous (returns `{ locator }` or `{ selector }`). This change makes the ref path async. All callers already `await` the subsequent locator operations, but `resolveRef()` itself needs to become async, OR the count check can be done at the call site. Assess both approaches and pick the one with least caller disruption.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] Using a stale ref (after navigation or DOM change) throws immediately (~5ms) with message containing "stale" and "snapshot"
- [ ] Using a valid ref still works normally with no performance regression
- [ ] Error message is actionable: tells agent to re-run `snapshot`

**Agent:** general-purpose

**Priority:** P1

---

### TASK-005: CLI flags, registration, and help text (cli.ts + server.ts)

Modify `src/cli.ts` and `src/server.ts`:

**New CLI flag:**
- `--max-output <n>` — Extract before command (like `--json`). Pass as `X-Browse-Max-Output` header. Support `BROWSE_MAX_OUTPUT` env var and `browse.json` config.
- In `src/server.ts`, after computing `result` (around line 300, before content boundaries and JSON wrapping): if maxOutput is set and `result.length > maxOutput`, truncate: `result = result.slice(0, maxOutput) + '\n... (truncated at ' + maxOutput + ' chars)'`. Apply truncation to raw result only, not to JSON wrapper.

**Server registration (server.ts):**
- Add to `WRITE_COMMANDS`: `'rightclick'`, `'tap'`, `'swipe'`, `'mouse'`, `'keyboard'`, `'scrollinto'`, `'scrollintoview'`, `'set'`
- Add to `READ_COMMANDS`: `'box'`, `'errors'`
- Add to `META_COMMANDS`: `'doctor'`, `'upgrade'`

**SAFE_TO_RETRY (cli.ts):**
- Add: `'box'`, `'errors'`, `'doctor'`, `'upgrade'`

**CLI help text (cli.ts):**
- Add all new commands to appropriate sections
- Add `--max-output <n>` to options section
- Add snapshot flag note about `--max-output`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse --max-output 100 text` truncates output to 100 chars with truncation notice
- [ ] `BROWSE_MAX_OUTPUT=500` env var works as default
- [ ] Output shorter than limit is returned unchanged
- [ ] All new commands appear in `browse --help` output
- [ ] `box`, `errors`, `doctor` are in SAFE_TO_RETRY
- [ ] All new commands are registered in the correct command set

**Agent:** general-purpose

**Depends on:** TASK-001, TASK-002, TASK-003
**Priority:** P1

---

### TASK-006: Test fixtures

Extend `test/fixtures/interactions.html` with elements needed by test tasks:

- `<button id="ctx-btn" oncontextmenu="this.textContent='right-clicked'">Right Click Me</button>` — for rightclick test
- `<img id="alt-img" alt="Test Logo" src="" />` — for find alt test
- `<span id="title-span" title="Close Dialog">X</span>` — for find title test
- `<div id="mouse-tracker" onmousemove="this.dataset.x=event.clientX; this.dataset.y=event.clientY">Track</div>` — for mouse move test
- `<div id="error-trigger" onclick="console.error('test error')">Trigger Error</div>` — for errors test

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] All new elements render in the fixture page
- [ ] Event handlers fire correctly (verify manually or via existing test infrastructure)
- [ ] Existing fixture elements unchanged

**Agent:** general-purpose

**Priority:** P0

---

### TASK-007: Tests for write commands (test/interactions.test.ts)

Add tests in `test/interactions.test.ts` for all new write commands from TASK-001:

- `rightclick` — right-click element, verify contextmenu event fires (check text change on `#ctx-btn`)
- `mouse move` — move to coordinates, verify via `#mouse-tracker` dataset
- `mouse wheel` — scroll and verify `scrollY` changed
- `mouse` invalid subcommand — throws error
- `wait --text` — navigate to spa.html, verify text detection after delay
- `wait --fn` — verify JS condition detection
- `wait 100` — verify completes (timing not critical)
- `wait <sel> --state hidden` — hide element via JS, verify wait completes
- `tap` — verify tap on touch-enabled context (may need emulate first)
- `set geo` — set geolocation, verify via `js` eval of `navigator.geolocation`
- `set media dark` — verify via `js` eval of `matchMedia`
- `cookie clear` — set cookie, clear, verify empty via `cookies` read
- `cookie set` with `--domain` — verify cookie attributes

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All new write command tests pass
- [ ] No regressions in existing interaction tests
- [ ] At least one failure/edge case test (invalid subcommand, missing args)

**Agent:** general-purpose

**Depends on:** TASK-001, TASK-006
**Priority:** P2

---

### TASK-008: Tests for read commands (test/commands.test.ts)

Add tests in `test/commands.test.ts` for TASK-002 read commands:

- `box` — verify returns JSON with numeric x, y, width, height for visible element
- `box` with ref — snapshot first, then `box @e1`
- `box` with nonexistent selector — verify throws
- `errors` — trigger `console.error()` via `js`, verify `errors` returns only error entries
- `errors` — trigger `console.log()`, verify not in `errors` output
- `errors --clear` — verify clears error entries

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] `box` returns valid JSON with numeric values
- [ ] `errors` filters correctly (only error-level)
- [ ] `errors --clear` clears buffer
- [ ] No regressions in existing command tests

**Agent:** general-purpose

**Depends on:** TASK-002, TASK-006
**Priority:** P2

---

### TASK-009: Tests for meta commands and features (test/features.test.ts)

Add tests in `test/features.test.ts` for TASK-003, TASK-004, and TASK-005:

- `find alt` — find `#alt-img` by alt text "Test Logo"
- `find title` — find `#title-span` by title "Close Dialog"
- `find first .item` — returns first of 3 items
- `find last .item` — returns last of 3 items
- `find nth 1 .item` — returns second item (0-indexed)
- `screenshot @e1 <path>` — snapshot first, screenshot ref element, verify PNG exists and is smaller than full page screenshot
- `screenshot --clip 0,0,100,100 <path>` — verify produces PNG
- `screenshot --clip ... --full` — verify throws
- `--max-output` — get long page text, verify truncation with flag
- Ref staleness — navigate to page, snapshot, navigate away, try to use ref, verify fast failure with "stale" message
- `doctor` — verify returns Bun version info

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All find extension tests pass (alt, title, first, last, nth)
- [ ] Screenshot element/clip tests produce valid PNG files
- [ ] Ref staleness test fails fast (<1s) with actionable error
- [ ] --max-output truncation works correctly
- [ ] No regressions in existing feature tests

**Agent:** general-purpose

**Depends on:** TASK-003, TASK-004, TASK-005, TASK-006
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `tap` fails on non-touch context | TASK-001 | Catch Playwright error, rewrite to actionable message suggesting `emulate` |
| `swipe` touch events not supported in headless | TASK-001 | Use `page.evaluate` to dispatch synthetic TouchEvents as fallback |
| `set geo` requires permission grant | TASK-001 | Call `context.grantPermissions(['geolocation'])` before `setGeolocation` |
| Screenshot selector detection false positive (path looks like selector) | TASK-003 | Heuristic: `@e` prefix, `.`, `#`, `[` = selector. Contains `/` or ends `.png`/`.jpg`/`.webp` = path |
| `--clip` + `--annotate` interaction | TASK-003 | Allow clip + annotate (annotations are overlays, clip just crops) |
| `--max-output` truncates JSON mode output | TASK-005 | Apply truncation to raw result only, before JSON wrapping |
| `resolveRef` becomes async (staleness check) | TASK-004 | Assess caller impact — if too many callers, do count check at call site instead |
| Chain command sets out of sync | TASK-001, TASK-002 | Explicitly update `WRITE_SET`/`READ_SET` in meta.ts:364-365 in same task |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| rightclick via locator.click({button:'right'}) | TASK-007 | integration |
| mouse move/down/up/wheel | TASK-007 | integration |
| wait --text/--fn/--load/--state/ms | TASK-007 | integration |
| tap/swipe touch commands | TASK-007 | integration |
| set geo + set media | TASK-007 | integration |
| cookie clear + cookie set with options | TASK-007 | integration |
| box bounding box | TASK-008 | integration |
| errors console filter | TASK-008 | integration |
| find alt/title/first/last/nth | TASK-009 | integration |
| screenshot element/ref + clip | TASK-009 | integration |
| ref staleness detection | TASK-009 | integration |
| --max-output truncation | TASK-009 | integration |
| doctor command | TASK-009 | integration |
| keyboard inserttext | (covered by write command batch — manual verify) | manual |
| scrollinto alias | (covered by existing scroll tests — same code path) | existing |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": [],
  "TASK-004": [],
  "TASK-005": ["TASK-001", "TASK-002", "TASK-003"],
  "TASK-006": [],
  "TASK-007": ["TASK-001", "TASK-006"],
  "TASK-008": ["TASK-002", "TASK-006"],
  "TASK-009": ["TASK-003", "TASK-004", "TASK-005", "TASK-006"]
}
```
