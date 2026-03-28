# Form Requests

## What

Form Requests are dedicated classes for HTTP input validation and request-level authorization. Every controller method that accepts input uses a Form Request — never inline `$request->validate()`. Form Requests live in `app/Http/Requests/{Domain}/`, named `{Verb}{Resource}Request` (e.g., `StoreOrderRequest`, `UpdateUserRequest`).

Create with: `php artisan make:request StoreOrderRequest`

Core methods: `rules()` (field validation), `authorize()` (delegates to Policies), `prepareForValidation()` (normalize input before rules run), `messages()` (custom error messages).

## How

### Complete Form Request example

```php
namespace App\Http\Requests\Order;

use App\Enums\OrderStatus;
use App\Models\Order;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rules\Enum;

final class StoreOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('create', Order::class);
    }

    public function rules(): array
    {
        return [
            'customer_email'          => ['required', 'email:rfc,dns', 'max:255'],
            'status'                  => ['required', new Enum(OrderStatus::class)],
            'notes'                   => ['nullable', 'string', 'max:1000'],
            'shipping_address'        => ['required', 'array'],
            'shipping_address.street' => ['required', 'string', 'max:255'],
            'shipping_address.city'   => ['required', 'string', 'max:100'],
            'shipping_address.zip'    => ['required', 'string', 'max:20'],
            'items'                   => ['required', 'array', 'min:1'],
            'items.*.product_id'      => ['required', 'exists:products,id'],
            'items.*.quantity'        => ['required', 'integer', 'min:1', 'max:100'],
            'coupon_code'             => ['nullable', 'string', 'exists:coupons,code'],
            'attachment'              => ['nullable', 'file', 'mimes:pdf,jpg,png', 'max:10240'],
        ];
    }

    public function prepareForValidation(): void
    {
        $this->merge([
            'customer_email' => strtolower(trim($this->customer_email ?? '')),
            'coupon_code'    => $this->coupon_code ? strtoupper(trim($this->coupon_code)) : null,
        ]);
    }

    public function messages(): array
    {
        return [
            'items.required'             => 'At least one order item is required.',
            'items.*.product_id.exists'  => 'Product :input does not exist.',
            'items.*.quantity.max'       => 'Quantity per item cannot exceed 100.',
            'attachment.max'             => 'Attachment must not exceed 10 MB.',
        ];
    }
}
```

### authorize() with Policies

Delegate to Policies via `$this->user()->can()`. When `authorize()` returns `false`, Laravel returns a 403 JSON response automatically.

```php
// Store — pass the model class
public function authorize(): bool { return $this->user()->can('create', Order::class); }

// Update / Delete — pass the route-bound model instance
public function authorize(): bool { return $this->user()->can('update', $this->route('order')); }

// No authorization needed — be explicit
public function authorize(): bool { return true; }
```

### Update request with unique-ignore

```php
final class UpdateUserRequest extends FormRequest
{
    public function authorize(): bool
    {
        return $this->user()->can('update', $this->route('user'));
    }

    public function rules(): array
    {
        return [
            'name'  => ['sometimes', 'string', 'max:255'],
            'email' => [
                'sometimes', 'email:rfc,dns',
                Rule::unique('users')->ignore($this->route('user')),
            ],
        ];
    }
}
```

### Custom validation rules

Create with `php artisan make:rule ValidCouponCode`:

```php
namespace App\Rules;

use App\Models\Coupon;
use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

final class ValidCouponCode implements ValidationRule
{
    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        $coupon = Coupon::where('code', $value)->where('expires_at', '>', now())->first();
        if (! $coupon) {
            $fail('The :attribute is invalid or expired.');
        }
    }
}
```

Use in rules: `'coupon_code' => ['nullable', 'string', new ValidCouponCode]`.

### Conditional validation

```php
'payment_method' => ['required', 'in:card,bank_transfer,cash'],
'card_number'    => ['required_if:payment_method,card', 'string', 'size:16'],
'card_expiry'    => ['required_if:payment_method,card', 'date_format:m/Y'],
'bank_account'   => [
    Rule::when($this->payment_method === 'bank_transfer', ['required', 'string', 'max:34'], ['prohibited']),
],
'shipping_address' => ['required_unless:is_draft,true', 'array'],
```

### File upload validation

```php
'avatar' => [
    'required', 'image', 'mimes:jpg,png,webp', 'max:5120',
    'dimensions:min_width=200,min_height=200,max_width=2000,max_height=2000',
],
'documents'   => ['required', 'array', 'max:5'],
'documents.*' => ['file', 'mimes:pdf,docx', 'max:20480'],
```

Cross-reference `file-storage.md` for handling validated uploads (Storage facade, S3, media library).

### Nested and array validation

```php
'address'               => ['required', 'array'],           // nested object — dot notation
'address.street'        => ['required', 'string', 'max:255'],
'address.zip'           => ['required', 'string', 'regex:/^\d{5}(-\d{4})?$/'],
'contacts'              => ['required', 'array', 'min:1', 'max:10'],  // array — wildcard
'contacts.*.name'       => ['required', 'string', 'max:255'],
'contacts.*.email'      => ['required', 'email:rfc,dns'],
'items'                 => ['required', 'array', 'min:1'],  // deeply nested
'items.*.product_id'    => ['required', 'exists:products,id'],
'items.*.options'       => ['nullable', 'array'],
'items.*.options.size'  => ['nullable', 'in:S,M,L,XL'],
```

## When

| Scenario | Approach |
|----------|----------|
| Controller method accepts input | Dedicated Form Request class |
| Creating a resource | `StoreOrderRequest` — fields use `required` |
| Updating a resource | `UpdateOrderRequest` — fields use `sometimes` |
| Resource-level authorization | `authorize()` with `$this->user()->can()` |
| No authorization needed | `authorize()` returns `true` explicitly |
| Input normalization | `prepareForValidation()` — trim, lowercase, defaults |
| Reusable domain validation | Rule class via `php artisan make:rule` |
| One-off check | Inline closure: `function ($attr, $val, $fail) { ... }` |
| Unique ignoring current record | `Rule::unique('table')->ignore($this->route('model'))` |
| PHP enum validation | `new Enum(OrderStatus::class)` |
| File restrictions | `mimes:jpg,png` + `max:` (KB) + `dimensions:` |
| Nested objects / arrays | Dot notation (`address.city`) / wildcard (`items.*.qty`) |

## Never

- **Never use inline validation in controllers.** `$request->validate([...])` violates the thin-controller pattern. Always use a Form Request class.
- **Never skip `authorize()`.** Every Form Request must implement it. Return `true` explicitly if no auth is needed. The default `false` silently blocks all requests with 403.
- **Never hardcode role checks in `authorize()`.** Use `$this->user()->can('action', $model)` to delegate to Policies. Never `$this->user()->role === 'admin'`.
- **Never validate in Actions or Models.** Validation is an HTTP concern. Actions receive already-validated data via `$request->validated()`.
- **Never use `$request->all()`.** Use `$request->validated()` to pass only validated fields to Actions.
- **Never return custom error formats.** Laravel converts validation failures to 422 JSON automatically. Let the framework handle it.
- **Never forget `Rule::unique()->ignore()` on updates.** Without it, updating fails unique validation against the record's own existing value.
- **Never accept unvalidated file uploads.** Always validate `mimes`, `max`, and `dimensions`. Unvalidated uploads are a security risk.
