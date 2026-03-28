# Notifications, Mail, Channels, Queuing

## What

Notifications are multi-channel messages tied to a notifiable entity (typically a User). A single notification class delivers via mail, database, broadcast, and SMS simultaneously. Mailables are email-only classes for complex templates not tied to a specific notifiable.

**Notification** — multi-channel delivery to a user/notifiable (mail + database + SMS + broadcast).
**Mailable** — email-only, complex templates/attachments, or recipient is not a notifiable (external partner, generated report).

Key rules:
- `ShouldQueue` on ALL notifications — never send synchronously
- `toArray()` for database channel — stored in the `notifications` table
- `toMail()` returns `MailMessage` (simple) or a custom `Mailable` (complex)
- Mail config via `.env` — never hardcode SMTP credentials or sender addresses
- Pass computed data from Actions — no business logic inside notification classes

## How

### Notification class — mail + database, queued

```php
<?php
namespace App\Notifications;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Notifications\Notification;

final class OrderShippedNotification extends Notification implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;
    public array $backoff = [30, 60, 120];

    public function __construct(
        private readonly int $orderId,
        private readonly string $trackingNumber,
        private readonly int $totalCents,
    ) {}

    public function via(object $notifiable): array
    {
        return ['mail', 'database'];
    }

    public function toMail(object $notifiable): MailMessage
    {
        return (new MailMessage)
            ->subject('Your order has shipped')
            ->greeting("Hello {$notifiable->name}!")
            ->line("Your order #{$this->orderId} has been shipped.")
            ->line("Tracking number: {$this->trackingNumber}")
            ->action('Track Order', url("/orders/{$this->orderId}/tracking"))
            ->line('Thank you for your purchase.');
    }

    public function toArray(object $notifiable): array
    {
        return [
            'order_id' => $this->orderId,
            'tracking_number' => $this->trackingNumber,
            'total_cents' => $this->totalCents,
            'message' => "Order #{$this->orderId} shipped — tracking: {$this->trackingNumber}",
        ];
    }
}
```

### toMail() with custom Mailable (complex templates)

Return a `Mailable` from `toMail()` when the email needs custom HTML, attachments, or Markdown:

```php
// In the notification's toMail()
public function toMail(object $notifiable): OrderShippedMail
{
    return (new OrderShippedMail(orderId: $this->orderId, trackingNumber: $this->trackingNumber))
        ->to($notifiable->email);
}
```

```php
<?php
namespace App\Mail;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\{Content, Envelope};

final class OrderShippedMail extends Mailable implements ShouldQueue
{
    use Queueable;

    public function __construct(
        private readonly int $orderId,
        private readonly string $trackingNumber,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(subject: "Your order #{$this->orderId} has shipped");
    }

    public function content(): Content
    {
        return new Content(
            markdown: 'emails.order.shipped',
            with: ['orderId' => $this->orderId, 'trackingNumber' => $this->trackingNumber],
        );
    }
}
```

### Markdown mail template

`resources/views/emails/order/shipped.blade.php` — uses Blade components (`<x-mail::message>`, `<x-mail::button>`, `<x-mail::table>`):

```blade
<x-mail::message>
# Order Shipped

Your order **#{{ $orderId }}** is on its way. **Tracking:** {{ $trackingNumber }}

<x-mail::button :url="url('/orders/'.$orderId.'/tracking')">
Track Your Order
</x-mail::button>

Thanks,<br>{{ config('app.name') }}
</x-mail::message>
```

Publish vendor templates to customize: `php artisan vendor:publish --tag=laravel-mail`.

### Sending from an Action

```php
// In App\Actions\ShipOrder (inside DB::transaction)
$order->update(['status' => 'shipped', 'tracking_number' => $trackingNumber]);
$order->user->notify(new OrderShippedNotification(
    orderId: $order->id, trackingNumber: $trackingNumber, totalCents: $order->total_cents,
));
```

### On-demand notifications (recipient not in system)

```php
use Illuminate\Support\Facades\Notification;

Notification::route('mail', 'partner@example.com')
    ->route('vonage', '15551234567')
    ->notify(new InvoiceReadyNotification($invoiceId));
```

### Database channel

Run `php artisan notifications:table && php artisan migrate`. The `toArray()` return is stored as JSON in the `data` column.

```php
$user->unreadNotifications;                       // query unread
$user->unreadNotifications->markAsRead();          // mark all read
$user->notifications()->where('type', OrderShippedNotification::class)->latest()->first();
```

### SMS and broadcast channels

```php
public function via(object $notifiable): array
{
    $channels = ['database'];
    if ($notifiable->prefers_email) { $channels[] = 'mail'; }
    if ($notifiable->phone) { $channels[] = 'vonage'; }        // SMS
    if ($notifiable->is_online) { $channels[] = 'broadcast'; } // Reverb
    return $channels;
}

public function toVonage(object $notifiable): \Illuminate\Notifications\Messages\VonageMessage
{
    return (new VonageMessage)->content("Order #{$this->orderId} shipped. Track: {$this->trackingNumber}");
}

public function toBroadcast(object $notifiable): \Illuminate\Notifications\Messages\BroadcastMessage
{
    return new BroadcastMessage($this->toArray($notifiable));
}
```

