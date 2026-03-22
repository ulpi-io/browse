# Plan: React DevTools Integration

> Generated: 2026-03-22
> Branch: `feat/react-devtools`
> Mode: HOLD

## Overview

Add `react-devtools` meta command with subcommands for React inspection. Lazy-downloaded hook injected on-demand via `enable`. No env var, no auto-inject.

## Commands

```
browse react-devtools enable      # download hook, inject, reload
browse react-devtools disable     # remove hook, reload
browse react-devtools tree        # component tree
browse react-devtools props @e3   # props/state of component
browse react-devtools suspense    # suspense boundaries + status
browse react-devtools errors      # error boundaries + caught errors
browse react-devtools profiler    # render timing per component
browse react-devtools hydration   # hydration timing + mismatches
browse react-devtools renders     # what re-rendered since last check
browse react-devtools owners @e3  # parent component chain
browse react-devtools context @e3 # context values consumed
```

## Tasks

### TASK-001: React DevTools module (P0)
Create `src/react-devtools.ts` — lazy download, hook injection, all query functions.
**Agent:** nodejs-cli-senior-engineer

### TASK-002: react-devtools meta command (P1, depends TASK-001)
Add to META_COMMANDS + implement all subcommands in meta.ts.
**Agent:** nodejs-cli-senior-engineer

### TASK-003: Integration tests (P2, depends TASK-002)
Test against React page fixture. Enable/disable lifecycle, tree, non-React pages.
**Agent:** nodejs-cli-senior-engineer

### TASK-004: Documentation (P3, depends TASK-003)
SKILL.md, README, CHANGELOG.
**Agent:** general-purpose

## Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": ["TASK-003"]
}
```
