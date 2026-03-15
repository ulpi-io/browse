/**
 * Action policy — gate commands via JSON config
 *
 * File: browse-policy.json (project root) or BROWSE_POLICY env var
 * Format: { default: "allow"|"deny", deny?: string[], confirm?: string[], allow?: string[] }
 * Precedence: deny > confirm > allow whitelist > default
 * Hot-reloads on mtime change.
 */

import * as fs from 'fs';

interface ActionPolicy {
  default?: 'allow' | 'deny';
  deny?: string[];
  confirm?: string[];
  allow?: string[];
}

export type PolicyResult = 'allow' | 'deny' | 'confirm';

export class PolicyChecker {
  private filePath: string | null = null;
  private lastMtime: number = 0;
  private policy: ActionPolicy | null = null;
  private confirmOverrides: Set<string> | null = null;

  constructor(filePath?: string) {
    // Explicit path from env or argument
    this.filePath = filePath || process.env.BROWSE_POLICY || null;

    // Auto-discover browse-policy.json in project root
    if (!this.filePath) {
      const candidates = ['browse-policy.json'];
      for (const name of candidates) {
        if (fs.existsSync(name)) {
          this.filePath = name;
          break;
        }
      }
    }

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
    if (!this.filePath) return;

    try {
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs === this.lastMtime) return;
      this.lastMtime = stat.mtimeMs;

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.policy = JSON.parse(raw);
    } catch {
      // File missing or invalid — keep last-known-good policy
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
