# Filament v5 — Namespace & Import Map

## The #1 Source of Bugs: Action Namespaces

In v3, actions lived in multiple namespaces. In v5, ALL actions are unified under `Filament\Actions`.

### v5 Correct Imports

```php
// Actions — ALL from one namespace
use Filament\Actions\Action;
use Filament\Actions\ActionGroup;
use Filament\Actions\BulkAction;
use Filament\Actions\BulkActionGroup;
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

// Table columns — still in Tables namespace
use Filament\Tables\Columns\CheckboxColumn;
use Filament\Tables\Columns\ColorColumn;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\ImageColumn;
use Filament\Tables\Columns\SelectColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Columns\TextInputColumn;
use Filament\Tables\Columns\ToggleColumn;

// Filters — still in Tables namespace
use Filament\Tables\Filters\Filter;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Filters\TernaryFilter;

// Table itself
use Filament\Tables\Table;

// Form fields — still in Forms namespace
use Filament\Forms\Components\Checkbox;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\CodeEditor;
use Filament\Forms\Components\ColorPicker;
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Hidden;
use Filament\Forms\Components\KeyValue;
use Filament\Forms\Components\MarkdownEditor;
use Filament\Forms\Components\Radio;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\RichEditor;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Slider;
use Filament\Forms\Components\TagsInput;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Components\ToggleButtons;

// Layout components — NEW Schemas namespace
use Filament\Schemas\Components\Grid;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Components\Tabs;
use Filament\Schemas\Components\Wizard;
use Filament\Schemas\Schema;

// Infolist entries — still in Infolists namespace
use Filament\Infolists\Components\CodeEntry;
use Filament\Infolists\Components\ColorEntry;
use Filament\Infolists\Components\IconEntry;
use Filament\Infolists\Components\ImageEntry;
use Filament\Infolists\Components\KeyValueEntry;
use Filament\Infolists\Components\RepeatableEntry;
use Filament\Infolists\Components\TextEntry;
```

### What DOES NOT EXIST in v5

These will cause fatal errors:

```php
// WRONG — Old table action namespace (DOES NOT EXIST in v5)
use Filament\Tables\Actions\Action;
use Filament\Tables\Actions\EditAction;
use Filament\Tables\Actions\DeleteAction;
use Filament\Tables\Actions\BulkActionGroup;
use Filament\Tables\Actions\DeleteBulkAction;
use Filament\Tables\Actions\ViewAction;

// WRONG — Old form action namespace (DOES NOT EXIST in v5)
use Filament\Forms\Actions\Action;

// WRONG — Removed column class (DOES NOT EXIST in v5)
use Filament\Tables\Columns\BadgeColumn;

// WRONG — Old layout namespace (DOES NOT EXIST in v5)
use Filament\Forms\Components\Section;  // → Filament\Schemas\Components\Section
use Filament\Forms\Components\Grid;     // → Filament\Schemas\Components\Grid
use Filament\Forms\Components\Tabs;     // → Filament\Schemas\Components\Tabs
use Filament\Forms\Components\Wizard;   // → Filament\Schemas\Components\Wizard
```

### Namespace Decision Tree

```
Need an Action?
  → use Filament\Actions\{ActionName}

Need a Table Column?
  → use Filament\Tables\Columns\{ColumnName}
  → Want a badge? Use TextColumn::make()->badge()

Need a Table Filter?
  → use Filament\Tables\Filters\{FilterName}

Need a Form Field?
  → use Filament\Forms\Components\{FieldName}

Need a Layout (Section, Grid, Tabs)?
  → use Filament\Schemas\Components\{LayoutName}

Need an Infolist Entry?
  → use Filament\Infolists\Components\{EntryName}

Need the Table object?
  → use Filament\Tables\Table

Need the Schema object?
  → use Filament\Schemas\Schema
```
