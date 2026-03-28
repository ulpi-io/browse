# Async & Concurrency — Tokio Runtime, io_uring, Crossbeam Lock-Free, Concurrent Data Structures

Every concurrent Rust component assumes these patterns. Do not deviate.

## Tokio Runtime

### Runtime Setup

```rust
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // For most services: use the macro. Tokio picks sensible defaults.
    run_server().await
}
```

When you need explicit control over threads, queue depth, or thread naming:

```rust
fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(num_cpus::get())
        .max_blocking_threads(64)         // ceiling for spawn_blocking pool
        .thread_name("engine-worker")
        .thread_stack_size(4 * 1024 * 1024)
        .enable_all()
        .build()?;

    runtime.block_on(async {
        run_server().await
    })
}
```

**When to customize:**
- `worker_threads` — match physical cores for CPU-heavy async tasks; default is fine for I/O-bound workloads
- `max_blocking_threads` — raise above 512 if the blocking pool saturates (compression, hashing, fsync)
- `thread_name` — essential for profiling and `top -H` readability in production
- `thread_stack_size` — raise only for deeply recursive call stacks (parser, query planner)

### Task Types — When to Use Each

#### `tokio::spawn` — Concurrent I/O Tasks

Use for anything that awaits network, disk, or channel I/O. The future must be `Send + 'static`.

```rust
use tokio::net::TcpStream;

async fn handle_connections(listener: tokio::net::TcpListener) {
    loop {
        let (stream, peer) = listener.accept().await.unwrap();
        tokio::spawn(async move {
            if let Err(e) = process_connection(stream).await {
                tracing::error!(?peer, error = %e, "connection failed");
            }
        });
    }
}

async fn process_connection(stream: TcpStream) -> anyhow::Result<()> {
    // All I/O here is async — reads, writes, channel sends
    todo!()
}
```

#### `tokio::task::spawn_blocking` — CPU-Bound Work

Use for anything that takes >10us without an await point: compression, hashing, CRC computation, SIMD distance calculations, serialization of large payloads.

```rust
use bytes::Bytes;

/// Compress a WAL segment before writing to object storage.
async fn compress_segment(data: Bytes) -> anyhow::Result<Bytes> {
    tokio::task::spawn_blocking(move || {
        let mut encoder = zstd::Encoder::new(Vec::new(), 3)?;
        std::io::Write::write_all(&mut encoder, &data)?;
        let compressed = encoder.finish()?;
        Ok(Bytes::from(compressed))
    })
    .await?
}

/// Hash a block for content-addressed storage.
async fn hash_block(data: Bytes) -> [u8; 32] {
    tokio::task::spawn_blocking(move || {
        use ring::digest;
        let hash = digest::digest(&digest::SHA256, &data);
        let mut out = [0u8; 32];
        out.copy_from_slice(hash.as_ref());
        out
    })
    .await
    .expect("blocking task panicked")
}
```

**Never do this on the tokio runtime directly** — it blocks the worker thread and starves other tasks:

```rust
// WRONG: blocks the async runtime
async fn bad_compress(data: &[u8]) -> Vec<u8> {
    zstd::encode_all(data, 3).unwrap() // This takes milliseconds — blocks the worker
}
```

#### Dedicated OS Threads — Long-Running Background Work

Use `std::thread::spawn` for work that runs for the lifetime of the process and does not need async I/O: compaction loops, WAL flush threads, background merge operations.

```rust
use crossbeam_channel::{Receiver, bounded};
use std::thread;

struct CompactionHandle {
    _thread: thread::JoinHandle<()>,
}

fn start_compaction_thread(rx: Receiver<CompactionRequest>) -> CompactionHandle {
    let handle = thread::Builder::new()
        .name("compaction".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            while let Ok(request) = rx.recv() {
                // CPU-bound: merge sorted runs, rewrite segments
                // This runs on its own OS thread — never touches tokio
                if let Err(e) = compact(request) {
                    tracing::error!(error = %e, "compaction failed");
                }
            }
            tracing::info!("compaction thread exiting");
        })
        .expect("failed to spawn compaction thread");

    CompactionHandle { _thread: handle }
}
```

#### `tokio::task::spawn_local` — `!Send` Futures

Rare. Use only when a future holds a non-Send type (e.g., `Rc`, raw pointers to thread-local data). Requires a `LocalSet`:

```rust
use tokio::task::LocalSet;

async fn run_local_work() {
    let local = LocalSet::new();
    local.run_until(async {
        tokio::task::spawn_local(async {
            // Can hold Rc, Cell, and other !Send types here
        }).await.unwrap();
    }).await;
}
```

### Graceful Shutdown

Complete pattern using `CancellationToken` with drain period:

