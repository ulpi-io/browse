# @ulpi/browse

Headless browser CLI for AI coding agents. Persistent Chromium daemon via Playwright, ~100ms per command after startup.

## Installation

### Global Installation (recommended)

```bash
npm install -g @ulpi/browse
```

Requires [Bun](https://bun.sh) runtime. Chromium is installed automatically via Playwright on first `npm install`.

### Project Installation (local dependency)

```bash
npm install @ulpi/browse
```

Then use via `package.json` scripts or by invoking `browse` directly.

### From Source

```bash
git clone https://github.com/ulpi-io/browse
cd browse
bun install
bun run src/cli.ts goto https://example.com   # Dev mode
bun run build                                  # Build standalone binary
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
browse dblclick <sel>          # Double-click element
browse fill <sel> <val>        # Clear and fill input
browse select <sel> <val>      # Select dropdown option
browse hover <sel>             # Hover element
browse focus <sel>             # Focus element
browse check <sel>             # Check checkbox
browse uncheck <sel>           # Uncheck checkbox
browse type <text>             # Type text via keyboard (current focus)
browse press <key>             # Press key (Enter, Tab, etc.)
browse keydown <key>           # Key down event
browse keyup <key>             # Key up event
browse scroll [sel|up|down]    # Scroll element into view or direction
browse drag <src> <tgt>        # Drag and drop
browse highlight <sel>         # Highlight element with visual overlay
browse download <sel> [path]   # Download file triggered by click
browse upload <sel> <files...> # Upload files to input
```

### Wait

```bash
browse wait <selector>         # Wait for element
browse wait --url <pattern>    # Wait for URL
browse wait --network-idle     # Wait for network idle
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
browse clipboard [write <text>] # Read or write clipboard
browse console [--clear]       # Console log buffer
browse network [--clear]       # Network request buffer
browse cookies                 # Browser cookies as JSON
browse storage [set <k> <v>]   # localStorage/sessionStorage
browse perf                    # Navigation timing (dns, ttfb, load)
browse devices [filter]        # List available device names
```

### Visual

```bash
browse screenshot [path]       # Take screenshot
browse screenshot --annotate   # Annotated screenshot with numbered element labels
browse pdf [path]              # Save page as PDF
browse responsive [prefix]     # Mobile/tablet/desktop screenshots
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

### Network

```bash
browse route <pattern> block                # Block matching requests
browse route <pattern> fulfill <status> [body] # Mock response
browse route clear                          # Remove all routes
browse offline [on|off]                     # Toggle offline mode
browse cookie <name>=<value>                # Set cookie
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
```

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

## Options

| Flag | Description |
|------|-------------|
| `--session <id>` | Named session (isolates tabs, refs, cookies) |
| `--json` | Wrap output as `{success, data, command}` |
| `--content-boundaries` | Wrap page content in nonce-delimited markers |
| `--allowed-domains <d,d>` | Block navigation/resources outside allowlist |
| `--headed` | Show browser window (not headless) |

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
| `BROWSE_RUNTIME` | playwright | Browser runtime (playwright, rebrowser, lightpanda) |

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

Rerun: `bun run benchmark`

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for full release history.

## Acknowledgments

Inspired by and originally derived from the `/browse` skill in [gstack](https://github.com/garrytan/gstack) by Garry Tan.

## License

MIT
