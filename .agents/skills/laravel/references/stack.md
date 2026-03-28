# Stack — Locked Decisions & Toolchain

Every other reference file assumes these decisions. Do not deviate.

## What

| Dependency | Version | Notes |
|---|---|---|
| PHP | 8.4+ | Readonly properties, enums, match, named args, intersection types, fibers |
| Laravel | 12 | API-only. No Blade, no Livewire, no Inertia, no views. |
| Database | MySQL 8.x | Primary data store |
| Cache / Queue driver | Redis 7.x | Always — both cache and queue use Redis |
| Auth (default) | Sanctum | First-party SPA and mobile token auth |
| Auth (OAuth2) | Passport | Only when third-party API access requires OAuth2 flows |
| Admin panel | Filament 3 | Self-contained panel at `/admin` — the only UI in the app |
| Testing | Pest | No PHPUnit syntax. `expect()->toBe()`, not `$this->assertEquals()`. |
| Code style | Pint | Laravel preset. Run via `composer lint`. |
| Queue dashboard | Horizon | Always — never bare `queue:work` |
| Feature flags | Pennant | First-party. Evaluate per-user or per-team feature rollouts. |

### API-only configuration

This stack has no web frontend. JSON responses via API Resources. No Blade templates, no Livewire components, no Inertia pages, no views directory. The only UI is the Filament admin panel, which runs as a separate panel and does not conflict with the API-only architecture.

Bootstrap with `laravel new --api` or manually strip the web middleware group, remove `resources/views/`, and remove frontend scaffolding packages.

### Strict model configuration

Enable in `AppServiceProvider::boot()` — non-negotiable:

```php
public function boot(): void
{
    Model::shouldBeStrict();
}
```

This enables three protections at once:
- `preventLazyLoading()` — throws on lazy loading (catches N+1 queries)
- `preventSilentlyDiscardingAttributes()` — throws when setting attributes not in `$fillable`
- `preventAccessingMissingAttributes()` — throws when accessing undefined attributes

### PHP 8.4 features to use

| Feature | Use for | Example |
|---|---|---|
| Readonly properties | DTOs, value objects | `public readonly string $email` |
| Enums | Status fields, fixed sets | `enum OrderStatus: string { case Pending = 'pending'; }` |
| `match` expression | Replace switch statements | `match($status) { OrderStatus::Pending => 'waiting' }` |
| Named arguments | Readability on long arg lists | `Cache::remember(key: $k, ttl: 3600, callback: fn() => ...)` |
| Constructor promotion | Models, DTOs, Actions | `public function __construct(private readonly UserRepository $users)` |
| First-class callables | Callbacks, collection ops | `$users->map($this->formatUser(...))` |
| Intersection types | Typed contracts | `function process(Countable&Iterator $items)` |

## How

### Package hierarchy

**First-party Laravel packages first. Spatie when no first-party exists. Community only when neither covers it.**

When evaluating a package for the project, walk this list top to bottom. Stop at the first match.

#### First-party packages (laravel/*)

| Package | Purpose | When to use |
|---|---|---|
| Sanctum | Token + SPA cookie auth | Default for all auth. Every project. |
| Passport | Full OAuth2 server | Only when third-party apps need OAuth2 flows |
| Horizon | Queue dashboard + process manager | Always. Replaces bare `queue:work`. |
| Telescope | Dev-time debugging dashboard | Local development only. Never in production. |
| Pulse | Production monitoring dashboard | Production. Slow queries, exceptions, queue depth. |
| Pennant | Feature flags | When you need per-user or per-team feature rollout |
| Socialite | OAuth social login | When users log in via Google, GitHub, etc. |
| Cashier | Subscription billing (Stripe/Paddle) | When the app has subscription payments |
| Reverb | WebSocket server | When the app needs real-time broadcasting |
| Pint | Code style fixer | Always. Laravel preset. |

#### Spatie packages (spatie/laravel-*)

| Package | Purpose | When to use |
|---|---|---|
| laravel-permission | Roles and permissions | When users have roles or granular permissions |
| laravel-data | Typed DTOs with validation | For structured data transfer between layers |
| laravel-query-builder | API filtering, sorting, includes | For list endpoints with filter/sort query params |
| laravel-activitylog | Audit trail | When you need to log who changed what and when |
| laravel-medialibrary | File attachments on models | When models own files (avatars, documents, images) |
| laravel-tags | Tagging system | When models need user-defined tags |
| laravel-sluggable | Automatic slug generation | When models need URL-friendly slugs |

