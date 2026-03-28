# Per-Crate / Per-Package CLAUDE.md Template

Use the appropriate template based on project type. Replace ALL placeholders with actual values from Phase 1 discovery.

---

## Rust Crate Template

````markdown
# hgdb-<name>

[1-2 sentence purpose. What does this crate do? What problem does it solve?]

## Public API ([N] items)

| Item | Kind | Purpose |
|------|------|---------|
| `TypeName` | struct | What it represents |
| `TraitName` | trait | What contract it defines |
| `function_name` | fn | What it does |
| `ErrorType` | enum | Error variants for this crate |

## Key Files

| File | Purpose |
|------|---------|
| `src/lib.rs` | Crate root, re-exports public API |
| `src/module/mod.rs` | [What this module does] |
| ... | ... |

## Dependencies

Imports from these workspace crates:

- `hgdb-common` — types: `RowId`, `TxnId`; errors: `HgdbError`
- `hgdb-types` — formats: `Bmap`, `Barr`; coercion: `coerce_type`

External dependencies:

- `tokio` — async runtime
- `bytes` — zero-copy buffer sharing

## Usage Pattern

```rust
// How other crates use this one
use hgdb_<name>::{TypeA, TypeB, function_a};
```

## Architecture

- [Key design decisions specific to THIS crate]
- [What's locked in root CLAUDE.md that affects this crate]
- [What is NOT in this crate (common confusion points)]

## Testing

```bash
cargo test -p hgdb-<name>
cargo test -p hgdb-<name> -- --ignored  # slow/integration tests
cargo bench -p hgdb-<name>              # if benchmarks exist
```

- Unit tests: `#[cfg(test)]` modules in source files
- Integration tests: `tests/` directory
- Proptest: invariant checking (if applicable)
- Benchmarks: `benches/` directory (if applicable)
````

---

## Node.js/TypeScript Package Template

````markdown
# @scope/package-name

[1-2 sentence purpose. What does this package do? What problem does it solve?]

## Exports ([N] total)

| Export | Kind | Purpose |
|--------|------|---------|
| ExportName | type/interface/function/class/const | What it does |
| ... | ... | ... |

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, re-exports all public API |
| `src/parser.ts` | [What it does] |
| ... | ... |

## Dependencies

Imports from these monorepo packages:

- `@scope/contracts` — types: `TypeA`, `TypeB`
- `@scope/config` — paths: `functionA`, `CONSTANT_B`

## Import Pattern

```typescript
import { ExportA, ExportB } from "@scope/package-name";
import type { TypeA, TypeB } from "@scope/package-name";
```

## Conventions

- [Package-specific conventions]
- [Build tool: tsc or tsup]

## Testing

```bash
pnpm --filter @scope/package-name test
```
````

---

## Size Guidelines

| Crate/Package Type | Target Lines | Notes |
|-------------------|-------------|-------|
| Foundation (types, errors, config) | 50-80 | Large API table, minimal prose |
| Engine (moderate API surface) | 80-150 | Focused, clear boundaries |
| Core (large API, many modules) | 150-200 | May need sub-sections |
| Binary (entry point) | 50-80 | Wiring only |

## Rules

1. **Every `pub` item must appear in the Public API table** — no exceptions
2. **Every source file must appear in Key Files** — with accurate descriptions
3. **Dependencies must be actual imports** — grep the source, don't guess
4. **Usage patterns must show real examples** — from actual consumers in the workspace
5. **No prose paragraphs** — tables and bullet lists ONLY
6. **No duplication with root** — don't repeat global conventions

## Examples of Good vs Bad

**Bad public API row:**
```
| Wal | struct | WAL struct |
```

**Good public API row:**
```
| Wal | struct | Write-ahead log with group commit, crash recovery, and engine hint filtering |
```

**Bad key file:**
```
| `src/utils.rs` | Utilities |
```

**Good key file:**
```
| `src/wal/writer.rs` | Append-only WAL writer with group commit batching and fsync |
```
