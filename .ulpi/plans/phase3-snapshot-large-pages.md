# Plan: Phase 3 — Snapshot & Large Page Handling

> Generated: 2026-04-12
> Branch: `feat/snapshot-large-pages`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase2-real-web-browsing-quality, phase4-proxy-pool, phase5-concurrency-lifecycle, phase6-new-commands

## Overview

Add snapshot windowing/pagination, Google SERP fast-path extraction, and DOM image extraction to browse_cli. Snapshot windowing truncates ARIA snapshots exceeding 80K chars with offset-based pagination and preserves navigation/pagination links at the tail. Google SERP fast-path uses DOM-based extraction on google.com/search pages instead of ariaSnapshot for ~2x faster structured results. The images command lists page images with metadata and optional inline base64. All three features are runtime-agnostic (work with Playwright, Camoufox, or any BrowserTarget). Phase 3 of 6 in the camoufox integration roadmap.

## Scope Challenge

`handleSnapshot()` in `src/browser/snapshot.ts` returns a plain string from `ariaSnapshot()`. For large pages (search results, dashboards, long articles), this string can exceed 80K characters, overwhelming AI agent context windows. The windowing solution wraps the output post-render with offset-based pagination, preserving tail navigation links (~5K chars). This is a pure post-processing wrapper that does not touch the ref-map building or locator assignment — it operates on the final rendered string only.

The SERP fast-path short-circuits the snapshot path entirely when the URL matches `google.com/search`, returning structured DOM extraction instead of ARIA tree parsing. It does NOT populate the refMap, so it's a read-only fast path for content extraction.

The images command is a new read command following the existing registry pattern (register in `registry.ts`, implement in `read.ts`, wire via `registerReadDefinitions`).

## Prerequisites

- `handleSnapshot()` returns a rendered string and stores refMap via `bm.setRefMap()` (verified: `src/browser/snapshot.ts:547-549`)
- `handleSnapshot` is called from `inspection.ts` (meta command) and `action-context.ts` (finalize) (verified: `src/commands/meta/inspection.ts:49`, `src/automation/action-context.ts:397`)
- Command registry pattern supports adding new read commands with MCP schemas (verified: `src/automation/registry.ts:29-127`)
- `registerReadDefinitions()` wires registry specs to `handleReadCommand` dispatch (verified: `src/commands/read.ts:472-495`)
- `BrowserTarget` interface provides `getPage()` for DOM evaluation (verified: `src/browser/target.ts`)

## Non-Goals

- Proxy pool rotation (Phase 4)
- Consent dialog auto-dismiss (Phase 2)
- Google block detection and retry (Phase 2)
- Streaming snapshot output (would require HTTP response streaming)
- Snapshot caching/memoization across commands
- Server-side image compression or thumbnail generation
- SERP extraction for non-Google search engines (Bing, DuckDuckGo)
- Modifying the ref-map building or locator assignment logic

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Snapshot windowing -> callers | `snapshot-window.ts applySnapshotWindow()` | `inspection.ts handleInspectionCommand()`, `mcp/server.ts` | `{ text: string, truncated: boolean, totalChars: number, hasMore: boolean, nextOffset: number \| null }` | Windowing is applied AFTER handleSnapshot returns, at the command-handler level only. Full snapshot is always stored for delta comparison; only the returned text is windowed. Action context path (finalizeWriteContext) does NOT apply windowing -- it calls handleSnapshot directly and gets the full text. |
| SERP fast-path -> snapshot handler | `serp.ts extractGoogleSerp()` | `inspection.ts handleInspectionCommand('snapshot')` | `string \| null` — formatted SERP results or null on failure | SERP extraction does NOT populate refMap. Returns null on failure, triggering fallback to regular snapshot. |
| images command -> read handler | `handleReadCommand('images', args, bm, buffers)` | CLI / MCP / chain / flow | `string` — one line per image with src, alt, dimensions | Read-only, safe to retry, supports @ref scoping |

## Architecture

