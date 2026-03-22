# Roadmap

> Last updated: 2026-03-22 | Current: v1.0.6

```
  v1.0 (NOW)          v1.1                v1.2                v1.3+
  ─────────────       ─────────────       ─────────────       ─────────────
  Node.js port        React DevTools      Cloud Providers     Mobile
  Profiles            Component tree      Browserless         iOS Simulator
  Record/Export       Suspense debug      Browserbase         Real devices
  Bun CLI shim        Hydration timing    Kernel
  Handoff             Lazy download       Encrypted vault
```

---

## v1.1 — React DevTools Integration

Give agents visibility into React internals for debugging Next.js/React apps.

```bash
browse react-tree                      # Component tree with props/state
browse react-props @e3                 # Inspect props of component at ref
browse react-suspense                  # Suspense boundaries + loading status
browse react-profiler                  # Render timing per component
```

- **Lazy download** — first `react-tree` call auto-downloads the React DevTools hook (~50KB). No install step.
- Injects `__REACT_DEVTOOLS_GLOBAL_HOOK__` via `context.addInitScript()` before page JS runs
- React auto-discovers the hook and registers renderers
- All queries via `page.evaluate()` — no Chrome extension UI needed
- Works with `--profile` (persistent) and `--session` (ephemeral)

---

## v1.2 — Cloud Providers

Run browse against hosted Chromium. API keys stored in encrypted vault — never visible to agents.

```bash
# Human sets up once (encrypted at rest):
browse provider save browserbase sk-live-xxxxx

# Agent uses it (no token in args/stdout/env):
browse --provider browserbase goto https://example.com
```

- **Browserless** — direct WebSocket, already works via `BROWSE_CDP_URL`, add vault
- **Browserbase** — REST API to create session → CDP URL
- **Kernel** — same pattern
- Reuses AuthVault encryption (AES-256-GCM, `.browse/providers/`)

---

## v1.3 — Streaming & Handoff Improvements

Enhance the handoff protocol with real-time browser streaming.

- **Live viewport** — WebSocket stream of the browser to a web UI
- **Human input relay** — forward mouse/keyboard/touch to the browser

---

## v1.4 — Mobile

Automate real mobile browsers, not just device emulation.

- **iOS Simulator** — connect to Safari via WebKit protocol
- **Real device (USB)** — iOS/Android device automation

---

## Ongoing

- **Homebrew formula** — `brew install browse`
- **Chrome DevTools trace** — `trace start/stop` for performance analysis
