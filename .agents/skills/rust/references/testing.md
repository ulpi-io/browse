# Testing — Property Testing, Deterministic Tests, Integration Structure, Benchmarking

## What

Testing strategy for Rust systems code. Unit tests live inline with `#[cfg(test)]`. Integration tests live in `tests/`. Property tests use `proptest` to find edge cases that hand-written examples miss. Deterministic testing replaces real I/O, time, and randomness with injectable fakes so tests are reproducible and fast. Benchmarks use `criterion` with statistical regression detection.

Key rules: every binary format gets a proptest round-trip. Every `unsafe` block gets a `cargo miri test` pass. Every public API gets an integration test. Every hot path gets a criterion benchmark. Flaky tests are bugs — use deterministic fakes, not sleeps and retries.

## Test Organization

### Unit tests — inline with the code

```rust
// crates/storage/src/wal.rs

pub struct WalWriter { /* ... */ }

impl WalWriter {
    pub fn append(&mut self, entry_type: WalEntryType, payload: &[u8]) -> Result<u64, StorageError> {
        // ...
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_returns_incrementing_sequence_numbers() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut writer = WalWriter::open(dir.path()).unwrap();
        let seq1 = writer.append(WalEntryType::Insert, b"row1").unwrap();
        let seq2 = writer.append(WalEntryType::Insert, b"row2").unwrap();
        assert_eq!(seq2, seq1 + 1);
    }

    #[test]
    fn append_rejects_payload_exceeding_max_size() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut writer = WalWriter::open(dir.path()).unwrap();
        let oversized = vec![0u8; WalWriter::MAX_PAYLOAD_SIZE + 1];
        let result = writer.append(WalEntryType::Insert, &oversized);
        assert!(matches!(result, Err(StorageError::PayloadTooLarge { .. })));
    }
}
```

### Integration tests — cross-crate, public API only

```
tests/
├── storage_integration.rs    // WAL + segment + compaction end-to-end
├── query_integration.rs      // SQL parse -> plan -> execute -> results
├── network_integration.rs    // Wire protocol round-trips
└── common/
    └── mod.rs                // Shared fixtures, test harness setup
```

```rust
// tests/common/mod.rs
use tempfile::TempDir;

pub struct TestHarness {
    pub dir: TempDir,
    pub engine: StorageEngine,
}

impl TestHarness {
    pub fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();
        Self { dir, engine }
    }

    /// Insert N rows with sequential integer keys.
    pub fn insert_rows(&mut self, n: usize) {
        for i in 0..n {
            self.engine
                .insert(format!("key_{i}"), vec![0u8; 128])
                .unwrap();
        }
    }
}
```

```rust
// tests/storage_integration.rs
mod common;
use common::TestHarness;

#[test]
fn write_flush_reopen_reads_back() {
    let mut harness = TestHarness::new();
    harness.insert_rows(100);
    harness.engine.flush().unwrap();

    // Reopen from disk — proves durability
    let reopened = StorageEngine::open(harness.dir.path()).unwrap();
    for i in 0..100 {
        let val = reopened.get(&format!("key_{i}")).unwrap();
        assert!(val.is_some(), "key_{i} missing after reopen");
    }
}

#[test]
fn compaction_merges_segments_without_data_loss() {
    let mut harness = TestHarness::new();

    // Write enough to create multiple segments
    for batch in 0..5 {
        harness.insert_rows(1000);
        harness.engine.flush().unwrap();
    }

    let segment_count_before = harness.engine.segment_count();
    harness.engine.compact().unwrap();
    let segment_count_after = harness.engine.segment_count();

    assert!(segment_count_after < segment_count_before);

    // Verify every row survived compaction
    for i in 0..5000 {
        assert!(harness.engine.get(&format!("key_{i}")).unwrap().is_some());
    }
}
```

### Test utilities module — behind `#[cfg(test)]`

