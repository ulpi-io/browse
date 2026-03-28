# Filament v5 — Infolists (Read-Only Detail Views)

## Namespace

```php
use Filament\Infolists\Components\CodeEntry;
use Filament\Infolists\Components\ColorEntry;
use Filament\Infolists\Components\IconEntry;
use Filament\Infolists\Components\ImageEntry;
use Filament\Infolists\Components\KeyValueEntry;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
```

## Define in Resource

```php
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

public static function infolist(Schema $schema): Schema
{
    return $schema->components([
        Section::make('Customer Details')
            ->schema([
                TextEntry::make('name'),
                TextEntry::make('email')
                    ->copyable(),
                TextEntry::make('status')
                    ->badge()
                    ->color(fn (string $state) => match ($state) {
                        'active' => 'success',
                        'inactive' => 'danger',
                        default => 'gray',
                    }),
                TextEntry::make('created_at')
                    ->dateTime(),
            ])
            ->columns(2),

        Section::make('Additional')
            ->schema([
                IconEntry::make('is_active')
                    ->boolean(),
                ImageEntry::make('avatar')
                    ->circular(),
                ColorEntry::make('brand_color'),
                TextEntry::make('total_orders')
                    ->numeric(),
                TextEntry::make('revenue')
                    ->money('usd'),
            ])
            ->columns(3),
    ]);
}
```

## Entry Types

### TextEntry

```php
TextEntry::make('name')
    ->label('Full Name')
    ->weight('bold')
    ->size('lg')
    ->color('primary')
    ->copyable()
    ->copyMessage('Copied!')
    ->limit(100)
    ->tooltip(fn ($record) => $record->name)
    ->placeholder('Not set')
    ->url(fn ($record) => route('users.show', $record))

// Formatting
TextEntry::make('price')->money('usd', divideBy: 100)
TextEntry::make('created_at')->dateTime()
TextEntry::make('created_at')->since()               // "2 hours ago"
TextEntry::make('count')->numeric(decimalPlaces: 0)

// Badge
TextEntry::make('status')
    ->badge()
    ->color(fn ($state) => match ($state) { ... })
    ->icon(fn ($state) => match ($state) { ... })

// List (HasMany relationship)
TextEntry::make('tags.name')
    ->badge()
    ->separator(',')
    ->listWithLineBreaks()
    ->limitList(5)
    ->expandableLimitedList()
```

### IconEntry

```php
IconEntry::make('is_verified')
    ->boolean()
    ->trueIcon('heroicon-o-check-circle')
    ->falseIcon('heroicon-o-x-circle')
    ->trueColor('success')
    ->falseColor('danger')
```

### ImageEntry

```php
ImageEntry::make('avatar')
    ->circular()
    ->size(80)
    ->defaultImageUrl('https://ui-avatars.com/api/?name=...')
```

### RepeatableEntry

```php
RepeatableEntry::make('comments')
    ->schema([
        TextEntry::make('author.name'),
        TextEntry::make('body'),
        TextEntry::make('created_at')->dateTime(),
    ])
    ->columns(3)
```

### KeyValueEntry

```php
KeyValueEntry::make('metadata')
```

## View Page Setup

Ensure your resource has a View page:

```php
// In getPages()
'view' => Pages\ViewCustomer::route('/{record}'),
```

```php
// ViewCustomer.php
class ViewCustomer extends ViewRecord
{
    protected static string $resource = CustomerResource::class;

    protected function getHeaderActions(): array
    {
        return [
            EditAction::make(),
        ];
    }
}
```
