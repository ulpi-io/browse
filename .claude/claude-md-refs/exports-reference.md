# Exports Reference — @ulpi/browse

## Source Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI client — HTTP wrapper talks to persistent server |
| `src/server.ts` | Persistent Chromium daemon (Bun.serve) |
| `src/browser-manager.ts` | Browser lifecycle, tabs, refs, device emulation |
| `src/buffers.ts` | Console/network ring buffers (50K cap) |
| `src/snapshot.ts` | Accessibility tree snapshot with @ref selection |
| `src/constants.ts` | Default config values |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/commands/read.ts` | Read commands (no side effects) |
| `src/commands/write.ts` | Write commands (navigation + interaction) |
| `src/commands/meta.ts` | Meta commands (tabs, screenshots, chain, diff) |

## Exported Functions

| Export | File | Type | Purpose |
|--------|------|------|---------|
| `resolveServerScript` | cli.ts | function | Find server.ts path (env, adjacent file) |
| `SAFE_TO_RETRY` | cli.ts | Set\<string\> | Read-only commands safe for auto-retry |
| `handleReadCommand` | commands/read.ts | async function | Dispatch read commands to Playwright |
| `handleWriteCommand` | commands/write.ts | async function | Dispatch write commands to Playwright |
| `handleMetaCommand` | commands/meta.ts | async function | Dispatch meta commands (tabs, screenshot, chain) |
| `handleSnapshot` | snapshot.ts | async function | Build ARIA snapshot with @ref map |
| `parseSnapshotArgs` | snapshot.ts | function | Parse -i/-c/-C/-d/-s flags into options |
| `addConsoleEntry` | buffers.ts | function | Push to console ring buffer |
| `addNetworkEntry` | buffers.ts | function | Push to network ring buffer |
| `consoleTotalAdded` | buffers.ts | number | Monotonic counter for flush cursor |
| `networkTotalAdded` | buffers.ts | number | Monotonic counter for flush cursor |
| `consoleBuffer` | buffers.ts | LogEntry[] | In-memory console log ring buffer |
| `networkBuffer` | buffers.ts | NetworkEntry[] | In-memory network log ring buffer |
| `DEFAULTS` | constants.ts | object | Port range, timeouts, buffer sizes |

## Exported Classes

| Class | File | Key Methods | Purpose |
|-------|------|-------------|---------|
| `BrowserManager` | browser-manager.ts | launch, close, getPage, newTab, closeTab, switchTab, resolveRef, setRefMap, emulateDevice, setViewport, setExtraHeader | Manages Playwright browser lifecycle, tabs, refs, device emulation |

## Exported Types/Interfaces

| Type | File | Purpose |
|------|------|---------|
| `LogEntry` | buffers.ts | `{ timestamp, level, text }` |
| `NetworkEntry` | buffers.ts | `{ timestamp, method, url, status?, duration?, size? }` |
| `DeviceDescriptor` | browser-manager.ts | `{ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }` |
| `CommandContext` | types.ts | `{ manager, command, args }` |
| `CommandResult` | types.ts | `{ output, hint? }` |

## CLI Commands

### Read Commands (16) — no side effects

| Command | Args | Purpose |
|---------|------|---------|
| `text` | — | Visible text via TreeWalker (no DOM mutation) |
| `html` | `[sel]` | Full HTML or element innerHTML |
| `links` | — | All `<a href>` as `text → href` |
| `forms` | — | Form structure as JSON |
| `accessibility` | — | Raw ARIA snapshot tree |
| `js` | `<expr>` | Evaluate JS expression |
| `eval` | `<file>` | Evaluate JS file |
| `css` | `<sel> <prop>` | Get computed CSS property |
| `attrs` | `<sel>` | Get element attributes as JSON |
| `state` | `<sel>` | Element state (visible, enabled, checked, etc.) |
| `dialog` | — | Last dialog info |
| `console` | `[--clear]` | Console log buffer |
| `network` | `[--clear]` | Network request buffer |
| `cookies` | — | Browser cookies as JSON |
| `storage` | `[set <k> <v>]` | localStorage/sessionStorage |
| `perf` | — | Navigation timing (dns, ttfb, load) |
| `devices` | `[filter]` | List available device names |

### Write Commands (18) — navigation + interaction

| Command | Args | Purpose |
|---------|------|---------|
| `goto` | `<url>` | Navigate to URL |
| `back` | — | Browser back |
| `forward` | — | Browser forward |
| `reload` | — | Reload page |
| `click` | `<sel>` | Click element |
| `fill` | `<sel> <val>` | Fill input field |
| `select` | `<sel> <val>` | Select dropdown option |
| `hover` | `<sel>` | Hover element |
| `type` | `<text>` | Type text via keyboard |
| `press` | `<key>` | Press key (Enter, Tab, etc.) |
| `scroll` | `[sel]` | Scroll element into view or to bottom |
| `wait` | `<sel>` | Wait for element to appear |
| `viewport` | `<WxH>` | Set viewport size |
| `cookie` | `<n>=<v>` | Set cookie |
| `header` | `<n>:<v>` | Set extra HTTP header |
| `useragent` | `<str>` | Set user agent (recreates context) |
| `upload` | `<sel> <files...>` | Upload files to input |
| `emulate` | `<device>\|reset` | Emulate device or reset to desktop |

### Meta Commands (12) — tabs, server, visual, chain

| Command | Args | Purpose |
|---------|------|---------|
| `tabs` | — | List all tabs with titles |
| `tab` | `<id>` | Switch to tab |
| `newtab` | `[url]` | Open new tab |
| `closetab` | `[id]` | Close tab |
| `status` | — | Server health report |
| `url` | — | Current page URL |
| `stop` | — | Stop server |
| `restart` | — | Restart server |
| `screenshot` | `[path] [--annotate]` | Full-page screenshot |
| `pdf` | `[path]` | Save page as PDF |
| `responsive` | `[prefix]` | Mobile/tablet/desktop screenshots |
| `chain` | (stdin JSON) | Execute command sequence |
| `diff` | `<url1> <url2>` | Text diff between two pages |
| `snapshot` | `[-i] [-c] [-C] [-d N] [-s sel]` | Accessibility tree with @refs |
| `snapshot-diff` | — | Diff current vs last snapshot |

## Constants (DEFAULTS)

| Constant | Value | Purpose |
|----------|-------|---------|
| `PORT_RANGE_START` | 9400 | Server port scan start |
| `PORT_RANGE_END` | 9410 | Server port scan end |
| `IDLE_TIMEOUT_MS` | 1,800,000 (30m) | Auto-shutdown idle timeout |
| `COMMAND_TIMEOUT_MS` | 15,000 | Navigation timeout |
| `ACTION_TIMEOUT_MS` | 5,000 | Click/fill timeout |
| `HEALTH_CHECK_TIMEOUT_MS` | 2,000 | Health check timeout |
| `BUFFER_HIGH_WATER_MARK` | 50,000 | Ring buffer max entries |
| `BUFFER_FLUSH_INTERVAL_MS` | 1,000 | Disk flush interval |
| `NETWORK_SETTLE_MS` | 5,000 | Wait for pending responses before flush |
| `LOCK_STALE_THRESHOLD_MS` | 15,000 | Lock file considered stale |

## Import Patterns

```typescript
import { BrowserManager, resolveDevice, listDevices } from './browser-manager';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { handleSnapshot, parseSnapshotArgs } from './snapshot';
import { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry } from './buffers';
import { DEFAULTS } from './constants';
```
