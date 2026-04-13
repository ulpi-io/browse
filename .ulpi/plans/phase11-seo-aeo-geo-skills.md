# Plan: Phase 11 — Camoufox Config, SEO/AEO/GEO Commands & Skills

> Generated: 2026-04-13
> Branch: `feat/seo-aeo-geo`
> Mode: HOLD
> Review: none

## Overview

Surface all 19 camoufox-js launch options through `browse.json` config and named profiles with a `--camoufox-profile` CLI flag. Add 3 convenience read commands (`schema`, `meta`, `headings`). Create 5 skills: `browse-config` (guided config generator), `browse-stealth` (rewrite), `browse-seo`, `browse-aeo`, `browse-geo`.

## Scope Challenge

The camoufox runtime currently hardcodes 3 of 19 available launch options (`headless`, `humanize`, `enable_cache`). Critical stealth options like `geoip`, `os`, `locale`, `block_webrtc` are not exposed — making the fingerprint inconsistent with the proxy IP/locale. The fix is a `camoufox` section in `browse.json` + named profiles, not 19 env vars. One env var (`BROWSE_CAMOUFOX_PROFILE`) selects a profile. A new `browse-config` skill generates the config via guided flow.

## Architecture

```
browse.json (project root)                  .browse/profiles/*.json
┌──────────────────────────┐               ┌────────────────────────┐
│ {                         │               │ stealth-google.json     │
│   "runtime": "camoufox", │               │ fast-scrape.json        │
│   "camoufox": {           │  ◄── merge ── │ perplexity.json         │
│     "geoip": true,        │   TASK-001     │                        │
│     "os": "windows",      │   TASK-002     └────────────────────────┘
│     "blockWebrtc": true   │
│   }                       │
│ }                         │
└──────────┬───────────────┘
           │
           ▼
  src/config.ts                    src/engine/resolver.ts
  CamoufoxConfig type  ────────►  camoufox loader reads config
  TASK-001                        maps camelCase → snake_case
                                  passes to launchOptions()
                                  TASK-001

  src/cli.ts                      .browse/profiles/
  --camoufox-profile flag ──────► profile JSON loaded + merged
  TASK-002                        TASK-002

  src/commands/read.ts             skill/browse-config/
  schema, meta, headings ◄──────  guided flow generates config
  TASK-003                        TASK-005

  skill/browse-stealth/           skill/browse-seo/
  references /browse-config       uses schema/meta/headings
  TASK-006                        TASK-007

  skill/browse-aeo/               skill/browse-geo/
  page audit + SERP analysis      multi-engine GEO monitoring
  TASK-008                        TASK-009
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Config file loading | `src/config.ts loadConfig()` | Extend (add CamoufoxConfig) |
| Camoufox launch | `src/engine/resolver.ts:171-182` | Extend (read config, not hardcode) |
| CLI flag parsing | `src/cli.ts cliFlags` | Extend (add --camoufox-profile) |
| JSON-LD extraction | `browse js` command | Extend (new schema command) |
| Skill file structure | `skill/browse/SKILL.md` | Reuse pattern |

## Camoufox Options — Full Coverage

All 19 camoufox-js LaunchOptions exposed via `browse.json` camoufox section:

| Option | Config Key | Type | Default |
|--------|-----------|------|---------|
| `headless` | `headless` | `boolean \| 'virtual'` | from `BROWSE_HEADED` |
| `humanize` | `humanize` | `boolean \| number` | `true` |
| `enable_cache` | `enableCache` | `boolean` | `true` |
| `os` | `os` | `string \| string[]` | random |
| `block_images` | `blockImages` | `boolean` | `false` |
| `block_webrtc` | `blockWebrtc` | `boolean` | `false` |
| `block_webgl` | `blockWebgl` | `boolean` | `false` |
| `disable_coop` | `disableCoop` | `boolean` | `false` |
| `geoip` | `geoip` | `string \| boolean` | `false` |
| `locale` | `locale` | `string \| string[]` | system |
| `addons` | `addons` | `string[]` | `[]` |
| `fonts` | `fonts` | `string[]` | OS defaults |
| `custom_fonts_only` | `customFontsOnly` | `boolean` | `false` |
| `screen` | `screen` | `{ min/maxWidth, min/maxHeight }` | random |
| `window` | `window` | `[width, height]` | random |
| `fingerprint` | `fingerprint` | `object` | auto-generated |
| `ff_version` | `ffVersion` | `number` | current |
| `main_world_eval` | `mainWorldEval` | `boolean` | `false` |
| `firefox_user_prefs` | `firefoxUserPrefs` | `Record<string, any>` | `{}` |
| `proxy` | `proxy` | `string \| { server, username, password }` | from `BROWSE_PROXY` |
| `debug` | `debug` | `boolean` | `false` |

## Tasks

### TASK-001: Add camoufox config to BrowseConfig and resolver

Extend `src/config.ts` with `CamoufoxConfig` interface (all 19 options). Add `camoufox?: CamoufoxConfig` to `BrowseConfig`. Add `loadCamoufoxConfig(localDir?)` function that: (1) reads browse.json camoufox section, (2) checks `BROWSE_CAMOUFOX_PROFILE` env var, (3) if set, loads `.browse/profiles/<name>.json` and merges (profile wins), (4) returns merged config. Update `src/engine/resolver.ts` camoufox loader to call `loadCamoufoxConfig()`, map camelCase → snake_case, pass to `launchOptions()`. No changes to `getRuntime()` signature — resolver reads config internally.

Note: `headless: 'virtual'` requires Linux with Xvfb. Document in JSDoc. camoufox-js throws on unsupported platforms — the try/catch fallback handles it.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] browse.json `{ "camoufox": { "geoip": true, "os": "windows" } }` causes launchOptions() to receive those values
- [ ] Missing camoufox section falls back to current defaults
- [ ] Invalid config key logs warning but doesn't crash

**Write Scope:** `src/config.ts`, `src/engine/resolver.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-002: Named camoufox profiles and --camoufox-profile flag

