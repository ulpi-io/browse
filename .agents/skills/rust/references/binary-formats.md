# Binary Formats

## Design Principles

All on-disk formats follow five rules:

| Principle | Rationale |
|---|---|
| Length-prefixed variable fields | Reader knows exact byte range without scanning |
| Fixed-size headers | Random access without parsing preceding data |
| CRC-32C checksums | Hardware-accelerated integrity on x86 (`_mm_crc32_*`) and ARM (`__crc32c*`) |
| Little-endian throughout | Native byte order on x86/ARM — no swapping on read |
| Page-aligned regions | Direct `mmap` without offset arithmetic; OS page cache friendly |

Page size constant used everywhere:

```rust
const PAGE_SIZE: usize = 4096;

/// Round `size` up to the next page boundary.
#[inline]
const fn page_align(size: usize) -> usize {
    (size + PAGE_SIZE - 1) & !(PAGE_SIZE - 1)
}
```

---

## Zero-Copy Parsing with zerocopy

The `zerocopy` crate casts raw byte slices to typed struct references with zero allocation. The struct must be `repr(C)` (or `repr(C, packed)`) so the compiler does not reorder or pad fields.

### Cargo.toml

```toml
[dependencies]
zerocopy = { version = "0.8", features = ["derive"] }
crc32c = "0.6"
```

### Header struct

```rust
use zerocopy::{FromBytes, IntoBytes, KnownLayout, Immutable};

/// On-disk segment header — 32 bytes, page-aligned start.
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct SegmentHeader {
    pub magic: [u8; 4],        // b"SEG\x01"
    pub version: u8,           // format version
    pub flags: u8,             // bit 0: compressed, bit 1: encrypted
    pub _reserved: [u8; 2],    // alignment padding, must be 0
    pub entry_count: u32,      // number of entries in this segment
    pub data_offset: u32,      // byte offset to data region from segment start
    pub data_size: u32,        // total bytes in data region
    pub index_offset: u32,     // byte offset to index region
    pub index_size: u32,       // total bytes in index region
    pub checksum: u32,         // CRC-32C of everything after this field
}
```

### Casting bytes to a header reference

```rust
use zerocopy::Ref;

/// Parse a segment header from a byte slice without copying.
///
/// Returns the header reference and the remaining bytes.
/// Fails if the slice is too short or misaligned.
pub fn parse_segment_header(bytes: &[u8]) -> Result<(Ref<&[u8], SegmentHeader>, &[u8]), FormatError> {
    let (header_ref, rest) = Ref::<_, SegmentHeader>::from_prefix(bytes)
        .map_err(|_| FormatError::HeaderTooShort)?;

    if header_ref.magic != *b"SEG\x01" {
        return Err(FormatError::BadMagic);
    }

    // Verify CRC: checksum covers bytes after the checksum field itself.
    let checksum_offset = offset_of_checksum();
    let payload = &bytes[checksum_offset + 4..][..header_ref.data_size as usize + header_ref.index_size as usize];
    let computed = crc32c::crc32c(payload);
    if computed != header_ref.checksum {
        return Err(FormatError::ChecksumMismatch { expected: header_ref.checksum, computed });
    }

    Ok((header_ref, rest))
}

fn offset_of_checksum() -> usize {
    // magic(4) + version(1) + flags(1) + reserved(2) + entry_count(4)
    // + data_offset(4) + data_size(4) + index_offset(4) + index_size(4) = 28
    28
}
```

### Casting a struct to bytes for writing

```rust
use zerocopy::IntoBytes;

pub fn write_segment_header(header: &SegmentHeader, writer: &mut impl std::io::Write) -> std::io::Result<()> {
    writer.write_all(header.as_bytes())
}
```

### Array of fixed-size entries — zero-copy slice

```rust
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct IndexEntry {
    pub key_hash: u64,
    pub offset: u32,
    pub length: u32,
}

/// Interpret a byte slice as a contiguous array of IndexEntry.
pub fn parse_index(bytes: &[u8], count: usize) -> Result<&[IndexEntry], FormatError> {
    let expected_len = count * std::mem::size_of::<IndexEntry>();
    if bytes.len() < expected_len {
        return Err(FormatError::IndexTooShort);
    }
    // zerocopy guarantees alignment and size checks.
    let (entries, _) = <[IndexEntry]>::ref_from_prefix_with_elems(&bytes[..expected_len], count)
        .map_err(|_| FormatError::IndexAlignment)?;
    Ok(entries)
}
```

---

## Binary Map Format (BMAP)

BMAP stores key-value maps on disk with O(log n) field access by key name. Used for JSON/JSONB column storage. No full deserialization required to read a single field.

### On-disk layout

```text
+-----------------------------------------------+
| BMapHeader (12 bytes)                         |
|   magic: [u8; 2]       = b"BM"               |
|   version: u8           = 1                   |
|   flags: u8             = 0                   |
|   key_count: u16                              |
|   total_size: u32       (entire BMAP blob)    |
|   checksum: u16         (CRC-16 of payload)   |
+-----------------------------------------------+
| Key Index (sorted by key_hash, 15 bytes each) |
|   key_hash:     u32     FNV-1a of key string  |
|   key_offset:   u32     from BMAP start       |
|   key_len:      u16     bytes                 |
|   value_offset: u32     from BMAP start       |
|   value_type:   u8      type tag              |
+-----------------------------------------------+
| Key Strings Region                            |
|   UTF-8 key bytes packed back-to-back         |
+-----------------------------------------------+
| Values Region                                 |
|   type-tagged values, variable size           |
|   nested BMAP/BARR stored inline              |
+-----------------------------------------------+
```

### Value type tags

```rust
/// Type discriminant stored in key index entries.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BMapValueType {
    Null    = 0,
    Bool    = 1,   // 1 byte: 0x00=false, 0x01=true
    Int64   = 2,   // 8 bytes LE
    Float64 = 3,   // 8 bytes LE IEEE 754
    String  = 4,   // u32 length prefix + UTF-8 bytes
    Bytes   = 5,   // u32 length prefix + raw bytes
    BMap    = 6,   // nested BMAP blob (recursive)
    BArr    = 7,   // nested BARR blob
    Decimal = 8,   // packed decimal (DEC format)
}

impl BMapValueType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Null),
            1 => Some(Self::Bool),
            2 => Some(Self::Int64),
            3 => Some(Self::Float64),
            4 => Some(Self::String),
            5 => Some(Self::Bytes),
            6 => Some(Self::BMap),
            7 => Some(Self::BArr),
            8 => Some(Self::Decimal),
            _ => None,
        }
    }
}
```

### Structs

```rust
use zerocopy::{FromBytes, IntoBytes, KnownLayout, Immutable};

#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct BMapHeader {
    pub magic: [u8; 2],       // b"BM"
    pub version: u8,
    pub flags: u8,
    pub key_count: u16,
    pub total_size: u32,
    pub checksum: u16,
}

#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct BMapKeyEntry {
    pub key_hash: u32,
    pub key_offset: u32,
    pub key_len: u16,
    pub value_offset: u32,
    pub value_type: u8,
}
```

### FNV-1a hash (32-bit)

```rust
/// FNV-1a 32-bit hash. Deterministic, fast, good distribution for short strings.
#[inline]
pub fn fnv1a_32(data: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5; // FNV offset basis
    for &byte in data {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193); // FNV prime
    }
    hash
}
```

### BMapReader — zero-copy access

