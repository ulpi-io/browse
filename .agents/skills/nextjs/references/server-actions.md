# Server Actions — Mutations

## What

Server Actions are async functions that run on the server, invoked from forms or client code. They handle all mutations: creating, updating, and deleting data through the API client. Every Server Action validates input with Zod, authorizes the user, calls the API, and revalidates cached data.

### File location

`src/actions/{domain}.ts` — one file per domain (e.g., `cart.ts`, `products.ts`, `users.ts`). The `'use server'` directive at the top of the file makes every exported function a Server Action.

### Return type — discriminated union

```typescript
// src/types/actions.ts
type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; fieldErrors?: Record<string, string[]> };
```

Every Server Action returns `ActionResult<T>`. Callers check `result.success` to discriminate. `fieldErrors` maps Zod field-level errors to form inputs. Never throw from a Server Action — return the error shape instead.

### Zod validation

Validation schemas live in `src/lib/validations/{domain}.ts` (e.g., `src/lib/validations/cart.ts`). Import and validate inside the action before any mutation. Zod `safeParse` returns field-level errors that map directly to `fieldErrors`.

### Revalidation after mutation

Three APIs, each with different semantics. Call-site pattern only — see `references/caching-strategy.md` for the full decision tree.

| API | Semantics | When to use |
|-----|-----------|-------------|
| `updateTag(tag)` | Read-your-writes — user sees fresh data immediately | User-facing mutations: add to cart, update profile, submit form |
| `revalidateTag(tag, profile)` | SWR background refresh — stale served while revalidating | Background content: admin publishes article, inventory sync |
| `refresh()` | Refreshes uncached data only, no cache involvement | Data not using `'use cache'` that needs a fresh server render |

`updateTag` is the default choice. `revalidateTag` requires the `cacheLife` profile as 2nd arg (single-arg form deprecated in Next.js 16).

## How

### Complete Server Action — addToCartAction

```typescript
// src/actions/cart.ts
'use server';
import { updateTag } from 'next/cache';
import { verifySession } from '@/lib/auth/dal';
import { addToCartItem } from '@/lib/api/endpoints/cart';
import { addToCartSchema } from '@/lib/validations/cart';
import type { ActionResult } from '@/types/actions';
import type { CartItem } from '@/types/cart';

export async function addToCartAction(
  _prevState: ActionResult<CartItem> | null,
  formData: FormData,
): Promise<ActionResult<CartItem>> {
  // 1. Authenticate
  const session = await verifySession();

  // 2. Validate
  const parsed = addToCartSchema.safeParse({
    productId: formData.get('productId'),
    quantity: Number(formData.get('quantity')),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: 'validation_failed',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  // 3. Mutate via API client
  try {
    const item = await addToCartItem(session.userId, parsed.data);
    // 4. Revalidate — user sees updated cart immediately
    updateTag('cart');
    return { success: true, data: item };
  } catch (error) {
    return { success: false, error: 'cart.addFailed' };
  }
}
```

`_prevState` is required by `useActionState` (underscore signals unused). `verifySession()` is `React.cache()`-wrapped — deduplicated per request (see `references/auth.md`). Error strings like `'cart.addFailed'` are translation keys — the form passes them to `t()`. See `references/security.md` for IDOR prevention.

### Zod validation schema

```typescript
// src/lib/validations/cart.ts
import { z } from 'zod';

export const addToCartSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
});

export type AddToCartInput = z.infer<typeof addToCartSchema>;
```

### Complete form — useActionState + useFormStatus

```tsx
// src/app/[locale]/products/[slug]/_components/add-to-cart-form.tsx
'use client';
import { useActionState, useOptimistic } from 'react';
import { useTranslations } from 'next-intl';
import { addToCartAction } from '@/actions/cart';
import type { ActionResult } from '@/types/actions';
import type { CartItem } from '@/types/cart';

interface AddToCartFormProps {
  productId: string;
  productName: string;
  cartCount: number;
}

function AddToCartForm({ productId, productName, cartCount }: AddToCartFormProps) {
  const t = useTranslations('products');
  const [optimisticCount, addOptimistic] = useOptimistic(
    cartCount,
    (current, _increment: number) => current + _increment,
  );
  const [state, formAction, isPending] = useActionState<
    ActionResult<CartItem> | null, FormData
  >(async (prevState, formData) => {
    addOptimistic(1);
    return addToCartAction(prevState, formData);
  }, null);

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="quantity" value="1" />
      <SubmitButton isPending={isPending} productName={productName} />
      <p className="mt-2 text-sm text-muted-foreground">
        {t('cart.itemCount', { count: optimisticCount })}
      </p>
      {state && !state.success && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t(state.error)}
        </p>
      )}
    </form>
  );
}
export { AddToCartForm };
```

