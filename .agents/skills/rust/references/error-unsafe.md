# Error Handling and Unsafe Rust — thiserror/anyhow Patterns, mmap, SIMD, Arena, FFI

## Error Handling

### thiserror for Library Crates

Every library crate defines its own error enum using `thiserror`. Errors are specific, structured, and carry enough context for callers to decide what to do.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("WAL corrupted at offset {offset}: {reason}")]
    WalCorrupted { offset: u64, reason: String },

    #[error("segment {segment_id} not found")]
    SegmentNotFound { segment_id: u64 },

    #[error("checksum mismatch: expected {expected:#010x}, got {actual:#010x}")]
    ChecksumMismatch { expected: u32, actual: u32 },

    #[error("page size overflow: {size} exceeds maximum {max}")]
    PageOverflow { size: usize, max: usize },

    #[error("segment open failed: {path}")]
    SegmentOpen {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("header too short: expected {expected} bytes, got {actual}")]
    HeaderTooShort { expected: usize, actual: usize },

    #[error("header alignment error")]
    HeaderAlignment,

    #[error("invalid magic bytes")]
    InvalidMagic,

    #[error("key not found: {key}")]
    KeyNotFound { key: String },

    #[error("write failed: disk full")]
    DiskFull,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
```

Rules for error variants:
- Every variant carries structured fields, not just a string message.
- Format strings use the field names — callers can also match on the fields directly.
- `#[error(transparent)]` + `#[from]` for error types that pass through unchanged (I/O).
- `#[source]` on a field (without `#[from]`) when you want to preserve the chain but wrap with additional context (like `SegmentOpen` above).

### Error Hierarchy Across Crates

Errors compose bottom-up. Lower crates define specific errors. Higher crates wrap them.

```rust
// ─── crate: types ───
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TypeError {
    #[error("invalid column type: {name} cannot be cast to {target}")]
    InvalidCast { name: String, target: String },

    #[error("schema mismatch: expected {expected} columns, got {actual}")]
    SchemaMismatch { expected: usize, actual: usize },

    #[error("null value in non-nullable column: {column}")]
    UnexpectedNull { column: String },
}

// ─── crate: storage ───
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("WAL corrupted at offset {offset}: {reason}")]
    WalCorrupted { offset: u64, reason: String },

    #[error("segment {segment_id} not found")]
    SegmentNotFound { segment_id: u64 },

    #[error(transparent)]
    Type(#[from] TypeError),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

// ─── crate: sql ───
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SqlError {
    #[error("parse error at position {position}: {message}")]
    Parse { position: usize, message: String },

    #[error("unknown table: {table}")]
    UnknownTable { table: String },

    #[error("query timeout after {elapsed_ms}ms")]
    Timeout { elapsed_ms: u64 },

    #[error(transparent)]
    Storage(#[from] StorageError),

    #[error(transparent)]
    Type(#[from] TypeError),
}

// ─── crate: server (binary) ───
// Binary crates can use anyhow — no downstream consumers need typed errors.
use anyhow::Context;

fn handle_query(sql: &str) -> anyhow::Result<QueryResult> {
    let plan = parse_and_plan(sql)
        .context("query planning failed")?;
    let result = execute(plan)
        .context("query execution failed")?;
    Ok(result)
}
```

### Error Context Pattern

When a low-level error (e.g., `io::Error`) needs additional context, wrap it with domain-specific information rather than letting `#[from]` discard the context.

```rust
use std::path::Path;

fn open_segment(path: &Path) -> Result<Segment, StorageError> {
    let file = std::fs::File::open(path)
        .map_err(|e| StorageError::SegmentOpen {
            path: path.to_path_buf(),
            source: e,
        })?;

    let metadata = file.metadata()
        .map_err(|e| StorageError::SegmentOpen {
            path: path.to_path_buf(),
            source: e,
        })?;

    if metadata.len() < SegmentHeader::SIZE as u64 {
        return Err(StorageError::HeaderTooShort {
            expected: SegmentHeader::SIZE,
            actual: metadata.len() as usize,
        });
    }

    // SAFETY: File is opened read-only. Segment files are immutable after sealing.
    let mmap = unsafe { memmap2::Mmap::map(&file) }
        .map_err(|e| StorageError::SegmentOpen {
            path: path.to_path_buf(),
            source: e,
        })?;

    Ok(Segment { mmap, len: metadata.len() })
}
```

### anyhow with .context() — Binary Crates Only

`anyhow` adds human-readable context to errors at the call site. Use it in `main.rs`, CLI tools, integration tests, and top-level server handlers — never in library crates.

```rust
use anyhow::{Context, Result, bail, ensure};

async fn start_server(config_path: &str) -> Result<()> {
    let config_str = std::fs::read_to_string(config_path)
        .with_context(|| format!("failed to read config file: {config_path}"))?;

    let config: ServerConfig = toml::from_str(&config_str)
        .context("invalid TOML in config file")?;

    ensure!(config.port > 0, "port must be positive, got {}", config.port);

    if config.data_dir.is_empty() {
        bail!("data_dir must not be empty");
    }

    let storage = Storage::open(&config.data_dir)
        .await
        .context("failed to open storage engine")?;

    serve(storage, config.port).await
}
```

