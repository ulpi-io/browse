# @ulpi/browse

**The headless browser CLI built for AI agents — not humans.**

When AI agents browse the web, the bottleneck isn't Chromium — it's **what gets dumped into the context window**. [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) sends the full accessibility snapshot on every navigate, click, and keystroke. On a real e-commerce page, that's **~16,000 tokens per action** — automatically, whether the agent needs it or not.

Ten actions and you've burned **159K tokens — 79% of a 200K context window** — just on browser output. That leaves almost nothing for the agent to actually think.

`@ulpi/browse` flips this. Navigation returns 11 tokens. Clicks return 15 tokens. The agent requests a page snapshot **only when it needs one** — and can filter to interactive elements only, cutting another 2-6x.

**Same 10 actions: 12K tokens. 6% of context. 13x less than @playwright/mcp.**

## Benchmarks (Measured)

Tested on 4 e-commerce sites (mumzworld, amazon, ebay, nike) across homepage, search results, and product detail pages ([raw data](BENCHMARKS.md)):

| Site | Page | @playwright/mcp navigate | browse snapshot -i | Reduction |
|------|------|-------------------------:|-------------------:|----------:|
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

And that's the per-snapshot comparison. The real gap is architectural — @playwright/mcp dumps a snapshot on every action (navigate, click, type). `browse` only returns ~15 tokens per action:

| | @playwright/mcp | @ulpi/browse |
|---|---:|---:|
| Tokens on `navigate` | ~14,578 (auto-dumped) | **~11** (one-liner) |
| Tokens on `click` | ~14,578 (auto-dumped) | **~15** (one-liner) |
| 10-action session | ~145,780 | **~11,511** |
| Context consumed (200K) | **73%** | **6%** |

The agent decides when to see the page. Most actions don't need a snapshot.

Rerun: `bun run benchmark`

## Why It's Faster

### 1. You Control What Enters the Context

```
@playwright/mcp browser_navigate → 51,150 tokens (full snapshot, every time)

browse goto    →     11 tokens  ("Navigated to https://... (200)")
browse text    →  4,970 tokens  (clean visible text, when you need it)
browse snap -i → 15,072 tokens  (interactive elements + refs, when you need it)
```

You pick the right view for the task. Reading prices? Use `text`. Need to click something? Use `snapshot -i`. Just navigating? `goto` is enough.

### 2. Ref-Based Interaction — No Selector Construction

After `snapshot`, every element gets a ref (`@e1`, `@e2`, ...) backed by a Playwright Locator. The agent doesn't waste tokens constructing CSS selectors:

```bash
$ browse snapshot -i
@e1 [button] "Help 24/7"
@e2 [link] "Mumzworld"
  @e3 [searchbox]
@e4 [link] "Sign In"
@e5 [link] "Cart"

$ browse fill @e3 "strollers"
Filled @e3

$ browse press Enter
Pressed Enter
```

### 3. Cursor-Interactive Detection — What ARIA Misses

Modern SPAs use `<div onclick>`, `cursor: pointer`, `tabindex`, and `data-action` for interactivity. These are **invisible** to accessibility trees — both @playwright/mcp and raw `ariaSnapshot()` miss them.

```bash
$ browse snapshot -i -C
@e1 [button] "Submit"
@e2 [textbox] "Email"

[cursor-interactive]
@e3 [div.card] "Add to cart" (cursor:pointer)
@e4 [span.close] "Close dialog" (onclick)
@e5 [div.menu] "Open Menu" (data-action)
```

Every detected element gets a ref. `browse click @e3` just works.

### 4. 40+ Purpose-Built Commands vs Generic Tools

@playwright/mcp has ~15 tools. For anything beyond navigate/click/type, you write JavaScript via `browser_evaluate`. `browse` has purpose-built commands that return structured, minimal output:

| Need | @playwright/mcp | browse |
|------|----------------|--------|
| Page text | `browser_evaluate` + custom JS | `text` |
| Form fields | `browser_evaluate` + custom JS | `forms` → structured JSON |
| All links | `browser_evaluate` + custom JS | `links` → `Text → URL` |
| Network log | Not available | `network` |
| Cookies | Not available | `cookies` |
| Performance | Not available | `perf` |
| Page diff | Not available | `diff <url1> <url2>` |
| Snapshot diff | Not available | `snapshot-diff` |
| Responsive screenshots | Not available | `responsive` |
| Device emulation | Not available | `emulate iphone` |

### 5. Persistent Daemon — 100ms Commands

```
First command:       ~2s  (server + Chromium startup, once)
Every command after: ~100-200ms  (HTTP to localhost)
```

@playwright/mcp starts a new browser per MCP session. `browse` keeps the server running across commands with auto-shutdown after 30 min idle. Crash recovery is built in — the CLI detects a dead server and restarts transparently.

### 6. Multi-Agent Session Isolation

Multiple AI agents share one Chromium process with fully isolated sessions:

```bash
browse --session agent-a goto https://mumzworld.com
browse --session agent-b goto https://amazon.com
# Each has its own tabs, refs, cookies, storage — no cross-talk
```

## Install

```bash
bun install -g @ulpi/browse
```

