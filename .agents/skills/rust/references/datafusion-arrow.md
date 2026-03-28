# DataFusion & Arrow Integration

## What

Apache DataFusion is a vectorized SQL query engine built on Apache Arrow columnar arrays. We use it as the **embedded SQL execution layer** inside a custom database engine — not as a standalone query tool. DataFusion handles parsing, planning, optimizing, and executing SQL. We provide the storage via custom `TableProvider` implementations and extend the engine with custom functions, optimizer rules, and transaction semantics.

Key abstractions:

| Abstraction | Role |
|---|---|
| `SessionContext` | Entry point — registers tables, UDFs, executes SQL |
| `SessionState` | Immutable snapshot of config, catalog, optimizer rules |
| `TableProvider` | Bridge between DataFusion and custom storage |
| `ExecutionPlan` | Physical operator tree — produces `RecordBatch` streams |
| `PhysicalExpr` | Evaluates expressions against `RecordBatch` columns |
| `LogicalPlan` | Parsed + optimized SQL before physical planning |
| `RecordBatch` | Arrow columnar data — the unit of vectorized execution |

Key crates:

```toml
[dependencies]
datafusion = "46"
datafusion-common = "46"
datafusion-expr = "46"
datafusion-physical-expr = "46"
datafusion-physical-plan = "46"
arrow = "55"
arrow-array = "55"
arrow-schema = "55"
arrow-cast = "55"
arrow-buffer = "55"
```

## Custom TableProvider

The `TableProvider` trait bridges DataFusion to the storage engine. Each table in the catalog is a `TableProvider`. The critical method is `scan()`, which returns an `ExecutionPlan` that reads from storage.

```rust
use std::any::Any;
use std::sync::Arc;

use arrow_schema::{DataType, Field, Schema, SchemaRef};
use async_trait::async_trait;
use datafusion::catalog::TableProvider;
use datafusion::datasource::TableType;
use datafusion::error::Result as DfResult;
use datafusion::execution::context::SessionState;
use datafusion::logical_expr::TableProviderFilterPushDown;
use datafusion::physical_plan::ExecutionPlan;
use datafusion_expr::Expr;

use crate::storage::{StorageEngine, TableHandle};

/// Bridges a single table in the storage engine to DataFusion's catalog.
///
/// One instance per table. Registered on SessionContext via `register_table`.
/// The storage engine owns the data; this provider translates DataFusion
/// scan requests into storage-layer reads.
pub struct StorageTableProvider {
    /// Handle to the underlying storage table (segments, indices, WAL).
    table: Arc<TableHandle>,
    /// Arrow schema derived from the storage engine's type system.
    schema: SchemaRef,
    /// Reference to the storage engine for segment access.
    engine: Arc<StorageEngine>,
}

impl StorageTableProvider {
    pub fn new(
        table: Arc<TableHandle>,
        schema: SchemaRef,
        engine: Arc<StorageEngine>,
    ) -> Self {
        Self { table, schema, engine }
    }

    /// Convert storage column types to Arrow DataTypes.
    /// Called once at table registration time.
    pub fn arrow_schema_from_storage(table: &TableHandle) -> SchemaRef {
        let fields: Vec<Field> = table
            .columns()
            .iter()
            .map(|col| {
                let dt = match col.storage_type {
                    // Narrow on disk, wide in execution — I64/F64 for SIMD.
                    StorageType::UInt8 | StorageType::UInt16
                    | StorageType::UInt32 | StorageType::Int8
                    | StorageType::Int16 | StorageType::Int32
                    | StorageType::Int64 => DataType::Int64,
                    StorageType::Float32 | StorageType::Float64 => DataType::Float64,
                    StorageType::Boolean => DataType::Boolean,
                    StorageType::String => DataType::Utf8,
                    StorageType::Binary => DataType::Binary,
                    StorageType::Timestamp => DataType::Timestamp(
                        arrow_schema::TimeUnit::Microsecond,
                        Some("UTC".into()),
                    ),
                };
                Field::new(&col.name, dt, col.nullable)
            })
            .collect();
        Arc::new(Schema::new(fields))
    }
}

#[async_trait]
impl TableProvider for StorageTableProvider {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        Arc::clone(&self.schema)
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    /// Evaluate which filters can be pushed into the storage layer.
    /// Returns one entry per filter expression.
    fn supports_filters_pushdown(
        &self,
        filters: &[&Expr],
    ) -> DfResult<Vec<TableProviderFilterPushDown>> {
        let pushdown = filters
            .iter()
            .map(|expr| {
                if self.table.can_pushdown(expr) {
                    TableProviderFilterPushDown::Exact
                } else {
                    TableProviderFilterPushDown::Unsupported
                }
            })
            .collect();
        Ok(pushdown)
    }

    /// Called by the physical planner to produce a scan operator.
    ///
    /// - `projection`: column indices to read (None = all columns).
    /// - `filters`: predicates that passed `supports_filters_pushdown`.
    /// - `limit`: row limit pushed down from LIMIT clause.
    async fn scan(
        &self,
        state: &SessionState,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        let projected_schema = match projection {
            Some(indices) => Arc::new(self.schema.project(indices)?),
            None => Arc::clone(&self.schema),
        };

        let plan = StorageScanExec::new(
            Arc::clone(&self.engine),
            Arc::clone(&self.table),
            projected_schema,
            projection.cloned(),
            filters.to_vec(),
            limit,
            state.config().batch_size(),
        );
        Ok(Arc::new(plan))
    }
}
```

### Registering the table on SessionContext

```rust
use datafusion::execution::context::SessionContext;

pub async fn register_tables(
    ctx: &SessionContext,
    engine: &Arc<StorageEngine>,
) -> DfResult<()> {
    for table_handle in engine.list_tables() {
        let schema = StorageTableProvider::arrow_schema_from_storage(&table_handle);
        let provider = StorageTableProvider::new(
            Arc::new(table_handle.clone()),
            schema,
            Arc::clone(engine),
        );
        ctx.register_table(
            table_handle.name(),
            Arc::new(provider),
        )?;
    }
    Ok(())
}
```

## Custom ExecutionPlan

The `ExecutionPlan` is the physical operator that produces `RecordBatch` streams. It reads from mmap'd segments, applies pushed-down predicates, and projects only requested columns.