```rust
/// Read-only accessor for a BMAP blob. Borrows the underlying bytes.
pub struct BMapReader<'a> {
    data: &'a [u8],
    header: &'a BMapHeader,
    key_index: &'a [BMapKeyEntry],
}

/// Value extracted from BMAP without copying the backing bytes.
#[derive(Debug)]
pub enum BMapValue<'a> {
    Null,
    Bool(bool),
    Int64(i64),
    Float64(f64),
    String(&'a str),
    Bytes(&'a [u8]),
    BMap(BMapReader<'a>),
    BArr(BArrReader<'a>),
    Decimal(PackedDecimalRef<'a>),
}

impl<'a> BMapReader<'a> {
    /// Parse a BMAP from a byte slice. O(1) — no deserialization.
    pub fn from_bytes(data: &'a [u8]) -> Result<Self, FormatError> {
        if data.len() < std::mem::size_of::<BMapHeader>() {
            return Err(FormatError::BMapTooShort);
        }

        let (header, rest) = Ref::<_, BMapHeader>::from_prefix(data)
            .map_err(|_| FormatError::BMapTooShort)?;
        let header: &BMapHeader = &header;

        if header.magic != *b"BM" {
            return Err(FormatError::BadMagic);
        }

        let count = header.key_count as usize;
        let (key_index, _) = <[BMapKeyEntry]>::ref_from_prefix_with_elems(rest, count)
            .map_err(|_| FormatError::BMapIndexTruncated)?;

        Ok(Self { data, header, key_index })
    }

    /// Look up a key. O(log n) binary search on the hash-sorted index.
    pub fn get(&self, key: &str) -> Result<Option<BMapValue<'a>>, FormatError> {
        let target_hash = fnv1a_32(key.as_bytes());

        // Binary search the key index by hash.
        let result = self.key_index.binary_search_by(|entry| {
            entry.key_hash.cmp(&target_hash)
        });

        let idx = match result {
            Ok(idx) => idx,
            Err(_) => return Ok(None),
        };

        // Handle hash collisions: scan both directions from the match point.
        // Check the exact key string for each candidate.
        for i in self.scan_hash_run(idx, target_hash) {
            let entry = &self.key_index[i];
            let key_start = entry.key_offset as usize;
            let key_end = key_start + entry.key_len as usize;

            if key_end > self.data.len() {
                return Err(FormatError::BMapKeyOutOfBounds);
            }

            let stored_key = std::str::from_utf8(&self.data[key_start..key_end])
                .map_err(|_| FormatError::InvalidUtf8)?;

            if stored_key == key {
                return self.read_value(entry).map(Some);
            }
        }

        Ok(None) // hash matched but key string did not — collision
    }

    /// Nested access: `reader.get_path(&["address", "city"])` traverses
    /// nested BMAPs without intermediate allocations.
    pub fn get_path(&self, keys: &[&str]) -> Result<Option<BMapValue<'a>>, FormatError> {
        if keys.is_empty() {
            return Ok(None);
        }

        let mut current_value = match self.get(keys[0])? {
            Some(v) => v,
            None => return Ok(None),
        };

        for &key in &keys[1..] {
            match current_value {
                BMapValue::BMap(nested) => {
                    current_value = match nested.get(key)? {
                        Some(v) => v,
                        None => return Ok(None),
                    };
                }
                _ => return Ok(None), // tried to descend into a non-map
            }
        }

        Ok(Some(current_value))
    }

    /// Iterate all key-value pairs. O(n).
    pub fn iter(&self) -> impl Iterator<Item = Result<(&'a str, BMapValue<'a>), FormatError>> + '_ {
        self.key_index.iter().map(move |entry| {
            let key_start = entry.key_offset as usize;
            let key_end = key_start + entry.key_len as usize;
            let key = std::str::from_utf8(&self.data[key_start..key_end])
                .map_err(|_| FormatError::InvalidUtf8)?;
            let value = self.read_value(entry)?;
            Ok((key, value))
        })
    }

    /// Return indices of all key_index entries whose hash equals `target_hash`,
    /// starting from the binary-search hit at `center`.
    fn scan_hash_run(&self, center: usize, target_hash: u32) -> impl Iterator<Item = usize> + '_ {
        let left = (0..center)
            .rev()
            .take_while(move |&i| self.key_index[i].key_hash == target_hash);
        let right = (center..self.key_index.len())
            .take_while(move |&i| self.key_index[i].key_hash == target_hash);
        // center is included in `right`, so no double-counting.
        left.chain(right)
    }

    fn read_value(&self, entry: &BMapKeyEntry) -> Result<BMapValue<'a>, FormatError> {
        let offset = entry.value_offset as usize;
        let remaining = self.data.get(offset..).ok_or(FormatError::BMapValueOutOfBounds)?;

        let vtype = BMapValueType::from_u8(entry.value_type)
            .ok_or(FormatError::UnknownValueType(entry.value_type))?;

        match vtype {
            BMapValueType::Null => Ok(BMapValue::Null),

            BMapValueType::Bool => {
                let b = *remaining.first().ok_or(FormatError::BMapValueOutOfBounds)?;
                Ok(BMapValue::Bool(b != 0))
            }

            BMapValueType::Int64 => {
                let bytes: [u8; 8] = remaining[..8]
                    .try_into()
                    .map_err(|_| FormatError::BMapValueOutOfBounds)?;
                Ok(BMapValue::Int64(i64::from_le_bytes(bytes)))
            }

            BMapValueType::Float64 => {
                let bytes: [u8; 8] = remaining[..8]
                    .try_into()
                    .map_err(|_| FormatError::BMapValueOutOfBounds)?;
                Ok(BMapValue::Float64(f64::from_le_bytes(bytes)))
            }

            BMapValueType::String => {
                let len = u32::from_le_bytes(
                    remaining[..4].try_into().map_err(|_| FormatError::BMapValueOutOfBounds)?
                ) as usize;
                let s = std::str::from_utf8(&remaining[4..4 + len])
                    .map_err(|_| FormatError::InvalidUtf8)?;
                Ok(BMapValue::String(s))
            }

            BMapValueType::Bytes => {
                let len = u32::from_le_bytes(
                    remaining[..4].try_into().map_err(|_| FormatError::BMapValueOutOfBounds)?
                ) as usize;
                Ok(BMapValue::Bytes(&remaining[4..4 + len]))
            }

            BMapValueType::BMap => {
                // Nested BMAP: first 4 bytes after offset are the total_size
                // Actually, BMapHeader is self-describing via total_size field.
                let nested = BMapReader::from_bytes(remaining)?;
                Ok(BMapValue::BMap(nested))
            }

            BMapValueType::BArr => {
                let nested = BArrReader::from_bytes(remaining)?;
                Ok(BMapValue::BArr(nested))
            }

            BMapValueType::Decimal => {
                let dec = PackedDecimalRef::from_bytes(remaining)?;
                Ok(BMapValue::Decimal(dec))
            }
        }
    }
}
```

### BMapWriter — build a BMAP from serde_json::Value

```rust
use serde_json::Value as JsonValue;

/// Builds a BMAP blob from structured data. Allocates a single Vec<u8>.
pub struct BMapWriter {
    buf: Vec<u8>,
}

impl BMapWriter {
    /// Serialize a JSON value into BMAP bytes.
    pub fn from_json(value: &JsonValue) -> Result<Vec<u8>, FormatError> {
        match value {
            JsonValue::Object(map) => Self::write_object(map),
            _ => Err(FormatError::BMapRootMustBeObject),
        }
    }

    fn write_object(map: &serde_json::Map<String, JsonValue>) -> Result<Vec<u8>, FormatError> {
        let key_count = map.len();
        let header_size = std::mem::size_of::<BMapHeader>();
        let index_size = key_count * std::mem::size_of::<BMapKeyEntry>();

        // Phase 1: Serialize all keys and values into temporary buffers
        // to compute final offsets.
        let mut keys_buf: Vec<u8> = Vec::new();
        let mut values_buf: Vec<u8> = Vec::new();
        let mut entries: Vec<(u32, BMapKeyEntry, Vec<u8>)> = Vec::with_capacity(key_count);
        // (hash, entry_template, key_bytes) — entry offsets filled in phase 2

        for (key, value) in map {
            let key_bytes = key.as_bytes();
            let key_hash = fnv1a_32(key_bytes);

            let key_offset_in_region = keys_buf.len();
            keys_buf.extend_from_slice(key_bytes);

            let value_offset_in_region = values_buf.len();
            let value_type = Self::write_value(value, &mut values_buf)?;

            entries.push((key_hash, BMapKeyEntry {
                key_hash,
                key_offset: 0,     // filled in phase 2
                key_len: key_bytes.len() as u16,
                value_offset: 0,   // filled in phase 2
                value_type: value_type as u8,
            }, key_bytes.to_vec()));

            // Store region-relative offsets temporarily.
            let last = entries.last_mut().unwrap();
            last.1.key_offset = key_offset_in_region as u32;
            last.1.value_offset = value_offset_in_region as u32;
        }

        // Sort entries by key_hash for binary search at read time.
        entries.sort_by_key(|(hash, _, _)| *hash);

        // Phase 2: Compute absolute offsets and assemble the blob.
        let keys_region_start = header_size + index_size;
        let values_region_start = keys_region_start + keys_buf.len();
        let total_size = values_region_start + values_buf.len();

        for (_, entry, _) in &mut entries {
            entry.key_offset += keys_region_start as u32;
            entry.value_offset += values_region_start as u32;
        }

        // Phase 3: Write the final blob.
        let mut buf = Vec::with_capacity(total_size);

        // Header (checksum filled after payload is written).
        let header = BMapHeader {
            magic: *b"BM",
            version: 1,
            flags: 0,
            key_count: key_count as u16,
            total_size: total_size as u32,
            checksum: 0, // placeholder
        };
        buf.extend_from_slice(header.as_bytes());

        // Key index.
        for (_, entry, _) in &entries {
            buf.extend_from_slice(entry.as_bytes());
        }

        // Key strings region.
        buf.extend_from_slice(&keys_buf);

        // Values region.
        buf.extend_from_slice(&values_buf);

        // Patch checksum over everything after the header.
        let payload_crc = crc32c::crc32c(&buf[header_size..]) as u16;
        let checksum_field_offset = 10; // offset of `checksum` field in BMapHeader
        buf[checksum_field_offset..checksum_field_offset + 2]
            .copy_from_slice(&payload_crc.to_le_bytes());

        Ok(buf)
    }

    fn write_value(value: &JsonValue, buf: &mut Vec<u8>) -> Result<BMapValueType, FormatError> {
        match value {
            JsonValue::Null => Ok(BMapValueType::Null),

            JsonValue::Bool(b) => {
                buf.push(if *b { 1 } else { 0 });
                Ok(BMapValueType::Bool)
            }

            JsonValue::Number(n) => {
                if let Some(i) = n.as_i64() {
                    buf.extend_from_slice(&i.to_le_bytes());
                    Ok(BMapValueType::Int64)
                } else if let Some(f) = n.as_f64() {
                    buf.extend_from_slice(&f.to_le_bytes());
                    Ok(BMapValueType::Float64)
                } else {
                    Err(FormatError::UnsupportedNumberType)
                }
            }

            JsonValue::String(s) => {
                let bytes = s.as_bytes();
                buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                buf.extend_from_slice(bytes);
                Ok(BMapValueType::String)
            }

            JsonValue::Array(arr) => {
                // Encode as nested BARR.
                let barr_bytes = BArrWriter::from_json_array(arr)?;
                buf.extend_from_slice(&barr_bytes);
                Ok(BMapValueType::BArr)
            }

            JsonValue::Object(map) => {
                // Encode as nested BMAP — recursive.
                let bmap_bytes = Self::write_object(map)?;
                buf.extend_from_slice(&bmap_bytes);
                Ok(BMapValueType::BMap)
            }
        }
    }
}
```

