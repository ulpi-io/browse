---
name: map-project-monorepo
version: 2.1.0
description: Scan a Cargo workspace or package monorepo and generate/update per-member CLAUDE.md files. Each member directory gets a focused, self-contained CLAUDE.md with real exported surface, key files, dependencies, wiring points, and conventions. Run after coding sessions, refactors, or crate/package additions to keep the AI context map current.
---

<EXTREMELY-IMPORTANT>
Before writing ANY per-crate CLAUDE.md, you **ABSOLUTELY MUST** complete Phase 1 discovery.

**SKIPPING DISCOVERY = INCOMPLETE PER-CRATE DOCS = CLAUDE SEARCHING BLINDLY**

This is not optional. Each sub-directory CLAUDE.md must be self-contained.
Claude lazy-loads these files — they ONLY load when Claude touches files in that directory.
If the CLAUDE.md is incomplete, Claude has NO context for that crate.
</EXTREMELY-IMPORTANT>

# Update CLAUDE.md for Workspace

## MANDATORY FIRST RESPONSE PROTOCOL

Before writing ANY documentation:

1. ☐ Detect project type: Cargo workspace (`Cargo.toml` with `[workspace]`) or Node monorepo (`package.json` with `workspaces`)
2. ☐ Discover all member crates/packages
3. ☐ For each, identify actual exported/public surface, not just raw `pub` or `export`
4. ☐ Map inter-member dependencies
5. ☐ Identify key files AND hidden wiring points (crate roots, barrels, manifests, startup hooks, registries, routers)
6. ☐ Identify which members have tests, benchmarks, and runtime entry points
7. ☐ Announce: "Generating CLAUDE.md for X crates/packages, targeting 10/10"

**Writing per-crate docs without discovery = guaranteed gaps. Phase 1 is NON-NEGOTIABLE.**

## Overview

In a monorepo/workspace, Claude Code **lazy-loads** subdirectory CLAUDE.md files — they only load when Claude touches files in that directory. Sibling crates never see each other's CLAUDE.md. This means each per-crate CLAUDE.md must be **self-contained**: everything Claude needs to work effectively in that crate, right there.

This skill generates a focused CLAUDE.md for every workspace member directory, then **simplifies** the root CLAUDE.md by pushing per-crate detail down to where Claude actually needs it.

**Core principle:** Detail lives where it's used. Root stays lean. Crates are self-contained.

**Quality target:** 10/10 — Claude should implement features correctly on first attempt in ANY crate.

**Critical refinement:** map the real public surface and the hidden wiring surface. A member can look "documented" while still being incomplete if the docs miss:

- root export files (`src/lib.rs`, `mod.rs`, `src/index.ts`, barrel files)
- package or crate manifests (`Cargo.toml`, `package.json`, exports maps, feature flags)
- startup/bootstrap files
- router/registry/plugin registration points
- feature-gated modules that affect what is actually reachable

## How Claude Code Loads Subdirectory CLAUDE.md

| Behavior | Detail |
|----------|--------|
| **Lazy loading** | `crates/hgdb-storage/CLAUDE.md` loads ONLY when Claude reads/writes files under `crates/hgdb-storage/` |
| **No cross-loading** | Working in `crates/hgdb-storage/` does NOT load `crates/hgdb-sql/CLAUDE.md` |
| **Root always loads** | Root `CLAUDE.md` loads at startup for every session |
| **Hierarchy** | Instructions from parent CLAUDE.md are inherited (root applies everywhere) |

**Implication:** Per-crate CLAUDE.md must include everything Claude needs for that crate. Don't assume root-level detail will be available — keep root lean, push detail down.

## Context Budget

| Component | Max Lines | Rationale |
|-----------|-----------|-----------|
| Root CLAUDE.md | 300 | Always loaded — keep it to project-wide info only |
| Per-crate CLAUDE.md | 50-200 | Lazy-loaded per directory, focused on that crate |

## When to Use

- **After workspace refactor:** Crates added, removed, or responsibilities shifted
- **After coding session:** New public API, changed dependencies
- **Claude searches blindly:** Reading 10 files across 5 crates to find one function
- **Periodic refresh:** User asks to update workspace docs or sync CLAUDE.md files

