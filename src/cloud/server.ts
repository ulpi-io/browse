/**
 * Cloud server — multi-tenant HTTP API for remote browser automation.
 *
 * Separate entry point from the local server (src/server.ts).
 * Wraps the same SessionManager + executeCommand infrastructure
 * behind JWT-authenticated, tenant-scoped routes.
 *
 * Auth flow: API key -> JWT exchange -> Bearer token on all /v1/ routes.
 * Sessions are prefixed `tenant:<tenantId>:session:<id>` for isolation.
 */

import * as http from 'http';
import { getRuntime, type BrowserRuntime } from '../engine/resolver';
import { SessionManager, type Session } from '../session/manager';
import { createBrowserTargetFactory } from '../session/target-factory';
import { executeCommand } from '../automation/executor';
import { ensureDefinitionsRegistered } from '../automation/registry';
import { ApiKeyVault, createJwt, validateJwt, resolveJwtSecret } from './auth';
import { CloudSessionManager, TenantAccessError } from './sessions';
import { handleUpgrade, closeAllConnections, broadcastSessionEvent } from './ws';
import { DockerClient } from './docker';
import { ContainerOrchestrator } from './orchestrator';
import type { Orchestrator, SessionHandle } from './orchestrator-interface';
import { ContainerReaper } from './reaper';
import { CLOUD_DEFAULTS } from '../constants';
import type { Browser } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────

export interface CloudConfig {
  port: number;
  host: string;
  dbPath: string;
  jwtSecret: Buffer;
  adminKey: string | undefined;
}

interface TenantContext {
  tenantId: string;
  permissions: string;
}

// ─── HTTP helper (same pattern as src/server.ts) ────────────────

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

// ─── Helpers ────────────────────────────────────────────────────

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(error: string, status: number, hint?: string): Response {
  return jsonResponse(hint ? { error, hint } : { error }, status);
}

/** Extract the short session ID from a tenant-scoped ID */
function shortSessionId(fullId: string): string {
  const parts = fullId.split(':session:');
  return parts.length > 1 ? parts[1] : fullId;
}

/** Extract Bearer token from Authorization header */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}

/** Parse URL pathname into segments: /v1/sessions/abc -> ['v1', 'sessions', 'abc'] */
function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

// ─── Startup ────────────────────────────────────────────────────

