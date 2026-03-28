# Routing — Navigation, Dynamic Routes & proxy.ts

## What

Next.js 16 App Router uses filesystem-based routing. Directories under `src/app/` become URL segments. Navigation uses `<Link>` (server and client) or `useRouter` (client only). Server-side redirects use `redirect()` / `permanentRedirect()`. Route protection, locale detection, and rewrites live in `proxy.ts` (replaces `middleware.ts`), which runs on the Node.js runtime — not Edge.

### Route segment conventions

| Pattern | Example URL | Params |
|---|---|---|
| `[slug]` | `/products/widget` | `{ slug: 'widget' }` |
| `[...slug]` | `/docs/a/b/c` | `{ slug: ['a','b','c'] }` — 404 on `/docs` |
| `[[...slug]]` | `/docs` or `/docs/a/b` | `{ slug: undefined }` or `{ slug: ['a','b'] }` |
| `(group)` | no URL segment | Layout sharing without affecting the URL |
| `@slot` | no URL segment | Parallel route — rendered alongside siblings |
| `(.)segment` | intercepts same-level | Intercepting route for modals |

### Key APIs

- **`<Link>`** — extends `<a>` with prefetching and client-side navigation. Prefetches when link enters viewport.
- **`useRouter()`** — client-only. `push()`, `replace()`, `refresh()`, `back()`, `forward()`, `prefetch()`.
- **`redirect(url)`** — server-side, throws internally (307 temporary). Use in Server Components, actions, route handlers.
- **`permanentRedirect(url)`** — 308 permanent. Use when a URL has moved forever.
- **`generateStaticParams()`** — pre-render specific dynamic route paths at build time.
- **View Transitions (React 19.2)** — opt-in animated transitions via `<ViewTransition>` wrapper.

## How

### Link component

```tsx
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function Navigation() {
  const t = useTranslations('common');
  return (
    <nav>
      <Link href="/en/products">{t('nav.products')}</Link>
      <Link href="/en/legal/terms" prefetch={false}>{t('nav.terms')}</Link>
      <Link href="/en/dashboard" replace>{t('nav.dashboard')}</Link>
      <Link href="/en/products?page=2" scroll={false}>{t('nav.nextPage')}</Link>
    </nav>
  );
}
```

**Prefetching:** default prefetches static routes fully, dynamic routes up to nearest `loading.tsx`. `prefetch={true}` forces full. `prefetch={false}` disables for low-traffic links. **Scroll:** default scrolls to top. `scroll={false}` preserves position (pagination, tabs, filters).

### useRouter — client-side navigation

```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function SearchForm() {
  const router = useRouter();
  const t = useTranslations('search');

  function handleSearch(query: string) {
    router.push(`/en/products?q=${encodeURIComponent(query)}`);
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); handleSearch(new FormData(e.currentTarget).get('q') as string); }}>
      <input name="q" placeholder={t('placeholder')} />
      <button type="submit">{t('submit')}</button>
      <button type="button" onClick={() => router.replace('/en/products')}>{t('reset')}</button>
    </form>
  );
}
```

Prefer `<Link>` for all click-based navigation. Use `useRouter` only for programmatic triggers (form submit, keyboard shortcut, post-mutation redirect).

### View Transitions (React 19.2)

```tsx
import { unstable_ViewTransition as ViewTransition } from 'react';

export function PageWrapper({ children }: { children: React.ReactNode }) {
  return <ViewTransition>{children}</ViewTransition>;
}
```

Programmatic: `router.push('/en/products/widget', { viewTransition: true })`.

CSS (`globals.css`) — always respect reduced motion:

```css
::view-transition-old(root) { animation: fade-out 150ms ease-out; }
::view-transition-new(root) { animation: fade-in 150ms ease-in; }
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
}
```

### Dynamic routes and generateStaticParams

```tsx
// src/app/[locale]/products/[slug]/page.tsx
import type { PageProps } from 'next';
import { getProduct } from '@/lib/api/endpoints/products';
import { getTranslations } from 'next-intl/server';

export async function generateStaticParams() {
  return [{ slug: 'widget-pro' }, { slug: 'widget-lite' }];
}

export default async function ProductPage({ params }: PageProps<'/[locale]/products/[slug]'>) {
  const { locale, slug } = await params;  // ALWAYS await — sync removed in v16
  const t = await getTranslations({ locale, namespace: 'products' });
  const product = await getProduct(slug);
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{t('detail.description')}</p>
    </main>
  );
}
```

### Parallel routes

Render multiple pages simultaneously in one layout via `@slot` directories. Every slot **must** have a `default.tsx` — without it, soft navigation fails and the build breaks.

```
dashboard/
├── layout.tsx           # Receives { children, analytics, activity }
├── page.tsx             # Main content → {children}
├── @analytics/
│   ├── default.tsx      # REQUIRED — return null
│   └── page.tsx
└── @activity/
    ├── default.tsx      # REQUIRED — return null
    └── page.tsx
```