```rust
use std::any::Any;
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use datafusion::error::Result as DfResult;
use datafusion::execution::SendableRecordBatchStream;
use datafusion::physical_expr::EquivalenceProperties;
use datafusion::physical_plan::{
    DisplayAs, DisplayFormatType, ExecutionMode, ExecutionPlan,
    Partitioning, PlanProperties,
};
use datafusion_expr::Expr;
use futures::Stream;

use crate::storage::{SegmentReader, StorageEngine, TableHandle};

/// Physical scan operator that reads from the storage engine.
///
/// One instance per scan node in the physical plan tree.
/// Partition-aware: each storage segment maps to one partition.
#[derive(Debug)]
pub struct StorageScanExec {
    engine: Arc<StorageEngine>,
    table: Arc<TableHandle>,
    projected_schema: SchemaRef,
    projection: Option<Vec<usize>>,
    filters: Vec<Expr>,
    limit: Option<usize>,
    batch_size: usize,
    properties: PlanProperties,
}

impl StorageScanExec {
    pub fn new(
        engine: Arc<StorageEngine>,
        table: Arc<TableHandle>,
        projected_schema: SchemaRef,
        projection: Option<Vec<usize>>,
        filters: Vec<Expr>,
        limit: Option<usize>,
        batch_size: usize,
    ) -> Self {
        let num_partitions = table.segment_count();
        let properties = PlanProperties::new(
            EquivalenceProperties::new(Arc::clone(&projected_schema)),
            Partitioning::UnknownPartitioning(num_partitions),
            ExecutionMode::Bounded,
        );
        Self {
            engine,
            table,
            projected_schema,
            projection,
            filters,
            limit,
            batch_size,
            properties,
        }
    }
}

impl DisplayAs for StorageScanExec {
    fn fmt_as(&self, t: DisplayFormatType, f: &mut fmt::Formatter) -> fmt::Result {
        match t {
            DisplayFormatType::Default | DisplayFormatType::Verbose => {
                write!(
                    f,
                    "StorageScanExec: table={}, projection={:?}, filters={}, limit={:?}",
                    self.table.name(),
                    self.projection,
                    self.filters.len(),
                    self.limit,
                )
            }
        }
    }
}

impl ExecutionPlan for StorageScanExec {
    fn name(&self) -> &str {
        "StorageScanExec"
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn properties(&self) -> &PlanProperties {
        &self.properties
    }

    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> {
        // Leaf node — no children.
        vec![]
    }

    fn with_new_children(
        self: Arc<Self>,
        _children: Vec<Arc<dyn ExecutionPlan>>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        // Leaf node — return self unchanged.
        Ok(self)
    }

    /// Execute one partition. Each partition corresponds to one storage segment.
    fn execute(
        &self,
        partition: usize,
        _context: Arc<datafusion::execution::TaskContext>,
    ) -> DfResult<SendableRecordBatchStream> {
        let reader = self.engine.open_segment_reader(
            &self.table,
            partition,
            self.projection.as_deref(),
            &self.filters,
            self.limit,
        )?;

        Ok(Box::pin(StorageBatchStream {
            reader,
            schema: Arc::clone(&self.projected_schema),
            batch_size: self.batch_size,
            rows_emitted: 0,
            limit: self.limit,
        }))
    }
}

/// Streaming adapter from storage segment reads to Arrow RecordBatch.
pub struct StorageBatchStream {
    reader: SegmentReader,
    schema: SchemaRef,
    batch_size: usize,
    rows_emitted: usize,
    limit: Option<usize>,
}

impl Stream for StorageBatchStream {
    type Item = DfResult<RecordBatch>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        // Respect LIMIT pushdown.
        if let Some(limit) = self.limit {
            if self.rows_emitted >= limit {
                return Poll::Ready(None);
            }
        }

        let remaining = self
            .limit
            .map(|l| l - self.rows_emitted)
            .unwrap_or(self.batch_size);
        let read_size = remaining.min(self.batch_size);

        match self.reader.next_batch(read_size) {
            Ok(Some(batch)) => {
                self.rows_emitted += batch.num_rows();
                Poll::Ready(Some(Ok(batch)))
            }
            Ok(None) => Poll::Ready(None),
            Err(e) => Poll::Ready(Some(Err(e.into()))),
        }
    }
}

impl datafusion::physical_plan::RecordBatchStream for StorageBatchStream {
    fn schema(&self) -> SchemaRef {
        Arc::clone(&self.schema)
    }
}
```

## Arrow RecordBatch Construction

Building `RecordBatch` from storage engine rows. Three patterns: builder (general), zero-copy from mmap (fast path for strings/binary), and batch-from-columns.

### ArrayBuilder pattern

```rust
use arrow_array::{
    ArrayRef, BooleanArray, Float64Array, Int64Array, RecordBatch,
    StringArray, TimestampMicrosecondArray,
};
use arrow_array::builder::{
    BooleanBuilder, Float64Builder, Int64Builder, StringBuilder,
    TimestampMicrosecondBuilder,
};
use arrow_schema::{Field, Schema, SchemaRef};
use std::sync::Arc;

/// Build a RecordBatch from raw storage rows using typed builders.
///
/// Builders handle null bitmaps automatically via `append_null()`.
/// Call `finish()` to produce the final Arrow array.
pub fn build_batch_from_rows(
    schema: &SchemaRef,
    rows: &[StorageRow],
) -> Result<RecordBatch, ArrowError> {
    let num_rows = rows.len();

    // One builder per column. Pre-allocate capacity.
    let mut id_builder = Int64Builder::with_capacity(num_rows);
    let mut name_builder = StringBuilder::with_capacity(num_rows, num_rows * 32);
    let mut score_builder = Float64Builder::with_capacity(num_rows);
    let mut active_builder = BooleanBuilder::with_capacity(num_rows);
    let mut ts_builder = TimestampMicrosecondBuilder::with_capacity(num_rows);

    for row in rows {
        // Append value or null. Never skip rows — nulls maintain alignment.
        match row.id {
            Some(v) => id_builder.append_value(v),
            None => id_builder.append_null(),
        }
        match &row.name {
            Some(v) => name_builder.append_value(v),
            None => name_builder.append_null(),
        }
        match row.score {
            Some(v) => score_builder.append_value(v),
            None => score_builder.append_null(),
        }
        match row.active {
            Some(v) => active_builder.append_value(v),
            None => active_builder.append_null(),
        }
        match row.created_at {
            Some(v) => ts_builder.append_value(v),
            None => ts_builder.append_null(),
        }
    }

    let columns: Vec<ArrayRef> = vec![
        Arc::new(id_builder.finish()),
        Arc::new(name_builder.finish()),
        Arc::new(score_builder.finish()),
        Arc::new(active_builder.finish()),
        Arc::new(ts_builder.finish().with_timezone("UTC")),
    ];

    RecordBatch::try_new(Arc::clone(schema), columns)
}
```

