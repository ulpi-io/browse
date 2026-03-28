# Rust Axum Bug Patterns

> Detect: `Cargo.toml` has `axum` dependency, files import from `axum`, `Router::new()` patterns.

## All Rust Bugs Apply

Axum inherits ALL Rust bug patterns (ownership, error handling, async, unsafe). See `rust.md`. This file covers **Axum-specific** bugs only.

## Extractor Ordering — The #1 Axum Bug

### Body-consuming extractor must be LAST

```rust
// BUG: Json consumes the body — later extractors can't read it
async fn handler(
    Json(body): Json<CreateUser>,  // consumes body FIRST
    headers: HeaderMap,             // fine — doesn't need body
    State(db): State<AppState>,    // fine — doesn't need body
) -> impl IntoResponse { }

// BUG: Two body-consuming extractors — second one fails
async fn handler(
    Json(body): Json<Value>,    // consumes body
    Form(form): Form<Value>,    // ERROR: body already consumed
) -> impl IntoResponse { }

// FIX: Body-consuming extractor MUST be the last argument
async fn handler(
    headers: HeaderMap,             // non-consuming first
    State(db): State<AppState>,    // non-consuming first
    Json(body): Json<CreateUser>,  // consuming LAST
) -> impl IntoResponse { }
```

### Optional extractors — rejection becomes 400 instead of skipping

```rust
// BUG: Missing header returns 400 Bad Request
async fn handler(
    TypedHeader(auth): TypedHeader<Authorization<Bearer>>,
) -> impl IntoResponse { }
// If Authorization header is missing → 400

// FIX: Use Option for optional extractors
async fn handler(
    auth: Option<TypedHeader<Authorization<Bearer>>>,
) -> impl IntoResponse {
    match auth {
        Some(TypedHeader(Authorization(bearer))) => {
            // authenticated
        }
        None => {
            // anonymous — handle accordingly
        }
    }
}
```

## State Management

### Shared state must be Clone — Arc pattern

```rust
// BUG: State not Clone — compile error
struct AppState {
    db: DatabasePool,  // DatabasePool might not implement Clone
}

let app = Router::new()
    .route("/", get(handler))
    .with_state(AppState { db: pool }); // ERROR if AppState isn't Clone

// FIX: Wrap in Arc
type SharedState = Arc<AppState>;

struct AppState {
    db: DatabasePool,
}

let shared = Arc::new(AppState { db: pool });
let app = Router::new()
    .route("/", get(handler))
    .with_state(shared);

async fn handler(State(state): State<SharedState>) -> impl IntoResponse {
    state.db.query("...").await
}
```

### State type mismatch — different routers with different state

```rust
// BUG: Merging routers with different state types
let api = Router::new()
    .route("/users", get(list_users))
    .with_state(api_state); // ApiState

let admin = Router::new()
    .route("/admin", get(dashboard))
    .with_state(admin_state); // AdminState

let app = api.merge(admin); // ERROR: state types don't match

// FIX: Use same state type or nest instead of merge
let app = Router::new()
    .nest("/api", api)
    .nest("/admin", admin)
    .with_state(app_state); // Single state type

// Or use Extension for per-router state
let admin = Router::new()
    .route("/admin", get(dashboard))
    .layer(Extension(admin_state));
```

## Error Handling

### IntoResponse for errors — don't return raw errors

```rust
// BUG: anyhow::Error doesn't implement IntoResponse
async fn handler() -> Result<Json<User>, anyhow::Error> {
    let user = db.find_user(1).await?;  // compiler error
    Ok(Json(user))
}

// FIX: Create an error type that implements IntoResponse
struct AppError(anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": self.0.to_string() })),
        ).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

async fn handler() -> Result<Json<User>, AppError> {
    let user = db.find_user(1).await?;  // works now
    Ok(Json(user))
}
```

### Error responses expose internals

