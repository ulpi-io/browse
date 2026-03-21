# Feature Comparison: browse vs gstack vs agent-browser vs browser-use

> Generated: 2026-03-21
> State: auth-persistence shipped (v0.9.0)

Legend: **YES** = shipped, **BLOCKED** = code ready but blocked by external bug, **—** = not available

## Architecture

| | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Language | TypeScript/Bun | TypeScript/Bun | Rust | Python |
| Browser engine | Playwright | Playwright | Direct CDP | Playwright |
| Daemon IPC | HTTP | HTTP | Unix socket | Unix socket |
| Command latency | ~100-200ms | ~100-200ms | ~50ms | ~50ms |
| Binary | Bun --compile (~58MB) | Bun --compile (~58MB) | Native Rust | Python package |
| Windows | — | — | YES | YES |

## Navigation & Core Interaction

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| goto/back/forward/reload | YES | YES | YES | YES |
| click | YES | YES | YES | YES |
| dblclick | YES | — | YES | YES |
| rightclick | — | — | — | YES |
| fill | YES | YES | YES | YES (`input`) |
| select | YES | YES | YES | YES |
| hover | YES | YES | YES | YES |
| focus | YES | — | YES | — |
| check/uncheck | YES | — | YES | — |
| type (keyboard) | YES | YES | YES | YES |
| press (key) | YES | YES | YES | YES (`keys`) |
| keydown/keyup | YES | — | YES | — |
| keyboard insertText | — | — | YES | — |
| scroll | YES | YES | YES | YES |
| scrollIntoView | — | — | YES | — |
| drag | YES | — | YES | — |
| upload | YES | YES | YES | YES |
| download | YES | — | YES | — |
| highlight | YES | — | YES | — |
| mouse move/down/up/wheel | — | — | YES | — |
| tap/swipe (mobile) | — | — | YES | — |

## Content Extraction

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| text (visible) | YES | YES | YES (`get text`) | — |
| html | YES | YES | YES (`get html`) | YES (`get html`) |
| links | YES | YES | — | — |
| forms | YES | YES | — | — |
| accessibility tree | YES | YES | — | — |
| value (input) | YES | — | YES (`get value`) | YES (`get value`) |
| count (elements) | YES | — | YES (`get count`) | — |
| attrs (element) | YES | YES (`attrs`) | — | YES (`get attributes`) |
| css (computed style) | YES | YES | YES (`get styles`) | — |
| element-state | YES | YES (`is`) | YES (`is visible/enabled/checked`) | — |
| bounding box | — | — | YES (`get box`) | YES (`get bbox`) |
| clipboard | YES | — | YES | — |
| page title | via js | via js | YES (`get title`) | YES (`get title`) |

## Snapshot & Refs

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| ARIA snapshot with @refs | YES | YES | YES | — |
| `-i` interactive only | YES (terse flat) | YES | YES | — |
| `-f` full tree (with -i) | YES | — | — | — |
| `-V` viewport filter | YES | — | — | — |
| `-c` compact | YES | YES | YES | — |
| `-C` cursor-interactive | YES | YES (`@c` refs) | YES | — |
| `-d` depth limit | YES | YES | YES | — |
| `-s` scope to selector | YES | YES | YES | — |
| Snapshot diff | YES | YES (`-D` flag) | YES (`diff snapshot`) | — |
| Annotated screenshot | YES | YES (`-a` flag) | YES (`--annotate`) | — |
| Ref staleness detection | — | YES (count check) | — | — |
| Numeric index refs | — (uses `@e5`) | — | — | YES (`click 5`) |

## Find / Semantic Locators

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| find by role | YES | — | YES | — |
| find by text | YES | — | YES | — |
| find by label | YES | — | YES | — |
| find by placeholder | YES | — | YES | — |
| find by testid | YES | — | YES | — |
| find by alt | — | — | YES | — |
| find by title | — | — | YES | — |
| find first/last/nth | — | — | YES | — |

## Tabs & Frames

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| List tabs | YES | YES | YES | — |
| Switch tab | YES | YES | YES | YES (`switch`) |
| New tab | YES | YES | YES | — |
| Close tab | YES | YES | YES | YES |
| New window | — | — | YES | — |
| Frame targeting | YES | — | YES | — |

