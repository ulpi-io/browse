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
import { getRuntime, type BrowserRuntime } from './engine/resolver';
import { SessionManager, type Session, type RecordedStep } from './session/manager';
import type { BrowserTarget } from './browser/target';
import { PolicyChecker } from './security/policy';
import { DEFAULTS } from './constants';
import { type LogEntry, type NetworkEntry } from './network/buffers';
import { prepareWriteContext, finalizeWriteContext, prepareAppWriteContext, finalizeAppWriteContext } from './automation/action-context';
import { executeCommand } from './automation/executor';
import type { ContextLevel, WriteContextCapture } from './types';
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

/**
 * Narrow the session's AutomationTarget to BrowserTarget.
 * Returns null if the session targets a non-browser automation backend.
 */
function trySessionBt(session: Session): BrowserTarget | null {
  if (session.manager.targetType === 'browser') {
    return session.manager as BrowserTarget;
  }
  return null;
}

/**
 * Narrow the session's AutomationTarget to BrowserTarget (throws if not browser).
 */
function sessionBt(session: Session): BrowserTarget {
  const bt = trySessionBt(session);
  if (!bt) throw new Error('This operation requires a browser session');
  return bt;
}

import { registry, rewriteError as registryRewriteError } from './automation/registry';

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

// Nonce for content boundaries — generated once per server process
const BOUNDARY_NONCE = crypto.randomUUID();

// Use rewriteError from registry
const rewriteError = registryRewriteError;

interface RequestOptions {
  jsonMode: boolean;
  contentBoundaries: boolean;
  maxOutput: number;
  contextLevel: ContextLevel;
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

  const bt = trySessionBt(session);
  const target = session.manager;
  const effectiveLevel: ContextLevel = opts.contextLevel !== 'off' ? opts.contextLevel : session.contextLevel;

