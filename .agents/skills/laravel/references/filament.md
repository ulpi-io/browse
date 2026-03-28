# Filament — Admin Panel, Resources, Pages, Widgets, Authorization

## What

**Filament v3** provides the admin panel at `/admin` — the only UI in this API-only app. It runs as a self-contained panel with its own Blade views, sessions, and authentication. This does not conflict with API-only architecture: Filament is an isolated admin panel, not a general frontend.

Filament handles CRUD via **Resources** (one per model), custom views via **Pages**, dashboard metrics via **Widgets**, and inline related-record management via **Relation Managers**. It uses Laravel **Policies** for authorization automatically — if a Policy exists, Filament respects `viewAny`, `view`, `create`, `update`, `delete` without extra configuration (see `auth.md`). Custom operations (approve, ban) delegate to project Action classes (see `service-layer.md`). No business logic lives in Filament Resources.

## How

### Panel setup

```bash
composer require filament/filament:"^3.0"
php artisan filament:install --panels
```

Creates `app/Providers/Filament/AdminPanelProvider.php`. Key configuration:

```php
class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->default()->id('admin')->path('admin')->login()
            ->colors(['primary' => Color::Indigo])
            ->discoverResources(in: app_path('Filament/Resources'), for: 'App\\Filament\\Resources')
            ->discoverPages(in: app_path('Filament/Pages'), for: 'App\\Filament\\Pages')
            ->discoverWidgets(in: app_path('Filament/Widgets'), for: 'App\\Filament\\Widgets')
            ->middleware([EncryptCookies::class, StartSession::class, ShareErrorsFromSession::class,
                VerifyCsrfToken::class, DisableBladeIconComponents::class, DispatchServingFilamentEvent::class])
            ->authMiddleware([Authenticate::class]);
    }
}
```

Register in `bootstrap/providers.php`. Filament requires web middleware (sessions, cookies, CSRF) for its panel — API routes remain stateless under `routes/api.php`.

### Resource — complete OrderResource example

Generate: `php artisan make:filament-resource Order --generate`. One Resource per model.

