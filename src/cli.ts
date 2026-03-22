/**
 * browse CLI — thin wrapper that talks to the persistent server
 *
 * Flow:
 *   1. Read /tmp/browse-server.json for port + token
 *   2. If missing or stale PID → start server in background
 *   3. Health check
 *   4. Send command via HTTP POST
 *   5. Print response to stdout (or stderr for errors)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { DEFAULTS } from './constants';
import { loadConfig } from './config';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// Global CLI flags — set in main(), used by sendCommand()
const cliFlags = {
  json: false,
  contentBoundaries: false,
  allowedDomains: '' as string,
  headed: false,
  stateFile: '' as string,
  maxOutput: 0,
  cdpUrl: '' as string,
  profile: '' as string,
};

// Track whether --state has been applied (only sent on first command)
let stateFileApplied = false;

const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
// One server per project directory by default. Sessions handle agent isolation.
// For multiple servers on the same project: set BROWSE_INSTANCE or BROWSE_PORT.
const BROWSE_INSTANCE = process.env.BROWSE_INSTANCE || '';
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : (BROWSE_INSTANCE ? `-${BROWSE_INSTANCE}` : '');

/**
 * Resolve the project-local .browse/ directory for state files, logs, screenshots.
 * Walks up from cwd looking for .git/ or .claude/ (project root markers).
 * Creates <root>/.browse/ with a self-contained .gitignore.
 * Falls back to /tmp/ if not found (e.g. running outside a project).
 */
function resolveLocalDir(): string {
  if (process.env.BROWSE_LOCAL_DIR) {
    try { fs.mkdirSync(process.env.BROWSE_LOCAL_DIR, { recursive: true }); } catch {}
    return process.env.BROWSE_LOCAL_DIR;
  }

  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      const browseDir = path.join(dir, '.browse');
      try {
        fs.mkdirSync(browseDir, { recursive: true });
        // Self-contained .gitignore — users don't need to add .browse/ to their .gitignore
        const gi = path.join(browseDir, '.gitignore');
        if (!fs.existsSync(gi)) {
          fs.writeFileSync(gi, '*\n');
        }
      } catch {}
      return browseDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '/tmp';
}

const LOCAL_DIR = resolveLocalDir();
const STATE_FILE = process.env.BROWSE_STATE_FILE || path.join(LOCAL_DIR, `browse-server${INSTANCE_SUFFIX}.json`);
const MAX_START_WAIT = 8000; // 8 seconds to start
const LOCK_FILE = STATE_FILE + '.lock';
const LOCK_STALE_MS = DEFAULTS.LOCK_STALE_THRESHOLD_MS;

const __filename_cli = fileURLToPath(import.meta.url);
const __dirname_cli = path.dirname(__filename_cli);

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = __dirname_cli,
): string {
  // 1. Explicit env var override
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // 2. Dev mode: server.ts adjacent to cli.ts
  if (metaDir.startsWith('/')) {
    const direct = path.resolve(metaDir, 'server.ts');
    if (fs.existsSync(direct)) {
      return direct;
    }
  }

  // 3. Bundled mode: self-spawn (cli.ts and server.ts are in the same bundle)
  //    The bundle checks __BROWSE_SERVER_MODE to decide which path to run.
  const selfPath = fileURLToPath(import.meta.url);
  if (fs.existsSync(selfPath)) {
    return '__self__';
  }

  throw new Error(
    '[browse] Cannot find server.ts. Set BROWSE_SERVER_SCRIPT env var to the path of server.ts.'
  );
}

const SERVER_SCRIPT = resolveServerScript();

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
}

