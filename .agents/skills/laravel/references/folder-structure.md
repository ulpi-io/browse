# Folder Structure

## What

Laravel 12 API-only project structure. No Blade, no Livewire, no Inertia, no `resources/views/`. JSON responses via API Resources. Business logic lives in Actions (one class per operation). Filament admin panel is the only UI — self-contained at `/admin`. Every directory has a single responsibility.

## How

### Full `app/` tree

```
app/
├── Actions/                    # Business logic — one class per operation
│   ├── Order/                  # Domain subdirectory
│   │   ├── CreateOrder.php     # Single execute() method, wraps DB::transaction()
│   │   ├── CancelOrder.php     # Verb + Noun naming
│   │   └── UpdateOrder.php
│   └── User/
│       ├── RegisterUser.php
│       └── UpdateUserProfile.php
│
├── Console/Commands/           # Custom Artisan commands (only if needed)
│   └── PruneExpiredTokens.php
│
├── Data/                       # DTOs via spatie/laravel-data
│   ├── OrderData.php           # Typed properties, validation via #[Rule] attributes
│   ├── UserData.php            # Nested DTOs supported (AddressData inside UserData)
│   └── AddressData.php
│
├── Enums/                      # PHP 8.4 backed enums
│   ├── OrderStatus.php         # enum OrderStatus: string { case Pending = 'pending'; ... }
│   └── UserRole.php            # Used in casts, Rule::enum(), Filament selects
│
├── Events/                     # Event classes — dispatched from Actions after mutations
│   ├── OrderCreated.php
│   └── UserRegistered.php
│
├── Exceptions/                 # Custom exception classes — extend HttpException
│   ├── OrderNotFoundException.php
│   └── InsufficientStockException.php
│
├── Http/
│   ├── Controllers/
│   │   └── Api/
│   │       └── V1/             # Versioned API controllers — /api/v1/
│   │           ├── OrderController.php    # Thin: validate, delegate, return
│   │           ├── UserController.php     # 3-5 lines per method
│   │           └── HealthCheckController.php  # Invokable (__invoke)
│   ├── Middleware/              # Custom middleware classes
│   │   ├── ForceJsonResponse.php    # Accept: application/json on all API requests
│   │   └── VerifyWebhookSignature.php
│   ├── Requests/               # Form Request validation classes
│   │   ├── Order/
│   │   │   ├── StoreOrderRequest.php    # rules(), authorize(), prepareForValidation()
│   │   │   └── UpdateOrderRequest.php
│   │   └── User/
│   │       ├── RegisterUserRequest.php
│   │       └── UpdateUserRequest.php
│   └── Resources/              # API Resource response transformers
│       ├── OrderResource.php          # JsonResource — shapes JSON output
│       ├── OrderCollection.php        # ResourceCollection — pagination envelope
│       └── UserResource.php
│
├── Jobs/                       # Queued job classes (ShouldQueue) — pass IDs, not models
│   ├── SendOrderConfirmation.php
│   └── GenerateInvoicePdf.php
│
├── Listeners/                  # Event listeners — ShouldQueue for async side effects
│   ├── SendWelcomeNotification.php
│   └── LogOrderActivity.php
│
├── Mail/                       # Mailable classes (complex email templates)
│   └── InvoiceMail.php
│
├── Models/                     # Eloquent models — relationships, scopes, casts ONLY
│   ├── Order.php               # $fillable, $casts, relationships — no business logic
│   ├── User.php
│   └── Product.php
│
├── Notifications/              # Notification classes (multi-channel, ShouldQueue always)
│   └── OrderShippedNotification.php
│
├── Observers/                  # Model observers — complex cross-cutting behavior
│   └── OrderObserver.php
│
├── Policies/                   # Authorization policies — one per model
│   ├── OrderPolicy.php         # viewAny, view, create, update, delete
│   └── UserPolicy.php
│
├── Providers/                  # Service providers
│   ├── AppServiceProvider.php  # Model::shouldBeStrict(), bindings, rate limiters
│   └── HorizonServiceProvider.php
│
└── Rules/                      # Custom validation rule classes
    └── ValidCouponCode.php
```

### Project root and supporting directories

```
project-root/
├── app/                        # Application code (see tree above)
├── bootstrap/
│   └── app.php                 # Middleware, exception handler (Laravel 12 — NOT Kernel.php)
├── config/                     # Configuration files — all env-driven
├── database/
│   ├── factories/              # Model factories — states, relationships, sequences
│   ├── migrations/             # Timestamped migration files
│   └── seeders/                # Idempotent, environment-aware seeders
├── docker/                     # Per-service config (see docker.md)
│   ├── app/                    # Dockerfile.dev + Dockerfile.prod
│   ├── nginx/                  # Dockerfile + nginx.conf
│   ├── worker/                 # Horizon entrypoint
│   ├── scheduler/              # Cron loop entrypoint
│   └── data/                   # mysql/ + redis/ — gitignored
├── routes/
│   ├── api.php                 # All API routes — versioned groups (/api/v1/)
│   ├── console.php             # Schedule definitions (Laravel 12 — NOT Kernel.php)
│   └── channels.php            # Broadcast channel authorization (optional)
├── tests/
│   ├── Feature/Api/V1/         # API endpoint tests — mirrors Controllers/
│   │   ├── OrderControllerTest.php
│   │   └── UserControllerTest.php
│   └── Unit/Actions/           # Business logic tests — mirrors Actions/
│       └── Order/
│           └── CreateOrderTest.php
├── docker-compose.yml          # All services, reads .env, zero hardcoded values
├── pint.json                   # Laravel preset + project rules
└── phpstan.neon                # Larastan config
```

