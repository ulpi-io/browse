# Testing — Pest Setup, Feature Tests, Unit Tests, Mocking, Coverage

## What

All tests use **Pest** — never PHPUnit class syntax. Pest provides `test()`/`it()` functions, `expect()` chains, Datasets for data-driven tests, and custom expectations. Feature tests hit API endpoints via `getJson()`, `postJson()`, etc. Unit tests exercise Actions, DTOs, and validators in isolation.

Organization: `tests/Feature/` mirrors `app/Http/Controllers/` (one file per controller). `tests/Unit/` mirrors `app/Actions/`, `app/Data/`, `app/Rules/` (one file per class). `tests/Pest.php` holds shared traits and custom expectations. See `folder-structure.md` for full directory tree.

Key rules: `RefreshDatabase` on all DB-touching tests, factories for all test data (see `database.md` for states/relationships), `actingAs($user)` for auth, `expect()->toBe()` for assertions. Test happy path, validation, authorization, and edge cases.

## How

### Pest configuration — `tests/Pest.php`

```php
<?php
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

pest()->extend(Tests\TestCase::class)->use(RefreshDatabase::class)->in('Feature', 'Unit');

expect()->extend('toHavePaginationMeta', function () {
    expect($this->value)->toHaveKey('meta')
        ->and($this->value['meta'])->toHaveKeys(['current_page', 'per_page', 'total', 'last_page']);
    return $this;
});

function authenticatedUser(array $attrs = []): User { return User::factory()->create($attrs); }
```

### Datasets — data-driven tests

```php
dataset('invalid_order_statuses', ['empty' => [''], 'numeric' => [99], 'unknown' => ['nonexistent']]);

it('rejects invalid order status', function (mixed $status) {
    $this->actingAs(authenticatedUser())
        ->postJson('/api/v1/orders', ['status' => $status])
        ->assertUnprocessable()->assertJsonValidationErrors(['status']);
})->with('invalid_order_statuses');

dataset('order_endpoints', [
    'list' => ['get', '/api/v1/orders'], 'store' => ['post', '/api/v1/orders'],
    'show' => ['get', '/api/v1/orders/1'], 'update' => ['put', '/api/v1/orders/1'],
    'delete' => ['delete', '/api/v1/orders/1'],
]);

it('requires auth on all endpoints', function (string $method, string $url) {
    $this->{$method . 'Json'}($url)->assertUnauthorized();
})->with('order_endpoints');
```

### Feature tests — API endpoint CRUD

```php
// tests/Feature/Http/Controllers/API/V1/OrderControllerTest.php
use App\Enums\OrderStatus;
use App\Models\{Order, User};

// --- INDEX: pagination, filtering, scoping ---
it('returns paginated orders for authenticated user', function () {
    $user = User::factory()->create();
    Order::factory()->count(3)->recycle($user)->create();
    Order::factory()->count(2)->create(); // other user — must not appear
    $this->actingAs($user)->getJson('/api/v1/orders')
        ->assertOk()->assertJsonCount(3, 'data')
        ->assertJsonStructure([
            'data' => [['id', 'reference', 'status', 'total_cents', 'created_at']],
            'meta' => ['current_page', 'per_page', 'total', 'last_page'],
        ]);
});
it('filters orders by status', function () {
    $user = User::factory()->create();
    Order::factory()->count(2)->recycle($user)->create(['status' => OrderStatus::Shipped]);
    Order::factory()->recycle($user)->create(['status' => OrderStatus::Pending]);
    $this->actingAs($user)->getJson('/api/v1/orders?filter[status]=shipped')
        ->assertOk()->assertJsonCount(2, 'data');
});

// --- STORE: creation, validation ---
it('creates order and returns 201', function () {
    $user = User::factory()->create();
    $payload = ['reference' => 'ORD-TEST001', 'currency' => 'USD', 'notes' => 'Rush',
        'items' => [['product_id' => 1, 'quantity' => 2, 'unit_price_cents' => 1500]]];
    $this->actingAs($user)->postJson('/api/v1/orders', $payload)
        ->assertCreated()->assertJsonPath('data.reference', 'ORD-TEST001')
        ->assertJsonStructure(['data' => ['id', 'reference', 'status', 'total_cents']]);
    $this->assertDatabaseHas('orders', ['reference' => 'ORD-TEST001', 'user_id' => $user->id]);
});
it('returns 422 for invalid payload', function () {
    $this->actingAs(authenticatedUser())->postJson('/api/v1/orders', [])
        ->assertUnprocessable()->assertJsonValidationErrors(['reference', 'currency', 'items']);
});

// --- SHOW: relationships, 404, authorization ---
it('returns order with relationships', function () {
    $user = User::factory()->create();
    $order = Order::factory()->withItems(2)->recycle($user)->create();
    $this->actingAs($user)->getJson("/api/v1/orders/{$order->id}")
        ->assertOk()->assertJsonPath('data.id', $order->id)
        ->assertJsonStructure(['data' => ['id', 'reference', 'items' => [['id', 'quantity']]]]);
});
it('returns 404 for nonexistent order', function () {
    $this->actingAs(authenticatedUser())->getJson('/api/v1/orders/99999')->assertNotFound();
});
it('returns 403 for another user order', function () {
    $other = Order::factory()->create();
    $this->actingAs(authenticatedUser())->getJson("/api/v1/orders/{$other->id}")->assertForbidden();
});

// --- UPDATE ---
it('updates order and returns 200', function () {
    $user = User::factory()->create();
    $order = Order::factory()->recycle($user)->create();
    $this->actingAs($user)->putJson("/api/v1/orders/{$order->id}", ['notes' => 'Updated'])
        ->assertOk()->assertJsonPath('data.notes', 'Updated');
    $this->assertDatabaseHas('orders', ['id' => $order->id, 'notes' => 'Updated']);
});

// --- DELETE ---
it('soft-deletes order and returns 204', function () {
    $user = User::factory()->create();
    $order = Order::factory()->recycle($user)->create();
    $this->actingAs($user)->deleteJson("/api/v1/orders/{$order->id}")->assertNoContent();
    $this->assertSoftDeleted('orders', ['id' => $order->id]);
});
```

