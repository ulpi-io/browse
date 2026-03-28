---
name: lokei
description: |
  Local dev proxy that gives projects named HTTPS domains on .test with valid TLS.
  Use when setting up local development environments, running dev servers, sharing localhost
  publicly via tunnels, or managing Docker Compose services with HTTPS. Handles framework
  detection (30+ frameworks), port management, DNS, certificates, and public tunnels.
  Trigger on: "run my dev server", "set up HTTPS locally", "share localhost", "expose my app",
  "local dev proxy", "tunnel", ".test domain", or when helping users start/configure web projects.
version: 1.0.0
allowed-tools:
  - Bash
  - Read
---

# lokei

Local dev proxy with HTTPS and named `.test` domains. Run `lokei run next dev` and get `https://myapp.test` automatically — with valid TLS, DNS resolution, and port forwarding.

## Setup

Before using lokei, confirm it is installed:

```bash
lokei --version
```

If not installed, tell the user:

> `lokei` is not installed. Install it with:
>
> ```bash
> npm i -g lokei && lokei setup
> ```
>
> `lokei setup` runs once — it generates a local CA, trusts it in your OS keychain, configures DNS resolution for `.test` domains, and sets up port forwarding.

**Do NOT install or run setup automatically.** Wait for the user to confirm before proceeding.

After installation, verify setup is complete:

```bash
lokei doctor
```

If `lokei doctor` reports issues, guide the user through fixing them. Common issues:
- CA not trusted → re-run `lokei setup`
- DNS resolver missing → re-run `lokei setup`
- Port forwarding inactive → re-run `lokei setup` (requires sudo)

## Core Commands

### Run a dev server with HTTPS

```bash
lokei run <command>
```

This is the primary command. It:
1. Starts the daemon if not running
2. Reads `package.json`, detects the framework (Next.js, Vite, Rails, Django, etc.)
3. Reserves a sticky port from the 4000–5999 range
4. Spawns the dev server with the correct PORT and host flags injected
5. Waits for TCP bind (30s timeout)
6. Generates a TLS certificate for `<name>.test` signed by the local CA
7. Registers the route — `https://<name>.test` is live

**Examples:**
```bash
lokei run                    # Auto-detects: reads package.json scripts
lokei run next dev           # Explicit command
lokei run --name myapp       # Override project name → myapp.test
lokei run --port 3000        # Use specific port instead of auto-assigned
lokei run --expose           # Also create a public tunnel
```

The project name is inferred from (in order): `--name` flag, `package.json` name, git remote, or directory name.

### Share localhost publicly

```bash
lokei share --port <port>
```

Creates an ad-hoc public tunnel. No login required for random subdomain URLs.

```bash
lokei share --port 3000                          # Random URL at lokei.dev
lokei share --port 3000 --subdomain myapp        # Request specific subdomain
lokei share --port 3000 --password secret123     # Password-protected
lokei share --port 3000 --ttl 3600               # Expires in 1 hour
```

### Run with public tunnel

```bash
lokei run --expose
```

Combines local HTTPS and public tunnel. Gives you both:
- `https://myapp.test` (local)
- `https://<username>.lokei.dev/myapp` (public, if logged in)

### Docker Compose integration

```bash
lokei docker up              # HTTPS domains for all Compose services
lokei docker down            # Tear down
```

Each Compose service gets `<service>.test` with HTTPS. No port mapping needed.

### Multi-service orchestration

```bash
lokei up                     # Start services from .test.yaml
lokei down                   # Stop all services
```

Define services in `.test.yaml`:
```yaml
services:
  web:
    cmd: next dev
    name: myapp
  api:
    cmd: node server.js
    name: api
    port: 3001
```

### Manage routes and tunnels

```bash
lokei routes ls              # List active .test routes
lokei tunnel list            # List active tunnels
lokei tunnel close <id>      # Close a tunnel
lokei inspect                # Open traffic inspector at inspect.test
```

