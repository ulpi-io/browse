# Caching Strategy

## What

Next.js 16 replaces the old fetch-based caching model with the `'use cache'` directive. Caching is opt-in, explicit, and requires `cacheComponents: true` in `next.config.ts` — without it, every `'use cache'` directive is silently ignored.

### Prerequisite

```typescript
// next.config.ts — required for ANY caching to work
const nextConfig: NextConfig = {
  cacheComponents: true,  // WITHOUT THIS, 'use cache' is silently ignored
};
```

### The `'use cache'` directive

| Scope | Placement | What it caches |
|-------|-----------|----------------|
| File-level | Top of file, before imports | Every exported function in the module |
| Component-level | First line inside a component function | That single component's rendered output |
| Function-level | First line inside a function | That function's return value |

### Cache scope variants

| Directive | Shared across requests | Use case |
|-----------|----------------------|----------|
| `'use cache'` | Yes — default shared cache | Most data fetching, shared content |
| `'use cache: remote'` | Yes — via external cache handler (Redis, KV) | Platforms with dedicated cache infrastructure. Network roundtrip cost. |
| `'use cache: private'` | No — per-request, accesses runtime request APIs | Compliance requirements, user-specific cached data that needs `cookies()`/`headers()` |

### `cacheLife` presets

Built-in profiles control staleness, revalidation, and expiration:

| Preset | Stale | Revalidate | Expire |
|--------|-------|------------|--------|
| `"seconds"` | 0 | 1s | 60s |
| `"minutes"` | 5min | 1min | 1h |
| `"hours"` | 5min | 1h | 24h |
| `"days"` | 5min | 1d | 7d |
| `"weeks"` | 5min | 1w | 30d |
| `"max"` | 5min | 30d | never |
| _(default)_ | 5min | 15min | never |

**Default profile** (when `cacheLife` is not specified): stale after 5 minutes, revalidate every 15 minutes, never expires from cache.

Custom profiles in `next.config.ts`:

```typescript
const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheLife: {
    catalog: { stale: 300, revalidate: 3600, expire: 86400 },    // 5min / 1h / 1d
    realtime: { stale: 0, revalidate: 1, expire: 60 },           // 0 / 1s / 60s
  },
};
```

### `cacheTag` — granular invalidation

Tag cached data so it can be invalidated by name:

```typescript
import { cacheTag } from 'next/cache';

async function getProduct(slug: string) {
  'use cache';
  cacheTag(`product-${slug}`, 'products');
  // ... fetch and return
}
```

A single cached function can have multiple tags. Invalidating any one tag invalidates the entry.

### Three invalidation APIs

| API | Semantics | Where it runs | Signature |
|-----|-----------|---------------|-----------|
| `updateTag(tag)` | Read-your-writes — user sees fresh data immediately | Server Actions only | `updateTag(tag: string)` |
| `revalidateTag(tag, profile)` | SWR background refresh — serves stale, refreshes behind the scenes | Server Actions, route handlers | `revalidateTag(tag: string, profile: string)` |
| `refresh()` | Refreshes uncached data only — no cache involvement | Server-side | `refresh()` |

**`updateTag(tag)`** — The acting user sees the updated data on the very next render. Other users continue seeing the cached version until it naturally revalidates. Use for user-facing mutations where the person who made the change must see it immediately.

**`revalidateTag(tag, profile)`** — Marks the tagged cache entry as stale and triggers a background refresh. The next request gets the old data while fresh data is generated. The second argument is the `cacheLife` profile name (e.g., `'minutes'`, `'hours'`, or a custom profile). The single-argument form is deprecated — always pass the profile.

**`refresh()`** — Server-side equivalent of `router.refresh()`. Re-runs Server Components to pick up fresh uncached data. Does not touch the cache at all. Use when data is not cached but the page needs to reflect a change.

### The four cache layers

| Layer | Scope | What it caches | Invalidation |
|-------|-------|----------------|-------------|
| Request memoization | Single request | Duplicate `fetch()` calls with same URL/options | Automatic — per-request |
| Data cache | Cross-request | `'use cache'` function/component return values | `updateTag`, `revalidateTag` |
| Full route cache | Cross-request | Static route HTML + RSC payload | Revalidation of underlying data |
| Router cache | Client-side | Previously visited routes in browser session | `router.refresh()`, navigation, time-based |

### Serialization constraints

Cached function arguments and return values must be serializable.

**Can serialize:** primitives, plain objects/arrays, `Date`, `Map`, `Set`, `TypedArray`, `ArrayBuffer`, Server Action references, JSX elements / `children` (passed through without introspection).

**Cannot serialize:** class instances, closures, Symbols, DOM nodes, Streams.

## How

### Function-level caching — data fetcher

```typescript
import { cacheTag, cacheLife } from 'next/cache';
import { apiFetch } from '@/lib/api/client';
import type { Product } from '@/types/product';

async function getProduct(slug: string): Promise<Product> {
  'use cache';
  cacheLife('hours');
  cacheTag(`product-${slug}`, 'products');

  return apiFetch<Product>(`/products/${slug}`);
}

async function getProductList(category: string): Promise<Product[]> {
  'use cache';
  cacheLife('minutes');
  cacheTag(`products-${category}`, 'products');

  return apiFetch<Product[]>(`/products?category=${category}`);
}

export { getProduct, getProductList };
```

### Component-level caching