## Wait

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Wait for element | YES | YES | YES | YES |
| Wait for URL | YES | — | YES | — |
| Wait for network idle | YES | — | YES | — |
| Wait for text | — | — | YES | YES |
| Wait for JS condition | — | — | YES (`--fn`) | — |
| Wait for load state | — | — | YES (`--load`) | — |
| Wait for download | — | — | YES (`--download`) | — |
| Wait element hidden | — | — | YES (`--state hidden`) | YES (`--state hidden`) |
| Wait milliseconds | — | — | YES | — |

## Visual & Compare

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Screenshot | YES | YES | YES | YES |
| Screenshot viewport (default) | YES (default) | — | YES (default) | YES (default) |
| Screenshot full page | YES (`--full`) | YES (default) | YES (`--full`) | YES (`--full`) |
| Screenshot element/ref | — | YES | — | — |
| Screenshot clip region | — | YES (`--clip x,y,w,h`) | — | — |
| PDF | YES | — | YES | — |
| Responsive (multi-viewport) | YES | YES | — | — |
| Diff two URLs (text) | YES | YES | YES (`diff url`) | — |
| Screenshot diff (pixel) | YES | YES | YES (`diff screenshot`) | — |

## Device Emulation

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Emulate device | YES | — | YES (`set device`) | — |
| List devices | YES | — | — | — |
| Reset to desktop | YES | — | — | — |
| Set viewport | YES | YES | YES (`set viewport`) | — |
| Set user agent | YES | YES | — | — |
| Set geolocation | — | — | YES (`set geo`) | — |
| Set color scheme | — | — | YES (`set media`) | — |

## JavaScript

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Eval expression | YES (`js`) | YES (`js`) | YES (`eval`) | YES (`eval`) |
| Eval file | YES (`eval`) | YES (`eval`) | YES (`eval -b`) | — |
| Async/await support | YES | YES | YES | YES |
| Python REPL (persistent) | — | — | — | YES |

## Network & Cookies

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Console buffer | YES | YES | YES | — |
| Network buffer | YES | YES | YES (`network requests`) | — |
| Page errors (dedicated) | — | — | YES (`errors`) | — |
| Cookies read | YES | YES | YES | YES |
| Cookie set | YES | — | YES | YES |
| Cookie clear | — | — | YES | YES |
| Cookie export/import file | — | — | — | YES |
| Storage read/write | YES | YES | YES | — |
| Route/intercept requests | YES | — | YES (`network route`) | — |
| Route mock response | YES | — | YES (`network route --body`) | — |
| Offline mode | YES | — | — | — |
| Set HTTP headers | YES | — | YES (`set headers`, `--headers`) | — |
| Set cookie with options | — | — | — | YES (domain/secure/expires) |

## Dialogs

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Dialog info | YES | YES | — | — |
| Dialog accept | YES | YES | YES | — |
| Dialog dismiss | YES | YES | YES | — |
| Dialog buffer/log | — | YES | — | — |

## Recording & Export

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| HAR recording | YES | — | YES (`network har`) | — |
| Video recording (WebM) | YES | — | — | — |
| Command recording | YES (`record`) | — | — | — |
| Export to Playwright script | YES | — | — | — |
| Export to Puppeteer script | YES | — | — | — |
| Export to JSON (replayable) | YES | — | — | — |
| Chrome DevTools trace | — | — | YES (`trace`) | — |
| CPU profiler | — | — | YES (`profiler`) | — |