`context()` / `with_context()` wraps the error in a chain. When printed with `{:?}`, you get:

```
Error: failed to open storage engine

Caused by:
    0: segment open failed: /data/segments/0001.seg
    1: No such file or directory (os error 2)
```

### Never unwrap() in Production

```rust
// WRONG — panics at runtime on missing key
let value = map.get("key").unwrap();

// WRONG — panic message does not help diagnose the issue
let value = map.get("key").expect("key must exist");

// RIGHT — returns a typed error with context
let value = map.get("key")
    .ok_or(StorageError::KeyNotFound { key: "key".into() })?;

// RIGHT — anyhow context in binary crates
let value = map.get("key")
    .context("expected 'key' in metadata map")?;

// OK — in tests only, where panics are the reporting mechanism
#[cfg(test)]
mod tests {
    #[test]
    fn test_key_lookup() {
        let value = map.get("key").unwrap();
        assert_eq!(value, "expected");
    }
}
```

### Result Type Aliases

Define these at the crate root to reduce noise in function signatures.

```rust
// crate: storage — lib.rs
pub type StorageResult<T> = Result<T, StorageError>;

// crate: sql — lib.rs
pub type SqlResult<T> = Result<T, SqlError>;

// crate: types — lib.rs
pub type TypeResult<T> = Result<T, TypeError>;
```

Usage:

```rust
pub fn read_page(segment: &Segment, page_id: u64) -> StorageResult<Page> {
    let offset = page_id * PAGE_SIZE as u64;
    let bytes = segment.read_at(offset as usize, PAGE_SIZE)
        .ok_or(StorageError::PageOverflow { size: offset as usize, max: segment.len() })?;
    Page::from_bytes(bytes)
}
```

### Error Conversion Matrix

When to use `#[from]`, `#[source]`, or manual `map_err`:

| Scenario | Mechanism | Example |
|---|---|---|
| Direct 1:1 conversion, no extra context needed | `#[from]` | `Io(#[from] std::io::Error)` |
| Wrapping with additional context fields | `#[source]` + struct fields | `SegmentOpen { path, #[source] source: io::Error }` |
| Same source type could map to different variants | Manual `map_err` | `io::Error` could be `DiskFull` or `SegmentOpen` |
| Cross-crate error composition | `#[from]` on the inner error type | `Storage(#[from] StorageError)` |
| Binary crate adding human context | `anyhow::Context` | `.context("failed to open WAL")` |

---

## Unsafe Rust Patterns

### Rule: unsafe Only in Storage Hot Paths

Acceptable uses of `unsafe`:
1. **mmap** — memory-mapped I/O for segment files
2. **SIMD intrinsics** — vectorized distance functions, checksums, filtering
3. **Arena allocator internals** — custom allocators, bump allocation
4. **C FFI** — calling C libraries (Tree-sitter, SQLite, compression codecs)
5. **Zero-copy type casting** — interpreting byte slices as typed structs

Everything else must be safe Rust. If you think you need `unsafe` for something not on this list, you are almost certainly wrong — find the safe alternative first.

### mmap Safety

Memory-mapped I/O is inherently `unsafe` because the OS can change the underlying memory at any time (another process modifies the file, the file is truncated, the disk is removed). The safety contract requires **immutable files**.

```rust
use memmap2::{Mmap, MmapMut, MmapOptions};
use std::fs::{File, OpenOptions};
use std::path::Path;

/// A sealed, immutable segment file that is safe to memory-map.
///
/// The seal-then-map lifecycle guarantees safety:
/// 1. Create the segment file
/// 2. Write all data
/// 3. fsync to ensure durability
/// 4. Set file permissions to read-only (seal)
/// 5. Memory-map the sealed file
/// 6. Never modify the mapped file
pub struct MappedSegment {
    mmap: Mmap,
    path: std::path::PathBuf,
}

impl MappedSegment {
    /// Open an already-sealed segment file.
    ///
    /// # Safety contract
    /// The file at `path` must be immutable — no process may write to it
    /// while it is mapped. We enforce this by:
    /// - Opening the file read-only
    /// - Verifying permissions are read-only before mapping
    /// - Only mapping files produced by `SegmentWriter::seal()`
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let file = File::open(path)
            .map_err(|e| StorageError::SegmentOpen {
                path: path.to_path_buf(),
                source: e,
            })?;

        // Verify the file is read-only (our seal invariant)
        let metadata = file.metadata()
            .map_err(|e| StorageError::SegmentOpen {
                path: path.to_path_buf(),
                source: e,
            })?;

        if !metadata.permissions().readonly() {
            return Err(StorageError::SegmentNotSealed {
                path: path.to_path_buf(),
            });
        }

        // SAFETY: The file is opened read-only and verified as sealed (read-only
        // permissions). No process will modify it. The mmap lifetime is tied to
        // this struct, which keeps the File handle alive via the OS fd.
        let mmap = unsafe { Mmap::map(&file) }
            .map_err(|e| StorageError::SegmentOpen {
                path: path.to_path_buf(),
                source: e,
            })?;

        // Advise the kernel on our access pattern
        mmap.advise(memmap2::Advice::Sequential)?;

        Ok(Self { mmap, path: path.to_path_buf() })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.mmap
    }
}
```

