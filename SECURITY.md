# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.x     | Yes                |
| < 1.0   | No (use latest 1.x)|

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Use [GitHub Security Advisories](https://github.com/ulpi-io/browse/security/advisories/new) to report vulnerabilities privately. This ensures the issue is not publicly visible until a fix is available.

### What to include

- **Description** of the vulnerability and its impact
- **Steps to reproduce** — exact commands, configuration, and environment
- **Affected component** — which file/module is involved
- **Severity assessment** — your estimate of how critical this is
- **Suggested fix** — if you have one (not required)

### Response timeline

| Stage | Target |
|-------|--------|
| Acknowledgment | 48 hours |
| Initial assessment | 1 week |
| Fix for critical issues | 7 days |
| Fix for high/medium issues | 30 days |
| Public disclosure | After fix is released |

We'll coordinate with you on disclosure timing. If we can't meet these timelines, we'll communicate why.

## Threat Model

@ulpi/browse is a **localhost-only** tool that controls a headless Chromium browser. It's designed for AI coding agents running on developer machines or CI environments. The primary trust boundary is between the CLI user and the persistent server daemon.

### Architecture-specific considerations

- **Server binds to 127.0.0.1 only** — not exposed to the network
- **Bearer token auth** — random UUID generated per server startup, stored in `.browse/browse-server.json` (mode 0o600)
- **No remote access by default** — `BROWSE_CDP_URL` is opt-in for connecting to remote Chrome instances
- **Credential vault** — AES-256-GCM encryption for stored passwords, key auto-generated or provided via `BROWSE_ENCRYPTION_KEY`

## In-Scope Vulnerabilities

The following are security-relevant and should be reported:

### Command injection
- CLI arguments or selectors that escape into shell commands
- `js` or `eval` commands bypassing the action policy when policy denies them
- Crafted @ref identifiers that cause unintended code execution

### Authentication and authorization
- Server token bypass or prediction
- Accessing commands without valid Bearer token
- Policy enforcement bypass (`browse-policy.json` deny rules not enforced)

### Credential vault
- Weaknesses in the AES-256-GCM encryption implementation (`src/auth-vault.ts`)
- Key material exposure (encryption key readable by other users)
- Plaintext password leakage in logs, error messages, or network buffer
- Stored credentials accessible without proper file permissions

### Path traversal
- Session IDs that escape `.browse/sessions/` directory
- Credential names that write outside `.browse/auth/`
- Screenshot/PDF/HAR paths that overwrite arbitrary files
- `sanitizeName()` bypass (`src/sanitize.ts`)

### Domain filter bypass
- HTTP requests reaching blocked domains despite `--allowed-domains`
- WebSocket/EventSource/sendBeacon connections bypassing the domain filter
- `data:`, `blob:`, or `javascript:` URI abuse
- `route` command overriding domain filter restrictions

### Information disclosure
- Console/network buffers leaking data across sessions
- State file (pid, port, token) readable by other users
- Credential vault listing exposing passwords (should only expose metadata)

## Out of Scope

The following are **not** security vulnerabilities in this project:

- **Playwright or Chromium vulnerabilities** — report these upstream to [Playwright](https://github.com/microsoft/playwright/security) or [Chromium](https://www.chromium.org/Home/chromium-security/reporting-security-bugs/)
- **Local privilege escalation** — the tool runs with the same privileges as the user; it doesn't elevate
- **Denial of service against the local server** — it's localhost-only and single-user by design
- **Issues requiring physical access** to the machine
- **Social engineering** — tricking a user into running malicious `browse` commands is no different from tricking them into running any shell command
- **AI agent misuse** — the tool executes commands it receives; securing the agent's decision-making is the agent's responsibility, not ours. That said, the action policy system (`browse-policy.json`) exists to let users restrict what commands agents can run.

## Hardening Recommendations for Users

If you're deploying @ulpi/browse in sensitive environments:

1. **Use the action policy** — create a `browse-policy.json` that denies `js`, `eval`, and any commands your workflow doesn't need
2. **Use domain filtering** — set `--allowed-domains` to restrict which sites the browser can access
3. **Set `BROWSE_ENCRYPTION_KEY`** — provide your own key instead of relying on the auto-generated one
4. **Restrict file permissions** — ensure `.browse/` directory is only readable by the running user
5. **Use sessions** — `--session` isolates browser contexts, cookies, and buffers between agents
