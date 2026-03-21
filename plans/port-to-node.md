# Plan: Port from Bun to Node.js

> Generated: 2026-03-21
> Branch: `feat/port-to-node`
> Mode: EXPANSION

## Overview

Replace all Bun-specific APIs with Node.js equivalents to unblock CDP/WebSocket connections (`--connect`, `--cdp`, lightpanda runtime), enable Windows support, and remove dependency on the Bun runtime. The core logic (Playwright, snapshot, commands, buffers, session manager) uses zero Bun APIs and is untouched.

## Scope Challenge

The Bun surface area is thin and confined to edges:
- **server.ts**: `Bun.serve()` — 1 call
- **cli.ts**: `Bun.spawn()` (1), `Bun.sleep()` (5), `Bun.stdin.text()` (2)
- **runtime.ts**: `Bun.listen()` (1), `Bun.spawn()` (1)
- **cookie-import.ts**: `bun:sqlite` (1 import), `Bun.spawn()` (1)
- **meta.ts**: `Bun.version` (1 reference in `doctor` command)
- **bin/browse.ts**: shebang `#!/usr/bin/env bun`
- **7 test files**: `bun:test` imports
- **package.json**: `bun build --compile`, `bun test`, `engines.bun`
- **build-all.sh**: `bun build --compile --target`

Core logic (15+ files) is pure Node.js `fs`, `path`, `crypto`, `net`. Zero changes needed.

EXPANSION mode chosen to include: esbuild pipeline, vitest config, tsconfig adjustments, Windows CI readiness, and enabling the blocked CDP features.

## Architecture

```
bin/browse.ts ─────────── TASK-001 (shebang + tsx/node)
      │
src/cli.ts ────────────── TASK-002 (Bun.spawn→child_process, Bun.sleep→setTimeout, stdin)
      │
src/server.ts ─────────── TASK-003 (Bun.serve→node:http)
      │
src/runtime.ts ────────── TASK-004 (Bun.listen→net, Bun.spawn→child_process, unblock lightpanda)
      │
src/cookie-import.ts ──── TASK-005 (bun:sqlite→better-sqlite3, Bun.spawn→child_process)
      │
src/commands/meta.ts ──── TASK-006 (Bun.version reference in doctor)
      │
package.json ──────────── TASK-007 (deps, scripts, engines, build)
scripts/build-all.sh
tsconfig.json
      │
test/*.test.ts ────────── TASK-008 (bun:test→vitest, vitest.config.ts)
test/setup.ts
      │
src/bun.d.ts ──────────── TASK-009 (remove, no longer needed)
      │
                           TASK-010 (unblock --connect/--cdp in cli.ts)
                           TASK-011 (full test run + integration verification)
                           TASK-012 (docs: CHANGELOG, README, SKILL.md)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| HTTP server | `src/server.ts` (Bun.serve) | Replace with `node:http` createServer |
| Process spawn | `src/cli.ts`, `src/runtime.ts`, `src/cookie-import.ts` | Replace `Bun.spawn` with `child_process.spawn` |
| Sleep/delay | `src/cli.ts` (Bun.sleep) | Replace with `setTimeout` promise wrapper |
| Stdin reading | `src/cli.ts` (Bun.stdin.text) | Replace with `process.stdin` stream read |
| SQLite | `src/cookie-import.ts` (bun:sqlite) | Replace with `better-sqlite3` |
| Port detection | `src/runtime.ts` (Bun.listen) | Replace with `net.createServer` (already used elsewhere) |
| Test runner | all test files (bun:test) | Replace with vitest (same describe/test/expect API) |
| Binary build | `bun build --compile` | Replace with esbuild bundle + Node SEA or just `npx` |
| Type declarations | `src/bun.d.ts` | Remove entirely |
| Core logic (15+ files) | browser-manager, session-manager, snapshot, buffers, etc. | Reuse as-is (zero changes) |

## Tasks

### TASK-001: Update entry point and shebang

Replace `#!/usr/bin/env bun` with `#!/usr/bin/env node` in `bin/browse.ts`. Change file extension from `.ts` to `.js` (or use `tsx` as runner). Ensure the entry point works with both `node` and `tsx`.