```
handleInspectionCommand('snapshot')          TASK-003 / TASK-004
  |
  +-- isGoogleSerp(url)?
  |     |
  |     YES --> extractGoogleSerp(page)      TASK-002
  |     |         |
  |     |         +-- null? --> fall through to handleSnapshot
  |     |         +-- text? --> return '[Google SERP fast-path]\n' + text
  |     |
  |     NO --> handleSnapshot(args, bm)      (returns FULL text)
  |              |
  |              +-- ariaSnapshot() --> parse --> build refs
  |              +-- bm.setLastSnapshot(FULL text)
  |              +-- bm.setRefMap(ALL refs)
  |
  +-- applySnapshotWindow(result)            TASK-001 / TASK-003
  |     (applied AFTER handleSnapshot, at command-handler level)
  |     |
  |     +-- under 80K? --> return unchanged
  |     +-- over 80K? --> truncate + tail + metadata

handleReadCommand('images')                  TASK-005
  |
  +-- page.evaluate() --> extract <img> elements
  +-- filter (no 1x1, no empty src)
  +-- format: src | alt | WxH
  +-- apply --limit N
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Snapshot output post-processing | `src/browser/snapshot.ts:547` — `output.join('\n')` render point | Wrap with windowing |
| SERP URL detection | `bm.getPage().url()` — available in all contexts | Reuse |
| DOM evaluation for extraction | `src/commands/read.ts:72-78` — links command pattern | Follow pattern |
| Command registration with MCP | `src/automation/registry.ts:29-127` — `r()` helper | Extend |
| Read command dispatch | `src/commands/read.ts:472-495` — `registerReadDefinitions()` | Extend |
| Barrel exports | `src/browser/index.ts` — re-exports modules | Extend |
| SERP extraction logic | `camofox-browser server.js:1132-1268` | Port (external) |
| Snapshot windowing logic | `camofox-browser lib/snapshot.js` (~40 lines) | Port (external) |

## Tasks

### TASK-001: Snapshot windowing module (`src/browser/snapshot-window.ts`)

Create a pure post-processing module that applies windowing to snapshot output strings. No Playwright imports, no side effects.

Export `applySnapshotWindow(text: string, opts?: WindowOpts): WindowResult` where:
- `WindowOpts`: `{ maxChars?: number (default 80000), offset?: number (default 0), tailReserve?: number (default 5000) }`
- `WindowResult`: `{ text: string, truncated: boolean, totalChars: number, hasMore: boolean, nextOffset: number | null }`

Logic:
1. If `text.length <= maxChars`, return unchanged with `truncated: false`
2. Otherwise, find the last complete line boundary before `offset + maxChars - tailReserve`
3. Extract tail section: scan backwards from end of `text` to find navigation/pagination-related lines (lines containing 'link', 'navigation', 'pagination', 'next', 'previous', 'page'). Reserve up to `tailReserve` chars for this tail.
4. Compose: `head portion + '\n[... truncated ...]\n' + tail portion`
5. Set `nextOffset = offset + headPortion.length`, `hasMore = nextOffset < totalChars`

Also export `formatWindowMetadata(result: WindowResult): string` helper that returns a single metadata line.

Update `src/browser/index.ts` barrel exports.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `applySnapshotWindow()` returns unchanged text with `truncated=false` when input is under 80K chars
- [ ] `applySnapshotWindow()` truncates at line boundary and includes tail navigation section when input exceeds 80K chars
- [ ] `WindowResult` metadata (`totalChars`, `hasMore`, `nextOffset`) is accurate for pagination
- [ ] Offset-based pagination: `applySnapshotWindow(text, { offset: 80000 })` returns the next page of content
- [ ] `formatWindowMetadata()` returns a single-line summary of truncation state

**Write Scope:** `src/browser/snapshot-window.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: Google SERP extraction module (`src/browser/serp.ts`)

Create a module that extracts structured search results from Google SERP pages via DOM evaluation.

Export `isGoogleSerp(url: string): boolean` — returns true if URL matches `google.com/search` or `google.XX/search` patterns.

Export `extractGoogleSerp(page: Page): Promise<string | null>` — runs `page.evaluate()` to extract:
1. Search results: title (h3), URL (a[href]), snippet
2. 'People also ask' section
3. Pagination links
4. Knowledge panel (if present)

Format as structured text with numbered results. Return `null` if zero results extracted.

Use multiple fallback selectors since Google frequently changes class names. Port from camofox-browser `server.js` extractGoogleSerp (lines 1132-1268), adapting from Playwright-Python to Playwright-Node API.

Update `src/browser/index.ts` barrel exports.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `isGoogleSerp()` correctly identifies google.com/search, google.co.uk/search, google.de/search URLs
- [ ] `isGoogleSerp()` returns false for non-Google URLs and google.com non-search pages
- [ ] `extractGoogleSerp()` returns formatted text with numbered results including title, URL, snippet
- [ ] `extractGoogleSerp()` returns null when no results are found
- [ ] `extractGoogleSerp()` includes 'People also ask' section when present

