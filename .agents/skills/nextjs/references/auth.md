# Authentication — BFF Pattern, Sessions & Authorization

## What

Next.js acts as a Backend-For-Frontend (BFF) between the browser and the backend API. The browser never sees raw API tokens. Next.js holds access and refresh tokens server-side in an encrypted httpOnly first-party cookie. The cookie is transport between browser and Next.js — the real auth is the access token attached to backend API calls server-side.

```
Browser  ──cookie──▶  Next.js (BFF)  ──Bearer token──▶  Backend API
                      encrypts/decrypts                   verifies tokens
                      tokens in cookie                    issues tokens
```

**Dependencies:** Jose (JWT encryption/decryption — not verification, backend verifies), `server-only` (prevents auth modules from leaking to client bundles).

**File structure:** `src/lib/auth/session.ts` (createSession, getSession, updateSession, deleteSession), `src/lib/auth/dal.ts` (verifySession with React.cache, authorization helpers).

## How

### session.ts — encrypt tokens in httpOnly cookie

```typescript
// src/lib/auth/session.ts
import 'server-only';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';

const SESSION_COOKIE = 'session';
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET!); // 32+ chars

interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // access token exp (epoch seconds)
}

export async function createSession(accessToken: string, refreshToken: string): Promise<void> {
  const expiresAt = decodeTokenExp(accessToken);
  const cookieStore = await cookies();
  const encrypted = await new SignJWT({ accessToken, refreshToken, expiresAt } satisfies SessionPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(SECRET);
  cookieStore.set(SESSION_COOKIE, encrypted, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;
  try {
    const { payload } = await jwtVerify(cookie, SECRET, { algorithms: ['HS256'] });
    return payload as unknown as SessionPayload;
  } catch { return null; }
}

export async function updateSession(accessToken: string, refreshToken: string): Promise<void> {
  await createSession(accessToken, refreshToken);
}
export async function deleteSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
function decodeTokenExp(token: string): number {
  return JSON.parse(atob(token.split('.')[1]!)).exp as number;
}
```

Jose signs both tokens into a single cookie. `getSession` returns `null` on missing/tampered cookies. `SESSION_SECRET` must be 32+ characters — never `NEXT_PUBLIC_`.

### dal.ts — verifySession with React.cache

```typescript
// src/lib/auth/dal.ts
import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { getSession, updateSession, deleteSession } from '@/lib/auth/session';
import { apiFetch } from '@/lib/api/client';

interface SessionUser { userId: string; role: string; accessToken: string; }

export const verifySession = cache(async (): Promise<SessionUser> => {
  const session = await getSession();
  if (!session) redirect('/login');

  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt > now) {
    const claims = JSON.parse(atob(session.accessToken.split('.')[1]!));
    return { userId: claims.sub, role: claims.role, accessToken: session.accessToken };
  }

  // Access token expired — refresh
  try {
    const tokens = await apiFetch<{ accessToken: string; refreshToken: string }>(
      '/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken: session.refreshToken }), public: true },
    );
    await updateSession(tokens.accessToken, tokens.refreshToken);
    const claims = JSON.parse(atob(tokens.accessToken.split('.')[1]!));
    return { userId: claims.sub, role: claims.role, accessToken: tokens.accessToken };
  } catch { await deleteSession(); redirect('/login'); }
});
```

`React.cache()` deduplicates within a single request — page, layout, and Server Action all calling `verifySession()` hits the session once. Returns `SessionUser` or redirects; callers never receive `null`.

### Login Server Action

```typescript
// src/actions/auth.ts
'use server';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api/client';
import { createSession, deleteSession } from '@/lib/auth/session';
import { loginSchema } from '@/lib/validations/auth';
import type { ActionResult } from '@/types/actions';

export async function loginAction(
  _prevState: ActionResult<void> | null, formData: FormData,
): Promise<ActionResult<void>> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'), password: formData.get('password'),
  });
  if (!parsed.success) {
    return { success: false, error: 'validation_failed',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  }
  try {
    const tokens = await apiFetch<{ accessToken: string; refreshToken: string }>(
      '/auth/login', { method: 'POST', body: JSON.stringify(parsed.data), public: true },
    );
    await createSession(tokens.accessToken, tokens.refreshToken);
  } catch {
    return { success: false, error: 'auth.invalidCredentials' };
  }
  redirect(formData.get('callbackUrl')?.toString() || '/');
}

export async function logoutAction(): Promise<void> {
  await deleteSession();
  redirect('/login');
}
```

`public: true` skips auth header injection — no session exists yet. `'auth.invalidCredentials'` is a translation key passed to `t()`. `redirect()` called outside try/catch — it throws internally.

### API client integration — 401 refresh with race lock

The API client (see `references/api-client-pattern.md`) handles auth automatically. On 401, it refreshes and retries. Module-level mutex prevents parallel 401s from firing duplicate refreshes:

```typescript
// Inside src/lib/api/client.ts — refresh lock
let refreshPromise: Promise<{ accessToken: string; refreshToken: string }> | null = null;

export async function refreshAccessToken(): Promise<{ accessToken: string; refreshToken: string } | null> {
  if (refreshPromise) return refreshPromise;
  const session = await getSession();
  if (!session?.refreshToken) return null;
  refreshPromise = apiFetch<{ accessToken: string; refreshToken: string }>(
    '/auth/refresh',
    { method: 'POST', body: JSON.stringify({ refreshToken: session.refreshToken }), public: true },
  ).finally(() => { refreshPromise = null; });
  try {
    const tokens = await refreshPromise;
    await updateSession(tokens.accessToken, tokens.refreshToken);
    return tokens;
  } catch { await deleteSession(); return null; }
}
```

Concurrent 401s coalesce into one refresh call — without this, parallel refreshes invalidate each other's tokens (rotation).

### proxy.ts — optimistic route protection

```typescript
// Inside proxy.ts (see references/routing.md for full proxy.ts)
const sessionCookie = request.cookies.get('session')?.value;
const isPublic = PUBLIC_PATHS.some(
  (p) => pathname === `/${locale}${p}` || pathname === `/${locale}`,
);
if (!sessionCookie && !isPublic) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = `/${locale}/login`;
  loginUrl.searchParams.set('callbackUrl', pathname);
  return NextResponse.redirect(loginUrl);
}
```

Optimistic only — checks cookie presence, not validity. Expired sessions pass through. Real auth is in `verifySession()` at the data layer.

### Server Action authorization

Every Server Action calls `verifySession()` before any mutation — Server Actions are public HTTP endpoints, proxy.ts does not protect them.

```typescript
export async function deletePostAction(formData: FormData) {
  const session = await verifySession();                                         // 1. Authenticate
  const parsed = z.string().uuid().safeParse(formData.get('postId'));           // 2. Validate
  if (!parsed.success) return { success: false, error: 'validation_failed' };
  const post = await getPost(parsed.data);                                      // 3. Authorize (IDOR, see security.md)
  if (post.authorId !== session.userId) return { success: false, error: 'forbidden' };
  await deletePost(parsed.data);                                                // 4. Mutate
  updateTag('posts');
  return { success: true, data: undefined };
}
```

### Client-side auth state — props, no context

```tsx
// Server Component passes minimal user info as props
const session = await verifySession();
return <Header userName={session.userId} userRole={session.role} />;

// Client Component receives auth as props — never fetches, never stores
'use client';
function Header({ userName, userRole }: { userName: string; userRole: string }) {
  const t = useTranslations('common');
  return <nav><span>{t('nav.greeting', { name: userName })}</span></nav>;
}
```

## When

| Scenario | What to call |
|----------|-------------|
| User submits login form | `loginAction` → `createSession()` |
| User clicks logout | `logoutAction` → `deleteSession()` → redirect |
| Server Component needs user data | `verifySession()` — returns `SessionUser` or redirects |
| Server Action needs authorization | `verifySession()` then check resource ownership |
| API client sends backend request | `getSession()` reads token, attaches `Authorization` header |
| Access token expired during API call | API client catches 401, calls `refreshAccessToken()`, retries |
| Refresh token also expired | `deleteSession()` → `redirect('/login')` |
| proxy.ts checks route access | Read session cookie presence — optimistic redirect if missing |
| Client component needs user info | Receive as props from parent Server Component |

### Token refresh — proactive vs reactive

| Strategy | Where | How |
|----------|-------|-----|
| Proactive | `verifySession()` in DAL | Checks `expiresAt` before API call. Refreshes preemptively. |
| Reactive | `apiFetch()` in API client | Catches 401. Refreshes and retries. Defense-in-depth. |

Both exist. Proactive avoids the wasted 401 round-trip. Reactive catches edge cases where the token expires between DAL check and API call.

## Never

- **No Auth.js / NextAuth.** Backend owns identity, token issuance, and user management. Next.js stores tokens — it does not manage accounts, providers, or OAuth flows.
- **No iron-session.** Jose + cookies is simpler for BFF. iron-session adds abstraction without benefit when the backend issues JWTs.
- **No localStorage / sessionStorage for tokens.** XSS can read them. httpOnly cookies are inaccessible to JavaScript.
- **No direct browser-to-backend-API calls.** All API traffic routes through Next.js. Tokens never leave the server.
- **No token exposure to client components.** Never pass `accessToken` or `refreshToken` as props. Pass only display data (name, role, avatar URL).
- **No page-level auth as sole protection.** proxy.ts is optimistic. Pages and Server Actions still need `verifySession()`. Server Actions are separate HTTP endpoints.
- **No JWT verification in Next.js.** Backend verifies tokens. Next.js only encrypts/decrypts the session cookie and decodes claims (`exp`, `sub`, `role`). Never import a verification key.
- **No auth context providers.** Server Components call `verifySession()` and pass user info as props. No `<AuthProvider>`. See `references/component-anatomy.md`.
- **No inline fetch for auth endpoints.** Use `apiFetch` with `{ public: true }`. See `references/api-client-pattern.md`.
