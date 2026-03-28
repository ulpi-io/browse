# Routing

## What

API routes live in `routes/api.php`. Laravel automatically prefixes every route in this file with `/api`. Versioning adds a second prefix (`/v1`), giving all endpoints the base URL `/api/v1/`. Route files available in a Laravel 12 API-only project:

| File | Purpose |
|------|---------|
| `routes/api.php` | All API routes — versioned groups, middleware, rate limiting |
| `routes/console.php` | Schedule definitions and Artisan closures (Laravel 12 — NOT `Kernel.php`) |
| `routes/channels.php` | Broadcast channel authorization (optional — only when using Reverb) |

There is no `routes/web.php` in an API-only project. If it exists, delete it.

Middleware is registered in `bootstrap/app.php` (Laravel 12 — NOT `Kernel.php`, which was removed). Rate limiters are defined in `AppServiceProvider::boot()` using `RateLimiter::for()`.

## How

### Full `routes/api.php` example

```php
<?php

use App\Http\Controllers\Api\V1\OrderController;
use App\Http\Controllers\Api\V1\ProductController;
use App\Http\Controllers\Api\V1\UserController;
use App\Http\Controllers\Api\V1\HealthCheckController;
use App\Http\Controllers\Api\V1\WebhookController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Health check — no auth, no version prefix
|--------------------------------------------------------------------------
*/
Route::get('/health', HealthCheckController::class)->name('health');

/*
|--------------------------------------------------------------------------
| Webhook routes — no auth, separate rate limit, signature verification
|--------------------------------------------------------------------------
*/
Route::prefix('webhooks')
    ->middleware(['throttle:webhooks', 'verify-webhook-signature'])
    ->group(function () {
        Route::post('/stripe', [WebhookController::class, 'stripe'])->name('webhooks.stripe');
        Route::post('/github', [WebhookController::class, 'github'])->name('webhooks.github');
    });

/*
|--------------------------------------------------------------------------
| API v1 — public routes (no auth)
|--------------------------------------------------------------------------
*/
Route::prefix('v1')->as('api.v1.')->group(function () {
    Route::get('/products', [ProductController::class, 'index'])->name('products.index');
    Route::get('/products/{product}', [ProductController::class, 'show'])->name('products.show');
});

/*
|--------------------------------------------------------------------------
| API v1 — authenticated routes
|--------------------------------------------------------------------------
*/
Route::prefix('v1')
    ->as('api.v1.')
    ->middleware(['auth:sanctum', 'throttle:api'])
    ->group(function () {
        // Orders — full CRUD
        Route::apiResource('orders', OrderController::class);

        // Users — profile management
        Route::get('/users/me', [UserController::class, 'show'])->name('users.show');
        Route::put('/users/me', [UserController::class, 'update'])->name('users.update');
    });
```

### Invokable controller registration

For single-action endpoints, register the controller class directly without specifying a method. The controller must implement `__invoke()`. See `controller-pattern.md` for the class structure.

```php
use App\Http\Controllers\Api\V1\HealthCheckController;
use App\Http\Controllers\Api\V1\ExportOrdersCsvController;

// Invokable — single-action controller
Route::get('/health', HealthCheckController::class)->name('health');
Route::post('/v1/orders/export', ExportOrdersCsvController::class)
    ->middleware('auth:sanctum')
    ->name('api.v1.orders.export');
```

### Resource routes

`Route::apiResource()` registers five routes excluding `create` and `edit` (no views in an API):

| Method | URI | Action | Route name |
|--------|-----|--------|------------|
| GET | `/orders` | index | orders.index |
| POST | `/orders` | store | orders.store |
| GET | `/orders/{order}` | show | orders.show |
| PUT/PATCH | `/orders/{order}` | update | orders.update |
| DELETE | `/orders/{order}` | destroy | orders.destroy |

```php
// Full CRUD resource
Route::apiResource('orders', OrderController::class);

// Partial resource — only the routes you need
Route::apiResource('products', ProductController::class)->only(['index', 'show']);

// Nested resource — /orders/{order}/items
Route::apiResource('orders.items', OrderItemController::class)->shallow();
```

### Route model binding

Laravel resolves `{order}` to an `Order` model instance automatically by primary key. Customize the lookup column by overriding `getRouteKeyName()` on the model:

```php
// app/Models/Order.php
public function getRouteKeyName(): string
{
    return 'uuid'; // Resolves /orders/{order} by the uuid column
}
```

Scoped bindings enforce parent-child relationships in nested routes:

```php
// /users/{user}/orders/{order} — order must belong to user
Route::get('/users/{user}/orders/{order}', [OrderController::class, 'show'])
    ->scopeBindings();
```

### Middleware registration in `bootstrap/app.php`

All middleware is registered here — there is no `Kernel.php` in Laravel 12.

