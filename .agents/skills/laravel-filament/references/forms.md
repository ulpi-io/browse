# Filament v5 — Forms & Schema Components

## Schema Structure (v5)

In v5, the `form()` method accepts `Schema` instead of `Form`:

```php
use Filament\Schemas\Schema;

public static function form(Schema $schema): Schema
{
    return $schema->components([
        // Layout and field components here
    ]);
}
```

## Layout Components (from Schemas package)

```php
use Filament\Schemas\Components\Grid;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Components\Tabs;
use Filament\Schemas\Components\Wizard;

// Section
Section::make('Details')
    ->description('Enter customer details')
    ->schema([...])
    ->columns(2)               // 2-column grid inside section
    ->collapsible()            // can collapse
    ->collapsed()              // starts collapsed
    ->icon('heroicon-o-user')

// Grid
Grid::make(2)
    ->schema([...])            // 2-column grid

// Tabs
Tabs::make('Settings')
    ->tabs([
        Tabs\Tab::make('General')
            ->icon('heroicon-o-cog')
            ->schema([...]),
        Tabs\Tab::make('Advanced')
            ->schema([...])
            ->badge(5),         // badge count on tab
    ])

// Wizard
Wizard::make([
    Wizard\Step::make('Details')
        ->schema([...]),
    Wizard\Step::make('Billing')
        ->schema([...]),
])
```

## Form Field Components

### TextInput

```php
use Filament\Forms\Components\TextInput;

TextInput::make('name')
    ->required()
    ->maxLength(255)
    ->minLength(2)
    ->unique(ignoreRecord: true)      // unique validation, skip current record
    ->email()                          // email validation + input type
    ->tel()                            // telephone input
    ->url()                            // URL validation
    ->password()                       // masked input
    ->numeric()                        // numeric input
    ->integer()                        // integer only
    ->minValue(0)
    ->maxValue(100)
    ->step(0.01)
    ->prefix('$')
    ->suffix('.00')
    ->prefixIcon('heroicon-o-currency-dollar')
    ->placeholder('Enter name...')
    ->helperText('This will be visible to customers')
    ->hint('Max 255 characters')
    ->hintIcon('heroicon-o-information-circle')
    ->autocomplete('off')
    ->autofocus()
    ->live()                            // triggers reactivity on change
    ->live(onBlur: true)                // triggers on blur instead
    ->debounce(500)                     // debounce live updates
    ->afterStateUpdated(fn (Set $set, ?string $state) =>
        $set('slug', Str::slug($state)))
    ->alphaDash()                       // alpha-numeric + dashes
    ->regex('/^[a-z]+$/')               // custom regex
    ->disabled()
    ->readOnly()
    ->hidden()
    ->default('value')
    ->formatStateUsing(fn (?string $state) => strtoupper($state))   // transform for display
    ->dehydrateStateUsing(fn (?string $state) => strtolower($state)) // transform before save
```

### Select

```php
use Filament\Forms\Components\Select;

// Static options
Select::make('status')
    ->options([
        'draft' => 'Draft',
        'published' => 'Published',
    ])
    ->required()
    ->searchable()
    ->native(false)                    // use Filament's custom select (not browser native)

// From enum
Select::make('status')
    ->options(Status::class)
    ->required()

// BelongsTo relationship
Select::make('author_id')
    ->relationship('author', 'name')
    ->searchable()
    ->preload()                         // load all options upfront
    ->createOptionForm([                // inline creation
        TextInput::make('name')->required(),
        TextInput::make('email')->required()->email(),
    ])
    ->editOptionForm([                  // inline edit
        TextInput::make('name')->required(),
        TextInput::make('email')->required()->email(),
    ])

// Multiple (BelongsToMany)
Select::make('tags')
    ->multiple()
    ->relationship('tags', 'name')
    ->preload()
    ->searchable()

// Scoped options
Select::make('org_id')
    ->relationship('organization', 'name', fn (Builder $query) =>
        $query->withoutGlobalScopes())
    ->searchable()
    ->preload()
```

### Toggle & Checkbox

```php
use Filament\Forms\Components\Toggle;
use Filament\Forms\Components\Checkbox;

Toggle::make('is_active')
    ->default(true)
    ->onColor('success')
    ->offColor('danger')
    ->inline(false)

Checkbox::make('accept_terms')
    ->accepted()                        // must be checked
    ->label('I accept the terms')
```

### DatePicker / DateTimePicker

