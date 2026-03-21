---
name: browse
version: 2.10.0
description: |
  Fast web browsing and web app testing for AI coding agents via persistent headless Chromium daemon.
  Browse any URL, read page content, click elements, fill forms, run JavaScript, take screenshots,
  inspect CSS/DOM, capture console/network logs, and more. Ideal for verifying local dev servers,
  testing UI changes, and validating web app behavior end-to-end. ~100ms per command after
  first call. Works with Claude Code, Cursor, Cline, Windsurf, and any agent that can run Bash.
  No MCP, no Chrome extension — just fast CLI.
allowed-tools:
  - Bash
  - Read

---

# browse: Persistent Browser for AI Coding Agents

Persistent headless Chromium daemon. First call auto-starts the server (~3s).
Every subsequent call: ~100-200ms. Auto-shuts down after 30 min idle.

## SETUP

Before using browse, confirm the CLI is installed:

```bash
browse --version
```

If not installed, tell the user:

> `browse` CLI is not installed. Install it with:
>
> ```bash
> npm install -g @ulpi/browse
> ```
>
> If you don't have bun, install it first from https://bun.sh then run the command above.

**Do NOT install anything automatically.** Wait for the user to confirm they have installed it before proceeding.

### Permissions (optional)

To avoid being prompted on every browse command, tell the user they can add browse permissions to `.claude/settings.json` under `permissions.allow`:

```json
"Bash(browse:*)",
"Bash(browse goto:*)", "Bash(browse back:*)", "Bash(browse forward:*)",
"Bash(browse reload:*)", "Bash(browse url:*)", "Bash(browse text:*)",
"Bash(browse html:*)", "Bash(browse links:*)", "Bash(browse forms:*)",
"Bash(browse accessibility:*)", "Bash(browse snapshot:*)",
"Bash(browse snapshot-diff:*)", "Bash(browse click:*)",
"Bash(browse dblclick:*)", "Bash(browse fill:*)", "Bash(browse select:*)",
"Bash(browse hover:*)", "Bash(browse focus:*)",
"Bash(browse check:*)", "Bash(browse uncheck:*)",
"Bash(browse type:*)", "Bash(browse press:*)",
"Bash(browse keydown:*)", "Bash(browse keyup:*)",
"Bash(browse scroll:*)", "Bash(browse wait:*)",
"Bash(browse viewport:*)", "Bash(browse upload:*)",
"Bash(browse drag:*)", "Bash(browse highlight:*)", "Bash(browse download:*)",
"Bash(browse dialog-accept:*)", "Bash(browse dialog-dismiss:*)",
"Bash(browse js:*)", "Bash(browse eval:*)", "Bash(browse css:*)",
"Bash(browse attrs:*)", "Bash(browse element-state:*)", "Bash(browse dialog:*)",
"Bash(browse console:*)", "Bash(browse network:*)",
"Bash(browse cookies:*)", "Bash(browse storage:*)", "Bash(browse perf:*)",
"Bash(browse value:*)", "Bash(browse count:*)",
"Bash(browse devices:*)", "Bash(browse emulate:*)",
"Bash(browse screenshot:*)", "Bash(browse pdf:*)",
"Bash(browse responsive:*)", "Bash(browse diff:*)",
"Bash(browse chain:*)", "Bash(browse tabs:*)", "Bash(browse tab:*)",
"Bash(browse newtab:*)", "Bash(browse closetab:*)",
"Bash(browse frame:*)",
"Bash(browse sessions:*)", "Bash(browse session-close:*)",
"Bash(browse record:*)",
"Bash(browse state:*)", "Bash(browse auth:*)", "Bash(browse har:*)", "Bash(browse video:*)",
"Bash(browse route:*)", "Bash(browse offline:*)",
"Bash(browse status:*)", "Bash(browse stop:*)", "Bash(browse restart:*)",
"Bash(browse cookie:*)", "Bash(browse header:*)",
"Bash(browse useragent:*)",
"Bash(browse clipboard:*)", "Bash(browse screenshot-diff:*)",
"Bash(browse find:*)", "Bash(browse inspect:*)",
"Bash(browse instances:*)", "Bash(browse --headed:*)",
"Bash(browse rightclick:*)", "Bash(browse tap:*)",
"Bash(browse swipe:*)", "Bash(browse mouse:*)",
"Bash(browse keyboard:*)", "Bash(browse scrollinto:*)",
"Bash(browse scrollintoview:*)", "Bash(browse set:*)",
"Bash(browse box:*)", "Bash(browse errors:*)",
"Bash(browse doctor:*)", "Bash(browse upgrade:*)",
"Bash(browse --max-output:*)"
```

