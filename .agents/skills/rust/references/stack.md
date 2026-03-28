# Stack — Toolchain, Workspace Layout, Crate Ecosystem, Cargo Conventions

Every other reference file assumes these decisions. Do not deviate.

## Toolchain

| Tool | Version / Channel | Purpose |
|---|---|---|
| Rust | Edition 2021, stable channel | All production code compiles on stable |
| MSRV | 1.75+ | Async traits, C-string literals, `impl Trait` in return position everywhere |
| `cargo fmt` | Default `rustfmt.toml` | Run on every save. CI fails on unformatted code. |
| `cargo clippy` | `-- -D warnings` | All warnings are errors. No `#[allow]` without a comment explaining why. |
| `cargo miri` | Nightly (CI only) | Validates all `unsafe` blocks. Run on every PR that touches `unsafe`. |
| `cargo deny` | Latest | License audit, duplicate crate detection, advisory DB |
| `cargo bench` | Built-in + criterion | Performance regression tracking |

### `rustfmt.toml`

```toml
edition = "2021"
max_width = 100
use_small_heuristics = "Max"
imports_granularity = "Crate"
group_imports = "StdExternalCrate"
```

### `clippy.toml`

```toml
msrv = "1.75"
```

Enable additional lint groups in the workspace root `Cargo.toml`:

```toml
[workspace.lints.clippy]
pedantic = { level = "warn", priority = -1 }
nursery = { level = "warn", priority = -1 }
unwrap_used = "warn"
expect_used = "warn"
```

### Cross-compilation targets

| Target | Use case | Install |
|---|---|---|
| `x86_64-unknown-linux-musl` | Static Linux binaries (Docker scratch) | `rustup target add x86_64-unknown-linux-musl` |
| `aarch64-unknown-linux-musl` | ARM64 Linux (Graviton, ARM servers) | `rustup target add aarch64-unknown-linux-musl` |
| `x86_64-apple-darwin` | macOS Intel | `rustup target add x86_64-apple-darwin` |
| `aarch64-apple-darwin` | macOS Apple Silicon | Default on M-series Macs |
| `wasm32-wasip1` | WASI plugin execution | `rustup target add wasm32-wasip1` |

Build static musl binary:

```bash
cargo build --release --target x86_64-unknown-linux-musl
```

### CI validation pipeline

Run in this order. Fail fast.

```bash
# 1. Format check
cargo fmt --all -- --check

# 2. Lint
cargo clippy --workspace --all-targets --all-features -- -D warnings

# 3. Test
cargo test --workspace --all-features

# 4. Miri (unsafe validation — nightly only)
cargo +nightly miri test --workspace

# 5. Deny (license + advisory audit)
cargo deny check

# 6. Build release
cargo build --release --workspace
```

## Workspace Structure

Realistic multi-crate database engine workspace:

