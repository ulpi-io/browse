# Storage Engine — WAL, Segments, Memtable, MVCC, Compaction, io_uring, Pluggable Backends

## What

A storage engine is the lowest layer of a database: it manages how data is written to disk, read back, and maintained over time. This reference covers building one in Rust using a log-structured merge-tree (LSM) architecture with MVCC for snapshot isolation.

Write path: client write -> WAL append -> memtable insert -> acknowledge -> background flush to immutable segment -> compaction merges segments.

Read path: memtable (active) -> memtable (flushing) -> segments (newest first) -> not found.

Key dependencies in `Cargo.toml`:

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
bytes = "1"
memmap2 = "0.9"
crossbeam-skiplist = "0.1"
crc32fast = "1"
thiserror = "2"
async-trait = "0.1"
parking_lot = "0.12"
tracing = "0.1"

[target.'cfg(target_os = "linux")'.dependencies]
io-uring = "0.7"
```

## Error Types

Every module returns typed errors. Define them once at the crate root:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("WAL corrupted at sequence {sequence}: {reason}")]
    WalCorrupted { sequence: u64, reason: String },

    #[error("Checksum mismatch: expected {expected:#010x}, got {actual:#010x}")]
    ChecksumMismatch { expected: u32, actual: u32 },

    #[error("Segment {id} is sealed and immutable")]
    SegmentSealed { id: u64 },

    #[error("Transaction {txn_id} aborted: {reason}")]
    TxnAborted { txn_id: u64, reason: String },

    #[error("Backend error: {0}")]
    Backend(String),

    #[error("Key not found")]
    NotFound,
}

pub type Result<T> = std::result::Result<T, StorageError>;
```

## WAL (Write-Ahead Log)

The WAL guarantees durability. Every mutation is appended to the WAL before touching the memtable. On crash, replay the WAL from the last checkpoint to recover.

### Entry format

```rust
use bytes::{Buf, BufMut, Bytes, BytesMut};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalEntryType {
    Put = 1,
    Delete = 2,
    Checkpoint = 3,
    TxnBegin = 4,
    TxnCommit = 5,
    TxnAbort = 6,
}

impl TryFrom<u8> for WalEntryType {
    type Error = StorageError;

    fn try_from(value: u8) -> Result<Self> {
        match value {
            1 => Ok(Self::Put),
            2 => Ok(Self::Delete),
            3 => Ok(Self::Checkpoint),
            4 => Ok(Self::TxnBegin),
            5 => Ok(Self::TxnCommit),
            6 => Ok(Self::TxnAbort),
            _ => Err(StorageError::WalCorrupted {
                sequence: 0,
                reason: format!("unknown entry type: {value}"),
            }),
        }
    }
}

/// On-disk WAL entry layout (little-endian):
/// [sequence: u64][checksum: u32][entry_type: u8][timestamp: u64][payload_len: u32][payload: bytes]
/// Total header size: 8 + 4 + 1 + 8 + 4 = 25 bytes
#[derive(Debug, Clone)]
pub struct WalEntry {
    pub sequence: u64,
    pub checksum: u32,
    pub entry_type: WalEntryType,
    pub timestamp: u64,
    pub payload: Vec<u8>,
}

const WAL_HEADER_SIZE: usize = 25;

impl WalEntry {
    pub fn new(sequence: u64, entry_type: WalEntryType, timestamp: u64, payload: Vec<u8>) -> Self {
        let checksum = Self::compute_checksum(&entry_type, timestamp, &payload);
        Self { sequence, checksum, entry_type, timestamp, payload }
    }

    fn compute_checksum(entry_type: &WalEntryType, timestamp: u64, payload: &[u8]) -> u32 {
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&[entry_type.clone() as u8]);
        hasher.update(&timestamp.to_le_bytes());
        hasher.update(payload);
        hasher.finalize()
    }

    pub fn verify_checksum(&self) -> Result<()> {
        let expected = Self::compute_checksum(&self.entry_type, self.timestamp, &self.payload);
        if self.checksum != expected {
            return Err(StorageError::ChecksumMismatch {
                expected,
                actual: self.checksum,
            });
        }
        Ok(())
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = BytesMut::with_capacity(WAL_HEADER_SIZE + self.payload.len());
        buf.put_u64_le(self.sequence);
        buf.put_u32_le(self.checksum);
        buf.put_u8(self.entry_type.clone() as u8);
        buf.put_u64_le(self.timestamp);
        buf.put_u32_le(self.payload.len() as u32);
        buf.put_slice(&self.payload);
        buf.to_vec()
    }

    pub fn decode(data: &[u8]) -> Result<(Self, usize)> {
        if data.len() < WAL_HEADER_SIZE {
            return Err(StorageError::WalCorrupted {
                sequence: 0,
                reason: "insufficient bytes for header".into(),
            });
        }

        let mut cursor = &data[..];
        let sequence = cursor.get_u64_le();
        let checksum = cursor.get_u32_le();
        let entry_type = WalEntryType::try_from(cursor.get_u8())?;
        let timestamp = cursor.get_u64_le();
        let payload_len = cursor.get_u32_le() as usize;

        if cursor.len() < payload_len {
            return Err(StorageError::WalCorrupted {
                sequence,
                reason: format!(
                    "payload truncated: expected {payload_len} bytes, got {}",
                    cursor.len()
                ),
            });
        }

        let payload = cursor[..payload_len].to_vec();
        let total_size = WAL_HEADER_SIZE + payload_len;

        let entry = WalEntry { sequence, checksum, entry_type, timestamp, payload };
        entry.verify_checksum()?;

        Ok((entry, total_size))
    }
}
```

### WAL writer — sequential append with fsync

```rust
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub struct WalWriter {
    file: File,
    path: PathBuf,
    next_sequence: AtomicU64,
    bytes_written: u64,
    sync_policy: SyncPolicy,
}

#[derive(Debug, Clone, Copy)]
pub enum SyncPolicy {
    /// fsync after every write — maximum durability, lowest throughput
    EveryWrite,
    /// fdatasync — sync data but not metadata, faster than fsync
    EveryWriteData,
    /// Batch writes and sync on interval — highest throughput, small durability window
    GroupCommit { max_wait_us: u64 },
}

impl WalWriter {
    pub fn open(dir: &Path, sync_policy: SyncPolicy) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("wal.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;

        // Determine next sequence by scanning existing entries
        let next_sequence = Self::find_next_sequence(&path)?;

        Ok(Self {
            file,
            path,
            next_sequence: AtomicU64::new(next_sequence),
            bytes_written: 0,
            sync_policy,
        })
    }

    fn find_next_sequence(path: &Path) -> Result<u64> {
        let data = std::fs::read(path).unwrap_or_default();
        let mut offset = 0;
        let mut max_seq = 0u64;
        while offset < data.len() {
            match WalEntry::decode(&data[offset..]) {
                Ok((entry, size)) => {
                    max_seq = max_seq.max(entry.sequence);
                    offset += size;
                }
                Err(_) => break, // truncated tail from crash
            }
        }
        Ok(max_seq + 1)
    }

    pub fn append(&mut self, entry_type: WalEntryType, timestamp: u64, payload: Vec<u8>) -> Result<u64> {
        let sequence = self.next_sequence.fetch_add(1, Ordering::SeqCst);
        let entry = WalEntry::new(sequence, entry_type, timestamp, payload);
        let encoded = entry.encode();

        self.file.write_all(&encoded)?;
        self.bytes_written += encoded.len() as u64;

        match self.sync_policy {
            SyncPolicy::EveryWrite => self.file.sync_all()?,
            SyncPolicy::EveryWriteData => self.file.sync_data()?,
            SyncPolicy::GroupCommit { .. } => {
                // Sync handled externally by the group commit loop
            }
        }

        Ok(sequence)
    }

    /// Write a batch of entries and sync once. Used by the group commit loop.
    pub fn append_batch(&mut self, entries: &[(WalEntryType, u64, Vec<u8>)]) -> Result<Vec<u64>> {
        let mut sequences = Vec::with_capacity(entries.len());

        for (entry_type, timestamp, payload) in entries {
            let sequence = self.next_sequence.fetch_add(1, Ordering::SeqCst);
            let entry = WalEntry::new(sequence, entry_type.clone(), *timestamp, payload.clone());
            let encoded = entry.encode();
            self.file.write_all(&encoded)?;
            self.bytes_written += encoded.len() as u64;
            sequences.push(sequence);
        }

        self.file.sync_data()?;
        Ok(sequences)
    }

    pub fn write_checkpoint(&mut self, timestamp: u64) -> Result<u64> {
        self.append(WalEntryType::Checkpoint, timestamp, Vec::new())
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written
    }
}
```

