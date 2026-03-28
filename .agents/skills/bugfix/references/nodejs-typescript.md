# Node.js / TypeScript Bug Patterns

> Detect: `package.json` present, `.ts`/`.js` files, `tsconfig.json`, `node_modules/`. This is the base reference for all Node.js frameworks.

## Async / Promise Bugs

### Unhandled promise rejection — crashes Node 15+

```typescript
// BUG: Unhandled rejection terminates the process
async function init() {
  const data = await fetchData(); // if this rejects, process crashes
}
init(); // no catch!

// FIX: Always handle top-level rejections
init().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Or use a global handler as safety net
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});
```

### forEach + async — doesn't await

```typescript
// BUG: forEach doesn't await async callbacks
const items = [1, 2, 3];
items.forEach(async (item) => {
  await processItem(item); // NOT awaited by forEach
});
console.log("done"); // runs BEFORE any items are processed

// FIX: Use for...of or Promise.all
for (const item of items) {
  await processItem(item); // sequential
}
// or
await Promise.all(items.map((item) => processItem(item))); // parallel
```

### Event emitter — error event crashes if no listener

```typescript
// BUG: Unhandled 'error' event crashes the process
const emitter = new EventEmitter();
emitter.emit("error", new Error("fail")); // CRASH — no error listener

// FIX: Always add error listener
emitter.on("error", (err) => {
  console.error("Emitter error:", err);
});
```

## Type Safety Gaps

### `as` casts provide zero runtime safety

```typescript
// BUG: TypeScript trusts the cast — no runtime check
const data = JSON.parse(body) as UserInput;
// data could be anything — type system says UserInput but runtime disagrees

// FIX: Validate at boundary with Zod
import { z } from "zod";
const UserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});
const data = UserInput.parse(JSON.parse(body)); // throws on invalid input
```

### Loose equality — type coercion traps

```typescript
// BUG: Loose equality causes unexpected behavior
"0" == false; // true
"" == false; // true
null == undefined; // true
[] == false; // true

// FIX: Always use strict equality
"0" === false; // false (correct)
```

### Optional chaining — doesn't throw, returns undefined

```typescript
// BUG: Silent undefined propagation
const city = user?.address?.city;
// If user is null, city is undefined — no error
// But then: city.toUpperCase() → CRASH

// FIX: Handle the undefined case
const city = user?.address?.city;
if (!city) {
  throw new Error("City is required");
}
city.toUpperCase(); // safe — TypeScript narrows to string
```

## Security

### Environment variables — not validated

```typescript
// BUG: Missing env var is undefined — silently breaks
const apiKey = process.env.API_KEY; // could be undefined
fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
// Sends "Bearer undefined"

// FIX: Validate at startup
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable is required");
}
```

### Path traversal — path.join doesn't prevent it

```typescript
// BUG: path.join doesn't prevent traversal
const filePath = path.join("uploads", userInput); // "../../../etc/passwd" works!

// FIX: Resolve and verify
const filePath = path.resolve("uploads", userInput);
if (!filePath.startsWith(path.resolve("uploads"))) {
  throw new Error("Path traversal attempt");
}
```

### Command injection — execSync with template strings

```typescript
// BUG: Command injection
execSync(`git log --author="${author}"`);
// author = '"; rm -rf / #' → disaster

// FIX: execFileSync with arg array
execFileSync("git", ["log", `--author=${author}`]);
```

## Resource Leaks

### Database connections — not releasing on error

```typescript
// BUG: Connection leaks on throw
const conn = await pool.getConnection();
const result = await conn.query("SELECT ..."); // if throws, conn leaks
conn.release();

// FIX: try/finally
const conn = await pool.getConnection();
try {
  return await conn.query("SELECT ...");
} finally {
  conn.release();
}
```

### Event listeners — not removed

```typescript
// BUG: Listener accumulates on every call
function watchFile(path: string) {
  fs.watchFile(path, callback); // adds new listener each call
}

// FIX: Track and remove
let watcher: fs.StatWatcher | null = null;
function watchFile(path: string) {
  if (watcher) fs.unwatchFile(path);
  watcher = fs.watchFile(path, callback);
}
```

## Module System Bugs

### ESM vs CJS — import confusion

```typescript
// BUG: require() in ESM module
const fs = require("fs"); // ERROR in ESM: require is not defined

// FIX: Use import
import fs from "node:fs";

// BUG: Top-level await in CJS
const data = await fetchData(); // ERROR in CJS: await only in async/ESM

// FIX: Use "type": "module" in package.json, or use async IIFE
```

### **dirname / **filename not available in ESM

```typescript
// BUG: __dirname is not defined in ESM
const configPath = path.join(__dirname, "config.json"); // ERROR

// FIX: Use import.meta
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

## Testing Patterns

```typescript
import { describe, it, expect, vi } from "vitest";

describe("processUserInput", () => {
  it("should reject command injection in filename", () => {
    expect(() => processFile("; rm -rf /")).toThrow("Invalid path");
  });

  it("should handle undefined env var gracefully", () => {
    vi.stubEnv("API_KEY", undefined);
    expect(() => getApiKey()).toThrow(
      "API_KEY environment variable is required",
    );
    vi.unstubAllEnvs();
  });

  it("should release connection on query error", async () => {
    const mockRelease = vi.fn();
    const mockConn = {
      query: vi.fn().mockRejectedValue(new Error("fail")),
      release: mockRelease,
    };
    vi.spyOn(pool, "getConnection").mockResolvedValue(mockConn);

    await expect(queryUsers()).rejects.toThrow("fail");
    expect(mockRelease).toHaveBeenCalled();
  });
});
```

## Framework Gotchas

| Gotcha                                   | Detail                                        |
| ---------------------------------------- | --------------------------------------------- |
| `JSON.parse()` throws on invalid input   | Always wrap in try/catch at boundaries        |
| `parseInt("08")` works (no longer octal) | But `parseInt("0x10")` returns 16             |
| `typeof null === "object"`               | Check for null explicitly before typeof       |
| `NaN !== NaN`                            | Use `Number.isNaN()`, not `=== NaN`           |
| `Array.sort()` mutates in place          | And sorts as strings by default               |
| `Date` months are 0-indexed              | `new Date(2024, 0, 1)` is January 1           |
| `Buffer.from(string)` defaults to UTF-8  | Specify encoding explicitly for binary data   |
| `process.exit()` skips cleanup           | Use `process.exitCode` + let event loop drain |