```
project-root/
├── Cargo.toml              # [workspace] definition + shared deps
├── Cargo.lock              # Committed — this is a binary/application project
├── rustfmt.toml
├── clippy.toml
├── deny.toml
├── .cargo/
│   └── config.toml         # Linker overrides, target defaults
├── crates/
│   ├── storage/            # WAL, segments, mmap, MVCC, compaction
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── wal.rs      # Write-ahead log
│   │       ├── segment.rs  # Immutable segment files
│   │       ├── mmap.rs     # Memory-mapped I/O
│   │       ├── mvcc.rs     # Multi-version concurrency control
│   │       └── compaction.rs
│   ├── types/              # Shared type system — disk format + execution types
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── datum.rs    # Runtime value representation
│   │       ├── schema.rs   # Column types, table schemas
│   │       └── encoding.rs # Binary encode/decode for on-disk format
│   ├── planner/            # Query router, cost-based optimizer
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── optimizer.rs
│   │       └── router.rs   # Routes queries to SQL/search/vector/graph
│   ├── sql/                # DataFusion-backed SQL execution
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── provider.rs # Custom TableProvider implementations
│   │       └── udf.rs      # User-defined functions
│   ├── search/             # Tantivy full-text search integration
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── index.rs    # Index build, merge
│   │       └── query.rs    # BM25 queries, facets, highlights
│   ├── vector/             # HNSW index, SIMD distance functions
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── hnsw.rs     # Hierarchical navigable small world graph
│   │       ├── distance.rs # Cosine, L2, dot — SIMD accelerated
│   │       └── quantize.rs # Product quantization, scalar quantization
│   ├── graph/              # Arena-allocated adjacency list graph engine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── arena.rs    # bumpalo arena for graph nodes/edges
│   │       └── traverse.rs # BFS, DFS, shortest path
│   ├── geo/                # R-tree spatial index
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       └── rtree.rs    # rstar-backed spatial queries
│   ├── temporal/           # Bi-temporal versioning
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       └── bitemporal.rs  # valid-time + transaction-time
│   ├── server/             # Network layer — pgwire, HTTP, WebSocket
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── pgwire.rs   # Postgres wire protocol handler
│   │       ├── http.rs     # REST + health endpoints (axum)
│   │       └── ws.rs       # WebSocket streaming results
│   └── common/             # Shared utilities — error types, config, metrics
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── error.rs    # Unified error enum (thiserror)
│           ├── config.rs   # TOML config loading
│           └── metrics.rs  # Prometheus metrics helpers
├── src/
│   └── main.rs             # Binary entry point — wires crates together
├── benches/
│   ├── storage_bench.rs    # WAL write throughput, segment scan speed
│   └── vector_bench.rs     # HNSW query latency, distance function throughput
└── tests/
    └── integration/
        ├── sql_test.rs
        └── pgwire_test.rs
```

### Workspace `Cargo.toml`

```toml
[workspace]
resolver = "2"
members = [
    "crates/storage",
    "crates/types",
    "crates/planner",
    "crates/sql",
    "crates/search",
    "crates/vector",
    "crates/graph",
    "crates/geo",
    "crates/temporal",
    "crates/server",
    "crates/common",
]

[workspace.package]
edition = "2021"
rust-version = "1.75"
license = "Apache-2.0"
repository = "https://github.com/org/project"

[workspace.lints.clippy]
pedantic = { level = "warn", priority = -1 }
nursery = { level = "warn", priority = -1 }
unwrap_used = "warn"
expect_used = "warn"

[workspace.lints.rust]
unsafe_op_in_unsafe_fn = "warn"
missing_docs = "warn"

# --- Shared dependency versions (consumed via workspace = true) ---
[workspace.dependencies]
tokio = { version = "1.43", features = ["rt-multi-thread", "io-util", "net", "sync", "macros", "signal", "fs"] }
bytes = "1.9"
arrow = { version = "54", features = ["prettyprint"] }
datafusion = "44"
tantivy = "0.22"
pgwire = "0.28"
axum = { version = "0.8", features = ["ws", "macros"] }
tower = { version = "0.5", features = ["timeout", "limit"] }
tower-http = { version = "0.6", features = ["cors", "trace", "compression-gzip"] }
memmap2 = "0.9"
bumpalo = { version = "3.16", features = ["collections"] }
rstar = "0.12"
crossbeam = "0.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
thiserror = "2"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
crc32fast = "1.4"
zerocopy = { version = "0.8", features = ["derive"] }
byteorder = "1"
ring = "0.17"
proptest = "1"
criterion = { version = "0.5", features = ["html_reports"] }
rand = "0.8"
uuid = { version = "1", features = ["v7", "serde"] }
parking_lot = "0.12"
dashmap = "6"
futures = "0.3"
pin-project-lite = "0.2"

# Linux-only
[target.'cfg(target_os = "linux")'.workspace.dependencies]
io-uring = "0.7"

# Optional / feature-gated
wasmtime = "27"

# --- Root binary ---
[package]
name = "mydb"
edition.workspace = true
rust-version.workspace = true
version = "0.1.0"

[dependencies]
mydb-storage = { path = "crates/storage" }
mydb-types = { path = "crates/types" }
mydb-planner = { path = "crates/planner" }
mydb-sql = { path = "crates/sql" }
mydb-search = { path = "crates/search" }
mydb-vector = { path = "crates/vector" }
mydb-graph = { path = "crates/graph" }
mydb-geo = { path = "crates/geo" }
mydb-temporal = { path = "crates/temporal" }
mydb-server = { path = "crates/server" }
mydb-common = { path = "crates/common" }
tokio.workspace = true
anyhow.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
serde.workspace = true
toml.workspace = true

[dev-dependencies]
proptest.workspace = true
criterion.workspace = true

[[bench]]
name = "storage_bench"
harness = false

[[bench]]
name = "vector_bench"
harness = false

# --- Profiles ---
[profile.release]
lto = "fat"
codegen-units = 1
strip = "symbols"
panic = "abort"
opt-level = 3

[profile.release.build-override]
opt-level = 3

[profile.bench]
inherits = "release"
debug = 2          # Debug symbols for profiling without sacrificing optimization

[profile.dev]
opt-level = 1      # Slightly faster dev builds for large workspaces
split-debuginfo = "unpacked"

[profile.dev.package."*"]
opt-level = 2      # Optimize dependencies even in dev
```