**Write Scope:** `src/browser/serp.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Wire snapshot windowing into snapshot command path

Integrate the snapshot windowing module into the snapshot command path. CRITICAL: windowing must NOT be applied inside `handleSnapshot()` itself -- it must be applied at the command-handler level only. `finalizeWriteContext()` (action-context.ts:397) calls `handleSnapshot()` for delta/full context; if windowing truncated the output there, it would corrupt context deltas and full snapshots for large pages.

1. **Parse new args in `parseSnapshotArgs`** (`src/browser/snapshot.ts`): Add `--offset N` and `--max-chars N` flags, producing new `SnapshotOptions` fields: `offset?: number`, `maxChars?: number`. `handleSnapshot()` returns the FULL snapshot text as before -- no windowing inside.

2. **Apply windowing at the command-handler level** (`src/commands/meta/inspection.ts`): In the snapshot case, after calling `handleSnapshot(args, bm)`, apply `applySnapshotWindow(result, { offset: opts.offset, maxChars: opts.maxChars })` to the returned text. If truncated, append the metadata line. This is the ONLY place windowing is applied. The full unwindowed snapshot is already stored by `handleSnapshot` via `bm.setLastSnapshot(rendered, args)` and `bm.setRefMap(refMap)` -- those remain unaffected.

3. **Action context path is explicitly safe**: `finalizeWriteContext()` calls `handleSnapshot()` directly and gets the full unwindowed text. No changes needed to `action-context.ts`. This is a hard invariant: action context must always see the complete snapshot for accurate delta computation.

4. **Update MCP schema in `registry.ts`**: Add `offset` and `maxChars` optional parameters to the snapshot command's MCP inputSchema.

5. **Also wire windowing in the MCP server path** (`src/mcp/server.ts`): The MCP server calls `handleSnapshot` and returns the result. Apply windowing after `handleSnapshot` returns, same as the `inspection.ts` path.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Snapshot command on a large page returns truncated output with metadata line when ARIA text exceeds 80K chars
- [ ] `snapshot --offset 80000` returns the next page of a large snapshot
- [ ] `bm.getLastSnapshot()` always returns the FULL unwindowed snapshot text (for delta comparison)
- [ ] `bm.getRefMap()` contains ALL refs from the full snapshot (not just the windowed portion)
- [ ] Action context (`finalizeWriteContext` -> `handleSnapshot`) always receives full unwindowed snapshot -- verified by checking that `handleSnapshot()` never calls `applySnapshotWindow()`

**Write Scope:** `src/browser/snapshot.ts`, `src/commands/meta/inspection.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Wire SERP fast-path into snapshot handler

Integrate the Google SERP extraction into `src/commands/meta/inspection.ts`.

**SAFETY: OPT-IN only (default OFF).** The SERP fast-path activates when `--serp` flag is passed in snapshot args OR `BROWSE_SERP_FASTPATH=1` env var is set. Without either, snapshot on Google pages uses the standard ARIA snapshot with refs — preserving backward compatibility.

In `handleInspectionCommand` case `'snapshot'` (line 48-49), before calling `handleSnapshot(args, bm)`:
1. Check if SERP enabled: args contain `--serp` OR `BROWSE_SERP_FASTPATH === '1'`
2. If enabled, get current URL, check `isGoogleSerp(url)`
3. If true AND no flags requiring refs (no `-C`, `--offset`), call `extractGoogleSerp(page)`
4. If non-null, return `'[Google SERP fast-path]\n' + result`
5. If not enabled or extraction fails, fall through to regular `handleSnapshot(args, bm)`

Add `BROWSE_SERP_FASTPATH` to `src/constants.ts` DEFAULTS (default `'0'`). Update MCP schema.

SERP fast-path does NOT populate refMap. Output is clearly marked so agents know @refs are unavailable.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Snapshot on Google WITHOUT `--serp` uses standard ARIA snapshot with refs (backward compatible, default)
- [ ] `snapshot --serp` on a Google search page returns SERP fast-path output prefixed with `[Google SERP fast-path]`
- [ ] `BROWSE_SERP_FASTPATH=1` enables SERP fast-path without `--serp` flag
- [ ] Failed SERP extraction falls back to regular snapshot silently
- [ ] SERP fast-path is NOT triggered during action-context delta/full

**Write Scope:** `src/commands/meta/inspection.ts`, `src/browser/snapshot.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Add `images` read command (`src/commands/read.ts` + registry)

Add a new `images` read command that lists `<img>` elements on the page with metadata.

1. **Register in `src/automation/registry.ts`**: Use `r()` helper with MCP schema — optional `selector`, `limit` (number, default 100), `inline` (boolean).

2. **Implement in `src/commands/read.ts`**: Add `'images'` case to `handleReadCommand` switch.
   - Parse args: optional selector/@ref, `--limit N`, `--inline`
   - `page.evaluate()` extracts: `{ src, alt, width, height, naturalWidth, naturalHeight, loading }`
   - Filter: no empty src, no data: placeholders < 100 bytes, no 1x1 tracking pixels
   - Format: `src | alt | WxH [naturalWxH]`
   - Apply limit (default 100)

Follow the pattern of the `links` command (line 72-78) for DOM evaluation and `count` command for @ref resolution.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse images` returns list of page images with src, alt, and dimensions
- [ ] `browse images --limit 5` caps output to 5 images
- [ ] `browse images <selector>` scopes extraction to elements within container
- [ ] `browse images @e3` resolves @ref and scopes to that container
- [ ] Tracking pixels (1x1) and empty-src images are filtered out
- [ ] images command is registered in registry as a read command with MCP schema

