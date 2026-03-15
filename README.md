# @ulpi/browse

**Give AI agents eyes and hands on the web — without burning tokens on raw HTML.**

Tools like [Playwright MCP](https://github.com/microsoft/playwright-mcp) dump the **full accessibility snapshot into the AI context on every action** — navigate, click, type. On a real e-commerce page, that's **~50,000 tokens per action**, whether the agent needs it or not. Four navigations and your context window is saturated.

`@ulpi/browse` gives the agent **control over what it sees**. Navigation returns a one-liner. The agent requests a snapshot only when needed — and can filter to interactive elements only, cutting tokens by another 3-4x.

## The Problem (Measured)

```
Action: Navigate to mumzworld.com homepage

Playwright MCP browser_navigate:   200.7 KB   ~51,379 tokens  (auto-dumped)
browse goto:                            44 B       ~11 tokens  (one-liner)
browse snapshot -i (when needed):   59.2 KB   ~15,147 tokens  (on demand)
```

**Playwright MCP dumps 3.4x more tokens than browse — and it does it on every single action.** Over a 10-step session, that's **~174K vs ~21K tokens** for the same work.

See [BENCHMARKS.md](BENCHMARKS.md) for full data across mumzworld, amazon, and ebay (homepage, search, PDP).

## What Makes This Different

### 1. Ref-Based Element Selection — No More CSS Selector Gymnastics

After a `snapshot`, every element gets a stable ref (`@e1`, `@e2`, ...) backed by a Playwright Locator. The agent doesn't need to construct fragile CSS selectors or XPaths — it just says `click @e3`.

```bash
$ browse snapshot -i
@e1 [button] "Help 24/7"
@e2 [link] "Mumzworld"
  @e3 [searchbox]
@e4 [link] "Sign In"
@e5 [link] "Cart"
      @e6 [link] "Sale"
      @e7 [link] "Gear"
      @e8 [link] "Toys"

$ browse fill @e3 "strollers"
Filled @e3

$ browse press Enter
Pressed Enter
```

No selectors. No DOM traversal. No guessing. The agent sees `@e3 [searchbox]`, fills it, done.

### 2. Cursor-Interactive Detection — Catch What ARIA Misses

Modern SPAs are full of `<div onclick="...">` and `<span style="cursor:pointer">` elements that are invisible to accessibility trees. The `-C` flag scans the DOM for these hidden interactive elements and gives them refs too:

```bash
$ browse snapshot -i -C
@e1 [button] "Submit"
@e2 [textbox] "Email"
@e3 [link] "Sign In"

[cursor-interactive]
@e4 [div.card] "Add to cart" (cursor:pointer)
@e5 [span.close] "Close dialog" (onclick)
@e6 [div.tab] "Custom Tab" (tabindex)
@e7 [div.menu] "Open Menu" (data-action)
```

The agent can now `click @e4` to add to cart — something raw Playwright accessibility APIs would miss entirely.

### 3. Persistent Daemon — 100ms Commands, Not 3-Second Browser Launches

Every Playwright script pays a ~2-3 second tax to launch Chromium. `browse` starts a persistent background server on first use and keeps it running. Every subsequent command is just an HTTP call to localhost:

```
First command:    ~2s  (server + Chromium startup)
Every command after: ~100-200ms  (HTTP to localhost)
Idle shutdown:    30 min (configurable)
```

For an agent running 20 browser commands in a session, that's **~40 seconds saved** vs launching a fresh browser each time.

### 4. Crash Recovery Without Agent Logic

Chromium crashed? Server died? The CLI detects it and auto-restarts transparently. The agent doesn't need try/catch/retry logic — it just works.

Write commands are **not** retried (to avoid double form submissions). Read commands retry automatically. The agent gets a clear error if recovery isn't possible.

### 5. Token-Efficient Output Across All Commands

Every command is designed to return **structured, minimal output** — not raw browser dumps:

| What you need | Playwright MCP | `browse` | Difference |
|---------------|----------------|----------|------------|
| Navigate to page | Auto-dumps ~50K tokens | `goto` → ~11 tokens | **Agent controls when to snapshot** |
| Click a button | Auto-dumps ~50K tokens | `click @e3` → ~15 tokens | **No snapshot on actions** |
| Interactive elements | Full tree, no filter | `snapshot -i` → interactive only | **3-6x fewer tokens** |
| Hidden clickable divs | Not detected | `snapshot -C` detects them | **Catches what ARIA misses** |
| Clean page text | Not available | `text` → visible text only | **Purpose-built command** |
| Form fields | Not available | `forms` → structured JSON | **Purpose-built command** |
| Network log | Not available | `network` → one-liner per request | **Purpose-built command** |
| Snapshot diff | Not available | `snapshot-diff` | **Before/after comparison** |
| Crash recovery | None | Auto-restart + safe retry | **Built-in resilience** |

## Install

```bash
bun install -g @ulpi/browse
```

Requires [Bun](https://bun.sh). Chromium is installed automatically via Playwright.

## Real-World Example: E-Commerce Flow

Here's an agent browsing mumzworld.com — search, find a product, add to cart, checkout:

```bash
# Navigate and search
browse goto https://www.mumzworld.com
browse snapshot -i                    # find the searchbox → @e3
browse fill @e3 "strollers"
browse press Enter

# Find the right product (1,400 AED stroller)
browse text                           # scan prices in results
browse goto "https://www.mumzworld.com/en/doona-infant-car-seat..."

# Add to cart
browse snapshot -i                    # find Add to Cart → @e54
browse click @e54

# Handle the cart modal
browse snapshot -i -s "[role=dialog]" # scope snapshot to modal only
browse click @e3                      # "View Cart"

# Checkout
browse snapshot -i                    # find Checkout → @e52
browse click @e52
# → redirected to sign-in page
```

**Total tokens consumed by the agent for this 12-step flow: ~15,000** (snapshot -i at each step).
With `page.content()` at each step: **~4,000,000+ tokens** — 270x more.

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
`snapshot-diff` — compare current page against last snapshot (strips ref numbers to avoid false positives from renumbering).

### Device Emulation
`emulate <device>` | `emulate reset` | `devices [filter]`

Supports 100+ devices: iPhone 12-17, Pixel 5-7, iPad, Galaxy, and all Playwright built-ins.

### Inspection
`js <expr>` | `eval <file>` | `css <sel> <prop>` | `attrs <sel>` | `state <sel>` | `console [--clear]` | `network [--clear]` | `cookies` | `storage [set <k> <v>]` | `perf`

### Visual
`screenshot [path]` | `screenshot --annotate` | `pdf [path]` | `responsive [prefix]`

`--annotate` overlays numbered badges on interactive elements and returns a legend — useful for visual debugging.

### Compare
`diff <url1> <url2>` — text diff between two pages (uses a temp tab, preserves your session).

### Multi-Step
```bash
echo '[["goto","https://example.com"],["text"]]' | browse chain
```

### Tabs
`tabs` | `tab <id>` | `newtab [url]` | `closetab [id]`

### Server Control
`status` | `cookie <n>=<v>` | `header <n>:<v>` | `useragent <str>` | `stop` | `restart`

## Architecture

```
browse <command>  →  CLI (thin HTTP client)
                        ↓
                  Persistent server (localhost, auto-started)
                        ↓
                  Chromium (Playwright, headless)
```

- Server auto-starts on first command, stays running across commands
- Auto-shutdown after 30 min idle (configurable)
- State file in project `.browse/` directory (auto-gitignored)
- Crash recovery: CLI detects dead server and restarts transparently

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSE_PORT` | auto 9400-9410 | Fixed server port |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle shutdown in ms |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log directory |

## License

MIT
