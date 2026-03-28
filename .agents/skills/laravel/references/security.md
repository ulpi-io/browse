# Security — Mass Assignment, SQL Injection, CORS, Rate Limiting, Webhooks, Hardening

## What

Security is enforced at multiple layers: Eloquent guards against mass assignment, query builder parameterization prevents SQL injection, CORS restricts cross-origin access, rate limiting blocks abuse, and webhook verification authenticates external callers. Every layer is configured explicitly — Laravel defaults are not sufficient for production.

Key dependencies: `Model::shouldBeStrict()` catches mass assignment violations (see `eloquent-models.md`). Redis backs rate limiting across instances (see `caching.md`). Rate limiter definitions live in `AppServiceProvider::boot()` — see `routing.md` for `RateLimiter::for()` code and `throttle:{name}` middleware. Webhook routes are excluded from `auth:sanctum` — see `routing.md` for route structure.

## How

### Mass assignment protection

Every model declares `$fillable` explicitly. `Model::shouldBeStrict()` enables `preventSilentlyDiscardingAttributes()` — any mass-assign of a field not in `$fillable` throws in development (see `eloquent-models.md` for production handler).

```php
class Order extends Model
{
    protected $fillable = ['user_id', 'status', 'total_cents', 'notes', 'shipped_at'];
    // NEVER: protected $guarded = [];
}
```

### SQL injection prevention

Always use Eloquent or query builder bindings. Never concatenate user input into SQL.

```php
// SAFE — Eloquent (parameterized automatically)
$user = User::where('email', $request->email)->first();

// SAFE — raw with explicit bindings
$results = DB::select('SELECT * FROM users WHERE email = ? AND active = ?', [$email, true]);
$orders = Order::whereRaw('total_cents > ? AND created_at > ?', [1000, $startDate])->get();
```

```php
// DANGEROUS — raw concatenation, SQL injection vector
$results = DB::select("SELECT * FROM users WHERE email = '$email'");
// DANGEROUS — column names from user input
$orders = Order::orderBy($request->input('sort'))->get();
```

For dynamic column names, validate against an allow-list before passing to `orderBy`:

```php
$allowed = ['created_at', 'total_cents', 'status'];
$sortBy = in_array($request->input('sort'), $allowed, strict: true)
    ? $request->input('sort')
    : 'created_at';
$orders = Order::orderBy($sortBy, 'desc')->paginate(15);
```

### CORS configuration

`config/cors.php` — restrictive in production, permissive in development:

```php
return [
    'paths' => ['api/*'],
    'allowed_methods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    'allowed_origins' => explode(',', env('CORS_ALLOWED_ORIGINS', 'http://localhost:3000')),
    'allowed_origins_patterns' => [],
    'allowed_headers' => ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    'exposed_headers' => ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    'max_age' => 86400,
    'supports_credentials' => true,
];
```

```dotenv
# Development
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
# Production — exact origin(s), never wildcard
CORS_ALLOWED_ORIGINS=https://app.example.com
```

Expose rate limit headers in `exposed_headers` so the client can read them from JavaScript.

### Rate limiting strategy

This section owns the **strategy rationale** — why each tier exists, which backend, and what the headers mean. See `routing.md` for `RateLimiter::for()` definition code and `throttle:{name}` middleware registration.

| Tier | Key | Limit | Protects against |
|------|-----|-------|------------------|
| Default API | User ID, fallback to IP | 60/min | General abuse, scraping |
| Auth endpoints | IP only | 10/min | Brute force, credential stuffing |
| Webhooks | Source IP | 120/min | Retry storms from providers |
| Expensive ops | User ID | 5/hour | Resource exhaustion (exports, reports) |

**Per-user for authenticated routes:** Keying by user ID ensures one abusive user does not exhaust the limit for others sharing the same IP (NAT, corporate proxies). Unauthenticated routes fall back to IP.

**Per-IP for auth endpoints:** Login and registration have no authenticated user yet. Keep the limit strict (10/min) to block credential stuffing.

**Redis backend:** Rate limiting state must be shared across all app instances. In-memory or file stores break in multi-container deployments. Redis is already in the stack.

**Response headers** (sent automatically by `throttle` middleware):
- `X-RateLimit-Limit` — max requests in the window
- `X-RateLimit-Remaining` — requests left before throttling
- `X-RateLimit-Reset` — Unix timestamp when the window resets

When exceeded, `429 Too Many Requests` with `Retry-After` header (seconds until reset).

### Webhook signature verification

Verify HMAC-SHA256 signature, check timestamp, enforce idempotency:

```php
// app/Http/Middleware/VerifyWebhookSignature.php
namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;

class VerifyWebhookSignature
{
    public function handle(Request $request, Closure $next): Response
    {
        $payload = $request->getContent();
        $secret = config('services.webhooks.secret');

        // 1. Verify HMAC-SHA256 signature
        $signature = $request->header('X-Signature-256');
        $expected = hash_hmac('sha256', $payload, $secret);
        if (! $signature || ! hash_equals($expected, $signature)) {
            throw new AccessDeniedHttpException('Invalid webhook signature.');
        }

        // 2. Reject payloads older than 5 minutes (replay prevention)
        $timestamp = (int) $request->header('X-Webhook-Timestamp');
        if (abs(time() - $timestamp) > 300) {
            throw new AccessDeniedHttpException('Webhook timestamp expired.');
        }

        // 3. Idempotency — skip already-processed webhooks
        $webhookId = $request->header('X-Webhook-ID');
        if ($webhookId && Cache::has("webhook:processed:{$webhookId}")) {
            return response()->json(['status' => 'already_processed'], 200);
        }

        $response = $next($request);

        if ($webhookId) {
            Cache::put("webhook:processed:{$webhookId}", true, now()->addHours(24));
        }
        return $response;
    }
}
```

Register the middleware alias in `bootstrap/app.php` — see `routing.md` for registration and route assignment. Adapt header names per provider: Stripe uses `Stripe-Signature` with `t=...;v1=...` format, GitHub uses `X-Hub-Signature-256`.

### Input sanitization

Form Requests handle type validation (see `form-requests.md`). Sanitize string inputs in `prepareForValidation()`:

```php
protected function prepareForValidation(): void
{
    $this->merge([
        'name' => strip_tags($this->input('name', '')),
        'bio' => strip_tags($this->input('bio', '')),
        'email' => strtolower(trim($this->input('email', ''))),
    ]);
}
```

For file uploads, validate MIME types strictly — never trust the client `Content-Type` header (see `form-requests.md` and `file-storage.md`).

### HTTPS enforcement

```php
// app/Providers/AppServiceProvider.php
public function boot(): void
{
    if (env('FORCE_HTTPS', false)) {
        URL::forceScheme('https');
    }
}
```

Set `FORCE_HTTPS=true` in production, `false` in local dev.

### Security headers middleware

```php
// app/Http/Middleware/SecurityHeaders.php
namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('X-Frame-Options', 'DENY');
        $response->headers->set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        $response->headers->set('X-XSS-Protection', '0');
        $response->headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->headers->set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        return $response;
    }
}
```

Register in `bootstrap/app.php`. These can also be set in nginx (see `docker.md`) — middleware ensures headers apply even without nginx.

### Dependency auditing

```bash
composer audit --format=json   # CI — fails the build on known vulnerabilities
composer audit                 # local check
```

Add before the test stage in CI (see `docker.md` for pipeline skeleton). Run on every push.

## When

| Situation | Action |
|---|---|
| Creating a new model | Declare `$fillable` with every mass-assignable field |
| Writing `whereRaw` or raw query | Always use `?` placeholders with bindings array |
| Dynamic sort/filter from user input | Validate against an allow-list before `orderBy` |
| Setting up CORS for a new frontend | Add exact origin to `CORS_ALLOWED_ORIGINS` in `.env` |
| Adding a new public endpoint | Ensure it has a rate limiter — consult tiers above |
| Receiving webhooks from a new provider | Build verification with HMAC + timestamp + idempotency |
| Deploying to production | `FORCE_HTTPS=true`, verify security headers, `composer audit` |
| Adding a new dependency | Run `composer audit` after install |
| Storing user-submitted text | Strip tags in `prepareForValidation()` |

## Never

- **Never use `$guarded = []`.** Disables mass assignment protection. Always use explicit `$fillable`.
- **Never concatenate user input into SQL.** Use Eloquent or bindings. `DB::select("... WHERE id = $id")` is an injection vector.
- **Never allow wildcard CORS in production.** `allowed_origins: ['*']` lets any domain make authenticated requests.
- **Never skip rate limiting on auth endpoints.** Login, registration, password reset are brute force targets. Strict per-IP limit.
- **Never trust webhook payloads without signature verification.** Verify HMAC-SHA256, check timestamp (> 5 min = reject), enforce idempotency.
- **Never pass user input as column names.** `Order::orderBy($request->sort)` allows injection. Validate against an allow-list.
- **Never serve API over plain HTTP in production.** Enforce HTTPS via `URL::forceScheme('https')` and HSTS.
- **Never skip `composer audit` in CI.** Vulnerable dependencies are the lowest-effort attack vector.
- **Never hardcode secrets in source code.** Use `env()` / `config()` with environment variables.
- **Never expose stack traces in production.** `APP_DEBUG=false`. Error handler returns safe codes only (see `error-handling.md`).
