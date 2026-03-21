---
name: browse
version: 2.4.0
description: |
  Fast web browsing for AI coding agents via persistent headless Chromium daemon. Navigate to any URL,
  read page content, click elements, fill forms, run JavaScript, take screenshots,
  inspect CSS/DOM, capture console/network logs, and more. ~100ms per command after
  first call. Works with Claude Code, Cursor, Cline, Windsurf, and any agent that can run Bash.
  No MCP, no Chrome extension — just fast CLI.
allowed-tools:
  - Bash
  - Read

---

# browse: Persistent Browser for AI Coding Agents

Persistent headless Chromium daemon. First call auto-starts the server (~3s).
Every subsequent call: ~100-200ms. Auto-shuts down after 30 min idle.

## SETUP (run this check BEFORE any browse command)

```bash
# Check if browse is available
if command -v browse &>/dev/null; then
  echo "READY"
else
  echo "NEEDS_INSTALL"
fi
```

If `NEEDS_INSTALL`:
1. Tell the user: "browse needs a one-time install via npm. OK to proceed?"
2. If they approve: `bun install -g @ulpi/browse`
3. If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`

### Permissions check

After confirming browse is available, check if browse commands are pre-allowed:

```bash
cat .claude/settings.json 2>/dev/null
```

If the file is missing or does not contain browse permission rules in `permissions.allow`:
1. Tell the user: "browse works best when its commands are pre-allowed so you don't get prompted on every call. Add browse permissions to `.claude/settings.json`?"
2. If they approve, read the existing `.claude/settings.json` (or create it), and add ALL of these rules to `permissions.allow` (merge with existing rules — do not overwrite):

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
"Bash(browse state:*)", "Bash(browse auth:*)", "Bash(browse har:*)", "Bash(browse video:*)",
"Bash(browse route:*)", "Bash(browse offline:*)",
"Bash(browse status:*)", "Bash(browse stop:*)", "Bash(browse restart:*)",
"Bash(browse cookie:*)", "Bash(browse header:*)",
"Bash(browse useragent:*)",
"Bash(browse clipboard:*)", "Bash(browse screenshot-diff:*)",
"Bash(browse find:*)", "Bash(browse inspect:*)",
"Bash(browse instances:*)", "Bash(browse --headed:*)"
```

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

# Auth vault (credentials never visible to LLM)
browse auth save github https://github.com/login user pass123
browse auth login github

# HAR recording
browse har start
browse goto https://example.com
browse har stop ./recording.har

# Video recording
browse video start ./videos
browse goto https://example.com
browse click @e3
browse video stop

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

# Fast headless engine (10x faster, lower memory)
# Requires: curl -L -o ~/.local/bin/lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-aarch64-macos && chmod a+x ~/.local/bin/lightpanda
browse --runtime lightpanda goto https://example.com

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
browse snapshot -i -v     Interactive elements — verbose indented tree with props
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
browse dblclick <selector>     Double-click element
browse fill <selector> <value> Fill input field
browse select <selector> <val> Select dropdown value
browse hover <selector>        Hover over element
browse focus <selector>        Focus element
browse check <selector>        Check checkbox
browse uncheck <selector>      Uncheck checkbox
browse drag <src> <tgt>        Drag source to target
browse type <text>             Type into focused element
browse press <key>             Press key (Enter, Tab, Escape, etc.)
browse keydown <key>           Hold key down
browse keyup <key>             Release key
browse scroll [sel|up|down]    Scroll element/viewport/bottom
browse wait <sel|--url|--network-idle>  Wait for element, URL, or network
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
browse count <selector>        Count matching elements
browse dialog                  Last dialog info or "(no dialog detected)"
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

### Server management
```
browse status                  Server health, uptime, session count
browse instances               List all running browse servers (instance, PID, port, status)
browse version                 Print CLI version
browse stop                    Shutdown server
browse restart                 Kill + restart server
browse inspect                 Open DevTools (requires BROWSE_DEBUG_PORT)
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--session <id>` | Named session (isolates tabs, refs, cookies) |
| `--json` | Wrap output as `{success, data, command}` |
| `--content-boundaries` | Wrap page content in nonce-delimited markers (prompt injection defense) |
| `--allowed-domains <d,d>` | Block navigation/resources outside allowlist |
| `--headed` | Run browser in headed (visible) mode |
| `--runtime <name>` | Browser runtime: playwright (default), rebrowser (stealth), lightpanda (fast) |

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
| Fast scraping | `--runtime lightpanda goto <url>` |

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
- Runtime abstraction: `--runtime` selects browser engine (playwright default, rebrowser for stealth, lightpanda for speed)
