/**
 * Browser runtime provider registry
 *
 * Abstracts the browser engine so playwright, rebrowser, etc. are swappable at runtime.
 * Each runtime is loaded lazily via dynamic import -- only the selected runtime is loaded.
 *
 * Two kinds of runtime:
 *   Library runtimes (playwright, rebrowser) -- return a BrowserType for launch()/connectOverCDP()
 *   Process runtimes (lightpanda) -- spawn a binary, wait for CDP, connect Playwright to it
 *     These set `browser` (pre-connected) and `close` (cleanup spawned process).
 */

import { homedir } from 'os';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import * as net from 'net';
import type { Browser, BrowserType } from 'playwright';

export interface BrowserRuntime {
  name: string;
  chromium: BrowserType;
  /** Pre-connected browser (for process runtimes like lightpanda). */
  browser?: Browser;
  /** Cleanup function -- kills spawned process, if any. */
  close?: () => Promise<void>;
}

type RuntimeLoader = () => Promise<BrowserRuntime>;

/**
 * Find the lightpanda binary on this machine.
 * Checks PATH via `which`, then well-known install locations.
 * Returns the absolute path or null if not found.
 */
export function findLightpanda(): string | null {
  // Check PATH
  try {
    const result = execSync('which lightpanda', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) return result;
  } catch {
    // not on PATH
  }

  // Check well-known install locations
  const home = homedir();
  const candidates = [
    join(home, '.lightpanda', 'lightpanda'),
    join(home, '.local', 'bin', 'lightpanda'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const registry: Record<string, RuntimeLoader> = {
  playwright: async () => {
    const pw = await import('playwright');
    return { name: 'playwright', chromium: pw.chromium };
  },

  rebrowser: async () => {
    try {
      const pw = await import('rebrowser-playwright');
      return { name: 'rebrowser', chromium: pw.chromium };
    } catch {
      throw new Error(
        'rebrowser-playwright not installed. Run: bun add rebrowser-playwright'
      );
    }
  },

  lightpanda: async () => {
    const binaryPath = findLightpanda();
    if (!binaryPath) {
      throw new Error(
        'Lightpanda not found. Install: https://lightpanda.io/docs/open-source/installation'
      );
    }

    // Find a free port
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });

    // Spawn lightpanda with 1-week session timeout (documented maximum)
    const child = spawn(
      binaryPath,
      ['serve', '--host', '127.0.0.1', '--port', String(port), '--timeout', '604800'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // Collect stderr for error reporting
    let stderrData = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderrData += chunk; });
    }

    // Poll for CDP ready (10s timeout, 100ms interval)
    const deadline = Date.now() + 10_000;
    let wsUrl: string | undefined;

    while (Date.now() < deadline) {
      // Check if process exited early
      if (child.exitCode !== null) {
        throw new Error(
          `Lightpanda exited before CDP became ready (exit code: ${child.exitCode})` +
          (stderrData ? `\nstderr: ${stderrData.slice(0, 2000)}` : '')
        );
      }

      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          const data = await res.json() as { webSocketDebuggerUrl?: string };
          wsUrl = data.webSocketDebuggerUrl;
          break;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, 100));
    }

    if (!wsUrl) {
      child.kill();
      throw new Error(
        `Lightpanda failed to start on port ${port} within 10 seconds`
      );
    }

    // Connect Playwright to lightpanda via CDP
    const pw = await import('playwright');
    const browser = await pw.chromium.connectOverCDP(wsUrl);

    return {
      name: 'lightpanda',
      chromium: pw.chromium,
      browser,
      close: async () => {
        await browser.close().catch(() => {});
        child.kill();
      },
    };
  },

  chrome: async () => {
    const pw = await import('playwright');
    const { launchChrome } = await import('./chrome');
    const { browser, close } = await launchChrome();
    return { name: 'chrome', chromium: pw.chromium, browser, close };
  },
};

export const AVAILABLE_RUNTIMES: string[] = Object.keys(registry);

export async function getRuntime(name?: string): Promise<BrowserRuntime> {
  const key = name ?? 'playwright';
  const loader = registry[key];
  if (!loader) {
    throw new Error(
      `Unknown runtime: ${key}. Available: ${AVAILABLE_RUNTIMES.join(', ')}`
    );
  }
  return loader();
}
