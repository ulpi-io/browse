# Wire Protocols — pgwire, MySQL Protocol, SQLite Embedded

## What

Implement database-compatible network servers in Rust. The pgwire (Postgres) protocol is the primary target — it enables any Postgres client, ORM, or tool (`psql`, Prisma, Drizzle, SQLAlchemy, DBeaver) to connect to your custom database engine. MySQL protocol and SQLite embedded mode provide additional compatibility surfaces.

Key crates: `pgwire` (Postgres wire protocol), `tokio` (async runtime), `tokio-rustls` (TLS), `rusqlite` (SQLite FFI), `bytes` (buffer management).

## pgwire Server — Complete Implementation

### Cargo.toml Dependencies

```toml
[dependencies]
pgwire = "0.28"
tokio = { version = "1", features = ["full"] }
tokio-rustls = "0.26"
async-trait = "0.1"
futures = "0.3"
bytes = "1"
thiserror = "2"
tracing = "0.1"
```

### Server Bootstrap

```rust
use std::sync::Arc;
use tokio::net::TcpListener;
use pgwire::tokio::process_socket;
use pgwire::api::auth::noop::NoopStartupHandler;
use pgwire::api::MakeHandler;

/// Factory that creates handler instances per connection.
pub struct HandlerFactory {
    catalog: Arc<Catalog>,
}

impl MakeHandler for HandlerFactory {
    type Handler = Arc<QueryHandler>;

    fn make(&self) -> Self::Handler {
        Arc::new(QueryHandler {
            catalog: Arc::clone(&self.catalog),
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let catalog = Arc::new(Catalog::new());

    let factory = Arc::new(HandlerFactory { catalog });
    let authenticator = Arc::new(NoopStartupHandler);

    let listener = TcpListener::bind("0.0.0.0:5432").await?;
    tracing::info!("pgwire server listening on port 5432");

    loop {
        let (socket, addr) = listener.accept().await?;
        tracing::debug!("new connection from {addr}");

        let factory = Arc::clone(&factory);
        let authenticator = Arc::clone(&authenticator);

        tokio::spawn(async move {
            if let Err(e) = process_socket(
                socket,
                None, // No TLS acceptor — see TLS section below
                factory.make(),        // query handler
                authenticator.clone(),  // startup/auth handler
                factory.make(),        // copy handler (reuse query handler)
            )
            .await
            {
                tracing::error!("connection error from {addr}: {e}");
            }
        });
    }
}
```

### SimpleQueryHandler — Full Implementation

Handles `Query` messages from `psql` and simple-mode clients. Every query arrives as a raw SQL string.

```rust
use async_trait::async_trait;
use pgwire::api::portal::Portal;
use pgwire::api::query::SimpleQueryHandler;
use pgwire::api::results::{
    DataRowEncoder, FieldFormat, FieldInfo, QueryResponse, Response, Tag,
};
use pgwire::api::ClientInfo;
use pgwire::error::{ErrorInfo, PgWireError, PgWireResult};
use pgwire::messages::data::DataRow;

pub struct QueryHandler {
    catalog: Arc<Catalog>,
}

#[async_trait]
impl SimpleQueryHandler for QueryHandler {
    async fn do_query<'a, C: ClientInfo + Unpin + Send + 'a>(
        &self,
        client: &mut C,
        query: &'a str,
    ) -> PgWireResult<Vec<Response<'a>>> {
        tracing::debug!(query, "simple query");

        // Parse the SQL — your engine's parser goes here
        let statement = match self.catalog.parse(query) {
            Ok(stmt) => stmt,
            Err(e) => {
                return Err(PgWireError::UserError(Box::new(ErrorInfo::new(
                    "ERROR".to_string(),
                    "42601".to_string(), // syntax_error
                    e.to_string(),
                ))));
            }
        };

        match statement {
            // --- SELECT: return rows ---
            Statement::Select(select) => {
                let result_set = self.catalog.execute_select(&select)?;

                // Build field descriptors (RowDescription message)
                let fields: Vec<FieldInfo> = result_set
                    .columns
                    .iter()
                    .map(|col| {
                        FieldInfo::new(
                            col.name.clone(),          // column name
                            None,                      // table oid (optional)
                            None,                      // column attribute number
                            logical_type_to_pg_type(&col.data_type),
                            FieldFormat::Text,         // text format for simple query
                        )
                    })
                    .collect();

                let field_info = Arc::new(fields);

                // Encode rows
                let mut rows: Vec<DataRow> = Vec::with_capacity(result_set.rows.len());
                for row in &result_set.rows {
                    let mut encoder = DataRowEncoder::new(Arc::clone(&field_info));
                    for (i, value) in row.values.iter().enumerate() {
                        encode_value_text(&mut encoder, value, &result_set.columns[i].data_type)?;
                    }
                    rows.push(encoder.finish());
                }

                Ok(vec![Response::Query(QueryResponse::new(field_info, rows))])
            }

            // --- INSERT/UPDATE/DELETE: return affected count ---
            Statement::Insert(insert) => {
                let affected = self.catalog.execute_insert(&insert)?;
                Ok(vec![Response::Execution(
                    Tag::new("INSERT").with_oid(0).with_rows(affected),
                )])
            }
            Statement::Update(update) => {
                let affected = self.catalog.execute_update(&update)?;
                Ok(vec![Response::Execution(
                    Tag::new("UPDATE").with_rows(affected),
                )])
            }
            Statement::Delete(delete) => {
                let affected = self.catalog.execute_delete(&delete)?;
                Ok(vec![Response::Execution(
                    Tag::new("DELETE").with_rows(affected),
                )])
            }

            // --- DDL: return command tag ---
            Statement::CreateTable(ct) => {
                self.catalog.create_table(&ct)?;
                Ok(vec![Response::Execution(Tag::new("CREATE TABLE"))])
            }
            Statement::DropTable(dt) => {
                self.catalog.drop_table(&dt)?;
                Ok(vec![Response::Execution(Tag::new("DROP TABLE"))])
            }
            Statement::CreateIndex(ci) => {
                self.catalog.create_index(&ci)?;
                Ok(vec![Response::Execution(Tag::new("CREATE INDEX"))])
            }

            // --- Transactions ---
            Statement::Begin => {
                self.catalog.begin_transaction(client)?;
                Ok(vec![Response::Execution(Tag::new("BEGIN"))])
            }
            Statement::Commit => {
                self.catalog.commit_transaction(client)?;
                Ok(vec![Response::Execution(Tag::new("COMMIT"))])
            }
            Statement::Rollback => {
                self.catalog.rollback_transaction(client)?;
                Ok(vec![Response::Execution(Tag::new("ROLLBACK"))])
            }

            // --- SET / session variables ---
            Statement::Set { name, value } => {
                // ORMs send SET commands — store in session state
                tracing::debug!("SET {name} = {value} (acknowledged, may be ignored)");
                Ok(vec![Response::Execution(Tag::new("SET"))])
            }

            _ => Err(PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "0A000".to_string(), // feature_not_supported
                format!("Unsupported statement: {query}"),
            )))),
        }
    }
}
```

### ExtendedQueryHandler — Prepared Statements

The extended query protocol is used by most ORMs and client libraries (`node-postgres`, `libpq` in prepared mode, JDBC). It splits query execution into Parse/Bind/Describe/Execute phases.

