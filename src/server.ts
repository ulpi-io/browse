/**
 * browse server — persistent Chromium daemon
 *
 * Architecture:
 *   Bun.serve HTTP on localhost → routes commands to Playwright
 *   Session multiplexing: multiple agents share one Chromium via X-Browse-Session header
 *   Console/network buffers: per-session in-memory + disk flush every 1s
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown when all sessions idle past BROWSE_IDLE_TIMEOUT (default 30 min)
 */

import { chromium, type Browser } from 'playwright';
import { SessionManager, type Session } from './session-manager';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { PolicyChecker } from './policy';
import { DEFAULTS } from './constants';
import { type LogEntry, type NetworkEntry } from './buffers';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Re-export types for backward compatibility
export { type LogEntry, type NetworkEntry };

// ─── Auth (inline) ─────────────────────────────────────────────
const AUTH_TOKEN = crypto.randomUUID();
const DEBUG_PORT = parseInt(process.env.BROWSE_DEBUG_PORT || '0', 10);
const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10); // 0 = auto-scan
const BROWSE_INSTANCE = process.env.BROWSE_INSTANCE || '';
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : (BROWSE_INSTANCE ? `-${BROWSE_INSTANCE}` : '');
const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';
const STATE_FILE = process.env.BROWSE_STATE_FILE || `${LOCAL_DIR}/browse-server${INSTANCE_SUFFIX}.json`;
const IDLE_TIMEOUT_MS = parseInt(process.env.BROWSE_IDLE_TIMEOUT || String(DEFAULTS.IDLE_TIMEOUT_MS), 10);

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ─── Per-Session Buffer Flush ──────────────────────────────────
// Flushes each session's buffers to separate log files on disk.

function flushAllBuffers(sessionManager: SessionManager, final = false) {
  for (const session of sessionManager.getAllSessions()) {
    flushSessionBuffers(session, final);
  }
}

function flushSessionBuffers(session: Session, final: boolean) {
  const consolePath = `${session.outputDir}/console.log`;
  const networkPath = `${session.outputDir}/network.log`;
  const buffers = session.buffers;

  // Console flush
  const newConsoleCount = buffers.consoleTotalAdded - buffers.lastConsoleFlushed;
  if (newConsoleCount > 0) {
    const count = Math.min(newConsoleCount, buffers.consoleBuffer.length);
    const newEntries = buffers.consoleBuffer.slice(-count);
    const lines = newEntries.map(e =>
      `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
    ).join('\n') + '\n';
    fs.appendFileSync(consolePath, lines);
    buffers.lastConsoleFlushed = buffers.consoleTotalAdded;
  }

  // Network flush
  let newNetworkCount = buffers.networkTotalAdded - buffers.lastNetworkFlushed;
  if (newNetworkCount > 0) {
    if (newNetworkCount > buffers.networkBuffer.length) {
      buffers.lastNetworkFlushed = buffers.networkTotalAdded - buffers.networkBuffer.length;
      newNetworkCount = buffers.networkBuffer.length;
    }
    const newEntries = buffers.networkBuffer.slice(-newNetworkCount);
    const now = Date.now();

    let prefixLen = 0;
    for (let i = 0; i < newEntries.length; i++) {
      const e = newEntries[i];
      if (final || e.status !== undefined || (now - e.timestamp > DEFAULTS.NETWORK_SETTLE_MS)) {
        prefixLen = i + 1;
      } else {
        break;
      }
    }

    if (prefixLen > 0) {
      const prefix = newEntries.slice(0, prefixLen);
      const lines = prefix.map(e =>
        `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n') + '\n';
      fs.appendFileSync(networkPath, lines);
      buffers.lastNetworkFlushed += prefixLen;
    }
  }
}

// ─── Server ────────────────────────────────────────────────────
let sessionManager: SessionManager;
let browser: Browser;
let isShuttingDown = false;
let isRemoteBrowser = false;
const policyChecker = new PolicyChecker();

// Read/write/meta command sets for routing
const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs', 'element-state', 'dialog',
  'console', 'network', 'cookies', 'storage', 'perf', 'devices',
  'value', 'count', 'clipboard',
]);

const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'dblclick', 'fill', 'select', 'hover', 'focus', 'check', 'uncheck',
  'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss', 'emulate',
  'drag', 'keydown', 'keyup',
  'highlight', 'download', 'route', 'offline',
]);

const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot', 'snapshot-diff', 'screenshot-diff',
  'sessions', 'session-close',
  'frame', 'state', 'find',
  'auth', 'har', 'inspect',
]);

// Probe if a port is free using net.createServer (not Bun.serve which fatally crashes on EADDRINUSE)
import * as net from 'net';

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => { srv.close(() => resolve(true)); });
    srv.listen(port, '127.0.0.1');
  });
}

