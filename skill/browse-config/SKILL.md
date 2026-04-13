---
name: browse-config
version: 1.0.0
description: |
  Guided configuration generator for the browse CLI's camoufox integration.
  Asks the user questions to build a browse.json camoufox section or a named
  profile JSON file for stealth, fast-scraping, Google-safe, or custom setups.
allowed-tools:
  - AskUserQuestion
  - Bash
  - Read
  - Write
argument-hint: "[preset or 'custom']"
arguments:
  - request
when_to_use: |
  Use when the user asks to configure camoufox, set up stealth browsing, create a browse
  profile, tune anti-detection settings, or says /browse-config. Do NOT use for general
  browse CLI usage or non-camoufox configuration.
effort: medium
---

# browse-config: Camoufox Configuration Generator

## Step 0: Ask what the user needs

Use AskUserQuestion to determine the goal. Offer these presets:

| Preset | Description |
|--------|-------------|
| **Stealth browsing** | For scraping protected sites. Enables geoip, humanize, default OS fingerprint. |
| **Fast scraping** | Minimal footprint. Blocks images, WebRTC, WebGL. Enables disk cache. |
| **Google-safe** | For Google search without "unusual traffic" blocks. Enables geoip, humanize, random OS. |
| **Custom** | Walk through each option group interactively. |

### Preset defaults

**Stealth browsing:**
```json
{
  "geoip": true,
  "humanize": true
}
```

**Fast scraping:**
```json
{
  "blockImages": true,
  "blockWebrtc": true,
  "blockWebgl": true,
  "enableCache": true
}
```

**Google-safe:**
```json
{
  "geoip": true,
  "humanize": true,
  "os": ["windows", "macos", "linux"]
}
```

## Step 1: Custom configuration (skip if preset chosen)

If the user chose "Custom", ask about each option group using AskUserQuestion. Present one group at a time.

### Identity
- `os` (string or array) -- target OS fingerprint: "windows", "macos", "linux", or an array for random selection
- `locale` (string or array) -- browser locale, e.g. "en-US" or ["en-US", "en-GB"]
- `fingerprint` (object) -- advanced fingerprint overrides (most users skip this)

### Privacy
- `blockWebrtc` (boolean) -- block WebRTC to prevent IP leaks
- `blockWebgl` (boolean) -- block WebGL fingerprinting
- `blockImages` (boolean) -- block image loading (also improves speed)

### Performance
- `enableCache` (boolean) -- enable browser disk cache
- `blockImages` (boolean) -- already covered in Privacy, mention speed benefit here

### Network
- `proxy` (string or object) -- proxy URL like "http://user:pass@host:port" or `{"server":"...","username":"...","password":"..."}`
- `geoip` (string or boolean) -- true to auto-derive from proxy IP, or a country code like "US"

### Behavior
- `humanize` (boolean or number) -- true for default human-like delays, or a number (0.5-2.0) to control speed

### Advanced (offer only if user asks)
- `addons` (string[]) -- Firefox addon paths to load
- `excludeAddons` (string[]) -- built-in addons to skip
- `firefoxUserPrefs` (Record) -- raw Firefox about:config preferences
- `args` (string[]) -- extra browser launch arguments
- `fonts` (string[]) -- custom font list
- `customFontsOnly` (boolean) -- use only custom fonts
- `screen` (object) -- `{minWidth, maxWidth, minHeight, maxHeight}`
- `window` ([width, height]) -- fixed window size
- `ffVersion` (number) -- target Firefox version
- `headless` (boolean or "virtual") -- headless mode (not recommended for anti-detection)
- `mainWorldEval` (boolean) -- enable main world JavaScript eval
- `executablePath` (string) -- custom camoufox binary path
- `env` (Record) -- environment variables for the browser process
- `virtualDisplay` (string) -- virtual display config (Linux only)
- `disableCoop` (boolean) -- disable Cross-Origin-Opener-Policy headers
- `debug` (boolean) -- enable debug logging

## Step 2: Ask where to save

Use AskUserQuestion with two options:

1. **browse.json** -- adds a `"camoufox"` section to the project's `browse.json`. Applied automatically whenever `--runtime camoufox` is used.
2. **Named profile** -- saves to `.browse/camoufox-profiles/<name>.json`. Used with `--camoufox-profile <name>`. Good for per-scenario configs (e.g. "google", "scrape", "stealth").

If the user picks a named profile, ask for the profile name.

## Step 3: Generate and write the file

### If browse.json

Read the existing `browse.json` first (if it exists). Merge the new `camoufox` key into it. Write the result:

```json
{
  "camoufox": {
    "geoip": true,
    "humanize": true
  }
}
```

### If named profile

Create the directory `.browse/camoufox-profiles/` if needed. Write just the config object:

```json
{
  "geoip": true,
  "humanize": true,
  "os": "windows"
}
```

## Step 4: Show usage

After writing the file, tell the user exactly how to use it.

**If browse.json:**
```
Run: browse --runtime camoufox goto <url>
The camoufox section is applied automatically.
```

**If named profile:**
```
Run: browse --runtime camoufox --camoufox-profile <name> goto <url>
```

Always note: "The `--camoufox-profile` flag only applies when starting a new server. If a server is already running, stop it first with `browse stop`."

## All CamoufoxConfig options

All keys use camelCase in JSON. They are auto-mapped to snake_case for camoufox-js internally.

| Key | Type | Description |
|-----|------|-------------|
| `os` | string or string[] | Target OS fingerprint |
| `blockImages` | boolean | Block image loading |
| `blockWebrtc` | boolean | Block WebRTC |
| `blockWebgl` | boolean | Block WebGL |
| `disableCoop` | boolean | Disable COOP headers |
| `geoip` | string or boolean | GeoIP spoofing (true or country code) |
| `humanize` | boolean or number | Human-like delays (true or speed factor) |
| `locale` | string or string[] | Browser locale |
| `addons` | string[] | Firefox addon paths |
| `fonts` | string[] | Custom fonts |
| `customFontsOnly` | boolean | Only use custom fonts |
| `screen` | object | Screen size range ({minWidth, maxWidth, minHeight, maxHeight}) |
| `window` | [number, number] | Fixed window size |
| `fingerprint` | object | Fingerprint overrides |
| `ffVersion` | number | Firefox version |
| `headless` | boolean or "virtual" | Headless mode |
| `mainWorldEval` | boolean | Main world eval |
| `firefoxUserPrefs` | Record | Firefox about:config prefs |
| `proxy` | string or object | Proxy config |
| `enableCache` | boolean | Enable disk cache |
| `debug` | boolean | Debug logging |
| `excludeAddons` | string[] | Addons to exclude |
| `executablePath` | string | Custom browser path |
| `args` | string[] | Extra browser args |
| `env` | Record | Environment variables |
| `virtualDisplay` | string | Virtual display (Linux) |

## Guardrails

- Always use AskUserQuestion before generating config. Do not assume preferences.
- Use camelCase keys in all generated JSON (the CLI handles snake_case mapping).
- Never overwrite existing browse.json fields outside the `camoufox` key.
- Never include proxy credentials in output shown to the user. Write them to the file only.
- Do not include options the user did not ask for or confirm, beyond the preset defaults.