```rust
use pgwire::api::query::ExtendedQueryHandler;
use pgwire::api::portal::Portal;
use pgwire::api::stmt::{NoopQueryParser, QueryParser, StoredStatement};
use pgwire::api::store::MemPortalStore;
use pgwire::api::results::DescribePortalResponse;
use pgwire::messages::extendedquery::Bind;

/// Custom query parser that compiles SQL into your engine's plan.
pub struct EngineQueryParser {
    catalog: Arc<Catalog>,
}

impl QueryParser for EngineQueryParser {
    type Statement = CompiledPlan;

    /// Called on Parse message — compile the SQL, extract parameter placeholders.
    fn parse_sql(&self, sql: &str, types: &[Type]) -> PgWireResult<Self::Statement> {
        let plan = self.catalog.compile(sql, types).map_err(|e| {
            PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "42601".to_string(),
                e.to_string(),
            )))
        })?;
        Ok(plan)
    }
}

#[async_trait]
impl ExtendedQueryHandler for QueryHandler {
    type Statement = CompiledPlan;
    type QueryParser = EngineQueryParser;
    type PortalStore = MemPortalStore<Self::Statement>;

    fn query_parser(&self) -> Arc<Self::QueryParser> {
        Arc::new(EngineQueryParser {
            catalog: Arc::clone(&self.catalog),
        })
    }

    fn portal_store(&self) -> Arc<Self::PortalStore> {
        Arc::new(MemPortalStore::new())
    }

    /// Called on Describe(Statement) — return parameter types the statement expects.
    async fn do_describe_statement<C: ClientInfo + Unpin + Send>(
        &self,
        _client: &mut C,
        stmt: &StoredStatement<Self::Statement>,
    ) -> PgWireResult<DescribeStatementResponse> {
        let plan = stmt.statement();

        // Parameter types — what $1, $2, etc. expect
        let param_types: Vec<Type> = plan
            .parameters
            .iter()
            .map(|p| logical_type_to_pg_type(&p.data_type))
            .collect();

        // Result columns — what the query returns
        let columns: Vec<FieldInfo> = plan
            .output_columns
            .iter()
            .map(|col| {
                FieldInfo::new(
                    col.name.clone(),
                    None,
                    None,
                    logical_type_to_pg_type(&col.data_type),
                    FieldFormat::Text,
                )
            })
            .collect();

        Ok(DescribeStatementResponse::new(param_types, columns))
    }

    /// Called on Describe(Portal) — return column metadata for a bound portal.
    async fn do_describe_portal<C: ClientInfo + Unpin + Send>(
        &self,
        _client: &mut C,
        portal: &Portal<Self::Statement>,
    ) -> PgWireResult<DescribePortalResponse> {
        let plan = portal.statement().statement();
        let format = portal.result_column_format();

        let columns: Vec<FieldInfo> = plan
            .output_columns
            .iter()
            .enumerate()
            .map(|(i, col)| {
                let fmt = format
                    .get(i)
                    .copied()
                    .unwrap_or(FieldFormat::Text);
                FieldInfo::new(
                    col.name.clone(),
                    None,
                    None,
                    logical_type_to_pg_type(&col.data_type),
                    fmt,
                )
            })
            .collect();

        Ok(DescribePortalResponse::new(columns))
    }

    /// Called on Execute — run the bound statement with parameters.
    async fn do_query<'a, C: ClientInfo + Unpin + Send + 'a>(
        &self,
        _client: &mut C,
        portal: &'a Portal<Self::Statement>,
        max_rows: usize,
    ) -> PgWireResult<Response<'a>> {
        let plan = portal.statement().statement();
        let params = portal.parameters();

        // Decode bound parameters
        let decoded_params: Vec<Value> = plan
            .parameters
            .iter()
            .enumerate()
            .map(|(i, param_meta)| {
                decode_parameter(params, i, &param_meta.data_type)
            })
            .collect::<PgWireResult<Vec<_>>>()?;

        // Execute with parameters
        let result_set = self
            .catalog
            .execute_plan(plan, &decoded_params, max_rows)
            .map_err(|e| {
                PgWireError::UserError(Box::new(ErrorInfo::new(
                    "ERROR".to_string(),
                    "XX000".to_string(), // internal_error
                    e.to_string(),
                )))
            })?;

        // Determine format (text vs binary) from portal binding
        let format = portal.result_column_format();

        let fields: Vec<FieldInfo> = result_set
            .columns
            .iter()
            .enumerate()
            .map(|(i, col)| {
                let fmt = format
                    .get(i)
                    .copied()
                    .unwrap_or(FieldFormat::Text);
                FieldInfo::new(
                    col.name.clone(),
                    None,
                    None,
                    logical_type_to_pg_type(&col.data_type),
                    fmt,
                )
            })
            .collect();

        let field_info = Arc::new(fields);

        let mut rows: Vec<DataRow> = Vec::with_capacity(result_set.rows.len());
        for row in &result_set.rows {
            let mut encoder = DataRowEncoder::new(Arc::clone(&field_info));
            for (i, value) in row.values.iter().enumerate() {
                let col_format = format
                    .get(i)
                    .copied()
                    .unwrap_or(FieldFormat::Text);
                match col_format {
                    FieldFormat::Text => {
                        encode_value_text(&mut encoder, value, &result_set.columns[i].data_type)?;
                    }
                    FieldFormat::Binary => {
                        encode_value_binary(&mut encoder, value, &result_set.columns[i].data_type)?;
                    }
                }
            }
            rows.push(encoder.finish());
        }

        Ok(Response::Query(QueryResponse::new(field_info, rows)))
    }
}
```

### Parameter Decoding

Decode bound parameters from the wire format into your engine's value types.

```rust
use pgwire::api::portal::Portal;
use pgwire::messages::extendedquery::Bind;
use postgres_types::Type;

fn decode_parameter(
    params: &[Option<bytes::Bytes>],
    index: usize,
    logical_type: &LogicalType,
) -> PgWireResult<Value> {
    let raw = match params.get(index) {
        Some(Some(bytes)) => bytes,
        Some(None) | None => return Ok(Value::Null),
    };

    // Parameters in extended protocol arrive as text or binary.
    // Most clients send text format for parameters.
    let text = std::str::from_utf8(raw).map_err(|_| {
        PgWireError::UserError(Box::new(ErrorInfo::new(
            "ERROR".to_string(),
            "22021".to_string(), // character_not_in_repertoire
            "Invalid UTF-8 in parameter".to_string(),
        )))
    })?;

    match logical_type {
        LogicalType::Int => Ok(Value::Int(text.parse::<i32>().map_err(|e| {
            PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "22P02".to_string(), // invalid_text_representation
                format!("Invalid integer: {e}"),
            )))
        })?)),
        LogicalType::BigInt => Ok(Value::BigInt(text.parse::<i64>().map_err(|e| {
            PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "22P02".to_string(),
                format!("Invalid bigint: {e}"),
            )))
        })?)),
        LogicalType::Text => Ok(Value::Text(text.to_string())),
        LogicalType::Bool => {
            let val = match text {
                "t" | "true" | "TRUE" | "1" | "yes" | "on" => true,
                "f" | "false" | "FALSE" | "0" | "no" | "off" => false,
                _ => {
                    return Err(PgWireError::UserError(Box::new(ErrorInfo::new(
                        "ERROR".to_string(),
                        "22P02".to_string(),
                        format!("Invalid boolean: {text}"),
                    ))));
                }
            };
            Ok(Value::Bool(val))
        }
        LogicalType::Float => Ok(Value::Float(text.parse::<f32>().map_err(|e| {
            PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "22P02".to_string(),
                format!("Invalid float: {e}"),
            )))
        })?)),
        LogicalType::Double => Ok(Value::Double(text.parse::<f64>().map_err(|e| {
            PgWireError::UserError(Box::new(ErrorInfo::new(
                "ERROR".to_string(),
                "22P02".to_string(),
                format!("Invalid double: {e}"),
            )))
        })?)),
        LogicalType::Uuid => Ok(Value::Text(text.to_string())), // validate UUID format
        LogicalType::Timestamp => Ok(Value::Text(text.to_string())), // parse as needed
        LogicalType::Json | LogicalType::Jsonb => Ok(Value::Text(text.to_string())),
        LogicalType::Bytea => {
            // Postgres sends bytea as hex: \x48656c6c6f
            let decoded = if text.starts_with("\\x") {
                hex::decode(&text[2..]).map_err(|e| {
                    PgWireError::UserError(Box::new(ErrorInfo::new(
                        "ERROR".to_string(),
                        "22P02".to_string(),
                        format!("Invalid bytea hex: {e}"),
                    )))
                })?
            } else {
                text.as_bytes().to_vec()
            };
            Ok(Value::Bytea(decoded))
        }
        _ => Ok(Value::Text(text.to_string())), // fallback — treat as text
    }
}
```

## Postgres Type OID Mapping

Every Postgres type has a numeric OID. Clients use these to interpret column metadata and encode/decode parameters.

```rust
use postgres_types::Type;

/// Map your engine's logical types to Postgres wire types.
/// The pgwire crate uses `postgres_types::Type` which bundles OID + format info.
fn logical_type_to_pg_type(ty: &LogicalType) -> Type {
    match ty {
        LogicalType::Bool       => Type::BOOL,        // OID 16
        LogicalType::SmallInt   => Type::INT2,        // OID 21
        LogicalType::Int        => Type::INT4,        // OID 23
        LogicalType::BigInt     => Type::INT8,        // OID 20
        LogicalType::Float      => Type::FLOAT4,      // OID 700
        LogicalType::Double     => Type::FLOAT8,      // OID 701
        LogicalType::Numeric    => Type::NUMERIC,     // OID 1700
        LogicalType::Text       => Type::TEXT,        // OID 25
        LogicalType::Varchar    => Type::VARCHAR,     // OID 1043
        LogicalType::Char       => Type::BPCHAR,      // OID 1042
        LogicalType::Bytea      => Type::BYTEA,       // OID 17
        LogicalType::Date       => Type::DATE,        // OID 1082
        LogicalType::Time       => Type::TIME,        // OID 1083
        LogicalType::Timestamp  => Type::TIMESTAMP,   // OID 1114
        LogicalType::TimestampTz => Type::TIMESTAMPTZ,// OID 1184
        LogicalType::Interval   => Type::INTERVAL,    // OID 1186
        LogicalType::Uuid       => Type::UUID,        // OID 2950
        LogicalType::Json       => Type::JSON,        // OID 114
        LogicalType::Jsonb      => Type::JSONB,       // OID 3802
        LogicalType::IntArray   => Type::INT4_ARRAY,  // OID 1007
        LogicalType::TextArray  => Type::TEXT_ARRAY,   // OID 1009
        LogicalType::Oid        => Type::OID,         // OID 26
        LogicalType::Void       => Type::VOID,        // OID 2278
    }
}
```

### Complete OID Reference Table

