# File Storage — Filesystem Disks, Uploads, S3, Media Library

## What

File storage uses the `Storage` facade over Laravel's filesystem abstraction. Three disks: **local** (private), **s3** (cloud), **public** (publicly accessible local). Config in `config/filesystems.php`, active disk via `FILESYSTEM_DISK` env. Upload validation in **Form Requests** (see `form-requests.md`). Model-attached media with conversions via **spatie/laravel-medialibrary**. Large files via **direct-to-S3 presigned uploads**. Testing via `Storage::fake()`.

## How

### Disk configuration

`.env`: `FILESYSTEM_DISK=s3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_BUCKET`.

`config/filesystems.php` — three disks, all with `'throw' => true`:
```php
'default' => env('FILESYSTEM_DISK', 'local'),
'disks' => [
    'local'  => ['driver' => 'local', 'root' => storage_path('app/private'), 'throw' => true],
    'public' => ['driver' => 'local', 'root' => storage_path('app/public'),
                  'url' => env('APP_URL') . '/storage', 'visibility' => 'public', 'throw' => true],
    's3'     => ['driver' => 's3', 'key' => env('AWS_ACCESS_KEY_ID'), 'secret' => env('AWS_SECRET_ACCESS_KEY'),
                  'region' => env('AWS_DEFAULT_REGION'), 'bucket' => env('AWS_BUCKET'), 'throw' => true],
],
```

### Directory conventions

Organize by model type and ID: `uploads/{model}/{id}/{category}/` (e.g. `uploads/orders/123/invoices/`).

### File upload validation in Form Requests

```php
final class StoreDocumentRequest extends FormRequest
{
    public function authorize(): bool { return true; }
    public function rules(): array
    {
        return [
            'document' => ['required', 'file', 'mimes:pdf,doc,docx', 'max:10240'],  // 10 MB
            'avatar'   => ['nullable', 'image', 'mimes:jpg,png,webp', 'max:2048',
                           'dimensions:min_width=100,min_height=100,max_width=2000,max_height=2000'],
            'photos'   => ['nullable', 'array', 'max:5'],
            'photos.*' => ['image', 'mimes:jpg,png,webp', 'max:5120'],              // 5 MB each
        ];
    }
}
```

### Storage operations

`put` for raw content, `putFile` for auto-named uploads, `putFileAs` for explicit filenames:
```php
Storage::disk('s3')->put('path/file.pdf', $contents);
$path = Storage::disk('s3')->putFile('uploads/orders/123', $uploadedFile);              // auto-named
$path = Storage::disk('s3')->putFileAs('uploads/orders/123', $uploadedFile, 'inv.pdf'); // explicit
Storage::disk('s3')->get($path);  Storage::disk('s3')->exists($path);  Storage::disk('s3')->delete($path);
```

### Complete upload Action

```php
final class UploadOrderDocument
{
    public function execute(Order $order, UploadedFile $file, DocumentData $data): string
    {
        return DB::transaction(function () use ($order, $file, $data) {
            $path = Storage::disk('s3')->putFileAs(
                "uploads/orders/{$order->id}/documents", $file,
                "{$data->type->value}-" . now()->timestamp . '.' . $file->getClientOriginalExtension(),
            );
            $order->documents()->create([
                'path' => $path, 'disk' => 's3', 'type' => $data->type,
                'original_name' => $file->getClientOriginalName(),
                'size_bytes' => $file->getSize(), 'mime_type' => $file->getMimeType(),
            ]);
            return $path;
        });
    }
}
```
Always persist both `path` and `disk` — disk may change during migration.

### Temporary signed URLs for private S3 files

Generate short-lived URLs — never make private files publicly accessible:
```php
$url = Storage::disk('s3')->temporaryUrl($document->path, now()->addMinutes(30));

// In API Resources — expose signed URL, never the raw S3 path
'download_url' => Storage::disk($this->disk)->temporaryUrl($this->path, now()->addMinutes(30)),
```

### Direct-to-S3 presigned uploads for large files

For files exceeding PHP's upload limit, generate a presigned PUT URL so the client uploads directly to S3:
```php
final class GeneratePresignedUploadUrl
{
    public function __construct(private readonly \Aws\S3\S3Client $s3) {}
    public function execute(string $directory, string $filename, string $contentType): array
    {
        $key = "{$directory}/{$filename}";
        $cmd = $this->s3->getCommand('PutObject', [
            'Bucket' => config('filesystems.disks.s3.bucket'), 'Key' => $key, 'ContentType' => $contentType,
        ]);
        return ['upload_url' => (string) $this->s3->createPresignedRequest($cmd, '+30 minutes')->getUri(), 'key' => $key];
    }
}
```
Client flow: (1) POST `/api/v1/uploads/presign`, (2) PUT file to `upload_url`, (3) POST to associate `key` with model.

