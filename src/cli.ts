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
import { DEFAULTS } from './constants';

const BROWSE_PORT = parseInt(process.env.BROWSE_PORT || '0', 10);
const INSTANCE_SUFFIX = BROWSE_PORT ? `-${BROWSE_PORT}` : '';

/**
 * Resolve the project-local .browse/ directory for state files, logs, screenshots.
 * Walks up from cwd looking for .git/ or .claude/ (project root markers).
 * Creates <root>/.browse/ with a self-contained .gitignore.
 * Falls back to /tmp/ if not found (e.g. running outside a project).
 */
function resolveLocalDir(): string {
  if (process.env.BROWSE_LOCAL_DIR) return process.env.BROWSE_LOCAL_DIR;

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

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
): string {
  // 1. Explicit env var override
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // 2. server.ts adjacent to cli.ts (dev mode or installed)
  if (metaDir.startsWith('/') && !metaDir.includes('$bunfs')) {
    const direct = path.resolve(metaDir, 'server.ts');
    if (fs.existsSync(direct)) {
      return direct;
    }
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
      await Bun.sleep(100);
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

    // Start server as detached background process
    const proc = Bun.spawn(['bun', 'run', SERVER_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSE_LOCAL_DIR: LOCAL_DIR },
    });

    // Don't hold the CLI open
    proc.unref();

    // Wait for state file to appear
    const start = Date.now();
    while (Date.now() - start < MAX_START_WAIT) {
      const state = readState();
      if (state && isProcessAlive(state.pid)) {
        return state;
      }
      await Bun.sleep(100);
    }

    // If we get here, server didn't start in time
    // Try to read stderr for error message
    const stderr = proc.stderr;
    if (stderr) {
      const reader = stderr.getReader();
      const { value } = await reader.read();
      if (value) {
        const errText = new TextDecoder().decode(value);
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
  }

  // Need to (re)start
  console.error('[browse] Starting server...');
  return startServer();
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
  'css', 'attrs', 'state', 'dialog',
  'console', 'network', 'cookies', 'perf',
  // Meta commands that are read-only
  'tabs', 'status', 'url', 'snapshot', 'snapshot-diff', 'devices', 'sessions',
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

      // After restart succeeds, wait for old server to actually die, then start fresh
      if (command === 'restart') {
        const oldPid = state.pid;
        // Wait up to 5s for graceful shutdown
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isProcessAlive(oldPid)) {
          await Bun.sleep(100);
        }
        // If still alive (e.g. browserManager.close() stalled), force-kill
        if (isProcessAlive(oldPid)) {
          try { process.kill(oldPid, 'SIGKILL'); } catch {}
          // Brief wait for OS to reclaim the process and release the port
          await Bun.sleep(300);
        }
        const newState = await startServer();
        console.error(`[browse] Server restarted (PID: ${newState.pid})`);
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
async function main() {
  const args = process.argv.slice(2);

  // Extract --session flag before command parsing
  let sessionId: string | undefined;
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx !== -1) {
    sessionId = args[sessionIdx + 1];
    if (!sessionId || sessionId.startsWith('-')) {
      console.error('Usage: browse --session <id> <command> [args...]');
      process.exit(1);
    }
    args.splice(sessionIdx, 2); // remove --session and its value
  }
  sessionId = sessionId || process.env.BROWSE_SESSION || undefined;

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`browse — Fast headless browser for AI coding agents

Usage: browse [--session <id>] <command> [args...]

Navigation:     goto <url> | back | forward | reload | url
Content:        text | html [sel] | links | forms | accessibility
Interaction:    click <sel> | fill <sel> <val> | select <sel> <val>
                hover <sel> | type <text> | press <key>
                scroll [sel] | wait <sel> | viewport <WxH>
Device:         emulate <device> | emulate reset | devices [filter]
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                console [--clear] | network [--clear]
                cookies | storage [set <k> <v>] | perf
Visual:         screenshot [path] | pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-C] [-d N] [-s sel]
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Sessions:       sessions | session-close <id>
Server:         status | cookie <n>=<v> | header <n>:<v>
                useragent <str> | stop | restart

Options:
  --session <id>  Use a named session (isolates tabs, refs, cookies).
                  Multiple agents can share one server with different sessions.
                  Also settable via BROWSE_SESSION env var.

Snapshot flags:
  -i            Interactive elements only (buttons, links, inputs)
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
    const stdin = await Bun.stdin.text();
    commandArgs.push(stdin.trim());
  }

  const state = await ensureServer();
  await sendCommand(state, command, commandArgs, 0, sessionId);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[browse] ${err.message}`);
    process.exit(1);
  });
}
