/**
 * iOS Simulator lifecycle service — shared between CLI and command layer.
 *
 * All simulator lifecycle logic lives here. Both the CLI fast path
 * and the meta command handler call this service, never reimplementing
 * simulator resolution, runner bootstrap, or health checking.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  listSimulators,
  resolveSimulator,
  bootSimulator,
} from './controller';

const __filename_svc = fileURLToPath(import.meta.url);
const __dirname_svc = path.dirname(__filename_svc);

const DEFAULT_PORT = 9820;

// ─── State ─────────────────────────────────────────────────────

export interface SimServiceState {
  platform: string;
  device: string;
  udid: string;
  app: string;
  port: number;
  pid?: number;
  startedAt: string;
}

function resolveStateDir(): string {
  // Use the same .browse/ directory as the rest of browse
  const localDir = process.env.BROWSE_LOCAL_DIR;
  if (localDir) return localDir;

  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) {
      const browseDir = path.join(dir, '.browse');
      fs.mkdirSync(browseDir, { recursive: true });
      return browseDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '/tmp';
}

function stateFilePath(): string {
  return path.join(resolveStateDir(), 'sim-state.json');
}

export function readState(): SimServiceState | null {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8')); } catch { return null; }
}

export function writeState(state: SimServiceState): void {
  const dir = path.dirname(stateFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}

export function clearState(): void {
  try { fs.unlinkSync(stateFilePath()); } catch {}
}

// ─── Health ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function checkHealth(port: number = DEFAULT_PORT): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch { return false; }
}

// ─── Configure Target ──────────────────────────────────────────

export async function configureTarget(port: number, bundleId: string, udid?: string): Promise<void> {
  // Launch the app via simctl first — XCUIApplication.activate() inside the runner
  // blocks the main actor indefinitely for cold launches. Launching externally
  // (like Maestro does) avoids this.
  if (bundleId !== 'io.ulpi.browse-ios-runner') {
    const { execSync } = await import('child_process');
    const deviceId = udid || readState()?.udid;
    if (deviceId) {
      try {
        execSync(`xcrun simctl launch ${deviceId} ${bundleId}`, { stdio: 'pipe', timeout: 30000 });
      } catch {
        // App might already be running — that's fine
      }
    }
  }
  const { configureRunnerTarget } = await import('./bridge');
  await configureRunnerTarget(port, bundleId);
}

// ─── Status ────────────────────────────────────────────────────

export async function status(): Promise<{ running: boolean; state: SimServiceState | null; healthy: boolean }> {
  const state = readState();
  if (!state) return { running: false, state: null, healthy: false };
  const healthy = await checkHealth(state.port);
  if (!healthy) { clearState(); return { running: false, state, healthy: false }; }
  return { running: true, state, healthy: true };
}

// ─── Cleanup ──────────────────────────────────────────────────

/**
 * Kill any xcodebuild processes running the BrowseRunner scheme,
 * and any process holding the runner port. This ensures a clean
 * start even after crashes, stale PIDs, or interrupted shutdowns.
 */
async function killStaleRunners(port: number, statePid?: number): Promise<void> {
  const { execSync } = await import('child_process');

  // 1. Kill the PID from state if it's still alive
  if (statePid) {
    try { process.kill(statePid, 'SIGKILL'); } catch {}
  }

  // 2. Kill all xcodebuild processes running BrowseRunnerApp
  try {
    execSync('pkill -9 -f "xcodebuild.*BrowseRunnerApp"', { stdio: 'pipe', timeout: 5000 });
  } catch { /* no matching processes — fine */ }

  // 3. Kill anything holding the runner port (SIGKILL to avoid CLOSE_WAIT lingering)
  try {
    const lsof = execSync(`lsof -ti :${port}`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
    for (const pid of lsof.split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch {}
    }
  } catch { /* nothing on port — fine */ }

  // Wait for the OS to fully release the port and clean up CLOSE_WAIT connections
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    try {
      execSync(`lsof -ti :${port}`, { stdio: 'pipe', timeout: 2000 });
      // Still occupied — keep waiting
    } catch {
      break; // Port is free
    }
  }
}

// ─── Stop ──────────────────────────────────────────────────────

export async function stop(): Promise<string> {
  const state = readState();
  if (!state) return 'No simulator/emulator running.';

  await killStaleRunners(state.port, state.pid);
  clearState();
  return `${state.platform} simulator stopped (${state.device}).`;
}

// ─── Start (iOS) ───────────────────────────────────────────────

export interface StartOptions {
  device?: string;
  app?: string;
  /** Open the Simulator window so the user can see it (default: headless) */
  visible?: boolean;
  /** Callback for progress messages (default: stderr) */
  log?: (msg: string) => void;
}