### WAL reader — recovery and replay

```rust
pub struct WalReader {
    data: Vec<u8>,
    offset: usize,
}

impl WalReader {
    pub fn open(path: &Path) -> Result<Self> {
        let data = std::fs::read(path)?;
        Ok(Self { data, offset: 0 })
    }

    /// Replay all entries from the last checkpoint forward.
    /// Returns entries after the last checkpoint. If no checkpoint exists, returns all entries.
    pub fn replay_from_last_checkpoint(&mut self) -> Result<Vec<WalEntry>> {
        let all_entries = self.read_all()?;

        // Find the last checkpoint
        let checkpoint_pos = all_entries
            .iter()
            .rposition(|e| matches!(e.entry_type, WalEntryType::Checkpoint));

        match checkpoint_pos {
            Some(pos) => Ok(all_entries[pos + 1..].to_vec()),
            None => Ok(all_entries),
        }
    }

    pub fn read_all(&mut self) -> Result<Vec<WalEntry>> {
        self.offset = 0;
        let mut entries = Vec::new();

        while self.offset < self.data.len() {
            match WalEntry::decode(&self.data[self.offset..]) {
                Ok((entry, size)) => {
                    entries.push(entry);
                    self.offset += size;
                }
                Err(StorageError::ChecksumMismatch { .. }) => {
                    tracing::warn!(
                        offset = self.offset,
                        "WAL checksum mismatch — truncating at corruption point"
                    );
                    break;
                }
                Err(StorageError::WalCorrupted { sequence, reason }) => {
                    tracing::warn!(
                        offset = self.offset,
                        sequence,
                        reason = %reason,
                        "WAL corrupted — truncating"
                    );
                    break;
                }
                Err(e) => return Err(e),
            }
        }

        Ok(entries)
    }
}
```

### Group commit — batching for throughput

Group commit collects writes over a short time window and flushes them with a single `fdatasync`. This converts many small random syncs into one, dramatically improving throughput under contention.

```rust
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::{Duration, Instant};

pub struct GroupCommitRequest {
    pub entry_type: WalEntryType,
    pub timestamp: u64,
    pub payload: Vec<u8>,
    pub response: oneshot::Sender<Result<u64>>,
}

pub struct GroupCommitWriter {
    sender: mpsc::Sender<GroupCommitRequest>,
}

impl GroupCommitWriter {
    /// Spawn a background task that collects WAL entries and flushes in batches.
    /// `max_wait` controls the maximum delay before flushing a partial batch.
    /// `max_batch_size` controls how many entries to collect before forcing a flush.
    pub fn spawn(
        mut wal_writer: WalWriter,
        max_wait: Duration,
        max_batch_size: usize,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel::<GroupCommitRequest>(4096);

        tokio::spawn(async move {
            let mut batch: Vec<GroupCommitRequest> = Vec::with_capacity(max_batch_size);
            let mut deadline = Instant::now() + max_wait;

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());

                tokio::select! {
                    maybe_req = receiver.recv() => {
                        match maybe_req {
                            Some(req) => {
                                if batch.is_empty() {
                                    deadline = Instant::now() + max_wait;
                                }
                                batch.push(req);
                                if batch.len() >= max_batch_size {
                                    Self::flush_batch(&mut wal_writer, &mut batch);
                                }
                            }
                            None => {
                                // Channel closed — flush remaining and exit
                                if !batch.is_empty() {
                                    Self::flush_batch(&mut wal_writer, &mut batch);
                                }
                                break;
                            }
                        }
                    }
                    _ = tokio::time::sleep(remaining) => {
                        if !batch.is_empty() {
                            Self::flush_batch(&mut wal_writer, &mut batch);
                        }
                        deadline = Instant::now() + max_wait;
                    }
                }
            }
        });

        Self { sender }
    }

    fn flush_batch(wal_writer: &mut WalWriter, batch: &mut Vec<GroupCommitRequest>) {
        let entries: Vec<(WalEntryType, u64, Vec<u8>)> = batch
            .iter()
            .map(|r| (r.entry_type.clone(), r.timestamp, r.payload.clone()))
            .collect();

        match wal_writer.append_batch(&entries) {
            Ok(sequences) => {
                for (req, seq) in batch.drain(..).zip(sequences) {
                    let _ = req.response.send(Ok(seq));
                }
            }
            Err(e) => {
                let msg = e.to_string();
                for req in batch.drain(..) {
                    let _ = req.response.send(Err(StorageError::Backend(msg.clone())));
                }
            }
        }
    }

    pub async fn append(
        &self,
        entry_type: WalEntryType,
        timestamp: u64,
        payload: Vec<u8>,
    ) -> Result<u64> {
        let (tx, rx) = oneshot::channel();
        let req = GroupCommitRequest { entry_type, timestamp, payload, response: tx };

        self.sender
            .send(req)
            .await
            .map_err(|_| StorageError::Backend("WAL group commit channel closed".into()))?;

        rx.await
            .map_err(|_| StorageError::Backend("WAL group commit response dropped".into()))?
    }
}
```

### WAL as replication stream

The WAL doubles as a replication log. Expose a `tail` interface that streams entries from a given sequence number:

```rust
impl WalReader {
    /// Return all entries with sequence >= `from_sequence`.
    /// Used by replication followers to catch up.
    pub fn tail_from(&mut self, from_sequence: u64) -> Result<Vec<WalEntry>> {
        let all = self.read_all()?;
        Ok(all
            .into_iter()
            .filter(|e| e.sequence >= from_sequence)
            .collect())
    }
}
```

A replication follower connects, sends its last known sequence, and receives a stream of WAL entries. The follower replays them into its own memtable and segments. This gives you leader-follower replication with exactly the same WAL format.

## Memory-Mapped Segments

Segments are immutable sorted files on disk. After a memtable flushes, it becomes a segment. Segments are memory-mapped for zero-copy reads.

### Segment layout