```rust
use std::time::Duration;
use tokio::signal;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

pub struct ShutdownController {
    token: CancellationToken,
    drain_tx: watch::Sender<bool>,
    drain_rx: watch::Receiver<bool>,
}

impl ShutdownController {
    pub fn new() -> Self {
        let (drain_tx, drain_rx) = watch::channel(false);
        Self {
            token: CancellationToken::new(),
            drain_tx,
            drain_rx,
        }
    }

    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn drain_rx(&self) -> watch::Receiver<bool> {
        self.drain_rx.clone()
    }

    /// Run the shutdown sequence:
    /// 1. Receive signal → enter drain mode (stop accepting new work)
    /// 2. Wait `drain_period` for in-flight work to complete
    /// 3. Cancel all remaining tasks
    pub async fn wait_for_shutdown(self, drain_period: Duration) {
        // Wait for SIGINT or SIGTERM
        let ctrl_c = signal::ctrl_c();
        #[cfg(unix)]
        let mut sigterm = signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to register SIGTERM handler");

        #[cfg(unix)]
        tokio::select! {
            _ = ctrl_c => tracing::info!("received SIGINT"),
            _ = sigterm.recv() => tracing::info!("received SIGTERM"),
        }

        #[cfg(not(unix))]
        ctrl_c.await.expect("failed to listen for Ctrl+C");

        // Phase 1: Drain — stop accepting new connections
        tracing::info!("entering drain phase ({drain_period:?})");
        let _ = self.drain_tx.send(true);

        // Phase 2: Wait for in-flight work
        tokio::time::sleep(drain_period).await;

        // Phase 3: Cancel all remaining tasks
        tracing::info!("cancelling remaining tasks");
        self.token.cancel();
    }
}
```

Service integration:

```rust
async fn run_server() -> anyhow::Result<()> {
    let shutdown = ShutdownController::new();
    let token = shutdown.token();
    let mut drain_rx = shutdown.drain_rx();

    let listener = tokio::net::TcpListener::bind("0.0.0.0:5432").await?;

    // Spawn the shutdown controller
    let shutdown_handle = tokio::spawn(shutdown.wait_for_shutdown(Duration::from_secs(30)));

    loop {
        tokio::select! {
            // Accept new connections until drain starts
            result = listener.accept() => {
                let (socket, peer) = result?;
                let task_token = token.clone();
                tokio::spawn(async move {
                    tokio::select! {
                        result = handle_connection(socket) => {
                            if let Err(e) = result {
                                tracing::error!(?peer, error = %e, "connection error");
                            }
                        }
                        _ = task_token.cancelled() => {
                            tracing::debug!(?peer, "connection cancelled");
                        }
                    }
                });
            }
            // Stop accepting when drain signal arrives
            _ = drain_rx.changed() => {
                tracing::info!("drain active — stopped accepting connections");
                break;
            }
        }
    }

    // Wait for shutdown to complete
    shutdown_handle.await?;
    tracing::info!("shutdown complete");
    Ok(())
}
```

### Cancellation Safety

`tokio::select!` drops the losing branch's future. This is safe for some operations and dangerous for others.

#### Safe to cancel

| Operation | Why safe |
|---|---|
| `channel.recv()` | Message stays in channel, next recv gets it |
| `TcpListener::accept()` | Connection stays in backlog |
| `tokio::time::sleep()` | No side effects |
| `CancellationToken::cancelled()` | Idempotent check |
| `tokio::sync::Notify::notified()` | Notification is not consumed until polled to completion |

#### NOT safe to cancel

| Operation | What goes wrong |
|---|---|
| `file.write_all(buf)` | Partial write — file is now corrupt |
| `stream.read_exact(buf)` | Partial read — buffer contains garbage |
| Accumulation loops (`while let Some(chunk) = stream.next().await`) | Accumulated data is lost |
| Multi-step protocol handshakes | Peer sees half a handshake |

#### Pattern: Make cancellation-unsafe code safe

Wrap the entire unsafe sequence in a single `tokio::spawn` — the spawned task runs to completion even if the parent future is cancelled:

```rust
use tokio::sync::oneshot;

/// Flush a WAL buffer to disk. Must not be cancelled mid-write.
async fn flush_wal(wal: &WalWriter, buffer: Vec<u8>) -> anyhow::Result<()> {
    let (tx, rx) = oneshot::channel();
    let wal = wal.clone();

    // Spawn an uncancellable task — runs to completion even if the caller drops us
    tokio::spawn(async move {
        let result = wal.write_and_fsync(buffer).await;
        let _ = tx.send(result);
    });

    rx.await?
}
```

#### Pattern: Checkpoint before yield points

```rust
/// Process a batch of mutations. Checkpoint after each item so cancellation
/// never loses more than one item of work.
async fn process_batch(items: Vec<Mutation>, state: &mut ProcessState) -> anyhow::Result<()> {
    for item in items {
        // Apply the mutation
        state.apply(&item)?;

        // Checkpoint — if we get cancelled after this yield, the mutation is saved
        state.checkpoint().await?;

        // Yield to allow cancellation between items, not during an item
        tokio::task::yield_now().await;
    }
    Ok(())
}
```

## Async Traits

### Native Async Fn in Traits (Rust 1.75+)

Since Rust 1.75, async functions work directly in traits:

```rust
pub trait StorageBackend: Send + Sync {
    async fn read(&self, path: &str, offset: u64, len: u64) -> Result<bytes::Bytes, StorageError>;
    async fn write(&self, path: &str, data: &[u8]) -> Result<(), StorageError>;
    async fn delete(&self, path: &str) -> Result<(), StorageError>;
    async fn exists(&self, path: &str) -> Result<bool, StorageError>;
}
```

**Limitation:** native async trait methods do not automatically produce `Send` futures. When you need the future to be `Send` (for `tokio::spawn`), you must add the bound explicitly:

```rust
pub trait StorageBackend: Send + Sync {
    fn read(&self, path: &str, offset: u64, len: u64)
        -> impl Future<Output = Result<bytes::Bytes, StorageError>> + Send;
}
```

### `async_trait` Crate — When Still Needed

Use `async_trait` when:
1. You need `dyn Trait` (object safety) — native async traits are not object-safe
2. You target older MSRV (<1.75)
3. A third-party crate requires it (e.g., `pgwire`, `datafusion`)

