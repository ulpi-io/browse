# Plan: Phase 8 — Cloud API Layer & SDK

> Generated: 2026-04-13
> Branch: `feat/cloud-api-layer`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase2-real-web-browsing-quality, phase3-snapshot-large-pages, phase4-proxy-pool, phase5-concurrency-lifecycle, phase6-new-commands, phase7-safety-skill-integration, phase9-container-isolation, phase10-microvm-snapshot-restore

## Overview

Add a cloud-deployable HTTP API gateway that provisions isolated browse sessions on demand for remote multi-tenant access, plus a TypeScript SDK (`@ulpi/browse-sdk`) that can talk to either a local browse server or the cloud endpoint. The cloud server wraps the existing server.ts command pipeline — same `executeCommand()`, same session multiplexing, same command registry — behind a new multi-tenant auth layer (API keys, JWT), session provisioning API, and WebSocket streaming for real-time events. Phase 8 of 10 in the browse roadmap.

## Scope Challenge

The existing `server.ts` already has the core pieces: HTTP server, session multiplexing via SessionManager, auth via Bearer token, command routing via `executeCommand()`. The cloud layer adds: (1) API key management replacing the single random UUID token, (2) session provisioning endpoints (create/list/delete/freeze), (3) tenant isolation boundaries, (4) a TypeScript SDK that abstracts local vs remote, (5) WebSocket transport for streaming events. The `server.ts` code is NOT modified — the cloud server is a separate entry point that imports and orchestrates the same domain modules.

## Prerequisites

- Phases 1-7 features are merged to main (prerequisite for cloud stability)
- SessionManager supports multi-session isolation with domain filters (verified: `src/session/manager.ts`)
- `executeCommand()` is the shared pipeline for all command execution (verified: `src/automation/executor.ts`)
- SessionTargetFactory decouples session creation from concrete target types (verified: `src/session/target-factory.ts`)
- Session state persistence (cookies, localStorage) exists (verified: `src/session/persist.ts`)
- AES-256-GCM encryption infrastructure exists (verified: `src/session/encryption.ts`)

## Non-Goals

- Container isolation per session (Phase 9)
- MicroVM snapshot/restore (Phase 10)
- Geographic distribution / edge routing
- Usage-based billing / payment integration
- Admin dashboard UI
- Rate limiting beyond basic per-tenant caps (advanced rate limiting is Phase 9)
- Custom Chromium builds or browser binary management
- RBAC or team permissions (single API key per tenant for now)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Cloud API Gateway → SessionManager | `src/cloud/gateway.ts` | `src/session/manager.ts` | Gateway validates API key, resolves tenant, calls `SessionManager.getOrCreate(tenantSessionId)` | Session IDs are prefixed with tenant ID to prevent cross-tenant access |
| API Key Vault → Gateway Auth | `src/cloud/auth.ts ApiKeyVault` | `src/cloud/gateway.ts validateRequest()` | `ApiKeyVault.validate(apiKey) → { tenantId, permissions, rateLimit } \| null` | Keys are hashed (SHA-256) before storage. Constant-time comparison. |
| Cloud Gateway → executeCommand | `src/cloud/gateway.ts handleCommand()` | `src/automation/executor.ts` | Same ExecuteOptions interface — lifecycle hooks, CommandContext | Cloud gateway constructs identical CommandContext to local server.ts |
| SDK → Cloud API / Local Server | `@ulpi/browse-sdk` | User application code | `BrowseClient { connect(opts): Session }` | SDK method signatures mirror CLI command names |
| WebSocket → Session Events | `src/cloud/ws.ts` | SDK / browser client | `WS messages: { type, sessionId, data }` | Best-effort — dropped events don't break command execution |

## Architecture