The writer side — creating and sealing a segment:

```rust
use std::fs;
use std::io::Write;

pub struct SegmentWriter {
    file: File,
    path: std::path::PathBuf,
    bytes_written: u64,
}

impl SegmentWriter {
    pub fn create(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .create_new(true)  // Fail if file already exists
            .write(true)
            .open(path)?;
        Ok(Self { file, path: path.to_path_buf(), bytes_written: 0 })
    }

    pub fn append(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.file.write_all(data)?;
        self.bytes_written += data.len() as u64;
        Ok(())
    }

    /// Seal the segment: fsync, set read-only, return the path for mapping.
    /// After this call, the segment is immutable and safe to mmap.
    pub fn seal(self) -> std::io::Result<std::path::PathBuf> {
        // 1. Flush all buffered data to the OS
        self.file.sync_all()?;

        // 2. Set file to read-only (the seal)
        let mut perms = self.file.metadata()?.permissions();
        perms.set_readonly(true);
        fs::set_permissions(&self.path, perms)?;

        // 3. Drop the file handle — no more writes possible
        drop(self.file);

        Ok(self.path)
    }
}
```

Usage — the full lifecycle:

```rust
async fn flush_wal_to_segment(
    wal_entries: &[WalEntry],
    segment_dir: &Path,
    segment_id: u64,
) -> Result<MappedSegment, StorageError> {
    let path = segment_dir.join(format!("{segment_id:08}.seg"));

    // Step 1-2: Create and write
    let mut writer = SegmentWriter::create(&path)?;
    for entry in wal_entries {
        writer.append(&entry.encode())?;
    }

    // Step 3-4: fsync + seal (set read-only)
    let sealed_path = writer.seal()?;

    // Step 5: Now safe to mmap — file is immutable
    MappedSegment::open(&sealed_path)
}
```

### MmapMut — Writable Memory Maps

For append-only structures like a WAL, you may need a writable mmap. This is more dangerous — you must synchronize all access.

```rust
use memmap2::MmapMut;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct MmapWal {
    mmap: MmapMut,
    write_offset: AtomicU64,
    capacity: u64,
}

impl MmapWal {
    pub fn create(path: &Path, capacity: u64) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;

        // Pre-allocate the file to the desired capacity
        file.set_len(capacity)?;

        // SAFETY: We are the sole writer. The file is pre-allocated to `capacity`
        // bytes. All writes go through `append()` which uses an atomic offset
        // to prevent overlapping writes. The file is not shared with other processes.
        let mmap = unsafe { MmapMut::map_mut(&file)? };

        Ok(Self {
            mmap,
            write_offset: AtomicU64::new(0),
            capacity,
        })
    }

    pub fn append(&self, data: &[u8]) -> Result<u64, StorageError> {
        let len = data.len() as u64;
        let offset = self.write_offset.fetch_add(len, Ordering::SeqCst);

        if offset + len > self.capacity {
            // Roll back the offset
            self.write_offset.fetch_sub(len, Ordering::SeqCst);
            return Err(StorageError::DiskFull);
        }

        // SAFETY: The atomic offset guarantees non-overlapping writes.
        // offset + len <= capacity, so we are within bounds.
        unsafe {
            let dst = self.mmap.as_ptr().add(offset as usize) as *mut u8;
            std::ptr::copy_nonoverlapping(data.as_ptr(), dst, data.len());
        }

        Ok(offset)
    }

    pub fn flush(&self) -> std::io::Result<()> {
        self.mmap.flush()
    }
}
```

### SIMD Safety

SIMD intrinsics are `unsafe` because they require specific CPU features. The pattern is: write an `unsafe` function with `#[target_feature]`, then wrap it in a safe function that checks feature availability at runtime.

