/**
 * Discover a running Chrome instance for CDP connection.
 *
 * Strategy (first match wins):
 *   1. Read DevToolsActivePort file from known browser profile paths
 *   2. Probe well-known CDP ports (9222, 9229)
 *   3. Return null if nothing found
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const PROFILE_PATHS = [
  'Google/Chrome',
  'Arc/User Data',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
];

const PROBE_PORTS = [9222, 9229];

/** Fetch the CDP WebSocket URL from a Chrome /json/version endpoint. */
async function fetchWsUrl(port: number): Promise<string | null> {
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
    const filePath = path.join(home, 'Library', 'Application Support', profile, 'DevToolsActivePort');
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
