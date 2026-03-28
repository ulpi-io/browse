# Observability — Telescope, Horizon Dashboard, Pulse, Health Checks

## What

Three first-party tools cover the observability stack: **Telescope** (dev debugging), **Horizon** (queue dashboard), and **Pulse** (production monitoring). Each serves a distinct environment and purpose — they do not overlap.

- **Telescope** — dev-only request/query/job inspector. Records everything. Never runs in production.
- **Horizon** — queue monitoring dashboard. Runs in all environments. Throughput, runtime, failure metrics.
- **Pulse** — production monitoring. Slow queries, slow requests, exceptions, queue depths, cache hit rates. Lightweight enough for prod.

Health check endpoints (`/health` for liveness, `/ready` for readiness) let Docker and load balancers verify the app and its dependencies. Mandatory for every deployment.

## How

### Telescope setup (dev only)

Install as a dev dependency so it never ships to production:

```bash
composer require laravel/telescope --dev
php artisan telescope:install
php artisan migrate
```

`app/Providers/TelescopeServiceProvider.php`:

```php
class TelescopeServiceProvider extends TelescopeApplicationServiceProvider
{
    public function register(): void
    {
        Telescope::night();
        $this->hideSensitiveRequestDetails();
        Telescope::filter(fn (IncomingEntry $entry): bool =>
            $this->app->environment('local') || $entry->isReportableException() || $entry->isFailedJob());
    }

    protected function hideSensitiveRequestDetails(): void
    {
        if ($this->app->environment('local')) { return; }
        Telescope::hideRequestParameters(['_token', 'password', 'password_confirmation']);
        Telescope::hideRequestHeaders(['cookie', 'x-csrf-token', 'x-xsrf-token']);
    }

    protected function gate(): void
    {
        Gate::define('viewTelescope', fn (?User $user): bool => $this->app->environment('local'));
    }
}
```

Register conditionally in `bootstrap/providers.php`:

```php
return [
    App\Providers\AppServiceProvider::class,
    ...array_filter([
        class_exists(\Laravel\Telescope\TelescopeServiceProvider::class)
            ? App\Providers\TelescopeServiceProvider::class : null,
    ]),
];
```

**Watchers** — enabled by default in `config/telescope.php`:

| Watcher | Records | Why |
|---|---|---|
| `RequestWatcher` | HTTP requests with headers, payload, response | Debug request flow |
| `QueryWatcher` | SQL queries with bindings and duration | Find slow queries, N+1 |
| `JobWatcher` | Job dispatch, execution, failure | Debug background processing |
| `MailWatcher` | Outgoing emails with preview | Verify content without sending |
| `NotificationWatcher` | All notifications across channels | Verify delivery |
| `CacheWatcher` | Cache hits, misses, writes, forgets | Tune caching strategy |
| `LogWatcher` | Log entries with context | Correlate logs to requests |
| `ExceptionWatcher` | Exceptions with stack traces | Debug errors in context |
| `GateWatcher` | Authorization checks | Debug policy/gate failures |
| `ModelWatcher` | Model events (created, updated, deleted) | Track data mutations |

Prune old entries on a schedule (see `scheduling.md`):

```php
// routes/console.php
Schedule::command('telescope:prune --hours=48')->daily();
```

### Horizon dashboard (queue monitoring)

Full Horizon config (supervisors, queues, job classes) lives in `queues-jobs.md`. This section covers the dashboard and metrics.

Dashboard at `/horizon`, protected by auth gate in `HorizonServiceProvider`:

```php
protected function gate(): void
{
    Gate::define('viewHorizon', fn (?User $user): bool => $user?->hasRole('admin') ?? false);
}
```

**Dashboard metrics:** throughput (jobs/minute per queue and job class), runtime (average and P99 per job), completion/failure rates, wait time, failed jobs with exception details and retry, searchable recent jobs list.

**Auto-scaling** in `config/horizon.php` (cross-reference `queues-jobs.md` for full config):

| Setting | Value | Purpose |
|---|---|---|
| `balance` | `auto` | Scale workers up/down based on workload (prod) |
| `autoScalingStrategy` | `time` | Scale by wait time, not queue size |
| `minProcesses` | `2` | Minimum workers always running |
| `maxProcesses` | `10` | Upper bound for auto-scaling |
| `balanceMaxShift` | `3` | Max workers added/removed per scale event |
| `balanceCooldown` | `3` | Seconds between scale decisions |

Balancing strategies: `auto` (recommended for production — scales dynamically) vs `simple` (fixed round-robin — use in local dev).

### Pulse setup (production monitoring)

```bash
composer require laravel/pulse
php artisan vendor:publish --provider="Laravel\Pulse\PulseServiceProvider"
php artisan migrate
```

Dashboard at `/pulse`, gate in `AppServiceProvider::boot()`: `Gate::define('viewPulse', fn (?User $user): bool => $user?->hasRole('admin') ?? false);`

**Recorders** in `config/pulse.php`:

```php
'recorders' => [
    SlowQueries::class     => ['enabled' => true, 'threshold' => 500,  'sample_rate' => 1.0],
    SlowRequests::class    => ['enabled' => true, 'threshold' => 1000, 'sample_rate' => 1.0],
    Exceptions::class      => ['enabled' => true, 'sample_rate' => 1.0, 'location' => true],
    Queues::class          => ['enabled' => true, 'sample_rate' => 1.0],
    CacheInteractions::class      => ['enabled' => true, 'sample_rate' => 1.0],
    SlowOutgoingRequests::class   => ['enabled' => true, 'threshold' => 1000, 'sample_rate' => 1.0],
    UserRequests::class           => ['enabled' => true, 'sample_rate' => 1.0],
],
'trim' => ['lottery' => [1, 1000], 'keep' => '7 days'],
```

All recorder classes are under `\Laravel\Pulse\Recorders\`. `threshold` is milliseconds. `sample_rate` of `1.0` records everything — reduce in high-traffic apps.

Scheduled cleanup (see `scheduling.md`):

```php
// routes/console.php
Schedule::command('pulse:check')->everyFiveSeconds();
Schedule::command('pulse:purge')->daily();
```

### Health check endpoints

| Endpoint | Probe | Checks | Returns |
|---|---|---|---|
| `/health` | Liveness | App running, PHP responds | `200` with `{"status": "ok"}` |
| `/ready` | Readiness | DB + Redis + queue connections | `200` or `503` with details |

```php
<?php
namespace App\Http\Controllers\API;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\{Cache, DB, Queue};

class HealthCheckController
{
    public function health(): JsonResponse
    {
        return response()->json(['status' => 'ok', 'timestamp' => now()->toIso8601String()]);
    }

    public function ready(): JsonResponse
    {
        $checks = []; $healthy = true;

        try { DB::connection()->getPdo(); $checks['database'] = 'ok'; }
        catch (\Throwable) { $checks['database'] = 'failed'; $healthy = false; }

        try { Cache::store('redis')->put('health:ping', true, 10);
              Cache::store('redis')->forget('health:ping'); $checks['redis'] = 'ok'; }
        catch (\Throwable) { $checks['redis'] = 'failed'; $healthy = false; }

        try { Queue::connection('redis')->size('default'); $checks['queue'] = 'ok'; }
        catch (\Throwable) { $checks['queue'] = 'failed'; $healthy = false; }

        return response()->json(
            ['status' => $healthy ? 'ok' : 'degraded', 'checks' => $checks],
            $healthy ? 200 : 503,
        );
    }
}
```

Routes — unauthenticated, excluded from rate limiting:

```php
// routes/api.php
Route::get('/health', [HealthCheckController::class, 'health']);
Route::get('/ready', [HealthCheckController::class, 'ready']);
```

Docker HEALTHCHECK uses these endpoints (see `docker.md`):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost/health || exit 1
```

### Alternative: spatie/laravel-health

Pre-built checks, failure notifications, and a dashboard. Use when you need more than the custom controller above:

```php
// AppServiceProvider::boot()
use Spatie\Health\Facades\Health;
use Spatie\Health\Checks\Checks\{DatabaseCheck, RedisCheck, CacheCheck, QueueCheck, UsedDiskSpaceCheck};

Health::checks([
    DatabaseCheck::new(), RedisCheck::new(), CacheCheck::new(),
    QueueCheck::new()->failWhenHealthJobTakesLongerThanMinutes(5),
    UsedDiskSpaceCheck::new()->warnWhenUsedSpaceIsAbovePercentage(70)->failWhenUsedSpaceIsAbovePercentage(90),
]);

// routes/api.php
Route::get('/health', \Spatie\Health\Http\Controllers\HealthCheckJsonResultsController::class);
```

## When

| Situation | Tool |
|---|---|
| Debug requests, queries, mail, events locally | Telescope |
| Find N+1 queries during development | Telescope `QueryWatcher` |
| Monitor queue throughput and failures | Horizon dashboard |
| Tune worker auto-scaling | Horizon config (see `queues-jobs.md`) |
| Track slow queries / requests in production | Pulse `SlowQueries` / `SlowRequests` |
| Monitor exceptions and queue depths in production | Pulse `Exceptions` / `Queues` |
| Docker liveness probe | `/health` endpoint |
| Docker readiness probe (check dependencies) | `/ready` endpoint |
| Pre-built health checks with notifications | `spatie/laravel-health` |

## Never

- **Never run Telescope in production.** Records every request, query, and job — massive performance hit and security risk. Install as `--dev`, register conditionally on `APP_ENV=local`.
- **Never expose Horizon dashboard without an auth gate.** Without `Gate::define('viewHorizon', ...)`, anyone sees job payloads and can retry failed jobs.
- **Never expose Pulse dashboard without an auth gate.** Slow queries, exception details, and user request patterns are sensitive operational data.
- **Never skip health check endpoints.** Without `/health` and `/ready`, Docker restarts are blind, load balancers route to broken instances, deployments proceed against dead dependencies.
- **Never check only liveness.** A `/health` returning 200 while the database is down routes traffic to an instance that cannot serve requests. Always implement `/ready` with dependency checks.
- **Never use Telescope as a production monitoring replacement.** Telescope is a debugger. Use Pulse for production metrics.
- **Never log sensitive data in Telescope watchers.** Call `hideSensitiveRequestDetails()` to strip passwords, tokens, and cookies from recorded entries.
- **Never ignore slow query alerts from Pulse.** A query crossing the threshold is a scaling problem. Investigate and optimize — do not raise the threshold to silence it.
