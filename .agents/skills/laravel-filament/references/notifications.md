# Filament v5 — Notifications

## Sending Flash Notifications

```php
use Filament\Notifications\Notification;

// Basic
Notification::make()
    ->title('Saved successfully')
    ->success()
    ->send();

// With body
Notification::make()
    ->title('Order approved')
    ->body('Order #123 has been approved and the customer was notified.')
    ->success()
    ->send();

// Warning
Notification::make()
    ->title('Low stock')
    ->body('Widget X has only 3 items remaining.')
    ->warning()
    ->send();

// Danger
Notification::make()
    ->title('Payment failed')
    ->body('The charge was declined.')
    ->danger()
    ->persistent()                    // requires manual dismissal
    ->send();

// Info
Notification::make()
    ->title('Syncing...')
    ->info()
    ->duration(3000)                  // 3 seconds (default: 6s)
    ->send();

// With icon
Notification::make()
    ->title('Email sent')
    ->icon('heroicon-o-envelope')
    ->iconColor('success')
    ->send();
```

## Notifications with Actions

NOTE: Notification actions use `Filament\Notifications\Actions\Action` — this is separate from the unified `Filament\Actions\Action` used in tables/pages. Do not mix them.

```php
use Filament\Notifications\Actions\Action;   // Notification-specific action class
use Filament\Notifications\Notification;

Notification::make()
    ->title('Order shipped')
    ->body('Track your package')
    ->actions([
        Action::make('track')
            ->label('Track Package')
            ->url('https://tracking.example.com/123', shouldOpenInNewTab: true)
            ->button(),
        Action::make('dismiss')
            ->label('Dismiss')
            ->close(),                // closes notification
    ])
    ->persistent()
    ->send();
```

## Notifications in Actions

```php
use Filament\Actions\Action;
use Filament\Notifications\Notification;

Action::make('approve')
    ->action(function ($record) {
        $record->approve();

        Notification::make()
            ->title('Order approved')
            ->success()
            ->send();
    })

// Or using the built-in success notification
Action::make('approve')
    ->successNotificationTitle('Order approved')
    ->action(fn ($record) => $record->approve())
```

## Duration & Positioning

```php
// Duration
Notification::make()
    ->title('Saved')
    ->success()
    ->seconds(3)                      // shorthand for milliseconds
    ->send();

// Global positioning (in service provider boot)
use Filament\Notifications\Livewire\Notifications;
use Filament\Support\Enums\Alignment;
use Filament\Support\Enums\VerticalAlignment;

Notifications::alignment(Alignment::Center);
Notifications::verticalAlignment(VerticalAlignment::Top);
```

## Database Notifications

Enable in panel:
```php
->databaseNotifications()
->databaseNotificationsPolling('30s')
```

Send:
```php
use Filament\Notifications\Notification;

Notification::make()
    ->title('New order received')
    ->body('Order #456 from John Doe')
    ->icon('heroicon-o-shopping-bag')
    ->actions([
        Action::make('view')
            ->url(OrderResource::getUrl('view', ['record' => $order]))
            ->button(),
    ])
    ->sendToDatabase($admin);       // send to specific user
```
