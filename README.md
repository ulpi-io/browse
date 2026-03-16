# @ulpi/browse

**The headless browser CLI built for AI agents — not humans.**

When AI agents browse the web, the bottleneck isn't Chromium — it's **what gets dumped into the context window**. [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) sends the full accessibility snapshot on every navigate, click, and keystroke. On a real e-commerce page, that's **~16,000 tokens per action** — automatically, whether the agent needs it or not.

Ten actions and you've burned **146K tokens — 73% of a 200K context window** — just on browser output. That leaves almost nothing for the agent to actually think.

`@ulpi/browse` flips this. Navigation returns 11 tokens. Clicks return 15 tokens. The agent requests a page snapshot **only when it needs one** — and can filter to interactive elements only, cutting another 2-6x.

**Same 10 actions: ~11K tokens. 6% of context. 13x less than @playwright/mcp.**

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
| 10-action session | ~145,780 | **~11,388** |
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

### 4. 58+ Purpose-Built Commands vs Generic Tools

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
| Input value | `browser_evaluate` + custom JS | `value <sel>` |
| Element count | `browser_evaluate` + custom JS | `count <sel>` |
| iframe targeting | Not available | `frame <sel>` / `frame main` |
| Network mocking | Not available | `route <pattern> block\|fulfill` |
| Offline mode | Not available | `offline on\|off` |
| State persistence | Not available | `state save\|load` |
| Credential vault | Not available | `auth save\|login\|list` |
| HAR recording | Not available | `har start\|stop` |
| Domain restriction | Not available | `--allowed-domains` |
| Prompt injection defense | Not available | `--content-boundaries` |
| JSON output mode | Not available | `--json` |

### 5. Persistent Daemon — 100ms Commands

```
First command:       ~2s  (server + Chromium startup, once)
Every command after: ~100-200ms  (HTTP to localhost)
```

@playwright/mcp starts a new browser per MCP session. `browse` keeps the server running across commands with auto-shutdown after 30 min idle. Crash recovery is built in — the CLI detects a dead server and restarts transparently.

### 6. Multi-Agent Sessions — Parallel Browsing on One Chromium

Run multiple AI agents in parallel, each with its own isolated browser session, sharing a single Chromium process. Each session gets its own tabs, refs, cookies, localStorage, and console/network buffers — zero cross-talk.

```bash
# Agent A researches strollers on mumzworld
browse --session agent-a goto https://www.mumzworld.com
browse --session agent-a snapshot -i
browse --session agent-a fill @e3 "strollers"
browse --session agent-a press Enter

# Agent B checks competitor pricing on amazon — simultaneously
browse --session agent-b goto https://www.amazon.com
browse --session agent-b snapshot -i
browse --session agent-b fill @e6 "baby stroller"
browse --session agent-b press Enter

# Or set once via env var
export BROWSE_SESSION=agent-a
browse text    # runs in agent-a's session
```

Under the hood, each session is a separate Playwright `BrowserContext` on the shared Chromium — same isolation model as browser profiles (separate cookies, storage, cache). One process, no extra memory for multiple Chromium instances.

```
browse --session <id> <command>
          │
    Persistent server (one Chromium process)
          │
    SessionManager
    ├── "default"  → BrowserContext → tabs, refs, cookies, buffers
    ├── "agent-a"  → BrowserContext → tabs, refs, cookies, buffers
    └── "agent-b"  → BrowserContext → tabs, refs, cookies, buffers
```

**Session management:**
```bash
browse sessions                # list active sessions with tab counts
browse session-close agent-a   # close a session (frees its tabs/context)
browse status                  # shows total session count
```

Sessions auto-close after the idle timeout (default 30 min). The server shuts down when all sessions are idle. Without `--session`, everything runs in a `"default"` session — fully backward compatible.

For full process isolation (separate Chromium instances), use `BROWSE_PORT` to run independent servers.

## Install

```bash
npm install -g @ulpi/browse
```

