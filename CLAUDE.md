# @ulpi/browse

Fast headless browser CLI for AI coding agents. Persistent Chromium daemon via Playwright, controlled through `browse <command>` CLI. Supports parallel agents via session multiplexing.

## Project Documentation

@.claude/claude-md-refs/architecture.md
@.claude/claude-md-refs/development-guide.md
@.claude/claude-md-refs/exports-reference.md

## Quick Documentation Reference

| Need Help With | See File |
|----------------|----------|
| Adding commands, testing, building | development-guide.md |
| System design, request flow, crash recovery | architecture.md |
| Finding functions, types, command tables | exports-reference.md |

## Tech Stack

- **Runtime:** Node.js (>=18.0)
- **Browser:** Playwright + Chromium (headless)
- **Language:** TypeScript (ESNext, strict, bundler resolution)
- **Tests:** `bun:test` (integration tests against real browser)
- **Build:** `npm run build` (esbuild bundle with `--external` flags)

## Project Structure

```
bin/browse.ts                Entry point (shebang)
src/cli.ts                   CLI client (HTTP wrapper, --session flag)
src/server.ts                Persistent server daemon (session-aware)
src/constants.ts             Default config values
src/config.ts                Project config loader (browse.json)
src/types.ts                 Shared TypeScript interfaces
src/install-skill.ts         Claude Code skill installer

src/automation/              Domain: target-neutral execution contracts
  target.ts                  AutomationTarget interface + capabilities
  command.ts                 CommandSpec type + CommandRegistry class
  registry.ts                Singleton registry — single source of truth for all commands
  executor.ts                executeCommand() shared pipeline (used by server + MCP)
  action-context.ts          Page state capture + delta formatting for write context
  events.ts                  Command lifecycle hooks (before/after/error)
  index.ts                   Barrel exports

src/browser/                 Domain: Playwright browser lifecycle
  target.ts                  BrowserTarget interface (43 methods handlers call)
  manager.ts                 BrowserManager (implements BrowserTarget)
  tabs.ts                    TabManager collaborator
  refs.ts                    RefManager collaborator (@ref state)
  snapshot.ts                ARIA snapshot with @ref system
  emulation.ts               Device aliases, resolveDevice, listDevices
  profiles.ts                Profile management (persistent contexts)
  react-devtools.ts          React DevTools integration
  cookie-import.ts           Browser cookie import
  png-compare.ts             Self-contained PNG decoder + pixel comparator
  events.ts                  Event wiring anchor
  index.ts                   Barrel exports

src/network/                 Domain: buffers + HAR export
  buffers.ts                 SessionBuffers class + ring buffers
  har.ts                     HAR 1.2 export from network buffer
  index.ts                   Barrel exports

src/session/                 Domain: session multiplexing
  manager.ts                 SessionManager (Map<id, Session>)
  persist.ts                 Session state save/restore
  encryption.ts              AES-256-GCM key management
  index.ts                   Barrel exports

src/security/                Domain: access control + credentials
  domain-filter.ts           Domain allowlist (HTTP + WS/ES/sendBeacon)
  policy.ts                  Action policy gate (allow/deny/confirm)
  auth-vault.ts              Encrypted credential storage
  sanitize.ts                Path-safe name sanitization
  index.ts                   Barrel exports

src/engine/                  Domain: browser runtime discovery
  resolver.ts                Runtime resolver (local/CDP/cloud)
  chrome.ts                  Chrome/Chromium discovery
  providers.ts               Cloud provider management
  index.ts                   Barrel exports

src/export/                  Domain: recording + export
  record.ts                  RecordedStep type + resolveRefSelectors + exportBrowse
  replay.ts                  Chrome DevTools Recorder export (exportReplay)
  index.ts                   Barrel exports

src/mcp/                     Domain: MCP server + tool definitions
  server.ts                  MCP server (stdio transport, executeCommand pipeline)
  tools/read.ts              Read command MCP schemas
  tools/write.ts             Write command MCP schemas
  tools/meta.ts              Meta command MCP schemas
  tools/index.ts             Tool aggregation + mapToolCallToCommand()
  index.ts                   Barrel exports

src/commands/                Command handlers (accept BrowserTarget)
  read.ts                    Read commands
  write.ts                   Write commands
  meta/index.ts              Meta dispatcher
  meta/tabs.ts               Tab management commands
  meta/screenshots.ts        Screenshot/PDF/responsive/diff commands
  meta/recording.ts          Record/HAR/video commands
  meta/sessions.ts           Session/state/handoff commands
  meta/inspection.ts         Snapshot/find/frame/coverage/detect commands
  meta/auth.ts               Auth/cookie-import commands
  meta/system.ts             Status/stop/restart/chain/doctor commands
  meta/profile.ts            Profile/react-devtools/provider commands

test/                        Test suite (526 tests, 11 files)
  architecture.test.ts       Domain structure + contract enforcement
  commands.test.ts           Integration tests
  snapshot.test.ts           Snapshot-specific tests
  sessions.test.ts           Session multiplexing isolation tests
  session-e2e.test.ts        E2E CLI session tests
  features.test.ts           Feature tests (policy, auth, HAR, registry, executor)
  interactions.test.ts       Interaction command tests
  mcp.test.ts                MCP integration tests
  action-context.test.ts     Action context tests
  test-server.ts             Local HTTP fixture server
  fixtures/                  HTML test fixtures

scripts/
  check-legacy-imports.mjs   Guard: fails on deprecated import paths
```

