# Hono Bug Patterns

> Detect: `package.json` has `hono` dependency, files import from `hono`, `Hono()` constructor, `c.json()`/`c.text()` patterns.

## Middleware & Auth

### Middleware registration order — same as Express

```typescript
// BUG: Route before auth middleware
const app = new Hono();
app.get("/admin", adminHandler);
app.use("/admin/*", authMiddleware); // too late!

// FIX: Middleware before routes
app.use("/admin/*", authMiddleware);
app.get("/admin", adminHandler);
```

### CORS — not enabled by default

```typescript
// BUG: CORS not configured — browser requests blocked
const app = new Hono();
app.get("/api/data", handler);

// FIX: Add CORS middleware
import { cors } from "hono/cors";
app.use(
  "/api/*",
  cors({
    origin: ["https://myapp.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
  }),
);
```

## Validation

### Hono doesn't validate input by default

```typescript
// BUG: No input validation
app.post("/users", async (c) => {
  const body = await c.req.json(); // accepts anything
  await db.users.create(body);
});

// FIX: Use Hono's validator middleware with Zod
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const CreateUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
});

app.post("/users", zValidator("json", CreateUser), async (c) => {
  const body = c.req.valid("json"); // typed and validated
  await db.users.create(body);
});
```

## Context (c) Bugs

### c.req.json() can throw on invalid JSON

```typescript
// BUG: Unhandled parse error
app.post("/data", async (c) => {
  const body = await c.req.json(); // throws if body isn't valid JSON
  return c.json(body);
});

// FIX: Use try/catch or validator middleware
app.post("/data", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
});
```

### c.req.param() returns string — not number

```typescript
// BUG: Comparing string to number
app.get("/users/:id", async (c) => {
  const id = c.req.param("id"); // always a string
  const user = await db.users.findById(id); // might need parseInt
  if (user.id === id) {
    /* string === number → always false */
  }
});

// FIX: Parse to correct type
app.get("/users/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
  const user = await db.users.findById(id);
});
```

## Runtime-Specific Bugs

### Hono runs on multiple runtimes — APIs differ

```typescript
// BUG: Node.js API used in Cloudflare Workers
import fs from "node:fs"; // not available in Workers

// FIX: Use Web Standard APIs or check runtime
// Hono targets: Cloudflare Workers, Deno, Bun, Node.js, Lambda
// Use only Web Standard APIs for portability:
// - fetch(), Request, Response, Headers
// - crypto.subtle (not node:crypto)
// - Web Streams (not Node streams)
```

### Environment variables — different per runtime

```typescript
// BUG: process.env doesn't exist in Cloudflare Workers
app.get("/config", (c) => {
  const key = process.env.API_KEY; // undefined in Workers
});

// FIX: Use Hono's env helper (works across runtimes)
app.get("/config", (c) => {
  const { API_KEY } = env<{ API_KEY: string }>(c);
});
```

## Error Handling

### Hono error handler

```typescript
// BUG: Errors in async handlers return generic 500
app.get("/data", async (c) => {
  throw new Error("Something failed"); // generic "Internal Server Error"
});

// FIX: Use onError handler for custom error responses
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(err);
  return c.json({ error: "Internal Server Error" }, 500);
});
```

## Testing Patterns

```typescript
import { Hono } from "hono";
import { app } from "../app.js";

describe("POST /api/users", () => {
  it("should reject invalid input", async () => {
    const res = await app.request("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("should require auth", async () => {
    const res = await app.request("/api/admin");
    expect(res.status).toBe(401);
  });
});
```

## Framework Gotchas

| Gotcha                                            | Detail                                                |
| ------------------------------------------------- | ----------------------------------------------------- |
| `app.request()` for testing (no server needed)    | Built-in, no supertest required                       |
| Middleware order = registration order             | Same as Express, auth before routes                   |
| `c.req.json()` must be awaited                    | Returns a Promise, not a synchronous value            |
| Route params are always strings                   | Must parse to int/float manually                      |
| No built-in body size limit                       | Add `bodyLimit` middleware for production             |
| `c.json()` sets Content-Type automatically        | Don't set it manually                                 |
| Runtime portability                               | Avoid `node:*` imports for Workers/Deno compatibility |
| `c.executionCtx.waitUntil()` for background tasks | Only available in Workers runtime                     |