| Logical Type | Postgres Type | OID | Rust Encode Type | Notes |
|---|---|---|---|---|
| Bool | `BOOL` | 16 | `bool` | Postgres text: `t`/`f` |
| SmallInt | `INT2` | 21 | `i16` | 2-byte signed |
| Int | `INT4` | 23 | `i32` | 4-byte signed |
| BigInt | `INT8` | 20 | `i64` | 8-byte signed |
| Float | `FLOAT4` | 700 | `f32` | IEEE 754 single |
| Double | `FLOAT8` | 701 | `f64` | IEEE 754 double |
| Numeric | `NUMERIC` | 1700 | string repr | Arbitrary precision |
| Text | `TEXT` | 25 | `&str` | Variable-length |
| Varchar | `VARCHAR` | 1043 | `&str` | Length-constrained |
| Char | `BPCHAR` | 1042 | `&str` | Blank-padded |
| Name | `NAME` | 19 | `&str` | 63-byte identifier |
| Bytea | `BYTEA` | 17 | `&[u8]` | Binary data |
| Date | `DATE` | 1082 | `i32` days | Days since 2000-01-01 |
| Time | `TIME` | 1083 | `i64` microseconds | Microseconds since midnight |
| Timestamp | `TIMESTAMP` | 1114 | `i64` microseconds | Microseconds since 2000-01-01 |
| TimestampTz | `TIMESTAMPTZ` | 1184 | `i64` microseconds | Same, in UTC |
| Interval | `INTERVAL` | 1186 | 16 bytes | months(i32) + days(i32) + microseconds(i64) |
| UUID | `UUID` | 2950 | `[u8; 16]` | RFC 4122 |
| JSON | `JSON` | 114 | `&str` | Text JSON |
| JSONB | `JSONB` | 3802 | `&[u8]` | Binary JSON, version byte prefix |
| OID | `OID` | 26 | `u32` | Object identifier |
| Int4Array | `INT4[]` | 1007 | custom | Array header + elements |
| TextArray | `TEXT[]` | 1009 | custom | Array header + elements |
| Void | `VOID` | 2278 | `()` | No value |
| RegType | `REGTYPE` | 2206 | `u32` | Type OID as regtype |

## Binary vs Text Wire Format

Postgres sends data in either text or binary format. Simple query protocol always uses text. Extended query protocol uses whatever format the client requests in the Bind message.

### Text Format Encoding

```rust
fn encode_value_text(
    encoder: &mut DataRowEncoder,
    value: &Value,
    ty: &LogicalType,
) -> PgWireResult<()> {
    match value {
        Value::Null => encoder.encode_field(&None::<&str>),
        Value::Bool(b) => {
            // Postgres text format: "t" or "f" — NOT "true"/"false"
            encoder.encode_field(&Some(if *b { "t" } else { "f" }))
        }
        Value::Int(n) => encoder.encode_field(&Some(n.to_string())),
        Value::BigInt(n) => encoder.encode_field(&Some(n.to_string())),
        Value::Float(f) => encoder.encode_field(&Some(format_float(*f))),
        Value::Double(f) => encoder.encode_field(&Some(format_double(*f))),
        Value::Text(s) => encoder.encode_field(&Some(s.as_str())),
        Value::Bytea(b) => {
            // Postgres hex format: \x followed by hex pairs
            let hex = format!("\\x{}", hex::encode(b));
            encoder.encode_field(&Some(hex))
        }
        Value::Timestamp(us) => {
            // Microseconds since 2000-01-01 → "2024-01-15 10:30:00.000000"
            let formatted = format_pg_timestamp(*us);
            encoder.encode_field(&Some(formatted))
        }
        Value::Uuid(bytes) => {
            let uuid_str = format!(
                "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
                u32::from_be_bytes(bytes[0..4].try_into().unwrap()),
                u16::from_be_bytes(bytes[4..6].try_into().unwrap()),
                u16::from_be_bytes(bytes[6..8].try_into().unwrap()),
                u16::from_be_bytes(bytes[8..10].try_into().unwrap()),
                // last 6 bytes as 48-bit integer
                u64::from_be_bytes({
                    let mut buf = [0u8; 8];
                    buf[2..8].copy_from_slice(&bytes[10..16]);
                    buf
                }),
            );
            encoder.encode_field(&Some(uuid_str))
        }
        Value::Json(s) | Value::Jsonb(s) => encoder.encode_field(&Some(s.as_str())),
    }
}

/// Postgres float formatting: no trailing zeros, but always at least one decimal place.
fn format_float(f: f32) -> String {
    if f.fract() == 0.0 {
        format!("{f:.1}")
    } else {
        format!("{f}")
    }
}

fn format_double(f: f64) -> String {
    if f.fract() == 0.0 {
        format!("{f:.1}")
    } else {
        format!("{f}")
    }
}
```

### Binary Format Encoding

```rust
use bytes::{BufMut, BytesMut};

fn encode_value_binary(
    encoder: &mut DataRowEncoder,
    value: &Value,
    ty: &LogicalType,
) -> PgWireResult<()> {
    match value {
        Value::Null => encoder.encode_field(&None::<&[u8]>),
        Value::Bool(b) => {
            // 1 byte: 0x01 for true, 0x00 for false
            encoder.encode_field(&Some(if *b { &[1u8][..] } else { &[0u8][..] }))
        }
        Value::Int(n) => {
            // 4 bytes, big-endian
            encoder.encode_field(&Some(&n.to_be_bytes()[..]))
        }
        Value::BigInt(n) => {
            // 8 bytes, big-endian
            encoder.encode_field(&Some(&n.to_be_bytes()[..]))
        }
        Value::Float(f) => {
            // 4 bytes, IEEE 754 big-endian
            encoder.encode_field(&Some(&f.to_be_bytes()[..]))
        }
        Value::Double(f) => {
            // 8 bytes, IEEE 754 big-endian
            encoder.encode_field(&Some(&f.to_be_bytes()[..]))
        }
        Value::Text(s) => {
            // Variable-length, no null terminator
            encoder.encode_field(&Some(s.as_bytes()))
        }
        Value::Bytea(b) => {
            // Raw bytes, no hex encoding in binary format
            encoder.encode_field(&Some(b.as_slice()))
        }
        Value::Uuid(bytes) => {
            // 16 bytes, raw
            encoder.encode_field(&Some(&bytes[..]))
        }
        Value::Timestamp(microseconds) => {
            // 8 bytes, big-endian i64 microseconds since 2000-01-01
            encoder.encode_field(&Some(&microseconds.to_be_bytes()[..]))
        }
        Value::Json(s) => {
            // JSON binary format is just the text bytes
            encoder.encode_field(&Some(s.as_bytes()))
        }
        Value::Jsonb(s) => {
            // JSONB binary format: version byte (0x01) + jsonb data
            let mut buf = BytesMut::with_capacity(1 + s.len());
            buf.put_u8(1); // JSONB version
            buf.put_slice(s.as_bytes());
            encoder.encode_field(&Some(&buf[..]))
        }
    }
}
```

## Error Responses — SQLSTATE Codes

Proper error codes are critical for ORM compatibility. ORMs parse SQLSTATE codes to decide retry behavior, migration state, and error display.

```rust
use pgwire::error::{ErrorInfo, PgWireError};

/// Build a Postgres error with severity, SQLSTATE code, and message.
fn pg_error(severity: &str, code: &str, message: String) -> PgWireError {
    PgWireError::UserError(Box::new(ErrorInfo::new(
        severity.to_string(),
        code.to_string(),
        message,
    )))
}

// --- Common SQLSTATE codes ---

// Class 00 — Successful Completion
// "00000" success

// Class 23 — Integrity Constraint Violation
fn unique_violation(detail: &str) -> PgWireError {
    pg_error("ERROR", "23505", format!("duplicate key value violates unique constraint: {detail}"))
}
fn not_null_violation(column: &str) -> PgWireError {
    pg_error("ERROR", "23502", format!("null value in column \"{column}\" violates not-null constraint"))
}
fn foreign_key_violation(detail: &str) -> PgWireError {
    pg_error("ERROR", "23503", format!("insert or update violates foreign key constraint: {detail}"))
}
fn check_violation(constraint: &str) -> PgWireError {
    pg_error("ERROR", "23514", format!("new row violates check constraint \"{constraint}\""))
}

// Class 42 — Syntax Error or Access Rule Violation
fn syntax_error(msg: &str) -> PgWireError {
    pg_error("ERROR", "42601", format!("syntax error: {msg}"))
}
fn undefined_table(name: &str) -> PgWireError {
    pg_error("ERROR", "42P01", format!("relation \"{name}\" does not exist"))
}
fn undefined_column(name: &str) -> PgWireError {
    pg_error("ERROR", "42703", format!("column \"{name}\" does not exist"))
}
fn duplicate_table(name: &str) -> PgWireError {
    pg_error("ERROR", "42P07", format!("relation \"{name}\" already exists"))
}

// Class 22 — Data Exception
fn invalid_text_representation(msg: &str) -> PgWireError {
    pg_error("ERROR", "22P02", format!("invalid input syntax: {msg}"))
}
fn division_by_zero() -> PgWireError {
    pg_error("ERROR", "22012", "division by zero".to_string())
}
fn numeric_value_out_of_range() -> PgWireError {
    pg_error("ERROR", "22003", "numeric value out of range".to_string())
}

// Class 25 — Invalid Transaction State
fn no_active_transaction() -> PgWireError {
    pg_error("WARNING", "25P01", "there is no transaction in progress".to_string())
}

// Class 40 — Transaction Rollback
fn serialization_failure() -> PgWireError {
    pg_error("ERROR", "40001", "could not serialize access due to concurrent update".to_string())
}
fn deadlock_detected() -> PgWireError {
    pg_error("ERROR", "40P01", "deadlock detected".to_string())
}

// Class 0A — Feature Not Supported
fn feature_not_supported(feature: &str) -> PgWireError {
    pg_error("ERROR", "0A000", format!("feature not supported: {feature}"))
}

// Class 53 — Insufficient Resources
fn too_many_connections() -> PgWireError {
    pg_error("FATAL", "53300", "too many connections".to_string())
}

// Class 57 — Operator Intervention
fn admin_shutdown() -> PgWireError {
    pg_error("FATAL", "57P01", "terminating connection due to administrator command".to_string())
}
```

