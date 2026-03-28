# Laravel Boost (`laravel/boost`)

## What

A **developer-time** package (`--dev`) that gives AI coding agents the context and knowledge they need to write high-quality, idiomatic Laravel code. Your end users never interact with it — it helps *you* and your AI tools build faster.

Boost provides three layers:
1. **MCP Tools** (15 tools) — give AI agents runtime access to your app's schema, logs, errors, docs
2. **AI Guidelines** — composable instruction files loaded upfront so agents know your stack's conventions
3. **Agent Skills** — on-demand knowledge modules activated for specific tasks (Livewire, Pest, Tailwind, etc.)

Supports: Cursor, Claude Code, Codex CLI, Gemini CLI, GitHub Copilot (VS Code), Junie, PhpStorm.

Related packages: **AI SDK** (`ai-sdk.md`) adds AI features your users interact with. **Laravel MCP** (`mcp.md`) is the framework Boost is built on — every Boost tool is an MCP tool. Boost is the development-time layer; the AI SDK and MCP serve production.

Key rules:
- Always install as `--dev` — this is a development tool, not a production dependency
- Run `boost:install` after install to configure for your IDE
- Run `boost:update --discover` periodically to pick up new packages and guidelines
- Use custom guidelines in `.ai/guidelines/` for project-specific conventions
- Boost is built on top of Laravel MCP internally — every Boost tool is an MCP tool

## How

### Installation

```bash
composer require laravel/boost --dev
php artisan boost:install
```

The install command detects your IDE and configures the MCP connection. Follow the prompts to select your environment.

### MCP tools provided

Boost exposes MCP tools that AI agents call to understand your application at runtime. Key tools:

| Tool | What it does |
|---|---|
| Application Info | PHP/Laravel versions, DB engine, installed packages, Eloquent models |
| Database Schema | Read the full database schema — columns, types, indexes, foreign keys |
| Database Query | Execute read queries against the database (guarded, dev-only) |
| Database Connections | Inspect available database connections and their config |
| Last Error | Read the most recent error from log files |
| Read Log Entries | Read last N log entries with level filtering |
| Browser Logs | Read browser console errors (Vite dev server) |
| Search Docs | Query hosted documentation API (17,000+ pieces of Laravel ecosystem info) |
| Get Absolute URL | Convert relative route paths to absolute URLs |

These tools give AI agents *live* access to your application state — schema, logs, errors — so they can write code that matches your actual database structure and catch issues in real time. The tools are exposed via MCP (see `mcp.md` for how MCP works under the hood).

### AI guidelines

Composable instruction files that tell AI agents how your stack works. Loaded automatically based on your installed packages.

**Built-in guideline coverage:**
- Laravel Framework (core, 10.x, 11.x, 12.x)
- Livewire (core, 2.x, 3.x, 4.x)
- Flux UI, Folio, Herd
- Inertia (React/Vue/Svelte, core + versions 1.x–3.x)
- MCP, Pennant, Pest (3.x, 4.x), PHPUnit, Pint, Sail
- Tailwind CSS (3.x, 4.x)
- Livewire Volt, Wayfinder

**Custom guidelines** — add project-specific conventions that AI agents should follow. Uses Blade or Markdown:

```
.ai/guidelines/
├── api-conventions.blade.php    # or .md
├── naming-rules.blade.php
└── testing-standards.blade.php
```

Example custom guideline (`.ai/guidelines/api-conventions.md`):

```markdown
## API Response Conventions

- All list endpoints use cursor pagination, not offset pagination
- All monetary values are integers in cents (USD), never floats
- All timestamps use ISO 8601 format with timezone
- Error responses follow the envelope format in error-handling.md
```

**Third-party package guidelines** — package authors ship guidelines so AI agents understand their package automatically:

```
resources/boost/guidelines/core.blade.php
```

### Agent skills

On-demand knowledge modules activated when working on specific tasks. Unlike guidelines (always loaded), skills are invoked only when relevant:

| Skill | Activated for |
|---|---|
| `fluxui-development` | Flux UI component work |
| `folio-routing` | Folio page-based routing |
| `inertia-react-development` | Inertia.js with React |
| `inertia-svelte-development` | Inertia.js with Svelte |
| `inertia-vue-development` | Inertia.js with Vue |
| `livewire-development` | Livewire components |
| `mcp-development` | MCP server development |
| `pennant-development` | Feature flags with Pennant |
| `pest-testing` | Pest test writing |
| `tailwindcss-development` | Tailwind CSS styling |
| `volt-development` | Livewire Volt single-file components |
| `wayfinder-development` | Wayfinder route generation |

**Custom skills** — add project-specific skills:

```
.ai/skills/{skill-name}/SKILL.md
```

### Documentation API

Semantic search over 17,000+ documentation entries covering:

| Package | Versions |
|---|---|
| Laravel Framework | 10, 11, 12 |
| Filament | 2, 3, 4, 5 |
| Flux UI | current |
| Inertia | 1, 2 |
| Livewire | 1, 2, 3, 4 |
| Nova | 4, 5 |
| Pest | 3, 4 |
| Tailwind CSS | 3, 4 |

### Keeping updated

```bash
php artisan boost:update              # Update existing guidelines and skills
php artisan boost:update --discover   # Scan for newly installed packages and add their resources
```

### Extending Boost

Create custom agents for other IDEs or tools by extending the base agent. Each interface opts into a Boost layer:

```php
<?php

namespace App\Boost;

use Laravel\Boost\Install\Agents\Agent;
use Laravel\Boost\Contracts\{SupportsGuidelines, SupportsMcp, SupportsSkills};
use Laravel\Boost\Facades\Boost;

final class MyCustomAgent extends Agent implements SupportsGuidelines, SupportsMcp, SupportsSkills
{
    public function name(): string { return 'my-custom-agent'; }

    public function guidelinesPath(): string { return base_path('.ai/guidelines'); }

    public function mcpConfig(): array { return ['transport' => 'stdio']; }

    public function skillsPath(): string { return base_path('.ai/skills'); }
}

// Register in AppServiceProvider::boot()
Boost::registerAgent(MyCustomAgent::class);
```

## When

| Scenario | Action |
|---|---|
| Setting up a new Laravel project for AI-assisted development | `composer require laravel/boost --dev && php artisan boost:install` |
| AI agent writes wrong patterns for your Laravel version | Check guidelines are up to date: `php artisan boost:update` |
| Added new packages (Livewire, Pest, etc.) | `php artisan boost:update --discover` |
| Project has custom conventions AI agents should follow | Add `.ai/guidelines/*.blade.php` or `.md` files |
| Building a package that AI agents should know about | Ship `resources/boost/guidelines/core.blade.php` |
| AI agent needs to understand your database schema | Boost's Database Schema MCP tool handles this automatically |
| AI agent needs to see recent errors | Boost's Last Error / Read Log Entries tools handle this |

## Never

- **Never install Boost in production.** It is a `--dev` dependency only. It exposes database queries and log reading tools — production exposure is a security risk:
  ```bash
  # WRONG
  composer require laravel/boost

  # RIGHT
  composer require laravel/boost --dev
  ```
- **Never skip `boost:install`.** Without it, your IDE/agent won't have the MCP connection configured and won't use any Boost tools or guidelines.
- **Never manually edit Boost-generated guideline files.** They get overwritten on `boost:update`. Use `.ai/guidelines/` for custom conventions instead.
- **Never confuse Boost with the AI SDK.** Boost helps *you* write code with AI agents. The AI SDK (`laravel/ai`, see `ai-sdk.md`) adds AI features *your users* interact with. They serve different audiences.
- **Never confuse Boost with Laravel MCP.** Boost is a pre-built MCP server for development. `laravel/mcp` (see `mcp.md`) is a framework for building your own MCP servers that expose your app to external AI clients.
