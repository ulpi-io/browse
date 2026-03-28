# API Resources

## What

API Resources transform Eloquent models into JSON responses. Every endpoint returns a Resource or ResourceCollection — never a raw model, never a hand-built array. Resources control which fields the client sees, rename snake_case columns to camelCase JSON keys, conditionally include relationships, and produce a consistent response envelope.

- **`JsonResource`** — single item. Wraps one model via `toArray()`.
- **`ResourceCollection`** — list of items. Wraps a paginator, automatically includes `meta` (pagination) and `links` (navigation URLs).

All list endpoints are paginated. No exceptions. Use `->paginate()` for offset or `->cursorPaginate()` for infinite scroll. Never `->get()` on a list endpoint.

**Localization convention:** return machine-readable codes and keys in all responses. Never return pre-translated strings. The client holds the translation table and maps `"status": "pending"` or `"error_code": "ORDER_NOT_FOUND"` to the user's locale. The API never changes when a new language is added.

## How

### JsonResource with conditional fields

```php
<?php
namespace App\Http\Resources;

use App\Enums\OrderStatus;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class OrderResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id'            => $this->id,
            'reference'     => $this->reference,
            'status'        => $this->status->value,          // enum backing value — client translates
            'totalCents'    => $this->total_cents,
            'currency'      => $this->currency,
            'notes'         => $this->notes,
            'createdAt'     => $this->created_at?->toIso8601String(),
            'shippedAt'     => $this->shipped_at?->toIso8601String(),

            // whenLoaded — included only when eager-loaded, omitted otherwise
            'user'          => new UserResource($this->whenLoaded('user')),
            'items'         => OrderItemResource::collection($this->whenLoaded('items')),

            // whenCounted — included only when withCount('items') was called
            'itemsCount'    => $this->whenCounted('items'),

            // when — conditional on arbitrary boolean
            'internalNotes' => $this->when(
                $request->user()?->hasRole('admin'),
                $this->internal_notes,
            ),

            // mergeWhen — conditional field group (avoids wrapping each field individually)
            ...$this->mergeWhen($this->status === OrderStatus::Shipped, [
                'trackingNumber' => $this->tracking_number,
                'carrier'        => $this->carrier,
            ]),
        ];
    }
}
```

### ResourceCollection with pagination

```php
<?php
namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class OrderCollection extends ResourceCollection
{
    public $collects = OrderResource::class;

    public function toArray(Request $request): array
    {
        return ['data' => $this->collection];
    }

    /** Attach additional metadata alongside data/meta/links. */
    public function with(Request $request): array
    {
        return ['summary' => ['totalRevenueCents' => $this->collection->sum(fn ($o) => $o->total_cents)]];
    }
}
```

### Response envelope

Laravel wraps Resources in `data` automatically. Paginated collections add `meta` and `links`:

```json
{
    "data": [
        { "id": 1, "reference": "ORD-A1B2C3D4", "status": "pending", "totalCents": 4999 }
    ],
    "links": { "first": "...?page=1", "last": "...?page=5", "prev": null, "next": "...?page=2" },
    "meta": { "current_page": 1, "from": 1, "last_page": 5, "per_page": 15, "to": 15, "total": 72 }
}
```

### Resource composition

Wrap loaded relationships in their own Resource. Never inline raw data:

```php
class OrderItemResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id'             => $this->id,
            'productName'    => $this->product_name,
            'quantity'        => $this->quantity,
            'unitPriceCents' => $this->unit_price_cents,
            'totalCents'     => $this->quantity * $this->unit_price_cents,
            'product'        => new ProductResource($this->whenLoaded('product')),
        ];
    }
}
```

### spatie/laravel-query-builder integration

Use in controller `index()` methods. The package reads `filter`, `sort`, and `include` URL parameters and applies them as Eloquent constraints — no manual `$request->query()` parsing.

```php
use Spatie\QueryBuilder\AllowedFilter;
use Spatie\QueryBuilder\QueryBuilder;

// GET /api/v1/orders?filter[status]=pending&sort=-created_at&include=items,user

public function index(): OrderCollection
{
    $orders = QueryBuilder::for(Order::class)
        ->allowedFilters([
            'status',                                    // exact match
            'currency',                                  // exact match
            AllowedFilter::partial('reference'),         // LIKE %value%
            AllowedFilter::exact('user_id'),             // explicit exact
            AllowedFilter::scope('created_between'),     // calls scopeCreatedBetween
            AllowedFilter::trashed(),                    // soft-deleted records
        ])
        ->allowedSorts(['created_at', 'total_cents', 'status'])
        ->defaultSort('-created_at')
        ->allowedIncludes(['items', 'user', 'tags'])
        ->paginate(15);

    return new OrderCollection($orders);
}
```