```php
namespace App\Filament\Resources;
use App\Enums\OrderStatus;
use App\Filament\Resources\OrderResource\{Pages, RelationManagers\ItemsRelationManager};
use App\Models\Order;
use Filament\{Forms, Forms\Form, Infolists, Infolists\Infolist, Resources\Resource, Tables, Tables\Table};

class OrderResource extends Resource
{
    protected static ?string $model = Order::class;
    protected static ?string $navigationIcon = 'heroicon-o-shopping-bag';
    protected static ?string $navigationGroup = 'Sales';
    protected static ?int $navigationSort = 1;

    public static function form(Form $form): Form
    {
        return $form->schema([
            Forms\Components\Section::make('Order Details')->schema([
                Forms\Components\TextInput::make('reference')->required()->maxLength(255)->unique(ignoreRecord: true),
                Forms\Components\Select::make('user_id')->relationship('user', 'name')->searchable()->preload()->required(),
                Forms\Components\Select::make('status')->options(OrderStatus::class)->searchable()->required()->default(OrderStatus::Pending),
                Forms\Components\DatePicker::make('due_date')->native(false)->required(),
                Forms\Components\Toggle::make('is_priority')->default(false),
                Forms\Components\FileUpload::make('invoice')->disk('s3')->directory('invoices')
                    ->acceptedFileTypes(['application/pdf'])->maxSize(10240),
            ])->columns(2),
            Forms\Components\Section::make('Notes')->schema([
                Forms\Components\Textarea::make('notes')->rows(4)->maxLength(2000),
            ]),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('reference')->searchable()->sortable(),
                Tables\Columns\TextColumn::make('user.name')->searchable()->sortable(),
                Tables\Columns\BadgeColumn::make('status')->colors([
                    'success' => OrderStatus::Completed->value, 'warning' => OrderStatus::Pending->value,
                    'danger' => OrderStatus::Cancelled->value, 'info' => OrderStatus::Processing->value,
                ]),
                Tables\Columns\TextColumn::make('total_cents')->label('Total')->money('usd', divideBy: 100)->sortable(),
                Tables\Columns\ToggleColumn::make('is_priority'),
                Tables\Columns\TextColumn::make('due_date')->date()->sortable(),
                Tables\Columns\TextColumn::make('created_at')->dateTime()->sortable()->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                Tables\Filters\SelectFilter::make('status')->options(OrderStatus::class),
                Tables\Filters\SelectFilter::make('user')->relationship('user', 'name')->searchable()->preload(),
                Tables\Filters\TernaryFilter::make('is_priority'),
            ])
            ->actions([
                Tables\Actions\ViewAction::make(), Tables\Actions\EditAction::make(),
                Tables\Actions\Action::make('approve')->label('Approve')->icon('heroicon-o-check')->color('success')
                    ->requiresConfirmation()->modalHeading('Approve this order?')
                    ->visible(fn (Order $record): bool => $record->status === OrderStatus::Pending)
                    ->action(fn (Order $record) => app(\App\Actions\Orders\ApproveOrder::class)->execute($record)),
                Tables\Actions\DeleteAction::make(),
            ])
            ->bulkActions([Tables\Actions\BulkActionGroup::make([
                Tables\Actions\DeleteBulkAction::make()->requiresConfirmation(),
                Tables\Actions\BulkAction::make('markCompleted')->label('Mark Completed')
                    ->icon('heroicon-o-check-circle')->requiresConfirmation()
                    ->action(fn ($records) => $records->each(
                        fn ($record) => app(\App\Actions\Orders\CompleteOrder::class)->execute($record))),
            ])])
            ->defaultSort('created_at', 'desc');
    }

    public static function infolist(Infolist $infolist): Infolist
    {
        return $infolist->schema([Infolists\Components\Section::make('Order Details')->schema([
            Infolists\Components\TextEntry::make('reference'),
            Infolists\Components\TextEntry::make('user.name')->label('Customer'),
            Infolists\Components\TextEntry::make('status')->badge(),
            Infolists\Components\TextEntry::make('total_cents')->label('Total')->money('usd', divideBy: 100),
            Infolists\Components\TextEntry::make('due_date')->date(),
            Infolists\Components\IconEntry::make('is_priority')->boolean(),
        ])->columns(2)]);
    }
    public static function getRelations(): array { return [ItemsRelationManager::class]; }
    public static function getPages(): array
    {
        return ['index' => Pages\ListOrders::route('/'), 'create' => Pages\CreateOrder::route('/create'),
            'view' => Pages\ViewOrder::route('/{record}'), 'edit' => Pages\EditOrder::route('/{record}/edit')];
    }
    public static function getNavigationBadge(): ?string
    {
        return static::getModel()::where('status', OrderStatus::Pending)->count() ?: null;
    }
}
```

### Relation managers

Manage related records inline. Generate: `php artisan make:filament-relation-manager OrderResource items product_id`

```php
class ItemsRelationManager extends RelationManager
{
    protected static string $relationship = 'items';
    public function form(Form $form): Form
    {
        return $form->schema([
            Forms\Components\Select::make('product_id')->relationship('product', 'name')->searchable()->preload()->required(),
            Forms\Components\TextInput::make('quantity')->numeric()->required()->minValue(1),
            Forms\Components\TextInput::make('unit_price_cents')->numeric()->required(),
        ]);
    }
    public function table(Table $table): Table
    {
        return $table->columns([
            Tables\Columns\TextColumn::make('product.name'),
            Tables\Columns\TextColumn::make('quantity'),
            Tables\Columns\TextColumn::make('unit_price_cents')->money('usd', divideBy: 100),
        ])->headerActions([Tables\Actions\CreateAction::make()])
          ->actions([Tables\Actions\EditAction::make(), Tables\Actions\DeleteAction::make()])
          ->bulkActions([Tables\Actions\DeleteBulkAction::make()]);
    }
}
```

### Pages and widgets

Custom dashboard page: `php artisan make:filament-page Dashboard`

```php
class Dashboard extends \Filament\Pages\Dashboard
{
    protected static ?string $navigationIcon = 'heroicon-o-home';
    public function getWidgets(): array { return [OrderStatsWidget::class, RevenueChartWidget::class]; }
}
```