---

## Phase 1: Workspace Discovery (MANDATORY)

**Gate: Complete inventory before writing ANY per-crate CLAUDE.md.**

### For Rust Cargo Workspaces

#### Step 1: Find All Crates

```bash
# List all workspace members
grep -A 100 '^\[workspace\]' Cargo.toml | grep 'members' -A 50 | head -20

# Or list all Cargo.toml files
find crates/ -name "Cargo.toml" -maxdepth 2 | sort
```

#### Step 2: Build Crate Inventory

For EACH crate, collect:

```bash
# Crate name and dependencies
for crate_dir in crates/*/; do
  name=$(grep '^name' "$crate_dir/Cargo.toml" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  echo "=== $name ==="
  # Count public items
  grep -rh "^pub " "$crate_dir/src/" --include="*.rs" 2>/dev/null | wc -l
  echo ""
done
```

Create inventory table:

| Crate | Public Items | Export Surface | Has Tests | Has Benches | Key Role |
|-------|-------------|----------------|-----------|-------------|----------|
| hgdb-common | ? | ? | ? | Shared types, errors |
| hgdb-storage | ? | ? | ? | WAL, segments, MVCC |
| ... | ... | ... | ... | ... |

#### Step 3: Map Inter-Crate Dependencies

```bash
# For each crate, find workspace dependencies
for crate_dir in crates/*/; do
  name=$(grep '^name' "$crate_dir/Cargo.toml" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  deps=$(grep 'path = ' "$crate_dir/Cargo.toml" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' | tr '\n' ', ')
  echo "$name → $deps"
done
```

#### Step 4: Extract Public API Per Crate

For each crate, identify the actual export surface:

```bash
for crate_dir in crates/*/; do
  name=$(grep '^name' "$crate_dir/Cargo.toml" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  echo "=== $name ==="
  echo "-- crate root exports --"
  sed -n '1,200p' "$crate_dir/src/lib.rs" 2>/dev/null | grep -E '^(pub use|pub mod|mod |use )'
  echo "-- public items --"
  grep -rh "^pub " "$crate_dir/src/" --include="*.rs" 2>/dev/null | head -30
  echo ""
done
```

**Important:** raw `pub` count is not the same as exported API.

- Some `pub` items are internal to the crate and never re-exported.
- Some crates export through `pub use` from submodules.
- Some functionality is reachable only via feature flags.
- Some packages export through `package.json` `exports` or `src/index.ts`, not by scanning every file.

Document the surface that consumers actually reach first; treat raw `pub` / `export` counts as a discovery aid, not the source of truth.

#### Step 5: Identify Key Files Per Crate

```bash
for crate_dir in crates/*/; do
  name=$(grep '^name' "$crate_dir/Cargo.toml" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  echo "=== $name ==="
  find "$crate_dir/src" -name "*.rs" | sort
  echo ""
done
```

#### Step 5a: Identify Hidden Wiring Files

For each member, identify files that make the module/package actually usable:

- crate/package roots: `src/lib.rs`, `src/main.rs`, `src/index.ts`, barrel files
- manifests: `Cargo.toml`, `package.json`, exports maps, feature flags
- registration points: routers, plugin registries, startup/bootstrap files, DI containers
- generated or feature-gated entry points that shape the public surface

Create a wiring inventory:

| Member | Wiring Files | Why They Matter |
|--------|--------------|-----------------|
| hgdb-storage | `src/lib.rs`, `Cargo.toml` | exports modules, feature flags |
| api-server | `src/index.ts`, `src/app.ts` | route registration, app bootstrap |

**Rule:** if a future code change would require touching a file to make new functionality reachable, that file belongs in the member CLAUDE.md.

#### Step 6: Check for Tests and Benchmarks

```bash
for crate_dir in crates/*/; do
  name=$(grep '^name' "$crate_dir/Cargo.toml" | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  tests=$(find "$crate_dir" -name "*.rs" -path "*/tests/*" 2>/dev/null | wc -l)
  benches=$(find "$crate_dir" -name "*.rs" -path "*/benches/*" 2>/dev/null | wc -l)
  cfg_tests=$(grep -rl "#\[cfg(test)\]" "$crate_dir/src/" --include="*.rs" 2>/dev/null | wc -l)
  echo "$name: $tests integration tests, $cfg_tests files with unit tests, $benches benchmarks"
done
```

