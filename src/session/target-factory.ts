/**
 * SessionTargetFactory — decouples session creation from concrete target types.
 *
 * SessionManager uses this factory to create automation targets instead of
 * constructing BrowserManager directly. This is the structural seam for:
 *   - v2.0 AppManager (native app automation)
 *   - v2.2 plugin-provided targets
 *
 * The default implementation (createBrowserTargetFactory) creates browser-backed
 * sessions with the same behavior as the pre-factory code.
 */

import type { Browser, BrowserContext } from 'playwright';
import type { AutomationTarget } from '../automation/target';
import type { SessionBuffers } from '../network/buffers';
import type { DomainFilter } from '../security/domain-filter';

/** Result of target creation — the target plus browser-specific accessors for session setup */
export interface CreatedTarget {
  /** The automation target (stored on Session.manager) */
  target: AutomationTarget;
  /** Get the browser context for session setup (cookies, routing, init scripts) */
  getContext(): BrowserContext | null;
  /** Set domain filter on the target */
  setDomainFilter(filter: DomainFilter): void;
  /** Set init script on the target */
  setInitScript(script: string): void;
  /** Get tab list for domain filter injection into open pages */
  getTabList(): Array<{ id: number; url: string; title: string; active: boolean }>;
  /** Get a specific page by tab ID */
  getPageById(id: number): unknown;
  /** Get tab count for session listing */
  getTabCount(): number;
}

/** Factory interface for creating automation targets within sessions */
export interface SessionTargetFactory {
  /**
   * Create a new automation target for a session.
   * @param buffers - Per-session buffer container
   * @param reuseContext - Whether to reuse the first browser context (chrome runtime)
   */
  create(buffers: SessionBuffers, reuseContext: boolean): Promise<CreatedTarget>;
}

/**
 * Create a persistent browser target for profile mode.
 * Profile mode launches its own Chromium with persistent storage — no session multiplexing.
 */
export async function createPersistentBrowserTarget(
  profileDir: string,
  onCrash: () => void,
): Promise<CreatedTarget> {
  const { BrowserManager } = await import('../browser/manager');
  const bm = new BrowserManager();
  await bm.launchPersistent(profileDir, onCrash);
  return {
    target: bm,
    getContext: () => bm.getContext(),
    setDomainFilter: (filter) => bm.setDomainFilter(filter),
    setInitScript: (script) => bm.setInitScript(script),
    getTabList: () => bm.getTabList(),
    getPageById: (id) => bm.getPageById(id),
    getTabCount: () => bm.getTabCount(),
  };
}

/**
 * Create the default browser-backed target factory.
 * This preserves the exact same behavior as the pre-factory SessionManager code.
 */
export function createBrowserTargetFactory(browser: Browser): SessionTargetFactory {
  return {
    async create(buffers: SessionBuffers, reuseContext: boolean): Promise<CreatedTarget> {
      const { BrowserManager } = await import('../browser/manager');
      const bm = new BrowserManager(buffers);
      await bm.launchWithBrowser(browser, reuseContext);
      return {
        target: bm,
        getContext: () => bm.getContext(),
        setDomainFilter: (filter) => bm.setDomainFilter(filter),
        setInitScript: (script) => bm.setInitScript(script),
        getTabList: () => bm.getTabList(),
        getPageById: (id) => bm.getPageById(id),
        getTabCount: () => bm.getTabCount(),
      };
    },
  };
}

/**
 * Create an app-backed target factory for native app automation (macOS first).
 * The factory resolves the app by name, spawns the bridge, and creates AppManager instances.
 */
export function createAppTargetFactory(appName: string): SessionTargetFactory {
  return {
    async create(buffers: SessionBuffers): Promise<CreatedTarget> {
      const { ensureMacOSBridge, createMacOSBridge } = await import('../app/macos/bridge');
      const { AppManager } = await import('../app/manager');
      const bridgePath = await ensureMacOSBridge();

      // Resolve PID from app name
      const { execSync } = await import('child_process');
      let pid: number;
      try {
        const output = execSync(`pgrep -x "${appName}"`, { encoding: 'utf-8' }).trim();
        const pids = output.split('\n').filter(Boolean).map(Number);
        if (pids.length === 0) throw new Error(`App '${appName}' is not running`);
        if (pids.length > 1) throw new Error(`Multiple processes match '${appName}': PIDs ${pids.join(', ')}. Use a more specific name.`);
        pid = pids[0];
      } catch (err: any) {
        if (err.message.includes('is not running') || err.message.includes('Multiple')) throw err;
        throw new Error(`App '${appName}' is not running`);
      }

      const bridge = createMacOSBridge(bridgePath, pid);
      const manager = new AppManager(bridge, appName);

      return {
        target: manager,
        getContext: () => null,
        setDomainFilter: () => {},
        setInitScript: () => {},
        getTabList: () => [],
        getPageById: () => undefined,
        getTabCount: () => 0,
      };
    },
  };
}
