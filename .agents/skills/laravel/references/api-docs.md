# API Documentation — Auto-Generated Docs, OpenAPI Spec, Scribe & Scramble

## What

API documentation is auto-generated from code — Form Requests become parameter docs, API Resources become response shapes, route definitions become endpoint listings. Never maintain docs manually.

**Scramble** (preferred) — generates OpenAPI 3.1 by inferring types from Form Requests, API Resources, and PHP return types. Attribute-based when extra detail is needed. Minimal annotation, tight Laravel integration, by Dedoc. Use when standard patterns cover the API.

**Scribe** — annotation-based (`@group`, `@bodyParam`, `@response`), generates static HTML and Postman collections. More mature, more manual control. Use when Scramble's auto-inference cannot cover custom response shapes.

Docs are versioned per API version (`/api/v1/`), generated in CI on every build, and served from the app or exported as static HTML.

## How

### Scramble setup

Install: `composer require dedoc/scramble`

```php
// config/scramble.php
return [
    'api_path' => 'api',
    'info' => ['version' => env('API_VERSION', '1.0.0'), 'description' => 'Order Management API'],
    'servers' => [['url' => '/api/v1', 'description' => 'API v1']],
    'routes' => fn (Route $route) => Str::startsWith($route->uri, 'api/v1'),
];
```

Scramble auto-serves: **UI** at `/docs/api` (Stoplight Elements), **OpenAPI spec** at `/docs/api.json`.

### How Scramble infers docs from existing code

Zero annotation needed — Scramble reads Form Request `rules()`, API Resource `toArray()`, and controller return types:

```php
// Form Request rules() → parameter docs (types, required, constraints all inferred)
final class StoreOrderRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'customer_id'        => ['required', 'exists:customers,id'],
            'items'              => ['required', 'array', 'min:1'],
            'items.*.product_id' => ['required', 'exists:products,id'],
            'items.*.quantity'   => ['required', 'integer', 'min:1', 'max:100'],
            'notes'              => ['nullable', 'string', 'max:500'],
            'priority'           => ['sometimes', Rule::enum(OrderPriority::class)],
        ];
    }
}

// Controller return types are mandatory — Scramble uses them for response shape inference
final class OrderController extends Controller
{
    public function store(StoreOrderRequest $request, CreateOrder $action): OrderResource
    {
        $order = $action->execute(OrderData::from($request->validated()));
        return new OrderResource($order->load(['customer', 'items']));
    }

    public function index(Request $request): AnonymousResourceCollection
    {
        return OrderResource::collection(
            QueryBuilder::for(Order::class)->allowedFilters(['status', 'customer_id'])
                ->allowedSorts(['created_at', 'total_cents'])->with(['customer'])->paginate(15)
        );
    }
}
```

### Adding detail Scramble cannot infer

```php
use Dedoc\Scramble\Attributes\{Group, QueryParameter};

#[Group('Orders')]
final class OrderController extends Controller
{
    /** List orders — paginated, filterable by status and customer. */
    #[QueryParameter('filter[status]', type: 'string', example: 'pending')]
    #[QueryParameter('sort', description: '- prefix for desc', type: 'string', example: '-created_at')]
    public function index(Request $request): AnonymousResourceCollection { /* ... */ }
}
```

### Response examples

Add `@response` for realistic data including error cases (Scramble infers structure but needs examples):

```php
/**
 * @response 201 {"data":{"id":42,"status":"pending","total_cents":15990,
 *   "customer":{"id":7,"name":"Acme Corp"},
 *   "items":[{"id":1,"product_id":12,"quantity":3,"unit_price_cents":5330}],
 *   "created_at":"2026-03-22T14:30:00+00:00"}}
 * @response 422 {"error":{"code":"VALIDATION_FAILED","message":"The given data was invalid.","status":422}}
 */
public function store(StoreOrderRequest $request, CreateOrder $action): OrderResource { /* ... */ }
```

### Authentication documentation

Configure the security scheme so Scramble marks authenticated endpoints with a lock icon. Unauthenticated routes (login, register, webhooks) remain open. Scramble auto-detects `auth:sanctum` middleware.

