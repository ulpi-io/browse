# Unit Testing — Vitest

## What

Vitest tests pure functions, Zod schemas, API client modules, Server Actions, hooks, and component rendering in isolation.

### Setup — vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom', globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['src/test/**'] },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

Path aliases must match `tsconfig.json`. Setup file (`src/test/setup.ts`) imports `@testing-library/jest-dom/vitest` for matchers like `toBeInTheDocument()`.

### File organization

Co-locate tests: `cart.ts` + `cart.test.ts`, `products.ts` + `products.test.ts`. One convention per project — co-located `.test.ts` or `__tests__/` directories. Never mix both.

## How

### Testing a Server Action — complete example

```typescript
// src/actions/cart.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addToCartAction } from './cart';
vi.mock('@/lib/api/endpoints/cart', () => ({ addToCartItem: vi.fn() }));
vi.mock('@/lib/auth/dal', () => ({ verifySession: vi.fn() }));
vi.mock('next/cache', () => ({ updateTag: vi.fn() }));
import { addToCartItem } from '@/lib/api/endpoints/cart';
import { verifySession } from '@/lib/auth/dal';
import { updateTag } from 'next/cache';

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
function fd(data: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(data)) f.append(k, v);
  return f;
}

describe('addToCartAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifySession).mockResolvedValue({ userId: 'u1', role: 'user' });
  });

  it('returns success and calls updateTag on valid input', async () => {
    const item = { id: 'ci1', productId: 'p1', quantity: 2 };
    vi.mocked(addToCartItem).mockResolvedValue(item);
    const result = await addToCartAction(null, fd({ productId: UUID, quantity: '2' }));
    expect(result).toEqual({ success: true, data: item });
    expect(addToCartItem).toHaveBeenCalledWith('u1', { productId: UUID, quantity: 2 });
    expect(updateTag).toHaveBeenCalledWith('cart');
  });

  it('returns fieldErrors when Zod validation fails', async () => {
    const result = await addToCartAction(null, fd({ productId: 'bad', quantity: '0' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('validation_failed');
      expect(result.fieldErrors?.productId).toBeDefined();
    }
    expect(addToCartItem).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });

  it('returns error when API call fails', async () => {
    vi.mocked(addToCartItem).mockRejectedValue(new Error('fail'));
    const result = await addToCartAction(null, fd({ productId: UUID, quantity: '1' }));
    expect(result).toEqual({ success: false, error: 'cart.addFailed' });
    expect(updateTag).not.toHaveBeenCalled();
  });

  it('return type matches ActionResult discriminated union', async () => {
    vi.mocked(addToCartItem).mockResolvedValue({ id: 'ci1', productId: 'p1', quantity: 1 });
    const result = await addToCartAction(null, fd({ productId: UUID, quantity: '1' }));
    if (result.success) expect(result.data).toBeDefined();
    else expect(result.error).toBeDefined();
  });
});
```

**Pattern:** Mock API client, `verifySession`, `next/cache`. Call with `FormData`. Assert return matches `ActionResult<T>`, correct API called, `updateTag` invoked. Every suite must include a validation failure test where the API is never called.

### Testing an API endpoint module — complete example

```typescript
// src/lib/api/endpoints/products.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api/client';
import { getProduct, getProducts } from './products';

describe('products endpoint module', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('getProduct calls apiFetch with correct path', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'p1', slug: 'widget' });
    expect(await getProduct('widget')).toEqual({ id: 'p1', slug: 'widget' });
    expect(apiFetch).toHaveBeenCalledWith('/products/widget');
  });
  it('getProducts appends query params', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data: [], pagination: {} });
    await getProducts({ page: 2, category: 'electronics' });
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'));
  });
  it('getProducts with no params calls base path', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ data: [], pagination: {} });
    await getProducts();
    expect(apiFetch).toHaveBeenCalledWith('/products');
  });
});
```

Mock `apiFetch` at the module level. Never mock `fetch` for endpoint modules — mock the API client layer.

### Testing the API client — mock fetch

When testing `client.ts` itself, mock global `fetch` and Next.js server functions:

```typescript
// src/lib/api/client.test.ts
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ 'accept-language': 'en' })),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn().mockResolvedValue({ accessToken: 'tok_123' }),
  refreshAccessToken: vi.fn(),
}));
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ id: 1 }), { status: 200 }),
));

it('attaches Authorization and Accept-Language headers', async () => {
  await apiFetch('/products/1');
  const headers = vi.mocked(fetch).mock.calls[0]![1]!.headers as Headers;
  expect(headers.get('Authorization')).toBe('Bearer tok_123');
  expect(headers.get('Accept-Language')).toBe('en');
});
```

### Testing Zod schemas

```typescript
// src/lib/validations/cart.test.ts
import { describe, it, expect } from 'vitest';
import { addToCartSchema } from './cart';
const VALID = { productId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', quantity: 3 };

it('accepts valid input', () => { expect(addToCartSchema.safeParse(VALID).success).toBe(true); });
it('rejects non-UUID productId', () => {
  const r = addToCartSchema.safeParse({ ...VALID, productId: 'abc' });
  if (!r.success) expect(r.error.flatten().fieldErrors.productId).toBeDefined();
});
it('rejects quantity below 1', () => { expect(addToCartSchema.safeParse({ ...VALID, quantity: 0 }).success).toBe(false); });
it('rejects quantity above 99', () => { expect(addToCartSchema.safeParse({ ...VALID, quantity: 100 }).success).toBe(false); });
```

Test success and failure. Verify the correct field is flagged. Cover boundary values.

### Testing hooks — renderHook

```typescript
import { renderHook, act } from '@testing-library/react';
import { useDebounce } from './use-debounce';

it('debounces value updates', async () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(
    ({ value, delay }) => useDebounce(value, delay),
    { initialProps: { value: 'hello', delay: 300 } },
  );
  rerender({ value: 'world', delay: 300 });
  expect(result.current).toBe('hello');
  await act(() => { vi.advanceTimersByTime(300); });
  expect(result.current).toBe('world');
  vi.useRealTimers();
});
```

### Testing components

Mock `next-intl` with an identity function. For async Server Components that fetch data, mock the API endpoint module and `await` the component function before passing to `render`.

```tsx
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

it('renders product name and price', () => {
  render(<ProductCard name="Widget" price={29.99} currency="USD"
    imageUrl="/w.jpg" imageAlt="A widget" slug="widget" />);
  expect(screen.getByText('Widget')).toBeInTheDocument();
});
```

## When

### Unit test vs e2e test — decision tree

```
├─ Pure function, Zod schema, API client logic           → Unit test
├─ Server Action: validation, API call, return type      → Unit test
├─ Server Action: full form → action → UI update         → E2e test
├─ Custom hook logic, component render from props        → Unit test
├─ Navigation, form e2e, i18n switching, auth flow       → E2e test
└─ Visual layout, responsive design                      → E2e test
```

If it returns a value or renders predictable output from props, unit test. If it involves navigation, browser state, or full request cycle, e2e test. See `references/testing-e2e.md`.

### What to mock

**Always mock:** `apiFetch` (never hit a real API), `verifySession()` (no real session), `next/cache` (`updateTag`/`revalidateTag` — side effects), `next/headers` (`headers()`/`cookies()` — no request context).

**Never mock:** Zod schemas (subject under test, fast), utility functions (pure, deterministic).

**Identity mock:** `next-intl` `useTranslations` — returns the key as the value, sufficient for unit tests.

### When to write tests

**Always:** New Server Action (validation + success + failure), new Zod schema (valid + each invalid field + boundaries), new API endpoint module (path + params), new custom hook (state + transitions), new feature component (output given props), bug fixes (regression test).

**Optional:** New `ui/` component — only if it has conditional rendering logic.

## Never

- **No testing implementation details.** Test behavior (return values, rendered output), not internal state.
- **No mocking Zod schemas.** Run the real schema. They are fast and their logic is the subject under test.
- **No `fetch` mocking for endpoint modules.** Mock `apiFetch`. Only mock `fetch` when testing `client.ts` itself.
- **No snapshot tests.** Brittle, no signal. Assert specific elements and content.
- **No testing `t()` return values.** Mock `useTranslations` as identity function. Translation correctness is an i18n concern.
- **No testing framework behavior.** Do not test that `redirect()` works or `'use server'` creates a Server Action.
- **No skipping validation failure path.** Every Server Action suite must test Zod rejection with API never called.
- **No `any` in test files.** Use `vi.mocked()` for typed mock instances.
- **No order-dependent tests.** Each test independent. `beforeEach` with `vi.clearAllMocks()`.
