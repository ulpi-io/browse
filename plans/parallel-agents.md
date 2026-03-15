# Plan: Parallel Agent Support (Session Multiplexing + Multi-Process)

> Generated: 2026-03-15
> Branch: `feat/parallel-agents`
> Mode: EXPANSION

## Overview

Add session multiplexing to `@ulpi/browse` so multiple AI agents can share a single server with isolated browser contexts. Each session gets its own `BrowserManager` (tabs, refs, cookies, storage, buffers) while sharing one Chromium process. Multi-process isolation via `BROWSE_PORT` continues to work as a fallback for full isolation.

## Scope Challenge

**What already exists:**
- `BrowserManager` is already a self-contained class — no global state leaks from its internals
- `BROWSE_PORT` + `INSTANCE_SUFFIX` already support separate server instances
- Port range scanning works for auto-assignment

**What's broken for parallel use:**
- `server.ts` creates a single `BrowserManager` at module scope (line 108)
- `buffers.ts` exports module-level singletons (`consoleBuffer`, `networkBuffer`) — shared across all requests
- `commands/read.ts` reads from these global buffers directly (lines 226-244)
- `browser-manager.ts` calls global `addConsoleEntry`/`addNetworkEntry` from `wirePageEvents`
- No session concept in HTTP protocol — all requests hit the same BrowserManager
- Idle timer is global — can't GC individual sessions

**Why EXPANSION:** This touches the core data flow (buffers, command dispatch, browser lifecycle). Half-measures would leave data leaking between sessions. Full decomposition ensures correctness.

## Architecture

```
                          CLI (cli.ts)
                            │
                     --session=<id>
                            │
                    POST /command
                    X-Browse-Session: <id>
                            │
                  ┌─────────▼──────────┐
                  │   server.ts         │
                  │                     │
                  │   SessionManager    │  ◄── TASK-002
                  │   ┌─────────────┐   │
                  │   │ Session "a" │   │  ◄── TASK-003
                  │   │  BrowserMgr │   │
                  │   │  Buffers    │   │  ◄── TASK-001
                  │   │  IdleTimer  │   │
                  │   ├─────────────┤   │
                  │   │ Session "b" │   │
                  │   │  BrowserMgr │   │
                  │   │  Buffers    │   │
                  │   │  IdleTimer  │   │
                  │   └─────────────┘   │
                  │                     │
                  │   Shared Browser    │  ◄── TASK-004
                  │   (one Chromium)    │
                  └─────────────────────┘
                            │
                      Chromium (headless)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Browser context isolation | `BrowserManager.recreateContext()` | Reuse pattern — each session gets its own context via `browser.newContext()` |
| Tab/ref/snapshot state | `BrowserManager` private fields | Reuse as-is — already self-contained per instance |
| Ring buffer logic | `buffers.ts` `addConsoleEntry`/`addNetworkEntry` | Refactor — move into class or per-session instance |
| Command routing | `server.ts` `handleCommand()` | Extend — resolve session before dispatching |
| CLI arg parsing | `cli.ts` `main()` | Extend — add `--session` flag |
| Idle timer | `server.ts` `idleCheckInterval` | Extend — per-session + global |
| Port scanning | `server.ts` `findPort()` | Reuse as-is |
| Crash handler | `browser-manager.ts` `launch()` | Extend — crash affects all sessions |
| Buffer flush to disk | `server.ts` `flushBuffers()` | Extend — iterate all sessions |
| Health check | `server.ts` `/health` | Extend — include session count |

## Tasks

### TASK-001: Refactor Buffers Into Per-Session Class

Move console/network buffers from module-level singletons into a `SessionBuffers` class that can be instantiated per session. Update `BrowserManager` to accept a `SessionBuffers` instance instead of importing globals.

**Files:**
- Modify `src/buffers.ts` — add `SessionBuffers` class wrapping the existing buffer logic
- Modify `src/browser-manager.ts` — accept `SessionBuffers` in constructor, use it in `wirePageEvents`

**Implementation:**
```typescript
// buffers.ts
export class SessionBuffers {
  consoleBuffer: LogEntry[] = [];
  networkBuffer: NetworkEntry[] = [];
  consoleTotalAdded = 0;
  networkTotalAdded = 0;

