# Plan: Quick-Win Feature Parity

> Generated: 2026-03-21
> Branch: `feat/quick-wins`
> Mode: EXPANSION

## Overview

Close 27 feature gaps identified in `features-comparison.md` against agent-browser, gstack, and browser-use. All are S-effort Playwright API calls — 5-15 line case blocks in existing switch statements. No new modules, no architectural changes.

## Scope Challenge

Explored the codebase — every feature maps directly to an existing Playwright API and follows the exact same pattern as existing commands (resolveRef, case block, register in server.ts, update CLI help). The `scroll` command already does `scrollIntoViewIfNeeded` for selectors, so `scrollIntoView` is partially covered. `wait` already handles `--url` and `--network-idle`. All 27 features are truly independent S-effort additions. EXPANSION mode selected for per-feature granularity and independent agent execution.

## Architecture

```
src/commands/write.ts (TASK-001 through TASK-011)
├── rightclick, tap, swipe              ← new interaction commands
├── mouse move/down/up/wheel            ← new mouse subcommands
├── keyboard inserttext                 ← new keyboard subcommand
├── wait --text/--fn/--load/--state/ms  ← extend existing wait case
├── cookie clear + extended cookie set  ← extend existing cookie case
└── set geo, set media                  ← new settings subcommands

src/commands/read.ts (TASK-012 through TASK-014)
├── box <sel>                           ← new read command
├── errors [--clear]                    ← new read command (filter console buffer)
└── find alt/title/first/last/nth       ← extend existing find case

src/commands/meta.ts (TASK-015 through TASK-017)
├── screenshot <sel|@ref> [path]        ← extend screenshot case
├── screenshot --clip x,y,w,h          ← extend screenshot case
└── doctor                              ← new meta command

src/server.ts (touched by every task — registration)
src/cli.ts (touched by every task — help text, SAFE_TO_RETRY)

test/interactions.test.ts (TASK-018 through TASK-027)
test/fixtures/interactions.html (extended)
test/commands.test.ts (some tests)
test/features.test.ts (some tests)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Ref resolution for selectors | `bm.resolveRef()` in write.ts:77-82 | Reuse pattern |
| Frame context for scrolling | `bm.getFrameContext()` in write.ts:143 | Reuse pattern |
| Console buffer filtering | `read.ts:234-244` console case | Extend/filter for errors |
| Cookie setting | `write.ts:205-219` cookie case | Extend with options |
| Wait command | `write.ts:167-195` wait case | Extend with new flags |
| Find command | `meta.ts:735-774` find case | Extend with new types |
| Screenshot command | `meta.ts:233-308` screenshot case | Extend with selector/clip |
| Command registration | `server.ts:109-135` command sets | Add to existing sets |
| CLI help | `cli.ts:597-653` help text | Extend existing sections |
| Chain command sets | `meta.ts:364-365` READ_SET/WRITE_SET | Keep in sync |
| Test patterns | `test/interactions.test.ts` | Follow existing pattern |

## Tasks

### TASK-001: Add `rightclick` command

Add `rightclick <sel>` to `src/commands/write.ts`. Uses `locator.click({ button: 'right' })`. Follows existing `click` pattern with `resolveRef()`.

Register `'rightclick'` in `WRITE_COMMANDS` in `src/server.ts` and `WRITE_SET` in chain command (`src/commands/meta.ts`). Add to CLI help text in `src/cli.ts`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse rightclick <sel>` right-clicks the element
- [ ] `browse rightclick @e1` works with ref selectors
- [ ] `browse rightclick` with no args throws usage error

**Agent:** general-purpose

**Priority:** P1

---

### TASK-002: Add `tap` command

Add `tap <sel>` to `src/commands/write.ts`. Uses `locator.tap()`. Requires `hasTouch: true` on the BrowserContext (set by `emulate` device commands).

Register in `WRITE_COMMANDS`, `WRITE_SET` in chain, CLI help. Include note in error message if tap fails due to missing touch support.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse tap <sel>` taps the element when context has `hasTouch: true`
- [ ] `browse tap @e1` works with ref selectors
- [ ] Tap on non-touch context throws actionable error ("use emulate to enable touch")

**Agent:** general-purpose

**Priority:** P1

---

### TASK-003: Add `swipe` command

Add `swipe <dir> [px]` to `src/commands/write.ts`. Uses `page.touchscreen` API: `touchscreen.tap(cx, cy)` isn't enough — need `mouse.move` with touch simulation or `page.evaluate` with TouchEvent dispatch. Implementation: get viewport center, then `touchscreen.tap` at start, use `page.evaluate` to dispatch `touchstart` → `touchmove` → `touchend` sequence. Directions: `up`, `down`, `left`, `right`. Default distance: one viewport height/width.

Register in `WRITE_COMMANDS`, `WRITE_SET` in chain, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse swipe down` swipes down by one viewport height
- [ ] `browse swipe up 500` swipes up by 500px
- [ ] `browse swipe` with no direction throws usage error

