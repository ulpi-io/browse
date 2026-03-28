# Controller Pattern

## What

Controllers in this stack are thin routing glue. A controller method does exactly three things: (1) accept a validated Form Request, (2) delegate to an Action, (3) return an API Resource. No business logic, no inline validation, no raw Eloquent returns. Every controller method is 3-5 lines.

Two controller types exist:

- **Resource controllers** — standard CRUD (index, store, show, update, destroy) registered via `Route::apiResource()`. One controller per resource.
- **Invokable controllers** — single-action endpoints using the `__invoke()` method. One controller per action, registered as `Route::get('/endpoint', SomeController::class)`.

Controllers live in `app/Http/Controllers/Api/V1/`. Response codes: 200 (success), 201 (created), 204 (no content for deletes), 422 (validation — automatic from Form Requests), 403 (forbidden), 404 (not found).

## How

### Resource controller — full CRUD example

```php
<?php

namespace App\Http\Controllers\Api\V1;

use App\Actions\Order\CreateOrder;
use App\Actions\Order\DeleteOrder;
use App\Actions\Order\UpdateOrder;
use App\Http\Controllers\Controller;
use App\Http\Requests\Order\StoreOrderRequest;
use App\Http\Requests\Order\UpdateOrderRequest;
use App\Http\Resources\OrderCollection;
use App\Http\Resources\OrderResource;
use App\Models\Order;
use Spatie\QueryBuilder\QueryBuilder;

class OrderController extends Controller
{
    public function index(): OrderCollection
    {
        $orders = QueryBuilder::for(Order::class)
            ->allowedFilters(['status', 'user_id'])
            ->allowedSorts(['created_at', 'total'])
            ->allowedIncludes(['items', 'user'])
            ->paginate();

        return new OrderCollection($orders);
    }

    public function store(
        StoreOrderRequest $request,
        CreateOrder $action,
    ): OrderResource {
        $order = $action->execute($request->validated());

        return OrderResource::make($order)
            ->response()
            ->setStatusCode(201);
    }

    public function show(Order $order): OrderResource
    {
        $this->authorize('view', $order);

        return new OrderResource($order->load(['items', 'user']));
    }

    public function update(
        UpdateOrderRequest $request,
        Order $order,
        UpdateOrder $action,
    ): OrderResource {
        $order = $action->execute($order, $request->validated());

        return new OrderResource($order);
    }

    public function destroy(Order $order, DeleteOrder $action): \Illuminate\Http\Response
    {
        $this->authorize('delete', $order);

        $action->execute($order);

        return response()->noContent();
    }
}
```

Register with `Route::apiResource()` — it generates index, store, show, update, destroy (no create/edit since there are no views):

```php
// routes/api.php
Route::prefix('v1')->middleware('auth:sanctum')->group(function () {
    Route::apiResource('orders', OrderController::class);
});
```

### Invokable controller — single-action endpoint

Use an invokable controller when an endpoint maps to a single action that does not fit a CRUD resource. The class has one public method: `__invoke()`.

```php
<?php

namespace App\Http\Controllers\Api\V1;

use App\Actions\Order\CancelOrder;
use App\Http\Controllers\Controller;
use App\Http\Resources\OrderResource;
use App\Models\Order;

class CancelOrderController extends Controller
{
    public function __invoke(Order $order, CancelOrder $action): OrderResource
    {
        $this->authorize('update', $order);

        $order = $action->execute($order);

        return new OrderResource($order);
    }
}
```

Register without a method name — Laravel routes directly to `__invoke()`:

```php
// routes/api.php
Route::post('/v1/orders/{order}/cancel', CancelOrderController::class)
    ->middleware('auth:sanctum');
```

### Constructor injection vs method injection

**Method injection** — type-hint the Action in the method signature. Use for resource controllers where each method has a different Action (see `store`, `update`, `destroy` in the example above).

**Constructor injection** — store the Action as a `private readonly` property. Use for invokable controllers where the single `__invoke` method always needs the same dependency:

```php
class ExportOrdersController extends Controller
{
    public function __construct(
        private readonly ExportOrders $action,
    ) {}

    public function __invoke(): \Symfony\Component\HttpFoundation\StreamedResponse
    {
        return $this->action->execute();
    }
}
```

### Authorization in controllers

Two options — pick one per endpoint, do not mix both on the same request:

- **In the controller method:** `$this->authorize('update', $order)` — shown in `show()` and `destroy()` above.
- **In the Form Request:** implement the `authorize()` method to call `$this->user()->can('update', $this->route('order'))`. See `form-requests.md`.

Cross-reference `auth.md` for Policy definitions and `spatie/laravel-permission` role checks.

### Pagination on list endpoints

Always paginate collections. Never return unbounded results with `->get()`. Use `->paginate(15)` for standard offset pagination or `->cursorPaginate(15)` for infinite scroll / very large datasets. The paginator automatically includes `meta` with `current_page`, `total`, `per_page` when wrapped in a `ResourceCollection`. See `api-resources.md` for the response envelope.

## When

**Building CRUD for a resource (orders, users, products)?**
Resource controller with `Route::apiResource()`. Five methods, 3-5 lines each.

**Building a one-off action endpoint (cancel order, export CSV, health check)?**
Invokable controller with `__invoke()`. One class, one method.

**Choosing where to authorize?**
If the Form Request already loads the model (via route model binding), authorize there to keep the controller even thinner. Otherwise, authorize in the controller method with `$this->authorize()`.

**Choosing where to inject the Action?**
Method injection for resource controllers (different Action per method). Constructor injection for invokable controllers (single Action per class).

**Returning paginated vs single resource?**
`index()` always returns a `ResourceCollection` with `->paginate()`. All other methods return a single `JsonResource`.

## Never

- **Never put business logic in controllers.** No queries beyond route model binding. No conditionals that decide business outcomes. No calculations. No direct model creation. Delegate everything to an Action.
  ```php
  // WRONG — business logic leaked into controller
  $order = Order::create($request->validated());
  $order->items()->createMany($request->input('items'));
  $order->user->notify(new OrderCreatedNotification($order));

  // RIGHT — delegate to Action
  $order = $action->execute($request->validated());
  return OrderResource::make($order)->response()->setStatusCode(201);
  ```
- **Never return Eloquent models directly.** No `return $order` or `return Order::find($id)`. Always wrap in an API Resource — it controls which fields the client sees and transforms snake_case to camelCase.
- **Never use inline validation.** No `$request->validate([...])` in controllers. Type-hint a Form Request class — validation runs before the method executes. See `form-requests.md`.
- **Never return raw arrays.** No `return ['data' => $order]` or `response()->json([...])`. Always use API Resources for consistent response shape.
- **Never have multiple responsibilities in one method.** If a controller method is longer than 5 lines, logic is leaking in. Move it to an Action.
- **Never use `->get()` without pagination on list endpoints.** Unbounded queries crash on large datasets.
  ```php
  // WRONG
  return OrderResource::collection(Order::all());
  return OrderResource::collection(Order::where('active', true)->get());

  // RIGHT
  return new OrderCollection(Order::paginate());
  ```
