---
name: laravel-filament
version: 1.0.0
description: |
  Filament v5 admin panel — resources, schemas, tables, actions, relation managers,
  widgets, navigation, and panels. Use when working on any Filament resource, form,
  table, action, filter, widget, page, or panel configuration task.
allowed-tools:
  - Bash
  - Read
---

<EXTREMELY-IMPORTANT>
These rules apply to ALL Filament code you write. Violating any produces broken admin panels.

1. **Unified action namespace.** ALL actions import from `Filament\Actions\*` — never `Filament\Tables\Actions\*` or `Filament\Forms\Actions\*`. These old namespaces DO NOT EXIST in v5.
2. **Table methods changed.** Use `->recordActions()` not `->actions()`. Use `->toolbarActions()` not `->bulkActions()`. The v3 method names DO NOT EXIST in v5.
3. **No BadgeColumn.** Use `TextColumn::make('status')->badge()->color(...)`. `BadgeColumn` was removed.
4. **Schemas package.** Layout components come from `Filament\Schemas\Components\*` (Section, Grid, Tabs, Wizard). Form fields stay in `Filament\Forms\Components\*`. Infolist entries stay in `Filament\Infolists\Components\*`.
5. **No business logic in Resources.** Custom actions delegate to project Action classes: `->action(fn ($record) => app(SomeAction::class)->execute($record))`.
6. **Schema/Table class extraction.** Resources delegate to separate schema and table classes for maintainability. Keep `form()` and `table()` methods as one-liners that call `SomeForm::configure($schema)`.
7. **Filters stay in Tables namespace.** `Filament\Tables\Filters\*` is correct. Only actions moved to the unified namespace.
</EXTREMELY-IMPORTANT>

# Filament v5 Admin Panel

## MANDATORY FIRST RESPONSE PROTOCOL

Before writing ANY Filament code, you **MUST** complete this checklist:

1. Read `references/namespaces.md` to understand the v5 import map
2. Identify the task type from the routing table below
3. Read the matching reference file(s)
4. Only then begin implementation

**Writing Filament code without reading the reference = wrong namespaces, wrong methods, rework.**

## Routing Table

| Task | Read |
|------|------|
| Understanding v5 namespace changes from v3 | `references/namespaces.md` |
| Creating or editing a Resource | `references/resources.md` |
| Form fields, validation, layout | `references/forms.md` |
| Table columns, sorting, searching | `references/tables.md` |
| Table/page/bulk actions, modals, confirmations | `references/actions.md` |
| Filters (select, ternary, custom) | `references/filters.md` |
| Relation managers, relationships in forms | `references/relationships.md` |
| Widgets (stats, charts) | `references/widgets.md` |
| Navigation, panels, theming | `references/panels.md` |
| Notifications (flash, database, broadcast) | `references/notifications.md` |
| Testing Filament resources and pages | `references/testing.md` |
| Infolists (read-only detail views) | `references/infolists.md` |

Multiple tasks? Read multiple files.

## Quick Rules

These repeat the critical guardrails for context-window resilience:

1. ALL actions: `use Filament\Actions\{Action, EditAction, DeleteAction, BulkAction, BulkActionGroup, ...}` — one namespace.
2. Table methods: `->recordActions([...])`, `->toolbarActions([...])`, `->headerActions([...])` — never `->actions()` or `->bulkActions()`.
3. Badge columns: `TextColumn::make('field')->badge()->color(fn ($state) => ...)` — no `BadgeColumn` class.
4. Layout: `Filament\Schemas\Components\{Section, Grid, Tabs, Wizard}`.
5. Form fields: `Filament\Forms\Components\{TextInput, Select, Toggle, ...}`.
6. Infolist entries: `Filament\Infolists\Components\{TextEntry, IconEntry, ...}`.
7. Table columns: `Filament\Tables\Columns\{TextColumn, IconColumn, ImageColumn, ...}`.
8. Filters: `Filament\Tables\Filters\{Filter, SelectFilter, TernaryFilter}`.
9. Custom actions delegate to Action classes — no business logic in Resources.
10. Policies are auto-detected — no manual authorization wiring needed.

## v5 Breaking Changes from v3 (Quick Summary)

| v3 | v5 | Notes |
|----|-----|-------|
| `Tables\Actions\EditAction` | `Filament\Actions\EditAction` | Unified action namespace |
| `Tables\Actions\Action` | `Filament\Actions\Action` | Same class, different namespace |
| `Tables\Actions\BulkActionGroup` | `Filament\Actions\BulkActionGroup` | Unified |
| `Tables\Actions\DeleteBulkAction` | `Filament\Actions\DeleteBulkAction` | Unified |
| `->actions([...])` | `->recordActions([...])` | Table method renamed |
| `->bulkActions([...])` | `->toolbarActions([BulkActionGroup::make([...])])` | Bulk actions live in toolbar |
| `->headerActions([...])` | `->headerActions([...])` | Unchanged |
| `Tables\Columns\BadgeColumn` | `TextColumn::make()->badge()` | BadgeColumn removed |
| `Forms\Components\Section` | `Filament\Schemas\Components\Section` | Layout → Schemas package |
| `Forms\Components\Grid` | `Filament\Schemas\Components\Grid` | Layout → Schemas package |
| `Forms\Components\Tabs` | `Filament\Schemas\Components\Tabs` | Layout → Schemas package |
| `Form $form` (in resource) | `Schema $schema` | Type hint changed |
| `$form->schema([...])` | `$schema->components([...])` | Method renamed |
