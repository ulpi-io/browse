# Caching — Redis Driver, Patterns, Invalidation, TTL Strategy

## What

All caching uses **Redis**. File-based and database cache drivers are never used in production. Redis runs as a dedicated container (see `docker.md`), shared by the cache store and queue driver.

Core API:
- `Cache::remember($key, $ttl, $callback)` — get or compute and store
- `Cache::rememberForever($key, $callback)` — never expires, invalidate manually
- `Cache::forget($key)` — delete a key
- `Cache::tags([...])->remember(...)` — tagged cache for granular invalidation
- `Cache::tags([...])->flush()` — invalidate all entries under a tag

Cache invalidation happens **in Actions after mutations** — never rely on TTL alone for data consistency. TTL is a safety net, not a strategy.

## How

### Redis driver configuration

`.env`:
```dotenv
CACHE_STORE=redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=null
REDIS_CACHE_DB=1
```

`config/database.php` — separate Redis databases for cache (`REDIS_CACHE_DB=1`) and queue (`REDIS_DB=0`) to allow independent flushes:
```php
'redis' => [
    'client' => env('REDIS_CLIENT', 'phpredis'),
    'default' => [
        'host' => env('REDIS_HOST', '127.0.0.1'), 'port' => env('REDIS_PORT', 6379),
        'password' => env('REDIS_PASSWORD'), 'database' => env('REDIS_DB', 0),
    ],
    'cache' => [
        'host' => env('REDIS_HOST', '127.0.0.1'), 'port' => env('REDIS_PORT', 6379),
        'password' => env('REDIS_PASSWORD'), 'database' => env('REDIS_CACHE_DB', 1),
    ],
],
```

`config/cache.php`:
```php
'default' => env('CACHE_STORE', 'redis'),
'stores' => [
    'redis' => ['driver' => 'redis', 'connection' => 'cache', 'lock_connection' => 'default', 'prefix' => env('CACHE_PREFIX', 'app')],
],
```

### Cache key conventions

Pattern: `{resource}:{identifier}:{variant}` — colon-delimited, lowercase. Examples: `orders:123:with-items`, `users:456:permissions`, `stats:dashboard:daily`. Never use raw user input in keys — hash or sanitize first.

### Cache::remember and Cache::rememberForever

```php
final class GetOrderWithItems
{
    public function execute(int $orderId): Order
    {
        return Cache::tags(['orders', "orders:{$orderId}"])
            ->remember(
                key: "orders:{$orderId}:with-items",
                ttl: now()->addMinutes(15),
                callback: fn () => Order::with(['items.product', 'user'])->findOrFail($orderId),
            );
    }
}

final class GetPermissionsForRole
{
    public function execute(string $roleName): Collection
    {
        return Cache::tags(['permissions'])
            ->rememberForever(
                key: "permissions:role:{$roleName}",
                callback: fn () => Role::findByName($roleName)->permissions->pluck('name'),
            );
    }
}
```

Use `rememberForever` only for data with explicit invalidation (config, permissions, static lookups). Every `rememberForever` must have a corresponding `flush` in a mutation Action.

### Cache tags — granular invalidation

Tags group related entries for targeted flushing. Redis required (file/database drivers do not support tags).

```php
// Writing — tag by resource type AND specific resource
Cache::tags(['orders', "orders:{$orderId}"])->remember("orders:{$orderId}:summary", ...);
Cache::tags(['orders', "user:{$userId}:orders"])->remember("users:{$userId}:order-list", ...);

// Flushing — targeted invalidation
Cache::tags(["orders:{$orderId}"])->flush();         // one order's caches
Cache::tags(["user:{$userId}:orders"])->flush();     // one user's order caches
Cache::tags(['orders'])->flush();                     // ALL order caches (nuclear option)
```

Tag strategy: resource type tag (`orders`) for broad invalidation, specific resource tag (`orders:123`) for single-record mutation, owner tag (`user:456:orders`) for per-user invalidation.

### Cache invalidation in Actions

Every mutation Action invalidates relevant caches. Invalidation lives next to the mutation, not in observers or events:

```php
final class UpdateOrder
{
    public function execute(Order $order, OrderData $data): Order
    {
        return DB::transaction(function () use ($order, $data) {
            $order->update(['status' => $data->status, 'notes' => $data->notes]);

            Cache::tags(["orders:{$order->id}"])->flush();
            Cache::tags(["user:{$order->user_id}:orders"])->flush();

            return $order->fresh();
        });
    }
}
```

### Query caching in list endpoints

Cache expensive filtered queries with short TTL. Build cache keys from query parameters so different filters produce different keys:

```php
// In controller — deterministic cache key from request params
$cacheKey = 'orders:user:' . $user->id . ':' . md5(serialize($request->query()));

// In Action — cache the paginated result
return Cache::tags(['orders', "user:{$userId}:orders"])
    ->remember($cacheKey, now()->addMinutes(5), fn () =>
        Order::where('user_id', $userId)->with('items')->latest()->paginate(15),
    );
```

### Response caching (optional — spatie/laravel-responsecache)

Full HTTP response caching for read-heavy public endpoints. Not in the default stack — add when needed:

```php
// bootstrap/app.php — register middleware
->withMiddleware(fn (Middleware $middleware) =>
    $middleware->append(\Spatie\ResponseCache\Middlewares\CacheResponse::class))

// Invalidate in Actions after mutations
ResponseCache::clear(); // or selective per-request invalidation
```

Use `Cache::remember` in Actions for most cases. Reserve `responsecache` for public, high-traffic endpoints.

### Cache warming — scheduled precomputation

Precompute expensive caches during off-peak hours via scheduled jobs (see `scheduling.md`):

```php
// routes/console.php
Schedule::call(function () {
    $stats = DB::table('orders')->selectRaw('COUNT(*) as total, SUM(total_cents) as revenue')
        ->where('created_at', '>=', now()->startOfDay())->first();
    Cache::tags(['stats'])->put('stats:dashboard:daily', $stats, now()->addHours(2));
})->dailyAt('02:00')->withoutOverlapping();
```

### TTL strategy by data type

| Data type | TTL | Rationale |
|---|---|---|
| Config / settings | 1 hour | Rarely changes, invalidate on update |
| User permissions / roles | 15 minutes | Security-sensitive, short stale window |
| API list responses | 5 minutes | Frequently changing, balance freshness vs load |
| Aggregated stats / reports | 30 minutes | Expensive to compute, tolerates staleness |
| Static content / translations | 24 hours | Rarely changes, invalidate on deploy |
| Single resource (show endpoint) | 15 minutes | Invalidated on mutation, TTL is safety net |

## When

| Situation | Approach |
|---|---|
| Expensive query, same result for many requests | `Cache::remember()` with tags |
| Rarely-changing lookup data (permissions, config) | `Cache::rememberForever()` + explicit invalidation |
| After create/update/delete | `Cache::tags([...])->flush()` in the mutation Action |
| List endpoint with filters | Cache with key from query params, 5-minute TTL |
| Full HTTP response caching for public endpoints | `spatie/laravel-responsecache` (optional) |
| Expensive aggregation (dashboard stats) | Cache warming via scheduled job |
| Invalidate one record's caches | Tag with specific ID (`orders:123`), flush that tag |
| Invalidate all caches for a resource type | Tag with resource type (`orders`), flush that tag |

## Never

- **Never use file or database cache in production.** Redis only. File caches break in multi-instance deployments.
- **Never rely on TTL alone for data consistency.** Mutation Actions must explicitly invalidate. Users must not see stale data after saving.
- **Never cache without a corresponding invalidation path.** Every `remember` must have a `flush` in the relevant mutation Action.
- **Never cache per-user data without user-specific keys or tags.** `Cache::remember('orders', ...)` serves user A's data to user B. Scope with `"user:{$userId}:orders"`.
- **Never put dynamic user input directly in cache keys.** Hash with `md5(serialize($request->query()))`.
- **Never cache inside models or observers.** Cache logic belongs in Actions. Observers make invalidation invisible.
- **Never over-cache.** A 2ms query that changes every minute gains nothing. Cache when expensive (>50ms) or high frequency.
- **Never `Cache::flush()` without tags in production.** Untagged flush wipes the entire store. Use `Cache::tags([...])->flush()`.
