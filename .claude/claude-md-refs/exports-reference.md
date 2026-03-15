# Exports Reference — @ulpi/browse

## Source Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI client — HTTP wrapper talks to persistent server |
| `src/server.ts` | Persistent Chromium daemon (Bun.serve), session routing |
| `src/browser-manager.ts` | Browser lifecycle, tabs, refs, device emulation, frame targeting |
| `src/session-manager.ts` | Session multiplexing (Map<id, Session>) with domain filters |
| `src/buffers.ts` | SessionBuffers class + legacy global ring buffers (50K cap) |
| `src/snapshot.ts` | Accessibility tree snapshot with @ref selection |
| `src/constants.ts` | Default config values (ports, timeouts, buffer sizes) |
| `src/config.ts` | Project config loader (browse.json from project root) |
| `src/types.ts` | Shared TypeScript interfaces (CommandContext, CommandResult) |
| `src/auth-vault.ts` | AES-256-GCM encrypted credential storage + auto-login |
| `src/domain-filter.ts` | Domain allowlist (HTTP routes + WebSocket/EventSource/sendBeacon) |
| `src/har.ts` | HAR 1.2 export from network buffer entries |
| `src/png-compare.ts` | Self-contained PNG decoder + pixel comparator (no deps) |
| `src/policy.ts` | Action policy gate (allow/deny/confirm per command) |
| `src/sanitize.ts` | Path-safe name sanitization (strips separators, `..`) |
| `src/install-skill.ts` | Claude Code skill installer (copies SKILL.md, adds permissions) |
| `src/commands/read.ts` | 19 read commands (no side effects, per-session buffers) |
| `src/commands/write.ts` | 31 write commands (navigation, interaction, routing) |
| `src/commands/meta.ts` | 23 meta commands (tabs, screenshots, chain, auth, HAR) |
| `src/bun.d.ts` | Bun type declarations |
| `src/diff.d.ts` | diff module type declarations |

## Exported Functions

| Export | File | Type | Purpose |
|--------|------|------|---------|
| `resolveServerScript` | cli.ts | function | Find server.ts path (env, adjacent file, compiled) |
| `main` | cli.ts | async function | CLI entry point (parse args, ensure server, dispatch) |
| `SAFE_TO_RETRY` | cli.ts | Set\<string\> | Read-only commands safe for auto-retry |
| `handleReadCommand` | commands/read.ts | async function | Dispatch read commands to Playwright |
| `handleWriteCommand` | commands/write.ts | async function | Dispatch write commands to Playwright |
| `handleMetaCommand` | commands/meta.ts | async function | Dispatch meta commands (tabs, screenshot, auth, HAR) |
| `handleSnapshot` | snapshot.ts | async function | Build ARIA snapshot with @ref map |
| `parseSnapshotArgs` | snapshot.ts | function | Parse -i/-c/-C/-d/-s flags into options |
| `addConsoleEntry` | buffers.ts | function | Push to legacy global console ring buffer |
| `addNetworkEntry` | buffers.ts | function | Push to legacy global network ring buffer |
| `consoleBuffer` | buffers.ts | LogEntry[] | Legacy global console log ring buffer |
| `networkBuffer` | buffers.ts | NetworkEntry[] | Legacy global network log ring buffer |
| `consoleTotalAdded` | buffers.ts | number | Monotonic counter for flush cursor |
| `networkTotalAdded` | buffers.ts | number | Monotonic counter for flush cursor |
| `decodePNG` | png-compare.ts | function | Decode PNG buffer to RGBA pixels (8-bit RGB/RGBA) |
| `compareScreenshots` | png-compare.ts | function | Pixel-diff two PNG buffers, return mismatch percentage |
| `formatAsHar` | har.ts | function | Convert NetworkEntry[] to HAR 1.2 JSON |
| `sanitizeName` | sanitize.ts | function | Strip path separators and `..` from names |
| `loadConfig` | config.ts | function | Load browse.json from project root |
| `installSkill` | install-skill.ts | function | Copy SKILL.md + add permissions to .claude/settings.json |
| `resolveDevice` | browser-manager.ts | function | Resolve device name to descriptor (aliases, custom, built-in, fuzzy) |
| `listDevices` | browser-manager.ts | function | List available device names with optional filter |
| `DEFAULTS` | constants.ts | object | Port range, timeouts, buffer sizes |

## Exported Classes

