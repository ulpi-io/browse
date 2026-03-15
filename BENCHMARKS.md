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
| amazon.com | Homepage | ~10,465 | ~2,151 | **5x** |
| amazon.com | Search | ~20,614 | ~3,454 | **6x** |
| ebay.com | Homepage | ~4,717 | ~1,565 | **3x** |
| ebay.com | Search | ~36,071 | ~7,118 | **5x** |
| ebay.com | PDP | ~1,297 | ~680 | **2x** |
| nike.com | Homepage | ~2,495 | ~816 | **3x** |
| nike.com | Search | ~7,998 | ~2,678 | **3x** |
| **TOTAL** | **10 pages** | **~158,739** | **~40,232** | **4x** |

`browse goto` alone costs ~10-25 tokens per navigation (one-liner confirmation). The agent requests a snapshot only when it needs to see the page.

## 10-Step Agent Session

A typical flow: navigate, snapshot, click, snapshot, fill, click, snapshot, check result.

| | @playwright/mcp | @ulpi/browse |
|---|---:|---:|
| Tokens per navigate/click/type | ~15,874 (auto-dumped) | ~15 (one-liner) |
| 10 actions total | ~158,740 | ~12,174 (3 snapshots + 7 actions) |
| Context consumed (200K window) | 79% | 6% |

## Raw Data

### mumzworld.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 199.8 KB | ~51,151 | Full snapshot auto-dumped |
| Playwright page.content() | 3.50 MB | ~917,743 | Raw HTML |
| browse goto | 44 B | ~11 | One-liner |
| browse text | 19.4 KB | ~4,970 | Clean visible text |
| browse snapshot | 159.5 KB | ~40,844 | Full tree + @refs |
| **browse snapshot -i** | **58.9 KB** | **~15,072** | **Interactive + @refs** |
| browse links | 62.2 KB | ~15,913 | Text → URL |
| browse forms | 213 B | ~53 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 54.1 KB | ~13,860 | Full snapshot auto-dumped |
| Playwright page.content() | 1.08 MB | ~283,752 | Raw HTML |
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
| Playwright page.content() | 1.48 MB | ~387,467 | Raw HTML |
| browse goto | 101 B | ~25 | One-liner |
| browse text | 6.9 KB | ~1,769 | Clean visible text |
| browse snapshot | 33.2 KB | ~8,510 | Full tree + @refs |
| **browse snapshot -i** | **12.0 KB** | **~3,084** | **Interactive + @refs** |
| browse links | 12.5 KB | ~3,203 | Text → URL |
| browse forms | 545 B | ~136 | Structured JSON |

### amazon.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 40.9 KB | ~10,465 | Full snapshot auto-dumped |
| Playwright page.content() | 580.5 KB | ~148,611 | Raw HTML |
| browse goto | 41 B | ~10 | One-liner |
| browse text | 4.7 KB | ~1,194 | Clean visible text |
| browse snapshot | 19.6 KB | ~5,011 | Full tree + @refs |
| **browse snapshot -i** | **8.4 KB** | **~2,151** | **Interactive + @refs** |
| browse links | 38.5 KB | ~9,852 | Text → URL |
| browse forms | 4.2 KB | ~1,075 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 80.5 KB | ~20,614 | Full snapshot auto-dumped |
| Playwright page.content() | 680.8 KB | ~174,277 | Raw HTML |
| browse goto | 59 B | ~15 | One-liner |
| browse text | 8.2 KB | ~2,090 | Clean visible text |
| browse snapshot | 27.6 KB | ~7,072 | Full tree + @refs |
| **browse snapshot -i** | **13.5 KB** | **~3,454** | **Interactive + @refs** |
| browse links | 48.4 KB | ~12,389 | Text → URL |
| browse forms | 5.4 KB | ~1,377 | Structured JSON |

### ebay.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 18.4 KB | ~4,717 | Full snapshot auto-dumped |
| Playwright page.content() | 1.71 MB | ~447,683 | Raw HTML |
| browse goto | 39 B | ~10 | One-liner |
| browse text | 4.9 KB | ~1,265 | Clean visible text |
| browse snapshot | 10.7 KB | ~2,738 | Full tree + @refs |
| **browse snapshot -i** | **6.1 KB** | **~1,565** | **Interactive + @refs** |
| browse links | 29.9 KB | ~7,648 | Text → URL |
| browse forms | 3.9 KB | ~1,006 | Structured JSON |

#### Search

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 140.9 KB | ~36,071 | Full snapshot auto-dumped |
| Playwright page.content() | 2.22 MB | ~583,148 | Raw HTML |
| browse goto | 69 B | ~17 | One-liner |
| browse text | 17.9 KB | ~4,574 | Clean visible text |
| browse snapshot | 57.8 KB | ~14,805 | Full tree + @refs |
| **browse snapshot -i** | **27.8 KB** | **~7,118** | **Interactive + @refs** |
| browse links | 62.0 KB | ~15,870 | Text → URL |
| browse forms | 4.4 KB | ~1,124 | Structured JSON |

#### PDP

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 5.1 KB | ~1,297 | Full snapshot auto-dumped |
| Playwright page.content() | 1.24 MB | ~325,023 | Raw HTML |
| browse goto | 56 B | ~14 | One-liner |
| browse text | 1.2 KB | ~315 | Clean visible text |
| browse snapshot | 3.4 KB | ~877 | Full tree + @refs |
| **browse snapshot -i** | **2.7 KB** | **~680** | **Interactive + @refs** |
| browse links | 7.6 KB | ~1,934 | Text → URL |
| browse forms | 3.9 KB | ~1,006 | Structured JSON |

### nike.com

#### Homepage

| Approach | Size | ~Tokens | Notes |
|----------|-----:|--------:|-------|
| @playwright/mcp navigate | 9.7 KB | ~2,495 | Full snapshot auto-dumped |
| Playwright page.content() | 700.4 KB | ~179,314 | Raw HTML |
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
| Playwright page.content() | 1.08 MB | ~282,584 | Raw HTML |
| browse goto | 57 B | ~14 | One-liner |
| browse text | 5.9 KB | ~1,502 | Clean visible text |
| browse snapshot | 16.3 KB | ~4,162 | Full tree + @refs |
| **browse snapshot -i** | **10.5 KB** | **~2,678** | **Interactive + @refs** |
| browse links | 26.6 KB | ~6,798 | Text → URL |
| browse forms | 291 B | ~73 | Structured JSON |

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