export async function startIOS(opts: StartOptions = {}): Promise<SimServiceState> {
  const log = opts.log || ((msg: string) => process.stderr.write(`[browse] ${msg}\n`));
  const port = parseInt(process.env.BROWSE_RUNNER_PORT || '', 10) || DEFAULT_PORT;

  // Resolve --app file path to bundle ID if needed
  if (opts.app) {
    const { isAppFilePath, resolveIOSApp } = await import('../resolve-app');
    if (isAppFilePath(opts.app)) {
      // Need simulator UDID for install — resolve it early
      const sim = await resolveSimulator(opts.device);
      if (sim.state !== 'Booted') await bootSimulator(sim.udid);
      opts.app = await resolveIOSApp(opts.app, sim.udid, log);
    }
  }

  // Check if already running
  const existing = readState();
  if (existing) {
    const healthy = await checkHealth(existing.port);
    if (healthy) {
      // Open Simulator.app window if --visible (even if already running)
      if (opts.visible) {
        const { execSync: execSyncVis } = await import('child_process');
        try { execSyncVis('open -a Simulator', { stdio: 'pipe', timeout: 5000 }); } catch {}
      }
      // Reconfigure target if different app
      if (opts.app && existing.app !== opts.app) {
        log(`Switching target to ${opts.app}...`);
        await configureTarget(existing.port, opts.app);
        const updated = { ...existing, app: opts.app };
        writeState(updated);
        return updated;
      }
      return existing;
    }
    // Unhealthy — clean up stale processes before fresh start
    log('Cleaning up stale runner...');
    await killStaleRunners(existing.port, existing.pid);
    clearState();
  } else {
    // No state file but port might still be occupied by an orphan
    await killStaleRunners(port);
  }

  // Resolve simulator
  log('Resolving simulator...');
  const sim = await resolveSimulator(opts.device);

  // Boot
  if (sim.state !== 'Booted') {
    log(`Booting ${sim.name}...`);
    await bootSimulator(sim.udid);
  }

  // Open Simulator.app window if --visible
  if (opts.visible) {
    const { execSync: execSyncVis } = await import('child_process');
    try { execSyncVis('open -a Simulator', { stdio: 'pipe', timeout: 5000 }); } catch {}
  }

  // Build runner if needed — check multiple locations for bundled vs dev
  const runnerCandidates = [
    path.resolve(__dirname_svc, '../../../browse-ios-runner'),
    path.resolve(__dirname_svc, '../../browse-ios-runner'),
    path.resolve(__dirname_svc, '../bin/browse-ios-runner'),
  ];
  const runnerDir = runnerCandidates.find(d => fs.existsSync(path.join(d, 'project.yml')))
    || runnerCandidates[0];
  const { execSync } = await import('child_process');

  if (!fs.existsSync(path.join(runnerDir, 'BrowseRunner.xcodeproj', 'project.pbxproj'))) {
    log('Generating Xcode project...');
    execSync('xcodegen generate --spec project.yml', { cwd: runnerDir, stdio: 'pipe' });
  }

  log('Building iOS runner...');
  execSync(
    `xcodebuild build-for-testing -project BrowseRunner.xcodeproj -scheme BrowseRunnerApp -sdk iphonesimulator -destination "id=${sim.udid}" -derivedDataPath .build CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO -quiet`,
    { cwd: runnerDir, stdio: 'pipe', timeout: 120000 },
  );

  // Launch runner in background
  log('Starting runner...');
  const proc = spawn('xcodebuild', [
    'test', '-project', 'BrowseRunner.xcodeproj', '-scheme', 'BrowseRunnerApp',
    '-sdk', 'iphonesimulator', '-destination', `id=${sim.udid}`,
    '-derivedDataPath', '.build',
    'CODE_SIGN_IDENTITY=', 'CODE_SIGNING_ALLOWED=NO',
    '-test-timeouts-enabled', 'NO',
  ], {
    cwd: runnerDir,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  proc.unref();

  // Wait for health
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) break;
    await sleep(2000);
  }

  if (!await checkHealth(port)) {
    throw new Error('iOS runner failed to start within 60s. Check: browse-ios-runner/.build/ for logs');
  }

  // Configure target app
  const targetApp = opts.app || 'io.ulpi.browse-ios-runner';
  if (opts.app) {
    log(`Configuring target: ${opts.app}...`);
    await configureTarget(port, opts.app);
  }

  const state: SimServiceState = {
    platform: 'ios',
    device: sim.name,
    udid: sim.udid,
    app: targetApp,
    port,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  return state;
}
