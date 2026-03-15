# Benchmarks: @ulpi/browse vs Playwright MCP

Measured March 2026. Same machine, same Chromium, same pages.
3 e-commerce sites × 3 page types (Homepage, Search Results, Product Detail Page).

## What Gets Dumped Into the AI's Context Window

The key question: when an AI agent browses a page, **how many tokens** does the tool dump into the context?

### Playwright MCP (`@playwright/mcp`)

Every `browser_navigate`, `browser_click`, or `browser_type` call returns the **full accessibility snapshot** of the page — automatically, whether you need it or not.

### @ulpi/browse

`goto` returns a one-liner (`"Navigated to https://... (200)"`). The agent **chooses** what to request: `text`, `snapshot -i`, `links`, `forms`, etc.

## Results

### Per-Page Token Cost

```
Site                Page      PW MCP navigate  browse goto  browse snapshot -i   Ratio
─────────────────────────────────────────────────────────────────────────────────────────
mumzworld.com       Homepage       ~51,379          ~11          ~15,147          3.4x
mumzworld.com       Search         ~13,891          ~17           ~3,598          3.9x
mumzworld.com       PDP            ~10,076          ~25           ~3,074          3.3x
amazon.com          Homepage       ~10,426          ~10           ~2,137          4.9x
amazon.com          Search         ~21,016          ~15           ~3,543          5.9x
ebay.com            Homepage        ~4,608          ~10           ~1,536          3.0x
ebay.com            Search         ~26,377          ~17           ~7,010          3.8x
ebay.com            PDP             ~1,294          ~14             ~670          1.9x
─────────────────────────────────────────────────────────────────────────────────────────
TOTAL              8 pages       ~139,067         ~119          ~36,715          3.8x
```

**Playwright MCP dumps 3-6x more tokens per page than `browse snapshot -i`.**

But the real gap is bigger — Playwright MCP dumps the snapshot on **every action** (click, type, navigate). Browse only returns a snapshot when you ask for one.

### 10-Step Agent Session: Cumulative Token Cost

A typical flow: navigate → snapshot → click → snapshot → fill → click → snapshot → check result.

With Playwright MCP, every one of those 10 actions dumps a full snapshot:

```
Playwright MCP:  10 actions × ~17,383 avg tokens = ~173,830 tokens
browse:           3 gotos (~15 tok each) + 3 snapshots (~7,000 avg) + 4 actions (~15 tok each)
                = 45 + 21,000 + 60 = ~21,105 tokens
```

**~8x fewer tokens for the same session.**

### Raw Data: All Measurements

#### mumzworld.com — Homepage

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 200.7 KB | ~51,379 | Full snapshot auto-dumped |
| Playwright MCP snapshot | 200.6 KB | ~51,354 | Same data, requested explicitly |
| Playwright `page.content()` | 3.52 MB | ~922,919 | Raw HTML |
| browse goto | 44 B | ~11 | One-liner confirmation |
| browse text | 19.5 KB | ~4,991 | Clean visible text |
| browse snapshot (full) | 160.2 KB | ~41,010 | Full tree + @refs |
| **browse snapshot -i** | **59.2 KB** | **~15,147** | **Interactive only + @refs** |

#### mumzworld.com — Search Results ("strollers")

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 54.3 KB | ~13,891 | Full snapshot auto-dumped |
| Playwright `page.content()` | 1.08 MB | ~284,039 | Raw HTML |
| browse goto | 66 B | ~17 | One-liner |
| browse text | 6.6 KB | ~1,691 | |
| **browse snapshot -i** | **14.1 KB** | **~3,598** | **Interactive + @refs** |

#### mumzworld.com — Product Detail Page

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 39.4 KB | ~10,076 | Full snapshot auto-dumped |
| Playwright `page.content()` | 1.48 MB | ~387,428 | Raw HTML |
| browse goto | 101 B | ~25 | One-liner |
| browse text | 6.9 KB | ~1,763 | |
| **browse snapshot -i** | **12.0 KB** | **~3,074** | **Interactive + @refs** |