### Unit tests — Actions, DTOs, validators

```php
// tests/Unit/Actions/Order/CreateOrderTest.php
use App\Actions\Order\CreateOrder;
use App\Data\OrderData;
use App\Enums\OrderStatus;
use App\Events\OrderCreated;
use App\Models\{Order, User};
use Illuminate\Support\Facades\Event;

it('creates order with items and dispatches event', function () {
    Event::fake([OrderCreated::class]);
    $user = User::factory()->create();
    $data = OrderData::from(['user_id' => $user->id, 'status' => OrderStatus::Pending,
        'currency' => 'USD', 'notes' => null, 'items' => [
            ['product_id' => 1, 'quantity' => 2, 'unit_price_cents' => 1500],
            ['product_id' => 2, 'quantity' => 1, 'unit_price_cents' => 3000]]]);
    $order = app(CreateOrder::class)->execute($data);
    expect($order)->toBeInstanceOf(Order::class)->user_id->toBe($user->id)->items->toHaveCount(2);
    expect($order->total_cents)->toBe(2 * 1500 + 3000);
    Event::assertDispatched(OrderCreated::class, fn ($e) => $e->order->id === $order->id);
});

it('rolls back on failure — no partial data', function () {
    $data = OrderData::from(['user_id' => User::factory()->create()->id,
        'status' => OrderStatus::Pending, 'currency' => 'USD', 'notes' => null,
        'items' => [['product_id' => 1, 'quantity' => -1, 'unit_price_cents' => 1500]]]);
    expect(fn () => app(CreateOrder::class)->execute($data))->toThrow(Exception::class);
    expect(Order::count())->toBe(0);
});

// tests/Unit/Data/OrderDataTest.php
it('creates DTO from array with correct types', function () {
    $data = OrderData::from(['user_id' => 1, 'status' => 'pending', 'currency' => 'USD',
        'notes' => null, 'items' => [['product_id' => 1, 'quantity' => 2, 'unit_price_cents' => 1500]]]);
    expect($data)->userId->toBe(1)->status->toBe(OrderStatus::Pending)->items->toHaveCount(1);
});
it('rejects DTO with missing required fields', function () {
    expect(fn () => OrderData::validateAndCreate([]))->toThrow(ValidationException::class);
});

// tests/Unit/Rules/OrderReferenceRuleTest.php
it('passes for valid order reference', function () {
    $v = Validator::make(['ref' => 'ORD-ABC12345'], ['ref' => [new OrderReferenceRule]]);
    expect($v->passes())->toBeTrue();
});
it('fails for reference without ORD- prefix', function () {
    $v = Validator::make(['ref' => 'ABC12345'], ['ref' => [new OrderReferenceRule]]);
    expect($v->fails())->toBeTrue();
});
```

### Factories in tests

Factory definitions live in `database/factories/` (see `database.md` for states, sequences, `afterCreating`). Usage:

```php
Order::factory()->create();                                          // default
Order::factory()->shipped()->create();                               // state
Order::factory()->withItems(5)->create();                            // relationship
Order::factory()->count(3)->recycle($user)->create();                // shared parent
Order::factory()->shipped()->withItems(3)->recycle($user)->create(); // combined
```