## Key Commands

```bash
npm test                                              # Run tests (vitest)
npx tsx src/cli.ts <command> [args]                   # Dev mode
npx tsx src/cli.ts --session <id> <command> [args]    # Dev mode with session
npm run build                                         # Build bundle (esbuild)
```

## Architecture Summary

```
CLI [--session <id>] → Server (node:http) → CommandRegistry → executeCommand() → Handler → AutomationTarget → Chromium
```

- **CommandRegistry** is the single source of truth for all commands (category, metadata, MCP schema)
- **AutomationTarget** is the target-neutral contract — `BrowserManager` implements it, future targets (app, flow) will too
- **executeCommand()** is the shared pipeline with lifecycle hooks (before/after/error)
- Server auto-starts on first command, shuts down when all sessions idle (30 min)
- Session multiplexing: multiple agents share one Chromium via `--session` flag
- Each session: own BrowserContext, tabs, @refs, console/network buffers, cookies
- State file: `.browse/browse-server.json` (pid, port, token)
- Crash recovery: CLI detects dead server → auto-restart

## Command Categories (registry-derived)

Command counts and sets are derived from `src/automation/registry.ts` — no hand-maintained sets.
- **Read** (22): content extraction, evaluation, element inspection
- **Write** (40): navigation, interaction, configuration
- **Meta** (37): tabs, screenshots, recording, sessions, inspection, auth, system

## Development Rules

- **No destructive git.** NEVER run `git reset --hard`, `git checkout .`, `git clean -f`, or any command that destroys uncommitted work. If branches diverge, use `git pull --rebase` or ask the user. Uncommitted files may contain in-progress work.
- **No shortcuts.** When you find a bug, stop and fix it. Don't patch around it, don't defer it.
- **No filtered-out errors.** If `tsc --noEmit` shows errors in files you're touching, fix them in the same task. Never `grep -v` errors out of the output to make a check "pass" — that's hiding debt, not completing work.
- **No fake reviews.** Find real bugs or say it's clean. Never list non-issues as findings.
- **Automagic for customers.** The tool must self-heal. Zombie servers, port conflicts, stale state — all handled automatically. If you need `pkill` or `rm` before testing, that's a bug.
- **Build command:** Always `npm run build` (esbuild with `--external` flags for playwright optional deps).
- **Bundle:** Self-spawns in server mode via `__BROWSE_SERVER_MODE=1` env var. In dev mode, spawns `node --import tsx server.ts`.

## Node.js Gotchas

- **`child_process.spawn` + `detached` + `pipe` = parent hangs.** Node keeps the event loop alive for every open handle (stream, socket, timer). `proc.unref()` only unrefs the process, NOT its stdio streams. If you spawn a background server with `stdio: 'pipe'`, the parent will hang forever. Fix: use `stdio: 'ignore'` for streams you don't read, and call `proc.stderr.unref()` on any piped streams you keep.

## Conventions

- All selectors support both CSS selectors and @refs (`@e1`, `@e2`...)
- Read commands are safe to retry; write commands are NOT retried after transport failure
- Command sets are registry-derived — add new commands by registering in `src/automation/registry.ts`
- `SessionBuffers` class holds per-session buffers in `src/network/buffers.ts`
- `SessionBuffers` has O(1) running counters (`consoleErrorCount`, `networkPendingCount`) for action context
- Ring buffers cap at 50K entries (BUFFER_HIGH_WATER_MARK)
- Action context levels: `state` (page changes), `delta` (ARIA diff with refs), `full` (complete snapshot with refs)
- Context activation: `--context [state|delta|full]`, `X-Browse-Context: state|delta|full`, `browse set context off|state|delta|full`, MCP default `state`
- Context orchestration: `prepareWriteContext()` before write, `finalizeWriteContext()` after — wraps all snapshot work in try/catch
- Device emulation recreates the entire browser context (Playwright limitation)
- State files live in `.browse/` (auto-gitignored) or `/tmp` as fallback
- Port range: 9400-10400 (1001 ports for multi-process isolation)
- Domain filter uses `route.fallback()` for new sessions, `route.continue()` for initial setup
- Frame targeting is per-tab via `frame <selector>` / `frame main`
- PNG decode + pixel diff runs server-side (no external image deps)