**Agent:** general-purpose

**Priority:** P2

---

### TASK-004: Add `mouse` subcommands

Add `mouse move|down|up|wheel` to `src/commands/write.ts` as a new case block with sub-switch.

- `mouse move <x> <y>` → `page.mouse.move(x, y)`
- `mouse down [button]` → `page.mouse.down({ button })` (default: 'left')
- `mouse up [button]` → `page.mouse.up({ button })`
- `mouse wheel <dy> [dx]` → `page.mouse.wheel(dx, dy)`

Register `'mouse'` in `WRITE_COMMANDS`, `WRITE_SET` in chain, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse mouse move 100 200` moves cursor to (100, 200)
- [ ] `browse mouse wheel 300` scrolls down by 300px
- [ ] `browse mouse` with no subcommand throws usage error listing valid subcommands

**Agent:** general-purpose

**Priority:** P1

---

### TASK-005: Add `keyboard inserttext` command

Add `keyboard inserttext <text>` to `src/commands/write.ts`. Uses `page.keyboard.insertText(text)`. No key events — just inserts text at current cursor position.

Register `'keyboard'` in `WRITE_COMMANDS`, `WRITE_SET` in chain, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse keyboard inserttext "hello"` inserts text at cursor
- [ ] `browse keyboard` with no subcommand throws usage error
- [ ] `browse keyboard inserttext` with no text throws usage error

**Agent:** general-purpose

**Priority:** P2

---

### TASK-006: Extend `wait` with `--text`, `--fn`, `--load`, `--state hidden`, and millisecond wait

Extend the existing `wait` case in `src/commands/write.ts:167-195` with five new modes:

- `wait --text "Welcome"` → `page.waitForFunction(() => document.body.innerText.includes(text))`
- `wait --fn "window.ready === true"` → `page.waitForFunction(expr)`
- `wait --load networkidle|load|domcontentloaded` → `page.waitForLoadState(state)`
- `wait <sel> --state hidden` → `page.waitForSelector(sel, { state: 'hidden' })`
- `wait <ms>` (numeric arg) → `page.waitForTimeout(ms)`

Update CLI help text with new wait variants.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse wait --text "Hello"` waits for text to appear in page body
- [ ] `browse wait --fn "document.title === 'Done'"` waits for JS condition
- [ ] `browse wait --load domcontentloaded` waits for load state
- [ ] `browse wait #spinner --state hidden` waits for element to disappear
- [ ] `browse wait 2000` waits for 2 seconds
- [ ] `browse wait --text` with no text arg throws usage error

**Agent:** general-purpose

**Priority:** P0

---

### TASK-007: Extend `cookie` with `clear` and options

Extend the existing `cookie` case in `src/commands/write.ts:205-219`:

- `cookie clear` → `page.context().clearCookies()`
- `cookie set <name> <value> [--domain <d>] [--secure] [--expires <ts>] [--sameSite <s>]` → `page.context().addCookies([{ name, value, domain, secure, expires, sameSite }])`

The existing `cookie <n>=<v>` format continues to work unchanged.

Update CLI help text.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse cookie clear` clears all cookies
- [ ] `browse cookie set auth token123 --domain .example.com --secure` sets cookie with options
- [ ] Existing `browse cookie name=value` still works unchanged
- [ ] `browse cookie set` with missing name/value throws usage error

**Agent:** general-purpose

**Priority:** P1

---

### TASK-008: Add `set geo` subcommand

Add a `set` command with `geo` subcommand to `src/commands/write.ts`. New case `'set'` with sub-switch.

- `set geo <lat> <lng>` → `context.setGeolocation({ latitude, longitude })` + `context.grantPermissions(['geolocation'])`

Register `'set'` in `WRITE_COMMANDS`, `WRITE_SET` in chain, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse set geo 37.7749 -122.4194` sets geolocation to San Francisco
- [ ] `navigator.geolocation.getCurrentPosition` returns the set coordinates (verify via `browse js`)
- [ ] `browse set geo` with missing args throws usage error

**Agent:** general-purpose