Add `--camoufox-profile <name>` CLI flag. The flag sets `BROWSE_CAMOUFOX_PROFILE` env var on server spawn (same pattern as `BROWSE_RUNTIME`). The resolver's `loadCamoufoxConfig()` (TASK-001) reads this env var and loads the profile — no server.ts changes needed for config plumbing. Add `browse profiles` meta command to list available profiles.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--camoufox-profile stealth-google` loads `.browse/profiles/stealth-google.json` and merges with browse.json
- [ ] Missing profile file produces clear error with list of available profiles
- [ ] `browse profiles` lists all .json files in `.browse/profiles/`

**Write Scope:** `src/cli.ts`, `src/server.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-003: Register schema, meta, and headings read commands

Add 3 new read commands to `src/automation/registry.ts`, implement in `src/commands/read.ts`, update CLI help text in `src/cli.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse schema` on a page with JSON-LD returns parsed structured data
- [ ] `browse meta` on a page returns title, description, canonical, OG tags
- [ ] `browse headings` on a page with no headings returns `(no headings found)`

**Write Scope:** `src/automation/registry.ts`, `src/commands/read.ts`, `src/cli.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-004: Tests for new commands and camoufox config

Create `test/seo-commands.test.ts` + `test/fixtures/seo-page.html` for schema/meta/headings tests. Add camoufox config unit tests for key mapping and profile merging.

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All schema/meta/headings tests pass against HTML fixture
- [ ] Config mapping test verifies camelCase → snake_case for all 19 options
- [ ] Profile merge test verifies profile values override browse.json defaults
- [ ] Integration test (`test.skipIf(!camoufoxAvailable)`) calls `launchOptions()` with mapped config

**Write Scope:** `test/fixtures/seo-page.html`, `test/seo-commands.test.ts`, `test/test-server.ts`
**Validation:** `npm test -- test/seo-commands`

**Depends on:** TASK-001, TASK-003
**Agent:** nodejs-cli-senior-engineer
**Priority:** P1

---

### TASK-005: Create browse-config skill

Create `skill/browse-config/SKILL.md` — guided flow using AskUserQuestion. Asks: what are you doing? have a proxy? need images? Generates browse.json camoufox section or named profile JSON. Referenced by browse-stealth.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Uses AskUserQuestion for guided config choices
- [ ] Generated JSON is valid with correct camoufox options for selected use case
- [ ] Shows exact CLI command to use the generated config