```rust
use async_trait::async_trait;

#[async_trait]
pub trait QueryExecutor: Send + Sync {
    async fn execute(&self, plan: &ExecutionPlan) -> Result<RecordBatchStream, QueryError>;
}

// Can be used as dyn Trait:
async fn run_query(executor: &dyn QueryExecutor, plan: &ExecutionPlan) {
    let stream = executor.execute(plan).await.unwrap();
    // ...
}
```

### Decision: Native vs `async_trait`

| Requirement | Use |
|---|---|
| Concrete types only, Rust >=1.75 | Native `async fn` in trait |
| Need `dyn Trait` (dynamic dispatch) | `#[async_trait]` |
| Third-party crate mandates it | `#[async_trait]` |
| Performance-critical hot path, monomorphization wanted | Native `async fn` in trait |

## io_uring (Linux)

### Why io_uring

Standard POSIX file I/O (`read`/`write`/`pread`/`pwrite`) requires one syscall per operation. `io_uring` amortizes syscall overhead by batching:

- **Submission Queue (SQ):** userspace pushes I/O requests without a syscall
- **Completion Queue (CQ):** kernel pushes results without a syscall
- **Single `io_uring_enter` syscall** submits and reaps an entire batch

For random read-heavy workloads (page lookups, index traversal), io_uring achieves 2-3x the IOPS of `pread` because it eliminates per-operation syscall overhead and enables the kernel to optimize scheduling across the batch.

### Basic Usage with the `io-uring` Crate

```rust
#[cfg(target_os = "linux")]
use io_uring::{IoUring, opcode, types, squeue};
use std::os::unix::io::AsRawFd;

#[cfg(target_os = "linux")]
pub struct UringReader {
    ring: IoUring,
}

#[cfg(target_os = "linux")]
impl UringReader {
    pub fn new(queue_depth: u32) -> std::io::Result<Self> {
        let ring = IoUring::builder()
            .setup_sqpoll(1000) // kernel-side polling — reduces syscalls further
            .build(queue_depth)?;
        Ok(Self { ring })
    }

    /// Read a single block from the file at the given offset.
    pub fn read_block(
        &mut self,
        fd: &std::fs::File,
        buf: &mut [u8],
        offset: u64,
    ) -> std::io::Result<usize> {
        let read_entry = opcode::Read::new(
            types::Fd(fd.as_raw_fd()),
            buf.as_mut_ptr(),
            buf.len() as u32,
        )
        .offset(offset)
        .build()
        .user_data(0x01);

        // Submit
        unsafe {
            self.ring.submission().push(&read_entry)
                .map_err(|_| std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "submission queue full",
                ))?;
        }
        self.ring.submit_and_wait(1)?;

        // Reap
        let cqe = self.ring.completion().next()
            .ok_or_else(|| std::io::Error::new(
                std::io::ErrorKind::Other,
                "no completion entry",
            ))?;

        let result = cqe.result();
        if result < 0 {
            Err(std::io::Error::from_raw_os_error(-result))
        } else {
            Ok(result as usize)
        }
    }

    /// Submit a batch of reads and wait for all completions.
    /// Returns results in submission order.
    pub fn read_batch(
        &mut self,
        fd: &std::fs::File,
        requests: &mut [(Vec<u8>, u64)], // (buffer, offset) pairs
    ) -> std::io::Result<Vec<usize>> {
        let raw_fd = fd.as_raw_fd();

        // Submit all reads
        for (i, (buf, offset)) in requests.iter_mut().enumerate() {
            let entry = opcode::Read::new(
                types::Fd(raw_fd),
                buf.as_mut_ptr(),
                buf.len() as u32,
            )
            .offset(*offset)
            .build()
            .user_data(i as u64);

            unsafe {
                self.ring.submission().push(&entry)
                    .map_err(|_| std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "submission queue full",
                    ))?;
            }
        }

        // Submit and wait for all
        self.ring.submit_and_wait(requests.len())?;

        // Collect results, ordered by user_data
        let mut results = vec![0usize; requests.len()];
        for cqe in self.ring.completion() {
            let idx = cqe.user_data() as usize;
            let result = cqe.result();
            if result < 0 {
                return Err(std::io::Error::from_raw_os_error(-result));
            }
            results[idx] = result as usize;
        }

        Ok(results)
    }
}
```

### Feature Gating for Platform Portability

io_uring is Linux-only. Gate it behind both `#[cfg(target_os = "linux")]` and a feature flag so the crate compiles on all platforms:

```rust
// In Cargo.toml:
// [features]
// io-uring = ["dep:io-uring"]
//
// [target.'cfg(target_os = "linux")'.dependencies]
// io-uring = { workspace = true, optional = true }

#[cfg(all(target_os = "linux", feature = "io-uring"))]
mod uring_backend;

#[cfg(not(all(target_os = "linux", feature = "io-uring")))]
mod fallback_backend;

// Unified trait — callers do not know which backend is active
pub trait BlockReader: Send + Sync {
    fn read_block(&self, offset: u64, len: u32) -> std::io::Result<Vec<u8>>;
    fn read_batch(&self, requests: &[(u64, u32)]) -> std::io::Result<Vec<Vec<u8>>>;
}

// Fallback uses standard pread — works on macOS, Windows, all Linuxes
#[cfg(not(all(target_os = "linux", feature = "io-uring")))]
mod fallback_backend {
    use std::os::unix::fs::FileExt;

    pub struct PreadReader {
        file: std::fs::File,
    }

    impl super::BlockReader for PreadReader {
        fn read_block(&self, offset: u64, len: u32) -> std::io::Result<Vec<u8>> {
            let mut buf = vec![0u8; len as usize];
            self.file.read_exact_at(&mut buf, offset)?;
            Ok(buf)
        }

        fn read_batch(&self, requests: &[(u64, u32)]) -> std::io::Result<Vec<Vec<u8>>> {
            requests.iter()
                .map(|&(offset, len)| self.read_block(offset, len))
                .collect()
        }
    }
}
```