### Individual crate `Cargo.toml` (example: `crates/storage`)

```toml
[package]
name = "mydb-storage"
version = "0.1.0"
edition.workspace = true
rust-version.workspace = true

[lints]
workspace = true

[features]
default = []
io-uring = ["dep:io-uring"]  # Linux-only async I/O
serde = ["dep:serde"]        # Serialization support (off by default for lib crates)

[dependencies]
mydb-types = { path = "../types" }
mydb-common = { path = "../common" }
tokio.workspace = true
bytes.workspace = true
memmap2.workspace = true
crc32fast.workspace = true
crossbeam.workspace = true
parking_lot.workspace = true
tracing.workspace = true
thiserror.workspace = true
zerocopy.workspace = true
byteorder.workspace = true
serde = { workspace = true, optional = true }

[target.'cfg(target_os = "linux")'.dependencies]
io-uring = { workspace = true, optional = true }

[dev-dependencies]
proptest.workspace = true
tempfile = "3"
```

### Feature flag patterns

Feature flags control optional functionality. Library crates expose features; the binary crate enables them.

```toml
# In a library crate (crates/vector/Cargo.toml):
[features]
default = []
simd = []                       # Enable hand-tuned SIMD distance functions
quantization = []               # Product quantization support
wasm-plugins = ["dep:wasmtime"] # WASM UDF execution
serde = ["dep:serde"]           # Serialize index metadata

# In the root binary Cargo.toml:
[dependencies]
mydb-vector = { path = "crates/vector", features = ["simd", "quantization"] }
```

## Key Crate Ecosystem

| Crate | Version | Purpose | Notes |
|---|---|---|---|
| `tokio` | 1.43 | Async runtime | `rt-multi-thread`, `io-util`, `net`, `sync`, `macros`, `signal`, `fs` |
| `memmap2` | 0.9 | Memory-mapped files | Segment reads, vector storage, read-only mmap for hot data |
| `datafusion` | 44 | SQL query engine | `TableProvider` for custom storage, UDFs, vectorized execution |
| `arrow` | 54 | Columnar memory format | Zero-copy IPC, compute kernels, record batches |
| `tantivy` | 0.22 | Full-text search | BM25, custom tokenizers, faceted search, concurrent indexing |
| `pgwire` | 0.28 | Postgres wire protocol | Server-side implementation, extended query protocol |
| `axum` | 0.8 | HTTP framework | REST endpoints, WebSocket upgrade, Tower middleware |
| `bumpalo` | 3.16 | Arena allocator | Graph nodes, temp per-query allocations, zero-drop arenas |
| `rstar` | 0.12 | R-tree spatial index | Nearest neighbor, envelope queries, bulk loading |
| `crossbeam` | 0.8 | Lock-free structures | Channels, skip lists, epoch-based reclamation |
| `bytes` | 1.9 | Byte buffer abstraction | Network I/O, zero-copy slicing, `BytesMut` for building frames |
| `thiserror` | 2 | Derive `Error` | Library crates only |
| `anyhow` | 1 | Dynamic `Error` | Binary crate and tests only |
| `proptest` | 1 | Property-based testing | Round-trip encoding, invariant checking, fuzz-like coverage |
| `criterion` | 0.5 | Benchmarking | Statistical benchmarks with regression detection |
| `serde` + `serde_json` | 1 | Serialization | Config files, JSON wire format, always behind feature flag in libs |
| `tracing` | 0.1 | Structured logging | Spans, events, per-request trace IDs |
| `tracing-subscriber` | 0.3 | Log output | `env-filter` for per-module levels, `json` for production |
| `crc32fast` | 1.4 | CRC checksums | WAL integrity, segment verification, frame checksums |
| `io-uring` | 0.7 | Linux async I/O | Storage hot path, `O_DIRECT` reads — Linux only, feature-gated |
| `wasmtime` | 27 | WASM runtime | Plugin execution, sandboxed UDFs — optional, feature-gated |
| `ring` | 0.17 | Cryptography | SHA-256, AES-GCM, HMAC — no OpenSSL dependency |
| `zerocopy` | 0.8 | Zero-copy types | Packed struct to/from bytes, on-disk header parsing |
| `byteorder` | 1 | Endian-aware I/O | Binary format parsing, network byte order |
| `parking_lot` | 0.12 | Faster mutexes | Drop-in `Mutex`/`RwLock` replacement, no poisoning |
| `dashmap` | 6 | Concurrent hash map | Sharded lock-free reads, metadata caches |
| `uuid` | 1 | UUIDs | v7 (time-ordered) for primary keys, `serde` support |
| `tempfile` | 3 | Temp files/dirs | Test fixtures, atomic file writes via `persist()` |

