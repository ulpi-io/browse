---
name: nextjs
version: 1.0.0
description: |
  Next.js 16 App Router reference — Cache Components, proxy.ts, API-backed data layer,
  multilingual-first with next-intl, atomic components, structured logging, analytics tracking.
  Use when working on any Next.js page, component, route, layout, data fetching, caching,
  i18n, testing, or metadata task.
allowed-tools:
  - Bash
  - Read
---

<EXTREMELY-IMPORTANT>
These rules apply to ALL Next.js code you write. Violating any of them produces broken, unmaintainable, or inaccessible output.

1. **No raw strings in JSX.** Every user-visible string must use `t()` from next-intl. No hardcoded text.
2. **No oversized files.** Components: 150 lines max. Pages: 300 lines max. Extract to `_components/` or `features/` if larger.
3. **No page without `generateMetadata` + OG.** Every page exports `generateMetadata` with title, description, OG image, hreflang alternates.
4. **No inline fetch.** All data fetching goes through `src/lib/api/` client. Never call `fetch()` directly. Never use an ORM.
5. **No `'use client'` on pages or layouts.** Only leaf components in `components/ui/`, `components/features/`, or `_components/` may be client components.
6. **All params/searchParams/cookies/headers are async.** Always `await params`, `await searchParams`, `await cookies()`, `await headers()`. Sync access is removed in v16.
</EXTREMELY-IMPORTANT>

# Next.js 16 App Router

## MANDATORY FIRST RESPONSE PROTOCOL

Before writing ANY code, you **MUST** complete this checklist:

1. Read `references/stack.md` to understand locked decisions (runtime, bundler, config)
2. Identify the task type from the routing table below
3. Read the matching reference file(s) — they contain the patterns, code examples, and anti-patterns
4. Only then begin implementation

**Writing code without reading the reference = wrong patterns, wasted time, rework.**

## Routing Table

| Task | Read |
|------|------|
| Starting a session / understanding the stack | `references/stack.md` |
| Creating or modifying files, folder conventions | `references/folder-structure.md` |
| Navigation, dynamic routes, proxy.ts, parallel routes | `references/routing.md` |
| Creating a new page or layout | `references/page-checklist.md` |
| Creating or editing a component | `references/component-anatomy.md` |
| Adding data fetching (reads) | `references/api-client-pattern.md` |
| Adding mutations (writes), forms | `references/server-actions.md` |
| Making caching decisions | `references/caching-strategy.md` |
| Adding/editing user-facing text, translations, or RTL | `references/i18n-conventions.md` |
| Error boundaries, recovery, not-found | `references/error-handling.md` |
| Structured logging, log levels, PII rules | `references/logging.md` |
| Analytics events, provider adapters | `references/tracking.md` |
| Unit tests (Vitest) | `references/testing-unit.md` |
| End-to-end tests (Playwright) | `references/testing-e2e.md` |
| Authentication, sessions, protected routes | `references/auth.md` |
| Security hardening, CSP, headers, XSS prevention | `references/security.md` |
| SEO, OG tags, structured data, sitemaps | `references/seo.md` |
| Accessibility (ARIA, keyboard, focus, reduced motion) | `references/accessibility.md` |
| Markdown mirrors, llms.txt, machine-readable content | `references/machine-readable.md` |

Multiple tasks? Read multiple files. The references are self-contained — no need to consult external docs.

## Quick Rules

These repeat the critical guardrails for context-window resilience:

1. All `params`, `searchParams`, `cookies()`, `headers()` are async — always `await`.
2. All data fetching goes through the API client — never inline fetch, never ORM.
3. All visible strings use `t()` — no hardcoded text.
4. All Tailwind uses logical properties — `ps-`, `pe-`, `ms-`, `me-`, `text-start`, `text-end`.
5. `cacheComponents: true` required in `next.config.ts` for `'use cache'` to work.