### io_uring with O_DIRECT

For bypassing the page cache (large sequential scans, compaction reads where data is used once):

```rust
#[cfg(target_os = "linux")]
use std::os::unix::fs::OpenOptionsExt;

#[cfg(target_os = "linux")]
fn open_direct(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECT)
        .open(path)
}
```

**O_DIRECT constraints:** buffer must be aligned to 512 bytes (or filesystem block size), read length must be a multiple of 512 bytes. Use `aligned_alloc` or manually align buffers.

## Crossbeam Lock-Free Structures

### SkipMap — Concurrent Sorted Map

`SkipMap` provides lock-free concurrent reads and writes with sorted key ordering. Ideal for in-memory sorted indices:

```rust
use crossbeam_skiplist::SkipMap;
use bytes::Bytes;

pub struct Memtable {
    data: SkipMap<Bytes, Bytes>,
    size: std::sync::atomic::AtomicUsize,
}

impl Memtable {
    pub fn new() -> Self {
        Self {
            data: SkipMap::new(),
            size: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn insert(&self, key: Bytes, value: Bytes) {
        let entry_size = key.len() + value.len();
        self.data.insert(key, value);
        self.size.fetch_add(entry_size, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn get(&self, key: &[u8]) -> Option<Bytes> {
        self.data.get(key).map(|entry| entry.value().clone())
    }

    /// Iterate over a key range — lock-free, consistent snapshot.
    pub fn range(&self, start: &[u8], end: &[u8]) -> Vec<(Bytes, Bytes)> {
        self.data
            .range(Bytes::copy_from_slice(start)..Bytes::copy_from_slice(end))
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect()
    }

    pub fn approximate_size(&self) -> usize {
        self.size.load(std::sync::atomic::Ordering::Relaxed)
    }
}
```

### Epoch-Based Reclamation

Crossbeam uses epoch-based garbage collection to safely reclaim memory in lock-free structures. Understanding this is essential for debugging memory growth:

**How it works:**
1. Each thread pins the current global epoch before accessing shared data
2. While pinned, no memory from the current or adjacent epochs is reclaimed
3. When a thread removes data, the removed node is deferred — placed on a garbage list tagged with the current epoch
4. Memory is reclaimed only when all threads have advanced past the epoch in which the data was removed

```rust
use crossbeam_epoch::{self as epoch, Atomic, Owned, Shared};
use std::sync::atomic::Ordering;

pub struct LockFreeStack<T> {
    head: Atomic<Node<T>>,
}

struct Node<T> {
    data: T,
    next: Atomic<Node<T>>,
}

impl<T> LockFreeStack<T> {
    pub fn new() -> Self {
        Self { head: Atomic::null() }
    }

    pub fn push(&self, data: T) {
        let node = Owned::new(Node {
            data,
            next: Atomic::null(),
        });

        let guard = epoch::pin();
        let mut node = node;

        loop {
            let head = self.head.load(Ordering::Relaxed, &guard);
            node.next.store(head, Ordering::Relaxed);

            match self.head.compare_exchange(
                head,
                node,
                Ordering::Release,
                Ordering::Relaxed,
                &guard,
            ) {
                Ok(_) => break,
                Err(err) => node = err.new,
            }
        }
    }

    pub fn pop(&self) -> Option<T> {
        let guard = epoch::pin();
        loop {
            let head = self.head.load(Ordering::Acquire, &guard);
            let head_ref = unsafe { head.as_ref()? };

            let next = head_ref.next.load(Ordering::Relaxed, &guard);

            if self.head
                .compare_exchange(head, next, Ordering::Release, Ordering::Relaxed, &guard)
                .is_ok()
            {
                // SAFETY: We won the CAS, so we have exclusive ownership of this node.
                // Defer deallocation until all threads have advanced past this epoch.
                unsafe {
                    let data = std::ptr::read(&head_ref.data);
                    guard.defer_destroy(head);
                    return Some(data);
                }
            }
        }
    }
}
```

**Key rule:** always `pin()` before accessing shared atomic pointers. Keep the pin duration short — a long-held pin prevents garbage collection across all threads.

### SegQueue — Lock-Free FIFO

```rust
use crossbeam_queue::SegQueue;

/// Lock-free queue for passing completed I/O results back to the event loop.
struct IoCompletionQueue {
    queue: SegQueue<IoResult>,
}

struct IoResult {
    request_id: u64,
    data: Result<Vec<u8>, std::io::Error>,
}

impl IoCompletionQueue {
    fn new() -> Self {
        Self { queue: SegQueue::new() }
    }

    fn push(&self, result: IoResult) {
        self.queue.push(result);
    }

    fn drain(&self) -> Vec<IoResult> {
        let mut results = Vec::new();
        while let Some(result) = self.queue.pop() {
            results.push(result);
        }
        results
    }
}
```

### Crossbeam Channels

Three channel types for different coordination patterns:

```rust
use crossbeam_channel::{bounded, unbounded, select, Receiver, Sender};
use std::time::Duration;

// Bounded — backpressure. Writer blocks when channel is full.
// Use between fast producers and slow consumers (WAL writer → compaction).
let (wal_tx, wal_rx): (Sender<WalEntry>, Receiver<WalEntry>) = bounded(1024);

// Unbounded — fire-and-forget events. Never blocks the sender.
// Use for metrics, logging, notifications where dropping is worse than memory growth.
let (event_tx, event_rx): (Sender<Event>, Receiver<Event>) = unbounded();

// select! — multiplex multiple channels, similar to Go's select.
fn compaction_loop(
    work_rx: Receiver<CompactionRequest>,
    shutdown_rx: Receiver<()>,
) {
    loop {
        select! {
            recv(work_rx) -> msg => {
                match msg {
                    Ok(request) => compact(request),
                    Err(_) => break, // channel closed
                }
            }
            recv(shutdown_rx) -> _ => {
                tracing::info!("compaction shutting down");
                break;
            }
            default(Duration::from_secs(60)) => {
                // No work for 60s — run periodic maintenance
                run_gc();
            }
        }
    }
}
```

**When to use crossbeam channels vs tokio channels:**

| Scenario | Use |
|---|---|
| Sender and receiver are both in async code | `tokio::sync::mpsc` |
| Sender is sync (OS thread), receiver is async | `crossbeam_channel` + `tokio::task::spawn_blocking` to bridge |
| Both sides are sync (dedicated threads) | `crossbeam_channel` |
| Need `select!` across multiple sync channels | `crossbeam_channel::select!` |
| Need `select!` mixing async ops and channels | `tokio::select!` with `tokio::sync` channels |

## Concurrent Patterns for Database Engines

### Reader-Writer Lock with Tokio

```rust
use tokio::sync::RwLock;
use std::sync::Arc;

pub struct Schema {
    pub columns: Vec<ColumnDef>,
    pub version: u64,
}

pub struct TableState {
    /// Many concurrent readers (queries), rare writers (schema changes).
    schema: RwLock<Arc<Schema>>,
}

impl TableState {
    /// Fast path — clone the Arc, release the lock immediately.
    pub async fn schema(&self) -> Arc<Schema> {
        self.schema.read().await.clone()
    }

    /// Slow path — exclusive lock for schema changes.
    pub async fn alter_schema(&self, new_schema: Schema) {
        let mut guard = self.schema.write().await;
        *guard = Arc::new(new_schema);
        // Lock released here — all waiting readers proceed
    }
}
```

**Optimization:** For extremely hot read paths, avoid even the RwLock by using `arc_swap`:

```rust
use arc_swap::ArcSwap;
use std::sync::Arc;

pub struct HotTableState {
    /// Lock-free reads via ArcSwap — no contention on the read path at all.
    schema: ArcSwap<Schema>,
}

impl HotTableState {
    pub fn schema(&self) -> Arc<Schema> {
        self.schema.load_full()
    }

    pub fn update_schema(&self, new_schema: Schema) {
        self.schema.store(Arc::new(new_schema));
    }
}
```

### Double-Buffered Memtable

The double-buffer pattern allows writes to continue on a fresh buffer while the old buffer is being flushed to disk:

```rust
use crossbeam_skiplist::SkipMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use bytes::Bytes;

pub struct DoubleBufferedMemtable {
    /// Index of the currently active table (0 or 1).
    active: AtomicUsize,
    /// The two memtables. Writers always write to tables[active].
    tables: [Arc<SkipMap<Bytes, Bytes>>; 2],
    /// Protects the swap operation — only one flush at a time.
    flush_lock: Mutex<()>,
}

impl DoubleBufferedMemtable {
    pub fn new() -> Self {
        Self {
            active: AtomicUsize::new(0),
            tables: [Arc::new(SkipMap::new()), Arc::new(SkipMap::new())],
            flush_lock: Mutex::new(()),
        }
    }

    /// Insert into the active memtable. Lock-free, concurrent-safe.
    pub fn insert(&self, key: Bytes, value: Bytes) {
        let idx = self.active.load(Ordering::Acquire);
        self.tables[idx].insert(key, value);
    }

    /// Read from the active memtable first, then check the inactive one
    /// (it may still be draining during a flush).
    pub fn get(&self, key: &[u8]) -> Option<Bytes> {
        let idx = self.active.load(Ordering::Acquire);
        if let Some(entry) = self.tables[idx].get(key) {
            return Some(entry.value().clone());
        }
        // Check the inactive table — may still have data being flushed
        let other = 1 - idx;
        self.tables[other].get(key).map(|e| e.value().clone())
    }

    /// Swap the active buffer and return the old one for flushing.
    /// Only one thread calls this at a time (protected by flush_lock).
    pub fn swap_for_flush(&self) -> Arc<SkipMap<Bytes, Bytes>> {
        let _guard = self.flush_lock.lock();
        let old_idx = self.active.load(Ordering::Acquire);
        let new_idx = 1 - old_idx;

        // The new table should be empty (cleared after previous flush completed)
        assert!(self.tables[new_idx].is_empty(), "new buffer not empty — previous flush incomplete");

        // Swap — new writes go to the empty table
        self.active.store(new_idx, Ordering::Release);

        // Return the old table for flushing
        Arc::clone(&self.tables[old_idx])
    }

    /// Called after flush completes — clear the flushed table so it's ready for reuse.
    pub fn clear_flushed(&self, idx: usize) {
        self.tables[idx].clear();
    }
}
```

### MVCC Snapshot Manager

