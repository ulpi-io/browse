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

## Testing

```bash
bun test                   # Run all tests
bun test test/commands     # Run command tests only
bun test test/snapshot     # Run snapshot tests only
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
bun build --compile src/cli.ts --outfile dist/browse  # Standalone binary
bun run src/cli.ts                                     # Dev mode (via bun)
bun run src/server.ts                                  # Start server directly
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `BROWSE_PORT` | auto (9400-9410) | Fixed server port |
| `BROWSE_PORT_START` | 9400 | Start of port scan range |
| `BROWSE_IDLE_TIMEOUT` | 1800000 (30m) | Idle auto-shutdown (ms) |
| `BROWSE_LOCAL_DIR` | `.browse/` or `/tmp` | State/log/screenshot directory |
| `BROWSE_STATE_FILE` | `<LOCAL_DIR>/browse-server.json` | Server state file path |
| `BROWSE_SERVER_SCRIPT` | auto-detected | Override path to server.ts |

## Error Handling Patterns

**Server errors** return JSON `{ error: string, hint?: string }` with HTTP 400/500.

**CLI transport errors** (ECONNREFUSED, ECONNRESET):
- Read-only commands: auto-retry after server restart
- Write commands: fail with clear message (avoid side-effect duplication)
- After restart, read commands fail if page state was lost (blank page)

**Chromium crashes**: server exits immediately, CLI detects and restarts on next command.
