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

import type { Browser } from 'playwright';
import { getRuntime, type BrowserRuntime } from './runtime';
import { SessionManager, type Session, type RecordedStep } from './session-manager';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { PolicyChecker } from './policy';
import { DEFAULTS } from './constants';
import { type LogEntry, type NetworkEntry } from './buffers';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import { fileURLToPath } from 'url';

function nodeServe(opts: { port: number; hostname: string; fetch: (req: Request) => Promise<Response> }) {
  const server = http.createServer(async (nodeReq, nodeRes) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeReq) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = `http://${opts.hostname}:${opts.port}${nodeReq.url}`;
      const req = new Request(url, {
        method: nodeReq.method,
        headers: nodeReq.headers as Record<string, string>,
        body: nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD' ? body : undefined,
      });
      const res = await opts.fetch(req);
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      nodeRes.writeHead(res.status, resHeaders);
      nodeRes.end(await res.text());
    } catch (err: any) {
      nodeRes.writeHead(500, { 'Content-Type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    }
  });
  server.listen(opts.port, opts.hostname);
  return server;
}

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

function flushAllBuffers(sm: SessionManager | null, final = false) {
  if (sm) {
    for (const session of sm.getAllSessions()) {
      flushSessionBuffers(session, final);
    }
  } else if (profileSession) {
    flushSessionBuffers(profileSession, final);
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
let sessionManager: SessionManager | null = null;
let browser: Browser | null = null;
let profileSession: Session | null = null;
let activeRuntime: BrowserRuntime | undefined;
let isShuttingDown = false;
let isRemoteBrowser = false;
const policyChecker = new PolicyChecker();

// Read/write/meta command sets for routing
const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs', 'element-state', 'dialog',
  'console', 'network', 'cookies', 'storage', 'perf', 'devices',
  'value', 'count', 'clipboard',
  'box', 'errors',
]);

const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'dblclick', 'fill', 'select', 'hover', 'focus', 'check', 'uncheck',
  'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss', 'emulate',
  'drag', 'keydown', 'keyup',
  'highlight', 'download', 'route', 'offline',
  'rightclick', 'tap', 'swipe', 'mouse', 'keyboard',
  'scrollinto', 'scrollintoview', 'set',
]);

const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot', 'snapshot-diff', 'screenshot-diff',
  'sessions', 'session-close',
  'frame', 'state', 'find',
  'auth', 'har', 'video', 'inspect', 'record', 'cookie-import',
  'doctor', 'upgrade', 'handoff', 'resume', 'profile',
  'react-devtools', 'provider',
]);