```
SDK / CLI / MCP Client
    │
    ▼
Cloud API Gateway (src/cloud/server.ts)        TASK-002
    │  0.0.0.0:8400
    │
    ├── POST /v1/auth ───────► ApiKeyVault      TASK-001
    │     (API key → JWT)       (SQLite, SHA-256)
    │
    ├── POST /v1/sessions ──► CloudSessionMgr   TASK-003
    │     (provision)           │
    │                           ├── tenant isolation
    │                           ├── session limits
    │                           └── freeze/resume
    │                                 └── persist.ts ◄── TASK-004
    │                                     (tab URLs, cookies, settings)
    │
    ├── POST /v1/sessions/:id/command
    │     │
    │     ▼
    │   executeCommand()        (src/automation/executor.ts — REUSED)
    │     │
    │     ▼
    │   SessionManager          (src/session/manager.ts — REUSED)
    │     │
    │     ▼
    │   BrowserTarget → Chromium
    │
    └── WS /v1/sessions/:id/ws  ◄── TASK-005
          (real-time events)

SDK Package (packages/browse-sdk/)
    ├── BrowseClient            TASK-006
    ├── LocalTransport          TASK-006
    └── CloudTransport          TASK-007
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Command execution pipeline | `src/automation/executor.ts` | Reuse as-is |
| Session multiplexing and isolation | `src/session/manager.ts` | Reuse as-is |
| Session state persistence | `src/session/persist.ts` | Extend (freeze/resume) |
| AES-256-GCM encryption | `src/session/encryption.ts` | Reuse as-is |
| Domain filtering per session | `src/security/domain-filter.ts` | Reuse as-is |
| Browser runtime resolution | `src/engine/resolver.ts` | Reuse as-is |
| Cloud provider pattern | `src/engine/providers.ts` | Extend (reference pattern) |
| HTTP server pattern | `src/server.ts nodeServe()` | Extend (new entry point) |
| Command registry | `src/automation/registry.ts` | Reuse as-is |
| Target factory pattern | `src/session/target-factory.ts` | Reuse as-is |

## Tasks

### TASK-001: API key vault and JWT auth module

Create `src/cloud/auth.ts` with ApiKeyVault class and JWT token generation.

ApiKeyVault stores API keys as SHA-256 hashes in a SQLite database (reusing the existing better-sqlite3 dependency). Each key record: `{ id, tenantId, keyHash, name, permissions, maxSessions, maxConcurrent, createdAt, revokedAt }`. Keys are prefixed with `brw_` for identification.

JWT implementation uses native Node.js `crypto` — no external library. Token format: base64url-encoded JSON header + payload + HMAC-SHA256 signature. Header: `{ alg: 'HS256', typ: 'JWT' }`. Payload: `{ tenantId, sessionId, permissions, iat, exp }`. Expiry: 15 minutes. Signing key from `BROWSE_CLOUD_JWT_SECRET` env var (64-char hex) or auto-generated via `crypto.randomBytes(32)` stored at `.browse/.cloud-jwt-key`. Uses `crypto.timingSafeEqual()` for signature comparison. This avoids adding a `jsonwebtoken` dependency while providing standard JWT interop.

Export: `ApiKeyVault` class, `createJwt()`, `validateJwt()`, `hashApiKey()`.

Register exports in `src/cloud/index.ts` barrel.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] ApiKeyVault.create(tenantId, name) returns a key starting with `brw_` and stores SHA-256 hash in SQLite
- [ ] ApiKeyVault.validate(rawKey) returns tenant info for valid keys, null for invalid/revoked keys, and runs in constant time
- [ ] createJwt() returns a signed JWT with 15-minute expiry containing tenantId and permissions; validateJwt() rejects expired or tampered tokens

**Write Scope:** `src/cloud/auth.ts`, `src/cloud/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-002: Cloud server entry point and config

Create `src/cloud/server.ts` as the cloud server entry point (separate from `src/server.ts`).

This server:
1. Reads cloud config from env vars: `BROWSE_CLOUD_PORT` (default 8400), `BROWSE_CLOUD_HOST` (default 0.0.0.0), `BROWSE_CLOUD_JWT_SECRET`, `BROWSE_CLOUD_DB_PATH` (default .browse/cloud.db)
2. Initializes ApiKeyVault (from TASK-001)
3. Launches browser via getRuntime() (same as server.ts)
4. Creates a SessionManager with the browser target factory
5. Starts HTTP server with routes: `GET /health`, `POST /v1/sessions`, `GET /v1/sessions`, `DELETE /v1/sessions/:id`, `POST /v1/sessions/:id/command`, `POST /v1/keys` (admin)
6. Listens on 0.0.0.0 (not 127.0.0.1 like local server)

Add `BROWSE_CLOUD_DEFAULTS` to `src/constants.ts` with cloud-specific defaults.

Add `"cloud"` script to package.json: `"cloud": "tsx src/cloud/server.ts"`.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Cloud server starts on configured port, responds to GET /health with `{ status: 'healthy', sessions, version }`
- [ ] POST /v1/sessions/:id/command with valid JWT routes to executeCommand() and returns command output
- [ ] Requests without valid API key or JWT receive 401 with clear error message