Usage:

```rust
let json: serde_json::Value = serde_json::json!({
    "name": "Alice",
    "age": 30,
    "address": {
        "city": "Portland",
        "zip": "97201"
    }
});

let bmap_bytes = BMapWriter::from_json(&json)?;
let reader = BMapReader::from_bytes(&bmap_bytes)?;

// Direct field access — O(log n).
assert_eq!(reader.get("name")?, Some(BMapValue::String("Alice")));

// Nested access — no intermediate allocation.
assert_eq!(reader.get_path(&["address", "city"])?, Some(BMapValue::String("Portland")));
```

---

## Binary Array Format (BARR)

BARR stores arrays on disk. Two modes depending on whether elements have uniform size.

### On-disk layout

```text
+----------------------------------------------+
| BArrHeader (12 bytes)                        |
|   magic: [u8; 2]       = b"BA"              |
|   version: u8           = 1                  |
|   flags: u8             bit 0: variable-size |
|   elem_count: u32                            |
|   elem_type: u8         type tag             |
|   total_size: u24       (3 bytes LE)         |
+----------------------------------------------+
| Mode A — Fixed-size elements (flags bit 0=0) |
|   elem[0], elem[1], ..., elem[n-1]          |
|   contiguous, SIMD-accessible               |
+----------------------------------------------+
| Mode B — Variable-size elements (flags bit0=1)|
|   Offset table: [u32; elem_count]            |
|     offsets from BARR start                  |
|   Values: packed back-to-back                |
|     each length-prefixed (u32 + payload)     |
+----------------------------------------------+
```

### Structs

```rust
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct BArrHeader {
    pub magic: [u8; 2],      // b"BA"
    pub version: u8,
    pub flags: u8,            // bit 0: 0=fixed-size, 1=variable-size
    pub elem_count: u32,
    pub elem_type: u8,        // BMapValueType discriminant
    pub total_size_lo: u16,   // total_size lower 16 bits (LE)
    pub total_size_hi: u8,    // total_size upper 8 bits
}

impl BArrHeader {
    pub fn total_size(&self) -> u32 {
        self.total_size_lo as u32 | ((self.total_size_hi as u32) << 16)
    }

    pub fn is_variable_size(&self) -> bool {
        self.flags & 0x01 != 0
    }
}
```

### BArrReader

```rust
pub struct BArrReader<'a> {
    data: &'a [u8],
    header: &'a BArrHeader,
}

impl<'a> BArrReader<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Result<Self, FormatError> {
        let (header, _) = Ref::<_, BArrHeader>::from_prefix(data)
            .map_err(|_| FormatError::BArrTooShort)?;

        if header.magic != *b"BA" {
            return Err(FormatError::BadMagic);
        }

        Ok(Self { data, header: &header })
    }

    pub fn len(&self) -> usize {
        self.header.elem_count as usize
    }

    pub fn is_empty(&self) -> bool {
        self.header.elem_count == 0
    }

    /// Fixed-size path: return a slice of i64 values. O(1) — direct pointer cast.
    /// Only valid when elem_type == Int64 and flags bit 0 == 0.
    pub fn as_i64_slice(&self) -> Result<&'a [i64], FormatError> {
        if self.header.is_variable_size() {
            return Err(FormatError::BArrNotFixedSize);
        }
        if BMapValueType::from_u8(self.header.elem_type) != Some(BMapValueType::Int64) {
            return Err(FormatError::BArrTypeMismatch);
        }

        let header_size = std::mem::size_of::<BArrHeader>();
        let count = self.header.elem_count as usize;
        let data_bytes = &self.data[header_size..header_size + count * 8];

        // SAFETY: i64 has alignment 1 when read via from_le_bytes, but for
        // zero-copy we need the data to be 8-byte aligned. If mmap'd from
        // a page boundary this is guaranteed. Otherwise, fall back to copying.
        // Here we use zerocopy which handles alignment checks.
        let (entries, _) = <[zerocopy::little_endian::I64]>::ref_from_prefix_with_elems(data_bytes, count)
            .map_err(|_| FormatError::BArrAlignment)?;

        // Convert zerocopy LE i64 slice to native i64 slice.
        // On little-endian platforms this is a no-op pointer cast.
        Ok(zerocopy::transmute_ref!(entries))
    }

    /// Fixed-size path: return a slice of f64 values. Same constraints as as_i64_slice.
    pub fn as_f64_slice(&self) -> Result<&'a [f64], FormatError> {
        if self.header.is_variable_size() {
            return Err(FormatError::BArrNotFixedSize);
        }
        if BMapValueType::from_u8(self.header.elem_type) != Some(BMapValueType::Float64) {
            return Err(FormatError::BArrTypeMismatch);
        }

        let header_size = std::mem::size_of::<BArrHeader>();
        let count = self.header.elem_count as usize;
        let data_bytes = &self.data[header_size..header_size + count * 8];

        let (entries, _) = <[zerocopy::little_endian::F64]>::ref_from_prefix_with_elems(data_bytes, count)
            .map_err(|_| FormatError::BArrAlignment)?;

        Ok(zerocopy::transmute_ref!(entries))
    }

    /// Variable-size path: get element at index. O(1) random access via offset table.
    pub fn get_variable(&self, index: usize) -> Result<&'a [u8], FormatError> {
        if !self.header.is_variable_size() {
            return Err(FormatError::BArrNotVariableSize);
        }
        if index >= self.header.elem_count as usize {
            return Err(FormatError::BArrIndexOutOfBounds);
        }

        let header_size = std::mem::size_of::<BArrHeader>();
        let offset_table_start = header_size;
        let offset_pos = offset_table_start + index * 4;

        let elem_offset = u32::from_le_bytes(
            self.data[offset_pos..offset_pos + 4]
                .try_into()
                .map_err(|_| FormatError::BArrOffsetTruncated)?
        ) as usize;

        // Variable-size elements are length-prefixed.
        let len = u32::from_le_bytes(
            self.data[elem_offset..elem_offset + 4]
                .try_into()
                .map_err(|_| FormatError::BArrValueTruncated)?
        ) as usize;

        Ok(&self.data[elem_offset + 4..elem_offset + 4 + len])
    }

    /// Get a variable-size string element.
    pub fn get_string(&self, index: usize) -> Result<&'a str, FormatError> {
        let bytes = self.get_variable(index)?;
        std::str::from_utf8(bytes).map_err(|_| FormatError::InvalidUtf8)
    }
}
```

### BArrWriter

