# Folder Structure

## What

Next.js App Router uses filesystem-based routing under `src/app/`. Directories become URL segments. Special files (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`, `default.tsx`) define route behavior. Directories prefixed with `_` are private — ignored by the router. Directories wrapped in `()` are route groups — organize without adding URL segments. All routes live under `[locale]/` for multilingual support via next-intl.

## How

### Full `src/` tree

```
src/
├── app/
│   ├── [locale]/                          # All routes under locale — next-intl
│   │   ├── layout.tsx                     # Root locale layout — NextIntlClientProvider, theme script, fonts
│   │   ├── page.tsx                       # Homepage — /[locale]
│   │   ├── not-found.tsx                  # Locale-aware 404 page
│   │   ├── loading.tsx                    # Root loading skeleton
│   │   ├── error.tsx                      # Root error boundary ('use client')
│   │   │
│   │   ├── (marketing)/                   # Route group — shared marketing layout, no URL segment
│   │   │   ├── layout.tsx                 # Marketing-specific layout (nav + footer)
│   │   │   ├── about/
│   │   │   │   └── page.tsx               # /[locale]/about
│   │   │   └── pricing/
│   │   │       ├── page.tsx               # /[locale]/pricing
│   │   │       └── _components/           # Route-private components for pricing
│   │   │           └── pricing-table.tsx
│   │   │
│   │   ├── (app)/                         # Route group — authenticated app layout
│   │   │   ├── layout.tsx                 # App layout (sidebar + header)
│   │   │   ├── dashboard/
│   │   │   │   ├── page.tsx               # /[locale]/dashboard
│   │   │   │   ├── loading.tsx            # Dashboard skeleton
│   │   │   │   └── _components/           # Route-private — dashboard widgets
│   │   │   │       ├── stats-card.tsx
│   │   │   │       └── recent-activity.tsx
│   │   │   └── products/
│   │   │       ├── page.tsx               # /[locale]/products (list)
│   │   │       ├── [slug]/
│   │   │       │   ├── page.tsx           # /[locale]/products/[slug] (detail)
│   │   │       │   └── _components/
│   │   │       │       └── product-gallery.tsx
│   │   │       └── _components/
│   │   │           └── product-list-item.tsx
│   │   │
│   │   ├── (auth)/                        # Route group — login/register, minimal layout
│   │   │   ├── layout.tsx                 # Auth layout (centered card, no nav)
│   │   │   ├── login/
│   │   │   │   └── page.tsx               # /[locale]/login
│   │   │   └── register/
│   │   │       └── page.tsx               # /[locale]/register
│   │   │
│   │   └── @modal/                        # Parallel route slot for modals
│   │       ├── default.tsx                # REQUIRED — return null when no modal active
│   │       └── (.)products/[slug]/
│   │           └── page.tsx               # Intercepted product modal
│   │
│   ├── [...slug]/
│   │   └── md/
│   │       └── route.ts                   # Markdown mirror route handler
│   ├── sitemap.ts                         # Dynamic sitemap generation
│   ├── robots.ts                          # Robots.txt generation
│   ├── llms.txt/
│   │   └── route.ts                       # llms.txt route handler
│   ├── llms-full.txt/
│   │   └── route.ts                       # llms-full.txt route handler
│   ├── api/
│   │   ├── webhooks/
│   │   │   └── stripe/
│   │   │       └── route.ts               # Webhook handler — only valid use of route.ts
│   │   └── csp-report/
│   │       └── route.ts                   # CSP violation reporting endpoint
│   └── global-error.tsx                   # Catches errors in root layout
│
├── components/
│   ├── ui/                                # Tier 1 — primitives (Button, Input, Card, Badge)
│   │   ├── button.tsx                     # No business logic, no data fetching, no translations
│   │   ├── input.tsx                      # Props-only, purely presentational
│   │   └── card.tsx
│   └── features/                          # Tier 2 — feature components (ProductCard, UserAvatar)
│       ├── product-card.tsx               # Can use translations, can compose ui/ primitives
│       └── user-avatar.tsx                # No data fetching, no server actions
│
├── actions/                               # Server Actions — one file per domain
│   ├── products.ts                        # 'use server' at top, Zod-validated mutations
│   ├── auth.ts                            # Login, logout, register actions
│   └── theme.ts                           # setTheme action
│
├── lib/
│   ├── api/
│   │   ├── client.ts                      # apiFetch<T>() — base typed fetcher, import 'server-only'
│   │   └── endpoints/                     # One file per API domain
│   │       ├── products.ts                # getProduct(), getProducts(), etc.
│   │       └── users.ts                   # getUser(), getCurrentUser(), etc.
│   ├── auth/
│   │   ├── session.ts                     # Jose encryption, cookie read/write, import 'server-only'
│   │   └── dal.ts                         # verifySession(), authorization helpers, import 'server-only'
│   ├── validations/                       # Zod schemas — one file per domain
│   │   ├── products.ts                    # createProductSchema, updateProductSchema
│   │   └── auth.ts                        # loginSchema, registerSchema
│   ├── tracking/
│   │   ├── types.ts                       # Provider-agnostic event interface
│   │   ├── tracker.ts                     # Main tracking dispatch
│   │   └── providers/                     # Provider mappers (GA, PostHog)
│   │       └── ga.ts
│   ├── seo/
│   │   └── page-registry.ts              # Page entries for llms.txt, sitemap
│   └── logger.ts                          # Pino setup, import 'server-only'
│
├── hooks/                                 # Shared client hooks — only 'use client' utilities
│   └── use-debounce.ts
│
├── types/                                 # Shared TypeScript types/interfaces
│   ├── api.ts                             # ApiError, PaginatedResponse<T>, ActionResult<T>
│   └── product.ts                         # Product, ProductListItem, etc.
│
├── i18n/
│   ├── routing.ts                         # next-intl routing config (locales, defaultLocale)
│   └── request.ts                         # next-intl request config (locale detection, message loading)
│
├── proxy.ts                               # Replaces middleware.ts — auth, locale, rewrites, CSP
│
└── messages/                              # i18n message files
    ├── en/
    │   ├── common.json                    # Shared UI strings (buttons, labels, nav)
    │   ├── products.json                  # Product-related strings
    │   └── auth.json                      # Auth-related strings
    ├── ar/
    │   ├── common.json
    │   ├── products.json
    │   └── auth.json
    └── de/
        ├── common.json
        ├── products.json
        └── auth.json
```

### Component tiers

| Tier | Location | Can do | Cannot do |
|------|----------|--------|-----------|
| 1 -- primitives | `src/components/ui/` | Props-only, purely presentational | Business logic, data fetching, translations, server actions |
| 2 -- features | `src/components/features/` | Translations via `t()`, compose ui/ primitives | Data fetching, server actions |
| 3 -- route-specific | `src/app/*/_components/` | Everything (fetch, actions, translations, compose any tier) | Reuse outside its route |

Underscore prefix (`_components/`) makes the directory private to the router -- not a route segment.

### Promotion rules

| Trigger | Direction | Action |
|---------|-----------|--------|
| `_components/` component used in 2+ routes | `_components/` --> `features/` | Move file, update imports, verify it has no route-specific data fetching |
| `features/` component stripped of all business logic and translations | `features/` --> `ui/` | Remove translations, make props-only, update imports |
| `ui/` component gains translations or business logic | **Stop** -- it does not belong in `ui/` | Keep it in `features/` instead |

### Parallel route slots and `default.tsx`

Every `@slotname/` directory must contain a `default.tsx`. Without it, soft navigation fails and the build breaks.

```tsx
// src/app/[locale]/@modal/default.tsx — return null when no modal active
export default function ModalDefault() { return null; }

// Alternative: notFound() for hard-navigation 404 behavior
// export default function SlotDefault() { notFound(); }
```

### i18n message files

Pattern: `messages/{locale}/{namespace}.json`. One namespace per feature domain (`common`, `products`, `auth`, `dashboard`). Keys are flat within namespace using `section.element` convention. Create a new namespace when a page or feature exceeds 10 unique keys. Every key must exist in all locale files.

## When

**Where does this file go?**

```
Is it a Server Action (mutation)?
  └─ Yes → src/actions/{domain}.ts

Is it a Zod validation schema?
  └─ Yes → src/lib/validations/{domain}.ts

Is it an API endpoint wrapper?
  └─ Yes → src/lib/api/endpoints/{domain}.ts

Is it a shared TypeScript type?
  └─ Yes → src/types/{domain}.ts

Is it a route handler?
  └─ Is it for webhooks or revalidation?
       └─ Yes → src/app/api/{service}/route.ts
       └─ No  → Do NOT create a route handler. Use Server Actions or API client.

Is it a component?
  └─ Is it presentational with zero business logic?
       └─ Yes → src/components/ui/{name}.tsx
  └─ Does it use translations or compose primitives with feature logic?
       └─ Yes → src/components/features/{name}.tsx
  └─ Is it specific to one route?
       └─ Yes → src/app/[locale]/.../_components/{name}.tsx
```

**When to create a route group:** two or more sibling routes share a layout (e.g., `(marketing)/` with nav+footer, `(app)/` with sidebar), or auth pages need a distinct layout. Route groups add no URL segment.

## Never

- **Never co-locate Server Actions with pages.** Actions live in `src/actions/`, not next to `page.tsx`.
- **Never use barrel exports** (`index.ts` re-exports). They defeat tree-shaking and create circular dependencies.
- **Never put Zod schemas in action files.** Schemas go in `src/lib/validations/` so both actions and forms can import them without pulling in `'use server'` modules.
- **Never create route handlers for data fetching.** No `app/api/products/route.ts`. Use Server Components with the API client or Server Actions for mutations.
- **Never use relative imports beyond one level.** Always `@/` alias: `'@/components/ui/button'`, never `'../../../components/ui/button'`.
- **Never omit `default.tsx` from parallel route slots.** Build fails without it.
- **Never put `_components/` outside `src/app/`.** Shared components go in `src/components/`.
- **Never use PascalCase file names.** Files: `kebab-case.tsx`. Exports: `PascalCase`.
- **Never place a component in `ui/` if it uses `t()` or business logic.** It belongs in `features/`.