// ─── State File ────────────────────────────────────────────────
function readState(): ServerState | null {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listInstances(): Promise<void> {
  try {
    const files = fs.readdirSync(LOCAL_DIR).filter(
      f => f.startsWith('browse-server') && f.endsWith('.json') && !f.endsWith('.lock')
    );
    if (files.length === 0) { console.log('(no running instances)'); return; }

    let found = false;
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(LOCAL_DIR, file), 'utf-8'));
        if (!data.pid || !data.port) continue;

        const alive = isProcessAlive(data.pid);
        let status = 'dead';
        let sessions = 0;
        if (alive) {
          try {
            const resp = await fetch(`http://127.0.0.1:${data.port}/health`, { signal: AbortSignal.timeout(1000) });
            if (resp.ok) {
              const health = await resp.json() as any;
              status = health.status === 'healthy' ? 'healthy' : 'unhealthy';
              sessions = health.sessions || 0;
            }
          } catch { status = 'unreachable'; }
        }

        // Derive instance name from filename
        const match = file.match(/^browse-server-?(.*)\.json$/);
        const instance = match?.[1] || 'default';

        console.log(`  ${instance.padEnd(15)} PID ${String(data.pid).padEnd(8)} port ${data.port}  ${status}${sessions ? `  ${sessions} session(s)` : ''}`);
        found = true;

        // Clean up dead entries
        if (!alive) {
          try { fs.unlinkSync(path.join(LOCAL_DIR, file)); } catch {}
        }
      } catch {}
    }
    if (!found) console.log('(no running instances)');
  } catch { console.log('(no running instances)'); }
}

function isBrowseProcess(pid: number): boolean {
  try {
    const { execSync } = require('child_process');
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
    return cmd.includes('browse') || cmd.includes('__BROWSE_SERVER_MODE');
  } catch {
    return false;
  }
}

// ─── Server Lifecycle ──────────────────────────────────────────

/**
 * Acquire a lock file to prevent concurrent server spawns.
 * Uses O_EXCL (wx flag) for atomic creation.
 * Returns true if lock acquired, false if another process holds it.
 */
function acquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      // Check if lock is stale
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Lock is stale — remove and retry
          try { fs.unlinkSync(LOCK_FILE); } catch {}
          return acquireLock();
        }
      } catch {}
      return false;
    }
    throw err;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

async function startServer(): Promise<ServerState> {
  // Acquire lock to prevent concurrent spawns
  if (!acquireLock()) {
    // Another process is starting the server — wait for state file or lock release
    const start = Date.now();
    while (Date.now() - start < MAX_START_WAIT) {
      const state = readState();
      if (state && isProcessAlive(state.pid)) {
        return state;
      }
      // If the lock was released (first starter failed), retry acquiring it
      // instead of waiting forever for a state file that will never appear.
      if (acquireLock()) {
        // We now hold the lock — fall through to the spawn logic below
        break;
      }
      await sleep(100);
    }
    // If we still don't hold the lock and no state file appeared, give up
    if (!fs.existsSync(LOCK_FILE) || fs.readFileSync(LOCK_FILE, 'utf-8').trim() !== String(process.pid)) {
      const state = readState();
      if (state && isProcessAlive(state.pid)) return state;
      throw new Error('Server failed to start (another process is starting it)');
    }
  }

  try {
    // Only remove state file if it belongs to a dead process
    try {
      const oldState = readState();
      if (oldState && !isProcessAlive(oldState.pid)) {
        fs.unlinkSync(STATE_FILE);
      }
    } catch {}

    // Start server as detached background process.
    // Server must run under Node (not Bun) for correct WebSocket/CDP handling.
    // CLI may run under Bun for faster startup, but server always uses node.
    const nodeExec = process.execPath.includes('bun') ? 'node' : process.execPath;
    const selfPath = fileURLToPath(import.meta.url);
    const spawnCmd = SERVER_SCRIPT === '__self__'
      ? [nodeExec, selfPath]
      : [nodeExec, '--import', 'tsx', SERVER_SCRIPT];
    const spawnEnv = { ...process.env, __BROWSE_SERVER_MODE: '1', BROWSE_LOCAL_DIR: LOCAL_DIR, BROWSE_INSTANCE, ...(cliFlags.headed ? { BROWSE_HEADED: '1' } : {}), ...(cliFlags.cdpUrl ? { BROWSE_CDP_URL: cliFlags.cdpUrl } : {}), ...(cliFlags.profile ? { BROWSE_PROFILE: cliFlags.profile } : {}) } as NodeJS.ProcessEnv;
    const proc = spawn(spawnCmd[0], spawnCmd.slice(1), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: spawnEnv,
      detached: true,
    });

    // Don't hold the CLI open — unref process and stderr pipe
    proc.unref();
    if (proc.stderr) (proc.stderr as any).unref();

    // Wait for state file to appear
    const start = Date.now();
    while (Date.now() - start < MAX_START_WAIT) {
      const state = readState();
      if (state && isProcessAlive(state.pid)) {
        return state;
      }
      await sleep(100);
    }

    // If we get here, server didn't start in time
    // Try to read stderr for error message
    const stderr = proc.stderr;
    if (stderr) {
      const stderrChunks: Buffer[] = [];
      stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      await new Promise(resolve => stderr.once('end', resolve));
      if (stderrChunks.length > 0) {
        const errText = Buffer.concat(stderrChunks).toString('utf8');
        throw new Error(`Server failed to start:\n${errText}`);
      }
    }
    throw new Error(`Server failed to start within ${MAX_START_WAIT / 1000}s`);
  } finally {
    releaseLock();
  }
}

