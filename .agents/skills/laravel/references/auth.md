# Authentication & Authorization

## What

**Sanctum** is the default — first-party SPA (cookie-based session) and mobile (personal access tokens). **Passport** only when OAuth2 is required for third-party API consumers. Roles/permissions via **spatie/laravel-permission**. Per-model authorization via **Policies**. Non-model authorization via **Gates**.

Guards: `config/auth.php`. Middleware registration: `bootstrap/app.php` (Laravel 12 — NOT `Kernel.php`). Stack: `auth:sanctum`, `verified`, `can:`, `role:`, `permission:`.

## How

### Sanctum setup

Ships with Laravel. Install if not present: `php artisan install:api`. SPA auth uses cookie-based sessions (no tokens needed for same-domain web apps). Mobile/API auth uses personal access tokens via `createToken()`, hashed in `personal_access_tokens` table.

### Registration Action

```php
namespace App\Actions\Auth;

use App\Models\User;
use Illuminate\Support\Facades\{DB, Hash};

final class RegisterUser
{
    public function execute(array $data): array
    {
        return DB::transaction(function () use ($data) {
            $user = User::create([
                'name' => $data['name'], 'email' => $data['email'],
                'password' => Hash::make($data['password']),
            ]);
            $token = $user->createToken('auth_token', abilities: ['*'])->plainTextToken;
            return ['user' => $user, 'token' => $token];
        });
    }
}
```

```php
// Controller — validate via Form Request, delegate to Action, return API Resource
public function store(RegisterRequest $request, RegisterUser $action): \Illuminate\Http\JsonResponse
{
    $result = $action->execute($request->validated());
    return AuthTokenResource::make($result['user'])
        ->additional(['token' => $result['token']])->response()->setStatusCode(201);
}
```

### Login Action

```php
namespace App\Actions\Auth;

use Illuminate\Support\Facades\Auth;
use Illuminate\Validation\ValidationException;

final class LoginUser
{
    public function execute(array $credentials, array $abilities = ['*']): array
    {
        if (! Auth::attempt(['email' => $credentials['email'], 'password' => $credentials['password']])) {
            throw ValidationException::withMessages(['email' => ['The provided credentials are incorrect.']]);
        }
        $user = Auth::user();
        $token = $user->createToken('auth_token', abilities: $abilities)->plainTextToken;
        return ['user' => $user, 'token' => $token];
    }
}
```

```php
// Controller — pass scoped abilities per client type
$result = $action->execute(
    credentials: $request->validated(),
    abilities: ['orders:read', 'orders:create', 'profile:read', 'profile:update'],
);
return AuthTokenResource::make($result['user'])->additional(['token' => $result['token']])->response();
```

### Token refresh, revocation, and abilities

```php
// Refresh — revoke current, issue new with same abilities
$abilities = $user->currentAccessToken()->abilities;
$user->currentAccessToken()->delete();
$newToken = $user->createToken('auth_token', abilities: $abilities)->plainTextToken;

// Revocation
$request->user()->currentAccessToken()->delete();  // logout current device
$request->user()->tokens()->delete();               // logout all devices

// Token abilities — restrict what a token can do
$token = $user->createToken('mobile', ['orders:read', 'orders:create'])->plainTextToken;
$request->user()->tokenCan('orders:create');  // check in code
// Enforce via route middleware: ->middleware('ability:orders:read')
```

### Middleware pipeline — `bootstrap/app.php`

> See also `references/routing.md` for route group middleware patterns and rate limiting.

```php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(api: __DIR__ . '/../routes/api.php', health: '/up')
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->alias([
            'ability'    => \Laravel\Sanctum\Http\Middleware\CheckAbilities::class,
            'abilities'  => \Laravel\Sanctum\Http\Middleware\CheckForAnyAbility::class,
            'verified'   => \Illuminate\Auth\Middleware\EnsureEmailIsVerified::class,
            'role'       => \Spatie\Permission\Middleware\RoleMiddleware::class,
            'permission' => \Spatie\Permission\Middleware\PermissionMiddleware::class,
        ]);
        $middleware->statefulApi();
    })
    ->withExceptions(function (Exceptions $exceptions) {})
    ->create();
```

### Route middleware application

```php
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::apiResource('orders', OrderController::class);
    Route::middleware('verified')->group(function () {           // email verified
        Route::post('/orders/{order}/pay', PayOrderController::class);
    });
    Route::middleware('role:admin')->group(function () {         // spatie role
        Route::apiResource('users', UserController::class);
    });
    Route::middleware('permission:reports.view')->group(function () {  // spatie permission
        Route::get('/reports/sales', SalesReportController::class);
    });
    Route::middleware('ability:orders:create')->group(function () {    // Sanctum ability
        Route::post('/orders', [OrderController::class, 'store']);
    });
});
```

### Passport — OAuth2 only

Install only when third-party consumers need standard OAuth2. Not for first-party apps.

