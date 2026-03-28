# Rust Actix Web Bug Patterns

> Detect: `Cargo.toml` has `actix-web` dependency, files import from `actix_web`, `HttpServer::new()` / `App::new()` patterns.

## All Rust Bugs Apply

Actix Web inherits ALL Rust bug patterns. See `rust.md`. This file covers **Actix-specific** bugs only.

## Extractor Bugs

### Body extractors can only be used once per handler

```rust
// BUG: Two body extractors — second fails at runtime
async fn handler(
    body: web::Json<Value>,
    form: web::Form<Value>,  // ERROR: body already consumed
) -> impl Responder { }

// FIX: Use one body extractor, or use Bytes and parse manually
async fn handler(body: web::Json<CreateUser>) -> impl Responder {
    HttpResponse::Ok().json(body.into_inner())
}
```

### Path extractor — type must match route param count

```rust
// BUG: Route has 2 params but extractor expects 1
#[get("/users/{user_id}/posts/{post_id}")]
async fn handler(path: web::Path<i32>) -> impl Responder {
    // Only captures user_id — post_id is lost!
}

// FIX: Use tuple or struct matching all params
#[get("/users/{user_id}/posts/{post_id}")]
async fn handler(path: web::Path<(i32, i32)>) -> impl Responder {
    let (user_id, post_id) = path.into_inner();
}

// Or use a named struct
#[derive(Deserialize)]
struct PostPath { user_id: i32, post_id: i32 }

#[get("/users/{user_id}/posts/{post_id}")]
async fn handler(path: web::Path<PostPath>) -> impl Responder {
    let PostPath { user_id, post_id } = path.into_inner();
}
```

### Query extractor — fails with 400 on missing optional params

```rust
// BUG: Missing query param returns 400 instead of using default
#[derive(Deserialize)]
struct Pagination {
    page: u32,
    limit: u32,
}

async fn list(query: web::Query<Pagination>) -> impl Responder {
    // GET /items → 400 (page and limit are required!)
}

// FIX: Use Option or Default
#[derive(Deserialize)]
struct Pagination {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_limit")]
    limit: u32,
}
fn default_page() -> u32 { 1 }
fn default_limit() -> u32 { 20 }
```

## App State

### Data must be wrapped in web::Data (Arc internally)

```rust
// BUG: State not shared correctly across workers
let db = DatabasePool::new();
HttpServer::new(move || {
    App::new()
        .app_data(db.clone())  // BUG: clones for each worker, not shared!
        .route("/", web::get().to(handler))
})

// FIX: Wrap in web::Data (which uses Arc internally)
let db = web::Data::new(DatabasePool::new());
HttpServer::new(move || {
    App::new()
        .app_data(db.clone())  // clones the Arc, shares the pool
        .route("/", web::get().to(handler))
})

async fn handler(db: web::Data<DatabasePool>) -> impl Responder {
    db.query("...").await
}
```

### App::new() closure runs per worker — don't create resources inside

```rust
// BUG: New database pool per worker thread
HttpServer::new(|| {
    let pool = DatabasePool::new();  // created per worker!
    App::new().app_data(web::Data::new(pool))
})

// FIX: Create outside, share via Arc/web::Data
let pool = web::Data::new(DatabasePool::new());  // created once
HttpServer::new(move || {
    App::new().app_data(pool.clone())  // shared across workers
})
```

## Error Handling

### ResponseError trait — custom error types

```rust
// BUG: Returning raw strings as errors — no structured error response
async fn handler() -> Result<HttpResponse, String> {
    Err("something failed".to_string())  // returns 500 with plain text
}

// FIX: Implement ResponseError for structured errors
#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Not found")]
    NotFound,
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Internal error: {0}")]
    Internal(String),
}

impl actix_web::ResponseError for AppError {
    fn error_response(&self) -> HttpResponse {
        match self {
            AppError::NotFound => HttpResponse::NotFound()
                .json(json!({"error": "Not found"})),
            AppError::Unauthorized => HttpResponse::Unauthorized()
                .json(json!({"error": "Unauthorized"})),
            AppError::Internal(_) => {
                tracing::error!("{self}");
                HttpResponse::InternalServerError()
                    .json(json!({"error": "Internal server error"}))
            }
        }
    }
}
```

## Middleware

### Middleware order — wraps inner to outer (same as Axum/Tower)

```rust
// Request flow: last .wrap() runs first
App::new()
    .wrap(Logger::default())       // runs first (outermost)
    .wrap(auth_middleware)          // runs second
    .service(web::resource("/api")) // handler runs last

// Actix also has guard-based routing
web::resource("/admin")
    .guard(guard::Header("x-admin-token", "secret"))
    .route(web::get().to(admin_handler))
```

### Blocking in async handler — use web::block()

```rust
// BUG: Blocking operation in async handler — starves thread pool
async fn handler() -> impl Responder {
    let result = expensive_computation();  // blocks async executor
    HttpResponse::Ok().json(result)
}

// FIX: Use web::block for CPU-bound work
async fn handler() -> Result<HttpResponse, actix_web::Error> {
    let result = web::block(|| expensive_computation()).await??;
    Ok(HttpResponse::Ok().json(result))
}
```

## Testing Patterns

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test;

    #[actix_web::test]
    async fn test_create_user() {
        let app = test::init_service(
            App::new().route("/users", web::post().to(create_user))
        ).await;

        let req = test::TestRequest::post()
            .uri("/users")
            .set_json(json!({"email": "test@example.com", "name": "Test"}))
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::CREATED);
    }

    #[actix_web::test]
    async fn test_requires_auth() {
        let app = test::init_service(create_app()).await;

        let req = test::TestRequest::get()
            .uri("/protected")
            .to_request();

        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
```

## Framework Gotchas

| Gotcha                                     | Detail                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| `App::new()` closure runs per worker       | Create shared resources outside, wrap in `web::Data`      |
| `web::Data` uses `Arc` internally          | Don't double-wrap: `web::Data::new(Arc::new(x))` is wrong |
| Body extractor can only be used once       | `Json`, `Form`, `Bytes`, `String`, `Payload`              |
| Path extractor must match ALL route params | Use tuple or struct, not single type                      |
| `web::block()` for blocking operations     | Don't block the async executor                            |
| Default JSON payload limit is 32KB         | Set with `web::JsonConfig::default().limit(1_048_576)`    |
| `HttpServer` is multi-threaded by default  | State must be `Send + Sync`                               |
| Middleware wraps inner-to-outer            | Last `.wrap()` runs first on request                      |