```rust
// crates/storage/src/test_utils.rs

use crate::{StorageEngine, WalEntry, WalEntryType};
use tempfile::TempDir;

/// Create a temporary storage engine pre-loaded with test data.
pub fn engine_with_rows(n: usize) -> (TempDir, StorageEngine) {
    let dir = TempDir::new().unwrap();
    let mut engine = StorageEngine::open(dir.path()).unwrap();
    for i in 0..n {
        engine.insert(format!("key_{i}"), vec![i as u8; 64]).unwrap();
    }
    engine.flush().unwrap();
    (dir, engine) // dir must outlive engine — return both
}

/// Build a WAL entry without writing to disk.
pub fn fake_wal_entry(payload_size: usize) -> WalEntry {
    WalEntry::new(WalEntryType::Insert, &vec![0xAB; payload_size])
}

/// Schema with common column types for testing type coercion.
pub fn sample_schema() -> Schema {
    Schema::builder()
        .column("id", LogicalType::BigInt)
        .column("name", LogicalType::Varchar(255))
        .column("score", LogicalType::Decimal { precision: 10, scale: 2 })
        .column("active", LogicalType::Bool)
        .column("embedding", LogicalType::Vector(384))
        .build()
}
```

Reference from the crate root:

```rust
// crates/storage/src/lib.rs
#[cfg(test)]
pub(crate) mod test_utils;
```

## Property Testing with proptest

### Round-trip testing — the most important pattern

Every binary format, every encoder/decoder pair, every serialize/deserialize path needs a proptest round-trip. If you encode data and decode it, you must get the original back.

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn wal_frame_roundtrip(
        sequence in 0u64..u64::MAX,
        payload in prop::collection::vec(any::<u8>(), 0..8192),
    ) {
        let frame = WalFrame::new(sequence, payload.clone());
        let mut buf = Vec::new();
        frame.encode(&mut buf);
        let mut cursor = buf.as_slice();
        let decoded = WalFrame::decode(&mut cursor).unwrap();
        prop_assert_eq!(decoded.sequence, sequence);
        prop_assert_eq!(decoded.payload, payload);
        prop_assert_eq!(decoded.checksum, frame.checksum);
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
        prop_assert_eq!(restored.entry_count, entry_count);
        prop_assert_eq!(restored.data_offset, data_offset);
        prop_assert_eq!(restored.index_offset, index_offset);
    }
}
```

### Custom strategies for domain types

Build strategies that produce valid instances of your domain types. Compose them from primitives.

```rust
fn arbitrary_logical_type() -> impl Strategy<Value = LogicalType> {
    prop_oneof![
        Just(LogicalType::Bool),
        Just(LogicalType::Int),
        Just(LogicalType::BigInt),
        Just(LogicalType::Float),
        Just(LogicalType::Double),
        (1u32..255).prop_map(LogicalType::Varchar),
        (1u8..38, 0u8..18).prop_map(|(p, s)| LogicalType::Decimal {
            precision: p,
            scale: s.min(p),
        }),
        (1usize..2048).prop_map(LogicalType::Vector),
    ]
}

fn arbitrary_datum() -> impl Strategy<Value = Datum> {
    prop_oneof![
        Just(Datum::Null),
        any::<bool>().prop_map(Datum::Bool),
        any::<i32>().prop_map(Datum::Int),
        any::<i64>().prop_map(Datum::BigInt),
        any::<f64>()
            .prop_filter("not NaN", |f| !f.is_nan())
            .prop_map(Datum::Double),
        "[a-zA-Z0-9]{0,100}".prop_map(Datum::Text),
        prop::collection::vec(any::<u8>(), 0..1024).prop_map(Datum::Blob),
    ]
}

