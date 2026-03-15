/**
 * Action policy — gate commands via JSON config
 *
 * File: browse-policy.json (project root) or BROWSE_POLICY env var
 * Format: { default: "allow"|"deny", deny?: string[], confirm?: string[], allow?: string[] }
 * Precedence: deny > confirm > allow whitelist > default
 * Hot-reloads on mtime change.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ActionPolicy {
  default?: 'allow' | 'deny';
  deny?: string[];
  confirm?: string[];
  allow?: string[];
}

export type PolicyResult = 'allow' | 'deny' | 'confirm';

/**
 * Walk up from cwd looking for a file by name.
 * Returns the full path if found, or null.
 */
function findFileUpward(filename: string): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export class PolicyChecker {
  private filePath: string | null = null;
  private lastMtime: number = 0;
  private policy: ActionPolicy | null = null;
  private confirmOverrides: Set<string> | null = null;

  constructor(filePath?: string) {
    // Explicit path from env or argument, or walk up from cwd to find browse-policy.json.
    this.filePath = filePath || process.env.BROWSE_POLICY || findFileUpward('browse-policy.json') || 'browse-policy.json';

    // Parse BROWSE_CONFIRM_ACTIONS env var
    const confirmEnv = process.env.BROWSE_CONFIRM_ACTIONS;
    if (confirmEnv) {
      this.confirmOverrides = new Set(
        confirmEnv.split(',').map(s => s.trim()).filter(Boolean)
      );
    }

    this.reload();
  }

  private reload(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs === this.lastMtime) return;
      this.lastMtime = stat.mtimeMs;

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.policy = JSON.parse(raw);
    } catch {
      // File missing or invalid — if it was loaded before, keep last-known-good.
      // If it never existed, policy stays null (everything allowed).
    }
  }

  check(command: string): PolicyResult {
    this.reload();

    // Env var overrides take priority for confirm
    if (this.confirmOverrides?.has(command)) return 'confirm';

    if (!this.policy) return 'allow';

    // Precedence: deny > confirm > allow whitelist > default
    if (this.policy.deny?.includes(command)) return 'deny';
    if (this.policy.confirm?.includes(command)) return 'confirm';
    if (this.policy.allow) {
      return this.policy.allow.includes(command) ? 'allow' : 'deny';
    }
    return this.policy.default || 'allow';
  }

  isActive(): boolean {
    return this.policy !== null || this.confirmOverrides !== null;
  }
}
