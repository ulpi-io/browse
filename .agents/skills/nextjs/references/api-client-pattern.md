# API Client Pattern

## What

All data reads go through a typed `apiFetch<T>()` function in `src/lib/api/client.ts`. It wraps native `fetch` with auth token forwarding, locale headers, structured error handling, and request logging. No Axios, no ORM, no inline fetch.

Endpoint modules in `src/lib/api/endpoints/` organize calls by domain. Each exports typed async functions that Server Components and Server Actions call directly.

```
src/lib/api/
  client.ts              # apiFetch<T>() — base fetcher
  types.ts               # ApiError, PaginatedResponse<T>
  endpoints/
    products.ts          # getProduct(), getProducts()
    users.ts             # getUser(), getUserPreferences()
    orders.ts            # getOrder(), getOrders()
```

## How

### client.ts — complete reference implementation

```typescript
import 'server-only';

import { headers } from 'next/headers';

import pino from 'pino';

import { getSession, refreshAccessToken } from '@/lib/auth/session';

const logger = pino({ name: 'api-client' });
const API_BASE_URL = process.env.API_BASE_URL!;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly message: string,
    public readonly code?: string,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface FetchOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
  public?: boolean; // Skip auth — use for public endpoints
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { public: isPublic = false, ...fetchOptions } = options;
  const start = performance.now();
  const reqHeaders = new Headers(fetchOptions.headers);

  // Auth token from encrypted session cookie (see auth.md)
  if (!isPublic) {
    const session = await getSession();
    if (session?.accessToken) {
      reqHeaders.set('Authorization', `Bearer ${session.accessToken}`);
    }
  }

  // Forward Accept-Language for i18n
  const incomingHeaders = await headers();
  const locale = incomingHeaders.get('accept-language');
  if (locale) reqHeaders.set('Accept-Language', locale);

  reqHeaders.set('Content-Type', 'application/json');
  reqHeaders.set('Accept', 'application/json');

  const url = `${API_BASE_URL}${path}`;
  let response = await fetch(url, { ...fetchOptions, headers: reqHeaders });

  // Token refresh on 401 (see auth.md for full refresh flow)
  if (response.status === 401 && !isPublic) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      reqHeaders.set('Authorization', `Bearer ${refreshed.accessToken}`);
      response = await fetch(url, { ...fetchOptions, headers: reqHeaders });
    }
  }

  const duration = Math.round(performance.now() - start);
  logger.info({ method: fetchOptions.method ?? 'GET', path, status: response.status, duration }, 'api_request');

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    logger.error({ method: fetchOptions.method ?? 'GET', path, status: response.status }, 'api_error');
    throw new ApiError(response.status, body.message ?? response.statusText, body.code, body.fieldErrors);
  }

  return response.json() as Promise<T>;
}
```

### types.ts

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}
```

### Endpoint module — products.ts

```typescript
import { apiFetch } from '@/lib/api/client';
import type { PaginatedResponse } from '@/lib/api/types';

export interface Product {
  id: string;  slug: string;  name: string;  description: string;
  price: number;  currency: string;  imageUrl: string;  imageAlt: string;
  category: string;  isNew: boolean;
}

export async function getProduct(slug: string): Promise<Product> {
  return apiFetch<Product>(`/products/${slug}`);
}

export async function getProducts(
  params?: { page?: number; pageSize?: number; category?: string },
): Promise<PaginatedResponse<Product>> {
  const sp = new URLSearchParams();
  if (params?.page) sp.set('page', String(params.page));
  if (params?.pageSize) sp.set('pageSize', String(params.pageSize));
  if (params?.category) sp.set('category', params.category);
  return apiFetch<PaginatedResponse<Product>>(`/products${sp.size ? `?${sp}` : ''}`);
}
```

### Server Component usage

```tsx
import { getTranslations } from 'next-intl/server';

import { ProductCard } from '@/components/features/product-card';
import { Pagination } from '@/components/ui/pagination';
import { getProducts } from '@/lib/api/endpoints/products';

