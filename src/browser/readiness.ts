/**
 * Page readiness — wait for page to be truly ready after navigation.
 * Runtime-agnostic. Best-effort, never throws.
 * Gated by BROWSE_READINESS env var (default '0' = disabled, opt-in only).
 */

import type { Page } from 'playwright';

export interface ReadinessOptions {
  /** Max time to wait for network idle (ms). Default: 2000. */
  networkTimeout?: number;
  /** Settle time after rAF (ms). Default: 100. */
  settleMs?: number;
}

/**
 * Wait for page readiness: networkidle (soft) + rAF + settle.
 * Never throws — all steps wrapped in try/catch.
 * Total overhead bounded: networkTimeout + settleMs.
 */
export async function waitForPageReady(page: Page, opts?: ReadinessOptions): Promise<void> {
  const networkTimeout = opts?.networkTimeout ?? 2000;
  const settleMs = opts?.settleMs ?? 100;

  try {
    // Soft wait for network to settle — non-fatal on timeout
    await page.waitForLoadState('networkidle', { timeout: networkTimeout }).catch(() => {});

    // Wait for one animation frame + settle
    await page.evaluate((ms) => new Promise<void>(resolve =>
      requestAnimationFrame(() => setTimeout(resolve, ms))
    ), settleMs).catch(() => {});
  } catch {
    // Never throw — readiness is best-effort
  }
}
