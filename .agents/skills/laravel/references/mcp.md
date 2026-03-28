# Laravel MCP (`laravel/mcp`)

## What

Build **Model Context Protocol servers** inside your Laravel application so external AI clients (ChatGPT, Claude, Cursor, etc.) can interact with your app's functionality. MCP is the standard protocol for AI-to-application communication.

Two server types:
- **Web servers** — HTTP POST endpoint for remote AI clients
- **Local servers** — Artisan command for local AI assistants

Three MCP primitives:
- **Tools** — callable actions (CRUD, queries, workflows)
- **Resources** — expose data/content as context
- **Prompts** — reusable prompt templates

Key dependencies: MCP tools should delegate to Actions (see `service-layer.md`). Authentication uses Sanctum or Passport (see `auth.md`). Authorization uses Policies (see `auth.md`). Testing follows Pest patterns (see `testing.md`).

Related packages: **Boost** (`boost.md`) is a pre-built MCP server for development — built on top of this package. **AI SDK** (`ai-sdk.md`) adds AI features your users interact with. Laravel MCP lets external AI clients interact with *your app*.

Key rules:
- One server class per logical domain (weather, orders, users)
- Tools for actions, resources for context, prompts for templates — don't mix purposes
- Use annotations (`#[IsReadOnly]`, `#[IsDestructive]`) to communicate tool behavior to AI clients
- Authenticate web servers — never expose unauthenticated MCP endpoints
- Test with `mcp:inspector` during development

## How

### Installation

```bash
composer require laravel/mcp
php artisan vendor:publish --tag=ai-routes  # Creates routes/ai.php
```

### Server class

```php
<?php
namespace App\Mcp;

use Laravel\Mcp\Server\Server;
use Laravel\Mcp\Attributes\{Name, Version, Instructions};

#[Name('Order Server')]
#[Version('1.0.0')]
#[Instructions('This server provides order management functionality.')]
final class OrderServer extends Server
{
    protected array $tools = [
        \App\Mcp\Tools\GetOrderTool::class,
        \App\Mcp\Tools\SearchOrdersTool::class,
        \App\Mcp\Tools\UpdateOrderStatusTool::class,
    ];

    protected array $resources = [
        \App\Mcp\Resources\OrderPoliciesResource::class,
    ];

    protected array $prompts = [
        \App\Mcp\Prompts\SummarizeOrderPrompt::class,
    ];
}
```

### Registering servers — `routes/ai.php`

```php
use Illuminate\Support\Facades\Mcp;
use App\Mcp\OrderServer;

// Web server — HTTP POST for remote AI clients
Mcp::web('/mcp/orders', OrderServer::class);

// Local server — Artisan command for local AI assistants
Mcp::local('orders', OrderServer::class);
```

### Tools

```bash
php artisan make:mcp-tool GetOrderTool
```

```php
<?php
namespace App\Mcp\Tools;

use App\Models\Order;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tool\{Request, Response};
use Laravel\Mcp\Support\JsonSchema;
use Laravel\Mcp\Attributes\{IsReadOnly};

#[IsReadOnly]
final class GetOrderTool extends Tool
{
    public function __construct(
        private readonly \App\Actions\Order\GetOrder $getOrder,
    ) {}

    public function description(): string
    {
        return 'Get order details by ID.';
    }

    public function schema(JsonSchema $schema): JsonSchema
    {
        return $schema->integer('order_id', 'The order ID');
    }

    public function handle(Request $request): Response
    {
        // Delegate to Action — MCP tools are the interface layer, not the business layer
        // See service-layer.md for Action patterns
        $order = $this->getOrder->execute($request->get('order_id'));

        if (! $order) {
            return Response::error('Order not found');
        }

        return Response::text(json_encode($order->toArray(), JSON_PRETTY_PRINT));
    }
}
```

**Tool annotations** — communicate behavior to AI clients:

```php
use Laravel\Mcp\Attributes\{IsReadOnly, IsDestructive, IsIdempotent, IsOpenWorld};

#[IsReadOnly]       // Does not modify state
#[IsDestructive]    // Performs destructive operations (delete, etc.)
#[IsIdempotent]     // Safe to retry
#[IsOpenWorld]      // Interacts with external systems
```

**Response types:**

```php
Response::text('Plain text response');
Response::error('Something went wrong');
Response::image($imageData, 'image/png');
Response::audio($audioData, 'audio/mp3');
Response::fromStorage('files/report.pdf');
Response::structured(['key' => 'value']);

// Multiple content items
return Response::text('Order details:')
    ->and(Response::text(json_encode($order)));
```

