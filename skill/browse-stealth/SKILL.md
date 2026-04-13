---
name: browse-stealth
version: 2.0.0
description: |
  Stealth browsing with the camoufox runtime for AI agents. Covers Cloudflare Turnstile bypass,
  Google anti-bot evasion, authenticated sessions, and proxy rotation. Uses the browse CLI with
  --runtime camoufox and named camoufox profiles.
allowed-tools:
  - Bash
  - Read
argument-hint: "[URL or site that blocks normal browsers]"
arguments:
  - request
when_to_use: |
  Use when the user asks for stealth browsing, anti-detection, bot bypass, Turnstile, or says
  /browse-stealth. Signs you need this:
  - Page shows CAPTCHA or "verify you are human" challenge
  - Page returns blank/403/challenge page instead of content
  - Google shows "unusual traffic" block
  - Site uses Cloudflare, DataDome, PerimeterX, or similar bot protection
  Do NOT use for sites that load fine with regular browse -- camoufox is slower to start.
effort: high
---

# browse-stealth: Stealth Browsing with Camoufox

## Step 0: Setup via /browse-config

Before launching a stealth session, generate a camoufox configuration profile.

Run `/browse-config` to generate a stealth profile, or use the Google-safe preset.

Presets available in /browse-config:
- **Stealth browsing** -- geoip + humanize for general anti-detection
- **Google-safe** -- geoip + humanize + random OS for Google searches
- **Fast scraping** -- blocks images, WebRTC, WebGL; enables cache
- **Custom** -- interactive walkthrough of all options

The `--camoufox-profile` flag only applies when starting a NEW server. If a browse server is already running, stop it first with `browse stop` before switching profiles.

## Step 1: Launch with camoufox

Stop any existing server, then launch with the camoufox runtime:

```bash
browse stop                                          # stop any running server
browse --runtime camoufox --camoufox-profile <name> goto <url>
```

Replace `<name>` with the profile created in Step 0 (e.g. "stealth", "google"). If no named profile exists, the `camoufox` section in `browse.json` is used automatically:

```bash
browse stop
browse --runtime camoufox goto <url>
```

After navigation, stabilize the page before reading or interacting:

```bash
browse wait --network-idle
browse snapshot -i
```

## Step 2: Cloudflare Turnstile bypass

### Navigate and identify the Turnstile widget

```bash
browse --runtime camoufox --camoufox-profile <name> goto https://target-site.com/login
browse snapshot -i
```

Look in the snapshot output for a Turnstile iframe or checkbox. Common patterns:
- An iframe with `challenges.cloudflare.com` in the src
- A checkbox labeled "Verify you are human"
- Elements with `cf-turnstile` in their class or ID

### Wait for Turnstile to auto-resolve

Many Turnstile challenges resolve automatically when humanize is enabled in the profile. Wait for it:

```bash
browse wait --network-idle
browse snapshot -i
```

Check if the page has advanced past the challenge. If the form or main content is now visible, Turnstile passed.

### Click the checkbox if Turnstile persists

If the challenge is still showing after the wait:

```bash
browse click @eN                                     # use the @ref from snapshot
```

Replace `@eN` with the ref pointing to the Turnstile checkbox from the snapshot.

### Verify and retry

```bash
browse snapshot -i
```

If Turnstile still blocks, increase humanize delay in the profile (set humanize to a higher value like 2.0), stop the server, and relaunch:

```bash
browse stop
browse --runtime camoufox --camoufox-profile <name> goto https://target-site.com/login
```

## Step 3: Google anti-bot bypass

### Configure the profile

Use the Google-safe preset from /browse-config, which enables:
- `geoip: true` -- spoofs location based on exit IP
- `humanize: true` -- adds random delays to interactions
- `os: ["windows", "macos", "linux"]` -- random OS fingerprint per launch

### Navigate to Google

```bash
browse stop
browse --runtime camoufox --camoufox-profile google goto "https://www.google.com/search?q=your+query"
```

Or use the search macro:

```bash
browse --runtime camoufox --camoufox-profile google goto @google "your query"
```

### Check for blocks

```bash
browse snapshot -i
```

Look for CAPTCHA screens or consent dialogs. If blocked:

```bash
browse text
```

Confirm the block message (e.g. "unusual traffic from your computer network").

### Handle consent screens

Google often shows a consent/cookie dialog before search results. Dismiss it:

```bash
browse snapshot -i                                   # find the Accept button ref
browse click @eN                                     # click Accept/Agree
```

### Add delays between requests

When making multiple Google searches, add waits between them to avoid rate limiting:

```bash
browse wait --network-idle
```

If still blocked after multiple attempts, the IP may be flagged. Switch to a different proxy (see Step 5).

## Step 4: Authenticated sessions

### Persistent browser profiles

Use `--profile` for a persistent browser identity. Cookies, localStorage, and session data survive server restarts:

```bash
browse stop
browse --runtime camoufox --camoufox-profile stealth --profile mysite goto https://target-site.com/login
```

Login once through the normal flow (fill credentials, click submit). On subsequent launches with the same `--profile`, cookies persist and you skip the login:

```bash
browse stop
browse --runtime camoufox --camoufox-profile stealth --profile mysite goto https://target-site.com/dashboard
```

### Credential vault

For automated login flows, save credentials to the encrypted vault:

```bash
browse auth save mysite https://target-site.com/login myuser --password-stdin <<< "mypassword"
```

Then login automatically:

```bash
browse auth login mysite
```

The vault uses AES-256-GCM encryption. Passwords are stored in `.browse/auth/` with mode 0o600.

## Step 5: Proxy rotation

### Configure proxy in the camoufox profile

Add proxy settings to the profile JSON (via /browse-config custom mode or by editing the file directly):

```json
{
  "geoip": true,
  "humanize": true,
  "proxy": {
    "server": "http://proxy:8080",
    "username": "user",
    "password": "pass"
  }
}
```

Save this as a named profile, e.g. `.browse/camoufox-profiles/proxy-us.json`.

### Switch proxies by switching profiles

Create multiple profiles with different proxy endpoints:

- `.browse/camoufox-profiles/proxy-us.json` -- US proxy
- `.browse/camoufox-profiles/proxy-eu.json` -- EU proxy
- `.browse/camoufox-profiles/proxy-asia.json` -- Asia proxy

To rotate, stop the server and relaunch with a different profile:

```bash
browse stop
browse --runtime camoufox --camoufox-profile proxy-eu goto <url>
```

Each profile switch requires a server restart because the proxy is configured at browser launch time.

## Key Rules

1. **`--camoufox-profile` is server-spawn-only.** Switching profiles requires `browse stop` first. The profile is read once at server startup.
2. **`--runtime camoufox` selects the Firefox-based anti-detection engine.** It replaces the default Chromium with a hardened Firefox that spoofs fingerprints at the C++ level.
3. **humanize adds random delays to clicks and typing.** Set to `true` for default delays, or a number (0.5-2.0) to control speed. Higher values mean slower, more human-like behavior.
4. **geoip spoofs location based on exit IP.** When using a proxy, geoip derives timezone, locale, and geolocation from the proxy's IP address.
5. **Never mix `--profile` (persistent browser data) with `--session` (shared Chromium multiplexing).** They serve different purposes. `--profile` persists cookies across restarts. `--session` isolates parallel agents within a single server.
6. **IP reputation matters.** Fingerprint spoofing alone does not bypass IP-based blocks. Use residential proxies for heavily protected sites.
7. **Headed mode is recommended.** Headless Firefox is easier to detect. Use `--headed` when anti-detection is critical, or set `headless: false` in the profile.
