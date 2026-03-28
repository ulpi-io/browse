# Fastify Bug Patterns

> Detect: `package.json` has `fastify` dependency, files import `fastify`, `fastify.get/post/register` patterns.

## Validation — Fastify uses JSON Schema, not middleware

### Missing schema = no validation

```typescript
// BUG: No input validation — accepts any body
fastify.post("/users", async (request, reply) => {
  const { email, name } = request.body as any;
  await db.users.create({ email, name });
});

// FIX: Define JSON Schema for validation
fastify.post(
  "/users",
  {
    schema: {
      body: {
        type: "object",
        required: ["email", "name"],
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string", minLength: 1, maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
  },
  async (request, reply) => {
    const { email, name } = request.body; // validated and typed
    await db.users.create({ email, name });
  },
);
```

### Schema coercion — numbers in query strings

```typescript
// BUG: query.page is a string, comparison fails
fastify.get(
  "/items",
  {
    schema: {
      querystring: { type: "object", properties: { page: { type: "number" } } },
    },
  },
  async (request) => {
    // Fastify coerces "1" → 1 when schema says type: "number"
    // But WITHOUT schema, request.query.page is always a string
  },
);
```

## Plugin System Bugs

### Plugin encapsulation — plugins don't share scope by default

```typescript
// BUG: Decorator registered in plugin A is not available in plugin B
fastify.register(async (instance) => {
  instance.decorate("db", database);
});

fastify.register(async (instance) => {
  instance.db; // undefined! Different encapsulated context
});

// FIX: Register on the root instance or use fastify-plugin
import fp from "fastify-plugin";

const dbPlugin = fp(async (fastify) => {
  fastify.decorate("db", database);
});

fastify.register(dbPlugin); // Now available everywhere
```

### Plugin registration order matters

```typescript
// BUG: Auth plugin registered after routes — routes are unprotected
fastify.register(routes);
fastify.register(authPlugin);

// FIX: Auth before routes
fastify.register(authPlugin);
fastify.register(routes);
```

## Error Handling

### reply.send() in onRequest hook doesn't stop execution

```typescript
// BUG: Handler still executes after reply.send() in hook
fastify.addHook("onRequest", async (request, reply) => {
  if (!request.headers.authorization) {
    reply.code(401).send({ error: "Unauthorized" });
    // Missing return! Execution continues to handler
  }
});

// FIX: Return reply to stop execution
fastify.addHook("onRequest", async (request, reply) => {
  if (!request.headers.authorization) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});
```

### Async error handling — different from Express

```typescript
// Fastify handles async errors automatically (unlike Express)
// Just throw — Fastify catches it
fastify.get("/data", async (request, reply) => {
  const data = await fetchData(); // if this throws, Fastify returns 500
  return data; // can return directly instead of reply.send()
});

// BUG: Using reply.send() AND returning a value — double response
fastify.get("/data", async (request, reply) => {
  const data = await fetchData();
  reply.send(data);
  return data; // BUG: sends response twice
});

// FIX: Use EITHER return OR reply.send(), never both
fastify.get("/data", async () => {
  return await fetchData(); // just return
});
```

## Serialization Bugs

### reply.serialize() vs JSON.stringify — Fastify uses fast-json-stringify

```typescript
// BUG: Response schema missing fields — they get silently dropped
fastify.get(
  "/user",
  {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            name: { type: "string" },
            // email is NOT in schema
          },
        },
      },
    },
  },
  async () => {
    return { name: "John", email: "john@example.com" };
    // Response: { name: "John" } — email is stripped!
  },
);

// FIX: Include all fields in response schema (or omit response schema)
```

## Testing Patterns

```typescript
import Fastify from "fastify";
import { app } from "../app.js";

describe("POST /api/users", () => {
  it("should reject invalid email", async () => {
    const fastify = Fastify();
    await fastify.register(app);
    const res = await fastify.inject({
      method: "POST",
      url: "/api/users",
      payload: { email: "not-an-email", name: "Test" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("should require authentication", async () => {
    const fastify = Fastify();
    await fastify.register(app);
    const res = await fastify.inject({
      method: "GET",
      url: "/api/admin/users",
    });
    expect(res.statusCode).toBe(401);
  });
});
```

## Framework Gotchas

| Gotcha                                                        | Detail                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| Plugins are encapsulated by default                           | Use `fastify-plugin` to share decorators/hooks       |
| `reply.send()` doesn't end execution                          | Must `return reply` in hooks to stop chain           |
| Response schema strips unknown fields                         | Include all fields or omit response schema           |
| Fastify coerces query/params when schema defined              | Without schema, everything is a string               |
| `fastify.inject()` for testing (no HTTP needed)               | Much faster than supertest                           |
| Hooks are scoped to their plugin                              | `onRequest` in plugin A doesn't affect plugin B      |
| `reply.code()` is chainable but `reply.status()` is the alias | Both work, pick one                                  |
| Content-Type must match schema                                | Sending JSON without `application/json` header → 415 |