### Zero-copy from mmap

For string and binary data stored contiguously in mmap'd segments, avoid copying into builders. Construct Arrow arrays directly from the raw byte buffers.

```rust
use arrow_array::StringArray;
use arrow_buffer::{Buffer, OffsetBuffer, NullBuffer, BooleanBuffer};

/// Construct a StringArray directly from mmap'd segment data.
///
/// The segment stores strings as:
///   - offsets: &[i32] — byte offset of each string start
///   - data: &[u8] — contiguous UTF-8 string bytes
///   - null_bitmap: &[u8] — one bit per row, 1 = valid, 0 = null
///
/// SAFETY: The mmap'd region must remain valid for the lifetime of the
/// returned array. The caller ensures the segment is pinned.
pub unsafe fn string_array_from_mmap(
    offsets_bytes: &[u8],
    data_bytes: &[u8],
    null_bitmap_bytes: &[u8],
    num_rows: usize,
) -> StringArray {
    // SAFETY: offsets_bytes is aligned to i32 and contains num_rows + 1 entries.
    let offsets_slice: &[i32] = std::slice::from_raw_parts(
        offsets_bytes.as_ptr() as *const i32,
        num_rows + 1,
    );

    // Wrap raw bytes as Arrow buffers — no copy.
    let offsets = OffsetBuffer::new_unchecked(
        Buffer::from_slice_ref(offsets_slice).into(),
    );
    let values = Buffer::from_slice_ref(data_bytes);
    let null_buffer = NullBuffer::new(
        BooleanBuffer::new(Buffer::from_slice_ref(null_bitmap_bytes), 0, num_rows),
    );

    // SAFETY: offsets are valid UTF-8 boundaries, null bitmap length matches num_rows.
    StringArray::new(offsets, values, Some(null_buffer))
}
```

### Batch-from-columns (typed arrays directly)

When the storage engine already provides columnar data (e.g., column-oriented segments):

```rust
use arrow_array::{ArrayRef, Float64Array, Int64Array, RecordBatch};
use arrow_schema::SchemaRef;
use std::sync::Arc;

/// Build a RecordBatch from pre-extracted columnar data.
/// Each column is already a contiguous typed slice from the storage engine.
pub fn batch_from_columnar(
    schema: &SchemaRef,
    int_col: &[i64],
    float_col: &[f64],
    null_mask_int: Option<&[bool]>,
    null_mask_float: Option<&[bool]>,
) -> Result<RecordBatch, ArrowError> {
    let int_array: ArrayRef = match null_mask_int {
        Some(mask) => {
            // Pair each value with its null flag.
            let values: Vec<Option<i64>> = int_col
                .iter()
                .zip(mask.iter())
                .map(|(&v, &valid)| if valid { Some(v) } else { None })
                .collect();
            Arc::new(Int64Array::from(values))
        }
        None => Arc::new(Int64Array::from_iter_values(int_col.iter().copied())),
    };

    let float_array: ArrayRef = match null_mask_float {
        Some(mask) => {
            let values: Vec<Option<f64>> = float_col
                .iter()
                .zip(mask.iter())
                .map(|(&v, &valid)| if valid { Some(v) } else { None })
                .collect();
            Arc::new(Float64Array::from(values))
        }
        None => Arc::new(Float64Array::from_iter_values(float_col.iter().copied())),
    };

    RecordBatch::try_new(Arc::clone(schema), vec![int_array, float_array])
}
```

## Custom Scalar Functions (UDFs)

Register domain-specific scalar functions on `SessionContext`. Each UDF defines its signature, return type, and evaluation logic.

### VECTOR_DISTANCE — cosine similarity between two vector columns

```rust
use arrow_array::{ArrayRef, Float64Array, ListArray, cast::AsArray};
use datafusion::error::Result as DfResult;
use datafusion::logical_expr::{
    ColumnarValue, ScalarFunctionImplementation, ScalarUDF, Volatility,
};
use datafusion::logical_expr::function::ScalarFunctionArgs;
use datafusion_common::DataFusionError;
use datafusion_expr::{ScalarUDFImpl, Signature, TypeSignature};
use arrow_schema::DataType;
use std::any::Any;
use std::sync::Arc;

#[derive(Debug)]
pub struct VectorDistanceUdf {
    signature: Signature,
}

impl VectorDistanceUdf {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![
                    DataType::List(Arc::new(arrow_schema::Field::new(
                        "item", DataType::Float64, false,
                    ))),
                    DataType::List(Arc::new(arrow_schema::Field::new(
                        "item", DataType::Float64, false,
                    ))),
                ],
                Volatility::Immutable,
            ),
        }
    }
}

impl ScalarUDFImpl for VectorDistanceUdf {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn name(&self) -> &str {
        "vector_distance"
    }

    fn signature(&self) -> &Signature {
        &self.signature
    }

    fn return_type(&self, _arg_types: &[DataType]) -> DfResult<DataType> {
        Ok(DataType::Float64)
    }

    fn invoke_with_args(
        &self,
        args: ScalarFunctionArgs,
    ) -> DfResult<ColumnarValue> {
        let args = &args.args;
        if args.len() != 2 {
            return Err(DataFusionError::Plan(
                "vector_distance requires exactly 2 arguments".to_string(),
            ));
        }

        let left = match &args[0] {
            ColumnarValue::Array(a) => a.as_list::<i32>().clone(),
            _ => return Err(DataFusionError::Plan(
                "vector_distance requires array arguments".to_string(),
            )),
        };
        let right = match &args[1] {
            ColumnarValue::Array(a) => a.as_list::<i32>().clone(),
            _ => return Err(DataFusionError::Plan(
                "vector_distance requires array arguments".to_string(),
            )),
        };

        let mut results = Float64Array::builder(left.len());
        for i in 0..left.len() {
            if left.is_null(i) || right.is_null(i) {
                results.append_null();
                continue;
            }
            let l = left.value(i);
            let r = right.value(i);
            let l_vals = l.as_primitive::<arrow_array::types::Float64Type>();
            let r_vals = r.as_primitive::<arrow_array::types::Float64Type>();

            // Cosine similarity.
            let (mut dot, mut norm_l, mut norm_r) = (0.0f64, 0.0f64, 0.0f64);
            for j in 0..l_vals.len() {
                let a = l_vals.value(j);
                let b = r_vals.value(j);
                dot += a * b;
                norm_l += a * a;
                norm_r += b * b;
            }
            let denom = norm_l.sqrt() * norm_r.sqrt();
            let similarity = if denom == 0.0 { 0.0 } else { dot / denom };
            // Return distance (1 - similarity) so lower is closer.
            results.append_value(1.0 - similarity);
        }

        Ok(ColumnarValue::Array(Arc::new(results.finish())))
    }
}
```

