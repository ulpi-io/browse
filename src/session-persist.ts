import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext } from 'playwright';
import { encrypt, decrypt } from './encryption';

const STATE_FILENAME = 'state.json';

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