### Mocking — facade fakes

```php
// Http::fake — external APIs
Http::fake(['https://api.stripe.com/*' => Http::response(['id' => 'ch_1', 'status' => 'succeeded'], 200)]);
$result = app(ChargeOrder::class)->execute($order, 'tok_visa');
expect($result->status)->toBe('succeeded');
Http::assertSent(fn ($r) => $r->url() === 'https://api.stripe.com/v1/charges');

// Notification::fake
Notification::fake();
app(ShipOrder::class)->execute($order);
Notification::assertSentTo($user, OrderShippedNotification::class, fn ($n) => $n->order->id === $order->id);

// Mail::fake
Mail::fake();
app(ProcessPayment::class)->execute($order);
Mail::assertSent(InvoiceMail::class, fn ($m) => $m->hasTo($order->user->email));

// Queue::fake
Queue::fake();
app(CreateOrder::class)->execute($data);
Queue::assertPushed(GenerateInvoicePdf::class);
Queue::assertPushedOn('default', GenerateInvoicePdf::class);

// Storage::fake — in-memory filesystem
Storage::fake('s3');
$file = UploadedFile::fake()->create('invoice.pdf', 1024, 'application/pdf');
$this->actingAs(authenticatedUser())->postJson('/api/v1/orders/1/invoice', ['file' => $file])->assertOk();
Storage::disk('s3')->assertExists('invoices/1/invoice.pdf');

// Event::fake
Event::fake([OrderCreated::class]);
app(CreateOrder::class)->execute($data);
Event::assertDispatched(OrderCreated::class, 1);
```

### Test organization

```
tests/
├── Pest.php                                      # shared config, traits, expectations
├── Feature/Http/Controllers/API/V1/
│   ├── OrderControllerTest.php                   # mirrors OrderController
│   └── AuthControllerTest.php
├── Unit/
│   ├── Actions/Order/CreateOrderTest.php         # mirrors app/Actions/Order/CreateOrder
│   ├── Data/OrderDataTest.php
│   └── Rules/OrderReferenceRuleTest.php
└── Datasets/OrderDatasets.php                    # shared datasets (optional)
```

### Code coverage

```bash
php artisan test --coverage                  # summary
php artisan test --coverage --min=80         # fail below 80% — enforce in CI
php artisan test --parallel --coverage       # parallel + coverage
```

Configure source in `phpunit.xml` — include `app/`, exclude `app/Providers/`.

## When

| Situation | Test type | Key assertions |
|---|---|---|
| New API endpoint | Feature | `assertStatus`, `assertJsonStructure`, `assertDatabaseHas` |
| Validation rules | Feature | `assertUnprocessable`, `assertJsonValidationErrors` |
| Authorization | Feature | `assertForbidden`, `assertUnauthorized` |
| Action business logic | Unit | `expect()->toBe()`, mock externals, assert DB state |
| DTO creation/validation | Unit | `from()`, typed properties, `validateAndCreate()` throws |
| Custom validation rule | Unit | `Validator::make()` + `passes()`/`fails()` |
| External API call | Unit | `Http::fake()` + `Http::assertSent()` |
| Notification/mail sent | Either | `Notification::fake()` + `assertSentTo`, `Mail::fake()` + `assertSent` |
| Job dispatched | Either | `Queue::fake()` + `assertPushed` |
| File upload | Feature | `Storage::fake()` + `assertExists` |

## Never

- **Never use PHPUnit class syntax.** No `class OrderTest extends TestCase`, no `$this->assertEquals()`. Use `test()`/`it()` and `expect()` chains. Note: `$this->assertDatabaseHas()`, `$this->assertSoftDeleted()`, and other Laravel testing helpers are fine inside Pest closures — they have no `expect()` equivalent.
- **Never build test data with manual arrays.** Use factories with states. `Order::factory()->shipped()->create()` is readable and schema-consistent. Raw arrays drift from schema.
- **Never skip authorization tests.** Test that unauthorized users get 403/401. Missing auth tests ship permission bugs.
- **Never test framework internals.** Do not test that Laravel validation works. Test that YOUR rules pass/fail for YOUR inputs.
- **Never mock what you do not own.** Mock facades (`Http::fake`, `Queue::fake`) and injected interfaces. Do not mock Eloquent — use `RefreshDatabase` with real DB.
- **Never share mutable state between tests.** `RefreshDatabase` resets per test. Do not rely on execution order.
- **Never scope fakes globally in `beforeEach`.** Scope `Event::fake()`, `Http::fake()` etc. to the test that needs them. Global fakes hide real failures.
- **Never skip `--coverage --min=80` in CI.** Coverage ratchets up. Set minimum in pipeline (see `docker.md`).