**Priority:** P1

---

### TASK-009: Add `set media` subcommand

Extend the `set` command (from TASK-008) with `media` subcommand.

- `set media dark` → `context.emulateMedia({ colorScheme: 'dark' })`
- `set media light` → `context.emulateMedia({ colorScheme: 'light' })`
- `set media no-preference` → `context.emulateMedia({ colorScheme: 'no-preference' })`

Update CLI help text.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse set media dark` sets color scheme to dark
- [ ] `window.matchMedia('(prefers-color-scheme: dark)').matches` returns true (verify via `browse js`)
- [ ] `browse set media` with no value throws usage error listing valid values

**Agent:** general-purpose

**Depends on:** TASK-008
**Priority:** P1

---

### TASK-010: Add `--max-output` flag

Add `--max-output <n>` flag to `src/cli.ts` (extracted like `--json`) and pass as `X-Browse-Max-Output` header. In `src/server.ts`, after computing `result` (line ~300, before content boundaries and JSON wrapping): `if (maxOutput && result.length > maxOutput) result = result.slice(0, maxOutput) + '\n... (truncated at ' + maxOutput + ' chars)'`.

Also support `BROWSE_MAX_OUTPUT` env var.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --max-output 100 text` truncates output to 100 characters with truncation notice
- [ ] `BROWSE_MAX_OUTPUT=500` env var works as default
- [ ] Output shorter than limit is returned unchanged

**Agent:** general-purpose

**Priority:** P1

---

### TASK-011: Add `scrollinto` alias

Add `scrollinto <sel>` / `scrollintoview <sel>` as an explicit command aliased to the existing scroll-into-view behavior. Currently `scroll <sel>` does scrollIntoView, but having a dedicated command name improves discoverability.

Add both `'scrollinto'` and `'scrollintoview'` to `WRITE_COMMANDS` in server.ts. In `write.ts`, add case that falls through to the scroll selector path. Update CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse scrollinto #bottom-marker` scrolls element into view
- [ ] `browse scrollintoview @e1` works with refs
- [ ] `browse scrollinto` with no selector throws usage error

**Agent:** general-purpose

**Priority:** P2

---

### TASK-012: Add `box` read command

Add `box <sel>` to `src/commands/read.ts`. Uses `locator.boundingBox()` → returns JSON `{ x, y, width, height }`.

Register `'box'` in `READ_COMMANDS` in server.ts, `READ_SET` in chain, `SAFE_TO_RETRY` in cli.ts, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse box #highlight-target` returns JSON with x, y, width, height
- [ ] `browse box @e1` works with ref selectors
- [ ] `browse box` with no selector throws usage error
- [ ] Element not found returns clear error

**Agent:** general-purpose

**Priority:** P1

---

### TASK-013: Add `errors` read command

Add `errors [--clear]` to `src/commands/read.ts`. Filters the console buffer for entries where `level === 'error'`. Same pattern as `console` command but filtered.

Register `'errors'` in `READ_COMMANDS` in server.ts, `READ_SET` in chain, `SAFE_TO_RETRY` in cli.ts, CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse errors` returns only error-level console entries
- [ ] `browse errors --clear` clears error entries from buffer
- [ ] Returns `(no errors)` when console buffer has no error entries

**Agent:** general-purpose

**Priority:** P1

---

### TASK-014: Extend `find` with `alt`, `title`, `first`, `last`, `nth`

Extend the existing `find` case in `src/commands/meta.ts:735-774`:

- `find alt <text>` → `root.getByAltText(text)`
- `find title <text>` → `root.getByTitle(text)`
- `find first <sel>` → `page.locator(sel).first()` — report text content
- `find last <sel>` → `page.locator(sel).last()` — report text content
- `find nth <n> <sel>` → `page.locator(sel).nth(n)` — report text content

Update error message to include new types. Update CLI help.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse find alt "Logo"` finds elements by alt text
- [ ] `browse find title "Close"` finds elements by title attribute
- [ ] `browse find first .item` returns first match with text content
- [ ] `browse find nth 2 .item` returns third match (0-indexed)
- [ ] `browse find last .item` returns last match

**Agent:** general-purpose

**Priority:** P1

---

### TASK-015: Extend `screenshot` with element/ref support

Extend the screenshot case in `src/commands/meta.ts:233-308`. Detect if first arg is a selector or @ref (not a path): `@e` prefix = ref, `.`/`#`/`[` prefix = CSS selector. Use `locator.screenshot({ path })` instead of `page.screenshot()`.

