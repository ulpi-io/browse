# Filament v5 — Tables

## Table Structure

```php
use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

public static function configure(Table $table): Table
{
    return $table
        ->columns([...])
        ->defaultSort('created_at', 'desc')
        ->filters([...])
        ->recordActions([...])
        ->toolbarActions([...])
        ->headerActions([...]);
}
```

## Column Types

### TextColumn (the workhorse)

```php
TextColumn::make('name')
    ->searchable()
    ->sortable()
    ->label('Customer Name')
    ->description(fn ($record) => $record->email)    // subtitle text
    ->weight('bold')                                  // FontWeight::Bold
    ->color('primary')                                // or closure
    ->copyable()                                      // click to copy
    ->copyMessage('Copied!')
    ->limit(50)                                       // truncate
    ->tooltip(fn ($record) => $record->name)          // show full on hover
    ->wrap()                                          // allow wrapping
    ->placeholder('N/A')                              // null fallback
    ->toggleable(isToggledHiddenByDefault: true)      // toggle visibility
    ->extraAttributes(['class' => 'font-mono'])

// As badge
TextColumn::make('status')
    ->badge()
    ->color(fn (string $state): string => match ($state) {
        'active' => 'success',
        'suspended' => 'warning',
        'revoked' => 'danger',
        default => 'gray',
    })
    ->icon(fn (string $state): ?string => match ($state) {
        'active' => 'heroicon-m-check-circle',
        default => null,
    })

// Formatting
TextColumn::make('price_cents')->money('usd', divideBy: 100)
TextColumn::make('created_at')->dateTime()           // or ->date(), ->since(), ->time()
TextColumn::make('size_bytes')->size()                // human-readable file sizes
TextColumn::make('count')->numeric(decimalPlaces: 0)

// Relationships
TextColumn::make('organization.name')                // dot notation
    ->searchable()
    ->sortable()
TextColumn::make('tags.name')                        // HasMany — renders as list
    ->badge()
    ->separator(',')

// Aggregates
TextColumn::make('orders_count')->counts('orders')
TextColumn::make('orders_avg_total')->avg('orders', 'total')
TextColumn::make('orders_sum_total')->sum('orders', 'total')
TextColumn::make('orders_min_total')->min('orders', 'total')
TextColumn::make('orders_max_total')->max('orders', 'total')
TextColumn::make('orders_exists')->exists('orders')
```

### IconColumn

```php
IconColumn::make('is_active')
    ->boolean()                                      // ✓/✗ icons
    ->trueIcon('heroicon-o-check-circle')
    ->falseIcon('heroicon-o-x-circle')
    ->trueColor('success')
    ->falseColor('danger')
```

### ImageColumn

```php
ImageColumn::make('avatar')
    ->circular()
    ->size(40)
    ->defaultImageUrl(fn ($record) => 'https://ui-avatars.com/api/?name=' . $record->name)
```

### Editable Columns

```php
ToggleColumn::make('is_active')
SelectColumn::make('status')->options(Status::class)
TextInputColumn::make('sort_order')->rules(['required', 'integer'])
CheckboxColumn::make('is_featured')
```

### ColorColumn

```php
ColorColumn::make('brand_color')
    ->copyable()
```

## Searching

```php
// Global search (searchable columns combined)
TextColumn::make('name')->searchable()

// Individual column search (separate search input per column)
TextColumn::make('email')->searchable(isIndividual: true)

// Search across relationship
TextColumn::make('author.name')->searchable()

// Custom search query
TextColumn::make('name')
    ->searchable(query: function (Builder $query, string $search): Builder {
        return $query->where('name', 'ilike', "%{$search}%");
    })

// Disable global search for a column
TextColumn::make('internal_id')->searchable(isGlobal: false)
```

## Sorting

```php
TextColumn::make('name')->sortable()

// Sort by relationship
TextColumn::make('author.name')->sortable()

// Custom sort
TextColumn::make('full_name')
    ->sortable(query: function (Builder $query, string $direction): Builder {
        return $query->orderBy('last_name', $direction)->orderBy('first_name', $direction);
    })

// Default sort
$table->defaultSort('created_at', 'desc')
```

## Pagination

```php
$table
    ->paginated([10, 25, 50, 100, 'all'])            // page size options
    ->defaultPaginationPageOption(25)
    ->extremePaginationLinks()                         // first/last links
    ->paginationMode(PaginationMode::Simple)           // simple prev/next
    ->paginationMode(PaginationMode::Cursor)           // cursor-based
    ->paginated(false)                                 // disable entirely
```

## Other Table Methods

```php
$table
    ->striped()                                        // alternating row colors
    ->poll('10s')                                      // auto-refresh
    ->deferLoading()                                   // async load
    ->heading('Clients')                               // table title
    ->description('Manage your clients')
    ->reorderable('sort_order')                        // drag to reorder
    ->recordUrl(fn ($record) => route('view', $record)) // clickable rows
    ->openRecordUrlInNewTab()
    ->recordClasses(fn ($record) => $record->is_urgent ? 'bg-red-50' : '')
```

## Utility Injection in Column Callbacks

All closures in column config can inject:

| Parameter | Description |
|---|---|
| `$state` | Current cell value |
| `$record` | Eloquent model instance |
| `$column` | Column component instance |
| `$table` | Table instance |
| `$livewire` | Livewire component |
| `$rowLoop` | Laravel loop variable |
