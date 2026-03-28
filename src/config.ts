/**
 * Config file loader — reads browse.json from project root.
 * Config values serve as defaults — CLI flags and env vars override.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BrowseConfig {
  session?: string;
  json?: boolean;
  contentBoundaries?: boolean;
  allowedDomains?: string[];
  idleTimeout?: number;
  viewport?: string;
  device?: string;
  context?: boolean;
  networkBodies?: boolean;
  /** Default session ID — overrides BROWSE_SESSION env var */
  defaultSession?: string;
  /** Default context level ('off' | 'on' | 'full') */
  defaultContext?: string;
  /** Flow files to execute automatically on server startup */
  startupFlows?: string[];
  /** Extra directories to search for .browse/detections/*.json files */
  detectionPaths?: string[];
  /** Extra directories to search for rule files */
  rulePaths?: string[];
  /** Extra directories to search for flow YAML files */
  flowPaths?: string[];
}

/**
 * Load browse.json from the project root (directory containing .git or .claude).
 * Returns empty config if file doesn't exist or is malformed.
 */
export function loadConfig(): BrowseConfig {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      const configPath = path.join(dir, 'browse.json');
      if (fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          return JSON.parse(raw) as BrowseConfig;
        } catch {
          // Malformed JSON — silently ignore
          return {};
        }
      }
      return {};
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}
