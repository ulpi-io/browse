# Plan: Phase 11 — Camoufox Config, SEO/AEO/GEO Commands & Skills

> Generated: 2026-04-13
> Branch: `feat/seo-aeo-geo`
> Mode: EXPANSION
> Review: none

## Overview

Surface 26 of 27 camoufox-js launch options (all except webgl_config) through `browse.json` config and named profiles with a `--camoufox-profile` CLI flag. Add 3 convenience read commands (`schema`, `meta`, `headings`). Update browse skill command docs. Create 5 skills: `browse-config` (guided config generator), `browse-stealth` (rewrite), `browse-seo`, `browse-aeo`, `browse-geo`.

## Scope Challenge

This is EXPANSION: new config surface (CamoufoxConfig type + loadCamoufoxConfig), new CLI flag (--camoufox-profile), new meta command (profiles), 3 new read commands, 5 new/rewritten skills, new test file + fixture, and user-facing doc updates. Not a simple extension.

## Camoufox Options — Full Coverage (26 keys)

| # | camoufox-js key | Config key | Type |
|---|----------------|-----------|------|
| 1 | `os` | `os` | `string \| string[]` |
| 2 | `block_images` | `blockImages` | `boolean` |
| 3 | `block_webrtc` | `blockWebrtc` | `boolean` |
| 4 | `block_webgl` | `blockWebgl` | `boolean` |
| 5 | `disable_coop` | `disableCoop` | `boolean` |
| 6 | `geoip` | `geoip` | `string \| boolean` |
| 7 | `humanize` | `humanize` | `boolean \| number` |
| 8 | `locale` | `locale` | `string \| string[]` |
| 9 | `addons` | `addons` | `string[]` |
| 10 | `fonts` | `fonts` | `string[]` |
| 11 | `custom_fonts_only` | `customFontsOnly` | `boolean` |
| 12 | `screen` | `screen` | `{ min/maxWidth, min/maxHeight }` |
| 13 | `window` | `window` | `[width, height]` |
| 14 | `fingerprint` | `fingerprint` | `object` |
| 15 | `ff_version` | `ffVersion` | `number` |
| 16 | `headless` | `headless` | `boolean \| 'virtual'` |
| 17 | `main_world_eval` | `mainWorldEval` | `boolean` |
| 18 | `firefox_user_prefs` | `firefoxUserPrefs` | `Record<string, any>` |
| 19 | `proxy` | `proxy` | `string \| { server, username, password }` |
| 20 | `enable_cache` | `enableCache` | `boolean` |
| 21 | `debug` | `debug` | `boolean` |
| 22 | `exclude_addons` | `excludeAddons` | `string[]` |
| 23 | `executable_path` | `executablePath` | `string` |
| 24 | `args` | `args` | `string[]` |
| 25 | `env` | `env` | `Record<string, string>` |
| 26 | `virtual_display` | `virtualDisplay` | `string` |

Excluded: `webgl_config` — camoufox auto-generates from fingerprint, manual override not needed.

## Architecture

```
browse.json                           .browse/profiles/*.json
┌───────────────────┐                ┌──────────────────────┐
│ { "camoufox": {   │                │ stealth-google.json   │
│   "geoip": true   │  ◄── merge ── │ fast-scrape.json      │
│ }}                 │   TASK-001     └──────────────────────┘
└────────┬──────────┘
         │
         ▼
  src/config.ts                     src/engine/resolver.ts
  CamoufoxConfig type               camoufox loader calls
  loadCamoufoxConfig()  ──────────► loadCamoufoxConfig()
  mapCamoufoxConfig()               maps keys, passes to
  TASK-001                          launchOptions()  TASK-001

  src/cli.ts                        src/commands/meta/profile.ts
  --camoufox-profile flag           browse profiles command
  sets BROWSE_CAMOUFOX_PROFILE      lists .browse/profiles/*.json
  TASK-002                          TASK-002

  src/automation/registry.ts        src/commands/read.ts
  register schema/meta/headings     implement page.evaluate()
  register profiles command         TASK-003
  TASK-002 + TASK-003

  skill/browse/references/          skill/browse-config/
  commands.md updated               guided config generator
  TASK-005                          TASK-006

  skill/browse-stealth/             skill/browse-seo|aeo|geo/
  rewrite, refs /browse-config      SEO/AEO/GEO workflows
  TASK-007                          TASK-008/009/010
```

