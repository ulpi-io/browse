import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext } from 'playwright';
import { encrypt, decrypt } from './encryption';
import type { AutomationTarget } from '../automation/target';
import { SessionBuffers } from '../network/buffers';

const STATE_FILENAME = 'state.json';
const FROZEN_MANIFEST_FILENAME = 'frozen-manifest.json';

// ─── Freeze / Resume Types ──────────────────────────────────────

/** Full session state for cloud freeze/resume */
export interface FrozenSessionManifest {
  version: 1;
  sessionId: string;
  frozenAt: string;
  /** All tab URLs at freeze time */
  tabUrls: string[];
  /** Active tab index in tabUrls array */
  activeTabIndex: number;
  /** Session settings */
  contextLevel: string;
  settleMode: boolean;
  /** Domain filter domains (null if no filter) */
  allowedDomains: string[] | null;
  /** Path to cookies/storage state file (relative to session dir) */
  stateFile: string;
}

/**
 * Save session state (cookies + localStorage) to disk.
 * Calls context.storageState(), optionally encrypts, writes state.json.
 * Graceful: catches errors (context already closed, etc.) and logs warning.
 */
export async function saveSessionState(
  sessionDir: string,
  context: BrowserContext,
  encryptionKey?: Buffer,
): Promise<void> {
  try {
    const state = await context.storageState();
    const json = JSON.stringify(state, null, 2);

    let content: string;
    if (encryptionKey) {
      const { ciphertext, iv, authTag } = encrypt(json, encryptionKey);
      content = JSON.stringify({ encrypted: true, iv, authTag, data: ciphertext }, null, 2);
    } else {
      content = json;
    }

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, STATE_FILENAME), content, { mode: 0o600 });
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to save state: ${err.message}`);
  }
}

/**
 * Load session state from disk into a browser context.
 * Reads state.json, optionally decrypts, applies cookies via context.addCookies().
 * Restores localStorage by navigating to each origin with 3s timeout per origin.
 * Returns true if state was loaded, false if no file/corrupted (logs warning).
 * Does NOT throw on failure.
 */
export async function loadSessionState(
  sessionDir: string,
  context: BrowserContext,
  encryptionKey?: Buffer,
): Promise<boolean> {
  const statePath = path.join(sessionDir, STATE_FILENAME);

  if (!fs.existsSync(statePath)) {
    return false;
  }

  let stateData: any;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (parsed.encrypted) {
      if (!encryptionKey) {
        console.log('[session-persist] Warning: state file is encrypted but no encryption key provided');
        return false;
      }
      const decrypted = decrypt(parsed.data, parsed.iv, parsed.authTag, encryptionKey);
      stateData = JSON.parse(decrypted);
    } else {
      stateData = parsed;
    }
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to read/decrypt state file: ${err.message}`);
    return false;
  }

  try {
    if (stateData.cookies?.length) {
      try {
        await context.addCookies(stateData.cookies);
      } catch (err: any) {
        console.log(`[session-persist] Warning: failed to restore cookies: ${err.message}`);
      }
    }

    if (stateData.origins?.length) {
      for (const origin of stateData.origins) {
        if (!origin.localStorage?.length) continue;
        let page: any = null;
        try {
          page = await context.newPage();
          await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 3000 });
          for (const item of origin.localStorage) {
            await page.evaluate(
              ([k, v]: [string, string]) => localStorage.setItem(k, v),
              [item.name, item.value],
            );
          }
        } catch (err: any) {
          console.log(`[session-persist] Warning: failed to restore localStorage for ${origin.origin}: ${err.message}`);
        } finally {
          if (page) {
            try {
              await page.close();
            } catch (_) {
              // page may already be closed
            }
          }
        }
      }
    }

    return true;
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to load state: ${err.message}`);
    return false;
  }
}

/**
 * Check if a persisted state file exists.
 */
export function hasPersistedState(sessionDir: string): boolean {
  return fs.existsSync(path.join(sessionDir, STATE_FILENAME));
}

/**
 * Delete state files older than maxAgeDays from both directories:
 * - localDir/states/ (all .json files)
 * - localDir/sessions/<id>/state.json (auto-persisted)
 */
export function cleanOldStates(
  localDir: string,
  maxAgeDays: number,
): { deleted: number } {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  // Clean localDir/states/*.json
  const statesDir = path.join(localDir, 'states');
  if (fs.existsSync(statesDir)) {
    try {
      const entries = fs.readdirSync(statesDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const filePath = path.join(statesDir, entry);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch (_) {
          // stat or unlink failed, skip
        }
      }
    } catch (_) {
      // readdirSync failed, skip
    }
  }

  // Clean localDir/sessions/*/state.json
  const sessionsDir = path.join(localDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      const sessionDirs = fs.readdirSync(sessionsDir);
      for (const dir of sessionDirs) {
        const dirPath = path.join(sessionsDir, dir);
        try {
          const dirStat = fs.statSync(dirPath);
          if (!dirStat.isDirectory()) continue;
        } catch (_) {
          continue;
        }
        const statePath = path.join(dirPath, STATE_FILENAME);
        try {
          const stat = fs.statSync(statePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(statePath);
            deleted++;
          }
        } catch (_) {
          // file doesn't exist or stat/unlink failed, skip
        }
      }
    } catch (_) {
      // readdirSync failed, skip
    }
  }

  return { deleted };
}

// ─── Freeze / Resume Functions ──────────────────────────────────

/**
 * Freeze a session to disk — captures tabs, cookies, localStorage, and settings.
 *
 * Writes a FrozenSessionManifest to `<sessionDir>/frozen-manifest.json` and
 * delegates cookie/storage persistence to `saveSessionState()`.
 *
 * Graceful: never throws. Logs warnings on partial failure and returns a
 * best-effort manifest (empty tab list, etc.).
 */
export async function freezeSession(
  session: {
    id: string;
    manager: AutomationTarget;
    contextLevel: string;
    settleMode: boolean;
    domainFilter: { domains?: string[] } | null;
  },
  sessionDir: string,
  encryptionKey?: Buffer,
): Promise<FrozenSessionManifest> {
  let tabUrls: string[] = [];
  let activeTabIndex = 0;

  // 1. Collect tab URLs via duck-typed getTabList (BrowserTarget has it, others may not)
  try {
    const mgr = session.manager as unknown as Record<string, unknown>;
    if ('getTabList' in session.manager && typeof mgr.getTabList === 'function') {
      const tabs = mgr.getTabList() as Array<{ id: number; url: string; title: string; active: boolean }>;
      tabUrls = tabs.map((t) => t.url);
      const activeIdx = tabs.findIndex((t) => t.active);
      activeTabIndex = activeIdx >= 0 ? activeIdx : 0;
    } else {
      // Fallback: single location from the target contract
      const loc = session.manager.getCurrentLocation();
      if (loc) tabUrls = [loc];
    }
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to collect tab URLs during freeze: ${err.message}`);
  }

  // 2. Persist cookies/localStorage via existing saveSessionState
  try {
    const mgr = session.manager as unknown as Record<string, unknown>;
    if ('getContext' in session.manager && typeof mgr.getContext === 'function') {
      const context = mgr.getContext() as BrowserContext | null;
      if (context) {
        await saveSessionState(sessionDir, context, encryptionKey);
      }
    }
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to save browser state during freeze: ${err.message}`);
  }

  // 3. Build manifest
  const allowedDomains = session.domainFilter?.domains ?? null;

  const manifest: FrozenSessionManifest = {
    version: 1,
    sessionId: session.id,
    frozenAt: new Date().toISOString(),
    tabUrls,
    activeTabIndex,
    contextLevel: session.contextLevel,
    settleMode: session.settleMode,
    allowedDomains: allowedDomains && allowedDomains.length > 0 ? allowedDomains : null,
    stateFile: STATE_FILENAME,
  };

  // 4. Write manifest to disk
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, FROZEN_MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to write frozen manifest: ${err.message}`);
  }

  return manifest;
}

