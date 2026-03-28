# Component Anatomy

## What

A component is a single `.tsx` file with one named export. Every component follows the same structure: directive (if needed), imports, props interface, function, export. Components live in one of three tiers that determine what they are allowed to do.

### Component tiers

| Tier | Location | Allowed | Forbidden |
|------|----------|---------|-----------|
| Primitives | `src/components/ui/` | Props only, presentational, Tailwind styling, `ref` forwarding | Hooks with side effects, data fetching, translations `t()`, business logic, server actions |
| Features | `src/components/features/` | Translations `t()`, compose ui/ primitives, client hooks (`useState`, `useTranslations`) | Data fetching, server actions, direct API calls |
| Route-specific | `src/app/*/_components/` | Everything: data fetching, server actions, translations, compose any tier | Reuse outside its route. If needed in 2+ routes, promote to features/ |

### File template

```tsx
'use client';                              // 1. Directive — only if needed

import { useState } from 'react';          // 2a. React / Next.js
import Image from 'next/image';

import { useTranslations } from 'next-intl'; // 2b. Third-party

import { Button } from '@/components/ui/button'; // 2c. @/ internal
import { formatPrice } from '@/lib/utils/format';

import type { CardProps } from './card.types';    // 2d. Relative (never ../../)

interface AddToCartButtonProps {             // 3. Props — explicit, co-located, never any
  productId: string;
  price: number;
  disabled?: boolean;
}

function AddToCartButton({ productId, price, disabled = false }: AddToCartButtonProps) {
  const t = useTranslations('products');    // 4. Component body
  // ...
}

export { AddToCartButton };                 // 5. Named export (default only for page/layout/loading/error)
```

**Import order:** React/Next → third-party → `@/` internal → relative `./`. Blank line between groups. Never `../../` — cross-directory imports always use `@/`.

**Exports:** Named exports for all components. Default exports only for `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `default.tsx`. One component per file.

## How

### Server component — ProductCard (features tier)

```tsx
import Image from 'next/image';
import Link from 'next/link';

import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatPrice } from '@/lib/utils/format';

interface ProductCardProps {
  slug: string;
  name: string;
  price: number;
  currency: string;
  imageUrl: string;
  imageAlt: string;
  isNew?: boolean;
}

async function ProductCard({
  slug, name, price, currency, imageUrl, imageAlt, isNew = false,
}: ProductCardProps) {
  const t = await getTranslations('products');

  return (
    <Card className="group overflow-hidden">
      <Link href={`/products/${slug}`} className="block">
        <div className="relative aspect-[4/3]">
          <Image
            src={imageUrl}
            alt={imageAlt}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            className="object-cover transition-transform group-hover:scale-105
                       motion-reduce:transition-none"
            placeholder="blur"
            blurDataURL={`${imageUrl}?w=10&q=10`}
          />
          {isNew && (
            <Badge className="absolute start-3 top-3">{t('badge.new')}</Badge>
          )}
        </div>
        <div className="p-4">
          <h3 className="text-start text-lg font-semibold">{name}</h3>
          <p className="mt-1 text-start text-muted-foreground">
            {formatPrice(price, currency)}
          </p>
        </div>
      </Link>
    </Card>
  );
}

export { ProductCard };
```

Note: no `'use client'` (server is the default), `async` for `getTranslations`, `fill` + `sizes` on image, `placeholder="blur"` for perceived performance, logical properties (`start-3`, `text-start`), `motion-reduce:transition-none` on animations.

### Client component — AddToCartButton (features tier)

```tsx
'use client';

import { useTransition } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { addToCart } from '@/actions/cart';

interface AddToCartButtonProps {
  productId: string;
  productName: string;
}

function AddToCartButton({ productId, productName }: AddToCartButtonProps) {
  const t = useTranslations('products');
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await addToCart(productId);
      if (!result.success) {
        // Error handling — toast or inline message
      }
    });
  }

  return (
    <Button
      onClick={handleClick}
      disabled={isPending}
      aria-label={t('cart.addAriaLabel', { product: productName })}
    >
      {isPending ? t('cart.adding') : t('cart.add')}
    </Button>
  );
}

export { AddToCartButton };
```

Note: `'use client'` required for event handlers and `useTransition`, `useTranslations` (client hook, synchronous) not `getTranslations`, server action imported from `@/actions/` and called inside transition, `aria-label` translated with interpolation. For accessibility patterns, see `references/accessibility.md`.
### next/image patterns

| Scenario | Pattern |
|----------|---------|
| Known dimensions | `<Image src={url} alt={alt} width={600} height={400} />` |
| Fill parent | `<Image src={url} alt={alt} fill sizes="..." className="object-cover" />` — parent must be `relative` |
| LCP hero image | Add `priority` — skips lazy loading |
| Blur placeholder | `placeholder="blur"` for local imports, `blurDataURL="..."` for remote |
| Responsive sizes | `sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"` — always set with `fill` |