### Crate usage examples

**tokio — async runtime bootstrap**

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("mydb=debug,tower_http=debug")
        .json()
        .init();

    let config = MyDbConfig::load("config.toml")?;
    let server = Server::bind(&config).await?;
    server.run().await
}
```

**memmap2 — memory-mapped segment reads**

```rust
use memmap2::Mmap;
use std::fs::File;

pub struct Segment {
    mmap: Mmap,
    len: u64,
}

impl Segment {
    pub fn open(path: &std::path::Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        // SAFETY: File is opened read-only. The segment file is immutable once written
        // (append-only WAL flushes produce new segments; existing ones are never modified).
        let mmap = unsafe { Mmap::map(&file)? };
        mmap.advise(memmap2::Advice::Sequential)?;
        Ok(Self { mmap, len })
    }

    pub fn read_at(&self, offset: usize, len: usize) -> &[u8] {
        &self.mmap[offset..offset + len]
    }
}
```

**thiserror — library error types**

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("WAL corrupted at offset {offset}: CRC mismatch (expected {expected:#010x}, got {actual:#010x})")]
    WalCorrupted { offset: u64, expected: u32, actual: u32 },

    #[error("segment {id} not found")]
    SegmentNotFound { id: u64 },

    #[error("write failed: disk full")]
    DiskFull,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
```

**crc32fast — WAL frame integrity**

```rust
use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use crc32fast::Hasher;

pub struct WalFrame {
    pub sequence: u64,
    pub payload: Vec<u8>,
    pub checksum: u32,
}

impl WalFrame {
    pub fn new(sequence: u64, payload: Vec<u8>) -> Self {
        let checksum = Self::compute_crc(sequence, &payload);
        Self { sequence, payload, checksum }
    }

    fn compute_crc(sequence: u64, payload: &[u8]) -> u32 {
        let mut h = Hasher::new();
        h.update(&sequence.to_be_bytes());
        h.update(payload);
        h.finalize()
    }

    pub fn encode(&self, buf: &mut Vec<u8>) {
        buf.write_u64::<BigEndian>(self.sequence).unwrap();
        buf.write_u32::<BigEndian>(self.payload.len() as u32).unwrap();
        buf.extend_from_slice(&self.payload);
        buf.write_u32::<BigEndian>(self.checksum).unwrap();
    }

    pub fn decode(cursor: &mut &[u8]) -> Result<Self, StorageError> {
        let sequence = cursor.read_u64::<BigEndian>()?;
        let len = cursor.read_u32::<BigEndian>()? as usize;
        let payload = cursor[..len].to_vec();
        *cursor = &cursor[len..];
        let stored_crc = cursor.read_u32::<BigEndian>()?;
        let computed_crc = Self::compute_crc(sequence, &payload);
        if stored_crc != computed_crc {
            return Err(StorageError::WalCorrupted {
                offset: 0,
                expected: stored_crc,
                actual: computed_crc,
            });
        }
        Ok(Self { sequence, payload, checksum: stored_crc })
    }
}
```