```rust
pub struct BArrWriter;

impl BArrWriter {
    /// Write a fixed-size i64 array. Contiguous layout, no offset table.
    pub fn from_i64_slice(values: &[i64]) -> Vec<u8> {
        let header_size = std::mem::size_of::<BArrHeader>();
        let data_size = values.len() * 8;
        let total = header_size + data_size;

        let mut buf = Vec::with_capacity(total);

        let header = BArrHeader {
            magic: *b"BA",
            version: 1,
            flags: 0, // fixed-size
            elem_count: values.len() as u32,
            elem_type: BMapValueType::Int64 as u8,
            total_size_lo: (total & 0xFFFF) as u16,
            total_size_hi: ((total >> 16) & 0xFF) as u8,
        };
        buf.extend_from_slice(header.as_bytes());

        for &v in values {
            buf.extend_from_slice(&v.to_le_bytes());
        }

        buf
    }

    /// Write a variable-size string array. Offset table + length-prefixed values.
    pub fn from_strings(values: &[&str]) -> Vec<u8> {
        let header_size = std::mem::size_of::<BArrHeader>();
        let offset_table_size = values.len() * 4;

        // Pre-compute value sizes: 4-byte length prefix + payload per element.
        let values_size: usize = values.iter().map(|s| 4 + s.len()).sum();
        let total = header_size + offset_table_size + values_size;

        let mut buf = Vec::with_capacity(total);

        let header = BArrHeader {
            magic: *b"BA",
            version: 1,
            flags: 0x01, // variable-size
            elem_count: values.len() as u32,
            elem_type: BMapValueType::String as u8,
            total_size_lo: (total & 0xFFFF) as u16,
            total_size_hi: ((total >> 16) & 0xFF) as u8,
        };
        buf.extend_from_slice(header.as_bytes());

        // Build offset table: each offset points to the length-prefixed value.
        let values_region_start = header_size + offset_table_size;
        let mut current_offset = values_region_start;
        for s in values {
            buf.extend_from_slice(&(current_offset as u32).to_le_bytes());
            current_offset += 4 + s.len();
        }

        // Write length-prefixed values.
        for s in values {
            buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
            buf.extend_from_slice(s.as_bytes());
        }

        buf
    }

    /// Encode a JSON array into BARR format. Dispatches to fixed or variable
    /// based on element types.
    pub fn from_json_array(arr: &[JsonValue]) -> Result<Vec<u8>, FormatError> {
        if arr.is_empty() {
            return Ok(Self::from_i64_slice(&[])); // empty array, fixed-size default
        }

        // Homogeneous i64 array? Use fixed-size path.
        if arr.iter().all(|v| v.as_i64().is_some()) {
            let ints: Vec<i64> = arr.iter().map(|v| v.as_i64().unwrap()).collect();
            return Ok(Self::from_i64_slice(&ints));
        }

        // Homogeneous f64 array? Use fixed-size path.
        if arr.iter().all(|v| v.as_f64().is_some()) {
            let floats: Vec<f64> = arr.iter().map(|v| v.as_f64().unwrap()).collect();
            return Ok(Self::from_f64_slice(&floats));
        }

        // Mixed/string/nested: serialize each element individually, variable-size.
        Self::from_json_array_variable(arr)
    }

    pub fn from_f64_slice(values: &[f64]) -> Vec<u8> {
        let header_size = std::mem::size_of::<BArrHeader>();
        let data_size = values.len() * 8;
        let total = header_size + data_size;

        let mut buf = Vec::with_capacity(total);

        let header = BArrHeader {
            magic: *b"BA",
            version: 1,
            flags: 0,
            elem_count: values.len() as u32,
            elem_type: BMapValueType::Float64 as u8,
            total_size_lo: (total & 0xFFFF) as u16,
            total_size_hi: ((total >> 16) & 0xFF) as u8,
        };
        buf.extend_from_slice(header.as_bytes());

        for &v in values {
            buf.extend_from_slice(&v.to_le_bytes());
        }

        buf
    }

    fn from_json_array_variable(arr: &[JsonValue]) -> Result<Vec<u8>, FormatError> {
        // Serialize each element into a temporary buffer, then assemble with offsets.
        let mut element_bufs: Vec<Vec<u8>> = Vec::with_capacity(arr.len());
        for val in arr {
            let mut elem_buf = Vec::new();
            BMapWriter::write_value_to_buf(val, &mut elem_buf)?;
            element_bufs.push(elem_buf);
        }

        let header_size = std::mem::size_of::<BArrHeader>();
        let offset_table_size = arr.len() * 4;
        let values_size: usize = element_bufs.iter().map(|b| 4 + b.len()).sum();
        let total = header_size + offset_table_size + values_size;

        let mut buf = Vec::with_capacity(total);

        let header = BArrHeader {
            magic: *b"BA",
            version: 1,
            flags: 0x01,
            elem_count: arr.len() as u32,
            elem_type: BMapValueType::Bytes as u8, // mixed types stored as tagged bytes
            total_size_lo: (total & 0xFFFF) as u16,
            total_size_hi: ((total >> 16) & 0xFF) as u8,
        };
        buf.extend_from_slice(header.as_bytes());

        let values_region_start = header_size + offset_table_size;
        let mut current_offset = values_region_start;
        for elem_buf in &element_bufs {
            buf.extend_from_slice(&(current_offset as u32).to_le_bytes());
            current_offset += 4 + elem_buf.len();
        }

        for elem_buf in &element_bufs {
            buf.extend_from_slice(&(elem_buf.len() as u32).to_le_bytes());
            buf.extend_from_slice(elem_buf);
        }

        Ok(buf)
    }
}
```

---

## Packed Decimal Format (DEC)

For DECIMAL/NUMERIC exact-precision arithmetic. Avoids floating-point representation error. Each digit group stores 4 decimal digits (0-9999) in a u16, using base-10000 encoding.

### Representation

```rust
/// Packed decimal: exact numeric representation for DECIMAL(p, s) columns.
/// Base-10000 encoding: each u16 in `digits` holds 0..9999 (four decimal digits).
///
/// Examples:
///   123456.78 → sign=1, weight=1, scale=2, digits=[12, 3456, 7800]
///   -0.005    → sign=-1, weight=-1, scale=3, digits=[50]
///   0         → sign=0, weight=0, scale=0, digits=[]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackedDecimal {
    pub sign: i8,           // +1, -1, or 0
    pub weight: i16,        // position of first digit group (base-10000 exponent)
    pub scale: u16,         // digits after decimal point
    pub digits: Vec<u16>,   // base-10000 digit groups, most significant first
}
```

### On-disk encoding

```text
+------------------------------------------+
| sign:   i8    (1 byte)                   |
| weight: i16   (2 bytes LE)              |
| scale:  u16   (2 bytes LE)              |
| ndigits: u16  (2 bytes LE)              |
| digits: [u16; ndigits] (2*ndigits LE)   |
+------------------------------------------+
Total: 7 + 2*ndigits bytes
```

### Reader/Writer

```rust
/// Zero-copy reference into packed decimal bytes.
pub struct PackedDecimalRef<'a> {
    pub sign: i8,
    pub weight: i16,
    pub scale: u16,
    pub digits: &'a [u8], // raw LE u16 pairs
}

impl<'a> PackedDecimalRef<'a> {
    pub fn from_bytes(data: &'a [u8]) -> Result<Self, FormatError> {
        if data.len() < 7 {
            return Err(FormatError::DecimalTooShort);
        }

        let sign = data[0] as i8;
        let weight = i16::from_le_bytes([data[1], data[2]]);
        let scale = u16::from_le_bytes([data[3], data[4]]);
        let ndigits = u16::from_le_bytes([data[5], data[6]]) as usize;
        let digits_len = ndigits * 2;

        if data.len() < 7 + digits_len {
            return Err(FormatError::DecimalTruncated);
        }

        Ok(Self {
            sign,
            weight,
            scale,
            digits: &data[7..7 + digits_len],
        })
    }

    /// Read the i-th digit group as a native u16.
    pub fn digit(&self, i: usize) -> u16 {
        let offset = i * 2;
        u16::from_le_bytes([self.digits[offset], self.digits[offset + 1]])
    }

    /// Number of digit groups.
    pub fn ndigits(&self) -> usize {
        self.digits.len() / 2
    }

    /// Convert to f64 (lossy — for display/comparison, not exact arithmetic).
    pub fn to_f64(&self) -> f64 {
        if self.sign == 0 {
            return 0.0;
        }
        let mut result: f64 = 0.0;
        for i in 0..self.ndigits() {
            let group = self.digit(i) as f64;
            let exponent = (self.weight as i32 - i as i32) * 4;
            result += group * 10f64.powi(exponent);
        }
        result * self.sign as f64
    }
}

impl PackedDecimal {
    /// Serialize to bytes for on-disk storage.
    pub fn to_bytes(&self) -> Vec<u8> {
        let ndigits = self.digits.len();
        let mut buf = Vec::with_capacity(7 + ndigits * 2);

        buf.push(self.sign as u8);
        buf.extend_from_slice(&self.weight.to_le_bytes());
        buf.extend_from_slice(&self.scale.to_le_bytes());
        buf.extend_from_slice(&(ndigits as u16).to_le_bytes());
        for &d in &self.digits {
            buf.extend_from_slice(&d.to_le_bytes());
        }

        buf
    }

    /// Parse a decimal string like "123456.78" or "-0.005".
    pub fn from_str(s: &str) -> Result<Self, FormatError> {
        let s = s.trim();
        if s == "0" || s == "0.0" || s == "-0" {
            return Ok(Self { sign: 0, weight: 0, scale: 0, digits: vec![] });
        }

        let (sign, s) = if let Some(rest) = s.strip_prefix('-') {
            (-1i8, rest)
        } else {
            (1i8, s)
        };

        let (integer_part, frac_part) = match s.split_once('.') {
            Some((i, f)) => (i, f),
            None => (s, ""),
        };

        let scale = frac_part.len() as u16;

        // Combine integer + fraction into one digit string, pad to multiple of 4.
        let mut all_digits = format!("{}{}", integer_part, frac_part);
        let integer_len = integer_part.len();

        // Weight = number of base-10000 groups in the integer part - 1.
        let weight = ((integer_len as i32 + 3) / 4) as i16 - 1;

        // Left-pad to align so that the decimal point falls on a group boundary.
        let pad_left = (4 - (integer_len % 4)) % 4;
        if pad_left > 0 {
            all_digits = format!("{}{}", "0".repeat(pad_left), all_digits);
        }

        // Right-pad to a multiple of 4.
        let pad_right = (4 - (all_digits.len() % 4)) % 4;
        for _ in 0..pad_right {
            all_digits.push('0');
        }

        // Split into groups of 4.
        let mut digits = Vec::new();
        for chunk in all_digits.as_bytes().chunks(4) {
            let group: u16 = std::str::from_utf8(chunk)
                .map_err(|_| FormatError::InvalidDecimalString)?
                .parse()
                .map_err(|_| FormatError::InvalidDecimalString)?;
            digits.push(group);
        }

        // Strip trailing zero groups (beyond what scale requires).
        while digits.last() == Some(&0) && digits.len() > 1 {
            digits.pop();
        }

        Ok(Self { sign, weight, scale, digits })
    }
}
```

