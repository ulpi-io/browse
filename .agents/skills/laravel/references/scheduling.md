# Scheduling — Schedule Definition, Overlap Prevention, Docker Container

## What

Scheduled tasks are defined in `routes/console.php` using the `Schedule` facade. **Not in `Kernel.php`** — the console kernel's `schedule()` method was removed in Laravel 11. Any code that registers schedules in `App\Console\Kernel` will silently do nothing.

The scheduler runs inside a dedicated Docker container that executes `php artisan schedule:run` every 60 seconds in a loop (see `docker.md`). The framework checks which tasks are due and runs them.

Key rules:
- Define all schedules in `routes/console.php` — never `Kernel.php`
- Always add `withoutOverlapping()` on tasks that run longer than one minute
- Always add `onOneServer()` when running multiple app instances
- Monitor every scheduled task — silent failures are the norm without health pings

## How

### Schedule definition in routes/console.php

```php
<?php
// routes/console.php

use Illuminate\Support\Facades\Schedule;
use App\Jobs\GenerateDailyReport;
use App\Jobs\PruneExpiredTokens;
use App\Jobs\SyncInventoryFromWarehouse;
use App\Jobs\CleanOrphanedMedia;

// Artisan commands
Schedule::command('telescope:prune')->daily();
Schedule::command('horizon:snapshot')->everyFiveMinutes();
Schedule::command('queue:prune-batches --hours=48')->daily();

// Queued jobs — dispatched to the queue, not run inline
Schedule::job(new GenerateDailyReport)->dailyAt('02:00')
    ->withoutOverlapping()
    ->onOneServer()
    ->runInBackground();

Schedule::job(new PruneExpiredTokens)->hourly()
    ->onOneServer();

// Closure — for simple one-liners
Schedule::call(fn () => cache()->tags(['stats'])->flush())
    ->dailyAt('00:00')
    ->onOneServer();

// External sync — long-running, overlap prevention mandatory
Schedule::job(new SyncInventoryFromWarehouse)->everyThirtyMinutes()
    ->withoutOverlapping(expiresAt: 25)  // lock expires after 25 minutes
    ->onOneServer()
    ->runInBackground()
    ->pingBefore(env('HEALTHCHECK_INVENTORY_START'))
    ->thenPing(env('HEALTHCHECK_INVENTORY_FINISH'));

// Weekly cleanup
Schedule::job(new CleanOrphanedMedia)->weeklyOn(1, '03:00')
    ->withoutOverlapping()
    ->onOneServer()
    ->runInBackground();
```

Three task types: `Schedule::command()` for Artisan commands, `Schedule::job()` for queued jobs, `Schedule::call()` for closures. Jobs dispatched via `Schedule::job()` go through the queue (processed by Horizon). Commands and closures run inline in the scheduler process.

### Frequency methods

| Method | Schedule |
|---|---|
| `everyMinute()` / `everyFiveMinutes()` / `everyTenMinutes()` / `everyThirtyMinutes()` | Sub-hourly intervals |
| `hourly()` / `hourlyAt(17)` | Hourly — at :00 or at specified minute |
| `daily()` / `dailyAt('02:00')` / `twiceDaily(1, 13)` | Daily — midnight, specific time, or twice |
| `weekly()` / `weeklyOn(1, '08:00')` | Weekly — Sunday midnight or specific day/time |
| `monthly()` / `monthlyOn(15, '03:00')` / `quarterly()` / `yearly()` | Monthly and beyond |
| `cron('15 3 * * 1-5')` | Raw cron expression |

Constrain further with `->weekdays()`, `->sundays()`, `->between('08:00', '17:00')`, `->unlessBetween('23:00', '04:00')`, `->environments(['production'])`, `->when(fn () => $condition)`, `->skip(fn () => $condition)`.

### withoutOverlapping() — mandatory for long tasks

Prevents a new instance from starting while the previous one is still running. Uses a cache lock (Redis). Always set this on any task that could exceed one minute:

```php
// Lock held for duration of task, released on completion
Schedule::command('reports:generate')->hourly()
    ->withoutOverlapping();

// Custom expiry — lock auto-releases after 20 minutes even if task hangs
Schedule::job(new SyncInventoryFromWarehouse)->everyThirtyMinutes()
    ->withoutOverlapping(expiresAt: 20);
```

Without `withoutOverlapping()`, a task running for 3 minutes on a 1-minute schedule stacks 3 concurrent instances — resource exhaustion and data corruption.

### onOneServer() — multi-instance deployments

When multiple scheduler containers or instances run (horizontal scaling, multiple servers), `onOneServer()` ensures only one instance executes the task. Requires a centralized cache driver (Redis):

```php
Schedule::job(new GenerateDailyReport)->dailyAt('02:00')
    ->withoutOverlapping()
    ->onOneServer();
```

If you run a single scheduler container, `onOneServer()` is still safe to include — zero overhead, protects against future scaling.

