# Benchmarks: @ulpi/browse vs @playwright/mcp

Measured 2026-03-15. Same machine, same Chromium, same pages.

## What Gets Dumped Into the AI Context

**@playwright/mcp**: Every `browser_navigate`, `browser_click`, or `browser_type` returns the **full accessibility snapshot** — automatically, whether you need it or not.

**@ulpi/browse**: `goto` returns a one-liner (`"Navigated to ... (200)"`). The agent **chooses** what to request: `text`, `snapshot -i`, `links`, `forms`, etc.

## Per-Page Token Cost

| Site | Page | @playwright/mcp navigate | browse snapshot -i | Ratio |
|------|------|-------------------------:|-------------------:|------:|
| mumzworld.com | Homepage | ~51,151 | ~15,072 | **3x** |
| mumzworld.com | Search | ~13,860 | ~3,614 | **4x** |
| mumzworld.com | PDP | ~10,071 | ~3,084 | **3x** |
| amazon.com | Homepage | ~10,431 | ~2,150 | **5x** |
| amazon.com | Search | ~19,458 | ~3,644 | **5x** |
| ebay.com | Homepage | ~4,641 | ~1,557 | **3x** |
| ebay.com | Search | ~35,929 | ~7,088 | **5x** |
| ebay.com | PDP | ~1,294 | ~678 | **2x** |
| nike.com | Homepage | ~2,495 | ~816 | **3x** |
| nike.com | Search | ~7,998 | ~2,678 | **3x** |
| nike.com | PDP | ~3,034 | ~989 | **3x** |
| **TOTAL** | **11 pages** | **~160,362** | **~41,370** | **4x** |

`browse goto` alone costs ~10-25 tokens per navigation (one-liner confirmation). The agent requests a snapshot only when it needs to see the page.

## 10-Step Agent Session

A typical flow: navigate, snapshot, click, snapshot, fill, click, snapshot, check result.

| | @playwright/mcp | @ulpi/browse |
|---|---:|---:|
| Tokens per navigate/click/type | ~14,578 (auto-dumped) | ~15 (one-liner) |
| 10 actions total | ~145,780 | ~11,388 (3 snapshots + 7 actions) |
| Context consumed (200K window) | 73% | 6% |

## Raw Data

### mumzworld.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 199.8 KB | ~51,151 | Full snapshot auto-dumped |
| Playwright page.content() | 3.50 MB | ~917,905 | Raw HTML |
| browse goto | 44 B | ~11 | One-liner |
| browse text | 19.4 KB | ~4,971 | Clean visible text |
| browse snapshot | 159.5 KB | ~40,844 | Full tree + @refs |
| **browse snapshot -i** | **58.9 KB** | **~15,072** | **Interactive + @refs** |
| browse links | 62.2 KB | ~15,913 | Text → URL |
| browse forms | 213 B | ~53 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 54.1 KB | ~13,860 | Full snapshot auto-dumped |
| Playwright page.content() | 1.08 MB | ~283,764 | Raw HTML |
| browse goto | 66 B | ~17 | One-liner |
| browse text | 6.6 KB | ~1,687 | Clean visible text |
| browse snapshot | 49.2 KB | ~12,585 | Full tree + @refs |
| **browse snapshot -i** | **14.1 KB** | **~3,614** | **Interactive + @refs** |
| browse links | 14.0 KB | ~3,587 | Text → URL |
| browse forms | 305 B | ~76 | Structured JSON |

#### PDP

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 39.3 KB | ~10,071 | Full snapshot auto-dumped |
| Playwright page.content() | 1.48 MB | ~387,614 | Raw HTML |
| browse goto | 101 B | ~25 | One-liner |
| browse text | 6.9 KB | ~1,767 | Clean visible text |
| browse snapshot | 33.2 KB | ~8,508 | Full tree + @refs |
| **browse snapshot -i** | **12.0 KB** | **~3,084** | **Interactive + @refs** |
| browse links | 12.5 KB | ~3,203 | Text → URL |
| browse forms | 545 B | ~136 | Structured JSON |

### amazon.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 40.7 KB | ~10,431 | Full snapshot auto-dumped |
| Playwright page.content() | 584.2 KB | ~149,544 | Raw HTML |
| browse goto | 41 B | ~10 | One-liner |
| browse text | 4.7 KB | ~1,192 | Clean visible text |
| browse snapshot | 19.6 KB | ~5,008 | Full tree + @refs |
| **browse snapshot -i** | **8.4 KB** | **~2,150** | **Interactive + @refs** |
| browse links | 38.5 KB | ~9,853 | Text → URL |
| browse forms | 4.2 KB | ~1,075 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 76.0 KB | ~19,458 | Full snapshot auto-dumped |
| Playwright page.content() | 673.5 KB | ~172,417 | Raw HTML |
| browse goto | 59 B | ~15 | One-liner |
| browse text | 8.1 KB | ~2,069 | Clean visible text |
| browse snapshot | 29.1 KB | ~7,446 | Full tree + @refs |
| **browse snapshot -i** | **14.2 KB** | **~3,644** | **Interactive + @refs** |
| browse links | 49.7 KB | ~12,712 | Text → URL |
| browse forms | 5.4 KB | ~1,377 | Structured JSON |

