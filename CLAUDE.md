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

- **Runtime:** Bun (>=1.0)
- **Browser:** Playwright + Chromium (headless)
- **Language:** TypeScript (ESNext, strict, bundler resolution)
- **Tests:** `bun:test` (integration tests against real browser)
- **Build:** `bun build --compile --external electron --external chromium-bidi` → standalone binary

## Project Structure

```
bin/browse.ts              Entry point (shebang)
src/cli.ts                 CLI client (HTTP wrapper, --session flag)
src/server.ts              Persistent server daemon (session-aware)
src/session-manager.ts     Session multiplexing (Map<id, Session>)
src/browser-manager.ts     Playwright browser lifecycle (shared or owned)
src/buffers.ts             SessionBuffers class + legacy global buffers
src/snapshot.ts            ARIA snapshot with @ref system
src/constants.ts           Default config values
src/types.ts               Shared TypeScript interfaces
src/commands/read.ts       16 read commands (per-session buffers)
src/commands/write.ts      18 write commands (navigation/interaction)
src/commands/meta.ts       14 meta commands (tabs, visual, chain, sessions)
test/commands.test.ts      Integration tests
test/snapshot.test.ts      Snapshot-specific tests
test/sessions.test.ts      Session multiplexing isolation tests
test/session-e2e.test.ts   E2E CLI session tests
test/test-server.ts        Local HTTP fixture server
test/fixtures/             HTML test fixtures
```

## Key Commands

```bash
bun test                                              # Run tests
bun run src/cli.ts <command> [args]                   # Dev mode
bun run src/cli.ts --session <id> <command> [args]    # Dev mode with session
bun run build                                         # Build binary (uses --external flags)
```

## Architecture Summary

```
CLI [--session <id>] → Server (Bun.serve) → SessionManager → BrowserManager(s) → Chromium
```

- Server auto-starts on first command, shuts down when all sessions idle (30 min)
- Session multiplexing: multiple agents share one Chromium via `--session` flag
- Each session: own BrowserContext, tabs, @refs, console/network buffers, cookies
- Without `--session`: uses `"default"` session (backward compatible)
- State file: `.browse/browse-server.json` (pid, port, token)
- Crash recovery: CLI detects dead server → auto-restart
- `BrowserManager.launch()` = own Chromium (multi-process mode)
- `BrowserManager.launchWithBrowser(browser)` = shared Chromium (session mode)

## Command Categories

- **Read** (18): `text`, `html`, `links`, `forms`, `accessibility`, `js`, `eval`, `css`, `attrs`, `element-state`, `dialog`, `console`, `network`, `cookies`, `storage`, `perf`, `value`, `count`, `devices`
- **Write** (27): `goto`, `back`, `forward`, `reload`, `click`, `dblclick`, `fill`, `select`, `hover`, `focus`, `check`, `uncheck`, `type`, `press`, `keydown`, `keyup`, `scroll`, `wait`, `viewport`, `cookie`, `header`, `useragent`, `upload`, `emulate`, `drag`, `highlight`, `download`, `route`, `offline`, `dialog-accept`, `dialog-dismiss`
- **Meta** (18): `tabs`, `tab`, `newtab`, `closetab`, `status`, `url`, `stop`, `restart`, `screenshot`, `pdf`, `responsive`, `chain`, `diff`, `snapshot`, `snapshot-diff`, `sessions`, `session-close`, `frame`, `state`, `auth`, `har`

## Development Rules

- **No shortcuts.** When you find a bug, stop and fix it. Don't patch around it, don't defer it.
- **No fake reviews.** Find real bugs or say it's clean. Never list non-issues as findings.
- **Automagic for customers.** The tool must self-heal. Zombie servers, port conflicts, stale state — all handled automatically. If you need `pkill` or `rm` before testing, that's a bug.
- **Build command:** Always `bun run build` (uses `--external electron --external chromium-bidi`). These are playwright optional deps we never use.
- **Compiled binary:** Self-spawns in server mode via `__BROWSE_SERVER_MODE=1` env var. In dev mode, spawns `bun run server.ts`.

## Conventions

- All selectors support both CSS selectors and @refs (`@e1`, `@e2`...)
- Read commands are safe to retry; write commands are NOT retried after transport failure
- The `chain` command duplicates command sets — keep in sync with server.ts
- `SessionBuffers` class holds per-session buffers; legacy global exports in buffers.ts for backward compat
- Ring buffers cap at 50K entries (BUFFER_HIGH_WATER_MARK)
- Device emulation recreates the entire browser context (Playwright limitation)
- State files live in `.browse/` (auto-gitignored) or `/tmp` as fallback
- Port range: 9400-10400 (1001 ports for multi-process isolation)