Auto-detect logic: if arg starts with `@e`, `.`, `#`, `[`, or contains `:` — treat as selector. Otherwise treat as output path.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse screenshot @e1 shot.png` screenshots the ref element
- [ ] `browse screenshot "#header" header.png` screenshots element by CSS selector
- [ ] `browse screenshot page.png` still works as output path (no regression)
- [ ] `browse screenshot @e1` without path uses default screenshot path

**Agent:** general-purpose

**Priority:** P1

---

### TASK-016: Extend `screenshot` with `--clip` region

Extend the screenshot case in `src/commands/meta.ts:233-308`. Add `--clip x,y,w,h` flag. Parse comma-separated values, pass as `page.screenshot({ clip: { x, y, width, height } })`.

Mutual exclusion: `--clip` + selector throws error. `--clip` + `--full` throws error.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse screenshot --clip 0,0,400,300 region.png` captures the specified region
- [ ] `browse screenshot --clip 0,0,400,300` with no path uses default path
- [ ] `browse screenshot --clip` with invalid format throws usage error
- [ ] `browse screenshot --clip 0,0,400,300 --full` throws mutual exclusion error

**Agent:** general-purpose

**Priority:** P2

---

### TASK-017: Add `doctor` meta command

Add `doctor` to `src/commands/meta.ts`. Checks:
1. Bun version (`Bun.version`)
2. Playwright installed (try `import('playwright')`)
3. Chromium binary exists (check `chromium.executablePath()`)
4. Server health (already running → report port/pid)

Returns a checklist-style report. Register in `META_COMMANDS`, CLI help. Add to `SAFE_TO_RETRY`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse doctor` reports Bun version, Playwright status, Chromium path
- [ ] Missing Chromium shows actionable message ("run: bunx playwright install chromium")
- [ ] Command works even when server is not yet running

**Agent:** general-purpose

**Priority:** P2

---

### TASK-018: Test `rightclick` command

Add test in `test/interactions.test.ts`. Extend `test/fixtures/interactions.html` with a `contextmenu` event listener that sets text.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test right-clicks element and verifies contextmenu event fired
- [ ] Test verifies ref selector works with rightclick

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P2

---

### TASK-019: Test `mouse` subcommands

Add test in `test/interactions.test.ts`. Test `mouse move`, `mouse down`, `mouse up`, `mouse wheel` using JS event listeners to verify events fire.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test mouse move fires mousemove event at correct coordinates
- [ ] Test mouse wheel changes scroll position
- [ ] Test invalid subcommand throws error

**Agent:** general-purpose

**Depends on:** TASK-004
**Priority:** P2

---

### TASK-020: Test extended `wait` variants

Add test in `test/interactions.test.ts`. Test `wait --text`, `wait --fn`, `wait --load`, `wait <sel> --state hidden`, `wait <ms>`.

Use SPA fixture (`test/fixtures/spa.html`) which has delayed rendering for text/fn tests.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `wait --text` detects text appearing after delay
- [ ] Test `wait --fn` detects JS condition becoming true
- [ ] Test `wait 100` completes after ~100ms (not before)
- [ ] Test `wait <sel> --state hidden` detects element disappearing

**Agent:** general-purpose

**Depends on:** TASK-006
**Priority:** P2

---

### TASK-021: Test extended `cookie` commands

Add test in `test/commands.test.ts`. Test `cookie clear` and `cookie set` with options.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `cookie clear` removes all cookies (verify via `cookies` read command)
- [ ] Test `cookie set` with `--domain` applies correct domain
- [ ] Test existing `cookie name=value` still works

**Agent:** general-purpose

**Depends on:** TASK-007
**Priority:** P2

---

### TASK-022: Test `set geo` and `set media`

Add test in `test/features.test.ts`. Test geolocation and color scheme emulation using JS eval to verify.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `set geo` changes geolocation (verify via JS `navigator.geolocation`)
- [ ] Test `set media dark` changes color scheme (verify via JS `matchMedia`)

**Agent:** general-purpose

**Depends on:** TASK-008, TASK-009
**Priority:** P2

---

### TASK-023: Test `--max-output` flag

Add test in `test/features.test.ts`. Test truncation behavior on long output.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test output longer than limit is truncated with notice
- [ ] Test output shorter than limit is returned unchanged

**Agent:** general-purpose

**Depends on:** TASK-010
**Priority:** P2

---

### TASK-024: Test `box` read command

Add test in `test/commands.test.ts`. Test bounding box returns valid JSON with x, y, width, height.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `box` returns valid JSON with numeric x, y, width, height
- [ ] Test `box` with ref selector works
- [ ] Test `box` with nonexistent selector throws error

**Agent:** general-purpose

**Depends on:** TASK-012
**Priority:** P2

---

### TASK-025: Test `errors` read command

Add test in `test/commands.test.ts`. Use `js` command to trigger `console.error()`, then verify `errors` returns only error entries.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `errors` shows error-level messages after `console.error()` is triggered
- [ ] Test `errors` does not show `console.log()` messages
- [ ] Test `errors --clear` clears the error entries

**Agent:** general-purpose

**Depends on:** TASK-013
**Priority:** P2

---

### TASK-026: Test extended `find` command

Add test in `test/interactions.test.ts`. Extend `test/fixtures/interactions.html` with elements that have `alt`, `title` attributes. Test `find first/last/nth`.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `find alt` finds image by alt text
- [ ] Test `find title` finds element by title attribute
- [ ] Test `find first .item` returns first item
- [ ] Test `find nth 2 .item` returns third item
- [ ] Test `find last .item` returns last item

**Agent:** general-purpose

**Depends on:** TASK-014
**Priority:** P2

---

### TASK-027: Test extended `screenshot` (element + clip)

Add test in `test/features.test.ts`. Test element screenshot and clip screenshot produce valid PNG files.

**Type:** test
**Effort:** S

**Acceptance Criteria:**
- [ ] Test `screenshot #header shot.png` produces a PNG smaller than full page
- [ ] Test `screenshot --clip 0,0,100,100 clip.png` produces a 100x100 PNG
- [ ] Test `screenshot --clip` with `--full` throws error