**zerocopy — zero-copy on-disk header**

```rust
use zerocopy::{FromBytes, IntoBytes, KnownLayout, Immutable};

#[derive(FromBytes, IntoBytes, KnownLayout, Immutable, Debug, Clone, Copy)]
#[repr(C, packed)]
pub struct SegmentHeader {
    pub magic: [u8; 4],      // b"MYDB"
    pub version: u8,
    pub _reserved: [u8; 3],
    pub entry_count: u64,
    pub data_offset: u64,
    pub index_offset: u64,
    pub checksum: u32,
    pub _padding: [u8; 4],
}

impl SegmentHeader {
    pub const MAGIC: [u8; 4] = *b"MYDB";
    pub const SIZE: usize = std::mem::size_of::<Self>();

    pub fn from_bytes(bytes: &[u8]) -> Option<&Self> {
        Self::ref_from_bytes(&bytes[..Self::SIZE]).ok()
    }
}
```

**bumpalo — arena-allocated graph traversal**

```rust
use bumpalo::Bump;

pub struct GraphNode<'a> {
    pub id: u64,
    pub edges: bumpalo::collections::Vec<'a, &'a GraphNode<'a>>,
}

pub fn bfs_shortest_path<'a>(
    arena: &'a Bump,
    start: u64,
    target: u64,
    adjacency: &impl Fn(u64) -> Vec<u64>,
) -> Option<Vec<u64>> {
    let mut queue = bumpalo::collections::Vec::new_in(arena);
    let mut visited = std::collections::HashSet::new();
    let mut parent = std::collections::HashMap::new();

    queue.push(start);
    visited.insert(start);

    while !queue.is_empty() {
        let current = queue.remove(0);
        if current == target {
            // Reconstruct path
            let mut path = vec![target];
            let mut node = target;
            while let Some(&prev) = parent.get(&node) {
                path.push(prev);
                node = prev;
            }
            path.reverse();
            return Some(path);
        }
        for neighbor in adjacency(current) {
            if visited.insert(neighbor) {
                parent.insert(neighbor, current);
                queue.push(neighbor);
            }
        }
    }
    None
}
```

**datafusion — custom TableProvider**

```rust
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use datafusion::catalog::Session;
use datafusion::datasource::{TableProvider, TableType};
use datafusion::error::Result;
use datafusion::execution::SendableRecordBatchStream;
use datafusion::logical_expr::Expr;
use datafusion::physical_plan::ExecutionPlan;
use std::sync::Arc;

pub struct MyTableProvider {
    schema: SchemaRef,
    // ... storage layer handle
}

#[async_trait::async_trait]
impl TableProvider for MyTableProvider {
    fn as_any(&self) -> &dyn std::any::Any { self }
    fn schema(&self) -> SchemaRef { self.schema.clone() }
    fn table_type(&self) -> TableType { TableType::Base }

    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        // Push down filters to storage layer, respect projection and limit
        todo!("Build execution plan from storage segments")
    }
}
```

**pgwire — Postgres wire protocol server**

```rust
use pgwire::api::auth::noop::NoopStartupHandler;
use pgwire::api::query::{PlaceholderExtendedQueryHandler, SimpleQueryHandler};
use pgwire::api::results::{DescribePortalResponse, DescribeStatementResponse, Response, QueryResponse, Tag};
use pgwire::api::{ClientInfo, MakeHandler, StatelessMakeHandler, Type};
use pgwire::error::{PgWireError, PgWireResult};
use pgwire::tokio::process_socket;

pub struct MyQueryHandler;

#[async_trait::async_trait]
impl SimpleQueryHandler for MyQueryHandler {
    async fn do_query<'a, C>(
        &self,
        _client: &mut C,
        query: &'a str,
    ) -> PgWireResult<Vec<Response<'a>>>
    where
        C: ClientInfo + Unpin + Send,
    {
        tracing::info!(query, "executing simple query");
        // Parse SQL, plan, execute, return results as Response
        todo!("Route to DataFusion or custom engine")
    }
}

pub async fn start_pgwire(addr: &str) -> anyhow::Result<()> {
    let handler = Arc::new(StatelessMakeHandler::new(Arc::new(MyQueryHandler)));
    let startup_handler = Arc::new(StatelessMakeHandler::new(Arc::new(NoopStartupHandler)));
    let extended_handler = Arc::new(StatelessMakeHandler::new(Arc::new(
        PlaceholderExtendedQueryHandler,
    )));

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("pgwire listening on {addr}");

    loop {
        let (socket, peer) = listener.accept().await?;
        tracing::debug!(?peer, "new connection");
        let h = handler.clone();
        let s = startup_handler.clone();
        let e = extended_handler.clone();
        tokio::spawn(async move {
            if let Err(err) = process_socket(socket, None, s, h, e).await {
                tracing::error!(?err, "connection error");
            }
        });
    }
}
```

