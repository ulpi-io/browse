/**
 * Config file loader — reads browse.json from project root.
 * Config values serve as defaults — CLI flags and env vars override.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName } from './security/sanitize';

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
  /** Maximum flow nesting depth (default: 10) */
  maxFlowDepth?: number;
  /** Auto-dismiss cookie/consent banners (default: false) */
  consentDismiss?: boolean;
  /** Force-click through overlays (default: false) */
  clickForce?: boolean;
  /** Wait for page readiness signals before commands (default: false) */
  readiness?: boolean;
  /** Enable SERP fast-path extraction (default: false) */
  serpFastpath?: boolean;
  /** Enable per-session command lock (default: true) */
  commandLock?: boolean;
  /** Tab inactivity timeout in ms (default: 1_800_000) */
  tabInactivityMs?: number;
  /** Camoufox browser runtime configuration */
  camoufox?: CamoufoxConfig;
}

/**
 * Find the project root by walking up from cwd looking for .git or .claude markers.
 * Returns the absolute path to the project root, or null if not found.
 */
export function findProjectRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load browse.json from the project root (directory containing .git or .claude).
 * Returns empty config if file doesn't exist or is malformed.
 */
export function loadConfig(): BrowseConfig {
  const root = findProjectRoot();
  if (!root) return {};

  const configPath = path.join(root, 'browse.json');
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

// --- Camoufox configuration ---

export interface CamoufoxConfig {
  os?: string | string[];
  blockImages?: boolean;
  blockWebrtc?: boolean;
  blockWebgl?: boolean;
  disableCoop?: boolean;
  geoip?: string | boolean;
  humanize?: boolean | number;
  locale?: string | string[];
  addons?: string[];
  fonts?: string[];
  customFontsOnly?: boolean;
  screen?: { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number };
  window?: [number, number];
  fingerprint?: Record<string, unknown>;
  ffVersion?: number;
  headless?: boolean | 'virtual';
  mainWorldEval?: boolean;
  firefoxUserPrefs?: Record<string, unknown>;
  proxy?: string | { server: string; username?: string; password?: string };
  enableCache?: boolean;
  debug?: boolean;
  excludeAddons?: string[];
  executablePath?: string;
  args?: string[];
  env?: Record<string, string>;
  virtualDisplay?: string;
}

const CAMOUFOX_KEY_MAP: Record<string, string> = {
  os: 'os', blockImages: 'block_images', blockWebrtc: 'block_webrtc',
  blockWebgl: 'block_webgl', disableCoop: 'disable_coop', geoip: 'geoip',
  humanize: 'humanize', locale: 'locale', addons: 'addons', fonts: 'fonts',
  customFontsOnly: 'custom_fonts_only', screen: 'screen', window: 'window',
  fingerprint: 'fingerprint', ffVersion: 'ff_version', headless: 'headless',
  mainWorldEval: 'main_world_eval', firefoxUserPrefs: 'firefox_user_prefs',
  proxy: 'proxy', enableCache: 'enable_cache', debug: 'debug',
  excludeAddons: 'exclude_addons', executablePath: 'executable_path',
  args: 'args', env: 'env', virtualDisplay: 'virtual_display',
};

/**
 * Map CamoufoxConfig (camelCase) keys to camoufox-js snake_case keys.
 */
export function mapCamoufoxConfig(config: CamoufoxConfig): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const snakeKey = CAMOUFOX_KEY_MAP[key];
    if (snakeKey) mapped[snakeKey] = value;
  }
  return mapped;
}

/**
 * Load camoufox config from browse.json + optional named profile.
 * Profile selected via BROWSE_CAMOUFOX_PROFILE env var.
 * Profile files live in <localDir>/camoufox-profiles/<name>.json.
 */
export function loadCamoufoxConfig(localDir?: string): CamoufoxConfig {
  // 1. Read browse.json camoufox section
  const config = loadConfig();
  const base: CamoufoxConfig = config.camoufox ?? {};

  // 2. Check for named profile
  const profileName = process.env.BROWSE_CAMOUFOX_PROFILE;
  if (!profileName) return base;

  // 3. Resolve profile path — respect BROWSE_LOCAL_DIR, then project root .browse/
  const resolvedLocalDir = localDir
    || process.env.BROWSE_LOCAL_DIR
    || (() => { const root = findProjectRoot(); return root ? path.join(root, '.browse') : '/tmp'; })();
  const dir = path.join(resolvedLocalDir, 'camoufox-profiles');

  const safeName = sanitizeName(profileName);
  const profilePath = path.join(dir, `${safeName}.json`);

  if (!fs.existsSync(profilePath)) {
    // List available profiles
    let available: string[] = [];
    if (fs.existsSync(dir)) {
      available = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    }
    const list = available.length > 0 ? ` Available: ${available.join(', ')}` : ' No profiles found in ' + dir;
    throw new Error(`Camoufox profile "${profileName}" not found at ${profilePath}.${list}`);
  }

  // 4. Parse and merge
  try {
    const raw = fs.readFileSync(profilePath, 'utf-8');
    const profile = JSON.parse(raw) as CamoufoxConfig;
    return { ...base, ...profile };
  } catch (err) {
    console.error(`[browse] Warning: malformed camoufox profile ${profilePath}: ${(err as Error).message}. Using browse.json defaults.`);
    return base;
  }
}
