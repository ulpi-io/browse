/**
 * browse server — persistent Chromium daemon
 *
 * Architecture:
 *   Bun.serve HTTP on localhost → routes commands to Playwright
 *   Console/network buffers: in-memory (all entries) + disk flush every 1s
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after BROWSE_IDLE_TIMEOUT (default 30 min)
 */

import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { DEFAULTS } from './constants';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Auth (inline) ─────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10); // 0 = auto-scan
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';
const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `${LOCAL_DIR}/browse-server${INSTANCE_SUFFIX}.json`;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || String(DEFAULTS.IDLE_TIMEOUT_MS), 10);

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ─── Buffer (from buffers.ts) ────────────────────────────────────
import { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry, consoleTotalAdded, networkTotalAdded, type LogEntry, type NetworkEntry } from './buffers';
export { consoleBuffer, networkBuffer, addConsoleEntry, addNetworkEntry, type LogEntry, type NetworkEntry };
const CONSOLE_LOG_PATH = `${LOCAL_DIR}/browse-console${INSTANCE_SUFFIX}.log`;
const NETWORK_LOG_PATH = `${LOCAL_DIR}/browse-network${INSTANCE_SUFFIX}.log`;
let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;

function flushBuffers(final = false) {
  // Use totalAdded cursor (not buffer.length) because the ring buffer
  // stays pinned at HIGH_WATER_MARK after wrapping.
  const newConsoleCount = consoleTotalAdded - lastConsoleFlushed;
  if (newConsoleCount > 0) {
    const count = Math.min(newConsoleCount, consoleBuffer.length);
    const newEntries = consoleBuffer.slice(-count);
    const lines = newEntries.map(e =>
      `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
    ).join('\n') + '\n';
    fs.appendFileSync(CONSOLE_LOG_PATH, lines);
    lastConsoleFlushed = consoleTotalAdded;
  }

  let newNetworkCount = networkTotalAdded - lastNetworkFlushed;
  if (newNetworkCount > 0) {
    // If the ring buffer wrapped, oldest unflushed entries were evicted.
    // Advance cursor to skip them — they're gone and can't be flushed.
    if (newNetworkCount > networkBuffer.length) {
      lastNetworkFlushed = networkTotalAdded - networkBuffer.length;
      newNetworkCount = networkBuffer.length;
    }
    const newEntries = networkBuffer.slice(-newNetworkCount);
    const now = Date.now();

    // Flush only a contiguous prefix of ready entries (oldest first).
    // Stop at the first still-pending entry to avoid gaps in the log.
    // On final flush (shutdown), flush everything regardless.
    let prefixLen = 0;
    for (let i = 0; i < newEntries.length; i++) {
      const e = newEntries[i];
      if (final || e.status !== undefined || (now - e.timestamp > DEFAULTS.NETWORK_SETTLE_MS)) {
        prefixLen = i + 1;
      } else {
        break; // First pending entry — stop here
      }
    }

    if (prefixLen > 0) {
      const prefix = newEntries.slice(0, prefixLen);
      const lines = prefix.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n') + '\n';
      fs.appendFileSync(NETWORK_LOG_PATH, lines);
      lastNetworkFlushed += prefixLen;
    }
  }
}

// Flush every 1 second
const flushInterval = setInterval(flushBuffers, DEFAULTS.BUFFER_FLUSH_INTERVAL_MS);

// ─── Idle Timer ────────────────────────────────────────────────
let lastActivity = Date.now();

function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[browse] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    shutdown();
  }
}, 60_000);

// ─── Server ────────────────────────────────────────────────────
const browserManager = new BrowserManager();
let isShuttingDown = false;

// Read/write/meta command sets for routing
const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs', 'state', 'dialog',
  'console', 'network', 'cookies', 'storage', 'perf', 'devices',
]);

const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'fill', 'select', 'hover', 'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss', 'emulate',
]);

const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot', 'snapshot-diff',
]);

// Find port: use BROWSE_PORT or scan range
async function findPort(): Promise<number> {
  if (BROWSE_PORT) {
    try {
      const testServer = Bun.serve({ port: BROWSE_PORT, fetch: () => new Response('ok') });
      testServer.stop();
      return BROWSE_PORT;
    } catch {
      throw new Error(`[browse] Port ${BROWSE_PORT} is in use`);
    }
  }

  // Scan range
  const start = parseInt(process.env.BROWSE_PORT_START || String(DEFAULTS.PORT_RANGE_START), 10);
  const end = start + (DEFAULTS.PORT_RANGE_END - DEFAULTS.PORT_RANGE_START);
  for (let port = start; port <= end; port++) {
    try {
      const testServer = Bun.serve({ port, fetch: () => new Response('ok') });
      testServer.stop();
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`[browse] No available port in range ${start}-${end}`);
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  flushBuffers(true); // Final flush — force all pending entries

  await browserManager.close();

  // Only remove state file if it still belongs to this server instance.
  // A new server may have already written its own state file during restart.
  try {
    const currentState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (currentState.pid === process.pid || currentState.token === AUTH_TOKEN) {
      fs.unlinkSync(STATE_FILE);
    }
  } catch {}

  process.exit(0);
}

// Handle signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  // Clear old log files
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}

  const port = await findPort();

  // Launch browser — pass crash cleanup so buffers flush and state file is removed
  await browserManager.launch(() => {
    flushBuffers(true);
    // Only remove state file if it still belongs to this server
    try {
      const currentState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (currentState.pid === process.pid || currentState.token === AUTH_TOKEN) {
        fs.unlinkSync(STATE_FILE);
      }
    } catch {}
  });

  const startTime = Date.now();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      resetIdleTimer();

      const url = new URL(req.url);

      // Health check — no auth required
      if (url.pathname === '/health') {
        const healthy = browserManager.isHealthy();
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          tabs: browserManager.getTabCount(),
          currentUrl: browserManager.getCurrentUrl(),
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // All other endpoints require auth
      if (!validateAuth(req)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/command' && req.method === 'POST') {
        const body = await req.json();
        return handleCommand(body);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  // Write state file
  const state = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(import.meta.dir, 'server.ts'),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${STATE_FILE}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  process.exit(1);
});