**proptest — round-trip property testing**

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn wal_frame_roundtrip(
        sequence in 0u64..u64::MAX,
        payload in prop::collection::vec(any::<u8>(), 0..4096),
    ) {
        let frame = WalFrame::new(sequence, payload.clone());
        let mut buf = Vec::new();
        frame.encode(&mut buf);
        let mut cursor = buf.as_slice();
        let decoded = WalFrame::decode(&mut cursor).unwrap();
        assert_eq!(decoded.sequence, sequence);
        assert_eq!(decoded.payload, payload);
        assert_eq!(decoded.checksum, frame.checksum);
    }
}

proptest! {
    #[test]
    fn segment_header_roundtrip(
        entry_count in 0u64..1_000_000,
        data_offset in 0u64..u64::MAX,
        index_offset in 0u64..u64::MAX,
    ) {
        let header = SegmentHeader {
            magic: SegmentHeader::MAGIC,
            version: 1,
            _reserved: [0; 3],
            entry_count,
            data_offset,
            index_offset,
            checksum: 0,
            _padding: [0; 4],
        };
        let bytes = header.as_bytes();
        let restored = SegmentHeader::from_bytes(bytes).unwrap();
        assert_eq!(restored.entry_count, entry_count);
        assert_eq!(restored.data_offset, data_offset);
    }
}
```

**criterion — benchmarks**

```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId};

fn wal_write_benchmark(c: &mut Criterion) {
    let mut group = c.benchmark_group("wal_write");

    for payload_size in [64, 256, 1024, 4096, 16384] {
        group.bench_with_input(
            BenchmarkId::from_parameter(payload_size),
            &payload_size,
            |b, &size| {
                let payload = vec![0xABu8; size];
                b.iter(|| {
                    let frame = WalFrame::new(1, black_box(payload.clone()));
                    let mut buf = Vec::with_capacity(size + 16);
                    frame.encode(&mut buf);
                    black_box(buf);
                });
            },
        );
    }

    group.finish();
}

criterion_group!(benches, wal_write_benchmark);
criterion_main!(benches);
```

**tracing — structured logging setup**

```rust
use tracing_subscriber::{fmt, EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

pub fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            // Default: info for our crates, warn for dependencies
            "mydb=debug,mydb_storage=debug,mydb_server=debug,tower_http=debug,warn".into()
        }))
        .with(fmt::layer().json())  // JSON for production
        .init();
}

// Usage in code:
fn process_query(query_id: uuid::Uuid, sql: &str) {
    let _span = tracing::info_span!("query", %query_id, sql).entered();
    tracing::info!("planning");
    // ... work happens under this span
    tracing::info!(rows = 42, "execution complete");
}
```

## Cargo Conventions

### `[workspace.dependencies]` for shared versions

All dependency versions are declared once in the workspace root `Cargo.toml` under `[workspace.dependencies]`. Individual crates reference them with `workspace = true`:

```toml
# Root Cargo.toml
[workspace.dependencies]
tokio = { version = "1.43", features = ["rt-multi-thread", "io-util", "net", "sync", "macros"] }