export default async function ProductsPage(
  { searchParams }: { searchParams: Promise<{ page?: string; category?: string }> },
) {
  const { page, category } = await searchParams;
  const t = await getTranslations('products');
  const { data: products, pagination } = await getProducts({
    page: page ? Number(page) : 1, category,
  });

  return (<section>
    <h1>{t('title')}</h1>
    <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
      {products.map((p) => <ProductCard key={p.id} {...p} />)}
    </div>
    {products.length === 0 && <p>{t('empty')}</p>}
    <Pagination currentPage={pagination.page} totalPages={pagination.totalPages} />
  </section>);
}
```

`searchParams` is a `Promise` — must be `await`ed (sync access removed in Next.js 16). Auth and locale headers are handled by `apiFetch` automatically.

### Server Action usage

```typescript
'use server';

import { revalidateTag } from 'next/cache';

import { ApiError, apiFetch } from '@/lib/api/client';
import { verifySession } from '@/lib/auth/dal';

export async function updateProduct(productId: string, data: { name: string; price: number }) {
  const session = await verifySession();
  if (!session) return { success: false as const, error: 'Unauthorized' };

  try {
    const result = await apiFetch<{ slug: string }>(`/products/${productId}`, {
      method: 'PATCH', body: JSON.stringify(data),
    });
    revalidateTag('products', 'minutes');
    return { success: true as const, data: result };
  } catch (error) {
    if (error instanceof ApiError) {
      return { success: false as const, error: error.message, fieldErrors: error.fieldErrors };
    }
    return { success: false as const, error: 'Unexpected error' };
  }
}
```

### Route handlers — webhooks and revalidation only

Route handlers (`route.ts`) exist for two purposes: webhooks from external services and on-demand revalidation. They are NOT for data fetching or CRUD.

```typescript
// app/api/webhooks/stripe/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { updateTag } from 'next/cache';
import pino from 'pino';

const logger = pino({ name: 'webhook-stripe' });

export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 });

  const body = await request.text();
  if (!verifyStripeSignature(body, signature)) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  const event = JSON.parse(body);
  logger.info({ type: event.type }, 'stripe_webhook_received');
  if (event.type === 'checkout.session.completed') updateTag('orders');
  return NextResponse.json({ received: true });
}
```

## When

| Context | Pattern |
|---------|---------|
| Server Component reads data | `await getProducts()` — call endpoint function at top of component |
| Server Action mutates data | `await apiFetch('/products', { method: 'POST', body })` via base client |
| Server Action reads before mutating | `await getProduct(id)` — endpoint function for reads |
| Client Component needs data | Props from parent Server Component. Never fetch client-side. |
| Webhook from external service | Route handler receives payload, calls `updateTag`/`revalidateTag` |
| On-demand revalidation | Route handler with secret token, calls `revalidateTag` |
| Public endpoint (no auth) | `apiFetch('/public/products', { public: true })` |

**Adding a new domain:** Create `src/lib/api/endpoints/{domain}.ts`, define response interfaces, export typed functions wrapping `apiFetch<T>()`, import in Server Components or Server Actions.

## Never

- **No inline fetch.** Every backend call goes through `apiFetch<T>()`.
  ```typescript
  // WRONG — const res = await fetch(`${process.env.API_URL}/products`);
  // RIGHT — const products = await getProducts();
  ```
- **No Axios, no ky, no got.** Native `fetch` only, wrapped by `apiFetch`.
- **No Prisma, no ORM.** Next.js is a frontend. It talks to a backend API. No database connection.
- **No client-side data fetching.** No `useEffect` + `fetch`, no React Query, no SWR. Server Components fetch data and pass props. See `references/component-anatomy.md`.
- **No route handlers for CRUD.** Route handlers are not a REST API. Reads use Server Components, writes use Server Actions. See `references/server-actions.md`.
- **No token handling in endpoint modules.** Auth lives in `client.ts`. Endpoint modules never touch cookies or tokens. See `references/auth.md`.
- **No untyped responses.** Every call specifies `<T>`. Never `apiFetch<any>()`.
- **No hardcoded API URLs.** Base URL from `process.env.API_BASE_URL`. Endpoints pass relative paths.
- **No swallowed errors.** `apiFetch` throws `ApiError`. Server Components rely on error boundaries, Server Actions catch and return `ActionResult`.
