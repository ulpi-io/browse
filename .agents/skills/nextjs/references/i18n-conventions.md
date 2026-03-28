# i18n Conventions — next-intl, RTL, Message Files

## What

All user-visible strings come from translation files via `t()`. The app is multilingual-first: every page, component, and metadata function uses next-intl. API responses may return translated content — those are NOT duplicated in message files. Tailwind uses logical properties exclusively so layouts work LTR and RTL without CSS changes.

**RTL locales:** `ar` (Arabic), `he` (Hebrew), `fa` (Persian), `ur` (Urdu). When active, `<html>` gets `dir="rtl"` and all logical properties flip automatically.

## How

### Wiring — three config files

**`src/i18n/routing.ts`** — locale list, default locale, pathnames:

```typescript
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'es', 'ar'],
  defaultLocale: 'en',
});
```

**`src/i18n/request.ts`** — locale detection and message loading:

```typescript
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as any)) locale = routing.defaultLocale;

  const common = (await import(`@/messages/${locale}/common.json`)).default;
  const products = (await import(`@/messages/${locale}/products.json`)).default;
  const auth = (await import(`@/messages/${locale}/auth.json`)).default;

  return { locale, messages: { common, products, auth } };
});
```

**`src/app/[locale]/layout.tsx`** — provider wiring with RTL:

```typescript
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';

const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'];

export default async function LocaleLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as any)) notFound();

  const messages = await getMessages();
  const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir}>
      <body>
        <NextIntlClientProvider messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
```

`await params` is mandatory in Next.js 16 — sync access removed. `dir` on `<html>` makes every logical CSS property flip automatically for RTL locales.

### Message file structure

```
messages/
  en/
    common.json      # Shared: nav, footer, buttons, errors, theme labels
    products.json    # Product pages
    auth.json        # Login, register, password reset
    checkout.json    # Cart and checkout flow
  es/   common.json | products.json | auth.json | checkout.json  # Same files, translated values
  ar/   common.json | products.json | auth.json | checkout.json
```

Every locale has the same namespace files with identical keys. Missing files crash at runtime.

### Message file example — `messages/en/common.json`

```json
{
  "nav.home": "Home",
  "nav.products": "Products",
  "nav.account": "Account",
  "footer.copyright": "Copyright {year} {company}",
  "footer.privacy": "Privacy Policy",
  "button.submit": "Submit",
  "button.cancel": "Cancel",
  "button.loading": "Loading...",
  "error.generic": "Something went wrong. Please try again.",
  "error.notFound": "Page not found",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System"
}
```

### Key naming

Keys use `section.element` — flat within namespace, two levels max. Never deeper: `nav.main.desktop.home` is wrong. If a namespace grows too many sections, create a new namespace file.

### Server Components — getTranslations

```typescript
import { getTranslations } from 'next-intl/server';

async function ProductPage() {
  const t = await getTranslations('products');
  return (
    <main>
      <h1>{t('heading')}</h1>
      <p>{t('description')}</p>
    </main>
  );
}
```

Async — always `await`. Works in Server Components, `generateMetadata`, and Server Actions.

### Client Components — useTranslations

```typescript
'use client';
import { useTranslations } from 'next-intl';

function AddToCartButton() {
  const t = useTranslations('products');
  return <button>{t('cart.add')}</button>;
}
export { AddToCartButton };
```

`useTranslations` is a hook — synchronous, client-side. Requires `NextIntlClientProvider` in the tree.

### generateMetadata — translated metadata

```typescript
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';

export async function generateMetadata({
  params,
}: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'products' });
  return {
    title: t('meta.title'),
    description: t('meta.description'),
    alternates: {
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, `/${l}/products`])
      ),
    },
  };
}
```

Always pass `locale` explicitly inside `generateMetadata` — without it, metadata renders in the default language regardless of route locale.

### RTL — logical properties only

Every Tailwind class involving horizontal direction uses logical properties. Non-negotiable.