Multi-Version Concurrency Control lets readers see a consistent snapshot while writers proceed without blocking:

```rust
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::RwLock;

pub struct SnapshotManager {
    /// Monotonically increasing transaction ID.
    current_txn: AtomicU64,
    /// Set of all active (in-use) snapshot IDs.
    active_snapshots: RwLock<BTreeSet<u64>>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub txn_id: u64,
    /// This snapshot can see all versions with txn_id < visible_before.
    pub visible_before: u64,
}

impl SnapshotManager {
    pub fn new() -> Self {
        Self {
            current_txn: AtomicU64::new(1),
            active_snapshots: RwLock::new(BTreeSet::new()),
        }
    }

    /// Allocate a new transaction ID.
    pub fn next_txn_id(&self) -> u64 {
        self.current_txn.fetch_add(1, Ordering::SeqCst)
    }

    /// Create a snapshot that sees everything committed before this moment.
    pub fn acquire_snapshot(&self) -> Snapshot {
        let txn_id = self.current_txn.load(Ordering::SeqCst);
        self.active_snapshots.write().insert(txn_id);
        Snapshot {
            txn_id,
            visible_before: txn_id,
        }
    }

    /// Release a snapshot — allows GC of versions it was holding alive.
    pub fn release_snapshot(&self, snapshot: &Snapshot) {
        self.active_snapshots.write().remove(&snapshot.txn_id);
    }

    /// The oldest active snapshot. Versions older than this can be garbage collected
    /// because no reader can see them.
    pub fn min_active_snapshot(&self) -> Option<u64> {
        self.active_snapshots.read().iter().next().copied()
    }

    /// Check if a version is visible to a given snapshot.
    pub fn is_visible(&self, version_txn: u64, snapshot: &Snapshot) -> bool {
        version_txn < snapshot.visible_before
    }
}

/// RAII guard that releases the snapshot when dropped.
pub struct SnapshotGuard<'a> {
    manager: &'a SnapshotManager,
    pub snapshot: Snapshot,
}

impl<'a> SnapshotGuard<'a> {
    pub fn new(manager: &'a SnapshotManager) -> Self {
        let snapshot = manager.acquire_snapshot();
        Self { manager, snapshot }
    }
}

impl Drop for SnapshotGuard<'_> {
    fn drop(&mut self) {
        self.manager.release_snapshot(&self.snapshot);
    }
}
```

Usage:

```rust
fn query_with_snapshot(manager: &SnapshotManager) {
    let guard = SnapshotGuard::new(manager);

    // All reads during this scope see a consistent snapshot
    // Even if other threads are writing new versions concurrently
    let snapshot = &guard.snapshot;

    // When guard is dropped, the snapshot is released
    // GC can now reclaim versions that only this snapshot was keeping alive
}
```

### Group Commit

Batch multiple WAL entries into a single fsync to amortize disk flush cost:

```rust
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, oneshot};
use std::collections::VecDeque;

pub struct WalEntry {
    pub data: Vec<u8>,
}

struct PendingEntry {
    entry: WalEntry,
    done: oneshot::Sender<Result<u64, WalError>>,
}

pub struct GroupCommitter {
    pending: Mutex<VecDeque<PendingEntry>>,
    notify: Notify,
    max_batch_size: usize,
    max_batch_delay: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum WalError {
    #[error("WAL write failed: {0}")]
    Io(#[from] std::io::Error),
}

impl GroupCommitter {
    pub fn new(max_batch_size: usize, max_batch_delay: Duration) -> Self {
        Self {
            pending: Mutex::new(VecDeque::new()),
            notify: Notify::new(),
            max_batch_size,
            max_batch_delay,
        }
    }

    /// Append an entry. Returns the LSN (log sequence number) once the group
    /// commit flushes it to disk. The caller blocks until the flush completes.
    pub async fn append(&self, entry: WalEntry) -> Result<u64, WalError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.push_back(PendingEntry { entry, done: tx });
        }
        self.notify.notify_one();
        rx.await.expect("group committer dropped sender")
    }

    /// Background loop: collect entries, flush in batches.
    pub async fn run(&self, wal_writer: &mut WalWriter) {
        loop {
            // Wait for at least one entry
            self.notify.notified().await;

            // Collect up to max_batch_size entries, or until max_batch_delay expires
            let deadline = Instant::now() + self.max_batch_delay;
            let mut batch = Vec::new();

            loop {
                {
                    let mut pending = self.pending.lock().await;
                    while let Some(entry) = pending.pop_front() {
                        batch.push(entry);
                        if batch.len() >= self.max_batch_size {
                            break;
                        }
                    }
                }

                if batch.len() >= self.max_batch_size || Instant::now() >= deadline {
                    break;
                }

                // Wait briefly for more entries to accumulate
                tokio::select! {
                    _ = self.notify.notified() => continue,
                    _ = tokio::time::sleep_until(deadline.into()) => break,
                }
            }

            if batch.is_empty() {
                continue;
            }

            // Write all entries and fsync once
            let entries: Vec<WalEntry> = batch.iter().map(|p| {
                WalEntry { data: p.entry.data.clone() }
            }).collect();

            let result = wal_writer.write_batch_and_fsync(&entries).await;

            // Notify all waiters
            match result {
                Ok(lsn) => {
                    for (i, pending) in batch.into_iter().enumerate() {
                        let _ = pending.done.send(Ok(lsn + i as u64));
                    }
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    for pending in batch {
                        let _ = pending.done.send(Err(WalError::Io(
                            std::io::Error::new(std::io::ErrorKind::Other, err_msg.clone()),
                        )));
                    }
                }
            }
        }
    }
}
```

