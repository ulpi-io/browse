---
name: browse
version: 1.0.0
description: |
  Fast web browsing for Claude Code via persistent headless Chromium daemon. Navigate to any URL,
  read page content, click elements, fill forms, run JavaScript, take screenshots,
  inspect CSS/DOM, capture console/network logs, and more. ~100ms per command after
  first call. Use when you need to check a website, verify a deployment, read docs,
  or interact with any web page. No MCP, no Chrome extension — just fast CLI.
allowed-tools:
  - Bash
  - Read

---

# browse: Persistent Browser for Claude Code

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
"Bash(browse fill:*)", "Bash(browse select:*)", "Bash(browse hover:*)",
"Bash(browse type:*)", "Bash(browse press:*)", "Bash(browse scroll:*)",
"Bash(browse wait:*)", "Bash(browse viewport:*)", "Bash(browse upload:*)",
"Bash(browse dialog-accept:*)", "Bash(browse dialog-dismiss:*)",
"Bash(browse js:*)", "Bash(browse eval:*)", "Bash(browse css:*)",
"Bash(browse attrs:*)", "Bash(browse state:*)", "Bash(browse dialog:*)",
"Bash(browse console:*)", "Bash(browse network:*)",
"Bash(browse cookies:*)", "Bash(browse storage:*)", "Bash(browse perf:*)",
"Bash(browse devices:*)", "Bash(browse emulate:*)",
"Bash(browse screenshot:*)", "Bash(browse pdf:*)",
"Bash(browse responsive:*)", "Bash(browse diff:*)",
"Bash(browse chain:*)", "Bash(browse tabs:*)", "Bash(browse tab:*)",
"Bash(browse newtab:*)", "Bash(browse closetab:*)",
"Bash(browse sessions:*)", "Bash(browse session-close:*)",
"Bash(browse status:*)", "Bash(browse stop:*)", "Bash(browse restart:*)",
"Bash(browse cookie:*)", "Bash(browse header:*)",
"Bash(browse useragent:*)"
```

## IMPORTANT

- Always call `browse` as a bare command (it's on PATH via global install).
- Do NOT use shell variables like `B=...` or full paths — they break Claude Code's permission matching.
- NEVER use `#` in CSS selectors — use `[id=foo]` instead of `#foo`. The `#` character breaks Claude Code's permission matching and triggers approval prompts.
- The browser persists between calls — cookies, tabs, and state carry over.
- The server auto-starts on first command. No manual setup needed.
- Use `--session <id>` for parallel agent isolation. Each session gets its own tabs, refs, cookies.

## Quick Reference

```bash
# Navigate to a page
browse goto https://example.com

# Read cleaned page text
browse text

# Take a screenshot (then Read the image)
browse screenshot .browse/page.png

# Snapshot: accessibility tree with refs
browse snapshot -i

# Click by ref (after snapshot)
browse click @e3

# Fill by ref
browse fill @e4 "test@test.com"

# Run JavaScript
browse js "document.title"

# Get all links
browse links

# Click by CSS selector
browse click "button.submit"

# Fill a form by CSS selector (use [id=...] instead of # to avoid shell issues)
browse fill "[id=email]" "test@test.com"
browse fill "[id=password]" "abc123"
browse click "button[type=submit]"

# Get HTML of an element
browse html "main"

# Get computed CSS
browse css "body" "font-family"

# Get element attributes
browse attrs "nav"

# Wait for element to appear
browse wait ".loaded"

# Device emulation
browse emulate iphone
browse emulate reset

# Parallel sessions
browse --session agent-a goto https://site1.com
browse --session agent-b goto https://site2.com
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
browse snapshot -i        Interactive elements only (buttons, links, inputs)
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
browse fill <selector> <value> Fill input field
browse select <selector> <val> Select dropdown value
browse hover <selector>        Hover over element
browse type <text>             Type into focused element
browse press <key>             Press key (Enter, Tab, Escape, etc.)
browse scroll [selector]       Scroll element into view, or page bottom
browse wait <selector>         Wait for element to appear (max 15s)
browse viewport <WxH>          Set viewport size (e.g. 375x812)
browse upload <sel> <files>    Upload file(s) to a file input
browse dialog-accept [value]   Set dialogs to auto-accept
browse dialog-dismiss          Set dialogs to auto-dismiss (default)
browse emulate <device>        Emulate device (iphone, pixel, etc.)
browse emulate reset           Reset to desktop (1920x1080)
```

