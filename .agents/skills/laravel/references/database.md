# Database — Migrations, Transactions, Seeders, Factories, Query Optimization

## What

Database layer: migrations define schema, `DB::transaction()` guarantees atomicity, seeders populate data, factories generate test records, and query optimization prevents performance problems. MySQL 8.x is the database. Redis handles cache and queues (see `caching.md`, `queues-jobs.md`).

## How

### Migration conventions

```php
return new class extends Migration {
    public function up(): void
    {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('warehouse_id')->constrained()->nullOnDelete();
            $table->string('reference', 20)->unique();
            $table->string('status', 30)->default('pending');
            $table->unsignedInteger('total_cents');
            $table->string('currency', 3)->default('USD');
            $table->text('notes')->nullable();
            $table->timestamp('shipped_at')->nullable();
            $table->timestamps();
            $table->softDeletes();

            // Composite index: most selective column first
            $table->index(['status', 'created_at']);
            $table->index(['user_id', 'status']);
        });
    }

    public function down(): void { Schema::dropIfExists('orders'); }
};
```

**Composite index ordering:** most selective column first. `['status', 'created_at']` when `status` narrows to a small subset; reverse when date range is the primary filter.

**Foreign key indexes:** Laravel auto-creates indexes on `foreignId()`. Add explicit indexes on non-FK columns in `WHERE`, `ORDER BY`, or `JOIN` clauses. Never modify a migration that has been run in production — create a new one.

### `DB::transaction()` — closure pattern

> For how transactions are used inside Actions, see `references/service-layer.md`.

Always use the closure pattern. Auto-commits on success, auto-rolls-back on exception. Return values propagate out of the closure:

```php
$order = DB::transaction(function () use ($orderData, $items) {
    $order = Order::create($orderData);
    $order->items()->createMany($items);
    OrderStatusHistory::create(['order_id' => $order->id, 'status' => $order->status]);
    return $order; // propagates to outer $order
}, attempts: 3); // optional: retries up to 3 times on deadlock
```

### Savepoints and nested transactions

`DB::transaction()` inside another creates a savepoint. If the inner throws, only the savepoint rolls back — the outer transaction can still commit:

```php
DB::transaction(function () use ($orderData, $items) {
    $order = Order::create($orderData);
    try {
        DB::transaction(fn () => $order->loyaltyPoints()->create(['points' => 100])); // savepoint
    } catch (LoyaltyServiceException $e) {
        Log::warning('Loyalty points failed', ['order_id' => $order->id]);
    }
    $order->items()->createMany($items); // outer commits — order + items saved, loyalty not
});
```

### Database locking

Use inside transactions to prevent race conditions:

```php
// lockForUpdate() — exclusive lock, blocks reads AND writes on locked rows
$order = DB::transaction(function () use ($orderId, $newStatus) {
    $order = Order::where('id', $orderId)->lockForUpdate()->first();
    if ($order->status !== OrderStatus::Pending) { throw new OrderAlreadyProcessedException(); }
    $order->update(['status' => $newStatus]);
    return $order;
});

// sharedLock() — blocks writes but allows concurrent reads
$balance = DB::transaction(function () use ($userId) {
    return Account::where('user_id', $userId)->sharedLock()->first()->balance;
});
```

`lockForUpdate()` when you read-then-update (prevents concurrent modification). `sharedLock()` when you need a consistent read without modification.

### Seeders — environment-aware, idempotent

```php
class UserSeeder extends Seeder
{
    public function run(): void
    {
        if (app()->isProduction()) { return; }

        User::firstOrCreate(
            ['email' => 'admin@example.com'],
            ['name' => 'Admin User', 'password' => bcrypt('password')],
        );
        User::factory()->count(20)->create();
    }
}
```

Always `firstOrCreate` or `updateOrCreate` — seeders must survive re-runs.

### Factories — states, relationships, sequences, afterCreating

```php
class OrderFactory extends Factory
{
    protected $model = Order::class;

    public function definition(): array
    {
        return [
            'user_id' => User::factory(), 'reference' => 'ORD-' . strtoupper(fake()->bothify('????????')),
            'status' => OrderStatus::Pending, 'total_cents' => fake()->numberBetween(1000, 500_000),
            'currency' => 'USD',
        ];
    }

    // States — named variants
    public function shipped(): static {
        return $this->state(fn () => ['status' => OrderStatus::Shipped, 'shipped_at' => now()]);
    }
    public function cancelled(): static {
        return $this->state(fn () => ['status' => OrderStatus::Cancelled]);
    }

    // Relationships
    public function withItems(int $count = 3): static {
        return $this->has(OrderItem::factory()->count($count), 'items');
    }

    // Sequences — cycle through values
    public function withRotatingStatuses(): static {
        return $this->sequence(
            new Sequence(['status' => OrderStatus::Pending], ['status' => OrderStatus::Processing], ['status' => OrderStatus::Shipped]),
        );
    }

    // afterCreating — side effects after persist
    public function configure(): static {
        return $this->afterCreating(fn (Order $order) =>
            OrderStatusHistory::create(['order_id' => $order->id, 'status' => $order->status])
        );
    }
}
```