Requires [Bun](https://bun.sh). Chromium is installed automatically via Playwright.

## Real-World Example: E-Commerce Flow

Agent browses mumzworld.com — search, find a product, add to cart, checkout:

```bash
browse goto https://www.mumzworld.com
browse snapshot -i                    # find searchbox → @e3
browse fill @e3 "strollers"
browse press Enter

browse text                           # scan prices in results
browse goto "https://www.mumzworld.com/en/doona-infant-car-seat..."

browse snapshot -i                    # find Add to Cart → @e54
browse click @e54

browse snapshot -i -s "[role=dialog]" # scope to cart modal
browse click @e3                      # "View Cart"

browse snapshot -i                    # find Checkout → @e52
browse click @e52
```

**12 steps. ~15K tokens total.** With @playwright/mcp: **~190K tokens** for the same flow.

## Command Reference

### Navigation
`goto <url>` | `back` | `forward` | `reload` | `url`

### Content Extraction
`text` | `html [sel]` | `links` | `forms` | `accessibility`

### Interaction
`click <sel>` | `fill <sel> <val>` | `select <sel> <val>` | `hover <sel>` | `type <text>` | `press <key>` | `scroll [sel]` | `wait <sel>` | `viewport <WxH>`

### Snapshot & Refs
```
snapshot [-i] [-c] [-C] [-d N] [-s sel]
  -i    Interactive elements only (buttons, links, inputs)
  -c    Compact — remove empty structural nodes
  -C    Cursor-interactive — detect hidden clickable elements
  -d N  Limit tree depth
  -s    Scope to CSS selector
```
After snapshot, use `@e1`, `@e2`... as selectors in any command.

### Snapshot Diff
`snapshot-diff` — compare current page against last snapshot.

### Device Emulation
`emulate <device>` | `emulate reset` | `devices [filter]`

100+ devices: iPhone 12-17, Pixel 5-7, iPad, Galaxy, and all Playwright built-ins.

### Inspection
`js <expr>` | `eval <file>` | `css <sel> <prop>` | `attrs <sel>` | `state <sel>` | `console [--clear]` | `network [--clear]` | `cookies` | `storage [set <k> <v>]` | `perf`

### Visual
`screenshot [path]` | `screenshot --annotate` | `pdf [path]` | `responsive [prefix]`

### Compare
`diff <url1> <url2>` — text diff between two pages.

### Multi-Step
```bash
echo '[["goto","https://example.com"],["text"]]' | browse chain
```

### Tabs
`tabs` | `tab <id>` | `newtab [url]` | `closetab [id]`

### Sessions
`sessions` | `session-close <id>`

### Server Control
`status` | `cookie <n>=<v>` | `header <n>:<v>` | `useragent <str>` | `stop` | `restart`

## Architecture

```
browse [--session <id>] <command>
          │
          ▼
    CLI (thin HTTP client)
    X-Browse-Session: <id>
          │
          ▼
    Persistent server (localhost, auto-started)
          │
    SessionManager
    ├── Session "default" → BrowserContext + tabs + refs + buffers
    ├── Session "agent-a" → BrowserContext + tabs + refs + buffers
    └── Session "agent-b" → BrowserContext + tabs + refs + buffers
          │
          ▼
    Chromium (Playwright, headless, shared)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSE_PORT` | auto 9400-10400 | Fixed server port |
| `BROWSE_SESSION` | (none) | Default session ID for all commands |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle shutdown in ms |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log directory |

## Acknowledgments

Inspired by and originally derived from the `/browse` skill in [gstack](https://github.com/garrytan/gstack) by Garry Tan. The core architecture — persistent Chromium daemon, thin CLI client, ref-based element selection via ARIA snapshots — comes from gstack.

### Added beyond gstack

**New commands:**
- `emulate` / `devices` — device emulation with 100+ devices (iPhone, Pixel, iPad, custom descriptors)
- `snapshot -C` — cursor-interactive detection (cursor:pointer, onclick, tabindex, data-action)
- `snapshot-diff` — before/after comparison with ref-number stripping
- `dialog` / `dialog-accept` / `dialog-dismiss` — dialog handling with prompt value support
- `state` — element state inspection (visible, enabled, checked, focused, bounding box)
- `upload` — file upload to input elements
- `sessions` / `session-close` — multi-agent session multiplexing
- `screenshot --annotate` — numbered badge overlay with legend

**Architectural improvements:**
- Session multiplexing — multiple agents share one Chromium via isolated BrowserContexts
- Per-tab ref scoping — refs belong to the tab that created them, cross-tab usage throws clear error
- Per-tab snapshot baselines — `snapshot-diff` compares the correct baseline after tab switches
- Safe retry classification — read commands auto-retry after crash, write commands don't (prevents double form submissions)
- Concurrency-safe server spawning — file lock with stale detection prevents race conditions
- Network correlation via WeakMap — accurate request/response pairing even with duplicate URLs
- Content-Length based sizing — avoids reading response bodies into memory
- TreeWalker text extraction — `text` command never triggers MutationObservers
- Tab creation rollback — failed `newTab(url)` closes the page instead of leaving orphan tabs
- Context recreation with rollback — `emulate`/`useragent` preserve cookies and all tab URLs, rollback on failure
- Crash callback — server flushes buffers and cleans state file before exit

## License

MIT