/**
 * Resume a session from a frozen manifest — creates a fresh target, restores
 * cookies/localStorage, and navigates to the previously open tabs.
 *
 * Graceful: never throws. Returns the created target even if state restore
 * or tab navigation partially fails (logs warnings).
 */
export async function resumeSession(
  manifest: FrozenSessionManifest,
  sessionDir: string,
  factory: { create(buffers: SessionBuffers, reuseContext: boolean): Promise<any> },
  encryptionKey?: Buffer,
): Promise<{
  target: AutomationTarget;
  createdTarget: any;
}> {
  // 1. Create a fresh target
  const buffers = new SessionBuffers();
  const createdTarget = await factory.create(buffers, false);
  const target: AutomationTarget = createdTarget.target;

  // 2. Restore cookies/localStorage if browser context is available
  try {
    if (typeof createdTarget.getContext === 'function') {
      const context = createdTarget.getContext() as BrowserContext | null;
      if (context) {
        await loadSessionState(sessionDir, context, encryptionKey);
      }
    }
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to restore state during resume: ${err.message}`);
  }

  // 3. Navigate to saved tab URLs
  if (manifest.tabUrls.length > 0) {
    // Navigate the first (already-open) tab to the first URL
    try {
      const mgr = target as unknown as Record<string, unknown>;
      if ('getPage' in target && typeof mgr.getPage === 'function') {
        const page = mgr.getPage() as { goto(url: string, opts?: any): Promise<any> };
        await page.goto(manifest.tabUrls[0], { waitUntil: 'domcontentloaded', timeout: 10000 });
      }
    } catch (err: any) {
      console.log(`[session-persist] Warning: failed to navigate first tab to ${manifest.tabUrls[0]}: ${err.message}`);
    }

    // Open additional tabs for remaining URLs
    for (let i = 1; i < manifest.tabUrls.length; i++) {
      try {
        const mgr = target as unknown as Record<string, unknown>;
        if ('newTab' in target && typeof mgr.newTab === 'function') {
          await (mgr.newTab as (url?: string) => Promise<unknown>)(manifest.tabUrls[i]);
        }
      } catch (err: any) {
        console.log(`[session-persist] Warning: failed to open tab for ${manifest.tabUrls[i]}: ${err.message}`);
      }
    }

    // Switch to the previously active tab
    if (manifest.activeTabIndex > 0 && manifest.activeTabIndex < manifest.tabUrls.length) {
      try {
        const mgr = target as unknown as Record<string, unknown>;
        if ('getTabList' in target && typeof mgr.getTabList === 'function') {
          const tabs = (mgr.getTabList as () => Array<{ id: number }>)();
          if (tabs[manifest.activeTabIndex]) {
            if ('switchTab' in target && typeof mgr.switchTab === 'function') {
              await (mgr.switchTab as (id: number) => Promise<void>)(tabs[manifest.activeTabIndex].id);
            }
          }
        }
      } catch (err: any) {
        console.log(`[session-persist] Warning: failed to switch to active tab index ${manifest.activeTabIndex}: ${err.message}`);
      }
    }
  }

  return { target, createdTarget };
}

/**
 * Check whether a frozen manifest file exists for a session directory.
 */
export function hasFrozenManifest(sessionDir: string): boolean {
  try {
    return fs.existsSync(path.join(sessionDir, FROZEN_MANIFEST_FILENAME));
  } catch {
    return false;
  }
}

/**
 * Load and parse a frozen manifest from a session directory.
 * Returns null if the file is missing, unreadable, or corrupt.
 */
export function loadFrozenManifest(sessionDir: string): FrozenSessionManifest | null {
  const manifestPath = path.join(sessionDir, FROZEN_MANIFEST_FILENAME);
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Basic structural validation
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      typeof parsed.sessionId === 'string' &&
      Array.isArray(parsed.tabUrls)
    ) {
      return parsed as FrozenSessionManifest;
    }

    console.log('[session-persist] Warning: frozen manifest has invalid structure');
    return null;
  } catch (err: any) {
    console.log(`[session-persist] Warning: failed to read frozen manifest: ${err.message}`);
    return null;
  }
}
