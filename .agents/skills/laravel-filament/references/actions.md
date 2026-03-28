# Filament v5 — Actions

## Critical: One Namespace for All Actions

```php
use Filament\Actions\Action;           // custom actions
use Filament\Actions\ActionGroup;      // group actions in dropdown
use Filament\Actions\BulkAction;       // bulk operations
use Filament\Actions\BulkActionGroup;  // group bulk actions
use Filament\Actions\CreateAction;
use Filament\Actions\DeleteAction;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Actions\ExportAction;
use Filament\Actions\ForceDeleteAction;
use Filament\Actions\ForceDeleteBulkAction;
use Filament\Actions\ImportAction;
use Filament\Actions\ReplicateAction;
use Filament\Actions\RestoreAction;
use Filament\Actions\RestoreBulkAction;
use Filament\Actions\ViewAction;
```

## Where Actions Appear

### Table Record Actions (per-row)

```php
->recordActions([
    ViewAction::make(),
    EditAction::make(),
    Action::make('suspend')
        ->label('Suspend')
        ->icon('heroicon-o-no-symbol')
        ->color('warning')
        ->requiresConfirmation()
        ->modalHeading('Suspend Agent')
        ->modalDescription('Are you sure?')
        ->modalSubmitActionLabel('Yes, suspend')
        ->visible(fn ($record): bool => $record->status === Status::Active)
        ->action(fn ($record) => app(SuspendAgent::class)->execute($record))
        ->after(function () {
            Notification::make()->title('Agent suspended')->success()->send();
        }),
    DeleteAction::make(),
])
```

### Table Toolbar Actions (bulk actions go here)

```php
->toolbarActions([
    BulkActionGroup::make([
        DeleteBulkAction::make(),
        RestoreBulkAction::make(),
        BulkAction::make('markActive')
            ->label('Mark Active')
            ->icon('heroicon-o-check-circle')
            ->requiresConfirmation()
            ->action(fn ($records) => $records->each->activate())
            ->deselectRecordsAfterCompletion(),
    ]),
])
```

### Table Header Actions

```php
->headerActions([
    CreateAction::make(),
    ImportAction::make()->importer(CustomerImporter::class),
    ExportAction::make()->exporter(CustomerExporter::class),
])
```

### Page Header Actions

```php
// In ListRecords page
protected function getHeaderActions(): array
{
    return [
        CreateAction::make(),
    ];
}

// In EditRecord page
protected function getHeaderActions(): array
{
    return [
        DeleteAction::make(),
        RestoreAction::make(),
        ForceDeleteAction::make(),
    ];
}
```

## Action Configuration Methods

### Visual

```php
Action::make('approve')
    ->label('Approve')
    ->icon('heroicon-o-check')
    ->color('success')                          // success, warning, danger, info, gray
    ->size(Size::Small)                          // Small, Medium, Large
    ->button()                                   // or ->link(), ->iconButton(), ->badge()
    ->outlined()                                 // outlined button style
    ->badge('3')                                 // corner badge
    ->badgeColor('danger')
    ->labeledFrom('md')                          // responsive: icon-only on small screens
```

### Behavior

```php
Action::make('approve')
    ->action(fn ($record) => $record->approve())        // PHP callback
    ->actionJs('alert("done")')                          // JS callback
    ->url(fn ($record) => route('orders.show', $record)) // navigate
    ->urlInNewTab()
    ->requiresConfirmation()                              // show confirm dialog
    ->disabled(fn ($record) => $record->is_locked)        // conditional disable
    ->visible(fn ($record) => $record->canApprove())      // conditional visibility
    ->hidden(fn ($record) => $record->is_archived)
    ->authorize('approve')                                // policy check
```

### Modals with Forms

```php
Action::make('sendEmail')
    ->schema([
        TextInput::make('subject')->required(),
        Textarea::make('body')->required()->rows(5),
    ])
    ->modalHeading('Send Email')
    ->modalDescription('Compose your message')
    ->modalSubmitActionLabel('Send')
    ->modalWidth('lg')                        // sm, md, lg, xl, 2xl, ...
    ->action(function (array $data, $record) {
        // $data['subject'], $data['body'] available
        Mail::to($record->email)->send(new GenericEmail($data));
    })
```

### Lifecycle Hooks

```php
EditAction::make()
    ->beforeFormFilled(function () {
        // Before form populated from database
    })
    ->afterFormFilled(function () {
        // After form populated
    })
    ->beforeFormValidated(function () {
        // Before validation runs
    })
    ->afterFormValidated(function () {
        // After validation passes
    })
    ->before(function () {
        // Before saving to database
    })
    ->after(function () {
        // After saving to database
    })
```

### Bulk Action Specifics

```php
BulkAction::make('export')
    ->action(fn (Collection $records) => /* ... */)
    ->deselectRecordsAfterCompletion()
    ->requiresConfirmation()

// Authorization per record
DeleteBulkAction::make()
    ->authorizeIndividualRecords()

// Chunked processing for large selections
BulkAction::make('process')
    ->chunkSelectedRecords()
    ->action(fn (LazyCollection $records) => /* ... */)

// Limit selection
$table->selectCurrentPageOnly()     // prevent cross-page selection
$table->maxSelectableRecords(100)   // cap total
```

## Utility Injection

Action callbacks can inject these by parameter name:

| Parameter | Type | Description |
|---|---|---|
| `$action` | `Action` | Current action instance |
| `$arguments` | `array` | Arguments passed to action |
| `$data` | `array` | Submitted modal form data |
| `$record` | `Model` | Current Eloquent record |
| `$records` | `Collection` | Selected records (bulk) |
| `$livewire` | `Component` | Livewire component |
| `$table` | `Table` | Table instance (table context) |
| `$model` | `string` | Model FQN |
| `$schemaGet` | `Get` | Read schema field value |
| `$schemaSet` | `Set` | Write schema field value |

## Action Groups

```php
ActionGroup::make([
    ViewAction::make(),
    EditAction::make(),
    DeleteAction::make(),
])
->label('Actions')
->icon('heroicon-m-ellipsis-vertical')
->color('gray')
```

## Rate Limiting

```php
Action::make('sendOtp')
    ->rateLimit(3)                                   // 3 per minute per user
    ->rateLimitedNotificationTitle('Too many attempts')
```
