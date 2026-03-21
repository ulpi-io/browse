# Plan: Auth Persistence

> Generated: 2026-03-21
> Branch: `feat/auth-persistence`
> Mode: EXPANSION

## Overview

Add auth persistence features to bridge the gap with agent-browser and gstack: auto-persist named sessions, import cookies from real browsers, and connect to running Chrome instances. Builds on existing `state save/load`, `auth-vault`, and `BROWSE_CDP_URL` infrastructure.

## Scope Challenge

Explored all three competitors in depth. Deferred persistent profiles (`--profile <dir>`) because `launchPersistentContext` returns a `BrowserContext` (not `Browser`), breaking session multiplexing. Auto-persist covers 90% of the auth use case. Selected EXPANSION mode to build cookie import (biggest gap) alongside persistence and Chrome discovery in one pass.

## Architecture

```
                        CLI (src/cli.ts)
                        ├── --session <id>
                        ├── --state <path>         ← TASK-003
                        ├── --connect / --cdp      ← TASK-009
                        │
                 ┌──────▼──────────────────┐
                 │   Server (src/server.ts)  │
                 │   ├── META_COMMANDS       │
                 │   │   ├── state clean     │ ← TASK-004
                 │   │   └── cookie-import   │ ← TASK-007
                 │   ├── shutdown → save all │ ← TASK-005
                 │   └── BROWSE_CDP_URL      │ ← TASK-009
                 └──────┬──────────────────┘
                        │
          ┌─────────────▼──────────────────┐
          │  SessionManager                 │
          │  ├── getOrCreate → loadState    │ ← TASK-005
          │  ├── closeSession → saveState   │ ← TASK-005
          │  └── closeAll → saveState       │ ← TASK-005
          └─────────────┬──────────────────┘
                        │
     ┌──────────────────▼────────────────────────┐
     │              Shared Modules                │
     │  ┌──────────────┐  ┌───────────────────┐  │
     │  │ encryption.ts │  │ session-persist.ts│  │
     │  │ TASK-001      │  │ TASK-002          │  │
     │  └──────────────┘  └───────────────────┘  │
     │  ┌──────────────┐  ┌───────────────────┐  │
     │  │cookie-import │  │chrome-discover.ts │  │
     │  │ TASK-006      │  │ TASK-008          │  │
     │  └──────────────┘  └───────────────────┘  │
     └───────────────────────────────────────────┘
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| AES-256-GCM encrypt/decrypt | `src/auth-vault.ts:50-96` | Extract to shared module |
| State save format (storageState) | `src/commands/meta.ts:170-213` | Reuse Playwright format |
| Session lifecycle hooks | `src/session-manager.ts:48-199` | Extend getOrCreate/closeSession/closeAll |
| CDP connection | `src/server.ts:391-396` | Reuse existing connectOverCDP path |
| Remote browser guard | `src/server.ts:105,337` | Already guards browser.close() |
| Path sanitization | `src/sanitize.ts` | Reuse for session IDs |
| CLI flag extraction | `src/cli.ts:519-576` | Follow existing --session pattern |

## Tasks

### TASK-001: Extract encryption module from auth-vault

Extract `resolveKey`, `encrypt`, `decrypt` from `src/auth-vault.ts` into a new shared `src/encryption.ts` module. Update `auth-vault.ts` to import from the new module. No behavior change — pure refactor.

The new module exports:
- `resolveEncryptionKey(localDir: string): Buffer` — env var → key file → auto-generate
- `encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string; authTag: string }`
- `decrypt(ciphertext: string, iv: string, authTag: string, key: Buffer): string`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `src/encryption.ts` exports the 3 functions above
- [ ] `src/auth-vault.ts` imports from `encryption.ts` and all existing auth tests pass
- [ ] Encryption roundtrip: encrypt then decrypt returns original plaintext

**Agent:** general-purpose

**Priority:** P0

---

### TASK-002: Create session-persist module

Create `src/session-persist.ts` with functions to save/load session state (Playwright `storageState` format) to/from disk, with optional encryption.

- `saveSessionState(sessionDir, context, encryptionKey?)` — calls `context.storageState()`, optionally encrypts via `encryption.ts`, writes `state.json` (mode 0o600). Catches errors gracefully (context closed, etc.)
- `loadSessionState(sessionDir, context, encryptionKey?)` — reads `state.json`, optionally decrypts, applies cookies via `context.addCookies()`. Restores localStorage per-origin with **3s timeout per origin** — skip unreachable origins. Returns false on missing/corrupted file (log warning, don't throw).
- `hasPersistedState(sessionDir)` — checks if `state.json` exists
- `cleanOldStates(localDir, maxAgeDays)` — deletes state files older than threshold from both `.browse/states/` and `.browse/sessions/*/state.json`

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Save + load roundtrip preserves cookies and localStorage
- [ ] Encrypted save + load roundtrip works with a test key
- [ ] Missing/corrupted state file returns false without throwing
- [ ] Unreachable origin during localStorage restore is skipped (3s timeout)

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Add --state CLI flag

Add `--state <path>` flag to `src/cli.ts`, extracted before the command (like `--session`). Pass the path to the server via `X-Browse-State` header.

On the server side (`src/server.ts`), when `X-Browse-State` header is present on the first command for a session: load the state file into the session's context before executing the command. If `--state` and `--session` are both present, load `--state` first, then auto-persisted session state merges on top.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --state auth.json goto https://example.com` loads cookies from auth.json before navigating
- [ ] `--state` with nonexistent file produces clear error message
- [ ] `--state` + `--session` both work together (state loaded, session persistence applies on top)

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P1

---

### TASK-004: Add state clean subcommand

Extend the `state` case in `src/commands/meta.ts` to accept `clean` subcommand (currently: `save|load|list|show`). Calls `cleanOldStates` from `session-persist.ts`.

Cleans both:
- `.browse/states/*.json` (manual state files)
- `.browse/sessions/*/state.json` (auto-persisted session state)

Default: 7 days. `--older-than N` flag for custom threshold.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse state clean` deletes state files older than 7 days from both directories
- [ ] `browse state clean --older-than 30` uses custom threshold
- [ ] Recent state files are not deleted

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P2

