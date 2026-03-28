# Rust Bug Patterns

> Detect: `Cargo.toml` present, `.rs` files, `fn main()`, `use std::`, `cargo build`/`cargo run` in scripts.

## Ownership & Borrowing

### Use after move

```rust
// BUG: Value used after move
let data = vec![1, 2, 3];
let other = data; // data is moved
println!("{:?}", data); // ERROR: value used after move

// FIX: Clone if you need both, or use references
let data = vec![1, 2, 3];
let other = data.clone(); // explicit clone
println!("{:?}", data); // OK

// Or borrow
let other = &data; // borrow, don't move
```

### Mutable borrow while immutable borrow exists

```rust
// BUG: Can't mutably borrow while immutably borrowed
let mut v = vec![1, 2, 3];
let first = &v[0]; // immutable borrow
v.push(4); // mutable borrow — ERROR
println!("{first}"); // immutable borrow still in use

// FIX: Ensure immutable borrow ends before mutation
let mut v = vec![1, 2, 3];
let first = v[0]; // copy the value (i32 is Copy)
v.push(4); // OK — no outstanding borrows
println!("{first}");
```

## Error Handling

### unwrap() — panics in production

```rust
// BUG: unwrap panics on None/Err
let config = std::fs::read_to_string("config.toml").unwrap(); // panic if file missing

// FIX: Use ? operator or match
let config = std::fs::read_to_string("config.toml")
    .map_err(|e| AppError::Config(format!("Failed to read config: {e}")))?;

// Or provide default
let config = std::fs::read_to_string("config.toml").unwrap_or_default();
```

### Error conversion — missing From implementations

```rust
// BUG: ? operator fails because error types don't match
fn process() -> Result<(), MyError> {
    let data = std::fs::read("file.txt")?; // io::Error, not MyError
}

// FIX: Implement From, or use thiserror
#[derive(Debug, thiserror::Error)]
enum MyError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error), // auto-implements From<io::Error>

    #[error("Parse error: {0}")]
    Parse(#[from] serde_json::Error),
}
```

## Concurrency

### Data races — Arc<Mutex<T>> pattern

```rust
// BUG: Shared state without synchronization
let counter = 0u64;
let handles: Vec<_> = (0..10).map(|_| {
    std::thread::spawn(|| {
        counter += 1; // ERROR: can't capture mutable reference in multiple threads
    })
}).collect();

// FIX: Arc<Mutex<T>> for shared mutable state
let counter = Arc::new(Mutex::new(0u64));
let handles: Vec<_> = (0..10).map(|_| {
    let counter = Arc::clone(&counter);
    std::thread::spawn(move || {
        let mut num = counter.lock().unwrap();
        *num += 1;
    })
}).collect();
for h in handles { h.join().unwrap(); }

// Or use AtomicU64 for simple counters
let counter = Arc::new(AtomicU64::new(0));
```

### Mutex poisoning — lock().unwrap() can panic

```rust
// BUG: If a thread panics while holding the lock, the mutex is poisoned
let data = mutex.lock().unwrap(); // panics if mutex is poisoned

// FIX: Handle poisoned mutex
let data = mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
```

### Deadlock — multiple locks in inconsistent order

```rust
// BUG: Deadlock — thread 1 locks A then B, thread 2 locks B then A
let a = Mutex::new(1);
let b = Mutex::new(2);
// Thread 1: lock(a) → lock(b)
// Thread 2: lock(b) → lock(a) → DEADLOCK

// FIX: Always lock in the same order
// Thread 1: lock(a) → lock(b)
// Thread 2: lock(a) → lock(b) — same order
```

## Async Rust (Tokio)

### Blocking in async context — starves the runtime

```rust
// BUG: Blocking I/O in async function
async fn handle_request() {
    let data = std::fs::read_to_string("large_file.txt"); // blocks the executor!
}

// FIX: Use async I/O or spawn_blocking
async fn handle_request() {
    let data = tokio::fs::read_to_string("large_file.txt").await; // async I/O

    // Or for CPU-bound work
    let result = tokio::task::spawn_blocking(|| {
        expensive_computation()
    }).await.unwrap();
}
```

