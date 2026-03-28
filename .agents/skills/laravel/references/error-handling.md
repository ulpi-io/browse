# Error Handling

## What

Laravel 11+ moved exception handling from `app/Exceptions/Handler.php` to `bootstrap/app.php` via the `withExceptions()` method. The `Handler.php` class no longer exists. All exception customization — reporting, rendering, ignoring — happens in the `withExceptions` closure.

This stack enforces a consistent JSON error envelope for every error response. Clients receive a machine-readable error code, a human-readable message, and the HTTP status. Clients translate error codes on their end — the API never returns pre-translated text.

```json
{
    "error": {
        "code": "ORDER_NOT_FOUND",
        "message": "The requested order does not exist.",
        "status": 404
    }
}
```

Built-in exceptions the framework throws automatically:

| Exception | Status | Trigger |
|-----------|--------|---------|
| `ValidationException` | 422 | Form Request validation fails |
| `NotFoundHttpException` | 404 | Route model binding fails, or `abort(404)` |
| `AuthorizationException` | 403 | `$this->authorize()` or Policy denial |
| `AuthenticationException` | 401 | `auth:sanctum` middleware, unauthenticated |
| `ThrottleRequestsException` | 429 | Rate limiter exceeded |

## How

### Exception handler in bootstrap/app.php

```php
<?php
// bootstrap/app.php
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\TooManyRequestsHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(api: __DIR__ . '/../routes/api.php', health: '/up')
    ->withMiddleware(function (Middleware $middleware) { /* ... */ })
    ->withExceptions(function (Exceptions $exceptions) {

        // -- Rendering: force JSON envelope for every exception --

        $exceptions->renderable(function (NotFoundHttpException $e, Request $request): JsonResponse {
            return self::envelope('RESOURCE_NOT_FOUND', $e->getMessage() ?: 'The requested resource does not exist.', 404);
        });

        $exceptions->renderable(function (\Illuminate\Auth\Access\AuthorizationException $e, Request $request): JsonResponse {
            return self::envelope('FORBIDDEN', $e->getMessage() ?: 'You are not authorized to perform this action.', 403);
        });

        $exceptions->renderable(function (\Illuminate\Auth\AuthenticationException $e, Request $request): JsonResponse {
            return self::envelope('UNAUTHENTICATED', 'Authentication is required.', 401);
        });

        $exceptions->renderable(function (\Illuminate\Validation\ValidationException $e, Request $request): JsonResponse {
            return response()->json(['error' => [
                'code' => 'VALIDATION_FAILED', 'message' => 'The given data was invalid.',
                'status' => 422, 'errors' => $e->errors(),
            ]], 422);
        });

        $exceptions->renderable(function (TooManyRequestsHttpException $e, Request $request): JsonResponse {
            return self::envelope('RATE_LIMIT_EXCEEDED', 'Too many requests. Please try again later.', 429);
        });

        // Catch-all: prevent HTML fallback, hide internals in production
        $exceptions->renderable(function (\Throwable $e, Request $request): JsonResponse {
            $status = method_exists($e, 'getStatusCode') ? $e->getStatusCode() : 500;
            $message = app()->isProduction() ? 'An unexpected error occurred.' : $e->getMessage();
            return self::envelope('SERVER_ERROR', $message, $status);
        });

        // -- Reporting: external service + suppression --

        $exceptions->reportable(function (\Throwable $e) {
            if (app()->bound('sentry')) {
                app('sentry')->captureException($e);
            }
        })->stop();

        $exceptions->dontReport([
            \Illuminate\Auth\AuthenticationException::class,
            \Illuminate\Auth\Access\AuthorizationException::class,
            \Illuminate\Validation\ValidationException::class,
            TooManyRequestsHttpException::class,
        ]);
    })
    ->create();

// Helper used inside the closure (define as a local closure or extract to a helper class)
function envelope(string $code, string $message, int $status): JsonResponse
{
    return response()->json(['error' => compact('code', 'message', 'status')], $status);
}
```

### Custom exception base class

All domain exceptions extend this. Each carries a machine-readable error code and optional context for structured logging.

```php
<?php
namespace App\Exceptions;

use Illuminate\Http\JsonResponse;

abstract class AppException extends \RuntimeException
{
    protected string $errorCode = 'APP_ERROR';
    protected int $statusCode = 400;

    public function __construct(
        string $message = '',
        protected array $context = [],
    ) {
        parent::__construct($message ?: $this->getDefaultMessage());
    }

    abstract protected function getDefaultMessage(): string;
    public function getErrorCode(): string { return $this->errorCode; }
    public function getStatusCode(): int { return $this->statusCode; }
    public function getContext(): array { return $this->context; }

    public function render(): JsonResponse
    {
        return response()->json([
            'error' => [
                'code' => $this->errorCode,
                'message' => $this->getMessage(),
                'status' => $this->statusCode,
            ],
        ], $this->statusCode);
    }
}
```