Requires [Bun](https://bun.sh) runtime. Chromium is installed automatically via Playwright.

### Claude Code Skill

Install via [skills.sh](https://skills.sh) (works across Claude Code, Cursor, Cline, Windsurf, and 15+ agents):

```bash
npx skills add https://github.com/ulpi-io/skills --skill browse
```

Or install directly into your project:

```bash
browse install-skill
```

Both copy the skill definition to `.claude/skills/browse/SKILL.md` and add all browse commands to permissions — no more approval prompts.

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

**12 steps. ~24K tokens total.** With @playwright/mcp: **~240K tokens** for the same flow (every action dumps a full snapshot).

## Command Reference

### Navigation
`goto <url>` | `back` | `forward` | `reload` | `url`

### Content Extraction
`text` | `html [sel]` | `links` | `forms` | `accessibility`

### Interaction
`click <sel>` | `dblclick <sel>` | `fill <sel> <val>` | `select <sel> <val>` | `hover <sel>` | `focus <sel>` | `check <sel>` | `uncheck <sel>` | `drag <src> <tgt>` | `type <text>` | `press <key>` | `keydown <key>` | `keyup <key>` | `scroll [sel|up|down]` | `wait <sel|--url|--network-idle>` | `viewport <WxH>` | `highlight <sel>` | `download <sel> [path]`

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
`js <expr>` | `eval <file>` | `css <sel> <prop>` | `attrs <sel>` | `element-state <sel>` | `value <sel>` | `count <sel>` | `console [--clear]` | `network [--clear]` | `cookies` | `storage [set <k> <v>]` | `perf`

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

### Frames
`frame <sel>` | `frame main`

### Sessions
`sessions` | `session-close <id>`

### Network
`route <pattern> block` | `route <pattern> fulfill <status> [body]` | `route clear` | `offline [on|off]`

### State & Auth
`state save [name]` | `state load [name]` | `auth save <name> <url> <user> <pass>` | `auth login <name>` | `auth list` | `auth delete <name>`

### Recording
`har start` | `har stop [path]`

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
| `BROWSE_INSTANCE` | auto (PPID) | Instance ID for multi-Claude isolation |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle shutdown in ms |
| `BROWSE_TIMEOUT` | (none) | Override all command timeouts (ms) |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log directory |
| `BROWSE_JSON` | (none) | Set to `1` for JSON output mode |
| `BROWSE_CONTENT_BOUNDARIES` | (none) | Set to `1` for nonce-delimited output |
| `BROWSE_ALLOWED_DOMAINS` | (none) | Comma-separated domain allowlist |
| `BROWSE_PROXY` | (none) | Proxy server URL |
| `BROWSE_PROXY_BYPASS` | (none) | Proxy bypass list |
| `BROWSE_CDP_URL` | (none) | Connect to remote Chrome via CDP |

## Acknowledgments

Inspired by and originally derived from the `/browse` skill in [gstack](https://github.com/garrytan/gstack) by Garry Tan. The core architecture — persistent Chromium daemon, thin CLI client, ref-based element selection via ARIA snapshots — comes from gstack.

## Changelog

### v0.2.0 — Security, Interactions, DX

**Commands:**
- `dblclick`, `focus`, `check`, `uncheck`, `drag`, `keydown`, `keyup` — interaction commands
- `frame <sel>` / `frame main` — iframe targeting
- `value <sel>`, `count <sel>` — element inspection
- `scroll up/down` — viewport-relative scrolling
- `wait --url`, `wait --network-idle` — navigation/network wait variants
- `highlight <sel>` — visual element debugging
- `download <sel> [path]` — file download
- `route <pattern> block/fulfill` — network request interception and mocking
- `offline on/off` — offline mode toggle
- `state save/load` — persist and restore cookies + localStorage (all origins)
- `har start/stop` — HAR recording and export
- `screenshot-diff` — pixel-level visual regression testing
- `find role/text/label/placeholder/testid` — semantic element locators

**Security:**
- `--allowed-domains` — domain allowlist (HTTP + WebSocket/EventSource/sendBeacon)
- `browse-policy.json` — action policy gate (allow/deny/confirm per command)
- `auth save/login/list/delete` — AES-256-GCM encrypted credential vault
- `--content-boundaries` — CSPRNG nonce wrapping for prompt injection defense

**DX:**
- `--json` — structured output mode for agent frameworks
- `browse.json` config file support
- AI-friendly error messages — Playwright errors rewritten to actionable hints
- Per-session output folders (`.browse/sessions/{id}/`)

**Infrastructure:**
- Auto-instance servers via PPID — multi-Claude isolation
- CDP remote connection (`BROWSE_CDP_URL`)
- Proxy support (`BROWSE_PROXY`)
- Compiled binary self-spawn mode
- Orphaned server cleanup

### v0.1.0 — Foundation

**Commands:**
- `emulate` / `devices` — device emulation (100+ devices)
- `snapshot -C` — cursor-interactive detection
- `snapshot-diff` — before/after comparison with ref-number stripping
- `dialog` / `dialog-accept` / `dialog-dismiss` — dialog handling
- `upload` — file upload
- `screenshot --annotate` — numbered badge overlay with legend

**Infrastructure:**
- Session multiplexing — multiple agents share one Chromium
- Safe retry classification — read vs write commands
- TreeWalker text extraction — no MutationObserver triggers

## License

MIT