| Class | File | Key Methods | Purpose |
|-------|------|-------------|---------|
| `BrowserManager` | browser-manager.ts | launch, launchWithBrowser, close, getPage, newTab, closeTab, switchTab, resolveRef, setRefMap, emulateDevice, setViewport, setExtraHeader, setDomainFilter, getFrameContext, setInitScript, getUserRoutes, getContext | Playwright browser lifecycle, tabs, refs, device emulation, frame targeting |
| `SessionManager` | session-manager.ts | getOrCreate, closeSession, closeIdleSessions, listSessions, getAllSessions, closeAll | Session multiplexing with domain filter setup |
| `SessionBuffers` | buffers.ts | addConsoleEntry, addNetworkEntry | Per-session console/network ring buffers with flush cursors |
| `DomainFilter` | domain-filter.ts | isAllowed, blockedMessage, generateInitScript | Domain allowlist for HTTP + WebSocket/EventSource/sendBeacon |
| `PolicyChecker` | policy.ts | check, isActive | Action policy gate with hot-reload on mtime change |
| `AuthVault` | auth-vault.ts | save, login, list, delete | AES-256-GCM encrypted credential storage + auto-login |

## Exported Types/Interfaces

| Type | File | Purpose |
|------|------|---------|
| `LogEntry` | buffers.ts | `{ timestamp, level, text }` |
| `NetworkEntry` | buffers.ts | `{ timestamp, method, url, status?, duration?, size? }` |
| `DeviceDescriptor` | browser-manager.ts | `{ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }` |
| `CommandContext` | types.ts | `{ manager, command, args }` |
| `CommandResult` | types.ts | `{ output, hint? }` |
| `HarRecording` | har.ts | `{ startTime, active }` |
| `DecodedImage` | png-compare.ts | `{ width, height, data: Buffer }` (RGBA pixels) |
| `CompareResult` | png-compare.ts | `{ totalPixels, diffPixels, mismatchPct, passed }` |
| `BrowseConfig` | config.ts | `{ session?, json?, contentBoundaries?, allowedDomains?, ... }` |
| `Session` | session-manager.ts | `{ id, manager, buffers, domainFilter, outputDir, lastActivity, createdAt }` |
| `CredentialInfo` | auth-vault.ts | `{ name, url, username, hasPassword, createdAt }` |
| `PolicyResult` | policy.ts | `'allow' \| 'deny' \| 'confirm'` |

## CLI Commands

### Read Commands (19) — no side effects

| Command | Args | Purpose |
|---------|------|---------|
| `text` | -- | Visible text via TreeWalker (no DOM mutation) |
| `html` | `[sel]` | Full HTML or element innerHTML |
| `links` | -- | All `<a href>` as `text -> href` |
| `forms` | -- | Form structure as JSON |
| `accessibility` | -- | Raw ARIA snapshot tree |
| `js` | `<expr>` | Evaluate JS expression |
| `eval` | `<file>` | Evaluate JS file |
| `css` | `<sel> <prop>` | Get computed CSS property |
| `attrs` | `<sel>` | Get element attributes as JSON |
| `element-state` | `<sel>` | Element state (visible, enabled, checked, etc.) |
| `dialog` | -- | Last dialog info |
| `console` | `[--clear]` | Console log buffer |
| `network` | `[--clear]` | Network request buffer |
| `cookies` | -- | Browser cookies as JSON |
| `storage` | `[set <k> <v>]` | localStorage/sessionStorage |
| `perf` | -- | Navigation timing (dns, ttfb, load) |
| `devices` | `[filter]` | List available device names |
| `value` | `<sel>` | Get input/select element value |
| `count` | `<sel>` | Count elements matching selector |

### Write Commands (31) — navigation + interaction

