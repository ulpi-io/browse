/**
 * Session manager — multiplexes multiple agents on a single automation target
 *
 * Each session gets its own automation target (tabs, refs, cookies, storage)
 * created through a SessionTargetFactory. The factory determines the concrete
 * target type (browser today, app/plugin targets in the future).
 * Sessions are identified by string IDs (from X-Browse-Session header).
 */

import { SessionBuffers } from '../network/buffers';
import { DomainFilter } from '../security/domain-filter';
import { sanitizeName } from '../security/sanitize';
import { saveSessionState, loadSessionState, hasPersistedState } from './persist';
import { resolveEncryptionKey } from './encryption';
import type { ContextLevel } from '../types';
import type { AutomationTarget } from '../automation/target';
import type { SessionTargetFactory, CreatedTarget } from './target-factory';
import type { RecordedStep } from '../export/record';
import * as fs from 'fs';
import * as path from 'path';

export type { RecordedStep };

export interface Session {
  id: string;
  manager: AutomationTarget;
  buffers: SessionBuffers;
  domainFilter: DomainFilter | null;
  recording: RecordedStep[] | null;
  lastRecording: RecordedStep[] | null;
  outputDir: string;
  lastActivity: number;
  createdAt: number;
  contextLevel: ContextLevel;
  /** When true, write commands auto-wait for page settled signal before returning */
  settleMode: boolean;
  /** Proxy pool reference — stored for status/inspection by future commands */
  proxyPool?: import('../proxy').ProxyPool | null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Factory-created target accessors for setup operations that need target-specific methods */
  private targets = new Map<string, CreatedTarget>();
  private factory: SessionTargetFactory;
  /** Per-session factory overrides (e.g. app:TextEdit uses AppTargetFactory) */
  private appFactories = new Map<string, SessionTargetFactory>();
  private localDir: string;
  private encryptionKey: Buffer | undefined;
  private reuseContext: boolean;
  /** Proxy pool — stored so sessions can reference it for status/rotation */
  proxyPool?: import('../proxy').ProxyPool | null;

  constructor(factory: SessionTargetFactory, localDir: string = '/tmp', reuseContext = false) {
    this.factory = factory;
    this.localDir = localDir;
    this.reuseContext = reuseContext;
    try {
      this.encryptionKey = resolveEncryptionKey(localDir);
    } catch {
      // Encryption not available — persist unencrypted
    }
  }

  /**
   * Register an alternative target factory for a specific session ID.
   * Used by the server to direct app:* sessions to the app target factory.
   */
  setAppFactory(sessionId: string, factory: SessionTargetFactory): void {
    this.appFactories.set(sessionId, factory);
  }

  /**
   * Check if an app factory is registered for a session ID.
   */
  hasAppFactory(sessionId: string): boolean {
    return this.appFactories.has(sessionId);
  }