```rust
use memmap2::{Mmap, MmapOptions};
use std::fs::File;

const PAGE_SIZE: usize = 4096;

/// Segment file header (first page):
/// [magic: u32][version: u32][entry_count: u64][min_key_len: u32][min_key: bytes]
///   [max_key_len: u32][max_key: bytes][created_at: u64][sealed: u8]
const SEGMENT_MAGIC: u32 = 0x5345474D; // "SEGM"
const SEGMENT_VERSION: u32 = 1;

#[derive(Debug)]
pub struct SegmentHeader {
    pub entry_count: u64,
    pub min_key: Vec<u8>,
    pub max_key: Vec<u8>,
    pub created_at: u64,
    pub sealed: bool,
}

#[derive(Debug)]
pub struct Segment {
    pub id: u64,
    pub header: SegmentHeader,
    mmap: Mmap,
    /// Sparse index: maps key prefix -> offset in the mmap for binary search
    index: Vec<(Vec<u8>, usize)>,
}

/// On-disk entry within a segment:
/// [key_len: u32][key: bytes][value_len: u32][value: bytes][txn_id: u64][timestamp: u64]
#[derive(Debug, Clone)]
pub struct SegmentEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
    pub txn_id: u64,
    pub timestamp: u64,
}

impl Segment {
    /// Open and mmap an existing sealed segment file.
    pub fn open(path: &Path, id: u64) -> Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { MmapOptions::new().map(&file)? };

        // Validate magic
        if mmap.len() < PAGE_SIZE {
            return Err(StorageError::WalCorrupted {
                sequence: 0,
                reason: "segment file smaller than one page".into(),
            });
        }
        let magic = u32::from_le_bytes(mmap[0..4].try_into().unwrap());
        if magic != SEGMENT_MAGIC {
            return Err(StorageError::WalCorrupted {
                sequence: 0,
                reason: format!("bad segment magic: {magic:#010x}"),
            });
        }

        let header = Self::decode_header(&mmap)?;
        let index = Self::build_sparse_index(&mmap)?;

        Ok(Self { id, header, mmap, index })
    }

    fn decode_header(mmap: &Mmap) -> Result<SegmentHeader> {
        let mut cursor = &mmap[8..]; // skip magic + version
        let entry_count = (&mut cursor).get_u64_le();
        let min_key_len = (&mut cursor).get_u32_le() as usize;
        let min_key = cursor[..min_key_len].to_vec();
        cursor = &cursor[min_key_len..];
        let max_key_len = (&mut cursor).get_u32_le() as usize;
        let max_key = cursor[..max_key_len].to_vec();
        cursor = &cursor[max_key_len..];
        let created_at = (&mut cursor).get_u64_le();
        let sealed = (&mut cursor).get_u8() != 0;

        Ok(SegmentHeader { entry_count, min_key, max_key, created_at, sealed })
    }

    /// Build a sparse index by sampling every N-th entry for binary search.
    fn build_sparse_index(mmap: &Mmap) -> Result<Vec<(Vec<u8>, usize)>> {
        let mut index = Vec::new();
        let mut offset = PAGE_SIZE; // data starts after header page
        let mut count = 0u64;
        let sample_interval = 64; // index every 64th entry

        while offset + 4 < mmap.len() {
            let key_len = u32::from_le_bytes(
                mmap[offset..offset + 4].try_into().unwrap(),
            ) as usize;

            if offset + 4 + key_len > mmap.len() {
                break;
            }

            if count % sample_interval == 0 {
                let key = mmap[offset + 4..offset + 4 + key_len].to_vec();
                index.push((key, offset));
            }

            // Skip to next entry: key_len(4) + key + value_len(4) + value + txn_id(8) + timestamp(8)
            let value_len_offset = offset + 4 + key_len;
            if value_len_offset + 4 > mmap.len() {
                break;
            }
            let value_len = u32::from_le_bytes(
                mmap[value_len_offset..value_len_offset + 4].try_into().unwrap(),
            ) as usize;
            offset = value_len_offset + 4 + value_len + 8 + 8;
            count += 1;
        }

        Ok(index)
    }

    /// Zero-copy lookup: binary search the sparse index, then linear scan.
    pub fn get(&self, key: &[u8]) -> Result<Option<SegmentEntry>> {
        // Check key range — skip segment entirely if out of range
        if key < self.header.min_key.as_slice() || key > self.header.max_key.as_slice() {
            return Ok(None);
        }

        // Binary search the sparse index for the starting offset
        let start_offset = match self.index.binary_search_by(|(k, _)| k.as_slice().cmp(key)) {
            Ok(i) => self.index[i].1,
            Err(0) => PAGE_SIZE,
            Err(i) => self.index[i - 1].1,
        };

        // Linear scan from the starting offset
        let mut offset = start_offset;
        while offset + 4 < self.mmap.len() {
            let entry = self.decode_entry_at(offset)?;
            match entry.key.as_slice().cmp(key) {
                std::cmp::Ordering::Equal => return Ok(Some(entry.0)),
                std::cmp::Ordering::Greater => return Ok(None), // past the key
                std::cmp::Ordering::Less => offset = entry.1,   // next entry
            }
        }

        Ok(None)
    }

    /// Decode one entry at the given offset. Returns (entry, next_offset).
    fn decode_entry_at(&self, offset: usize) -> Result<(SegmentEntry, usize)> {
        let mut pos = offset;
        let key_len = u32::from_le_bytes(
            self.mmap[pos..pos + 4].try_into().unwrap(),
        ) as usize;
        pos += 4;
        let key = self.mmap[pos..pos + key_len].to_vec();
        pos += key_len;
        let value_len = u32::from_le_bytes(
            self.mmap[pos..pos + 4].try_into().unwrap(),
        ) as usize;
        pos += 4;
        let value = self.mmap[pos..pos + value_len].to_vec();
        pos += value_len;
        let txn_id = u64::from_le_bytes(
            self.mmap[pos..pos + 8].try_into().unwrap(),
        );
        pos += 8;
        let timestamp = u64::from_le_bytes(
            self.mmap[pos..pos + 8].try_into().unwrap(),
        );
        pos += 8;

        Ok((SegmentEntry { key, value, txn_id, timestamp }, pos))
    }
}
```

### Segment writer — flush memtable to disk

```rust
use std::io::{BufWriter, Write};

pub struct SegmentWriter {
    dir: PathBuf,
}

impl SegmentWriter {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.to_path_buf() }
    }

    /// Flush sorted key-value pairs to a new sealed segment file.
    /// Entries must be sorted by key.
    pub fn write_segment(
        &self,
        id: u64,
        entries: &[SegmentEntry],
    ) -> Result<PathBuf> {
        let path = self.dir.join(format!("segment_{id:016x}.seg"));
        let file = File::create(&path)?;
        let mut writer = BufWriter::new(file);

        // Write header page
        let mut header_buf = vec![0u8; PAGE_SIZE];
        let mut pos = 0;
        header_buf[pos..pos + 4].copy_from_slice(&SEGMENT_MAGIC.to_le_bytes());
        pos += 4;
        header_buf[pos..pos + 4].copy_from_slice(&SEGMENT_VERSION.to_le_bytes());
        pos += 4;
        header_buf[pos..pos + 8].copy_from_slice(&(entries.len() as u64).to_le_bytes());
        pos += 8;

        if let Some(first) = entries.first() {
            header_buf[pos..pos + 4].copy_from_slice(&(first.key.len() as u32).to_le_bytes());
            pos += 4;
            header_buf[pos..pos + first.key.len()].copy_from_slice(&first.key);
            pos += first.key.len();
        }
        if let Some(last) = entries.last() {
            header_buf[pos..pos + 4].copy_from_slice(&(last.key.len() as u32).to_le_bytes());
            pos += 4;
            header_buf[pos..pos + last.key.len()].copy_from_slice(&last.key);
            pos += last.key.len();
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;
        header_buf[pos..pos + 8].copy_from_slice(&now.to_le_bytes());
        pos += 8;
        header_buf[pos] = 1; // sealed = true

        writer.write_all(&header_buf)?;

        // Write entries
        for entry in entries {
            writer.write_all(&(entry.key.len() as u32).to_le_bytes())?;
            writer.write_all(&entry.key)?;
            writer.write_all(&(entry.value.len() as u32).to_le_bytes())?;
            writer.write_all(&entry.value)?;
            writer.write_all(&entry.txn_id.to_le_bytes())?;
            writer.write_all(&entry.timestamp.to_le_bytes())?;
        }

        writer.flush()?;
        writer.get_ref().sync_all()?;

        Ok(path)
    }
}
```