The layout receives each `@slot` as a named prop alongside `children`.

### Intercepting routes

Show a route in a different context (modal) on soft nav, preserving the full page on hard nav. Conventions: `(.)` same level, `(..)` one up, `(...)` app root, `(..)(..)` two up. Product modal pattern (see `folder-structure.md`):

```
src/app/[locale]/
├── @modal/
│   ├── default.tsx                 # return null
│   └── (.)products/[slug]/page.tsx # Modal on soft nav
└── (app)/products/[slug]/page.tsx  # Full page on hard nav
```

### Route groups

Directory name in `()` shares a layout without adding a URL segment. Use for layout boundaries: `(marketing)/` with nav+footer, `(app)/` with sidebar, `(auth)/` with centered card. Each group can have its own `layout.tsx`, `loading.tsx`, `error.tsx`.

### proxy.ts — full pattern

```typescript
// src/proxy.ts
import { NextRequest, NextResponse } from 'next/server';
import { routing } from '@/i18n/routing';

const PUBLIC_PATHS = ['/', '/login', '/register', '/about', '/pricing'];
const DEFAULT_LOCALE = routing.defaultLocale; // 'en'
const LOCALES = routing.locales;              // ['en', 'ar', 'de']

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const locale = detectLocale(request);

  // Markdown mirror routing (see machine-readable.md, seo.md)
  // .md suffix or Accept: text/markdown → rewrite to /[...slug]/md handler

  // Auth check — optimistic only, real auth is in DAL (see auth.md)
  const sessionCookie = request.cookies.get('session')?.value;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === `/${locale}${p}` || pathname === `/${locale}`
  );
  if (!sessionCookie && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = `/${locale}/login`;
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Security headers set here (see security.md for CSP nonce, HSTS)
  return NextResponse.next();
}

function detectLocale(request: NextRequest): string {
  // 1. URL path prefix — user explicitly chose this locale
  const pathLocale = LOCALES.find(
    (l) => request.nextUrl.pathname.startsWith(`/${l}/`) || request.nextUrl.pathname === `/${l}`
  );
  if (pathLocale) return pathLocale;
  // 2. Cookie — persisted preference from language switcher
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value;
  if (cookieLocale && LOCALES.includes(cookieLocale)) return cookieLocale;
  // 3. Accept-Language — browser preference for first-time visitors
  const acceptLang = request.headers.get('Accept-Language') ?? '';
  const preferred = acceptLang.split(',')
    .map((part) => part.split(';')[0]?.trim().substring(0, 2))
    .find((code) => code && LOCALES.includes(code));
  return preferred ?? DEFAULT_LOCALE;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)).*)',],
};
```

**Additional proxy.ts responsibilities** (documented in owning files):
- **Markdown mirrors** — `.md` suffix and `Accept: text/markdown` content negotiation. See `machine-readable.md`.
- **CSP nonce and secure headers** — See `security.md`.

## When

| Scenario | Use |
|---|---|
| Clickable navigation (nav, cards, breadcrumbs) | `<Link>` |
| Programmatic navigation (form submit, post-mutation) | `useRouter().push()` |
| Server-side redirect (auth, moved content) | `redirect()` |
| Permanent URL change (slug renamed, old route gone) | `permanentRedirect()` |
| Re-fetch server data without navigation | `useRouter().refresh()` |
| Single URL param | `[slug]` |
| Variable-depth, at least one segment required | `[...slug]` |
| Variable-depth, root also valid | `[[...slug]]` |
| Independent sections that load/error independently | Parallel routes (`@slot`) |
| Shared chrome around child pages | Nested `layout.tsx` |
| Modal overlay preserving background | Parallel route + intercepting route |
| Different layouts without URL segments | Route groups: `(marketing)/`, `(app)/`, `(auth)/` |
| Pre-render known slugs at build time | `generateStaticParams()` |

## Never

- **No `middleware.ts`** — replaced by `proxy.ts` in Next.js 16. Runs on Node.js, not Edge.
- **No sync params** — `params` and `searchParams` are async in v16. Always `await params`. Sync access is removed.
- **No `useRouter` from `next/router`** — use `next/navigation`. The Pages Router import does not exist in App Router.
- **No `useRouter` in Server Components** — client-only hook. Use `redirect()` for server-side navigation.
- **No `@slot/` without `default.tsx`** — build breaks. Return `null` or call `notFound()`.
- **No `router.push()` for simple links** — `<Link>` prefetches, is accessible, works without JS.
- **No `getStaticPaths`** — removed. Use `generateStaticParams`.
- **No route handlers for client data fetching** — use Server Components with the API client.
- **No `next.config.ts` rewrites for request interception** — all goes through `proxy.ts`. See `machine-readable.md`.
- **No hardcoded strings in navigation** — every visible string uses `t()`.
