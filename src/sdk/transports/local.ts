/**
 * LocalTransport — talks to a local browse server via HTTP.
 *
 * Reads the server state file (.browse/browse-server.json) to discover
 * the port and auth token. Does NOT auto-start the server — callers
 * should ensure the server is running before connecting (e.g. via `browse status`).
 *
 * State file discovery mirrors the CLI logic in src/cli.ts:
 *   1. Explicit stateFile option
 *   2. BROWSE_STATE_FILE env var
 *   3. Walk up from cwd looking for .browse/browse-server.json
 *   4. Fallback to /tmp/browse-server.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import type { Transport } from '../session.js';

// ─── Types ────────────────────────────────────────────────────

export interface LocalTransportOptions {
  /** Override state file path (skips discovery) */
  stateFile?: string;
  /** Session ID for multiplexing */
  session?: string;
  /** Command timeout in milliseconds (default: 30000) */
  timeout?: number;
}

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
}

// ─── LocalTransport ───────────────────────────────────────────

export class LocalTransport implements Transport {
  private port: number = 0;
  private token: string = '';
  private session: string | undefined;
  private timeout: number;
  private connected: boolean = false;

  constructor(private opts: LocalTransportOptions = {}) {
    this.session = opts.session;
    this.timeout = opts.timeout ?? 30_000;
  }

  /**
   * Read the server state file and extract port + token.
   * Must be called before execute(), or execute() will call it lazily.
   */
  async connect(): Promise<void> {
    const stateFile = this.resolveStateFile();
    if (!stateFile) {
      throw new Error(
        'Browse server not running — no state file found. ' +
        'Start the server with: browse status',
      );
    }

    let raw: string;
    try {
      raw = fs.readFileSync(stateFile, 'utf-8');
    } catch {
      throw new Error(
        `Browse server state file not readable: ${stateFile}. ` +
        'Start the server with: browse status',
      );
    }

    let state: ServerState;
    try {
      state = JSON.parse(raw) as ServerState;
    } catch {
      throw new Error(
        `Browse server state file is corrupt: ${stateFile}. ` +
        'Restart the server with: browse restart',
      );
    }

    if (!state.port || !state.token) {
      throw new Error(
        `Browse server state file missing port or token: ${stateFile}. ` +
        'Restart the server with: browse restart',
      );
    }

    this.port = state.port;
    this.token = state.token;
    this.connected = true;
  }

  /**
   * Send a command to the browse server and return the text response.
   * Lazily connects on first call if connect() was not called explicitly.
   */
  async execute(command: string, args: string[]): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    return new Promise<string>((resolve, reject) => {
      const body = JSON.stringify({ command, args });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      };
      if (this.session) {
        headers['X-Browse-Session'] = this.session;
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/command',
          method: 'POST',
          headers,
          timeout: this.timeout,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode === 200) {
              resolve(text);
            } else {
              // Parse JSON error response from server
              try {
                const err = JSON.parse(text) as { error?: string; hint?: string };
                const message = err.error || text;
                const error = new Error(message);
                if (err.hint) {
                  (error as Error & { hint?: string }).hint = err.hint;
                }
                reject(error);
              } catch {
                reject(new Error(text || `HTTP ${res.statusCode}`));
              }
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Command '${command}' timed out after ${this.timeout}ms`));
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error(
            'Browse server not reachable (connection refused). ' +
            'Start the server with: browse status',
          ));
        } else {
          reject(err);
        }
      });

      req.end(body);
    });
  }

  /**
   * Close the transport. LocalTransport does not own the server,
   * so this is a no-op. The session can optionally be closed via
   * session.execute('session-close', [sessionId]).
   */
  async close(): Promise<void> {
    this.connected = false;
  }

  // ─── State File Discovery ───────────────────────────────────

  /**
   * Resolve the state file path using the same strategy as the CLI:
   *   1. Explicit option
   *   2. BROWSE_STATE_FILE env var
   *   3. Walk up from cwd looking for .browse/browse-server.json
   *   4. Fallback to /tmp/browse-server.json
   */
  private resolveStateFile(): string | null {
    // 1. Explicit option
    if (this.opts.stateFile) {
      return fs.existsSync(this.opts.stateFile) ? this.opts.stateFile : null;
    }

    // 2. Env var override
    if (process.env.BROWSE_STATE_FILE) {
      return fs.existsSync(process.env.BROWSE_STATE_FILE)
        ? process.env.BROWSE_STATE_FILE
        : null;
    }

    // 3. Walk up from cwd looking for project root (.git or .claude)
    //    then check .browse/browse-server.json inside it
    let dir = process.cwd();
    for (let i = 0; i < 20; i++) {
      // Check for project root markers (mirrors resolveLocalDir in cli.ts)
      if (
        fs.existsSync(path.join(dir, '.git')) ||
        fs.existsSync(path.join(dir, '.claude'))
      ) {
        const candidate = path.join(dir, '.browse', 'browse-server.json');
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    // 4. Fallback to /tmp
    const tmpPath = '/tmp/browse-server.json';
    if (fs.existsSync(tmpPath)) return tmpPath;

    return null;
  }
}
