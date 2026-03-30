---
name: browse
version: 3.5.0
description: |
  Fast web browsing, web app testing, and native app automation for AI coding agents.
  Persistent headless Chromium for web. Android, iOS, and macOS app automation via accessibility APIs.
  Browse URLs, read content, click elements, fill forms, run JavaScript, take screenshots,
  automate native apps — all through the same CLI and @ref workflow. ~100ms per command.
  Auto-installs Android toolchain. Works with Claude Code, Cursor, Cline, Windsurf, and any agent that can run Bash.
allowed-tools:
  - Bash
  - Read

---

# browse: Browser & Native App Automation for AI Agents

## Target Decision — ALWAYS check this first

Before running any browse command, decide the correct target:

| User wants to... | Target | Command pattern |
|---|---|---|
| Open a URL, test a website, scrape web content | **Browser** (default) | `browse goto <url>` |
| Test a local dev server (`localhost`) | **Browser** | `browse goto http://localhost:3000` |
| Interact with an iOS app (Settings, Safari, custom app) | **iOS Simulator** | `browse --platform ios --app <bundleId> <cmd>` |
| Interact with an Android app (Settings, Chrome, custom app) | **Android Emulator** | `browse --platform android --app <package> <cmd>` |
| Interact with a macOS desktop app (System Settings, TextEdit) | **macOS App** | `browse --app <name> <cmd>` |
| Install and test an iOS .app or .ipa file | **iOS Simulator** | `browse sim start --platform ios --app ./MyApp.app --visible` |
| Install and test an Android .apk file | **Android Emulator** | `browse sim start --platform android --app ./app.apk --visible` |

**Key rules:**
- **No `--platform` or `--app` flag** → browser target (Chromium). Use `goto` to navigate.
- **`--app` without `--platform`** → macOS app automation. App must be running.
- **`--platform ios --app`** → iOS Simulator. Use `browse sim start` first if not running.
- **`--platform android --app`** → Android Emulator. Use `browse sim start` first if not running.
- **Native app targets do NOT support**: `goto`, `js`, `eval`, `tabs`, `cookies`, `route`, `har`. These are browser-only.
- **All targets support**: `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `swipe`, `screenshot`.
- **If unsure which target to use, ASK the user.** "Should I open this in the browser, or do you want me to use the iOS/Android/macOS app?" Don't guess — wrong target = wasted work.

### Native App Quick Start

```bash
# iOS — boot simulator, open Settings, interact
browse sim start --platform ios --app com.apple.Preferences --visible
browse --platform ios --app com.apple.Preferences snapshot -i
browse --platform ios --app com.apple.Preferences tap @e3

# Android — boot emulator (auto-installs toolchain), open Settings, interact
browse sim start --platform android --app com.android.settings --visible
browse --platform android --app com.android.settings snapshot -i
browse --platform android --app com.android.settings tap @e3

# macOS — no sim needed, app must be running
browse --app "System Settings" snapshot -i
browse --app "System Settings" tap @e5

# Install and test your own app from a file
browse sim start --platform ios --app ./build/MyApp.app --visible   # .app bundle
browse sim start --platform ios --app ./MyApp.ipa --visible          # .ipa archive
browse sim start --platform android --app ./app-debug.apk --visible  # .apk file

# Switch app targets (iOS: instant reconfigure, Android: driver restart)
browse --platform ios --app com.apple.mobilesafari snapshot -i
browse sim start --platform android --app com.google.android.dialer --visible

