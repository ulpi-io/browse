# Contributing to @ulpi/browse

## Prerequisites

- Node.js >= 18.0
- npm (comes with Node.js)
- Git

Optional but recommended:
- [Bun](https://bun.sh) — browse auto-detects it for ~2x faster command execution

## Setup

```bash
git clone https://github.com/ulpi-io/browse
cd browse
npm install
npx playwright install chromium
```

Verify everything works:

```bash
npm test
npm run build
```

## Architecture Overview

Before contributing, understand how the pieces fit together:

```
CLI (src/cli.ts)  →  HTTP POST  →  Server (src/server.ts)  →  SessionManager  →  BrowserManager  →  Chromium
```

- **CLI** is a thin HTTP client. It auto-starts the server on first command.
- **Server** is a persistent daemon that manages Chromium via Playwright. It shuts down after 30 min idle.
- **SessionManager** handles multi-agent isolation — each `--session` gets its own BrowserContext, tabs, cookies, and buffers.
- **BrowserManager** wraps Playwright: browser/context/page lifecycle, tab management, @ref map, device emulation, frame targeting.

State file: `.browse/browse-server.json` (pid, port, token). The CLI reads this to connect. If the server is dead, the CLI spawns a new one.

Commands are split into three categories:

| Category | File | Side effects? | Safe to retry? |
|----------|------|---------------|----------------|
| Read | `src/commands/read.ts` | No | Yes |
| Write | `src/commands/write.ts` | Yes (navigation, clicks, form fills) | No |
| Meta | `src/commands/meta.ts` | Varies (tabs, screenshots, auth) | Varies |

## Development Workflow

### Running in dev mode

```bash
npx tsx src/cli.ts goto https://example.com
npx tsx src/cli.ts text
npx tsx src/cli.ts snapshot -i
npx tsx src/cli.ts click @e1
```

With sessions:

```bash
npx tsx src/cli.ts --session agent1 goto https://example.com
npx tsx src/cli.ts --session agent1 text
```

### Running tests

```bash
npm test                               # All tests (vitest)
npm test -- test/commands              # Command tests only
npm test -- test/snapshot              # Snapshot tests
npm test -- test/sessions             # Session multiplexing tests
npm test -- test/features             # Policy, auth, HAR, domain filter
npm test -- test/interactions         # Click, fill, select, etc.
```

Tests run against a real Chromium browser — no mocking. Each test file starts a local HTTP server serving fixtures from `test/fixtures/` and launches a real `BrowserManager`.

### Building

```bash
npm run build
```

Always use `npm run build`. The build uses esbuild with `--external` flags for Playwright optional deps. Running esbuild directly will produce a broken bundle.

## Adding a New Command

### 1. Pick a category

- **Read** — extracts data, no side effects, safe to retry. Examples: `text`, `html`, `links`, `cookies`.
- **Write** — navigates or interacts with the page, NOT safe to retry. Examples: `goto`, `click`, `fill`.
- **Meta** — server management, visual output, sessions. Examples: `tabs`, `screenshot`, `chain`.

### 2. Register the command

Add the command name to the correct set in `src/server.ts`:

```typescript
const READ_COMMANDS = new Set([..., 'your-command']);
// or WRITE_COMMANDS or META_COMMANDS
```

### 3. Implement the handler

Add a `case` to the switch in the appropriate command file:

```typescript
case 'your-command': {
  const page = bm.getPage();
  const result = await page.evaluate(() => {
    // Your Playwright logic here
  });
  return result;
}
```

### 4. Support @ref selectors

Any command that accepts a CSS selector **must** support @refs:

```typescript
const selector = args[0];
if (!selector) throw new Error('Usage: browse your-command <selector>');
const resolved = bm.resolveRef(selector);
if ('locator' in resolved) {
  // @ref — use the Playwright Locator directly
  const result = await resolved.locator.someMethod();
} else {
  // CSS selector — use page methods
  const result = await page.someMethod(resolved.selector);
}
```

### 5. Register everywhere else

- **`src/cli.ts`** — add help text in the help string
- **`SAFE_TO_RETRY`** in `src/cli.ts` — add if the command is read-only
- **`chain` command sets** in `src/commands/meta.ts` — these must stay in sync with `server.ts`

### 6. Write tests

Add tests in the appropriate test file. Pattern:

```typescript
test('your-command returns expected output', async () => {
  await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
  const result = await handleReadCommand('your-command', [], bm);
  expect(result).toContain('expected');
});
```

If your test needs custom HTML, add a fixture in `test/fixtures/` and register it in `test/test-server.ts`.

## Session Awareness

If your change involves state (buffers, cookies, storage, refs), make sure it's per-session:

- Use `SessionBuffers` for console/network data, not the legacy global buffers
- BrowserManager instances are per-session — don't introduce shared mutable state
- Test with `--session` to verify isolation: two sessions navigating different pages should not interfere

## Error Handling

- **Server errors** return JSON `{ error: string, hint?: string }` with HTTP 400/403/500
- **Playwright errors** are rewritten into actionable messages (e.g., "run `snapshot -i` to find exact refs")
- **Transport errors** (ECONNREFUSED, ECONNRESET): CLI auto-retries read commands after server restart, but fails write commands immediately to avoid double-submission

Don't swallow errors. If something fails, return a clear message that tells the user what to do next.

## Code Principles

- **No shortcuts.** When you find a bug, stop and fix it. Don't patch around it.
- **No unnecessary abstractions.** Three similar lines are better than a premature helper function.
- **Automagic for users.** Zombie servers, port conflicts, stale state — all handled automatically. If a user needs `pkill` or `rm` before using the tool, that's a bug.
- **TypeScript strict mode.** No `any` unless absolutely necessary.
- **Tests use real browsers.** No mocking Playwright. If a test is hard to write without mocks, the code needs restructuring.

## Pull Requests

### Before submitting

1. `npm test` passes
2. `npm run build` succeeds
3. `npx tsc --noEmit` has no errors
4. You've tested manually with `npx tsx src/cli.ts`

### PR guidelines

- One logical change per PR
- Include tests for new commands and bug fixes
- No breaking changes without discussion first — open an issue to discuss
- Write a clear description of what and why, not just what files changed

### What we look for in review

- Does it handle @ref selectors correctly?
- Does it work with `--session` isolation?
- Are error messages actionable?
- Is it registered in all the right places (server.ts, cli.ts, chain)?
- Does it follow existing patterns in the codebase?

## Environment Variables

If your feature needs configuration, check if an existing env var covers it before adding a new one. Current variables are documented in the [development guide](.claude/claude-md-refs/development-guide.md). New env vars should:

- Start with `BROWSE_` prefix
- Have a sensible default (the tool should work without any env vars)
- Be documented in the README and development guide

## Questions?

Open an issue. If you're unsure whether something is a bug or a feature request, use the bug report template — we'll re-label if needed.