### Naming conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Actions | Verb + Noun | `CreateOrder`, `CancelOrder`, `UpdateUserProfile` |
| Controllers | Resource + `Controller` | `OrderController`, `UserController` |
| Form Requests | Verb + Resource + `Request` | `StoreOrderRequest`, `UpdateOrderRequest` |
| API Resources | Resource + `Resource` / `Collection` | `OrderResource`, `OrderCollection` |
| Policies | Resource + `Policy` | `OrderPolicy`, `UserPolicy` |
| DTOs | Resource + `Data` | `OrderData`, `UserData` |
| Enums | Noun | `OrderStatus`, `UserRole` |
| Events | Resource + PastVerb | `OrderCreated`, `UserRegistered` |
| Jobs | Verb + Noun | `SendOrderConfirmation`, `GenerateInvoicePdf` |
| Database columns | snake_case | `created_at`, `user_id`, `order_status` |
| JSON response keys | camelCase (via API Resources) | `createdAt`, `userId`, `orderStatus` |
| Routes (URLs) | kebab-case, plural nouns | `/api/v1/order-items`, `/api/v1/users` |
| Route names | dot notation | `api.v1.orders.index`, `api.v1.orders.store` |

### Where logic lives

| Concern | Location |
|---------|----------|
| Business logic (mutations, calculations) | `Actions/{Domain}/` |
| Input validation | `Http/Requests/` |
| Authorization | `Policies/` |
| Response shaping | `Http/Resources/` |
| Data access, relationships, scopes | `Models/` |
| Typed data transfer between layers | `Data/` |
| Decoupled side effects | `Events/` + `Listeners/` |
| Async processing via Horizon | `Jobs/` |

## When

**Where does this new file go?**

| Type | Path |
|------|------|
| Business logic (create, update, calculate) | `app/Actions/{Domain}/{VerbNoun}.php` |
| HTTP input validation | `app/Http/Requests/{Domain}/{VerbResourceRequest}.php` |
| JSON response shaping | `app/Http/Resources/{Resource}Resource.php` |
| Typed data transfer object | `app/Data/{Resource}Data.php` |
| API controller | `app/Http/Controllers/Api/V1/{Resource}Controller.php` |
| Fixed-value status/type/category | `app/Enums/{Name}.php` |
| Model authorization | `app/Policies/{Resource}Policy.php` |
| Post-mutation side effect | `app/Events/` + `app/Listeners/` (ShouldQueue) |
| Async heavy work | `app/Jobs/{VerbNoun}.php` |
| API endpoint test | `tests/Feature/Api/V1/{Resource}ControllerTest.php` |
| Action unit test | `tests/Unit/Actions/{Domain}/{VerbNoun}Test.php` |

**When to create a domain subdirectory:** Actions and Form Requests are grouped by domain (`Actions/Order/`, `Requests/Order/`). Create a domain subdirectory when you have two or more related classes. Models, Resources, Policies, and Enums stay flat — subdirectories only if the project grows beyond 15+ files in one directory.

**When to add a new API version:** Create `Http/Controllers/Api/V2/` and a corresponding `v2` prefix group in `routes/api.php` only when introducing breaking changes. Non-breaking additions go in the current version.

## Never

- **Never put business logic in Controllers.** Controllers validate (Form Request), delegate (Action), return (API Resource). Nothing else.
- **Never put business logic in Models.** Models define relationships, scopes, casts, and `$fillable`. Calculations, API calls, and orchestration belong in Actions.
- **Never create `resources/views/` or Blade files.** This is an API-only project. Filament provides its own views at `/admin`.
- **Never return Eloquent models directly from Controllers.** Always wrap in an API Resource — it controls what the client sees.
- **Never skip the version directory.** Controllers go in `Api/V1/`, not directly in `Controllers/`.
- **Never use flat Actions without domain grouping.** `Actions/CreateOrder.php` is wrong. Use `Actions/Order/CreateOrder.php`.
- **Never define schedules in `Kernel.php`.** Laravel 12 uses `routes/console.php`. The Kernel was removed.
- **Never register middleware in `Kernel.php`.** Laravel 12 uses `bootstrap/app.php` for middleware.
- **Never create a `Services/` directory with god classes.** One Action per operation. If you need shared utilities between Actions, extract a focused helper Action that other Actions compose.
- **Never mix test types.** Feature tests (HTTP endpoint tests) go in `tests/Feature/`, unit tests (isolated logic) go in `tests/Unit/`. Mirror the `app/` structure in each.
