# Rust Rocket Bug Patterns

> Detect: `Cargo.toml` has `rocket` dependency, files import from `rocket`, `#[launch]`/`#[get]`/`#[post]` macros, `rocket::build()` pattern.

## All Rust Bugs Apply

Rocket inherits ALL Rust bug patterns. See `rust.md`. This file covers **Rocket-specific** bugs only.

## Route & Guard Bugs

### Route attribute type mismatch — compiles but 404s at runtime

```rust
// BUG: Route param type doesn't match URL — silently returns 404
#[get("/users/<id>")]
fn get_user(id: i32) -> String {
    format!("User {id}")
}
// GET /users/abc → 404 (not 400!) because "abc" can't parse to i32

// FIX: Use Result for graceful error handling
#[get("/users/<id>")]
fn get_user(id: Result<i32, &str>) -> Result<String, Status> {
    match id {
        Ok(id) => Ok(format!("User {id}")),
        Err(_) => Err(Status::BadRequest),
    }
}

// Or use a custom FromParam implementation for validation
```

### Multiple routes with same rank — ambiguous matching

```rust
// BUG: Ambiguous routes — Rocket picks one non-deterministically
#[get("/files/<path..>")]
fn serve_file(path: PathBuf) -> Option<NamedFile> { }

#[get("/files/config")]
fn get_config() -> &'static str { "config" }
// Both match /files/config — which one wins?

// FIX: Set explicit rank (lower number = higher priority)
#[get("/files/config", rank = 1)]
fn get_config() -> &'static str { "config" }

#[get("/files/<path..>", rank = 2)]
fn serve_file(path: PathBuf) -> Option<NamedFile> { }
```

### Request guards — return Outcome, not Result

```rust
// BUG: Wrong return type for guard
#[rocket::async_trait]
impl<'r> FromRequest<'r> for AuthUser {
    type Error = AuthError;

    async fn from_request(request: &'r Request<'_>) -> request::Outcome<Self, Self::Error> {
        let token = request.headers().get_one("Authorization");
        match token {
            Some(t) => match verify_token(t) {
                Ok(user) => Outcome::Success(AuthUser(user)),
                Err(e) => Outcome::Error((Status::Unauthorized, AuthError::InvalidToken)),
            },
            // BUG: Using Outcome::Error for "no token" — returns 401 for all routes
            None => Outcome::Error((Status::Unauthorized, AuthError::MissingToken)),
        }
    }
}

// FIX: Use Outcome::Forward if the route should be skippable
None => Outcome::Forward(Status::Unauthorized),
// Forward lets Rocket try other matching routes
// Error stops route matching entirely
```

## State Management

### State must be managed before use

```rust
// BUG: State not managed — handler panics at request time
#[get("/")]
fn index(db: &State<DatabasePool>) -> String {
    // panics: State<DatabasePool> not managed
}

rocket::build()
    .mount("/", routes![index])
    // Missing: .manage(pool)

// FIX: Always .manage() state before mounting routes
rocket::build()
    .manage(pool)  // register state
    .mount("/", routes![index])
```

### State is read-only — use Mutex/RwLock for mutation

```rust
// BUG: Can't mutate State — it's behind a shared reference
#[post("/count")]
fn increment(counter: &State<u64>) -> String {
    *counter += 1;  // ERROR: can't mutate immutable reference
}

// FIX: Wrap mutable state in synchronization primitive
#[post("/count")]
fn increment(counter: &State<AtomicU64>) -> String {
    let val = counter.fetch_add(1, Ordering::Relaxed);
    format!("Count: {val}")
}

// Or for complex state:
#[post("/data")]
async fn update(state: &State<RwLock<AppData>>) -> String {
    let mut data = state.write().await;
    data.update();
    format!("Updated")
}
```

## Fairings (Middleware)

### Fairing execution order

```rust
// Fairings execute in attachment order
rocket::build()
    .attach(LogFairing)     // runs first
    .attach(AuthFairing)    // runs second
    .attach(CORSFairing)    // runs third
    .mount("/", routes![...])

// BUG: CORS fairing after auth — preflight OPTIONS requests get 401
// FIX: CORS before auth
rocket::build()
    .attach(CORSFairing)    // handles OPTIONS first
    .attach(AuthFairing)    // then checks auth
    .mount("/", routes![...])
```

## Responder Bugs

### Option<T> — None returns 404

```rust
// Surprising: Returning None gives 404, not 500 or empty
#[get("/users/<id>")]
fn get_user(id: i32) -> Option<Json<User>> {
    db.find(id).map(Json)  // None → 404
}

// This is actually correct behavior — but document it
// If you want a different status for "not found":
#[get("/users/<id>")]
fn get_user(id: i32) -> Result<Json<User>, Status> {
    db.find(id).map(Json).ok_or(Status::NotFound)
}
```

### Json responder — serialization errors become 500

```rust
// BUG: If serde serialization fails, Rocket returns opaque 500
#[get("/data")]
fn get_data() -> Json<ComplexType> {
    Json(data)  // if ComplexType has unserializable fields → 500
}

// FIX: Use Result to handle serialization explicitly
#[get("/data")]
fn get_data() -> Result<Json<ComplexType>, Status> {
    serde_json::to_value(&data)
        .map(|_| Json(data))
        .map_err(|_| Status::InternalServerError)
}
```

## Form & Data Validation

### Form data — Rocket validates structure but not business rules

```rust
#[derive(FromForm)]
struct LoginForm {
    username: String,  // Rocket ensures it exists and is a string
    password: String,  // But doesn't check length, format, etc.
}

// FIX: Add validation in handler or use custom FromForm
#[post("/login", data = "<form>")]
fn login(form: Form<LoginForm>) -> Result<String, Status> {
    if form.username.is_empty() || form.password.len() < 8 {
        return Err(Status::BadRequest);
    }
    // proceed
}
```

## Testing Patterns

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rocket::http::{ContentType, Status};
    use rocket::local::blocking::Client;

    #[test]
    fn test_create_user() {
        let client = Client::tracked(rocket()).expect("valid rocket");
        let response = client.post("/users")
            .header(ContentType::JSON)
            .body(r#"{"email":"test@example.com","name":"Test"}"#)
            .dispatch();

        assert_eq!(response.status(), Status::Created);
    }

    #[test]
    fn test_invalid_id_returns_400() {
        let client = Client::tracked(rocket()).expect("valid rocket");
        let response = client.get("/users/not-a-number").dispatch();
        assert_eq!(response.status(), Status::BadRequest);
    }

    #[test]
    fn test_requires_auth() {
        let client = Client::tracked(rocket()).expect("valid rocket");
        let response = client.get("/protected").dispatch();
        assert_eq!(response.status(), Status::Unauthorized);
    }
}
```

## Framework Gotchas

| Gotcha                                      | Detail                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Route param type mismatch → 404, not 400    | Non-parseable params silently skip the route             |
| `Option<T>` responder → None is 404         | Use `Result<T, Status>` for explicit status control      |
| State must be `.manage()`d before use       | Missing state panics at request time                     |
| `State<T>` is immutable                     | Use `State<Mutex<T>>` or `State<AtomicU64>` for mutation |
| `Outcome::Error` stops route matching       | Use `Outcome::Forward` to try other routes               |
| Fairings run in attachment order            | CORS fairing must come before auth fairing               |
| Route rank — lower number = higher priority | Set explicitly to avoid ambiguous matching               |
| `#[launch]` macro generates `main`          | Don't define your own `main` alongside it                |