```php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__ . '/../routes/api.php',
        commands: __DIR__ . '/../routes/console.php',
        channels: __DIR__ . '/../routes/channels.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->api(append: [
            \App\Http\Middleware\ForceJsonResponse::class,
        ]);
        $middleware->alias([
            'verify-webhook-signature' => \App\Http\Middleware\VerifyWebhookSignature::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // See error-handling.md
    })
    ->create();
```

### Rate limiter definitions

Define rate limiters in `AppServiceProvider::boot()` using `RateLimiter::for()`. These definitions own the throttle logic — routes reference them by name via `throttle:{name}` middleware.

```php
// In AppServiceProvider::boot()

// Default API rate limit — per authenticated user, fallback to IP
RateLimiter::for('api', function (Request $request) {
    return Limit::perMinute(60)->by(
        $request->user()?->id ?: $request->ip()
    );
});

// Stricter limit for auth endpoints (login, register, password reset)
RateLimiter::for('auth', function (Request $request) {
    return Limit::perMinute(10)->by($request->ip());
});

// Webhook rate limit — per source IP
RateLimiter::for('webhooks', function (Request $request) {
    return Limit::perMinute(120)->by($request->ip());
});

// Expensive operations — tighter per-user limit
RateLimiter::for('exports', function (Request $request) {
    return Limit::perHour(5)->by($request->user()->id);
});
```

Rate limit response headers are sent automatically when using the `throttle` middleware:
- `X-RateLimit-Limit` — max requests in the window
- `X-RateLimit-Remaining` — requests left
- `X-RateLimit-Reset` — Unix timestamp when the window resets

Redis is the backend for all rate limiting. It distributes limits across multiple app instances.

### Webhook routes

Webhook routes are excluded from `auth:sanctum` (external services cannot authenticate as your users). In an API-only project, there is no CSRF concern (CSRF protection applies only to the web middleware group, which does not exist). Webhook routes require: (1) a dedicated rate limit group with higher throughput, (2) signature verification middleware (see `security.md` for HMAC implementation), (3) placement outside the `auth:sanctum` group. See the full `routes/api.php` example above for the complete pattern.

### API versioning strategy

Version via URL prefix: `/api/v1/`, `/api/v2/`. Each version gets its own controller directory (`Http/Controllers/Api/V1/`, `Http/Controllers/Api/V2/`) and its own `prefix('v2')->as('api.v2.')` route group. Non-breaking changes (new fields, new endpoints, new optional parameters) go in the current version. A new version is only created for backward-incompatible changes (removed fields, changed response shape, altered validation rules). Both versions run simultaneously while the old version is deprecated with a removal timeline.

### Route caching

In production, cache routes for faster registration:

```bash
php artisan route:cache
```

Run as part of the deployment pipeline (see `docker.md` for the Artisan optimize pipeline). Never cache routes in development — the cache must be cleared and rebuilt on every change.

## When

| Situation | Pattern |
|-----------|---------|
| Standard CRUD for a resource | `Route::apiResource('orders', OrderController::class)` |
| Partial CRUD (read-only) | `Route::apiResource('products', ProductController::class)->only(['index', 'show'])` |
| Single-action endpoint (health, export, webhook) | `Route::get('/health', HealthCheckController::class)` (invokable) |
| Nested resource (order items) | `Route::apiResource('orders.items', OrderItemController::class)->shallow()` |
| Endpoint needs auth | Place inside `middleware('auth:sanctum')` group |
| Endpoint is public | Place outside any auth middleware group |
| Webhook from external service | Separate group, no auth, webhook signature middleware, own rate limit |
| Expensive endpoint (reports, exports) | Apply a tighter per-user rate limit: `throttle:exports` |
| New API version needed | Create `V2` controller directory + `prefix('v2')` route group. Only for breaking changes. |
| Lookup resource by slug instead of ID | Override `getRouteKeyName()` on the model |

## Never

- **Never define routes in `routes/web.php`.** This is an API-only project. If the file exists, delete it.
- **Never register middleware in `Kernel.php`.** It was removed in Laravel 12. Use `bootstrap/app.php`.
- **Never hardcode rate limits inline.** Define all limiters in `AppServiceProvider::boot()` with `RateLimiter::for()`, then reference by name: `throttle:api`.
- **Never skip rate limiting on auth endpoints.** Login, registration, and password reset need a strict per-IP limit to prevent brute force.
- **Never expose webhook routes without signature verification middleware.** External payloads must be verified (HMAC-SHA256 + timestamp check). See `security.md`.
- **Never create a new API version for additive changes.** New fields, new endpoints, and new optional parameters are non-breaking and go in the current version.
- **Never use `Route::resource()` for API routes.** It includes `create` and `edit` (form views). Use `Route::apiResource()` which excludes them.
- **Never use closure routes in `routes/api.php`.** They cannot be cached by `route:cache`. Always point to controller classes.
- **Never return responses directly from routes.** Route to a controller. Even single-action endpoints use an invokable controller (see `controller-pattern.md`).
