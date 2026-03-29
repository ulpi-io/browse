/**
 * Simulator CLI handler — runs directly in the CLI process, not through the HTTP server.
 *
 * sim start boots the simulator, builds the runner, starts it, configures the target app.
 * sim stop kills the runner and optionally shuts down the simulator.
 * sim status checks the runner health.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename_sim = fileURLToPath(import.meta.url);
const __dirname_sim = path.dirname(__filename_sim);

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '.browse';
const SIM_STATE_FILE = path.join(LOCAL_DIR, 'sim-state.json');

interface SimState {
  platform: string;
  device?: string;
  app?: string;
  port: number;
  pid?: number;
  startedAt: string;
}

function readSimState(): SimState | null {
  try { return JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf-8')); } catch { return null; }
}

function writeSimState(state: SimState): void {
  fs.mkdirSync(path.dirname(SIM_STATE_FILE), { recursive: true });
  fs.writeFileSync(SIM_STATE_FILE, JSON.stringify(state, null, 2));
}

function clearSimState(): void {
  try { fs.unlinkSync(SIM_STATE_FILE); } catch {}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function handleSimCLI(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help') {
    console.log('Usage: browse sim start --platform ios [--device <name>] [--app <bundleId>]');
    console.log('       browse sim stop');
    console.log('       browse sim status');
    return;
  }

  if (sub === 'status') {
    const state = readSimState();
    if (!state) { console.log('No simulator/emulator running.'); return; }
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) });
      const health = await resp.json() as any;
      console.log(`Platform: ${state.platform}`);
      console.log(`Device:   ${state.device || 'default'}`);
      console.log(`App:      ${state.app || '(runner)'}`);
      console.log(`Port:     ${state.port}`);
      console.log(`Status:   ${health?.data?.status || 'unknown'}`);
      console.log(`Started:  ${state.startedAt}`);
    } catch {
      console.log('Runner not responding. Clearing state.');
      clearSimState();
    }
    return;
  }

  if (sub === 'stop') {
    const state = readSimState();
    if (!state) { console.log('No simulator/emulator running.'); return; }
    try { execSync('pkill -f "xcodebuild.*BrowseRunner"', { stdio: 'ignore' }); } catch {}
    clearSimState();
    console.log(`${state.platform} simulator stopped.`);
    return;
  }

  if (sub !== 'start') {
    console.error(`Unknown sim command: ${sub}`);
    process.exit(1);
  }

  // Parse start args
  let platform = 'ios';
  let device: string | undefined;
  let appBundleId: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) platform = args[++i];
    else if (args[i] === '--device' && args[i + 1]) device = args[++i];
    else if (args[i] === '--app' && args[i + 1]) appBundleId = args[++i];
  }

  if (platform === 'ios') {
    await startIOS(device, appBundleId);
  } else if (platform === 'android') {
    console.error('Android sim start not yet implemented. Use adb directly.');
    process.exit(1);
  } else {
    console.error('Usage: browse sim start --platform ios|android');
    process.exit(1);
  }
}

async function startIOS(device?: string, appBundleId?: string): Promise<void> {
  const port = 9820;

  // Check if already running
  const existing = readSimState();
  if (existing) {
    try {
      const resp = await fetch(`http://127.0.0.1:${existing.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        // Reconfigure target if different app
        if (appBundleId && existing.app !== appBundleId) {
          console.error(`[browse] Switching target to ${appBundleId}...`);
          await fetch(`http://127.0.0.1:${port}/configure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetBundleId: appBundleId }),
            signal: AbortSignal.timeout(10000),
          });
          writeSimState({ ...existing, app: appBundleId });
          console.log(`iOS simulator ready (target: ${appBundleId})`);
          return;
        }
        console.log(`iOS simulator already running on port ${existing.port}.`);
        return;
      }
    } catch {
      clearSimState();
    }
  }

  // Resolve simulator
  console.error('[browse] Resolving simulator...');
  const simList = JSON.parse(execSync('xcrun simctl list devices -j', { encoding: 'utf-8' }));
  const allDevices: Array<{ udid: string; name: string; state: string; isAvailable: boolean }> = [];
  for (const [, devices] of Object.entries(simList.devices) as any) {
    for (const d of devices) {
      if (d.isAvailable) allDevices.push(d);
    }
  }

  let sim: { udid: string; name: string; state: string };
  if (device) {
    const match = allDevices.find(d => d.name === device || d.udid === device || d.name.includes(device));
    if (!match) {
      console.error(`Simulator '${device}' not found. Available:`);
      allDevices.filter(d => d.name.includes('iPhone')).forEach(d => console.error(`  ${d.name} (${d.udid})`));
      process.exit(1);
    }
    sim = match;
  } else {
    const iphone = allDevices.find(d => d.name.includes('iPhone'));
    if (!iphone) { console.error('No available iPhone simulator.'); process.exit(1); }
    sim = iphone;
  }

  // Boot
  console.error(`[browse] Booting ${sim.name}...`);
  try { execSync(`xcrun simctl boot "${sim.udid}"`, { stdio: 'ignore' }); } catch {}
  // Open Simulator app so user can see it
  try { execSync('open -a Simulator', { stdio: 'ignore' }); } catch {}

  // Build runner
  const runnerDir = path.resolve(__dirname_sim, '../browse-ios-runner');
  if (!fs.existsSync(path.join(runnerDir, 'BrowseRunner.xcodeproj', 'project.pbxproj'))) {
    console.error('[browse] Generating Xcode project...');
    execSync('xcodegen generate --spec project.yml', { cwd: runnerDir, stdio: 'pipe' });
  }

  console.error('[browse] Building iOS runner...');
  execSync(
    `xcodebuild build-for-testing -project BrowseRunner.xcodeproj -scheme BrowseRunnerApp -sdk iphonesimulator -destination "id=${sim.udid}" -derivedDataPath .build CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO -quiet`,
    { cwd: runnerDir, stdio: 'pipe', timeout: 120000 },
  );

  // Launch runner in background
  console.error('[browse] Starting runner...');
  const proc = spawn('xcodebuild', [
    'test', '-project', 'BrowseRunner.xcodeproj', '-scheme', 'BrowseRunnerApp',
    '-sdk', 'iphonesimulator', '-destination', `id=${sim.udid}`,
    '-derivedDataPath', '.build',
    'CODE_SIGN_IDENTITY=', 'CODE_SIGNING_ALLOWED=NO',
  ], {
    cwd: runnerDir,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  proc.unref();

  // Wait for health
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) break;
    } catch {}
    await sleep(2000);
    process.stderr.write('.');
  }
  console.error('');

  // Check health one more time
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) throw new Error('not healthy');
  } catch {
    console.error('iOS runner failed to start. Check: browse-ios-runner/.build/ for logs');
    process.exit(1);
  }

  // Configure target app
  const targetApp = appBundleId || 'io.ulpi.browse-ios-runner';
  if (appBundleId) {
    console.error(`[browse] Configuring target: ${appBundleId}...`);
    try {
      await fetch(`http://127.0.0.1:${port}/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetBundleId: appBundleId }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err: any) {
      console.error(`Warning: could not configure target app: ${err.message}`);
    }
  }

  writeSimState({
    platform: 'ios',
    device: sim.name,
    app: targetApp,
    port,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
  });

  console.log(`iOS simulator ready: ${sim.name} (target: ${targetApp})`);
}
