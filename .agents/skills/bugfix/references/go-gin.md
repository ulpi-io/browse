# Go Gin Bug Patterns

> Detect: `go.mod` has `github.com/gin-gonic/gin` dependency, files import `gin`, `gin.Default()`/`gin.New()` patterns.

## All Go Bugs Apply

Gin inherits ALL Go bug patterns (error handling, concurrency, SQL). See `golang.md`. This file covers **Gin-specific** bugs only.

## Binding & Validation

### ShouldBind — different content types, different bind methods

```go
// BUG: ShouldBind uses Content-Type header — attacker can change content type
func CreateUser(c *gin.Context) {
    var input UserInput
    c.ShouldBind(&input) // depends on Content-Type header
}

// FIX: Use specific binder
func CreateUser(c *gin.Context) {
    var input UserInput
    if err := c.ShouldBindJSON(&input); err != nil {
        c.JSON(400, gin.H{"error": err.Error()})
        return
    }
}
```

### Binding errors expose internal details

```go
// BUG: Validation error message leaks struct field names and types
if err := c.ShouldBindJSON(&input); err != nil {
    c.JSON(400, gin.H{"error": err.Error()}) // exposes internal struct info
}

// FIX: Map to user-friendly messages
if err := c.ShouldBindJSON(&input); err != nil {
    var ve validator.ValidationErrors
    if errors.As(err, &ve) {
        out := make([]string, len(ve))
        for i, fe := range ve {
            out[i] = fmt.Sprintf("Field '%s' failed validation: %s", fe.Field(), fe.Tag())
        }
        c.JSON(400, gin.H{"errors": out})
        return
    }
    c.JSON(400, gin.H{"error": "Invalid input"})
}
```

## Middleware

### c.Next() vs c.Abort() — middleware execution control

```go
// BUG: Auth middleware doesn't stop execution on failure
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if token == "" {
            c.JSON(401, gin.H{"error": "Unauthorized"})
            // Missing c.Abort()! Handler still executes
        }
        c.Next()
    }
}

// FIX: Abort to stop handler chain
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if token == "" {
            c.AbortWithStatusJSON(401, gin.H{"error": "Unauthorized"})
            return
        }
        c.Next()
    }
}
```

### Goroutine with gin.Context — must copy

```go
// BUG: Using gin.Context in goroutine — race condition
func Handler(c *gin.Context) {
    go func() {
        // c is reused by the next request! Data race!
        log.Println(c.Request.URL.Path)
    }()
}

// FIX: Copy the context
func Handler(c *gin.Context) {
    cp := c.Copy() // safe copy for goroutine
    go func() {
        log.Println(cp.Request.URL.Path)
    }()
}
```

## Response Bugs

### Double response — writing after c.JSON()

```go
// BUG: c.JSON doesn't return or abort
func Handler(c *gin.Context) {
    if err != nil {
        c.JSON(500, gin.H{"error": "failed"})
        // Falls through! Writes response again
    }
    c.JSON(200, gin.H{"ok": true})
}

// FIX: Return after sending response
func Handler(c *gin.Context) {
    if err != nil {
        c.JSON(500, gin.H{"error": "failed"})
        return
    }
    c.JSON(200, gin.H{"ok": true})
}
```

## Trusted Proxies

```go
// BUG: Gin trusts all proxies by default (before v1.7.7)
// c.ClientIP() returns X-Forwarded-For which can be spoofed

// FIX: Set trusted proxies
router := gin.Default()
router.SetTrustedProxies([]string{"10.0.0.0/8"})
// Or trust no proxies
router.SetTrustedProxies(nil)
```

## Testing Patterns

```go
func TestCreateUser(t *testing.T) {
    router := setupRouter()

    body := `{"email": "test@example.com", "name": "Test"}`
    req := httptest.NewRequest("POST", "/api/users", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    rec := httptest.NewRecorder()

    router.ServeHTTP(rec, req)

    assert.Equal(t, 201, rec.Code)
}

func TestAuthRequired(t *testing.T) {
    router := setupRouter()
    req := httptest.NewRequest("GET", "/api/admin", nil)
    rec := httptest.NewRecorder()
    router.ServeHTTP(rec, req)
    assert.Equal(t, 401, rec.Code)
}
```

## Framework Gotchas

| Gotcha                                     | Detail                                        |
| ------------------------------------------ | --------------------------------------------- |
| `c.JSON()` doesn't return or abort         | Must `return` after sending response          |
| `c.Abort()` doesn't return                 | Must also `return` from handler               |
| `gin.Context` is NOT goroutine-safe        | Use `c.Copy()` for goroutines                 |
| `ShouldBind` can only be called once       | Body is consumed on first read                |
| `gin.Default()` includes Logger + Recovery | `gin.New()` for no default middleware         |
| `c.Param("id")` is always string           | Must parse to int manually                    |
| Route groups share middleware              | Middleware on group applies to all routes     |
| `gin.H{}` is just `map[string]any`         | Use structs for typed responses in production |
