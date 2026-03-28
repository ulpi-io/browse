/**
 * Profile lifecycle helpers — standalone functions for managing persistent
 * browser profile directories.
 *
 * The BrowserManager.launchPersistent() method and getIsPersistent() remain
 * in manager.ts because they depend on private BrowserManager state
 * (context, browser, isPersistent, nextTabId, etc.).
 *
 * TODO: When BrowserManager is further decomposed, move launchPersistent /
 * getIsPersistent here as well.
 */

import * as path from 'path';
import * as fs from 'fs';
import { sanitizeName } from '../security/sanitize';

/**
 * Get the profile directory path for a named profile.
 * Profiles live in .browse/profiles/<name>/
 */
export function getProfileDir(localDir: string, name: string): string {
  const sanitized = sanitizeName(name);
  if (!sanitized) throw new Error('Invalid profile name');
  return path.join(localDir, 'profiles', sanitized);
}

/**
 * List all profiles with metadata.
 */
export function listProfiles(localDir: string): Array<{ name: string; size: string; lastUsed: string }> {
  const profilesDir = path.join(localDir, 'profiles');
  if (!fs.existsSync(profilesDir)) return [];

  return fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const dir = path.join(profilesDir, d.name);
      const stat = fs.statSync(dir);
      // Approximate size by counting files
      let totalSize = 0;
      try {
        const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
        for (const f of files) {
          if (f.isFile()) {
            try { totalSize += fs.statSync(path.join((f as any).parentPath || (f as any).path || dir, f.name)).size; } catch {}
          }
        }
      } catch {}
      const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
      return {
        name: d.name,
        size: `${sizeMB}MB`,
        lastUsed: stat.mtime.toISOString().split('T')[0],
      };
    });
}

/**
 * Delete a profile directory.
 */
export function deleteProfile(localDir: string, name: string): void {
  const dir = getProfileDir(localDir, name);
  if (!fs.existsSync(dir)) throw new Error(`Profile "${name}" not found`);
  fs.rmSync(dir, { recursive: true, force: true });
}
