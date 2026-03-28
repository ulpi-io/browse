# Express.js Bug Patterns

> Detect: `package.json` has `express` dependency, files import `express`, `app.get/post/use` patterns.

## Injection

### SQL — Use parameterized queries, never string templates

```typescript
// BUG: SQL injection via string interpolation
app.get("/users", (req, res) => {
  db.query(`SELECT * FROM users WHERE name = '${req.query.name}'`);
});

// FIX: Parameterized query
app.get("/users", (req, res) => {
  db.query("SELECT * FROM users WHERE name = $1", [req.query.name]);
});
```

### Command — Express doesn't sanitize route params

```typescript
// BUG: Command injection through route param
app.get("/files/:name", (req, res) => {
  execSync(`cat uploads/${req.params.name}`);
});

// FIX: execFileSync + path validation
app.get("/files/:name", (req, res) => {
  const safePath = path.resolve("uploads", req.params.name);
  if (!safePath.startsWith(path.resolve("uploads"))) {
    return res.status(400).json({ error: "Invalid path" });
  }
  const content = readFileSync(safePath, "utf-8");
  res.send(content);
});
```

### NoSQL injection (MongoDB)

```typescript
// BUG: Object injection — req.body.username can be { "$gt": "" }
app.post("/login", (req, res) => {
  db.users.findOne({
    username: req.body.username,
    password: req.body.password,
  });
});

// FIX: Validate types explicitly
app.post("/login", (req, res) => {
  if (
    typeof req.body.username !== "string" ||
    typeof req.body.password !== "string"
  ) {
    return res.status(400).json({ error: "Invalid input" });
  }
  db.users.findOne({
    username: req.body.username,
    password: req.body.password,
  });
});
```

## Auth & Middleware

### Middleware order matters — auth must come before route handlers

```typescript
// BUG: Route registered BEFORE auth middleware
app.get("/admin/users", adminController.list);
app.use("/admin", requireAuth);

// FIX: Middleware before routes
app.use("/admin", requireAuth);
app.get("/admin/users", adminController.list);
```

### express.json() body size limit — default is 100kb

```typescript
// BUG: No body size limit → DoS via large JSON payload
app.use(express.json());

// FIX: Set explicit limit
app.use(express.json({ limit: "1mb" }));
```

### Trust proxy — required behind reverse proxy for correct req.ip

```typescript
// BUG: req.ip returns proxy IP, rate limiter bypassed
app.use(rateLimit({ windowMs: 60000, max: 100 }));

// FIX: Trust proxy first
app.set("trust proxy", 1); // trust first proxy
app.use(rateLimit({ windowMs: 60000, max: 100 }));
```

## Error Handling

### Async route handlers — unhandled rejections crash Express

```typescript
// BUG: Async error not caught — crashes the process
app.get("/data", async (req, res) => {
  const data = await fetchData(); // if this throws, process crashes
  res.json(data);
});

// FIX: Wrap async handlers (or use express-async-errors)
app.get("/data", async (req, res, next) => {
  try {
    const data = await fetchData();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// BETTER: Use express-async-errors (patches Express to handle async)
import "express-async-errors";
app.get("/data", async (req, res) => {
  const data = await fetchData(); // errors auto-forwarded to error handler
  res.json(data);
});
```

### Error handler must have 4 parameters

```typescript
// BUG: Missing `next` parameter — Express doesn't recognize this as error handler
app.use((err, req, res) => {
  res.status(500).json({ error: err.message });
});

// FIX: Must have exactly 4 params (even if next is unused)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ error: err.message });
});
```

### Double response — headers already sent

```typescript
// BUG: Sends response twice
app.get("/check", (req, res) => {
  if (!req.query.id) {
    res.status(400).json({ error: "Missing id" });
    // Missing return! Falls through to next line
  }
  res.json({ ok: true }); // ERR_HTTP_HEADERS_SENT
});

// FIX: Always return after sending response
app.get("/check", (req, res) => {
  if (!req.query.id) {
    return res.status(400).json({ error: "Missing id" });
  }
  res.json({ ok: true });
});
```

## Session & CSRF

### express-session — default MemoryStore leaks memory in production

```typescript
// BUG: Default MemoryStore is for dev only — leaks in production
app.use(session({ secret: "keyboard cat" }));

// FIX: Use a production store
import RedisStore from "connect-redis";
app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, httpOnly: true, sameSite: "strict" },
  }),
);
```

## Testing Patterns

```typescript
import request from "supertest";
import { app } from "../app.js";

describe("GET /api/users/:id", () => {
  it("should reject SQL injection in path param", async () => {
    const res = await request(app).get("/api/users/1' OR '1'='1");
    expect(res.status).toBe(400);
  });

  it("should require authentication", async () => {
    const res = await request(app).get("/api/users/1");
    expect(res.status).toBe(401);
  });

  it("should prevent IDOR — user A cannot access user B", async () => {
    const res = await request(app)
      .get("/api/users/2")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(403);
  });
});
```

## Framework Gotchas

| Gotcha                                            | Detail                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `req.query` values are always strings (or arrays) | `?page=1` → `req.query.page === "1"` not `1`                           |
| `req.params` are not decoded by default           | URL-encoded values need explicit `decodeURIComponent`                  |
| `res.send(null)` sends empty 200                  | Use `res.status(204).end()` for no-content                             |
| `app.route()` shares middleware                   | Adding auth to one method adds it to all                               |
| `express.static` serves dotfiles by default       | Set `dotfiles: "deny"` in production                                   |
| `req.body` is `undefined` without body parser     | Always `app.use(express.json())` before routes                         |
| Router-level error handlers must be on the router | `app.use(errorHandler)` won't catch router errors unless mounted after |