---

## Row Layout

Complete physical row format for a storage engine. Rows are stored in pages (typically 4096 or 8192 bytes).

### On-disk layout

```text
+---------------------------------------------------------------------+
| RowHeader (variable size, ~20+ bytes)                               |
|   row_id:       u64    (8 bytes) — monotonic row identifier         |
|   txn_id:       u64    (8 bytes) — transaction that wrote this row  |
|   flags:        u8     (1 byte)  — bit 0: deleted, bit 1: overflow  |
|   column_count: u16    (2 bytes) — number of columns                |
|   null_bitmap:  [u8; ceil(column_count / 8)]                        |
+---------------------------------------------------------------------+
| Fixed-size columns (packed in schema order, no padding)             |
|   BOOL  → 1 bit (packed 8-per-byte in a separate bool bitmap)      |
|   I8    → 1 byte                                                    |
|   I16   → 2 bytes LE                                                |
|   I32   → 4 bytes LE                                                |
|   I64   → 8 bytes LE                                                |
|   F32   → 4 bytes LE                                                |
|   F64   → 8 bytes LE                                                |
+---------------------------------------------------------------------+
| Variable-size offset table: [u32; var_column_count]                 |
|   Each entry is the byte offset from row start to the variable col  |
+---------------------------------------------------------------------+
| Variable-size columns (length-prefixed)                             |
|   TEXT  → u32 len + UTF-8 bytes                                     |
|   BYTES → u32 len + raw bytes                                       |
|   BMAP  → u32 len + BMAP blob                                       |
|   BARR  → u32 len + BARR blob                                       |
|   DEC   → u16 len + packed decimal bytes                             |
+---------------------------------------------------------------------+
| Overflow pointer (only if flags bit 1 is set)                       |
|   page_id: u32, offset: u16 — continuation page for oversized rows  |
+---------------------------------------------------------------------+
```

### Schema types

```rust
/// Column type identifiers. Matches the disk encoding sizes above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ColumnType {
    Bool = 0,
    I8 = 1,
    I16 = 2,
    I32 = 3,
    I64 = 4,
    F32 = 5,
    F64 = 6,
    Text = 10,
    Bytes = 11,
    BMap = 12,
    BArr = 13,
    Decimal = 14,
}

impl ColumnType {
    /// Returns Some(size) for fixed-size types, None for variable-size.
    pub fn fixed_size(&self) -> Option<usize> {
        match self {
            Self::Bool => Some(0), // bools packed in separate bitmap
            Self::I8 => Some(1),
            Self::I16 => Some(2),
            Self::I32 => Some(4),
            Self::I64 => Some(8),
            Self::F32 => Some(4),
            Self::F64 => Some(8),
            _ => None,
        }
    }

    pub fn is_variable(&self) -> bool {
        self.fixed_size().is_none()
    }
}

#[derive(Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub col_type: ColumnType,
    pub nullable: bool,
}

#[derive(Debug, Clone)]
pub struct RowSchema {
    pub columns: Vec<ColumnDef>,
}

impl RowSchema {
    /// Columns that have fixed-size encoding, in schema order.
    pub fn fixed_columns(&self) -> impl Iterator<Item = (usize, &ColumnDef)> {
        self.columns.iter().enumerate().filter(|(_, c)| !c.col_type.is_variable())
    }

    /// Columns that have variable-size encoding, in schema order.
    pub fn variable_columns(&self) -> impl Iterator<Item = (usize, &ColumnDef)> {
        self.columns.iter().enumerate().filter(|(_, c)| c.col_type.is_variable())
    }

    pub fn null_bitmap_bytes(&self) -> usize {
        (self.columns.len() + 7) / 8
    }

    /// Number of booleans — these get their own packed bitmap.
    pub fn bool_count(&self) -> usize {
        self.columns.iter().filter(|c| c.col_type == ColumnType::Bool).count()
    }

    pub fn bool_bitmap_bytes(&self) -> usize {
        (self.bool_count() + 7) / 8
    }

    pub fn variable_count(&self) -> usize {
        self.columns.iter().filter(|c| c.col_type.is_variable()).count()
    }
}
```

### Row header struct

```rust
#[derive(Debug, Clone, Copy, FromBytes, IntoBytes, KnownLayout, Immutable)]
#[repr(C, packed)]
pub struct RowHeaderFixed {
    pub row_id: u64,
    pub txn_id: u64,
    pub flags: u8,
    pub column_count: u16,
    // null_bitmap follows immediately — variable length, not in this struct
}

impl RowHeaderFixed {
    pub const SIZE: usize = std::mem::size_of::<Self>(); // 19 bytes

    pub fn is_deleted(&self) -> bool {
        self.flags & 0x01 != 0
    }

    pub fn has_overflow(&self) -> bool {
        self.flags & 0x02 != 0
    }
}
```

### RowWriter