  /**
   * Get an existing session without creating one.
   * Returns undefined if the session doesn't exist.
   */
  getExisting(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get an existing session or create a new one.
   * Creating a session uses the target factory to provision a new automation target.
   * If an app factory is registered for this session ID, it takes precedence.
   */
  async getOrCreate(sessionId: string, allowedDomains?: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      // Update domain filter if provided and session doesn't already have one
      if (allowedDomains && !session.domainFilter) {
        const domains = allowedDomains.split(',').map(d => d.trim()).filter(Boolean);
        if (domains.length > 0) {
          const ct = this.targets.get(sessionId)!;
          const domainFilter = new DomainFilter(domains);
          ct.setDomainFilter(domainFilter);
          const context = ct.getContext();
          if (context) {
            await context.route('**/*', (route: any) => {
              const url = route.request().url();
              if (domainFilter.isAllowed(url)) {
                route.fallback();
              } else {
                route.abort('blockedbyclient');
              }
            });
            const initScript = domainFilter.generateInitScript();
            await context.addInitScript(initScript);
            ct.setInitScript(initScript);
            // Inject filter script into ALL open tabs immediately
            for (const tab of ct.getTabList()) {
              try {
                const page = ct.getPageById(tab.id) as any;
                if (page) await page.evaluate(initScript);
              } catch {}
            }
          }
          session.domainFilter = domainFilter;
        }
      }
      return session;
    }

    // Create per-session output directory
    const outputDir = path.join(this.localDir, 'sessions', sanitizeName(sessionId));
    fs.mkdirSync(outputDir, { recursive: true });

    const buffers = new SessionBuffers();
    const effectiveFactory = this.appFactories.get(sessionId) ?? this.factory;
    const ct = await effectiveFactory.create(buffers, this.reuseContext && this.sessions.size === 0, { sessionId });

    // Apply domain filter if allowed domains are specified
    let domainFilter: DomainFilter | null = null;
    if (allowedDomains) {
      const domains = allowedDomains.split(',').map(d => d.trim()).filter(Boolean);
      if (domains.length > 0) {
        domainFilter = new DomainFilter(domains);
        ct.setDomainFilter(domainFilter);
        const context = ct.getContext();
        if (context) {
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (domainFilter!.isAllowed(url)) {
              route.fallback();
            } else {
              route.abort('blockedbyclient');
            }
          });
          const initScript = domainFilter.generateInitScript();
          await context.addInitScript(initScript);
          ct.setInitScript(initScript);
        }
      }
    }

    session = {
      id: sessionId,
      manager: ct.target,
      buffers,
      domainFilter,
      recording: null,
      lastRecording: null,
      outputDir,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      contextLevel: 'off',
      settleMode: false,
      proxyPool: this.proxyPool ?? null,
    };
    this.sessions.set(sessionId, session);
    this.targets.set(sessionId, ct);
    console.log(`[browse] Session "${sessionId}" created`);

    // Auto-restore persisted state for named sessions (not "default")
    if (sessionId !== 'default' && hasPersistedState(outputDir)) {
      const context = ct.getContext();
      if (context) {
        await loadSessionState(outputDir, context, this.encryptionKey);
        console.log(`[browse] Session "${sessionId}" state restored`);
      }
    }

    return session;
  }

  /**
   * Close and remove a specific session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    // Auto-save state for named sessions (not "default")
    if (sessionId !== 'default') {
      const ct = this.targets.get(sessionId);
      const context = ct?.getContext();
      if (context) {
        await saveSessionState(session.outputDir, context, this.encryptionKey);
      }
    }

    await session.manager.close();
    this.sessions.delete(sessionId);
    this.targets.delete(sessionId);
    console.log(`[browse] Session "${sessionId}" closed`);
  }

  /**
   * Close sessions idle longer than maxIdleMs.
   * Returns list of closed session IDs.
   */
  async closeIdleSessions(maxIdleMs: number, flushFn?: (session: Session) => void): Promise<string[]> {
    const now = Date.now();
    const closed: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > maxIdleMs) {
        if (flushFn) flushFn(session);
        // Auto-save state for named sessions (not "default")
        if (id !== 'default') {
          const ct = this.targets.get(id);
          const context = ct?.getContext();
          if (context) {
            await saveSessionState(session.outputDir, context, this.encryptionKey).catch(() => {});
          }
        }
        await session.manager.close().catch(() => {});
        this.sessions.delete(id);
        this.targets.delete(id);
        closed.push(id);
      }
    }

    return closed;
  }

  /**
   * List all active sessions (for status/sessions commands).
   */
  listSessions(): Array<{ id: string; tabs: number; url: string; idleSeconds: number; active: boolean }> {
    const now = Date.now();
    return [...this.sessions.entries()].map(([id, session]) => {
      const ct = this.targets.get(id);
      return {
        id,
        tabs: ct?.getTabCount() ?? 0,
        url: session.manager.getCurrentLocation(),
        idleSeconds: Math.floor((now - session.lastActivity) / 1000),
        active: true,
      };
    });
  }

  /**
   * Get all sessions (for buffer flush iteration).
   */
  getAllSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Close all sessions (for server shutdown).
   */
  async closeAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      // Auto-save state for named sessions (not "default")
      if (id !== 'default') {
        const ct = this.targets.get(id);
        const context = ct?.getContext();
        if (context) {
          await saveSessionState(session.outputDir, context, this.encryptionKey).catch(() => {});
        }
      }
      await session.manager.close().catch(() => {});
    }
    this.sessions.clear();
    this.targets.clear();
  }
}
