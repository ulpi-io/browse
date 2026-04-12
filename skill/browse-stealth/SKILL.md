---
name: browse-stealth
version: 1.0.0
description: |
  Anti-detection browsing for AI agents using Camoufox (Firefox with C++ fingerprint spoofing).
  Bypasses Cloudflare Turnstile, bot detection, and fingerprinting. Handles CAPTCHAs that
  require checkbox clicks with human-like mouse movement. Uses the same browse CLI with
  --runtime camoufox.
allowed-tools:
  - Bash
  - Read
argument-hint: "[URL or site that blocks normal browsers]"
arguments:
  - request
when_to_use: |
  Use when the target site blocks normal Chromium browsing — Cloudflare Turnstile challenges,
  bot detection walls, fingerprint checks, or "unusual traffic" errors. Signs you need this:
  - Page shows CAPTCHA or "verify you are human" challenge
  - Page returns blank/403/challenge page instead of content
  - Google shows "unusual traffic" block
  - Site uses Cloudflare, DataDome, PerimeterX, or similar bot protection
  Do NOT use for sites that load fine with regular browse — camoufox is slower to start.
effort: high
---

# browse-stealth: Anti-Detection Browsing

## Prerequisites

```bash
npm install camoufox-js        # install the package
npx camoufox-js fetch          # download Firefox binary (~300MB, one-time)
```

Verify: `browse --runtime camoufox doctor` should show `Camoufox: installed`.

## Core Pattern

Every command uses `--runtime camoufox --headed`:

```bash
browse --runtime camoufox --headed goto <url>
browse --runtime camoufox --headed snapshot -i
browse --runtime camoufox --headed click @e3
```

Headed mode is required for most anti-detection — headless Firefox is easier to detect.

## Cloudflare Turnstile Bypass

Turnstile requires real browser input events and mouse movement history. Pattern:

### Step 1: Navigate and find the Turnstile widget

```bash
browse --runtime camoufox --headed goto https://target-site.com/login
browse --runtime camoufox --headed js "
  const el = document.querySelector('#turnstile-widget, [class*=turnstile], [class*=cf-turnstile]');
  if (!el) 'no turnstile widget found';
  else {
    const rect = el.getBoundingClientRect();
    JSON.stringify({x: rect.x, y: rect.y, w: rect.width, h: rect.height});
  }
"
```

### Step 2: Human-like mouse movement to the checkbox

Move the mouse in a natural trajectory to the checkbox area (left side of widget, vertically centered). The movement MUST use Playwright's mouse API (not JS events):

```bash
# Start from a random page position, move gradually toward the checkbox
browse --runtime camoufox --headed mouse move 400 300
browse --runtime camoufox --headed mouse move 500 400
browse --runtime camoufox --headed mouse move 600 500
browse --runtime camoufox --headed mouse move 680 560
browse --runtime camoufox --headed mouse move 720 585
# Final position: widget X + 30, widget Y + height/2
browse --runtime camoufox --headed mouse move <targetX> <targetY>
```

### Step 3: Click the checkbox

```bash
browse --runtime camoufox --headed mouse click <targetX> <targetY>
```

### Step 4: Verify the token was set

```bash
browse --runtime camoufox --headed js "
  const input = document.querySelector('[name=cf-turnstile-response], #cf-chl-widget-bele1_response');
  input?.value?.length || 0
"
```

If the value length is >0 (typically ~500 chars), Turnstile passed. Proceed with form submission.

### Step 5: Submit the form

```bash
browse --runtime camoufox --headed click 'button[type=submit]'
# or use the specific button ID/selector
```

## Key Rules

1. **Always use `--headed`** — headless mode is more detectable
2. **Always use `--runtime camoufox`** — regular Chromium gets blocked
3. **Mouse movement before clicks** — Turnstile and similar check for movement history
4. **Use Playwright mouse API** (`mouse move`, `mouse click`) — NOT JavaScript-dispatched events. JS events are ignored by bot detection.
5. **Wait between actions** — instant fill + click is a bot signal. Add brief pauses between steps.
6. **Find widgets by DOM** — Turnstile widgets are NOT in shadow DOM or iframes on most sites. Use `js` to query `#turnstile-widget`, `[class*=turnstile]`, or `[data-sitekey]`.
7. **Check the token** — after clicking, verify `cf-turnstile-response` input has a value before submitting the form.

## Common Turnstile Widget Selectors

```
#turnstile-widget
[class*=cf-turnstile]
[data-sitekey]
#cf-chl-widget-*_response    (hidden input with token)
[name=cf-turnstile-response] (hidden input with token)
```

## Search Macros (opt-in)

For Google searches through anti-detection:

```bash
BROWSE_CONSENT_DISMISS=1 browse --runtime camoufox --headed goto '@google best coffee beans'
```

## Recommended Environment Variables

```bash
export BROWSE_RUNTIME=camoufox           # default to camoufox for this session
export BROWSE_CONSENT_DISMISS=1          # auto-dismiss cookie banners
export BROWSE_READINESS=1                # wait for page hydration after navigation
```

## What Camoufox Spoofs (C++ level)

- navigator.userAgent, platform, hardwareConcurrency, oscpu
- Canvas pixel data (deterministic noise per context)
- WebGL vendor, renderer, attributes, shader precision
- WebRTC ICE candidates (blocks real IP leak)
- Audio context (sample rate, output latency noise)
- Font list (random 30-78% subset per launch)
- Screen dimensions (width, height, colorDepth)
- Timezone, locale, Accept-Language header
- Media device counts (mic/webcam/speaker)
- Geolocation (auto-derived from proxy IP)
- Speech synthesis voices

## Limitations

- **Slower startup** — Camoufox binary is ~300MB, first launch takes a few seconds
- **No CDP support** — cannot use `--cdp` flag with camoufox
- **IP reputation still matters** — if the IP is blacklisted, fingerprint spoofing alone won't help. Use a residential proxy.
- **Visual CAPTCHAs** — Turnstile checkbox works, but image-selection CAPTCHAs (pick all traffic lights) cannot be solved
- **Rate limiting** — anti-detection doesn't bypass server-side rate limits