```rust
/// Column values to write. Enum mirrors ColumnType.
#[derive(Debug, Clone)]
pub enum ColumnValue {
    Null,
    Bool(bool),
    I8(i8),
    I16(i16),
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
    Text(String),
    Bytes(Vec<u8>),
    BMap(Vec<u8>),   // pre-serialized BMAP blob
    BArr(Vec<u8>),   // pre-serialized BARR blob
    Decimal(PackedDecimal),
}

/// Builds a complete row byte representation from column values.
pub struct RowWriter<'a> {
    schema: &'a RowSchema,
}

impl<'a> RowWriter<'a> {
    pub fn new(schema: &'a RowSchema) -> Self {
        Self { schema }
    }

    /// Serialize a row. Returns the complete row bytes.
    /// `values` must be in schema order, one per column. Use ColumnValue::Null
    /// for null columns.
    pub fn write_row(
        &self,
        row_id: u64,
        txn_id: u64,
        values: &[ColumnValue],
    ) -> Result<Vec<u8>, FormatError> {
        if values.len() != self.schema.columns.len() {
            return Err(FormatError::ColumnCountMismatch {
                expected: self.schema.columns.len(),
                got: values.len(),
            });
        }

        let column_count = self.schema.columns.len();
        let null_bitmap_size = self.schema.null_bitmap_bytes();
        let bool_bitmap_size = self.schema.bool_bitmap_bytes();
        let var_count = self.schema.variable_count();

        // Estimate capacity: header + null bitmap + fixed cols + offset table + variable cols.
        let mut buf = Vec::with_capacity(256);

        // --- Row header ---
        let header = RowHeaderFixed {
            row_id,
            txn_id,
            flags: 0,
            column_count: column_count as u16,
        };
        buf.extend_from_slice(header.as_bytes());

        // --- Null bitmap ---
        let null_bitmap_start = buf.len();
        buf.resize(null_bitmap_start + null_bitmap_size, 0);
        for (i, val) in values.iter().enumerate() {
            if matches!(val, ColumnValue::Null) {
                buf[null_bitmap_start + i / 8] |= 1 << (i % 8);
            }
        }

        // --- Bool bitmap (separate from fixed columns) ---
        let bool_bitmap_start = buf.len();
        buf.resize(bool_bitmap_start + bool_bitmap_size, 0);
        let mut bool_idx = 0;
        for (i, col) in self.schema.columns.iter().enumerate() {
            if col.col_type == ColumnType::Bool {
                if let ColumnValue::Bool(true) = &values[i] {
                    buf[bool_bitmap_start + bool_idx / 8] |= 1 << (bool_idx % 8);
                }
                bool_idx += 1;
            }
        }

        // --- Fixed-size columns (non-bool) ---
        for (i, col) in self.schema.columns.iter().enumerate() {
            if col.col_type == ColumnType::Bool || col.col_type.is_variable() {
                continue;
            }
            match (&values[i], col.col_type) {
                (ColumnValue::Null, _) => {
                    // Write zero bytes as placeholder for null fixed-size columns.
                    let size = col.col_type.fixed_size().unwrap_or(0);
                    buf.extend_from_slice(&vec![0u8; size]);
                }
                (ColumnValue::I8(v), ColumnType::I8) => buf.push(*v as u8),
                (ColumnValue::I16(v), ColumnType::I16) => buf.extend_from_slice(&v.to_le_bytes()),
                (ColumnValue::I32(v), ColumnType::I32) => buf.extend_from_slice(&v.to_le_bytes()),
                (ColumnValue::I64(v), ColumnType::I64) => buf.extend_from_slice(&v.to_le_bytes()),
                (ColumnValue::F32(v), ColumnType::F32) => buf.extend_from_slice(&v.to_le_bytes()),
                (ColumnValue::F64(v), ColumnType::F64) => buf.extend_from_slice(&v.to_le_bytes()),
                _ => return Err(FormatError::TypeMismatch {
                    column: i,
                    expected: col.col_type,
                }),
            }
        }

        // --- Variable-size offset table (placeholder, filled after writing values) ---
        let offset_table_pos = buf.len();
        buf.resize(offset_table_pos + var_count * 4, 0);

        // --- Variable-size columns ---
        let mut var_idx = 0;
        for (i, col) in self.schema.columns.iter().enumerate() {
            if !col.col_type.is_variable() {
                continue;
            }

            // Record offset from row start.
            let offset = buf.len() as u32;
            buf[offset_table_pos + var_idx * 4..offset_table_pos + (var_idx + 1) * 4]
                .copy_from_slice(&offset.to_le_bytes());
            var_idx += 1;

            match &values[i] {
                ColumnValue::Null => {
                    // Null variable columns: write zero-length prefix.
                    buf.extend_from_slice(&0u32.to_le_bytes());
                }
                ColumnValue::Text(s) => {
                    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
                    buf.extend_from_slice(s.as_bytes());
                }
                ColumnValue::Bytes(b) | ColumnValue::BMap(b) | ColumnValue::BArr(b) => {
                    buf.extend_from_slice(&(b.len() as u32).to_le_bytes());
                    buf.extend_from_slice(b);
                }
                ColumnValue::Decimal(d) => {
                    let dec_bytes = d.to_bytes();
                    buf.extend_from_slice(&(dec_bytes.len() as u16).to_le_bytes());
                    buf.extend_from_slice(&dec_bytes);
                }
                _ => return Err(FormatError::TypeMismatch {
                    column: i,
                    expected: col.col_type,
                }),
            }
        }

        Ok(buf)
    }
}
```

### RowReader

```rust
/// Zero-copy row reader. Borrows the underlying page bytes.
pub struct RowReader<'a> {
    data: &'a [u8],
    schema: &'a RowSchema,
    header: RowHeaderFixed,
    null_bitmap_offset: usize,
    bool_bitmap_offset: usize,
    fixed_offset: usize,      // start of fixed-size column data
    offset_table_pos: usize,   // start of variable-size offset table
}

impl<'a> RowReader<'a> {
    pub fn from_bytes(data: &'a [u8], schema: &'a RowSchema) -> Result<Self, FormatError> {
        if data.len() < RowHeaderFixed::SIZE {
            return Err(FormatError::RowTooShort);
        }

        let (header_ref, _) = Ref::<_, RowHeaderFixed>::from_prefix(data)
            .map_err(|_| FormatError::RowTooShort)?;
        let header = *header_ref;

        let null_bitmap_offset = RowHeaderFixed::SIZE;
        let null_bitmap_size = schema.null_bitmap_bytes();
        let bool_bitmap_offset = null_bitmap_offset + null_bitmap_size;
        let bool_bitmap_size = schema.bool_bitmap_bytes();
        let fixed_offset = bool_bitmap_offset + bool_bitmap_size;

        // Compute where fixed columns end and offset table begins.
        let fixed_size: usize = schema.fixed_columns()
            .filter(|(_, c)| c.col_type != ColumnType::Bool)
            .map(|(_, c)| c.col_type.fixed_size().unwrap_or(0))
            .sum();
        let offset_table_pos = fixed_offset + fixed_size;

        Ok(Self {
            data,
            schema,
            header,
            null_bitmap_offset,
            bool_bitmap_offset,
            fixed_offset,
            offset_table_pos,
        })
    }

    pub fn row_id(&self) -> u64 { self.header.row_id }
    pub fn txn_id(&self) -> u64 { self.header.txn_id }
    pub fn is_deleted(&self) -> bool { self.header.is_deleted() }

    /// Check if column `col_idx` is null.
    pub fn is_null(&self, col_idx: usize) -> bool {
        let byte = self.data[self.null_bitmap_offset + col_idx / 8];
        byte & (1 << (col_idx % 8)) != 0
    }

    /// Read a fixed-size column by index. Returns None if null.
    pub fn read_i64(&self, col_idx: usize) -> Result<Option<i64>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        let offset = self.fixed_column_offset(col_idx)?;
        let bytes: [u8; 8] = self.data[offset..offset + 8]
            .try_into()
            .map_err(|_| FormatError::RowTruncated)?;
        Ok(Some(i64::from_le_bytes(bytes)))
    }

    pub fn read_i32(&self, col_idx: usize) -> Result<Option<i32>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        let offset = self.fixed_column_offset(col_idx)?;
        let bytes: [u8; 4] = self.data[offset..offset + 4]
            .try_into()
            .map_err(|_| FormatError::RowTruncated)?;
        Ok(Some(i32::from_le_bytes(bytes)))
    }

    pub fn read_f64(&self, col_idx: usize) -> Result<Option<f64>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        let offset = self.fixed_column_offset(col_idx)?;
        let bytes: [u8; 8] = self.data[offset..offset + 8]
            .try_into()
            .map_err(|_| FormatError::RowTruncated)?;
        Ok(Some(f64::from_le_bytes(bytes)))
    }

    pub fn read_bool(&self, col_idx: usize) -> Result<Option<bool>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        // Find which bool index this column is.
        let bool_idx = self.schema.columns[..col_idx]
            .iter()
            .filter(|c| c.col_type == ColumnType::Bool)
            .count();
        let byte = self.data[self.bool_bitmap_offset + bool_idx / 8];
        Ok(Some(byte & (1 << (bool_idx % 8)) != 0))
    }

    /// Read a variable-size column as a string reference. Zero-copy.
    pub fn read_text(&self, col_idx: usize) -> Result<Option<&'a str>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        let bytes = self.read_variable_bytes(col_idx)?;
        let s = std::str::from_utf8(bytes).map_err(|_| FormatError::InvalidUtf8)?;
        Ok(Some(s))
    }

    /// Read a variable-size column as raw bytes. Zero-copy.
    pub fn read_bytes(&self, col_idx: usize) -> Result<Option<&'a [u8]>, FormatError> {
        if self.is_null(col_idx) {
            return Ok(None);
        }
        Ok(Some(self.read_variable_bytes(col_idx)?))
    }

    /// Read a BMAP column, returning a BMapReader for further access.
    pub fn read_bmap(&self, col_idx: usize) -> Result<Option<BMapReader<'a>>, FormatError> {
        let bytes = match self.read_bytes(col_idx)? {
            Some(b) if !b.is_empty() => b,
            _ => return Ok(None),
        };
        BMapReader::from_bytes(bytes).map(Some)
    }

    // --- internal helpers ---

    /// Compute the byte offset of a fixed-size column within the row.
    fn fixed_column_offset(&self, col_idx: usize) -> Result<usize, FormatError> {
        let mut offset = self.fixed_offset;
        for (i, col) in self.schema.columns.iter().enumerate() {
            if col.col_type == ColumnType::Bool || col.col_type.is_variable() {
                continue;
            }
            if i == col_idx {
                return Ok(offset);
            }
            offset += col.col_type.fixed_size().unwrap_or(0);
        }
        Err(FormatError::ColumnNotFound(col_idx))
    }

    /// Read the offset table entry for a variable column, then read its bytes.
    fn read_variable_bytes(&self, col_idx: usize) -> Result<&'a [u8], FormatError> {
        let var_idx = self.schema.columns[..col_idx]
            .iter()
            .filter(|c| c.col_type.is_variable())
            .count();

        let table_entry_pos = self.offset_table_pos + var_idx * 4;
        let data_offset = u32::from_le_bytes(
            self.data[table_entry_pos..table_entry_pos + 4]
                .try_into()
                .map_err(|_| FormatError::RowTruncated)?
        ) as usize;

        // Read length prefix.
        let len = u32::from_le_bytes(
            self.data[data_offset..data_offset + 4]
                .try_into()
                .map_err(|_| FormatError::RowTruncated)?
        ) as usize;

        Ok(&self.data[data_offset + 4..data_offset + 4 + len])
    }
}
```