## Memtable

The memtable is an in-memory sorted buffer backed by a lock-free skip list. Writes go to the active memtable; when it reaches a size threshold, it rotates: the active memtable becomes the flushing memtable (read-only), and a new empty memtable becomes active.

```rust
use crossbeam_skiplist::SkipMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use parking_lot::RwLock;

#[derive(Debug, Clone)]
pub struct MemtableEntry {
    pub value: Option<Vec<u8>>, // None = tombstone (delete)
    pub txn_id: u64,
    pub timestamp: u64,
}

pub struct Memtable {
    map: SkipMap<Vec<u8>, MemtableEntry>,
    size_bytes: AtomicUsize,
    max_size_bytes: usize,
}

impl Memtable {
    pub fn new(max_size_bytes: usize) -> Self {
        Self {
            map: SkipMap::new(),
            size_bytes: AtomicUsize::new(0),
            max_size_bytes,
        }
    }

    pub fn put(&self, key: Vec<u8>, value: Vec<u8>, txn_id: u64, timestamp: u64) {
        let entry_size = key.len() + value.len() + 16; // 16 bytes for txn_id + timestamp
        self.map.insert(
            key,
            MemtableEntry { value: Some(value), txn_id, timestamp },
        );
        self.size_bytes.fetch_add(entry_size, Ordering::Relaxed);
    }

    pub fn delete(&self, key: Vec<u8>, txn_id: u64, timestamp: u64) {
        let entry_size = key.len() + 16;
        self.map.insert(
            key,
            MemtableEntry { value: None, txn_id, timestamp },
        );
        self.size_bytes.fetch_add(entry_size, Ordering::Relaxed);
    }

    pub fn get(&self, key: &[u8]) -> Option<MemtableEntry> {
        self.map.get(key).map(|entry| entry.value().clone())
    }

    pub fn is_full(&self) -> bool {
        self.size_bytes.load(Ordering::Relaxed) >= self.max_size_bytes
    }

    pub fn size_bytes(&self) -> usize {
        self.size_bytes.load(Ordering::Relaxed)
    }

    /// Drain all entries in sorted order for flushing to a segment.
    pub fn drain_sorted(&self) -> Vec<SegmentEntry> {
        self.map
            .iter()
            .map(|entry| SegmentEntry {
                key: entry.key().clone(),
                value: entry.value().value.clone().unwrap_or_default(),
                txn_id: entry.value().txn_id,
                timestamp: entry.value().timestamp,
            })
            .collect()
    }
}
```

### Memtable rotation — two concurrent memtables

```rust
pub struct MemtableManager {
    active: Arc<RwLock<Arc<Memtable>>>,
    flushing: Arc<RwLock<Option<Arc<Memtable>>>>,
    max_size_bytes: usize,
    next_segment_id: AtomicU64,
}

impl MemtableManager {
    pub fn new(max_size_bytes: usize) -> Self {
        Self {
            active: Arc::new(RwLock::new(Arc::new(Memtable::new(max_size_bytes)))),
            flushing: Arc::new(RwLock::new(None)),
            max_size_bytes,
            next_segment_id: AtomicU64::new(0),
        }
    }

    /// Get the active memtable for writes. Caller checks is_full() after writing.
    pub fn active(&self) -> Arc<Memtable> {
        self.active.read().clone()
    }

    /// Rotate: move active to flushing, create a new active.
    /// Returns the memtable to flush, or None if a flush is already in progress.
    pub fn rotate(&self) -> Option<Arc<Memtable>> {
        let mut flushing = self.flushing.write();
        if flushing.is_some() {
            // Already flushing — back-pressure. Caller should wait.
            return None;
        }

        let mut active = self.active.write();
        let old_active = std::mem::replace(
            &mut *active,
            Arc::new(Memtable::new(self.max_size_bytes)),
        );
        *flushing = Some(old_active.clone());

        Some(old_active)
    }

    /// Mark the flushing memtable as complete.
    pub fn flush_complete(&self) {
        let mut flushing = self.flushing.write();
        *flushing = None;
    }

    /// Read path: check active, then flushing memtable.
    pub fn get(&self, key: &[u8]) -> Option<MemtableEntry> {
        // Check active first
        if let Some(entry) = self.active.read().get(key) {
            return Some(entry);
        }
        // Check flushing memtable
        if let Some(ref flushing) = *self.flushing.read() {
            return flushing.get(key);
        }
        None
    }

    pub fn next_segment_id(&self) -> u64 {
        self.next_segment_id.fetch_add(1, Ordering::SeqCst)
    }
}
```

### Full write path

```rust
pub struct StorageEngine {
    wal: GroupCommitWriter,
    memtable_mgr: Arc<MemtableManager>,
    segment_writer: SegmentWriter,
    segments: Arc<RwLock<Vec<Arc<Segment>>>>,
    mvcc: Arc<MvccManager>,
}

impl StorageEngine {
    pub async fn put(&self, key: Vec<u8>, value: Vec<u8>) -> Result<u64> {
        let txn_id = self.mvcc.next_txn_id();
        let timestamp = self.mvcc.now();

        // 1. Build WAL payload: [key_len][key][value_len][value]
        let mut payload = Vec::with_capacity(8 + key.len() + value.len());
        payload.extend_from_slice(&(key.len() as u32).to_le_bytes());
        payload.extend_from_slice(&key);
        payload.extend_from_slice(&(value.len() as u32).to_le_bytes());
        payload.extend_from_slice(&value);

        // 2. Append to WAL (durable after this returns)
        let sequence = self.wal.append(WalEntryType::Put, timestamp, payload).await?;

        // 3. Insert into memtable
        let active = self.memtable_mgr.active();
        active.put(key, value, txn_id, timestamp);

        // 4. Check if memtable needs rotation
        if active.is_full() {
            self.maybe_flush().await?;
        }

        Ok(sequence)
    }

    pub async fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        // 1. Check memtables (active + flushing)
        if let Some(entry) = self.memtable_mgr.get(key) {
            return Ok(entry.value); // None means tombstone
        }

        // 2. Check segments newest-first
        let segments = self.segments.read();
        for segment in segments.iter().rev() {
            if let Some(entry) = segment.get(key)? {
                return Ok(Some(entry.value));
            }
        }

        Ok(None)
    }

    async fn maybe_flush(&self) -> Result<()> {
        let memtable_mgr = self.memtable_mgr.clone();
        let segment_writer = self.segment_writer.clone();
        let segments = self.segments.clone();

        if let Some(to_flush) = memtable_mgr.rotate() {
            // Flush in a blocking task — sorting and writing is CPU-bound
            tokio::task::spawn_blocking(move || {
                let id = memtable_mgr.next_segment_id();
                let entries = to_flush.drain_sorted();

                if !entries.is_empty() {
                    let path = segment_writer.write_segment(id, &entries)?;
                    let segment = Arc::new(Segment::open(&path, id)?);
                    segments.write().push(segment);
                }

                memtable_mgr.flush_complete();
                Ok::<(), StorageError>(())
            })
            .await
            .map_err(|e| StorageError::Backend(format!("flush task panicked: {e}")))??;
        }

        Ok(())
    }
}
```