### next/font setup

```tsx
// src/app/[locale]/layout.tsx
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',          // Prevents invisible text during load
  variable: '--font-inter', // Variable font — apply via Tailwind font-sans
});

export default function LocaleLayout({ children }: { children: React.ReactNode }) {
  return (
    <html className={inter.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
```

## When

### Server vs client decision tree

Add `'use client'` ONLY when the component uses: event handlers (`onClick`, `onChange`, `onSubmit`), React state hooks (`useState`, `useReducer`, `useTransition`, `useOptimistic`), effects or DOM refs (`useEffect`, `useRef` for DOM), browser APIs (`window`, `document`, `IntersectionObserver`), or `useTranslations()` (client hook). Otherwise keep as Server Component (no directive) and use `getTranslations()` for i18n.

**Default is server.** Push `'use client'` to the smallest leaf component — never on pages or layouts.

### State management decision tree

| Data type | Where it lives | Why |
|-----------|---------------|-----|
| Server data (products, users, content) | Server Component props via API client | No client state. Server Components render with fresh data. |
| URL state (filters, pagination, sort) | `searchParams` in Server Component, update via `<Link>` / `router.push()` | Shareable, bookmarkable, survives refresh. No `useState`. |
| Form input state | `useState` in `'use client'` leaf | Ephemeral, local to the form. |
| UI toggles (modal, accordion, menu) | `useState` in `'use client'` leaf | Ephemeral, local to the component. |
| Optimistic UI (pending mutations) | `useOptimistic` or `useActionState` | Temporary while Server Action completes. |
| Theme preference | Cookie — server-read, set via Server Action | Must be server-readable. See `references/page-checklist.md`. |
| Auth state | Server-side session via DAL | Never in client state. See `references/auth.md`. |

**What we do NOT use** — No Redux, no React Query / TanStack Query, no Zustand for server data. Server data belongs in Server Components. No Context API for data that should be props — prop drilling through Server Components has no re-render cost. Exception: Context is valid for app-wide client concerns (e.g., toast notifications).

**`useState` is correct for:** form inputs, UI toggles, animation state, debounced search input, temporary client-only state that does not survive navigation.

**`useState` is WRONG for:** API data (use Server Component), URL state like filters (use `searchParams`), auth/session (use server-side session), data multiple components need (pass as props from Server Component).

## Never

### Multi-component files

```tsx
// WRONG — two components in one file
export function ProductCard({ ... }) { ... }
export function ProductBadge({ ... }) { ... }

// RIGHT — one component per file
// product-card.tsx → export { ProductCard }
// product-badge.tsx → export { ProductBadge }
```

### useEffect for data fetching

```tsx
// WRONG — client-side fetch in useEffect
'use client';
function ProductList() {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    fetch('/api/products').then(r => r.json()).then(setProducts);
  }, []);
  return products.map(p => <div key={p.id}>{p.name}</div>);
}

// RIGHT — Server Component with API client
import { getProducts } from '@/lib/api/endpoints/products';
async function ProductList() {
  const products = await getProducts();
  return products.map(p => <div key={p.id}>{p.name}</div>);
}
export { ProductList };
```

### Hardcoded strings

```tsx
// WRONG — hardcoded user-visible text
<button>Add to Cart</button>
<p>No products found.</p>

// RIGHT — translated
<button>{t('cart.add')}</button>
<p>{t('products.empty')}</p>
```

### Physical CSS properties

```tsx
// WRONG — breaks in RTL locales
<div className="ml-4 mr-2 pl-3 text-left">

// RIGHT — logical properties, works LTR and RTL
<div className="ms-4 me-2 ps-3 text-start">
```

### Other anti-patterns

- **Max 150 lines per component file.** If larger, decompose into smaller components.
- **Never `../../` imports.** Use `@/` alias for all cross-directory imports.
- **Never `any` in props.** Define explicit TypeScript interfaces.
- **Never `'use client'` on pages or layouts.** Push to the smallest leaf component.
- **Never `useEffect` to sync state to URL.** Read `searchParams` directly in Server Components.
- **Never `<QueryClientProvider>` wrapping the app.** Server Components handle data fetching.
- **Never `createContext()` for per-page data.** Pass as props from Server Components.
- For accessibility patterns (ARIA, keyboard, focus management), see `references/accessibility.md`.
