# Go Echo Bug Patterns

> Detect: `go.mod` has `github.com/labstack/echo` dependency, files import `echo`, `echo.New()` patterns.

## All Go Bugs Apply

Echo inherits ALL Go bug patterns. See `golang.md`. This file covers **Echo-specific** bugs only.

## Binding & Validation

### Bind — doesn't validate by default

```go
// BUG: Bind parses but doesn't validate
type UserInput struct {
    Email string `json:"email"`
    Name  string `json:"name"`
}

func CreateUser(c echo.Context) error {
    var input UserInput
    if err := c.Bind(&input); err != nil {
        return c.JSON(400, map[string]string{"error": "Invalid input"})
    }
    // input.Email could be empty or invalid — no validation!
}

// FIX: Use Validate (register a validator first)
// In setup:
e.Validator = &CustomValidator{validator: validator.New()}

// In handler:
type UserInput struct {
    Email string `json:"email" validate:"required,email"`
    Name  string `json:"name" validate:"required,min=1,max=100"`
}

func CreateUser(c echo.Context) error {
    var input UserInput
    if err := c.Bind(&input); err != nil {
        return c.JSON(400, map[string]string{"error": "Invalid input"})
    }
    if err := c.Validate(&input); err != nil {
        return c.JSON(400, map[string]string{"error": err.Error()})
    }
}
```

## Middleware

### Middleware order — Skipper pattern

```go
// BUG: Auth middleware runs on login/register routes
e.Use(middleware.KeyAuth(validateKey))

// FIX: Use Skipper to exclude public routes
e.Use(middleware.KeyAuthWithConfig(middleware.KeyAuthConfig{
    Skipper: func(c echo.Context) bool {
        return c.Path() == "/login" || c.Path() == "/register"
    },
    Validator: validateKey,
}))
```

### echo.Context in goroutines — same issue as Gin

```go
// BUG: Context reused across requests
func Handler(c echo.Context) error {
    go func() {
        // c is reused! Race condition
        processAsync(c.Param("id"))
    }()
    return c.NoContent(202)
}

// FIX: Extract values before goroutine
func Handler(c echo.Context) error {
    id := c.Param("id") // extract before goroutine
    go func() {
        processAsync(id)
    }()
    return c.NoContent(202)
}
```

## Error Handling

### Echo's HTTPError — custom error handler

```go
// BUG: Default error handler exposes internal errors
// Echo shows "Internal Server Error" but logs may leak info

// FIX: Custom error handler
e.HTTPErrorHandler = func(err error, c echo.Context) {
    var he *echo.HTTPError
    if errors.As(err, &he) {
        c.JSON(he.Code, map[string]string{"error": fmt.Sprint(he.Message)})
    } else {
        // Log internal error, return generic message
        e.Logger.Error(err)
        c.JSON(500, map[string]string{"error": "Internal server error"})
    }
}
```

### Return error vs c.JSON — must return errors to trigger error handler

```go
// BUG: Error not returned — error handler never called
func Handler(c echo.Context) error {
    data, err := fetchData()
    if err != nil {
        c.JSON(500, map[string]string{"error": "failed"}) // bypasses error handler
        return nil // error handler NOT called
    }
    return c.JSON(200, data)
}

// FIX: Return echo.HTTPError to use error handler
func Handler(c echo.Context) error {
    data, err := fetchData()
    if err != nil {
        return echo.NewHTTPError(500, "Failed to fetch data")
    }
    return c.JSON(200, data)
}
```

## Testing Patterns

```go
func TestCreateUser(t *testing.T) {
    e := echo.New()
    body := `{"email":"test@example.com","name":"Test"}`
    req := httptest.NewRequest(http.MethodPost, "/users", strings.NewReader(body))
    req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
    rec := httptest.NewRecorder()
    c := e.NewContext(req, rec)

    if assert.NoError(t, CreateUser(c)) {
        assert.Equal(t, http.StatusCreated, rec.Code)
    }
}
```

## Framework Gotchas

| Gotcha                                      | Detail                                        |
| ------------------------------------------- | --------------------------------------------- |
| `c.Bind()` doesn't validate                 | Must call `c.Validate()` separately           |
| Handler must return error                   | Return `nil` only on success                  |
| `c.Param()` returns empty string if missing | Not an error — check explicitly               |
| Echo context is NOT goroutine-safe          | Extract values before spawning goroutines     |
| `e.Logger` is the built-in logger           | Replace with structured logger for production |
| Default CORS is disabled                    | Must add `middleware.CORS()` explicitly       |
| `c.Response().Committed`                    | Check before writing to avoid double response |
| Path params are URL-decoded                 | No need for manual `url.QueryUnescape`        |