**Output schema** — define expected response structure:

```php
public function outputSchema(JsonSchema $schema): JsonSchema
{
    return $schema
        ->string('status', 'Order status')
        ->number('total', 'Order total');
}
```

**Streaming with progress notifications:**

```php
public function handle(Request $request): \Generator
{
    yield Response::notification('Starting export...');

    foreach ($batches as $i => $batch) {
        // process batch...
        yield Response::notification("Processed batch {$i}");
    }

    return Response::text('Export complete');
}
```

**Conditional registration** — only show tool when conditions are met (uses same role/permission checks as `auth.md`):

```php
public function shouldRegister(Request $request): bool
{
    return $request->user()?->hasRole('admin') ?? false;
}
```

Full dependency injection supported in constructor and `handle()` method — inject Actions, repositories, or any service (see `service-layer.md` for binding patterns).

### Resources

```bash
php artisan make:mcp-resource OrderPoliciesResource
```

```php
<?php
namespace App\Mcp\Resources;

use Laravel\Mcp\Server\Resource;
use Laravel\Mcp\Server\Resource\Response;
use Laravel\Mcp\Attributes\{Uri, MimeType, Description, Audience, Priority};
use Laravel\Mcp\Enums\Role;

#[Uri('docs://orders/policies')]
#[MimeType('text/markdown')]
#[Description('Order handling policies and business rules')]
#[Audience(Role::User)]
#[Priority(0.9)]
final class OrderPoliciesResource extends Resource
{
    public function get(): Response
    {
        return Response::text(file_get_contents(resource_path('docs/order-policies.md')));
    }
}
```

**Resource templates** — dynamic URIs with parameters:

```php
use Laravel\Mcp\Contracts\HasUriTemplate;

#[Uri('file://users/{userId}/orders/{orderId}')]
final class UserOrderResource extends Resource implements HasUriTemplate
{
    public function get(int $userId, int $orderId): Response
    {
        $order = Order::where('user_id', $userId)->findOrFail($orderId);
        return Response::text(json_encode($order));
    }
}
```

**Response types:**

```php
Response::text('Markdown or plain text content');
Response::blob($binaryData, 'application/pdf');
```

**Annotations:**

```php
#[Audience(Role::User)]         // Intended for end users
#[Audience(Role::Assistant)]    // Intended for AI assistant
#[Priority(0.9)]                // Higher = more important (0.0–1.0)
#[LastModified('2025-01-15')]   // Cache hint
```

### Prompts

```bash
php artisan make:mcp-prompt SummarizeOrderPrompt
```

```php
<?php
namespace App\Mcp\Prompts;

use Laravel\Mcp\Server\Prompt;
use Laravel\Mcp\Server\Prompt\{Argument, Response};

final class SummarizeOrderPrompt extends Prompt
{
    public function description(): string
    {
        return 'Generate a summary of an order for customer communication.';
    }

    public function arguments(): array
    {
        return [
            Argument::make('order_id', 'The order ID to summarize')->required(),
            Argument::make('tone', 'Communication tone (formal, friendly)'),
        ];
    }

    public function get(string $orderId, string $tone = 'friendly'): array
    {
        $order = \App\Models\Order::with('items')->findOrFail($orderId);

        return [
            Response::text("Summarize this order in a {$tone} tone for the customer:"),
            Response::text(json_encode($order->toArray(), JSON_PRETTY_PRINT)),
            Response::text("Include: item list, total, estimated delivery.")->asAssistant(),
        ];
    }
}
```

`->asAssistant()` marks a message as coming from the assistant role (system instruction).

### Authentication

Same auth stack as API routes — see `auth.md` for Sanctum vs Passport decision and middleware pipeline.

**OAuth 2.1 via Passport** (recommended for external third-party AI clients):

```php
// routes/ai.php
Mcp::oauthRoutes();
Mcp::web('/mcp/orders', OrderServer::class)->middleware('auth:api');
```

**Sanctum** (for first-party AI clients):

```php
Mcp::web('/mcp/orders', OrderServer::class)->middleware('auth:sanctum');
```

**Custom middleware** — combine with `spatie/laravel-permission` roles (see `auth.md`):

```php
Mcp::web('/mcp/orders', OrderServer::class)->middleware(['auth:sanctum', 'role:admin']);
```

Access authenticated user in tools for Policy-based authorization (see `auth.md` for Policies):

