# Filament v5 — Resources

## Generate

```bash
php artisan make:filament-resource Customer
php artisan make:filament-resource Customer --generate          # auto-generates form/table from DB schema
php artisan make:filament-resource Customer --simple             # modal-based CRUD (single page)
php artisan make:filament-resource Customer --soft-deletes       # adds soft delete support
php artisan make:filament-resource Customer --view               # adds a dedicated View page
php artisan make:filament-resource Customer --model --migration --factory  # scaffolds model too
```

## Generated Structure (v5)

```
app/Filament/Resources/
├── CustomerResource.php              # Main resource class
├── CustomerResource/
│   ├── Pages/
│   │   ├── CreateCustomer.php
│   │   ├── EditCustomer.php
│   │   └── ListCustomers.php
│   ├── Schemas/
│   │   └── CustomerForm.php          # Extracted form schema class
│   └── Tables/
│       └── CustomersTable.php        # Extracted table class
```

## Resource Class Structure

```php
namespace App\Filament\Resources;

use App\Filament\Resources\Customers\Pages;
use App\Filament\Resources\Customers\Schemas\CustomerForm;
use App\Filament\Resources\Customers\Tables\CustomersTable;
use App\Models\Customer;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Tables\Table;

class CustomerResource extends Resource
{
    protected static ?string $model = Customer::class;

    // Navigation
    protected static ?string $navigationIcon = 'heroicon-o-users';
    protected static ?string $navigationGroup = 'CRM';
    protected static ?int $navigationSort = 1;
    protected static ?string $navigationLabel = 'Customers';
    protected static ?string $modelLabel = 'Customer';
    protected static ?string $pluralModelLabel = 'Customers';
    protected static ?string $slug = 'customers';            // custom URL path
    protected static ?string $recordTitleAttribute = 'name'; // for global search

    // Form — delegates to extracted class
    public static function form(Schema $schema): Schema
    {
        return CustomerForm::configure($schema);
    }

    // Table — delegates to extracted class
    public static function table(Table $table): Table
    {
        return CustomersTable::configure($table);
    }

    // Pages
    public static function getPages(): array
    {
        return [
            'index'  => Pages\ListCustomers::route('/'),
            'create' => Pages\CreateCustomer::route('/create'),
            'edit'   => Pages\EditCustomer::route('/{record}/edit'),
            'view'   => Pages\ViewCustomer::route('/{record}'),
        ];
    }

    // Relation managers
    public static function getRelations(): array
    {
        return [
            // OrdersRelationManager::class,
        ];
    }

    // Navigation badge
    public static function getNavigationBadge(): ?string
    {
        return (string) static::getModel()::count();
    }

    public static function getNavigationBadgeColor(): string|array|null
    {
        return 'info';
    }

    // Eloquent query customization
    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()
            ->withoutGlobalScope('org');  // remove tenant scope for admin
    }

    // Disable creation from admin
    public static function canCreate(): bool
    {
        return false;
    }
}
```

## Schema Class (Extracted Form)

```php
namespace App\Filament\Resources\Customers\Schemas;

use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

class CustomerForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                Section::make('Customer Details')
                    ->schema([
                        TextInput::make('name')
                            ->required()
                            ->maxLength(255),
                        TextInput::make('email')
                            ->email()
                            ->required()
                            ->unique(ignoreRecord: true),
                        Select::make('status')
                            ->options(CustomerStatus::class)
                            ->required(),
                        Toggle::make('is_active')
                            ->default(true),
                    ])
                    ->columns(2),
            ]);
    }
}
```

## Table Class (Extracted Table)

```php
namespace App\Filament\Resources\Customers\Tables;

use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Actions\ViewAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class CustomersTable
{
    public static function configure(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')
                    ->searchable()
                    ->sortable(),
                TextColumn::make('email')
                    ->searchable(),
                TextColumn::make('status')
                    ->badge()
                    ->color(fn (string $state): string => match ($state) {
                        'active' => 'success',
                        'inactive' => 'danger',
                        default => 'gray',
                    }),
                TextColumn::make('created_at')
                    ->dateTime()
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
            ])
            ->defaultSort('created_at', 'desc')
            ->filters([
                SelectFilter::make('status')
                    ->options(CustomerStatus::class),
            ])
            ->recordActions([
                ViewAction::make(),
                EditAction::make(),
            ])
            ->toolbarActions([
                BulkActionGroup::make([
                    DeleteBulkAction::make(),
                ]),
            ]);
    }
}
```

## Page Classes

### List Page

```php
namespace App\Filament\Resources\Customers\Pages;

use App\Filament\Resources\CustomerResource;
use Filament\Actions\CreateAction;
use Filament\Resources\Pages\ListRecords;

class ListCustomers extends ListRecords
{
    protected static string $resource = CustomerResource::class;

    protected function getHeaderActions(): array
    {
        return [
            CreateAction::make(),
        ];
    }
}
```

### Edit Page

```php
namespace App\Filament\Resources\Customers\Pages;

use App\Filament\Resources\CustomerResource;
use Filament\Actions\DeleteAction;
use Filament\Actions\RestoreAction;
use Filament\Resources\Pages\EditRecord;

class EditCustomer extends EditRecord
{
    protected static string $resource = CustomerResource::class;

    protected function getHeaderActions(): array
    {
        return [
            DeleteAction::make(),
            RestoreAction::make(),
        ];
    }
}
```

## Authorization

Filament auto-detects Laravel Policies. If `CustomerPolicy` exists:

| Policy Method | Effect |
|---|---|
| `viewAny()` → false | Hidden from navigation, list page 403 |
| `create()` → false | "New" button hidden |
| `update()` → false | Edit action/page hidden |
| `delete()` → false | Delete action hidden |
| `forceDelete()` → false | Force-delete hidden |
| `restore()` → false | Restore action hidden |
| `reorder()` → false | Reorder disabled |

Skip authorization (rare): `protected static bool $shouldSkipAuthorization = true;`

## Global Search

Set `$recordTitleAttribute` on the resource for basic global search. For multi-column search:

```php
public static function getGloballySearchableAttributes(): array
{
    return ['name', 'email', 'phone'];
}

public static function getGlobalSearchResultDetails(Model $record): array
{
    return [
        'Email' => $record->email,
        'Status' => $record->status->getLabel(),
    ];
}
```

## URL Generation

```php
CustomerResource::getUrl();                                    // /admin/customers
CustomerResource::getUrl('create');                            // /admin/customers/create
CustomerResource::getUrl('edit', ['record' => $customer]);     // /admin/customers/edit/1
CustomerResource::getUrl('view', ['record' => $customer]);     // /admin/customers/1
```

## Record Sub-Navigation (Tabs between Edit/View/Relations)

```php
public static function getRecordSubNavigation(Page $page): array
{
    return $page->generateNavigationItems([
        Pages\ViewCustomer::class,
        Pages\EditCustomer::class,
        Pages\ManageAddresses::class,
    ]);
}

// Position: Start (default), End, or Top (renders as tabs)
protected static SubNavigationPosition $subNavigationPosition = SubNavigationPosition::Top;
```