**Files:** `bin/browse.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `bin/browse.ts` (or `.js`) runs with `node` or `tsx` without errors
- [ ] Shebang is `#!/usr/bin/env node` (or `#!/usr/bin/env tsx`)
- [ ] `__BROWSE_SERVER_MODE=1` still routes to server.ts correctly

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Port cli.ts from Bun APIs to Node.js

Replace all Bun-specific APIs in `src/cli.ts`:
- `Bun.spawn(cmd, opts)` → `child_process.spawn(cmd[0], cmd.slice(1), opts)` with `.unref()`
- `Bun.sleep(ms)` → `new Promise(r => setTimeout(r, ms))` (5 occurrences)
- `Bun.stdin.text()` → stream-read `process.stdin` (2 occurrences)
- Dev mode spawn: `['bun', 'run', SERVER_SCRIPT]` → `['tsx', SERVER_SCRIPT]` or `['node', '--import', 'tsx', SERVER_SCRIPT]`

**Files:** `src/cli.ts`

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] All 5 `Bun.sleep()` calls replaced with `setTimeout` promise
- [ ] `Bun.spawn()` replaced with `child_process.spawn()` with proper stdio and unref
- [ ] `Bun.stdin.text()` replaced with process.stdin stream reader
- [ ] Dev mode spawn uses `tsx` (or `node --import tsx`) instead of `bun run`
- [ ] Server still starts and responds to health check after spawn

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-003: Port server.ts from Bun.serve to node:http with thin adapter

Replace `Bun.serve()` with a ~20-line adapter function that bridges `http.createServer()` to the same `fetch(Request) → Response` signature. Zero new dependencies — uses Node 18+ global `Request`/`Response`.

Write a `nodeServe()` function at the top of server.ts (or in a small `src/node-serve.ts` helper):

```typescript
import * as http from 'http';

function nodeServe(opts: { port: number; hostname: string; fetch: (req: Request) => Promise<Response> }) {
  const server = http.createServer(async (nodeReq, nodeRes) => {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = `http://${opts.hostname}:${opts.port}${nodeReq.url}`;
    const req = new Request(url, {
      method: nodeReq.method,
      headers: nodeReq.headers as Record<string, string>,
      body: nodeReq.method !== 'GET' ? body : undefined,
    });
    const res = await opts.fetch(req);
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    nodeRes.end(await res.text());
  });
  server.listen(opts.port, opts.hostname);
  return server;
}
```

Then replace `Bun.serve({ port, hostname, fetch })` with `nodeServe({ port, hostname, fetch })`. The `handleCommand()` and entire fetch handler stay **unchanged**.

**Files:** `src/server.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `Bun.serve()` replaced with `nodeServe()` adapter using `http.createServer()`
- [ ] `handleCommand()` and the fetch handler are **unchanged** (same Request/Response API)
- [ ] `/health` endpoint returns JSON with status, uptime, sessions
- [ ] `/command` POST endpoint parses JSON body and dispatches to handlers
- [ ] Auth header validation works identically
- [ ] Server exits cleanly on Chromium disconnect
- [ ] Zero new dependencies added for this task

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-004: Port runtime.ts from Bun APIs to Node.js

Replace `Bun.listen()` (used for ephemeral port detection) with `net.createServer()` and `Bun.spawn()` with `child_process.spawn()`. Unblock the lightpanda runtime — remove the error throw about Bun WebSocket bug since Node.js handles CDP WebSocket correctly.

**Files:** `src/runtime.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `Bun.listen()` replaced with `net.createServer().listen(0)` for free port detection
- [ ] `Bun.spawn()` replaced with `child_process.spawn()`
- [ ] Lightpanda runtime error about Bun WebSocket bug is removed
- [ ] `connectOverCDP(wsUrl)` call is reached (no longer thrown before)
- [ ] Playwright and rebrowser runtimes still work unchanged

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-005: Port cookie-import.ts from bun:sqlite to better-sqlite3

Replace `import { Database } from 'bun:sqlite'` with `import Database from 'better-sqlite3'`. Replace `Bun.spawn()` with `child_process.spawn()`. The `better-sqlite3` API is nearly identical to `bun:sqlite` — both use `.prepare().all()` and `.prepare().get()`.

**Files:** `src/cookie-import.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `bun:sqlite` import replaced with `better-sqlite3`
- [ ] `Bun.spawn()` replaced with `child_process.spawn()`
- [ ] Cookie import from Chrome on macOS still works (reads and decrypts cookies)
- [ ] `better-sqlite3` added to package.json dependencies
- [ ] Handles missing database file gracefully (error message, not crash)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-007
**Priority:** P1

