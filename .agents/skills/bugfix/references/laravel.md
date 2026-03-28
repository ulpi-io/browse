# Laravel Bug Patterns

> Detect: `composer.json` has `laravel/framework` dependency, `artisan` file present, `app/Http/Controllers/` directory, `.blade.php` templates.

## Injection

### Mass assignment — unguarded model attributes

```php
// BUG: All attributes are mass-assignable
class User extends Model {
    // No $fillable or $guarded defined
}

// Attacker sends: POST /users { "name": "John", "is_admin": true }
User::create($request->all()); // is_admin is set!

// FIX: Define $fillable whitelist
class User extends Model {
    protected $fillable = ['name', 'email', 'password'];
}
```

### Raw SQL — Eloquent is safe, raw queries are not

```php
// BUG: SQL injection via raw query
$users = DB::select("SELECT * FROM users WHERE name = '{$request->name}'");

// FIX: Parameterized binding
$users = DB::select("SELECT * FROM users WHERE name = ?", [$request->name]);

// BETTER: Use Eloquent (parameterized by default)
$users = User::where('name', $request->name)->get();

// TRAP: Raw expressions inside Eloquent are still injectable
User::whereRaw("name = '{$request->name}'")->get(); // BUG!
User::whereRaw("name = ?", [$request->name])->get(); // FIX
```

### Blade XSS — {!! !!} renders raw HTML

```blade
{{-- BUG: Raw HTML output — XSS --}}
{!! $user->bio !!}

{{-- FIX: Escaped output (default) --}}
{{ $user->bio }}

{{-- If HTML is required, sanitize first --}}
{!! clean($user->bio) !!}
```

## Auth & Authorization

### Gate/Policy not checked — controller trusts route

```php
// BUG: No authorization check — any authenticated user can update any post
public function update(Request $request, Post $post) {
    $post->update($request->validated());
}

// FIX: Use authorize
public function update(Request $request, Post $post) {
    $this->authorize('update', $post);
    $post->update($request->validated());
}
```

### Middleware vs. Gate — common confusion

```php
// BUG: 'auth' middleware only checks authentication, not authorization
Route::middleware('auth')->group(function () {
    Route::delete('/users/{user}', [UserController::class, 'destroy']);
    // Any authenticated user can delete any user!
});

// FIX: Add authorization in controller or use can middleware
Route::middleware(['auth', 'can:delete,user'])->group(function () {
    Route::delete('/users/{user}', [UserController::class, 'destroy']);
});
```

## Validation Bugs

### $request->all() includes unexpected fields

```php
// BUG: Extra fields pass through
public function store(Request $request) {
    $request->validate(['name' => 'required', 'email' => 'required|email']);
    User::create($request->all()); // includes any extra fields sent by client!
}

// FIX: Use validated() or only()
public function store(Request $request) {
    $validated = $request->validate(['name' => 'required', 'email' => 'required|email']);
    User::create($validated); // only validated fields
}
```

### unique validation — must exclude current record on update

```php
// BUG: Update fails because current user's email triggers unique violation
$request->validate([
    'email' => 'required|email|unique:users',
]);

// FIX: Ignore current user
$request->validate([
    'email' => ['required', 'email', Rule::unique('users')->ignore($user->id)],
]);
```

## Eloquent Bugs

### N+1 query problem

```php
// BUG: 101 queries for 100 posts (1 for posts + 100 for authors)
$posts = Post::all();
@foreach ($posts as $post)
    {{ $post->author->name }}  <!-- lazy loads author for each post -->
@endforeach

// FIX: Eager load relationships
$posts = Post::with('author')->get();
```

### Soft deletes — forgetting they exist

```php
// BUG: Unique constraint fails because soft-deleted record exists
User::create(['email' => 'test@example.com']);
// User gets soft-deleted
User::create(['email' => 'test@example.com']); // unique violation!

// FIX: Account for soft deletes in unique validation
Rule::unique('users')->whereNull('deleted_at');
```

### Model events — save() vs update() behavior

```php
// BUG: Model observer/event not firing
Post::where('author_id', $userId)->update(['status' => 'archived']);
// Mass update bypasses model events! No "updating"/"updated" events fire.

// FIX: If events are needed, loop (or use chunk)
Post::where('author_id', $userId)->each(function ($post) {
    $post->update(['status' => 'archived']); // events fire for each
});
```

## Queue / Job Bugs

### Job fails silently — missing failed() method

```php
// BUG: Job fails but no notification or logging
class ProcessPayment implements ShouldQueue {
    public function handle() {
        // If this throws, job is retried then buried
    }
}

// FIX: Implement failed() for alerting
class ProcessPayment implements ShouldQueue {
    public $tries = 3;
    public $backoff = [10, 60, 300];

    public function handle() { /* ... */ }

    public function failed(\Throwable $exception) {
        Log::error("Payment processing failed", ['error' => $exception->getMessage()]);
        // Notify admins, update order status, etc.
    }
}
```

## Testing Patterns

```php
use Tests\TestCase;
use Illuminate\Foundation\Testing\RefreshDatabase;

class UserControllerTest extends TestCase {
    use RefreshDatabase;

    public function test_prevents_mass_assignment_of_admin_flag(): void {
        $response = $this->postJson('/api/users', [
            'name' => 'John',
            'email' => 'john@example.com',
            'password' => 'secret123',
            'is_admin' => true,
        ]);
        $response->assertCreated();
        $this->assertFalse(User::first()->is_admin);
    }

    public function test_user_cannot_access_other_users_data(): void {
        $user1 = User::factory()->create();
        $user2 = User::factory()->create();
        $this->actingAs($user1)
            ->getJson("/api/users/{$user2->id}/settings")
            ->assertForbidden();
    }

    public function test_sql_injection_in_search(): void {
        $this->actingAs(User::factory()->create())
            ->getJson("/api/users?search=' OR '1'='1")
            ->assertOk()
            ->assertJsonCount(0, 'data');
    }
}
```

## Framework Gotchas

| Gotcha                                              | Detail                                            |
| --------------------------------------------------- | ------------------------------------------------- |
| `$request->all()` includes extra fields             | Use `$request->validated()` or `$request->only()` |
| Mass update skips model events                      | Use `->each()` if events are needed               |
| `whereRaw()` is injectable                          | Always pass bindings array as second param        |
| `{!! !!}` renders raw HTML (XSS)                    | Use `{{ }}` for auto-escaping                     |
| Route model binding can expose soft-deleted records | Add `withTrashed()` only when intended            |
| `config()` returns null if key doesn't exist        | Use `config('key', 'default')`                    |
| Queue workers need restart after code changes       | Use `queue:restart` in deployment                 |
| `env()` returns null outside of config files        | Only use `env()` in config/\*.php                 |
