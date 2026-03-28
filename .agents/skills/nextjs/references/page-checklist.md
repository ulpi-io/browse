# Page Checklist

Run through every item before writing a page file.

## What

Pages are async Server Components (`page.tsx` default export) with typed async props, required
`generateMetadata`, and companion loading/error/not-found files. Sync params/searchParams removed
in v16. Type helpers are globally available (no import):

```typescript
type Props = PageProps<'/[locale]/products/[slug]'>;
//   { params: Promise<{ locale: string; slug: string }>;
//     searchParams: Promise<{ [key: string]: string | string[] | undefined }> }
type LProps = LayoutProps<'/[locale]'>;
//   { params: Promise<{ locale: string }>; children: React.ReactNode }
```

## How

### 1. Async params and searchParams (gate item -- do this first)

```typescript
// src/app/[locale]/products/[slug]/page.tsx
import { getTranslations } from 'next-intl/server';
import { getProduct } from '@/lib/api/endpoints/products';
type Props = PageProps<'/[locale]/products/[slug]'>;

export default async function ProductPage({ params, searchParams }: Props) {
  const { locale, slug } = await params;       // MUST await
  const { tab } = await searchParams;          // MUST await
  const t = await getTranslations({ locale, namespace: 'products' });
  const product = await getProduct(slug, locale);
  return (
    <main>
      <h1>{product.name}</h1>
      <p>{t('detail.description')}</p>
    </main>
  );
}
```

The old sync pattern (`params.slug`) throws a runtime error in v16.
### 2. generateMetadata with i18n, OG, and hreflang

```typescript
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getProduct } from '@/lib/api/endpoints/products';
import { routing } from '@/i18n/routing';
type Props = PageProps<'/[locale]/products/[slug]'>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'products' });
  const product = await getProduct(slug, locale);
  const url = `https://example.com/${locale}/products/${slug}`;
  return {
    title: product.name,
    description: t('meta.description', { name: product.name }),
    keywords: [t('meta.keyword.product'), product.category],
    alternates: {
      canonical: url,
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, `https://example.com/${l}/products/${slug}`])
      ),
    },
    openGraph: {
      title: product.name,
      description: t('meta.description', { name: product.name }),
      url, siteName: t('common:meta.siteName'), locale, type: 'website',
      images: [{ url: product.ogImageUrl, width: 1200, height: 630, alt: product.name }],
    },
    twitter: {
      card: 'summary_large_image', title: product.name,
      description: t('meta.description', { name: product.name }),
      images: [product.ogImageUrl], site: '@example',
    },
  };
}
```

Every page must have `generateMetadata`. See `seo.md` for JSON-LD, `i18n-conventions.md` for translations.

### 3. loading.tsx (skeleton, not spinner)

```tsx
export default function ProductLoading() {
  return (
    <main>
      <div className="h-8 w-64 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="mt-4 space-y-3">
        <div className="h-4 w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      </div>
    </main>
  );
}
```

Skeletons match page layout shape, prevent layout shift. Include `dark:` variants.

### 4. error.tsx ('use client' REQUIRED)

```tsx
'use client';  // REQUIRED -- omitting is a build error
import { useTranslations } from 'next-intl';

export default function ProductError(
  { error, reset }: { error: Error & { digest?: string }; reset: () => void }
) {
  const t = useTranslations('common');
  return (
    <main role="alert">
      <h1>{t('error.title')}</h1>
      <p>{t('error.unexpected')}</p>
      <button onClick={reset}>{t('error.retry')}</button>
    </main>
  );
}
```

Never expose raw `error.message` to users. Log server-side (`error-handling.md`).
### 5. not-found.tsx for dynamic params

```tsx
import { getTranslations } from 'next-intl/server';

export default async function ProductNotFound() {
  const t = await getTranslations('products');
  return (<main><h1>{t('notFound.title')}</h1><p>{t('notFound.description')}</p></main>);
}
```

Trigger in the page: `if (!product) notFound();` -- renders nearest not-found.tsx.

### 6. Data fetching

All reads go through `src/lib/api/endpoints/`. Never inline `fetch()`, never ORM. See `api-client-pattern.md`.

### 7. Dark mode / theming (cookie-based, no flash)

Theme stored in a cookie, resolved before first paint. No localStorage, no useEffect.

**Root layout -- inline blocking script prevents FOUWT:**

```typescript
// src/app/[locale]/layout.tsx (relevant section)
import { cookies } from 'next/headers';

