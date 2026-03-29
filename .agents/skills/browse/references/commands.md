# browse — Full Command Reference

Read this file when you need command syntax not covered in the SKILL.md Quick Reference, or need exact flags for a specific command category.

## Quick Reference (all examples)

```bash
# Navigate to a page
browse goto https://example.com

# Read cleaned page text
browse text

# Take a screenshot (saved to .browse/sessions/default/screenshot.png)
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

# Cookie import from real browsers (macOS -- Chrome, Arc, Brave, Edge)
browse cookie-import --list                              # show installed browsers
browse cookie-import chrome --domain .example.com        # import cookies for a domain
browse cookie-import arc --domain .github.com            # import from Arc
browse cookie-import chrome --profile "Profile 1" --domain .site.com  # specific Chrome profile

# Session auto-persistence (named sessions survive restarts)
browse --session myapp goto https://app.com/login        # login...
browse session-close myapp                               # state auto-saved (encrypted if BROWSE_ENCRYPTION_KEY set)
browse --session myapp goto https://app.com/dashboard    # cookies auto-restored

# Persistent profiles (full browser state, own Chromium)
browse --profile mysite goto https://app.com       # all state persists automatically
browse --profile mysite snapshot -i                 # still logged in next time
browse profile list                                 # list all profiles with size
browse profile delete old-site                      # remove a profile

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

# Handoff (human takeover for CAPTCHA/MFA -- see guides.md for protocol)
browse handoff "stuck on CAPTCHA"
browse resume

# React debugging
browse react-devtools enable
browse react-devtools tree
browse react-devtools props @e3
browse react-devtools suspense
browse react-devtools disable

# Stealth mode (bypasses bot detection)
browse --runtime rebrowser goto https://example.com

# State list / show
browse state list
browse state show mysite
```

## Navigation
```
browse goto <url>         Navigate current tab
browse back               Go back
browse forward            Go forward
browse reload             Reload page
browse url                Print current URL
```

## Content extraction
```
browse text               Cleaned page text (no scripts/styles)
browse html [selector]    innerHTML of element, or full page HTML
browse links              All links as "text -> href"
browse forms              All forms + fields as JSON
browse accessibility      Accessibility tree snapshot (ARIA)
```