```tsx
// src/app/[locale]/products/[slug]/_components/submit-button.tsx — MUST be a child of <form>
'use client';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

function SubmitButton({ isPending, productName }: { isPending: boolean; productName: string }) {
  const t = useTranslations('products');
  const { pending } = useFormStatus();
  const isDisabled = isPending || pending;
  return (
    <Button type="submit" disabled={isDisabled}
      aria-label={t('cart.addAriaLabel', { product: productName })}>
      {isDisabled ? t('cart.adding') : t('cart.add')}
    </Button>
  );
}
export { SubmitButton };
```

**Progressive enhancement:** `<form action={formAction}>` works without JS — standard POST, action runs, page re-renders. JS enhances with optimistic updates and pending UI.

**`useActionState`** returns `[state, formAction, isPending]`. The `formAction` goes on `<form action>`. **`useFormStatus`** must be in a **child** of `<form>` — that is why `SubmitButton` is extracted. **`useOptimistic`** resets automatically when the action completes and the server re-renders. Error strings are translation keys — `t(state.error)`. `role="alert"` announces to screen readers (see `references/accessibility.md`). All visible strings use `t()`.

## When

### Choosing the revalidation API

```
Mutation succeeded → data cached with 'use cache' + cacheTag?
├─ YES, user must see change now  →  updateTag('tag-name')
├─ YES, background refresh OK     →  revalidateTag('tag-name', 'hours')
└─ NO, data is not cached         →  refresh()
```

### useActionState vs useTransition for calling actions

| Scenario | Use |
|----------|-----|
| HTML form with inputs, progressive enhancement needed | `useActionState` — manages form state, works without JS |
| Button click, no form inputs | `useTransition` + direct action call — simpler API |
| Form with optimistic updates | `useActionState` + `useOptimistic` — full form lifecycle |

### When to split action files

| Condition | Action |
|-----------|--------|
| File exceeds ~150 lines | Split by sub-domain: `cart-items.ts`, `cart-coupons.ts` |
| Action needs different authorization | Separate file — makes auth boundaries visible |
| Single domain, few actions | One file: `src/actions/cart.ts` |

## Never

### Missing validation or authorization

```typescript
// WRONG — trusting client input, no auth
export async function deletePostAction(postId: string) {
  await deletePost(postId);
}

// RIGHT — validate, authenticate, authorize (IDOR check), then mutate
const session = await verifySession();
const parsed = z.string().uuid().safeParse(formData.get('postId'));
if (!parsed.success) return { success: false, error: 'validation_failed' };
const post = await getPost(parsed.data);
if (post.authorId !== session.userId) return { success: false, error: 'forbidden' };
await deletePost(parsed.data);
updateTag('posts');
return { success: true, data: undefined };
```

Server Actions are public HTTP endpoints — anyone can POST directly. Always validate with Zod and authorize with `verifySession()`. See `references/security.md` for IDOR prevention.

### Throwing errors instead of returning

```typescript
// WRONG — .parse() throws, breaking the discriminated union contract
const data = updateProfileSchema.parse(formData);

// RIGHT — .safeParse() returns, map to ActionResult
const parsed = updateProfileSchema.safeParse(/* ... */);
if (!parsed.success) {
  return { success: false, error: 'validation_failed', fieldErrors: ... };
}
```

Use `safeParse`, not `parse`. Wrap API calls in try/catch and return `{ success: false, error: 'key' }` — never let exceptions escape.

### Other anti-patterns

- **No `useFormStatus` in the form component itself** — it reads the **parent** `<form>`, so it must be in a child component. Calling it in the same component that renders `<form>` always returns `{ pending: false }`.
- **No `revalidateTag(tag)` with one argument** — deprecated in Next.js 16. Always pass the `cacheLife` profile as the second argument: `revalidateTag('products', 'hours')`.
- **No inline fetch in actions** — call the API client from `src/lib/api/endpoints/`. See `references/api-client-pattern.md`.
- **No `redirect()` inside try/catch** — `redirect()` throws internally. Calling it inside a `catch` block will swallow the redirect. Call `redirect()` after the try/catch.
- **No `'use server'` on individual functions** — put it at the file top. One directive covers all exports and keeps actions co-located by domain.
- **No hardcoded error messages** — return translation keys (`'cart.addFailed'`). The form component calls `t(key)` to display the translated message.
- **No skipping `verifySession()`** — even if the page is behind auth in proxy.ts, the action is a separate entry point. See `references/auth.md`.