---

### TASK-005: Hook session persistence into SessionManager

Modify `src/session-manager.ts` and `src/server.ts` to auto-save/restore session state:

- `getOrCreate()`: after creating BrowserManager + context, call `loadSessionState()` if `hasPersistedState()` returns true. Skip for `"default"` session.
- `closeSession()`: call `saveSessionState()` before closing context. Skip for `"default"`.
- `closeAll()`: save state for each named session before closing.
- Server shutdown path: save all named sessions before exit.

Resolve encryption key once in server startup (via `resolveEncryptionKey(LOCAL_DIR)`) and pass through to SessionManager.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] Named session cookies persist across close/reopen cycle
- [ ] `"default"` session does NOT auto-persist
- [ ] Server shutdown saves all named session state
- [ ] Idle-timeout session close saves state before closing

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P1

---

### TASK-006: Create cookie-import module

Create `src/cookie-import.ts` — reads and decrypts cookies from Chromium-based browsers on macOS.

Browser registry (hardcoded):
- Chrome: `Google/Chrome/`, keychain `Chrome Safe Storage`
- Arc: `Arc/User Data/`, keychain `Arc Safe Storage`
- Brave: `BraveSoftware/Brave-Browser/`, keychain `Brave Safe Storage`
- Edge: `Microsoft Edge/`, keychain `Microsoft Edge Safe Storage`

Functions:
- `findInstalledBrowsers(): BrowserInfo[]` — checks cookie DB existence
- `listDomains(browser, profile?): { domain, count }[]` — SQL query, no decryption
- `importCookies(browser, domains[], profile?): Promise<ImportResult>` — full decrypt pipeline
- Internal: `getKeychainPassword()` (10s timeout, async Bun.spawn), `deriveKey()` (PBKDF2, cached), `decryptCookieValue()` (AES-128-CBC), `openDb()` (copy-on-lock for WAL)

Error types with `code` and optional `action: 'retry'` for retryable errors. Keychain errors surface actionable messages ("Look for macOS dialog, click Allow").

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] `findInstalledBrowsers()` returns correct structure for installed browsers
- [ ] `chromiumEpochToUnix()` correctly converts timestamps
- [ ] Locked DB path: copies DB+WAL+SHM to temp, reads, cleans up
- [ ] Keychain timeout (10s) produces actionable error message for the agent

**Agent:** general-purpose

**Priority:** P0

---

### TASK-007: Add cookie-import command handler

Wire `cookie-import` into the command system:

- Add `'cookie-import'` to `META_COMMANDS` in `src/server.ts`
- Add handler case in `src/commands/meta.ts`:
  - `cookie-import --list` → call `findInstalledBrowsers()`
  - `cookie-import <browser> [--domain <d>] [--profile <p>]` → call `importCookies()`, add to context
