# E2E Testing — Playwright

## What

Playwright tests verify critical user paths through the running application: navigation, form submissions, authentication, locale switching, error recovery, and visual layout. Tests run against a real dev or preview server, exercising the full stack — proxy.ts, Server Components, Server Actions, and client interactivity. They do NOT retest logic covered by Vitest (Zod schemas, API client, action return types). See `references/testing-unit.md`.

### Setup — playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', outputDir: './e2e/test-results',
  fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0, workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : [['html', { open: 'on-failure' }]],
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000', trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'npm run dev', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
```

### File organization

All e2e files live under `e2e/` at the project root — never inside `src/`:

```
e2e/
  fixtures/           # Custom fixtures (auth.fixture.ts) and test data (test-data.ts)
  pages/              # Page object models (products.page.ts, login.page.ts)
  tests/              # Spec files (checkout.spec.ts, auth.spec.ts, i18n.spec.ts)
```

## How

### Page object pattern

```typescript
// e2e/pages/products.page.ts
import type { Locator, Page } from '@playwright/test';

export class ProductsPage {
  readonly heading: Locator;
  readonly productCards: Locator;
  readonly searchInput: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.productCards = page.getByTestId('product-card');
    this.searchInput = page.getByRole('searchbox');
  }

  async goto(locale = 'en') { await this.page.goto(`/${locale}/products`); }

  async search(query: string) {
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
    await this.page.waitForURL(/q=/);
  }

  async selectProduct(index: number) {
    await this.productCards.nth(index).click();
    await this.page.waitForURL(/\/products\/.+/);
  }
}
```

Selectors: `getByRole`/`getByLabel` first, `getByTestId` second. Never CSS selectors or XPath. Page objects expose actions — tests read like user stories.

### Testing user flows — navigation and forms

```typescript
// e2e/tests/checkout.spec.ts
import { test, expect } from '@playwright/test';
import { ProductsPage } from '../pages/products.page';

test('browse → add to cart → checkout', async ({ page }) => {
  const products = new ProductsPage(page);
  await products.goto();
  await products.selectProduct(0);

  await page.getByRole('button', { name: /add to cart/i }).click();
  await expect(page.getByRole('status')).toContainText(/added/i);

  await page.getByRole('link', { name: /cart/i }).click();
  await expect(page).toHaveURL(/\/cart/);
  await expect(page.getByTestId('cart-item')).toHaveCount(1);

  await page.getByRole('link', { name: /checkout/i }).click();
  await page.getByLabel(/email/i).fill('test@example.com');
  await page.getByLabel(/address/i).fill('123 Test Street');
  await page.getByRole('button', { name: /place order/i }).click();
  await expect(page).toHaveURL(/\/confirmation/);
});
```

### Testing authentication flows

```typescript
// e2e/fixtures/auth.fixture.ts — reusable authenticated state
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ authenticatedPage: typeof base['page'] }>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/en/login');
    await page.getByLabel(/email/i).fill(process.env.E2E_USER_EMAIL!);
    await page.getByLabel(/password/i).fill(process.env.E2E_USER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await use(page);
  },
});

// e2e/tests/auth.spec.ts
import { test } from '../fixtures/auth.fixture';
import { expect } from '@playwright/test';

