# Type System — Disk Types, Execution Types, Logical Types, Coercion & Arrow Interop

Three-layer type system: **Logical** (SQL-facing) maps to **Disk** (storage-facing)
maps to **Exec** (runtime-facing). Disk types are narrow and compact for I/O. Exec types
are wide and uniform for SIMD and branch-free processing. Logical types carry SQL
semantics, constraints, and dialect-specific names.

---

## Disk Type Enum

13 discriminants. `repr(u8)` for single-byte encoding in page headers and column metadata.

```rust
use std::mem;

/// Physical storage type — one byte on disk, determines encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum DiskType {
    Null  = 0,
    Bool  = 1,
    I8    = 2,
    I16   = 3,
    I32   = 4,
    I64   = 5,
    F32   = 6,
    F64   = 7,
    Dec   = 8,   // fixed-point decimal: 16 bytes (i128 mantissa + u8 scale)
    Text  = 9,   // length-prefixed UTF-8
    Bytes = 10,  // length-prefixed arbitrary bytes
    BMap  = 11,  // binary-encoded map (key-value pairs)
    BArr  = 12,  // binary-encoded array (homogeneous elements)
}

impl DiskType {
    /// Byte width of a single value for fixed-size types.
    /// Variable-length types return `None`.
    #[must_use]
    pub const fn size_of(self) -> Option<usize> {
        match self {
            DiskType::Null  => Some(0),
            DiskType::Bool  => Some(1),
            DiskType::I8    => Some(1),
            DiskType::I16   => Some(2),
            DiskType::I32   => Some(4),
            DiskType::I64   => Some(8),
            DiskType::F32   => Some(4),
            DiskType::F64   => Some(8),
            DiskType::Dec   => Some(17), // 16-byte mantissa + 1-byte scale
            DiskType::Text  => None,
            DiskType::Bytes => None,
            DiskType::BMap  => None,
            DiskType::BArr  => None,
        }
    }

    /// True when every value occupies a fixed number of bytes.
    #[must_use]
    pub const fn is_fixed_size(self) -> bool {
        self.size_of().is_some()
    }

    /// Required alignment in bytes. Variable-length types align to 1.
    #[must_use]
    pub const fn alignment(self) -> usize {
        match self {
            DiskType::Null  => 1,
            DiskType::Bool  => 1,
            DiskType::I8    => 1,
            DiskType::I16   => 2,
            DiskType::I32   => 4,
            DiskType::I64   => 8,
            DiskType::F32   => 4,
            DiskType::F64   => 8,
            DiskType::Dec   => 8, // align mantissa to 8 for fast i128 loads
            DiskType::Text  => 1,
            DiskType::Bytes => 1,
            DiskType::BMap  => 1,
            DiskType::BArr  => 1,
        }
    }

    /// Reconstruct from the on-disk discriminant byte.
    #[must_use]
    pub const fn from_u8(tag: u8) -> Option<DiskType> {
        match tag {
            0  => Some(DiskType::Null),
            1  => Some(DiskType::Bool),
            2  => Some(DiskType::I8),
            3  => Some(DiskType::I16),
            4  => Some(DiskType::I32),
            5  => Some(DiskType::I64),
            6  => Some(DiskType::F32),
            7  => Some(DiskType::F64),
            8  => Some(DiskType::Dec),
            9  => Some(DiskType::Text),
            10 => Some(DiskType::Bytes),
            11 => Some(DiskType::BMap),
            12 => Some(DiskType::BArr),
            _  => None,
        }
    }
}
```

---

## Decimal Representation

Fixed-point decimal stored as a 128-bit mantissa and 8-bit scale.

```rust
/// Owned decimal — stored inline on disk (17 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decimal {
    pub mantissa: i128,
    pub scale: u8,
}

/// Borrowed decimal — zero-copy reference into a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecimalRef<'a> {
    /// 16-byte slice containing the mantissa in little-endian.
    pub mantissa_bytes: &'a [u8; 16],
    pub scale: u8,
}

impl<'a> DecimalRef<'a> {
    #[must_use]
    pub fn mantissa(&self) -> i128 {
        i128::from_le_bytes(*self.mantissa_bytes)
    }

    #[must_use]
    pub fn to_owned(&self) -> Decimal {
        Decimal {
            mantissa: self.mantissa(),
            scale: self.scale,
        }
    }
}
```

---

## Execution Type Enum

8 variants — one per type class. All narrow integer types widen to `I64`, all narrow
floats widen to `F64`. This gives exactly one code path per type class in the execution
engine, enabling SIMD-friendly columnar processing.

```rust
/// Binary map reference — zero-copy into a page.
#[derive(Debug, Clone, Copy)]
pub struct BMapRef<'a> {
    pub data: &'a [u8],
}

/// Binary array reference — zero-copy into a page.
#[derive(Debug, Clone, Copy)]
pub struct BArrRef<'a> {
    pub data: &'a [u8],
}

/// Runtime value — wide types for execution.
///
/// Widening rules:
///   I8  → I64
///   I16 → I64
///   I32 → I64
///   F32 → F64
///
/// One code path per type class. No I8/I16/I32/F32 variants here.
#[derive(Debug, Clone)]
pub enum ExecValue<'a> {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Dec(DecimalRef<'a>),
    Str(&'a str),
    Bytes(&'a [u8]),
    BMap(BMapRef<'a>),
    BArr(BArrRef<'a>),
}

impl<'a> ExecValue<'a> {
    /// True when the value is `Null`.
    #[must_use]
    pub const fn is_null(&self) -> bool {
        matches!(self, ExecValue::Null)
    }

    /// Return the `DiskType` this value would serialize to.
    /// Narrow types are already widened, so I64 could have originated
    /// from I8/I16/I32 — the caller must know the target DiskType.
    #[must_use]
    pub fn exec_type_tag(&self) -> DiskType {
        match self {
            ExecValue::Null      => DiskType::Null,
            ExecValue::Bool(_)   => DiskType::Bool,
            ExecValue::I64(_)    => DiskType::I64,
            ExecValue::F64(_)    => DiskType::F64,
            ExecValue::Dec(_)    => DiskType::Dec,
            ExecValue::Str(_)    => DiskType::Text,
            ExecValue::Bytes(_)  => DiskType::Bytes,
            ExecValue::BMap(_)   => DiskType::BMap,
            ExecValue::BArr(_)   => DiskType::BArr,
        }
    }
}
```

### Widening: Disk → Exec