| Command | Args | Purpose |
|---------|------|---------|
| `goto` | `<url>` | Navigate to URL |
| `back` | -- | Browser back |
| `forward` | -- | Browser forward |
| `reload` | -- | Reload page |
| `click` | `<sel>` | Click element |
| `dblclick` | `<sel>` | Double-click element |
| `fill` | `<sel> <val>` | Fill input field |
| `select` | `<sel> <val>` | Select dropdown option |
| `hover` | `<sel>` | Hover element |
| `focus` | `<sel>` | Focus element |
| `check` | `<sel>` | Check checkbox |
| `uncheck` | `<sel>` | Uncheck checkbox |
| `type` | `<text>` | Type text via keyboard |
| `press` | `<key>` | Press key (Enter, Tab, etc.) |
| `keydown` | `<key>` | Key down event |
| `keyup` | `<key>` | Key up event |
| `scroll` | `[sel\|up\|down]` | Scroll element into view or direction |
| `wait` | `<sel\|--url\|--network-idle>` | Wait for element/URL/network idle |
| `viewport` | `<WxH>` | Set viewport size |
| `cookie` | `<n>=<v>` | Set cookie |
| `header` | `<n>:<v>` | Set extra HTTP header |
| `useragent` | `<str>` | Set user agent (recreates context) |
| `upload` | `<sel> <files...>` | Upload files to input |
| `dialog-accept` | `[text]` | Accept next dialog (optional prompt text) |
| `dialog-dismiss` | -- | Dismiss next dialog |
| `emulate` | `<device>\|reset` | Emulate device or reset to desktop |
| `drag` | `<src> <tgt>` | Drag from source to target selector |
| `highlight` | `<sel>` | Highlight element with visual overlay |
| `download` | `<sel> [path]` | Download file triggered by click |
| `route` | `<pattern> block\|fulfill` | Intercept network requests |
| `offline` | `[on\|off]` | Toggle offline mode |

### Meta Commands (23) — tabs, server, visual, chain, auth, HAR

| Command | Args | Purpose |
|---------|------|---------|
| `tabs` | -- | List all tabs with titles |
| `tab` | `<id>` | Switch to tab |
| `newtab` | `[url]` | Open new tab |
| `closetab` | `[id]` | Close tab |
| `status` | -- | Server health report |
| `url` | -- | Current page URL |
| `stop` | -- | Stop server |
| `restart` | -- | Restart server |
| `screenshot` | `[path]` | Full-page screenshot |
| `pdf` | `[path]` | Save page as PDF |
| `responsive` | `[prefix]` | Mobile/tablet/desktop screenshots |
| `chain` | (stdin JSON) | Execute command sequence |
| `diff` | `<url1> <url2>` | Text diff between two pages |
| `snapshot` | `[-i] [-c] [-C] [-d N] [-s sel]` | Accessibility tree with @refs |
| `snapshot-diff` | -- | Diff current vs last snapshot |
| `screenshot-diff` | `<baseline> [current]` | Pixel-diff two screenshots |
| `sessions` | -- | List active sessions |
| `session-close` | `<id>` | Close a session |
| `frame` | `<sel>\|main` | Target iframe or return to main page |
| `state` | `save\|load\|list\|show [name]` | Save/restore page state (URL, cookies, storage) |
| `find` | `role\|text\|label\|placeholder\|testid <query>` | Find elements by role, text, label, etc. |
| `auth` | `save\|login\|list\|delete <args>` | Credential vault operations |
| `har` | `start\|stop [path]` | HAR recording (start/stop + export) |

## Constants (DEFAULTS)

| Constant | Value | Purpose |
|----------|-------|---------|
| `PORT_RANGE_START` | 9400 | Server port scan start |
| `PORT_RANGE_END` | 10400 | Server port scan end |
| `IDLE_TIMEOUT_MS` | 1,800,000 (30m) | Auto-shutdown idle timeout |
| `COMMAND_TIMEOUT_MS` | 15,000 | Navigation timeout |
| `ACTION_TIMEOUT_MS` | 5,000 | Click/fill timeout |
| `HEALTH_CHECK_TIMEOUT_MS` | 2,000 | Health check timeout |
| `BUFFER_HIGH_WATER_MARK` | 50,000 | Ring buffer max entries |
| `BUFFER_FLUSH_INTERVAL_MS` | 1,000 | Disk flush interval |
| `NETWORK_SETTLE_MS` | 5,000 | Wait for pending responses before flush |
| `LOCK_STALE_THRESHOLD_MS` | 15,000 | Lock file considered stale |

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

## Import Patterns

```typescript
import { BrowserManager, resolveDevice, listDevices } from './browser-manager';
import { SessionManager } from './session-manager';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { handleSnapshot, parseSnapshotArgs } from './snapshot';
import { SessionBuffers, consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry } from './buffers';
import { DomainFilter } from './domain-filter';
import { PolicyChecker } from './policy';
import { AuthVault } from './auth-vault';
import { decodePNG, compareScreenshots } from './png-compare';
import { formatAsHar } from './har';
import { sanitizeName } from './sanitize';
import { loadConfig } from './config';
import { DEFAULTS } from './constants';
```