```php
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Components\DateTimePicker;

DatePicker::make('due_date')
    ->native(false)                     // Filament date picker
    ->minDate(now())
    ->maxDate(now()->addYear())
    ->displayFormat('d/m/Y')
    ->format('Y-m-d')                  // database format
    ->closeOnDateSelection()

DateTimePicker::make('published_at')
    ->native(false)
    ->seconds(false)
    ->timezone('America/New_York')
```

### Textarea

```php
use Filament\Forms\Components\Textarea;

Textarea::make('notes')
    ->rows(4)
    ->maxLength(2000)
    ->autosize()                        // auto-grow
    ->helperText('Supports plain text only')
    ->formatStateUsing(fn ($state) => json_encode($state, JSON_PRETTY_PRINT))
    ->dehydrateStateUsing(fn ($state) => json_decode($state, true))
```

### FileUpload

```php
use Filament\Forms\Components\FileUpload;

FileUpload::make('avatar')
    ->image()
    ->disk('s3')
    ->directory('avatars')
    ->maxSize(5120)                     // 5MB
    ->acceptedFileTypes(['image/jpeg', 'image/png'])
    ->imageEditor()                     // built-in image editor
    ->imageCropAspectRatio('1:1')
    ->imageResizeTargetWidth(200)

FileUpload::make('documents')
    ->multiple()
    ->disk('s3')
    ->directory('documents')
    ->reorderable()
    ->maxFiles(10)
```

### Repeater

```php
use Filament\Forms\Components\Repeater;

Repeater::make('items')
    ->schema([
        TextInput::make('name')->required(),
        TextInput::make('quantity')->numeric()->required(),
    ])
    ->columns(2)
    ->minItems(1)
    ->maxItems(10)
    ->defaultItems(1)
    ->collapsible()
    ->reorderable()
    ->orderColumn('sort_order')

// With HasMany relationship
Repeater::make('addresses')
    ->relationship()
    ->schema([...])
```

### Other Fields

```php
// Rich editor
RichEditor::make('body')
    ->toolbarButtons(['bold', 'italic', 'link', 'h2', 'h3', 'bulletList', 'orderedList'])
    ->maxLength(65535)

// Tags input
TagsInput::make('tags')
    ->suggestions(['Laravel', 'PHP', 'Vue'])
    ->separator(',')

// Key-value
KeyValue::make('metadata')
    ->keyLabel('Key')
    ->valueLabel('Value')
    ->addActionLabel('Add Row')

// Color picker
ColorPicker::make('brand_color')
    ->hex()

// Hidden field
Hidden::make('user_id')
    ->default(auth()->id())

// Radio
Radio::make('plan')
    ->options(['basic' => 'Basic', 'pro' => 'Pro', 'enterprise' => 'Enterprise'])
    ->descriptions(['basic' => 'For small teams', 'pro' => 'For growing businesses'])
    ->inline()

// CheckboxList
CheckboxList::make('roles')
    ->relationship('roles', 'name')
    ->searchable()
    ->bulkToggleable()
    ->columns(3)
```

## Reactivity & Dependencies

```php
// Live updates — field must be ->live() to trigger re-renders
Select::make('country')
    ->options(Country::pluck('name', 'id'))
    ->live()                              // REQUIRED for reactivity
    ->afterStateUpdated(fn (Set $set) => $set('city', null)),

Select::make('city')
    ->options(fn (Get $get) =>            // re-evaluated when country changes
        City::where('country_id', $get('country'))->pluck('name', 'id'))
    ->visible(fn (Get $get) => filled($get('country'))),
```

## Validation

```php
TextInput::make('email')
    ->required()
    ->email()
    ->unique(table: User::class, column: 'email', ignoreRecord: true)
    ->rules(['max:255'])                  // raw Laravel rules
    ->rule(new MyCustomRule())            // custom rule object

// Conditional validation
TextInput::make('phone')
    ->requiredWith('address')
    ->requiredWithout('email')

// Operation-specific visibility
TextInput::make('password')
    ->visibleOn('create')                 // only show on create
    ->hiddenOn('edit')                    // hide on edit
```

## Dependency Injection in Callbacks

All closures can inject by parameter name:

| Parameter | Description |
|---|---|
| `$get` / `$schemaGet` | Read another field's value |
| `$set` / `$schemaSet` | Set another field's value |
| `$record` | Current Eloquent record (null on create) |
| `$operation` | 'create', 'edit', or 'view' |
| `$livewire` | Livewire component instance |
| `$component` | Current component instance |
| `$state` | Current field value |