### SQLSTATE Code Quick Reference

| Code | Name | When to Use |
|---|---|---|
| `00000` | successful_completion | Query succeeded |
| `22003` | numeric_value_out_of_range | Integer overflow, etc. |
| `22012` | division_by_zero | Division by zero |
| `22P02` | invalid_text_representation | Bad type cast |
| `23502` | not_null_violation | NULL in NOT NULL column |
| `23503` | foreign_key_violation | FK constraint fails |
| `23505` | unique_violation | Duplicate key |
| `23514` | check_violation | CHECK constraint fails |
| `25P01` | no_active_sql_transaction | COMMIT/ROLLBACK with no txn |
| `40001` | serialization_failure | Serializable isolation conflict |
| `40P01` | deadlock_detected | Deadlock |
| `42601` | syntax_error | Parse failure |
| `42703` | undefined_column | Column not found |
| `42P01` | undefined_table | Table not found |
| `42P07` | duplicate_table | CREATE TABLE that exists |
| `0A000` | feature_not_supported | Unimplemented SQL |
| `53300` | too_many_connections | Connection limit |
| `57P01` | admin_shutdown | Server shutting down |
| `XX000` | internal_error | Bug in your engine |

## Authentication

### NoopStartupHandler (No Auth)

```rust
use pgwire::api::auth::noop::NoopStartupHandler;

// Used in development — accepts all connections
let authenticator = Arc::new(NoopStartupHandler);
```

### Cleartext Password

```rust
use async_trait::async_trait;
use pgwire::api::auth::{StartupHandler, Password, LoginInfo, ServerParameterProvider};
use pgwire::api::ClientInfo;
use pgwire::error::PgWireResult;
use pgwire::messages::startup::Authentication;

pub struct CleartextAuthHandler {
    password_store: Arc<dyn PasswordStore + Send + Sync>,
}

#[async_trait]
impl StartupHandler for CleartextAuthHandler {
    async fn on_startup<C: ClientInfo + Unpin + Send>(
        &self,
        client: &mut C,
        message: PgWireFrontendMessage,
    ) -> PgWireResult<()> {
        // Send AuthenticationCleartextPassword
        // The pgwire crate handles the message flow — you implement the check
        todo!("see pgwire auth examples")
    }
}
```

### MD5 Password

```rust
/// MD5 auth: server sends a 4-byte salt, client responds with:
///   "md5" + md5(md5(password + username) + salt)
pub struct Md5AuthHandler {
    password_store: Arc<dyn PasswordStore + Send + Sync>,
}

/// Verify MD5-hashed password from client.
fn verify_md5_password(
    username: &str,
    password_hash: &str, // stored as md5(password + username)
    salt: &[u8; 4],
    client_response: &str,
) -> bool {
    use md5::{Md5, Digest};

    // Step 1: inner = md5(password + username) — this is what we store
    // Step 2: outer = "md5" + md5(inner_hex + salt)
    let mut hasher = Md5::new();
    hasher.update(password_hash.as_bytes());
    hasher.update(salt);
    let expected = format!("md5{:x}", hasher.finalize());

    expected == client_response
}
```

### SCRAM-SHA-256 (Recommended for Production)

```rust
/// SCRAM-SHA-256 is the modern auth mechanism (Postgres 10+).
/// The pgwire crate provides `ScramSha256StartupHandler` or you can implement
/// the SASL exchange manually.
///
/// Flow:
/// 1. Server sends AuthenticationSASL with mechanism list ["SCRAM-SHA-256"]
/// 2. Client sends SASLInitialResponse with client-first-message
/// 3. Server sends SASLContinue with server-first-message (salt + iteration count)
/// 4. Client sends SASLResponse with client-final-message (proof)
/// 5. Server verifies proof, sends SASLFinal with server signature
/// 6. Server sends AuthenticationOk
///
/// Key: store SCRAM credentials (salt, iteration count, StoredKey, ServerKey)
/// rather than plaintext passwords.

pub struct ScramCredential {
    pub salt: Vec<u8>,
    pub iterations: u32,
    pub stored_key: [u8; 32],
    pub server_key: [u8; 32],
}

/// Generate SCRAM credential from a plaintext password (done once at user creation).
fn generate_scram_credential(password: &str, iterations: u32) -> ScramCredential {
    use rand::RngCore;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    use pbkdf2::pbkdf2_hmac;

    let mut salt = vec![0u8; 16];
    rand::rng().fill_bytes(&mut salt);

    let mut salted_password = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut salted_password);

    let client_key = {
        let mut mac = Hmac::<Sha256>::new_from_slice(&salted_password).unwrap();
        mac.update(b"Client Key");
        mac.finalize().into_bytes()
    };

    let stored_key = {
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(&client_key);
        hasher.finalize().into()
    };

    let server_key = {
        let mut mac = Hmac::<Sha256>::new_from_slice(&salted_password).unwrap();
        mac.update(b"Server Key");
        mac.finalize().into_bytes()
    };

    ScramCredential {
        salt,
        iterations,
        stored_key,
        server_key: server_key.into(),
    }
}
```

### Certificate-Based Authentication (mTLS)

```rust
/// mTLS auth: client presents a TLS certificate, server validates it.
/// Combine with the TLS section below — configure tokio-rustls with
/// client certificate verification.
///
/// In the StartupHandler, extract the CN (Common Name) from the client cert
/// and match it against allowed users.

use tokio_rustls::server::TlsStream;

fn extract_client_cn(tls_stream: &TlsStream<tokio::net::TcpStream>) -> Option<String> {
    let (_, server_conn) = tls_stream.get_ref();
    let certs = server_conn.peer_certificates()?;
    let cert = certs.first()?;

    // Parse X.509 and extract CN
    let parsed = x509_parser::parse_x509_certificate(cert.as_ref()).ok()?.1;
    let cn = parsed
        .subject()
        .iter_common_name()
        .next()?
        .as_str()
        .ok()?
        .to_string();

    Some(cn)
}
```

## TLS with tokio-rustls

```rust
use std::fs::File;
use std::io::BufReader;
use std::sync::Arc;
use tokio_rustls::TlsAcceptor;
use rustls::ServerConfig;
use rustls_pemfile::{certs, private_key};

fn build_tls_acceptor(
    cert_path: &str,
    key_path: &str,
) -> Result<TlsAcceptor, Box<dyn std::error::Error>> {
    let cert_file = &mut BufReader::new(File::open(cert_path)?);
    let key_file = &mut BufReader::new(File::open(key_path)?);

    let cert_chain: Vec<_> = certs(cert_file).collect::<Result<_, _>>()?;
    let key = private_key(key_file)?
        .ok_or("no private key found")?;

    let config = ServerConfig::builder()
        .with_no_client_auth() // or .with_client_cert_verifier() for mTLS
        .with_single_cert(cert_chain, key)?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

// In server startup:
let tls_acceptor = build_tls_acceptor("server.crt", "server.key")?;

// Pass to process_socket:
process_socket(
    socket,
    Some(tls_acceptor.clone()), // TLS enabled
    handler,
    authenticator,
    copy_handler,
)
.await?;
```

## System Catalog Queries (ORM Compatibility)

ORMs issue introspection queries against `pg_catalog` and `information_schema` before running any user queries. Your server must handle these or ORMs will refuse to connect.

### pg_catalog.pg_type

Every ORM queries this to resolve type OIDs.

