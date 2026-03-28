# Service Layer

## What

Business logic lives in **Actions** — one class per operation, one public method, constructor injection for dependencies. Actions are the only place where mutations, calculations, external API calls, and orchestration happen. Controllers delegate to Actions. Models define data access. Actions do the work.

**DTOs** via `spatie/laravel-data` carry structured data between boundaries (HTTP layer to Action, Action to Action, Action to event). They replace loose arrays with typed, validated objects.

**Service providers** wire interfaces to implementations. `AppServiceProvider` handles most bindings.

Key rules:
- One Action per operation (`CreateOrder`, `CancelOrder`, `UpdateUserProfile`)
- Single `execute()` or `handle()` method — never both, pick one convention per project
- All mutations wrapped in `DB::transaction()` (see `database.md` for mechanics)
- Constructor injection for all dependencies — no facades inside Actions
- Actions can compose other Actions

## How

### Action class — complete example

```php
<?php

namespace App\Actions\Order;

use App\Data\OrderData;
use App\Events\OrderCreated;
use App\Models\Order;
use Illuminate\Support\Facades\DB;

final class CreateOrder
{
    public function __construct(
        private readonly ApplyOrderDiscount $applyDiscount,
    ) {}

    public function execute(OrderData $data): Order
    {
        return DB::transaction(function () use ($data) {
            $order = Order::create([
                'user_id' => $data->userId,
                'status' => $data->status,
                'currency' => $data->currency,
                'notes' => $data->notes,
                'total_cents' => 0,
            ]);

            foreach ($data->items as $item) {
                $order->items()->create([
                    'product_id' => $item->productId,
                    'quantity' => $item->quantity,
                    'unit_price_cents' => $item->unitPriceCents,
                ]);
            }

            $order = $this->applyDiscount->execute($order);
            $order->update(['total_cents' => $order->items->sum(
                fn ($item) => $item->quantity * $item->unit_price_cents,
            )]);

            OrderCreated::dispatch($order);

            return $order->load('items');
        });
    }
}
```

- **`final`** — Actions are not for inheritance. Compose via constructor injection.
- **Constructor injection** — `ApplyOrderDiscount` is another Action. Container resolves automatically.
- **Typed return** — the model, a DTO, or `void`. Never `mixed`.
- **`DB::transaction()`** — any exception rolls back. Closure return becomes method return. See `database.md` for savepoints, nested transactions, locking.
- **Event inside transaction** — use `$afterCommit = true` on queued listeners so events dispatch only after commit.

### DTO via spatie/laravel-data — complete example

```php
<?php

namespace App\Data;

use App\Enums\OrderStatus;
use Spatie\LaravelData\Attributes\MapInputName;
use Spatie\LaravelData\Attributes\Validation\Max;
use Spatie\LaravelData\Attributes\Validation\Min;
use Spatie\LaravelData\Data;
use Spatie\LaravelData\DataCollection;

class OrderData extends Data
{
    public function __construct(
        #[MapInputName('user_id')]
        public readonly int $userId,
        public readonly OrderStatus $status,
        public readonly string $currency,
        #[Max(1000)]
        public readonly ?string $notes,
        /** @var DataCollection<OrderItemData> */
        #[Min(1)]
        public readonly DataCollection $items,
    ) {}
}
```

```php
// app/Data/OrderItemData.php
class OrderItemData extends Data
{
    public function __construct(
        #[MapInputName('product_id')]  public readonly int $productId,
        public readonly int $quantity,
        #[MapInputName('unit_price_cents')]  public readonly int $unitPriceCents,
    ) {}
}
```

**Creating DTOs** — `from()` handles requests, arrays, and models:

```php
$data = OrderData::from($request->validated());   // from validated request
$data = OrderData::from(['user_id' => 1, ...]);   // from array
$data = OrderData::from($order);                  // from Eloquent model
```

**Validation via attributes** — for complex rules, override `rules()`:

```php
use Spatie\LaravelData\Attributes\Validation\{Required, StringType, Max, Email, Unique};

class UserData extends Data
{
    public function __construct(
        #[Required, StringType, Max(255)]  public readonly string $name,
        #[Required, Email, Unique('users', 'email')]  public readonly string $email,
    ) {}

    public static function rules(): array  // override for complex rules
    {
        return ['email' => ['required', 'email', Rule::unique('users')->ignore(request()->route('user'))]];
    }
}
```

**DTOs vs Form Requests:**

