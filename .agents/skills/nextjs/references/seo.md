# SEO, AEO & GEO — Search Optimization

## What

Every public page needs `generateMetadata` with full OG, Twitter, canonical, and hreflang tags. Structured data (JSON-LD) gets rich results. Sitemaps and robots.ts control crawling. AEO (Answer Engine Optimization) makes content extractable by AI search. GEO (Generative Engine Optimization) is implemented through JSON-LD structured data and markdown mirrors (see `references/machine-readable.md`). All visible strings use `t()`.

## How

### generateMetadata — complete pattern with i18n

```typescript
// src/app/[locale]/products/[slug]/page.tsx
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { getProduct } from '@/lib/api/endpoints/products';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

export async function generateMetadata({
  params,
}: { params: Promise<{ locale: string; slug: string }> }): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'products' });
  const product = await getProduct(slug);
  const url = `${BASE_URL}/${locale}/products/${slug}`;
  const ogImage = product.imageUrl ?? `${BASE_URL}/og-default.png`;

  return {
    title: product.name,
    description: t('meta.description', { name: product.name }),
    keywords: [t('meta.keyword.product'), product.category, product.brand].filter(Boolean),
    alternates: {
      canonical: url,
      languages: Object.fromEntries(
        routing.locales.map((l) => [l, `${BASE_URL}/${l}/products/${slug}`])
      ),
    },
    openGraph: {
      title: product.name,
      description: t('meta.description', { name: product.name }),
      url,
      siteName: t('meta.siteName'),
      locale,
      alternateLocale: routing.locales.filter((l) => l !== locale),
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: product.name }],
    },
    twitter: {
      card: 'summary_large_image',
      title: product.name,
      description: t('meta.description', { name: product.name }),
      images: [ogImage],
      site: '@yoursite',
      creator: '@yoursite',
    },
    robots: { index: true, follow: true },
  };
}
```

Always pass `locale` explicitly to `getTranslations({ locale, namespace })` inside `generateMetadata` — without it, metadata renders in the default language regardless of route locale.

**Twitter card type:** use `summary_large_image` when `og:image` is present and at least 300x157px (the default). Use `summary` only when no image or image is small.

**Per-page robots:** set `robots: { index: false, follow: false }` on `/[locale]/(auth)/*` pages and admin pages.

### JSON-LD structured data — Product + BreadcrumbList

Generate JSON-LD in the page component body. Co-locate schema generation with the page.

```tsx
// In the page component's return — same file as generateMetadata above
const productSchema = {
  '@context': 'https://schema.org', '@type': 'Product',
  name: product.name, description: product.description,
  image: product.imageUrl, url: `${BASE_URL}/${locale}/products/${slug}`,
  brand: { '@type': 'Brand', name: product.brand },
  offers: {
    '@type': 'Offer', price: product.price, priceCurrency: product.currency,
    availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
  },
};
const breadcrumbSchema = {
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: t('breadcrumb.home'), item: `${BASE_URL}/${locale}` },
    { '@type': 'ListItem', position: 2, name: t('breadcrumb.products'), item: `${BASE_URL}/${locale}/products` },
    { '@type': 'ListItem', position: 3, name: product.name },
  ],
};
return (
  <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productSchema) }} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
    <main><h1>{product.name}</h1></main>
  </>
);
```

### JSON-LD schema types

| Schema | Page type | Required fields |
|--------|-----------|-----------------|
| `Product` | Product detail | `name`, `description`, `image`, `offers` (price, currency, availability) |
| `Article` | Blog, news, content | `headline`, `author`, `datePublished`, `dateModified`, `image` |
| `FAQ` | FAQ page or section | `mainEntity` array of `Question` + `acceptedAnswer` |
| `BreadcrumbList` | Every page with breadcrumbs | `itemListElement` with position, name, item URL |
| `Organization` | Homepage / about | `name`, `url`, `logo`, `sameAs` (social links) |
| `WebSite` + `SearchAction` | Homepage | `name`, `url`, `potentialAction` with target URL template |

### Article schema — GEO fields

```typescript
const articleSchema = {
  '@context': 'https://schema.org', '@type': 'Article',
  headline: article.title, description: article.excerpt, image: article.imageUrl,
  author: { '@type': 'Person', name: article.authorName, url: article.authorUrl },
  datePublished: article.publishedAt, dateModified: article.updatedAt,
  publisher: { '@type': 'Organization', name: t('meta.siteName'),
    logo: { '@type': 'ImageObject', url: `${BASE_URL}/logo.png` } },
};
```

Render visible author bylines with semantic `<time>` elements in the page body:

```tsx
<p>{t('article.by', { author: article.authorName })}</p>
<time dateTime={article.publishedAt}>
  {new Intl.DateTimeFormat(locale).format(new Date(article.publishedAt))}
</time>
```

### FAQ schema — AEO pattern

FAQ schema is the highest-impact AEO pattern. AI search extracts question/answer pairs directly:

```typescript
const faqSchema = {
  '@context': 'https://schema.org', '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question', name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
};
```

### Sitemap — `app/sitemap.ts`

```typescript
import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { getAllProducts } from '@/lib/api/endpoints/products';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

export async function generateSitemaps() {
  return [{ id: 0 }, { id: 1 }]; // split by content type
}

export default async function sitemap({ id }: { id: number }): Promise<MetadataRoute.Sitemap> {
  const products = await getAllProducts();
  return products.flatMap((p) =>
    routing.locales.map((locale) => ({
      url: `${BASE_URL}/${locale}/products/${p.slug}`,
      lastModified: new Date(p.updatedAt),
      changeFrequency: 'weekly' as const,
      priority: 0.6,
      alternates: {
        languages: Object.fromEntries(
          routing.locales.map((l) => [l, `${BASE_URL}/${l}/products/${p.slug}`])
        ),
      },
    }))
  );
}
```

Every entry includes `lastModified`, `changeFrequency` (`'daily'` for homepage, `'weekly'` for catalog, `'monthly'` for static), `priority` (1.0 homepage, 0.8 main pages, 0.6 detail pages), and `alternates.languages` for hreflang. Include `.md` URLs as separate entries when markdown mirrors are active (see `references/machine-readable.md`).

### robots.ts — `app/robots.ts`

```typescript
import type { MetadataRoute } from 'next';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL!;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/',
        disallow: ['/api/*', '/*/login', '/*/register', '/*/password-reset', '/*/admin/*'] },
      { userAgent: 'GPTBot', allow: ['/', '/*.md'] },
      { userAgent: 'ClaudeBot', allow: ['/', '/*.md'] },
      { userAgent: 'PerplexityBot', allow: ['/', '/*.md'] },
      { userAgent: 'CCBot', allow: ['/', '/*.md'] },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
```

AI crawlers explicitly allowed — we want AI indexing. Markdown mirrors (`references/machine-readable.md`) provide clean content for generative engines.

### AEO content patterns

1. **Single H1 per page** — the primary topic the page answers.
2. **Heading hierarchy** — H1 > H2 > H3, never skip levels. Each H2 is independently extractable.
3. **Answer-first paragraphs** — lead with the answer, then elaborate. AI search shows the first sentence.
4. **Concise paragraphs** — 2-3 sentences max. AI search quotes short blocks.
5. **Visible author bylines** — `<time datetime>` elements for dates. AI search shows attribution.

### GEO implementation

GEO is three concrete patterns, not buzzwords: (1) JSON-LD structured data (this file) with Article `author`/`datePublished`/`dateModified` for generative engine attribution, (2) markdown mirrors (`references/machine-readable.md`) providing clean parseable content at every URL, and (3) `<time>` elements for semantic date markup generative engines parse for freshness.

## When

### generateMetadata decision tree

| Page type | OG image | JSON-LD | robots |
|-----------|----------|---------|--------|
| Public product | Product image | Product + BreadcrumbList | index, follow |
| Public article | Article image | Article + BreadcrumbList | index, follow |
| FAQ page | Default OG | FAQPage + BreadcrumbList | index, follow |
| Homepage | Default OG | Organization + WebSite + SearchAction | index, follow |
| Login / register | None | None | **noindex, nofollow** |
| Admin pages | None | None | **noindex, nofollow** |

Validate JSON-LD with [Google Rich Results Test](https://search.google.com/test/rich-results) before merging any page with new structured data.

### Sitemap split strategy

| Site size | Strategy |
|-----------|----------|
| Under 5,000 URLs | Single sitemap, no `generateSitemaps` needed |
| 5,000-50,000 URLs | Split by content type (`{ id: 0 }` pages, `{ id: 1 }` articles) |
| Over 50,000 URLs | Split by content type AND pagination within each type |

## Never

- **No page without `generateMetadata`.** Every page needs title, description, OG, canonical, and hreflang.
- **No `generateMetadata` without explicit locale in `getTranslations()`.** Always pass `{ locale, namespace }` — otherwise metadata renders in the default language for non-default locales.
- **No hardcoded OG image URL.** Dynamic per-page images. Fall back to a default OG image, not a missing image.
- **No missing hreflang alternates.** Every locale variant must link to every other via `alternates.languages`. Missing hreflang causes duplicate content penalties.
- **No missing canonical URL.** Self-referencing canonical on every page. Without it, search engines pick the wrong URL.
- **No Article schema without `author`, `datePublished`, `dateModified`.** Required for rich results and GEO attribution.
- **No JSON-LD in separate utility files.** Co-locate schema generation with the page component. Schema depends on page-specific data.
- **No blocking `.md` URLs in robots.txt.** AI crawlers need markdown mirror access. Allow `/*.md` for all AI User-Agents.
- **No FAQ schema on pages without visible FAQ content.** Schema must match visible content. Hidden schema triggers manual action penalties.
- **No hardcoded strings in metadata.** All visible metadata values use `t()` — title templates, descriptions, breadcrumb labels, site name.