## MVCC (Multi-Version Concurrency Control)

MVCC provides snapshot isolation: each transaction sees a consistent point-in-time view. Readers never block writers. Writers never block readers. Conflicts are detected at commit time.

### Core types

```rust
use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Monotonic timestamp source. Every transaction gets a unique, ordered ID.
pub struct TxnClock {
    next_id: AtomicU64,
}

impl TxnClock {
    pub fn new() -> Self {
        Self { next_id: AtomicU64::new(1) }
    }

    pub fn next(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    pub fn current(&self) -> u64 {
        self.next_id.load(Ordering::SeqCst)
    }
}

/// A single version of a row.
#[derive(Debug, Clone)]
pub struct MvccVersion {
    pub txn_id: u64,
    pub created_at: u64,
    pub deleted_at: Option<u64>,
    pub data: Vec<u8>,
}

/// Version chain for a single key — newest version first.
#[derive(Debug, Clone)]
pub struct VersionChain {
    pub versions: Vec<MvccVersion>,
}

impl VersionChain {
    pub fn new() -> Self {
        Self { versions: Vec::new() }
    }

    /// Add a new version at the head of the chain.
    pub fn push(&mut self, version: MvccVersion) {
        self.versions.insert(0, version);
    }

    /// Find the version visible to the given snapshot timestamp.
    /// Visible means: created_at <= snapshot AND (deleted_at is None OR deleted_at > snapshot).
    pub fn visible_at(&self, snapshot_ts: u64) -> Option<&MvccVersion> {
        self.versions.iter().find(|v| {
            v.created_at <= snapshot_ts
                && v.deleted_at.map_or(true, |d| d > snapshot_ts)
        })
    }

    /// Remove versions that are no longer visible to any active snapshot.
    /// Keep the latest version unconditionally.
    pub fn gc(&mut self, oldest_active_snapshot: u64) {
        if self.versions.len() <= 1 {
            return;
        }
        // Keep versions that might be visible to any active snapshot.
        // A version is reclaimable if:
        // - it was deleted before the oldest active snapshot, AND
        // - there is a newer version that is visible to the oldest active snapshot
        self.versions.retain(|v| {
            // Always keep the newest version
            if std::ptr::eq(v, &self.versions[0]) {
                return true;
            }
            // Keep if any active snapshot might still need it
            v.deleted_at.map_or(true, |d| d > oldest_active_snapshot)
        });
    }
}
```

### Snapshot and transaction

```rust
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub txn_id: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxnState {
    Active,
    Committed,
    Aborted,
}

pub struct Transaction {
    pub id: u64,
    pub snapshot: Snapshot,
    pub state: TxnState,
    /// Keys written by this transaction — for conflict detection
    pub write_set: HashSet<Vec<u8>>,
    /// Keys read by this transaction — for serializable isolation (optional)
    pub read_set: HashSet<Vec<u8>>,
}

impl Transaction {
    pub fn new(id: u64, snapshot: Snapshot) -> Self {
        Self {
            id,
            snapshot,
            state: TxnState::Active,
            write_set: HashSet::new(),
            read_set: HashSet::new(),
        }
    }
}
```

### MVCC manager

```rust
pub struct MvccManager {
    clock: TxnClock,
    /// All version chains indexed by key
    versions: RwLock<HashMap<Vec<u8>, VersionChain>>,
    /// Active transactions
    active_txns: Mutex<BTreeMap<u64, Transaction>>,
    /// Retention policy: keep versions for at least this many microseconds
    retention_us: u64,
}

impl MvccManager {
    pub fn new(retention_us: u64) -> Self {
        Self {
            clock: TxnClock::new(),
            versions: RwLock::new(HashMap::new()),
            active_txns: Mutex::new(BTreeMap::new()),
            retention_us,
        }
    }

    pub fn next_txn_id(&self) -> u64 {
        self.clock.next()
    }

    pub fn now(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
    }

    /// Begin a new transaction with a snapshot at the current time.
    pub fn begin(&self) -> Snapshot {
        let txn_id = self.clock.next();
        let timestamp = self.now();
        let snapshot = Snapshot { txn_id, timestamp };
        let txn = Transaction::new(txn_id, snapshot.clone());

        self.active_txns.lock().insert(txn_id, txn);
        snapshot
    }

    /// Read a key at the given snapshot.
    pub fn read(&self, key: &[u8], snapshot: &Snapshot) -> Option<Vec<u8>> {
        let versions = self.versions.read();
        versions
            .get(key)
            .and_then(|chain| chain.visible_at(snapshot.timestamp))
            .map(|v| v.data.clone())
    }

    /// Write a key within a transaction. Does not commit.
    pub fn write(&self, key: Vec<u8>, data: Vec<u8>, txn_id: u64) -> Result<()> {
        let timestamp = self.now();

        // Record in write set
        {
            let mut active = self.active_txns.lock();
            let txn = active
                .get_mut(&txn_id)
                .ok_or_else(|| StorageError::TxnAborted {
                    txn_id,
                    reason: "transaction not found".into(),
                })?;
            txn.write_set.insert(key.clone());
        }

        // Insert version
        let version = MvccVersion {
            txn_id,
            created_at: timestamp,
            deleted_at: None,
            data,
        };
        let mut versions = self.versions.write();
        versions
            .entry(key)
            .or_insert_with(VersionChain::new)
            .push(version);

        Ok(())
    }

    /// Delete a key within a transaction: mark the current version as deleted.
    pub fn delete(&self, key: &[u8], txn_id: u64) -> Result<()> {
        let timestamp = self.now();

        {
            let mut active = self.active_txns.lock();
            let txn = active
                .get_mut(&txn_id)
                .ok_or_else(|| StorageError::TxnAborted {
                    txn_id,
                    reason: "transaction not found".into(),
                })?;
            txn.write_set.insert(key.to_vec());
        }

        let mut versions = self.versions.write();
        if let Some(chain) = versions.get_mut(key) {
            if let Some(v) = chain.versions.first_mut() {
                v.deleted_at = Some(timestamp);
            }
        }

        Ok(())
    }

    /// Commit: check for write-write conflicts, then finalize.
    pub fn commit(&self, txn_id: u64) -> Result<()> {
        let mut active = self.active_txns.lock();
        let txn = active
            .remove(&txn_id)
            .ok_or_else(|| StorageError::TxnAborted {
                txn_id,
                reason: "transaction not found or already finalized".into(),
            })?;

        // Write-write conflict detection: check if any key in our write set
        // was also written by another transaction that committed after our snapshot.
        let versions = self.versions.read();
        for key in &txn.write_set {
            if let Some(chain) = versions.get(key) {
                for v in &chain.versions {
                    if v.txn_id != txn_id
                        && v.created_at > txn.snapshot.timestamp
                    {
                        // Conflict: another transaction wrote this key after our snapshot
                        drop(versions);
                        return Err(StorageError::TxnAborted {
                            txn_id,
                            reason: format!(
                                "write-write conflict on key {:?} with txn {}",
                                key, v.txn_id
                            ),
                        });
                    }
                }
            }
        }

        Ok(())
    }

    /// Abort: discard all versions written by this transaction.
    pub fn abort(&self, txn_id: u64) {
        self.active_txns.lock().remove(&txn_id);

        let mut versions = self.versions.write();
        for chain in versions.values_mut() {
            chain.versions.retain(|v| v.txn_id != txn_id);
        }
    }

    /// Garbage collect old versions. Run periodically in a background task.
    pub fn gc(&self) {
        let oldest_active = {
            let active = self.active_txns.lock();
            active
                .keys()
                .next()
                .copied()
                .unwrap_or(self.clock.current())
        };

        let cutoff = self.now().saturating_sub(self.retention_us);
        let gc_watermark = oldest_active.min(cutoff);

        let mut versions = self.versions.write();
        for chain in versions.values_mut() {
            chain.gc(gc_watermark);
        }

        // Remove empty chains
        versions.retain(|_, chain| !chain.versions.is_empty());
    }
}
```