**Write Scope:** `src/cloud/server.ts`, `src/constants.ts`, `package.json`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Session provisioning and tenant isolation

Create `src/cloud/sessions.ts` with CloudSessionManager that wraps the existing SessionManager with tenant boundaries.

CloudSessionManager:
1. `provision(tenantId, opts?)` — creates a new session with tenant-scoped ID (`tenant:<tenantId>:session:<uuid>`), enforces per-tenant session limit, returns `{ sessionId, createdAt, expiresAt }`
2. `list(tenantId)` — lists only sessions belonging to this tenant
3. `get(tenantId, sessionId)` — returns session info if it belongs to tenant, 403 otherwise
4. `terminate(tenantId, sessionId)` — closes session and cleans up, 403 if wrong tenant
5. `freeze(tenantId, sessionId)` — saves session state, closes browser context, marks as frozen
6. `resume(tenantId, sessionId)` — restores session state into fresh browser context

Tenant enforcement: all methods validate that the session's tenant prefix matches. Cross-tenant access throws `TenantAccessError`.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] provision() creates a session with tenant-prefixed ID and enforces maxSessions limit (returns 429 when exceeded)
- [ ] get(tenantA, sessionOwnedByTenantB) throws TenantAccessError — cross-tenant access is impossible
- [ ] freeze() saves state via saveSessionState() and resume() restores into a fresh browser context with cookies/localStorage intact

**Write Scope:** `src/cloud/sessions.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001, TASK-002
**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Session freeze/resume with state snapshots

Extend `src/session/persist.ts` to support full session freeze/resume for cloud use.

Current persist.ts saves cookies and localStorage. For cloud freeze/resume, also capture:
1. Tab URLs (all open tabs, not just active)
2. Active tab ID
3. Context level setting
4. Domain filter configuration
5. Settle mode flag

Add `freezeSession()` and `resumeSession()` functions. The existing `saveSessionState`/`loadSessionState` remain unchanged for backward compatibility.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] freezeSession() captures tab URLs, active tab ID, context level, domain filter config, and settle mode in addition to cookies/localStorage
- [ ] resumeSession() restores a frozen session with all tabs navigated to saved URLs and active tab re-selected
- [ ] Freeze/resume round-trip preserves cookies — verified by setting a cookie, freezing, resuming, and reading the cookie back

**Write Scope:** `src/session/persist.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: WebSocket event streaming

Create `src/cloud/ws.ts` with WebSocket upgrade handler for real-time session event streaming.

Event types: `console`, `network`, `context`, `error`, `session`. Auth via `?token=<jwt>` query parameter. Connection lifecycle: ping/pong every 30s, idle disconnect after 5 min, max 100 connections per tenant.

Add `onConsoleEntry` and `onNetworkEntry` callback fields to `SessionBuffers` in `src/network/buffers.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] WebSocket connection on /v1/sessions/:id/ws streams console entries in real-time as JSON messages with type='console'
- [ ] Invalid JWT in query param results in WS close with code 4001 and reason 'Unauthorized'
- [ ] Connection that misses 3 consecutive pings is terminated server-side

**Write Scope:** `src/cloud/ws.ts`, `src/network/buffers.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002, TASK-003
**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-006: TypeScript SDK — core client and local transport

Create the SDK as an in-repo module at `src/sdk/` — avoids introducing a monorepo workspace pattern. The SDK is built and bundled alongside the main CLI.

Core classes:
1. `BrowseClient` — main entry point. `BrowseClient.connect({ endpoint?, apiKey? })` returns a `BrowseSession`.
2. `BrowseSession` — methods mirror CLI commands: `goto(url)`, `click(selector)`, `fill(selector, value)`, `text()`, `snapshot(opts?)`, `screenshot(path?)`, etc.
3. `LocalTransport` — sends HTTP requests to local browse server (reads state file, auto-starts server).

Consumers import from `@ulpi/browse/sdk` via package.json `exports` field.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] BrowseClient.connect() with no options connects to local browse server and returns a BrowseSession
- [ ] session.goto('https://example.com') followed by session.text() returns page text content
- [ ] SDK exports are typed — TypeScript consumers get autocomplete for all session methods

**Write Scope:** `src/sdk/index.ts`, `src/sdk/client.ts`, `src/sdk/session.ts`, `src/sdk/transports/local.ts`, `package.json`
**Validation:** `npx tsc --noEmit`

**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-007: SDK cloud transport and session lifecycle

