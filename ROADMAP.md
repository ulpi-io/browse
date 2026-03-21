# Roadmap

> Last updated: 2026-03-21 | Current: v1.0.0

```
  v1.0 (NOW)          v1.1                v1.2                v1.3+
  ─────────────       ─────────────       ─────────────       ─────────────
  Node.js port        Cloud Providers     Streaming           Mobile
  138 features        Browserless         Live viewport       iOS Simulator
  0 blocked           Browserbase         Human handoff       Real devices
                      Kernel
                      Encrypted vault
```

---

## v1.1 — Cloud Providers

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

## v1.2 — Streaming & Handoff

Let humans see what the agent sees and take over for CAPTCHA, MFA, or complex flows.

- **Live viewport** — WebSocket stream of the browser to a web UI
- **Human input relay** — forward mouse/keyboard/touch to the browser
- **Handoff mode** — agent pauses, human takes control, agent resumes

---

## v1.3 — Mobile

Automate real mobile browsers, not just device emulation.

- **iOS Simulator** — connect to Safari via WebKit protocol
- **Real device (USB)** — iOS/Android device automation

---

## Ongoing

- **Homebrew formula** — `brew install browse`
- **Node SEA binary** — single executable via Node 20+ Single Executable Applications
- **Chrome DevTools trace** — `trace start/stop` for performance analysis
