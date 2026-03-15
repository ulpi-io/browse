/**
 * End-to-end CLI session tests
 *
 * Spawns actual CLI processes with --session flags and verifies
 * that two concurrent sessions get independent browser state
 * while sharing a single server instance.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let testServer: ReturnType<typeof startTestServer>;
let baseUrl: string;

// Unique state file and port range to avoid conflicts with running servers
const STATE_FILE = `/tmp/browse-session-e2e-${Date.now()}.json`;
const PORT_START = 18000 + Math.floor(Math.random() * 5000);
const CLI_PATH = path.resolve(__dirname, '../src/cli.ts');

// Track server PID for cleanup
let serverPid: number | null = null;

beforeAll(() => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;
});

afterAll(async () => {
  try { testServer.server.stop(); } catch {}

  // Kill any server we spawned
  if (serverPid) {
    try { process.kill(serverPid, 'SIGTERM'); } catch {}
  }

  // Also try to read PID from state file in case it was updated
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (state.pid && state.pid !== serverPid) {
      try { process.kill(state.pid, 'SIGTERM'); } catch {}
    }
  } catch {}

  // Clean up state files
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(STATE_FILE + '.lock'); } catch {}
});

/**
 * Run a CLI command and return its output.
 * Spawns `bun run src/cli.ts [--session <id>] <command> [args...]`
 */
function runCli(
  args: string[],
  opts: { sessionId?: string; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliArgs = ['run', CLI_PATH];

  if (opts.sessionId) {
    cliArgs.push('--session', opts.sessionId);
  }
  cliArgs.push(...args);

  return new Promise((resolve) => {
    const proc = spawn('bun', cliArgs, {
      timeout: opts.timeout ?? 20000,
      env: {
        ...process.env,
        BROWSE_STATE_FILE: STATE_FILE,
        BROWSE_PORT_START: String(PORT_START),
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => {
      // Capture server PID for cleanup
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (state.pid) serverPid = state.pid;
      } catch {}
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ─── Two CLI sessions are independent ───────────────────────────

describe('Session E2E', () => {
  test('two CLI sessions navigate to different pages with independent state', async () => {
    // Session A: navigate to basic.html
    const gotoA = await runCli(['goto', baseUrl + '/basic.html'], { sessionId: 'alpha' });
    expect(gotoA.code).toBe(0);
    expect(gotoA.stdout).toContain('Navigated to');

    // Session B: navigate to forms.html
    const gotoB = await runCli(['goto', baseUrl + '/forms.html'], { sessionId: 'beta' });
    expect(gotoB.code).toBe(0);
    expect(gotoB.stdout).toContain('Navigated to');

    // Session A: text should show basic.html content, not forms.html
    const textA = await runCli(['text'], { sessionId: 'alpha' });
    expect(textA.code).toBe(0);
    expect(textA.stdout).toContain('Hello World');
    expect(textA.stdout).not.toContain('Form Test Page');

    // Session B: text should show forms.html content, not basic.html
    const textB = await runCli(['text'], { sessionId: 'beta' });
    expect(textB.code).toBe(0);
    expect(textB.stdout).toContain('Form Test Page');
    expect(textB.stdout).not.toContain('Hello World');

    // Session A again: still on basic.html (not affected by session B)
    const textA2 = await runCli(['text'], { sessionId: 'alpha' });
    expect(textA2.code).toBe(0);
    expect(textA2.stdout).toContain('Hello World');
  }, 60000);

  // ─── Default session (no --session flag) ────────────────────────

  test('CLI without --session uses default session (backward compatible)', async () => {
    // Navigate without --session flag
    const gotoDefault = await runCli(['goto', baseUrl + '/basic.html']);
    expect(gotoDefault.code).toBe(0);
    expect(gotoDefault.stdout).toContain('Navigated to');

    // Read text without --session flag
    const textDefault = await runCli(['text']);
    expect(textDefault.code).toBe(0);
    expect(textDefault.stdout).toContain('Hello World');
  }, 30000);

  // ─── Shared server (single state file) ─────────────────────────

  test('both sessions share the same server state file (single server)', async () => {
    // Run status with session alpha
    const statusA = await runCli(['status'], { sessionId: 'alpha' });
    expect(statusA.code).toBe(0);
    expect(statusA.stdout).toContain('Status: healthy');

    // Read state file — should exist and have a single server PID
    const stateAfterA = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const pidAfterA = stateAfterA.pid;
    expect(pidAfterA).toBeGreaterThan(0);

    // Run status with session beta
    const statusB = await runCli(['status'], { sessionId: 'beta' });
    expect(statusB.code).toBe(0);
    expect(statusB.stdout).toContain('Status: healthy');

    // State file should still point to the same server PID
    const stateAfterB = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(stateAfterB.pid).toBe(pidAfterA);
  }, 30000);

  // ─── URL independence ──────────────────────────────────────────

  test('sessions report independent URLs', async () => {
    // Ensure sessions are navigated to different pages
    await runCli(['goto', baseUrl + '/basic.html'], { sessionId: 'alpha' });
    await runCli(['goto', baseUrl + '/forms.html'], { sessionId: 'beta' });

    // Check URL for session alpha
    const urlA = await runCli(['url'], { sessionId: 'alpha' });
    expect(urlA.code).toBe(0);
    expect(urlA.stdout).toContain('/basic.html');

    // Check URL for session beta
    const urlB = await runCli(['url'], { sessionId: 'beta' });
    expect(urlB.code).toBe(0);
    expect(urlB.stdout).toContain('/forms.html');
  }, 40000);
});