```rust
use std::io::{self, Read as IoRead};

/// Read a fixed-size disk value and widen it to an ExecValue.
///
/// This is the hot path for scanning columns. Every narrow integer
/// becomes I64, every narrow float becomes F64 — one branch per
/// type class, no per-row type dispatch.
pub fn widen_from_bytes<'a>(
    disk_type: DiskType,
    buf: &'a [u8],
) -> Result<ExecValue<'a>, TypeError> {
    match disk_type {
        DiskType::Null => Ok(ExecValue::Null),
        DiskType::Bool => {
            let b = *buf.first().ok_or(TypeError::BufferTooShort)?;
            Ok(ExecValue::Bool(b != 0))
        }

        // --- Integer widening: all narrow → I64 ---
        DiskType::I8 => {
            let v = i8::from_le_bytes(
                buf.get(..1)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::I64(v as i64))
        }
        DiskType::I16 => {
            let v = i16::from_le_bytes(
                buf.get(..2)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::I64(v as i64))
        }
        DiskType::I32 => {
            let v = i32::from_le_bytes(
                buf.get(..4)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::I64(v as i64))
        }
        DiskType::I64 => {
            let v = i64::from_le_bytes(
                buf.get(..8)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::I64(v))
        }

        // --- Float widening: F32 → F64 ---
        DiskType::F32 => {
            let v = f32::from_le_bytes(
                buf.get(..4)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::F64(v as f64))
        }
        DiskType::F64 => {
            let v = f64::from_le_bytes(
                buf.get(..8)
                    .ok_or(TypeError::BufferTooShort)?
                    .try_into()
                    .unwrap(),
            );
            Ok(ExecValue::F64(v))
        }

        // --- Decimal: 16-byte mantissa + 1-byte scale ---
        DiskType::Dec => {
            let bytes = buf
                .get(..17)
                .ok_or(TypeError::BufferTooShort)?;
            let mantissa_bytes: &[u8; 16] = bytes[..16].try_into().unwrap();
            let scale = bytes[16];
            Ok(ExecValue::Dec(DecimalRef { mantissa_bytes, scale }))
        }

        // Variable-length types: caller passes the already-extracted payload.
        DiskType::Text => {
            let s = std::str::from_utf8(buf).map_err(|_| TypeError::InvalidUtf8)?;
            Ok(ExecValue::Str(s))
        }
        DiskType::Bytes => Ok(ExecValue::Bytes(buf)),
        DiskType::BMap  => Ok(ExecValue::BMap(BMapRef { data: buf })),
        DiskType::BArr  => Ok(ExecValue::BArr(BArrRef { data: buf })),
    }
}
```

### Narrowing: Exec → Disk

```rust
/// Narrow an ExecValue back to a fixed-size disk encoding.
/// Returns the number of bytes written. Variable-length types
/// write a length prefix followed by the payload.
pub fn narrow_to_bytes(
    value: &ExecValue<'_>,
    target: DiskType,
    out: &mut Vec<u8>,
) -> Result<usize, TypeError> {
    match (value, target) {
        (ExecValue::Null, DiskType::Null) => Ok(0),
        (ExecValue::Bool(b), DiskType::Bool) => {
            out.push(if *b { 1 } else { 0 });
            Ok(1)
        }

        // --- I64 → narrow integer: range-checked ---
        (ExecValue::I64(v), DiskType::I8) => {
            let n = i8::try_from(*v).map_err(|_| TypeError::OutOfRange {
                value: *v,
                target,
            })?;
            out.extend_from_slice(&n.to_le_bytes());
            Ok(1)
        }
        (ExecValue::I64(v), DiskType::I16) => {
            let n = i16::try_from(*v).map_err(|_| TypeError::OutOfRange {
                value: *v,
                target,
            })?;
            out.extend_from_slice(&n.to_le_bytes());
            Ok(2)
        }
        (ExecValue::I64(v), DiskType::I32) => {
            let n = i32::try_from(*v).map_err(|_| TypeError::OutOfRange {
                value: *v,
                target,
            })?;
            out.extend_from_slice(&n.to_le_bytes());
            Ok(4)
        }
        (ExecValue::I64(v), DiskType::I64) => {
            out.extend_from_slice(&v.to_le_bytes());
            Ok(8)
        }

        // --- F64 → narrow float: precision loss check ---
        (ExecValue::F64(v), DiskType::F32) => {
            let narrow = *v as f32;
            if (narrow as f64 - v).abs() > f64::EPSILON * v.abs().max(1.0) {
                return Err(TypeError::PrecisionLoss { value: *v });
            }
            out.extend_from_slice(&narrow.to_le_bytes());
            Ok(4)
        }
        (ExecValue::F64(v), DiskType::F64) => {
            out.extend_from_slice(&v.to_le_bytes());
            Ok(8)
        }

        // --- Decimal ---
        (ExecValue::Dec(d), DiskType::Dec) => {
            out.extend_from_slice(d.mantissa_bytes);
            out.push(d.scale);
            Ok(17)
        }

        // --- Variable-length: write payload (caller handles length prefix) ---
        (ExecValue::Str(s), DiskType::Text) => {
            out.extend_from_slice(s.as_bytes());
            Ok(s.len())
        }
        (ExecValue::Bytes(b), DiskType::Bytes) => {
            out.extend_from_slice(b);
            Ok(b.len())
        }
        (ExecValue::BMap(m), DiskType::BMap) => {
            out.extend_from_slice(m.data);
            Ok(m.data.len())
        }
        (ExecValue::BArr(a), DiskType::BArr) => {
            out.extend_from_slice(a.data);
            Ok(a.data.len())
        }

        _ => Err(TypeError::IncompatibleTypes {
            from: value.exec_type_tag(),
            to: target,
        }),
    }
}
```

---

## Logical Type Catalog

SQL-level types that map down to `DiskType` and up to `ExecValue`.

```rust
/// Element type within a vector column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorElement {
    F32,
    F64,
    I8,
}

/// SQL-facing type — carries constraints, precision, dialect semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogicalType {
    // --- Integer family ---
    TinyInt,            // disk: I8,  exec: I64
    SmallInt,           // disk: I16, exec: I64
    Int,                // disk: I32, exec: I64
    BigInt,             // disk: I64, exec: I64
    TinyIntUnsigned,    // disk: I8,  exec: I64  (constraint: >= 0)
    SmallIntUnsigned,   // disk: I16, exec: I64  (constraint: >= 0)
    IntUnsigned,        // disk: I32, exec: I64  (constraint: >= 0)
    BigIntUnsigned,     // disk: I64, exec: I64  (constraint: >= 0)

    // --- Float family ---
    Float,              // disk: F32, exec: F64
    Double,             // disk: F64, exec: F64

    // --- Decimal ---
    Decimal {
        precision: u8,  // total digits, max 38
        scale: u8,      // digits after decimal point
    },

    // --- Boolean ---
    Boolean,            // disk: Bool, exec: Bool

    // --- String family ---
    Char(u32),          // disk: Text, exec: &str  (fixed-width, space-padded)
    Varchar(u32),       // disk: Text, exec: &str  (max-length check)
    Text,               // disk: Text, exec: &str  (unbounded)

    // --- Binary family ---
    Binary(u32),        // disk: Bytes, exec: &[u8] (fixed-width)
    Varbinary(u32),     // disk: Bytes, exec: &[u8] (max-length check)
    Blob,               // disk: Bytes, exec: &[u8] (unbounded)

    // --- Structured ---
    Json,               // disk: Text,  exec: &str  (validated JSON)
    Jsonb,              // disk: Bytes, exec: &[u8] (binary JSON)

    // --- Specialized ---
    Vector {
        dimensions: u32,
        element_type: VectorElement,
    },
    Embedding {
        dimensions: u32,
        model: String,
    },

    // --- Geo ---
    Point,              // disk: Bytes (16 bytes: f64 lat + f64 lon)
    LineString,         // disk: Bytes
    Polygon,            // disk: Bytes

    // --- Temporal ---
    Date,               // disk: I32 (days since epoch)
    Time,               // disk: I64 (microseconds since midnight)
    Timestamp,          // disk: I64 (microseconds since epoch)
    TimestampTz,        // disk: I64 (microseconds since epoch, always UTC)
    Interval,           // disk: Bytes (months: i32, days: i32, micros: i64)

    // --- Other ---
    Uuid,               // disk: Bytes (16 bytes)
    Code,               // disk: Text, exec: &str (source code with language tag)
}
```