```rust
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

/// Compute the L2 (Euclidean) squared distance between two f32 vectors using AVX2.
///
/// # Safety
/// - Caller must ensure AVX2 is available (use `is_x86_feature_detected!`).
/// - `a` and `b` must have the same length.
/// - Length must be a multiple of 8 (AVX2 processes 8 f32s at a time).
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn l2_squared_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    debug_assert_eq!(a.len() % 8, 0);

    let mut sum = _mm256_setzero_ps();
    let chunks = a.len() / 8;

    for i in 0..chunks {
        let offset = i * 8;
        // SAFETY: offset + 8 <= a.len() because chunks = a.len() / 8
        // and a.len() is a multiple of 8. Pointers are aligned by the slice guarantees.
        let va = _mm256_loadu_ps(a.as_ptr().add(offset));
        let vb = _mm256_loadu_ps(b.as_ptr().add(offset));
        let diff = _mm256_sub_ps(va, vb);
        sum = _mm256_fma_ps(diff, diff, sum);  // sum += diff * diff
    }

    // Horizontal sum of the 8 f32 lanes
    let hi = _mm256_extractf128_ps(sum, 1);
    let lo = _mm256_castps256_ps128(sum);
    let sum128 = _mm_add_ps(lo, hi);
    let sum64 = _mm_add_ps(sum128, _mm_movehl_ps(sum128, sum128));
    let sum32 = _mm_add_ss(sum64, _mm_shuffle_ps(sum64, sum64, 1));
    _mm_cvtss_f32(sum32)
}

/// Compute the cosine distance between two f32 vectors using AVX2.
///
/// # Safety
/// Same requirements as `l2_squared_avx2`.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn cosine_distance_avx2(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    debug_assert_eq!(a.len() % 8, 0);

    let mut dot = _mm256_setzero_ps();
    let mut norm_a = _mm256_setzero_ps();
    let mut norm_b = _mm256_setzero_ps();

    let chunks = a.len() / 8;
    for i in 0..chunks {
        let offset = i * 8;
        let va = _mm256_loadu_ps(a.as_ptr().add(offset));
        let vb = _mm256_loadu_ps(b.as_ptr().add(offset));
        dot = _mm256_fma_ps(va, vb, dot);
        norm_a = _mm256_fma_ps(va, va, norm_a);
        norm_b = _mm256_fma_ps(vb, vb, norm_b);
    }

    let dot_sum = hsum_avx2(dot);
    let norm_a_sum = hsum_avx2(norm_a);
    let norm_b_sum = hsum_avx2(norm_b);

    let denom = (norm_a_sum * norm_b_sum).sqrt();
    if denom < f32::EPSILON {
        return 1.0; // Degenerate case: zero vector
    }
    1.0 - (dot_sum / denom)
}

/// Horizontal sum of an __m256 register.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn hsum_avx2(v: __m256) -> f32 {
    let hi = _mm256_extractf128_ps(v, 1);
    let lo = _mm256_castps256_ps128(v);
    let sum128 = _mm_add_ps(lo, hi);
    let sum64 = _mm_add_ps(sum128, _mm_movehl_ps(sum128, sum128));
    let sum32 = _mm_add_ss(sum64, _mm_shuffle_ps(sum64, sum64, 1));
    _mm_cvtss_f32(sum32)
}

// ─── Scalar fallbacks ───

fn l2_squared_scalar(a: &[f32], b: &[f32]) -> f32 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| {
            let d = x - y;
            d * d
        })
        .sum()
}

fn cosine_distance_scalar(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denom = (norm_a * norm_b).sqrt();
    if denom < f32::EPSILON {
        return 1.0;
    }
    1.0 - (dot / denom)
}

// ─── Safe public API with runtime detection ───

/// Compute L2 squared distance. Automatically uses AVX2 if available.
pub fn l2_squared(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && a.len() % 8 == 0 {
            // SAFETY: AVX2 feature detection passed, length is multiple of 8.
            return unsafe { l2_squared_avx2(a, b) };
        }
    }

    l2_squared_scalar(a, b)
}

/// Compute cosine distance. Automatically uses AVX2 if available.
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "vectors must have same length");

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && a.len() % 8 == 0 {
            // SAFETY: AVX2 feature detection passed, length is multiple of 8.
            return unsafe { cosine_distance_avx2(a, b) };
        }
    }

    cosine_distance_scalar(a, b)
}
```

For NEON (aarch64 / Apple Silicon):

```rust
#[cfg(target_arch = "aarch64")]
use std::arch::aarch64::*;

#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "neon")]
unsafe fn l2_squared_neon(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    debug_assert_eq!(a.len() % 4, 0);

    let mut sum = vdupq_n_f32(0.0);
    let chunks = a.len() / 4;

    for i in 0..chunks {
        let offset = i * 4;
        let va = vld1q_f32(a.as_ptr().add(offset));
        let vb = vld1q_f32(b.as_ptr().add(offset));
        let diff = vsubq_f32(va, vb);
        sum = vfmaq_f32(sum, diff, diff);
    }

    vaddvq_f32(sum)
}

pub fn l2_squared(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());

    #[cfg(target_arch = "aarch64")]
    {
        // NEON is always available on aarch64, but check alignment
        if a.len() % 4 == 0 {
            // SAFETY: NEON is guaranteed on aarch64. Length is multiple of 4.
            return unsafe { l2_squared_neon(a, b) };
        }
    }

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("avx2") && a.len() % 8 == 0 {
            return unsafe { l2_squared_avx2(a, b) };
        }
    }

    l2_squared_scalar(a, b)
}
```

### Arena Safety

Arena allocators provide fast, bump-pointer allocation for short-lived, batch-scoped data. Using `bumpalo`, most operations are safe. Unsafe is only needed for custom allocator integration.

```rust
use bumpalo::Bump;

/// Per-query arena. All allocations are freed together when the query completes.
/// This avoids per-object allocation overhead and improves cache locality.
pub struct QueryArena {
    bump: Bump,
}

impl QueryArena {
    pub fn new() -> Self {
        Self { bump: Bump::new() }
    }

    /// Pre-allocate capacity for a known workload.
    pub fn with_capacity(bytes: usize) -> Self {
        Self { bump: Bump::with_capacity(bytes) }
    }

    /// Allocate a single value. Lifetime is tied to the arena.
    pub fn alloc<T>(&self, val: T) -> &T {
        self.bump.alloc(val)
    }

    /// Allocate a slice by copying. Lifetime is tied to the arena.
    pub fn alloc_slice<T: Copy>(&self, vals: &[T]) -> &[T] {
        self.bump.alloc_slice_copy(vals)
    }

    /// Allocate a string. Lifetime is tied to the arena.
    pub fn alloc_str(&self, s: &str) -> &str {
        self.bump.alloc_str(s)
    }

    /// Total bytes allocated in this arena.
    pub fn allocated_bytes(&self) -> usize {
        self.bump.allocated_bytes()
    }

    /// Reset the arena, reusing the underlying memory for the next query.
    /// All references from previous allocations become invalid — the caller
    /// must ensure no references survive past this call.
    pub fn reset(&mut self) {
        self.bump.reset();
    }
}
```