### GEO_WITHIN — point-in-polygon test

```rust
#[derive(Debug)]
pub struct GeoWithinUdf {
    signature: Signature,
}

impl GeoWithinUdf {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![
                    DataType::Float64, // latitude
                    DataType::Float64, // longitude
                    DataType::Float64, // center_lat
                    DataType::Float64, // center_lon
                    DataType::Float64, // radius_meters
                ],
                Volatility::Immutable,
            ),
        }
    }
}

impl ScalarUDFImpl for GeoWithinUdf {
    fn as_any(&self) -> &dyn Any { self }
    fn name(&self) -> &str { "geo_within" }
    fn signature(&self) -> &Signature { &self.signature }

    fn return_type(&self, _arg_types: &[DataType]) -> DfResult<DataType> {
        Ok(DataType::Boolean)
    }

    fn invoke_with_args(
        &self,
        args: ScalarFunctionArgs,
    ) -> DfResult<ColumnarValue> {
        let args = &args.args;
        let lat = args[0].clone().into_array(1)?;
        let lon = args[1].clone().into_array(1)?;
        let center_lat = args[2].clone().into_array(1)?;
        let center_lon = args[3].clone().into_array(1)?;
        let radius = args[4].clone().into_array(1)?;

        let lat = lat.as_primitive::<arrow_array::types::Float64Type>();
        let lon = lon.as_primitive::<arrow_array::types::Float64Type>();
        let clat = center_lat.as_primitive::<arrow_array::types::Float64Type>();
        let clon = center_lon.as_primitive::<arrow_array::types::Float64Type>();
        let rad = radius.as_primitive::<arrow_array::types::Float64Type>();

        let mut results = arrow_array::builder::BooleanBuilder::with_capacity(lat.len());
        for i in 0..lat.len() {
            let dist = haversine_meters(
                lat.value(i), lon.value(i),
                clat.value(i), clon.value(i),
            );
            results.append_value(dist <= rad.value(i));
        }
        Ok(ColumnarValue::Array(Arc::new(results.finish())))
    }
}

/// Haversine distance in meters between two WGS84 coordinates.
fn haversine_meters(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0; // Earth radius in meters
    let (dlat, dlon) = (
        (lat2 - lat1).to_radians(),
        (lon2 - lon1).to_radians(),
    );
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos()
        * (dlon / 2.0).sin().powi(2);
    R * 2.0 * a.sqrt().asin()
}
```

### JSON_EXTRACT — extract a value from a JSON string column

```rust
#[derive(Debug)]
pub struct JsonExtractUdf {
    signature: Signature,
}

impl JsonExtractUdf {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![DataType::Utf8, DataType::Utf8],
                Volatility::Immutable,
            ),
        }
    }
}

impl ScalarUDFImpl for JsonExtractUdf {
    fn as_any(&self) -> &dyn Any { self }
    fn name(&self) -> &str { "json_extract" }
    fn signature(&self) -> &Signature { &self.signature }

    fn return_type(&self, _arg_types: &[DataType]) -> DfResult<DataType> {
        Ok(DataType::Utf8)
    }

    fn invoke_with_args(
        &self,
        args: ScalarFunctionArgs,
    ) -> DfResult<ColumnarValue> {
        let args = &args.args;
        let json_col = args[0].clone().into_array(1)?;
        let path_col = args[1].clone().into_array(1)?;

        let json_arr = json_col.as_string::<i32>();
        let path_arr = path_col.as_string::<i32>();

        let mut builder = arrow_array::builder::StringBuilder::new();
        for i in 0..json_arr.len() {
            if json_arr.is_null(i) || path_arr.is_null(i) {
                builder.append_null();
                continue;
            }
            let json_str = json_arr.value(i);
            let path = path_arr.value(i);
            match extract_json_path(json_str, path) {
                Some(val) => builder.append_value(&val),
                None => builder.append_null(),
            }
        }
        Ok(ColumnarValue::Array(Arc::new(builder.finish())))
    }
}

/// Simple dot-notation JSON path extractor.
/// Supports paths like "address.city" or "tags.0".
fn extract_json_path(json_str: &str, path: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(json_str).ok()?;
    let mut current = &parsed;
    for key in path.split('.') {
        current = if let Ok(idx) = key.parse::<usize>() {
            current.get(idx)?
        } else {
            current.get(key)?
        };
    }
    match current {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}
```

### Registering all UDFs

```rust
use datafusion::execution::context::SessionContext;
use datafusion::logical_expr::ScalarUDF;

pub fn register_udfs(ctx: &SessionContext) {
    ctx.register_udf(ScalarUDF::from(VectorDistanceUdf::new()));
    ctx.register_udf(ScalarUDF::from(GeoWithinUdf::new()));
    ctx.register_udf(ScalarUDF::from(JsonExtractUdf::new()));
}
```

## Custom Aggregate Functions (UDAFs)

Custom aggregates implement `Accumulator` for row-by-row state updates and produce a final scalar result.

### VECTOR_AVG — element-wise average of vector columns

