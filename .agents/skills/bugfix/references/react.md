# React Bug Patterns

> Detect: `package.json` has `react` dependency, files import from `react`, JSX/TSX files with components.

## XSS

### dangerouslySetInnerHTML — only use with sanitized content

```tsx
// BUG: User input rendered as HTML
function Comment({ body }: { body: string }) {
  return <div dangerouslySetInnerHTML={{ __html: body }} />;
}

// FIX: Use textContent (React auto-escapes by default)
function Comment({ body }: { body: string }) {
  return <div>{body}</div>;
}

// If HTML rendering is required, sanitize first
import DOMPurify from "dompurify";
function Comment({ body }: { body: string }) {
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(body) }} />;
}
```

### href with user input — javascript: protocol

```tsx
// BUG: XSS via javascript: protocol
function UserLink({ url }: { url: string }) {
  return <a href={url}>Visit</a>;
}

// FIX: Validate URL protocol
function UserLink({ url }: { url: string }) {
  const safeUrl = /^https?:\/\//.test(url) ? url : "#";
  return <a href={safeUrl}>Visit</a>;
}
```

## Hooks Bugs

### Stale closure — state captured at render time

```tsx
// BUG: count is always 0 inside the interval
function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setCount(count + 1); // always 0 + 1 = 1
    }, 1000);
    return () => clearInterval(id);
  }, []); // empty deps → stale closure
}

// FIX: Functional updater
useEffect(() => {
  const id = setInterval(() => {
    setCount((prev) => prev + 1);
  }, 1000);
  return () => clearInterval(id);
}, []);
```

### Missing cleanup — event listeners, subscriptions, timers

```tsx
// BUG: Event listener never removed → memory leak
useEffect(() => {
  window.addEventListener("resize", handleResize);
}, []);

// FIX: Return cleanup function
useEffect(() => {
  window.addEventListener("resize", handleResize);
  return () => window.removeEventListener("resize", handleResize);
}, []);
```

### useEffect dependency array — missing or wrong deps

```tsx
// BUG: Missing dependency — effect doesn't re-run when userId changes
useEffect(() => {
  fetchUser(userId).then(setUser);
}, []); // should include userId

// FIX: Include all dependencies
useEffect(() => {
  fetchUser(userId).then(setUser);
}, [userId]);

// TRAP: Object/array deps cause infinite loops
useEffect(() => {
  doSomething(options);
}, [options]); // if options is a new object each render → infinite loop

// FIX: useMemo the object or extract primitives
const stableOptions = useMemo(() => options, [options.key, options.value]);
```

### useState initializer — expensive computation on every render

```tsx
// BUG: computeExpensive() runs on every render
const [data, setData] = useState(computeExpensive());

// FIX: Lazy initializer (function, not call)
const [data, setData] = useState(() => computeExpensive());
```

### Conditional hooks — hooks must be called in the same order

```tsx
// BUG: Hook called conditionally — violates Rules of Hooks
function Component({ show }: { show: boolean }) {
  if (show) {
    const [value, setValue] = useState(""); // ILLEGAL
  }
}

// FIX: Always call hooks, conditionally use the result
function Component({ show }: { show: boolean }) {
  const [value, setValue] = useState("");
  // Use value only when show is true
}
```

## Race Conditions

### Fetch race — component unmounts or props change before response

```tsx
// BUG: Stale response overwrites fresh data
useEffect(() => {
  fetchUser(userId).then(setUser);
}, [userId]);
// If userId changes rapidly: response for old userId arrives after new one

// FIX: AbortController
useEffect(() => {
  const controller = new AbortController();
  fetchUser(userId, { signal: controller.signal })
    .then(setUser)
    .catch((err) => {
      if (err.name !== "AbortError") throw err;
    });
  return () => controller.abort();
}, [userId]);
```

### Strict Mode double-invoke — effects run twice in development

```tsx
// BUG: Side effect happens twice (API call, subscription)
useEffect(() => {
  createSubscription(channel); // called twice in dev
  return () => removeSubscription(channel);
}, [channel]);
// This is CORRECT — the cleanup runs between the two invocations.
// If you see double side effects, ensure your cleanup is symmetric.
```

## Performance / Re-render Bugs

### Object/function identity in props — causes unnecessary re-renders

```tsx
// BUG: New object every render → child always re-renders
function Parent() {
  return <Child style={{ color: "red" }} />; // new object each render
}

// FIX: Memoize or lift to module scope
const style = { color: "red" };
function Parent() {
  return <Child style={style} />;
}
```

### Context value identity

```tsx
// BUG: All consumers re-render on every Provider render
function App() {
  const [user, setUser] = useState(null);
  return (
    <UserContext.Provider value={{ user, setUser }}>
      {" "}
      {/* new object every render */}
      <Page />
    </UserContext.Provider>
  );
}

// FIX: Memoize context value
function App() {
  const [user, setUser] = useState(null);
  const value = useMemo(() => ({ user, setUser }), [user]);
  return (
    <UserContext.Provider value={value}>
      <Page />
    </UserContext.Provider>
  );
}
```

## Key Prop Bugs

```tsx
// BUG: Using array index as key — causes stale state on reorder
{
  items.map((item, i) => (
    <Item key={i} data={item} /> // index key breaks on sort/filter/delete
  ));
}

// FIX: Use stable unique ID
{
  items.map((item) => <Item key={item.id} data={item} />);
}
```

## Testing Patterns

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

describe("LoginForm", () => {
  it("should sanitize XSS in user display name", () => {
    render(<UserBadge name="<script>alert(1)</script>" />);
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    // Text content means it was escaped, not executed
  });

  it("should handle async data loading", async () => {
    render(<UserProfile userId="1" />);
    await waitFor(() => {
      expect(screen.getByText("John Doe")).toBeInTheDocument();
    });
  });

  it("should clean up subscriptions on unmount", () => {
    const unsubscribe = vi.fn();
    vi.spyOn(api, "subscribe").mockReturnValue(unsubscribe);
    const { unmount } = render(<LiveFeed />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

## Framework Gotchas

| Gotcha                                   | Detail                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| `setState` is async (batched)            | Don't read state immediately after setting it                 |
| `Object.is` comparison for state         | `setState(sameObject)` won't trigger re-render                |
| `useRef` changes don't trigger re-render | Use `useState` if UI depends on the value                     |
| React 18+ auto-batches all state updates | Even in promises, timeouts, native events                     |
| `key` prop reset trick                   | Changing `key` fully remounts a component                     |
| `children` is opaque                     | Don't iterate `props.children` directly; use `React.Children` |
| Fragment shorthand `<>` can't have keys  | Use `<Fragment key={...}>` when keys are needed               |
| `useLayoutEffect` warning in SSR         | Use `useEffect` for SSR-safe code                             |