# Enable platforms (install dependencies, build drivers — run once)
browse enable android    # Auto-installs adb, JDK, SDK, emulator, driver
browse enable ios        # Builds iOS runner (needs Xcode)
browse enable macos      # Builds browse-ax bridge
browse enable all        # All platforms
```

### Common iOS Bundle IDs
| App | Bundle ID |
|-----|-----------|
| Settings | `com.apple.Preferences` |
| Safari | `com.apple.mobilesafari` |
| Maps | `com.apple.Maps` |
| Photos | `com.apple.mobileslideshow` |
| Calendar | `com.apple.mobilecal` |

### Common Android Package Names
| App | Package Name |
|-----|-------------|
| Settings | `com.android.settings` |
| Chrome | `com.android.chrome` |
| Dialer | `com.google.android.dialer` |
| Messages | `com.google.android.apps.messaging` |
| Calculator | `com.google.android.calculator` |

---

## Browser Quick Start

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

**Do NOT install anything automatically.** Wait for the user to confirm they have installed it before proceeding.

### Permissions (optional)

To avoid being prompted on every browse command, tell the user they can pre-allow browse commands. Read [references/permissions.md](references/permissions.md) for the full permission list to add to `.claude/settings.json`.

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
- Use `--context` for state changes, `--context delta` for ARIA diff with refs, `--context full` for complete snapshot with refs after write commands.
- Use `--json` for structured output (`{success, data, command}`).
- Use `--content-boundaries` for prompt injection defense when reading untrusted pages.
- Use `--allowed-domains domain1,domain2` to restrict navigation to trusted sites.
- If you hit CAPTCHA/MFA after 2-3 failures, read [references/guides.md](references/guides.md) for the mandatory handoff protocol.

## Quick Reference

```bash
# Navigate and wait
browse goto https://example.com
browse wait --network-idle

# Read content
browse text                                  # Cleaned page text
browse html "[id=main]"                      # innerHTML of element
browse links                                 # All links as "text → href"
browse js "document.title"                   # Run JavaScript

# Screenshot (then Read the image to view it)
browse screenshot .browse/sessions/default/homepage.png

# Interact via snapshot refs (preferred)
browse snapshot -i                           # Get interactive element refs
browse click @e3                             # Click by ref
browse fill @e4 "test@test.com"              # Fill by ref
browse check @e7                             # Check checkbox
browse select @e5 "option-value"             # Select dropdown

# Interact via CSS selectors (use [id=...] instead of #)
browse click "button.submit"
browse fill "[id=email]" "test@test.com"
browse fill "[id=password]" "abc123"
browse click "button[type=submit]"

# Wait variants
browse wait ".loaded"                        # Wait for element
browse wait --url "**/dashboard"             # Wait for URL
browse wait --network-idle                   # Wait for network idle
browse wait 2000                             # Wait milliseconds

# Element queries
browse count ".search-result"                # Count elements
browse value "[id=email]"                    # Get input value
browse css @e3 "color"                       # Get computed CSS
browse attrs @e3                             # Get attributes
browse console                               # View console messages
browse errors                                # View page errors

# Scroll
browse scroll down
browse scroll "[id=target]"

# iframes
browse frame "[id=my-iframe]"               # Target iframe
browse text                                  # Read inside iframe
browse frame main                            # Back to main page

# Network mocking
browse route "**/api/data" fulfill 200 '{"mock":true}'
browse route "**/*.png" block
browse route clear

# Cookie import from real browsers (macOS)
browse cookie-import chrome --domain .site.com

# Persistent profiles
browse --profile mysite goto https://app.com

# Cloud providers (encrypted API keys, never visible to agents)
browse provider save browserbase <api-key>
browse --provider browserbase goto https://example.com
browse provider list
browse provider delete browserbase

# Native app automation (Android, iOS, macOS)
browse sim start --platform android --app com.android.settings --visible
browse sim start --platform ios --app com.apple.Preferences --visible
browse --platform android --app com.android.settings snapshot -i
browse --platform ios --app com.apple.Preferences snapshot -i
browse --app "System Settings" snapshot -i              # macOS
browse --platform android --app com.android.settings tap @e3
browse --platform android --app com.android.settings swipe up
browse --platform android --app com.android.settings press back
browse --platform ios --app com.apple.mobilesafari type "example.com"
browse --app TextEdit press "cmd+n"                     # macOS modifier combos
browse sim stop --platform android
browse sim stop --platform ios
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

