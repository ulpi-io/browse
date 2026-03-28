# Machine-Readable Content — Markdown Mirrors, llms.txt & Content Negotiation

## What

Every public page has a markdown counterpart. AI agents, generative engines, and CLI tools get clean markdown instead of parsing HTML. Three components:

1. **Markdown mirrors** — `.md` URL for every public HTML page, returning content as clean markdown.
2. **llms.txt** — index of all public pages with titles and one-line descriptions, linking to `.md` URLs.
3. **llms-full.txt** — concatenated markdown of every public page in a single response.

### Two access methods — both handled by proxy.ts (NOT next.config.ts rewrites)

**Method 1 — `.md` URL suffix:**
1. Request to `example.com/en/products/widget.md`
2. `proxy.ts` detects `.md` suffix, strips it, rewrites to `/en/products/widget/md`
3. Route handler at `app/[...slug]/md/route.ts` calls `generateMarkdown(locale)`
4. Returns `Content-Type: text/markdown; charset=utf-8` with `Vary: Accept`

**Method 2 — `Accept: text/markdown` header:**
1. Request to `example.com/en/products/widget` with `Accept: text/markdown`
2. `proxy.ts` detects `text/markdown` in Accept header, rewrites to `/en/products/widget/md`
3. Same route handler runs, same flow

### `generateMarkdown()` signature

```typescript
async function generateMarkdown(locale: string): Promise<string>
```

Co-located with the page at `src/app/[locale]/products/[slug]/_lib/markdown.ts`. Calls the same data-fetching function as the HTML page. Returns clean markdown — no navigation chrome, no component markup.

### Page registry — `src/lib/seo/page-registry.ts`

```typescript
export interface PageEntry {
  path: string;           // URL pattern: '/products/[slug]'
  title: string;          // Human-readable: 'Product Detail'
  description: string;    // One-line summary for llms.txt
  namespace: string;      // i18n namespace for translations
}

export const pageRegistry: PageEntry[] = [
  { path: '/', title: 'Home', description: 'Main landing page', namespace: 'home' },
  { path: '/products', title: 'Products', description: 'Product catalog with filtering', namespace: 'products' },
  { path: '/products/[slug]', title: 'Product Detail', description: 'Individual product page', namespace: 'products' },
];
```

**Sync strategy:** manually maintained, validated at build time — missing entries produce a build warning. Used by llms.txt, llms-full.txt, and sitemap.ts (see `references/seo.md`).

### Caching

All markdown route handlers use `'use cache'` + `cacheLife('days')` + `cacheTag('content')`. Invalidate on content changes via `revalidateTag('content', 'days')`.

## How

### proxy.ts — markdown mirror routing

Add before the auth check in `proxy.ts` (see `references/routing.md` for the full proxy pattern):

```typescript
// src/proxy.ts — markdown mirror routing block
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const accept = request.headers.get('Accept') ?? '';

  // Method 1: .md suffix → strip suffix, rewrite to /md route handler
  if (pathname.endsWith('.md') && !pathname.startsWith('/api/')) {
    const url = request.nextUrl.clone();
    url.pathname = `${pathname.slice(0, -3)}/md`;
    return NextResponse.rewrite(url);
  }

  // Method 2: Accept: text/markdown → rewrite to /md route handler
  if (accept.includes('text/markdown') && !pathname.startsWith('/api/') && !pathname.endsWith('/md')) {
    const url = request.nextUrl.clone();
    url.pathname = `${pathname}/md`;
    return NextResponse.rewrite(url);
  }

  // ... locale detection, auth check, security headers (see routing.md, security.md)
  return NextResponse.next();
}
```

### Route handler — `app/[...slug]/md/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { cacheLife, cacheTag } from 'next/cache';
import { pageRegistry } from '@/lib/seo/page-registry';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  'use cache';
  cacheLife('days');
  cacheTag('content');

  const { slug } = await params;
  const segments = slug.filter((s) => s !== 'md'); // strip trailing 'md'
  const locale = segments[0] ?? 'en';
  const pagePath = '/' + segments.slice(1).join('/');

  const entry = resolveRegistryEntry(pagePath);
  if (!entry) return new NextResponse('Not found', { status: 404 });

  const { generateMarkdown } = await entry.loader();
  const markdown = await generateMarkdown(locale);

  return new NextResponse(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Vary': 'Accept',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    },
  });
}

function resolveRegistryEntry(pagePath: string) {
  return pageRegistry.find((entry) => {
    const pattern = entry.path.replace(/\[[\w.]+\]/g, '[^/]+');
    return new RegExp(`^${pattern}$`).test(pagePath) || entry.path === pagePath;
  });
}
```

### `generateMarkdown` — product page example

```typescript
// src/app/[locale]/products/[slug]/_lib/markdown.ts
import 'server-only';
import { getTranslations } from 'next-intl/server';
import { getProduct } from '@/lib/api/endpoints/products';
import { formatPrice } from '@/lib/utils/format';