Arena-allocated graph traversal:

```rust
use bumpalo::Bump;
use bumpalo::collections::Vec as BumpVec;

pub struct GraphNode<'arena> {
    pub id: u64,
    pub label: &'arena str,
    pub edges: BumpVec<'arena, &'arena GraphNode<'arena>>,
}

/// Build a graph in an arena and traverse it.
/// All nodes, edges, and intermediate data structures live in the arena.
/// When the arena is dropped, everything is freed at once.
pub fn bfs_reachable<'a>(
    arena: &'a Bump,
    start_id: u64,
    max_depth: usize,
    adjacency: &impl Fn(u64) -> Vec<(u64, &str)>,
) -> BumpVec<'a, u64> {
    let mut queue = BumpVec::new_in(arena);
    let mut visited = std::collections::HashSet::new();
    let mut result = BumpVec::new_in(arena);
    let mut depths = std::collections::HashMap::new();

    queue.push(start_id);
    visited.insert(start_id);
    depths.insert(start_id, 0usize);

    while let Some(current) = queue.first().copied() {
        queue.remove(0);
        let depth = depths[&current];
        result.push(current);

        if depth >= max_depth {
            continue;
        }

        for (neighbor_id, _label) in adjacency(current) {
            if visited.insert(neighbor_id) {
                depths.insert(neighbor_id, depth + 1);
                queue.push(neighbor_id);
            }
        }
    }

    result
}
```

When unsafe IS needed with arenas — custom typed arena with stable addresses:

```rust
/// A typed arena that guarantees pointer stability. Objects allocated here
/// will not move, so raw pointers to them remain valid for the arena's lifetime.
pub struct StableArena<T> {
    chunks: std::cell::RefCell<Vec<Vec<T>>>,
    chunk_capacity: usize,
}

impl<T> StableArena<T> {
    pub fn new(chunk_capacity: usize) -> Self {
        Self {
            chunks: std::cell::RefCell::new(Vec::new()),
            chunk_capacity,
        }
    }

    /// Allocate a value and return a reference with the arena's lifetime.
    /// The reference is stable — the value will not move.
    pub fn alloc(&self, val: T) -> &T {
        let mut chunks = self.chunks.borrow_mut();

        // Check if current chunk has space
        if chunks.is_empty() || chunks.last().unwrap().len() == self.chunk_capacity {
            chunks.push(Vec::with_capacity(self.chunk_capacity));
        }

        let chunk = chunks.last_mut().unwrap();
        chunk.push(val);

        // SAFETY: The returned reference is valid because:
        // 1. The value was just pushed to a Vec that will not reallocate
        //    (len < capacity, and capacity == chunk_capacity).
        // 2. The Vec is never removed from `chunks` until the arena is dropped.
        // 3. The Vec never reallocates because we allocate a new chunk instead.
        // Therefore, the pointer is stable for the arena's lifetime.
        unsafe { &*(chunk.last().unwrap() as *const T) }
    }
}
```

### Zero-Copy Casting

Interpret raw byte slices as typed structs without copying. Use `zerocopy` derive macros instead of hand-written `unsafe` transmutes.

```rust
use zerocopy::{FromBytes, IntoBytes, KnownLayout, Immutable};

/// On-disk segment header.
///
/// repr(C, packed) ensures:
/// - C-compatible field ordering (no Rust reordering)
/// - No padding between fields (packed)
/// - Deterministic layout matching the on-disk format
#[derive(FromBytes, IntoBytes, KnownLayout, Immutable, Debug, Clone, Copy)]
#[repr(C, packed)]
pub struct SegmentHeader {
    pub magic: [u8; 4],       // b"SEGT"
    pub version: u8,
    pub flags: u8,
    pub _reserved: [u8; 2],
    pub entry_count: u64,
    pub data_offset: u64,
    pub index_offset: u64,
    pub checksum: u32,
    pub _padding: [u8; 4],
}

const SEGMENT_MAGIC: [u8; 4] = *b"SEGT";

impl SegmentHeader {
    pub const SIZE: usize = std::mem::size_of::<Self>();

    /// Read a header from a byte slice without copying.
    /// Validates magic bytes after casting.
    pub fn from_bytes(bytes: &[u8]) -> Result<&Self, StorageError> {
        if bytes.len() < Self::SIZE {
            return Err(StorageError::HeaderTooShort {
                expected: Self::SIZE,
                actual: bytes.len(),
            });
        }

        let header = Self::ref_from_bytes(&bytes[..Self::SIZE])
            .map_err(|_| StorageError::HeaderAlignment)?;

        if header.magic != SEGMENT_MAGIC {
            return Err(StorageError::InvalidMagic);
        }

        Ok(header)
    }

    /// Serialize the header to bytes (for writing).
    pub fn to_bytes(&self) -> &[u8] {
        self.as_bytes()
    }
}

/// On-disk index entry — also zero-copy.
#[derive(FromBytes, IntoBytes, KnownLayout, Immutable, Debug, Clone, Copy)]
#[repr(C, packed)]
pub struct IndexEntry {
    pub key_hash: u64,
    pub offset: u64,
    pub length: u32,
    pub flags: u32,
}

impl IndexEntry {
    pub const SIZE: usize = std::mem::size_of::<Self>();

    /// Read an array of index entries from a byte slice without copying.
    pub fn slice_from_bytes(bytes: &[u8], count: usize) -> Result<&[Self], StorageError> {
        let needed = count * Self::SIZE;
        if bytes.len() < needed {
            return Err(StorageError::HeaderTooShort {
                expected: needed,
                actual: bytes.len(),
            });
        }

        <[Self]>::ref_from_bytes(&bytes[..needed])
            .map_err(|_| StorageError::HeaderAlignment)
    }
}
```