```php
// AppServiceProvider::boot()
Scramble::afterOpenApiGenerated(function (OpenApi $openApi) {
    $openApi->secure(SecurityScheme::http('bearer', description: 'Sanctum token'));
});
```

### Scribe setup (alternative)

Install: `composer require knuckleswtf/scribe && php artisan vendor:publish --tag=scribe-config`

```php
// config/scribe.php (key settings)
return [
    'type' => 'laravel', 'title' => 'Order API — v1',
    'auth' => ['enabled' => true, 'default' => true, 'in' => 'bearer',
               'name' => 'Authorization', 'placeholder' => '{BEARER_TOKEN}'],
    'routes' => [['match' => ['prefixes' => ['api/v1']],
                   'apply' => ['headers' => ['Accept' => 'application/json']]]],
];
```

Scribe uses docblock annotations — verbose but fully explicit:

```php
/** @group Orders */
final class OrderController extends Controller
{
    /**
     * @bodyParam customer_id int required The customer. Example: 7
     * @bodyParam items array required Example: [{"product_id":12,"quantity":3}]
     * @bodyParam items[].product_id int required Example: 12
     * @bodyParam items[].quantity int required Quantity (1-100). Example: 3
     * @response 201 scenario="Success" {"data":{"id":42,"status":"pending","total_cents":15990}}
     * @response 422 scenario="Validation" {"error":{"code":"VALIDATION_FAILED","status":422}}
     */
    public function store(StoreOrderRequest $request, CreateOrder $action): OrderResource { /* ... */ }
}
```

Generate: `php artisan scribe:generate`

### Versioned documentation

Separate docs per API version. For Scribe, generate per version with version-specific route prefix config.

```php
// AppServiceProvider::boot() — served at /docs/v1 and /docs/v2
Scramble::registerApi('v1', ['api_path' => 'api/v1'])
    ->routes(fn (Route $route) => Str::startsWith($route->uri, 'api/v1'));
Scramble::registerApi('v2', ['api_path' => 'api/v2'])
    ->routes(fn (Route $route) => Str::startsWith($route->uri, 'api/v2'));
```

### CI integration — fail if spec drifts from code

```yaml
# .github/workflows/ci.yml
- name: Generate and validate API docs
  run: |
    php artisan scramble:export --path=storage/api-docs/openapi.json
    npx @redocly/cli lint storage/api-docs/openapi.json
    git diff --exit-code storage/api-docs/openapi.json || \
      (echo "API docs stale — run scramble:export and commit" && exit 1)
```

### Hosting

| Strategy | How |
|---|---|
| Serve from app | Scramble: auto at `/docs/api`. Scribe: `type => 'laravel'` |
| Static export | `scramble:export` or Scribe static output, serve from CDN |
| External | Export OpenAPI JSON, upload to Swagger Hub / Readme.io |
| Internal only | Gate in `AppServiceProvider` or disable routes in prod |

## When

| Situation | Approach |
|---|---|
| Standard patterns (Form Requests + API Resources + typed returns) | Scramble — auto-infers everything |
| Custom responses, non-standard patterns | Scribe — full manual annotation |
| Third-party consumers need OpenAPI spec | Export JSON, validate in CI |
| Multiple API versions | Register per-version in Scramble or run Scribe per version |
| CI pipeline | Generate + lint spec on every build, fail if stale |
| Production | Gate docs behind auth or disable routes entirely |

## Never

- **Never maintain API docs manually.** Manual docs drift from code within days. Auto-generate from Form Requests, API Resources, and route definitions.
- **Never skip response examples.** Docs without examples are unusable. Include success and error responses (422, 401, 403, 404, 429) for every endpoint.
- **Never omit authentication documentation.** Document which endpoints require auth, the token format (`Authorization: Bearer {token}`), and how to obtain tokens.
- **Never leave annotations incomplete.** Claude commonly generates `@bodyParam` without examples, or documents `store` but skips `index`/`show`/`update`/`destroy`. Every public endpoint needs full docs.
- **Never serve docs without versioning.** `/api/v1/` and `/api/v2/` must have separate docs. Mixed-version docs confuse consumers.
- **Never generate docs only locally.** CI must generate and validate the spec on every build. Stale docs are worse than no docs.
- **Never expose docs publicly without intent.** Gate the docs route in production or disable it for internal APIs.
