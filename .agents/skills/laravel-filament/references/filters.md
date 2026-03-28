# Filament v5 — Table Filters

## Namespace

Filters remain in the Tables namespace (not moved like Actions):

```php
use Filament\Tables\Filters\Filter;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Filters\TernaryFilter;
use Filament\Tables\Filters\TrashedFilter;
```

## SelectFilter

```php
// From enum
SelectFilter::make('status')
    ->options(OrderStatus::class)

// Static options
SelectFilter::make('role')
    ->options([
        'admin' => 'Admin',
        'editor' => 'Editor',
        'viewer' => 'Viewer',
    ])

// From relationship
SelectFilter::make('author')
    ->relationship('author', 'name')
    ->searchable()
    ->preload()

// With global scope removal
SelectFilter::make('organization')
    ->relationship('organization', 'name', fn (Builder $query) =>
        $query->withoutGlobalScopes())
    ->searchable()
    ->preload()

// Multiple selection
SelectFilter::make('tags')
    ->multiple()
    ->options(Tag::pluck('name', 'id'))

// Custom query
SelectFilter::make('tier')
    ->options(['free' => 'Free', 'paid' => 'Paid'])
    ->query(fn (Builder $query, array $data) =>
        $query->when($data['value'] === 'free', fn ($q) => $q->whereNull('subscription_id'))
              ->when($data['value'] === 'paid', fn ($q) => $q->whereNotNull('subscription_id')))
```

## TernaryFilter

Three states: true, false, blank (show all).

```php
TernaryFilter::make('is_active')
    ->label('Active')
    ->placeholder('All')
    ->trueLabel('Active only')
    ->falseLabel('Inactive only')

// Custom query
TernaryFilter::make('has_orders')
    ->queries(
        true: fn (Builder $query) => $query->has('orders'),
        false: fn (Builder $query) => $query->doesntHave('orders'),
        blank: fn (Builder $query) => $query,
    )
```

## TrashedFilter

For models with SoftDeletes:

```php
TrashedFilter::make()
// Shows: All, With trashed, Only trashed
```

## Custom Filter

```php
Filter::make('verified')
    ->query(fn (Builder $query): Builder =>
        $query->whereNotNull('email_verified_at'))

// With toggle (checkbox)
Filter::make('is_featured')
    ->toggle()

// With custom form
Filter::make('date_range')
    ->schema([
        DatePicker::make('from'),
        DatePicker::make('until'),
    ])
    ->query(function (Builder $query, array $data): Builder {
        return $query
            ->when($data['from'], fn ($q, $date) =>
                $q->whereDate('created_at', '>=', $date))
            ->when($data['until'], fn ($q, $date) =>
                $q->whereDate('created_at', '<=', $date));
    })
    ->indicateUsing(function (array $data): array {
        $indicators = [];
        if ($data['from'] ?? null) {
            $indicators[] = 'From ' . Carbon::parse($data['from'])->toFormattedDateString();
        }
        if ($data['until'] ?? null) {
            $indicators[] = 'Until ' . Carbon::parse($data['until'])->toFormattedDateString();
        }
        return $indicators;
    })
```

## Filter Layout

```php
use Filament\Tables\Enums\FiltersLayout;

$table
    ->filters([...])
    ->filtersLayout(FiltersLayout::AboveContent)              // show above table
    ->filtersLayout(FiltersLayout::AboveContentCollapsible)   // collapsible above
    ->filtersLayout(FiltersLayout::BelowContent)              // show below table
    // Default: dropdown panel via filter icon button
```
