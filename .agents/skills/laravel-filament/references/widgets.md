# Filament v5 — Widgets

## Stats Overview Widget

```bash
php artisan make:filament-widget OrderStats --stats-overview
```

```php
namespace App\Filament\Widgets;

use App\Models\Order;
use Filament\Widgets\StatsOverviewWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;

class OrderStats extends StatsOverviewWidget
{
    protected function getStats(): array
    {
        return [
            Stat::make('Total Orders', Order::count())
                ->description('All time')
                ->icon('heroicon-o-shopping-bag')
                ->color('primary'),

            Stat::make('Pending', Order::where('status', 'pending')->count())
                ->icon('heroicon-o-clock')
                ->color('warning')
                ->descriptionIcon('heroicon-m-arrow-trending-up')
                ->description('12% increase')
                ->chart([7, 3, 4, 5, 6, 3, 5, 3]),   // sparkline

            Stat::make('Revenue', '$' . number_format(Order::sum('total') / 100, 2))
                ->icon('heroicon-o-currency-dollar')
                ->color('success'),
        ];
    }

    // Auto-refresh
    protected static ?string $pollingInterval = '30s';
}
```

## Chart Widget

```bash
php artisan make:filament-widget RevenueChart --chart
```

```php
namespace App\Filament\Widgets;

use Filament\Widgets\ChartWidget;

class RevenueChart extends ChartWidget
{
    protected static ?string $heading = 'Monthly Revenue';
    protected static string $color = 'success';
    protected static ?string $pollingInterval = '60s';
    protected static ?int $sort = 2;                    // widget order on dashboard
    protected int|string|array $columnSpan = 'full';    // full width

    protected function getData(): array
    {
        $data = Order::selectRaw("DATE_FORMAT(created_at, '%Y-%m') as month, SUM(total) as revenue")
            ->where('created_at', '>=', now()->subMonths(6))
            ->groupByRaw("DATE_FORMAT(created_at, '%Y-%m')")
            ->orderBy('month')
            ->pluck('revenue', 'month');

        return [
            'datasets' => [
                [
                    'label' => 'Revenue',
                    'data' => $data->values(),
                    'backgroundColor' => '#10B981',
                    'borderColor' => '#10B981',
                ],
            ],
            'labels' => $data->keys(),
        ];
    }

    protected function getType(): string
    {
        return 'bar';   // 'line', 'pie', 'doughnut', 'radar', 'scatter', 'bubble', 'polarArea'
    }

    // Optional: filter selector
    protected function getFilters(): ?array
    {
        return [
            'week' => 'Last week',
            'month' => 'Last month',
            'quarter' => 'Last quarter',
            'year' => 'This year',
        ];
    }
}
```

## Register Widgets on Dashboard

```php
// In AdminPanelProvider
->widgets([
    OrderStats::class,
    RevenueChart::class,
])
```

## Register Widgets on Resource Pages

```php
// In resource class
public static function getWidgets(): array
{
    return [
        OrderStats::class,
    ];
}

// In a page class (e.g., ListOrders)
protected function getHeaderWidgets(): array
{
    return [
        OrderStats::class,
    ];
}

protected function getFooterWidgets(): array
{
    return [
        RevenueChart::class,
    ];
}
```

## Widget Column Span

```php
class OrderStats extends StatsOverviewWidget
{
    protected int|string|array $columnSpan = 'full';    // full width
    // or: 1, 2, 3 (number of columns), 'full'

    // Responsive
    protected int|string|array $columnSpan = [
        'md' => 2,
        'xl' => 3,
    ];
}
```