async function start() {
  const config: CloudConfig = {
    port: parseInt(process.env.BROWSE_CLOUD_PORT || String(CLOUD_DEFAULTS.PORT), 10),
    host: process.env.BROWSE_CLOUD_HOST || CLOUD_DEFAULTS.HOST,
    dbPath: process.env.BROWSE_CLOUD_DB_PATH || CLOUD_DEFAULTS.DB_PATH,
    jwtSecret: resolveJwtSecret(process.env.BROWSE_LOCAL_DIR || '.browse'),
    adminKey: process.env.BROWSE_CLOUD_ADMIN_KEY,
  };

  // Initialize auth
  const vault = new ApiKeyVault(config.dbPath);

  // Register command definitions once
  await ensureDefinitionsRegistered();

  // Launch browser runtime
  const runtimeName = process.env.BROWSE_RUNTIME;
  const runtime: BrowserRuntime = await getRuntime(runtimeName);
  console.log(`[cloud] Runtime: ${runtime.name}`);

  let browser: Browser;
  if (runtime.browser) {
    browser = runtime.browser;
  } else {
    browser = await runtime.chromium.launch({
      headless: true,
      ...(runtime.launchOptions ?? {}),
    });
  }

  browser.on('disconnected', () => {
    if (isShuttingDown) return;
    console.error('[cloud] Browser disconnected. Shutting down.');
    shutdown();
  });

  // Session manager
  const sessionManager = new SessionManager(
    createBrowserTargetFactory(browser),
    process.env.BROWSE_LOCAL_DIR || '.browse',
  );

  // Cloud session manager — tenant-scoped wrapper
  const cloudSessions = new CloudSessionManager(
    sessionManager,
    CLOUD_DEFAULTS.MAX_SESSIONS_PER_TENANT,
  );

  // ─── Container orchestrator (optional) ──────────────────

  const isolation = process.env.BROWSE_CLOUD_ISOLATION;
  let orchestrator: Orchestrator | null = null;
  let docker: DockerClient | null = null;

  // Track orchestrator sessions for the command handler
  const orchestratorHandles = new Map<string, SessionHandle>();

  if (isolation === 'container') {
    docker = new DockerClient();
    const reachable = await docker.ping();

    if (!reachable) {
      console.error('[cloud] Docker not reachable. Falling back to direct mode.');
      docker = null;
    } else {
      orchestrator = new ContainerOrchestrator({
        docker,
        imageName: process.env.BROWSE_CLOUD_IMAGE || 'browse-session',
      });
      console.log('[cloud] Container isolation enabled');
    }
  }

  // ─── Orphan container reaper (optional) ─────────────────

  let reaper: ContainerReaper | null = null;

  if (orchestrator instanceof ContainerOrchestrator && docker) {
    const containerOrch = orchestrator;
    reaper = new ContainerReaper({
      docker,
      getActiveIds: () => containerOrch.getActiveBackendIds(),
    });
    reaper.start();
  }

  // ─── Auth middleware ─────────────────────────────────────

  function authenticateJwt(req: Request): TenantContext | null {
    const token = extractBearerToken(req);
    if (!token) return null;
    const payload = validateJwt(token, config.jwtSecret);
    if (!payload) return null;
    return { tenantId: payload.tenantId, permissions: payload.permissions };
  }

  function requireAuth(req: Request): TenantContext | Response {
    const ctx = authenticateJwt(req);
    if (!ctx) return errorResponse('Unauthorized', 401);
    return ctx;
  }

  // ─── Route: POST /v1/auth ────────────────────────────────

  async function handleAuth(req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { apiKey } = body;
    if (!apiKey || typeof apiKey !== 'string') {
      return errorResponse('Missing or invalid "apiKey" field', 400);
    }

    const record = vault.validate(apiKey);
    if (!record) {
      return errorResponse('Invalid API key', 401);
    }

    const token = createJwt(
      { tenantId: record.tenantId, permissions: record.permissions },
      config.jwtSecret,
    );

    return jsonResponse({
      token,
      expiresIn: 900,
      tenantId: record.tenantId,
    });
  }

  // ─── Route: POST /v1/keys ────────────────────────────────

  async function handleCreateKey(req: Request): Promise<Response> {
    // Admin-only: requires BROWSE_CLOUD_ADMIN_KEY match
    if (!config.adminKey) {
      return errorResponse('Admin key not configured', 403);
    }

    const token = extractBearerToken(req);
    if (token !== config.adminKey) {
      return errorResponse('Forbidden', 403);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { tenantId, name } = body;
    if (!tenantId || typeof tenantId !== 'string') {
      return errorResponse('Missing or invalid "tenantId" field', 400);
    }
    if (!name || typeof name !== 'string') {
      return errorResponse('Missing or invalid "name" field', 400);
    }

    const result = vault.create(tenantId, name);
    return jsonResponse({ id: result.id, key: result.key, tenantId }, 201);
  }

  // ─── Route: POST /v1/sessions ────────────────────────────

  async function handleCreateSession(tenant: TenantContext, req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    try {
      // Container isolation path — provision via orchestrator
      if (orchestrator) {
        const handle = await orchestrator.provision(tenant.tenantId, {
          sessionId: body.sessionId || undefined,
          allowedDomains: body.allowedDomains || undefined,
        });
        orchestratorHandles.set(handle.sessionId, handle);

        return jsonResponse({
          sessionId: shortSessionId(handle.sessionId),
          createdAt: handle.createdAt,
        }, 201);
      }

      // Direct mode — provision via CloudSessionManager
      const result = await cloudSessions.provision(tenant.tenantId, {
        sessionId: body.sessionId || undefined,
        allowedDomains: body.allowedDomains || undefined,
      });

      return jsonResponse({
        sessionId: shortSessionId(result.sessionId),
        createdAt: result.createdAt,
      }, 201);
    } catch (err: any) {
      if (err instanceof TenantAccessError) {
        return errorResponse(err.message, 403);
      }
      // Session limit exceeded — the message already says "Session limit reached"
      if (err.message?.includes('Session limit reached')) {
        return errorResponse(err.message, 429);
      }
      throw err;
    }
  }

  // ─── Route: GET /v1/sessions ─────────────────────────────

  function handleListSessions(tenant: TenantContext): Response {
    // Container isolation — list from orchestrator
    if (orchestrator) {
      const handles = orchestrator.list(tenant.tenantId);
      const sessions = handles.map((h) => ({
        sessionId: shortSessionId(h.sessionId),
        backendId: h.backendId,
        createdAt: h.createdAt,
      }));
      return jsonResponse({ sessions });
    }

    // Direct mode — list from CloudSessionManager
    const sessions = cloudSessions.list(tenant.tenantId).map((s) => ({
      sessionId: shortSessionId(s.id),
      tabs: s.tabs,
      url: s.url,
      idleSeconds: s.idleSeconds,
    }));

    return jsonResponse({ sessions });
  }

  // ─── Route: DELETE /v1/sessions/:id ──────────────────────

  async function handleDeleteSession(tenant: TenantContext, sessionId: string): Promise<Response> {
    const fullId = `tenant:${tenant.tenantId}:session:${sessionId}`;

    try {
      // Container isolation — terminate via orchestrator
      if (orchestrator) {
        const handle = orchestratorHandles.get(fullId);
        if (!handle) {
          return errorResponse('Session not found', 404);
        }
        await orchestrator.terminate(handle);
        orchestratorHandles.delete(fullId);
        broadcastSessionEvent({ type: 'session', sessionId, event: 'terminated' });
        return jsonResponse({ deleted: true });
      }

      // Direct mode — terminate via CloudSessionManager
      await cloudSessions.terminate(tenant.tenantId, fullId);
      broadcastSessionEvent({ type: 'session', sessionId, event: 'terminated' });
      return jsonResponse({ deleted: true });
    } catch (err: any) {
      if (err instanceof TenantAccessError) {
        return errorResponse(err.message, 403);
      }
      if (err.message?.includes('not found')) {
        return errorResponse('Session not found', 404);
      }
      throw err;
    }
  }

  // ─── Route: POST /v1/sessions/:id/command ────────────────

  async function handleSessionCommand(tenant: TenantContext, sessionId: string, req: Request): Promise<Response> {
    const fullId = `tenant:${tenant.tenantId}:session:${sessionId}`;

    let body: any;
    try {
      body = await req.json();
    } catch {
      return errorResponse('Invalid JSON body', 400);
    }

    const { command, args = [] } = body;
    if (!command || typeof command !== 'string') {
      return errorResponse('Missing or invalid "command" field', 400);
    }

    try {
      // Container isolation — proxy to the container's internal server
      if (orchestrator) {
        const handle = orchestratorHandles.get(fullId);
        if (!handle) {
          return errorResponse('Session not found. Provision a session first.', 404);
        }

        const output = await orchestrator.executeCommand(handle, command, args);
        return jsonResponse({ output });
      }

      // Direct mode — execute in-process via SessionManager
      const session: Session = await cloudSessions.getOrCreate(tenant.tenantId, fullId);

      const result = await executeCommand(command, args, {
        context: {
          args,
          target: session.manager,
          buffers: session.buffers,
          domainFilter: session.domainFilter,
          session,
        },
      });

      return jsonResponse({
        output: result.output,
        durationMs: result.durationMs,
      });
    } catch (err: any) {
      if (err instanceof TenantAccessError) {
        return errorResponse(err.message, 403);
      }
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ─── Session idle cleanup ────────────────────────────────

  const cleanupInterval = setInterval(async () => {
    if (isShuttingDown) return;
    const closed = await sessionManager.closeIdleSessions(CLOUD_DEFAULTS.SESSION_IDLE_TIMEOUT_MS);
    for (const id of closed) {
      console.log(`[cloud] Session "${id}" idle — closed`);
      broadcastSessionEvent({ type: 'session', sessionId: shortSessionId(id), event: 'terminated' });
    }
  }, 60_000);

  // ─── HTTP server ─────────────────────────────────────────

  const startTime = Date.now();

  const server = nodeServe({
    port: config.port,
    hostname: config.host,
    fetch: async (req) => {
      const url = new URL(req.url);
      const segments = pathSegments(url.pathname);

      // GET /health — no auth
      if (url.pathname === '/health' && req.method === 'GET') {
        return jsonResponse({
          status: 'healthy',
          sessions: sessionManager.getSessionCount(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
          version: '1.0.0',
        });
      }

      // POST /v1/auth — API key exchange
      if (segments[0] === 'v1' && segments[1] === 'auth' && !segments[2] && req.method === 'POST') {
        return handleAuth(req);
      }

      // POST /v1/keys — admin create key
      if (segments[0] === 'v1' && segments[1] === 'keys' && !segments[2] && req.method === 'POST') {
        return handleCreateKey(req);
      }

      // All remaining /v1/ routes require JWT auth
      if (segments[0] === 'v1' && segments[1] === 'sessions') {
        const authResult = requireAuth(req);
        if (authResult instanceof Response) return authResult;
        const tenant = authResult;

        // POST /v1/sessions — create session
        if (!segments[2] && req.method === 'POST') {
          return handleCreateSession(tenant, req);
        }

        // GET /v1/sessions — list sessions
        if (!segments[2] && req.method === 'GET') {
          return handleListSessions(tenant);
        }

        // DELETE /v1/sessions/:id
        if (segments[2] && !segments[3] && req.method === 'DELETE') {
          return handleDeleteSession(tenant, segments[2]);
        }

        // POST /v1/sessions/:id/command
        if (segments[2] && segments[3] === 'command' && !segments[4] && req.method === 'POST') {
          return handleSessionCommand(tenant, segments[2], req);
        }
      }

      return errorResponse('Not found', 404);
    },
  });

  // ─── WebSocket upgrade ──────────────────────────────────

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, {
      jwtSecret: config.jwtSecret,
      getSessionBuffers: (tenantId: string, sessionId: string) => {
        // Validate tenant ownership via the session ID prefix
        if (!sessionId.startsWith(`tenant:${tenantId}:`)) return null;
        const session = sessionManager.getExisting(sessionId);
        return session?.buffers ?? null;
      },
    });
  });

  // ─── Shutdown ────────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[cloud] Shutting down...');

    clearInterval(cleanupInterval);
    closeAllConnections();

    // Stop the reaper before tearing down containers
    if (reaper) {
      reaper.stop();
    }

    // Shut down orchestrator-managed containers first
    if (orchestrator) {
      await orchestrator.shutdown().catch(() => {});
      orchestratorHandles.clear();
    }

    await sessionManager.closeAll().catch(() => {});
    browser.removeAllListeners('disconnected');
    await browser.close().catch(() => {});
    await runtime.close?.().catch(() => {});

    vault.close();
    server.close();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[cloud] Server running on http://${config.host}:${config.port}`);
  console.log(`[cloud] Database: ${config.dbPath}`);
  console.log(`[cloud] Sessions: ${sessionManager.getSessionCount()}`);
  if (config.adminKey) {
    console.log('[cloud] Admin key: configured');
  } else {
    console.log('[cloud] Admin key: not set (POST /v1/keys disabled)');
  }
}

start().catch((err) => {
  console.error(`[cloud] Failed to start: ${err.message}`);
  process.exit(1);
});
