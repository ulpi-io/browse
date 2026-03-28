# Go Bug Patterns

> Detect: `go.mod` present, `.go` files, `package main` / `func main()`, `go build`/`go run` in scripts.

## Error Handling

### Unchecked errors — the #1 Go bug

```go
// BUG: Error silently ignored
result, _ := db.Query("SELECT * FROM users WHERE id = ?", id)
// If query fails, result is nil → nil pointer dereference on next line

// FIX: Always check errors
result, err := db.Query("SELECT * FROM users WHERE id = ?", id)
if err != nil {
    return fmt.Errorf("query user %s: %w", id, err)
}
defer result.Close()
```

### defer Close() errors — ignoring close failures

```go
// BUG: Close error ignored (can lose data on write operations)
f, err := os.Create("output.txt")
if err != nil { return err }
defer f.Close()
f.Write(data) // write may be buffered

// FIX: Check close error (especially for writes)
f, err := os.Create("output.txt")
if err != nil { return err }
defer func() {
    if cerr := f.Close(); cerr != nil && err == nil {
        err = cerr
    }
}()
```

### errors.Is / errors.As — not using error wrapping properly

```go
// BUG: Equality check fails with wrapped errors
if err == sql.ErrNoRows { // fails if err was wrapped with fmt.Errorf("%w", ...)
    return nil
}

// FIX: Use errors.Is for wrapped errors
if errors.Is(err, sql.ErrNoRows) {
    return nil
}
```

## Concurrency

### Race condition — shared state without mutex

```go
// BUG: Data race — map accessed concurrently
var cache = map[string]string{}

func Get(key string) string { return cache[key] }     // concurrent read
func Set(key string, val string) { cache[key] = val }  // concurrent write → CRASH

// FIX: Use sync.Mutex or sync.Map
var (
    cache = map[string]string{}
    mu    sync.RWMutex
)

func Get(key string) string {
    mu.RLock()
    defer mu.RUnlock()
    return cache[key]
}

func Set(key string, val string) {
    mu.Lock()
    defer mu.Unlock()
    cache[key] = val
}
```

### Goroutine leak — goroutine blocked forever

```go
// BUG: Goroutine leaks — channel never read
func process() {
    ch := make(chan result)
    go func() {
        ch <- doWork() // blocks forever if nobody reads from ch
    }()
    // ch is never read if we return early
    return
}

// FIX: Use buffered channel or context cancellation
func process(ctx context.Context) {
    ch := make(chan result, 1) // buffered — won't block
    go func() {
        select {
        case ch <- doWork():
        case <-ctx.Done():
        }
    }()
}
```

### Loop variable capture — fixed in Go 1.22+

```go
// BUG (Go < 1.22): All goroutines capture the same variable
for _, item := range items {
    go func() {
        process(item) // item is always the last element
    }()
}

// FIX (Go < 1.22): Shadow the variable
for _, item := range items {
    item := item // shadow
    go func() {
        process(item)
    }()
}

// Go 1.22+: Loop variables are per-iteration (fixed by default)
```

### Context cancellation — not propagating context

```go
// BUG: Long operation ignores context cancellation
func fetchData(ctx context.Context) ([]byte, error) {
    resp, err := http.Get(url) // doesn't use ctx!
    // ...
}

// FIX: Use context-aware methods
func fetchData(ctx context.Context) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil { return nil, err }
    resp, err := http.DefaultClient.Do(req)
    // ...
}
```

## SQL

### sql.Rows not closed — connection leak

```go
// BUG: Rows not closed on early return
rows, err := db.Query("SELECT * FROM users")
if err != nil { return err }
for rows.Next() {
    if someCondition {
        return nil // LEAK: rows not closed
    }
}

// FIX: Defer Close immediately after Query
rows, err := db.Query("SELECT * FROM users")
if err != nil { return err }
defer rows.Close()
```

### Null handling — nullable columns crash Scan

```go
// BUG: Scan crashes on NULL value
var name string
err := row.Scan(&name) // panics if column is NULL

// FIX: Use sql.NullString (or *string)
var name sql.NullString
err := row.Scan(&name)
if name.Valid {
    fmt.Println(name.String)
}
```

## HTTP Server

### Default HTTP server — no timeouts (DoS vulnerability)

```go
// BUG: No timeouts — slowloris attack possible
http.ListenAndServe(":8080", handler)

// FIX: Set timeouts
server := &http.Server{
    Addr:         ":8080",
    Handler:      handler,
    ReadTimeout:  5 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  120 * time.Second,
}
server.ListenAndServe()
```

### JSON decoding — not limiting body size

```go
// BUG: Unlimited body size — memory exhaustion
var input UserInput
json.NewDecoder(r.Body).Decode(&input)

// FIX: Limit body size
r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB limit
var input UserInput
if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
    http.Error(w, "Bad request", 400)
    return
}
```

## Testing Patterns

```go
func TestUserHandler_RejectsInvalidID(t *testing.T) {
    req := httptest.NewRequest("GET", "/users/'; DROP TABLE users;--", nil)
    rec := httptest.NewRecorder()
    handler.ServeHTTP(rec, req)
    if rec.Code != http.StatusBadRequest {
        t.Errorf("expected 400, got %d", rec.Code)
    }
}

func TestConcurrentMapAccess(t *testing.T) {
    cache := NewSafeCache()
    var wg sync.WaitGroup
    for i := 0; i < 100; i++ {
        wg.Add(2)
        go func(i int) { defer wg.Done(); cache.Set(fmt.Sprint(i), "val") }(i)
        go func(i int) { defer wg.Done(); cache.Get(fmt.Sprint(i)) }(i)
    }
    wg.Wait() // should not panic with -race flag
}
```

## Framework Gotchas

| Gotcha                                                     | Detail                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Maps are not safe for concurrent use                       | Use `sync.Mutex` or `sync.Map`                          |
| `nil` slice is valid (empty) but `nil` map panics on write | Always `make(map)` before writing                       |
| `defer` evaluates args immediately                         | `defer log.Println(x)` captures current x value         |
| `range` over string iterates runes, not bytes              | Use `[]byte(s)` for byte iteration                      |
| Interface nil check is tricky                              | `var err *MyError; var i error = err; i != nil` is TRUE |
| `json.Unmarshal` silently ignores unknown fields           | Use `DisallowUnknownFields` decoder option              |
| `time.After` leaks in select loops                         | Use `time.NewTimer` with `Stop()` in loops              |
| `append` may or may not create new slice                   | Always use return value: `s = append(s, x)`             |