### Logical Type → Disk Type

```rust
impl LogicalType {
    /// Map a logical type to its physical storage encoding.
    #[must_use]
    pub fn disk_type(&self) -> DiskType {
        match self {
            // Integer family
            LogicalType::TinyInt | LogicalType::TinyIntUnsigned     => DiskType::I8,
            LogicalType::SmallInt | LogicalType::SmallIntUnsigned    => DiskType::I16,
            LogicalType::Int | LogicalType::IntUnsigned              => DiskType::I32,
            LogicalType::BigInt | LogicalType::BigIntUnsigned        => DiskType::I64,

            // Float family
            LogicalType::Float  => DiskType::F32,
            LogicalType::Double => DiskType::F64,

            // Decimal
            LogicalType::Decimal { .. } => DiskType::Dec,

            // Boolean
            LogicalType::Boolean => DiskType::Bool,

            // String family — all stored as length-prefixed UTF-8
            LogicalType::Char(_)
            | LogicalType::Varchar(_)
            | LogicalType::Text
            | LogicalType::Json
            | LogicalType::Code => DiskType::Text,

            // Binary family
            LogicalType::Binary(_)
            | LogicalType::Varbinary(_)
            | LogicalType::Blob
            | LogicalType::Jsonb
            | LogicalType::Point
            | LogicalType::LineString
            | LogicalType::Polygon
            | LogicalType::Uuid
            | LogicalType::Interval => DiskType::Bytes,

            // Temporal (integer-encoded)
            LogicalType::Date                       => DiskType::I32,
            LogicalType::Time
            | LogicalType::Timestamp
            | LogicalType::TimestampTz              => DiskType::I64,

            // Vectors and embeddings — stored as binary arrays
            LogicalType::Vector { .. }
            | LogicalType::Embedding { .. }         => DiskType::BArr,
        }
    }
}
```

### Logical Type → Exec Type Class

```rust
/// Which `ExecValue` variant a logical type produces at runtime.
/// Used for operator resolution and function dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTypeClass {
    Null,
    Bool,
    I64,
    F64,
    Dec,
    Str,
    Bytes,
    BMap,
    BArr,
}

impl LogicalType {
    /// The execution-engine type class after widening.
    #[must_use]
    pub fn exec_class(&self) -> ExecTypeClass {
        match self {
            LogicalType::TinyInt
            | LogicalType::SmallInt
            | LogicalType::Int
            | LogicalType::BigInt
            | LogicalType::TinyIntUnsigned
            | LogicalType::SmallIntUnsigned
            | LogicalType::IntUnsigned
            | LogicalType::BigIntUnsigned
            | LogicalType::Date
            | LogicalType::Time
            | LogicalType::Timestamp
            | LogicalType::TimestampTz => ExecTypeClass::I64,

            LogicalType::Float | LogicalType::Double => ExecTypeClass::F64,

            LogicalType::Decimal { .. } => ExecTypeClass::Dec,

            LogicalType::Boolean => ExecTypeClass::Bool,

            LogicalType::Char(_)
            | LogicalType::Varchar(_)
            | LogicalType::Text
            | LogicalType::Json
            | LogicalType::Code => ExecTypeClass::Str,

            LogicalType::Binary(_)
            | LogicalType::Varbinary(_)
            | LogicalType::Blob
            | LogicalType::Jsonb
            | LogicalType::Point
            | LogicalType::LineString
            | LogicalType::Polygon
            | LogicalType::Uuid
            | LogicalType::Interval => ExecTypeClass::Bytes,

            LogicalType::Vector { .. }
            | LogicalType::Embedding { .. } => ExecTypeClass::BArr,
        }
    }
}
```

---

## Type Coercion Rules

### Coercion Matrix

| From \ To | Bool | I64 | F64 | Dec | Str | Bytes |
|---|---|---|---|---|---|---|
| **Bool** | -- | implicit | no | no | explicit | no |
| **I64** | explicit | -- | implicit | implicit | explicit | no |
| **F64** | no | explicit* | -- | explicit* | explicit | no |
| **Dec** | no | explicit* | implicit | -- | explicit | no |
| **Str** | explicit | explicit | explicit | explicit | -- | explicit |
| **Bytes** | no | no | no | no | explicit | -- |

- `implicit` = engine applies automatically during expression evaluation.
- `explicit` = requires a `CAST(x AS type)` in SQL.
- `explicit*` = range-checked or precision-checked, returns error on overflow.
- `no` = not supported, always an error.

### Widening rules within the integer family

Narrow-to-wide integer is always implicit and lossless:

| From Disk | To Exec | Widening |
|---|---|---|
| I8 | I64 | `value as i64` — lossless, sign-extends |
| I16 | I64 | `value as i64` — lossless, sign-extends |
| I32 | I64 | `value as i64` — lossless, sign-extends |
| I64 | I64 | identity |
| F32 | F64 | `value as f64` — lossless |
| F64 | F64 | identity |

### Error Types

```rust
/// Errors returned by type coercion and narrowing.
#[derive(Debug, Clone, thiserror::Error)]
pub enum TypeError {
    #[error("buffer too short for {0:?}")]
    BufferTooShort,

    #[error("invalid UTF-8 in text column")]
    InvalidUtf8,

    #[error("value {value} out of range for {target:?}")]
    OutOfRange { value: i64, target: DiskType },

    #[error("precision loss converting {value} to F32")]
    PrecisionLoss { value: f64 },

    #[error("cannot coerce {from:?} to {to:?}")]
    IncompatibleTypes { from: DiskType, to: DiskType },

    #[error("cannot parse '{text}' as {target:?}")]
    ParseFailed { text: String, target: DiskType },

    #[error("varchar({max}) exceeded: got {actual} bytes")]
    LengthExceeded { max: u32, actual: usize },

    #[error("unsigned type cannot hold negative value {value}")]
    NegativeUnsigned { value: i64 },

    #[error("decimal precision {precision} exceeds maximum 38")]
    DecimalPrecisionExceeded { precision: u8 },
}
```

### Coercion Function