When `zerocopy` derive is not enough (rare — e.g., variable-length trailing data):

```rust
/// A frame with a fixed header and variable-length payload.
/// Cannot use zerocopy derive because the payload length varies.
#[repr(C, packed)]
struct RawFrameHeader {
    frame_type: u8,
    flags: u8,
    payload_len: u16,
    checksum: u32,
}

fn read_frame(data: &[u8]) -> Result<(&RawFrameHeader, &[u8]), StorageError> {
    let header_size = std::mem::size_of::<RawFrameHeader>();

    if data.len() < header_size {
        return Err(StorageError::HeaderTooShort {
            expected: header_size,
            actual: data.len(),
        });
    }

    // SAFETY:
    // - data.len() >= header_size (checked above)
    // - RawFrameHeader is repr(C, packed), so alignment requirement is 1
    // - All fields are primitive integers — no invalid bit patterns exist
    let header = unsafe { &*(data.as_ptr() as *const RawFrameHeader) };

    let payload_len = header.payload_len as usize;
    let total = header_size + payload_len;

    if data.len() < total {
        return Err(StorageError::HeaderTooShort {
            expected: total,
            actual: data.len(),
        });
    }

    let payload = &data[header_size..total];
    Ok((header, payload))
}
```

### FFI (C Interop)

Safe wrappers around C libraries follow the RAII pattern: a Rust struct owns the raw pointer, `Drop` frees it, and all methods go through the safe wrapper.

```rust
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr::NonNull;

// ─── Raw C bindings ───
// Typically generated by bindgen, shown manually here for clarity.

#[repr(C)]
pub struct RawParser {
    _opaque: [u8; 0],
}

#[repr(C)]
pub struct RawTree {
    _opaque: [u8; 0],
}

#[repr(C)]
pub struct RawLanguage {
    _opaque: [u8; 0],
}

extern "C" {
    fn ts_parser_new() -> *mut RawParser;
    fn ts_parser_delete(parser: *mut RawParser);
    fn ts_parser_set_language(parser: *mut RawParser, language: *const RawLanguage) -> bool;
    fn ts_parser_parse_string(
        parser: *mut RawParser,
        old_tree: *const RawTree,
        input: *const c_char,
        length: u32,
    ) -> *mut RawTree;
    fn ts_tree_delete(tree: *mut RawTree);
}

// ─── Safe wrapper: Parser ───

/// A safe wrapper around a Tree-sitter parser.
/// Owns the raw pointer and frees it on drop.
pub struct Parser {
    raw: NonNull<RawParser>,
}

// SAFETY: The parser is not thread-safe in Tree-sitter's API — Send but not Sync.
unsafe impl Send for Parser {}

impl Parser {
    pub fn new() -> Option<Self> {
        // SAFETY: ts_parser_new returns a valid pointer or null.
        let raw = unsafe { ts_parser_new() };
        NonNull::new(raw).map(|raw| Self { raw })
    }

    pub fn set_language(&mut self, language: &Language) -> bool {
        // SAFETY: self.raw is valid (non-null, created by ts_parser_new).
        // language.raw is valid (non-null, provided by tree-sitter language function).
        unsafe { ts_parser_set_language(self.raw.as_ptr(), language.raw.as_ptr()) }
    }

    pub fn parse(&mut self, source: &str, old_tree: Option<&Tree>) -> Option<Tree> {
        let old_tree_ptr = old_tree
            .map(|t| t.raw.as_ptr() as *const RawTree)
            .unwrap_or(std::ptr::null());

        // SAFETY: self.raw is valid. source is a valid UTF-8 string with known length.
        // old_tree_ptr is either null or a valid tree pointer. ts_parser_parse_string
        // does not retain the source pointer after returning.
        let raw = unsafe {
            ts_parser_parse_string(
                self.raw.as_ptr(),
                old_tree_ptr,
                source.as_ptr() as *const c_char,
                source.len() as u32,
            )
        };

        NonNull::new(raw).map(|raw| Tree { raw })
    }
}

impl Drop for Parser {
    fn drop(&mut self) {
        // SAFETY: self.raw was created by ts_parser_new, has not been freed,
        // and we are the sole owner (no Clone impl).
        unsafe { ts_parser_delete(self.raw.as_ptr()) };
    }
}

// ─── Safe wrapper: Tree ───

pub struct Tree {
    raw: NonNull<RawTree>,
}

unsafe impl Send for Tree {}

impl Drop for Tree {
    fn drop(&mut self) {
        // SAFETY: self.raw was created by ts_parser_parse_string, has not been freed,
        // and we are the sole owner.
        unsafe { ts_tree_delete(self.raw.as_ptr()) };
    }
}

// ─── Safe wrapper: Language ───

pub struct Language {
    raw: NonNull<RawLanguage>,
}

// Languages are immutable and thread-safe in Tree-sitter.
unsafe impl Send for Language {}
unsafe impl Sync for Language {}
```

