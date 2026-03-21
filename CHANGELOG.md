# Changelog

## v1.1.0 — Persistent Profiles

- `--profile <name>` — persistent browser profiles with full state (cookies, localStorage, IndexedDB, cache)
- Each profile gets its own Chromium with a real user data directory
- `profile list` | `profile delete <name>` | `profile clean` — profile management
- Mutually exclusive with `--session` (profiles own their Chromium, sessions share one)
- Auto-recovery: corrupted profile directories are detected and recreated

## v1.0.0 — Node.js Port

- **Ported from Bun to Node.js** — zero Bun runtime dependency, runs on Node 18+
- **Why:** Bun's WebSocket client sends `Connection: keep-alive` instead of `Connection: Upgrade`, breaking the CDP handshake required by Playwright's `connectOverCDP()`. This bug ([oven-sh/bun#9911](https://github.com/oven-sh/bun/issues/9911)) has been open since April 2024 and blocked all CDP-based features: `--connect`, `--cdp`, and LightPanda. Node.js handles WebSocket upgrades correctly.
- **All blocked features unblocked:**
  - `--connect` — auto-discover and connect to a running Chrome instance
  - `--cdp <port>` — connect to Chrome on a specific debugging port
  - `--runtime lightpanda` — LightPanda browser engine via CDP
- **Windows support** — Node.js runs everywhere
- Bun.serve → thin `nodeServe()` adapter (20 lines, zero deps, same Request/Response API)
- bun:test → vitest (same API, `pool: 'forks'` with `singleFork` for shared browser)
- bun:sqlite → better-sqlite3 (same `.prepare().all()` API)
- bun build --compile → esbuild bundle
- 304 tests pass on Node.js

## v0.10.0 — Feature Parity

**New commands:**
- `rightclick <sel>` — right-click element (context menu)
- `tap <sel>` — tap element (touch-enabled contexts)
- `swipe <up|down|left|right> [px]` — swipe gesture via touch events
- `mouse move|down|up|wheel` — low-level mouse control
- `keyboard inserttext <text>` — insert text without key events
- `scrollinto <sel>` / `scrollintoview <sel>` — explicit scroll-into-view
- `set geo <lat> <lng>` — set geolocation with permission grant
- `set media <dark|light|no-preference>` — emulate color scheme
- `box <sel>` — get element bounding box as JSON `{x, y, width, height}`
- `errors [--clear]` — view/clear page errors (filtered from console buffer)
- `doctor` — system check (Bun version, Playwright, Chromium path)
- `upgrade` — self-update via npm

**Extended commands:**
- `wait --text "..."` — wait for text to appear in page body
- `wait --fn "expr"` — wait for JavaScript condition
- `wait --load <state>` — wait for load state (load, domcontentloaded, networkidle)
- `wait <sel> --state hidden` — wait for element to disappear
- `wait <ms>` — wait for milliseconds
- `cookie clear` — clear all cookies
- `cookie set <n> <v> [--domain --secure --expires --sameSite --path]` — set cookie with options
- `cookie export <file>` — export cookies to JSON file
- `cookie import <file>` — import cookies from JSON file
- `find alt <text>` — find by alt text
- `find title <text>` — find by title attribute
- `find first|last <sel>` — find first/last matching element
- `find nth <n> <sel>` — find nth matching element (0-indexed)
- `screenshot <sel|@ref> [path]` — screenshot a specific element
- `screenshot --clip x,y,w,h [path]` — screenshot a clipped region

**New flag:**
- `--max-output <n>` — truncate output to N characters (also `BROWSE_MAX_OUTPUT` env var)

**Improvements:**
- Ref staleness detection — stale refs fail in ~5ms with actionable error instead of waiting for Playwright timeout
- 305 tests (31 new)

## v0.9.0 — Auth Persistence

- **Session auto-persistence** — named sessions (`--session myapp`) now automatically save cookies + localStorage on close and restore on next use. No extra commands needed. The `"default"` session is unaffected.
- **Cookie import from real browsers** — `cookie-import chrome --domain .example.com` reads and decrypts cookies from Chrome, Arc, Brave, or Edge on macOS. Import once, browse authenticated. Use `cookie-import --list` to see installed browsers. Supports `--profile` for multi-profile browsers.
- **Encrypted state at rest** — auto-persisted session state and manual state files are encrypted with AES-256-GCM when `BROWSE_ENCRYPTION_KEY` is set (same key as auth vault).
- **`--state <path>` flag** — load a saved state file before the first command: `browse --state auth.json goto https://app.com`
- **`state clean`** — garbage-collect old state files: `browse state clean` (7 days default) or `browse state clean --older-than 30`
- **`--connect` / `--cdp` flags** — discover and connect to a running Chrome instance (unblocked in v1.0.0 Node.js port)

## v0.8.0 — Command Recording & Export

- `record start` | `record stop` | `record status` — record browse commands as you go
- `record export browse [path]` — export as chain-compatible JSON (replay with `browse chain`)
- `record export replay [path]` — export as Chrome DevTools Recorder format (replay with `npx @puppeteer/replay` or Playwright)
- Tested end-to-end: record → export → `npx @puppeteer/replay` passes

## v0.7.5 — Token Optimization & Benchmarks

- `snapshot -i` now outputs terse flat list by default (no indentation, no props, names truncated to 30 chars)
- `-f` flag for full indented ARIA tree with props/children (the old `-i` behavior)
- `-V` flag for viewport-only snapshot — filters to elements visible in the current viewport (BBC: 189 → 28 elements, ~85% reduction)
- `browse version` / `--version` — print CLI version
- 2.4-2.8x fewer tokens than browser-use and agent-browser across real-world benchmarks

## v0.5.0–v0.7.0 — Runtime Abstraction (internal)

- Browser runtime provider registry (`src/runtime.ts`) — pluggable backend support
- `--runtime rebrowser` — stealth mode via rebrowser-playwright (bypasses bot detection)
- `--runtime lightpanda` — experimental LightPanda browser support
- `BROWSE_RUNTIME` env var for default runtime selection
- `screenshot --full` — full-page screenshots (entire scrollable page)
- Multiple internal package.json bumps during development

## v0.4.0 — Video Recording

- `video start [dir]` | `video stop` | `video status` — compositor-level WebM recording
- Works with local and remote (CDP) browsers

## v0.3.0 — Headed Mode, Clipboard, DevTools

- `--headed` flag — run browser in visible mode for debugging and demos
- `clipboard [write <text>]` — read and write clipboard contents
- `inspect` command — open DevTools debugger via `BROWSE_DEBUG_PORT`
- `screenshot --annotate` — pixel-annotated PNG with numbered badges
- `instances` command — list all running browse servers
- `BROWSE_DEBUG_PORT` env var for DevTools debugging

## v0.2.0 — Security, Interactions, DX

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

## v0.1.0 — Foundation

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
