# Eloquent Models

## What

Eloquent models define data access: relationships, scopes, casts, and `$fillable`. Nothing else — no business logic, no calculations, no external API calls. All models run under `Model::shouldBeStrict()` in `AppServiceProvider::boot()`:

```php
public function boot(): void
{
    Model::shouldBeStrict();
    // Production: log lazy-loading violations instead of throwing
    Model::handleLazyLoadingViolationUsing(function (Model $model, string $relation) {
        logger()->warning("Lazy loading {$relation} on {$model::class}");
    });
}
```

| Protection | Catches |
|---|---|
| `preventLazyLoading()` | Accessing a relationship not eager-loaded — silent N+1 queries |
| `preventSilentlyDiscardingAttributes()` | Setting attributes not in `$fillable` — data silently lost |
| `preventAccessingMissingAttributes()` | Reading undefined attributes — hides typos and schema drift |

## How

### Complete model

```php
<?php
namespace App\Models;

use App\Enums\OrderStatus;
use App\Events\OrderCreated;
use App\Observers\OrderObserver;
use Illuminate\Database\Eloquent\Attributes\ObservedBy;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\{BelongsTo, BelongsToMany, HasMany, MorphMany};
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Str;

#[ObservedBy(OrderObserver::class)]
class Order extends Model
{
    use HasFactory, SoftDeletes;

    protected $fillable = ['user_id', 'status', 'total_cents', 'currency', 'notes', 'shipped_at'];

    protected function casts(): array {
        return [
            'status' => OrderStatus::class, 'total_cents' => 'integer',
            'shipped_at' => 'datetime', 'metadata' => 'array', 'secret_note' => 'encrypted',
        ];
    }

    public function user(): BelongsTo       { return $this->belongsTo(User::class); }
    public function items(): HasMany        { return $this->hasMany(OrderItem::class); }
    public function tags(): BelongsToMany   { return $this->belongsToMany(Tag::class)->withTimestamps(); }
    public function comments(): MorphMany   { return $this->morphMany(Comment::class, 'commentable'); }

    public function scopePending(Builder $query): Builder  { return $query->where('status', OrderStatus::Pending); }
    public function scopeForUser(Builder $query, int $userId): Builder { return $query->where('user_id', $userId); }

    protected function totalFormatted(): Attribute {
        return Attribute::make(get: fn (mixed $value, array $attributes) => number_format($attributes['total_cents'] / 100, 2));
    }
    protected function notes(): Attribute {
        return Attribute::make(
            get: fn (?string $value) => $value,
            set: fn (?string $value) => $value ? trim(strip_tags($value)) : null,
        );
    }

    protected static function booted(): void {
        static::creating(fn (Order $order) => $order->reference = 'ORD-' . strtoupper(Str::random(8)));
    }

    protected $dispatchesEvents = ['created' => OrderCreated::class];
}
```

### `$fillable` — explicit, always

List every mass-assignable field. With `shouldBeStrict()`, `Order::create(['rogue_field' => 'x'])` throws `MassAssignmentException` instead of silently discarding the value.

### Casts — `casts()` method

Use the `casts()` method (not the `$casts` property). Common types: `'boolean'`, `'integer'`, `'datetime'`, `'array'` (JSON), `'collection'` (JSON to Collection), `'encrypted'`, `'encrypted:array'`, `'decimal:2'`, and backed enum classes.

**Enum casts with PHP 8.4 backed enums:**

```php
enum OrderStatus: string {
    case Pending = 'pending'; case Processing = 'processing';
    case Shipped = 'shipped'; case Delivered  = 'delivered'; case Cancelled = 'cancelled';
}
// Cast: 'status' => OrderStatus::class
// $order->status = OrderStatus::Shipped;    → stores 'shipped' in DB
// $order->status === OrderStatus::Shipped;  → true (returns enum instance)
// $order->status->value;                    → 'shipped' (raw backing value)
```

### Relationships

Always declare return types. Always eager-load — never rely on lazy loading.

```php
public function profile(): HasOne              { return $this->hasOne(Profile::class); }
public function orders(): HasMany              { return $this->hasMany(Order::class); }
public function user(): BelongsTo              { return $this->belongsTo(User::class); }
public function tags(): BelongsToMany          { return $this->belongsToMany(Tag::class)->withTimestamps(); }
public function comments(): MorphMany          { return $this->morphMany(Comment::class, 'commentable'); }
public function commentable(): MorphTo         { return $this->morphTo(); }
public function categories(): MorphToMany      { return $this->morphToMany(Category::class, 'categorizable'); }
public function orderItems(): HasManyThrough   { return $this->hasManyThrough(OrderItem::class, Order::class); }
public function latestItem(): HasOneThrough    { return $this->hasOneThrough(OrderItem::class, Order::class)->latestOfMany(); }
```

### Local scopes

Chainable query constraints. Accept and return `Builder`:

```php
public function scopeActive(Builder $query): Builder { return $query->where('is_active', true); }
public function scopeCreatedBetween(Builder $query, Carbon $from, Carbon $to): Builder { return $query->whereBetween('created_at', [$from, $to]); }
// Chain: Order::active()->pending()->forUser($userId)->paginate(15);
```

### Accessors and mutators — `Attribute::make()`