#### amazon.com — Homepage

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 40.7 KB | ~10,426 | Full snapshot auto-dumped |
| Playwright `page.content()` | 580.9 KB | ~148,706 | Raw HTML |
| browse goto | 41 B | ~10 | One-liner |
| browse text | 4.7 KB | ~1,192 | |
| **browse snapshot -i** | **8.3 KB** | **~2,137** | **Interactive + @refs** |

#### amazon.com — Search Results ("baby stroller")

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 82.1 KB | ~21,016 | Full snapshot auto-dumped |
| Playwright `page.content()` | 700.3 KB | ~179,283 | Raw HTML |
| browse goto | 59 B | ~15 | One-liner |
| browse text | 8.0 KB | ~2,059 | |
| **browse snapshot -i** | **13.8 KB** | **~3,543** | **Interactive + @refs** |

#### ebay.com — Homepage

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 18.0 KB | ~4,608 | Full snapshot auto-dumped |
| Playwright `page.content()` | 1.70 MB | ~446,096 | Raw HTML |
| browse goto | 39 B | ~10 | One-liner |
| browse text | 4.9 KB | ~1,247 | |
| **browse snapshot -i** | **6.0 KB** | **~1,536** | **Interactive + @refs** |

#### ebay.com — Search Results ("baby stroller")

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 103.0 KB | ~26,377 | Full snapshot auto-dumped |
| Playwright `page.content()` | 686.8 KB | ~175,811 | Raw HTML |
| browse goto | 69 B | ~17 | One-liner |
| browse text | 17.5 KB | ~4,484 | |
| **browse snapshot -i** | **27.4 KB** | **~7,010** | **Interactive + @refs** |

#### ebay.com — Product Detail Page

| Approach | Size | ~Tokens | Notes |
|----------|------|---------|-------|
| Playwright MCP navigate | 5.1 KB | ~1,294 | Full snapshot auto-dumped |
| Playwright `page.content()` | 1.07 MB | ~279,729 | Raw HTML |
| browse goto | 56 B | ~14 | One-liner |
| browse text | 1.2 KB | ~315 | |
| **browse snapshot -i** | **2.6 KB** | **~670** | **Interactive + @refs** |

## Architectural Differences

| | Playwright MCP | @ulpi/browse |
|---|---|---|
| **Navigate response** | Full snapshot (~10-50K tokens) | One-liner (~15 tokens) |
| **Click/type response** | Full snapshot (~10-50K tokens) | One-liner (~15 tokens) |
| **Agent controls output** | No — always gets full dump | Yes — requests what it needs |
| **Interactive-only filter** | No | `snapshot -i` |
| **Cursor-interactive detection** | No | `snapshot -C` (cursor:pointer, onclick, tabindex) |
| **Clean text extraction** | No — must use evaluate() | `text` command |
| **Form discovery** | No | `forms` command |
| **Link extraction** | No | `links` command |
| **Network/console logs** | console_messages only | `network` + `console` |
| **Performance timing** | No | `perf` command |
| **Cookies/storage** | No | `cookies` + `storage` |
| **Snapshot diff** | No | `snapshot-diff` |
| **Page text diff** | No | `diff <url1> <url2>` |
| **Responsive screenshots** | No | `responsive` (3 viewports at once) |
| **Persistent daemon** | No — new browser per session | Yes — ~100ms per command |
| **Crash recovery** | No | Auto-restart with safe retry |
| **Total commands** | ~15 tools | 40+ commands |

## Why This Matters

On a 200K-token context window, Playwright MCP's mumzworld homepage snapshot alone consumes **25% of the context**. Four navigations and the context is full.

With browse, 4 navigations + 4 snapshots = ~60K tokens — leaving 140K for the agent's actual reasoning.

## Methodology

- Token estimates: ~4 chars per token (standard approximation for mixed content)
- Playwright MCP behavior simulated by calling `ariaSnapshot()` after navigation (same as the MCP server does)
- Real Playwright MCP `browser_navigate` on mumzworld.com confirmed: 505,850 bytes returned to context
- All pages loaded with `waitUntil: 'domcontentloaded'` + 2s settle time
- Amazon PDP excluded (bot detection returned empty page on both tools)
- Measured March 2026, Playwright 1.58, Chromium headless