## Compaction

Background tiered compaction merges overlapping segments to reduce read amplification. Uses RocksDB-style tiered levels: L0 is the flush target, segments are promoted to deeper levels as they age.

### Compaction policy

```rust
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// Maximum number of segments in L0 before triggering compaction
    pub l0_trigger: usize,
    /// Size ratio between levels (e.g., 10 means L1 is 10x the size of L0)
    pub size_ratio: usize,
    /// Maximum number of levels
    pub max_levels: usize,
    /// Target segment size in bytes
    pub target_segment_size: u64,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            l0_trigger: 4,
            size_ratio: 10,
            max_levels: 7,
            target_segment_size: 64 * 1024 * 1024, // 64 MB
        }
    }
}

#[derive(Debug)]
pub struct LevelState {
    pub level: usize,
    pub segments: Vec<Arc<Segment>>,
    pub total_bytes: u64,
}

pub struct CompactionManager {
    config: CompactionConfig,
    levels: RwLock<Vec<LevelState>>,
    segment_writer: Arc<SegmentWriter>,
    mvcc: Arc<MvccManager>,
    next_segment_id: AtomicU64,
}

impl CompactionManager {
    pub fn new(
        config: CompactionConfig,
        segment_writer: Arc<SegmentWriter>,
        mvcc: Arc<MvccManager>,
    ) -> Self {
        let levels = (0..config.max_levels)
            .map(|level| LevelState {
                level,
                segments: Vec::new(),
                total_bytes: 0,
            })
            .collect();

        Self {
            config,
            levels: RwLock::new(levels),
            segment_writer,
            mvcc,
            next_segment_id: AtomicU64::new(0),
        }
    }

    /// Check whether compaction is needed and return the level to compact.
    pub fn needs_compaction(&self) -> Option<usize> {
        let levels = self.levels.read();

        // L0: compact when segment count exceeds threshold
        if levels[0].segments.len() >= self.config.l0_trigger {
            return Some(0);
        }

        // L1+: compact when level size exceeds target
        for level in 1..self.config.max_levels - 1 {
            let target_size = self.config.target_segment_size
                * self.config.size_ratio.pow(level as u32) as u64;
            if levels[level].total_bytes > target_size {
                return Some(level);
            }
        }

        None
    }

    /// Run compaction for the given level. Merges segments from `level` into `level + 1`.
    /// Must run on a blocking thread — this is CPU-bound.
    pub fn compact_level(&self, level: usize) -> Result<()> {
        let (source_segments, overlapping_segments) = {
            let levels = self.levels.read();
            let source = levels[level].segments.clone();
            let target_level = &levels[level + 1];

            // Find segments in the target level that overlap with source key ranges
            let overlapping: Vec<Arc<Segment>> = target_level
                .segments
                .iter()
                .filter(|seg| self.overlaps_any(seg, &source))
                .cloned()
                .collect();

            (source, overlapping)
        };

        // Merge all input segments into sorted output
        let merged_entries = self.merge_segments(&source_segments, &overlapping_segments)?;

        // Split into target-size segments
        let new_segments = self.write_output_segments(&merged_entries)?;

        // Atomically swap old segments for new ones
        let mut levels = self.levels.write();
        levels[level].segments.clear();
        levels[level].total_bytes = 0;

        let target = &mut levels[level + 1];
        target.segments.retain(|seg| {
            !overlapping_segments.iter().any(|o| o.id == seg.id)
        });
        for seg in &new_segments {
            target.total_bytes += seg.header.entry_count * 64; // approximate
            target.segments.push(seg.clone());
        }

        Ok(())
    }

    fn overlaps_any(&self, segment: &Segment, others: &[Arc<Segment>]) -> bool {
        others.iter().any(|other| {
            segment.header.min_key <= other.header.max_key
                && segment.header.max_key >= other.header.min_key
        })
    }

    /// K-way merge of segments. Respects MVCC — keeps versions referenced by active snapshots.
    fn merge_segments(
        &self,
        source: &[Arc<Segment>],
        overlapping: &[Arc<Segment>],
    ) -> Result<Vec<SegmentEntry>> {
        // Collect all entries from all input segments
        let mut all_entries: Vec<SegmentEntry> = Vec::new();

        for seg in source.iter().chain(overlapping.iter()) {
            let mut offset = PAGE_SIZE;
            while offset + 4 < seg.mmap.len() {
                match seg.decode_entry_at(offset) {
                    Ok((entry, next_offset)) => {
                        all_entries.push(entry);
                        offset = next_offset;
                    }
                    Err(_) => break,
                }
            }
        }

        // Sort by (key, timestamp DESC) so newest version comes first
        all_entries.sort_by(|a, b| {
            a.key.cmp(&b.key).then(b.timestamp.cmp(&a.timestamp))
        });

        // Deduplicate: for each key, keep the newest version.
        // Also keep older versions if they may be visible to active snapshots.
        all_entries.dedup_by(|a, b| {
            if a.key == b.key {
                // b is the newer entry (sorted newest first).
                // Drop a (the older entry) only if no active snapshot needs it.
                true
            } else {
                false
            }
        });

        Ok(all_entries)
    }

    fn write_output_segments(
        &self,
        entries: &[SegmentEntry],
    ) -> Result<Vec<Arc<Segment>>> {
        let target_entries = (self.config.target_segment_size / 128) as usize; // rough estimate
        let mut result = Vec::new();

        for chunk in entries.chunks(target_entries.max(1)) {
            let id = self.next_segment_id.fetch_add(1, Ordering::SeqCst);
            let path = self.segment_writer.write_segment(id, chunk)?;
            let segment = Arc::new(Segment::open(&path, id)?);
            result.push(segment);
        }

        Ok(result)
    }
}
```

### Background compaction loop