### Forgetting .await — future does nothing

```rust
// BUG: Future never polled — nothing happens
async fn process() {
    fetch_data(); // returns a Future but never .await-ed
    // WARNING: compiler warns about this, but it's easy to miss
}

// FIX: Always .await async calls
async fn process() {
    fetch_data().await;
}
```

## Unsafe Code

### Dereferencing raw pointers — undefined behavior

```rust
// BUG: Raw pointer dereference without safety guarantees
unsafe {
    let ptr: *const i32 = some_ffi_function();
    let value = *ptr; // UB if ptr is null, dangling, or unaligned
}

// FIX: Validate pointer first
unsafe {
    let ptr: *const i32 = some_ffi_function();
    if ptr.is_null() {
        return Err(MyError::NullPointer);
    }
    let value = *ptr; // still unsafe, but at least not null
}

// BETTER: Minimize unsafe surface area
fn safe_wrapper() -> Result<i32, MyError> {
    let ptr = unsafe { some_ffi_function() };
    if ptr.is_null() { return Err(MyError::NullPointer); }
    Ok(unsafe { *ptr })
}
```

## Serde / Serialization

### Missing fields in deserialization — silent defaults vs errors

```rust
// BUG: Missing field in JSON causes deserialization error
#[derive(Deserialize)]
struct Config {
    port: u16,
    host: String,
    debug: bool, // if missing in JSON → error
}

// FIX: Use default for optional fields
#[derive(Deserialize)]
struct Config {
    port: u16,
    host: String,
    #[serde(default)]
    debug: bool, // defaults to false if missing
}
```

### Integer overflow — wraps in release, panics in debug

```rust
// BUG: Integer overflow behavior differs between debug and release
let x: u8 = 255;
let y = x + 1; // debug: panic! release: wraps to 0

// FIX: Use checked arithmetic for untrusted input
let y = x.checked_add(1).ok_or(MyError::Overflow)?;
// Or wrapping/saturating for intentional overflow
let y = x.wrapping_add(1); // always 0
let y = x.saturating_add(1); // always 255
```

## Web Framework Patterns (Axum/Actix)

### Axum — extractor order matters

```rust
// BUG: Body consumed by Json before other extractors can use it
async fn handler(
    Json(body): Json<CreateUser>, // consumes body
    headers: HeaderMap,           // OK — doesn't need body
) -> impl IntoResponse { }

// The consuming extractor (Json) must be LAST
async fn handler(
    headers: HeaderMap,           // non-consuming extractors first
    Json(body): Json<CreateUser>, // consuming extractor last
) -> impl IntoResponse { }
```

## Testing Patterns

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_handles_none_safely() {
        let result = process_user(None);
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_concurrent_access() {
        let store = Arc::new(Mutex::new(Vec::new()));
        let mut handles = vec![];
        for i in 0..100 {
            let store = Arc::clone(&store);
            handles.push(tokio::spawn(async move {
                store.lock().unwrap().push(i);
            }));
        }
        for h in handles { h.await.unwrap(); }
        assert_eq!(store.lock().unwrap().len(), 100);
    }
}
```

## Framework Gotchas

| Gotcha                                 | Detail                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `unwrap()` panics in production        | Use `?`, `unwrap_or`, `unwrap_or_else`                                     |
| Integer overflow wraps in release mode | Use `checked_*` for untrusted input                                        |
| `Clone` is explicit, not implicit      | Must call `.clone()` — no implicit copying for heap types                  |
| `String` vs `&str`                     | `String` owns, `&str` borrows — function params should usually take `&str` |
| `async fn` returns `impl Future`       | Must `.await` or it does nothing                                           |
| `Mutex` poisoning                      | Handle with `unwrap_or_else`                                               |
| Blocking in async = runtime starvation | Use `spawn_blocking` for CPU/IO-bound work                                 |
| `#[derive(Debug)]` is not automatic    | Must derive or implement for println!("{:?}")                              |