```rust
use arrow_array::{ArrayRef, Float64Array, ListArray, cast::AsArray};
use arrow_schema::{DataType, Field};
use datafusion::error::Result as DfResult;
use datafusion::logical_expr::{
    Accumulator, AggregateUDFImpl, Signature, Volatility,
};
use datafusion::logical_expr::function::AccumulatorArgs;
use datafusion_common::{DataFusionError, ScalarValue};
use std::any::Any;
use std::sync::Arc;

#[derive(Debug)]
pub struct VectorAvgUdaf {
    signature: Signature,
}

impl VectorAvgUdaf {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![DataType::List(Arc::new(Field::new(
                    "item", DataType::Float64, false,
                )))],
                Volatility::Immutable,
            ),
        }
    }
}

impl AggregateUDFImpl for VectorAvgUdaf {
    fn as_any(&self) -> &dyn Any { self }
    fn name(&self) -> &str { "vector_avg" }
    fn signature(&self) -> &Signature { &self.signature }

    fn return_type(&self, _arg_types: &[DataType]) -> DfResult<DataType> {
        Ok(DataType::List(Arc::new(Field::new(
            "item", DataType::Float64, false,
        ))))
    }

    fn accumulator(
        &self,
        _args: AccumulatorArgs,
    ) -> DfResult<Box<dyn Accumulator>> {
        Ok(Box::new(VectorAvgAccumulator {
            sum: Vec::new(),
            count: 0,
        }))
    }
}

#[derive(Debug)]
struct VectorAvgAccumulator {
    sum: Vec<f64>,
    count: u64,
}

impl Accumulator for VectorAvgAccumulator {
    fn update_batch(&mut self, values: &[ArrayRef]) -> DfResult<()> {
        let list_array = values[0].as_list::<i32>();
        for i in 0..list_array.len() {
            if list_array.is_null(i) {
                continue;
            }
            let vec_arr = list_array
                .value(i)
                .as_primitive::<arrow_array::types::Float64Type>()
                .clone();

            // Initialize sum on first non-null vector.
            if self.sum.is_empty() {
                self.sum.resize(vec_arr.len(), 0.0);
            }

            for j in 0..vec_arr.len() {
                self.sum[j] += vec_arr.value(j);
            }
            self.count += 1;
        }
        Ok(())
    }

    fn evaluate(&mut self) -> DfResult<ScalarValue> {
        if self.count == 0 {
            return Ok(ScalarValue::Null);
        }
        let avg: Vec<f64> = self
            .sum
            .iter()
            .map(|s| s / self.count as f64)
            .collect();
        let arr = Float64Array::from(avg);
        Ok(ScalarValue::List(ScalarValue::new_list(
            &arr.iter()
                .map(|v| ScalarValue::Float64(v))
                .collect::<Vec<_>>(),
            &DataType::Float64,
            true,
        )))
    }

    fn size(&self) -> usize {
        std::mem::size_of_val(self) + self.sum.len() * std::mem::size_of::<f64>()
    }

    fn state(&mut self) -> DfResult<Vec<ScalarValue>> {
        // Return intermediate state for merge.
        let sum_arr = Float64Array::from(self.sum.clone());
        Ok(vec![
            ScalarValue::List(ScalarValue::new_list(
                &sum_arr.iter()
                    .map(|v| ScalarValue::Float64(v))
                    .collect::<Vec<_>>(),
                &DataType::Float64,
                true,
            )),
            ScalarValue::UInt64(Some(self.count)),
        ])
    }

    fn merge_batch(&mut self, states: &[ArrayRef]) -> DfResult<()> {
        let sum_lists = states[0].as_list::<i32>();
        let counts = states[1]
            .as_primitive::<arrow_array::types::UInt64Type>();

        for i in 0..sum_lists.len() {
            if sum_lists.is_null(i) {
                continue;
            }
            let other_sum = sum_lists
                .value(i)
                .as_primitive::<arrow_array::types::Float64Type>()
                .clone();

            if self.sum.is_empty() {
                self.sum.resize(other_sum.len(), 0.0);
            }
            for j in 0..other_sum.len() {
                self.sum[j] += other_sum.value(j);
            }
            self.count += counts.value(i);
        }
        Ok(())
    }
}
```

### Registering the UDAF

```rust
use datafusion::logical_expr::AggregateUDF;

pub fn register_udafs(ctx: &SessionContext) {
    ctx.register_udaf(AggregateUDF::from(VectorAvgUdaf::new()));
}
```

## Query Planning Extensions

### Custom optimizer rule — predicate pushdown to storage

Push filter predicates from the logical plan into storage-level scans so segments can skip non-matching data before Arrow materialization.

```rust
use datafusion::common::tree_node::{Transformed, TreeNode};
use datafusion::config::ConfigOptions;
use datafusion::error::Result as DfResult;
use datafusion::logical_expr::LogicalPlan;
use datafusion::optimizer::OptimizerRule;

/// Pushes filter predicates into StorageTableProvider scans.
///
/// Runs during logical optimization. Rewrites Filter → TableScan
/// into a TableScan with filters attached, so the physical scan
/// can skip non-matching segments.
#[derive(Debug, Default)]
pub struct StoragePredicatePushdown;

impl OptimizerRule for StoragePredicatePushdown {
    fn name(&self) -> &str {
        "storage_predicate_pushdown"
    }

    fn supports_rewrite(&self) -> bool {
        true
    }

    fn rewrite(
        &self,
        plan: LogicalPlan,
        _config: &ConfigOptions,
    ) -> DfResult<Transformed<LogicalPlan>> {
        match &plan {
            LogicalPlan::Filter(filter) => {
                if let LogicalPlan::TableScan(scan) = filter.input.as_ref() {
                    // Decompose the filter into conjuncts.
                    let predicates = split_conjunction(&filter.predicate);

                    // Check which predicates the storage layer can handle.
                    let (pushable, remaining): (Vec<_>, Vec<_>) = predicates
                        .into_iter()
                        .partition(|p| is_storage_pushable(p));

                    if pushable.is_empty() {
                        return Ok(Transformed::no(plan));
                    }

                    // Build a new TableScan with pushed-down filters.
                    let mut new_scan = scan.clone();
                    new_scan.filters.extend(pushable);

                    let new_plan = if remaining.is_empty() {
                        // All predicates pushed — remove the Filter node.
                        LogicalPlan::TableScan(new_scan)
                    } else {
                        // Some predicates remain — rebuild the Filter.
                        let remaining_pred = combine_conjunction(remaining);
                        LogicalPlan::Filter(datafusion_expr::logical_plan::Filter::try_new(
                            remaining_pred,
                            Arc::new(LogicalPlan::TableScan(new_scan)),
                        )?)
                    };
                    Ok(Transformed::yes(new_plan))
                } else {
                    Ok(Transformed::no(plan))
                }
            }
            _ => Ok(Transformed::no(plan)),
        }
    }
}

/// Returns true if the storage engine can evaluate this predicate
/// directly on segments (column comparisons, range filters, equality).
fn is_storage_pushable(expr: &Expr) -> bool {
    match expr {
        Expr::BinaryExpr(binary) => {
            matches!(
                binary.op,
                datafusion_expr::Operator::Eq
                    | datafusion_expr::Operator::NotEq
                    | datafusion_expr::Operator::Lt
                    | datafusion_expr::Operator::LtEq
                    | datafusion_expr::Operator::Gt
                    | datafusion_expr::Operator::GtEq
            ) && is_column_or_literal(&binary.left)
                && is_column_or_literal(&binary.right)
        }
        Expr::IsNull(_) | Expr::IsNotNull(_) => true,
        _ => false,
    }
}

fn is_column_or_literal(expr: &Expr) -> bool {
    matches!(expr, Expr::Column(_) | Expr::Literal(_))
}
```

### Index selection via table statistics

