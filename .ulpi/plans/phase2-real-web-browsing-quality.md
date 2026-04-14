# Plan: Phase 2 — Real-Web Browsing Quality

> Generated: 2026-04-12
> Branch: `feat/real-web-browsing-quality`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase3-snapshot-large-pages, phase4-proxy-pool, phase5-concurrency-lifecycle, phase6-new-commands

## Overview

Add six runtime-agnostic features that make browse_cli robust on real websites: consent dialog auto-dismiss (cookie banners), search engine macros (@google, @youtube, etc.), Google block/captcha detection, stale ref auto-refresh, click fallback chain (normal -> force -> mouse sequence), and page readiness enhancement (DOMContentLoaded + networkidle + hydration + rAF settle). All features work on every runtime (playwright, rebrowser, lightpanda, chrome, camoufox). Phase 2 of 6 in the camoufox integration roadmap.

## Scope Challenge

All six features integrate into the existing write command pipeline (`src/commands/write.ts`) and the browser domain (`src/browser/`). The goto handler (line 156) is the main integration point for 4 of 6 features: search macros expand the URL before navigation, page readiness runs after navigation, consent dismiss runs after readiness, and Google block detection runs after navigation to google.com. The click handler (line 182) is the integration point for 2 features: stale ref auto-refresh wraps resolveRef calls, and click fallback chain wraps the click itself.

Each feature is implemented as a standalone module in `src/browser/` first (P0 tasks), then wired into handlers (P1 tasks), keeping `write.ts` changes minimal and testable.

## Prerequisites

- Goto handler in `src/commands/write.ts` accepts BrowserTarget and returns navigation result (verified: line 156)
- Click handler supports both @ref and CSS selectors via `resolveRef()` (verified: line 182-211)
- `handleSnapshot()` rebuilds @ref map and returns ARIA tree text (verified: `src/browser/snapshot.ts`)
- `RefManager.resolveRef()` throws descriptive error when ref not found (verified: `src/browser/refs.ts:77`)
- Barrel exports in `src/browser/index.ts` allow clean imports from browser domain (verified)
- Test infrastructure supports HTML fixtures and BrowserManager integration tests (verified: `test/test-server.ts`)

## Non-Goals

- Proxy pool rotation (Phase 4)
- Snapshot windowing for large pages (Phase 3)
- Concurrency lifecycle improvements (Phase 5)
- New commands beyond what exists (Phase 6)
- CAPTCHA solving -- only detection + clear error reporting
- Auto-login to sites behind consent dialogs
- Custom consent dismiss selectors configurable by user (hardcoded ~20 selectors is sufficient)
- Search macros beyond the 14 defined (google, youtube, amazon, reddit, reddit_subreddit, wikipedia, twitter, yelp, spotify, netflix, linkedin, instagram, tiktok, twitch)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Search macros -> goto handler | `src/browser/macros.ts expandMacro(url)` | `src/commands/write.ts` goto case | `expandMacro(url: string): string \| null` -- expanded URL or null | Macro expansion runs BEFORE domain filter check. If non-null, goto uses expanded URL for both domain check and navigation. |
| Consent dismiss -> goto handler | `src/browser/consent.ts dismissConsentDialogs(page)` | `src/commands/write.ts` goto case (after nav) | `dismissConsentDialogs(page: Page): Promise<string \| null>` -- description or null | Best-effort: never throws, 2s hard timeout, never delays goto by more than 2s. Appends info to result if dismissed. |
| Google block detection -> goto + read | `src/browser/detection.ts detectGoogleBlock(page)` | `write.ts` goto, `read.ts` text, `inspection.ts` snapshot | `detectGoogleBlock(page: Page): Promise<{ blocked: boolean; reason: string } \| null>` | Returns null for non-Google URLs (fast path). When blocked, goto appends warning; text/snapshot prepend warning. |
| Stale ref auto-refresh -> write resolveRef | Inline retry in `write.ts` click/fill/hover | `handleSnapshot(['-i'], bm)` rebuilds refs | On ref-not-found: snapshot once, retry resolveRef. If retry fails, throw original. | At most once per command invocation. Only for @ref selectors. Uses `-i` flag for fast rebuild. |
| Click fallback chain -> click handler | Inline fallback in `write.ts` click case | `locator.click({force:true})` then `page.mouse` sequence | Normal (5s) -> force (3s) -> mouseover+mousedown+mouseup | Only for interception errors. Not-found errors skip fallback. Result indicates method used. |
| Page readiness -> goto handler | `src/browser/readiness.ts waitForPageReady(page)` | `src/commands/write.ts` goto case (after page.goto) | `waitForPageReady(page: Page, opts?): Promise<void>` | Best-effort: networkidle 2s soft timeout + rAF 100ms settle. Total max ~2.5s. Never throws. |

