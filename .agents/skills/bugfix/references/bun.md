# Bun Bug Patterns

> Detect: `bun.lockb` or `bun.lock` present, `bunfig.toml`, scripts use `bun run`/`bun test`, `Bun.serve()` pattern.

## All Node.js/TypeScript Bugs Apply

Bun is Node.js-compatible but has differences. See `nodejs-typescript.md`. This file covers **Bun-specific** bugs only.

## Bun.serve() — HTTP Server

### Default body size — no built-in limit

```typescript
// BUG: No body size limit — memory exhaustion
Bun.serve({
  async fetch(req) {
    const body = await req.json(); // accepts arbitrarily large body
    return Response.json({ ok: true });
  },
});

// FIX: Check content-length before reading body
Bun.serve({
  async fetch(req) {
    const contentLength = parseInt(req.headers.get("content-length") ?? "0");
    if (contentLength > 1_048_576) {
      return new Response("Payload too large", { status: 413 });
    }
    const body = await req.json();
    return Response.json({ ok: true });
  },
});
```

### WebSocket upgrade — forgetting to return upgrade response

```typescript
// BUG: WebSocket upgrade not handled — client gets 200 instead of 101
Bun.serve({
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") {
      server.upgrade(req); // returns boolean, not Response
      // Missing return! Falls through to normal response
    }
    return new Response("Hello");
  },
  websocket: { message(ws, msg) {} },
});

// FIX: Return after upgrade (or return undefined)
Bun.serve({
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") {
      if (server.upgrade(req)) return; // return void on success
      return new Response("Upgrade failed", { status: 400 });
    }
    return new Response("Hello");
  },
  websocket: { message(ws, msg) {} },
});
```

## Node.js Compatibility Gaps

### Not all Node.js APIs are implemented

```typescript
// BUG: Using unimplemented Node.js API
import { createServer } from "node:http2"; // http2 partially supported
import { Worker } from "node:worker_threads"; // workers have differences

// FIX: Check Bun compatibility docs, or use Bun-native APIs
// Bun.serve() instead of http.createServer()
// new Worker() with Bun-specific behavior
```

### node:child_process — different behavior

```typescript
// BUG: exec/execSync may behave differently
import { execSync } from "node:child_process";
// Bun uses its own shell implementation — some shell features differ

// FIX: Use execFileSync with arg arrays (portable across Node/Bun)
import { execFileSync } from "node:child_process";
execFileSync("git", ["log", "--oneline", "-5"]);
```

## Bun-Specific APIs

### Bun.file() — returns BunFile, not Buffer

```typescript
// BUG: Expecting Buffer from file read
const content = Bun.file("config.json"); // returns BunFile, not string/Buffer!

// FIX: Await the text/json/arrayBuffer method
const content = await Bun.file("config.json").text();
const config = await Bun.file("config.json").json();
```

### Bun.write() — overwrites by default

```typescript
// BUG: Silently overwrites existing file
await Bun.write("output.txt", data); // no "file exists" error

// FIX: Check existence first if overwrite is not intended
import { existsSync } from "node:fs";
if (existsSync("output.txt")) throw new Error("File already exists");
await Bun.write("output.txt", data);
```

## Testing (bun:test)

### Bun test runner differences from Jest/Vitest

```typescript
import { describe, it, expect, mock } from "bun:test";

// BUG: Using vi.mock (Vitest) or jest.mock — not available in bun:test
vi.mock("./module"); // ERROR

// FIX: Use Bun's mock()
const mockFn = mock(() => "mocked");
// Module mocking: use mock.module() (Bun 1.1+)
mock.module("./module", () => ({
  default: mockFn,
}));
```

```typescript
// Bun test patterns
describe("API endpoint", () => {
  it("should reject oversized payload", async () => {
    const largeBody = "x".repeat(2_000_000);
    const res = await fetch("http://localhost:3000/api/data", {
      method: "POST",
      body: largeBody,
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
  });
});
```

## Framework Gotchas

| Gotcha                                               | Detail                                                    |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `Bun.file()` returns BunFile, not content            | Must call `.text()`, `.json()`, `.arrayBuffer()`          |
| `Bun.serve()` uses Web Standard `Request`/`Response` | Not Express-style `req`/`res`                             |
| `bun:test` is not Jest/Vitest                        | Different mock API, some matchers differ                  |
| Hot reload (`--hot`) preserves module state          | Unlike `--watch` which restarts the process               |
| `Bun.password.hash()` for password hashing           | Built-in bcrypt/argon2 — don't `npm install bcrypt`       |
| SQLite is built-in (`bun:sqlite`)                    | No need for `better-sqlite3`                              |
| `fetch` is globally available (no import)            | Bun's fetch is built-in, not node-fetch                   |
| Package resolution differs from Node                 | Bun resolves packages slightly differently — test in both |