async function ensureServer(): Promise<ServerState> {
  const state = readState();

  if (state && isProcessAlive(state.pid)) {
    // Server appears alive — do a health check
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, {
        signal: AbortSignal.timeout(DEFAULTS.HEALTH_CHECK_TIMEOUT_MS),
      });
      if (resp.ok) {
        const health = await resp.json() as any;
        if (health.status === 'healthy') {
          return state;
        }
      }
    } catch {
      // Health check failed — server is dead or unhealthy
    }

    // Server is alive but unhealthy (shutting down, browser crashed).
    // Kill it so we can start fresh — but only if it's actually a browse process.
    if (isBrowseProcess(state.pid)) {
      try { process.kill(state.pid, 'SIGTERM'); } catch {}
      // Brief wait for graceful exit
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && isProcessAlive(state.pid)) {
        await sleep(100);
      }
      if (isProcessAlive(state.pid)) {
        try { process.kill(state.pid, 'SIGKILL'); } catch {}
        await sleep(200);
      }
    }
  }

  // Clean up stale state file
  if (state) {
    try { fs.unlinkSync(STATE_FILE); } catch {}
  }

  // Clean up orphaned state files from other instances (e.g., old PPID-suffixed files)
  cleanOrphanedServers();

  // Need to (re)start
  console.error('[browse] Starting server...');
  return startServer();
}

/**
 * Clean up orphaned browse server state files.
 * Removes any browse-server*.json whose PID is dead.
 * Kills live orphans (legacy PPID-suffixed files from pre-v0.2.4) if they're browse processes.
 * Preserves intentional BROWSE_PORT instances (suffix matches port inside the file).
 */
function cleanOrphanedServers(): void {
  try {
    const files = fs.readdirSync(LOCAL_DIR);
    for (const file of files) {
      if (!file.startsWith('browse-server') || !file.endsWith('.json') || file.endsWith('.lock')) continue;
      const filePath = path.join(LOCAL_DIR, file);
      if (filePath === STATE_FILE) continue;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!data.pid) { fs.unlinkSync(filePath); continue; }
        // Preserve intentional BROWSE_PORT instances (suffix = port number)
        const suffixMatch = file.match(/browse-server-(\d+)\.json$/);
        if (suffixMatch && data.port === parseInt(suffixMatch[1], 10) && isProcessAlive(data.pid)) continue;
        // Dead process → remove state file
        if (!isProcessAlive(data.pid)) { fs.unlinkSync(filePath); continue; }
        // Live orphan (legacy PPID file) → kill if it's a browse process
        if (isBrowseProcess(data.pid)) {
          try { process.kill(data.pid, 'SIGTERM'); } catch {}
        }
      } catch { try { fs.unlinkSync(filePath); } catch {} }
    }
  } catch {}
}

// ─── Command Dispatch ──────────────────────────────────────────