### Notification events — delivery tracking

```php
// AppServiceProvider::boot()
use Illuminate\Notifications\Events\{NotificationSent, NotificationFailed};

Event::listen(NotificationSent::class, function (NotificationSent $event) {
    Log::info('Notification delivered', [
        'notification' => get_class($event->notification),
        'channel' => $event->channel, 'notifiable_id' => $event->notifiable->id,
    ]);
});

Event::listen(NotificationFailed::class, function (NotificationFailed $event) {
    Log::error('Notification failed', [
        'notification' => get_class($event->notification),
        'channel' => $event->channel, 'notifiable_id' => $event->notifiable->id,
    ]);
});
```

### Mail configuration

`.env` — select one mailer:

```env
# SMTP (default — works with Mailtrap/local dev)
MAIL_MAILER=smtp
MAIL_HOST=smtp.mailtrap.io
MAIL_PORT=587
MAIL_USERNAME=null
MAIL_PASSWORD=null
MAIL_ENCRYPTION=tls

# Amazon SES (requires aws/aws-sdk-php)
MAIL_MAILER=ses

# Mailgun (requires symfony/mailgun-mailer + symfony/http-client)
MAIL_MAILER=mailgun
MAILGUN_DOMAIN=mg.example.com
MAILGUN_SECRET=key-xxx

# Shared
MAIL_FROM_ADDRESS=noreply@example.com
MAIL_FROM_NAME="${APP_NAME}"
```

### Testing — Notification::fake() and Mail::fake()

```php
use App\Notifications\OrderShippedNotification;
use App\Mail\OrderShippedMail;
use Illuminate\Support\Facades\{Notification, Mail};

test('order shipment sends notification to user', function () {
    Notification::fake();
    $user = User::factory()->create();
    $order = Order::factory()->for($user)->create();

    (new ShipOrder)->execute($order->id, 'TRACK123');

    Notification::assertSentTo($user, OrderShippedNotification::class, function ($notification, $channels) {
        expect($channels)->toContain('mail', 'database');
        return true;
    });
    Notification::assertNotSentTo($user, InvoiceNotification::class);
});

test('standalone mailable has correct content', function () {
    Mail::fake();
    Mail::to('test@example.com')->send(new OrderShippedMail(orderId: 1, trackingNumber: 'TRACK123'));

    Mail::assertSent(OrderShippedMail::class, fn ($mail) => $mail->hasTo('test@example.com'));
});

test('mailable renders expected html', function () {
    $mail = new OrderShippedMail(orderId: 42, trackingNumber: 'TRACK999');
    $mail->assertSeeInHtml('TRACK999');
    $mail->assertSeeInHtml('42');
});
```

## When

| Situation | Approach |
|---|---|
| Message to a user across mail + database + SMS | Notification with `via()` returning multiple channels |
| Simple transactional email to a user | Notification with `toMail()` returning `MailMessage` |
| Complex email with custom template/attachments | Notification with `toMail()` returning a custom `Mailable` |
| Email not tied to any user (reports, partner comms) | Standalone `Mailable` via `Mail::to()->send()` |
| Recipient not in the system | On-demand: `Notification::route('mail', $email)->notify(...)` |
| In-app notification center | Database channel + `toArray()`, query via `$user->unreadNotifications` |
| Real-time push to client | Broadcast channel + `toBroadcast()` — requires Reverb (see `queues-jobs.md`) |
| Delivery tracking/alerting | Listen to `NotificationSent` / `NotificationFailed` events |

## Never

- **Never send notifications synchronously.** Always implement `ShouldQueue`. Synchronous mail/SMS blocks the HTTP request for seconds.
- **Never put business logic in notification classes.** Compute in the Action, pass scalars to the constructor:
  ```php
  // WRONG: querying inside a notification
  public function toMail(object $notifiable): MailMessage {
      $order = Order::with('items')->find($this->orderId); // query belongs in the Action
  }
  // RIGHT: constructor receives computed data
  public function __construct(private readonly int $orderId, private readonly string $trackingNumber) {}
  ```
- **Never hardcode email addresses in notification classes.** Use `config('mail.from.address')` or pass from the Action.
- **Never skip `toArray()` when using the database channel.** Without it, the `data` column is empty.
- **Never use `Mail::raw()` for transactional emails.** Use a Mailable or MailMessage. Raw strings are unmaintainable.
- **Never store SMTP passwords or API keys in config files.** `.env` locally, real environment variables in production.
- **Never send the same message as both a Notification and a standalone Mailable.** Notification for user-tied multi-channel; Mailable for email-only non-user scenarios.