```rust
/// Minimal pg_type rows your server must return.
/// ORMs call: SELECT oid, typname, typnamespace, typlen, typtype FROM pg_catalog.pg_type
fn pg_type_rows() -> Vec<PgTypeRow> {
    vec![
        PgTypeRow { oid: 16,   typname: "bool",       typnamespace: 11, typlen: 1,  typtype: 'b', typbasetype: 0, typarray: 1000 },
        PgTypeRow { oid: 17,   typname: "bytea",      typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 1001 },
        PgTypeRow { oid: 20,   typname: "int8",       typnamespace: 11, typlen: 8,  typtype: 'b', typbasetype: 0, typarray: 1016 },
        PgTypeRow { oid: 21,   typname: "int2",       typnamespace: 11, typlen: 2,  typtype: 'b', typbasetype: 0, typarray: 1005 },
        PgTypeRow { oid: 23,   typname: "int4",       typnamespace: 11, typlen: 4,  typtype: 'b', typbasetype: 0, typarray: 1007 },
        PgTypeRow { oid: 25,   typname: "text",       typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 1009 },
        PgTypeRow { oid: 26,   typname: "oid",        typnamespace: 11, typlen: 4,  typtype: 'b', typbasetype: 0, typarray: 1028 },
        PgTypeRow { oid: 114,  typname: "json",       typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 199  },
        PgTypeRow { oid: 700,  typname: "float4",     typnamespace: 11, typlen: 4,  typtype: 'b', typbasetype: 0, typarray: 1021 },
        PgTypeRow { oid: 701,  typname: "float8",     typnamespace: 11, typlen: 8,  typtype: 'b', typbasetype: 0, typarray: 1022 },
        PgTypeRow { oid: 1042, typname: "bpchar",     typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 1014 },
        PgTypeRow { oid: 1043, typname: "varchar",    typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 1015 },
        PgTypeRow { oid: 1082, typname: "date",       typnamespace: 11, typlen: 4,  typtype: 'b', typbasetype: 0, typarray: 1182 },
        PgTypeRow { oid: 1083, typname: "time",       typnamespace: 11, typlen: 8,  typtype: 'b', typbasetype: 0, typarray: 1183 },
        PgTypeRow { oid: 1114, typname: "timestamp",  typnamespace: 11, typlen: 8,  typtype: 'b', typbasetype: 0, typarray: 1115 },
        PgTypeRow { oid: 1184, typname: "timestamptz",typnamespace: 11, typlen: 8,  typtype: 'b', typbasetype: 0, typarray: 1185 },
        PgTypeRow { oid: 1700, typname: "numeric",    typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 1231 },
        PgTypeRow { oid: 2950, typname: "uuid",       typnamespace: 11, typlen: 16, typtype: 'b', typbasetype: 0, typarray: 2951 },
        PgTypeRow { oid: 3802, typname: "jsonb",      typnamespace: 11, typlen: -1, typtype: 'b', typbasetype: 0, typarray: 3807 },
    ]
}
```

### information_schema.tables

```rust
/// ORMs call: SELECT table_name, table_schema, table_type
///   FROM information_schema.tables WHERE table_schema = 'public'
fn information_schema_tables(catalog: &Catalog) -> Vec<InfoSchemaTable> {
    catalog
        .list_tables()
        .iter()
        .map(|table| InfoSchemaTable {
            table_catalog: "your_db".to_string(),
            table_schema: table.schema.clone(), // typically "public"
            table_name: table.name.clone(),
            table_type: if table.is_view { "VIEW" } else { "BASE TABLE" }.to_string(),
        })
        .collect()
}
```

### information_schema.columns

```rust
/// ORMs call: SELECT column_name, data_type, is_nullable, column_default, ordinal_position,
///   character_maximum_length, numeric_precision, udt_name
///   FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
fn information_schema_columns(catalog: &Catalog, table: &str) -> Vec<InfoSchemaColumn> {
    let table_def = catalog.get_table(table).unwrap();
    table_def
        .columns
        .iter()
        .enumerate()
        .map(|(i, col)| InfoSchemaColumn {
            table_catalog: "your_db".to_string(),
            table_schema: "public".to_string(),
            table_name: table.to_string(),
            column_name: col.name.clone(),
            ordinal_position: (i + 1) as i32,
            column_default: col.default_expr.clone(),
            is_nullable: if col.nullable { "YES" } else { "NO" }.to_string(),
            data_type: logical_type_to_sql_name(&col.data_type),
            character_maximum_length: col.max_length,
            numeric_precision: numeric_precision_for(&col.data_type),
            udt_name: logical_type_to_pg_name(&col.data_type),
        })
        .collect()
}
```

### pg_catalog.pg_namespace

```rust
/// Prisma and SQLAlchemy query this for schema listing.
/// SELECT oid, nspname FROM pg_catalog.pg_namespace
fn pg_namespace_rows() -> Vec<PgNamespaceRow> {
    vec![
        PgNamespaceRow { oid: 11,    nspname: "pg_catalog".to_string() },
        PgNamespaceRow { oid: 2200,  nspname: "public".to_string() },
        PgNamespaceRow { oid: 12876, nspname: "information_schema".to_string() },
    ]
}
```

### Additional Catalog Queries ORMs Commonly Issue

```rust
/// pg_catalog.pg_class — table/index metadata
/// SELECT relname, relkind, relnamespace FROM pg_catalog.pg_class
///   WHERE relkind IN ('r', 'v') AND relnamespace = 2200

/// pg_catalog.pg_attribute — column details by OID
/// SELECT attname, atttypid, attnotnull, attnum FROM pg_catalog.pg_attribute
///   WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped

/// pg_catalog.pg_index — index metadata
/// SELECT indexrelid, indrelid, indkey, indisunique, indisprimary
///   FROM pg_catalog.pg_index WHERE indrelid = $1

/// pg_catalog.pg_constraint — constraints
/// SELECT conname, contype, conrelid, confrelid, conkey, confkey
///   FROM pg_catalog.pg_constraint WHERE conrelid = $1

/// pg_catalog.pg_description — column/table comments
/// SELECT objoid, objsubid, description FROM pg_catalog.pg_description
///   WHERE objoid = $1

/// Prisma-specific: version query
/// SELECT version() → return "PostgreSQL 15.0 (your-engine-name)"
/// SHOW server_version → "15.0"
/// SHOW server_encoding → "UTF8"
```

## Dialect Handling

When your engine supports multiple wire protocols, SQL behavior must match the connected dialect.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    Postgres,
    MySQL,
    SQLite,
}

// --- Boolean formatting ---
pub fn format_boolean(val: bool, dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::Postgres => if val { "t" } else { "f" }.to_string(),
        SqlDialect::MySQL => if val { "1" } else { "0" }.to_string(),
        SqlDialect::SQLite => if val { "1" } else { "0" }.to_string(),
    }
}

// --- RETURNING clause ---
pub fn supports_returning(dialect: SqlDialect) -> bool {
    match dialect {
        SqlDialect::Postgres => true,  // INSERT ... RETURNING id, created_at
        SqlDialect::MySQL => false,    // Must use LAST_INSERT_ID()
        SqlDialect::SQLite => true,    // Supported since 3.35.0
    }
}

/// Rewrite INSERT ... RETURNING for dialects that lack it.
pub fn rewrite_insert_returning(
    table: &str,
    columns: &[String],
    values: &str,
    returning: &[String],
    dialect: SqlDialect,
) -> Vec<String> {
    match dialect {
        SqlDialect::Postgres | SqlDialect::SQLite => {
            vec![format!(
                "INSERT INTO {table} ({cols}) VALUES ({values}) RETURNING {ret}",
                cols = columns.join(", "),
                ret = returning.join(", "),
            )]
        }
        SqlDialect::MySQL => {
            // MySQL: execute INSERT, then SELECT LAST_INSERT_ID()
            vec![
                format!(
                    "INSERT INTO {table} ({cols}) VALUES ({values})",
                    cols = columns.join(", "),
                ),
                format!(
                    "SELECT {ret} FROM {table} WHERE id = LAST_INSERT_ID()",
                    ret = returning.join(", "),
                ),
            ]
        }
    }
}