## Architecture

```
goto handler (write.ts:156)
  |
  |-- 1. expandMacro(url) ──────► macros.ts       TASK-001, TASK-004
  |       (expand @google -> URL)
  |
  |-- 2. domainFilter.isAllowed(expandedUrl)
  |
  |-- 3. page.goto(expandedUrl)
  |
  |-- 4. waitForPageReady(page) ──► readiness.ts   TASK-009
  |       (networkidle + rAF settle)
  |
  |-- 5. dismissConsentDialogs(page) ──► consent.ts  TASK-002, TASK-005
  |       (click cookie banner if present)
  |
  |-- 6. detectGoogleBlock(page) ──► detection.ts  TASK-003, TASK-006
  |       (warn if captcha page)
  |
  +-- return result


click handler (write.ts:182)
  |
  |-- 1. resolveRefWithAutoRefresh(sel, bm) ──────  TASK-007
  |       (rebuild refs once on stale @ref)
  |
  |-- 2. locator.click() ──────────────────────────  TASK-008
  |       |-- fallback: locator.click({force:true})
  |       +-- fallback: mouse.move + down + up
  |
  +-- return result


test/real-web.test.ts ──────────────────────────── TASK-010
  |-- unit: macros, detection
  |-- integration: consent, overlay click, stale ref, readiness
  +-- fixtures: consent-dialog.html, click-overlay.html, dynamic-refs.html
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Goto handler integration | `src/commands/write.ts:156-165` | extend |
| Click handler with @ref | `src/commands/write.ts:182-211` | extend |
| Fill handler with @ref | `src/commands/write.ts:213-236` | extend |
| Hover handler with @ref | `src/commands/write.ts:251-278` | extend |
| Ref resolution + error | `src/browser/refs.ts:62-89` | reuse |
| Snapshot rebuilds refs | `src/browser/snapshot.ts handleSnapshot()` | reuse |
| Browser domain barrel | `src/browser/index.ts` | extend |
| Test fixtures + shared BM | `test/test-server.ts, test/setup.ts` | extend |
| Consent selector list | camofox-browser server.js:1056-1099 | reuse (external) |
| Search macro templates | camofox-browser lib/macros.js | reuse (external) |
| Click fallback strategy | camofox-browser server.js:2036-2095 | adapt (external) |

## Tasks

### TASK-001: Search macros module

Create `src/browser/macros.ts` with a search macro registry and expansion function.

Exports:
- `SEARCH_MACROS`: Record mapping 14 macro names to URL templates with `{query}` placeholder (google, youtube, amazon, reddit, reddit_subreddit, wikipedia, twitter, yelp, spotify, netflix, linkedin, instagram, tiktok, twitch).
- `expandMacro(input: string): string | null` -- if input starts with `@<macro_name>` followed by space + query text, returns the expanded URL with the query URI-encoded. Returns null if no match.
- `listMacros(): string[]` -- sorted list of macro names.

Update barrel export in `src/browser/index.ts`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `expandMacro('@google test query')` returns `'https://www.google.com/search?q=test%20query'`
- [ ] `expandMacro('https://example.com')` returns null (not a macro)
- [ ] `listMacros()` returns array of 14 sorted macro names

**Write Scope:** `src/browser/macros.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Consent dialog dismiss module

Create `src/browser/consent.ts` with ~20 CSS selectors targeting common consent dialog accept/dismiss buttons (OneTrust, CookieBot, Quantcast, TrustArc, GDPR/CCPA banners, generic cookie buttons, text-based fallbacks).

Exports:
- `CONSENT_SELECTORS`: Array of selectors.
- `dismissConsentDialogs(page: Page): Promise<string | null>` -- iterates selectors, clicks first visible match, returns description or null. 2s hard timeout via Promise.race. Never throws.

Update barrel export in `src/browser/index.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `dismissConsentDialogs` returns description string when consent dialog is present
- [ ] `dismissConsentDialogs` returns null within <100ms on pages without consent dialogs
- [ ] `dismissConsentDialogs` never throws -- returns null on any error (timeout, selector failure)

**Write Scope:** `src/browser/consent.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Google block detection utility

Create `src/browser/detection.ts` with Google block/captcha detection.