```rust
/// Coerce an execution value to a different type.
///
/// Implicit coercions (called by the expression evaluator):
///   Bool → I64, any int → F64, any int → Dec, F64 → Dec (checked).
///
/// Explicit coercions (called via SQL CAST):
///   Str → numeric (parse), numeric → Str (format), wide → narrow (range-checked).
pub fn coerce<'a>(
    from: &ExecValue<'a>,
    to_class: ExecTypeClass,
) -> Result<ExecValue<'static>, TypeError> {
    // Identity — no coercion needed.
    if from.exec_type_tag() == DiskType::Null {
        return Ok(ExecValue::Null);
    }

    match (from, to_class) {
        // --- Bool → I64 ---
        (ExecValue::Bool(b), ExecTypeClass::I64) => {
            Ok(ExecValue::I64(if *b { 1 } else { 0 }))
        }

        // --- I64 → Bool (explicit: 0 = false, nonzero = true) ---
        (ExecValue::I64(v), ExecTypeClass::Bool) => {
            Ok(ExecValue::Bool(*v != 0))
        }

        // --- I64 → F64 (implicit) ---
        (ExecValue::I64(v), ExecTypeClass::F64) => {
            Ok(ExecValue::F64(*v as f64))
        }

        // --- F64 → I64 (explicit, truncates toward zero, range-checked) ---
        (ExecValue::F64(v), ExecTypeClass::I64) => {
            if v.is_nan() || *v > i64::MAX as f64 || *v < i64::MIN as f64 {
                return Err(TypeError::OutOfRange {
                    value: *v as i64,
                    target: DiskType::I64,
                });
            }
            Ok(ExecValue::I64(*v as i64))
        }

        // --- I64 → Dec (implicit) ---
        (ExecValue::I64(v), ExecTypeClass::Dec) => {
            let mantissa = *v as i128;
            let owned_bytes = mantissa.to_le_bytes();
            // Return an owned decimal as a static ExecValue.
            // In practice, the arena allocator would hold the bytes.
            Ok(ExecValue::I64(*v)) // Placeholder: real impl uses arena-backed DecimalRef
        }

        // --- Str → I64 (explicit, parse) ---
        (ExecValue::Str(s), ExecTypeClass::I64) => {
            let v: i64 = s.parse().map_err(|_| TypeError::ParseFailed {
                text: s.to_string(),
                target: DiskType::I64,
            })?;
            Ok(ExecValue::I64(v))
        }

        // --- Str → F64 (explicit, parse) ---
        (ExecValue::Str(s), ExecTypeClass::F64) => {
            let v: f64 = s.parse().map_err(|_| TypeError::ParseFailed {
                text: s.to_string(),
                target: DiskType::F64,
            })?;
            Ok(ExecValue::F64(v))
        }

        // --- Str → Bool (explicit: "true"/"1" → true, "false"/"0" → false) ---
        (ExecValue::Str(s), ExecTypeClass::Bool) => {
            match s.to_ascii_lowercase().as_str() {
                "true" | "1" | "t" | "yes" => Ok(ExecValue::Bool(true)),
                "false" | "0" | "f" | "no" => Ok(ExecValue::Bool(false)),
                _ => Err(TypeError::ParseFailed {
                    text: s.to_string(),
                    target: DiskType::Bool,
                }),
            }
        }

        _ => Err(TypeError::IncompatibleTypes {
            from: from.exec_type_tag(),
            to: match to_class {
                ExecTypeClass::Null  => DiskType::Null,
                ExecTypeClass::Bool  => DiskType::Bool,
                ExecTypeClass::I64   => DiskType::I64,
                ExecTypeClass::F64   => DiskType::F64,
                ExecTypeClass::Dec   => DiskType::Dec,
                ExecTypeClass::Str   => DiskType::Text,
                ExecTypeClass::Bytes => DiskType::Bytes,
                ExecTypeClass::BMap  => DiskType::BMap,
                ExecTypeClass::BArr  => DiskType::BArr,
            },
        }),
    }
}
```

### Logical Type Constraint Validation

```rust
impl LogicalType {
    /// Validate that an execution value satisfies this logical type's constraints.
    /// Called on INSERT and UPDATE before narrowing to disk format.
    pub fn validate(&self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match (self, value) {
            // Unsigned integer constraints
            (LogicalType::TinyIntUnsigned, ExecValue::I64(v)) if *v < 0 => {
                Err(TypeError::NegativeUnsigned { value: *v })
            }
            (LogicalType::SmallIntUnsigned, ExecValue::I64(v)) if *v < 0 => {
                Err(TypeError::NegativeUnsigned { value: *v })
            }
            (LogicalType::IntUnsigned, ExecValue::I64(v)) if *v < 0 => {
                Err(TypeError::NegativeUnsigned { value: *v })
            }
            (LogicalType::BigIntUnsigned, ExecValue::I64(v)) if *v < 0 => {
                Err(TypeError::NegativeUnsigned { value: *v })
            }

            // Varchar max-length constraint
            (LogicalType::Varchar(max), ExecValue::Str(s)) if s.len() > *max as usize => {
                Err(TypeError::LengthExceeded {
                    max: *max,
                    actual: s.len(),
                })
            }

            // Char fixed-length: value is padded/truncated at storage layer,
            // but reject if input exceeds max.
            (LogicalType::Char(max), ExecValue::Str(s)) if s.len() > *max as usize => {
                Err(TypeError::LengthExceeded {
                    max: *max,
                    actual: s.len(),
                })
            }

            // Binary max-length constraint
            (LogicalType::Binary(max), ExecValue::Bytes(b)) if b.len() > *max as usize => {
                Err(TypeError::LengthExceeded {
                    max: *max,
                    actual: b.len(),
                })
            }
            (LogicalType::Varbinary(max), ExecValue::Bytes(b)) if b.len() > *max as usize => {
                Err(TypeError::LengthExceeded {
                    max: *max,
                    actual: b.len(),
                })
            }

            // Decimal precision constraint
            (LogicalType::Decimal { precision, .. }, _) if *precision > 38 => {
                Err(TypeError::DecimalPrecisionExceeded {
                    precision: *precision,
                })
            }

            _ => Ok(()),
        }
    }
}
```

---

## Wire Dialect Mapping

Same logical type, different SQL text per dialect.