// --- UPSERT syntax ---
pub fn upsert_sql(
    table: &str,
    columns: &[String],
    conflict_column: &str,
    update_columns: &[String],
    dialect: SqlDialect,
) -> String {
    let cols = columns.join(", ");
    let placeholders = (1..=columns.len())
        .map(|i| match dialect {
            SqlDialect::Postgres => format!("${i}"),
            SqlDialect::MySQL | SqlDialect::SQLite => "?".to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ");

    match dialect {
        SqlDialect::Postgres => {
            let updates = update_columns
                .iter()
                .map(|c| format!("{c} = EXCLUDED.{c}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "INSERT INTO {table} ({cols}) VALUES ({placeholders}) \
                 ON CONFLICT ({conflict_column}) DO UPDATE SET {updates}"
            )
        }
        SqlDialect::MySQL => {
            let updates = update_columns
                .iter()
                .map(|c| format!("{c} = VALUES({c})"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "INSERT INTO `{table}` ({cols}) VALUES ({placeholders}) \
                 ON DUPLICATE KEY UPDATE {updates}"
            )
        }
        SqlDialect::SQLite => {
            let updates = update_columns
                .iter()
                .map(|c| format!("{c} = excluded.{c}"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "INSERT INTO {table} ({cols}) VALUES ({placeholders}) \
                 ON CONFLICT ({conflict_column}) DO UPDATE SET {updates}"
            )
        }
    }
}

// --- String concatenation ---
pub fn concat_strings(parts: &[&str], dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::Postgres | SqlDialect::SQLite => {
            // Postgres/SQLite: 'a' || 'b' || 'c'
            parts
                .iter()
                .map(|p| format!("'{p}'"))
                .collect::<Vec<_>>()
                .join(" || ")
        }
        SqlDialect::MySQL => {
            // MySQL: CONCAT('a', 'b', 'c')
            let inner = parts
                .iter()
                .map(|p| format!("'{p}'"))
                .collect::<Vec<_>>()
                .join(", ");
            format!("CONCAT({inner})")
        }
    }
}

// --- UUID generation ---
pub fn generate_uuid_sql(dialect: SqlDialect) -> &'static str {
    match dialect {
        SqlDialect::Postgres => "gen_random_uuid()",
        SqlDialect::MySQL => "UUID()",
        SqlDialect::SQLite => "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))",
    }
}

// --- Current timestamp ---
pub fn current_timestamp_sql(dialect: SqlDialect) -> &'static str {
    match dialect {
        SqlDialect::Postgres => "NOW()",          // returns TIMESTAMPTZ
        SqlDialect::MySQL => "NOW()",             // returns DATETIME
        SqlDialect::SQLite => "datetime('now')",  // returns TEXT
    }
}

// --- Identifier quoting ---
pub fn quote_identifier(name: &str, dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::Postgres | SqlDialect::SQLite => format!("\"{name}\""),
        SqlDialect::MySQL => format!("`{name}`"),
    }
}

// --- LIMIT/OFFSET ---
pub fn limit_offset_sql(limit: u64, offset: u64, dialect: SqlDialect) -> String {
    // All three dialects support LIMIT ... OFFSET ... syntax
    match dialect {
        SqlDialect::Postgres | SqlDialect::MySQL | SqlDialect::SQLite => {
            format!("LIMIT {limit} OFFSET {offset}")
        }
    }
}

// --- Type casting ---
pub fn cast_sql(expr: &str, target_type: &str, dialect: SqlDialect) -> String {
    match dialect {
        SqlDialect::Postgres => format!("{expr}::{target_type}"), // Postgres shorthand
        SqlDialect::MySQL | SqlDialect::SQLite => format!("CAST({expr} AS {target_type})"),
    }
}
```

## MySQL Protocol

Lighter-weight coverage. Use when you need MySQL client compatibility alongside pgwire.

### Handshake Sequence

```
Server → Client: Initial Handshake Packet (protocol version, server version, salt, capabilities)
Client → Server: Handshake Response (username, auth data, database, capabilities)
Server → Client: OK Packet or ERR Packet
```

```rust
/// MySQL protocol handshake — manual implementation.
/// For production, consider the `opensrv-mysql` crate.

use bytes::{Buf, BufMut, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MYSQL_PROTOCOL_VERSION: u8 = 10; // MySQL 3.21.0+

/// MySQL capability flags (bitfield).
bitflags::bitflags! {
    pub struct CapabilityFlags: u32 {
        const CLIENT_LONG_PASSWORD    = 0x0000_0001;
        const CLIENT_FOUND_ROWS       = 0x0000_0002;
        const CLIENT_LONG_FLAG        = 0x0000_0004;
        const CLIENT_CONNECT_WITH_DB  = 0x0000_0008;
        const CLIENT_PROTOCOL_41      = 0x0000_0200;
        const CLIENT_SECURE_CONNECTION = 0x0000_8000;
        const CLIENT_PLUGIN_AUTH      = 0x0008_0000;
        const CLIENT_DEPRECATE_EOF    = 0x0100_0000;
    }
}

/// Build the initial handshake packet the server sends.
fn build_handshake_packet(
    connection_id: u32,
    server_version: &str,
    auth_plugin_data: &[u8; 20],
) -> BytesMut {
    let mut buf = BytesMut::with_capacity(128);

    // Protocol version
    buf.put_u8(MYSQL_PROTOCOL_VERSION);
    // Server version (null-terminated)
    buf.put_slice(server_version.as_bytes());
    buf.put_u8(0);
    // Connection ID
    buf.put_u32_le(connection_id);
    // Auth plugin data part 1 (8 bytes)
    buf.put_slice(&auth_plugin_data[..8]);
    // Filler
    buf.put_u8(0);
    // Capability flags (lower 2 bytes)
    let caps = CapabilityFlags::CLIENT_PROTOCOL_41
        | CapabilityFlags::CLIENT_SECURE_CONNECTION
        | CapabilityFlags::CLIENT_PLUGIN_AUTH;
    buf.put_u16_le(caps.bits() as u16);
    // Character set (utf8mb4 = 45)
    buf.put_u8(45);
    // Status flags
    buf.put_u16_le(0x0002); // SERVER_STATUS_AUTOCOMMIT
    // Capability flags (upper 2 bytes)
    buf.put_u16_le((caps.bits() >> 16) as u16);
    // Length of auth plugin data
    buf.put_u8(21); // 8 + 13 (part2 includes null terminator)
    // Reserved (10 zero bytes)
    buf.put_slice(&[0u8; 10]);
    // Auth plugin data part 2 (13 bytes: 12 data + null terminator)
    buf.put_slice(&auth_plugin_data[8..20]);
    buf.put_u8(0);
    // Auth plugin name (null-terminated)
    buf.put_slice(b"mysql_native_password\0");

    buf
}
```

### COM_QUERY — Simple Queries

```rust
/// MySQL COM_QUERY response: column definitions + rows + EOF.
///
/// Wire format:
///   Column Count packet
///   N x Column Definition packets
///   EOF packet (or OK if CLIENT_DEPRECATE_EOF)
///   N x Result Row packets
///   EOF packet (or OK if CLIENT_DEPRECATE_EOF)

const COM_QUERY: u8 = 0x03;

fn encode_mysql_text_resultset(
    columns: &[ColumnDef],
    rows: &[Vec<Value>],
    buf: &mut BytesMut,
) {
    // Column count
    encode_length_encoded_int(buf, columns.len() as u64);

    // Column definitions
    for col in columns {
        encode_column_definition(buf, col);
    }

    // EOF marker (if not using CLIENT_DEPRECATE_EOF)
    buf.put_slice(&[0xfe, 0x00, 0x00, 0x00, 0x00]); // EOF packet

    // Rows — each column value is length-encoded string or 0xfb for NULL
    for row in rows {
        let mut row_buf = BytesMut::new();
        for value in row {
            match value {
                Value::Null => row_buf.put_u8(0xfb),
                other => {
                    let text = value_to_mysql_text(other);
                    encode_length_encoded_string(&mut row_buf, &text);
                }
            }
        }
        buf.extend_from_slice(&row_buf);
    }

    // Final EOF
    buf.put_slice(&[0xfe, 0x00, 0x00, 0x00, 0x00]);
}
```

### COM_STMT_PREPARE / COM_STMT_EXECUTE

```rust
const COM_STMT_PREPARE: u8 = 0x16;
const COM_STMT_EXECUTE: u8 = 0x17;
const COM_STMT_CLOSE: u8 = 0x19;

/// Prepared statement lifecycle:
/// 1. Client sends COM_STMT_PREPARE with SQL
/// 2. Server responds with statement_id, column_count, param_count
/// 3. Client sends COM_STMT_EXECUTE with statement_id + binary parameter values
/// 4. Server responds with binary resultset
/// 5. Client sends COM_STMT_CLOSE when done

fn handle_stmt_prepare(sql: &str, catalog: &Catalog) -> PreparedStatement {
    let plan = catalog.compile(sql, &[]).expect("parse");
    let stmt_id = catalog.next_statement_id(); // monotonic u32

    PreparedStatement {
        id: stmt_id,
        sql: sql.to_string(),
        param_count: plan.parameters.len() as u16,
        column_count: plan.output_columns.len() as u16,
        plan,
    }
}

fn encode_stmt_prepare_ok(stmt: &PreparedStatement, buf: &mut BytesMut) {
    buf.put_u8(0x00); // OK status
    buf.put_u32_le(stmt.id);
    buf.put_u16_le(stmt.column_count);
    buf.put_u16_le(stmt.param_count);
    buf.put_u8(0x00); // filler
    buf.put_u16_le(0); // warning count
}
```

### MySQL Type IDs vs Postgres OIDs

| MySQL Type ID | MySQL Type | Equivalent Postgres OID | Notes |
|---|---|---|---|
| `0x01` | TINYINT | 21 (INT2) | MySQL has no separate bool type; TINYINT(1) = bool |
| `0x02` | SMALLINT | 21 (INT2) | |
| `0x03` | INT | 23 (INT4) | |
| `0x08` | BIGINT | 20 (INT8) | |
| `0x04` | FLOAT | 700 (FLOAT4) | |
| `0x05` | DOUBLE | 701 (FLOAT8) | |
| `0x00` | DECIMAL | 1700 (NUMERIC) | |
| `0x0f` | VARCHAR | 1043 (VARCHAR) | |
| `0xfc` | BLOB/TEXT | 25 (TEXT) / 17 (BYTEA) | |
| `0xf5` | JSON | 114 (JSON) | |
| `0x0a` | DATE | 1082 (DATE) | |
| `0x0b` | TIME | 1083 (TIME) | |
| `0x0c` | DATETIME | 1114 (TIMESTAMP) | |
| `0x07` | TIMESTAMP | 1184 (TIMESTAMPTZ) | MySQL TIMESTAMP is UTC-converted |

### MySQL-Specific Behaviors

```rust
/// AUTO_INCREMENT: MySQL returns the last inserted auto-increment value.
/// After INSERT, respond with an OK packet containing `last_insert_id`.
fn encode_mysql_ok_packet(affected_rows: u64, last_insert_id: u64, buf: &mut BytesMut) {
    buf.put_u8(0x00); // OK header
    encode_length_encoded_int(buf, affected_rows);
    encode_length_encoded_int(buf, last_insert_id);
    buf.put_u16_le(0x0002); // SERVER_STATUS_AUTOCOMMIT
    buf.put_u16_le(0);      // warnings
}

/// Backtick quoting: MySQL uses backticks for identifiers.
/// SELECT `column name` FROM `table name`
/// vs Postgres: SELECT "column name" FROM "table name"

/// mysql_native_password scramble:
/// SHA1(password) XOR SHA1(scramble + SHA1(SHA1(password)))
fn mysql_native_password_check(
    password_sha1: &[u8; 20], // stored SHA1(password)
    scramble: &[u8; 20],
    client_auth_data: &[u8],
) -> bool {
    use sha1::{Sha1, Digest};

    // double_sha1 = SHA1(SHA1(password))
    let double_sha1 = {
        let mut hasher = Sha1::new();
        hasher.update(password_sha1);
        hasher.finalize()
    };

    // scramble_hash = SHA1(scramble + double_sha1)
    let scramble_hash = {
        let mut hasher = Sha1::new();
        hasher.update(scramble);
        hasher.update(&double_sha1);
        hasher.finalize()
    };

    // expected = SHA1(password) XOR scramble_hash
    let expected: Vec<u8> = password_sha1
        .iter()
        .zip(scramble_hash.iter())
        .map(|(a, b)| a ^ b)
        .collect();

    expected == client_auth_data
}
```

## SQLite Embedded Mode

No network protocol — SQLite is an embedded database accessed via function calls. Two approaches in Rust.

### rusqlite (C FFI Wrapper)

```toml
[dependencies]
rusqlite = { version = "0.32", features = ["bundled"] } # bundles SQLite C source
```

```rust
use rusqlite::{Connection, params, Result};

fn sqlite_embedded_example() -> Result<()> {
    // Open in-memory or file-backed
    let conn = Connection::open_in_memory()?;
    // let conn = Connection::open("data.db")?;

    // DDL
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE,
            created_at TEXT DEFAULT (datetime('now'))
        )"
    )?;

    // INSERT with parameters
    conn.execute(
        "INSERT INTO users (name, email) VALUES (?1, ?2)",
        params!["Alice", "alice@example.com"],
    )?;

    let last_id = conn.last_insert_rowid();

    // SELECT with row mapping
    let mut stmt = conn.prepare(
        "SELECT id, name, email, created_at FROM users WHERE id = ?1"
    )?;

    let user = stmt.query_row(params![last_id], |row| {
        Ok(User {
            id: row.get(0)?,
            name: row.get(1)?,
            email: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;

    // Iterate multiple rows
    let mut stmt = conn.prepare("SELECT id, name FROM users")?;
    let users = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    for user in users {
        let (id, name) = user?;
        println!("{id}: {name}");
    }

    Ok(())
}
```

### SQLite C FFI Signatures

When you need direct FFI (bypassing rusqlite) for performance or custom VFS:

```rust
// Core C API — these are what rusqlite wraps
extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        db: *mut *mut sqlite3,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;

    fn sqlite3_prepare_v2(
        db: *mut sqlite3,
        sql: *const c_char,
        nbyte: c_int,
        stmt: *mut *mut sqlite3_stmt,
        tail: *mut *const c_char,
    ) -> c_int;

    fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;
    fn sqlite3_close_v2(db: *mut sqlite3) -> c_int;

    fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, idx: c_int, val: i64) -> c_int;
    fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, idx: c_int, val: f64) -> c_int;
    fn sqlite3_bind_text(
        stmt: *mut sqlite3_stmt,
        idx: c_int,
        val: *const c_char,
        len: c_int,
        destructor: *const c_void, // SQLITE_TRANSIENT = -1
    ) -> c_int;
    fn sqlite3_bind_blob(
        stmt: *mut sqlite3_stmt,
        idx: c_int,
        val: *const c_void,
        len: c_int,
        destructor: *const c_void,
    ) -> c_int;
    fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, idx: c_int) -> c_int;

    fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, idx: c_int) -> i64;
    fn sqlite3_column_double(stmt: *mut sqlite3_stmt, idx: c_int) -> f64;
    fn sqlite3_column_text(stmt: *mut sqlite3_stmt, idx: c_int) -> *const c_uchar;
    fn sqlite3_column_blob(stmt: *mut sqlite3_stmt, idx: c_int) -> *const c_void;
    fn sqlite3_column_bytes(stmt: *mut sqlite3_stmt, idx: c_int) -> c_int;
    fn sqlite3_column_type(stmt: *mut sqlite3_stmt, idx: c_int) -> c_int;

    fn sqlite3_changes(db: *mut sqlite3) -> c_int;
    fn sqlite3_errmsg(db: *mut sqlite3) -> *const c_char;
}

