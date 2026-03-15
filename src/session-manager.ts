/**
 * Session manager — multiplexes multiple agents on a single Chromium instance
 *
 * Each session gets its own BrowserManager (tabs, refs, cookies, storage)
 * backed by an isolated BrowserContext on the shared Browser.
 * Sessions are identified by string IDs (from X-Browse-Session header).
 */

import type { Browser } from 'playwright';
import { BrowserManager } from './browser-manager';
import { SessionBuffers } from './buffers';
import { DomainFilter } from './domain-filter';
import { sanitizeName } from './sanitize';
import * as fs from 'fs';
import * as path from 'path';

export interface Session {
  id: string;
  manager: BrowserManager;
  buffers: SessionBuffers;
  domainFilter: DomainFilter | null;
  outputDir: string;
  lastActivity: number;
  createdAt: number;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private browser: Browser;
  private localDir: string;

  constructor(browser: Browser, localDir: string = '/tmp') {
    this.browser = browser;
    this.localDir = localDir;
  }

  /**
   * Get an existing session or create a new one.
   * Creating a session launches a new BrowserContext on the shared Chromium.
   */
  async getOrCreate(sessionId: string, allowedDomains?: string): Promise<Session> {
    let session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      // Update domain filter if provided and session doesn't already have one
      if (allowedDomains && !session.domainFilter) {
        const domains = allowedDomains.split(',').map(d => d.trim()).filter(Boolean);
        if (domains.length > 0) {
          const domainFilter = new DomainFilter(domains);
          session.manager.setDomainFilter(domainFilter);
          const context = session.manager.getContext();
          if (context) {
            await context.route('**/*', (route) => {
              const url = route.request().url();
              if (domainFilter.isAllowed(url)) {
                route.continue();
              } else {
                route.abort('blockedbyclient');
              }
            });
            const initScript = domainFilter.generateInitScript();
            await context.addInitScript(initScript);
            session.manager.setInitScript(initScript);
            // Inject filter script into the current page immediately
            try {
              const page = session.manager.getPage();
              await page.evaluate(initScript);
            } catch {}
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
    const manager = new BrowserManager(buffers);
    await manager.launchWithBrowser(this.browser);

    // Apply domain filter if allowed domains are specified
    let domainFilter: DomainFilter | null = null;
    if (allowedDomains) {
      const domains = allowedDomains.split(',').map(d => d.trim()).filter(Boolean);
      if (domains.length > 0) {
        domainFilter = new DomainFilter(domains);
        manager.setDomainFilter(domainFilter);
        const context = manager.getContext();
        if (context) {
          // Block disallowed domains at the network level via Playwright route()
          await context.route('**/*', (route) => {
            const url = route.request().url();
            if (domainFilter!.isAllowed(url)) {
              route.continue();
            } else {
              route.abort('blockedbyclient');
            }
          });
          // Block WebSocket, EventSource, sendBeacon via JS injection
          const initScript = domainFilter.generateInitScript();
          await context.addInitScript(initScript);
          manager.setInitScript(initScript);
        }
      }
    }

    session = {
      id: sessionId,
      manager,
      buffers,
      domainFilter,
      outputDir,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    console.log(`[browse] Session "${sessionId}" created`);
    return session;
  }

  /**
   * Close and remove a specific session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);

    await session.manager.close();
    this.sessions.delete(sessionId);
    console.log(`[browse] Session "${sessionId}" closed`);
  }

  /**
   * Close sessions idle longer than maxIdleMs.
   * Returns list of closed session IDs.
   */
  async closeIdleSessions(maxIdleMs: number): Promise<string[]> {
    const now = Date.now();
    const closed: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > maxIdleMs) {
        await session.manager.close().catch(() => {});
        this.sessions.delete(id);
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
    return [...this.sessions.entries()].map(([id, session]) => ({
      id,
      tabs: session.manager.getTabCount(),
      url: session.manager.getCurrentUrl(),
      idleSeconds: Math.floor((now - session.lastActivity) / 1000),
      active: true,
    }));
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
      await session.manager.close().catch(() => {});
    }
    this.sessions.clear();
  }
}