  try {
    let writeCapture: WriteContextCapture | null = null;

    const lifecycle: import('./automation/events').CommandLifecycle = {
        before: [async (event) => {
          // Write context capture (before execution) — browser targets only
          if (event.category === 'write' && bt) {
            writeCapture = await prepareWriteContext(effectiveLevel, bt, session.buffers);
          }
          // App write context capture
          if (event.category === 'write' && !bt) {
            writeCapture = await prepareAppWriteContext(effectiveLevel, target);
          }
        }],
        after: [async (event) => {
          let result = event.result;

          // Write context finalization (after execution)
          if (event.category === 'write') {
            if (writeCapture && bt) {
              result = await finalizeWriteContext(writeCapture, bt, session.buffers, result, event.command);
              writeCapture = null;
            } else if (writeCapture && !bt) {
              result = await finalizeAppWriteContext(writeCapture, target, result, event.command);
              writeCapture = null;
            }

            // Detect set context command and update session level
            if (event.command === 'set' && event.args[0] === 'context') {
              if (!event.args[1]) {
                result = `Context level: ${session.contextLevel}`;
              } else {
                const val = (event.args[1] as string).toLowerCase();
                session.contextLevel = val === 'on' || val === 'state' ? 'state'
                  : val === 'delta' ? 'delta'
                  : val === 'full' ? 'full'
                  : 'off';
              }
            }

            // Detect set settle command
            if (event.command === 'set' && event.args[0] === 'settle') {
              if (!event.args[1]) {
                result = `Settle mode: ${session.settleMode ? 'on' : 'off'}`;
              } else {
                session.settleMode = event.args[1] === 'on';
              }
            }
          }

          // Reset failure counter on success (browser targets only)
          if (bt) bt.resetFailures();

          // Record step if recording is active
          if (session.recording && !event.spec?.skipRecording) {
            const step: RecordedStep = { command: event.command, args: [...event.args], timestamp: Date.now() };
            const refArgs = [...event.args].filter((a: string) => a.startsWith('@e'));
            if (refArgs.length > 0 && bt) {
              const { resolveRefSelectors } = await import('./export/record');
              const resolved: Record<string, string[]> = {};
              for (const ref of refArgs) {
                try {
                  const r = bt.resolveRef(ref);
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
          return result;
        }],
        onError: [async (event) => {
          if (bt) bt.incrementFailures();
          let friendlyError = rewriteError(event.error.message);
          if (bt) {
            const hint = bt.getFailureHint();
            if (hint) friendlyError += '\n' + hint;
          }
          return friendlyError;
        }],
    };

    const { output, spec } = await executeCommand(command, args, {
      context: {
        args,
        target,
        buffers: session.buffers,
        domainFilter: session.domainFilter,
        session,
        shutdown,
        sessionManager: sessionManager ?? undefined,
        lifecycle,
      },
      lifecycle,
    });

    // ─── Transport-specific post-processing ────────────────
    let result = output;

    // Apply max-output truncation
    if (opts.maxOutput > 0 && result.length > opts.maxOutput) {
      result = result.slice(0, opts.maxOutput) + `\n... (truncated at ${opts.maxOutput} chars)`;
    }

    // Apply content boundaries for page-content commands
    if (opts.contentBoundaries && spec.pageContent) {
      const origin = target.getCurrentLocation();
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
    // Error already rewritten by onError hook
    const friendlyError = err.message;
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
    // Profile mode: close the persistent browser target (closes context + browser)
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
    const { getProfileDir } = await import('./browser/manager');
    const { SessionBuffers } = await import('./network/buffers');
    const { createPersistentBrowserTarget } = await import('./session/target-factory');

    const profileDir = getProfileDir(LOCAL_DIR, profileName);
    fs.mkdirSync(profileDir, { recursive: true });

    const profileTarget = await createPersistentBrowserTarget(profileDir, () => {
      if (isShuttingDown) return;
      console.error('[browse] Browser disconnected (profile mode). Shutting down.');
      shutdown();
    }, runtime.chromium, runtime.launchOptions);

    const outputDir = path.join(LOCAL_DIR, 'sessions', profileName);
    fs.mkdirSync(outputDir, { recursive: true });

    profileSession = {
      id: profileName,
      manager: profileTarget.target,
      buffers: new SessionBuffers(),
      domainFilter: null,
      recording: null,
      lastRecording: null,
      outputDir,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      contextLevel: 'off',
      settleMode: false,
    };

    console.log(`[browse] Profile mode: "${profileName}" (${profileDir})`);
  } else {
    // Normal mode: launch shared browser, session multiplexing via SessionManager
    const cdpUrl = process.env.BROWSE_CDP_URL;
    if (cdpUrl) {
      if (runtime.name === 'camoufox') {
        throw new Error('Camoufox (Firefox) does not support Chrome DevTools Protocol. Remove --cdp or use --runtime playwright.');
      }
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
      // Launch local browser (Chromium or Firefox via camoufox)
      const serverOptions: Record<string, any> = { headless: process.env.BROWSE_HEADED !== '1' };
      if (DEBUG_PORT > 0) {
        serverOptions.args = [`--remote-debugging-port=${DEBUG_PORT}`];
      }
      const proxyServer = process.env.BROWSE_PROXY;
      if (proxyServer) {
        serverOptions.proxy = { server: proxyServer };
        if (process.env.BROWSE_PROXY_BYPASS) {
          serverOptions.proxy.bypass = process.env.BROWSE_PROXY_BYPASS;
        }
      }

      // Merge runtime-specific launch options (e.g. camoufox Firefox prefs)
      const runtimeOpts = runtime.launchOptions ?? {};
      const launchOptions: Record<string, any> = {
        ...runtimeOpts,
        ...serverOptions,
        // Concatenate args arrays from both sources
        args: [...(Array.isArray(runtimeOpts.args) ? runtimeOpts.args : []), ...(serverOptions.args ?? [])],
        // Merge env objects (server env takes precedence)
        ...(runtimeOpts.env || serverOptions.env
          ? { env: { ...(runtimeOpts.env as Record<string, string> ?? {}), ...(serverOptions.env as Record<string, string> ?? {}) } }
          : {}),
      };
      browser = await runtime.chromium.launch(launchOptions);

      // Chromium crash → clean shutdown (only for owned browser)
      browser.on('disconnected', () => {
        if (isShuttingDown) return;
        console.error('[browse] Chromium disconnected. Shutting down.');
        shutdown();
      });
    }

    const reuseContext = runtime.name === 'chrome';
    const { createBrowserTargetFactory } = await import('./session/target-factory');
    sessionManager = new SessionManager(createBrowserTargetFactory(browser), LOCAL_DIR, reuseContext);
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
          // Profile mode: check if the browser target context is still alive
          healthy = !isShuttingDown && profileSession.manager.isReady();
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
        // normal mode uses SessionManager with session multiplexing.
        // If X-Browse-App is set, use an app-targeted session (prefixed "app:<name>").
        let session: Session;
        if (profileSession) {
          session = profileSession;
          session.lastActivity = Date.now();
        } else {
          const appName = req.headers.get('x-browse-app');
          const platform = req.headers.get('x-browse-platform') || '';
          const device = req.headers.get('x-browse-device') || '';
          let sessionId: string;
          if (appName) {
            if (platform === 'ios') {
              // iOS: single shared session — all apps share one runner, reconfigure target on switch
              sessionId = `ios-app`;
              if (!sessionManager!.hasAppFactory(sessionId)) {
                const { createIOSTargetFactory } = await import('./session/target-factory');
                sessionManager!.setAppFactory(
                  sessionId,
                  createIOSTargetFactory(appName, device || undefined),
                );
              }
              // If session already exists with a different app, reconfigure the runner
              const existingSession = sessionManager!.getExisting(sessionId);
              if (existingSession) {
                const mgr = existingSession.manager as any;
                if (mgr?.getBundleId && mgr.getBundleId() !== appName) {
                  const { configureTarget } = await import('./app/ios/sim-service');
                  const port = parseInt(process.env.BROWSE_RUNNER_PORT || '', 10) || 9820;
                  await configureTarget(port, appName);
                  mgr.reconfigureTarget(appName);
                }
              }
            } else if (platform === 'android') {
              sessionId = `app:${appName}`;
              if (!sessionManager!.hasAppFactory(sessionId)) {
                const { createAndroidTargetFactory } = await import('./session/target-factory');
                sessionManager!.setAppFactory(
                  sessionId,
                  createAndroidTargetFactory(appName, device || undefined),
                );
              }
            } else {
              sessionId = `app:${appName}`;
              // Default: macOS app automation
              if (!sessionManager!.hasAppFactory(sessionId)) {
                const { createAppTargetFactory } = await import('./session/target-factory');
                sessionManager!.setAppFactory(sessionId, createAppTargetFactory(appName));
              }
            }
          } else {
            sessionId = req.headers.get('x-browse-session') || 'default';
          }
          const allowedDomains = req.headers.get('x-browse-allowed-domains') || undefined;
          session = await sessionManager!.getOrCreate(sessionId, allowedDomains);
        }

        // Load state file (cookies) if requested via --state flag (browser sessions only)
        const stateFilePath = req.headers.get('x-browse-state');
        if (stateFilePath) {
          const sessionBt_ = trySessionBt(session);
          const context = sessionBt_?.getContext();
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

        // Enable network body capture if requested (browser sessions only)
        if (req.headers.get('x-browse-network-bodies') === '1') {
          const sessionBt_ = trySessionBt(session);
          if (sessionBt_ && !sessionBt_.getCaptureNetworkBodies()) {
            sessionBt_.setCaptureNetworkBodies(true);
          }
        }

        const ctxHeader = req.headers.get('x-browse-context');
        const contextLevel: ContextLevel = ctxHeader === '1' || ctxHeader === 'state' ? 'state'
          : ctxHeader === 'delta' ? 'delta'
          : ctxHeader === 'full' ? 'full'
          : 'off';
        const opts: RequestOptions = {
          jsonMode: req.headers.get('x-browse-json') === '1',
          contentBoundaries: req.headers.get('x-browse-boundaries') === '1',
          maxOutput: parseInt(req.headers.get('x-browse-max-output') || '0', 10) || 0,
          contextLevel,
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