**Agent:** general-purpose

**Depends on:** TASK-015, TASK-016
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `tap` fails on non-touch context | TASK-002 | Catch Playwright error, rewrite to actionable message suggesting `emulate` |
| `swipe` touch events not supported in headless | TASK-003 | Use `page.evaluate` to dispatch synthetic TouchEvents as fallback |
| `set geo` requires permission grant | TASK-008 | Call `context.grantPermissions(['geolocation'])` before `setGeolocation` |
| Screenshot selector detection false positive (path looks like selector) | TASK-015 | Use explicit heuristic: `@e`, `.`, `#`, `[` prefixes only. Paths with `/` or `.png`/`.jpg` extensions → path |
| `--clip` + `--annotate` interaction | TASK-016 | Allow clip + annotate (annotations are overlays, clip just crops) |
| `doctor` runs before server starts | TASK-017 | Make it a special case in CLI that doesn't require `ensureServer()` — or check lazily |
| Chain command sets out of sync | All | Update both `server.ts` sets AND `meta.ts` chain sets for every new command |
| `--max-output` truncates JSON mode output | TASK-010 | Apply truncation to the `data` field only, not the JSON wrapper |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| rightclick via locator.click({button:'right'}) | TASK-018 | integration |
| mouse move/down/up/wheel | TASK-019 | integration |
| wait --text/--fn/--load/--state/ms | TASK-020 | integration |
| cookie clear + cookie set with options | TASK-021 | integration |
| set geo + set media | TASK-022 | integration |
| --max-output truncation | TASK-023 | integration |
| box bounding box | TASK-024 | integration |
| errors console filter | TASK-025 | integration |
| find alt/title/first/last/nth | TASK-026 | integration |
| screenshot element/ref + clip | TASK-027 | integration |
| tap/swipe touch commands | (manual — requires touch context) | manual |
| keyboard inserttext | (covered by basic write test) | integration |
| scrollinto alias | (covered by existing scroll tests) | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": [],
  "TASK-004": [],
  "TASK-005": [],
  "TASK-006": [],
  "TASK-007": [],
  "TASK-008": [],
  "TASK-009": ["TASK-008"],
  "TASK-010": [],
  "TASK-011": [],
  "TASK-012": [],
  "TASK-013": [],
  "TASK-014": [],
  "TASK-015": [],
  "TASK-016": [],
  "TASK-017": [],
  "TASK-018": ["TASK-001"],
  "TASK-019": ["TASK-004"],
  "TASK-020": ["TASK-006"],
  "TASK-021": ["TASK-007"],
  "TASK-022": ["TASK-008", "TASK-009"],
  "TASK-023": ["TASK-010"],
  "TASK-024": ["TASK-012"],
  "TASK-025": ["TASK-013"],
  "TASK-026": ["TASK-014"],
  "TASK-027": ["TASK-015", "TASK-016"]
}
```