**Optional Spatie package (not default):** `laravel-responsecache` — add only when full HTTP response caching is needed.

### Pint configuration

`pint.json` at project root with the Laravel preset. Add project-specific rules only when the team agrees on a deviation.

```json
{
    "preset": "laravel"
}
```

### Pest configuration

`pest.php` at project root:

```php
uses(Tests\TestCase::class, Illuminate\Foundation\Testing\RefreshDatabase::class)
    ->in('Feature');

uses(Tests\TestCase::class)
    ->in('Unit');
```

Run tests: `composer test`
Parallel testing: `php artisan test --parallel`
Coverage: `php artisan test --coverage --min=80`

### Composer scripts

```json
{
    "scripts": {
        "lint": "pint --test",
        "format": "pint",
        "test": "pest --parallel",
        "analyse": "phpstan analyse --memory-limit=512M",
        "ci": [
            "@lint",
            "@analyse",
            "@test"
        ]
    }
}
```

Static analysis uses PHPStan with the Larastan extension for Laravel-aware rules.

### Environment variables

| Context | Source | Rule |
|---|---|---|
| Local development | `.env` file | Git-ignored. Copy from `.env.example`. |
| Production / Docker | Real environment variables | Injected from secrets manager. Never `.env` in containers. |
| CI | Environment variables | Set in CI config (GitHub Actions secrets, etc.) |

`.env.example` is committed with placeholder values. `.env` is never committed.

### Observability stack

| Tool | Environment | Dashboard | Purpose |
|---|---|---|---|
| Telescope | Development only | `/telescope` | Request inspection, query debugging, job tracing |
| Horizon | All environments | `/horizon` | Queue monitoring, auto-scaling, failure tracking |
| Pulse | Production | `/pulse` | Slow queries, slow requests, exceptions, cache hit rates |

All three dashboards are protected by auth gates. Telescope must never be installed or registered in production — it is a performance and security risk.

## When

### Sanctum vs Passport

| Scenario | Choose |
|---|---|
| First-party SPA consuming your API | Sanctum (cookie-based session auth) |
| First-party mobile app | Sanctum (personal access tokens) |
| Third-party apps need OAuth2 authorization code flow | Passport |
| Machine-to-machine with client credentials | Passport |
| You are unsure | Sanctum. Upgrade to Passport only if OAuth2 is explicitly required. |

### Telescope vs Pulse

| Question | Answer |
|---|---|
| Debugging in local dev / inspecting a specific request? | Telescope |
| Monitoring production performance / aggregate metrics? | Pulse |

### When to add a Spatie package

Add when: (1) the need is confirmed, not speculative, (2) no first-party package covers it, (3) the Spatie package is the established standard. Do not pre-install all Spatie packages.

### When to add Pennant

Add when you need per-user/per-team feature rollout or server-side A/B testing. Do not use Pennant for simple boolean config flags — use `config()` values for those.

## Never

- **No `$guarded = []`** — use explicit `$fillable` on every model. `shouldBeStrict()` enforces this.
- **No bare `queue:work`** — use Horizon in every environment, including development.
- **No Blade, Livewire, or Inertia** — this is an API-only stack. JSON responses via API Resources.
- **No Telescope in production** — performance overhead and security risk. Use Pulse for prod monitoring.
- **No `.env` file in Docker images** — inject real env vars from secrets manager.
- **No PHPUnit assertion syntax** — use Pest's `expect()` API. `expect($x)->toBe($y)`, not `$this->assertEquals($y, $x)`.
- **No legacy accessor syntax** — use `Attribute::make(get:, set:)`, not `getFullNameAttribute()`.
- **No switch statements** — use `match` expressions.
- **No returning Eloquent models from controllers** — always use API Resources.
- **No inline validation** — always use Form Request classes.
- **No business logic in controllers** — delegate to Actions.
- **No community packages when a first-party or Spatie package covers the need** — follow the hierarchy.
- **No `Kernel.php`** — removed in Laravel 11+. Middleware goes in `bootstrap/app.php`, schedules in `routes/console.php`.
- **No `Handler.php`** — removed in Laravel 11+. Exception handling goes in `bootstrap/app.php` via `withExceptions()`.
