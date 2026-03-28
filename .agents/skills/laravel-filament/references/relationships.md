# Filament v5 — Managing Relationships

## Choosing the Right Tool

| Relationship Type | Best Tool | When |
|---|---|---|
| HasMany, HasManyThrough, MorphMany | Relation Manager | Interactive table below form |
| HasMany, MorphMany (few fields) | Repeater | Fields inline in owner form |
| BelongsTo, MorphTo | Select | Dropdown picker |
| BelongsToMany | Select (multiple) or CheckboxList | Choose existing records |
| HasOne, MorphOne, BelongsTo | Layout component with `->relationship()` | Fields inline in owner form |

## Relation Managers

Generate:
```bash
php artisan make:filament-relation-manager OrderResource items product_id
```

### Basic Structure

```php
namespace App\Filament\Resources\OrderResource\RelationManagers;

use Filament\Actions\CreateAction;
use Filament\Actions\DeleteAction;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\TextInput;
use Filament\Resources\RelationManagers\RelationManager;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

class ItemsRelationManager extends RelationManager
{
    protected static string $relationship = 'items';

    public function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required(),
            TextInput::make('quantity')->numeric()->required(),
        ]);
    }

    public function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name'),
                TextColumn::make('quantity'),
            ])
            ->headerActions([
                CreateAction::make(),
            ])
            ->recordActions([
                EditAction::make(),
                DeleteAction::make(),
            ])
            ->toolbarActions([
                DeleteBulkAction::make(),
            ]);
    }
}
```

### Register in Resource

```php
public static function getRelations(): array
{
    return [
        ItemsRelationManager::class,
    ];
}
```

### Accessing Owner Record

```php
->action(function ($record) {
    $owner = $this->getOwnerRecord();  // the parent record
    // ...
})
```

### Read-Only Mode

```php
public function isReadOnly(): bool
{
    return true;    // disables all create/edit/delete
}
```

### BelongsToMany (Attach/Detach)

```php
class TagsRelationManager extends RelationManager
{
    protected static string $relationship = 'tags';

    public function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name'),
            ])
            ->headerActions([
                AttachAction::make()        // attach existing records
                    ->preloadRecordSelect()
                    ->recordSelectSearchColumns(['name']),
            ])
            ->recordActions([
                DetachAction::make(),       // detach (not delete)
            ])
            ->toolbarActions([
                DetachBulkAction::make(),
            ]);
    }
}
```

### Pivot Attributes

```php
// In listing
TextColumn::make('pivot.quantity')

// In creation
CreateAction::make()
    ->mutateFormDataUsing(function (array $data): array {
        $data['pivot']['quantity'] = 1;
        return $data;
    })

// In attach form
AttachAction::make()
    ->form(fn (AttachAction $action): array => [
        $action->getRecordSelect(),
        TextInput::make('quantity')->numeric()->required(),
    ])
```

### Customizing Eloquent Query

```php
protected function getTableQuery(): Builder
{
    return parent::getTableQuery()
        ->withoutGlobalScopes()
        ->where('is_active', true);
}
```

### Conditionally Showing

```php
public static function canViewForRecord(Model $ownerRecord, string $pageClass): bool
{
    return $ownerRecord->status === 'active';
}
```

## Select with Relationships (in Forms)

```php
// BelongsTo
Select::make('author_id')
    ->relationship('author', 'name')
    ->searchable()
    ->preload()
    ->createOptionForm([
        TextInput::make('name')->required(),
        TextInput::make('email')->required()->email(),
    ])

// BelongsToMany (multi-select)
Select::make('tags')
    ->multiple()
    ->relationship('tags', 'name')
    ->preload()
    ->searchable()

// With scope removal
Select::make('org_id')
    ->relationship('organization', 'name', fn (Builder $query) =>
        $query->withoutGlobalScopes())
```

## CheckboxList with Relationships

```php
CheckboxList::make('roles')
    ->relationship('roles', 'name')
    ->searchable()
    ->bulkToggleable()
    ->columns(3)
```

## Repeater with Relationships

```php
Repeater::make('addresses')
    ->relationship()                    // auto-detects HasMany
    ->schema([
        TextInput::make('street')->required(),
        TextInput::make('city')->required(),
        Select::make('country_id')
            ->relationship('country', 'name'),
    ])
    ->columns(2)
    ->minItems(1)
    ->maxItems(5)
    ->orderColumn('sort_order')
    ->collapsible()
```

## Layout Components with Single Relationships

For HasOne, MorphOne, BelongsTo — embed fields directly:

```php
use Filament\Schemas\Components\Section;

Section::make('Address')
    ->relationship('address')           // HasOne
    ->schema([
        TextInput::make('street'),
        TextInput::make('city'),
        TextInput::make('zip'),
    ])
```