**Write Scope:** `src/commands/read.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-006: Tests for snapshot windowing, SERP extraction, images command

Add comprehensive tests for all Phase 3 features.

**Unit tests** (in `test/snapshot.test.ts`):
- `applySnapshotWindow()` — unchanged when under limit, truncates at line boundary, tail navigation preserved, metadata accurate, offset pagination, edge cases
- `isGoogleSerp()` — URL matching for various Google TLDs, false for non-Google
- `extractGoogleSerp()` — structured results from mock SERP HTML, null on non-SERP

**Integration tests** (in `test/snapshot.test.ts` and `test/commands.test.ts`):
- Snapshot windowing on large page fixture with truncation metadata
- Snapshot pagination via `--offset` flag
- Refs from windowed snapshot remain clickable
- SERP fast-path on Google SERP fixture
- `--no-serp` bypass
- Images command: extraction, `--limit`, selector scoping, tracking pixel filtering

**New fixtures** (in `test/fixtures/`):
- `large-snapshot.html` — page with >80K chars of accessible content
- `google-serp.html` — static mock of Google SERP DOM structure
- `images.html` — page with variety of images (normal, 1x1 pixel, no src, large)

Register new fixtures in `test/test-server.ts`.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All unit tests for `applySnapshotWindow()` pass including edge cases
- [ ] All unit tests for `isGoogleSerp()` and `extractGoogleSerp()` pass
- [ ] Integration test confirms snapshot windowing truncates large pages and pagination works
- [ ] Integration test confirms SERP fast-path activates on Google SERP fixture
- [ ] Integration test confirms images command extracts correct metadata from fixture
- [ ] All existing snapshot tests continue to pass (no regression)

**Write Scope:** `test/snapshot.test.ts`, `test/commands.test.ts`, `test/test-server.ts`, `test/fixtures/large-snapshot.html`, `test/fixtures/google-serp.html`, `test/fixtures/images.html`
**Validation:** `npm test`

**Depends on:** TASK-003, TASK-004, TASK-005
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Windowing splits ref line mid-string — agent sees @e42 but can't see @e50 | TASK-001, TASK-003 | Refs remain valid (refMap built from full snapshot). Metadata hint tells agent to use `--offset` for next page. |
| Google changes SERP DOM structure — extraction returns empty | TASK-002, TASK-004 | Falls back to regular snapshot when null returned. Multiple fallback selectors. Warning in output. |
| Action context finalizeWriteContext truncates delta baseline | TASK-003 | Action context path does NOT apply windowing. Full snapshot always stored via setLastSnapshot. |
| Images command on pages with hundreds of images — huge output | TASK-005 | Default limit of 100. Support `--limit N`. No inline base64 by default. |
| SERP fast-path skips refMap — agent tries `click @e3` after SERP snapshot | TASK-004 | Output marked `[Google SERP fast-path]`. Hint: 'Use snapshot -i for @refs.' Agent falls back to full snapshot. |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-003 = snapshot windowing works end-to-end on large pages
- **Full value:** All 6 tasks = windowing + SERP fast-path + images command + tests

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `applySnapshotWindow()` truncates at 80K chars with metadata | TASK-006 | unit |
| `applySnapshotWindow()` preserves tail navigation links | TASK-006 | unit |
| `applySnapshotWindow()` returns unchanged when under limit | TASK-006 | unit |
| Offset-based pagination returns correct slice | TASK-006 | unit |
| `isGoogleSerp()` URL matching | TASK-006 | unit |
| `extractGoogleSerp()` structured results from SERP HTML | TASK-006 | unit |
| `extractGoogleSerp()` returns null on non-Google pages | TASK-006 | unit |
| `handleSnapshot` with `--offset` returns paginated output | TASK-006 | integration |
| Snapshot on Google SERP page uses fast-path | TASK-006 | integration |
| Images command extracts metadata from page | TASK-006 | integration |
| Images `--limit` caps output | TASK-006 | integration |
| Images with @ref scoping | TASK-006 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 6 |
| Layer Count | 3 |
| Critical Path | TASK-001 -> TASK-003 -> TASK-006 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002, TASK-005 | Independent foundation: windowing module, SERP module, images command |
| 1 | TASK-003, TASK-004 | Wiring: windowing into snapshot, SERP into inspection |
| 2 | TASK-006 | Tests for all features |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002"],
  "TASK-005": [],
  "TASK-006": ["TASK-003", "TASK-004", "TASK-005"]
}
```