**Write Scope:** `skill/browse-config/SKILL.md`
**Validation:** `head -5 skill/browse-config/SKILL.md`

**Depends on:** TASK-001, TASK-002
**Agent:** general-purpose
**Priority:** P1

---

### TASK-006: Rewrite browse-stealth skill

Full rewrite of `skill/browse-stealth/SKILL.md`. Step 0 references `/browse-config` for setup. Covers Turnstile bypass, Google blocks, auth sessions, proxy rotation. Every step has exact commands.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Step 0 references /browse-config for setup
- [ ] Every step includes exact browse CLI commands
- [ ] Turnstile bypass includes mouse movement and token verification

**Write Scope:** `skill/browse-stealth/SKILL.md`
**Validation:** `head -5 skill/browse-stealth/SKILL.md`

**Depends on:** TASK-005
**Agent:** general-purpose
**Priority:** P1

---

### TASK-007: Create browse-seo skill

Create `skill/browse-seo/SKILL.md` — SEO audit using schema/meta/headings + existing commands. References /browse-config for stealth setup.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Complete audit: meta, headings, schema, perf, links, mobile, images
- [ ] Uses new schema/meta/headings commands
- [ ] References /browse-config for camoufox setup

**Write Scope:** `skill/browse-seo/SKILL.md`
**Validation:** `head -5 skill/browse-seo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

### TASK-008: Create browse-aeo skill

Create `skill/browse-aeo/SKILL.md` — AEO page audit + SERP analysis. Agent interprets snapshots. References /browse-config.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Covers audit mode (page) and SERP mode (search results)
- [ ] SERP mode: agent interprets snapshot @refs, no magic parsing
- [ ] References /browse-config for camoufox setup

**Write Scope:** `skill/browse-aeo/SKILL.md`
**Validation:** `head -5 skill/browse-aeo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

### TASK-009: Create browse-geo skill

Create `skill/browse-geo/SKILL.md` — GEO monitoring across Google, Perplexity, ChatGPT Search. Exact navigation per engine. References /browse-config + --profile for auth.

**Type:** docs
**Effort:** L

**Acceptance Criteria:**
- [ ] Covers Google, Perplexity, ChatGPT with exact commands per engine
- [ ] Multi-engine comparison with domain visibility report
- [ ] References /browse-config and --profile for authenticated engines

**Write Scope:** `skill/browse-geo/SKILL.md`
**Validation:** `head -5 skill/browse-geo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Invalid camoufox config crashes launch | TASK-001 | try/catch around launchOptions(), fall back to defaults |
| headless: 'virtual' requires Xvfb (Linux only) | TASK-001 | Document in JSDoc. camoufox-js throws on unsupported platforms — try/catch handles it. |
| Profile file not found | TASK-002 | Clear error listing available profiles |
| Command name conflicts | TASK-003 | Verified: no existing schema/meta/headings |
| Skills too vague for agents | TASK-005-009 | Exact browse commands in every step |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Camoufox config from browse.json | TASK-004 | unit |
| Profile load + merge | TASK-004 | unit |
| camelCase → snake_case mapping | TASK-004 | unit |
| schema extracts JSON-LD | TASK-004 | integration |
| meta extracts title/OG/canonical | TASK-004 | integration |
| headings extracts H1-H6 tree | TASK-004 | integration |
| launchOptions() with full mapped config (skipIf) | TASK-004 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 9 |
| Layer Count | 3 |
| Critical Path | TASK-001 → TASK-002 → TASK-005 → TASK-006 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-003 | Config + new commands (independent) |
| 1 | TASK-002, TASK-004, TASK-007, TASK-008, TASK-009 | Profiles + tests + 3 skills |
| 2 | TASK-005, TASK-006 | Config skill + stealth rewrite (depend on profiles) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": ["TASK-001", "TASK-003"],
  "TASK-005": ["TASK-001", "TASK-002"],
  "TASK-006": ["TASK-005"],
  "TASK-007": ["TASK-003"],
  "TASK-008": ["TASK-003"],
  "TASK-009": ["TASK-003"]
}
```