## Snapshot (ref-based element selection)
```
browse snapshot           Full accessibility tree with @refs
browse snapshot -i        Interactive elements only -- terse flat list (minimal tokens)
browse snapshot -i -f     Interactive elements -- full indented tree with props
browse snapshot -i -V     Interactive elements -- viewport only (skip below-fold)
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

Refs are invalidated on navigation -- run `snapshot` again after `goto`.

## Interaction
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

## Cookies
```
browse cookie <n>=<v>                  Set cookie (shorthand)
browse cookie set <n> <v> [--domain d --secure]  Set cookie with options
browse cookie clear                    Clear all cookies
browse cookie export <file>            Export cookies to JSON file
browse cookie import <file>            Import cookies from JSON file
```

## Network
```
browse route <pattern> block           Block matching requests
browse route <pattern> fulfill <s> [b] Mock with status + body
browse route clear                     Remove all routes
```

## Inspection
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

## Visual
```
browse screenshot [path]              Viewport screenshot (default: .browse/sessions/{id}/screenshot.png)
browse screenshot --full [path]       Full-page screenshot (entire scrollable page)
browse screenshot <sel|@ref> [path]   Screenshot specific element
browse screenshot --clip x,y,w,h [path]  Screenshot clipped region
browse screenshot --annotate [path]   Screenshot with numbered badges + legend
browse pdf [path]                     Save as PDF
browse responsive [prefix]            Screenshots at mobile/tablet/desktop
```

## Frames (iframe targeting)
```
browse frame <selector>        Target an iframe (subsequent commands run inside it)
browse frame main              Return to main page
```

## Find (semantic element locators)
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

## Compare
```
browse diff <url1> <url2>             Text diff between two pages
browse screenshot-diff <base> [curr]  Pixel-diff two PNG screenshots
```

## Multi-step (chain)
```
echo '[["goto","https://example.com"],["snapshot","-i"],["click","@e1"]]' | browse chain
```

## Tabs
```
browse tabs                    List tabs (id, url, title)
browse tab <id>                Switch to tab
browse newtab [url]            Open new tab
browse closetab [id]           Close tab
```

## Sessions (parallel agents)
```
browse --session <id> <cmd>    Run command in named session
browse sessions                List active sessions
browse session-close <id>      Close a session
```

## Profiles
```
browse --profile <name> <cmd>             Use persistent browser profile
browse profile list                       List profiles with disk size
browse profile delete <name>              Delete a profile
browse profile clean [--older-than <d>]   Remove old profiles (default: 7 days)
```

## State persistence
```
browse state save [name]       Save cookies + localStorage (all origins)
browse state load [name]       Restore saved state
browse state list              List saved states
browse state show [name]       Show contents of saved state
browse state clean             Delete states older than 7 days
browse state clean --older-than N   Custom age threshold (days)
```

## Cookie import (macOS -- borrow auth from real browsers)
```
browse cookie-import --list                         List installed browsers
browse cookie-import <browser> --domain <d>         Import cookies for a domain
browse cookie-import <browser> --profile <p> --domain <d>   Specific Chrome profile
```

## Auth vault
```
browse auth save <name> <url> <user> <pass|--password-stdin>   Save credentials (encrypted)
browse auth login <name>                       Auto-login using saved credentials
browse auth list                               List saved credentials
browse auth delete <name>                      Delete credentials
```

## HAR recording
```
browse har start               Start recording network traffic
browse har stop [path]         Stop and save HAR file
```

## Video recording
```
browse video start [dir]       Start recording video (WebM, compositor-level)
browse video stop              Stop recording and save video files
browse video status            Check if recording is active
```

## Command recording & export
```
browse record start                    Start recording commands
browse record stop                     Stop recording, keep steps for export
browse record status                   Recording state and step count
browse record export browse [path]     Export as chain-compatible JSON (replay with browse chain)
browse record export replay [path]    Export as Chrome DevTools Recorder (Playwright/Puppeteer)
```

## React DevTools
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

## Performance audit
```
browse perf-audit [url]                  Full performance audit (Web Vitals, resources, images, fonts, DOM, coverage, stack detection, recommendations)
browse perf-audit [url] --no-coverage    Skip JS/CSS coverage (faster)
browse perf-audit [url] --no-detect      Skip framework/SaaS detection
browse perf-audit [url] --json           Structured JSON output
browse perf-audit save [name]            Save audit report to .browse/audits/ (auto-names from URL + date)
browse perf-audit compare <base> [curr]  Compare saved baseline vs current page or another saved audit
browse perf-audit list                   List saved audit reports
browse perf-audit delete <name>          Delete a saved audit
browse detect                            Tech stack fingerprint (frameworks, SaaS, CDN, infra)
browse coverage start                    Start JS/CSS code coverage collection
browse coverage stop                     Stop and report per-file used/unused bytes
browse initscript set <code>             Inject JS before every page load
browse initscript show                   Show current init script
browse initscript clear                  Remove init script
```

## Server management
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

## Native App Automation (Android, iOS, macOS)
```
# Simulator/emulator lifecycle
browse sim start --platform ios --app <bundleId> [--visible]     Boot simulator + launch app
browse sim start --platform android --app <package> [--visible]  Boot emulator + launch app
browse sim stop --platform ios|android                           Stop simulator/emulator
browse sim status --platform ios|android                         Check runner health

# iOS commands
browse --platform ios --app com.apple.Preferences snapshot -i
browse --platform ios --app com.apple.Preferences tap @e3
browse --platform ios --app com.apple.Preferences swipe up
browse --platform ios --app com.apple.Preferences press home
browse --platform ios --app com.apple.mobilesafari type "url"    # Switch app target

# Android commands
browse --platform android --app com.android.settings snapshot -i
browse --platform android --app com.android.settings tap @e3
browse --platform android --app com.android.settings swipe up
browse --platform android --app com.android.settings press back

# macOS commands (no sim needed)
browse --app "System Settings" snapshot -i
browse --app "System Settings" tap @e5
browse --app TextEdit press "cmd+n"                              # Modifier combos
browse --app TextEdit type "Hello world"
```

Supported on all platforms: `snapshot`, `text`, `tap`, `fill`, `type`, `press`, `swipe`, `screenshot`.
Android auto-installs adb, Java, SDK, emulator on first use. iOS requires Xcode.

## Handoff (human takeover)
```
browse handoff [reason]        Swap to visible browser for user to solve CAPTCHA/MFA
browse resume                  Swap back to headless, returns fresh snapshot
```

See [guides.md](guides.md) for the mandatory handoff protocol.
