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

import * as crypto from 'crypto';
import * as http from 'http';
import { getRuntime, type BrowserRuntime } from '../engine/resolver';
import { SessionManager, type Session } from '../session/manager';
import { createBrowserTargetFactory } from '../session/target-factory';
import { executeCommand } from '../automation/executor';
import { ensureDefinitionsRegistered } from '../automation/registry';
import { ApiKeyVault, createJwt, validateJwt, resolveJwtSecret } from './auth';
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

/** Build the tenant-scoped session ID */
function tenantSessionId(tenantId: string, sessionId: string): string {
  return `tenant:${tenantId}:session:${sessionId}`;
}

/** Extract the short session ID from a tenant-scoped ID */
function shortSessionId(fullId: string): string {
  const parts = fullId.split(':session:');
  return parts.length > 1 ? parts[1] : fullId;
}

/** Check if a full session ID belongs to a tenant */
function isOwnedByTenant(fullId: string, tenantId: string): boolean {
  return fullId.startsWith(`tenant:${tenantId}:session:`);
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

    const sessionId = body.sessionId || crypto.randomUUID();
    const fullId = tenantSessionId(tenant.tenantId, sessionId);

    // Check tenant session limit
    const tenantSessions = sessionManager.getAllSessions()
      .filter(s => isOwnedByTenant(s.id, tenant.tenantId));
    if (tenantSessions.length >= CLOUD_DEFAULTS.MAX_SESSIONS_PER_TENANT) {
      return errorResponse(
        `Session limit reached (max ${CLOUD_DEFAULTS.MAX_SESSIONS_PER_TENANT} per tenant)`,
        429,
      );
    }

    const allowedDomains = body.allowedDomains || undefined;
    await sessionManager.getOrCreate(fullId, allowedDomains);

    return jsonResponse({
      sessionId,
      createdAt: new Date().toISOString(),
    }, 201);
  }

  // ─── Route: GET /v1/sessions ─────────────────────────────

  function handleListSessions(tenant: TenantContext): Response {
    const all = sessionManager.listSessions();
    const tenantSessions = all
      .filter(s => isOwnedByTenant(s.id, tenant.tenantId))
      .map(s => ({
        sessionId: shortSessionId(s.id),
        tabs: s.tabs,
        url: s.url,
        idleSeconds: s.idleSeconds,
      }));

    return jsonResponse({ sessions: tenantSessions });
  }

  // ─── Route: DELETE /v1/sessions/:id ──────────────────────

  async function handleDeleteSession(tenant: TenantContext, sessionId: string): Promise<Response> {
    const fullId = tenantSessionId(tenant.tenantId, sessionId);

    const existing = sessionManager.getExisting(fullId);
    if (!existing) {
      return errorResponse('Session not found', 404);
    }

    await sessionManager.closeSession(fullId);
    return jsonResponse({ deleted: true });
  }

  // ─── Route: POST /v1/sessions/:id/command ────────────────

  async function handleSessionCommand(tenant: TenantContext, sessionId: string, req: Request): Promise<Response> {
    const fullId = tenantSessionId(tenant.tenantId, sessionId);

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

    // Ensure session exists (lazy-create on first command)
    const session: Session = await sessionManager.getOrCreate(fullId);

    try {
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
      return jsonResponse({ error: err.message }, 500);
    }
  }

  // ─── Session idle cleanup ────────────────────────────────

  const cleanupInterval = setInterval(async () => {
    if (isShuttingDown) return;
    const closed = await sessionManager.closeIdleSessions(CLOUD_DEFAULTS.SESSION_IDLE_TIMEOUT_MS);
    for (const id of closed) {
      console.log(`[cloud] Session "${id}" idle — closed`);
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

  // ─── Shutdown ────────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('[cloud] Shutting down...');

    clearInterval(cleanupInterval);

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