Add cloud transport to the SDK that connects to the browse cloud API.

Create `src/sdk/transports/cloud.ts` with API key → JWT exchange, session provisioning, command execution, freeze/resume, and optional WebSocket event subscription.

Update `BrowseClient.connect()` to accept `{ endpoint: 'https://api.browse.dev', apiKey: 'brw_...' }` and automatically use CloudTransport.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] BrowseClient.connect({ endpoint, apiKey }) authenticates and returns a BrowseSession backed by CloudTransport
- [ ] session.goto() sends POST /v1/sessions/:id/command with JWT auth header and returns typed result
- [ ] session.freeze() and session.resume() call the correct cloud API endpoints and session continues working after resume

**Write Scope:** `src/sdk/transports/cloud.ts`, `src/sdk/transports/index.ts`, `src/sdk/client.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-006, TASK-002
**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-008: Cloud API integration tests

Create `test/cloud.test.ts` with integration tests for the cloud API layer and `test/cloud-sdk.test.ts` for SDK tests. This is P1 because it covers security-sensitive auth paths that must be tested at ship cut.

Cloud API tests: auth flow (security-critical: API key → JWT → command → revoke → reject → expired → tampered), session provisioning lifecycle, tenant isolation, rate limiting, WebSocket streaming, health endpoint.

SDK tests: local transport round-trip, cloud transport round-trip with typed results.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All cloud API integration tests pass including auth flow, session lifecycle, tenant isolation, and rate limiting
- [ ] SDK tests verify both local and cloud transport round-trips with typed results
- [ ] Tenant isolation test proves that tenant A cannot access tenant B's session (receives 403 or TenantAccessError)

**Write Scope:** `test/cloud.test.ts`, `test/cloud-sdk.test.ts`
**Validation:** `npm test -- test/cloud`

**Depends on:** TASK-002, TASK-003, TASK-005, TASK-007
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Cross-tenant session leakage via session ID collision | TASK-001, TASK-003 | Tenant-prefixed session IDs with UUID generation |
| API key brute force | TASK-001 | SHA-256 hashed storage, constant-time comparison, rate limit on auth failures |
| Resource exhaustion — one tenant spawns too many sessions | TASK-003 | Per-tenant session limit (default 10), configurable per API key |
| WebSocket connection leak | TASK-005 | 30s ping/pong, 5 min idle disconnect, max 100 WS per tenant |
| SDK version drift from server API | TASK-006, TASK-007 | API version header, 400 with upgrade hint on mismatch |
| Local server.ts and cloud gateway diverge | TASK-003 | Both import same executeCommand() pipeline |
| SQLite single-writer under multi-instance | TASK-001, TASK-002 | Phase 8 is single-process. Multi-instance needs PostgreSQL migration (future). |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 = cloud API with auth, session provisioning, and command execution
- **Full Phase 8:** All 8 tasks = cloud API + SDK + WebSocket + freeze/resume
- **Not shippable without Phase 9:** multi-tenant production use (needs container isolation)

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| API key creation, validation, revocation | TASK-008 | integration |
| JWT token generation and validation | TASK-008 | integration |
| Auth flow end-to-end (key → JWT → command → revoke) | TASK-008 | integration |
| Tenant isolation — cross-tenant access blocked | TASK-003 | integration |
| Session provisioning lifecycle | TASK-003 | integration |
| Cloud gateway routes command to correct session | TASK-003 | integration |
| Per-tenant session limits enforced | TASK-003 | unit |
| WebSocket event streaming | TASK-005 | integration |
| SDK connect to local server | TASK-006 | integration |
| SDK connect to cloud endpoint | TASK-007 | integration |
| Cloud server startup and health check | TASK-002 | integration |
| Session freeze/resume via state persistence | TASK-004 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 8 |
| Layer Count | 4 |
| Critical Path | TASK-001 → TASK-002 → TASK-003 → TASK-008 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-006 | Independent: auth module + SDK core (no deps) |
| 1 | TASK-002, TASK-007 | Cloud server + SDK cloud transport |
| 2 | TASK-003, TASK-004, TASK-005 | Session provisioning + freeze/resume + WebSocket |
| 3 | TASK-008 | Integration tests (depends on all above) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-002"],
  "TASK-005": ["TASK-002", "TASK-003"],
  "TASK-006": [],
  "TASK-007": ["TASK-006", "TASK-002"],
  "TASK-008": ["TASK-002", "TASK-003", "TASK-005", "TASK-007"]
}
```