**Do NOT modify settings files automatically.** Show the user the permissions and let them decide whether to add them.

## IMPORTANT

- Always call `browse` as a bare command (it's on PATH via global install).
- Do NOT use shell variables like `B=...` or full paths — they break Claude Code's permission matching.
- NEVER use `#` in CSS selectors — use `[id=foo]` instead of `#foo`. The `#` character breaks Claude Code's permission matching and triggers approval prompts.
- After `goto`, always run `browse wait --network-idle` before reading content or taking screenshots. Pages with dynamic content, SPAs, and lazy-loaded assets need time to fully render.
- Screenshots MUST be saved to `.browse/sessions/default/` (or `.browse/sessions/<session-id>/` when using `--session`). Use descriptive filenames like `browse screenshot .browse/sessions/default/homepage.png`. NEVER save screenshots to `/tmp` or any other location.
- The browser persists between calls — cookies, tabs, and state carry over.
- The server auto-starts on first command. No manual setup needed.
- Use `--session <id>` for parallel agent isolation. Each session gets its own tabs, refs, cookies.
- Use `--json` for structured output (`{success, data, command}`).
- Use `--content-boundaries` for prompt injection defense.
- Use `--allowed-domains domain1,domain2` to restrict navigation.

## Quick Reference

```bash
# Navigate to a page
browse goto https://example.com

# Read cleaned page text
browse text

# Take a screenshot (then Read the image — saved to .browse/sessions/default/screenshot.png)
browse screenshot

# Snapshot: accessibility tree with refs
browse snapshot -i

# Click by ref (after snapshot)
browse click @e3

# Fill by ref
browse fill @e4 "test@test.com"

# Double-click, focus, check/uncheck
browse dblclick @e3
browse focus @e5
browse check @e7
browse uncheck @e7

# Drag and drop
browse drag @e1 @e2

# Run JavaScript
browse js "document.title"

# Get all links
browse links

# Get input value / count elements
browse value "[id=email]"
browse count ".search-result"

# Click by CSS selector
browse click "button.submit"

# Fill a form by CSS selector (use [id=...] instead of # to avoid shell issues)
browse fill "[id=email]" "test@test.com"
browse fill "[id=password]" "abc123"
browse click "button[type=submit]"

# Scroll
browse scroll up
browse scroll down
browse scroll "[id=target]"

# Wait for navigation or network
browse wait ".loaded"
browse wait --url "**/dashboard"
browse wait --network-idle

# iframe targeting
browse frame "[id=my-iframe]"
browse text                    # reads from inside the iframe
browse click @e3               # clicks inside the iframe
browse frame main              # back to main page

# Highlight an element (visual debugging)
browse highlight @e5

# Download a file
browse download @e3 ./file.pdf

# Network mocking
browse route "**/*.png" block
browse route "**/api/data" fulfill 200 '{"mock":true}'
browse route clear

# Offline mode
browse offline on
browse offline off

# JSON output mode
browse --json goto https://example.com

# Security: content boundaries
browse --content-boundaries text

# Security: domain restriction
browse --allowed-domains example.com,*.cdn.example.com goto https://example.com

# State persistence
browse state save mysite
browse state load mysite
browse state clean                    # delete states older than 7 days
browse state clean --older-than 30    # custom threshold

# Cookie management
browse cookie clear                                      # clear all cookies
browse cookie set auth token --domain .example.com       # set with options
browse cookie export ./cookies.json                      # export to file
browse cookie import ./cookies.json                      # import from file

# Cookie import from real browsers (macOS — Chrome, Arc, Brave, Edge)
browse cookie-import --list                              # show installed browsers
browse cookie-import chrome --domain .example.com        # import cookies for a domain
browse cookie-import arc --domain .github.com            # import from Arc
browse cookie-import chrome --profile "Profile 1" --domain .site.com  # specific Chrome profile

# Session auto-persistence (named sessions survive restarts)
browse --session myapp goto https://app.com/login        # login...
browse session-close myapp                               # state auto-saved (encrypted if BROWSE_ENCRYPTION_KEY set)
browse --session myapp goto https://app.com/dashboard    # cookies auto-restored

# Load state at launch
browse --state auth.json goto https://app.com            # load cookies before first command

# Auth vault (credentials never visible to LLM)
browse auth save github https://github.com/login user pass123
browse auth login github

# HAR recording
browse har start
browse goto https://example.com
browse har stop ./recording.har

# Video recording (watch a .webm of the session)
browse video start ./videos
browse goto https://example.com
browse click @e3
browse video stop

# Command recording (export replayable scripts)
browse record start
browse goto https://example.com
browse click "a"
browse fill "[id=search]" "test query"
browse record stop
browse record export replay ./recording.json    # replay with: npx @puppeteer/replay ./recording.json
browse record export browse ./steps.json        # replay with: cat steps.json | browse chain

# Both together (video + replayable script)
browse video start ./videos
browse record start
browse goto https://example.com
browse snapshot -i
browse click @e3
browse fill "[id=email]" "user@test.com"
browse record stop
browse video stop
browse record export replay ./recording.json

# Device emulation
browse emulate iphone
browse emulate reset

# Parallel sessions
browse --session agent-a goto https://site1.com
browse --session agent-b goto https://site2.com

# Clipboard
browse clipboard
browse clipboard write "copied text"

# Find elements semantically
browse find role button
browse find text "Submit"
browse find testid "login-btn"

# Screenshot diff (visual regression)
browse screenshot-diff baseline.png current.png

# Headed mode (visible browser)
browse --headed goto https://example.com

# Stealth mode (bypasses bot detection)
# Requires: bun add rebrowser-playwright && npx rebrowser-playwright install chromium
browse --runtime rebrowser goto https://example.com

# State list / show
browse state list
browse state show mysite
```

## Command Reference

### Navigation
```
browse goto <url>         Navigate current tab
browse back               Go back
browse forward            Go forward
browse reload             Reload page
browse url                Print current URL
```

### Content extraction
```
browse text               Cleaned page text (no scripts/styles)
browse html [selector]    innerHTML of element, or full page HTML
browse links              All links as "text → href"
browse forms              All forms + fields as JSON
browse accessibility      Accessibility tree snapshot (ARIA)
```

### Snapshot (ref-based element selection)
```
browse snapshot           Full accessibility tree with @refs
browse snapshot -i        Interactive elements only — terse flat list (minimal tokens)
browse snapshot -i -f     Interactive elements — full indented tree with props
browse snapshot -i -V     Interactive elements — viewport only (skip below-fold)
browse snapshot -c        Compact (no empty structural elements)
browse snapshot -C        Cursor-interactive (detect divs with cursor:pointer/onclick/tabindex)
browse snapshot -d <N>    Limit depth to N levels
browse snapshot -s <sel>  Scope to CSS selector
browse snapshot-diff      Compare current vs previous snapshot
```

After snapshot, use @refs as selectors in any command:
```
browse click @e3          Click the element assigned ref @e3
browse fill @e4 "value"   Fill the input assigned ref @e4
browse hover @e1          Hover the element assigned ref @e1
browse html @e2           Get innerHTML of ref @e2
browse css @e5 "color"    Get computed CSS of ref @e5
browse attrs @e6          Get attributes of ref @e6
```

Refs are invalidated on navigation — run `snapshot` again after `goto`.

### Interaction
```
browse click <selector>        Click element (CSS selector or @ref)
browse click <x>,<y>           Click at page coordinates (e.g. 590,461)
browse rightclick <selector>   Right-click element (context menu)
browse dblclick <selector>     Double-click element
browse fill <selector> <value> Fill input field
browse select <selector> <val> Select dropdown value
browse hover <selector>        Hover over element
browse focus <selector>        Focus element
browse check <selector>        Check checkbox
browse uncheck <selector>      Uncheck checkbox
browse tap <selector>          Tap element (requires touch context via emulate)
browse drag <src> <tgt>        Drag source to target
browse type <text>             Type into focused element
browse press <key>             Press key (Enter, Tab, Escape, etc.)
browse keydown <key>           Hold key down
browse keyboard inserttext <t> Insert text without key events
browse keyup <key>             Release key
browse scrollinto <sel>        Scroll element into view (explicit)
browse swipe <dir> [px]        Swipe up/down/left/right (touch events)
browse mouse move <x> <y>     Move mouse to coordinates
browse mouse down [button]     Press mouse button (left/right/middle)
browse mouse up [button]       Release mouse button
browse mouse wheel <dy> [dx]   Scroll wheel
browse scroll [sel|up|down]    Scroll element/viewport/bottom
browse wait <sel>              Wait for element to appear
browse wait <sel> --state hidden  Wait for element to disappear
browse wait <ms>               Wait for milliseconds
browse wait --text "..."       Wait for text to appear in page
browse wait --fn "expr"        Wait for JavaScript condition
browse wait --load <state>     Wait for load state
browse wait --url <pattern>    Wait for URL match
browse wait --network-idle     Wait for network idle
browse set geo <lat> <lng>     Set geolocation
browse set media <scheme>      Set color scheme (dark/light/no-preference)
browse viewport <WxH>          Set viewport size (e.g. 375x812)
browse upload <sel> <files>    Upload file(s) to a file input
browse highlight <selector>    Highlight element (visual debugging)
browse download <sel> [path]   Download file triggered by click
browse dialog-accept [value]   Set dialogs to auto-accept
browse dialog-dismiss          Set dialogs to auto-dismiss (default)
browse emulate <device>        Emulate device (iphone, pixel, etc.)
browse emulate reset           Reset to desktop (1920x1080)
browse offline [on|off]        Toggle offline mode
```

### Network
```
browse route <pattern> block           Block matching requests
browse route <pattern> fulfill <s> [b] Mock with status + body
browse route clear                     Remove all routes
```

### Inspection
```
browse js <expression>         Run JS, print result
browse eval <js-file>          Run JS file against page
browse css <selector> <prop>   Get computed CSS property
browse attrs <selector>        Get element attributes as JSON
browse element-state <selector> Element state (visible/enabled/checked/focused)
browse value <selector>        Get input field value
browse box <selector>          Get bounding box as JSON {x, y, width, height}
browse count <selector>        Count matching elements
browse dialog                  Last dialog info or "(no dialog detected)"
browse errors [--clear]        View/clear page errors (filtered from console)
browse console [--clear]       View/clear console messages
browse network [--clear]       View/clear network requests
browse cookies                 Dump all cookies as JSON
browse storage [set <k> <v>]   View/set localStorage
browse perf                    Page load performance timings
browse devices [filter]        List available device names
browse clipboard               Read system clipboard text
browse clipboard write <text>  Write text to system clipboard
```

### Visual
```
browse screenshot [path]              Viewport screenshot (default: .browse/sessions/{id}/screenshot.png)
browse screenshot <sel|@ref> [path]   Screenshot specific element
browse screenshot --clip x,y,w,h [path]  Screenshot clipped region
browse screenshot --full [path]       Full-page screenshot (entire scrollable page)
browse screenshot --annotate [path]   Screenshot with numbered badges + legend
browse pdf [path]                     Save as PDF
browse responsive [prefix]            Screenshots at mobile/tablet/desktop
```

### Frames (iframe targeting)
```
browse frame <selector>        Target an iframe (subsequent commands run inside it)
browse frame main              Return to main page
```

### Find (semantic element locators)
```
browse find role <query>              Find elements by ARIA role
browse find text <query>              Find elements by text content
browse find label <query>             Find elements by label
browse find placeholder <query>       Find elements by placeholder
browse find testid <query>            Find elements by test ID
browse find alt <query>               Find elements by alt text
browse find title <query>             Find elements by title attribute
browse find first <sel>               First matching element
browse find last <sel>                Last matching element
browse find nth <n> <sel>             Nth matching element (0-indexed)
```

### Compare
```
browse diff <url1> <url2>             Text diff between two pages
browse screenshot-diff <base> [curr]  Pixel-diff two PNG screenshots
```

### Multi-step (chain)
```
echo '[["goto","https://example.com"],["snapshot","-i"],["click","@e1"]]' | browse chain
```

### Tabs
```
browse tabs                    List tabs (id, url, title)
browse tab <id>                Switch to tab
browse newtab [url]            Open new tab
browse closetab [id]           Close tab
```

### Sessions (parallel agents)
```
browse --session <id> <cmd>    Run command in named session
browse sessions                List active sessions
browse session-close <id>      Close a session
```

### State persistence
```
browse state save [name]       Save cookies + localStorage (all origins)
browse state load [name]       Restore saved state
browse state list              List saved states
browse state show [name]       Show contents of saved state
browse state clean             Delete states older than 7 days
browse state clean --older-than N   Custom age threshold (days)
```

### Cookie import (macOS — borrow auth from real browsers)
```
browse cookie-import --list                         List installed browsers
browse cookie-import <browser> --domain <d>         Import cookies for a domain
browse cookie-import <browser> --profile <p> --domain <d>   Specific Chrome profile
```

### Auth vault
```
browse auth save <name> <url> <user> <pass>   Save credentials (encrypted)
browse auth login <name>                       Auto-login using saved credentials
browse auth list                               List saved credentials
browse auth delete <name>                      Delete credentials
```

### HAR recording
```
browse har start               Start recording network traffic
browse har stop [path]         Stop and save HAR file
```

### Video recording
```
browse video start [dir]       Start recording video (WebM, compositor-level)
browse video stop              Stop recording and save video files
browse video status            Check if recording is active
```

### Command recording & export
```
browse record start                    Start recording commands
browse record stop                     Stop recording, keep steps for export
browse record status                   Recording state and step count
browse record export browse [path]     Export as chain-compatible JSON (replay with browse chain)
browse record export replay [path]    Export as Chrome DevTools Recorder (Playwright/Puppeteer)
```

### Server management
```
browse status                  Server health, uptime, session count
browse instances               List all running browse servers (instance, PID, port, status)
browse stop                    Shutdown server
browse restart                 Kill + restart server
browse inspect                 Open DevTools (requires BROWSE_DEBUG_PORT)
browse version                 Print CLI version
browse doctor                  System check (Bun, Playwright, Chromium)
browse upgrade                 Self-update via npm
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--session <id>` | Named session (isolates tabs, refs, cookies — auto-persists on close) |
| `--state <path>` | Load state file (cookies/storage) before first command |
| `--json` | Wrap output as `{success, data, command}` |
| `--content-boundaries` | Wrap page content in nonce-delimited markers (prompt injection defense) |
| `--allowed-domains <d,d>` | Block navigation/resources outside allowlist |
| `--headed` | Run browser in headed (visible) mode |
| `--runtime <name>` | Browser engine: playwright (default), rebrowser (stealth) |
| `--max-output <n>` | Truncate output to N characters |

## Speed Rules

1. **Navigate once, query many times.** `goto` loads the page; then `text`, `js`, `css`, `screenshot` all run against the loaded page instantly.
2. **Use `snapshot -i` for interaction.** Get refs for all interactive elements, then click/fill by ref. No need to guess CSS selectors.
3. **Use `snapshot -C` for SPAs.** Catches cursor:pointer divs and onclick handlers that ARIA misses.
4. **Use `js` for precision.** `js "document.querySelector('.price').textContent"` is faster than parsing full page text.
5. **Use `links` to survey.** Faster than `text` when you just need navigation structure.
6. **Use `chain` for multi-step flows.** Avoids CLI overhead per step.
7. **Use `responsive` for layout checks.** One command = 3 viewport screenshots.
8. **Use `--session` for parallel work.** Multiple agents can browse simultaneously without interference.
9. **Use `value`/`count` instead of `js`.** Purpose-built commands are cleaner than `js "document.querySelector(...).value"`.
10. **Use `frame` for iframes.** Don't try to reach into iframes with CSS — use `frame [id=x]` first.

## When to Use What

| Task | Commands |
|------|----------|
| Read a page | `goto <url>` then `text` |
| Interact with elements | `snapshot -i` then `click @e3` |
| Find hidden clickables | `snapshot -i -C` then `click @e15` |
| Check if element exists | `count ".thing"` |
| Get input value | `value "[id=email]"` |
| Extract specific data | `js "document.querySelector('.price').textContent"` |
| Visual check | `screenshot` then `Read .browse/sessions/default/screenshot.png` |
| Fill and submit form | `snapshot -i` → `fill @e4 "val"` → `click @e5` |
| Check/uncheck boxes | `check @e7` / `uncheck @e7` |
| Check CSS | `css "selector" "property"` or `css @e3 "property"` |
| Inspect DOM | `html "selector"` or `attrs @e3` |
| Debug console errors | `console` |
| Check network requests | `network` |
| Mock API responses | `route "**/api/*" fulfill 200 '{"data":[]}'` |
| Block ads/trackers | `route "**/*.doubleclick.net/*" block` |
| Test offline behavior | `offline on` → test → `offline off` |
| Interact in iframe | `frame "[id=payment]"` → `fill @e2 "4242..."` → `frame main` |
| Check local dev | `goto http://127.0.0.1:3000` |
| Compare two pages | `diff <url1> <url2>` |
| Mobile layout check | `responsive .browse/sessions/default/resp` |
| Test on mobile device | `emulate iphone` → `goto <url>` → `screenshot` |
| Save/restore session | `state save mysite` / `state load mysite` |
| Auto-login | `auth save gh https://github.com/login user pass` → `auth login gh` |
| Record network | `har start` → browse around → `har stop ./out.har` |
| Record video | `video start ./vids` → browse around → `video stop` |
| Export automation script | `record start` → browse around → `record export replay ./recording.json` |
| Parallel agents | `--session agent-a <cmd>` / `--session agent-b <cmd>` |
| Multi-step flow | `echo '[...]' \| browse chain` |
| Secure browsing | `--allowed-domains example.com goto https://example.com` |
| Scroll through results | `scroll down` → `text` → `scroll down` → `text` |
| Drag and drop | `drag @e1 @e2` |
| Read/write clipboard | `clipboard` / `clipboard write "text"` |
| Find by accessibility | `find role button` / `find text "Submit"` |
| Visual regression | `screenshot-diff baseline.png` |
| Debug with DevTools | `inspect` (set BROWSE_DEBUG_PORT first) |
| See the browser | `browse --headed goto <url>` |
| Bypass bot detection | `--runtime rebrowser goto <url>` |
| Get element position | `box @e3` |
| Check page errors | `errors` |
| Right-click context menu | `rightclick @e3` |
| Test mobile gestures | `emulate iphone` → `tap @e1` / `swipe down` |
| Set dark mode | `set media dark` |
| Test geolocation | `set geo 37.7 -122.4` → verify in page |
| Export/import cookies | `cookie export ./cookies.json` / `cookie import ./cookies.json` |
| Limit output size | `--max-output 5000 text` |

## Architecture

- Persistent Chromium daemon on localhost (port 9400-10400)
- Bearer token auth per session
- One server per project directory — `--session` handles agent isolation
- Session multiplexing: multiple agents share one Chromium via isolated BrowserContexts
- For separate servers: set `BROWSE_INSTANCE` env var (e.g., fault isolation between teams)
- `browse instances` — discover all running servers (PID, port, status, session count)
- Project-local state: `.browse/` directory at project root (auto-created, self-gitignored)
  - `sessions/{id}/` — per-session screenshots, logs, PDFs
  - `states/{name}.json` — saved browser state (cookies + localStorage)
  - `browse-server.json` — server PID, port, auth token
- Auto-shutdown when all sessions idle past 30 min
- Chromium crash → server exits → auto-restarts on next command
- AI-friendly error messages: Playwright errors rewritten to actionable hints
- CDP remote connection: `BROWSE_CDP_URL` to connect to existing Chrome
- Policy enforcement: `browse-policy.json` for allow/deny/confirm rules
- Two browser engines: playwright (default) and rebrowser (stealth, bypasses bot detection)