### Inspection
```
browse js <expression>         Run JS, print result
browse eval <js-file>          Run JS file against page
browse css <selector> <prop>   Get computed CSS property
browse attrs <selector>        Get element attributes as JSON
browse state <selector>        Element state (visible/enabled/checked/focused)
browse dialog                  Last dialog info or "(no dialog detected)"
browse console [--clear]       View/clear console messages
browse network [--clear]       View/clear network requests
browse cookies                 Dump all cookies as JSON
browse storage [set <k> <v>]   View/set localStorage
browse perf                    Page load performance timings
browse devices [filter]        List available device names
```

### Visual
```
browse screenshot [path]              Screenshot (default: .browse/browse-screenshot.png)
browse screenshot --annotate [path]   Screenshot with numbered badges + legend
browse pdf [path]                     Save as PDF
browse responsive [prefix]            Screenshots at mobile/tablet/desktop
```

### Compare
```
browse diff <url1> <url2>      Text diff between two pages
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

### Server management
```
browse status                  Server health, uptime, session count
browse stop                    Shutdown server
browse restart                 Kill + restart server
```

## Speed Rules

1. **Navigate once, query many times.** `goto` loads the page; then `text`, `js`, `css`, `screenshot` all run against the loaded page instantly.
2. **Use `snapshot -i` for interaction.** Get refs for all interactive elements, then click/fill by ref. No need to guess CSS selectors.
3. **Use `snapshot -C` for SPAs.** Catches cursor:pointer divs and onclick handlers that ARIA misses.
4. **Use `js` for precision.** `js "document.querySelector('.price').textContent"` is faster than parsing full page text.
5. **Use `links` to survey.** Faster than `text` when you just need navigation structure.
6. **Use `chain` for multi-step flows.** Avoids CLI overhead per step.
7. **Use `responsive` for layout checks.** One command = 3 viewport screenshots.
8. **Use `--session` for parallel work.** Multiple agents can browse simultaneously without interference.

## When to Use What

| Task | Commands |
|------|----------|
| Read a page | `goto <url>` then `text` |
| Interact with elements | `snapshot -i` then `click @e3` |
| Find hidden clickables | `snapshot -i -C` then `click @e15` |
| Check if element exists | `js "!!document.querySelector('.thing')"` |
| Extract specific data | `js "document.querySelector('.price').textContent"` |
| Visual check | `screenshot .browse/x.png` then Read the image |
| Fill and submit form | `snapshot -i` → `fill @e4 "val"` → `click @e5` |
| Check CSS | `css "selector" "property"` or `css @e3 "property"` |
| Inspect DOM | `html "selector"` or `attrs @e3` |
| Debug console errors | `console` |
| Check network requests | `network` |
| Check local dev | `goto http://127.0.0.1:3000` |
| Compare two pages | `diff <url1> <url2>` |
| Mobile layout check | `responsive .browse/prefix` |
| Test on mobile device | `emulate iphone` → `goto <url>` → `screenshot` |
| Parallel agents | `--session agent-a <cmd>` / `--session agent-b <cmd>` |
| Multi-step flow | `echo '[...]' \| browse chain` |

## Architecture

- Persistent Chromium daemon on localhost (port 9400-9410)
- Bearer token auth per session
- Session multiplexing: multiple agents share one Chromium via isolated BrowserContexts
- Project-local state: `.browse/` directory at project root (auto-created, self-gitignored)
  - `browse-server.json` — server PID, port, auth token
  - `browse-console.log` — captured console messages
  - `browse-network.log` — captured network requests
  - `browse-screenshot.png` — default screenshot location
- Auto-shutdown when all sessions idle past 30 min
- Chromium crash → server exits → auto-restarts on next command
