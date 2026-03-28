# Per-App / Per-Binary CLAUDE.md Template

Use the appropriate template based on project type. Apps/binaries are more complex than library crates/packages and need type-specific sections.

---

## Rust Binary Crate Template

````markdown
# hgdb

[1-2 sentence purpose. What does this binary do?]

## Commands

| Task | Command |
|------|---------|
| Build | `cargo build -p hgdb` |
| Run | `cargo run -p hgdb -- [args]` |
| Release build | `cargo build -p hgdb --release` |
| Test | `cargo test -p hgdb` |

## Entry Point

| File | Purpose |
|------|---------|
| `src/main.rs` | Binary entry — parses CLI args, wires crates together, starts server |

## Dependencies

| Crate | Used For |
|-------|----------|
| `hgdb-server` | pgwire + HTTP server startup |
| `hgdb-sql` | DataFusion SessionContext, catalog setup |
| `hgdb-storage` | Storage engine initialization |
| ... | ... |

## Startup Flow

```
1. Parse CLI args / load config (hgdb.toml)
2. Initialize storage (WAL replay, segment registry)
3. Build catalog from WAL (schema recovery)
4. Register TableProviders with DataFusion
5. Start pgwire listener on :5432
6. Start HTTP listener on :8080 (if enabled)
7. Ready to accept connections
```

## Feature Flags

| Flag | What it enables |
|------|----------------|
| `sql` (default) | SQL engine via hgdb-sql |
| `pgwire` (default) | Postgres wire protocol |
| `http` | HTTP/REST API |
````

---

## Node.js API Server App — Template

````markdown
# @scope/app-name

[1-2 sentence purpose.]

## Commands

| Task | Command |
|------|---------|
| Build | `pnpm --filter @scope/app-name build` |
| Start | `[start command]` |
| Test | `[test command]` |

## Routes

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/api/health` | GET | `system.ts:health` | Health check |
| ... | ... | ... | ... |

## Dependencies

| Package | Used For |
|---------|----------|
| `@scope/contracts` | Types: `TypeA`, `TypeB` |
| ... | ... |
````

---

## Node.js CLI App — Template

````markdown
# @scope/cli-name

[1-2 sentence purpose.]

## Commands

| Command | Purpose | File |
|---------|---------|------|
| `init` | Initialize project | `commands/init.ts` |
| ... | ... | ... |

## Dependencies

| Package | Used For |
|---------|----------|
| `@scope/contracts` | Types |
| ... | ... |
````

---

## Size Guidelines

| App Type | Target Lines | Notes |
|----------|-------------|-------|
| Rust binary | 50-100 | Startup flow is the key section |
| API server | 150-250 | Route table is largest |
| CLI tool | 120-200 | Command + hook tables |
| Web UI | 120-200 | Pages + components |

## Rules

1. **Entry points must explain the startup flow** — what happens when the binary/app starts
2. **Dependencies must show what's used** — not just crate/package names
3. **Feature flags / commands must be COMPLETE**
4. **No prose paragraphs** — tables and bullet lists ONLY
5. **No duplication with root** — don't repeat global conventions
