# Architecture — @ulpi/browse

## System Overview

```
User / AI Agent
      |
      v
  bin/browse.ts  (shebang entry point)
      |
      v
  src/cli.ts  (thin HTTP client)
      |  1. Read state file (.browse/browse-server.json)
      |  2. If missing/stale -> start server as background process
      |  3. Health check (/health)
      |  4. POST /command { command, args }
      |  5. Print response to stdout
      v
  src/server.ts  (persistent Bun.serve HTTP daemon)
      |  Routes: /health (no auth), /command (POST, auth required)
      |  Policy check -> Dispatches to read/write/meta command handlers
      v
  +---------------+-----------------+----------------+
  | commands/      | commands/        | commands/       |
  | read.ts       | write.ts        | meta.ts         |
  | (19 commands) | (31 commands)   | (23 commands)   |
  +-------+-------+--------+--------+-------+---------+
          |                |                |
          v                v                v
    src/browser-manager.ts  (Playwright wrapper)
      |  - Browser/Context/Page lifecycle
      |  - Tab management (Map<id, Page>)
      |  - @ref map (Map<string, Locator>)
      |  - Frame targeting (per-tab active frame)
      |  - Device emulation (context recreation)
      |  - Console/network event wiring
      v
    Chromium (headless, Playwright)
```

## Dependency Graph

```
bin/browse.ts
  +-- src/cli.ts
        +-- src/constants.ts
        +-- src/config.ts
        +-- src/install-skill.ts (lazy import)

src/server.ts
  +-- src/session-manager.ts
  |     +-- src/browser-manager.ts
  |     +-- src/buffers.ts
  |     +-- src/domain-filter.ts
  |     +-- src/sanitize.ts
  +-- src/action-context.ts
  |     +-- src/browser-manager.ts
  |     +-- src/buffers.ts
  |     +-- src/types.ts
  |     +-- src/snapshot.ts (for delta/full context)
  +-- src/policy.ts
  +-- src/commands/read.ts
  |     +-- src/browser-manager.ts
  |     +-- src/buffers.ts
  +-- src/commands/write.ts
  |     +-- src/browser-manager.ts
  |     +-- src/domain-filter.ts
  |     +-- src/constants.ts
  +-- src/commands/meta.ts
  |     +-- src/browser-manager.ts
  |     +-- src/snapshot.ts
  |     |     +-- src/browser-manager.ts
  |     +-- src/auth-vault.ts
  |     |     +-- src/sanitize.ts
  |     +-- src/har.ts
  |     +-- src/png-compare.ts
  |     +-- src/sanitize.ts
  |     +-- src/constants.ts
  +-- src/buffers.ts
  +-- src/constants.ts
```

## Request Lifecycle

### CLI -> Server (every command)

```
1. CLI reads .browse/browse-server.json -> { pid, port, token }
2. If missing/stale PID -> acquire lock -> spawn server -> wait for state file
3. Health check: GET /health -> { status: "healthy" }
4. POST /command with Bearer token -> { command: "text", args: [] }
5. Server: policy check -> route to READ/WRITE/META handler
6. Handler calls Playwright API on active Page (or Frame)
7. Returns text/plain (200) or JSON error (400/403/500)
8. CLI writes stdout (success) or stderr+exit(1) (error)
```

### Server Startup

```
1. findPort() -- use BROWSE_PORT or scan 9400-10400
2. Launch Chromium (local) or connect via CDP (BROWSE_CDP_URL)
3. Create SessionManager with shared Browser
4. Bun.serve on 127.0.0.1:{port}
5. Write state file (pid, port, token, startedAt)
6. Start idle timer (30 min) and buffer flush interval (1s)
```

### Crash Recovery

```
Chromium crash -> server exits(1) -> state file removed
  |
  v
Next CLI command -> readState() fails or PID dead
  |
  v
startServer() -> spawn new server -> wait for state file
  |
  v
ECONNREFUSED: retry any command (server never received it)
ECONNRESET: retry read-only only (write may have executed)
After restart: fail read commands (blank page) -- user must re-navigate
```

## @ref System (Snapshot -> Interact)

