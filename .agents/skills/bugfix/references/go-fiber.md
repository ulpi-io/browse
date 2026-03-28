# Go Fiber Bug Patterns

> Detect: `go.mod` has `github.com/gofiber/fiber` dependency, files import `fiber`, `fiber.New()` patterns.

## All Go Bugs Apply

Fiber inherits ALL Go bug patterns. See `golang.md`. This file covers **Fiber-specific** bugs only.

## CRITICAL: Fiber uses fasthttp, not net/http

Fiber is built on `fasthttp`, not Go's standard `net/http`. This means:

- **Request/response objects are pooled and reused** — values are only valid within the handler
- **Headers, body, params are invalidated after handler returns**
- Standard `http.Request` / `http.ResponseWriter` are NOT available

### Storing request data after handler returns — the #1 Fiber bug

```go
// BUG: c.Body() returns a pointer to pooled memory — invalidated after handler
func Handler(c *fiber.Ctx) error {
    body := c.Body() // points to pooled buffer
    go func() {
        processAsync(body) // CRASH or corrupt data — buffer reused!
    }()
    return c.SendStatus(202)
}

// FIX: Copy the data before using in goroutine
func Handler(c *fiber.Ctx) error {
    body := make([]byte, len(c.Body()))
    copy(body, c.Body()) // copy to owned memory
    go func() {
        processAsync(body)
    }()
    return c.SendStatus(202)
}

// Same for params, headers, query values:
id := string(c.Params("id"))        // must convert to owned string
name := string(c.Query("name"))     // must convert to owned string
auth := string(c.Get("Authorization")) // must convert to owned string
```

### c.Locals() — values only valid during request

```go
// BUG: Storing reference types in Locals that point to pooled memory
func AuthMiddleware(c *fiber.Ctx) error {
    c.Locals("userId", c.Get("X-User-Id")) // fasthttp header — pooled!
    return c.Next()
}

// FIX: Store owned copies
func AuthMiddleware(c *fiber.Ctx) error {
    c.Locals("userId", string(c.Get("X-User-Id"))) // owned string
    return c.Next()
}
```

## Body Parsing

### BodyParser — doesn't validate

```go
// BUG: BodyParser only parses, no validation
type UserInput struct {
    Email string `json:"email"`
    Name  string `json:"name"`
}

func CreateUser(c *fiber.Ctx) error {
    var input UserInput
    if err := c.BodyParser(&input); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "Invalid input"})
    }
    // input.Email could be anything
}

// FIX: Add validation (go-playground/validator)
func CreateUser(c *fiber.Ctx) error {
    var input UserInput
    if err := c.BodyParser(&input); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": "Invalid input"})
    }
    if err := validate.Struct(input); err != nil {
        return c.Status(400).JSON(fiber.Map{"error": err.Error()})
    }
}
```

## Error Handling

### Fiber's error handler

```go
// BUG: Default error handler returns plain text with internal details
// Fiber returns: "cannot parse JSON" with stack trace info

// FIX: Custom error handler
app := fiber.New(fiber.Config{
    ErrorHandler: func(c *fiber.Ctx, err error) error {
        code := fiber.StatusInternalServerError
        var e *fiber.Error
        if errors.As(err, &e) {
            code = e.Code
        }
        return c.Status(code).JSON(fiber.Map{"error": "Internal server error"})
    },
})
```

## Middleware

### Rate limiter — uses in-memory store by default

```go
// BUG: Rate limiter doesn't work in multi-instance deployment
app.Use(limiter.New()) // in-memory store — not shared across instances

// FIX: Use Redis store
app.Use(limiter.New(limiter.Config{
    Storage: redis.New(redis.Config{
        Host: "localhost",
        Port: 6379,
    }),
}))
```

## Testing Patterns

```go
func TestCreateUser(t *testing.T) {
    app := setupApp()

    body := `{"email":"test@example.com","name":"Test"}`
    req := httptest.NewRequest("POST", "/api/users", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")

    resp, err := app.Test(req)
    assert.NoError(t, err)
    assert.Equal(t, 201, resp.StatusCode)
}
```

## Framework Gotchas

| Gotcha                                          | Detail                                                   |
| ----------------------------------------------- | -------------------------------------------------------- |
| **All request data is pooled**                  | Must `copy()` or `string()` before goroutines or storing |
| `c.Body()` returns `[]byte` pointer to pool     | Invalid after handler returns                            |
| `c.Params()`, `c.Query()` return pooled strings | Copy before async use                                    |
| `c.BodyParser()` doesn't validate               | Add validation library separately                        |
| `app.Test()` for testing (no server needed)     | Built-in, like Fastify's `inject`                        |
| Fiber v2 vs v3 API differences                  | v3 uses generics, different middleware API               |
| `c.SendStatus()` vs `c.Status().Send()`         | `SendStatus` also sets the body to status text           |
| Prefork mode shares nothing                     | Each worker is a separate process                        |