```rust
/// Supported SQL wire dialects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Postgres,
    MySQL,
    SQLite,
}

/// Return the dialect-specific SQL type name for a logical type.
/// Used when generating DDL, EXPLAIN output, and pgwire column descriptions.
#[must_use]
pub fn wire_type_name(logical: &LogicalType, dialect: SqlDialect) -> String {
    use LogicalType::*;
    use SqlDialect::*;

    match (logical, dialect) {
        // --- Integer family ---
        (TinyInt, Postgres)             => "SMALLINT".to_owned(),   // PG has no TINYINT
        (TinyInt, MySQL)                => "TINYINT".to_owned(),
        (TinyInt, SQLite)               => "INTEGER".to_owned(),

        (SmallInt, Postgres | MySQL)    => "SMALLINT".to_owned(),
        (SmallInt, SQLite)              => "INTEGER".to_owned(),

        (Int, Postgres)                 => "INTEGER".to_owned(),
        (Int, MySQL)                    => "INT".to_owned(),
        (Int, SQLite)                   => "INTEGER".to_owned(),

        (BigInt, Postgres | MySQL)      => "BIGINT".to_owned(),
        (BigInt, SQLite)                => "INTEGER".to_owned(),

        (TinyIntUnsigned, Postgres)     => "SMALLINT".to_owned(),
        (TinyIntUnsigned, MySQL)        => "TINYINT UNSIGNED".to_owned(),
        (TinyIntUnsigned, SQLite)       => "INTEGER".to_owned(),

        (SmallIntUnsigned, Postgres)    => "INTEGER".to_owned(),
        (SmallIntUnsigned, MySQL)       => "SMALLINT UNSIGNED".to_owned(),
        (SmallIntUnsigned, SQLite)      => "INTEGER".to_owned(),

        (IntUnsigned, Postgres)         => "BIGINT".to_owned(),
        (IntUnsigned, MySQL)            => "INT UNSIGNED".to_owned(),
        (IntUnsigned, SQLite)           => "INTEGER".to_owned(),

        (BigIntUnsigned, Postgres)      => "NUMERIC(20,0)".to_owned(),
        (BigIntUnsigned, MySQL)         => "BIGINT UNSIGNED".to_owned(),
        (BigIntUnsigned, SQLite)        => "INTEGER".to_owned(),

        // --- Float family ---
        (Float, Postgres)               => "REAL".to_owned(),
        (Float, MySQL)                  => "FLOAT".to_owned(),
        (Float, SQLite)                 => "REAL".to_owned(),

        (Double, Postgres)              => "DOUBLE PRECISION".to_owned(),
        (Double, MySQL)                 => "DOUBLE".to_owned(),
        (Double, SQLite)                => "REAL".to_owned(),

        // --- Decimal ---
        (Decimal { precision, scale }, _) => {
            format!("DECIMAL({precision},{scale})")
        }

        // --- Boolean ---
        (Boolean, Postgres)             => "BOOLEAN".to_owned(),
        (Boolean, MySQL)                => "TINYINT(1)".to_owned(),
        (Boolean, SQLite)               => "INTEGER".to_owned(),

        // --- String family ---
        (Char(n), _)                    => format!("CHAR({n})"),
        (Varchar(n), _)                 => format!("VARCHAR({n})"),

        (Text, Postgres)                => "TEXT".to_owned(),
        (Text, MySQL)                   => "LONGTEXT".to_owned(),
        (Text, SQLite)                  => "TEXT".to_owned(),

        // --- Binary family ---
        (Binary(n), Postgres)           => format!("BYTEA"),  // PG ignores fixed-width binary
        (Binary(n), MySQL)              => format!("BINARY({n})"),
        (Binary(_), SQLite)             => "BLOB".to_owned(),

        (Varbinary(n), Postgres)        => "BYTEA".to_owned(),
        (Varbinary(n), MySQL)           => format!("VARBINARY({n})"),
        (Varbinary(_), SQLite)          => "BLOB".to_owned(),

        (Blob, Postgres)                => "BYTEA".to_owned(),
        (Blob, MySQL)                   => "LONGBLOB".to_owned(),
        (Blob, SQLite)                  => "BLOB".to_owned(),

        // --- JSON ---
        (Json, Postgres)                => "JSON".to_owned(),
        (Json, MySQL)                   => "JSON".to_owned(),
        (Json, SQLite)                  => "TEXT".to_owned(),

        (Jsonb, Postgres)               => "JSONB".to_owned(),
        (Jsonb, MySQL)                  => "JSON".to_owned(),   // MySQL has no JSONB
        (Jsonb, SQLite)                 => "TEXT".to_owned(),

        // --- Temporal ---
        (Date, _)                       => "DATE".to_owned(),

        (Time, Postgres)                => "TIME".to_owned(),
        (Time, MySQL)                   => "TIME".to_owned(),
        (Time, SQLite)                  => "TEXT".to_owned(),

        (Timestamp, Postgres)           => "TIMESTAMP".to_owned(),
        (Timestamp, MySQL)              => "DATETIME".to_owned(),
        (Timestamp, SQLite)             => "TEXT".to_owned(),

        (TimestampTz, Postgres)         => "TIMESTAMPTZ".to_owned(),
        (TimestampTz, MySQL)            => "DATETIME".to_owned(),  // MySQL stores UTC implicitly
        (TimestampTz, SQLite)           => "TEXT".to_owned(),

        (Interval, Postgres)            => "INTERVAL".to_owned(),
        (Interval, MySQL)               => "VARCHAR(64)".to_owned(), // MySQL has no INTERVAL type
        (Interval, SQLite)              => "TEXT".to_owned(),

        // --- UUID ---
        (Uuid, Postgres)                => "UUID".to_owned(),
        (Uuid, MySQL)                   => "BINARY(16)".to_owned(),
        (Uuid, SQLite)                  => "BLOB".to_owned(),

        // --- Geo ---
        (Point, Postgres)               => "POINT".to_owned(),
        (Point, MySQL)                  => "POINT".to_owned(),
        (Point, SQLite)                 => "BLOB".to_owned(),

        (LineString, Postgres)          => "GEOMETRY(LineString)".to_owned(),
        (LineString, MySQL)             => "LINESTRING".to_owned(),
        (LineString, SQLite)            => "BLOB".to_owned(),

        (Polygon, Postgres)             => "GEOMETRY(Polygon)".to_owned(),
        (Polygon, MySQL)                => "POLYGON".to_owned(),
        (Polygon, SQLite)               => "BLOB".to_owned(),

        // --- Specialized ---
        (Vector { dimensions, element_type }, Postgres) => {
            let elem = match element_type {
                VectorElement::F32 => "float4",
                VectorElement::F64 => "float8",
                VectorElement::I8  => "int1",
            };
            format!("vector({dimensions})")  // pgvector extension
        }
        (Vector { dimensions, .. }, MySQL) => {
            format!("BLOB")  // MySQL: store as binary
        }
        (Vector { .. }, SQLite) => "BLOB".to_owned(),

        (Embedding { dimensions, .. }, d) => {
            // Embeddings use the same wire type as vectors.
            wire_type_name(
                &LogicalType::Vector {
                    dimensions: *dimensions,
                    element_type: VectorElement::F32,
                },
                d,
            )
        }

        (Code, _) => "TEXT".to_owned(),
    }
}
```

---

## Arrow Interop

### Logical Type → Arrow DataType