FFI for C compression libraries (e.g., LZ4, Zstd):

```rust
extern "C" {
    fn LZ4_compress_default(
        src: *const u8,
        dst: *mut u8,
        src_size: i32,
        dst_capacity: i32,
    ) -> i32;

    fn LZ4_decompress_safe(
        src: *const u8,
        dst: *mut u8,
        compressed_size: i32,
        dst_capacity: i32,
    ) -> i32;

    fn LZ4_compressBound(input_size: i32) -> i32;
}

pub fn lz4_compress(input: &[u8]) -> Result<Vec<u8>, StorageError> {
    let bound = unsafe { LZ4_compressBound(input.len() as i32) };
    if bound <= 0 {
        return Err(StorageError::CompressionFailed {
            reason: "input too large for LZ4".into(),
        });
    }

    let mut output = vec![0u8; bound as usize];

    // SAFETY: input is a valid slice, output has `bound` bytes of capacity.
    // LZ4_compress_default reads exactly input.len() bytes from src and writes
    // at most dst_capacity bytes to dst. It returns the number of bytes written
    // or 0 on failure.
    let compressed_size = unsafe {
        LZ4_compress_default(
            input.as_ptr(),
            output.as_mut_ptr(),
            input.len() as i32,
            bound,
        )
    };

    if compressed_size <= 0 {
        return Err(StorageError::CompressionFailed {
            reason: "LZ4 compression returned 0".into(),
        });
    }

    output.truncate(compressed_size as usize);
    Ok(output)
}

pub fn lz4_decompress(input: &[u8], max_output_size: usize) -> Result<Vec<u8>, StorageError> {
    let mut output = vec![0u8; max_output_size];

    // SAFETY: input is a valid slice, output has max_output_size bytes.
    // LZ4_decompress_safe reads at most compressed_size bytes and writes at most
    // dst_capacity bytes. It returns the number of decompressed bytes or a
    // negative value on failure.
    let decompressed_size = unsafe {
        LZ4_decompress_safe(
            input.as_ptr(),
            output.as_mut_ptr(),
            input.len() as i32,
            max_output_size as i32,
        )
    };

    if decompressed_size < 0 {
        return Err(StorageError::DecompressionFailed {
            reason: format!("LZ4 returned error code {decompressed_size}"),
        });
    }

    output.truncate(decompressed_size as usize);
    Ok(output)
}
```

### Unsafe Audit Checklist

Every `unsafe` block in the codebase must pass this checklist. Document the answers as `// SAFETY:` comments directly above the block.

| # | Question | Document in SAFETY comment |
|---|---|---|
| 1 | **What invariant** does this unsafe code rely on? | The precondition that makes this sound |
| 2 | **Who ensures** the invariant holds? | Caller contract, constructor, seal step, runtime check |
| 3 | **What happens** if the invariant is violated? | UB category: data race, use-after-free, out-of-bounds, etc. |
| 4 | **How is it tested?** | Miri, proptest, integration test, manual review |

Example of a fully documented `unsafe` block:

```rust
/// Read a page from the memory-mapped segment.
///
/// # Panics
/// Panics if `offset + len` exceeds the segment size.
pub fn read_page(&self, offset: usize, len: usize) -> &[u8] {
    assert!(offset + len <= self.mmap.len(), "read_page out of bounds");

    // SAFETY:
    // 1. INVARIANT: offset + len <= mmap.len() (asserted above)
    // 2. ENSURED BY: the assert on the line above — panics if violated
    // 3. VIOLATION: without the assert, this would be an out-of-bounds read
    //    returning garbage data or segfaulting
    // 4. TESTED: proptest generates random offset/len pairs, miri validates
    //    memory access in unit tests
    unsafe {
        std::slice::from_raw_parts(self.mmap.as_ptr().add(offset), len)
    }
}
```

### Miri for Unsafe Validation

Miri is an interpreter that detects undefined behavior in unsafe code. Run it on every PR that touches `unsafe`.

```bash
# Install miri
rustup +nightly component add miri

# Run all library tests under miri
cargo +nightly miri test --workspace

# Run a specific test
cargo +nightly miri test -p mydb-storage test_arena_alloc

# Set miri flags for stricter checking
MIRIFLAGS="-Zmiri-strict-provenance -Zmiri-symbolic-alignment-check" \
    cargo +nightly miri test --workspace
```