### runInBackground()

Runs the task as a background process so the scheduler is not blocked. Without this, a long task delays all subsequent tasks in the same minute:

```php
Schedule::command('reports:generate-pdf')->dailyAt('03:00')
    ->withoutOverlapping()
    ->onOneServer()
    ->runInBackground();
```

Use on any task longer than a few seconds. Always pair with `withoutOverlapping()`.

### Timezone handling

```php
// Per-task — for business-hour schedules
Schedule::job(new SendMarketingDigest)->dailyAt('09:00')
    ->timezone('America/New_York');

// Global in config/app.php — keep UTC, convert per-task as needed
'timezone' => 'UTC',
```

### Health check pings — dead man's switch monitoring

Ping external monitors (Healthchecks.io, Cronitor, Betteruptime) before/after execution. If the "after" ping never arrives, the monitor alerts:

```php
Schedule::job(new GenerateDailyReport)->dailyAt('02:00')
    ->withoutOverlapping()
    ->onOneServer()
    ->pingBefore(env('HEALTHCHECK_REPORT_START'))    // fires before task
    ->thenPing(env('HEALTHCHECK_REPORT_FINISH'))     // fires after (success or failure)
    ->pingOnSuccess(env('HEALTHCHECK_REPORT_SUCCESS'))
    ->pingOnFailure(env('HEALTHCHECK_REPORT_FAILURE'));
```

Store ping URLs in `.env` — never hardcode. These are no-ops when the env var is `null`, safe to leave unset in local dev.

### Monitoring via Pulse

Pulse tracks scheduled task execution times, success/failure rates, and overlap incidents. Cross-reference `observability.md` for Pulse setup. Pulse recorders capture scheduler data automatically — no extra configuration needed.

### schedule:list and schedule:test

```bash
php artisan schedule:list   # all tasks with frequencies and next due time
php artisan schedule:test   # manually trigger a task (interactive — select from list)
php artisan schedule:run    # run all due tasks (what the scheduler container executes)
```

`schedule:list` verifies registration — if a task does not appear, it is not in `routes/console.php`.

### The scheduler container

The scheduler runs in its own Docker container — same codebase, different entrypoint. From `docker-compose.yml` (see `docker.md` for the full topology):

```yaml
scheduler:
  build: { context: ., dockerfile: docker/scheduler/Dockerfile.dev }
  volumes: [".:/var/www/html"]
  depends_on:
    app: { condition: service_healthy }
  environment: *app-env
  command: >
    sh -c "while true; do php artisan schedule:run --verbose --no-interaction; sleep 60; done"
  networks: [app-network]
```

The loop runs `schedule:run` every 60 seconds, matching cron's minimum resolution. `--verbose` logs task execution. `--no-interaction` prevents prompts. The container needs the same env vars and Redis access as the app container for `onOneServer()` and `withoutOverlapping()` locks.

## When

| Situation | Approach |
|---|---|
| Periodic cleanup (prune tokens, logs, temp files) | `Schedule::command()` or `Schedule::job()` with `daily()` / `hourly()` |
| Report generation | `Schedule::job()` with `dailyAt()` + `withoutOverlapping()` + `runInBackground()` |
| Cache warming (precompute expensive queries) | `Schedule::call()` or `Schedule::job()` — see `caching.md` |
| External API sync (inventory, prices) | `Schedule::job()` + `withoutOverlapping()` + `onOneServer()` + health pings |
| Multiple app instances / horizontal scaling | Add `onOneServer()` to every task |
| Task runs longer than 1 minute | Add `withoutOverlapping()` — mandatory |
| Critical task that must not fail silently | Add `pingOnSuccess()` + `pingOnFailure()` to external monitor |
| Business-hours-only task | Add `->weekdays()->between('09:00', '17:00')->timezone('America/New_York')` |

## Never

- **Never define schedules in `Kernel.php`.** The console kernel `schedule()` method was removed in Laravel 11. Schedules belong in `routes/console.php`.
- **Never skip `withoutOverlapping()` on long-running tasks.** A 10-minute task on a 5-minute schedule stacks concurrent runs, causing data corruption and resource exhaustion.
- **Never skip `onOneServer()` in multi-instance deployments.** Without it, every instance runs every task — duplicated work, race conditions, double-sent notifications.
- **Never run scheduled tasks without monitoring.** Tasks fail silently by default. Use `pingOnSuccess()` / `pingOnFailure()` with an external dead man's switch.
- **Never hardcode health check URLs in schedule definitions.** Use `env('HEALTHCHECK_...')` — URLs differ per environment and are no-ops when null.
- **Never run the scheduler inside the app or worker container.** The scheduler gets its own container with the cron loop entrypoint (see `docker.md`). Mixing processes in one container prevents independent scaling and obscures failures.
- **Never use `runInBackground()` without `withoutOverlapping()`.** Background tasks are invisible to the scheduler — without overlap prevention, they stack up silently.