- Add `'cookie-import'` to `SAFE_TO_RETRY` in `src/cli.ts`
- Add to CLI help text

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse cookie-import --list` shows installed browsers
- [ ] `browse cookie-import chrome --domain github.com` imports cookies into session
- [ ] `cookie-import` is safe to retry after server restart
- [ ] Missing browser name shows helpful error with list of supported browsers

**Agent:** general-purpose

**Depends on:** TASK-006
**Priority:** P1

---

### TASK-008: Create chrome-discover module

Create `src/chrome-discover.ts` — discovers a running Chrome instance for CDP connection.

`discoverChrome(): Promise<string | null>`:
1. Check `DevToolsActivePort` in `~/Library/Application Support/Google/Chrome/` (and Arc, Brave, Edge)
2. Probe `http://127.0.0.1:9222/json/version` → extract `webSocketDebuggerUrl`
3. Probe port 9229
4. Return WebSocket URL or null

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] Returns WebSocket URL when Chrome is running with remote debugging
- [ ] Returns null when no Chrome is discoverable
- [ ] Does not hang — each probe has a 2s timeout

**Agent:** general-purpose

**Priority:** P0

---

### TASK-009: Add --connect and --cdp CLI flags

Add `--connect` (auto-discover) and `--cdp <port>` (explicit) flags to `src/cli.ts`:

- Extract flags before command (like `--session`)
- `--connect`: call `discoverChrome()`, set `BROWSE_CDP_URL` env var before spawning server
- `--cdp <port>`: construct `http://127.0.0.1:<port>` and set `BROWSE_CDP_URL`
- Both flags must force `BROWSE_RUNTIME=playwright` — error if `BROWSE_RUNTIME=lightpanda` is set (lightpanda rejects CDP connections per `src/runtime.ts:138-145`)
- Add to CLI help text

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --connect status` discovers and connects to running Chrome
- [ ] `browse --cdp 9222 status` connects to explicit port
- [ ] `--connect` with `BROWSE_RUNTIME=lightpanda` produces clear error
- [ ] Discovery failure produces actionable message: "Start Chrome with --remote-debugging-port=9222"

**Agent:** general-purpose

**Depends on:** TASK-008
**Priority:** P1

---

### TASK-010: Integration tests for all features

Add tests across test files:

`test/sessions.test.ts`:
- Session auto-persist roundtrip (save on close, restore on create)
- Default session does NOT persist
- Corrupted state file → graceful fresh start
- Encrypted state roundtrip
- `state clean` deletes old files, keeps recent
- `--state` flag loads before first command

`test/features.test.ts`:
- `chromiumEpochToUnix()` conversion
- `decryptCookieValue()` with known test vectors (create synthetic encrypted cookie)
- `findInstalledBrowsers()` returns expected structure
- `discoverChrome()` returns null when no Chrome running
- Cookie import with synthetic SQLite DB

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All new session persistence tests pass
- [ ] All cookie import unit tests pass with synthetic data
- [ ] All chrome discovery tests pass
- [ ] Full test suite (`bun test`) passes with no regressions

**Agent:** general-purpose

**Depends on:** TASK-005, TASK-007, TASK-009
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Encryption extraction breaks auth vault | TASK-001 | Run existing auth tests after extraction. Pure refactor — same key, same algorithm, same format. |
| Context already closed when saving state | TASK-002, TASK-005 | `saveSessionState` wraps in try/catch, logs warning, does not throw |
| Unreachable origin blocks session restore | TASK-002, TASK-005 | 3s per-origin timeout, skip on failure, log warning |
| Keychain dialog blocks server | TASK-006 | 10s async timeout via Bun.spawn, error message tells agent to relay "click Allow" to user |
| Chrome cookie DB locked (WAL) | TASK-006 | Copy DB+WAL+SHM to temp, read copy, clean up |
| lightpanda runtime + --connect | TASK-009 | Guard in CLI: force playwright runtime, error if lightpanda set |
| --connect kills user's Chrome on shutdown | TASK-009 | Already handled: `isRemoteBrowser` flag at server.ts:337 skips browser.close() |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| encryption.ts encrypt/decrypt | TASK-010 | unit |
| session-persist save/load roundtrip | TASK-010 | integration |
| session-persist encrypted roundtrip | TASK-010 | integration |
| session-persist unreachable origin | TASK-010 | integration |
| session-persist cleanOldStates | TASK-010 | unit |
| SessionManager auto-persist hooks | TASK-010 | integration |
| cookie-import chromiumEpochToUnix | TASK-010 | unit |
| cookie-import decryptCookieValue | TASK-010 | unit |
| cookie-import findInstalledBrowsers | TASK-010 | unit |
| cookie-import WAL copy-on-lock | TASK-010 | unit |
| chrome-discover discoverChrome | TASK-010 | unit |
| --state flag loading | TASK-010 | integration |
| --connect runtime guard | TASK-010 | unit |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-002"],
  "TASK-006": [],
  "TASK-007": ["TASK-006"],
  "TASK-008": [],
  "TASK-009": ["TASK-008"],
  "TASK-010": ["TASK-005", "TASK-007", "TASK-009"]
}
```