// Commands excluded from recording — meta/diagnostic commands that don't represent user actions
const RECORDING_SKIP = new Set([
  'record', 'status', 'stop', 'restart', 'sessions', 'session-close',
  'console', 'network', 'snapshot-diff', 'screenshot-diff', 'cookie-import',
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
  maxOutput: number;
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
      result = await handleMetaCommand(command, args, session.manager, shutdown, sessionManager ?? undefined, session);
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

    // Reset failure counter on success
    session.manager.resetFailures();

    // Record step if recording is active
    if (session.recording && !RECORDING_SKIP.has(command)) {
      const step: RecordedStep = { command, args, timestamp: Date.now() };
      const refArgs = args.filter((a: string) => a.startsWith('@e'));
      if (refArgs.length > 0) {
        const { resolveRefSelectors } = await import('./record-export');
        const resolved: Record<string, string[]> = {};
        for (const ref of refArgs) {
          try {
            const r = session.manager.resolveRef(ref);
            if ('locator' in r) {
              const sels = await resolveRefSelectors(r.locator);
              if (sels.length > 0) resolved[ref] = sels;
            }
          } catch { /* ref invalid or stale — skip */ }
        }
        if (Object.keys(resolved).length > 0) step.resolvedSelectors = resolved;
      }
      session.recording.push(step);
    }

    // Apply max-output truncation
    if (opts.maxOutput > 0 && result.length > opts.maxOutput) {
      result = result.slice(0, opts.maxOutput) + `\n... (truncated at ${opts.maxOutput} chars)`;
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
    session.manager.incrementFailures();
    let friendlyError = rewriteError(err.message);
    const hint = session.manager.getFailureHint();
    if (hint) friendlyError += '\n' + hint;
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

  if (profileSession) {
    // Profile mode: close the persistent BrowserManager (closes context + browser)
    await profileSession.manager.close().catch(() => {});
  } else if (sessionManager) {
    await sessionManager.closeAll();

    // Close the shared browser (skip if remote — we don't own it)
    if (browser && !isRemoteBrowser) {
      browser.removeAllListeners('disconnected');
      await browser.close().catch(() => {});
    }
  }

  // Clean up runtime resources (e.g. lightpanda child process)
  await activeRuntime?.close?.().catch(() => {});

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
  if (sessionManager || profileSession) flushAllBuffers(sessionManager);
}, DEFAULTS.BUFFER_FLUSH_INTERVAL_MS);

// ─── Session Idle Cleanup ───────────────────────────────────────
const sessionCleanupInterval = setInterval(async () => {
  if (isShuttingDown) return;

  // Profile mode: single persistent session, use idle timeout on it
  if (profileSession) {
    const idleMs = Date.now() - profileSession.lastActivity;
    if (idleMs > IDLE_TIMEOUT_MS) {
      console.log(`[browse] Profile session idle for ${IDLE_TIMEOUT_MS / 1000}s — shutting down`);
      shutdown();
    }
    return;
  }

  if (!sessionManager) return;

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

  // Resolve browser runtime (playwright, rebrowser, etc.)
  const runtimeName = process.env.BROWSE_RUNTIME;
  const runtime = await getRuntime(runtimeName);
  activeRuntime = runtime;
  console.log(`[browse] Runtime: ${runtime.name}`);

  // ─── Profile Mode vs Session Mode ────────────────────────────
  const profileName = process.env.BROWSE_PROFILE;

  if (profileName) {
    // Profile mode: persistent browser context, no session multiplexing.
    // Data (cookies, localStorage, cache) persists across server restarts.
    // launchPersistent() launches its own Chromium — skip the shared browser launch.
    const { BrowserManager, getProfileDir } = await import('./browser-manager');
    const { SessionBuffers } = await import('./buffers');

    const profileDir = getProfileDir(LOCAL_DIR, profileName);
    fs.mkdirSync(profileDir, { recursive: true });

    const bm = new BrowserManager();
    await bm.launchPersistent(profileDir, () => {
      if (isShuttingDown) return;
      console.error('[browse] Chromium disconnected (profile mode). Shutting down.');
      shutdown();
    });

    const outputDir = path.join(LOCAL_DIR, 'sessions', profileName);
    fs.mkdirSync(outputDir, { recursive: true });

    profileSession = {
      id: profileName,
      manager: bm,
      buffers: new SessionBuffers(),
      domainFilter: null,
      recording: null,
      outputDir,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };

    console.log(`[browse] Profile mode: "${profileName}" (${profileDir})`);
  } else {
    // Normal mode: launch shared browser, session multiplexing via SessionManager
    const cdpUrl = process.env.BROWSE_CDP_URL;
    if (cdpUrl) {
      // Connect to remote Chrome via CDP
      browser = await runtime.chromium.connectOverCDP(cdpUrl);
      isRemoteBrowser = true;
      console.log(`[browse] Connected to remote Chrome via CDP: ${cdpUrl}`);
    } else if (runtime.browser) {
      // Process runtime (e.g. lightpanda) -- browser already connected
      browser = runtime.browser;
      browser.on('disconnected', () => {
        if (isShuttingDown) return;
        console.error('[browse] Browser disconnected. Shutting down.');
        shutdown();
      });
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
      browser = await runtime.chromium.launch(launchOptions);

      // Chromium crash → clean shutdown (only for owned browser)
      browser.on('disconnected', () => {
        if (isShuttingDown) return;
        console.error('[browse] Chromium disconnected. Shutting down.');
        shutdown();
      });
    }

    sessionManager = new SessionManager(browser, LOCAL_DIR);
  }

  const startTime = Date.now();
  const server = nodeServe({
    port,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);

      // Health check — no auth required
      if (url.pathname === '/health') {
        let healthy: boolean;
        let sessionCount: number;
        if (profileSession) {
          // Profile mode: check if the BrowserManager context is still alive
          healthy = !isShuttingDown && !!profileSession.manager.getContext();
          sessionCount = 1;
        } else {
          healthy = !isShuttingDown && !!browser && browser.isConnected();
          sessionCount = sessionManager ? sessionManager.getSessionCount() : 0;
        }
        return new Response(JSON.stringify({
          status: healthy ? 'healthy' : 'unhealthy',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          sessions: sessionCount,
          ...(profileName ? { profile: profileName } : {}),
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

        // Resolve session: profile mode uses the single persistent session,
        // normal mode uses SessionManager with session multiplexing
        let session: Session;
        if (profileSession) {
          session = profileSession;
          session.lastActivity = Date.now();
        } else {
          const sessionId = req.headers.get('x-browse-session') || 'default';
          const allowedDomains = req.headers.get('x-browse-allowed-domains') || undefined;
          session = await sessionManager!.getOrCreate(sessionId, allowedDomains);
        }

        // Load state file (cookies) if requested via --state flag
        const stateFilePath = req.headers.get('x-browse-state');
        if (stateFilePath) {
          const context = session.manager.getContext();
          if (context) {
            try {
              const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
              if (stateData.cookies?.length) {
                await context.addCookies(stateData.cookies);
              }
            } catch (err: any) {
              return new Response(JSON.stringify({ error: `Failed to load state file: ${err.message}` }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
              });
            }
          }
        }

        const opts: RequestOptions = {
          jsonMode: req.headers.get('x-browse-json') === '1',
          contentBoundaries: req.headers.get('x-browse-boundaries') === '1',
          maxOutput: parseInt(req.headers.get('x-browse-max-output') || '0', 10) || 0,
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
    serverPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'server.ts'),
  };
  if (profileName) {
    state.profile = profileName;
  }
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