### Authentication (for stable tunnel URLs)

```bash
lokei login                  # Device-code auth → opens browser
```

After login, tunnels get stable URLs at `<username>.lokei.dev`.

### OS service mode

```bash
lokei service install        # Install as launchd/systemd service
lokei service start          # Start the service
lokei service stop           # Stop the service
lokei service status         # Check service state
lokei service logs           # View daemon logs
```

### Diagnostics

```bash
lokei doctor                 # Check CA, DNS, ports, trust store
lokei logs                   # View traffic logs
lokei logs --follow          # Stream logs in real-time
```

### Cleanup

```bash
lokei uninstall              # Remove everything: certs, DNS, ports, trust
```

## Framework Detection

lokei detects 30+ frameworks and injects the correct port and host flags:

| Framework | Detection | Flags injected |
|-----------|-----------|---------------|
| Next.js | `next dev` | `--port PORT` |
| Vite | `vite`, `vite dev` | `--port PORT --host 127.0.0.1` |
| Astro | `astro dev` | `--port PORT --host 127.0.0.1` |
| Rails | `rails server` | `-p PORT -b 127.0.0.1` |
| Django | `python manage.py runserver` | `127.0.0.1:PORT` |
| Laravel | `php artisan serve` | `--port=PORT --host=127.0.0.1` |
| Flask | `flask run` | `--port PORT --host 127.0.0.1` |
| Angular | `ng serve` | `--port PORT` |
| Nuxt | `nuxt dev` | `--port PORT` |
| Hugo | `hugo server` | `--port PORT` |
| npm/yarn/pnpm/bun | Script runner | `PORT` env var |

For unlisted frameworks, lokei sets `PORT` environment variable and the dev server should respect it.

## Git Worktree Support

When using git worktrees:
- Main branch → `myapp.test`
- Feature branch in worktree → `fix-ui.myapp.test`

The prefix is added automatically when multiple worktrees exist.

## Key Architecture Details

- **State directory**: `~/.lokei/` — CA certs, leaf certs, routes.json, ports.json, daemon socket
- **Port range**: 4000–5999 (sticky across restarts, file-locked ledger)
- **TLD**: `.test` (RFC 2606 reserved)
- **DNS**: Local resolver on 127.0.0.1:15353, wired via `/etc/resolver/test` on macOS
- **Port forwarding**: 80→15080, 443→15443 via pfctl (macOS), iptables (Linux)
- **TLS**: Per-host exact-match certs via SNI (no wildcards)
- **IPC**: JSON over Unix socket (macOS/Linux), Named Pipe (Windows)
- **Tunnel relay**: WebSocket + MessagePack at `relay.lokei.dev`

## When to Use Each Command

| Scenario | Command |
|----------|---------|
| Start working on a project | `lokei run` |
| Start with explicit command | `lokei run next dev` |
| Share with a teammate | `lokei share --port 3000` or `lokei run --expose` |
| Docker project | `lokei docker up` |
| Multiple services | `lokei up` (requires `.test.yaml`) |
| Debug network issues | `lokei inspect` |
| Check what's running | `lokei routes ls` |
| Something broken | `lokei doctor` |
| Run on boot | `lokei service install` |
| Remove everything | `lokei uninstall` |

## Common Patterns for AI Agents

When helping a user set up a project for local development:

1. Check if lokei is installed (`lokei --version`)
2. Check if setup is complete (`lokei doctor`)
3. Run the dev server: `lokei run` (auto-detects framework)
4. The URL will be `https://<project-name>.test`

When the user wants to share their work:
1. If already running with `lokei run`, suggest `lokei run --expose` next time
2. For quick sharing: `lokei share --port <port>`
3. For stable URLs: `lokei login` first, then `lokei run --expose`

When debugging:
1. Run `lokei doctor` to check system health
2. Check `lokei routes ls` for active routes
3. Use `lokei inspect` to view traffic
4. Check `lokei logs` for daemon output