// Commands that are safe to retry after a transport failure.
// Write commands (click, fill, goto, etc.) may have already executed
// before the connection dropped — retrying them could duplicate side effects.
// NOTE: 'js' and 'eval' excluded — page.evaluate() can run arbitrary side effects
// NOTE: 'storage' excluded — 'storage set' mutates localStorage
export const SAFE_TO_RETRY = new Set([
  // Read commands — no side effects
  'text', 'html', 'links', 'forms', 'accessibility',
  'css', 'attrs', 'element-state', 'dialog',
  'console', 'network', 'cookies', 'perf', 'value', 'count',
  // Meta commands that are read-only or idempotent
  'tabs', 'status', 'url', 'snapshot', 'snapshot-diff', 'devices', 'sessions', 'frame', 'find', 'record', 'cookie-import',
  'box', 'errors', 'doctor', 'upgrade',
  'react-devtools',
]);

// Commands that return static data independent of page state.
// Safe to retry even after a server restart (no "blank page" issue).
const PAGE_INDEPENDENT = new Set(['devices', 'status']);

async function sendCommand(state: ServerState, command: string, args: string[], retries = 0, sessionId?: string): Promise<void> {
  const body = JSON.stringify({ command, args });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${state.token}`,
  };
  if (sessionId) {
    headers['X-Browse-Session'] = sessionId;
  }
  if (cliFlags.json) {
    headers['X-Browse-Json'] = '1';
  }
  if (cliFlags.contentBoundaries) {
    headers['X-Browse-Boundaries'] = '1';
  }
  if (cliFlags.allowedDomains) {
    headers['X-Browse-Allowed-Domains'] = cliFlags.allowedDomains;
  }
  if (cliFlags.stateFile && !stateFileApplied) {
    headers['X-Browse-State'] = cliFlags.stateFile;
    stateFileApplied = true;
  }
  if (cliFlags.maxOutput > 0) {
    headers['X-Browse-Max-Output'] = String(cliFlags.maxOutput);
  }

  try {
    const resp = await fetch(`http://127.0.0.1:${state.port}/command`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (resp.status === 401) {
      // Token mismatch — server may have restarted
      console.error('[browse] Auth failed — server may have restarted. Retrying...');
      const newState = readState();
      if (newState && newState.token !== state.token) {
        return sendCommand(newState, command, args, 0, sessionId);
      }
      throw new Error('Authentication failed');
    }

    const text = await resp.text();

    if (resp.ok) {
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');

      // After stop/restart, wait for old server to actually die
      if (command === 'stop' || command === 'restart') {
        const oldPid = state.pid;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isProcessAlive(oldPid)) {
          await sleep(100);
        }
        if (isProcessAlive(oldPid)) {
          try { process.kill(oldPid, 'SIGKILL'); } catch {}
          await sleep(300);
        }
        // Clean up state file
        try { fs.unlinkSync(STATE_FILE); } catch {}

        if (command === 'restart') {
          const newState = await startServer();
          console.error(`[browse] Server restarted (PID: ${newState.pid})`);
        }
      }
    } else {
      // Try to parse as JSON error
      try {
        const err = JSON.parse(text);
        console.error(err.error || text);
        if (err.hint) console.error(err.hint);
      } catch {
        console.error(text);
      }
      process.exit(1);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.error('[browse] Command timed out after 30s');
      process.exit(1);
    }
    // Connection error — server may have crashed
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('fetch failed')) {
      if (retries >= 1) throw new Error('[browse] Server crashed twice in a row — aborting');

      // ECONNREFUSED = server not listening, command never executed → safe to retry anything.
      // ECONNRESET/fetch failed = connection dropped mid-request, command may have executed.
      // Only retry read-only commands to avoid duplicating side effects (e.g., form submits).
      if (err.code !== 'ECONNREFUSED' && !SAFE_TO_RETRY.has(command)) {
        throw new Error(
          `[browse] Connection lost during '${command}'. ` +
          `The action may have already executed — not retrying to avoid duplicating side effects.`
        );
      }

      console.error('[browse] Server connection lost. Restarting...');
      const newState = await startServer();

      // After a restart the new server has a fresh browser (blank page).
      // Read-only commands would silently return data from that blank page,
      // which is worse than an error. Only retry navigation commands that
      // will establish session state on the new server.
      // Exception: page-independent commands (devices, status) return static
      // data that doesn't depend on page state — safe to retry on blank page.
      if (SAFE_TO_RETRY.has(command) && !PAGE_INDEPENDENT.has(command)) {
        throw new Error(
          `[browse] Server restarted but '${command}' would return data from a blank page. ` +
          `Re-navigate with 'goto' first, then retry.`
        );
      }

      return sendCommand(newState, command, args, retries + 1, sessionId);
    }
    throw err;
  }
}