```rust
use arrow::datatypes::DataType;

/// Convert a logical type to the corresponding Arrow DataType.
/// Used when building RecordBatch schemas for DataFusion table providers.
#[must_use]
pub fn to_arrow_type(logical: &LogicalType) -> DataType {
    match logical {
        LogicalType::TinyInt              => DataType::Int8,
        LogicalType::SmallInt             => DataType::Int16,
        LogicalType::Int                  => DataType::Int32,
        LogicalType::BigInt               => DataType::Int64,
        LogicalType::TinyIntUnsigned      => DataType::UInt8,
        LogicalType::SmallIntUnsigned     => DataType::UInt16,
        LogicalType::IntUnsigned          => DataType::UInt32,
        LogicalType::BigIntUnsigned       => DataType::UInt64,

        LogicalType::Float                => DataType::Float32,
        LogicalType::Double               => DataType::Float64,

        LogicalType::Decimal { precision, scale } => {
            DataType::Decimal128(*precision, *scale as i8)
        }

        LogicalType::Boolean              => DataType::Boolean,

        LogicalType::Char(_)
        | LogicalType::Varchar(_)
        | LogicalType::Text
        | LogicalType::Json
        | LogicalType::Code               => DataType::Utf8,

        LogicalType::Binary(_)
        | LogicalType::Varbinary(_)
        | LogicalType::Blob
        | LogicalType::Jsonb              => DataType::Binary,

        LogicalType::Date                 => DataType::Date32,
        LogicalType::Time                 => DataType::Time64(arrow::datatypes::TimeUnit::Microsecond),
        LogicalType::Timestamp            => DataType::Timestamp(
            arrow::datatypes::TimeUnit::Microsecond,
            None,
        ),
        LogicalType::TimestampTz          => DataType::Timestamp(
            arrow::datatypes::TimeUnit::Microsecond,
            Some("UTC".into()),
        ),
        LogicalType::Interval             => DataType::Interval(
            arrow::datatypes::IntervalUnit::MonthDayNano,
        ),

        LogicalType::Uuid                 => DataType::FixedSizeBinary(16),

        LogicalType::Point                => DataType::FixedSizeBinary(16),
        LogicalType::LineString           => DataType::Binary,
        LogicalType::Polygon              => DataType::Binary,

        LogicalType::Vector { dimensions, element_type } => {
            let inner = match element_type {
                VectorElement::F32 => DataType::Float32,
                VectorElement::F64 => DataType::Float64,
                VectorElement::I8  => DataType::Int8,
            };
            DataType::FixedSizeList(
                Arc::new(arrow::datatypes::Field::new("element", inner, false)),
                *dimensions as i32,
            )
        }
        LogicalType::Embedding { dimensions, .. } => {
            DataType::FixedSizeList(
                Arc::new(arrow::datatypes::Field::new("element", DataType::Float32, false)),
                *dimensions as i32,
            )
        }
    }
}
```

### Arrow DataType → Logical Type

```rust
/// Convert an Arrow DataType back to a logical type.
/// Used when importing external Arrow data (Parquet files, IPC streams).
#[must_use]
pub fn from_arrow_type(dt: &DataType) -> Option<LogicalType> {
    match dt {
        DataType::Boolean         => Some(LogicalType::Boolean),
        DataType::Int8            => Some(LogicalType::TinyInt),
        DataType::Int16           => Some(LogicalType::SmallInt),
        DataType::Int32           => Some(LogicalType::Int),
        DataType::Int64           => Some(LogicalType::BigInt),
        DataType::UInt8           => Some(LogicalType::TinyIntUnsigned),
        DataType::UInt16          => Some(LogicalType::SmallIntUnsigned),
        DataType::UInt32          => Some(LogicalType::IntUnsigned),
        DataType::UInt64          => Some(LogicalType::BigIntUnsigned),
        DataType::Float32         => Some(LogicalType::Float),
        DataType::Float64         => Some(LogicalType::Double),
        DataType::Decimal128(p, s) => Some(LogicalType::Decimal {
            precision: *p,
            scale: *s as u8,
        }),
        DataType::Utf8 | DataType::LargeUtf8 => Some(LogicalType::Text),
        DataType::Binary | DataType::LargeBinary => Some(LogicalType::Blob),
        DataType::Date32          => Some(LogicalType::Date),
        DataType::Time64(_)       => Some(LogicalType::Time),
        DataType::Timestamp(_, None)       => Some(LogicalType::Timestamp),
        DataType::Timestamp(_, Some(_))    => Some(LogicalType::TimestampTz),
        DataType::FixedSizeBinary(16)      => Some(LogicalType::Uuid),
        DataType::FixedSizeList(field, n) => {
            match field.data_type() {
                DataType::Float32 => Some(LogicalType::Vector {
                    dimensions: *n as u32,
                    element_type: VectorElement::F32,
                }),
                DataType::Float64 => Some(LogicalType::Vector {
                    dimensions: *n as u32,
                    element_type: VectorElement::F64,
                }),
                DataType::Int8 => Some(LogicalType::Vector {
                    dimensions: *n as u32,
                    element_type: VectorElement::I8,
                }),
                _ => None,
            }
        }
        _ => None,
    }
}
```

### ExecValue → Arrow ArrayBuilder

```rust
use arrow::array::{
    ArrayBuilder, BooleanBuilder, Int64Builder, Float64Builder,
    StringBuilder, BinaryBuilder, Decimal128Builder,
};

/// Trait for appending ExecValues to the correct Arrow builder.
pub trait AppendExecValue {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError>;
}

impl AppendExecValue for BooleanBuilder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::Bool(b) => { self.append_value(*b); Ok(()) }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::Bool,
            }),
        }
    }
}

impl AppendExecValue for Int64Builder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::I64(v) => { self.append_value(*v); Ok(()) }
            ExecValue::Bool(b) => { self.append_value(if *b { 1 } else { 0 }); Ok(()) }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::I64,
            }),
        }
    }
}

impl AppendExecValue for Float64Builder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::F64(v) => { self.append_value(*v); Ok(()) }
            ExecValue::I64(v) => { self.append_value(*v as f64); Ok(()) }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::F64,
            }),
        }
    }
}

impl AppendExecValue for StringBuilder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::Str(s) => { self.append_value(s); Ok(()) }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::Text,
            }),
        }
    }
}

impl AppendExecValue for BinaryBuilder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::Bytes(b) => { self.append_value(b); Ok(()) }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::Bytes,
            }),
        }
    }
}

impl AppendExecValue for Decimal128Builder {
    fn append_exec(&mut self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        match value {
            ExecValue::Null => { self.append_null(); Ok(()) }
            ExecValue::Dec(d) => {
                self.append_value(d.mantissa());
                Ok(())
            }
            _ => Err(TypeError::IncompatibleTypes {
                from: value.exec_type_tag(),
                to: DiskType::Dec,
            }),
        }
    }
}

/// Build an Arrow array from a column of ExecValues.
/// `logical` determines which builder to use.
pub fn exec_values_to_arrow(
    logical: &LogicalType,
    values: &[ExecValue<'_>],
) -> Result<Arc<dyn arrow::array::Array>, TypeError> {
    use arrow::array::Array;
    let len = values.len();

    match logical.exec_class() {
        ExecTypeClass::Bool => {
            let mut builder = BooleanBuilder::with_capacity(len);
            for v in values { builder.append_exec(v)?; }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::I64 => {
            let mut builder = Int64Builder::with_capacity(len);
            for v in values { builder.append_exec(v)?; }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::F64 => {
            let mut builder = Float64Builder::with_capacity(len);
            for v in values { builder.append_exec(v)?; }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::Dec => {
            let (precision, scale) = match logical {
                LogicalType::Decimal { precision, scale } => (*precision, *scale),
                _ => (38, 0),
            };
            let mut builder = Decimal128Builder::with_capacity(len)
                .with_data_type(DataType::Decimal128(precision, scale as i8));
            for v in values { builder.append_exec(v)?; }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::Str => {
            let mut builder = StringBuilder::with_capacity(len, len * 32);
            for v in values { builder.append_exec(v)?; }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::Bytes | ExecTypeClass::BMap | ExecTypeClass::BArr => {
            let mut builder = BinaryBuilder::with_capacity(len, len * 64);
            for v in values {
                match v {
                    ExecValue::Null => builder.append_null(),
                    ExecValue::Bytes(b) => builder.append_value(b),
                    ExecValue::BMap(m) => builder.append_value(m.data),
                    ExecValue::BArr(a) => builder.append_value(a.data),
                    _ => return Err(TypeError::IncompatibleTypes {
                        from: v.exec_type_tag(),
                        to: DiskType::Bytes,
                    }),
                }
            }
            Ok(Arc::new(builder.finish()))
        }
        ExecTypeClass::Null => {
            let builder = arrow::array::NullArray::new(len);
            Ok(Arc::new(builder))
        }
    }
}
```

