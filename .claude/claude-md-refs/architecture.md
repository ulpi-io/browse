# Architecture — @ulpi/browse

## System Overview

```
User / AI Agent
      │
      ▼
  bin/browse.ts  (shebang entry point)
      │
      ▼
  src/cli.ts  (thin HTTP client)
      │  1. Read state file (.browse/browse-server.json)
      │  2. If missing/stale → start server as background process
      │  3. Health check (/health)
      │  4. POST /command { command, args }
      │  5. Print response to stdout
      ▼
  src/server.ts  (persistent Bun.serve HTTP daemon)
      │  Routes: /health (no auth), /command (POST, auth required)
      │  Dispatches to read/write/meta command handlers
      ▼
  ┌───────────────┬───────────────────┬──────────────────┐
  │ commands/      │ commands/          │ commands/         │
  │ read.ts       │ write.ts          │ meta.ts           │
  │ (16 commands) │ (18 commands)     │ (12 commands)     │
  └───────┬───────┴─────────┬─────────┴────────┬──────────┘
          │                 │                  │
          ▼                 ▼                  ▼
    src/browser-manager.ts  (Playwright wrapper)
      │  - Browser/Context/Page lifecycle
      │  - Tab management (Map<id, Page>)
      │  - @ref map (Map<string, Locator>)
      │  - Device emulation (context recreation)
      │  - Console/network event wiring
      ▼
    Chromium (headless, Playwright)
```

## Dependency Graph

```
bin/browse.ts
  └── src/cli.ts
        └── src/constants.ts

src/server.ts
  ├── src/browser-manager.ts
  │     └── src/buffers.ts
  │           └── src/constants.ts
  ├── src/commands/read.ts
  │     ├── src/browser-manager.ts
  │     └── src/buffers.ts
  ├── src/commands/write.ts
  │     ├── src/browser-manager.ts
  │     └── src/constants.ts
  ├── src/commands/meta.ts
  │     ├── src/browser-manager.ts
  │     ├── src/snapshot.ts
  │     │     └── src/browser-manager.ts
  │     └── src/constants.ts
  ├── src/buffers.ts
  └── src/constants.ts
```

## Request Lifecycle

### CLI → Server (every command)

```
1. CLI reads .browse/browse-server.json → { pid, port, token }
2. If missing/stale PID → acquire lock → spawn server → wait for state file
3. Health check: GET /health → { status: "healthy" }
4. POST /command with Bearer token → { command: "text", args: [] }
5. Server routes: READ_COMMANDS → read.ts | WRITE_COMMANDS → write.ts | META_COMMANDS → meta.ts
6. Handler calls Playwright API on active Page
7. Returns text/plain (200) or JSON error (400/500)
8. CLI writes stdout (success) or stderr+exit(1) (error)
```

### Server Startup

```
1. findPort() — use BROWSE_PORT or scan 9400-9410
2. browserManager.launch() — chromium.launch + newContext + newTab
3. Wire crash handler: browser.on('disconnected') → process.exit(1)
4. Bun.serve on 127.0.0.1:{port}
5. Write state file (pid, port, token, startedAt)
6. Start idle timer (30 min) and buffer flush interval (1s)
```

### Crash Recovery

```
Chromium crash → server exits(1) → state file removed
  │
  ▼
Next CLI command → readState() fails or PID dead
  │
  ▼
startServer() → spawn new server → wait for state file
  │
  ▼
ECONNREFUSED: retry any command (server never received it)
ECONNRESET: retry read-only only (write may have executed)
After restart: fail read commands (blank page) — user must re-navigate
```

## @ref System (Snapshot → Interact)

```
1. User: browse snapshot -i
2. page.locator('body').ariaSnapshot() → YAML-like ARIA tree
3. Parse tree: assign @e1, @e2, ... to each node
4. Build Playwright Locator per ref (getByRole + nth for disambiguation)
5. Store Map<string, Locator> on BrowserManager
6. Output: "@e1 [button] "Submit"  @e2 [textbox] "Email" ..."

7. User: browse click @e3
8. bm.resolveRef("@e3") → { locator: <Playwright Locator> }
9. locator.click()

Ref scoping:
- Refs are per-tab — switching tabs invalidates refs
- Navigation clears refs for the affected tab
- -C flag adds cursor-interactive elements (div.onclick, cursor:pointer)
```

## Server State Files

| File | Location | Content |
|------|----------|---------|
| `browse-server.json` | `.browse/` | `{ pid, port, token, startedAt, serverPath }` |
| `browse-server.json.lock` | `.browse/` | PID of process starting server (atomic O_EXCL) |
| `browse-console.log` | `.browse/` | Flushed console buffer (append-only) |
| `browse-network.log` | `.browse/` | Flushed network buffer (append-only) |
| `browse-screenshot.png` | `.browse/` | Default screenshot path |

## Auth Model

- Server generates random UUID token on startup
- Token stored in state file (mode 0o600)
- All `/command` requests require `Authorization: Bearer <token>`
- `/health` endpoint requires no auth
- Token mismatch → CLI reads fresh state file → retry

## Buffer Architecture

```
Console/Network events (Playwright)
  │
  ▼
Ring buffer (in-memory, 50K entries max)
  │  shift() on overflow (FIFO)
  │
  ├── Served to CLI on 'console'/'network' commands (real-time)
  │
  └── Flushed to disk every 1s (append-only log files)
       └── Network: only flush "ready" entries (have status) or settled (>5s)
           On shutdown: force-flush all pending entries
```

## Device Emulation

```
emulate <device>
  │
  ▼
resolveDevice(name) — check aliases → custom devices → Playwright built-ins → fuzzy
  │
  ▼
BrowserManager.emulateDevice(descriptor)
  │
  ▼
recreateContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })
  │  1. Save cookies + all tab URLs + active tab ID
  │  2. Create new BrowserContext with device settings
  │  3. Restore cookies/headers into new context
  │  4. Recreate all tabs (navigate to saved URLs)
  │  5. Restore active tab selection + migrate snapshots
  │  6. Close old context
  │
  ▼
emulate reset → recreateContext({ viewport: 1920x1080 })
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| CLI as HTTP client, not library | Crash isolation — server crash doesn't kill agent |
| No self-healing on crash | Exit immediately, let CLI restart — don't mask failures |
| Ring buffers, not unbounded arrays | Memory safety for long-running sessions |
| @refs via Locator, not DOM IDs | No DOM mutation — MutationObservers not triggered |
| Write commands not retried | Avoid double form submissions, duplicate clicks |
| Per-tab ref scoping | Prevent stale refs from clicking wrong elements |
| Context recreation for UA/device | Playwright limitation — can't change UA on existing context |
| File-based lock for server spawn | Prevent multiple concurrent server startups |
