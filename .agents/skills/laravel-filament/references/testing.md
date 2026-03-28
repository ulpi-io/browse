# Filament v5 — Testing

## Setup

Filament provides test helpers for Pest and PHPUnit. All examples use Pest.

```php
use function Pest\Livewire\livewire;
```

## Testing Resources

### List Page

```php
use App\Filament\Resources\Customers\Pages\ListCustomers;
use App\Models\Customer;

it('can list customers', function () {
    $customers = Customer::factory()->count(5)->create();

    livewire(ListCustomers::class)
        ->assertCanSeeTableRecords($customers);
});

it('can search customers by name', function () {
    $customer = Customer::factory()->create(['name' => 'John Doe']);
    $other = Customer::factory()->create(['name' => 'Jane Smith']);

    livewire(ListCustomers::class)
        ->searchTable('John')
        ->assertCanSeeTableRecords([$customer])
        ->assertCanNotSeeTableRecords([$other]);
});

it('can sort customers by name', function () {
    $customers = Customer::factory()->count(3)->create();

    livewire(ListCustomers::class)
        ->sortTable('name')
        ->assertCanSeeTableRecords($customers->sortBy('name'), inOrder: true);
});

it('can filter customers by status', function () {
    $active = Customer::factory()->create(['status' => 'active']);
    $inactive = Customer::factory()->create(['status' => 'inactive']);

    livewire(ListCustomers::class)
        ->filterTable('status', 'active')
        ->assertCanSeeTableRecords([$active])
        ->assertCanNotSeeTableRecords([$inactive]);
});
```

### Create Page

```php
use App\Filament\Resources\Customers\Pages\CreateCustomer;

it('can create a customer', function () {
    livewire(CreateCustomer::class)
        ->fillForm([
            'name' => 'New Customer',
            'email' => 'new@example.com',
            'status' => 'active',
        ])
        ->call('create')
        ->assertHasNoFormErrors();

    expect(Customer::where('email', 'new@example.com')->exists())->toBeTrue();
});

it('validates required fields', function () {
    livewire(CreateCustomer::class)
        ->fillForm([
            'name' => '',
            'email' => '',
        ])
        ->call('create')
        ->assertHasFormErrors(['name' => 'required', 'email' => 'required']);
});
```

### Edit Page

```php
use App\Filament\Resources\Customers\Pages\EditCustomer;

it('can edit a customer', function () {
    $customer = Customer::factory()->create();

    livewire(EditCustomer::class, ['record' => $customer->getRouteKey()])
        ->assertFormSet([
            'name' => $customer->name,
            'email' => $customer->email,
        ])
        ->fillForm([
            'name' => 'Updated Name',
        ])
        ->call('save')
        ->assertHasNoFormErrors();

    expect($customer->fresh()->name)->toBe('Updated Name');
});
```

### Testing Actions

```php
use Filament\Actions\Testing\TestAction;

it('can suspend an agent', function () {
    $agent = Agent::factory()->create(['status' => 'active']);

    livewire(ListAgents::class)
        ->callTableAction('suspend', $agent)
        ->assertNotified('Agent suspended');

    expect($agent->fresh()->status)->toBe('suspended');
});

it('cannot suspend an already suspended agent', function () {
    $agent = Agent::factory()->create(['status' => 'suspended']);

    livewire(ListAgents::class)
        ->assertTableActionHidden('suspend', $agent);
});

// Testing bulk actions
it('can bulk delete customers', function () {
    $customers = Customer::factory()->count(3)->create();

    livewire(ListCustomers::class)
        ->callTableBulkAction('delete', $customers)
        ->assertNotified();

    expect(Customer::count())->toBe(0);
});

// Testing page header actions
it('can delete from edit page', function () {
    $customer = Customer::factory()->create();

    livewire(EditCustomer::class, ['record' => $customer->getRouteKey()])
        ->callAction('delete')
        ->assertRedirect(ListCustomers::getUrl());
});

// Testing action with form data
it('can send email via action', function () {
    $customer = Customer::factory()->create();

    livewire(ListCustomers::class)
        ->callTableAction('sendEmail', $customer, data: [
            'subject' => 'Hello',
            'body' => 'World',
        ])
        ->assertNotified('Email sent');
});
```

### Testing Schema Components

```php
it('has the correct form fields', function () {
    livewire(CreateCustomer::class)
        ->assertFormFieldExists('name')
        ->assertFormFieldExists('email')
        ->assertFormFieldExists('status');
});

it('has the correct table columns', function () {
    livewire(ListCustomers::class)
        ->assertTableColumnExists('name')
        ->assertTableColumnExists('email')
        ->assertTableColumnExists('status');
});
```

## Common Test Assertions

| Assertion | Description |
|---|---|
| `assertCanSeeTableRecords($records)` | Records visible in table |
| `assertCanNotSeeTableRecords($records)` | Records not visible |
| `assertHasNoFormErrors()` | Form submitted without errors |
| `assertHasFormErrors(['field' => 'rule'])` | Specific validation errors |
| `assertFormSet(['field' => 'value'])` | Form fields match values |
| `assertNotified()` | A notification was sent |
| `assertNotified('Title')` | Specific notification sent |
| `assertTableActionHidden('name', $record)` | Action hidden for record |
| `assertTableActionVisible('name', $record)` | Action visible for record |
| `assertFormFieldExists('name')` | Field exists in form |
| `assertTableColumnExists('name')` | Column exists in table |
