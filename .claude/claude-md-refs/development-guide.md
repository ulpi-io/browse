# Development Guide — @ulpi/browse

## Adding a New CLI Command

### Step 1: Decide the command category

- **Read** (no side effects): goes in `src/commands/read.ts`
- **Write** (navigation/interaction): goes in `src/commands/write.ts`
- **Meta** (tabs, server, visual): goes in `src/commands/meta.ts`

### Step 2: Register the command in `src/server.ts`

Add the command name to the appropriate set:

```typescript
// src/server.ts
const READ_COMMANDS = new Set([
  'text', 'html', /* ... */ 'your-new-command',
]);
// or WRITE_COMMANDS or META_COMMANDS
```

### Step 3: Implement the handler

Add a case to the switch in the appropriate command file:

```typescript
// src/commands/read.ts — example read command
case 'your-command': {
  const page = bm.getPage();
  // Use bm.resolveRef(selector) for @ref support:
  // const resolved = bm.resolveRef(args[0]);
  // if ('locator' in resolved) { ... } else { ... }
  const result = await page.evaluate(() => { /* ... */ });
  return result;
}
```

### Step 4: Update CLI help text

Add the command to the help string in `src/cli.ts`:

```typescript
// src/cli.ts — main() help text
console.log(`browse — Fast headless browser for AI coding agents
...
YourCategory:   your-command [args]
...`);
```

### Step 5: Add to retry safety set (if read-only)

If the command is safe to retry after server restart:

```typescript
// src/cli.ts
export const SAFE_TO_RETRY = new Set([
  /* ... */ 'your-command',
]);
```

### Step 6: Register in chain command (if needed)

The chain command in `src/commands/meta.ts` duplicates the command sets:

```typescript
const READ_SET = new Set([/* ... */ 'your-command']);
```

### Step 7: Write tests

Add test cases in `test/commands.test.ts`:

```typescript
describe('YourCommand', () => {
  test('returns expected output', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('your-command', [], bm);
    expect(result).toContain('expected');
  });
});
```

If the test needs custom HTML, add a fixture in `test/fixtures/` and register it in `test/test-server.ts`.

## Supporting @ref Selectors

Any command that accepts a CSS selector MUST support @ref resolution:

```typescript
const selector = args[0];
if (!selector) throw new Error('Usage: browse your-command <selector>');
const resolved = bm.resolveRef(selector);
if ('locator' in resolved) {
  // @ref path — use Playwright Locator
  const result = await resolved.locator.someMethod();
} else {
  // CSS selector path
  const result = await page.someMethod(resolved.selector);
}
```

## Adding a New Device for Emulation

Add to `DEVICE_ALIASES` (shorthand) or `CUSTOM_DEVICES` (full descriptor) in `src/browser-manager.ts`:

```typescript
// Alias (maps to Playwright built-in or custom device name)
const DEVICE_ALIASES: Record<string, string> = {
  'my-device': 'Actual Device Name',
};

// Custom device (not in Playwright's built-in list)
const CUSTOM_DEVICES: Record<string, DeviceDescriptor> = {
  'My Custom Device': {
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 ...',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};
```

## Security Features

### Action Policy

Gate commands via `browse-policy.json` (project root) or `BROWSE_POLICY` env var:

```json
{ "default": "allow", "deny": ["js", "eval"], "confirm": ["goto"] }
```

Precedence: deny > confirm > allow whitelist > default. Hot-reloads on file change.

### Credential Vault

Encrypted credential storage in `.browse/auth/`:
- AES-256-GCM encryption with key from `BROWSE_ENCRYPTION_KEY` or auto-generated `.browse/.encryption-key`
- Passwords never returned in list/get responses
- Auto-detect login form selectors or specify explicitly

### Domain Filter

Block navigation and sub-resource requests outside an allowlist:
- HTTP requests blocked via `context.route('**/*')`
- WebSocket, EventSource, sendBeacon blocked via `context.addInitScript()`
- Supports exact (`example.com`) and wildcard (`*.example.com`) patterns
- Set via `--allowed-domains` flag, `BROWSE_ALLOWED_DOMAINS` env var, or `browse.json` config

### Path Sanitization

`sanitizeName()` strips path separators and `..` from user-supplied names used in file paths (session IDs, credential names).

## Testing

```bash
bun test                       # Run all tests
bun test test/commands         # Run command tests only
bun test test/snapshot         # Run snapshot tests only
bun test test/features         # Run feature tests (policy, auth, HAR)
bun test test/interactions     # Run interaction tests
```

Tests use a local HTTP test server (`test/test-server.ts`) serving HTML fixtures from `test/fixtures/`. A real `BrowserManager` is instantiated — no mocking.

### Test Structure

```typescript
// test/commands.test.ts pattern
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);  // port 0 = auto-assign
  baseUrl = testServer.url;
  bm = new BrowserManager();
  await bm.launch();
});

afterAll(async () => {
  testServer.server.stop();
  await bm.close();
});
```

## Build

```bash
bun run build                  # Standalone binary (uses --external electron --external chromium-bidi)
bun run src/cli.ts             # Dev mode (via bun)
bun run src/server.ts          # Start server directly
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BROWSE_PORT` | auto (9400-10400) | Fixed server port |
| `BROWSE_PORT_START` | 9400 | Start of port scan range |
| `BROWSE_INSTANCE` | auto (PPID in dev) | Instance identifier for multi-process isolation |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log/screenshot directory |
| `BROWSE_STATE_FILE` | `<LOCAL_DIR>/browse-server.json` | Server state file path |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle auto-shutdown (ms) |
| `BROWSE_TIMEOUT` | 0 (use defaults) | Override both navigation and action timeouts |
| `BROWSE_CDP_URL` | -- | Connect to remote Chrome via CDP |
| `BROWSE_PROXY` | -- | HTTP proxy server |
| `BROWSE_PROXY_BYPASS` | -- | Proxy bypass patterns |
| `BROWSE_SERVER_SCRIPT` | auto-detected | Override path to server.ts |
| `BROWSE_SESSION` | -- | Default session ID |
| `BROWSE_JSON` | 0 | Wrap output as `{success, data, command}` |
| `BROWSE_CONTENT_BOUNDARIES` | 0 | Wrap page content in nonce-delimited markers |
| `BROWSE_ALLOWED_DOMAINS` | -- | Comma-separated domain allowlist |
| `BROWSE_ENCRYPTION_KEY` | auto-generated | 64-char hex key for credential vault |
| `BROWSE_POLICY` | browse-policy.json | Path to action policy file |
| `BROWSE_CONFIRM_ACTIONS` | -- | Comma-separated commands requiring confirmation |
| `BROWSE_AUTH_PASSWORD` | -- | Password for auth save (alternative to --password-stdin) |
| `__BROWSE_SERVER_MODE` | -- | Internal: compiled binary self-spawns in server mode |

## Error Handling Patterns

**Server errors** return JSON `{ error: string, hint?: string }` with HTTP 400/403/500.

**Policy errors** return HTTP 403 with error and hint suggesting policy file update.

**CLI transport errors** (ECONNREFUSED, ECONNRESET):
- Read-only commands: auto-retry after server restart
- Write commands: fail with clear message (avoid side-effect duplication)
- After restart, read commands fail if page state was lost (blank page)

**AI-friendly error rewriting**: Playwright errors (strict mode violation, timeout, etc.) are rewritten into actionable messages suggesting next steps (e.g., "run 'snapshot -i' to find exact refs").

**Chromium crashes**: server exits immediately, CLI detects and restarts on next command.