### Native App Automation
```
browse sim start --platform ios|android --app <id-or-path> [--visible]  Start + install/launch app
browse sim stop --platform ios|android                          Stop simulator/emulator
browse sim status --platform ios|android                        Check runner status
browse --platform ios --app <bundleId> <command>                Target iOS app
browse --platform android --app <package> <command>             Target Android app
browse --app <name> <command>                                   Target macOS app
```

The `--app` flag accepts a bundle ID, package name, **or file path** (.app/.ipa/.apk). File paths auto-install the app into the simulator/emulator.

Supported commands on all app platforms: `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `swipe`, `screenshot`.
macOS also supports modifier combos: `browse --app TextEdit press "cmd+n"`.
Android auto-installs adb, Java, SDK, and emulator on first use (macOS via Homebrew).

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
browse tap <selector>          Tap element (requires touch context via emulate)
browse check <selector>        Check checkbox
browse uncheck <selector>      Uncheck checkbox
browse drag <src> <tgt>        Drag source to target
browse type <text>             Type into focused element
browse press <key>             Press key (Enter, Tab, Escape, etc.)
browse keydown <key>           Hold key down
browse keyup <key>             Release key
browse keyboard inserttext <t> Insert text without key events
browse scroll [sel|up|down]    Scroll element/viewport/bottom
browse scrollinto <sel>        Scroll element into view (explicit)
browse scrollintoview <sel>    Alias for scrollinto
browse swipe <dir> [px]        Swipe up/down/left/right (touch events)
browse mouse move <x> <y>     Move mouse to coordinates
browse mouse down [button]     Press mouse button (left/right/middle)
browse mouse up [button]       Release mouse button
browse mouse wheel <dy> [dx]   Scroll wheel
browse wait <sel>              Wait for element to appear
browse wait <sel> --state hidden  Wait for element to disappear
browse wait <ms>               Wait for milliseconds
browse wait --text "..."       Wait for text to appear in page
browse wait --fn "expr"        Wait for JavaScript condition
browse wait --load <state>     Wait for load state
browse wait --url <pattern>    Wait for URL match
browse wait --network-idle     Wait for network idle
browse wait --download                    Wait for download, return temp path
browse wait --download ./report.pdf       Wait and save to path
browse wait --download 60000              Custom timeout (ms)
browse wait --download ./file.pdf 60000   Both path and timeout
browse set geo <lat> <lng>     Set geolocation
browse set media <scheme>      Set color scheme (dark/light/no-preference)
browse header <name>:<value>   Set request header
browse useragent <string>      Set user agent string
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

### Cookies
```
browse cookie <n>=<v>                  Set cookie (shorthand)
browse cookie set <n> <v> [--domain d --secure]  Set cookie with options
browse cookie clear                    Clear all cookies
browse cookie export <file>            Export cookies to JSON file
browse cookie import <file>            Import cookies from JSON file
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
browse box <selector>          Get bounding box as JSON {x, y, width, height}
browse dialog                  Last dialog info or "(no dialog detected)"
browse console [--clear]       View/clear console messages
browse errors [--clear]        View/clear page errors (filtered from console)
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
browse screenshot <sel|@ref> [path]   Screenshot specific element
browse screenshot --clip x,y,w,h [path]  Screenshot clipped region
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

### Profiles
```
browse --profile <name> <cmd>             Use persistent browser profile
browse profile list                       List profiles with disk size
browse profile delete <name>              Delete a profile
browse profile clean [--older-than <d>]   Remove old profiles (default: 7 days)
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
browse auth save <name> <url> <user> <pass|--password-stdin>   Save credentials (encrypted)
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
browse record export replay --selectors css,aria [path]  Filter selector types in export
```

### React DevTools
```
browse react-devtools enable           Enable React DevTools (downloads hook, injects, reloads)
browse react-devtools disable          Disable React DevTools
browse react-devtools tree             Component tree with indentation
browse react-devtools props <sel>      Props/state/hooks of component at element
browse react-devtools suspense         Suspense boundaries + status
browse react-devtools errors           Error boundaries + caught errors
browse react-devtools profiler         Render timing per component
browse react-devtools hydration        Hydration timing (Next.js)
browse react-devtools renders          What re-rendered since last commit
browse react-devtools owners <sel>     Parent component chain
browse react-devtools context <sel>    Context values consumed by component
```