# crates/storage/Cargo.toml
[dependencies]
tokio.workspace = true
```

Adding a new dependency: always add to `[workspace.dependencies]` first, then reference from the crate. Never put a version directly in a crate `Cargo.toml`.

### Release profile optimization

```toml
[profile.release]
lto = "fat"           # Full link-time optimization — slower builds, faster binaries
codegen-units = 1     # Single codegen unit for maximum optimization
strip = "symbols"     # Strip debug symbols from release binary
panic = "abort"       # No unwinding — smaller binary, avoids catch_unwind overhead
opt-level = 3         # Maximum optimization
```

For edge deployment where binary size matters:

```toml
[profile.release-small]
inherits = "release"
opt-level = "z"       # Optimize for size over speed
strip = "symbols"
```

### `cargo deny` configuration (`deny.toml`)

```toml
[advisories]
vulnerability = "deny"
unmaintained = "warn"
yanked = "warn"

[licenses]
allow = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0"]
confidence-threshold = 0.8

[bans]
multiple-versions = "warn"
wildcards = "deny"        # No wildcard version specs

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-git = []
```

### `.cargo/config.toml` — linker and target defaults

```toml
# Use mold linker on Linux for faster linking
[target.x86_64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]

[target.aarch64-unknown-linux-gnu]
linker = "clang"
rustflags = ["-C", "link-arg=-fuse-ld=mold"]

# Default to musl for release builds
# [build]
# target = "x86_64-unknown-linux-musl"

[net]
git-fetch-with-cli = true

[registries.crates-io]
protocol = "sparse"
```

## Dependency Rules

### Library crates vs binary crate

| Rule | Library crate (`crates/*`) | Binary crate (root `src/main.rs`) |
|---|---|---|
| Error handling | `thiserror` — typed, specific errors | `anyhow` — erase and propagate |
| `serde` | Behind `serde` feature flag | Direct dependency |
| `tracing` | Events and spans only | Subscriber initialization |
| `tokio` | Async functions, no `#[tokio::main]` | `#[tokio::main]` entry point |
| Panics | Never panic. Return `Result`. | Top-level `main` may use `?` with `anyhow` |

### `serde` behind feature flag in library crates

```toml
# crates/types/Cargo.toml
[features]
default = []
serde = ["dep:serde"]

[dependencies]
serde = { workspace = true, optional = true }
```

```rust
// crates/types/src/schema.rs
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<ColumnDef>,
}
```

### Version pinning

Pin major versions in `[workspace.dependencies]`. Use `cargo update` to bump patch/minor within the pinned range. Run `cargo deny check` in CI to catch duplicates and advisories.

```toml
# Pinned major versions — correct
tokio = { version = "1.43", ... }
serde = { version = "1", ... }

# Wildcard — forbidden (cargo deny will reject)
# tokio = "*"
```

### `unsafe` policy

- Every `unsafe` block requires a `// SAFETY:` comment explaining the invariant.
- `cargo miri test` runs in CI on every PR that touches files containing `unsafe`.
- Prefer `zerocopy` derive macros over hand-written `unsafe` transmutes.
- Prefer `parking_lot::Mutex` over `std::sync::Mutex` (no poisoning, smaller, faster).
- Audit all `unsafe` in dependencies via `cargo geiger`.

```rust
// SAFETY: The mmap is created from a read-only file descriptor. The underlying
// segment file is immutable — it is never modified after creation. The mmap
// lifetime is tied to the Segment struct, which holds the File handle open.
let mmap = unsafe { Mmap::map(&file)? };
```

### Test organization

```
# Unit tests — in the same file as the code
crates/storage/src/wal.rs        # #[cfg(test)] mod tests { ... }

# Integration tests — separate files, test public API
tests/integration/sql_test.rs
tests/integration/pgwire_test.rs

# Property tests — alongside unit tests or in dedicated files
crates/storage/src/wal.rs        # proptest! { ... } inside #[cfg(test)]

# Benchmarks — top-level benches/ directory
benches/storage_bench.rs
benches/vector_bench.rs
```

Run specific test suites:

```bash
# All tests
cargo test --workspace --all-features

# Single crate
cargo test -p mydb-storage

# Single test function
cargo test -p mydb-storage wal_frame_roundtrip

# Integration tests only
cargo test --test sql_test

# Benchmarks
cargo bench --bench storage_bench
```