### Connection Pool Limiter

Use a semaphore to limit concurrent connections or outstanding I/O:

```rust
use tokio::sync::Semaphore;
use std::sync::Arc;

pub struct ConnectionPool {
    semaphore: Arc<Semaphore>,
    max_connections: usize,
}

impl ConnectionPool {
    pub fn new(max_connections: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_connections)),
            max_connections,
        }
    }

    pub async fn acquire(&self) -> Result<ConnectionGuard, PoolError> {
        let permit = self.semaphore.clone().acquire_owned().await
            .map_err(|_| PoolError::Closed)?;

        let conn = establish_connection().await?;
        Ok(ConnectionGuard { conn, _permit: permit })
    }

    pub fn available(&self) -> usize {
        self.semaphore.available_permits()
    }

    pub fn in_use(&self) -> usize {
        self.max_connections - self.semaphore.available_permits()
    }
}

pub struct ConnectionGuard {
    conn: Connection,
    _permit: tokio::sync::OwnedSemaphorePermit, // released on drop
}
```

### Config Broadcast with `watch`

When configuration changes must propagate to all tasks:

```rust
use tokio::sync::watch;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub max_batch_size: usize,
    pub flush_interval_ms: u64,
    pub compression_level: i32,
}

pub struct ConfigManager {
    tx: watch::Sender<Arc<RuntimeConfig>>,
}

impl ConfigManager {
    pub fn new(initial: RuntimeConfig) -> (Self, watch::Receiver<Arc<RuntimeConfig>>) {
        let (tx, rx) = watch::channel(Arc::new(initial));
        (Self { tx }, rx)
    }

    pub fn update(&self, new_config: RuntimeConfig) {
        let _ = self.tx.send(Arc::new(new_config));
        // All receivers are immediately notified
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<RuntimeConfig>> {
        self.tx.subscribe()
    }
}

/// In a worker task:
async fn worker(mut config_rx: watch::Receiver<Arc<RuntimeConfig>>) {
    let mut config = config_rx.borrow_and_update().clone();

    loop {
        tokio::select! {
            _ = config_rx.changed() => {
                config = config_rx.borrow_and_update().clone();
                tracing::info!(?config, "config updated");
            }
            _ = do_work(&config) => {}
        }
    }
}
```

### Fan-Out Events with `broadcast`

When multiple consumers need every event (replication subscribers, change data capture):

```rust
use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub enum ChangeEvent {
    Insert { table: String, key: Vec<u8> },
    Delete { table: String, key: Vec<u8> },
    SchemaChange { table: String },
}

pub struct EventBus {
    tx: broadcast::Sender<ChangeEvent>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn publish(&self, event: ChangeEvent) {
        // Returns Err if there are no active receivers — that's fine
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.tx.subscribe()
    }
}

/// Replication subscriber:
async fn replication_stream(mut rx: broadcast::Receiver<ChangeEvent>) {
    loop {
        match rx.recv().await {
            Ok(event) => replicate(event).await,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(skipped = n, "replication subscriber lagged — events dropped");
                // Must handle this: trigger a full resync or accept data loss
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}
```

## Synchronization Primitives Cheat Sheet

| Primitive | Use Case | Crate | Notes |
|---|---|---|---|
| `AtomicU64` / `AtomicUsize` | Counters, sequence numbers, flags | `std::sync::atomic` | Lock-free. Use `Ordering::Relaxed` for counters, `SeqCst` for sequence numbers |
| `RwLock` | Many readers, rare writers | `tokio::sync` (async) or `parking_lot` (sync) | Tokio version is fair; parking_lot is faster for short critical sections |
| `Mutex` | Short critical sections | `tokio::sync` (async) or `parking_lot` (sync) | Never hold a tokio Mutex across an await point if possible |
| `Semaphore` | Connection pool, concurrency limits | `tokio::sync` | `acquire_owned()` for moving permits across tasks |
| `Notify` | One-shot wakeup, "something happened" | `tokio::sync` | Not a counter — multiple `notify_one()` calls coalesce into one wakeup |
| `watch` | Config broadcast, "latest value" | `tokio::sync` | Receivers always see the most recent value; intermediate values may be skipped |
| `broadcast` | Fan-out events, all consumers see every event | `tokio::sync` | Bounded. Slow receivers get `Lagged` error |
| `mpsc` | Work queue, single consumer | `tokio::sync` | Bounded for backpressure, unbounded for fire-and-forget |
| `oneshot` | Single result delivery, future completion | `tokio::sync` | Group commit result notification, spawn_blocking result |
| `SkipMap` | Lock-free sorted map | `crossbeam-skiplist` | Memtable, sorted index. Epoch-based GC |
| `SegQueue` | Lock-free FIFO | `crossbeam-queue` | I/O completion queue, work stealing |
| `ArrayQueue` | Bounded lock-free FIFO | `crossbeam-queue` | Fixed capacity, try_push/try_pop |
| `DashMap` | Concurrent hash map | `dashmap` | Sharded. Fast reads, good for caches and metadata lookups |
| `ArcSwap` | Lock-free pointer swap | `arc-swap` | Hot-path config, schema pointers — zero contention reads |
| `Barrier` | Synchronize N threads at a point | `tokio::sync` | Phase-based algorithms, parallel test setup |

### Ordering Quick Reference