Exports:
- `detectGoogleBlock(page: Page): Promise<{ blocked: boolean; reason: string } | null>` -- null for non-Google URLs (fast path). Checks URL pattern (/sorry/) + body text signals ('unusual traffic', 'captcha', 'not a robot'). Returns blocked info or `{ blocked: false }` for normal Google pages.
- `formatBlockWarning(info): string` -- actionable error with proxy suggestion.

Update barrel export in `src/browser/index.ts`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `detectGoogleBlock` returns null for non-Google URLs (fast path, no page evaluation)
- [ ] `detectGoogleBlock` returns `{ blocked: true }` when URL contains /sorry/ and body contains 'unusual traffic'
- [ ] `formatBlockWarning` returns actionable error message with proxy suggestion

**Write Scope:** `src/browser/detection.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-004: Wire search macros into goto handler

Import `expandMacro` in `src/commands/write.ts`. In goto case, before domain filter check, call `expandMacro(url)`. If non-null, use expanded URL for navigation. Update return message to show macro + expanded URL.

Also update goto MCP description in `src/automation/registry.ts` to mention macro support.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse goto '@google test query'` navigates to Google search URL
- [ ] `browse goto 'https://example.com'` works unchanged (expandMacro returns null)
- [ ] Domain filter check uses the expanded URL, not the raw @macro input

**Write Scope:** `src/commands/write.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-005: Wire consent dismiss as post-navigation hook

In goto case of `src/commands/write.ts`, after `page.goto()`, call `dismissConsentDialogs(page)`. Append dismissed info to result if non-null. Add `BROWSE_CONSENT_DISMISS` env var (default '1', set '0' to disable).

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] goto to a page with consent dialog auto-dismisses it and reports in output
- [ ] goto to a page without consent dialog completes within normal timeframe
- [ ] `BROWSE_CONSENT_DISMISS=0` disables consent dismiss entirely

**Write Scope:** `src/commands/write.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P1

---

### TASK-006: Wire Google block detection into goto and read commands

Wire `detectGoogleBlock` + `formatBlockWarning` into:
1. `src/commands/write.ts` goto case -- append warning after navigation
2. `src/commands/read.ts` text case -- prepend warning to text output
3. `src/commands/meta/inspection.ts` snapshot case -- prepend warning to snapshot output

Detection returns null immediately for non-Google URLs (negligible overhead).

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] goto to Google /sorry page includes block warning in output
- [ ] text command on Google /sorry page prepends block warning
- [ ] Non-Google pages have zero overhead from detection (null fast path)

**Write Scope:** `src/commands/write.ts`, `src/commands/read.ts`, `src/commands/meta/inspection.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-003
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-007: Stale ref auto-refresh in click/fill/hover handlers

Create `resolveRefWithAutoRefresh(selector, bm)` helper in `src/commands/write.ts`:
- Try `bm.resolveRef(selector)`
- On ref-not-found error for @ref selectors: call `handleSnapshot(['-i'], bm)` to rebuild, retry resolveRef
- At most one retry per invocation

Replace `bm.resolveRef()` calls in click (line 188), fill (line 219), hover (line 257) with the auto-refresh wrapper.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] click @e3 after page content changes auto-rebuilds refs and succeeds if element still exists
- [ ] click @e999 (truly nonexistent) fails with clear error after one auto-refresh attempt
- [ ] click with CSS selector bypasses auto-refresh entirely

**Write Scope:** `src/commands/write.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-008: Click fallback chain

Enhance click handler try/catch block (line 198-207) with three-step fallback. **SAFETY: OPT-IN only.** Fallback activates ONLY when `--force` flag is passed in click args OR `BROWSE_CLICK_FORCE=1` env var is set. Default behavior (no flag) throws existing overlay error unchanged.

1. **Normal click** (always): existing `locator.click({ timeout: ACTION_TIMEOUT_MS })`
2. **Force click** (only if `--force` or `BROWSE_CLICK_FORCE=1`): on interception error, retry `locator.click({ force: true, timeout: 3000 })`
3. **Mouse sequence** (only if force also fails AND force mode active): bounding box center, `mouse.move` -> `mouse.down` -> `mouse.up`

Without `--force`: interception/overlay errors throw unchanged (backward compatible).
Not-found or strict-mode errors always throw immediately regardless of flag.
Result message indicates method: normal, force, or mouse.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Click on obscured element WITHOUT `--force` throws existing overlay error (no fallback — backward compatible)
- [ ] Click on obscured element WITH `--force` succeeds via force click fallback
- [ ] Click on non-existent element throws immediately without fallback attempts
- [ ] Result message indicates which click method was used