### Concrete domain exceptions

```php
<?php
namespace App\Exceptions;

class OrderNotFoundException extends AppException
{
    protected string $errorCode = 'ORDER_NOT_FOUND';
    protected int $statusCode = 404;
    protected function getDefaultMessage(): string { return 'The requested order does not exist.'; }
}

class InsufficientStockException extends AppException
{
    protected string $errorCode = 'INSUFFICIENT_STOCK';
    protected int $statusCode = 422;
    protected function getDefaultMessage(): string { return 'Not enough stock to fulfill this order.'; }
}
```

### Throwing from Actions

```php
<?php
namespace App\Actions\Order;

use App\Exceptions\OrderNotFoundException;
use App\Exceptions\InsufficientStockException;
use App\Models\Order;

class CancelOrder
{
    public function execute(int $orderId): Order
    {
        $order = Order::find($orderId)
            ?? throw new OrderNotFoundException(context: ['order_id' => $orderId]);

        if ($order->status->isShipped()) {
            throw new InsufficientStockException(
                message: 'Cannot cancel a shipped order.',
                context: ['order_id' => $orderId, 'status' => $order->status->value],
            );
        }

        // ... cancellation logic
        return $order;
    }
}
```

### Production safety

```bash
# Production — never expose internals
APP_DEBUG=false
APP_ENV=production
```

When `APP_DEBUG=false`, the catch-all renderer returns `"An unexpected error occurred."` instead of the real message. Stack traces are never included in the JSON envelope regardless of debug mode — they belong in logs only. Cross-reference `logging.md` for structured exception logging.

### API response localization

The API returns machine-readable error codes (`ORDER_NOT_FOUND`, `VALIDATION_FAILED`). Clients maintain their own translation map:

```json
{
    "ORDER_NOT_FOUND": "La commande demandee n'existe pas.",
    "INSUFFICIENT_STOCK": "Stock insuffisant pour cette commande."
}
```

The API stays language-agnostic. It never accepts `Accept-Language` to change error text. Clients control translations, pluralization, and locale formatting.

## When

**Framework throws a known HTTP exception (404, 403, 401, 429)?**
The renderable handlers in `withExceptions()` convert it to the JSON envelope. No action needed.

**Form Request validation fails?**
Laravel throws `ValidationException` automatically. The handler wraps it in the envelope with field-level `errors`. No action needed.

**A business rule is violated in an Action?**
Create a concrete exception extending `AppException`. Set `$errorCode` and `$statusCode`. Throw from the Action. The `render()` method produces the JSON envelope.

**Need to report to an external service (Sentry, Flare, Bugsnag)?**
Add a `reportable()` closure in `withExceptions()`. Use `->stop()` if the external service is the only destination, omit it to also log locally.

**Want to suppress certain exceptions from the log?**
Use `$exceptions->dontReport([...])` for normal control flow (validation, auth failures, rate limits).

## Never

- **Never use `app/Exceptions/Handler.php`.** Removed in Laravel 11. All exception handling lives in `bootstrap/app.php` via `withExceptions()`. Claude's training data may generate the old pattern — reject it.
- **Never expose stack traces in API responses.** The catch-all returns a generic message when `APP_DEBUG=false`. Never add `'trace' => $e->getTrace()` to the envelope.
- **Never return HTML error pages from the API.** Every renderable handler returns `JsonResponse`. The catch-all `\Throwable` handler prevents HTML fallback for unmatched exceptions.
- **Never return generic "Server Error" without an error code.** Every response includes a machine-readable `code` field. Clients depend on codes for logic and localization.
- **Never catch and silently swallow exceptions.**
  ```php
  // WRONG — swallowed
  try { $action->execute($data); } catch (\Throwable $e) { }

  // RIGHT — let it propagate to the global handler
  $action->execute($data);

  // RIGHT — catch, log, re-throw as domain exception
  try {
      $gateway->charge($amount);
  } catch (GatewayException $e) {
      Log::error('Payment failed', ['error' => $e->getMessage()]);
      throw new PaymentFailedException(context: ['gateway' => 'stripe']);
  }
  ```
- **Never return pre-translated error messages.** Return error codes. Let the client translate.
- **Never put rendering logic in Actions or controllers.** Exception rendering belongs in `bootstrap/app.php` or in the exception's `render()` method. Actions throw; they do not format responses.