## Tasks

### TASK-001: CamoufoxConfig type, loadCamoufoxConfig(), and resolver integration

Extend `src/config.ts` with `CamoufoxConfig` interface (26 keys), `loadCamoufoxConfig()` (reads browse.json + merges profile), `mapCamoufoxConfig()` (camelCase → snake_case). Update `src/engine/resolver.ts` camoufox loader to use these. Wrap in try/catch with fallback to defaults.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] browse.json `{ camoufox: { geoip: true, os: 'windows' } }` reaches launchOptions()
- [ ] BROWSE_CAMOUFOX_PROFILE merges profile on top of browse.json
- [ ] Malformed profile JSON logs warning, falls back to browse.json without crash

**Write Scope:** `src/config.ts`, `src/engine/resolver.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-002: --camoufox-profile CLI flag and browse profiles meta command

Add `--camoufox-profile <name>` to `src/cli.ts` (sets `BROWSE_CAMOUFOX_PROFILE` env on server spawn). Add `browse profiles` meta command in `src/commands/meta/profile.ts` (lists `.browse/profiles/*.json`). Register in `src/automation/registry.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `--camoufox-profile stealth-google` sets env var on server spawn
- [ ] `browse profiles` lists profiles with key summary
- [ ] `browse profiles` returns empty message when no profiles exist

**Write Scope:** `src/cli.ts`, `src/commands/meta/profile.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-003: Register schema, meta, and headings read commands

Add 3 read commands to `src/automation/registry.ts`, implement in `src/commands/read.ts`, update CLI help in `src/cli.ts`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `browse schema` extracts JSON-LD from current page
- [ ] `browse meta` returns structured meta tag text
- [ ] `browse headings` on empty page returns `(no headings found)`

**Write Scope:** `src/automation/registry.ts`, `src/commands/read.ts`, `src/cli.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Priority:** P0

---

### TASK-004: Tests for commands, config, profiles, and CLI flag

Create `test/seo-commands.test.ts` + `test/fixtures/seo-page.html`. Covers: read commands (6 tests), config mapping (6 tests), CLI flag (1 test), camoufox integration (1 skipIf test), profiles command (2 tests).

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All read command tests pass against fixture
- [ ] Config mapping verifies camelCase → snake_case for all 26 keys
- [ ] Profile merge: profile values override browse.json defaults
- [ ] skipIf integration test calls launchOptions() with mapped config

**Write Scope:** `test/fixtures/seo-page.html`, `test/seo-commands.test.ts`, `test/test-server.ts`
**Validation:** `npm test -- test/seo-commands`

**Depends on:** TASK-001, TASK-002, TASK-003
**Agent:** nodejs-cli-senior-engineer
**Priority:** P1

---

### TASK-005: Update browse skill command docs

Update `skill/browse/references/commands.md` and `skill/browse/SKILL.md` to document schema, meta, headings, profiles commands, --camoufox-profile flag, BROWSE_CAMOUFOX_PROFILE env var.

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] commands.md lists schema, meta, headings with syntax
- [ ] commands.md lists profiles under Meta commands
- [ ] --camoufox-profile documented with server-spawn-only note

**Write Scope:** `skill/browse/references/commands.md`, `skill/browse/SKILL.md`
**Validation:** `grep -c 'schema\|headings\|profiles' skill/browse/references/commands.md`

**Depends on:** TASK-002, TASK-003
**Agent:** general-purpose
**Priority:** P1

---

### TASK-006: Create browse-config skill

Guided flow via AskUserQuestion → generates browse.json or named profile. Referenced by browse-stealth.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Uses AskUserQuestion for guided choices
- [ ] Generated JSON is valid per use case
- [ ] Shows exact CLI command to use config

**Write Scope:** `skill/browse-config/SKILL.md`

**Depends on:** TASK-001, TASK-002
**Agent:** general-purpose
**Priority:** P1

---

### TASK-007: Rewrite browse-stealth skill

References /browse-config for setup. Covers Turnstile, Google blocks, auth, proxy. Documents --camoufox-profile is server-spawn-only.

**Type:** docs
**Effort:** M

**Acceptance Criteria:**
- [ ] Step 0 references /browse-config
- [ ] Every step has exact browse commands
- [ ] Documents server-spawn-only behavior of --camoufox-profile

**Write Scope:** `skill/browse-stealth/SKILL.md`

**Depends on:** TASK-006
**Agent:** general-purpose
**Priority:** P1

---

### TASK-008: Create browse-seo skill

SEO audit using schema/meta/headings. References /browse-config.

**Type:** docs
**Effort:** M

**Write Scope:** `skill/browse-seo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

### TASK-009: Create browse-aeo skill

AEO page audit + SERP analysis. Agent interprets snapshots. References /browse-config.

**Type:** docs
**Effort:** M

**Write Scope:** `skill/browse-aeo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

### TASK-010: Create browse-geo skill

GEO monitoring across Google, Perplexity, ChatGPT. References /browse-config + --profile.

**Type:** docs
**Effort:** L

**Write Scope:** `skill/browse-geo/SKILL.md`

**Depends on:** TASK-003
**Agent:** general-purpose
**Priority:** P1

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Invalid camoufox config crashes launch | TASK-001 | try/catch, log error key, fall back to defaults |
| headless: 'virtual' needs Xvfb (Linux) | TASK-001 | Document in JSDoc. camoufox-js throws — try/catch handles. |
| Malformed profile JSON | TASK-001 | Log warning, return browse.json config only |
| Invalid merge precedence | TASK-001 | Simple Object.assign — profile wins. Documented. |
| Profile file not found | TASK-001 | Error with list of available profiles |
| --camoufox-profile ignored on running server | TASK-002 | Same as --runtime. Document in CLI help + skills. |
| Command name conflicts | TASK-003 | Verified: no existing schema/meta/headings/profiles |
| Skills too vague for agents | TASK-006-010 | Exact commands in every step |

## Test Coverage Map

| Codepath | Task | Type |
|----------|------|------|
| Config from browse.json → launchOptions() | TASK-004 | unit |
| camelCase → snake_case (26 keys) | TASK-004 | unit |
| Profile load + merge (profile wins) | TASK-004 | unit |
| Malformed profile fallback | TASK-004 | unit |
| Missing profile error | TASK-004 | unit |
| --camoufox-profile flag parsing | TASK-004 | unit |
| browse profiles listing | TASK-004 | integration |
| schema extracts JSON-LD | TASK-004 | integration |
| meta extracts tags | TASK-004 | integration |
| headings extracts tree | TASK-004 | integration |
| schema empty page | TASK-004 | integration |
| launchOptions() full config (skipIf) | TASK-004 | integration |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 10 |
| Layer Count | 4 |
| Critical Path | TASK-001 → TASK-002 → TASK-006 → TASK-007 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-003 | Config + read commands (independent) |
| 1 | TASK-002, TASK-008, TASK-009, TASK-010 | CLI flag + 3 skills |
| 2 | TASK-004, TASK-005, TASK-006 | Tests + docs + config skill |
| 3 | TASK-007 | Stealth rewrite (depends on config skill) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": ["TASK-001", "TASK-002", "TASK-003"],
  "TASK-005": ["TASK-002", "TASK-003"],
  "TASK-006": ["TASK-001", "TASK-002"],
  "TASK-007": ["TASK-006"],
  "TASK-008": ["TASK-003"],
  "TASK-009": ["TASK-003"],
  "TASK-010": ["TASK-003"]
}
```