Provide statistics so DataFusion's optimizer can choose join strategies and estimate cardinality.

```rust
use datafusion::common::Statistics;
use datafusion::common::stats::Precision;
use datafusion::physical_plan::ExecutionPlan;

impl StorageScanExec {
    /// Report table statistics from the storage engine's metadata.
    /// Used by DataFusion's optimizer for join reordering and
    /// hash-vs-merge join selection.
    pub fn statistics_from_storage(&self) -> DfResult<Statistics> {
        let meta = self.table.metadata();
        Ok(Statistics {
            num_rows: Precision::Exact(meta.row_count as usize),
            total_byte_size: Precision::Exact(meta.total_bytes as usize),
            column_statistics: meta
                .columns
                .iter()
                .map(|col| datafusion::common::ColumnStatistics {
                    null_count: Precision::Exact(col.null_count as usize),
                    max_value: Precision::Absent,
                    min_value: Precision::Absent,
                    sum_value: Precision::Absent,
                    distinct_count: Precision::Absent,
                })
                .collect(),
        })
    }
}
```

### Registering custom optimizer rules

```rust
use datafusion::execution::context::SessionContext;
use datafusion::execution::SessionStateBuilder;

/// Build a SessionContext with custom optimizer rules.
pub fn build_session_context() -> SessionContext {
    let state = SessionStateBuilder::new()
        .with_default_features()
        .with_optimizer_rule(Arc::new(StoragePredicatePushdown::default()))
        .build();
    SessionContext::new_with_state(state)
}
```

## Window Functions

Register custom window functions for analytics queries.

```rust
use arrow_array::{ArrayRef, Float64Array};
use arrow_schema::DataType;
use datafusion::error::Result as DfResult;
use datafusion::logical_expr::{
    PartitionEvaluator, Signature, TypeSignature, Volatility, WindowUDFImpl,
};
use datafusion::logical_expr::function::WindowUDFFieldArgs;
use std::any::Any;
use std::sync::Arc;

/// MOVING_AVG(column, window_size) — compute a simple moving average
/// over the specified number of preceding rows.
#[derive(Debug)]
pub struct MovingAvgWindowUdf {
    signature: Signature,
}

impl MovingAvgWindowUdf {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![DataType::Float64, DataType::Int64],
                Volatility::Immutable,
            ),
        }
    }
}

impl WindowUDFImpl for MovingAvgWindowUdf {
    fn as_any(&self) -> &dyn Any { self }
    fn name(&self) -> &str { "moving_avg" }
    fn signature(&self) -> &Signature { &self.signature }

    fn return_type(&self, _arg_types: &[DataType]) -> DfResult<DataType> {
        Ok(DataType::Float64)
    }

    fn field(
        &self,
        field_args: WindowUDFFieldArgs,
    ) -> DfResult<arrow_schema::Field> {
        Ok(arrow_schema::Field::new(
            field_args.name(),
            DataType::Float64,
            true,
        ))
    }

    fn partition_evaluator(&self) -> DfResult<Box<dyn PartitionEvaluator>> {
        Ok(Box::new(MovingAvgEvaluator { window_size: 0 }))
    }
}

#[derive(Debug)]
struct MovingAvgEvaluator {
    window_size: usize,
}

impl PartitionEvaluator for MovingAvgEvaluator {
    fn evaluate_all(
        &mut self,
        values: &[ArrayRef],
        num_rows: usize,
    ) -> DfResult<ArrayRef> {
        let data = values[0]
            .as_primitive::<arrow_array::types::Float64Type>();
        // Extract window_size from the second argument (constant).
        let window_sizes = values[1]
            .as_primitive::<arrow_array::types::Int64Type>();
        let ws = window_sizes.value(0) as usize;

        let mut results = Float64Array::builder(num_rows);
        for i in 0..num_rows {
            let start = if i >= ws { i - ws + 1 } else { 0 };
            let mut sum = 0.0;
            let mut count = 0u64;
            for j in start..=i {
                if !data.is_null(j) {
                    sum += data.value(j);
                    count += 1;
                }
            }
            if count > 0 {
                results.append_value(sum / count as f64);
            } else {
                results.append_null();
            }
        }
        Ok(Arc::new(results.finish()))
    }

    fn uses_window_frame(&self) -> bool {
        false
    }

    fn include_rank(&self) -> bool {
        false
    }
}
```

### Registering the window function

```rust
use datafusion::logical_expr::WindowUDF;

pub fn register_window_functions(ctx: &SessionContext) {
    ctx.register_udwf(WindowUDF::from(MovingAvgWindowUdf::new()));
}
```

## Prepared Statements

Parse SQL once, cache the `LogicalPlan`, bind parameters at execution time. Avoids repeated parsing and optimization for parameterized queries.

```rust
use datafusion::error::Result as DfResult;
use datafusion::execution::context::SessionContext;
use datafusion::logical_expr::LogicalPlan;
use datafusion::prelude::ParamValues;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;

/// LRU cache of prepared statement logical plans.
///
/// Keyed by SQL string. The LogicalPlan contains parameter placeholders ($1, $2, ...)
/// that are replaced at execution time.
pub struct PreparedStatementCache {
    ctx: SessionContext,
    cache: Mutex<LruCache<String, LogicalPlan>>,
}

impl PreparedStatementCache {
    pub fn new(ctx: SessionContext, capacity: usize) -> Self {
        Self {
            ctx,
            cache: Mutex::new(LruCache::new(
                NonZeroUsize::new(capacity).expect("capacity must be > 0"),
            )),
        }
    }

    /// PREPARE: parse and optimize SQL, store the LogicalPlan.
    pub async fn prepare(&self, sql: &str) -> DfResult<()> {
        let plan = self.ctx.state().create_logical_plan(sql).await?;
        let optimized = self.ctx.state().optimize(&plan)?;
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.put(sql.to_string(), optimized);
        Ok(())
    }

    /// EXECUTE: retrieve cached plan, bind parameters, execute.
    ///
    /// Parameters are positional ($1, $2, ...) and passed as ScalarValues.
    pub async fn execute(
        &self,
        sql: &str,
        params: impl Into<ParamValues>,
    ) -> DfResult<datafusion::dataframe::DataFrame> {
        let plan = {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache
                .get(sql)
                .cloned()
                .ok_or_else(|| {
                    datafusion::error::DataFusionError::Plan(format!(
                        "Statement not prepared: {sql}"
                    ))
                })?
        };

        // Replace parameter placeholders with concrete values.
        let bound = plan.with_param_values(params)?;
        self.ctx.execute_logical_plan(bound).await
    }

    /// DEALLOCATE: remove a prepared statement from the cache.
    pub fn deallocate(&self, sql: &str) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.pop(sql);
    }
}
```

