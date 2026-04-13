/**
 * Cloud session manager — tenant-scoped session lifecycle on top of SessionManager.
 *
 * Wraps the generic SessionManager with tenant isolation:
 *   - Session IDs are prefixed `tenant:<tenantId>:session:<id>`
 *   - Each tenant has a configurable session limit
 *   - All accessors validate tenant ownership before touching a session
 *
 * Throws TenantAccessError (maps to HTTP 403) when a tenant tries to
 * reach a session it does not own.
 */

import * as crypto from 'crypto';
import type { SessionManager, Session } from '../session/manager';

// ─── Errors ────────────────────────────────────────────────────

export class TenantAccessError extends Error {
  constructor(tenantId: string, sessionId: string) {
    super(`Tenant "${tenantId}" does not own session "${sessionId}"`);
    this.name = 'TenantAccessError';
  }
}

// ─── CloudSessionManager ───────────────────────────────────────

export class CloudSessionManager {
  private sessionManager: SessionManager;
  private maxSessionsPerTenant: number;
  /** Tracks which session IDs belong to each tenant */
  private tenantSessions = new Map<string, Set<string>>();

  constructor(sessionManager: SessionManager, maxSessionsPerTenant = 10) {
    this.sessionManager = sessionManager;
    this.maxSessionsPerTenant = maxSessionsPerTenant;
  }

  /**
   * Provision a new session for a tenant.
   *
   * Generates a scoped ID `tenant:<tenantId>:session:<id>`, creates the
   * underlying session via SessionManager, and tracks it in tenantSessions.
   *
   * Throws if the tenant has reached its session limit (429-friendly message).
   */
  async provision(
    tenantId: string,
    opts?: { allowedDomains?: string; sessionId?: string },
  ): Promise<{ sessionId: string; createdAt: string }> {
    if (this.isAtLimit(tenantId)) {
      throw new Error(
        `Session limit reached (max ${this.maxSessionsPerTenant} per tenant)`,
      );
    }

    const shortId = opts?.sessionId || crypto.randomUUID();
    const scopedId = `tenant:${tenantId}:session:${shortId}`;

    await this.sessionManager.getOrCreate(scopedId, opts?.allowedDomains);
    this.trackSession(tenantId, scopedId);

    return { sessionId: scopedId, createdAt: new Date().toISOString() };
  }

  /**
   * List sessions belonging to a tenant.
   *
   * Filters the global session list by the tenant prefix.
   */
  list(
    tenantId: string,
  ): Array<{ id: string; tabs: number; url: string; idleSeconds: number }> {
    const prefix = `tenant:${tenantId}:`;
    return this.sessionManager
      .listSessions()
      .filter((s) => s.id.startsWith(prefix))
      .map((s) => ({
        id: s.id,
        tabs: s.tabs,
        url: s.url,
        idleSeconds: s.idleSeconds,
      }));
  }

  /**
   * Get an existing session, verifying tenant ownership.
   *
   * Throws TenantAccessError if the session does not belong to the tenant.
   * Throws a generic Error if the session does not exist.
   */
  get(tenantId: string, sessionId: string): Session {
    this.validateTenantOwnership(tenantId, sessionId);

    const session = this.sessionManager.getExisting(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    return session;
  }

  /**
   * Get an existing session or create it, verifying tenant ownership.
   *
   * Throws TenantAccessError if the session ID does not match the tenant prefix.
   */
  async getOrCreate(
    tenantId: string,
    sessionId: string,
    allowedDomains?: string,
  ): Promise<Session> {
    this.validateTenantOwnership(tenantId, sessionId);

    const session = await this.sessionManager.getOrCreate(sessionId, allowedDomains);
    this.trackSession(tenantId, sessionId);
    return session;
  }

  /**
   * Terminate a session, verifying tenant ownership.
   *
   * Throws TenantAccessError if the session does not belong to the tenant.
   */
  async terminate(tenantId: string, sessionId: string): Promise<void> {
    this.validateTenantOwnership(tenantId, sessionId);

    await this.sessionManager.closeSession(sessionId);
    this.untrackSession(tenantId, sessionId);
  }

  /**
   * Return the number of sessions currently tracked for a tenant.
   */
  getSessionCount(tenantId: string): number {
    return this.tenantSessions.get(tenantId)?.size ?? 0;
  }

  /**
   * Check whether a tenant has reached its session limit.
   */
  isAtLimit(tenantId: string): boolean {
    return this.getSessionCount(tenantId) >= this.maxSessionsPerTenant;
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Validate that a session ID has the correct tenant prefix.
   * Throws TenantAccessError if the prefix does not match.
   */
  private validateTenantOwnership(tenantId: string, sessionId: string): void {
    if (!sessionId.startsWith(`tenant:${tenantId}:`)) {
      throw new TenantAccessError(tenantId, sessionId);
    }
  }

  /** Add a session ID to the tenant tracking set. */
  private trackSession(tenantId: string, sessionId: string): void {
    let set = this.tenantSessions.get(tenantId);
    if (!set) {
      set = new Set();
      this.tenantSessions.set(tenantId, set);
    }
    set.add(sessionId);
  }

  /** Remove a session ID from the tenant tracking set. */
  private untrackSession(tenantId: string, sessionId: string): void {
    const set = this.tenantSessions.get(tenantId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) {
      this.tenantSessions.delete(tenantId);
    }
  }
}