| Boundary | Use |
|---|---|
| HTTP input validation | Form Request — validates raw HTTP input, returns 422 on failure |
| Data into an Action | DTO — typed, composable. Or `$request->validated()` for simple CRUD |
| Data between Actions | DTO — explicit contract |
| Event payloads | DTO — typed, serializable |

If the Action is called from multiple places (controller, command, another Action, a job), use a DTO. Single-caller simple CRUD can use `$request->validated()`.

### DB::transaction() in Actions

Actions own the transaction call-site. Mechanics (savepoints, nested behavior, locking) documented in `database.md`. Nested Actions calling `DB::transaction()` create savepoints automatically.

```php
$result = DB::transaction(function () use ($data) {
    $order = Order::create($data);
    $order->items()->createMany($data['items']);
    return $order;
});
```

### Service provider bindings

Register in `AppServiceProvider::register()`:

```php
$this->app->bind(PaymentGateway::class, StripePaymentGateway::class);       // new instance per resolution
$this->app->singleton(PaymentGateway::class, StripePaymentGateway::class);  // one per process
$this->app->scoped(PaymentGateway::class, StripePaymentGateway::class);     // one per request, fresh per job
```

| Binding | Lifetime | Use when |
|---|---|---|
| `bind` | New per resolution | Stateless services, Actions (default) |
| `singleton` | One per process | Connection pools, config readers, immutable shared state |
| `scoped` | One per request | Request-scoped state (current tenant, feature flags) |

Most Actions need no explicit binding — Laravel auto-resolves concrete classes. Bind only for interfaces.

### Interface-to-implementation binding

Define interface in `app/Contracts/`, implement in `app/Services/`, bind in `AppServiceProvider`:

```php
// app/Contracts/PaymentGateway.php
interface PaymentGateway
{
    public function charge(int $amountCents, string $currency, string $token): ChargeResult;
}

// app/Services/StripePaymentGateway.php
final class StripePaymentGateway implements PaymentGateway
{
    public function charge(int $amountCents, string $currency, string $token): ChargeResult { /* Stripe SDK */ }
}

// AppServiceProvider::register()
$this->app->bind(PaymentGateway::class, StripePaymentGateway::class);

// Type-hint the interface in Action constructors — swap implementations without changing logic:
final class ChargeOrder
{
    public function __construct(private readonly PaymentGateway $gateway) {}

    public function execute(Order $order, string $paymentToken): ChargeResult
    {
        return $this->gateway->charge($order->total_cents, $order->currency, $paymentToken);
    }
}
```

### When to create dedicated service providers

**Almost never.** Use `AppServiceProvider` for application bindings. Create a dedicated provider only when a package requires one (Horizon, Telescope, Filament ship their own) or a large subsystem needs isolated boot logic. Do not create `OrderServiceProvider` for a few bindings.

## When

| Situation | Approach |
|---|---|
| Creating, updating, or deleting a resource | Action with `DB::transaction()` |
| Read-only query, no side effects | Query in controller via QueryBuilder, or Action if complex |
| Composing multiple steps | Primary Action calls other Actions via constructor injection |
| Data from controller to Action | DTO (cross-boundary) or `$request->validated()` (simple CRUD) |
| External service (Stripe, Twilio) | Interface in `app/Contracts/`, impl in `app/Services/`, bound in `AppServiceProvider` |
| Swapping for testing | Interface binding — inject mock/fake |
| Stateless utility | Private method on the Action, or plain class in `app/Support/` |

## Never

- **Never create god services.** No `UserService` with `create()`, `update()`, `sendWelcomeEmail()`, `resetPassword()`. Each operation is its own Action: `CreateUser`, `ResetPassword`, `ExportUsers`.
- **Never store state on an Action.** No properties accumulating data across calls. Each `execute()` is independent.
- **Never put business logic in controllers, models, or middleware.** Actions own logic.
- **Never use facades inside Actions.** Facades hide dependencies. Use constructor injection:
  ```php
  // WRONG — hidden dependency
  Cache::forget('orders:count');

  // RIGHT — explicit, testable
  public function __construct(private readonly CacheManager $cache) {}
  // then: $this->cache->forget('orders:count');
  ```
- **Never skip `DB::transaction()` on mutations.** Multi-table writes without a transaction risk partial data corruption.
- **Never return untyped results.** Declare return type: `Order`, `OrderData`, `ChargeResult`, `void`. No `mixed`.
- **Never create a provider per domain concept.** `PaymentServiceProvider` for one binding is overhead. Use `AppServiceProvider`.