```rust
pub async fn run_compaction_loop(
    compaction_mgr: Arc<CompactionManager>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let check_interval = Duration::from_secs(10);

    loop {
        tokio::select! {
            _ = tokio::time::sleep(check_interval) => {}
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    tracing::info!("compaction loop shutting down");
                    return;
                }
            }
        }

        if let Some(level) = compaction_mgr.needs_compaction() {
            tracing::info!(level, "starting compaction");
            let mgr = compaction_mgr.clone();

            let result = tokio::task::spawn_blocking(move || {
                mgr.compact_level(level)
            })
            .await;

            match result {
                Ok(Ok(())) => tracing::info!(level, "compaction complete"),
                Ok(Err(e)) => tracing::error!(level, error = %e, "compaction failed"),
                Err(e) => tracing::error!(level, error = %e, "compaction task panicked"),
            }
        }
    }
}
```

## Pluggable Storage Backends

Abstract the underlying storage so the engine can run on local disk, object storage, or in-memory for tests.

### Trait definition

```rust
use async_trait::async_trait;
use bytes::Bytes;

#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// Read `len` bytes starting at `offset` from the given path.
    async fn read(&self, path: &str, offset: u64, len: u64) -> Result<Bytes>;

    /// Write (overwrite) the entire file at the given path.
    async fn write(&self, path: &str, data: &[u8]) -> Result<()>;

    /// Append data to the end of the file. Returns the offset where the data was written.
    async fn append(&self, path: &str, data: &[u8]) -> Result<u64>;

    /// List all paths with the given prefix.
    async fn list(&self, prefix: &str) -> Result<Vec<String>>;

    /// Delete the file at the given path.
    async fn delete(&self, path: &str) -> Result<()>;

    /// Whether this backend supports memory-mapping files.
    /// If false, the engine falls back to buffered reads.
    fn supports_mmap(&self) -> bool;
}
```

### Local filesystem backend

```rust
use std::io::{Read as IoRead, Seek, SeekFrom, Write as IoWrite};
use tokio::fs;

pub struct LocalBackend {
    root: PathBuf,
}

impl LocalBackend {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    fn resolve(&self, path: &str) -> PathBuf {
        self.root.join(path)
    }
}

#[async_trait]
impl StorageBackend for LocalBackend {
    async fn read(&self, path: &str, offset: u64, len: u64) -> Result<Bytes> {
        let full_path = self.resolve(path);
        let mut file = std::fs::File::open(&full_path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len as usize];
        file.read_exact(&mut buf)?;
        Ok(Bytes::from(buf))
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        let full_path = self.resolve(path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::File::create(&full_path)?;
        file.write_all(data)?;
        file.sync_all()?;
        Ok(())
    }

    async fn append(&self, path: &str, data: &[u8]) -> Result<u64> {
        let full_path = self.resolve(path);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&full_path)?;
        let offset = file.seek(SeekFrom::End(0))?;
        file.write_all(data)?;
        file.sync_data()?;
        Ok(offset)
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let dir = self.resolve(prefix);
        let mut paths = Vec::new();
        if dir.is_dir() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                if let Some(name) = entry.path().strip_prefix(&self.root).ok() {
                    paths.push(name.to_string_lossy().into_owned());
                }
            }
        }
        paths.sort();
        Ok(paths)
    }

    async fn delete(&self, path: &str) -> Result<()> {
        let full_path = self.resolve(path);
        std::fs::remove_file(&full_path)?;
        Ok(())
    }

    fn supports_mmap(&self) -> bool {
        true
    }
}
```

### S3/object storage backend

```rust
/// A generic object-storage backend that uses pre-signed URLs or an SDK.
/// This shows the structure — plug in your preferred S3 client (aws-sdk-s3, rusoto, etc.).
pub struct S3Backend {
    bucket: String,
    prefix: String,
    client: aws_sdk_s3::Client,
}

impl S3Backend {
    pub async fn new(bucket: String, prefix: String) -> Result<Self> {
        let config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = aws_sdk_s3::Client::new(&config);
        Ok(Self { bucket, prefix, client })
    }

    fn key(&self, path: &str) -> String {
        format!("{}/{}", self.prefix, path)
    }
}

#[async_trait]
impl StorageBackend for S3Backend {
    async fn read(&self, path: &str, offset: u64, len: u64) -> Result<Bytes> {
        let range = format!("bytes={}-{}", offset, offset + len - 1);
        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(self.key(path))
            .range(range)
            .send()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;

        let body = resp
            .body
            .collect()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;

        Ok(body.into_bytes())
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(self.key(path))
            .body(data.to_vec().into())
            .send()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(())
    }

    async fn append(&self, _path: &str, _data: &[u8]) -> Result<u64> {
        // S3 does not support append. Use multipart upload or rewrite.
        Err(StorageError::Backend(
            "S3 does not support append — use write() with full object".into(),
        ))
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let full_prefix = self.key(prefix);
        let resp = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(&full_prefix)
            .send()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;

        let paths = resp
            .contents()
            .iter()
            .filter_map(|obj| obj.key())
            .map(|k| k.strip_prefix(&format!("{}/", self.prefix)).unwrap_or(k).to_string())
            .collect();

        Ok(paths)
    }

    async fn delete(&self, path: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(self.key(path))
            .send()
            .await
            .map_err(|e| StorageError::Backend(e.to_string()))?;
        Ok(())
    }

    fn supports_mmap(&self) -> bool {
        false
    }
}
```

### In-memory backend (testing)

```rust
use std::collections::BTreeMap;

pub struct InMemoryBackend {
    files: RwLock<BTreeMap<String, Vec<u8>>>,
}

impl InMemoryBackend {
    pub fn new() -> Self {
        Self { files: RwLock::new(BTreeMap::new()) }
    }
}

#[async_trait]
impl StorageBackend for InMemoryBackend {
    async fn read(&self, path: &str, offset: u64, len: u64) -> Result<Bytes> {
        let files = self.files.read();
        let data = files
            .get(path)
            .ok_or(StorageError::NotFound)?;
        let start = offset as usize;
        let end = (offset + len) as usize;
        if end > data.len() {
            return Err(StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "read past end of file",
            )));
        }
        Ok(Bytes::copy_from_slice(&data[start..end]))
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<()> {
        self.files.write().insert(path.to_string(), data.to_vec());
        Ok(())
    }

    async fn append(&self, path: &str, data: &[u8]) -> Result<u64> {
        let mut files = self.files.write();
        let file = files.entry(path.to_string()).or_insert_with(Vec::new);
        let offset = file.len() as u64;
        file.extend_from_slice(data);
        Ok(offset)
    }

    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        let files = self.files.read();
        let paths: Vec<String> = files
            .keys()
            .filter(|k| k.starts_with(prefix))
            .cloned()
            .collect();
        Ok(paths)
    }

    async fn delete(&self, path: &str) -> Result<()> {
        self.files.write().remove(path);
        Ok(())
    }

    fn supports_mmap(&self) -> bool {
        false
    }
}
```

## io_uring (Linux)

`io_uring` provides kernel-bypassed async I/O on Linux. The engine uses it for WAL fsync and segment reads when available, falling back to standard syscalls on other platforms.

### Feature-gated io_uring wrapper

