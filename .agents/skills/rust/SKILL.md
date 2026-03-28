---
name: rust
version: 1.0.0
description: |
  Rust systems programming — storage engines, binary formats, SIMD, wire protocols,
  DataFusion/Arrow, tantivy search, HNSW vectors, arena allocation, graph engines,
  R-tree geo, async tokio, mmap, MVCC, zero-copy, io_uring.
  Use when working on any Rust crate involving database internals, storage, query
  execution, network protocols, search, vectors, or high-performance data structures.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

<EXTREMELY-IMPORTANT>
These rules apply to ALL Rust code you write. Violating any produces unsafe, slow, or unmaintainable output.

1. **Safe Rust by default.** `unsafe` only in storage hot paths: mmap, SIMD intrinsics, arena internals. Every `unsafe` block gets a `// SAFETY:` comment explaining the invariant.
2. **Zero-copy where possible.** mmap'd segments, `&str`/`&[u8]` references into pages, SIMD on contiguous arrays. Never copy data between storage and execution without reason.
3. **Narrow on disk, wide in execution.** Store the tightest encoding. Widen to uniform register-sized types (I64, F64) for SIMD and branch-free processing.
4. **Trait-based abstraction.** Pluggable backends, storage providers, distance metrics — all behind traits. Concrete types for hot paths, `dyn Trait` only at configuration boundaries.
5. **Error types per crate.** `thiserror` enums. Never `anyhow` in library crates — only in binaries and tests. Never `unwrap()` in production code paths.
6. **Async with tokio.** All I/O is async. CPU-bound work (SIMD, compression, hashing) runs on `spawn_blocking` or dedicated threads. Never block the tokio runtime.
7. **Property tests for invariants.** `proptest` for serialization round-trips, type coercion, binary format parsing. Unit tests for logic. Integration tests for cross-crate behavior.
8. **Workspace crate structure.** One crate per subsystem. Depend downward — never circular. Storage at the bottom, server at the top.
</EXTREMELY-IMPORTANT>

# Rust Systems Programming

## MANDATORY FIRST RESPONSE PROTOCOL

Before writing any Rust code:

1. Identify which subsystem the task touches
2. Read the matching reference file(s) from the routing table
3. Check crate dependencies — is this a library crate (thiserror) or binary (anyhow)?
4. State the approach before implementing

## Routing Table

| Task / Area | Read |
|---|---|
| Toolchain, workspace layout, key crates, Cargo conventions | `references/stack.md` |
| WAL, mmap, segments, MVCC, compaction, io_uring, backends | `references/storage-engine.md` |
| Custom on-disk formats, zero-copy parsing, packed structs | `references/binary-formats.md` |
| Database type system, disk/exec types, Arrow interop | `references/type-system.md` |
| DataFusion table providers, UDFs, Arrow RecordBatch, planning | `references/datafusion-arrow.md` |
| pgwire server, MySQL protocol, dialect mapping, ORM compat | `references/wire-protocols.md` |
| tantivy FTS, HNSW vectors, SIMD distance, hybrid search | `references/search-vector.md` |
| bumpalo arenas, graph adjacency, traversal algorithms | `references/arena-graph.md` |
| R-tree spatial index, geo predicates, WGS84 distance | `references/geo-rtree.md` |
| tokio async, io_uring, crossbeam, lock-free structures, MVCC | `references/async-concurrency.md` |
| proptest, deterministic testing, integration test patterns | `references/testing.md` |
| thiserror hierarchies, unsafe patterns, safety invariants | `references/error-unsafe.md` |

Multiple tasks? Read multiple files.

## Quick Rules

1. `cargo fmt` before commit. `cargo clippy -- -D warnings` must pass.
2. Explicit `use` imports — no glob imports except in test modules.
3. `#[must_use]` on functions returning `Result` or computed values.
4. `#[inline]` only on small functions called in hot loops — never on public API.
5. Feature flags for optional crate dependencies — `#[cfg(feature = "tantivy")]`.
6. `Send + Sync` bounds on all trait objects that cross async boundaries.
7. Prefer `&[u8]` over `Vec<u8>` in function signatures. Own data at boundaries, borrow inside.
8. `#[derive(Debug)]` on all public types. `#[derive(Clone)]` only when cheap.
9. Document all public items. `//!` module docs. `///` item docs with examples.
10. Integration tests in `tests/` directory. Unit tests in `#[cfg(test)] mod tests`.