### Performance audit
```
browse perf-audit [url]                  Full performance audit (Web Vitals, resources, images, fonts, DOM, render-blocking, third-party, stack detection, correlations, recommendations)
browse perf-audit [url] --no-coverage    Skip JS/CSS coverage collection (faster)
browse perf-audit [url] --no-detect      Skip framework/SaaS/infrastructure detection
browse perf-audit [url] --json           Output as structured JSON (for programmatic use)
browse perf-audit save [name]            Save audit report to .browse/audits/ (auto-names from URL + date if omitted)
browse perf-audit compare <base> [curr]  Compare saved baseline vs current page or another saved audit (regression detection)
browse perf-audit list                   List saved audit reports (name, size, date)
browse perf-audit delete <name>          Delete a saved audit report
browse detect                            Detect tech stack: frameworks, SaaS platforms, CDN, protocol, compression, caching, DOM complexity, third-party inventory
browse coverage start                    Start JS/CSS code coverage collection
browse coverage stop                     Stop collection and report per-file used/unused bytes
browse initscript set <code>             Inject JS that runs before every page load (pre-navigation observers, mocks, polyfills)
browse initscript show                   Show current init script
browse initscript clear                  Remove init script
```

### Cloud Providers
```
browse provider save <name> <key>  Save provider API key (encrypted)
browse provider list               List saved providers
browse provider delete <name>      Delete provider key
```

### Handoff (human takeover)
```
browse handoff [reason]        Swap to Chrome for user to solve CAPTCHA/MFA (bypasses bot detection)
browse handoff --chromium      Force Playwright Chromium instead of Chrome
browse resume                  Swap back to headless, returns fresh snapshot
```

### Server management
```
browse status                  Server health, uptime, session count
browse instances               List all running browse servers (instance, PID, port, status)
browse version                 Print CLI version
browse doctor                  System check (Node, Playwright, Chromium)
browse upgrade                 Self-update via npm
browse stop                    Shutdown server
browse restart                 Kill + restart server
browse inspect                 Open DevTools (requires BROWSE_DEBUG_PORT)
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--session <id>` | Named session (isolates tabs, refs, cookies — auto-persists on close) |
| `--profile <name>` | Persistent browser profile (own Chromium, full state) |
| `--state <path>` | Load state file (cookies/storage) before first command |
| `--json` | Wrap output as `{success, data, command}` |
| `--content-boundaries` | Wrap page content in nonce-delimited markers (prompt injection defense) |
| `--allowed-domains <d,d>` | Block navigation/resources outside allowlist |
| `--max-output <n>` | Truncate output to N characters |
| `--headed` | Run browser in headed (visible) mode |
| `--chrome` | Shortcut for `--runtime chrome --headed` (uses real Chrome, bypasses bot detection) |
| `--cdp <port>` | Connect to Chrome on a specific debugging port |
| `--connect` | Auto-discover and connect to a running Chrome instance |
| `--provider <name>` | Cloud browser provider (browserless, browserbase) |
| `--runtime <name>` | Browser engine: playwright (default), rebrowser (stealth), lightpanda, chrome |
| `--mcp` | Run as MCP server (for Cursor, Windsurf, Cline) |

## Reference Files

For extended examples, operational guides, or first-time setup:

| File | Read when... |
|------|-------------|
| [references/permissions.md](references/permissions.md) | First-time setup — user wants to pre-allow browse commands in `.claude/settings.json` |
| [references/guides.md](references/guides.md) | You hit a CAPTCHA/MFA blocker (handoff protocol), want optimization tips (speed rules), or need help choosing which command to use (decision table) |
| [references/commands.md](references/commands.md) | You want extended usage examples beyond the Quick Reference above |
