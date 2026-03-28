# Queues, Jobs, Events, Listeners, Broadcasting

## What

Queues defer expensive work (email, PDF generation, API calls) to background workers. **Horizon** manages all queue processing — never bare `queue:work`. Jobs are the unit of queued work. Events decouple side effects from core logic. Listeners handle events, optionally queued. Broadcasting pushes real-time updates via **Reverb** (optional — add when WebSocket support is needed).

Redis is the queue driver. Horizon provides dashboard, auto-scaling, and metrics. The worker container runs `php artisan horizon` in dev and prod (see `docker.md`).

Key rules:
- Always Horizon — never bare `queue:work`, not even in development
- Pass IDs to job constructors, re-query in `handle()` — never serialize Eloquent models
- Implement `failed()` on every critical job
- Use `ShouldQueue` on listeners for non-critical side effects
- Three queue priorities: `high`, `default`, `low`

## How

### Job class — complete example

```php
<?php
namespace App\Jobs;

use App\Models\Order;
use App\Notifications\OrderShippedNotification;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\{InteractsWithQueue, SerializesModels};
use Illuminate\Queue\Middleware\{RateLimited, WithoutOverlapping};

final class ProcessOrderShipment implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 3;
    public int $maxExceptions = 2;
    public array $backoff = [30, 120, 300]; // exponential: 30s, 2m, 5m

    public function __construct(
        private readonly int $orderId,
        private readonly string $trackingNumber,
    ) {}

    public function handle(): void
    {
        $order = Order::with('user')->findOrFail($this->orderId);
        $order->update(['status' => 'shipped', 'tracking_number' => $this->trackingNumber, 'shipped_at' => now()]);
        $order->user->notify(new OrderShippedNotification($order));
    }

    public function failed(\Throwable $exception): void
    {
        Log::error('Order shipment failed', ['order_id' => $this->orderId, 'error' => $exception->getMessage()]);
        // Alert ops, mark for manual review
    }

    public function middleware(): array
    {
        return [
            new RateLimited('shipments'),
            (new WithoutOverlapping($this->orderId))->expireAfter(300),
        ];
    }

    public function retryUntil(): \DateTime { return now()->addHours(6); }
}
```

**Dispatch:**

```php
ProcessOrderShipment::dispatch($order->id, $tracking);                    // default queue
ProcessOrderShipment::dispatch($order->id, $tracking)->onQueue('high');   // high priority
ProcessOrderShipment::dispatch($order->id, $tracking)->delay(now()->addMinutes(5)); // delayed
```

### Horizon configuration

`config/horizon.php`:

```php
'environments' => [
    'production' => [
        'supervisor-1' => [
            'connection' => 'redis',
            'queue' => ['high', 'default', 'low'],  // processing order
            'balance' => 'auto',                      // auto-scale workers
            'autoScalingStrategy' => 'time',
            'minProcesses' => 2, 'maxProcesses' => 10,
            'balanceMaxShift' => 3, 'balanceCooldown' => 3,
            'tries' => 3, 'timeout' => 300, 'maxJobs' => 500, 'memory' => 128,
        ],
    ],
    'local' => [
        'supervisor-1' => [
            'connection' => 'redis',
            'queue' => ['high', 'default', 'low'],
            'balance' => 'simple',
            'minProcesses' => 1, 'maxProcesses' => 3,
            'tries' => 3, 'timeout' => 300,
        ],
    ],
],
```

**Dashboard** at `/horizon`, protected by auth gate in `HorizonServiceProvider`:

```php
protected function gate(): void
{
    Gate::define('viewHorizon', fn (?User $user): bool => $user?->hasRole('admin') ?? false);
}
```

**Queue priority** — `high` processed before `default`, `default` before `low`:

```php
ProcessPayment::dispatch($orderId)->onQueue('high');     // critical
ProcessOrderShipment::dispatch($orderId, $tracking);     // default
GenerateMonthlyReport::dispatch($month)->onQueue('low'); // background
```

### Job middleware

```php
// Rate limiting — define in AppServiceProvider::boot()
RateLimiter::for('shipments', fn () => Limit::perMinute(30));

// In job's middleware() method:
public function middleware(): array
{
    return [
        new RateLimited('shipments'),                           // throttle execution
        (new WithoutOverlapping($this->orderId))                // prevent concurrent for same key
            ->expireAfter(300)->releaseAfter(30),
    ];
}

// Custom middleware — any invokable class
final class EnsureOrderNotCancelled
{
    public function handle(object $job, \Closure $next): void
    {
        if (Order::find($job->orderId)?->status === 'cancelled') { $job->delete(); return; }
        $next($job);
    }
}
```

### Job batching

```php
use Illuminate\Bus\Batch;
use Illuminate\Support\Facades\Bus;

$batch = Bus::batch([
    new ProcessOrderItem($order->id, $item1->id),
    new ProcessOrderItem($order->id, $item2->id),
    new ProcessOrderItem($order->id, $item3->id),
])
->then(fn (Batch $batch) => Log::info('All items processed', ['batch_id' => $batch->id]))
->catch(fn (Batch $batch, \Throwable $e) => Log::error('Batch failed', ['batch_id' => $batch->id]))
->finally(fn (Batch $batch) => FinalizeOrder::dispatch($batch->id))
->allowFailures()->onQueue('default')->name('process-order-items')->dispatch();

// Track: $batch->progress(), $batch->finished(), $batch->cancelled()
```

Batchable jobs must use the `Batchable` trait and check cancellation:

```php
use Illuminate\Bus\Batchable;

final class ProcessOrderItem implements ShouldQueue
{
    use Batchable, Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function handle(): void
    {
        if ($this->batch()?->cancelled()) { return; }
        // process item...
    }
}
```

### Job chaining

```php
Bus::chain([
    new ValidateOrder($orderId),
    new ChargePayment($orderId),
    new FulfillOrder($orderId),
    new SendConfirmation($orderId),
])->onQueue('high')->dispatch();
```

Chain stops on failure. Jobs pass state via database or cache, not return values.

### Events and listeners

**Event class** — plain PHP class with public properties, pass IDs not models:

```php
<?php
namespace App\Events;

use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class OrderCreated
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly int $orderId,
        public readonly int $userId,
    ) {}
}
```

**Queued listener** — `ShouldQueue` for async, `$afterCommit` for transaction safety:

```php
<?php
namespace App\Listeners;

use App\Events\OrderCreated;
use App\Models\User;
use App\Notifications\OrderConfirmation;
use Illuminate\Contracts\Queue\ShouldQueue;

final class SendOrderConfirmation implements ShouldQueue
{
    public string $queue = 'default';
    public bool $afterCommit = true; // dispatch only after DB transaction commits

    public function handle(OrderCreated $event): void
    {
        User::findOrFail($event->userId)->notify(new OrderConfirmation($event->orderId));
    }

    public function failed(OrderCreated $event, \Throwable $exception): void
    {
        Log::error('Order confirmation failed', ['order_id' => $event->orderId, 'error' => $exception->getMessage()]);
    }
}
```

**Dispatching:** `OrderCreated::dispatch($order->id, $order->user_id);` from Actions inside `DB::transaction()`. Or via model `$dispatchesEvents` (see `eloquent-models.md`).

**Event discovery** — auto-register listeners by type-hinted `handle()` parameter:

```php
// AppServiceProvider::boot()
Event::discover();
// Or explicit: Event::listen(OrderCreated::class, SendOrderConfirmation::class);
```

With discovery, any listener whose `handle()` type-hints an event is automatically registered.

### Broadcasting with Reverb (optional — add when needed)

Broadcasting pushes events to WebSocket clients. Set up only when real-time features are required.

**Broadcastable event:**

```php
<?php
namespace App\Events;

use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

final class OrderStatusUpdated implements ShouldBroadcast
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly int $orderId,
        public readonly string $status,
        public readonly int $userId,
    ) {}

    public function broadcastOn(): array { return [new PrivateChannel("orders.{$this->userId}")]; }
    public function broadcastAs(): string { return 'order.status.updated'; }
    public function broadcastWith(): array { return ['order_id' => $this->orderId, 'status' => $this->status]; }
}
```

**Channel authorization** in `routes/channels.php`:

```php
// Private channel — only the owning user
Broadcast::channel('orders.{userId}', fn (User $user, int $userId): bool => $user->id === $userId);

// Presence channel — tracks connected users, returns user info or null
Broadcast::channel('project.{projectId}', function (User $user, int $projectId): ?array {
    return $user->projects()->where('id', $projectId)->exists()
        ? ['id' => $user->id, 'name' => $user->name]
        : null;
});
```

| Channel | Use | Authorization |
|---|---|---|
| `Channel` | Public — anyone can listen | None |
| `PrivateChannel` | Authenticated users only | Callback returns bool |
| `PresenceChannel` | Track who is connected | Callback returns user array or null |

Reverb container setup in `docker.md`. Set `BROADCAST_CONNECTION=reverb` in `.env`.

## When

| Situation | Approach |
|---|---|
| Expensive operation (email, PDF, API call) | Queued job on `default` |
| Payment processing, critical path | Queued job on `high` |
| Report generation, analytics | Queued job on `low` |
| Parallel independent items | `Bus::batch()` with progress tracking |
| Sequential dependent steps | `Bus::chain()` — stops on failure |
| Side effect after mutation (notification, cache clear) | Event + queued listener (`ShouldQueue`) |
| Core business logic (charge payment, create order) | Direct Action call — not an event |
| Prevent duplicate job execution | `WithoutOverlapping` middleware |
| Throttle external API calls | `RateLimited` middleware |
| Real-time client updates (dashboard, chat) | Broadcasting with Reverb + `ShouldBroadcast` |

**Events vs direct Action calls:** Events for side effects (notifications, logging, cache) — caller does not care if they succeed. Direct calls for core logic (payments, inventory) — failure must propagate.

## Never

- **Never use bare `queue:work`** — Horizon provides dashboard, auto-scaling, metrics. Use `php artisan horizon` everywhere.
- **Never pass Eloquent models to job constructors.** Serialized models become stale:
  ```php
  // WRONG: public function __construct(private readonly Order $order) {}
  // RIGHT: public function __construct(private readonly int $orderId) {}
  //        In handle(): $order = Order::findOrFail($this->orderId);
  ```
- **Never skip `failed()` on critical jobs.** Without it, failures are silent.
- **Never use synchronous listeners for non-critical side effects.** Implement `ShouldQueue` — synchronous listeners block the request.
- **Never forget `$afterCommit = true` on queued listeners inside transactions.** Without it, the listener may fire before commit, operating on nonexistent data.
- **Never dispatch events for core business logic.** Events are for decoupled side effects. If failure must propagate, call the Action directly.
- **Never hardcode queue names in job classes.** Use `->onQueue('high')` at the dispatch call site.
- **Never skip `$this->batch()?->cancelled()` check in batchable jobs.** Cancelled batches continue processing without this guard.