fn arbitrary_schema(max_cols: usize) -> impl Strategy<Value = Schema> {
    prop::collection::vec(
        ("[a-z_]{1,30}", arbitrary_logical_type()),
        1..max_cols,
    )
    .prop_map(|cols| {
        let mut builder = Schema::builder();
        for (name, ty) in cols {
            builder = builder.column(&name, ty);
        }
        builder.build()
    })
}
```

### Key-value store invariants

```rust
proptest! {
    #[test]
    fn insert_then_get_returns_value(
        key in "[a-zA-Z0-9_]{1,64}",
        value in prop::collection::vec(any::<u8>(), 0..4096),
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let mut engine = StorageEngine::open(dir.path()).unwrap();
        engine.insert(&key, value.clone()).unwrap();
        let retrieved = engine.get(&key).unwrap();
        prop_assert_eq!(retrieved, Some(value));
    }

    #[test]
    fn delete_then_get_returns_none(
        key in "[a-zA-Z0-9_]{1,64}",
        value in prop::collection::vec(any::<u8>(), 1..256),
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let mut engine = StorageEngine::open(dir.path()).unwrap();
        engine.insert(&key, value).unwrap();
        engine.delete(&key).unwrap();
        let retrieved = engine.get(&key).unwrap();
        prop_assert_eq!(retrieved, None);
    }
}
```

### Type coercion invariants

```rust
proptest! {
    #[test]
    fn narrow_to_wide_int_preserves_value(val in any::<i8>()) {
        let widened = widen_to_i64(val as i64);
        let narrowed = narrow_to_i8(widened).unwrap();
        prop_assert_eq!(narrowed, val);
    }

    #[test]
    fn decimal_roundtrip_preserves_precision(
        mantissa in -999_999_999i64..999_999_999,
        scale in 0u8..9,
    ) {
        let decimal = Decimal::new(mantissa, scale);
        let encoded = decimal.to_bytes();
        let decoded = Decimal::from_bytes(&encoded).unwrap();
        prop_assert_eq!(decoded.mantissa(), mantissa);
        prop_assert_eq!(decoded.scale(), scale);
    }
}
```

### Sorted/ordered output invariants

```rust
proptest! {
    #[test]
    fn scan_returns_keys_in_sorted_order(
        entries in prop::collection::hash_map("[a-z]{1,10}", any::<i64>(), 1..200),
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let mut engine = StorageEngine::open(dir.path()).unwrap();
        for (k, v) in &entries {
            engine.insert(k, v.to_le_bytes().to_vec()).unwrap();
        }
        let keys: Vec<String> = engine.scan(..).unwrap().map(|(k, _)| k).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        prop_assert_eq!(keys, sorted);
    }
}
```

### Configuring proptest

Control case count per-test or globally via `proptest.toml` in the project root:

```toml
# proptest.toml — checked into the repo
[default]
cases = 256           # Default: 256 cases per test (up from proptest default of 100)
max_shrink_iters = 1000
```

Override per-test for expensive tests:

```rust
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn expensive_integration_property(/* ... */) {
        // Fewer cases because each one does real I/O
    }
}
```

## Deterministic Testing

Flaky tests destroy velocity. Replace every source of non-determinism with an injectable abstraction.

### Deterministic I/O — in-memory storage backend

```rust
/// Trait for storage backends. Production uses real files, tests use in-memory.
pub trait StorageBackend: Send + Sync {
    fn read(&self, path: &str) -> Result<Vec<u8>, StorageError>;
    fn write(&self, path: &str, data: &[u8]) -> Result<(), StorageError>;
    fn exists(&self, path: &str) -> bool;
    fn list(&self, prefix: &str) -> Result<Vec<String>, StorageError>;
    fn delete(&self, path: &str) -> Result<(), StorageError>;
    fn sync(&self) -> Result<(), StorageError>;
}

/// Real filesystem backend for production.
pub struct FsBackend {
    root: PathBuf,
}