### ebay.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 18.1 KB | ~4,641 | Full snapshot auto-dumped |
| Playwright page.content() | 1.70 MB | ~445,637 | Raw HTML |
| browse goto | 39 B | ~10 | One-liner |
| browse text | 4.9 KB | ~1,245 | Clean visible text |
| browse snapshot | 10.6 KB | ~2,715 | Full tree + @refs |
| **browse snapshot -i** | **6.1 KB** | **~1,557** | **Interactive + @refs** |
| browse links | 29.4 KB | ~7,533 | Text → URL |
| browse forms | 3.9 KB | ~1,006 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 140.3 KB | ~35,929 | Full snapshot auto-dumped |
| Playwright page.content() | 1.26 MB | ~331,247 | Raw HTML |
| browse goto | 69 B | ~17 | One-liner |
| browse text | 17.7 KB | ~4,526 | Clean visible text |
| browse snapshot | 57.6 KB | ~14,750 | Full tree + @refs |
| **browse snapshot -i** | **27.7 KB** | **~7,088** | **Interactive + @refs** |
| browse links | 61.9 KB | ~15,851 | Text → URL |
| browse forms | 4.4 KB | ~1,124 | Structured JSON |

#### PDP

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 5.1 KB | ~1,294 | Full snapshot auto-dumped |
| Playwright page.content() | 1.07 MB | ~279,725 | Raw HTML |
| browse goto | 56 B | ~14 | One-liner |
| browse text | 1.2 KB | ~315 | Clean visible text |
| browse snapshot | 3.5 KB | ~889 | Full tree + @refs |
| **browse snapshot -i** | **2.6 KB** | **~678** | **Interactive + @refs** |
| browse links | 7.6 KB | ~1,934 | Text → URL |
| browse forms | 3.9 KB | ~1,006 | Structured JSON |

### nike.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 9.7 KB | ~2,495 | Full snapshot auto-dumped |
| Playwright page.content() | 700.4 KB | ~179,315 | Raw HTML |
| browse goto | 39 B | ~10 | One-liner |
| browse text | 2.4 KB | ~607 | Clean visible text |
| browse snapshot | 5.1 KB | ~1,315 | Full tree + @refs |
| **browse snapshot -i** | **3.2 KB** | **~816** | **Interactive + @refs** |
| browse links | 30.2 KB | ~7,744 | Text → URL |
| browse forms | 1.3 KB | ~341 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 31.2 KB | ~7,998 | Full snapshot auto-dumped |
| Playwright page.content() | 1.08 MB | ~282,582 | Raw HTML |
| browse goto | 57 B | ~14 | One-liner |
| browse text | 5.9 KB | ~1,502 | Clean visible text |
| browse snapshot | 16.2 KB | ~4,152 | Full tree + @refs |
| **browse snapshot -i** | **10.5 KB** | **~2,678** | **Interactive + @refs** |
| browse links | 26.6 KB | ~6,798 | Text → URL |
| browse forms | 291 B | ~73 | Structured JSON |

#### PDP

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 11.9 KB | ~3,034 | Full snapshot auto-dumped |
| Playwright page.content() | 972.4 KB | ~248,945 | Raw HTML |
| browse goto | 81 B | ~20 | One-liner |
| browse text | 5.1 KB | ~1,313 | Clean visible text |
| browse snapshot | 9.0 KB | ~2,314 | Full tree + @refs |
| **browse snapshot -i** | **3.9 KB** | **~989** | **Interactive + @refs** |
| browse links | 24.2 KB | ~6,205 | Text → URL |
| browse forms | 283 B | ~71 | Structured JSON |

## Architectural Differences

| | @playwright/mcp | @ulpi/browse |
|---|---|---|
| **Navigate response** | Full snapshot (~5-50K tokens) | One-liner (~15 tokens) |
| **Click/type response** | Full snapshot (~5-50K tokens) | One-liner (~15 tokens) |
| **Agent controls output** | No — always gets full dump | Yes — requests what it needs |
| **Interactive-only filter** | No | `snapshot -i` |
| **Cursor-interactive detection** | No | `snapshot -C` (cursor:pointer, onclick, tabindex) |
| **Clean text extraction** | No | `text` command |
| **Form discovery** | No | `forms` command |
| **Link extraction** | No | `links` command |
| **Network/console logs** | console_messages only | `network` + `console` |
| **Performance timing** | No | `perf` command |
| **Cookies/storage** | No | `cookies` + `storage` |
| **Snapshot diff** | No | `snapshot-diff` |
| **Page text diff** | No | `diff <url1> <url2>` |
| **Responsive screenshots** | No | `responsive` (3 viewports) |
| **Persistent daemon** | No — new browser per session | Yes — ~100ms per command |
| **Crash recovery** | No | Auto-restart with safe retry |
| **Total commands** | ~15 tools | 40+ commands |

## Methodology

- Token estimates: ~4 chars per token (standard approximation)
- @playwright/mcp: simulated by calling `ariaSnapshot()` after navigation (identical to what the MCP server does internally)
- All pages loaded with `waitUntil: domcontentloaded` + 2.5s settle
- Pages returning < 200 bytes excluded (bot detection)
- Measured 2026-03-15, Playwright 1.58.2, Chromium headless
- Rerun: `bun run benchmark.ts`