export async function generateMarkdown(locale: string): Promise<string> {
  const t = await getTranslations({ locale, namespace: 'products' });
  const product = await getProduct(slug);

  const lines: string[] = [
    `# ${product.name}`,
    '',
    product.description,
    '',
    `## ${t('detail.specifications')}`,
    '',
    `- **${t('detail.price')}:** ${formatPrice(product.price, product.currency)}`,
    `- **${t('detail.category')}:** ${product.category}`,
    `- **${t('detail.availability')}:** ${product.inStock ? t('detail.inStock') : t('detail.outOfStock')}`,
  ];

  if (product.features.length > 0) {
    lines.push('', `## ${t('detail.features')}`, '');
    for (const feature of product.features) lines.push(`- ${feature}`);
  }

  lines.push('', '---', '', `[${t('nav.allProducts')}](/${locale}/products) | [${t('nav.home')}](/${locale})`);
  return lines.join('\n');
}
```

Same `getProduct()` call as the HTML page. All heading labels use `t()`. Output is clean markdown with internal links — no HTML tags, no navigation chrome.

### llms.txt route handler

```typescript
// app/llms.txt/route.ts
import { NextResponse } from 'next/server';
import { cacheLife, cacheTag } from 'next/cache';
import { pageRegistry } from '@/lib/seo/page-registry';

const SITE_NAME = 'Acme Store';
const SITE_DESCRIPTION = 'E-commerce platform for premium widgets';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

export async function GET() {
  'use cache';
  cacheLife('days');
  cacheTag('content');

  const lines: string[] = [`# ${SITE_NAME}`, `> ${SITE_DESCRIPTION}`, '', '## Docs'];
  for (const entry of pageRegistry) {
    if (!entry.path.includes('[')) {
      lines.push(`- [${entry.title}](${BASE_URL}${entry.path}.md): ${entry.description}`);
    }
  }
  lines.push('', '## Optional', `- [Full content](${BASE_URL}/llms-full.txt): Complete content dump`);

  return new NextResponse(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' },
  });
}
```

**llms.txt exact format:**
```
# Site Name
> Brief site description in default locale

## Docs
- [Page Title](https://example.com/page.md): One-line description
- [Page Title](https://example.com/other-page.md): One-line description

## Optional
- [Full content](https://example.com/llms-full.txt): Complete content dump
```

### llms-full.txt — `app/llms-full.txt/route.ts`

Same structure as llms.txt handler. Iterates `pageRegistry` (skipping dynamic patterns), calls each page's `generateMarkdown('en')`, concatenates all output separated by `\n\n---\n\n` with `<!-- url: ${BASE_URL}${entry.path} -->` as header above each section. Same caching: `'use cache'` + `cacheLife('days')` + `cacheTag('content')`. Returns `Content-Type: text/plain; charset=utf-8`.

## When

| Scenario | Implementation |
|----------|---------------|
| Adding a new public page | Add `PageEntry` to registry, co-locate `generateMarkdown` in `_lib/markdown.ts` |
| Dynamic pages (product, article) | `generateMarkdown` fetches from same endpoint as HTML page |
| Static pages (about, legal) | `generateMarkdown` returns hardcoded markdown with `t()` for headings |
| Content update | `revalidateTag('content', 'days')` invalidates mirrors, llms.txt, llms-full.txt |
| Testing markdown output | `curl -H 'Accept: text/markdown' https://example.com/en/products` or `curl https://example.com/en/products.md` |
| Sitemap integration | See `references/seo.md` — sitemap includes `.md` URLs as alternates |

**New page checklist:** 1. Create `page.tsx` + `_lib/markdown.ts`  2. Implement `generateMarkdown(locale)` using same data-fetching function  3. Add `PageEntry` to `src/lib/seo/page-registry.ts`  4. Build and verify no missing-entry warning  5. Test with `curl`

**Cross-references:** `seo.md` (metadata, structured data, sitemaps, robots.ts AI crawler rules), `routing.md` (full proxy.ts pattern), `caching-strategy.md` (`'use cache'` + `cacheLife` + `cacheTag`), `i18n-conventions.md` (`getTranslations()` in `generateMarkdown`)

## Never

- **No `next.config.ts` rewrites for markdown routing** — all request interception goes through `proxy.ts`. Config rewrites cannot inspect Accept headers or apply conditional logic.
- **No navigation chrome in markdown output** — `generateMarkdown` returns content only. No headers, footers, sidebars, breadcrumbs, or component markup.
- **No HTML tags in markdown output** — standard markdown only. No `<div>`, no `<span>`, no JSX. Links use `[text](url)` format.
- **No skipping the page registry** — every public page needs an entry in `src/lib/seo/page-registry.ts`. Missing entries mean `llms.txt` is incomplete.
- **No hardcoded strings in `generateMarkdown`** — all heading labels use `t()`. Content from the API comes through data fetching.
- **No separate data fetching** — `generateMarkdown` calls the same endpoint functions as the HTML page. Do not duplicate fetch logic.
- **No blocking AI crawlers** — `robots.ts` must allow `GPTBot`, `ClaudeBot`, `PerplexityBot`, `CCBot` on `*.md` URLs (see `references/seo.md`).
- **No missing `Vary: Accept` header** — route handler must set `Vary: Accept` so CDNs cache HTML and markdown responses separately.
- **No forgetting `cacheTag('content')`** — without the tag, content updates cannot invalidate markdown mirrors, llms.txt, or llms-full.txt.