  addConsoleEntry(entry: LogEntry) { /* existing logic */ }
  addNetworkEntry(entry: NetworkEntry) { /* existing logic */ }
}

// Keep backward-compat: default instance for single-session mode
export const defaultBuffers = new SessionBuffers();
```

```typescript
// browser-manager.ts constructor
constructor(private buffers: SessionBuffers = defaultBuffers) {}

// wirePageEvents: use this.buffers.addConsoleEntry() instead of global
```

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] `SessionBuffers` class holds its own console/network arrays and counters
- [ ] `BrowserManager` constructor accepts optional `SessionBuffers`, defaults to `defaultBuffers`
- [ ] All existing tests pass without modification (backward compat via defaults)
- [ ] Creating two `SessionBuffers` instances produces independent buffer state

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Create SessionManager

Create a `SessionManager` class in `src/session-manager.ts` that manages a `Map<string, Session>` where each session has its own `BrowserManager`, `SessionBuffers`, and idle timer. Sessions share a single Chromium `Browser` instance.

**Files:**
- Create `src/session-manager.ts`

**Implementation:**
```typescript
interface Session {
  id: string;
  manager: BrowserManager;
  buffers: SessionBuffers;
  lastActivity: number;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private browser: Browser;

  constructor(browser: Browser) { this.browser = browser; }

  async getOrCreate(sessionId: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const buffers = new SessionBuffers();
      const manager = new BrowserManager(buffers);
      await manager.launchWithBrowser(this.browser);
      session = { id: sessionId, manager, buffers, lastActivity: Date.now(), createdAt: Date.now() };
      this.sessions.set(sessionId, session);
    }
    session.lastActivity = Date.now();
    return session;
  }

  async closeSession(sessionId: string): Promise<void> { /* close context, remove from map */ }
  async closeIdleSessions(maxIdleMs: number): Promise<string[]> { /* GC idle sessions */ }
  listSessions(): Array<{ id, tabs, url, idleSeconds }> { /* for status command */ }
  async closeAll(): Promise<void> { /* shutdown all sessions */ }
}
```

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `getOrCreate` returns existing session or creates new one with isolated BrowserManager + buffers
- [ ] `closeSession` closes the browser context and removes from map
- [ ] `closeIdleSessions` returns list of closed session IDs and frees their resources
- [ ] Creating two sessions and navigating to different URLs produces independent state (different `getPage().url()`)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P0

---

### TASK-003: Split BrowserManager.launch Into Shared Browser Mode

Refactor `BrowserManager` so it can either launch its own `Browser` (current behavior, for single-session/multi-process mode) or receive an existing `Browser` instance (for session multiplexing where one Chromium is shared).

**Files:**
- Modify `src/browser-manager.ts` — add `launchWithBrowser(browser: Browser)` method

**Implementation:**
```typescript
// New method — creates a context on an existing browser (shared Chromium)
async launchWithBrowser(browser: Browser, onCrash?: () => void) {
  this.browser = browser;
  // Don't register crash handler here — SessionManager handles it globally
  this.context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  await this.newTab();
}

// Existing launch() stays unchanged for backward compat
```

Also update `close()` to only close the context (not the browser) when in shared mode:
```typescript
private ownsTheBrowser = false;

