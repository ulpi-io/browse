# Logging — Pino Structured Logging

## What

All server-side logging uses pino. One logger instance at `src/lib/logger.ts`, imported everywhere. Structured JSON objects — never string concatenation. Server-only — pino does not run in the browser.

Log levels in order of severity:

| Level | When to use |
|-------|-------------|
| `error` | Unexpected failures, caught exceptions with stack traces, 5xx from backend API |
| `warn` | Degraded functionality, fallback paths taken, rate limit hits |
| `info` | Significant operations: API calls, auth events, cache invalidations, webhook receipts |
| `debug` | Detailed diagnostic data: parsed params, resolved config. Dev only. |

## How

### Logger setup — src/lib/logger.ts

```typescript
import 'server-only';

import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  }),
});

export { logger };
```

`import 'server-only'` prevents accidental import from a Client Component — build fails instead of a runtime crash. See `references/security.md`. Production emits NDJSON to stdout (parsed by Datadog, Grafana Loki, CloudWatch). Development uses `pino-pretty` (devDependency) for human-readable output.

### Child loggers and request-scoped context

Child loggers add fixed fields to every log line. Use them for subsystem scoping and request correlation.

```typescript
import { logger } from '@/lib/logger';

// Module-scoped child — every log includes { module: 'api-client' }
const log = logger.child({ module: 'api-client' });
```

### Request correlation IDs

Generate a request ID in `proxy.ts`, read it downstream via `headers()`.

```typescript
// proxy.ts — generate and forward request ID
import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

export function proxy(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-request-id', requestId);
  return response;
}
```

```typescript
// src/lib/logger.ts — also export the request-scoped helper
import { headers } from 'next/headers';

export async function getRequestLogger(module: string) {
  const requestId = (await headers()).get('x-request-id');
  return logger.child({ module, requestId });
}
```

Every log line from that request includes `requestId`, making it trivial to trace a full request across API calls, server actions, and error handlers.

### Logging in the API client

The API client logs every request and error. See `references/api-client-pattern.md` for the full implementation.

```typescript
const log = logger.child({ module: 'api-client' });

// After response — log path, method, status, duration (ms)
log.info({ method: 'GET', path, status: response.status, duration }, 'api_request');

// On non-OK response (before throwing ApiError)
log.error({ method: 'GET', path, status: response.status, duration }, 'api_error');
```

Never log the full request body or auth headers.

### Logging in Server Actions

Log the mutation type, entity identifier, and outcome.

```typescript
// Inside a Server Action (see references/server-actions.md for full action structure)
const log = await getRequestLogger('action:cart');

// Validation failure
log.warn({ action: 'addToCart', reason: 'validation_failed' }, 'action_rejected');

// Success — log the entity ID, not the full payload
log.info({ action: 'addToCart', productId: parsed.data.productId }, 'action_success');

// Caught error — pass error as `err` for automatic stack serialization
log.error({ action: 'addToCart', err: error }, 'action_failed');
```

### Logging in proxy.ts

Log every proxied request at `info` level with path, locale, and rewrite target.

```typescript
const log = logger.child({ module: 'proxy' });

log.info(
  { path: request.nextUrl.pathname, locale: resolvedLocale, rewrite: rewriteTarget ?? null },
  'proxy_request',
);
```

### Logging errors with stack and context

Pass the error object as `err` — pino serializes name, message, and stack automatically.

```typescript
try {
  const data = await getProduct(slug);
} catch (error) {
  log.error(
    {
      err: error,               // pino extracts name, message, stack
      path: `/products/${slug}`,
      userId: session?.userId,  // internal UUID, not PII
    },
    'product_fetch_failed',
  );
}
```

Cross-reference: `references/error-handling.md` covers error boundaries and recovery. Log the error where it is thrown (Server Component, Server Action, route handler) — not in `error.tsx`, which is a `'use client'` component and cannot import the server logger.

### Dev vs production config

| Setting | Development | Production |
|---------|-------------|------------|
| Level | `debug` | `info` |
| Transport | `pino-pretty` (colorized) | Default JSON (NDJSON to stdout) |
| `pino-pretty` | devDependency | Not loaded, not bundled |

## When

| Situation | Level | What to log |
|-----------|-------|-------------|
| API client receives response | `info` | method, path, status, duration |
| API client gets 4xx/5xx | `error` | method, path, status, duration |
| Server Action validation fails | `warn` | action name, rejection reason |
| Server Action mutation succeeds | `info` | action name, entity ID |
| Server Action mutation fails | `error` | action name, error object |
| proxy.ts processes request | `info` | path, locale, rewrite target |
| Webhook received | `info` | webhook type, source |
| Auth token refreshed | `info` | event name only — no tokens |
| Auth token refresh failed | `warn` | event name and reason — no tokens |
| Rate limit hit | `warn` | action name, client identifier hash |
| Unhandled exception | `error` | full error object with stack |
| Config/env resolution | `debug` | resolved values (no secrets) |

## Never

- **No PII in logs.** Never log email addresses, full names, phone numbers, physical addresses, IP addresses, payment details, government IDs. `userId` (internal UUID) is acceptable — it is an opaque identifier, not PII.
- **No secrets or tokens.** Never log access tokens, refresh tokens, API keys, session cookies, encryption keys. Log that an event occurred, not the credentials involved.
- **No full request/response bodies.** Bodies may contain user data. Log the operation name, entity ID, and status — not the payload.
- **No string concatenation.**
  ```typescript
  // WRONG — log.info(`User ${userId} created product ${productId}`);
  // RIGHT — log.info({ userId, productId }, 'product_created');
  ```
- **No `console.log` in production code.** Use the pino logger. `console.log` is unstructured, has no levels, and is invisible to log aggregators. Lint rule: flag `console.log` as error.
- **No client-side pino.** `src/lib/logger.ts` imports `'server-only'`. For client-side error reporting, use a tracking/error service (see `references/tracking.md`).
- **No logging inside `error.tsx`.** It is a `'use client'` component — it cannot import the server logger. Log errors where they are thrown, not where the boundary catches them.