```
1. User: browse snapshot -i
2. page.locator('body').ariaSnapshot() -> YAML-like ARIA tree
3. Parse tree: assign @e1, @e2, ... to each node
4. Build Playwright Locator per ref (getByRole + nth for disambiguation)
5. Store Map<string, Locator> on BrowserManager
6. Output: "@e1 [button] "Submit"  @e2 [textbox] "Email" ..."

7. User: browse click @e3
8. bm.resolveRef("@e3") -> { locator: <Playwright Locator> }
9. locator.click()

Ref scoping:
- Refs are per-tab -- switching tabs invalidates refs
- Navigation clears refs for the affected tab
- -C flag adds cursor-interactive elements (div.onclick, cursor:pointer)
```

## Action Policy System

```
browse-policy.json (project root) or BROWSE_POLICY env var:
  { "default": "allow", "deny": ["js", "eval"], "confirm": ["goto"] }

Precedence: deny > confirm > allow whitelist > default
BROWSE_CONFIRM_ACTIONS env var overrides for confirm list.
PolicyChecker hot-reloads on file mtime change.

Result: "allow" -> execute | "deny" -> 403 | "confirm" -> 403 (non-interactive CLI)
```

## Credential Vault

```
auth save <name> <url> <user> <pass>
  |
  v
AES-256-GCM encrypt(password) with key from:
  1. BROWSE_ENCRYPTION_KEY env var (64-char hex)
  2. .browse/.encryption-key file (auto-generated)
  |
  v
Write .browse/auth/<name>.json (mode 0o600)

auth login <name>
  |
  v
Load credential -> decrypt password -> goto URL -> auto-detect selectors -> fill + submit
```

## Domain Filter

```
--allowed-domains example.com,*.api.io
  |
  v
DomainFilter class:
  1. HTTP requests: context.route('**/*') -> isAllowed(url) ? fallback/continue : abort
  2. WebSocket/EventSource/sendBeacon: context.addInitScript() wraps JS constructors
  |
  v
Blocks: file://, javascript://, non-matching HTTP domains
Allows: about:blank, data:, blob:, matching domains
Wildcard: *.example.com matches example.com AND any subdomain
```

## Lifecycle Threading (Flows/Chain)

```
Transport (server.ts / mcp/server.ts)
  constructs lifecycle = { before, after(recording+context), onError }
  passes lifecycle into both:
    - opts.lifecycle (for the executor pipeline)
    - context.lifecycle (so command handlers can forward it)

Flow/Chain handler receives ctx.lifecycle, forwards to nested executeCommand():
  executeCommand(step.command, step.args, {
    context: { ..., lifecycle: ctx.lifecycle },
    lifecycle: ctx.lifecycle,
  })

This causes the transport's after-hook (which pushes to session.recording)
to fire for each sub-step. Wrapper commands have skipRecording: true so
only sub-steps are recorded.

Flow nesting depth tracked per-session via WeakMap (max 10).
```

## Action Context

```
Write command execution with context level:

1. prepareWriteContext(level, bm, buffers) → WriteContextCapture
     state: captures PageState
     delta: captures PageState + stores baseline from bm.getLastSnapshot()
     full:  captures PageState
     off:   no-op
2. handleWriteCommand(command, args, bm, domainFilter)
3. finalizeWriteContext(capture, bm, buffers, result, command) → enriched result
     state: capturePageState → buildContextDelta → "[context] → /path | title: ..."
     delta: handleSnapshot(opts) → formatAriaDelta(baseline, new) → "[snapshot-delta] +N -M =K"
     full:  handleSnapshot(opts) → "[snapshot]\n@e1 [button] ..."
     off:   return result unchanged

Context Levels:
  state  — page state changes only (URL, title, tabs, dialogs, errors)
  delta  — state + ARIA diff with refs for added/removed elements
  full   — state + complete ARIA snapshot with fresh refs

Activation (any of):
  - CLI: --context [state|delta|full] or BROWSE_CONTEXT=state|delta|full
  - HTTP: X-Browse-Context: state|delta|full (1 maps to state for compat)
  - Session: browse set context off|state|delta|full
  - MCP: default 'state', changeable via browse_set context

Delta uses bm.getLastSnapshot() as baseline (from last explicit snapshot command).
If no baseline exists, delta falls back to full mode.
handleSnapshot in finalizeWriteContext updates bm.refMap — refs are always post-write.
All snapshot/delta work wrapped in try/catch — failures never break the write result.
```

