# Logging — Channels, Structured Context, PII Rules, Docker Integration

## What

Laravel logging wraps Monolog. Configuration lives in `config/logging.php`. Channels define where log entries go (files, stderr, external services). Every log call takes a message and a context array — never concatenate values into the string. `Log::withContext()` attaches data to every subsequent log entry in the request lifecycle (request IDs, user IDs). In Docker/production, logs go to `stderr` in JSON format so container orchestrators and log aggregators can parse them.

Integration with error handling: exceptions are logged via the `report()` pipeline configured in `bootstrap/app.php` (see `error-handling.md`). Logging captures the structured context; error handling decides what gets reported and what gets swallowed.

## How

### Channel configuration per environment

```php
// config/logging.php
return [
    'default' => env('LOG_CHANNEL', 'stack'),

    'channels' => [
        'stack' => [
            'driver' => 'stack',
            'channels' => explode(',', env('LOG_STACK_CHANNELS', 'daily')),
            'ignore_exceptions' => false,
        ],
        'daily' => [                                  // Dev: one file/day, 14-day retention
            'driver' => 'daily',
            'path' => storage_path('logs/laravel.log'),
            'level' => env('LOG_LEVEL', 'debug'),
            'days' => 14,
            'replace_placeholders' => true,
        ],
        'single' => [                                 // Dedicated channels (audit, payments)
            'driver' => 'single',
            'path' => storage_path('logs/laravel.log'),
            'level' => env('LOG_LEVEL', 'debug'),
            'replace_placeholders' => true,
        ],
        'stderr' => [                                 // Docker / production: JSON to stderr
            'driver' => 'monolog',
            'level' => env('LOG_LEVEL', 'info'),
            'handler' => StreamHandler::class,
            'handler_with' => ['stream' => 'php://stderr'],
            'formatter' => JsonFormatter::class,
            'processors' => [PsrLogMessageProcessor::class],
        ],
    ],
];
```

| Environment | `LOG_CHANNEL` | `LOG_STACK_CHANNELS` | Format |
|---|---|---|---|
| Local dev | `stack` | `daily` | Human-readable |
| Docker dev | `stack` | `stderr` | JSON — `docker compose logs` collects it |
| Production | `stack` | `stderr` | JSON — aggregator (Datadog, CloudWatch, ELK) parses it |
| Testing | `stack` | `single` | Human-readable, single file |

Set via `.env` locally, real environment variables in production containers.

### Structured logging with context

Always pass a context array. Never interpolate variables into the message string:

```php
use Illuminate\Support\Facades\Log;

Log::info('Order created', [
    'order_id' => $order->id,
    'user_id' => $user->id,
    'total_cents' => $order->total_cents,
    'item_count' => $order->items->count(),
]);

Log::error('External API failed', [
    'service' => 'stripe',
    'endpoint' => '/v1/charges',
    'status_code' => $response->status(),
    'order_id' => $order->id,
    'duration_ms' => $durationMs,
]);
```

Context arrays become structured JSON fields in production. Log aggregators filter, group, and alert on these fields.

### Request correlation with `Log::withContext()`

Set in middleware so every Action and event handler inherits correlation data:

```php
// app/Http/Middleware/AttachRequestContext.php
namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

class AttachRequestContext
{
    public function handle(Request $request, Closure $next): Response
    {
        $requestId = $request->header('X-Request-ID', (string) Str::uuid());
        Log::withContext([
            'request_id' => $requestId,
            'user_id'    => $request->user()?->id,
            'ip'         => $request->ip(),
            'method'     => $request->method(),
            'path'       => $request->path(),
        ]);
        $response = $next($request);
        $response->headers->set('X-Request-ID', $requestId);
        return $response;
    }
}
```

Register in `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->api(append: [
        \App\Http\Middleware\AttachRequestContext::class,
    ]);
})
```

Every `Log::info(...)` call now includes `request_id`, `user_id`, and request metadata automatically.

### Log levels

| Level | When | Example |
|---|---|---|
| `emergency` | System unusable | Database cluster down, app cannot start |
| `critical` | Immediate action required | Payment gateway unreachable, Redis connection lost |
| `error` | Unexpected failure, caught exception | Failed API call, job exception |
| `warning` | Degraded but functional | Cache miss fallback, deprecated endpoint used |
| `info` | Significant business operation | Order created, user registered, payment processed |
| `debug` | Diagnostic detail (dev only) | Query params, intermediate state, flag evaluation |

Production `LOG_LEVEL` should be `info`. Debug logs are excluded.

### Writing to a specific channel

```php
// Single channel
Log::channel('stderr')->info('Audit: role changed', [
    'user_id' => $user->id, 'old_role' => $oldRole->value,
    'new_role' => $newRole->value, 'changed_by' => $admin->id,
]);

// Multiple channels for a single entry
Log::stack(['daily', 'stderr'])->critical('Payment gateway timeout', [
    'order_id' => $order->id, 'gateway' => 'stripe', 'timeout_ms' => 30000,
]);
```

### Integration with exception reporting

Exceptions flow through `bootstrap/app.php` (see `error-handling.md`). Custom exceptions provide structured context via `context()` — merged into the log entry automatically when reported:

```php
class PaymentFailedException extends \RuntimeException
{
    public function __construct(
        public readonly int $orderId,
        public readonly string $gateway,
        public readonly int $statusCode,
        string $message = 'Payment processing failed',
    ) { parent::__construct($message); }

    // Merged into the log entry automatically when reported
    public function context(): array
    {
        return ['order_id' => $this->orderId, 'gateway' => $this->gateway, 'status_code' => $this->statusCode];
    }
}
```

No need to manually log before throwing — `report()` logs with the context automatically.

## When

| Situation | Approach |
|---|---|
| Business operation completed | `Log::info()` with entity IDs and outcome |
| External service failed | `Log::error()` with service, endpoint, status code, duration |
| Degraded functionality | `Log::warning()` with what degraded and fallback used |
| System-level failure | `Log::critical()` or `Log::emergency()` |
| Debugging in development | `Log::debug()` — filtered out in production by `LOG_LEVEL=info` |
| Need request tracing | `Log::withContext()` in middleware — all logs get request ID |
| Audit-sensitive operation | Dedicated channel via `Log::channel('audit')` |
| Exception needs structured log | Define `context()` method on custom exception class |
| Running in Docker | `LOG_STACK_CHANNELS=stderr`, JSON format |

## Never

- **Never concatenate variables into log messages** — `Log::info("Order {$id} created by {$userId}")` destroys structured parsing. Use context arrays: `Log::info('Order created', ['order_id' => $id, 'user_id' => $userId])`.
- **Never log passwords, tokens, API keys, credit card numbers, or PII** — log only IDs and metadata. To trace a user, log `user_id` — never `email`, `name`, `phone`, `address`, or `ssn`. Secrets must never appear in log output.
- **Never use `daily` channel in Docker** — container filesystems are ephemeral. Files inside a container are lost on restart. Use `stderr`.
- **Never omit context arrays** — `Log::info('Something happened')` with no context is useless in production. Include identifiers to trace the request, user, and entity.
- **Never log at `debug` level in production** — set `LOG_LEVEL=info`. Debug entries generate massive volume and may leak sensitive data.
- **Never catch and silently swallow without logging** — if you catch and do not re-throw, log it. Silent failures are invisible in production.
- **Never misuse log levels** — `Log::error()` for routine operations triggers false alerts. `Log::info()` for failures hides problems. Match level to severity.
- **Never log request/response bodies wholesale** — they may contain PII, tokens, or large payloads. Log specific safe fields only.