```php
// Authorization Code Grant with PKCE — third-party apps redirect to:
// /oauth/authorize?client_id=...&redirect_uri=...&response_type=code&code_challenge=...

// Client Credentials Grant — machine-to-machine
$response = Http::asForm()->post('/oauth/token', [
    'grant_type' => 'client_credentials', 'client_id' => $clientId,
    'client_secret' => $clientSecret, 'scope' => 'orders:read orders:create',
]);
// Define scopes in AppServiceProvider::boot()
Passport::tokensCan(['orders:read' => 'Read orders', 'orders:create' => 'Create orders']);
```

### spatie/laravel-permission

Install: `composer require spatie/laravel-permission`, publish, migrate. Add `HasRoles` trait to User alongside `HasApiTokens`.

```php
use Spatie\Permission\Models\{Permission, Role};

Permission::create(['name' => 'orders.view']);
Permission::create(['name' => 'orders.create']);
Permission::create(['name' => 'orders.update']);
Permission::create(['name' => 'orders.delete']);

$admin = Role::create(['name' => 'admin']);
$admin->givePermissionTo(Permission::all());
$manager = Role::create(['name' => 'manager']);
$manager->givePermissionTo(['orders.view', 'orders.create', 'orders.update']);
$customer = Role::create(['name' => 'customer']);
$customer->givePermissionTo(['orders.view', 'orders.create']);

// Assign and check
$user->assignRole('admin');
$user->can('orders.create');             // uses Laravel Gate
$user->hasRole('admin');                 // spatie role check
$user->hasPermissionTo('orders.delete'); // spatie permission check
```

### Policy — one per model

Create: `php artisan make:policy OrderPolicy --model=Order`. Lives in `app/Policies/`.

```php
namespace App\Policies;

use App\Models\{Order, User};

final class OrderPolicy
{
    public function viewAny(User $user): bool
    {
        return $user->can('orders.view');
    }

    public function view(User $user, Order $order): bool
    {
        return $user->can('orders.view') && ($user->hasRole('admin') || $order->user_id === $user->id);
    }

    public function create(User $user): bool
    {
        return $user->can('orders.create');
    }

    public function update(User $user, Order $order): bool
    {
        return $user->can('orders.update') && ($user->hasRole('admin') || $order->user_id === $user->id);
    }

    public function delete(User $user, Order $order): bool
    {
        return $user->can('orders.delete') && ($user->hasRole('admin') || $order->user_id === $user->id);
    }
}
```

Register via `Gate::policy(Order::class, OrderPolicy::class)` in `AppServiceProvider`, or rely on auto-discovery with `App\Policies\{Model}Policy` naming convention.

### Form Request using Policy

```php
final class UpdateOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('update', $this->route('order'));
    }

    public function rules(): array
    {
        return [
            'status' => ['sometimes', 'string'],
            'notes'  => ['nullable', 'string', 'max:1000'],
        ];
    }
}
```

Returns 403 automatically when `authorize()` returns `false`. Cross-reference `form-requests.md`.

### Gate definitions — non-model authorization

```php
// AppServiceProvider::boot()
Gate::define('access-admin-dashboard', fn (User $user): bool => $user->hasRole('admin'));
Gate::define('view-financial-reports', fn (User $user): bool => $user->hasAnyRole(['admin', 'finance']));
// Gate::authorize('access-admin-dashboard') throws 403; Gate::allows(...) returns bool
```

### Guards — `config/auth.php`

```php
'defaults' => ['guard' => 'sanctum'],
'guards'   => [
    'web'     => ['driver' => 'session', 'provider' => 'users'],
    'sanctum' => ['driver' => 'sanctum', 'provider' => 'users'],
],
'providers' => ['users' => ['driver' => 'eloquent', 'model' => App\Models\User::class]],
```

## When

| Scenario | Use |
|----------|-----|
| First-party SPA (same domain) | Sanctum SPA auth (cookie-based session) |
| First-party mobile app | Sanctum personal access tokens |
| Third-party consumers needing OAuth2 | Passport (auth code + PKCE, client credentials) |
| Role-based access (admin, manager) | `spatie/laravel-permission` — `role:` middleware |
| Permission-based access | `spatie/laravel-permission` — `permission:` middleware |
| Model-level auth (can user edit this order?) | Policy via Form Request `authorize()` or `$this->authorize()` |
| Non-model auth (dashboard access) | Gate in `AppServiceProvider` |
| Token scoping | Sanctum abilities — `ability:` middleware |

## Never

- **Never use Passport when Sanctum suffices.** Passport adds OAuth2 complexity. Only for third-party consumers needing standard OAuth2 flows.
- **Never hardcode role checks.** Use `$user->can()` or `$user->hasRole()` — never `if ($user->role === 'admin')`.
  ```php
  // WRONG                              // RIGHT
  if ($user->role === 'admin') {}       if ($user->can('orders.update')) {}
  ```
- **Never put authorization logic in controllers.** Use Policies via Form Request `authorize()` or `$this->authorize()`. No inline `if/else` auth blocks.
- **Never return raw tokens without scoping.** Specify abilities. `['*']` only for full-access (registration). Scoped tokens preferred.
- **Never store or log plaintext tokens.** Return `plainTextToken` once during creation, never again.
- **Never skip Policy registration.** Auto-discovery needs `App\Policies\{Model}Policy` naming. Otherwise `Gate::policy()`.
- **Never mix authorization locations.** Authorize in Form Request OR controller — not both on the same request.