#### Step 6a: Identify Runtime Entry Points and Cross-Member Consumers

For each member, answer:

- Who calls this member?
- How is it reached at runtime?
- Which files import it or register it?
- Which examples or tests exercise its real public surface?

Do not invent usage snippets. Prefer real consumers from the workspace.

### For Node.js/TypeScript Monorepos

Use the same phases but with Node tooling:

```bash
# Find packages
ls -d packages/*/package.json apps/*/package.json 2>/dev/null

# Count exports
for pkg in packages/*/; do
  name=$(jq -r '.name' "$pkg/package.json" 2>/dev/null)
  count=$(grep -c "^export" "$pkg/src/index.ts" 2>/dev/null || echo 0)
  echo "$name: $count exports"
done
```

### Phase 1 Gate

Before proceeding, you MUST have:

- [ ] List of ALL crates/packages with public API counts
- [ ] Actual exported/public surface for each member
- [ ] Inter-crate dependency map
- [ ] Key files per crate
- [ ] Wiring/registration file inventory
- [ ] Test and benchmark inventory
- [ ] Role description for each crate (1-line purpose)

---

## Phase 2: Per-Crate CLAUDE.md Generation

**Gate: EVERY crate has a CLAUDE.md.**

### Required Sections Per Crate (Rust)

Every per-crate CLAUDE.md MUST have:

| Section | Purpose | Format |
|---------|---------|--------|
| **Header** | Crate name + 1-line purpose | `# hgdb-storage` + paragraph |
| **Public API** | Actual exported surface | Table: Item, Kind, Purpose, Source |
| **Key Files** | Source files with descriptions | Table: File, Purpose |
| **Dependencies** | Which workspace crates are imported | Bullet list with what's used |
| **Wiring & Entry Points** | Hidden files that expose/register behavior | Table: File, Role |
| **Usage Pattern** | How other crates use this one | Code block with `use` statements |
| **Architecture** | Key design decisions for THIS crate | Bullet list |
| **Testing** | How to test, what test types exist | Commands + patterns |

### Required Sections Per Package (Node.js)