// Find port: use BROWSE_PORT or scan range
async function findPort(): Promise<number> {
  if (BROWSE_PORT) {
    if (await isPortFree(BROWSE_PORT)) return BROWSE_PORT;
    throw new Error(`[browse] Port ${BROWSE_PORT} is in use`);
  }

  // Scan range
  const start = parseInt(process.env.BROWSE_PORT_START || String(DEFAULTS.PORT_RANGE_START), 10);
  const end = start + (DEFAULTS.PORT_RANGE_END - DEFAULTS.PORT_RANGE_START);
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`[browse] No available port in range ${start}-${end}`);
}

// Commands that return page-derived content (for --content-boundaries wrapping).
// Action commands (click, goto) and meta commands (status, tabs) are NOT wrapped.
const PAGE_CONTENT_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'console', 'network', 'snapshot',
]);

// Nonce for content boundaries — generated once per server process
const BOUNDARY_NONCE = crypto.randomUUID();

interface RequestOptions {
  jsonMode: boolean;
  contentBoundaries: boolean;
}

/**
 * Rewrite Playwright error messages into actionable hints for AI agents.
 * Raw errors like "locator.click: Timeout 5000ms exceeded" are unhelpful.
 */
function rewriteError(msg: string): string {
  if (msg.includes('strict mode violation')) {
    const countMatch = msg.match(/resolved to (\d+) elements/);
    return `Multiple elements matched (${countMatch?.[1] || 'several'}). Use a more specific selector or run 'snapshot -i' to find exact refs.`;
  }
  if (msg.includes('Timeout') && msg.includes('exceeded')) {
    const timeMatch = msg.match(/Timeout (\d+)ms/);
    return `Element not found within ${timeMatch?.[1] || '?'}ms. The element may not exist, be hidden, or the page is still loading. Try 'wait <selector>' first, or check with 'snapshot -i'.`;
  }
  if (msg.includes('waiting for locator') || msg.includes('waiting for selector')) {
    return `Element not found on the page. Run 'snapshot -i' to see available elements, or check the current URL with 'url'.`;
  }
  if (msg.includes('not an HTMLInputElement') || msg.includes('not an input')) {
    return `Cannot fill this element — it's not an input field. Use 'click' instead, or run 'snapshot -i' to find the correct input.`;
  }
  if (msg.includes('Element is not visible')) {
    return `Element exists but is hidden (display:none or visibility:hidden). Try scrolling to it with 'scroll <selector>' or wait for it with 'wait <selector>'.`;
  }
  if (msg.includes('Element is outside of the viewport')) {
    return `Element is off-screen. Scroll to it first with 'scroll <selector>'.`;
  }
  if (msg.includes('intercepts pointer events')) {
    return `Another element is covering the target (e.g., a modal, overlay, or cookie banner). Close the overlay first or use 'js' to click directly.`;
  }
  if (msg.includes('Frame was detached') || msg.includes('frame was detached')) {
    return `The iframe was removed or navigated away. Run 'frame main' to return to the main page, then re-navigate.`;
  }
  if (msg.includes('Target closed') || msg.includes('target closed')) {
    return `The page or tab was closed. Use 'tabs' to list open tabs, or 'goto' to navigate to a new page.`;
  }
  if (msg.includes('net::ERR_')) {
    const errMatch = msg.match(/(net::\w+)/);
    return `Network error: ${errMatch?.[1] || 'connection failed'}. Check the URL and ensure the site is reachable.`;
  }
  return msg;
}