test('authenticated user sees dashboard', async ({ authenticatedPage: page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('unauthenticated user redirected to login', async ({ page }) => {
  await page.goto('/en/dashboard');
  await expect(page).toHaveURL(/\/login/);
});

test('logout clears session', async ({ authenticatedPage: page }) => {
  await page.getByTestId('user-menu').click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/en/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
```

### Testing i18n — locale switching and RTL

```typescript
// e2e/tests/i18n.spec.ts
import { test, expect } from '@playwright/test';

test('switches locale and content updates', async ({ page }) => {
  await page.goto('/en/products');
  const enHeading = await page.getByRole('heading', { level: 1 }).textContent();
  await page.getByTestId('locale-switcher').click();
  await page.getByRole('option', { name: /Espa/i }).click();
  await expect(page).toHaveURL(/\/es\/products/);
  const esHeading = await page.getByRole('heading', { level: 1 }).textContent();
  expect(esHeading).not.toBe(enHeading);
});

test('RTL layout for Arabic locale', async ({ page }) => {
  await page.goto('/ar/products');
  expect(await page.locator('html').getAttribute('dir')).toBe('rtl');
  const navBox = await page.getByRole('navigation').boundingBox();
  expect(navBox).not.toBeNull();
  expect(navBox!.x).toBeLessThan(200); // Nav at viewport start in RTL
});

test('all locales render translated content', async ({ page }) => {
  for (const locale of ['en', 'es', 'ar']) {
    await page.goto(`/${locale}/products`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
  }
});
```

### Testing error states

```typescript
// e2e/tests/error-states.spec.ts
import { test, expect } from '@playwright/test';

test('404 for unknown route', async ({ page }) => {
  await page.goto('/en/nonexistent-route');
  await expect(page.getByRole('heading')).toContainText(/not found/i);
  await expect(page.getByRole('link', { name: /home/i })).toBeVisible();
});

test('API failure triggers error boundary with retry', async ({ page }) => {
  await page.route('**/api/v1/products*', (route) =>
    route.fulfill({ status: 500, body: '{"error":"Internal"}' }),
  );
  await page.goto('/en/products');
  await expect(page.getByRole('button', { name: /retry|try again/i })).toBeVisible();
});

test('form validation errors display inline', async ({ page }) => {
  await page.goto('/en/contact');
  await page.getByRole('button', { name: /submit|send/i }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
});
```

Use `page.route()` to intercept API calls and simulate failures. Never depend on backend state.

### Test data management

```typescript
// e2e/fixtures/test-data.ts
export const TEST_USER = {
  email: process.env.E2E_USER_EMAIL ?? 'e2e@example.com',
  password: process.env.E2E_USER_PASSWORD ?? 'Test123!',
} as const;
```

**API mocking with `page.route()`** for deterministic tests:

```typescript
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/products', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: 'p1', slug: 'widget', name: 'Widget', price: 29.99 }],
        pagination: { page: 1, totalPages: 1 },
      }),
    }),
  );
});
```

Mock at the API boundary. Tests exercise proxy.ts, Server Components, and Server Actions — only the external backend is mocked.

### Visual regression patterns

```typescript
test('products page snapshot', async ({ page }) => {
  await page.route('**/api/v1/products*', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: [{ id: 'p1', name: 'Widget', price: 9.99 }], pagination: { page: 1, totalPages: 1 } }),
  }));
  await page.goto('/en/products');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveScreenshot('products-en.png', { maxDiffPixelRatio: 0.01 });
});

test('RTL layout snapshot', async ({ page }) => {
  await page.goto('/ar/products');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveScreenshot('products-ar-rtl.png', { maxDiffPixelRatio: 0.01 });
});
```

Generate baselines: `npx playwright test --update-snapshots`. Always mock API data so snapshots are deterministic.

### CI integration

```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy: { matrix: { shard: [1, 2, 3, 4] } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }}
        env: { CI: 'true', BASE_URL: 'http://localhost:3000' }
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: 'report-${{ matrix.shard }}', path: e2e/test-results/, retention-days: 7 }
```

`forbidOnly` prevents `.only` in CI. `retries: 2` handles flaky browsers. `--shard` parallelizes. Artifacts upload on failure.

## When

### What to e2e test — critical paths only

```
├─ Login → dashboard → protected action                    → E2e
├─ Browse → product detail → add to cart → checkout        → E2e
├─ Locale switch → translated content → RTL layout         → E2e
├─ 404 pages, error boundaries with retry                  → E2e
├─ Form submission end-to-end (submit → server → result)   → E2e
├─ Navigation between major sections                       → E2e
├─ Zod schema rejects bad input                            → Unit (not e2e)
├─ Server Action returns correct ActionResult              → Unit (not e2e)
├─ API client attaches auth headers                        → Unit (not e2e)
└─ Component renders props correctly                       → Unit (not e2e)
```

If a failure would block revenue or lock users out, it is a critical path.

### When to mock vs use real backend

| Scenario | Strategy |
|----------|----------|
| Feature tests (navigation, forms, i18n) | `page.route()` mock API responses |
| Visual regression | Always mock — deterministic data required |
| Smoke tests against staging | Real backend, no mocks |
| Auth flow credentials | Environment variables, never hardcoded |

Add visual snapshots when: complex layout could regress (product grid, dashboard), RTL needs verification, redesign being validated. Do NOT snapshot every page.

## Never

- **No testing Zod validation in e2e.** Validation is a unit test concern. E2e verifies errors display to the user.
- **No CSS selectors or XPath.** Use `getByRole`, `getByLabel`, `getByTestId`. Accessible selectors resist markup changes.
- **No `page.waitForTimeout()`.** Use `waitForURL`, `waitForSelector`, `expect().toBeVisible()`. Hard waits cause flaky tests.
- **No test interdependence.** Each test starts clean. Never rely on previous test side effects.
- **No credentials in source code.** Use environment variables or fixture files excluded from version control.
- **No testing third-party services.** Mock external APIs with `page.route()`. Tests must pass offline.
- **No snapshot tests for every page.** Snapshot critical layouts and RTL variants only.
- **No e2e tests for unit-level logic.** If you test a return value, use Vitest. E2e costs 10-100x more.
