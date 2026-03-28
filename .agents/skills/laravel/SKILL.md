---
name: laravel
version: 1.1.0
description: |
  Laravel 12 API development — API-only, Actions pattern, Sanctum/Passport auth,
  Eloquent strict mode, Redis caching/queues, Horizon, Filament admin, Pest testing.
  Also covers Laravel AI ecosystem: AI SDK (agents, embeddings, image/audio generation),
  Boost (AI-assisted development), and MCP (exposing your app to AI clients).
  Use when working on any Laravel route, controller, model, action, migration,
  job, notification, test, API endpoint, AI agent, or MCP server task.
allowed-tools:
  - Bash
  - Read
---

<EXTREMELY-IMPORTANT>
These rules apply to ALL Laravel code you write. Violating any of them produces broken, insecure, or unmaintainable output.

1. **No business logic in controllers.** Controllers validate (Form Request), delegate (Action), return (API Resource). Nothing else.
2. **No returning Eloquent models directly.** Every response goes through an API Resource. Never `return $user`.
3. **No inline validation.** All validation lives in Form Request classes. Never `$request->validate([...])` in controllers.
4. **No `$guarded = []`.** Every model uses explicit `$fillable`. Mass-assignment protection is non-negotiable.
5. **No raw queries.** Use Eloquent or the query builder with parameter bindings. Never concatenate user input into SQL.
6. **No bare `queue:work`.** All queue processing uses Horizon — in development and production.
7. **`Model::shouldBeStrict()` must be enabled** in `AppServiceProvider::boot()`. This prevents lazy loading, silently discarded attributes, and access to missing attributes.
</EXTREMELY-IMPORTANT>

# Laravel 12 API

## MANDATORY FIRST RESPONSE PROTOCOL

Before writing ANY code, you **MUST** complete this checklist:

1. Read `references/stack.md` to understand locked decisions (runtime, packages, patterns)
2. Identify the task type from the routing table below
3. Read the matching reference file(s) — they contain the patterns, code examples, and anti-patterns
4. Only then begin implementation

**Writing code without reading the reference = wrong patterns, wasted time, rework.**

## Routing Table

| Task | Read |
|------|------|
| Starting a session / understanding the stack | `references/stack.md` |
| Creating or modifying files, folder conventions | `references/folder-structure.md` |
| API routes, versioning, middleware | `references/routing.md` |
| Creating or editing a controller | `references/controller-pattern.md` |
| Adding validation to a request | `references/form-requests.md` |
| Creating or editing a model, relationships, scopes | `references/eloquent-models.md` |
| API response transformation, pagination, filtering | `references/api-resources.md` |
| Business logic, Actions, DTOs, service providers | `references/service-layer.md` |
| Authentication, tokens, roles, policies | `references/auth.md` |
| Migrations, seeders, factories, query optimization | `references/database.md` |
| Error responses, exception handling | `references/error-handling.md` |
| Logging configuration, structured logging | `references/logging.md` |
| Redis caching, cache invalidation, TTL strategy | `references/caching.md` |
| Jobs, queues, events, Horizon, broadcasting | `references/queues-jobs.md` |
| Writing tests (feature or unit) | `references/testing.md` |
| Security hardening, CORS, rate limiting, webhooks | `references/security.md` |
| API documentation generation | `references/api-docs.md` |
| Telescope, Horizon dashboard, Pulse, health checks | `references/observability.md` |
| Filament admin panel, resources, pages, widgets | `references/filament.md` |
| Docker setup, CI/CD, deployment | `references/docker.md` |
| Notifications, email, SMS | `references/notifications-mail.md` |
| File uploads, S3, media library | `references/file-storage.md` |
| Task scheduling, cron jobs | `references/scheduling.md` |
| AI agents, text/image/audio generation, embeddings, RAG | `references/ai-sdk.md` |
| AI-assisted development, Boost setup, guidelines, skills | `references/boost.md` |
| MCP servers, exposing app to AI clients, tools/resources/prompts | `references/mcp.md` |

Multiple tasks? Read multiple files. The references are self-contained — no need to consult external docs.

## Quick Rules

These repeat the critical guardrails for context-window resilience:

1. Controllers are thin — validate via Form Request, delegate to Action, return API Resource.
2. All mutations in Actions wrapped in `DB::transaction()`.
3. All list endpoints paginated — never return unbounded collections.
4. All responses via API Resources — never return Eloquent models directly.
5. `$fillable` on every model — never `$guarded = []`.
6. `Model::shouldBeStrict()` in `AppServiceProvider::boot()`.
7. Horizon for all queue processing — never bare `queue:work`.