### Usage

```rust
let schema = RowSchema {
    columns: vec![
        ColumnDef { name: "id".into(), col_type: ColumnType::I64, nullable: false },
        ColumnDef { name: "age".into(), col_type: ColumnType::I32, nullable: true },
        ColumnDef { name: "active".into(), col_type: ColumnType::Bool, nullable: false },
        ColumnDef { name: "name".into(), col_type: ColumnType::Text, nullable: true },
        ColumnDef { name: "metadata".into(), col_type: ColumnType::BMap, nullable: true },
    ],
};

let writer = RowWriter::new(&schema);
let row_bytes = writer.write_row(1, 100, &[
    ColumnValue::I64(42),
    ColumnValue::I32(30),
    ColumnValue::Bool(true),
    ColumnValue::Text("Alice".into()),
    ColumnValue::Null,
])?;

let reader = RowReader::from_bytes(&row_bytes, &schema)?;
assert_eq!(reader.row_id(), 1);
assert_eq!(reader.read_i64(0)?, Some(42));
assert_eq!(reader.read_i32(1)?, Some(30));
assert_eq!(reader.read_bool(2)?, Some(true));
assert_eq!(reader.read_text(3)?, Some("Alice"));
assert!(reader.is_null(4));
```

---

## byteorder — Explicit Endianness

When you need to read/write multi-byte integers from arbitrary byte streams (network buffers, legacy formats), `byteorder` provides cursor-based convenience.

```toml
[dependencies]
byteorder = "1"
```

### Read patterns

```rust
use byteorder::{LittleEndian, BigEndian, ReadBytesExt};
use std::io::Cursor;

fn parse_legacy_header(data: &[u8]) -> std::io::Result<(u32, u16, u64)> {
    let mut cursor = Cursor::new(data);

    let magic = cursor.read_u32::<LittleEndian>()?;
    let version = cursor.read_u16::<LittleEndian>()?;
    let timestamp = cursor.read_u64::<LittleEndian>()?;

    Ok((magic, version, timestamp))
}

/// Read a big-endian network protocol header.
fn parse_network_header(data: &[u8]) -> std::io::Result<(u16, u32)> {
    let mut cursor = Cursor::new(data);
    let msg_type = cursor.read_u16::<BigEndian>()?;
    let payload_len = cursor.read_u32::<BigEndian>()?;
    Ok((msg_type, payload_len))
}
```

### Write patterns

```rust
use byteorder::{LittleEndian, WriteBytesExt};

fn write_index_entry(writer: &mut Vec<u8>, key_hash: u64, offset: u32, length: u32) -> std::io::Result<()> {
    writer.write_u64::<LittleEndian>(key_hash)?;
    writer.write_u32::<LittleEndian>(offset)?;
    writer.write_u32::<LittleEndian>(length)?;
    Ok(())
}
```

### When to use byteorder vs from_le_bytes

| Scenario | Use |
|---|---|
| Zero-copy struct overlay | `zerocopy` + `repr(C, packed)` — no byteorder needed |
| Sequential cursor reads from mixed-endian data | `byteorder::ReadBytesExt` |
| Single-field conversion where you have the bytes | `u32::from_le_bytes(...)` — stdlib, no dependency |
| Writing to `impl Write` (file, socket, Vec) | `byteorder::WriteBytesExt` |

---

## bytes::Buf / BufMut — Network-Friendly Parsing

The `bytes` crate provides reference-counted byte buffers and traits for zero-copy slicing. Use for network protocols, chunked I/O, and any case where multiple owners need the same buffer.

```toml
[dependencies]
bytes = "1"
```

### Reading with Buf

```rust
use bytes::{Buf, Bytes};

fn parse_message(mut buf: Bytes) -> Result<(u8, u32, Bytes), FormatError> {
    if buf.remaining() < 5 {
        return Err(FormatError::MessageTooShort);
    }

    let msg_type = buf.get_u8();
    let payload_len = buf.get_u32_le();

    if buf.remaining() < payload_len as usize {
        return Err(FormatError::MessageTruncated);
    }

    // .split_to() gives us a Bytes owning the first N bytes — zero-copy,
    // reference-counted. The original `buf` advances past them.
    let payload = buf.split_to(payload_len as usize);

    Ok((msg_type, payload_len, payload))
}
```

### Writing with BufMut

```rust
use bytes::{BufMut, BytesMut};

fn build_response(msg_type: u8, payload: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(5 + payload.len());

    buf.put_u8(msg_type);
    buf.put_u32_le(payload.len() as u32);
    buf.put_slice(payload);

    buf.freeze() // convert to immutable Bytes
}
```

### Bytes vs Vec<u8>

| Feature | `Vec<u8>` | `Bytes` |
|---|---|---|
| Owned, growable | Yes | No (immutable after `freeze`) |
| Reference counted | No | Yes — `clone()` is O(1) |
| Zero-copy slicing | No — slice borrows | Yes — `slice()` returns a new `Bytes` |
| Use in async channels | Must clone or Arc-wrap | Send freely, clone is cheap |
| Mutable building | Direct | Use `BytesMut`, then `.freeze()` |

---

## Error Type

All format parsing functions share one error enum per crate:

```rust
#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("header too short")]
    HeaderTooShort,
    #[error("bad magic bytes")]
    BadMagic,
    #[error("checksum mismatch: expected {expected:#010x}, computed {computed:#010x}")]
    ChecksumMismatch { expected: u32, computed: u32 },
    #[error("index region too short")]
    IndexTooShort,
    #[error("index alignment error")]
    IndexAlignment,

    // BMAP
    #[error("BMAP blob too short")]
    BMapTooShort,
    #[error("BMAP key index truncated")]
    BMapIndexTruncated,
    #[error("BMAP key offset out of bounds")]
    BMapKeyOutOfBounds,
    #[error("BMAP value offset out of bounds")]
    BMapValueOutOfBounds,
    #[error("BMAP root must be an object")]
    BMapRootMustBeObject,
    #[error("unknown value type tag: {0}")]
    UnknownValueType(u8),
    #[error("invalid UTF-8 in key or string value")]
    InvalidUtf8,

    // BARR
    #[error("BARR blob too short")]
    BArrTooShort,
    #[error("BARR is not fixed-size")]
    BArrNotFixedSize,
    #[error("BARR is not variable-size")]
    BArrNotVariableSize,
    #[error("BARR element type mismatch")]
    BArrTypeMismatch,
    #[error("BARR alignment error")]
    BArrAlignment,
    #[error("BARR index out of bounds")]
    BArrIndexOutOfBounds,
    #[error("BARR offset truncated")]
    BArrOffsetTruncated,
    #[error("BARR value truncated")]
    BArrValueTruncated,

    // Decimal
    #[error("packed decimal too short")]
    DecimalTooShort,
    #[error("packed decimal truncated")]
    DecimalTruncated,
    #[error("invalid decimal string")]
    InvalidDecimalString,
    #[error("unsupported number type")]
    UnsupportedNumberType,

    // Row
    #[error("row too short")]
    RowTooShort,
    #[error("row truncated")]
    RowTruncated,
    #[error("column count mismatch: expected {expected}, got {got}")]
    ColumnCountMismatch { expected: usize, got: usize },
    #[error("type mismatch at column {column}: expected {expected:?}")]
    TypeMismatch { column: usize, expected: ColumnType },
    #[error("column {0} not found")]
    ColumnNotFound(usize),
    #[error("message too short")]
    MessageTooShort,
    #[error("message truncated")]
    MessageTruncated,
}
```

---

## Testing Binary Formats

### proptest round-trip