---

## Column Schema

Tie the type system together at the table definition level.

```rust
/// Column-level constraint.
#[derive(Debug, Clone, PartialEq)]
pub enum Constraint {
    NotNull,
    Unique,
    PrimaryKey,
    ForeignKey {
        table: String,
        column: String,
    },
    Check(String),           // SQL expression as string
    DefaultValue(String),    // SQL literal as string
}

/// A single column in a table definition.
#[derive(Debug, Clone)]
pub struct ColumnDef {
    /// Column name — lowercase, no quoting.
    pub name: String,
    /// SQL-level type with constraints (varchar length, decimal precision, etc.).
    pub logical_type: LogicalType,
    /// Whether the column accepts NULL values.
    pub nullable: bool,
    /// Static default value (evaluated once at DDL time, not per-row).
    pub default: Option<ExecValue<'static>>,
    /// Additional constraints (unique, foreign key, check expressions).
    pub constraints: Vec<Constraint>,
}

impl ColumnDef {
    /// The physical disk encoding for this column.
    #[must_use]
    pub fn disk_type(&self) -> DiskType {
        self.logical_type.disk_type()
    }

    /// The Arrow DataType for this column.
    #[must_use]
    pub fn arrow_type(&self) -> DataType {
        to_arrow_type(&self.logical_type)
    }

    /// Build an Arrow Field from this column definition.
    #[must_use]
    pub fn to_arrow_field(&self) -> arrow::datatypes::Field {
        arrow::datatypes::Field::new(
            &self.name,
            self.arrow_type(),
            self.nullable,
        )
    }

    /// Validate a value against this column's type and constraints.
    pub fn validate_value(&self, value: &ExecValue<'_>) -> Result<(), TypeError> {
        if value.is_null() {
            if !self.nullable {
                return Err(TypeError::IncompatibleTypes {
                    from: DiskType::Null,
                    to: self.disk_type(),
                });
            }
            return Ok(());
        }
        self.logical_type.validate(value)
    }
}

/// Full table schema — ordered list of columns.
#[derive(Debug, Clone)]
pub struct TableSchema {
    pub columns: Vec<ColumnDef>,
}

impl TableSchema {
    /// Convert to an Arrow Schema.
    #[must_use]
    pub fn to_arrow_schema(&self) -> arrow::datatypes::Schema {
        let fields: Vec<arrow::datatypes::Field> = self
            .columns
            .iter()
            .map(|col| col.to_arrow_field())
            .collect();
        arrow::datatypes::Schema::new(fields)
    }

    /// Look up a column by name (case-insensitive).
    #[must_use]
    pub fn column_by_name(&self, name: &str) -> Option<&ColumnDef> {
        let lower = name.to_ascii_lowercase();
        self.columns.iter().find(|c| c.name == lower)
    }
}
```

---

## Testing