### Usage

```rust
use datafusion_common::ScalarValue;

async fn example_prepared_statements(cache: &PreparedStatementCache) -> DfResult<()> {
    // Prepare once.
    cache.prepare(
        "SELECT id, name FROM users WHERE age > $1 AND city = $2"
    ).await?;

    // Execute many times with different parameters.
    let df = cache.execute(
        "SELECT id, name FROM users WHERE age > $1 AND city = $2",
        vec![
            ("$1", ScalarValue::Int64(Some(25))),
            ("$2", ScalarValue::Utf8(Some("Berlin".to_string()))),
        ],
    ).await?;

    let batches = df.collect().await?;
    for batch in &batches {
        println!("{:?}", batch);
    }
    Ok(())
}
```

## Transactions

Wrap DataFusion execution in MVCC snapshots. Each transaction sees a consistent view of the data at the snapshot point.

### Transaction manager

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use datafusion::error::Result as DfResult;
use datafusion::execution::context::SessionContext;

use crate::storage::{Snapshot, StorageEngine, WalEntry};

/// Monotonically increasing transaction ID.
static NEXT_TX_ID: AtomicU64 = AtomicU64::new(1);

/// Represents an active transaction with MVCC snapshot isolation.
pub struct Transaction {
    pub id: u64,
    pub snapshot: Arc<Snapshot>,
    /// SessionContext scoped to this transaction's snapshot.
    pub ctx: SessionContext,
    /// Buffered writes — applied on COMMIT, discarded on ROLLBACK.
    writes: Vec<WalEntry>,
}

/// Manages active transactions and coordinates commit/rollback.
pub struct TransactionManager {
    engine: Arc<StorageEngine>,
    active: RwLock<HashMap<u64, Arc<Transaction>>>,
}

impl TransactionManager {
    pub fn new(engine: Arc<StorageEngine>) -> Self {
        Self {
            engine,
            active: RwLock::new(HashMap::new()),
        }
    }

    /// BEGIN — create a new transaction with a snapshot of current state.
    pub fn begin(&self) -> DfResult<Arc<Transaction>> {
        let tx_id = NEXT_TX_ID.fetch_add(1, Ordering::SeqCst);
        let snapshot = self.engine.create_snapshot(tx_id)?;

        // Build a SessionContext whose TableProviders read from the snapshot.
        let ctx = SessionContext::new();
        register_snapshot_tables(&ctx, &snapshot, &self.engine)?;

        let tx = Arc::new(Transaction {
            id: tx_id,
            snapshot: Arc::new(snapshot),
            ctx,
            writes: Vec::new(),
        });

        self.active.write().unwrap().insert(tx_id, Arc::clone(&tx));
        Ok(tx)
    }

    /// COMMIT — validate snapshot, write to WAL, apply to storage.
    pub fn commit(&self, tx_id: u64) -> DfResult<()> {
        let tx = self
            .active
            .write()
            .unwrap()
            .remove(&tx_id)
            .ok_or_else(|| {
                datafusion::error::DataFusionError::Plan(format!(
                    "Transaction {tx_id} not found"
                ))
            })?;

        // Validate: check for write-write conflicts since snapshot.
        self.engine.validate_snapshot(&tx.snapshot, &tx.writes)?;

        // Write to WAL — durable before acknowledging commit.
        self.engine.append_wal(&tx.writes)?;

        // Apply buffered writes to in-memory state.
        self.engine.apply_writes(&tx.writes)?;

        Ok(())
    }

    /// ROLLBACK — discard buffered writes, release snapshot.
    pub fn rollback(&self, tx_id: u64) -> DfResult<()> {
        self.active.write().unwrap().remove(&tx_id);
        // Snapshot is dropped — no WAL entries written.
        Ok(())
    }
}
```

### Snapshot-scoped TableProvider

```rust
/// A TableProvider that reads from a specific MVCC snapshot.
///
/// Identical to StorageTableProvider but routes all reads through
/// the snapshot's visible set — only rows committed before the
/// snapshot timestamp are returned.
pub struct SnapshotTableProvider {
    table: Arc<TableHandle>,
    schema: SchemaRef,
    engine: Arc<StorageEngine>,
    snapshot: Arc<Snapshot>,
}

#[async_trait]
impl TableProvider for SnapshotTableProvider {
    fn as_any(&self) -> &dyn Any { self }
    fn schema(&self) -> SchemaRef { Arc::clone(&self.schema) }
    fn table_type(&self) -> TableType { TableType::Base }