What miri detects:
- Use-after-free
- Out-of-bounds memory access
- Unaligned pointer access
- Data races (with `-Zmiri-preemption-rate=0.1`)
- Invalid pointer provenance
- Violation of `noalias` guarantees (mutable reference aliasing)

What miri CANNOT validate — these require manual review + integration tests:
- **mmap correctness** — miri does not model memory-mapped files
- **SIMD intrinsics** — miri does not support most SIMD instructions
- **FFI calls** — miri cannot execute foreign C functions
- **io-uring** — kernel syscall interface, not interpretable

For code miri cannot check, use:

```rust
#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    proptest! {
        /// Property test: SIMD and scalar produce the same result.
        #[test]
        fn simd_matches_scalar(
            a in prop::collection::vec(-1.0f32..1.0, 64..=64),
            b in prop::collection::vec(-1.0f32..1.0, 64..=64),
        ) {
            let simd_result = l2_squared(&a, &b);
            let scalar_result = l2_squared_scalar(&a, &b);
            prop_assert!((simd_result - scalar_result).abs() < 1e-5,
                "SIMD and scalar diverged: {} vs {}", simd_result, scalar_result);
        }
    }
}
```

---

## Logging and Tracing

### Subscriber Setup

```rust
use tracing_subscriber::{fmt, EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

/// Initialize tracing for the application binary.
/// Library crates emit spans and events — only the binary configures the subscriber.
pub fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            // Default: debug for our crates, warn for dependencies
            "myapp=debug,myapp_storage=debug,myapp_server=debug,tower_http=debug,warn"
                .parse()
                .expect("valid filter directive")
        }))
        .with(fmt::layer().json())  // JSON output for production (structured, machine-parsable)
        .init();
}

/// Alternative: human-readable output for local development.
pub fn init_tracing_dev() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            "myapp=trace,warn".parse().expect("valid filter directive")
        }))
        .with(fmt::layer().pretty())  // Multi-line, colored output
        .init();
}
```

### Structured Fields and Spans

```rust
use tracing::{info, warn, error, debug, trace, instrument, Span};

/// #[instrument] creates a span for the function's duration.
/// `skip` excludes large or non-Display arguments from the span.
/// `fields` adds custom fields.
#[instrument(skip(data), fields(segment_id = %id, data_len = data.len()))]
pub async fn write_segment(id: u64, data: &[u8]) -> Result<(), StorageError> {
    info!("starting segment write");

    let checksum = crc32fast::hash(data);
    debug!(checksum = %format!("{checksum:#010x}"), "computed checksum");

    // The span automatically records duration when the function returns.
    Ok(())
}

/// Manual span creation for non-async or partial-function instrumentation.
pub fn compact_segments(segment_ids: &[u64]) -> Result<u64, StorageError> {
    let span = tracing::info_span!("compaction", segment_count = segment_ids.len());
    let _guard = span.enter();

    info!("starting compaction");

    for &id in segment_ids {
        let _segment_span = tracing::debug_span!("compact_segment", segment_id = %id).entered();
        debug!("processing segment");
        // ... compact logic ...
    }

    let new_segment_id = 42;
    info!(new_segment_id, "compaction complete");
    Ok(new_segment_id)
}
```

### Log Levels

| Level | Use for | Example |
|---|---|---|
| `error!` | Operation failed, requires attention | WAL corruption, unrecoverable I/O error |
| `warn!` | Degraded but operational | Slow query, retry succeeded, config fallback |
| `info!` | Significant state changes | Server started, segment sealed, compaction triggered |
| `debug!` | Diagnostic detail for development | Checksum values, query plan, cache hit/miss |
| `trace!` | Per-record / per-iteration detail | Every WAL frame read, every index probe |

### Per-Request Trace Context

```rust
use uuid::Uuid;

pub async fn handle_request(query: &str) -> Result<QueryResult, SqlError> {
    let request_id = Uuid::now_v7();
    let span = tracing::info_span!(
        "request",
        %request_id,
        query_len = query.len(),
    );
    let _guard = span.enter();

    info!(query, "received query");

    let plan = plan_query(query)?;
    debug!(?plan, "query planned");

    let result = execute_plan(plan).await?;
    info!(rows = result.row_count(), elapsed_ms = %result.elapsed().as_millis(), "query complete");

    Ok(result)
}
```

---

## Key Dependencies

| Crate | Purpose | Crate type |
|---|---|---|
| `thiserror` | Derive `Error` for typed error enums | Library crates only |
| `anyhow` | Dynamic error type with `.context()` | Binary crate and tests only |
| `tracing` | Structured logging — spans, events, fields | All crates |
| `tracing-subscriber` | Subscriber configuration — env-filter, JSON/pretty output | Binary crate only |
| `memmap2` | Memory-mapped file I/O | Storage hot path |
| `zerocopy` | Zero-copy struct-to-bytes casting via derive macros | On-disk format parsing |
| `bumpalo` | Arena (bump) allocator | Per-query allocations, graph traversal |