---

### TASK-006: Remove Bun.version from meta.ts doctor command

Replace `Bun.version` reference in the `doctor` command with Node.js `process.version`. Update the output label from "Bun:" to "Node:".

**Files:** `src/commands/meta.ts`

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `Bun.version` replaced with `process.version`
- [ ] Doctor output shows "Node: v20.x.x" instead of "Bun: x.x.x"
- [ ] No other Bun references remain in meta.ts

**Agent:** nodejs-cli-senior-engineer

**Priority:** P1

---

### TASK-007: Update package.json, tsconfig, and build scripts

Update `package.json`:
- Remove `"engines": { "bun": ">=1.0" }`, add `"engines": { "node": ">=18.0" }`
- Add dependencies: `better-sqlite3`, `tsx`, `esbuild`, `vitest`
- Update scripts: `"test": "vitest run"`, `"dev": "tsx src/cli.ts"`, `"build": "esbuild ..."`
- Update `"bin"` entry if filename changed
- Change `"postinstall"` from `bunx` to `npx`

Update `scripts/build-all.sh` to use `esbuild` instead of `bun build --compile`. Output a Node.js bundle that can run via `node dist/browse.js` (or use Node SEA for single binary).

Remove `src/bun.d.ts` — no longer needed.

**Files:** `package.json`, `scripts/build-all.sh`, `src/bun.d.ts`

**Type:** infra
**Effort:** M

**Acceptance Criteria:**
- [ ] `npm install` succeeds (no bun-specific deps)
- [ ] `npm test` runs vitest
- [ ] `npm run build` produces a working bundle via esbuild
- [ ] `npx playwright install chromium` works as postinstall
- [ ] `src/bun.d.ts` is deleted
- [ ] `engines` field specifies Node >=18, not Bun

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-008: Port tests from bun:test to vitest

Replace `import { describe, test, expect, beforeAll, afterAll } from 'bun:test'` with `import { describe, test, expect, beforeAll, afterAll } from 'vitest'` in all 7 test files + setup.ts. Create `vitest.config.ts` with appropriate timeout settings (tests launch Chromium).

**Files:** `test/setup.ts`, `test/commands.test.ts`, `test/snapshot.test.ts`

Note: only 3 files listed but the same mechanical change applies to all 7 test files. The agent should apply to all `.test.ts` files in `test/`.

**Type:** refactor
**Effort:** M

**Acceptance Criteria:**
- [ ] All test files import from `vitest` instead of `bun:test`
- [ ] `vitest.config.ts` created with test timeout (60s for browser tests)
- [ ] `vitest run` passes all 240+ tests
- [ ] No `bun:test` imports remain anywhere in the codebase
- [ ] Test that previously timed out with default timeout still passes with configured timeout

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-007
**Priority:** P1

---

### TASK-009: Clean up Bun artifacts and type declarations

Remove `src/bun.d.ts` (Bun type declarations — no longer needed). Search entire codebase for any remaining `Bun.`, `bun:`, or Bun-specific references and remove them. Update tsconfig.json to remove Bun-related types if present.

**Files:** `src/bun.d.ts`, `tsconfig.json`

**Type:** chore
**Effort:** S

**Acceptance Criteria:**
- [ ] `src/bun.d.ts` deleted
- [ ] `grep -r "Bun\." src/` returns zero matches (excluding comments about the migration)
- [ ] `grep -r "bun:" src/` returns zero matches
- [ ] TypeScript compiles cleanly (`tsc --noEmit`)

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-003, TASK-004, TASK-005, TASK-006
**Priority:** P2

---

### TASK-010: Unblock --connect and --cdp flags