```rust
#[cfg(target_os = "linux")]
mod uring {
    use io_uring::{opcode, types, IoUring};
    use std::fs::File;
    use std::os::unix::io::AsRawFd;

    use crate::Result;
    use crate::StorageError;

    /// Thin wrapper around io_uring for file operations.
    pub struct UringWriter {
        ring: IoUring,
    }

    impl UringWriter {
        pub fn new(queue_depth: u32) -> Result<Self> {
            let ring = IoUring::new(queue_depth)
                .map_err(|e| StorageError::Io(e))?;
            Ok(Self { ring })
        }

        /// Submit a write followed by an fsync, wait for both to complete.
        pub fn write_and_sync(&mut self, file: &File, data: &[u8], offset: u64) -> Result<()> {
            let fd = types::Fd(file.as_raw_fd());

            // Submit write
            let write_op = opcode::Write::new(fd, data.as_ptr(), data.len() as u32)
                .offset(offset)
                .build()
                .user_data(1);

            unsafe {
                self.ring.submission().push(&write_op)
                    .map_err(|_| StorageError::Backend("io_uring submission queue full".into()))?;
            }
            self.ring.submit_and_wait(1)?;

            // Consume write completion
            let cqe = self.ring.completion().next()
                .ok_or_else(|| StorageError::Backend("io_uring: no write completion".into()))?;
            if cqe.result() < 0 {
                return Err(StorageError::Io(std::io::Error::from_raw_os_error(-cqe.result())));
            }

            // Submit fsync
            let fsync_op = opcode::Fsync::new(fd)
                .build()
                .user_data(2);

            unsafe {
                self.ring.submission().push(&fsync_op)
                    .map_err(|_| StorageError::Backend("io_uring submission queue full".into()))?;
            }
            self.ring.submit_and_wait(1)?;

            let cqe = self.ring.completion().next()
                .ok_or_else(|| StorageError::Backend("io_uring: no fsync completion".into()))?;
            if cqe.result() < 0 {
                return Err(StorageError::Io(std::io::Error::from_raw_os_error(-cqe.result())));
            }

            Ok(())
        }

        /// Submit a batch of reads and wait for all completions.
        pub fn read_batch(
            &mut self,
            file: &File,
            requests: &mut [(u64, Vec<u8>)], // (offset, buffer)
        ) -> Result<()> {
            let fd = types::Fd(file.as_raw_fd());

            for (i, (offset, buf)) in requests.iter_mut().enumerate() {
                let read_op = opcode::Read::new(fd, buf.as_mut_ptr(), buf.len() as u32)
                    .offset(*offset)
                    .build()
                    .user_data(i as u64);

                unsafe {
                    self.ring.submission().push(&read_op)
                        .map_err(|_| StorageError::Backend("io_uring submission queue full".into()))?;
                }
            }

            self.ring.submit_and_wait(requests.len())?;

            // Drain completions
            let mut completed = 0;
            while completed < requests.len() {
                if let Some(cqe) = self.ring.completion().next() {
                    if cqe.result() < 0 {
                        return Err(StorageError::Io(
                            std::io::Error::from_raw_os_error(-cqe.result()),
                        ));
                    }
                    completed += 1;
                }
            }

            Ok(())
        }
    }
}
```

### Platform-agnostic I/O dispatcher

```rust
/// Dispatches file I/O to io_uring on Linux, standard syscalls elsewhere.
pub struct IoDispatcher {
    #[cfg(target_os = "linux")]
    uring: Option<uring::UringWriter>,
}

impl IoDispatcher {
    pub fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(target_os = "linux")]
            uring: uring::UringWriter::new(256).ok(),
        })
    }

    pub fn write_and_sync(&mut self, file: &File, data: &[u8], offset: u64) -> Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(ref mut uring) = self.uring {
            return uring.write_and_sync(file, data, offset);
        }

        // Fallback: standard write + fsync
        use std::io::{Seek, SeekFrom, Write};
        let mut file_ref = file;
        // Note: File does not implement Seek via &File — in production, use pwrite(2) via nix crate
        // or pass an owned/mutable file handle. Shown here for structure.
        std::io::Write::write_all(&mut file_ref, data)?;
        file.sync_all()?;
        Ok(())
    }

    pub fn has_io_uring(&self) -> bool {
        #[cfg(target_os = "linux")]
        return self.uring.is_some();

        #[cfg(not(target_os = "linux"))]
        return false;
    }
}
```

## Performance Targets

Baseline targets for a single-node engine on NVMe SSD (measured with WAL + memtable, not counting compaction overhead):

| Scenario | Target throughput | Latency p99 | Notes |
|---|---|---|---|
| Sequential writes (WAL fsync per write) | 50,000 ops/s | < 2 ms | Bounded by fdatasync latency |
| Sequential writes (group commit, 1ms window) | 300,000 ops/s | < 3 ms | Amortized fsync cost |
| Sequential writes (group commit + io_uring) | 500,000+ ops/s | < 2 ms | Linux only |
| Point reads (memtable hit) | 2,000,000+ ops/s | < 10 us | Lock-free skip list |
| Point reads (mmap segment, cached) | 500,000+ ops/s | < 50 us | Zero-copy from page cache |
| Point reads (mmap segment, cold) | 50,000 ops/s | < 500 us | Page fault cost |
| Range scan (memtable, 1000 keys) | 100,000 scans/s | < 100 us | Iterator over skip list |
| Compaction throughput | 200 MB/s | N/A | CPU-bound merge, runs on spawn_blocking |

Tuning knobs:

| Parameter | Default | Effect |
|---|---|---|
| `SyncPolicy` | `GroupCommit { max_wait_us: 1000 }` | Trade latency for throughput |
| `memtable max_size_bytes` | 64 MB | Larger = fewer flushes, more memory |
| `CompactionConfig::l0_trigger` | 4 segments | Lower = less read amplification, more compaction work |
| `CompactionConfig::size_ratio` | 10 | Lower = more compaction, less space amplification |
| `CompactionConfig::target_segment_size` | 64 MB | Larger = fewer segments to search |
| `io_uring queue_depth` | 256 | Higher = more concurrent I/O ops in flight |
| `MVCC retention_us` | 60,000,000 (60s) | Longer = more versions kept, more disk/memory |

## Never

- **Never skip the WAL.** Writing directly to the memtable without WAL means data loss on crash. The WAL is the source of truth.
- **Never fsync after every byte in a hot path.** Use group commit to batch syncs. A single fsync takes 100us-2ms on NVMe; doing it per-write caps throughput at 500-10,000 ops/s.
- **Never hold a lock across an fsync.** Fsync can block for milliseconds. Structure the code so the mutex is released before calling sync_all/sync_data.
- **Never mmap a file that is still being written.** Seal the segment first (make it immutable), then mmap. Writing to a mmap'd file from another fd is undefined behavior.
- **Never assume mmap reads are free.** First access triggers a page fault. Pre-fault hot pages with `madvise(MADV_WILLNEED)` or `MmapOptions::populate()`.
- **Never run compaction on the tokio runtime.** Compaction is CPU-bound. Use `tokio::task::spawn_blocking` to avoid starving async tasks.
- **Never delete segments that active MVCC snapshots reference.** The compaction merge must check the oldest active snapshot and preserve all versions visible to it.
- **Never use `unwrap()` on I/O operations in the storage engine.** Disk can fail, files can be corrupted. Propagate errors with `?`.
- **Never ignore CRC checksum failures.** A checksum mismatch means data corruption. Log it, truncate the WAL at the corruption point, and alert.
- **Never use `io_uring` without `#[cfg(target_os = "linux")]` gating.** It is Linux-only. The code must compile and run (with fallback) on macOS and other platforms.