async function handleCommand(body: any, session: Session, opts: RequestOptions): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    const error = 'Missing "command" field';
    if (opts.jsonMode) {
      return new Response(JSON.stringify({ success: false, error }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Policy check
  const policyResult = policyChecker.check(command);
  if (policyResult === 'deny') {
    const error = `Command '${command}' denied by policy`;
    const hint = 'Update browse-policy.json to allow this command.';
    if (opts.jsonMode) {
      return new Response(JSON.stringify({ success: false, error, hint }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error, hint }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (policyResult === 'confirm') {
    const error = `Command '${command}' requires confirmation (policy). Non-interactive CLI cannot confirm.`;
    const hint = 'Move this command to the allow list in browse-policy.json.';
    if (opts.jsonMode) {
      return new Response(JSON.stringify({ success: false, error, hint }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error, hint }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let result: string;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, session.manager, session.buffers);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, session.manager, session.domainFilter);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, session.manager, shutdown, sessionManager, session);
    } else {
      const error = `Unknown command: ${command}`;
      const hint = `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`;
      if (opts.jsonMode) {
        return new Response(JSON.stringify({ success: false, error, hint }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error, hint }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Apply content boundaries for page-content commands
    if (opts.contentBoundaries && PAGE_CONTENT_COMMANDS.has(command)) {
      const origin = session.manager.getCurrentUrl();
      result = `--- BROWSE_CONTENT nonce=${BOUNDARY_NONCE} origin=${origin} ---\n${result}\n--- END_BROWSE_CONTENT nonce=${BOUNDARY_NONCE} ---`;
    }

    // Apply JSON wrapping
    if (opts.jsonMode) {
      return new Response(JSON.stringify({ success: true, data: result, command }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(result, {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  } catch (err: any) {
    const friendlyError = rewriteError(err.message);
    if (opts.jsonMode) {
      return new Response(JSON.stringify({ success: false, error: friendlyError, command }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: friendlyError }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[browse] Shutting down...');
  clearInterval(flushInterval);
  clearInterval(sessionCleanupInterval);
  flushAllBuffers(sessionManager, true);

  await sessionManager.closeAll();

  // Close the shared browser (skip if remote — we don't own it)
  if (browser && !isRemoteBrowser) {
    browser.removeAllListeners('disconnected');
    await browser.close().catch(() => {});
  }

  // Only remove state file if it still belongs to this server instance.
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

// ─── Flush Timer ────────────────────────────────────────────────
const flushInterval = setInterval(() => {
  if (sessionManager) flushAllBuffers(sessionManager);
}, DEFAULTS.BUFFER_FLUSH_INTERVAL_MS);

// ─── Session Idle Cleanup ───────────────────────────────────────
const sessionCleanupInterval = setInterval(async () => {
  if (!sessionManager || isShuttingDown) return;

  const closed = await sessionManager.closeIdleSessions(IDLE_TIMEOUT_MS, (session) => flushSessionBuffers(session, true));
  for (const id of closed) {
    console.log(`[browse] Session "${id}" idle for ${IDLE_TIMEOUT_MS / 1000}s — closed`);
  }

  if (sessionManager.getSessionCount() === 0) {
    console.log('[browse] All sessions idle — shutting down');
    shutdown();
  }
}, 60_000);

// ─── Start ─────────────────────────────────────────────────────
async function start() {
  const port = await findPort();

  // Launch or connect to browser
  const cdpUrl = process.env.BROWSE_CDP_URL;
  if (cdpUrl) {
    // Connect to remote Chrome via CDP
    browser = await chromium.connectOverCDP(cdpUrl);
    isRemoteBrowser = true;
    console.log(`[browse] Connected to remote Chrome via CDP: ${cdpUrl}`);
  } else {
    // Launch local Chromium
    const launchOptions: Record<string, any> = { headless: process.env.BROWSE_HEADED !== '1' };
    if (DEBUG_PORT > 0) {
      launchOptions.args = [`--remote-debugging-port=${DEBUG_PORT}`];
    }
    const proxyServer = process.env.BROWSE_PROXY;
    if (proxyServer) {
      launchOptions.proxy = { server: proxyServer };
      if (process.env.BROWSE_PROXY_BYPASS) {
        launchOptions.proxy.bypass = process.env.BROWSE_PROXY_BYPASS;
      }
    }
    browser = await chromium.launch(launchOptions);

    // Chromium crash → flush, cleanup, exit (only for owned browser)
    browser.on('disconnected', () => {
      console.error('[browse] FATAL: Chromium process crashed or was killed. Server exiting.');
      if (sessionManager) flushAllBuffers(sessionManager, true);
      try {
        const currentState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (currentState.pid === process.pid || currentState.token === AUTH_TOKEN) {
          fs.unlinkSync(STATE_FILE);
        }
      } catch {}
      process.exit(1);
    });
  }

  // Create session manager
  sessionManager = new SessionManager(browser, LOCAL_DIR);

  const startTime = Date.now();
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      // Health check — no auth required
      if (url.pathname === '/health') {
        const healthy = !isShuttingDown && browser.isConnected();
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          sessions: sessionManager.getSessionCount(),
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
        const sessionId = req.headers.get('x-browse-session') || 'default';
        const allowedDomains = req.headers.get('x-browse-allowed-domains') || undefined;
        const session = await sessionManager.getOrCreate(sessionId, allowedDomains);
        const opts: RequestOptions = {
          jsonMode: req.headers.get('x-browse-json') === '1',
          contentBoundaries: req.headers.get('x-browse-boundaries') === '1',
        };
        return handleCommand(body, session, opts);
      }

      return new Response('Not found', { status: 404 });
    },
  });

  // Write state file
  const state: Record<string, any> = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: path.resolve(import.meta.dir, 'server.ts'),
  };
  if (DEBUG_PORT > 0) {
    state.debugPort = DEBUG_PORT;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

  console.log(`[browse] Server running on http://127.0.0.1:${port} (PID: ${process.pid})`);
  console.log(`[browse] State file: ${STATE_FILE}`);
  console.log(`[browse] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
}

start().catch((err) => {
  console.error(`[browse] Failed to start: ${err.message}`);
  process.exit(1);
});
