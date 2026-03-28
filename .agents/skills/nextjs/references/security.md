# Security — CSP, Headers, Tainting, CSRF & XSS

## What

Complete security hardening for a Next.js 16 API-backed frontend. Content Security Policy with per-request nonces, secure response headers, React data tainting, CSRF protection, XSS prevention, server-only enforcement, environment variable rules, Server Action hardening, and secure cookie defaults.

### Ownership boundaries

| Topic | Owner | Cross-reference |
|-------|-------|-----------------|
| Session cookie implementation | auth.md | security.md documents the security principles |
| Server Action authorization flow | auth.md | security.md adds IDOR prevention, rate limiting |
| `server-only` import pattern | security.md | auth.md references it as a dependency |
| CSRF via Server Actions | security.md | -- |
| Token exposure rules | auth.md | security.md covers general env var security |
| Environment variable mechanics | stack.md | security.md covers security rules and footguns |
| Rate limit logging | logging.md | security.md covers rate limit implementation |
| Webhook signature verification | security.md | api-client-pattern.md covers webhook route handlers |

## How

### 1. Content Security Policy -- nonce-based in proxy.ts

Next.js injects inline scripts for hydration. A strict CSP that blocks inline scripts breaks the app. Solution: generate a nonce per request in `proxy.ts`, pass it via header, use it in the CSP directive.

```typescript
// proxy.ts — CSP nonce generation + all secure response headers
import { type NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID();
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'${isDev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self'`,
    `connect-src 'self' ${process.env.API_BASE_URL ?? ''}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.headers.set('X-DNS-Prefetch-Control', 'on');
  return response;
}
```

**Dev vs prod:** Development adds `'unsafe-eval'` to `script-src` for Turbopack HMR. Production is strict nonce-only.

**Root layout reads the nonce** via `(await headers()).get('x-nonce')` and passes it to `<Script nonce={nonce}>` components.

**CSP violation reporting:** Add `report-uri /api/csp-report` to the CSP string. Route handler at `app/api/csp-report/route.ts` logs violations via pino at `warn` level. See `references/logging.md`.

### 2. Secure response headers

All headers set in `proxy.ts` (code above), not in `next.config.ts` `headers()`. proxy.ts gives per-request control and nonce access.

| Header | Value | Why |
|--------|-------|-----|
| `X-Frame-Options` | `DENY` | Prevents clickjacking. Defense-in-depth alongside CSP `frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Forces HTTPS for 2 years, HSTS preload eligible |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Origin on cross-origin, full URL on same-origin |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | Disables sensitive browser APIs unless explicitly needed |
| `X-DNS-Prefetch-Control` | `on` | Allows DNS prefetching for performance |

### 3. Data tainting API

Prevents sensitive data from leaking to Client Components at build/render time.

```typescript
// next.config.ts — required
const nextConfig: NextConfig = { experimental: { taint: true } };
```

**`taintObjectReference(message, object)`** -- prevents an entire object from being passed to Client Components. Use for user records, session objects, any object with mixed public/private fields.

**`taintUniqueValue(message, owner, value)`** -- prevents a specific value from being passed to Client Components. Use for API keys, tokens, secrets.

```typescript
// src/lib/auth/dal.ts — taint raw record, return safe DTO
import 'server-only';
import { experimental_taintObjectReference as taintObjectReference } from 'react';
import { cache } from 'react';

export const verifySession = cache(async () => {
  const session = await getSession();
  if (!session) redirect('/login');
  const user = await getUserById(session.userId);

  taintObjectReference('Do not pass raw user record to client. Use the DTO.', user);
  return { userId: user.id, role: user.role, name: user.name };
});
```

```typescript
// src/lib/api/client.ts — taint the auth token value
import { experimental_taintUniqueValue as taintUniqueValue } from 'react';
taintUniqueValue('Do not pass access token to client', session, session.accessToken);
```

### 4. CSRF protection

**Built-in for Server Actions:** POST-only requests, `Origin`/`Host` header comparison (mismatch = aborted), `sameSite: 'lax'` cookies prevent cross-site form submission.

**`allowedOrigins`** for reverse proxy / CDN setups where Origin and Host differ:

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  serverActions: { allowedOrigins: ['my-app.com', '*.my-app.com'] },
};
```

**Webhook route handlers** do not use Server Actions -- verify the webhook signature instead:

```typescript
// src/app/api/webhooks/stripe/route.ts
export async function POST(request: Request) {
  const body = await request.text();
  const signature = (await headers()).get('stripe-signature');
  if (!signature) return new Response('Missing signature', { status: 401 });
  try {
    const event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
    log.info({ type: event.type }, 'webhook_received');
    // Process event...
    return new Response(null, { status: 200 });
  } catch {
    return new Response('Invalid signature', { status: 401 });
  }
}
```

### 5. XSS prevention

**React auto-escaping** is the primary defense. JSX interpolation (`{userInput}`) is escaped automatically.

**`dangerouslySetInnerHTML`** -- required for CMS HTML, rich text, markdown-to-HTML. Always sanitize:

```typescript
import DOMPurify from 'isomorphic-dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(htmlContent) }} />
```

**`href` XSS** -- React does not fully protect against `javascript:` protocol. Validate URLs:

```typescript
function isSafeUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://') || url.startsWith('/');
}
```

**Zod `.transform()`** for defense-in-depth -- strip HTML tags at validation time:

```typescript
// src/lib/validations/comments.ts
export const commentSchema = z.object({
  body: z.string().min(1).max(2000).transform((s) => s.replace(/<[^>]*>/g, '')),
  authorName: z.string().min(1).max(100).transform((s) => s.replace(/<[^>]*>/g, '')),
});
```

### 6. Server-only modules

`import 'server-only'` at the top of any file that must never run on the client. Build error on violation: `"This module is intended for server use only."`

**Files that MUST include it:** `src/lib/auth/session.ts`, `src/lib/auth/dal.ts`, `src/lib/api/client.ts`, `src/lib/logger.ts`, and any file that reads `process.env` server secrets.

**Counterpart:** `import 'client-only'` prevents import in Server Components. Use for files that depend on `window`, `document`, `localStorage`.

### 7. Environment variable security

- Server secrets: `process.env.SECRET_KEY` -- accessible only in Server Components, Server Actions, route handlers, proxy.ts
- Client-safe values: `process.env.NEXT_PUBLIC_API_URL` -- bundled into client JS, visible to everyone
- Never prefix a secret with `NEXT_PUBLIC_`

**Silent failure footgun:** `process.env.SECRET_KEY` in a Client Component returns `undefined` -- no error, no warning. `import 'server-only'` turns this into a build error.

**Runtime env reads:** `process.env` is inlined at build time. For runtime reads, call `connection()` from `next/server` first. See `references/stack.md`.

**`.env` file rules:** `.env.local` never committed (gitignored, local secrets). `.env` committed with non-secret defaults only. `.env.production` committed, production non-secret config. All `.env*.local` in `.gitignore`.

### 8. Server Action security

Server Actions are public HTTP endpoints -- anyone can POST directly. Always validate + authorize inside every action.

**IDOR prevention:**

```typescript
const session = await verifySession();
const parsed = z.string().uuid().safeParse(formData.get('postId'));
if (!parsed.success) return { success: false, error: 'validation_failed' };
const post = await getPost(parsed.data);
if (post.authorId !== session.userId) return { success: false, error: 'forbidden' };
await deletePost(parsed.data);
```

**Closure encryption:** Server Actions defined inside components have closed-over variables encrypted per build. Transport security only -- not secret-keeping. Self-hosted: set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (base64, 32 bytes) for multi-instance consistency.

**Rate limiting** -- check before any work in expensive actions:

```typescript
// src/lib/rate-limit.ts
import 'server-only';
const store = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) { store.set(key, { count: 1, resetAt: now + windowMs }); return true; }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// Usage: if (!checkRateLimit(`send-email:${session.userId}`, 5, 60_000)) return { success: false, error: 'rate_limit_exceeded' };
```

In-memory store for single instance, Redis for distributed. See `references/logging.md` for logging rate limit hits at `warn` level.

### 9. Secure cookie defaults

Cross-reference: `references/auth.md` owns the session cookie implementation.

| Setting | Value | Security purpose |
|---------|-------|-----------------|
| `httpOnly` | `true` | Prevents XSS from reading cookies via `document.cookie` |
| `secure` | `true` | Prevents cookie theft over unencrypted connections |
| `sameSite` | `'lax'` | Baseline CSRF -- cookies not sent on cross-site subrequests |
| `path` | `'/'` | Scopes cookie to entire app |
| `maxAge` | Session duration | Limits exposure window if cookie is stolen |

Use `sameSite: 'strict'` for critical apps (banking, healthcare). Tradeoff: breaks "login and redirect back" from external links.

## When

| Situation | Apply |
|-----------|-------|
| Any `<Script>` or inline script injection | Read nonce from headers, pass `nonce` attribute |
| CMS/rich text HTML rendering | `DOMPurify.sanitize()` before `dangerouslySetInnerHTML` |
| User-provided URLs in `href` | Validate protocol is `http://`, `https://`, or `/` |
| Text inputs from forms | Zod `.transform()` to strip HTML tags |
| New server-only file created | Add `import 'server-only'` as first import |
| New Server Action created | `verifySession()` + Zod validation + IDOR check |
| Expensive Server Action (email, payment) | Rate limit before any work |
| Webhook route handler | Verify signature before processing payload |
| Reverse proxy / CDN setup | Add `allowedOrigins` in next.config.ts |
| Returning raw DB/API records from DAL | `taintObjectReference` the raw record, return a DTO |

## Never

- **No CSP in `next.config.ts` `headers()`** -- proxy.ts is the only place. `headers()` has no access to per-request nonces.
- **No `unsafe-inline` or `unsafe-eval` in production CSP** -- `unsafe-eval` is dev-only for Turbopack HMR.
- **No unsanitized `dangerouslySetInnerHTML`** -- always DOMPurify. No exceptions.
- **No `NEXT_PUBLIC_` prefix on server secrets** -- the value is bundled into client JS, visible to everyone.
- **No relying on page-level auth to protect Server Actions** -- actions are separate POST endpoints. Always `verifySession()` inside each action.
- **No trusting client-provided resource IDs without authorization** -- check `resource.ownerId === session.userId` before every mutation (IDOR).
- **No relying on closure encryption to keep data secret** -- transport security, not a secret-keeping mechanism.
- **No skipping rate limiting on expensive operations** -- email sending, payment processing, account creation must be rate-limited.
- **No `sameSite: 'none'` without a compelling reason** -- opens the door to cross-site request attacks.