// ─── Main ──────────────────────────────────────────────────────
export async function main() {
  const args = process.argv.slice(2);

  // Load project config (browse.json) — values serve as defaults
  const config = loadConfig();

  // Find the first non-flag arg (the command) to limit global flag scanning.
  // Only extract global flags from args BEFORE the command position.
  function findCommandIndex(a: string[]): number {
    for (let i = 0; i < a.length; i++) {
      if (!a[i].startsWith('-')) return i;
      // Skip flag values for known value-flags
      if (a[i] === '--session' || a[i] === '--allowed-domains' || a[i] === '--cdp' || a[i] === '--state' || a[i] === '--profile') i++;
    }
    return a.length;
  }

  // Extract --session flag (only before command)
  let sessionId: string | undefined;
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx !== -1 && sessionIdx < findCommandIndex(args)) {
    sessionId = args[sessionIdx + 1];
    if (!sessionId || sessionId.startsWith('-')) {
      console.error('Usage: browse --session <id> <command> [args...]');
      process.exit(1);
    }
    args.splice(sessionIdx, 2);
  }
  sessionId = sessionId || process.env.BROWSE_SESSION || config.session || undefined;

  // Extract --profile flag (only before command)
  let profileName: string | undefined;
  const profileIdx = args.indexOf('--profile');
  if (profileIdx !== -1 && profileIdx < findCommandIndex(args)) {
    profileName = args[profileIdx + 1];
    if (!profileName || profileName.startsWith('-')) {
      console.error('Usage: browse --profile <name> <command> [args...]');
      process.exit(1);
    }
    args.splice(profileIdx, 2);
  }
  // Also check env var
  profileName = profileName || process.env.BROWSE_PROFILE || undefined;

  if (sessionId && profileName) {
    console.error('Cannot use --profile and --session together. Profiles use their own Chromium; sessions share one.');
    process.exit(1);
  }

  // Extract --json flag (only before command)
  let jsonMode = false;
  const jsonIdx = args.indexOf('--json');
  if (jsonIdx !== -1 && jsonIdx < findCommandIndex(args)) {
    jsonMode = true;
    args.splice(jsonIdx, 1);
  }
  jsonMode = jsonMode || process.env.BROWSE_JSON === '1' || config.json === true;

  // Extract --content-boundaries flag (only before command)
  let contentBoundaries = false;
  const boundIdx = args.indexOf('--content-boundaries');
  if (boundIdx !== -1 && boundIdx < findCommandIndex(args)) {
    contentBoundaries = true;
    args.splice(boundIdx, 1);
  }
  contentBoundaries = contentBoundaries || process.env.BROWSE_CONTENT_BOUNDARIES === '1' || config.contentBoundaries === true;

  // Extract --allowed-domains flag (only before command)
  let allowedDomains: string | undefined;
  const domIdx = args.indexOf('--allowed-domains');
  if (domIdx !== -1 && domIdx < findCommandIndex(args)) {
    allowedDomains = args[domIdx + 1];
    if (!allowedDomains || allowedDomains.startsWith('-')) {
      console.error('Usage: browse --allowed-domains domain1,domain2 <command> [args...]');
      process.exit(1);
    }
    args.splice(domIdx, 2);
  }
  allowedDomains = allowedDomains || process.env.BROWSE_ALLOWED_DOMAINS || (config.allowedDomains ? config.allowedDomains.join(',') : undefined);

  // Extract --headed flag (only before command)
  let headed = false;
  const headedIdx = args.indexOf('--headed');
  if (headedIdx !== -1 && headedIdx < findCommandIndex(args)) {
    headed = true;
    args.splice(headedIdx, 1);
  }
  headed = headed || process.env.BROWSE_HEADED === '1';

  // Extract --connect flag (only before command)
  let connectFlag = false;
  const connectIdx = args.indexOf('--connect');
  if (connectIdx !== -1 && connectIdx < findCommandIndex(args)) {
    connectFlag = true;
    args.splice(connectIdx, 1);
  }

  // Extract --cdp <port> flag (only before command)
  let cdpPort: number | undefined;
  const cdpIdx = args.indexOf('--cdp');
  if (cdpIdx !== -1 && cdpIdx < findCommandIndex(args)) {
    const portStr = args[cdpIdx + 1];
    if (!portStr || portStr.startsWith('-')) {
      console.error('Usage: browse --cdp <port> <command> [args...]');
      process.exit(1);
    }
    cdpPort = parseInt(portStr, 10);
    if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
      console.error(`Invalid CDP port: ${portStr}`);
      process.exit(1);
    }
    args.splice(cdpIdx, 2);
  }

  // Extract --state <path> flag (only before command)
  let stateFile = '';
  const stateIdx = args.indexOf('--state');
  if (stateIdx !== -1 && stateIdx < findCommandIndex(args)) {
    stateFile = args[stateIdx + 1] || '';
    if (!stateFile || stateFile.startsWith('-')) {
      console.error('Usage: browse --state <path> <command> [args...]');
      process.exit(1);
    }
    args.splice(stateIdx, 2);
  }

  // Extract --max-output <n> flag (only before command)
  let maxOutput = 0;
  const maxOutputIdx = args.indexOf('--max-output');
  if (maxOutputIdx !== -1 && maxOutputIdx < findCommandIndex(args)) {
    const val = args[maxOutputIdx + 1];
    if (!val || val.startsWith('-')) {
      console.error('Usage: browse --max-output <chars> <command> [args...]');
      process.exit(1);
    }
    maxOutput = parseInt(val, 10);
    args.splice(maxOutputIdx, 2);
  }
  maxOutput = maxOutput || parseInt(process.env.BROWSE_MAX_OUTPUT || '0', 10) || 0;

  // Resolve CDP URL from --connect (auto-discover) or --cdp <port>
  let cdpUrl = process.env.BROWSE_CDP_URL || '';
  if (!cdpUrl && (connectFlag || cdpPort)) {
    if (cdpPort) {
      // --cdp <port>: construct CDP endpoint URL for the specific port
      cdpUrl = `http://127.0.0.1:${cdpPort}`;
    } else {
      // --connect: auto-discover a running Chrome instance
      const { discoverChrome } = await import('./chrome-discover');
      const discovered = await discoverChrome();
      if (!discovered) {
        console.error(
          'No running Chrome instance found.\n' +
          'Start Chrome with --remote-debugging-port=9222, or use --cdp <port>.'
        );
        process.exit(1);
      }
      cdpUrl = discovered;
    }
  }

  // Set global flags for sendCommand()
  cliFlags.json = jsonMode;
  cliFlags.contentBoundaries = contentBoundaries;
  cliFlags.allowedDomains = allowedDomains || '';
  cliFlags.headed = headed;
  cliFlags.stateFile = stateFile;
  cliFlags.maxOutput = maxOutput;
  cliFlags.cdpUrl = cdpUrl;
  cliFlags.profile = profileName || '';

  // ─── Local commands (no server needed) ─────────────────────
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-V') {
    const pkg = await import('../package.json');
    console.log(pkg.version);
    return;
  }

  if (args[0] === 'instances') {
    await listInstances();
    return;
  }

  if (args[0] === 'install-skill') {
    const { installSkill } = await import('./install-skill');
    installSkill(args[1]);
    return;
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`browse — Fast headless browser for AI coding agents

Usage: browse [options] <command> [args...]

Navigation:     goto <url> | back | forward | reload | url
Content:        text | html [sel] | links | forms | accessibility
Interaction:    click <sel> | rightclick <sel> | dblclick <sel>
                fill <sel> <val> | select <sel> <val>
                hover <sel> | focus <sel> | tap <sel>
                check <sel> | uncheck <sel> | drag <src> <tgt>
                type <text> | press <key> | keydown <key> | keyup <key>
                keyboard inserttext <text>
                scroll [sel|up|down] | scrollinto <sel>
                swipe <up|down|left|right> [px]
                wait <sel|ms|--url|--text|--fn|--load|--network-idle>
                viewport <WxH> | highlight <sel> | download <sel> [path]
Mouse:          mouse move <x> <y> | mouse down [btn] | mouse up [btn]
                mouse wheel <dy> [dx]
Settings:       set geo <lat> <lng> | set media <dark|light|no-preference>
Device:         emulate <device> | emulate reset | devices [filter]
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                element-state <sel> | box <sel>
                console [--clear] | errors [--clear] | network [--clear]
                cookies | storage [set <k> <v>] | perf
                value <sel> | count <sel> | clipboard [write <text>]
Visual:         screenshot [sel|@ref] [path] [--full] [--clip x,y,w,h]
                screenshot --annotate | pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-f] [-V] [-c] [-C] [-d N] [-s sel]
Find:           find role|text|label|placeholder|testid|alt|title <query>
                find first|last <sel> | find nth <n> <sel>
Compare:        diff <url1> <url2> | screenshot-diff <baseline> [current]
Multi-step:     chain (reads JSON from stdin)
Cookies:        cookie <n>=<v> | cookie set <n> <v> [--domain --secure]
                cookie clear | cookie export <file> | cookie import <file>
Network:        offline [on|off] | route <pattern> block|fulfill
                header <n>:<v> | useragent <str>
Recording:      har start | har stop [path]
                video start [dir] | video stop | video status
                record start | record stop | record status
                record export browse|replay [path]
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Frames:         frame <sel> | frame main
Sessions:       sessions | session-close <id>
Auth:           auth save <name> <url> <user> <pass|--password-stdin>
                auth login <name> | auth list | auth delete <name>
                cookie-import --list | cookie-import <browser> [--domain <d>] [--profile <p>]
State:          state save|load|list|show [name]
Handoff:        handoff [reason] | resume
Debug:          inspect (requires BROWSE_DEBUG_PORT)
Server:         status | instances | stop | restart | doctor | upgrade
Setup:          install-skill [path]

Options:
  --session <id>           Named session (isolates tabs, refs, cookies)
  --profile <name>         Persistent browser profile (own Chromium, full state persistence)
  --json                   Wrap output as {success, data, command}
  --content-boundaries     Wrap page content in nonce-delimited markers
  --allowed-domains <d,d>  Block navigation/resources outside allowlist
  --headed                 Run browser in headed (visible) mode
  --max-output <n>         Truncate output to N characters
  --state <path>           Load state file (cookies/storage) before first command
  --connect                Auto-discover and connect to running Chrome
  --cdp <port>             Connect to Chrome on specific debugging port

Snapshot flags:
  -i            Interactive elements only (terse flat list by default)
  -f            Full — indented tree with props and children (use with -i)
  -V            Viewport — only elements visible in current viewport
  -c            Compact — remove empty structural elements
  -C            Cursor-interactive — detect divs with cursor:pointer,
                onclick, tabindex, data-action (missed by ARIA tree)
  -d N          Limit tree depth to N levels
  -s <sel>      Scope to CSS selector

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Special case: chain reads from stdin
  if (command === 'chain' && commandArgs.length === 0) {
    const stdin = await readStdin();
    commandArgs.push(stdin.trim());
  }

  // Special case: auth --password-stdin reads in CLI before sending to server
  if (command === 'auth' && commandArgs.includes('--password-stdin')) {
    const stdinIdx = commandArgs.indexOf('--password-stdin');
    const password = (await readStdin()).trim();
    commandArgs.splice(stdinIdx, 1, password);
  }

  const state = await ensureServer();
  await sendCommand(state, command, commandArgs, 0, sessionId);
}

if (process.env.__BROWSE_SERVER_MODE === '1') {
  import('./server');
} else if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename_cli)) {
  // Direct execution: tsx src/cli.ts <command>
  main().catch((err) => {
    console.error(`[browse] ${err.message}`);
    process.exit(1);
  });
}