// Result codes
const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;

// Column type constants
const SQLITE_INTEGER: c_int = 1;
const SQLITE_FLOAT: c_int = 2;
const SQLITE_TEXT: c_int = 3;
const SQLITE_BLOB: c_int = 4;
const SQLITE_NULL: c_int = 5;
```

### SQLite Type Affinity Rules

SQLite uses type affinity, not strict types. The declared column type maps to one of five affinities:

| Declared Type Contains | Affinity | Storage Classes Used |
|---|---|---|
| "INT" | INTEGER | INTEGER |
| "CHAR", "CLOB", "TEXT" | TEXT | TEXT |
| "BLOB" or no type | BLOB | BLOB (or any) |
| "REAL", "FLOA", "DOUB" | REAL | REAL, INTEGER |
| Otherwise | NUMERIC | INTEGER, REAL, TEXT |

```rust
/// Determine SQLite type affinity from a declared column type.
fn sqlite_type_affinity(declared_type: &str) -> &'static str {
    let upper = declared_type.to_uppercase();
    if upper.contains("INT") {
        "INTEGER"
    } else if upper.contains("CHAR") || upper.contains("CLOB") || upper.contains("TEXT") {
        "TEXT"
    } else if upper.contains("BLOB") || upper.is_empty() {
        "BLOB"
    } else if upper.contains("REAL") || upper.contains("FLOA") || upper.contains("DOUB") {
        "REAL"
    } else {
        "NUMERIC"
    }
}
```

## ORM Compatibility

ORMs query system catalogs, expect specific behaviors, and rely on protocol features. This table summarizes what each ORM needs from your wire protocol implementation.

| ORM | Protocol | Key Requirements |
|---|---|---|
| **Prisma** | pgwire | RETURNING, `pg_catalog` queries, `information_schema`, `pg_type` lookups, transaction blocks, `SET` commands, `::regtype` casts |
| **Drizzle** | pgwire | Prepared statements (extended protocol), transaction blocks (`BEGIN`/`COMMIT`), `pg_catalog.pg_type` |
| **SQLAlchemy** | pgwire/MySQL | Full introspection (`pg_type`, `pg_attribute`, `pg_index`, `pg_constraint`), SAVEPOINT support, `::` casts |
| **TypeORM** | pgwire/MySQL | Migrations DDL, column metadata via `information_schema.columns`, `pg_catalog.pg_class` |
| **Diesel** | pgwire | Strong type mapping, custom type support via `pg_type`, `RETURNING`, binary format support |
| **GORM** | pgwire/MySQL | Auto-migrate introspection (`information_schema.columns`), `RETURNING` (Postgres mode) |
| **Sequelize** | pgwire/MySQL | `information_schema`, `SHOW` commands (MySQL mode), transaction isolation levels |
| **Knex.js** | pgwire/MySQL | `information_schema.columns`, `pg_catalog.pg_type`, raw query passthrough |
| **node-postgres (pg)** | pgwire | Extended query protocol, type parsers keyed on OID, `COPY` protocol (optional) |
| **libpq / psql** | pgwire | Full protocol compliance, `\d` metadata queries against `pg_catalog`, COPY |

### Prisma-Specific Startup Queries

Prisma issues these queries on every connection. All must return valid results.

```rust
/// Prisma introspection queries your server must handle:
///
/// 1. SELECT current_schema()
///    → Return "public"
///
/// 2. SELECT version()
///    → Return "PostgreSQL 15.0 (your-engine)"
///
/// 3. SHOW server_version
///    → Return "15.0"
///
/// 4. SELECT oid, typname FROM pg_type
///    → Return the pg_type_rows() defined above
///
/// 5. SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
///    → Return your tables
///
/// 6. SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
///    → Return column metadata for the given table
///
/// 7. SELECT conname, contype, ... FROM pg_catalog.pg_constraint
///      JOIN pg_catalog.pg_class ON ...
///    → Return constraints (PK, FK, UNIQUE)
///
/// 8. SET search_path = 'public'
///    → Acknowledge with Tag::new("SET")
///
/// 9. BEGIN / COMMIT / ROLLBACK
///    → Transaction management

