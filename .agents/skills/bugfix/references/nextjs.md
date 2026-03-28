# Next.js Bug Patterns

> Detect: `package.json` has `next` dependency, `next.config.js`/`next.config.ts` present, `app/` or `pages/` directory structure.

## All React Bugs Apply

Next.js inherits ALL React bug patterns. See `react.md`. This file covers **Next.js-specific** bugs only.

## Server / Client Boundary Bugs

### Using hooks or browser APIs in Server Components

```tsx
// BUG: useState in a Server Component (default in app/)
// app/dashboard/page.tsx — this is a Server Component by default
import { useState } from "react"; // ERROR: hooks don't work in Server Components

export default function Dashboard() {
  const [count, setCount] = useState(0); // CRASH
}

// FIX: Add "use client" directive
("use client");
import { useState } from "react";

export default function Dashboard() {
  const [count, setCount] = useState(0); // OK
}
```

### Passing non-serializable props from Server to Client Components

```tsx
// BUG: Functions can't cross the server/client boundary
// app/page.tsx (Server Component)
import ClientButton from "./button";
export default function Page() {
  return <ClientButton onClick={() => console.log("hi")} />; // ERROR
}

// FIX: Use Server Actions or move logic to client
// app/actions.ts
("use server");
export async function handleClick() {
  /* ... */
}

// app/button.tsx
("use client");
import { handleClick } from "./actions";
export default function ClientButton() {
  return <button onClick={() => handleClick()}>Click</button>;
}
```

## Data Fetching Bugs

### Fetch in Server Components — caching gotchas

```tsx
// BUG: Stale data — Next.js caches fetch by default (in App Router)
async function Dashboard() {
  const data = await fetch("https://api.example.com/stats"); // cached forever
  return <Stats data={await data.json()} />;
}

// FIX: Opt out of cache for dynamic data
const data = await fetch("https://api.example.com/stats", {
  cache: "no-store",
});

// Or revalidate on interval
const data = await fetch("https://api.example.com/stats", {
  next: { revalidate: 60 }, // refresh every 60 seconds
});
```

### generateStaticParams — missing params cause 404 in production

```tsx
// BUG: Dynamic route without generateStaticParams in static export
// app/posts/[slug]/page.tsx
export default function Post({ params }: { params: { slug: string } }) {
  // Works in dev (SSR), 404 in production (static export)
}

// FIX: Provide generateStaticParams
export async function generateStaticParams() {
  const posts = await getAllPosts();
  return posts.map((post) => ({ slug: post.slug }));
}
```

## Middleware Bugs

### Middleware runs on EVERY request (including static assets)

```typescript
// BUG: Middleware runs on _next/static, images, etc.
// middleware.ts
export function middleware(request: NextRequest) {
  // This runs on EVERY request including CSS, JS, images
  const token = request.cookies.get("token");
  if (!token) return NextResponse.redirect(new URL("/login", request.url));
}

// FIX: Use matcher config
export const config = {
  matcher: [
    // Match all paths except static files and api
    "/((?!_next/static|_next/image|favicon.ico|api).*)",
  ],
};
```

## Route Handler Bugs

### Route handlers — forgetting to return Response

```typescript
// BUG: No return statement
// app/api/users/route.ts
export async function GET() {
  const users = await db.users.findMany();
  NextResponse.json(users); // missing return!
}

// FIX: Return the response
export async function GET() {
  const users = await db.users.findMany();
  return NextResponse.json(users);
}
```

### Route handlers — GET is cached by default

```typescript
// BUG: GET route handler returns stale data
export async function GET() {
  return NextResponse.json(await getLatestData()); // cached in production
}

// FIX: Opt out of caching
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json(await getLatestData());
}
```

## Server Actions

### Server Actions — must validate input (runs on server but called from client)

```typescript
// BUG: Trusting client-sent data in Server Action
"use server";
export async function deleteUser(userId: string) {
  await db.users.delete({ where: { id: userId } });
  // Anyone can call this with any userId!
}

// FIX: Validate auth and ownership
("use server");
import { auth } from "@/lib/auth";
export async function deleteUser(userId: string) {
  const session = await auth();
  if (!session?.user?.isAdmin) throw new Error("Unauthorized");
  await db.users.delete({ where: { id: userId } });
}
```

## Environment Variables

```typescript
// BUG: Server env var used in client component
// STRIPE_SECRET_KEY is only available server-side
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!); // undefined in client!

// FIX: Use NEXT_PUBLIC_ prefix for client-visible vars
// Only NEXT_PUBLIC_* vars are bundled into client code
const publishableKey = process.env.NEXT_PUBLIC_STRIPE_KEY;

// Keep secrets server-side only
// app/api/checkout/route.ts (runs on server)
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
```

## Testing Patterns

```tsx
import { render, screen } from "@testing-library/react";

// Test Server Components by extracting logic
describe("Dashboard page", () => {
  it("should handle empty data", async () => {
    vi.spyOn(db.users, "findMany").mockResolvedValue([]);
    const page = await Dashboard(); // Server Components are async functions
    render(page);
    expect(screen.getByText("No users found")).toBeInTheDocument();
  });
});

// Test Route Handlers directly
describe("GET /api/users", () => {
  it("should require authentication", async () => {
    const req = new NextRequest("http://localhost/api/users");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
```

## Framework Gotchas

| Gotcha                                                 | Detail                                          |
| ------------------------------------------------------ | ----------------------------------------------- |
| App Router components are Server Components by default | Must add `"use client"` for interactivity       |
| `params` is now a Promise in Next.js 15                | Must `await params` before accessing properties |
| Layout components don't re-render on navigation        | Use `template.tsx` if you need re-render        |
| `cookies()` and `headers()` make routes dynamic        | Can't use with static export                    |
| Parallel routes (`@slot`) share layout state           | Navigation in one slot doesn't affect others    |
| `redirect()` throws (it's implemented as an error)     | Don't catch it in try/catch                     |
| Image component requires `width` + `height` or `fill`  | Missing either causes build errors              |
| `loading.tsx` only works for the segment it's in       | Doesn't cascade to child segments               |
