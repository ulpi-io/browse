# @ulpi/browse

Fast headless browser CLI — persistent Chromium daemon via Playwright.

Designed for AI coding agents. Starts a background Chromium server on first use (~100-200ms per command after that), supports 40+ commands, ref-based element selection, and auto-shutdown after idle timeout.

## Install

```bash
bun install -g @ulpi/browse
```

Requires [Bun](https://bun.sh) runtime. Chromium is installed automatically via Playwright on first install.

## Quick Start

```bash
browse goto https://example.com
browse text                        # extract page text
browse snapshot -i                 # interactive elements with refs
browse click @e3                   # click by ref
browse screenshot ~/page.png       # full-page screenshot
browse stop                        # shut down server
```

## Commands

### Navigation

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL |
| `back` | Go back |
| `forward` | Go forward |
| `reload` | Reload page |
| `url` | Print current URL |

### Content Extraction

| Command | Description |
|---------|-------------|
| `text` | Extract visible page text (no HTML) |
| `html [selector]` | Full HTML or element innerHTML |
| `links` | List all links with text and href |
| `forms` | Discover form fields (JSON) |
| `accessibility` | Raw ARIA accessibility tree |

### Interaction

| Command | Description |
|---------|-------------|
| `click <sel>` | Click element (CSS selector or `@ref`) |
| `fill <sel> <value>` | Fill input field |
| `select <sel> <value>` | Select dropdown option |
| `hover <sel>` | Hover over element |
| `type <text>` | Type text (focused element) |
| `press <key>` | Press key (Enter, Tab, Escape, etc.) |
| `scroll [sel]` | Scroll element into view or to bottom |
| `wait <sel> [timeout]` | Wait for element to appear |
| `viewport <WxH>` | Set viewport size (e.g., `375x812`) |

### Snapshot & Refs

```bash
browse snapshot              # full accessibility tree with refs
browse snapshot -i           # interactive elements only
browse snapshot -c           # compact (remove empty structural elements)
browse snapshot -C           # detect cursor-interactive elements (divs with cursor:pointer, onclick, tabindex)
browse snapshot -d 3         # limit depth to 3 levels
browse snapshot -s "#main"   # scope to CSS selector

# After snapshot, use refs as selectors:
browse click @e3
browse fill @e4 "hello"
browse hover @e1
browse html @e2
browse css @e5 color
browse attrs @e6
```

### Snapshot Diff

```bash
browse snapshot -i           # take baseline
# ... interact with page ...
browse snapshot-diff         # show what changed
```

### Device Emulation

```bash
browse emulate iphone        # emulate iPhone 15
browse emulate "Pixel 7"     # emulate Pixel 7
browse emulate reset          # back to desktop (1920x1080)
browse devices                # list all available devices
browse devices iphone         # filter devices
```

### Inspection

| Command | Description |
|---------|-------------|
| `js <expr>` | Evaluate JavaScript expression |
| `eval <file>` | Evaluate JavaScript file |
| `css <sel> <property>` | Get computed CSS property |
| `attrs <sel>` | Get element attributes (JSON) |
| `state <sel>` | Get element state (visible, enabled, checked, etc.) |
| `console [--clear]` | View/clear console messages |
| `network [--clear]` | View/clear network requests |
| `cookies` | List cookies (JSON) |
| `storage [set <k> <v>]` | View/set localStorage |
| `perf` | Page load performance timings |

### Visual

```bash
browse screenshot [path]          # full-page screenshot
browse screenshot --annotate      # screenshot with numbered element badges
browse pdf [path]                 # save page as PDF
browse responsive [prefix]        # mobile + tablet + desktop screenshots
```

### Compare

```bash
browse diff <url1> <url2>         # text diff between two pages
```

### Multi-Step

```bash
echo '[["goto","https://example.com"],["text"],["screenshot","/tmp/shot.png"]]' | browse chain
```

### Tabs

| Command | Description |
|---------|-------------|
| `tabs` | List all tabs |
| `tab <id>` | Switch to tab |
| `newtab [url]` | Open new tab |
| `closetab [id]` | Close tab |

### Server Control

| Command | Description |
|---------|-------------|
| `status` | Server health, URL, tabs, PID, uptime |
| `cookie <n>=<v>` | Set cookie |
| `header <n>:<v>` | Set extra HTTP header |
| `useragent <str>` | Set user agent |
| `stop` | Shut down server |
| `restart` | Restart server (fresh browser) |

## Architecture

```
browse <command>  →  CLI (thin HTTP client)
                        ↓
                  Server (persistent daemon on localhost)
                        ↓
                  Chromium (Playwright, headless)
```

- **First command** starts the server in the background (~2-3s)
- **Subsequent commands** are fast (~100-200ms) — just HTTP to localhost
- **Auto-shutdown** after 30 min idle (configurable via `BROWSE_IDLE_TIMEOUT`)
- **Crash recovery** — CLI auto-restarts server if Chromium crashes

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BROWSE_PORT` | Fixed server port | auto-scan 9400-9410 |
| `BROWSE_IDLE_TIMEOUT` | Idle shutdown (ms) | 1800000 (30 min) |
| `BROWSE_SERVER_SCRIPT` | Path to server.ts | auto-detected |
| `BROWSE_LOCAL_DIR` | State/log directory | project `.browse/` or `/tmp` |
| `BROWSE_STATE_FILE` | State file path | auto |

## License

MIT