fn handle_prisma_introspection(query: &str, catalog: &Catalog) -> Option<ResultSet> {
    let normalized = query.trim().to_lowercase();

    if normalized == "select current_schema()" {
        return Some(single_value_result("current_schema", Value::Text("public".into())));
    }

    if normalized == "select version()" {
        return Some(single_value_result(
            "version",
            Value::Text("PostgreSQL 15.0 (your-engine)".into()),
        ));
    }

    if normalized.starts_with("show server_version") {
        return Some(single_value_result("server_version", Value::Text("15.0".into())));
    }

    if normalized.starts_with("show server_encoding") {
        return Some(single_value_result("server_encoding", Value::Text("UTF8".into())));
    }

    if normalized.contains("pg_catalog.pg_type") || normalized.contains("pg_type") {
        return Some(build_pg_type_result());
    }

    if normalized.contains("information_schema.tables") {
        return Some(build_information_schema_tables(catalog));
    }

    if normalized.contains("information_schema.columns") {
        let table = extract_table_name_from_query(query)?;
        return Some(build_information_schema_columns(catalog, &table));
    }

    None // not a known introspection query — pass to engine
}
```

## Connection Pooling Compatibility

### PgBouncer-Compatible Session Handling

Connection poolers (PgBouncer, pgcat, odyssey) multiplex client connections onto server connections. Your server must handle pooler behavior.

```rust
/// Session state that must be tracked per-connection.
/// When a pooler reuses a connection, it may send DISCARD ALL or RESET ALL
/// to clear session state.
pub struct SessionState {
    /// Current search_path (default: "public")
    pub search_path: Vec<String>,

    /// Session variables set via SET commands
    pub session_vars: HashMap<String, String>,

    /// Current transaction state
    pub transaction_state: TransactionState,

    /// Prepared statements (extended protocol) — keyed by statement name
    pub prepared_statements: HashMap<String, PreparedStatement>,

    /// Active portals
    pub portals: HashMap<String, Portal>,

    /// Application name (SET application_name)
    pub application_name: String,

    /// Client encoding (always UTF8 for modern clients)
    pub client_encoding: String,

    /// Timezone
    pub timezone: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TransactionState {
    Idle,           // 'I' — no transaction
    InTransaction,  // 'T' — in a transaction block
    Failed,         // 'E' — in a failed transaction block
}

impl SessionState {
    pub fn new() -> Self {
        Self {
            search_path: vec!["public".to_string()],
            session_vars: HashMap::new(),
            transaction_state: TransactionState::Idle,
            prepared_statements: HashMap::new(),
            portals: HashMap::new(),
            application_name: String::new(),
            client_encoding: "UTF8".to_string(),
            timezone: "UTC".to_string(),
        }
    }

    /// Called on DISCARD ALL — reset everything to defaults.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Handle SET commands that change session state.
    pub fn handle_set(&mut self, name: &str, value: &str) {
        match name.to_lowercase().as_str() {
            "search_path" => {
                self.search_path = value
                    .split(',')
                    .map(|s| s.trim().trim_matches('\'').trim_matches('"').to_string())
                    .collect();
            }
            "application_name" => {
                self.application_name = value.to_string();
            }
            "timezone" | "time zone" => {
                self.timezone = value.to_string();
            }
            "client_encoding" => {
                self.client_encoding = value.to_string();
            }
            _ => {
                self.session_vars.insert(name.to_string(), value.to_string());
            }
        }
    }

    /// ReadyForQuery transaction status indicator.
    /// Sent after every query response — the client uses this to track transaction state.
    pub fn ready_for_query_status(&self) -> u8 {
        match self.transaction_state {
            TransactionState::Idle => b'I',
            TransactionState::InTransaction => b'T',
            TransactionState::Failed => b'E',
        }
    }
}
```

### Connection Lifecycle

```rust
/// Full connection lifecycle with session management.
///
/// PgBouncer session mode:
///   - Client gets a dedicated server connection for the session duration
///   - SET commands persist across queries
///   - Prepared statements persist
///
/// PgBouncer transaction mode:
///   - Client gets a server connection only during a transaction
///   - After COMMIT/ROLLBACK, the connection may be reused for another client
///   - DISCARD ALL is sent between client handoffs
///   - Prepared statements do NOT persist across transactions
///
/// Your server should:
/// 1. Accept DISCARD ALL and reset session state
/// 2. Accept RESET ALL (alias for DISCARD ALL in some poolers)
/// 3. Return correct transaction status in ReadyForQuery ('I', 'T', or 'E')
/// 4. Handle unnamed prepared statements (empty string name) — poolers use these

fn handle_session_command(query: &str, session: &mut SessionState) -> Option<Response<'_>> {
    let normalized = query.trim().to_lowercase();

    if normalized == "discard all" || normalized == "reset all" {
        session.reset();
        return Some(Response::Execution(Tag::new("DISCARD ALL")));
    }

    if normalized == "deallocate all" {
        session.prepared_statements.clear();
        return Some(Response::Execution(Tag::new("DEALLOCATE ALL")));
    }

    if let Some(rest) = normalized.strip_prefix("set ") {
        if let Some((name, value)) = rest.split_once('=') {
            session.handle_set(name.trim(), value.trim().trim_matches('\''));
            return Some(Response::Execution(Tag::new("SET")));
        }
        if let Some((name, value)) = rest.split_once(" to ") {
            session.handle_set(name.trim(), value.trim().trim_matches('\''));
            return Some(Response::Execution(Tag::new("SET")));
        }
    }

    None // not a session command
}
```

### Server Parameter Status Messages

After authentication, Postgres servers send ParameterStatus messages that clients and poolers rely on.

```rust
/// Parameters sent during startup handshake (after AuthenticationOk).
/// These are critical — some clients fail if they are missing.
fn startup_parameters() -> Vec<(&'static str, &'static str)> {
    vec![
        ("server_version", "15.0"),
        ("server_encoding", "UTF8"),
        ("client_encoding", "UTF8"),
        ("DateStyle", "ISO, MDY"),
        ("TimeZone", "UTC"),
        ("integer_datetimes", "on"),
        ("standard_conforming_strings", "on"),
        ("IntervalStyle", "postgres"),
        ("is_superuser", "on"),
        ("session_authorization", "default"),
    ]
}
```

## Testing Your Wire Protocol

### Connect with psql

```bash
# Simple query
psql -h 127.0.0.1 -p 5432 -U test -d testdb -c "SELECT 1 AS num, 'hello' AS greeting"

# Extended query (force prepared statement)
psql -h 127.0.0.1 -p 5432 -U test -d testdb -c "PREPARE test_stmt AS SELECT \$1::int; EXECUTE test_stmt(42)"

# Introspection
psql -h 127.0.0.1 -p 5432 -U test -d testdb -c "\dt"  # list tables
psql -h 127.0.0.1 -p 5432 -U test -d testdb -c "\d users"  # describe table
```

### Connect with node-postgres

```javascript
const { Client } = require('pg');
const client = new Client({ host: '127.0.0.1', port: 5432, user: 'test', database: 'testdb' });
await client.connect();

// Simple query
const res = await client.query('SELECT $1::int AS id, $2::text AS name', [1, 'Alice']);
console.log(res.rows); // [{ id: 1, name: 'Alice' }]

// Prepared statement
await client.query({ name: 'get-user', text: 'SELECT * FROM users WHERE id = $1', values: [1] });

await client.end();
```

### Integration Test Pattern in Rust

```rust
#[cfg(test)]
mod tests {
    use tokio_postgres::{NoTls, Config};

    /// Start the server on a random port, connect with tokio-postgres, run queries.
    #[tokio::test]
    async fn test_simple_query() {
        let port = start_test_server().await; // your server on a random port

        let (client, connection) = Config::new()
            .host("127.0.0.1")
            .port(port)
            .user("test")
            .dbname("testdb")
            .connect(NoTls)
            .await
            .expect("connection failed");

        // Drive the connection in the background
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("connection error: {e}");
            }
        });

        // DDL
        client.batch_execute("CREATE TABLE test_tbl (id INT, name TEXT)").await.unwrap();

        // INSERT
        let affected = client
            .execute("INSERT INTO test_tbl (id, name) VALUES ($1, $2)", &[&1i32, &"Alice"])
            .await
            .unwrap();
        assert_eq!(affected, 1);

        // SELECT
        let rows = client
            .query("SELECT id, name FROM test_tbl WHERE id = $1", &[&1i32])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get::<_, i32>("id"), 1);
        assert_eq!(rows[0].get::<_, &str>("name"), "Alice");

        // Error handling
        let err = client
            .query("SELECT * FROM nonexistent_table", &[])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("does not exist"));
    }

    #[tokio::test]
    async fn test_orm_introspection() {
        let port = start_test_server().await;
        let (client, connection) = connect(port).await;
        tokio::spawn(connection);

        // Verify pg_type returns rows
        let rows = client
            .query("SELECT oid, typname FROM pg_catalog.pg_type", &[])
            .await
            .unwrap();
        assert!(!rows.is_empty());

        // Verify information_schema.tables
        let rows = client
            .query(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
                &[],
            )
            .await
            .unwrap();
        // At minimum, returns empty set without error

        // Verify version()
        let row = client.query_one("SELECT version()", &[]).await.unwrap();
        let version: &str = row.get(0);
        assert!(version.contains("PostgreSQL"));
    }
}
```