Every format must survive write-then-read with arbitrary valid input:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn bmap_roundtrip(
            keys in prop::collection::vec("[a-z]{1,20}", 0..50),
            values in prop::collection::vec(any::<i64>(), 0..50),
        ) {
            let len = keys.len().min(values.len());
            let mut map = serde_json::Map::new();
            for i in 0..len {
                map.insert(keys[i].clone(), serde_json::Value::from(values[i]));
            }
            let json = serde_json::Value::Object(map.clone());
            let bytes = BMapWriter::from_json(&json).unwrap();
            let reader = BMapReader::from_bytes(&bytes).unwrap();

            for (key, val) in &map {
                let read_val = reader.get(key).unwrap().unwrap();
                match read_val {
                    BMapValue::Int64(v) => assert_eq!(v, val.as_i64().unwrap()),
                    _ => panic!("unexpected value type"),
                }
            }
        }

        #[test]
        fn barr_i64_roundtrip(values in prop::collection::vec(any::<i64>(), 0..1000)) {
            let bytes = BArrWriter::from_i64_slice(&values);
            let reader = BArrReader::from_bytes(&bytes).unwrap();
            assert_eq!(reader.len(), values.len());
            // Fixed-size path: zero-copy slice access.
            let slice = reader.as_i64_slice().unwrap();
            assert_eq!(slice, &values[..]);
        }

        #[test]
        fn barr_strings_roundtrip(
            values in prop::collection::vec("[a-zA-Z0-9 ]{0,100}", 0..200),
        ) {
            let refs: Vec<&str> = values.iter().map(|s| s.as_str()).collect();
            let bytes = BArrWriter::from_strings(&refs);
            let reader = BArrReader::from_bytes(&bytes).unwrap();
            assert_eq!(reader.len(), values.len());
            for (i, expected) in values.iter().enumerate() {
                let actual = reader.get_string(i).unwrap();
                assert_eq!(actual, expected.as_str());
            }
        }

        #[test]
        fn row_roundtrip(
            id in any::<u64>(),
            age in proptest::option::of(any::<i32>()),
            active in any::<bool>(),
            name in proptest::option::of("[a-zA-Z ]{1,50}"),
        ) {
            let schema = RowSchema {
                columns: vec![
                    ColumnDef { name: "id".into(), col_type: ColumnType::I64, nullable: false },
                    ColumnDef { name: "age".into(), col_type: ColumnType::I32, nullable: true },
                    ColumnDef { name: "active".into(), col_type: ColumnType::Bool, nullable: false },
                    ColumnDef { name: "name".into(), col_type: ColumnType::Text, nullable: true },
                ],
            };

            let values = vec![
                ColumnValue::I64(id as i64),
                age.map_or(ColumnValue::Null, ColumnValue::I32),
                ColumnValue::Bool(active),
                name.clone().map_or(ColumnValue::Null, ColumnValue::Text),
            ];

            let writer = RowWriter::new(&schema);
            let bytes = writer.write_row(id, 1, &values).unwrap();
            let reader = RowReader::from_bytes(&bytes, &schema).unwrap();

            assert_eq!(reader.row_id(), id);
            assert_eq!(reader.read_i64(0).unwrap(), Some(id as i64));
            assert_eq!(reader.read_i32(1).unwrap(), age);
            assert_eq!(reader.read_bool(2).unwrap(), Some(active));
            assert_eq!(reader.read_text(3).unwrap(), name.as_deref());
        }

        #[test]
        fn decimal_roundtrip(
            sign in prop::sample::select(vec![-1i8, 0, 1]),
            weight in -10i16..10,
            scale in 0u16..20,
            digits in prop::collection::vec(0u16..10000, 0..10),
        ) {
            let dec = PackedDecimal { sign, weight, scale, digits: digits.clone() };
            let bytes = dec.to_bytes();
            let dec_ref = PackedDecimalRef::from_bytes(&bytes).unwrap();
            assert_eq!(dec_ref.sign, sign);
            assert_eq!(dec_ref.weight, weight);
            assert_eq!(dec_ref.scale, scale);
            assert_eq!(dec_ref.ndigits(), digits.len());
            for (i, &expected) in digits.iter().enumerate() {
                assert_eq!(dec_ref.digit(i), expected);
            }
        }
    }
}
```

### Fuzz testing with arbitrary bytes

Feed random bytes to every `from_bytes` parser. It must return `Err`, never panic or UB:

```rust
#[cfg(test)]
mod fuzz_tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn bmap_no_panic_on_garbage(data in prop::collection::vec(any::<u8>(), 0..4096)) {
            // Must not panic. Ok or Err are both fine.
            let _ = BMapReader::from_bytes(&data);
        }

        #[test]
        fn barr_no_panic_on_garbage(data in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = BArrReader::from_bytes(&data);
        }

        #[test]
        fn segment_header_no_panic_on_garbage(data in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = parse_segment_header(&data);
        }

        #[test]
        fn packed_decimal_no_panic_on_garbage(data in prop::collection::vec(any::<u8>(), 0..256)) {
            let _ = PackedDecimalRef::from_bytes(&data);
        }
    }
}
```

### Edge cases to test explicitly

```rust
#[cfg(test)]
mod edge_tests {
    use super::*;

    #[test]
    fn empty_bmap() {
        let json = serde_json::json!({});
        let bytes = BMapWriter::from_json(&json).unwrap();
        let reader = BMapReader::from_bytes(&bytes).unwrap();
        assert_eq!(reader.get("anything").unwrap(), None);
    }

    #[test]
    fn empty_barr() {
        let bytes = BArrWriter::from_i64_slice(&[]);
        let reader = BArrReader::from_bytes(&bytes).unwrap();
        assert_eq!(reader.len(), 0);
        assert!(reader.is_empty());
    }

    #[test]
    fn bmap_hash_collision() {
        // Unlikely with FNV-1a on short keys, but the reader must handle it.
        // Construct two keys with the same hash to verify collision resolution.
        // In practice, use known-collision pairs for your hash function.
    }

    #[test]
    fn max_size_barr() {
        // Test with 2^16 - 1 elements (near offset table limits).
        let values: Vec<i64> = (0..65535).map(|i| i as i64).collect();
        let bytes = BArrWriter::from_i64_slice(&values);
        let reader = BArrReader::from_bytes(&bytes).unwrap();
        assert_eq!(reader.len(), 65535);
        let slice = reader.as_i64_slice().unwrap();
        assert_eq!(slice[0], 0);
        assert_eq!(slice[65534], 65534);
    }

    #[test]
    fn deeply_nested_bmap() {
        let json = serde_json::json!({
            "a": { "b": { "c": { "d": { "e": 42 } } } }
        });
        let bytes = BMapWriter::from_json(&json).unwrap();
        let reader = BMapReader::from_bytes(&bytes).unwrap();
        let val = reader.get_path(&["a", "b", "c", "d", "e"]).unwrap().unwrap();
        match val {
            BMapValue::Int64(v) => assert_eq!(v, 42),
            _ => panic!("expected Int64"),
        }
    }

    #[test]
    fn row_all_nulls() {
        let schema = RowSchema {
            columns: vec![
                ColumnDef { name: "a".into(), col_type: ColumnType::I64, nullable: true },
                ColumnDef { name: "b".into(), col_type: ColumnType::Text, nullable: true },
            ],
        };
        let writer = RowWriter::new(&schema);
        let bytes = writer.write_row(1, 1, &[ColumnValue::Null, ColumnValue::Null]).unwrap();
        let reader = RowReader::from_bytes(&bytes, &schema).unwrap();
        assert!(reader.is_null(0));
        assert!(reader.is_null(1));
        assert_eq!(reader.read_i64(0).unwrap(), None);
        assert_eq!(reader.read_text(1).unwrap(), None);
    }

    #[test]
    fn decimal_parse_string() {
        let d = PackedDecimal::from_str("123456.78").unwrap();
        assert_eq!(d.sign, 1);
        assert_eq!(d.scale, 2);

        let d = PackedDecimal::from_str("-0.005").unwrap();
        assert_eq!(d.sign, -1);
        assert_eq!(d.scale, 3);

        let d = PackedDecimal::from_str("0").unwrap();
        assert_eq!(d.sign, 0);
        assert!(d.digits.is_empty());
    }
}
```

---

## Never

- **No `unsafe` for parsing.** Use `zerocopy` derive macros. If alignment fails, return `Err`, do not force a raw pointer cast.
- **No big-endian on disk.** All on-disk integers are little-endian. Big-endian only for network protocol compatibility (and use `byteorder::BigEndian` explicitly).
- **No `unwrap()` in format readers.** Every byte access can fail on truncated or corrupted data. Return `FormatError`.
- **No padding between fields in packed structs.** Use `#[repr(C, packed)]`. If alignment is needed for SIMD, add explicit padding fields and document them.
- **No length fields wider than needed.** Key lengths are `u16` (max 64 KiB keys are absurd). Element counts are `u32` unless you prove you need `u64`.
- **No skipping checksum verification on read.** Always verify CRC before trusting any parsed fields. A corrupted header can cause out-of-bounds reads.
- **No `String` or `Vec<u8>` in zero-copy readers.** Reader types borrow `&'a [u8]` or `&'a str` from the backing buffer. Allocation belongs in writers.
