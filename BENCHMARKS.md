# Benchmarks: @ulpi/browse vs Raw Playwright

Measured on real websites, March 2026. Same machine, same Chromium, same pages.

## The Core Question

When an AI agent needs to understand a web page, what does it actually receive — and how many tokens does that cost?

## Results

### mumzworld.com (complex e-commerce, React SPA)

| Approach | Size | ~Tokens | Actionable? |
|----------|------|---------|-------------|
| Playwright `page.content()` | **1.2 MB** | **~415,000** | No — raw HTML with CSS classes, SVGs, tracking scripts |
| Playwright `body.innerText` | 2.4 KB | ~613 | No — plain text, can't interact with anything |
| Playwright `ariaSnapshot()` | 15.2 KB | ~3,902 | Partially — tree structure but no element refs |
| `browse text` | 2.5 KB | ~648 | No — clean visible text (no hidden elements) |
| `browse snapshot` | 13.2 KB | ~3,389 | **Yes** — full tree with @refs |
| **`browse snapshot -i`** | **5.4 KB** | **~1,379** | **Yes** — interactive elements with @refs |

**HTML → snapshot -i: 301x fewer tokens. Every element is clickable by ref.**

### news.ycombinator.com (classic server-rendered)

| Approach | Size | ~Tokens | Actionable? |
|----------|------|---------|-------------|
| Playwright `page.content()` | **34.3 KB** | **~11,696** | No |
| Playwright `body.innerText` | 3.9 KB | ~993 | No |
| Playwright `ariaSnapshot()` | 39.3 KB | ~10,073 | Partially |
| `browse text` | 3.8 KB | ~975 | No |
| `browse snapshot` | 28.5 KB | ~7,288 | **Yes** |
| **`browse snapshot -i`** | **9.4 KB** | **~2,405** | **Yes** |

**HTML → snapshot -i: 5x fewer tokens.**

Note: HN is a simple page with minimal CSS — the gap is smaller. On JS-heavy SPAs the savings are 50-300x.

### github.com/anthropics/claude-code (modern SPA)

| Approach | Size | ~Tokens | Actionable? |
|----------|------|---------|-------------|
| Playwright `page.content()` | **297.7 KB** | **~101,627** | No |
| Playwright `body.innerText` | 3.5 KB | ~890 | No |
| Playwright `ariaSnapshot()` | 15.0 KB | ~3,828 | Partially |
| `browse text` | 3.3 KB | ~843 | No |
| `browse snapshot` | 14.6 KB | ~3,737 | **Yes** |
| **`browse snapshot -i`** | **4.2 KB** | **~1,083** | **Yes** |

**HTML → snapshot -i: 94x fewer tokens.**

## What "Actionable" Means

With Playwright's `ariaSnapshot()`, you get a tree like:

```
- heading "Snapshot Test" [level=1]
- button "Submit"
- textbox "Username"
```

To click "Submit", you still need to construct a selector: `page.getByRole('button', { name: 'Submit' })`. If there are multiple buttons named "Submit", you need `nth()` disambiguation. The agent has to write code.

With `browse snapshot -i`, you get:

```
@e1 [heading] "Snapshot Test"
@e2 [button] "Submit"
@e3 [textbox] "Username"
```

To click "Submit": `browse click @e2`. Done. The ref maps to a pre-built Playwright Locator with nth() disambiguation already handled.

## What Playwright Misses Entirely

Modern SPAs use `<div>` elements with `cursor: pointer`, `onclick`, `tabindex`, or `data-action` attributes as interactive elements. These are **invisible to Playwright's accessibility APIs**.

`browse snapshot -i -C` catches them:

```
@e1 [button] "Submit"          ← ARIA catches this
@e2 [textbox] "Email"          ← ARIA catches this

[cursor-interactive]
@e3 [div.card] "Add to cart" (cursor:pointer)     ← ARIA misses this
@e4 [span.close] "Close" (onclick)                ← ARIA misses this
@e5 [div.tab] "Settings" (tabindex)               ← ARIA misses this
```

All of these are clickable via `browse click @e3` — the ref maps to the actual DOM element.

## Speed: Persistent Daemon vs Fresh Launch

Every raw Playwright script pays a startup tax:

| Operation | Time |
|-----------|------|
| `chromium.launch()` | ~800-1500ms |
| `browser.newContext()` | ~50ms |
| `context.newPage()` | ~50ms |
| **Total startup per script** | **~1-2s** |

With `browse`, the server starts once and stays running:

| Operation | Time |
|-----------|------|
| First command (server + Chromium start) | ~2-3s |
| Every subsequent command | **~100-200ms** |
| 20-command agent session total | ~4-6s |
| Same session with raw Playwright (20 launches) | ~20-40s |

## Cost at Scale

At Claude's pricing (~$3/M input tokens for Sonnet), the token savings translate directly to cost:

| Approach | Tokens per page | Cost per 1000 pages |
|----------|----------------|---------------------|
| Playwright `page.content()` (avg) | ~176,000 | **$0.53** |
| `browse snapshot -i` (avg) | ~1,622 | **$0.005** |

**~100x cost reduction per page load sent to the model.**

## Methodology

- Token estimates: ~3 chars/token for HTML, ~4 chars/token for plain text (conservative)
- All measurements on the same machine, same Chromium version (Playwright 1.58)
- Pages loaded with `waitUntil: 'domcontentloaded'`
- Measured March 2026
