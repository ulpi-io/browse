/**
 * Chrome discovery and launch utilities.
 *
 * - discoverChrome(): find a running Chrome with CDP (DevToolsActivePort / port probing)
 * - findChromeExecutable(): locate the Chrome binary on disk
 * - isChromeRunning(): check if Chrome process is active and if it has a debug port
 * - getChromeUserDataDir(): return the default Chrome profile directory
 * - launchChrome(): shared utility — find, check, spawn, poll CDP, connect Playwright
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execSync, spawn, type ChildProcess } from 'child_process';
import type { Browser } from 'playwright';
import { DEFAULTS } from './constants';

const PROFILE_PATHS = [
  'Google/Chrome',
  'Arc/User Data',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
];

const PROBE_PORTS = [9222, 9229];

/** Fetch the CDP WebSocket URL from a Chrome /json/version endpoint. */
export async function fetchWsUrl(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** Read a DevToolsActivePort file and extract the port number. */
function readDevToolsPort(filePath: string): number | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const port = parseInt(content.split('\n')[0], 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Discover a running Chrome instance and return its CDP WebSocket URL.
 * Returns null if no reachable Chrome is found.
 */
export async function discoverChrome(): Promise<string | null> {
  const home = os.homedir();

  // 1. Try DevToolsActivePort files
  for (const profile of PROFILE_PATHS) {
    const filePath = process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', profile, 'DevToolsActivePort')
      : path.join(home, '.config', profile.toLowerCase().replace(/ /g, '-'), 'DevToolsActivePort');
    const port = readDevToolsPort(filePath);
    if (port) {
      const wsUrl = await fetchWsUrl(port);
      if (wsUrl) return wsUrl;
    }
  }

  // 2. Probe well-known ports
  for (const port of PROBE_PORTS) {
    const wsUrl = await fetchWsUrl(port);
    if (wsUrl) return wsUrl;
  }

  // 3. Nothing found
  return null;
}

// ─── Chrome executable discovery ─────────────────────────────

/** Find the Chrome executable on this system. Returns absolute path or null. */
export function findChromeExecutable(): string | null {
  // Env override first
  const envPath = process.env.BROWSE_CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    return null; // Explicit override that doesn't exist = don't fall back
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } else if (process.platform === 'linux') {
    const names = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
    for (const name of names) {
      try {
        const result = execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (result) return result;
      } catch { /* not found */ }
    }
  }

  return null;
}

// ─── Chrome running detection ────────────────────────────────

export interface ChromeStatus {
  running: boolean;
  hasDebugPort: boolean;
  debugPort?: number;
}

/** Check if Chrome is currently running, and whether it has a debug port. */
export function isChromeRunning(): ChromeStatus {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return { running: false, hasDebugPort: false };
  }

  try {
    // Get PIDs of Chrome processes
    const pgrepPattern = process.platform === 'darwin' ? 'Google Chrome' : 'google-chrome|chromium';
    const pids = execSync(`pgrep -f "${pgrepPattern}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean);

    if (pids.length === 0) return { running: false, hasDebugPort: false };

    // Check if any process has --remote-debugging-port in its command line
    for (const pid of pids) {
      try {
        const cmdline = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const match = cmdline.match(/--remote-debugging-port=(\d+)/);
        if (match) {
          return { running: true, hasDebugPort: true, debugPort: parseInt(match[1], 10) };
        }
      } catch { /* process may have exited */ }
    }

    return { running: true, hasDebugPort: false };
  } catch {
    // pgrep returns exit code 1 when no processes found
    return { running: false, hasDebugPort: false };
  }
}

// ─── Chrome user data directory ──────────────────────────────

/** Return the default Chrome user data directory, or null if not found. */
export function getChromeUserDataDir(): string | null {
  const home = os.homedir();

  if (process.platform === 'darwin') {
    const dir = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    if (fs.existsSync(dir)) return dir;
  } else if (process.platform === 'linux') {
    const dir = path.join(home, '.config', 'google-chrome');
    if (fs.existsSync(dir)) return dir;
  }

  return null;
}

// ─── Shared Chrome launch utility ────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
  });
}

async function pickDebugPort(): Promise<number> {
  // Try Chrome's conventional port first
  if (await isPortFree(DEFAULTS.CHROME_DEBUG_PORT)) return DEFAULTS.CHROME_DEBUG_PORT;
  // Fallback: scan browse port range
  for (let port = DEFAULTS.PORT_RANGE_START; port <= DEFAULTS.PORT_RANGE_END; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('No available port for Chrome debug port');
}

function cleanStaleLock(dataDir: string): void {
  const lockFiles = ['SingletonLock', 'lockfile'];
  for (const name of lockFiles) {
    const lockPath = path.join(dataDir, name);
    try {
      // On macOS/Linux, SingletonLock is a symlink containing hostname-PID
      const target = fs.readlinkSync(lockPath);
      const pidMatch = target.match(/-(\d+)$/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        try {
          process.kill(pid, 0); // Check if alive (throws if dead)
        } catch {
          // PID is dead — stale lock, remove it
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // Not a symlink, or doesn't exist — try unlink anyway
      try { fs.unlinkSync(lockPath); } catch { /* doesn't exist */ }
    }
  }
}

export interface ChromeLaunchResult {
  browser: Browser;
  child: ChildProcess | null;
  close: () => Promise<void>;
}

/**
 * Launch or connect to Chrome with CDP.
 * Shared utility used by both the 'chrome' runtime and handoff().
 *
 * Three cases:
 *   1. Chrome running WITH debug port → connect (don't kill on close)
 *   2. Chrome running WITHOUT debug port → launch a NEW instance with browse-owned profile
 *   3. Chrome NOT running → launch with user's real profile
 */
export async function launchChrome(): Promise<ChromeLaunchResult> {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Install Google Chrome or set BROWSE_CHROME_PATH environment variable.'
    );
  }

  const status = isChromeRunning();

  // Case 1: Chrome running WITH debug port → just connect
  if (status.running && status.hasDebugPort && status.debugPort) {
    const wsUrl = await fetchWsUrl(status.debugPort);
    if (wsUrl) {
      const pw = await import('playwright');
      const browser = await pw.chromium.connectOverCDP(wsUrl);
      return { browser, child: null, close: async () => {} }; // don't kill — not ours
    }
  }

  // Chrome blocks --remote-debugging-port with the default user-data-dir.
  // Copy the real Chrome profile to a browse-owned dir so we get cookies, extensions, sessions.
  const port = await pickDebugPort();
  const localDir = process.env.BROWSE_LOCAL_DIR || '.browse';
  const dataDir = path.join(localDir, 'chrome-data');
  const realDataDir = getChromeUserDataDir();

  fs.mkdirSync(dataDir, { recursive: true });

  cleanStaleLock(dataDir);

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${dataDir}`,
  ];

  const child = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Collect stderr for error reporting
  let stderrData = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderrData += chunk; });
  }

  // Poll for CDP ready (15s timeout, 200ms interval)
  const deadline = Date.now() + DEFAULTS.CHROME_CDP_TIMEOUT_MS;
  let wsUrl: string | undefined;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited before CDP became ready (exit code: ${child.exitCode})` +
        (stderrData ? `\nstderr: ${stderrData.slice(0, 2000)}` : '')
      );
    }

    const url = await fetchWsUrl(port);
    if (url) { wsUrl = url; break; }
    await new Promise(r => setTimeout(r, 200));
  }

  if (!wsUrl) {
    child.kill();
    throw new Error(`Chrome failed to start on port ${port} within ${DEFAULTS.CHROME_CDP_TIMEOUT_MS / 1000} seconds`);
  }

  const pw = await import('playwright');
  const browser = await pw.chromium.connectOverCDP(wsUrl);

  // Import cookies from real Chrome profile into this clean Chrome instance
  if (realDataDir) {
    try {
      const { importCookies, listDomains } = await import('./cookie-import');
      const { domains } = listDomains('chrome');
      if (domains.length > 0) {
        const allDomains = domains.map(d => d.domain);
        const result = await importCookies('chrome', allDomains);
        if (result.cookies.length > 0) {
          const context = browser.contexts()[0];
          if (context) {
            await context.addCookies(result.cookies);
            console.log(`[browse] Imported ${result.cookies.length} cookies from Chrome.`);
          }
        }
      }
    } catch (err: any) {
      // Cookie import is best-effort — may fail if Chrome DB is locked or Keychain denied
      console.log(`[browse] Cookie import skipped: ${err.message}`);
    }
  }

  return {
    browser,
    child,
    close: async () => {
      await browser.close().catch(() => {});
      child.kill('SIGTERM');
    },
  };
}