New syntax only. camelCase method maps to snake_case attribute (`fullName()` → `$user->full_name`):

```php
protected function fullName(): Attribute {
    return Attribute::make(get: fn (mixed $value, array $attributes) => "{$attributes['first_name']} {$attributes['last_name']}");
}
protected function email(): Attribute {
    return Attribute::make(get: fn (string $value) => $value, set: fn (string $value) => strtolower(trim($value)));
}
```

### SoftDeletes

```php
use Illuminate\Database\Eloquent\SoftDeletes;
class Order extends Model { use SoftDeletes; }
```

```php
Order::all();                    // excludes soft-deleted (default)
Order::withTrashed()->get();     // includes soft-deleted
Order::onlyTrashed()->get();     // only soft-deleted
$order->restore();               // undo soft delete
$order->forceDelete();           // permanent removal
```

**Unique constraint gotcha:** A plain unique index on `email` blocks restoring a soft-deleted record if a new record holds that email. Fix with a composite or conditional index:

```php
$table->unique(['email', 'deleted_at']);   // composite — allows duplicates when one is soft-deleted
// Or conditional (MySQL 8+): unique only among non-deleted rows
DB::statement('CREATE UNIQUE INDEX users_email_active ON users (email) WHERE deleted_at IS NULL');
```

### Model events — `static::booted()` vs Observers

**`static::booted()` — preferred for simple, model-specific logic:**

```php
protected static function booted(): void {
    static::creating(fn (Order $order) => $order->reference = 'ORD-' . strtoupper(Str::random(8)));
    static::deleting(fn (Order $order) => $order->items()->pending()->update(['status' => 'cancelled']));
}
```

Events: `creating`, `created`, `updating`, `updated`, `saving`, `saved`, `deleting`, `deleted`, `restoring`, `restored`, `replicating`, `trashed`, `forceDeleting`, `forceDeleted`.

**Observers — for complex cross-cutting behavior (audit, activity).** Register via `#[ObservedBy(OrderObserver::class)]` attribute on the model (preferred) or `Order::observe(OrderObserver::class)` in `AppServiceProvider::boot()`:

```php
class OrderObserver {
    public function created(Order $order): void {
        activity()->performedOn($order)->log('created');
    }
    public function updated(Order $order): void {
        if ($order->isDirty('status')) {
            activity()->performedOn($order)->log("status changed to {$order->status->value}");
        }
    }
}
```

**`$dispatchesEvents`** maps lifecycle hooks to custom event classes handled by queued listeners (see `queues-jobs.md`):

```php
protected $dispatchesEvents = ['created' => OrderCreated::class, 'deleted' => OrderDeleted::class];
```

### Mass update event bypass

`Model::query()->update()` and `Model::query()->delete()` do **not** fire events or observers.

```php
// Does NOT fire events:
Order::where('status', 'expired')->update(['status' => 'cancelled']);
// DOES fire events (one at a time — use chunkById for large sets):
Order::where('status', 'expired')->chunkById(200, function ($orders) {
    $orders->each(fn (Order $order) => $order->update(['status' => 'cancelled']));
});
```

If you need bulk performance and events, dispatch events manually after the mass operation.

## When

| Situation | Approach |
|---|---|
| Simple default on create | `static::booted()` with `creating` closure |
| Audit logging on every change | Observer via `#[ObservedBy]` |
| Dispatching domain events to queued listeners | `$dispatchesEvents` property |
| Complex business logic on state change | Action called from controller — not a model event |
| Update thousands of rows fast | Mass `update()` — events will not fire |
| Update thousands of rows AND fire events | `chunkById()` + individual `save()` |
| Reusable query filter | Local scope |
| Computed attribute for responses | Accessor via `Attribute::make(get:)` |
| Normalize input on write | Mutator via `Attribute::make(set:)` |
| Preserve deleted records for audit | `SoftDeletes` trait |

**Relationship decision tree:**

| Cardinality | Use |
|---|---|
| Parent owns one child | `hasOne` / `belongsTo` (inverse) |
| Parent owns many children | `hasMany` / `belongsTo` (inverse) |
| Many ↔ Many (pivot table) | `belongsToMany` |
| Multiple models share same child type | `morphMany` / `morphOne` / `morphTo` |
| Polymorphic many-to-many | `morphToMany` / `morphedByMany` |
| Grandparent → grandchild (skip middle) | `hasManyThrough` / `hasOneThrough` |

## Never

- **Never `$guarded = []`** — wide open mass assignment. Use explicit `$fillable`. `shouldBeStrict()` enforces this.
- **Never lazy-load in a loop** — `$user->posts` in a `foreach` causes N+1. Eager-load with `with('posts')`. `shouldBeStrict()` throws.
- **Never put business logic in models** — no calculations, no API calls, no orchestration. That belongs in Actions.
- **Never use legacy accessor syntax** — `getFullNameAttribute()` / `setEmailAttribute()` are deprecated. Use `Attribute::make(get:, set:)`.
- **Never assume mass updates fire events** — `Model::query()->update()` bypasses events and observers entirely.
- **Never use an observer for trivial logic** — one-line defaults belong in `static::booted()`, not a separate observer class.
- **Never forget `deleted_at` in unique constraints with SoftDeletes** — a plain unique index blocks restore when a new record holds the same value.