**Stats overview widget** — key metrics cards:

```php
class OrderStatsWidget extends StatsOverviewWidget
{
    protected function getStats(): array
    {
        return [
            Stat::make('Pending', Order::where('status', OrderStatus::Pending)->count())->icon('heroicon-o-clock')->color('warning'),
            Stat::make('Revenue (30d)', '$' . number_format(
                Order::where('status', OrderStatus::Completed)->where('created_at', '>=', now()->subDays(30))->sum('total_cents') / 100, 2
            ))->icon('heroicon-o-currency-dollar')->color('success'),
        ];
    }
}
```

**Chart widget** — extend `ChartWidget`, implement `getData()` and `getType()`:

```php
class RevenueChartWidget extends ChartWidget
{
    protected static ?string $heading = 'Monthly Revenue';
    protected static string $color = 'success';
    protected function getData(): array
    {
        $data = Order::selectRaw("DATE_FORMAT(created_at, '%Y-%m') as month, SUM(total_cents) as revenue")
            ->where('created_at', '>=', now()->subMonths(6))
            ->groupByRaw("DATE_FORMAT(created_at, '%Y-%m')")->orderBy('month')->pluck('revenue', 'month');
        return ['datasets' => [['label' => 'Revenue', 'data' => $data->values()]], 'labels' => $data->keys()];
    }
    protected function getType(): string { return 'bar'; } // also: 'line', 'pie', 'doughnut'
}
```

### Authorization

Filament checks Policies automatically. If `OrderPolicy` exists, Filament enforces it:

| Policy Method | Filament Behavior |
|---|---|
| `viewAny` returns `false` | Resource hidden from navigation, list page 403 |
| `create` returns `false` | "New" button hidden |
| `update` returns `false` | Edit action/page hidden |
| `delete` returns `false` | Delete action hidden |

Restrict panel access — implement `FilamentUser` on the User model: `canAccessPanel(Panel $panel): bool { return $this->hasRole('admin'); }`. See `auth.md` for Policy class structure, `spatie/laravel-permission` role setup.

### Navigation and theming

Static properties on Resource: `$navigationIcon`, `$navigationGroup`, `$navigationSort`, `$navigationLabel`. Badge counts via `getNavigationBadge()` (shown in Resource). Badge color via `getNavigationBadgeColor()`. Custom Tailwind theme: `php artisan make:filament-theme`, register via `->viteTheme('resources/css/filament/admin/theme.css')` on the panel.

## When

| Situation | Action |
|---|---|
| Need admin CRUD for a model | Generate a Filament Resource (`make:filament-resource`) |
| Need dashboard metrics | Create StatsOverviewWidget or ChartWidget |
| Need to manage related records inline | Create a RelationManager |
| Need a custom admin view (reports, settings) | Create a Filament Page |
| Need a record-level operation (approve, ban) | Add a Filament Action that delegates to a project Action class |
| Need to restrict panel access | Implement `FilamentUser` with `canAccessPanel()` |
| Need per-resource authorization | Create a Policy — Filament picks it up automatically |
| Need read-only detail view | Define an Infolist on the Resource |

## Never

- **Never put business logic in Filament Resources.** Resources define UI (forms, tables, columns). Mutations belong in Action classes (see `service-layer.md`). Filament actions call `app(SomeAction::class)->execute($record)`.
- **Never bypass Policies in Filament.** Filament respects Policies automatically. Do not use direct queries to skip authorization or override policy checks.
- **Never build custom admin CRUD when Filament handles it.** Filament generates list, create, edit, view pages with filtering, sorting, searching, pagination, and bulk actions out of the box.
- **Never use Filament v2 syntax.** v3 uses `Forms\Components\TextInput::make()`, `Tables\Columns\TextColumn::make()` with method chaining. No array-based column definitions.
- **Never expose the Filament panel without authentication.** Always include `->login()` on the panel and implement `FilamentUser` with `canAccessPanel()` to restrict access.
- **Never duplicate validation in Filament and Form Requests expecting them to stay in sync.** Filament forms handle admin-side validation. API Form Requests handle API-side validation. They serve different entry points — each owns its own rules.