```tsx
import { cacheTag, cacheLife } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { getProduct } from '@/lib/api/endpoints/products';
import { formatPrice } from '@/lib/utils/format';

async function ProductDetails({ slug }: { slug: string }) {
  'use cache';
  cacheLife('hours');
  cacheTag(`product-${slug}`);

  const t = await getTranslations('products');
  const product = await getProduct(slug);

  return (
    <section>
      <h2 className="text-start text-2xl font-bold">{product.name}</h2>
      <p className="mt-2 text-start text-muted-foreground">
        {formatPrice(product.price, product.currency)}
      </p>
      <p className="mt-4 text-start">{product.description}</p>
    </section>
  );
}

export { ProductDetails };
```

### Invalidation — all three APIs in a Server Action

```typescript
'use server';

import { updateTag, revalidateTag, refresh } from 'next/cache';
import { apiFetch } from '@/lib/api/client';
import { verifySession } from '@/lib/auth/dal';
import { updateProductSchema } from '@/lib/validations/products';
import type { ActionResult } from '@/types/actions';
import type { Product } from '@/types/product';

// Mutation the user must see immediately → updateTag
export async function updateProduct(
  productId: string, formData: FormData,
): Promise<ActionResult<Product>> {
  await verifySession();
  const parsed = updateProductSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { success: false, error: 'Validation failed', fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const product = await apiFetch<Product>(`/products/${productId}`, {
    method: 'PATCH', body: JSON.stringify(parsed.data),
  });
  updateTag(`product-${product.slug}`); // read-your-writes: editor sees fresh data
  return { success: true, data: product };
}

// Background content refresh → revalidateTag (2nd arg = cacheLife profile, required)
export async function refreshCatalog(): Promise<ActionResult<null>> {
  await verifySession();
  revalidateTag('products', 'minutes'); // SWR: stale served while refreshing
  return { success: true, data: null };
}

// Uncached data changed (e.g., user preferences in cookies) → refresh
export async function updatePreferences(formData: FormData): Promise<ActionResult<null>> {
  const session = await verifySession();
  await apiFetch(`/users/${session.userId}/preferences`, {
    method: 'PUT', body: JSON.stringify(Object.fromEntries(formData)),
  });
  refresh(); // no cached data involved — re-render Server Components with fresh uncached data
  return { success: true, data: null };
}
```

## When

### Invalidation decision tree

| Scenario | API | Why |
|----------|-----|-----|
| User edits their own content (profile, post, product) | `updateTag(tag)` | User must see their change immediately |
| Admin publishes new content visible to all | `revalidateTag(tag, profile)` | SWR is fine — other users get it on next load |
| Webhook signals external data changed | `revalidateTag(tag, profile)` | Background refresh, no user waiting |
| User changes preferences stored in cookies | `refresh()` | Data is not cached, just re-render |
| Navigation after login/logout | `refresh()` | Session state changed, re-render with new auth |

### Caching strategy by data type

| Data type | Directive | cacheLife | cacheTag | Invalidation |
|-----------|-----------|-----------|----------|-------------|
| Product catalog | `'use cache'` | `'hours'` | `products`, `product-{slug}` | `revalidateTag('products', 'hours')` on webhook |
| User cart | None — do not cache | — | — | `refresh()` after mutation |
| Session / auth state | None — do not cache | — | — | `refresh()` on login/logout |
| Static content (about, legal) | `'use cache'` | `'max'` | `static-content` | `revalidateTag('static-content', 'max')` on CMS publish |
| Search results | `'use cache'` | `'minutes'` | `search-{query}` | Time-based expiry, no manual invalidation |
| User-specific dashboard | `'use cache: private'` | `'minutes'` | `dashboard-{userId}` | `updateTag('dashboard-{userId}')` on mutation |

### `'use cache'` variant decision tree

| Condition | Use |
|-----------|-----|
| Shared data, no per-user variation | `'use cache'` |
| Platform provides Redis/KV cache handler | `'use cache: remote'` |
| Per-user data, needs `cookies()`/`headers()` access | `'use cache: private'` |
| Rapidly changing user-specific data (cart, active session) | Do not cache |

## Never

- **No missing `cacheComponents: true`** — without it, every `'use cache'` is dead code. No error, no warning. This is the single most common caching mistake.
- **No single-argument `revalidateTag(tag)`** — the single-arg form is deprecated. Always pass the `cacheLife` profile as the second argument: `revalidateTag('products', 'hours')`.
- **No `updateTag` outside Server Actions** — `updateTag` only works inside Server Actions. In route handlers or other server code, use `revalidateTag`.
- **No caching of non-serializable arguments** — class instances, functions, Symbols, and DOM nodes cannot be arguments to cached functions. Restructure to pass plain objects.
- **No `'use cache'` on user-specific mutable data** — cart contents, active form state, and session data should not be cached. Cache misses are cheap; stale user data is a bug.
- **No `'use cache: private'` for shared content** — private cache is per-request. Use default `'use cache'` for content shared across users.
- **No `refresh()` to invalidate cached data** — `refresh()` only affects uncached data. To invalidate cache entries, use `updateTag` or `revalidateTag` with the appropriate tag.
- **No caching without tags** — every `'use cache'` function should call `cacheTag()`. Without tags, you have no way to invalidate specific entries and must wait for time-based expiry.
- **No forgetting that `cacheTag` is additive** — a function with `cacheTag('products', 'featured')` is invalidated when EITHER tag is invalidated. Design tags so unwanted cross-invalidation does not occur.