export default async function LocaleLayout({ children, params }: LProps) {
  const { locale } = await params;
  const theme = (await cookies()).get('theme')?.value ?? 'system';
  const themeScript = `(function(){
    var t=document.cookie.match(/theme=(\\w+)/)?.[1]||'system';
    var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme:dark)').matches);
    document.documentElement.classList.toggle('dark',d);
  })()`;
  return (
    <html lang={locale} className={theme !== 'system' ? (theme === 'dark' ? 'dark' : '') : ''}>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
```

Runs synchronously before paint -- no flash. Works with Tailwind `darkMode: 'class'`.

**Server Action for theme switching:**

```typescript
// src/actions/theme.ts
'use server';
import { cookies } from 'next/headers';

export async function setTheme(theme: 'light' | 'dark' | 'system') {
  (await cookies()).set('theme', theme, {
    httpOnly: false, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
  });
}
```

`httpOnly: false` because the blocking script reads `document.cookie` -- theme value is not
sensitive. All styles use `dark:` variants (`bg-white dark:bg-gray-950`). Theme toggle labels:
`t('common.theme.light')`, `t('common.theme.dark')`, `t('common.theme.system')`.

### 8. Remaining gates

- **Translation keys:** All visible strings use `t()`. Every key must exist in all locale files.
- **Semantic HTML:** One `<h1>` per page. Logical heading order. Use `<main>`, `<nav>`, `<aside>`, `<footer>`. Lists as `<ul>`/`<ol>`. See `accessibility.md`.
- **Max 300 lines:** Extract sections into `_components/` when exceeded.

## When

### Streaming: loading.tsx vs granular Suspense

| Page shape | Pattern |
|---|---|
| Entire page depends on one fetch | `loading.tsx` alone -- one Suspense boundary for the whole page |
| Independent sections at different speeds | Granular `<Suspense>` per section; `loading.tsx` for the initial shell |
| Mostly static with one slow widget | Wrap only the widget: `<Suspense fallback={<WidgetSkeleton />}>` |

```tsx
// Granular Suspense -- each section streams independently
export default async function ProductPage({ params }: Props) {
  const { locale, slug } = await params;
  return (
    <main>
      <Suspense fallback={<DetailsSkeleton />}>
        <ProductDetails slug={slug} locale={locale} />
      </Suspense>
      <Suspense fallback={<ReviewsSkeleton />}>
        <ProductReviews slug={slug} locale={locale} />
      </Suspense>
    </main>
  );
}
```

### not-found.tsx depth

| Route depth | Use case |
|---|---|
| `[locale]/not-found.tsx` | Generic 404 for unknown routes |
| `[locale]/products/[slug]/not-found.tsx` | Product-specific message |
| `[locale]/(app)/not-found.tsx` | Authenticated-area 404 with distinct layout |

### 'use client' in page-adjacent files

| File | Directive | Reason |
|---|---|---|
| `page.tsx`, `layout.tsx`, `loading.tsx`, `not-found.tsx` | None (Server Component) | Data fetching, metadata, async translations |
| `error.tsx` | `'use client'` **required** | Needs `reset()` callback, must catch client errors |
| `_components/*.tsx` | Only if interactive | Keep server default unless needs hooks/events |

## Never

- **Never access params/searchParams synchronously.** `params.slug` throws in v16. Always `await params`.
- **Never omit `generateMetadata`.** Invisible to search engines and social sharing without it.
- **Never use a spinner for loading.tsx.** Skeletons match layout shape. Spinners are for button states.
- **Never omit `'use client'` on error.tsx.** Build error. Error boundaries must be Client Components.
- **Never expose raw error messages to users.** Log server-side, show translated friendly messages.
- **Never use `useEffect` to detect theme.** Causes FOUWT. Use the cookie + blocking script pattern.
- **Never store theme in localStorage.** Not available server-side, guarantees flash on every load.
- **Never hardcode light-only colors.** Every `bg-*`, `text-*`, `border-*` needs a `dark:` variant.
- **Never inline `fetch()` in a page.** Use the API client. See `api-client-pattern.md`.
- **Never exceed 300 lines.** Extract to `_components/`.
- **Never hardcode visible strings.** All text uses `t()`. See `i18n-conventions.md`.
- **Never skip heading levels.** h1 then h3 without h2 breaks accessibility and SEO.
