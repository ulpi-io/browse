# Stack — Locked Decisions & Build Toolchain

Every other reference file assumes these decisions. Do not deviate.

## What

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 20.9+ | 18.x dropped in Next.js 16 |
| TypeScript | 5.1+ | Strict mode with `noUncheckedIndexedAccess` |
| React | 19.2 | Server Components, `useActionState`, `useOptimistic` |
| Next.js | 16 | App Router only. No Pages Router. |
| Bundler | Turbopack (default) | Opt out with `next dev --webpack` / `next build --webpack` |
| React Compiler | Stable | `reactCompiler: true` — promoted from experimental |
| Linter | ESLint flat config | `next lint` removed in v16 — run `eslint .` directly |
| i18n | next-intl | All visible strings via `t()` |

## How

### next.config.ts — complete template

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // --- Required ---
  reactCompiler: true,          // Stable in v16. Auto-memoizes components and hooks.
  cacheComponents: true,        // WITHOUT THIS, 'use cache' is silently ignored.

  // --- Turbopack (default in v16, no config needed) ---
  // Opt out: next dev --webpack, next build --webpack
  // experimental: { turbopackFileSystemCacheForDev: true },  // beta: faster cold starts

  // --- Images ---
  images: {
    remotePatterns: [
      // Add allowed remote image domains here
      // { protocol: 'https', hostname: 'cdn.example.com' },
    ],
  },

  // --- Security ---
  // serverActions: {
  //   allowedOrigins: ['my-app.com'],  // Only if behind a reverse proxy / CDN
  // },
  // experimental: {
  //   taint: true,  // Enable taintObjectReference / taintUniqueValue
  // },
};

export default nextConfig;
```

**Why `cacheComponents: true` matters:** Without this flag, any `'use cache'` directive in your
components and functions is silently ignored at runtime. The code compiles without error but
caching never activates. This is the single most common misconfiguration in Next.js 16.

### TypeScript — tsconfig.json strict settings

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,   // arr[0] is T | undefined, not T
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "es2017",
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`noUncheckedIndexedAccess` is non-negotiable. Without it, `params.slug` and `searchParams.page`
appear as `string` instead of `string | undefined`, hiding real bugs.

### ESLint — flat config (eslint.config.mjs)

```javascript
// eslint.config.mjs
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'import/no-duplicates': 'error',
    },
  },
];

export default eslintConfig;
```

`next lint` is removed in v16. Run ESLint directly:

```bash
npx eslint .
```

### Environment variables

| Prefix | Visibility | Example |
|---|---|---|
| `NEXT_PUBLIC_` | Bundled into client JS — visible to everyone | `NEXT_PUBLIC_API_URL` |
| _(none)_ | Server-only — Server Components, Server Actions, route handlers, proxy.ts | `API_SECRET_KEY` |

**Build-time inlining:** `process.env.VAR` is replaced at build time by default. If you need
a value that differs per deployment (staging vs production) without rebuilding:

```typescript
import { connection } from 'next/server';

async function getConfig() {
  await connection();  // Opts into dynamic rendering, reads env at runtime
  return process.env.API_URL;  // Now read at request time, not build time
}
```

**Rules:**
- Never prefix a secret with `NEXT_PUBLIC_` — it will be in the client bundle.
- Use `connection()` before reading `process.env` when the value must differ per environment at runtime.
- `.env.local` is gitignored (local secrets). `.env` is committed (non-secret defaults only).

### Build validation pipeline

Run in this order. Fail fast — do not continue if a step fails.

```bash
# 1. Lint
npx eslint .

# 2. Typecheck
npx tsc --noEmit

# 3. Build
npx next build

# 4. Test
npx vitest run
```

**Concurrent dev/build:** Dev and production use separate output directories (`.next/dev` for
dev) so `next dev` and `next build` can run in parallel without cache conflicts.

## When

### Turbopack vs Webpack

| Situation | Use |
|---|---|
| Default development and builds | Turbopack (no flag needed) |
| A dependency fails with Turbopack | `next dev --webpack` as a temporary workaround, file a bug |
| Custom webpack config (module federation, WASM loaders) | `--webpack` flag |
| CI builds | Turbopack (default) — faster builds |

### React Compiler — what it replaces

The React Compiler auto-memoizes components and hooks. With `reactCompiler: true`:
- Remove manual `useMemo`, `useCallback`, `React.memo` — the compiler handles this.
- Exception: keep `React.memo` on components that receive **non-primitive props** from
  third-party code the compiler cannot analyze.

### When to use `connection()`

| Scenario | Use `connection()`? |
|---|---|
| `NEXT_PUBLIC_` variable | No — inlined at build, available everywhere |
| Server secret that is the same across all deployments | No — build-time inlining is fine |
| Server secret that differs per environment (staging/prod) without rebuild | Yes |
| Reading cookies/headers (already dynamic) | No — already opted into dynamic rendering |

## Never

- **No `middleware.ts`** — use `proxy.ts` instead. Middleware is replaced in Next.js 16.
- **No Prisma, no ORM** — all data goes through the API client (`src/lib/api/`).
- **No `unstable_` prefixed APIs** — they have graduated or been removed. Use the stable equivalents.
- **No `next lint`** — removed in v16. Run `npx eslint .` directly.
- **No manual memoization** — the React Compiler handles `useMemo`/`useCallback`/`React.memo`. Remove existing instances.
- **No `cacheComponents` omission** — without `cacheComponents: true`, every `'use cache'` in the project is dead code.
- **No Node.js 18** — minimum is 20.9. CI and Dockerfiles must pin `node:20` or higher.
- **No `pages/` directory** — App Router only. No Pages Router, no `getServerSideProps`, no `getStaticProps`.
- **No inline fetch** — all data fetching goes through `src/lib/api/client.ts`. See `api-client-pattern.md`.
- **No hardcoded strings in JSX** — every user-visible string uses `t()`. See `i18n-conventions.md`.
- **No physical Tailwind properties** — use logical: `ps-`/`pe-` not `pl-`/`pr-`, `ms-`/`me-` not `ml-`/`mr-`, `text-start`/`text-end` not `text-left`/`text-right`.