## Auth & Session Persistence

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Credential vault (encrypted) | YES | — | YES | — |
| Auto-login with saved creds | YES | — | YES | — |
| Cookie import from real browser | YES | YES | YES (via `--auto-connect`) | YES (`--profile`) |
| Auto-persist named sessions | YES | — | YES (`--session-name`) | — |
| Encrypted state at rest | YES | — | YES | — |
| `--state <path>` load on launch | YES | — | YES | — |
| `--connect` auto-discover Chrome | BLOCKED (bun#9911) | — | YES | YES |
| `--cdp <port>` flag | BLOCKED (bun#9911) | — | YES | YES (`--cdp-url`) |
| State cleanup (`state clean`) | YES | — | YES (`state clean`) | — |
| Persistent profile (`--profile`) | — | — | YES | YES |
| Handoff to visible Chrome | — | YES | — | — |
| State save/load (manual) | YES | — | YES | — |

## Sessions & Isolation

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Session multiplexing (shared Chromium) | YES | — | — | — |
| Named sessions | YES (`--session`) | — | YES (`--session`) | YES (`--session`) |
| Per-project isolation | YES | YES | — | — |
| Multi-instance servers | YES (`BROWSE_PORT`) | YES (per-project) | per-session daemon | per-session daemon |
| Session list/close | YES | — | YES | YES |

## Security

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Domain allowlist (HTTP) | YES | — | YES | — |
| Domain allowlist (WS/SSE/beacon) | YES | — | — | — |
| Action policy (deny/confirm) | YES | — | YES | — |
| Content boundaries (nonce) | YES | — | YES | — |
| Output length limit | — | — | YES (`--max-output`) | — |
| Confirm interactive prompts | — | — | YES (`--confirm-interactive`) | — |

## Cloud Providers

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Browserless | — | — | YES | — |
| Browserbase | — | — | YES | — |
| Browser Use Cloud | — | — | YES | YES |
| Kernel | — | — | YES | — |
| Provider flag (`-p`) | — | — | YES | YES |
| Tunnels (expose localhost) | — | — | — | YES |

## iOS / Mobile

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| iOS Simulator (real Safari) | — | — | YES | — |
| Real device support (USB) | — | — | YES | — |
| Device list from Xcode | — | — | YES | — |

## Streaming / Live Preview

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| WebSocket viewport stream | — | — | YES | — |
| Human input relay (mouse/kb/touch) | — | — | YES | — |

## Developer Experience

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| `--headed` (visible browser) | YES | — | YES | YES |
| `--json` output mode | YES | — | YES | YES |
| Config file | YES (`browse.json`) | — | YES (`agent-browser.json`) | — |
| Install skill (Claude Code) | YES | YES (built-in) | YES (`npx skills add`) | YES (manual curl) |
| `install` / `doctor` | — | — | YES | YES |
| `upgrade` (self-update) | — | — | YES | — |
| AI-friendly error messages | YES | YES | YES | — |
| Batch/chain execution | YES (`chain`) | YES (`chain`) | YES (`batch`) | — |
| Runtime abstraction | YES (playwright/rebrowser/lightpanda) | — | YES (chrome/lightpanda) | — |
| Browser extensions | — | — | YES (`--extension`) | — |
| MCP server mode | — | — | — | YES (`--mcp`) |
| Homebrew install | — | — | YES | — |
| Cargo install | — | — | YES | — |

## Perf Debugging

| Feature | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Navigation timing (`perf`) | YES | YES | — | — |
| JS `performance.*` via eval | YES | YES | YES | YES |
| Chrome DevTools trace | — | — | YES | — |
| CPU profiler | — | — | YES | — |

## Summary Counts

| Category | **browse** | **gstack** | **agent-browser** | **browser-use** |
|---|---|---|---|---|
| Total features (YES) | 103 | 52 | 127 | 52 |
| Blocked (Bun bug) | 2 | — | — | — |

## Top Remaining Gaps

1. **`--connect`/`--cdp`** — code ready, blocked by Bun WebSocket bug (oven-sh/bun#9911). Will work when Bun fixes CDP handshake.
2. **Persistent profiles (`--profile`)** — deferred, conflicts with session multiplexing. Auto-persist covers 90% of auth use case.
3. **Cloud providers** — agent-browser has 4, we have 0 (L effort)
4. **Handoff** — gstack exclusive, unlocker for CAPTCHA/MFA (M effort)
5. **Small input commands** — mouse control, rightclick, bounding box, geolocation, color scheme (S each)
6. **Wait variants** — text, JS condition, load state, hidden state, milliseconds (S each)