**Usage:**

```php
Order::factory()->shipped()->create();                                         // state
Order::factory()->withItems(5)->create();                                      // relationships
Order::factory()->count(10)->recycle($user)->create();                         // reuse parent
Order::factory()->count(9)->withRotatingStatuses()->create();                  // sequence
Order::factory()->count(5)->shipped()->withItems(3)->recycle($user)->create(); // combined
```

### N+1 prevention

`Model::shouldBeStrict()` throws on lazy loading (see `eloquent-models.md`). Fix with eager loading:

```php
$orders = Order::with(['user', 'items'])->paginate(15);              // at query time
$orders = Order::with(['items.product', 'user.profile'])->get();     // nested eager loading
$order->load(['items', 'user']);                                      // lazy eager load on existing model
$users  = User::withCount('orders')->paginate(15);                   // counts only — no N+1
$orders = Order::with(['items' => fn ($q) => $q->where('quantity', '>', 0)])->paginate(15); // conditional
```

In production, log lazy-loading violations instead of throwing (see `eloquent-models.md` for the `handleLazyLoadingViolationUsing` pattern).

### Chunking large datasets

Never `Model::all()` or unbounded `->get()` on large tables:

```php
// chunk() — re-queries by OFFSET. Read-only batch processing.
Order::where('status', 'pending')->chunk(500, fn ($orders) =>
    $orders->each(fn (Order $o) => ProcessOrder::dispatch($o->id)));

// chunkById() — WHERE id > $lastId. Safe for mutations during iteration.
Order::where('status', 'pending')->chunkById(500, fn ($orders) =>
    $orders->each(fn (Order $o) => $o->update(['status' => 'processing'])));

// lazy() — generator, one chunk at a time. Exports/transforms.
Order::where('status', 'shipped')->lazy(500)->each(fn (Order $o) => $csvWriter->addRow($o->toArray()));

// cursor() — one model at a time, single query, minimal memory.
Order::where('created_at', '<', now()->subYear())->cursor()->each(fn (Order $o) => ArchiveOrder::dispatch($o->id));
```

### EXPLAIN / toSql / toRawSql debugging

```php
Order::where('status', 'pending')->toSql();       // "select * from `orders` where `status` = ?"
Order::where('status', 'pending')->toRawSql();    // bindings substituted (Laravel 10.15+)
Order::where('status', 'pending')->explain();      // EXPLAIN rows — check for full table scans
// Telescope query tab: all queries with time + duplicates. Pulse: slow queries in production.
```

## When

| Situation | Approach |
|---|---|
| Schema change | New migration (never edit one that ran in production) |
| Multi-model mutation | `DB::transaction()` closure wrapping all writes |
| Read-then-update race condition | `lockForUpdate()` inside transaction |
| Consistent read without mutation | `sharedLock()` inside transaction |
| Deadlock-prone writes | `DB::transaction(fn() => ..., attempts: 3)` |
| Nested operation that can partially fail | Nested `DB::transaction()` — creates savepoint |
| Seed dev environment | Seeder with `firstOrCreate` + `isProduction()` guard |
| Generate test data | Factory with states, `recycle()`, `afterCreating` |
| Load related models | `with()` at query time, `load()` on existing model |
| Process 10k+ rows | `chunkById()` for mutations, `lazy()`/`cursor()` for reads |
| Debug slow query | `toRawSql()` then `EXPLAIN` — check for missing indexes |
| Need related counts without N+1 | `withCount('relation')` |

**Chunking decision tree:**

| Need | Method | Why |
|---|---|---|
| Batch read-only | `chunk()` | Simple, familiar |
| Batch with mutations | `chunkById()` | OFFSET-safe when rows change |
| Stream / export | `lazy()` | Generator-based, low memory |
| Minimal memory, single query | `cursor()` | One model at a time |

## Never

- **Never manual `DB::beginTransaction()` / `DB::commit()` / `DB::rollBack()`** — the closure pattern handles commit, rollback, and deadlock retry. Manual management risks forgotten commits and leaked connections.
- **Never modify a production migration** — create a new migration. Other environments already ran the old version.
- **Never `Model::all()`** — paginate for API responses, chunk/cursor for background processing.
- **Never write non-idempotent seeders** — use `firstOrCreate`/`updateOrCreate`. A seeder that crashes on re-run blocks every developer.
- **Never skip `down()` in migrations** — rollback support is required for safe deployments.
- **Never lazy-load in a loop** — `$order->items` inside `foreach` causes N+1. Use `with('items')`. `shouldBeStrict()` catches this.
- **Never `chunk()` when mutating rows** — OFFSET shifts when rows change scope. Use `chunkById()`.
- **Never index every column** — indexes speed reads but slow writes. Index FKs, `WHERE`/`ORDER BY` columns, and composite indexes matching common query patterns.
- **Never forget to `return` from `DB::transaction()` closures** — if you need the created model outside, return it. The value propagates.