| Ordering | Use when |
|---|---|
| `Relaxed` | Counters, statistics — no ordering guarantees needed |
| `Acquire` / `Release` | Paired loads/stores — reader sees everything writer did before the store |
| `SeqCst` | Transaction IDs, sequence numbers — total ordering across all threads |

Rule of thumb: start with `SeqCst` for correctness, downgrade to `Acquire`/`Release` after profiling shows contention, use `Relaxed` only for statistics where stale reads are acceptable.

## Testing Concurrent Code

### `loom` — Deterministic Concurrency Testing

`loom` explores all possible thread interleavings to find race conditions that stress tests miss:

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn test_concurrent_insert() {
        loom::model(|| {
            use loom::sync::Arc;
            use loom::sync::atomic::{AtomicUsize, Ordering};

            let counter = Arc::new(AtomicUsize::new(0));
            let c1 = counter.clone();
            let c2 = counter.clone();

            let t1 = loom::thread::spawn(move || {
                c1.fetch_add(1, Ordering::SeqCst);
            });

            let t2 = loom::thread::spawn(move || {
                c2.fetch_add(1, Ordering::SeqCst);
            });

            t1.join().unwrap();
            t2.join().unwrap();

            assert_eq!(counter.load(Ordering::SeqCst), 2);
        });
    }
}
```

**Setup:** `loom` replaces `std::sync` and `std::thread` with its own versions. Use feature flags to swap implementations:

```rust
#[cfg(not(loom))]
use std::sync::atomic::AtomicU64;

#[cfg(loom)]
use loom::sync::atomic::AtomicU64;
```

### `tokio::test` — Async Test Runtime

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_snapshot_isolation() {
        let manager = SnapshotManager::new();

        // Writer creates version 1
        let txn1 = manager.next_txn_id();

        // Reader takes snapshot — should see version 1
        let snap = manager.acquire_snapshot();

        // Writer creates version 2 (after snapshot)
        let txn2 = manager.next_txn_id();

        // Snapshot should see txn1 but not txn2
        assert!(manager.is_visible(txn1, &snap));
        assert!(!manager.is_visible(txn2, &snap));

        manager.release_snapshot(&snap);
    }

    /// Multi-threaded tokio test — spawns actual worker threads.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn test_concurrent_memtable_writes() {
        let memtable = Arc::new(Memtable::new());
        let mut handles = Vec::new();

        for i in 0..100 {
            let mt = memtable.clone();
            handles.push(tokio::spawn(async move {
                let key = Bytes::from(format!("key-{i:04}"));
                let value = Bytes::from(format!("value-{i}"));
                mt.insert(key, value);
            }));
        }

        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(memtable.approximate_size(), /* expected */);
    }
}
```

### Stress Tests — Verify Invariants Under Load

```rust
#[cfg(test)]
mod stress_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    /// Hammer the double-buffered memtable with concurrent writes and flushes.
    /// Invariant: no writes are lost, reads always return either the current
    /// or the just-flushed version.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn stress_double_buffer() {
        let buffer = Arc::new(DoubleBufferedMemtable::new());
        let total_writes = Arc::new(AtomicUsize::new(0));

        // Spawn 10 writer tasks
        let mut writer_handles = Vec::new();
        for writer_id in 0..10 {
            let buf = buffer.clone();
            let writes = total_writes.clone();
            writer_handles.push(tokio::spawn(async move {
                for i in 0..1000 {
                    let key = Bytes::from(format!("w{writer_id}-{i:06}"));
                    let value = Bytes::from(vec![0xABu8; 64]);
                    buf.insert(key, value);
                    writes.fetch_add(1, Ordering::Relaxed);
                    // Small random delay to increase interleaving
                    if i % 100 == 0 {
                        tokio::task::yield_now().await;
                    }
                }
            }));
        }

        // Spawn a flusher that periodically swaps buffers
        let flush_buf = buffer.clone();
        let flush_handle = tokio::spawn(async move {
            for _ in 0..5 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let old = flush_buf.swap_for_flush();
                // Simulate flush delay
                tokio::time::sleep(Duration::from_millis(10)).await;
                // In real code: write old to disk, then clear
            }
        });

        for handle in writer_handles {
            handle.await.unwrap();
        }
        flush_handle.await.unwrap();

        assert_eq!(total_writes.load(Ordering::Relaxed), 10_000);
    }
}
```

## Key Dependencies

```toml
[dependencies]
tokio = { version = "1.43", features = ["rt-multi-thread", "io-util", "net", "sync", "macros", "signal", "fs", "time"] }
tokio-util = { version = "0.7", features = ["rt"] }  # CancellationToken
crossbeam = "0.8"                      # Umbrella: channels, epoch, queue, skiplist
crossbeam-skiplist = "0.1"             # SkipMap — lock-free sorted map
crossbeam-channel = "0.5"             # Bounded/unbounded channels, select!
crossbeam-epoch = "0.9"               # Epoch-based memory reclamation
crossbeam-queue = "0.3"               # SegQueue, ArrayQueue
parking_lot = "0.12"                   # Fast Mutex/RwLock — no poisoning
dashmap = "6"                          # Concurrent hash map — sharded locks
arc-swap = "1"                         # Lock-free Arc pointer swap
num_cpus = "1"                         # Detect physical/logical core count
futures = "0.3"                        # Stream, FutureExt, StreamExt

[target.'cfg(target_os = "linux")'.dependencies]
io-uring = { version = "0.7", optional = true }

[dev-dependencies]
loom = "0.7"                           # Deterministic concurrency testing
```