### spatie/laravel-medialibrary

Use when files need model attachment, collections, or conversions:
```php
final class Product extends Model implements HasMedia
{
    use InteractsWithMedia;
    protected $fillable = ['name', 'sku', 'price_cents'];

    public function registerMediaCollections(): void
    {
        $this->addMediaCollection('images')->useDisk('s3');
        $this->addMediaCollection('thumbnail')->singleFile()->useDisk('s3');
    }

    public function registerMediaConversions(?Media $media = null): void
    {
        $this->addMediaConversion('thumb')->width(300)->height(300)->sharpen(10)->nonQueued();
        $this->addMediaConversion('webp')->format('webp')->queued();
    }
}
```

In Actions: `$product->addMedia($file)->toMediaCollection('images')` to attach, `$product->addMediaFromDisk($key, 's3')->toMediaCollection('images')` after presigned upload, `$product->getFirstMediaUrl('thumbnail', 'thumb')` for conversions. Deleting a model with `HasMedia` auto-removes associated media.

### Cleanup of orphaned files

Always delete files in the deletion Action: `Storage::disk($document->disk)->delete($document->path)`. For accumulated orphans, schedule a weekly cleanup job (see `scheduling.md`):
```php
final class CleanOrphanedFiles implements ShouldQueue
{
    public function handle(): void
    {
        $referenced = DB::table('documents')->pluck('path')->toArray();
        $orphaned = array_diff(Storage::disk('s3')->allFiles('uploads'), $referenced);
        foreach (array_chunk($orphaned, 100) as $batch) { Storage::disk('s3')->delete($batch); }
        Log::info('Orphaned file cleanup completed', ['deleted_count' => count($orphaned)]);
    }
}
```

### Storage::fake() for testing

`Storage::fake('s3')` replaces the disk with an in-memory filesystem. Use `UploadedFile::fake()` for test files:

```php
test('upload stores document on s3', function () {
    Storage::fake('s3');
    $user = authenticatedUser();
    $order = Order::factory()->for($user)->create();
    $file = UploadedFile::fake()->create('invoice.pdf', 1024, 'application/pdf');

    $this->actingAs($user)
        ->postJson("/api/v1/orders/{$order->id}/documents", ['document' => $file, 'type' => 'invoice'])
        ->assertStatus(201);
    Storage::disk('s3')->assertExists("uploads/orders/{$order->id}/documents/");
});

test('rejects invalid file type', function () {
    Storage::fake('s3');
    $user = authenticatedUser();
    $order = Order::factory()->for($user)->create();
    $this->actingAs($user)
        ->postJson("/api/v1/orders/{$order->id}/documents", [
            'document' => UploadedFile::fake()->create('malware.exe', 1024), 'type' => 'invoice',
        ])->assertStatus(422)->assertJsonValidationErrors(['document']);
});
```

## When

| Situation | Approach |
|---|---|
| Standard upload (< 10 MB) | Form Request validation + `putFileAs()` in Action |
| Large upload (> 10 MB) | Presigned S3 URL, client uploads directly |
| Private files | S3 disk + `temporaryUrl()` |
| Public files | `public` disk or S3 with public visibility |
| Model-attached media with conversions | `spatie/laravel-medialibrary` |
| Testing | `Storage::fake()` + `UploadedFile::fake()` |
| Model deleted | Delete files in deletion Action or medialibrary auto-cleanup |
| Orphaned files | Scheduled cleanup job (weekly) |

## Never

- **Never store files in `public/` directly.** Use the Storage facade — direct placement bypasses access control.
- **Never skip file validation.** Validate `mimes`, `max`, `dimensions` in Form Requests.
- **Never serve private S3 files via public URLs.** Use `temporaryUrl()` with short expiration.
- **Never pass large files through PHP.** Presigned S3 URLs for uploads over 10 MB.
- **Never store paths without the disk name.** Persist both `path` and `disk` — disk may change.
- **Never forget to delete files when deleting the parent model.** Orphans accumulate cost.
- **Never expose S3 keys or bucket names in responses.** Return signed URLs only.
- **Never `Storage::fake()` without asserting.** Verify `assertExists` or `assertMissing`.
