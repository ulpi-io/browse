# Filament v5 — Panels, Navigation & Theming

## Panel Provider

```php
namespace App\Providers\Filament;

use Filament\Http\Middleware\Authenticate;
use Filament\Http\Middleware\DisableBladeIconComponents;
use Filament\Http\Middleware\DispatchServingFilamentEvent;
use Filament\Panel;
use Filament\PanelProvider;
use Filament\Support\Colors\Color;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\VerifyCsrfToken;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\View\Middleware\ShareErrorsFromSession;

class AdminPanelProvider extends PanelProvider
{
    public function panel(Panel $panel): Panel
    {
        return $panel
            ->default()
            ->id('admin')
            ->path('admin')
            ->login()                                      // enable login page
            ->registration()                               // enable registration (optional)
            ->passwordReset()                              // enable password reset (optional)
            ->emailVerification()                          // enable email verification (optional)
            ->profile()                                    // enable profile page (optional)
            ->colors([
                'primary' => Color::Indigo,
                'danger' => Color::Red,
                'info' => Color::Blue,
                'success' => Color::Green,
                'warning' => Color::Amber,
            ])
            ->font('Inter')
            ->favicon(asset('favicon.ico'))
            ->brandName('My Admin')
            ->brandLogo(asset('logo.svg'))
            ->darkMode(true)                               // enable dark mode toggle
            ->sidebarCollapsibleOnDesktop()
            ->sidebarFullyCollapsibleOnDesktop()
            ->discoverResources(
                in: app_path('Filament/Resources'),
                for: 'App\\Filament\\Resources'
            )
            ->discoverPages(
                in: app_path('Filament/Pages'),
                for: 'App\\Filament\\Pages'
            )
            ->discoverWidgets(
                in: app_path('Filament/Widgets'),
                for: 'App\\Filament\\Widgets'
            )
            ->middleware([
                EncryptCookies::class,
                StartSession::class,
                ShareErrorsFromSession::class,
                VerifyCsrfToken::class,
                DisableBladeIconComponents::class,
                DispatchServingFilamentEvent::class,
            ])
            ->authMiddleware([
                Authenticate::class,
            ])
            ->plugins([
                // Plugin::make(),
            ]);
    }
}
```

## Navigation Properties (on Resource)

```php
class OrderResource extends Resource
{
    protected static ?string $navigationIcon = 'heroicon-o-shopping-bag';
    protected static ?string $navigationGroup = 'Sales';
    protected static ?int $navigationSort = 1;
    protected static ?string $navigationLabel = 'Orders';
    protected static ?string $navigationParentItem = 'Shop';  // nest under parent

    // Dynamic
    public static function getNavigationLabel(): string { return 'Orders'; }
    public static function getNavigationIcon(): ?string { return 'heroicon-o-shopping-bag'; }
    public static function getNavigationSort(): ?int { return 1; }
    public static function getNavigationGroup(): ?string { return 'Sales'; }

    // Badge
    public static function getNavigationBadge(): ?string
    {
        return (string) static::getModel()::where('status', 'pending')->count() ?: null;
    }

    public static function getNavigationBadgeColor(): string|array|null
    {
        return static::getModel()::where('status', 'pending')->count() > 10 ? 'danger' : 'warning';
    }
}
```

## Custom Navigation Items (in Panel)

```php
->navigationItems([
    NavigationItem::make('Analytics')
        ->url('https://analytics.example.com', shouldOpenInNewTab: true)
        ->icon('heroicon-o-chart-bar')
        ->group('External')
        ->sort(10),
])
```

## Panel Access Control

Implement `FilamentUser` on User model:

```php
use Filament\Models\Contracts\FilamentUser;
use Filament\Panel;

class User extends Authenticatable implements FilamentUser
{
    public function canAccessPanel(Panel $panel): bool
    {
        if ($panel->getId() === 'admin') {
            return $this->hasRole('admin');
        }

        return true;
    }
}
```

## Multiple Panels

```bash
php artisan make:filament-panel app
```

Creates a second panel provider. Each panel has its own:
- Path (`/admin`, `/app`)
- Resources, pages, widgets
- Auth, middleware
- Colors, branding

## Theming

```bash
php artisan make:filament-theme
```

Register in panel:
```php
->viteTheme('resources/css/filament/admin/theme.css')
```

Custom colors:
```php
->colors([
    'primary' => Color::hex('#1a73e8'),
    'danger' => Color::Red,
])
```

## Global Table/Form Config

In a service provider's `boot()`:

```php
use Filament\Tables\Table;

Table::configureUsing(function (Table $table): void {
    $table
        ->paginationPageOptions([10, 25, 50])
        ->defaultPaginationPageOption(25)
        ->striped();
});
```