| Section | Purpose | Format |
|---------|---------|--------|
| **Header** | Package name + 1-line purpose | `# @scope/name` + paragraph |
| **Exports** | Actual exported surface | Table: Export, Kind, Purpose, Source |
| **Key Files** | Source files with descriptions | Table: File, Purpose |
| **Dependencies** | Which @scope/* packages are imported | Bullet list |
| **Wiring & Entry Points** | Barrels, app bootstrap, route/plugin registration | Table: File, Role |
| **Import Pattern** | How consumers import from this package | Code block |
| **Conventions** | Package-specific rules | Bullet list |
| **Testing** | How to test (if tests exist) | Command + pattern |

### Per-Crate Template (Rust)

````markdown
# hgdb-<name>

[1-2 sentence purpose. What does this crate do? What problem does it solve?]

## Public API

| Item | Kind | Purpose | Source |
|------|------|---------|--------|
| `StructName` | struct | What it represents | `src/lib.rs` re-export |
| `TraitName` | trait | What contract it defines | `src/trait_mod.rs` |
| `function_name` | fn | What it does | `src/lib.rs` |
| `ErrorType` | enum | Error variants for this crate | `src/error.rs` |

## Key Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Crate root, re-exports public API |
| `src/wal/mod.rs` | WAL writer, group commit, crash recovery |
| ... | ... |

## Dependencies

Imports from these workspace crates:

- `hgdb-common` — types: `RowId`, `TxnId`, errors: `HgdbError`
- `hgdb-types` — formats: `Bmap`, `Barr`, type coercion

## Wiring & Entry Points

| File | Role |
|------|------|
| `src/lib.rs` | Public export surface |
| `Cargo.toml` | Features, optional deps, crate metadata |
| `src/startup.rs` | Runtime registration/bootstrap (if applicable) |

## Usage Pattern

```rust
use hgdb_storage::{Wal, Memtable, SegmentWriter, Reader};
use hgdb_storage::btree::BTreeIndex;
```

## Architecture

- [Key design decisions specific to THIS crate]
- [What's locked in CLAUDE.md that affects this crate]
- [What is NOT in this crate (common confusion points)]

## Testing

```bash
cargo test -p hgdb-<name>
cargo test -p hgdb-<name> -- --ignored  # slow/integration tests
```

- Unit tests: `#[cfg(test)]` modules in source files
- Integration tests: `tests/` directory
- Proptest: `proptest!` blocks for invariant checking
- Benchmarks: `benches/` directory (if applicable)
````

### Content Quality Rules

1. **Public API table must describe the actual exported surface** — not just raw `pub` items
2. **If a member exports via barrel/root files, document the barrel/root first**
3. **Key files must list all source files that matter plus all hidden wiring files**
4. **Dependencies must be actual imports** — grep the source, don't guess
5. **Usage patterns must show real examples** — from actual consumers in the workspace
6. **Architecture must reference root CLAUDE.md decisions** — if the root locks a decision that affects this member, say so
7. **Call out what is not owned here** — common confusion points, delegated responsibility, upstream/downstream owners
8. **Run a drift check** — if docs say "not implemented" but code exists, or docs imply exported surface that is unreachable, fix the docs
9. **No prose paragraphs** — tables and bullet lists only. Save tokens.

### Size Guide

| Crate Complexity | Target Lines | Example |
|-----------------|-------------|---------|
| Foundation (types, errors) | 50-80 | hgdb-common, hgdb-types |
| Engine (moderate API) | 80-150 | hgdb-doc, hgdb-sql |
| Core (large API) | 150-200 | hgdb-storage |
| Binary (entry point) | 50-80 | hgdb |

---

## Phase 3: Root Simplification

**Gate: Root CLAUDE.md simplified. No per-crate detail in root.**

**CRITICAL: NEVER remove or modify locked architectural decisions in root CLAUDE.md.** The root CLAUDE.md may contain steering decisions, locked architecture, testing requirements, competitive positioning, and other project-level constraints that are NOT per-crate detail. These MUST be preserved exactly as-is. Only move per-crate detail (public API tables, file listings, crate-specific patterns) to per-crate files. When in doubt, leave it in root.

### What STAYS in Root CLAUDE.md (DO NOT TOUCH)

- Project name + core principle
- **ALL locked architectural decisions** (even if they mention specific crates — they are project-wide constraints)
- Workspace layout table (crate name + 1-line purpose)
- Global conventions (Rust edition, clippy config, testing policy)
- Testing requirements section
- Competitive positioning, branding
- Reference to docs/ for detailed specs

### What MOVES to Per-Crate CLAUDE.md

- Per-crate public API listings (if any exist in root — unlikely for a well-structured root)
- Per-crate file descriptions
- Per-crate wiring/registration notes
- Crate-specific testing instructions (not the global testing policy)

### Root Simplification Checklist

- [ ] Root CLAUDE.md architectural decisions are UNCHANGED (diff check — no deletions in architecture sections)
- [ ] Root CLAUDE.md is ≤ 300 lines (if already under, no simplification needed)
- [ ] No per-crate public API detail in root
- [ ] Per-crate CLAUDE.md does not repeat root conventions verbatim

---

## Phase 4: Verification (MANDATORY)

**Gate: ALL checks pass before marking complete.**

### Check 1: Coverage

```bash
# Count crates that need CLAUDE.md
TOTAL=$(find crates/ -name "Cargo.toml" -maxdepth 2 | wc -l)
GENERATED=$(find crates/ -name "CLAUDE.md" -maxdepth 2 | wc -l)
echo "Coverage: $GENERATED / $TOTAL"
```

**FAIL if:** Any crate is missing CLAUDE.md

### Check 2: Public API Completeness

For each crate, verify public API coverage:

```bash
for crate_dir in crates/*/; do
  actual=$(grep -rh "^pub " "$crate_dir/src/" --include="*.rs" 2>/dev/null | wc -l)
  documented=$(grep -c "^|" "$crate_dir/CLAUDE.md" 2>/dev/null || echo 0)
  name=$(basename "$crate_dir")
  echo "$name: $documented documented / $actual pub items"
