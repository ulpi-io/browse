# Tracking — Provider-Agnostic Analytics

## What

All analytics go through a provider-agnostic adapter at `src/lib/tracking/`. Call sites emit generic events — provider mappers translate them to GA4, PostHog, or any other format. Adding a provider means implementing one mapper and registering it. No call-site changes, no vendor lock-in. Tracking is client-side only. Server-side conversion events (webhooks) call provider APIs directly, bypassing this adapter.

```
src/lib/tracking/
  types.ts       # Event + provider + consent interfaces
  tracker.ts     # Dispatch to registered providers
  consent.ts     # Consent state (cookie-backed)
  providers/ga.ts        # GA4 mapper
  providers/posthog.ts   # PostHog mapper
```

**Event naming** — `snake_case`, `category_action`, past tense: `page_viewed`, `product_viewed`, `product_added_to_cart`, `form_submitted`, `form_failed`, `cta_clicked`, `search_performed`, `signup_completed`, `checkout_started`, `checkout_completed`. Never camelCase, never dot-separated.

## How

### Adapter interface — `types.ts`

```typescript
// src/lib/tracking/types.ts
import 'client-only';

export interface TrackingEvent {
  name: string;
  properties?: Record<string, string | number | boolean>;
  revenue?: { amount: number; currency: string };
}

export interface TrackingProvider {
  name: string;
  init: () => void;
  track: (event: TrackingEvent) => void;
  page: (url: string, title: string) => void;
  identify: (userId: string, traits?: Record<string, string>) => void;
}

export interface ConsentState { analytics: boolean; marketing: boolean; functional: boolean }
```

`import 'client-only'` prevents server-side import. `TrackingProvider` is the contract every mapper implements.

### Tracker — `tracker.ts`

```typescript
// src/lib/tracking/tracker.ts
import 'client-only';
import type { TrackingEvent, TrackingProvider, ConsentState } from './types';

let providers: TrackingProvider[] = [];
let consent: ConsentState = { analytics: false, marketing: false, functional: false };
let initialized = false;

export function registerProvider(p: TrackingProvider) { providers.push(p); }
export function setConsent(next: ConsentState) {
  consent = next;
  if (!initialized && next.analytics) { providers.forEach((p) => p.init()); initialized = true; }
}
export function trackEvent(e: TrackingEvent) { if (consent.analytics) providers.forEach((p) => p.track(e)); }
export function trackPageView(url: string, title: string) { if (consent.analytics) providers.forEach((p) => p.page(url, title)); }
export function identifyUser(id: string, traits?: Record<string, string>) { if (consent.analytics) providers.forEach((p) => p.identify(id, traits)); }
```

No tracking fires until `setConsent({ analytics: true, ... })`. Providers initialize lazily on first consent.

### GA4 mapper — `providers/ga.ts`

```typescript
// src/lib/tracking/providers/ga.ts
import 'client-only';
import type { TrackingProvider, TrackingEvent } from '../types';
declare global { interface Window { gtag: (...args: unknown[]) => void; dataLayer: unknown[] } }

const GA_MAP: Record<string, string> = {
  product_viewed: 'view_item', product_added_to_cart: 'add_to_cart',
  checkout_started: 'begin_checkout', checkout_completed: 'purchase', search_performed: 'search',
};

export const gaProvider: TrackingProvider = {
  name: 'google-analytics',
  init() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, { send_page_view: false });
  },
  track(event: TrackingEvent) {
    const params: Record<string, unknown> = { ...event.properties };
    if (event.revenue) { params.value = event.revenue.amount; params.currency = event.revenue.currency; }
    window.gtag('event', GA_MAP[event.name] ?? event.name, params);
  },
  page(url, title) { window.gtag('event', 'page_view', { page_location: url, page_title: title }); },
  identify(userId) { window.gtag('set', { user_id: userId }); },
};
```

`GA_MAP` translates generic names to GA4 recommended events. Unmapped events pass through. The `<script>` loading `gtag.js` goes in root layout, loaded only after consent.

### PostHog mapper — `providers/posthog.ts`

Same contract, no event name mapping needed — PostHog accepts names as-is:

```typescript
// src/lib/tracking/providers/posthog.ts
import 'client-only';
import posthog from 'posthog-js';
import type { TrackingProvider, TrackingEvent } from '../types';

export const posthogProvider: TrackingProvider = {
  name: 'posthog',
  init() { posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, { api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST, capture_pageview: false }); },
  track(event: TrackingEvent) {
    const props: Record<string, unknown> = { ...event.properties };
    if (event.revenue) { props.revenue_amount = event.revenue.amount; props.revenue_currency = event.revenue.currency; }
    posthog.capture(event.name, props);
  },
  page(url, title) { posthog.capture('$pageview', { $current_url: url, title }); },
  identify(userId, traits) { posthog.identify(userId, traits); },
};
```

### Consent — `consent.ts`