```php
public function handle(Request $request): Response
{
    $user = $request->user();
    $order = Order::findOrFail($request->get('order_id'));

    if (! $user->can('view', $order)) {
        return Response::error('Unauthorized: you do not have access to this order.');
    }

    return Response::text(json_encode($order->toArray(), JSON_PRETTY_PRINT));
}
```

### Metadata

Attach arbitrary metadata to tools, resources, and prompts:

```php
// On class
protected array $meta = ['category' => 'orders', 'internal' => true];

// On responses
return Response::text('data')->withMeta(['source' => 'database']);
```

### Testing

**MCP Inspector** — interactive browser-based testing during development:

```bash
php artisan mcp:inspector mcp/orders   # Test web server
php artisan mcp:inspector orders       # Test local server
```

**Unit tests** — use Pest syntax (see `testing.md` for general test patterns):

```php
// tests/Feature/Mcp/Tools/GetOrderToolTest.php
use App\Mcp\OrderServer;
use App\Mcp\Tools\{GetOrderTool, UpdateOrderStatusTool};
use App\Models\{Order, User};

it('returns order details for valid order', function () {
    $order = Order::factory()->shipped()->withItems(2)->create();

    $response = OrderServer::tool(GetOrderTool::class, ['order_id' => $order->id]);

    $response->assertOk();
    $response->assertSee('shipped');
    $response->assertName('GetOrderTool');
});

it('returns error for nonexistent order', function () {
    $response = OrderServer::tool(GetOrderTool::class, ['order_id' => 99999]);

    $response->assertHasErrors();
});

it('restricts tool access to admin users', function () {
    $admin = User::factory()->create()->assignRole('admin');
    $order = Order::factory()->create();

    $response = OrderServer::actingAs($admin)
        ->tool(UpdateOrderStatusTool::class, ['order_id' => $order->id, 'status' => 'shipped']);

    $response->assertOk();
});

it('reports progress during long-running export', function () {
    $response = OrderServer::tool(ExportOrdersTool::class, ['format' => 'csv']);

    $response->assertOk();
    $response->assertSentNotification();
    $response->assertNotificationCount(3);
});

it('has correct tool metadata', function () {
    $response = OrderServer::tool(GetOrderTool::class, ['order_id' => 1]);

    $response->assertTitle('Get Order');
    $response->assertDescription('Get order details by ID.');
});
```

## When

| Scenario | Approach |
|---|---|
| External AI clients need to query your app | Web server with OAuth/Sanctum auth |
| Local AI assistant needs app context | Local server via Artisan command |
| AI needs to perform actions (CRUD) | MCP Tools with appropriate annotations |
| AI needs reference data or documentation | MCP Resources with URI patterns |
| AI needs reusable prompt templates | MCP Prompts with arguments |
| Long-running tool operations | Generator with `yield Response::notification()` |
| Different tools for different user roles | `shouldRegister()` with auth checks |
| Dynamic resource URIs | `HasUriTemplate` interface |

## Never

- **Never expose web MCP servers without authentication.** Unauthenticated endpoints let anyone call your tools — including destructive ones. Always add auth middleware (see `auth.md`):
  ```php
  // WRONG — open to the internet
  Mcp::web('/mcp/orders', OrderServer::class);

  // RIGHT — authenticated
  Mcp::web('/mcp/orders', OrderServer::class)->middleware('auth:sanctum');
  ```
- **Never put business logic in MCP tools.** Tools delegate to Actions (see `service-layer.md`). MCP tools are the interface layer:
  ```php
  // WRONG — business logic in tool
  public function handle(Request $request): Response {
      DB::transaction(function () use ($request) {
          $order = Order::create([...]);
          $order->items()->createMany([...]);
          event(new OrderCreated($order));
      });
  }

  // RIGHT — delegate to Action
  public function handle(Request $request): Response {
      $order = $this->createOrder->execute(OrderData::from($request->all()));
      return Response::text(json_encode($order->toArray()));
  }
  ```
- **Never skip `#[IsDestructive]` on destructive tools.** AI clients use annotations to decide whether to confirm before calling. Missing annotations cause silent destructive operations.
- **Never return Eloquent models directly from tools.** Use `->toArray()` or format the response. Same principle as API Resources (see `api-resources.md`).
- **Never test MCP servers only with the inspector.** Write Pest tests with assertions (see `testing.md`). The inspector is for exploration, not regression coverage.
- **Never confuse Laravel MCP with Boost.** Boost is a pre-built MCP server for *development* (see `boost.md`). `laravel/mcp` is a framework for building *your own* MCP servers that expose your app to external AI clients.
