# Remix Bug Patterns

> Detect: `package.json` has `@remix-run/react` or `remix` dependency, `app/routes/` directory, `loader`/`action` exports.

## All React Bugs Apply

Remix inherits ALL React bug patterns. See `react.md`. This file covers **Remix-specific** bugs only.

## Loader / Action Bugs

### Loader data not validated — trust boundary between server and client

```typescript
// BUG: No validation on loader data shape
export async function loader({ params }: LoaderFunctionArgs) {
  const user = await db.users.findById(params.id);
  return json(user); // could be null!
}

export default function UserPage() {
  const user = useLoaderData<typeof loader>();
  return <h1>{user.name}</h1>; // crashes if user is null
}

// FIX: Handle null case in loader
export async function loader({ params }: LoaderFunctionArgs) {
  const user = await db.users.findById(params.id);
  if (!user) throw new Response("Not Found", { status: 404 });
  return json(user);
}
```

### Action — forgetting to return redirect after mutation

```typescript
// BUG: After form submission, page shows stale data
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  await db.posts.create({ title: form.get("title") as string });
  // Missing redirect! Remix re-renders with stale loader data
}

// FIX: Always redirect after mutation (POST/PUT/DELETE)
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const post = await db.posts.create({ title: form.get("title") as string });
  return redirect(`/posts/${post.id}`);
}
```

### Action — not validating form data

```typescript
// BUG: formData.get() returns FormDataEntryValue | null
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = form.get("email"); // could be null, could be File
  await db.users.update({ email }); // type error or null insertion
}

// FIX: Validate and typecheck
export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const email = form.get("email");
  if (typeof email !== "string" || !email.includes("@")) {
    return json({ error: "Invalid email" }, { status: 400 });
  }
  await db.users.update({ email });
  return redirect("/profile");
}
```

## Auth Bugs

### Loader auth — must check in EVERY loader

```typescript
// BUG: Admin route has no auth check in loader
export async function loader() {
  const users = await db.users.findAll(); // anyone can access!
  return json({ users });
}

// FIX: Check auth in every protected loader
export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireAdmin(request); // throws redirect to /login
  const users = await db.users.findAll();
  return json({ users });
}
```

### Cookie session — not validating session data

```typescript
// BUG: Trusting session data without validation
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  // userId could be tampered if using cookie session without signing
  const user = await db.users.findById(userId);
}

// FIX: Use createCookieSessionStorage with secrets
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__session",
    secrets: [process.env.SESSION_SECRET!],
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  },
});
```

## Nested Route Bugs

### ErrorBoundary scope — errors bubble up to parent

```typescript
// BUG: Error in child route crashes entire page
// app/routes/dashboard.tsx has no ErrorBoundary
// app/routes/dashboard.analytics.tsx throws an error
// → Error bubbles up to root ErrorBoundary, losing entire dashboard layout

// FIX: Add ErrorBoundary to parent layout routes
// app/routes/dashboard.tsx
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <DashboardLayout>
      <div>Something went wrong: {isRouteErrorResponse(error) ? error.data : "Unknown error"}</div>
    </DashboardLayout>
  );
}
```

### Outlet context — type safety gap

```typescript
// BUG: useOutletContext returns unknown
export default function ChildRoute() {
  const data = useOutletContext(); // typed as unknown
  return <div>{data.user.name}</div>; // runtime error if shape is wrong
}

// FIX: Type the context
type DashboardContext = { user: User; permissions: string[] };
export default function ChildRoute() {
  const { user, permissions } = useOutletContext<DashboardContext>();
  return <div>{user.name}</div>;
}
```

## Testing Patterns

```typescript
import { createRemixStub } from "@remix-run/testing";
import { render, screen } from "@testing-library/react";

describe("UserPage", () => {
  it("should handle missing user", async () => {
    const RemixStub = createRemixStub([
      {
        path: "/users/:id",
        Component: UserPage,
        loader: () => { throw new Response("Not Found", { status: 404 }); },
        ErrorBoundary: UserErrorBoundary,
      },
    ]);
    render(<RemixStub initialEntries={["/users/999"]} />);
    await screen.findByText("Not Found");
  });
});
```

## Framework Gotchas

| Gotcha                                                | Detail                                             |
| ----------------------------------------------------- | -------------------------------------------------- |
| Loaders run in parallel for nested routes             | Don't depend on parent loader data in child loader |
| `json()` is needed to set headers/status              | Plain object return works but can't set status     |
| `formData.get()` returns `FormDataEntryValue \| null` | Always check for null and type                     |
| `redirect()` throws (like Next.js)                    | Don't catch it in try/catch                        |
| `useNavigation().state` for pending UI                | Not `useTransition` (React 18 name collision)      |
| File routes use `.` for `/` in URL                    | `routes/posts.$id.tsx` → `/posts/:id`              |
| Revalidation happens after every action               | Loaders re-run automatically after mutations       |
| `headers` export controls cache headers               | Must export `headers` function for CDN caching     |