impl StorageBackend for FsBackend {
    fn read(&self, path: &str) -> Result<Vec<u8>, StorageError> {
        Ok(std::fs::read(self.root.join(path))?)
    }
    fn write(&self, path: &str, data: &[u8]) -> Result<(), StorageError> {
        std::fs::write(self.root.join(path), data)?;
        Ok(())
    }
    fn exists(&self, path: &str) -> bool {
        self.root.join(path).exists()
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, StorageError> {
        let mut result = Vec::new();
        for entry in std::fs::read_dir(self.root.join(prefix))? {
            result.push(entry?.file_name().to_string_lossy().into_owned());
        }
        Ok(result)
    }
    fn delete(&self, path: &str) -> Result<(), StorageError> {
        std::fs::remove_file(self.root.join(path))?;
        Ok(())
    }
    fn sync(&self) -> Result<(), StorageError> {
        // fsync the directory
        let dir = std::fs::File::open(&self.root)?;
        dir.sync_all()?;
        Ok(())
    }
}

/// In-memory backend for deterministic tests — no filesystem, no flakiness.
#[cfg(test)]
pub struct InMemoryBackend {
    files: std::sync::Mutex<HashMap<String, Vec<u8>>>,
}

#[cfg(test)]
impl InMemoryBackend {
    pub fn new() -> Self {
        Self { files: std::sync::Mutex::new(HashMap::new()) }
    }
}

#[cfg(test)]
impl StorageBackend for InMemoryBackend {
    fn read(&self, path: &str) -> Result<Vec<u8>, StorageError> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or(StorageError::NotFound(path.to_string()))
    }
    fn write(&self, path: &str, data: &[u8]) -> Result<(), StorageError> {
        self.files.lock().unwrap().insert(path.to_string(), data.to_vec());
        Ok(())
    }
    fn exists(&self, path: &str) -> bool {
        self.files.lock().unwrap().contains_key(path)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, StorageError> {
        Ok(self.files.lock().unwrap().keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect())
    }
    fn delete(&self, path: &str) -> Result<(), StorageError> {
        self.files.lock().unwrap().remove(path);
        Ok(())
    }
    fn sync(&self) -> Result<(), StorageError> {
        Ok(()) // No-op in memory
    }
}
```

### Deterministic time

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Injectable clock for deterministic time in tests.
pub trait Clock: Send + Sync {
    fn now_micros(&self) -> u64;
}

/// Real system clock for production.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_micros(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
    }
}

/// Fake clock for tests. Time only advances when you tell it to.
#[cfg(test)]
pub struct FakeClock {
    micros: AtomicU64,
}

#[cfg(test)]
impl FakeClock {
    pub fn new(start_micros: u64) -> Self {
        Self { micros: AtomicU64::new(start_micros) }
    }

    pub fn advance(&self, delta_micros: u64) {
        self.micros.fetch_add(delta_micros, Ordering::SeqCst);
    }

    pub fn set(&self, micros: u64) {
        self.micros.store(micros, Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn now_micros(&self) -> u64 {
        self.micros.load(Ordering::SeqCst)
    }
}
```

Usage in MVCC or TTL logic:

```rust
pub struct MvccStore<C: Clock> {
    clock: Arc<C>,
    // ...
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_sees_data_at_read_time() {
        let clock = Arc::new(FakeClock::new(1000));
        let store = MvccStore::new(clock.clone());

        // Write at t=1000
        store.put("key1", b"value_v1").unwrap();

        // Advance time, write again
        clock.advance(100);
        store.put("key1", b"value_v2").unwrap();

        // Snapshot at t=1050 sees v1 (before the t=1100 write)
        let snap = store.snapshot_at(1050);
        assert_eq!(snap.get("key1").unwrap(), b"value_v1");

        // Snapshot at t=1100 sees v2
        let snap = store.snapshot_at(1100);
        assert_eq!(snap.get("key1").unwrap(), b"value_v2");
    }
}
```

### Deterministic random — seeded RNG

For algorithms that use randomness (HNSW level selection, sampling, random restarts), inject a seeded RNG:

```rust
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

pub struct HnswIndex<R: Rng> {
    rng: R,
    max_level: usize,
    // ...
}

impl<R: Rng> HnswIndex<R> {
    pub fn new(rng: R, max_level: usize) -> Self {
        Self { rng, max_level }
    }

    fn random_level(&mut self) -> usize {
        let mut level = 0;
        while self.rng.gen::<f64>() < 0.5 && level < self.max_level {
            level += 1;
        }
        level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_level_assignment() {
        let rng = StdRng::seed_from_u64(42);
        let mut index = HnswIndex::new(rng, 6);

        // Same seed always produces the same level sequence
        let levels: Vec<usize> = (0..10).map(|_| index.random_level()).collect();
        assert_eq!(levels, vec![0, 1, 0, 0, 0, 2, 0, 0, 0, 0]); // deterministic
    }
}
```

### Simulating crashes — partial writes

Test that your storage engine recovers from crashes mid-write:

```rust
#[cfg(test)]
struct CrashingBackend {
    inner: InMemoryBackend,
    crash_after_bytes: Option<usize>,
}

#[cfg(test)]
impl StorageBackend for CrashingBackend {
    fn write(&self, path: &str, data: &[u8]) -> Result<(), StorageError> {
        if let Some(limit) = self.crash_after_bytes {
            if data.len() > limit {
                // Simulate partial write — only first `limit` bytes land
                self.inner.write(path, &data[..limit])?;
                return Err(StorageError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "simulated crash",
                )));
            }
        }
        self.inner.write(path, data)
    }
    // delegate other methods to inner...
}

#[test]
fn recovery_after_partial_wal_write() {
    let backend = CrashingBackend {
        inner: InMemoryBackend::new(),
        crash_after_bytes: Some(64),
    };
    let mut engine = StorageEngine::with_backend(Arc::new(backend));

    // This write will be partially written
    let result = engine.insert("key", &vec![0u8; 256]);
    assert!(result.is_err());

    // Recovery should detect the partial write via CRC mismatch and truncate
    engine.recover().unwrap();

    // The partial entry should not be visible
    assert_eq!(engine.get("key").unwrap(), None);
}
```

## Async Testing

### Basic async test with tokio

```rust
#[tokio::test]
async fn async_read_returns_written_data() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = AsyncStorageEngine::open(dir.path()).await.unwrap();
    engine.put("key1", b"value1").await.unwrap();
    let result = engine.get("key1").await.unwrap();
    assert_eq!(result, Some(b"value1".to_vec()));
}
```

### Multi-threaded async test with timeout

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writers_do_not_lose_data() {
    use tokio::time::{timeout, Duration};

    timeout(Duration::from_secs(10), async {
        let dir = tempfile::TempDir::new().unwrap();
        let engine = Arc::new(AsyncStorageEngine::open(dir.path()).await.unwrap());

        let mut handles = Vec::new();
        for writer_id in 0..8 {
            let engine = engine.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..100 {
                    engine
                        .put(format!("w{writer_id}_k{i}"), format!("val_{i}").into_bytes())
                        .await
                        .unwrap();
                }
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        // All 800 keys must be present
        for writer_id in 0..8 {
            for i in 0..100 {
                assert!(engine.get(&format!("w{writer_id}_k{i}")).await.unwrap().is_some());
            }
        }
    })
    .await
    .expect("test timed out after 10s");
}
```

### Testing channels and background tasks

```rust
#[tokio::test]
async fn background_compaction_completes() {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<CompactionEvent>(16);
    let dir = tempfile::TempDir::new().unwrap();
    let engine = StorageEngine::open(dir.path()).unwrap();

    // Spawn background compaction task
    let handle = tokio::spawn(async move {
        run_compaction_loop(engine, tx).await
    });

    // Wait for the first compaction event
    let event = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("timed out waiting for compaction")
        .expect("channel closed");

    assert!(event.segments_merged > 0);
    handle.abort();
}
```

## Concurrency Testing with loom

For lock-free data structures and subtle concurrency bugs, `loom` exhaustively explores thread interleavings:

```rust
#[cfg(loom)]
mod loom_tests {
    use loom::sync::atomic::{AtomicUsize, Ordering};
    use loom::sync::Arc;
    use loom::thread;

    #[test]
    fn concurrent_counter_is_linearizable() {
        loom::model(|| {
            let counter = Arc::new(AtomicUsize::new(0));

            let handles: Vec<_> = (0..3)
                .map(|_| {
                    let counter = counter.clone();
                    thread::spawn(move || {
                        counter.fetch_add(1, Ordering::SeqCst);
                    })
                })
                .collect();

            for h in handles {
                h.join().unwrap();
            }

            assert_eq!(counter.load(Ordering::SeqCst), 3);
        });
    }
}
```

Gate loom tests behind a cfg flag so they only run when explicitly requested:

```toml
# Cargo.toml
[target.'cfg(loom)'.dev-dependencies]
loom = "0.7"
```

```bash
# Run loom tests (slow — exhaustive exploration)
RUSTFLAGS="--cfg loom" cargo test --lib loom_tests
```

## Test Fixtures and Builders

### Temporary directories — the `TempDir` lifetime trap

`TempDir` deletes the directory when dropped. You must keep it alive for the entire test:

```rust
#[test]
fn correct_tempdir_lifetime() {
    let dir = tempfile::TempDir::new().unwrap();
    let engine = StorageEngine::open(dir.path()).unwrap();
    // dir is still alive here — engine can use the files
    engine.insert("key", b"value").unwrap();
    // dir drops after engine, cleaning up the test directory
}

// WRONG — dir drops immediately, engine has dangling path
// let engine = StorageEngine::open(TempDir::new().unwrap().path()).unwrap();
```

### Test data builders

```rust
#[cfg(test)]
pub struct TestRowBuilder {
    columns: Vec<(&'static str, Datum)>,
}

#[cfg(test)]
impl TestRowBuilder {
    pub fn new() -> Self {
        Self { columns: Vec::new() }
    }

    pub fn int(mut self, name: &'static str, val: i64) -> Self {
        self.columns.push((name, Datum::BigInt(val)));
        self
    }

    pub fn text(mut self, name: &'static str, val: &str) -> Self {
        self.columns.push((name, Datum::Text(val.to_string())));
        self
    }

    pub fn float(mut self, name: &'static str, val: f64) -> Self {
        self.columns.push((name, Datum::Double(val)));
        self
    }

    pub fn null(mut self, name: &'static str) -> Self {
        self.columns.push((name, Datum::Null));
        self
    }

    pub fn build(self) -> Row {
        Row::from_pairs(self.columns)
    }
}

// Usage:
#[test]
fn insert_and_read_mixed_types() {
    let row = TestRowBuilder::new()
        .int("id", 1)
        .text("name", "Alice")
        .float("score", 98.5)
        .null("notes")
        .build();

    engine.insert_row(&schema, row).unwrap();
}
```

### Snapshot testing for query plans

```rust
#[test]
fn select_star_produces_expected_plan() {
    let schema = sample_schema();
    let plan = planner.plan("SELECT * FROM test WHERE id > 10", &schema).unwrap();
    let formatted = plan.display_tree();

    // Use insta for snapshot testing
    insta::assert_snapshot!(formatted, @r###"
    Projection: *
      Filter: id > 10
        TableScan: test
    "###);
}
```

Add `insta` to dev-dependencies:

```toml
[dev-dependencies]
insta = { version = "1", features = ["redactions"] }
```

Update snapshots with `cargo insta review`.

## Benchmarking with criterion

### Basic benchmark

```rust
// benches/storage_bench.rs
use criterion::{black_box, criterion_group, criterion_main, Criterion, BenchmarkId, Throughput};

fn bench_wal_append(c: &mut Criterion) {
    let mut group = c.benchmark_group("wal_append");

    for payload_size in [64, 256, 1024, 4096, 16384] {
        group.throughput(Throughput::Bytes(payload_size as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(payload_size),
            &payload_size,
            |b, &size| {
                let dir = tempfile::TempDir::new().unwrap();
                let mut wal = WalWriter::open(dir.path()).unwrap();
                let payload = vec![0xABu8; size];

                b.iter(|| {
                    wal.append(WalEntryType::Insert, black_box(&payload)).unwrap();
                });
            },
        );
    }

    group.finish();
}
```

### Parameterized comparison benchmarks

```rust
fn bench_distance_functions(c: &mut Criterion) {
    let mut group = c.benchmark_group("vector_distance");

    for dim in [128, 384, 768, 1536] {
        let a: Vec<f32> = (0..dim).map(|i| (i as f32) * 0.001).collect();
        let b: Vec<f32> = (0..dim).map(|i| (i as f32) * 0.002).collect();

        group.bench_with_input(
            BenchmarkId::new("cosine", dim),
            &(&a, &b),
            |bench, (a, b)| bench.iter(|| cosine_distance(black_box(a), black_box(b))),
        );
        group.bench_with_input(
            BenchmarkId::new("l2", dim),
            &(&a, &b),
            |bench, (a, b)| bench.iter(|| l2_distance(black_box(a), black_box(b))),
        );
        group.bench_with_input(
            BenchmarkId::new("dot_product", dim),
            &(&a, &b),
            |bench, (a, b)| bench.iter(|| dot_product(black_box(a), black_box(b))),
        );
    }

    group.finish();
}

criterion_group!(benches, bench_wal_append, bench_distance_functions);
criterion_main!(benches);
```

### Cargo.toml setup for benchmarks

```toml
# In root Cargo.toml or crate Cargo.toml

[dev-dependencies]
criterion = { workspace = true }

[[bench]]
name = "storage_bench"
harness = false

[[bench]]
name = "vector_bench"
harness = false
```

### Running benchmarks

```bash
# Run all benchmarks
cargo bench

# Run specific benchmark group
cargo bench --bench storage_bench

# Run with filtering
cargo bench --bench vector_bench -- "cosine"

# Save baseline for comparison
cargo bench --bench storage_bench -- --save-baseline before_optimization

# Compare against baseline
cargo bench --bench storage_bench -- --baseline before_optimization
```

## Fuzz Testing with cargo-fuzz

Fuzz every parser, every deserializer, every function that takes untrusted bytes.

### Setup

```bash
cargo install cargo-fuzz
cargo fuzz init
```

### Fuzz target for a binary format reader

```rust
// fuzz/fuzz_targets/wal_frame_parse.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
use mydb_storage::WalFrame;

fuzz_target!(|data: &[u8]| {
    // Must never panic on arbitrary input — may return Err, that is fine
    let _ = WalFrame::decode(&mut &data[..]);
});
```

### Fuzz target for a segment reader

```rust
// fuzz/fuzz_targets/segment_read.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
use mydb_storage::SegmentReader;

fuzz_target!(|data: &[u8]| {
    if let Ok(reader) = SegmentReader::try_from_bytes(data) {
        // If it parsed, iteration must not panic
        for entry in reader.iter() {
            let _ = entry;
        }
    }
});
```

### Structured fuzzing with `Arbitrary`

For fuzzing higher-level operations, derive `Arbitrary` to generate structured inputs:

```rust
// fuzz/fuzz_targets/engine_ops.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

#[derive(Arbitrary, Debug)]
enum FuzzOp {
    Insert { key: String, value: Vec<u8> },
    Get { key: String },
    Delete { key: String },
    Flush,
    Compact,
}

fuzz_target!(|ops: Vec<FuzzOp>| {
    let dir = tempfile::TempDir::new().unwrap();
    let mut engine = StorageEngine::open(dir.path()).unwrap();

    for op in ops {
        match op {
            FuzzOp::Insert { key, value } => { let _ = engine.insert(&key, value); }
            FuzzOp::Get { key } => { let _ = engine.get(&key); }
            FuzzOp::Delete { key } => { let _ = engine.delete(&key); }
            FuzzOp::Flush => { let _ = engine.flush(); }
            FuzzOp::Compact => { let _ = engine.compact(); }
        }
    }
});
```

### Running fuzzer

```bash
# Run a fuzz target
cargo +nightly fuzz run wal_frame_parse

# Run with a time limit
cargo +nightly fuzz run wal_frame_parse -- -max_total_time=300

# Run with a corpus directory
cargo +nightly fuzz run wal_frame_parse fuzz/corpus/wal_frame_parse/
```

## Test Patterns Cheat Sheet

| What to Test | Pattern | Tool |
|---|---|---|
| Binary format round-trip | Write then read then assert equal | `proptest` |
| Type coercion | Arbitrary types then coerce then verify | `proptest` |
| Sorted output invariant | Insert random keys, scan, assert sorted | `proptest` |
| Storage crash recovery | Write, simulate partial crash, recover | Deterministic I/O |
| MVCC snapshot isolation | Fake clock, write at different times, read snapshots | Deterministic time |
| Concurrent access | Spawn N tasks, verify no data loss | `tokio::test` multi-thread |
| Lock-free correctness | Exhaustive interleaving exploration | `loom` |
| Performance regression | Benchmark critical paths with throughput | `criterion` |
| Malformed input handling | Fuzz with random bytes, must not panic | `cargo-fuzz` |
| Query plan correctness | Format plan tree, compare snapshot | `insta` |
| WAL integrity | Write with checksums, corrupt bytes, detect | Unit test |
| Deterministic algorithms | Seed RNG, assert identical output | `StdRng::seed_from_u64` |

## Key Dependencies

```toml
[dev-dependencies]
proptest = "1"               # Property-based testing
criterion = { version = "0.5", features = ["html_reports"] }  # Benchmarking
tempfile = "3"               # Temporary directories for test isolation
insta = { version = "1", features = ["redactions"] }  # Snapshot testing
tokio-test = "0.4"           # Async test utilities
loom = "0.7"                 # Concurrency model checker

# In fuzz/Cargo.toml
[dependencies]
libfuzzer-sys = "0.4"        # Fuzz target harness
arbitrary = { version = "1", features = ["derive"] }  # Structured fuzzing
```

## Running Tests

```bash
# All tests
cargo test --workspace --all-features

# Single crate
cargo test -p mydb-storage

# Single test function
cargo test -p mydb-storage wal_frame_roundtrip

# Integration tests only
cargo test --test storage_integration

# With output (see println! in tests)
cargo test -- --nocapture

# Run ignored (slow) tests
cargo test -- --ignored

# Benchmarks
cargo bench --bench storage_bench

# Miri (validates unsafe)
cargo +nightly miri test --workspace

# Loom (exhaustive concurrency)
RUSTFLAGS="--cfg loom" cargo test --lib loom_tests

# Fuzz
cargo +nightly fuzz run wal_frame_parse -- -max_total_time=300
```