done
```

**But do not stop there.** This check is only a coarse signal.

Also verify:

- [ ] `lib.rs` / barrel exports are represented in the docs
- [ ] feature-gated exports are called out when relevant
- [ ] documented API is reachable from the consumer surface, not just `pub` internally

### Check 3: Context Budget

```bash
wc -l CLAUDE.md
for f in crates/*/CLAUDE.md; do wc -l "$f"; done
```

**FAIL if:**
- Root CLAUDE.md > 300 lines
- Any per-crate CLAUDE.md > 200 lines

### Check 4: Self-Containment

For each per-crate CLAUDE.md, verify it answers:

- [ ] What does this crate do? (header)
- [ ] What does it export? (public API table)
- [ ] What files does it contain? (key files)
- [ ] What does it depend on? (dependencies)
- [ ] What files expose or register it? (wiring/entry points)
- [ ] How do I use it? (usage pattern)
- [ ] How do I test it? (testing section)

### Check 5: No Duplication

- [ ] Root CLAUDE.md has no per-crate public API listings
- [ ] Per-crate CLAUDE.md does not repeat root architectural decisions verbatim

### Check 6: Wiring and Drift

For each member, verify:

- [ ] hidden wiring files are documented
- [ ] startup/bootstrap/registration points are called out when applicable
- [ ] manifests that shape exports/features are documented when relevant
- [ ] no stale claims like "not implemented yet" when the code exists
- [ ] no stale claims that something is exported/registered when it is not actually reachable

---

## Quality Checklist (Must Score 10/10)

| Category | 0 | 1 | 2 |
|----------|---|---|---|
| **Coverage** | Some members missing | All have CLAUDE.md but incomplete | Every member complete |
| **API Surface Accuracy** | Raw visibility only | Mostly accurate | Real exported surface documented |
| **Self-Containment + Wiring** | Missing key basics | Mostly standalone | Fully standalone with wiring points |
| **Root Simplification** | Root has per-member detail | Some moved | Root ≤300 lines, clean |
| **Drift + Efficiency** | Stale or duplicated | Minor drift/duplication | No stale claims, efficient context |

**Total: 10/10 required to complete this skill**

---

## Quick Workflow Summary

```
PHASE 1: DISCOVERY (Do not skip)
├── Detect project type (Cargo workspace or Node monorepo)
├── Find all crates/packages
├── Count visible public items per member
├── Identify actual exported/public surface
├── Map inter-crate dependencies
├── List key files per crate
├── Identify wiring files and runtime entry points
├── Check for tests and benchmarks
└── Gate: Complete inventory

PHASE 2: PER-CRATE CLAUDE.md (Every crate)
├── Header + purpose
├── Public API table (actual exported surface)
├── Key files table
├── Dependencies list
├── Wiring & entry points
├── Usage patterns
├── Architecture notes (reference root decisions)
├── Testing instructions
└── Gate: Every crate has CLAUDE.md

PHASE 3: ROOT SIMPLIFICATION
├── Push per-crate detail to crate CLAUDE.md
├── Slim root to ≤300 lines
├── Keep only project-wide info in root
└── Gate: Root simplified, no duplication

PHASE 4: VERIFICATION (All must pass)
├── Check 1: Every crate has CLAUDE.md
├── Check 2: API surface documented accurately
├── Check 3: Context budget met
├── Check 4: Self-containment verified
├── Check 5: No duplication
├── Check 6: Wiring and drift verified
└── Gate: All checks pass

COMPLETE: Announce final quality score (must be 10/10)
```

---

## Integration with Other Skills

- **`map-project`** — Use for single-crate projects or root-only updates
- **`start`** — Start skill identifies if workspace docs are needed
- **`commit`** — After generating CLAUDE.md files, commit them

---

_This skill ensures every crate in a workspace has focused, self-contained documentation that loads exactly when Claude needs it._