### Property-Based: Type Coercion Round-Trips

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // ---- proptest: integer widening round-trip ----
    proptest! {
        #[test]
        fn i8_round_trip(v in i8::MIN..=i8::MAX) {
            let wide = widen_from_bytes(DiskType::I8, &v.to_le_bytes()).unwrap();
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::I8, &mut buf).unwrap();
            let recovered = i8::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }

        #[test]
        fn i16_round_trip(v in i16::MIN..=i16::MAX) {
            let wide = widen_from_bytes(DiskType::I16, &v.to_le_bytes()).unwrap();
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::I16, &mut buf).unwrap();
            let recovered = i16::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }

        #[test]
        fn i32_round_trip(v in i32::MIN..=i32::MAX) {
            let wide = widen_from_bytes(DiskType::I32, &v.to_le_bytes()).unwrap();
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::I32, &mut buf).unwrap();
            let recovered = i32::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }

        #[test]
        fn i64_round_trip(v in i64::MIN..=i64::MAX) {
            let wide = widen_from_bytes(DiskType::I64, &v.to_le_bytes()).unwrap();
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::I64, &mut buf).unwrap();
            let recovered = i64::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }

        #[test]
        fn f32_round_trip(v in proptest::num::f32::NORMAL) {
            let wide = widen_from_bytes(DiskType::F32, &v.to_le_bytes()).unwrap();
            // F32 widens to F64, narrowing back checks for precision loss.
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::F32, &mut buf).unwrap();
            let recovered = f32::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }

        #[test]
        fn f64_round_trip(v in proptest::num::f64::NORMAL) {
            let wide = widen_from_bytes(DiskType::F64, &v.to_le_bytes()).unwrap();
            let mut buf = Vec::new();
            narrow_to_bytes(&wide, DiskType::F64, &mut buf).unwrap();
            let recovered = f64::from_le_bytes(buf.try_into().unwrap());
            prop_assert_eq!(v, recovered);
        }
    }

    // ---- proptest: narrowing rejects out-of-range ----
    proptest! {
        #[test]
        fn i64_to_i8_rejects_overflow(v in (i8::MAX as i64 + 1)..=i64::MAX) {
            let exec = ExecValue::I64(v);
            let mut buf = Vec::new();
            prop_assert!(narrow_to_bytes(&exec, DiskType::I8, &mut buf).is_err());
        }

        #[test]
        fn i64_to_i16_rejects_overflow(v in (i16::MAX as i64 + 1)..=i64::MAX) {
            let exec = ExecValue::I64(v);
            let mut buf = Vec::new();
            prop_assert!(narrow_to_bytes(&exec, DiskType::I16, &mut buf).is_err());
        }
    }

    // ---- Exhaustive dialect mapping ----
    #[test]
    fn all_logical_types_have_dialect_mappings() {
        let types = vec![
            LogicalType::TinyInt,
            LogicalType::SmallInt,
            LogicalType::Int,
            LogicalType::BigInt,
            LogicalType::TinyIntUnsigned,
            LogicalType::SmallIntUnsigned,
            LogicalType::IntUnsigned,
            LogicalType::BigIntUnsigned,
            LogicalType::Float,
            LogicalType::Double,
            LogicalType::Decimal { precision: 10, scale: 2 },
            LogicalType::Boolean,
            LogicalType::Char(10),
            LogicalType::Varchar(255),
            LogicalType::Text,
            LogicalType::Binary(16),
            LogicalType::Varbinary(256),
            LogicalType::Blob,
            LogicalType::Json,
            LogicalType::Jsonb,
            LogicalType::Date,
            LogicalType::Time,
            LogicalType::Timestamp,
            LogicalType::TimestampTz,
            LogicalType::Interval,
            LogicalType::Uuid,
            LogicalType::Point,
            LogicalType::LineString,
            LogicalType::Polygon,
            LogicalType::Vector { dimensions: 128, element_type: VectorElement::F32 },
            LogicalType::Embedding { dimensions: 768, model: "test".to_owned() },
            LogicalType::Code,
        ];

        let dialects = [SqlDialect::Postgres, SqlDialect::MySQL, SqlDialect::SQLite];

        for lt in &types {
            for dialect in &dialects {
                let name = wire_type_name(lt, *dialect);
                assert!(!name.is_empty(), "empty wire name for {lt:?} / {dialect:?}");
            }
        }
    }

    // ---- Arrow round-trip ----
    #[test]
    fn arrow_type_round_trip() {
        let cases = vec![
            LogicalType::TinyInt,
            LogicalType::SmallInt,
            LogicalType::Int,
            LogicalType::BigInt,
            LogicalType::Float,
            LogicalType::Double,
            LogicalType::Boolean,
            LogicalType::Text,
            LogicalType::Blob,
            LogicalType::Date,
            LogicalType::Timestamp,
            LogicalType::Decimal { precision: 18, scale: 4 },
        ];

        for lt in &cases {
            let arrow = to_arrow_type(lt);
            let back = from_arrow_type(&arrow);
            assert!(
                back.is_some(),
                "no round-trip for {lt:?} (Arrow type: {arrow:?})"
            );
            // Note: round-trip is lossy for Varchar→Text, Char→Text, etc.
            // Only test types that survive exactly.
            assert_eq!(
                to_arrow_type(back.as_ref().unwrap()),
                arrow,
                "Arrow type mismatch for {lt:?}"
            );
        }
    }

    // ---- Bool coercion ----
    #[test]
    fn bool_to_i64_coercion() {
        let t = coerce(&ExecValue::Bool(true), ExecTypeClass::I64).unwrap();
        assert!(matches!(t, ExecValue::I64(1)));

        let f = coerce(&ExecValue::Bool(false), ExecTypeClass::I64).unwrap();
        assert!(matches!(f, ExecValue::I64(0)));
    }

    // ---- String parse coercion ----
    #[test]
    fn str_to_i64_coercion() {
        let v = coerce(&ExecValue::Str("42"), ExecTypeClass::I64).unwrap();
        assert!(matches!(v, ExecValue::I64(42)));

        let err = coerce(&ExecValue::Str("not_a_number"), ExecTypeClass::I64);
        assert!(err.is_err());
    }

    // ---- Varchar length validation ----
    #[test]
    fn varchar_rejects_overlength() {
        let lt = LogicalType::Varchar(5);
        let short = ExecValue::Str("hello");
        assert!(lt.validate(&short).is_ok());

        let long = ExecValue::Str("hello!");
        assert!(lt.validate(&long).is_err());
    }

    // ---- Unsigned rejects negative ----
    #[test]
    fn unsigned_rejects_negative() {
        let lt = LogicalType::TinyIntUnsigned;
        let neg = ExecValue::I64(-1);
        assert!(lt.validate(&neg).is_err());

        let pos = ExecValue::I64(42);
        assert!(lt.validate(&pos).is_ok());
    }

    // ---- DiskType properties ----
    #[test]
    fn disk_type_size_of() {
        assert_eq!(DiskType::Null.size_of(), Some(0));
        assert_eq!(DiskType::Bool.size_of(), Some(1));
        assert_eq!(DiskType::I8.size_of(), Some(1));
        assert_eq!(DiskType::I16.size_of(), Some(2));
        assert_eq!(DiskType::I32.size_of(), Some(4));
        assert_eq!(DiskType::I64.size_of(), Some(8));
        assert_eq!(DiskType::F32.size_of(), Some(4));
        assert_eq!(DiskType::F64.size_of(), Some(8));
        assert_eq!(DiskType::Dec.size_of(), Some(17));
        assert_eq!(DiskType::Text.size_of(), None);
        assert_eq!(DiskType::Bytes.size_of(), None);
        assert_eq!(DiskType::BMap.size_of(), None);
        assert_eq!(DiskType::BArr.size_of(), None);
    }

    #[test]
    fn disk_type_from_u8_round_trip() {
        for tag in 0..=12u8 {
            let dt = DiskType::from_u8(tag).unwrap();
            assert_eq!(dt as u8, tag);
        }
        assert!(DiskType::from_u8(13).is_none());
        assert!(DiskType::from_u8(255).is_none());
    }

    // ---- Column schema integration ----
    #[test]
    fn column_def_arrow_field() {
        let col = ColumnDef {
            name: "age".to_owned(),
            logical_type: LogicalType::Int,
            nullable: false,
            default: Some(ExecValue::I64(0)),
            constraints: vec![Constraint::NotNull],
        };

        let field = col.to_arrow_field();
        assert_eq!(field.name(), "age");
        assert_eq!(*field.data_type(), DataType::Int32);
        assert!(!field.is_nullable());
    }

    #[test]
    fn table_schema_to_arrow() {
        let schema = TableSchema {
            columns: vec![
                ColumnDef {
                    name: "id".to_owned(),
                    logical_type: LogicalType::BigInt,
                    nullable: false,
                    default: None,
                    constraints: vec![Constraint::PrimaryKey],
                },
                ColumnDef {
                    name: "name".to_owned(),
                    logical_type: LogicalType::Varchar(255),
                    nullable: true,
                    default: None,
                    constraints: vec![],
                },
                ColumnDef {
                    name: "balance".to_owned(),
                    logical_type: LogicalType::Decimal { precision: 18, scale: 4 },
                    nullable: false,
                    default: None,
                    constraints: vec![],
                },
            ],
        };

        let arrow_schema = schema.to_arrow_schema();
        assert_eq!(arrow_schema.fields().len(), 3);
        assert_eq!(*arrow_schema.field(0).data_type(), DataType::Int64);
        assert_eq!(*arrow_schema.field(1).data_type(), DataType::Utf8);
        assert_eq!(
            *arrow_schema.field(2).data_type(),
            DataType::Decimal128(18, 4)
        );
    }
}
```