async close() {
  if (this.context) {
    await this.context.close();
    this.context = null;
  }
  if (this.ownsTheBrowser && this.browser) {
    this.browser.removeAllListeners('disconnected');
    await this.browser.close();
    this.browser = null;
  }
}
```

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] `launchWithBrowser(browser)` creates a new context on the shared browser without launching Chromium
- [ ] `close()` in shared mode closes only the context, not the browser
- [ ] `close()` in owned mode (via `launch()`) still closes the browser entirely
- [ ] Two `BrowserManager` instances sharing the same `Browser` have independent contexts (different cookies, different pages)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-004: Wire Session Header Into Server HTTP Handler

Update `server.ts` to extract a session ID from the `X-Browse-Session` request header, resolve the session via `SessionManager`, and pass the session's `BrowserManager` + `SessionBuffers` to command handlers.

**Files:**
- Modify `src/server.ts` — replace single `browserManager` with `SessionManager`, update `handleCommand`, update `start()`, update `shutdown()`

**Implementation:**
- Replace `const browserManager = new BrowserManager()` with `let sessionManager: SessionManager`
- In `start()`: launch Chromium once, create `SessionManager(browser)`, register crash handler
- In `fetch` handler: extract `req.headers.get('x-browse-session') || 'default'`
- In `handleCommand`: `const session = await sessionManager.getOrCreate(sessionId)`
- Pass `session.manager` to read/write/meta handlers, pass `session.buffers` to `console`/`network` commands
- Update `shutdown()` to call `sessionManager.closeAll()`
- Update `/health` to include `sessions: sessionManager.listSessions().length`

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Requests without `X-Browse-Session` header use session ID `"default"` (backward compatible)
- [ ] Requests with different session IDs get independent BrowserManagers (different tabs, refs, URLs)
- [ ] `/health` response includes `sessions` count
- [ ] Shutdown closes all sessions cleanly

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-003
**Priority:** P1

---

### TASK-005: Update Read Commands for Per-Session Buffers

Update `commands/read.ts` to accept `SessionBuffers` instead of importing global `consoleBuffer`/`networkBuffer`. The `console` and `network` commands must read from the session's own buffers.

**Files:**
- Modify `src/commands/read.ts` — change signature to accept `SessionBuffers`, update `console` and `network` cases

**Implementation:**
Change function signature:
```typescript
export async function handleReadCommand(
  command: string,
  args: string[],
  bm: BrowserManager,
  buffers?: SessionBuffers  // optional for backward compat
): Promise<string> {
```

In `console` case: use `buffers?.consoleBuffer ?? consoleBuffer` (fallback to global for tests).
In `network` case: use `buffers?.networkBuffer ?? networkBuffer`.

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `console` command reads from session-specific buffer when `SessionBuffers` is provided
- [ ] `network` command reads from session-specific buffer when `SessionBuffers` is provided
- [ ] Without `SessionBuffers` argument, falls back to global buffers (existing tests pass)
- [ ] Two sessions produce independent console/network output after visiting different pages

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-006: Add --session Flag to CLI

Add `--session <id>` flag to `cli.ts` that sets the `X-Browse-Session` header on all HTTP requests to the server. Also support `BROWSE_SESSION` env var.

**Files:**
- Modify `src/cli.ts` — parse `--session` from args, add header to `sendCommand`

**Implementation:**
```typescript
// In main():
let sessionId: string | undefined;
const sessionIdx = args.indexOf('--session');
if (sessionIdx !== -1) {
  sessionId = args[sessionIdx + 1];
  args.splice(sessionIdx, 2); // remove --session and its value
}
sessionId = sessionId || process.env.BROWSE_SESSION;

// In sendCommand(): add header if sessionId is set
if (sessionId) {
  headers['X-Browse-Session'] = sessionId;
}
```

Update help text to document `--session`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --session agent-1 goto https://example.com` sends `X-Browse-Session: agent-1` header
- [ ] `BROWSE_SESSION=agent-1 browse goto ...` works equivalently
- [ ] Without `--session`, no header is sent (server uses `"default"` session)
- [ ] `--session` flag is consumed and not passed as a command argument (e.g., `browse --session x goto url` doesn't treat `--session` as the command)

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-007: Per-Session Buffer Flush to Disk

Update `server.ts` buffer flush logic to iterate all sessions and flush each session's buffers to separate log files (`browse-console-<session>.log`, `browse-network-<session>.log`).

**Files:**
- Modify `src/server.ts` — update `flushBuffers` to iterate `sessionManager.getSessions()`

**Implementation:**
```typescript
function flushBuffers(final = false) {
  for (const session of sessionManager.getAllSessions()) {
    flushSessionBuffers(session.id, session.buffers, final);
  }
}

function flushSessionBuffers(sessionId: string, buffers: SessionBuffers, final: boolean) {
  const suffix = sessionId === 'default' ? INSTANCE_SUFFIX : `-${sessionId}`;
  const consolePath = `${LOCAL_DIR}/browse-console${suffix}.log`;
  const networkPath = `${LOCAL_DIR}/browse-network${suffix}.log`;
  // ... existing flush logic using buffers.consoleBuffer, buffers.consoleTotalAdded, etc.
}
```

Add `getAllSessions()` method to `SessionManager` (returns iterable of sessions).
Track per-session flush cursors inside `SessionBuffers` class (move `lastConsoleFlushed`/`lastNetworkFlushed` there).

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Each session's logs flush to separate files named by session ID
- [ ] Default session uses existing file names (backward compatible)
- [ ] Shutdown flushes all sessions' buffers (final=true)
- [ ] Flush cursors are per-session (one session's flush doesn't skip another's entries)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-005
**Priority:** P1

---

### TASK-008: Per-Session Idle Cleanup

Replace the global idle timer with per-session idle tracking. The server stays alive as long as at least one session is active. Individual sessions are GC'd after their own idle timeout. Server shuts down when all sessions are idle and removed.

**Files:**
- Modify `src/server.ts` — replace global idle timer with session-aware cleanup
- Modify `src/session-manager.ts` — add `touch(sessionId)` for activity tracking

**Implementation:**
```typescript
// server.ts — replace global idle check
const sessionCleanupInterval = setInterval(async () => {
  const closed = await sessionManager.closeIdleSessions(IDLE_TIMEOUT_MS);
  for (const id of closed) {
    console.log(`[browse] Session "${id}" idle — closed`);
  }
  if (sessionManager.getSessionCount() === 0) {
    console.log('[browse] All sessions idle — shutting down');
    shutdown();
  }
}, 60_000);
```

Each `handleCommand` call already touches `session.lastActivity` via `getOrCreate`.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] Individual sessions close after their idle timeout without affecting other active sessions
- [ ] Server shuts down when ALL sessions have been idle-closed (zero sessions remaining)
- [ ] Active sessions prevent server shutdown even if other sessions are idle
- [ ] A session that was idle but receives a new command is NOT closed (activity resets timer)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-004
**Priority:** P1

---

### TASK-009: Session Management Commands

Add `sessions` (list all sessions), `session-close <id>` (close a session), and update `status` to show session info.

**Files:**
- Modify `src/commands/meta.ts` — add `sessions` and `session-close` cases
- Modify `src/server.ts` — add to `META_COMMANDS` set

**Implementation:**
```typescript
case 'sessions': {
  const list = sessionManager.listSessions();
  if (list.length === 0) return '(no active sessions)';
  return list.map(s =>
    `${s.active ? '> ' : '  '}[${s.id}] ${s.tabs} tab(s) — ${s.url} — idle ${s.idleSeconds}s`
  ).join('\n');
}

case 'session-close': {
  const id = args[0];
  if (!id) throw new Error('Usage: browse session-close <id>');
  await sessionManager.closeSession(id);
  return `Session "${id}" closed`;
}
```

Update `status` to include session count and current session ID.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse sessions` lists all active sessions with tab count, URL, and idle time
- [ ] `browse session-close <id>` closes the specified session and frees its resources
- [ ] `browse session-close` on a non-existent session returns a clear error
- [ ] `browse status` includes session count

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-004
**Priority:** P2

---

### TASK-010: Widen Port Range for Multi-Process Mode

Widen the default port range from 9400-9410 (11 ports) to 9400-9450 (51 ports) for environments that prefer full process isolation via `BROWSE_PORT`.

**Files:**
- Modify `src/constants.ts` — change `PORT_RANGE_END` from 9410 to 9450

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `PORT_RANGE_END` is 9450, allowing 51 concurrent server instances
- [ ] Port scanning still stops at first available port (no performance regression)
- [ ] Existing `BROWSE_PORT` and `BROWSE_PORT_START` overrides still work

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-011: Integration Tests for Session Multiplexing

Write integration tests that verify two sessions are fully isolated: independent navigation, independent refs, independent buffers, independent tab state.

**Files:**
- Create `test/sessions.test.ts`

**Implementation:**
```typescript
describe('Session multiplexing', () => {
  let browser: Browser;
  let sm: SessionManager;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    sm = new SessionManager(browser);
  });

  test('two sessions have independent page state', async () => {
    const a = await sm.getOrCreate('a');
    const b = await sm.getOrCreate('b');
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], a.manager);
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], b.manager);
    expect(a.manager.getCurrentUrl()).toContain('basic.html');
    expect(b.manager.getCurrentUrl()).toContain('forms.html');
  });

  test('two sessions have independent buffers', async () => { /* ... */ });
  test('two sessions have independent refs', async () => { /* ... */ });
  test('closing one session does not affect another', async () => { /* ... */ });
  test('idle session is cleaned up while active session persists', async () => { /* ... */ });
});
```

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Tests verify navigation isolation (different URLs per session)
- [ ] Tests verify buffer isolation (console/network entries don't leak between sessions)
- [ ] Tests verify ref isolation (snapshot refs from session A can't be used in session B)
- [ ] Tests verify session lifecycle (close one, other survives; idle cleanup works)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-004, TASK-005
**Priority:** P2

---

### TASK-012: Update README and CLAUDE.md for Sessions

Document the `--session` flag, `BROWSE_SESSION` env var, session management commands, and parallel agent usage patterns.

**Files:**
- Modify `README.md` — add "Parallel Agents" section, update command reference, update env vars table
- Modify `CLAUDE.md` — update command categories and architecture summary

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] README has a "Parallel Agents" section showing multi-agent usage with `--session`
- [ ] Environment variables table includes `BROWSE_SESSION`
- [ ] Command reference includes `sessions` and `session-close`
- [ ] CLAUDE.md reflects the new session architecture

**Agent:** general-purpose

**Depends on:** TASK-006, TASK-009
**Priority:** P3

---

### TASK-013: End-to-End CLI Session Test

Test the full CLI flow: two concurrent `browse --session` invocations hitting the same server with independent state.

**Files:**
- Create `test/session-e2e.test.ts`

**Implementation:**
Spawn two CLI processes with different `--session` flags, verify they get independent responses.

```typescript
test('two CLI sessions are independent', async () => {
  // Start server
  // Session A: goto basic.html, text → expect "Hello World"
  // Session B: goto forms.html, text → expect "Form Test Page"
  // Session A: text → still "Hello World" (not affected by B)
});
```

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Two concurrent CLI processes with different `--session` flags get independent browser state
- [ ] Session A's navigation does not affect Session B's page content
- [ ] CLI without `--session` uses default session (backward compatible)
- [ ] Server state file is shared (single server serves both sessions)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-006, TASK-004
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Chromium crash kills all sessions | TASK-003, TASK-004 | Document that crash recovery restarts ALL sessions (expected behavior — one Chromium). Agents must re-navigate. |
| Memory leak from unclosed sessions | TASK-002, TASK-008 | `closeIdleSessions` GC + server shutdown when all idle. Log session creation/destruction. |
| Global buffer imports in tests | TASK-001, TASK-005 | Keep `defaultBuffers` export for backward compat. Tests that import global buffers still work. |
| Race condition: two agents create same session ID | TASK-002 | `getOrCreate` is synchronous map lookup — no race. `await` is only for BrowserManager init, which is idempotent. |
| Session header not forwarded on retry | TASK-006 | `sendCommand` captures `sessionId` in closure — retries inherit it. |
| Flush cursors shared across sessions | TASK-007 | Move `lastConsoleFlushed`/`lastNetworkFlushed` into `SessionBuffers` class (TASK-001). |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| `SessionBuffers` class instantiation and isolation | TASK-001 (existing tests) + TASK-011 | unit |
| `SessionManager.getOrCreate` / `closeSession` / `closeIdleSessions` | TASK-011 | integration |
| `BrowserManager.launchWithBrowser` (shared browser mode) | TASK-011 | integration |
| `X-Browse-Session` header extraction in server | TASK-011, TASK-013 | integration, e2e |
| `--session` CLI flag parsing and header injection | TASK-013 | e2e |
| Per-session buffer read in `console`/`network` commands | TASK-011 | integration |
| Per-session buffer flush to disk | TASK-007 (manual verify) | integration |
| Per-session idle cleanup | TASK-011 | integration |
| `sessions` / `session-close` commands | TASK-011 | integration |
| Two concurrent CLI processes with independent state | TASK-013 | e2e |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-001"],
  "TASK-006": [],
  "TASK-007": ["TASK-002", "TASK-005"],
  "TASK-008": ["TASK-004"],
  "TASK-009": ["TASK-004"],
  "TASK-010": [],
  "TASK-011": ["TASK-004", "TASK-005"],
  "TASK-012": ["TASK-006", "TASK-009"],
  "TASK-013": ["TASK-006", "TASK-004"]
}
```