```typescript
// src/lib/tracking/consent.ts
import 'client-only';
import { setConsent } from './tracker';
import type { ConsentState } from './types';
const COOKIE = 'tracking_consent';
const OFF: ConsentState = { analytics: false, marketing: false, functional: false };

export function loadConsent(): ConsentState {
  const raw = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`))?.split('=')[1];
  if (!raw) return OFF;
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return OFF; }
}
export function saveConsent(consent: ConsentState): void {
  document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(consent))}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax; Secure`;
  setConsent(consent);
}
```

Non-httpOnly cookie readable by client JS. `saveConsent` writes cookie and activates tracking immediately.

### Page view tracking — TrackingSetup component

Place in root `[locale]/layout.tsx` inside `NextIntlClientProvider`:

```tsx
// src/components/features/tracking-setup.tsx
'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { registerProvider, trackPageView, setConsent } from '@/lib/tracking/tracker';
import { loadConsent } from '@/lib/tracking/consent';
import { gaProvider } from '@/lib/tracking/providers/ga';
import { posthogProvider } from '@/lib/tracking/providers/posthog';

let registered = false;
function TrackingSetup() {
  const pathname = usePathname();
  useEffect(() => {
    if (!registered) { registerProvider(gaProvider); registerProvider(posthogProvider); setConsent(loadConsent()); registered = true; }
  }, []);
  useEffect(() => { trackPageView(window.location.href, document.title); }, [pathname]);
  return null;
}
export { TrackingSetup };
```

### User action tracking — in components

```tsx
// In any 'use client' component — all visible strings use t()
import { useTranslations } from 'next-intl';
import { trackEvent } from '@/lib/tracking/tracker';
const t = useTranslations('products');
// On click handler:
trackEvent({ name: 'product_added_to_cart', properties: { product_id: id }, revenue: { amount: price, currency } });
// Button label: {t('cart.add')}
```

### Conversion tracking on forms

Hook fires once per `useActionState` result change — tracks success and failure:

```tsx
// src/lib/tracking/use-conversion-tracking.ts
'use client';
import { useEffect, useRef } from 'react';
import { trackEvent } from '@/lib/tracking/tracker';
import type { ActionResult } from '@/types/actions';

function useConversionTracking(formName: string, state: ActionResult<unknown> | null) {
  const tracked = useRef(false);
  useEffect(() => {
    if (!state || tracked.current) return;
    tracked.current = true;
    trackEvent({ name: state.success ? 'form_submitted' : 'form_failed', properties: { form_name: formName, ...(state.success ? {} : { error: state.error }) } });
    return () => { tracked.current = false; };
  }, [state, formName]);
}
export { useConversionTracking };
```

Usage: `useConversionTracking('signup', state)` in any form component using `useActionState`.

## When

### Server vs client tracking boundaries

| Type | Where | Why |
|------|-------|-----|
| Page views | Client (`TrackingSetup`) | Needs `window.location`, SPA navigation |
| User actions | Client (event handler) | Browser interaction |
| Form conversions | Client (`useConversionTracking`) | Reads `useActionState` result |
| Server conversions | Server (route handler) | No browser — call provider server SDK directly |
| Identify user | Client (after login) | After session established |

### Adding a new provider — checklist

1. Create `src/lib/tracking/providers/{name}.ts` implementing `TrackingProvider`.
2. Add event name translation if provider uses different names, pass through if not.
3. `registerProvider(yourProvider)` in `TrackingSetup`.
4. Add `NEXT_PUBLIC_{PROVIDER}_KEY` to `.env` — must be `NEXT_PUBLIC_`, runs client-side.
5. If provider needs external script, add conditionally in root layout after consent.
6. Verify events in provider dashboard and confirm nothing fires before consent.

| Scenario | Track? |
|----------|--------|
| Page navigation | Yes — `page_viewed` |
| CTA click | Yes — `cta_clicked` |
| Form success | Yes — `form_submitted` |
| Client validation fail | No — no real attempt |
| Server Action error | Yes — `form_failed` |
| Background revalidation | No — infrastructure |
| Admin actions | No — pollutes analytics |

## Never

- **No tracking before consent.** `trackEvent` and `trackPageView` return early when `analytics` is false. GDPR, CCPA, and ePrivacy require explicit consent.
- **No provider-specific calls in components.** Never import `gtag` or `posthog` directly. Always use `trackEvent`/`trackPageView` from `@/lib/tracking/tracker`.
- **No PII in event properties.** Never track email, name, phone, or address. Use `identifyUser` with user ID only.
- **No tracking in Server Components.** Adapter uses `import 'client-only'`. Server-side conversions call provider APIs directly.
- **No `camelCase` or dot-separated event names.** Always `snake_case` `category_action`: `product_viewed`, not `productViewed`.
- **No hardcoded strings in tracking UI.** Consent banners use `t()`: `t('consent.acceptAll')`, `t('consent.analytics')`.
- **No auto-tracking page views.** Disable provider built-ins (`send_page_view: false`, `capture_pageview: false`). Manual `trackPageView` ensures cross-provider consistency.
- **No revenue without currency.** Always pass both `amount` and `currency` in the `revenue` field.