```rust
// BUG: Internal error details leaked to client
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (StatusCode::INTERNAL_SERVER_ERROR,
         self.0.to_string()).into_response()  // exposes DB errors, paths, etc.
    }
}

// FIX: Log internally, return generic message
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        tracing::error!("Internal error: {:?}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR,
         Json(json!({ "error": "Internal server error" }))).into_response()
    }
}
```

## Middleware & Layers

### Middleware order — layers wrap INNER to OUTER

```rust
// BUG: Auth layer added but runs AFTER rate limit (wrong order)
let app = Router::new()
    .route("/api/data", get(handler))
    .layer(auth_layer)        // runs second (inner)
    .layer(rate_limit_layer); // runs first (outer)

// Axum layers are like an onion — last .layer() is outermost
// Request flows: rate_limit → auth → handler → auth → rate_limit

// FIX: If auth should run first (before rate limiting):
let app = Router::new()
    .route("/api/data", get(handler))
    .layer(rate_limit_layer)  // runs second (inner)
    .layer(auth_layer);       // runs first (outer)
```

### Tower timeout — not set by default

```rust
// BUG: No request timeout — slow handlers block forever
let app = Router::new().route("/", get(slow_handler));

// FIX: Add timeout layer
use tower::timeout::TimeoutLayer;
use std::time::Duration;

let app = Router::new()
    .route("/", get(slow_handler))
    .layer(TimeoutLayer::new(Duration::from_secs(30)));
```

## Validation

### Axum doesn't validate input by default

```rust
// BUG: Deserialized but not validated
#[derive(Deserialize)]
struct CreateUser {
    email: String,  // could be empty or invalid
    age: i32,       // could be negative
}

async fn create(Json(input): Json<CreateUser>) -> impl IntoResponse {
    // input.email could be "" — no validation!
}

// FIX: Use validator crate
use validator::Validate;

#[derive(Deserialize, Validate)]
struct CreateUser {
    #[validate(email)]
    email: String,
    #[validate(range(min = 0, max = 150))]
    age: i32,
}

async fn create(Json(input): Json<CreateUser>) -> Result<Json<User>, AppError> {
    input.validate()?;
    // Now safe to use
}
```

## Auth Patterns

### No built-in auth — must implement as extractor or middleware

```rust
// Common pattern: Auth extractor
struct AuthUser(User);

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, Json<Value>);

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = parts.headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or((StatusCode::UNAUTHORIZED, Json(json!({"error": "Missing token"}))))?;

        let user = verify_token(token)
            .map_err(|_| (StatusCode::UNAUTHORIZED, Json(json!({"error": "Invalid token"}))))?;

        Ok(AuthUser(user))
    }
}

// Usage — just add as parameter
async fn protected(AuthUser(user): AuthUser) -> impl IntoResponse {
    Json(json!({ "user": user.name }))
}
```

## Testing Patterns

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // for oneshot

    #[tokio::test]
    async fn test_create_user_validates_email() {
        let app = create_app();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/users")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"email":"not-an-email","age":25}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_requires_auth() {
        let app = create_app();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/protected")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
```

## Framework Gotchas

| Gotcha                                           | Detail                                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| Body-consuming extractor must be last parameter  | `Json`, `Form`, `Multipart`, `Bytes`, `String`, `Body`    |
| Layers wrap inner-to-outer                       | Last `.layer()` call runs first on request                |
| State must be `Clone + Send + Sync + 'static`    | Use `Arc<T>` for non-Clone types                          |
| `Router::merge()` requires same state type       | Use `Router::nest()` for different states                 |
| No built-in validation                           | Add `validator` crate manually                            |
| Error types must implement `IntoResponse`        | Create custom `AppError` wrapper                          |
| `oneshot()` consumes the router                  | Recreate or clone for multiple test requests              |
| Extractors that fail return their Rejection type | Use `Option<T>` or `Result<T, T::Rejection>` for optional |