## HAR Recording

```
har start -> store { startTime: Date.now(), active: true } on BrowserManager
har stop [path] -> formatAsHar(networkBuffer, startTime) -> write HAR 1.2 JSON
```

## Screenshot Diff (PNG Decode)

```
screenshot-diff <baseline> [current]
  |
  v
decodePNG(buf) -> inflate IDAT chunks -> apply scanline filters -> RGBA pixels
  |
  v
compareScreenshots(base, curr, threshold)
  -> pixel-by-pixel Euclidean distance (R,G,B)
  -> threshold: 900 (30 per channel)
  -> return { totalPixels, diffPixels, mismatchPct, passed }
```

## Server State Files

| File | Location | Content |
|------|----------|---------|
| `browse-server.json` | `.browse/` | `{ pid, port, token, startedAt, serverPath }` |
| `browse-server.json.lock` | `.browse/` | PID of process starting server (atomic O_EXCL) |
| `console.log` | `.browse/sessions/<id>/` | Flushed console buffer (append-only) |
| `network.log` | `.browse/sessions/<id>/` | Flushed network buffer (append-only) |
| `browse-screenshot.png` | `.browse/` | Default screenshot path |
| `.encryption-key` | `.browse/` | Auto-generated AES-256 key (mode 0o600) |
| `auth/<name>.json` | `.browse/` | Encrypted credentials (mode 0o600) |

## Auth Model

- Server generates random UUID token on startup
- Token stored in state file (mode 0o600)
- All `/command` requests require `Authorization: Bearer <token>`
- `/health` endpoint requires no auth
- Token mismatch -> CLI reads fresh state file -> retry

## Buffer Architecture

```
Console/Network events (Playwright)
  |
  v
Ring buffer (in-memory, 50K entries max) — per-session via SessionBuffers
  |  shift() on overflow (FIFO)
  |
  +-- Served to CLI on 'console'/'network' commands (real-time)
  |
  +-- Flushed to disk every 1s (append-only, per-session output dir)
       +-- Network: only flush "ready" entries (have status) or settled (>5s)
           On shutdown: force-flush all pending entries
```

## Device Emulation

```
emulate <device>
  |
  v
resolveDevice(name) -- check aliases -> custom devices -> Playwright built-ins -> fuzzy
  |
  v
BrowserManager.emulateDevice(descriptor)
  |
  v
recreateContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })
  |  1. Save cookies + all tab URLs + active tab ID
  |  2. Create new BrowserContext with device settings
  |  3. Restore cookies/headers into new context
  |  4. Recreate all tabs (navigate to saved URLs)
  |  5. Restore active tab selection + migrate snapshots
  |  6. Close old context
  |
  v
emulate reset -> recreateContext({ viewport: 1920x1080 })
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| CLI as HTTP client, not library | Crash isolation -- server crash doesn't kill agent |
| No self-healing on crash | Exit immediately, let CLI restart -- don't mask failures |
| Ring buffers, not unbounded arrays | Memory safety for long-running sessions |
| @refs via Locator, not DOM IDs | No DOM mutation -- MutationObservers not triggered |
| Write commands not retried | Avoid double form submissions, duplicate clicks |
| Per-tab ref scoping | Prevent stale refs from clicking wrong elements |
| Context recreation for UA/device | Playwright limitation -- can't change UA on existing context |
| File-based lock for server spawn | Prevent multiple concurrent server startups |
| Port range 9400-10400 | 1001 ports for multi-process isolation |
| route.fallback() for domain filter | Lets user routes (route command) take priority over domain filter |
| Per-tab frame targeting | Frame state is tab-specific, avoids cross-tab confusion |
| PNG decode server-side | No external image deps, works in compiled binary ($bunfs) |
| Policy hot-reload on mtime | No server restart needed to change policy |
| AES-256-GCM for credentials | Authenticated encryption, key auto-generated if not provided |