| Physical (WRONG) | Logical (RIGHT) |
|---|---|
| `pl-4` / `pr-4` | `ps-4` / `pe-4` |
| `ml-4` / `mr-4` | `ms-4` / `me-4` |
| `text-left` / `text-right` | `text-start` / `text-end` |
| `left-0` / `right-0` | `start-0` / `end-0` |
| `rounded-l-lg` / `rounded-r-lg` | `rounded-s-lg` / `rounded-e-lg` |
| `border-l` / `border-r` | `border-s` / `border-e` |
| `float-left` / `float-right` | `float-start` / `float-end` |
| `scroll-ml-4` / `scroll-mr-4` | `scroll-ms-4` / `scroll-me-4` |

### RTL — the `rtl:` variant

Use `rtl:` ONLY when logical properties are insufficient — primarily directional icons:

```tsx
<ChevronRightIcon className="h-5 w-5 rtl:rotate-180" />
<ArrowLeftIcon className="h-5 w-5 rtl:rotate-180" />
```

If you are writing `rtl:` on padding, margin, or text alignment, use the logical property instead.

### API content vs UI strings

| Source | Comes from | Example |
|--------|-----------|---------|
| UI strings | Message files via `t()` | Button labels, nav items, error messages, form labels |
| API content | Backend API response, already translated | Product names, descriptions, CMS content, user-generated content |

Never duplicate API content in message files. The backend returns translated content via `Accept-Language` header — render it directly. Only use `t()` for UI chrome.

## When

### New namespace vs extend existing

| Situation | Action |
|-----------|--------|
| Adding a button label, nav item, or generic error | Add to `common.json` |
| Adding text for a new feature page (e.g., checkout) | Create `checkout.json` |
| Adding text for a component in `features/` used across routes | Add to the namespace of its primary domain |
| A namespace file exceeds ~80 keys | Split into two namespaces |
| Text is specific to one route only | Use the domain namespace, not a route-specific namespace |

### Adding a new locale — checklist

1. **Create message files.** Copy every JSON from `messages/en/` to `messages/{new-locale}/`. Translate all values. Keys must match exactly.
2. **Update `routing.ts`.** Add the locale code to the `locales` array.
3. **Update `request.ts`.** Add the import for the new locale in the message-loading block.
4. **Check RTL.** If RTL locale (`ar`, `he`, `fa`, `ur`), verify it is in `RTL_LOCALES` in `[locale]/layout.tsx`.
5. **Hreflang and sitemap.** Both derive from `routing.locales` — no extra step if following seo.md patterns.
6. **Test.** Navigate to `/{new-locale}/` — verify translations load, RTL layout (if applicable), correct metadata language, no missing-key warnings in console.

### Server vs client translation API

| Context | API | Why |
|---------|-----|-----|
| Server Component | `const t = await getTranslations('ns')` | Async, runs on server, no client JS |
| Client Component | `const t = useTranslations('ns')` | Hook, synchronous, requires `NextIntlClientProvider` |
| `generateMetadata` | `const t = await getTranslations({ locale, namespace: 'ns' })` | Must pass locale explicitly |
| Server Action | `const t = await getTranslations('ns')` | Same as Server Component |

## Never

- **No hardcoded user-visible strings.** Every string the user sees comes from `t()` — including `aria-label`, `placeholder`, `title` attributes, alt text, and error messages.
- **No physical Tailwind properties.** `pl-`/`pr-`/`ml-`/`mr-`/`text-left`/`text-right`/`left-0`/`right-0`/`rounded-l-`/`rounded-r-`/`border-l`/`border-r` are forbidden. Use logical equivalents from the table above.
- **No nested keys beyond two levels.** `nav.home` is correct. `nav.main.home` is wrong. Split into new namespaces instead.
- **No API content in message files.** Backend returns translated content — render directly. Message files are for UI chrome only.
- **No missing locale files.** Every namespace JSON must exist for every locale. Missing file = runtime crash, not graceful fallback.
- **No `getTranslations()` in `generateMetadata` without explicit locale.** Always pass `{ locale, namespace }` — otherwise metadata renders in the default language.
- **No `rtl:` for padding, margin, or text alignment.** Use logical properties. `rtl:` is only for directional icons (`rtl:rotate-180`).
- **No `dir="rtl"` on individual elements.** Set `dir` once on `<html>`. All children inherit. Per-element `dir` causes inconsistent layout.
- **No implementation-describing keys.** `button.blueSubmit` is wrong. Keys describe content, not appearance: `button.submit`.