| URL parameter | Purpose | Example |
|---|---|---|
| `filter[field]=value` | Filter by field | `?filter[status]=pending` |
| `sort=field` / `sort=-field` | Sort asc / desc | `?sort=-created_at` |
| `sort=f1,-f2` | Multi-sort | `?sort=status,-created_at` |
| `include=rel1,rel2` | Eager-load relationships | `?include=items,user` |
| `page[number]=N` | Page number | `?page[number]=2` |

### Controller using resources end-to-end

```php
// See controller-pattern.md for full class structure
public function index(): OrderCollection
{
    $orders = QueryBuilder::for(Order::class)
        ->allowedFilters(['status', 'user_id'])
        ->allowedSorts(['created_at', 'total_cents'])
        ->allowedIncludes(['items', 'user'])
        ->paginate(15);

    return new OrderCollection($orders);
}

public function show(Order $order): OrderResource
{
    $this->authorize('view', $order);

    return new OrderResource(
        $order->loadCount('items')->load(['items', 'user']),
    );
}
```

### Localization — codes, not translations

```php
// RIGHT — return enum backing value, client translates
'status' => $this->status->value,              // "pending", "shipped", "cancelled"

// RIGHT — error code, client maps to locale string (see error-handling.md)
'error' => ['code' => 'ORDER_NOT_FOUND', 'status' => 404]

// WRONG — pre-translated, locks API to one language
'status' => __('orders.status.pending'),
'error'  => ['message' => 'The order was not found'],
```

## When

**Returning a single model from show/store/update?**
`new OrderResource($model)` or `OrderResource::make($model)`. Both equivalent.

**Returning a list from index?**
`new OrderCollection($paginator)`. Always pass a paginator, never a plain Collection.

**Need a relationship in the response?**
Eager-load in the controller (`->load('user')` or `allowedIncludes`), use `$this->whenLoaded('user')` in the resource. Omitted entirely when not loaded — no null, no empty object.

**Need a count without loading the full relationship?**
`->loadCount('items')` or `->withCount('items')`, then `$this->whenCounted('items')`.

**Fields visible only to certain roles?**
`$this->when($condition, $value)` for single fields. `$this->mergeWhen($condition, [...])` for groups.

**Offset vs cursor pagination?**
Offset (`paginate`) for page-numbered lists — gives `total` and `last_page`. Cursor (`cursorPaginate`) for infinite scroll or millions of rows — skips COUNT, more efficient.

**Filtering/sorting/including via query params?**
`spatie/laravel-query-builder`. Declare allowed filters, sorts, includes. Never parse `$request->query()` manually.

## Never

- **Never return Eloquent models directly.** No `return $order`. Raw models expose every column including sensitive fields. Always wrap in an API Resource.
  ```php
  // WRONG
  return Order::find($id);
  return response()->json($order);
  // RIGHT
  return new OrderResource($order);
  ```
- **Never use `->get()` on list endpoints.** Unbounded queries crash on large datasets. Always paginate.
  ```php
  // WRONG
  return OrderResource::collection(Order::all());
  // RIGHT
  return new OrderCollection(Order::paginate(15));
  ```
- **Never include all relationships by default.** Use `whenLoaded` — relationships appear only when eager-loaded. Including everything bloats responses and causes N+1 when not loaded.
- **Never expose sensitive fields.** Omit `password`, `remember_token`, `two_factor_secret`, internal cost fields. If using UUIDs publicly, omit auto-increment `id`.
- **Never return pre-translated strings.** Return status codes (`"pending"`), error codes (`"ORDER_NOT_FOUND"`), enum values. Client translates. A pre-translated API is locked to one language.
- **Never manually parse query parameters for filtering.** No `$request->query('status')` with `->where()`. Use `spatie/laravel-query-builder` — it validates allowed filters and prevents arbitrary WHERE injection.
- **Never build response arrays by hand.** No `return ['data' => $order, 'meta' => [...]]`. Use ResourceCollection for automatic envelope from the paginator.