    async fn scan(
        &self,
        state: &SessionState,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> DfResult<Arc<dyn ExecutionPlan>> {
        let projected_schema = match projection {
            Some(indices) => Arc::new(self.schema.project(indices)?),
            None => Arc::clone(&self.schema),
        };

        // SnapshotScanExec is like StorageScanExec but filters rows
        // by the snapshot's visibility map — only committed rows
        // with commit_ts <= snapshot_ts are emitted.
        let plan = SnapshotScanExec::new(
            Arc::clone(&self.engine),
            Arc::clone(&self.table),
            Arc::clone(&self.snapshot),
            projected_schema,
            projection.cloned(),
            filters.to_vec(),
            limit,
            state.config().batch_size(),
        );
        Ok(Arc::new(plan))
    }
}

/// Register all tables from the snapshot onto the transaction's SessionContext.
fn register_snapshot_tables(
    ctx: &SessionContext,
    snapshot: &Snapshot,
    engine: &Arc<StorageEngine>,
) -> DfResult<()> {
    for table_handle in snapshot.visible_tables() {
        let schema = StorageTableProvider::arrow_schema_from_storage(&table_handle);
        let provider = SnapshotTableProvider {
            table: Arc::new(table_handle.clone()),
            schema,
            engine: Arc::clone(engine),
            snapshot: Arc::new(snapshot.clone()),
        };
        ctx.register_table(table_handle.name(), Arc::new(provider))?;
    }
    Ok(())
}
```

### Transaction lifecycle

```rust
/// Full transaction lifecycle example.
async fn transaction_example(
    tx_mgr: &TransactionManager,
) -> DfResult<()> {
    // BEGIN
    let tx = tx_mgr.begin()?;

    // All reads go through the snapshot — isolated from concurrent writes.
    let df = tx.ctx.sql("SELECT * FROM orders WHERE status = 'pending'").await?;
    let batches = df.collect().await?;

    // Writes are buffered — not visible to other transactions yet.
    tx.ctx.sql("UPDATE orders SET status = 'shipped' WHERE id = 42").await?;

    // COMMIT — validate, WAL, apply.
    match tx_mgr.commit(tx.id) {
        Ok(()) => println!("Transaction {} committed", tx.id),
        Err(e) => {
            // Conflict detected — rollback and retry.
            eprintln!("Commit failed: {e}, rolling back");
            tx_mgr.rollback(tx.id)?;
        }
    }
    Ok(())
}
```

## Performance

### Vectorized execution

DataFusion processes data in columnar `RecordBatch` units, not row-by-row. Every custom operator must maintain this invariant.

```rust
use datafusion::execution::context::SessionContext;
use datafusion::config::ConfigOptions;

/// Configure a SessionContext for production workloads.
pub fn production_session_context() -> SessionContext {
    let mut config = ConfigOptions::new();

    // Batch size: number of rows per RecordBatch.
    // Default 8192. Larger = better SIMD utilization, more memory.
    // Smaller = lower latency for LIMIT queries.
    config.execution.batch_size = 8192;

    // Target partitions: parallelism level.
    // Set to number of CPU cores for CPU-bound workloads.
    config.execution.target_partitions = num_cpus::get();

    // Parquet pruning — skip row groups based on statistics.
    config.execution.parquet.pushdown_filters = true;
    config.execution.parquet.reorder_filters = true;

    // Sort spill: allow large sorts to spill to disk.
    config.execution.sort_spill_reservation_bytes = 10 * 1024 * 1024; // 10 MB

    let state = SessionStateBuilder::new()
        .with_config(config.into())
        .with_default_features()
        .build();
    SessionContext::new_with_state(state)
}
```

### Memory limits per query

Use `MemoryPool` to cap per-query memory and prevent OOM on large aggregations.

```rust
use datafusion::execution::context::SessionContext;
use datafusion::execution::memory_pool::{
    FairSpillPool, GreedyMemoryPool, MemoryPool,
};
use datafusion::execution::runtime_env::RuntimeEnvBuilder;
use std::sync::Arc;

/// Build a RuntimeEnv with a memory pool that limits total query memory.
///
/// FairSpillPool: divides memory equally among active queries.
///   Queries that exceed their share spill to disk.
///
/// GreedyMemoryPool: first-come-first-served. Simpler, but one
///   large query can starve others.
pub fn build_memory_limited_context(max_memory_bytes: usize) -> SessionContext {
    // FairSpillPool is preferred for multi-tenant workloads.
    let pool: Arc<dyn MemoryPool> = Arc::new(FairSpillPool::new(max_memory_bytes));

    let runtime = RuntimeEnvBuilder::new()
        .with_memory_pool(pool)
        .build_arc()
        .expect("Failed to build RuntimeEnv");

    let state = SessionStateBuilder::new()
        .with_runtime_env(runtime)
        .with_default_features()
        .build();
    SessionContext::new_with_state(state)
}
```

### Spill to disk for large aggregations

When a hash aggregate or sort exceeds its memory reservation, DataFusion spills intermediate data to temporary files. Configure the spill directory:

```rust
use datafusion::execution::runtime_env::RuntimeEnvBuilder;
use datafusion::execution::disk_manager::DiskManagerConfig;

/// Configure spill-to-disk for large sorts and aggregations.
pub fn build_spillable_runtime(
    max_memory: usize,
    spill_dir: &str,
) -> Arc<datafusion::execution::runtime_env::RuntimeEnv> {
    RuntimeEnvBuilder::new()
        .with_memory_pool(Arc::new(FairSpillPool::new(max_memory)))
        .with_disk_manager(DiskManagerConfig::NewSpecified(vec![spill_dir.into()]))
        .build_arc()
        .expect("Failed to build RuntimeEnv with spill")
}
```

### Batch size tuning guidelines

| Workload | Recommended batch size | Rationale |
|---|---|---|
| Full table scan / analytics | 8192 (default) | Maximizes SIMD lane utilization |
| LIMIT N (small N) | 1024 | Avoid reading 8192 rows to return 10 |
| Streaming / real-time | 256–1024 | Lower latency per batch |
| Wide tables (100+ columns) | 2048–4096 | Keep per-batch memory bounded |
| Narrow tables, large aggregations | 16384 | More rows per function call overhead |

## Key Dependencies

| Crate | Purpose |
|---|---|
| `datafusion` | SQL parser, logical/physical planner, optimizer, execution engine |
| `datafusion-common` | Shared types: `ScalarValue`, `DFSchema`, errors |
| `datafusion-expr` | `Expr`, `LogicalPlan`, `TableProvider`, UDF traits |
| `datafusion-physical-expr` | Physical expression evaluation on `RecordBatch` |
| `datafusion-physical-plan` | `ExecutionPlan` trait, stream utilities |
| `arrow` | Umbrella crate re-exporting all arrow-* crates |
| `arrow-array` | `RecordBatch`, typed arrays (`Int64Array`, `StringArray`, etc.) |
| `arrow-schema` | `Schema`, `Field`, `DataType` definitions |
| `arrow-cast` | Type casting between Arrow arrays |
| `arrow-buffer` | `Buffer`, `OffsetBuffer`, `NullBuffer` for zero-copy construction |
| `lru` | LRU cache for prepared statement plans |
| `async-trait` | `#[async_trait]` for async trait methods on `TableProvider` |

## Never

- **Never process rows one at a time inside an ExecutionPlan.** Always operate on columnar `RecordBatch` data. Row-by-row defeats vectorized execution.
- **Never hold a `Mutex` across `.await` boundaries.** Use `tokio::sync::Mutex` if you must lock across async calls, or restructure to avoid it.
- **Never allocate inside the inner loop of a UDF.** Pre-allocate builders with `with_capacity`, reuse buffers across batches.
- **Never ignore null bitmaps.** Check `is_null(i)` before accessing values. Arrow arrays have separate null tracking — reading a null slot returns arbitrary data.
- **Never return wrong-length arrays from UDFs.** The output array must have exactly the same number of rows as the input. DataFusion panics on length mismatch.
- **Never skip the `// SAFETY:` comment on `unsafe` blocks.** Every zero-copy mmap construction must document the invariant that keeps the data valid.
- **Never register a `TableProvider` that returns a different schema from `schema()` than what `scan()` produces.** Schema mismatch causes runtime panics in downstream operators.
- **Never use `anyhow` in library crates.** Use `datafusion::error::DataFusionError` or wrap it in a crate-specific `thiserror` enum with `#[from] DataFusionError`.