**Write Scope:** `src/commands/write.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-009: Page readiness enhancement

Create `src/browser/readiness.ts`:
- `waitForPageReady(page, opts?)` -- networkidle (2s soft timeout) + rAF settle (100ms). Never throws.

Wire into goto handler in `src/commands/write.ts` after `page.goto()` and before consent dismiss.
Add `BROWSE_READINESS` env var (default '0' — opt-in only, set '1' to enable). Adds latency to every goto, so must not be on by default.

Update barrel export in `src/browser/index.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `waitForPageReady` completes within 200ms on simple static pages
- [ ] `waitForPageReady` completes within 2.5s max on pages with persistent connections
- [ ] `BROWSE_READINESS=0` skips readiness wait entirely

**Write Scope:** `src/browser/readiness.ts`, `src/browser/index.ts`, `src/commands/write.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-010: Integration tests for Phase 2 features

New test file `test/real-web.test.ts` with fixtures:
- `test/fixtures/consent-dialog.html` -- mock cookie consent banner
- `test/fixtures/click-overlay.html` -- button behind transparent overlay
- `test/fixtures/dynamic-refs.html` -- button text changes after 500ms (simulating hydration)

Test sections: macro unit tests (expansion, null paths, list), consent integration (fixture click, null on clean page), Google detection unit tests, stale ref integration (dynamic content + old ref), click overlay integration (force fallback), page readiness integration.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All unit tests pass: macro expansion, Google detection, block warning formatting
- [ ] All integration tests pass: consent dismiss on fixture, click overlay fallback, stale ref refresh
- [ ] Test for click on non-existent element verifies no fallback chain activation (failure case)

**Write Scope:** `test/real-web.test.ts`, `test/fixtures/consent-dialog.html`, `test/fixtures/click-overlay.html`
**Validation:** `npm test`

**Depends on:** TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Consent selectors match non-consent elements (false positive click) | TASK-002, TASK-005 | Scoped to known framework IDs/classes. 2s timeout prevents hanging. Test with fixture. |
| Search macro expansion conflicts with real URLs starting with @ | TASK-001, TASK-004 | Only expand for known macro names followed by space. Unknown @prefixes pass through. |
| Google block detection false positive on normal Google pages | TASK-003, TASK-006 | Require both URL signal (/sorry/) AND body text signal. Two signals needed. |
| Stale ref auto-refresh causes unexpected delay mid-action | TASK-007 | Uses -i flag (fast). At most once per command. 3s timeout on snapshot rebuild. |
| Click fallback causes double-click or unintended side effects | TASK-008 | Each step only on previous step's interception error. Mouse sequence uses separate down/up. |
| Page readiness networkidle wait causes 2s delay on persistent connections | TASK-009 | 2s soft timeout via race. rAF settle adds only ~100ms. Total bounded at ~2.5s. |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-004 (macros) + TASK-007 (stale ref) + TASK-008 (click fallback) = core interaction robustness without the quality-of-life features
- **Full value:** All 10 tasks = complete real-web browsing quality layer
- **Not shippable without Phase 3:** large page handling (snapshot windowing)

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `expandMacro('@google query')` returns URL | TASK-010 | unit |
| `expandMacro('https://...')` returns null | TASK-010 | unit |
| `dismissConsentDialogs` clicks OneTrust button | TASK-010 | integration |
| `dismissConsentDialogs` returns null on clean page | TASK-010 | integration |
| `detectGoogleBlock` identifies /sorry page | TASK-010 | unit |
| `detectGoogleBlock` returns null for non-Google | TASK-010 | unit |
| Stale ref auto-refresh on page change | TASK-010 | integration |
| Click fallback: force click on overlay | TASK-010 | integration |
| Page readiness rAF settle | TASK-010 | integration |
| goto @google navigates to search URL | TASK-010 | integration |
| Consent dismiss no-delay on clean page | TASK-010 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 10 |
| Layer Count | 3 |
| Critical Path | TASK-002 -> TASK-005 -> TASK-010 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002, TASK-003, TASK-007, TASK-008, TASK-009 | Independent modules: macros, consent, detection, stale ref, click fallback, readiness |
| 1 | TASK-004, TASK-005, TASK-006 | Wiring into handlers (each depends on its P0 module) |
| 2 | TASK-010 | Integration tests (depends on all wiring tasks) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": [],
  "TASK-004": ["TASK-001"],
  "TASK-005": ["TASK-002"],
  "TASK-006": ["TASK-003"],
  "TASK-007": [],
  "TASK-008": [],
  "TASK-009": [],
  "TASK-010": ["TASK-004", "TASK-005", "TASK-006", "TASK-007", "TASK-008", "TASK-009"]
}
```
