# @ulpi/browse

Headless browser CLI for AI coding agents. Persistent Chromium daemon via Playwright, ~100ms per command after startup.

## Installation

### Global Installation (recommended)

```bash
npm install -g @ulpi/browse
```

Requires Node.js 18+. Chromium is installed automatically via Playwright on first `npm install`. If [Bun](https://bun.sh) is installed, browse automatically uses it for ~2x faster command execution.

### Project Installation (local dependency)

```bash
npm install @ulpi/browse
```

Then use via `package.json` scripts or by invoking `browse` directly.

### From Source

```bash
git clone https://github.com/ulpi-io/browse
cd browse
npm install
npx tsx src/cli.ts goto https://example.com   # Dev mode
npm run build                                  # Build bundle
```

## Quick Start

```bash
browse goto https://example.com
browse snapshot -i                     # Get interactive elements with refs
browse click @e2                       # Click by ref from snapshot
browse fill @e3 "test@example.com"     # Fill input by ref
browse text                            # Get visible page text
browse screenshot page.png
browse stop
```

### The Ref Workflow

Every `snapshot` assigns refs (`@e1`, `@e2`, ...) to elements. Use refs as selectors in any command — no CSS selector construction needed:

```bash
$ browse snapshot -i
@e1 [button] "Submit"
@e2 [link] "Home"
@e3 [textbox] "Email"

$ browse click @e1                     # Click the Submit button
Clicked @e1

$ browse fill @e3 "user@example.com"   # Fill the Email field
Filled @e3
```

### Traditional Selectors (also supported)

```bash
browse click "#submit"
browse fill ".email-input" "test@example.com"
browse click "text=Submit"
```

## Commands

### Navigation

```bash
browse goto <url>              # Navigate to URL
browse back                    # Go back
browse forward                 # Go forward
browse reload                  # Reload page
browse url                     # Get current URL
```

### Content Extraction

```bash
browse text                    # Visible text (clean, no DOM mutation)
browse html [sel]              # Full HTML or element innerHTML
browse links                   # All links as "text -> href"
browse forms                   # Form structure as JSON
browse accessibility           # Raw ARIA snapshot tree
```

### Interaction

```bash
browse click <sel>             # Click element
browse rightclick <sel>        # Right-click element (context menu)
browse dblclick <sel>          # Double-click element
browse fill <sel> <val>        # Clear and fill input
browse select <sel> <val>      # Select dropdown option
browse hover <sel>             # Hover element
browse focus <sel>             # Focus element
browse tap <sel>               # Tap element (requires touch context via emulate)
browse check <sel>             # Check checkbox
browse uncheck <sel>           # Uncheck checkbox
browse type <text>             # Type text via keyboard (current focus)
browse press <key>             # Press key (Enter, Tab, etc.)
browse keydown <key>           # Key down event
browse keyup <key>             # Key up event
browse keyboard inserttext <text> # Insert text without key events
browse scroll [sel|up|down]    # Scroll element into view or direction
browse scrollinto <sel>        # Scroll element into view (explicit)
browse swipe <dir> [px]        # Swipe up/down/left/right (touch events)
browse drag <src> <tgt>        # Drag and drop
browse highlight <sel>         # Highlight element with visual overlay
browse download <sel> [path]   # Download file triggered by click
browse upload <sel> <files...> # Upload files to input
```

### Mouse Control

```bash
browse mouse move <x> <y>     # Move mouse to coordinates
browse mouse down [button]     # Press mouse button (left/right/middle)
browse mouse up [button]       # Release mouse button
browse mouse wheel <dy> [dx]   # Scroll wheel
```

### Settings

```bash
browse set geo <lat> <lng>     # Set geolocation
browse set media <scheme>      # Set color scheme (dark/light/no-preference)
```

### Wait

```bash
browse wait <selector>         # Wait for element
browse wait <selector> --state hidden  # Wait for element to disappear
browse wait <ms>               # Wait for milliseconds
browse wait --url <pattern>    # Wait for URL
browse wait --text "Welcome"   # Wait for text to appear in page
browse wait --fn "js expr"     # Wait for JavaScript condition
browse wait --load <state>     # Wait for load state (load/domcontentloaded/networkidle)
browse wait --network-idle     # Wait for network idle
browse wait --download [path]  # Wait for download to complete
```

### Snapshot

```bash
browse snapshot                # Full accessibility tree
browse snapshot -i             # Interactive elements only (terse flat list)
browse snapshot -i -f          # Interactive elements, full indented tree
browse snapshot -i -C          # Include cursor-interactive elements (onclick, cursor:pointer)
browse snapshot -V             # Viewport only — elements visible on screen
browse snapshot -c             # Compact — remove empty structural elements
browse snapshot -d 3           # Limit depth to 3 levels
browse snapshot -s "#main"     # Scope to CSS selector
browse snapshot -i -c -d 5    # Combine options
```

| Flag | Description |
|------|-------------|
| `-i` | Interactive elements only (buttons, links, inputs) — terse flat list |
| `-f` | Full — indented tree with props and children (use with `-i`) |
| `-V` | Viewport — only elements visible in current viewport |
| `-c` | Compact — remove empty structural elements |
| `-C` | Cursor-interactive — detect divs with `cursor:pointer`, `onclick`, `tabindex` |
| `-d N` | Limit tree depth |
| `-s <sel>` | Scope to CSS selector |

The `-C` flag catches modern SPA patterns that ARIA trees miss — `<div onclick>`, `cursor: pointer`, `tabindex`, and `data-action` elements.

### Find Elements

```bash
browse find role <role> [name]                # By ARIA role
browse find text <text>                       # By text content
browse find label <label>                     # By label
browse find placeholder <placeholder>         # By placeholder
browse find testid <id>                       # By data-testid
browse find alt <text>                        # By alt text
browse find title <text>                      # By title attribute
browse find first <sel>                       # First matching element
browse find last <sel>                        # Last matching element
browse find nth <n> <sel>                     # Nth matching element (0-indexed)
```

### Inspection

```bash
browse js <expr>               # Evaluate JavaScript expression
browse eval <file>             # Evaluate JavaScript file
browse css <sel> <prop>        # Get computed CSS property
browse attrs <sel>             # Get element attributes as JSON
browse element-state <sel>     # Element state (visible, enabled, checked, etc.)
browse value <sel>             # Get input/select value
browse count <sel>             # Count elements matching selector
browse box <sel>               # Get bounding box as JSON {x, y, width, height}
browse clipboard [write <text>] # Read or write clipboard
browse console [--clear]       # Console log buffer
browse errors [--clear]        # Page errors only (filtered from console)
browse network [--clear]       # Network request buffer
browse cookies                 # Browser cookies as JSON
browse storage [set <k> <v>]   # localStorage/sessionStorage
browse perf                    # Navigation timing (dns, ttfb, load)
browse devices [filter]        # List available device names
```

### Visual

```bash
browse screenshot [path]              # Take screenshot (viewport)
browse screenshot --full [path]       # Full-page screenshot
browse screenshot <sel|@ref> [path]   # Screenshot specific element
browse screenshot --clip x,y,w,h [path] # Screenshot clipped region
browse screenshot --annotate [path]   # Annotated screenshot with numbered labels
browse pdf [path]                     # Save page as PDF
browse responsive [prefix]            # Mobile/tablet/desktop screenshots
```

### Compare

```bash
browse diff <url1> <url2>                  # Text diff between two pages
browse snapshot-diff                        # Diff current vs last snapshot
browse screenshot-diff <baseline> [current] # Pixel-level visual diff
```

### Tabs

```bash
browse tabs                    # List all tabs
browse tab <id>                # Switch to tab
browse newtab [url]            # Open new tab
browse closetab [id]           # Close tab
```

### Frames

```bash
browse frame <sel>             # Switch to iframe
browse frame main              # Back to main frame
```

### Device Emulation

```bash
browse emulate "iPhone 14"     # Emulate device
browse emulate reset           # Reset to desktop (1920x1080)
browse devices                 # List all available devices
browse devices iphone          # Filter device list
browse viewport 1280x720       # Set viewport size
```

100+ devices: iPhone 12–17, Pixel 5–7, iPad, Galaxy, and all Playwright built-ins.

### Cookies

```bash
browse cookie <name>=<value>                        # Set cookie (simple)
browse cookie set <n> <v> [--domain --secure ...]   # Set cookie with options
browse cookie clear                                 # Clear all cookies
browse cookie export <file>                         # Export cookies to JSON
browse cookie import <file>                         # Import cookies from JSON
browse cookies                                      # Read all cookies
```

### Network

```bash
browse route <pattern> block                # Block matching requests
browse route <pattern> fulfill <status> [body] # Mock response
browse route clear                          # Remove all routes
browse offline [on|off]                     # Toggle offline mode
browse header <name>:<value>                # Set extra HTTP header
browse useragent <string>                   # Set user agent
```

### Dialogs

```bash
browse dialog                  # Last dialog info
browse dialog-accept [text]    # Accept next dialog (optional prompt text)
browse dialog-dismiss          # Dismiss next dialog
```

### Recording

```bash
browse har start               # Start HAR recording
browse har stop [path]         # Stop and save HAR file

browse video start [dir]       # Start video recording (WebM)
browse video stop              # Stop recording
browse video status            # Check recording status

browse record start            # Record browsing commands as you go
browse record stop             # Stop recording
browse record status           # Check recording status
browse record export browse [path]      # Export as chain-compatible JSON (replay with browse chain)
browse record export replay [path]     # Export as Chrome DevTools Recorder (Playwright/Puppeteer)
browse record export replay --selectors css,aria [path]  # Filter selector types in export
```

### React DevTools

```bash
browse react-devtools enable           # Enable (downloads hook on first use)
browse react-devtools tree             # Component tree
browse react-devtools props <sel>      # Props/state of component
browse react-devtools suspense         # Suspense boundary status
browse react-devtools errors           # Error boundaries
browse react-devtools profiler         # Render timing
browse react-devtools hydration        # Hydration timing
browse react-devtools renders          # What re-rendered
browse react-devtools owners <sel>     # Parent component chain
browse react-devtools context <sel>    # Context values
browse react-devtools disable          # Disable
```

### Handoff (Human Takeover)

```bash
browse handoff [reason]        # Swap to Chrome for CAPTCHA/MFA/OAuth (falls back to Chromium)
browse handoff --chromium      # Force Playwright Chromium instead of Chrome
browse resume                  # Swap back to headless, returns fresh snapshot
```

Handoff defaults to your system Chrome (bypasses Turnstile and bot detection). Falls back to Playwright Chromium if Chrome is not installed. Agent asks permission first via AskUserQuestion, then hands off. Server auto-suggests handoff after 3 consecutive failures.

### Cloud Providers

```bash
browse provider save browserbase <api-key>     # Save API key (encrypted)
browse provider save browserless <token>       # Save token (encrypted)
browse --provider browserbase goto https://...  # Use cloud browser
browse provider list                           # List saved providers
browse provider delete <name>                  # Remove saved key
```

API keys are encrypted at rest in `.browse/providers/` — never visible to agents.

### State & Auth

```bash
browse state save [name]       # Save cookies + localStorage
browse state load [name]       # Restore saved state
browse state list              # List saved states
browse state show [name]       # Show state details

browse auth save <name> <url> <user> <pass>  # Save encrypted credential
browse auth save <name> <url> <user> --password-stdin  # Password from stdin
browse auth login <name>       # Auto-login with saved credential
browse auth list               # List saved credentials
browse auth delete <name>      # Delete credential

browse cookie-import --list                            # List browsers with cookies
browse cookie-import chrome [--domain .example.com]    # Import cookies from Chrome
browse cookie-import chrome --profile "Profile 1"      # Specific browser profile
```

### Multi-Step (Chaining)

Execute a sequence of commands in one call:

```bash
echo '[["goto","https://example.com"],["snapshot","-i"],["text"]]' | browse chain
```

### Server Control

```bash
browse status                  # Server health report
browse instances               # List all running browse servers
browse version                 # Print CLI version
browse doctor                  # System check (Node, Playwright, Chromium)
browse upgrade                 # Self-update via npm
browse stop                    # Stop server
browse restart                 # Restart server
browse inspect                 # Open DevTools (requires BROWSE_DEBUG_PORT)
```

### Setup

```bash
browse install-skill [path]    # Install Claude Code skill
```

## Sessions

Run multiple AI agents in parallel, each with isolated browser state, sharing one Chromium process:

```bash
# Agent A
browse --session agent-a goto https://site-a.com
browse --session agent-a snapshot -i
browse --session agent-a click @e3

# Agent B (simultaneously)
browse --session agent-b goto https://site-b.com
browse --session agent-b snapshot -i
browse --session agent-b fill @e2 "query"

# Or set once via env var
export BROWSE_SESSION=agent-a
browse text
```

Each session has its own:
- Browser context (cookies, storage, cache)
- Tabs and navigation history
- Refs from snapshots
- Console and network buffers

```bash
browse sessions                # List active sessions
browse session-close agent-a   # Close a session
browse status                  # Shows total session count
```

Sessions auto-close after the idle timeout (default 30 min). Without `--session`, everything runs in a `"default"` session.

For full process isolation (separate Chromium instances), use `BROWSE_PORT` to run independent servers.

### Profiles vs Sessions

| | `--session` | `--profile` |
|---|---|---|
| Chromium | Shared (one process) | Own (one per profile) |
| Memory | ~5MB per session | ~200MB per profile |
| State | Ephemeral (auto-persisted cookies) | Full persistence (cookies, cache, IndexedDB) |
| Multiplexing | Yes (parallel agents) | No (one agent per profile) |
| Use case | Parallel browsing, lightweight | Real login state, heavy |

## Security

All security features are opt-in — existing workflows are unaffected until you explicitly enable a feature.

### Domain Allowlist

Restrict navigation and sub-resource requests to trusted domains:

```bash
browse --allowed-domains "example.com,*.example.com" goto https://example.com
# Or via env var
BROWSE_ALLOWED_DOMAINS="example.com,*.api.io" browse goto https://example.com
```

Blocks HTTP requests, WebSocket, EventSource, and `sendBeacon` to non-allowed domains. Wildcards like `*.example.com` match the bare domain and all subdomains.

### Action Policy

Gate commands with a `browse-policy.json` file:

```json
{ "default": "allow", "deny": ["js", "eval"], "confirm": ["goto"] }
```

Precedence: deny > confirm > allow > default. Hot-reloads on file change — no server restart needed.

### Credential Vault

Encrypted credential storage (AES-256-GCM). The LLM never sees passwords:

```bash
echo "mypassword" | browse auth save github https://github.com/login myuser --password-stdin
browse auth login github          # Auto-navigates, detects form, fills + submits
browse auth list                  # List saved credentials (no passwords shown)
```

Key is auto-generated at `.browse/.encryption-key` or set via `BROWSE_ENCRYPTION_KEY`.

### Content Boundaries

Wrap page output in CSPRNG nonce-delimited markers so LLMs can distinguish tool output from untrusted page content:

```bash
browse --content-boundaries text
```

### JSON Output

Machine-readable output for agent frameworks:

```bash
browse --json snapshot -i
# Returns: {"success": true, "data": "...", "command": "snapshot"}
```

## Configuration

Create a `browse.json` file at your project root to set persistent defaults:

```json
{
  "session": "my-agent",
  "json": true,
  "contentBoundaries": true,
  "allowedDomains": ["example.com", "*.api.io"],
  "idleTimeout": 3600000,
  "viewport": "1280x720",
  "device": "iPhone 14",
  "runtime": "playwright"
}
```

CLI flags and environment variables override config file values.

## Usage with AI Agents

### Claude Code (recommended)

Install as a Claude Code skill via [skills.sh](https://skills.sh):

```bash
npx skills add https://github.com/ulpi-io/skills --skill browse
```

Or install directly:

```bash
browse install-skill
```

Both copy the skill definition to `.claude/skills/browse/SKILL.md` and add all browse commands to permissions — no more approval prompts.

### CLAUDE.md / AGENTS.md

Add to your project instructions:

```markdown
## Browser Automation

Use `browse` for web automation. Run `browse --help` for all commands.

Core workflow:
1. `browse goto <url>` — Navigate to page
2. `browse snapshot -i` — Get interactive elements with refs (@e1, @e2)
3. `browse click @e1` / `fill @e2 "text"` — Interact using refs
4. Re-snapshot after page changes
```

### Just ask the agent

```
Use browse to test the login flow. Run browse --help to see available commands.
```

## MCP Server Mode

Run browse as an [MCP](https://modelcontextprotocol.io/) server for editors that support the Model Context Protocol.

```bash
browse --mcp
```

Use `--json` alongside `--mcp` for structured responses (`{success, data, command}`).

> **Note:** Requires `npm install @modelcontextprotocol/sdk` alongside browse.

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browse": {
      "command": "browse",
      "args": ["--mcp"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browse": {
      "command": "browse",
      "args": ["--mcp"]
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "browse": {
      "command": "browse",
      "args": ["--mcp"]
    }
  }
}
```

## Options

| Flag | Description |
|------|-------------|
| `--session <id>` | Named session (isolates tabs, refs, cookies) |
| `--profile <name>` | Persistent browser profile (own Chromium, full state) |
| `--json` | Wrap output as `{success, data, command}` |
| `--content-boundaries` | Wrap page content in nonce-delimited markers |
| `--allowed-domains <d,d>` | Block navigation/resources outside allowlist |
| `--max-output <n>` | Truncate output to N characters |
| `--headed` | Show browser window (not headless) |
| `--chrome` | Launch system Chrome (uses real browser, bypasses bot detection) |
| `--cdp <port>` | Connect to Chrome on a specific debugging port |
| `--connect` | Auto-discover and connect to a running Chrome instance |
| `--provider <name>` | Cloud browser provider (browserless, browserbase) |
| `--runtime <name>` | Browser runtime: playwright (default), rebrowser (stealth), lightpanda, chrome |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSE_PORT` | auto (9400–10400) | Fixed server port |
| `BROWSE_PORT_START` | 9400 | Start of port scan range |
| `BROWSE_SESSION` | (none) | Default session ID for all commands |
| `BROWSE_INSTANCE` | auto (PPID) | Instance ID for multi-agent isolation |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle auto-shutdown in ms |
| `BROWSE_TIMEOUT` | (none) | Override all command timeouts (ms) |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log/screenshot directory |
| `BROWSE_JSON` | (none) | Set to `1` for JSON output mode |
| `BROWSE_CONTENT_BOUNDARIES` | (none) | Set to `1` for nonce-delimited output |
| `BROWSE_ALLOWED_DOMAINS` | (none) | Comma-separated domain allowlist |
| `BROWSE_MAX_OUTPUT` | (none) | Truncate output to N characters |
| `BROWSE_HEADED` | (none) | Set to `1` for headed browser mode |
| `BROWSE_CDP_URL` | (none) | Connect to remote Chrome via CDP |
| `BROWSE_PROXY` | (none) | Proxy server URL |
| `BROWSE_PROXY_BYPASS` | (none) | Proxy bypass list |
| `BROWSE_SERVER_SCRIPT` | auto-detected | Override path to server.ts |
| `BROWSE_DEBUG_PORT` | (none) | Port for DevTools debugging |
| `BROWSE_POLICY` | browse-policy.json | Path to action policy file |
| `BROWSE_CONFIRM_ACTIONS` | (none) | Commands requiring confirmation |
| `BROWSE_ENCRYPTION_KEY` | auto-generated | 64-char hex AES key for credential vault |
| `BROWSE_AUTH_PASSWORD` | (none) | Password for `auth save` (alt to `--password-stdin`) |
| `BROWSE_RUNTIME` | playwright | Browser runtime (playwright, rebrowser, lightpanda, chrome) |
| `BROWSE_CHROME` | (none) | Set to `1` to use system Chrome |
| `BROWSE_CHROME_PATH` | auto-detected | Override Chrome executable path |

## Architecture

```
browse [--session <id>] <command>
          |
    CLI (thin HTTP client)
          |
    Persistent server (localhost, auto-started)
          |
    SessionManager
    ├── "default"  → BrowserContext → tabs, refs, cookies, buffers
    ├── "agent-a"  → BrowserContext → tabs, refs, cookies, buffers
    └── "agent-b"  → BrowserContext → tabs, refs, cookies, buffers
          |
    Chromium (Playwright, headless, shared)
```

- **First command:** ~2s (server + Chromium startup, once)
- **Every command after:** ~100–200ms (HTTP to localhost)
- Server auto-starts on first command, auto-shuts down after 30 min idle
- Crash recovery: CLI detects dead server and restarts transparently
- State file: `.browse/browse-server.json` (pid, port, token)

## Benchmarks

### vs Agent Browser & Browser-Use (Token Cost)

Tested on 3 sites across multi-step browsing flows — navigate, snapshot, scroll, search, extract text:

| Tool | Total Tokens | Total Time | Context Used (200K) |
|------|-------------:|-----------:|--------------------:|
| **browse** | **14,134** | **28.5s** | **7.1%** |
| agent-browser | 39,414 | 36.2s | 19.7% |
| browser-use | 34,281 | 72.7s | 17.1% |

browse uses **2.4x fewer tokens** than browser-use, **2.8x fewer** than agent-browser, and completes **2.5x faster** than browser-use.

### vs @playwright/mcp (Architecture)

@playwright/mcp dumps the full accessibility snapshot on every action. browse returns ~15 tokens per action — the agent requests a snapshot only when needed:

| | @playwright/mcp | browse |
|---|---:|---:|
| Tokens on `navigate` | ~14,578 (auto-dumped) | **~11** |
| Tokens on `click` | ~14,578 (auto-dumped) | **~15** |
| 10-action session | ~145,780 | **~11,388** |
| Context consumed (200K) | **73%** | **6%** |

Rerun: `npm run benchmark`

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full release history.

## Acknowledgments

Inspired by and originally derived from the `/browse` skill in [gstack](https://github.com/garrytan/gstack) by Garry Tan.

## License

MIT