The `--connect` and `--cdp` features in `src/cli.ts` were blocked by Bun's WebSocket bug (oven-sh/bun#9911). With Node.js, `playwright.connectOverCDP(wsUrl)` works correctly. Remove the BLOCKED guard, enable the flags, and test CDP connection.

**Files:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `--connect` flag discovers and connects to a running Chrome instance
- [ ] `--cdp <port>` connects to Chrome at the specified debugging port
- [ ] `playwright.connectOverCDP()` succeeds (no WebSocket handshake failure)
- [ ] Error message when no Chrome instance is found is clear and actionable

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-003
**Priority:** P2

---

### TASK-011: Full integration test + build verification

Run the complete test suite under Node.js/vitest. Verify the esbuild bundle works. Test the CLI end-to-end: `browse goto`, `browse snapshot -i`, `browse click`, `browse record start/stop/export`. Test dev mode (`tsx`) and built mode.

**Files:** (no files modified — verification only)

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] `npm test` passes all 240+ tests under vitest
- [ ] `npm run build` produces a working bundle
- [ ] `node dist/browse.js goto https://example.com` works
- [ ] `tsx src/cli.ts goto https://example.com` works (dev mode)
- [ ] Record → export → `npx @puppeteer/replay` passes
- [ ] No Bun runtime is installed — everything runs on Node.js only

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-008, TASK-009, TASK-010
**Priority:** P2

---

### TASK-012: Update docs (CHANGELOG, README, SKILL.md)

Update documentation to reflect the Node.js port:
- CHANGELOG.md: add v1.0.0 entry documenting the Node.js port
- README.md: update install instructions (remove Bun requirement), update architecture section, mention `--connect`/`--cdp` as now working
- SKILL.md (both copies): update setup instructions
- features-comparison.md: update BLOCKED entries to YES, add Windows YES

**Files:** `CHANGELOG.md`, `README.md`, `skill/SKILL.md`

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] README no longer mentions Bun as a requirement
- [ ] Install instructions use `npm install -g @ulpi/browse`
- [ ] `--connect`/`--cdp` documented as working (not BLOCKED)
- [ ] CHANGELOG has v1.0.0 entry
- [ ] Features comparison updated

**Agent:** general-purpose

**Depends on:** TASK-011
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| `child_process.spawn()` stdio handling differs from `Bun.spawn()` | TASK-002 | Test spawn + unref + stdio pipes explicitly. Node uses `'pipe'` string, not Bun's object. |
| `http.createServer()` doesn't use Web API Request/Response | TASK-003 | Parse IncomingMessage manually (read body, extract headers). The response shapes stay the same. |
| `better-sqlite3` requires native compilation | TASK-005 | It's a well-maintained package with prebuilt binaries for all platforms. Falls back to node-gyp. |
| vitest timeout defaults too low for Chromium tests | TASK-008 | Set `testTimeout: 60000` in vitest.config.ts. |
| esbuild can't bundle native modules (better-sqlite3) | TASK-007 | Mark `better-sqlite3` as external in esbuild config, ship alongside bundle. |
| `process.stdin` stream reading differs from `Bun.stdin.text()` | TASK-002 | Use `process.stdin.setEncoding('utf8')` + `for await (const chunk of process.stdin)` pattern. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Node.js HTTP server (request handling) | TASK-011 | integration |
| child_process.spawn server startup | TASK-011 | integration |
| setTimeout-based sleep | TASK-011 | integration |
| process.stdin reading | TASK-011 | integration |
| better-sqlite3 cookie read | TASK-011 | integration |
| vitest runner compatibility | TASK-008 | integration |
| esbuild bundle output | TASK-011 | integration |
| CDP WebSocket connection (--connect) | TASK-010 | integration |
| lightpanda runtime unblocked | TASK-004 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": [],
  "TASK-004": [],
  "TASK-005": ["TASK-007"],
  "TASK-006": [],
  "TASK-007": [],
  "TASK-008": ["TASK-007"],
  "TASK-009": ["TASK-002", "TASK-003", "TASK-004", "TASK-005", "TASK-006"],
  "TASK-010": ["TASK-002", "TASK-003"],
  "TASK-011": ["TASK-008", "TASK-009", "TASK-010"],
  "TASK-012": ["TASK-011"]
}
```
