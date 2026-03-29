/**
 * Simulator/emulator management commands — sim start, sim stop, sim status
 *
 * Unified commands for iOS simulator and Android emulator lifecycle.
 * Platform is determined by --platform flag or auto-detected.
 */

import type { BrowserTarget } from '../../browser/target';
import type { SessionManager, Session } from '../../session/manager';
import * as fs from 'fs';
import * as path from 'path';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';
const SIM_STATE_FILE = path.join(LOCAL_DIR, 'sim-state.json');

interface SimState {
  platform: string;
  device?: string;
  port: number;
  pid?: number;
  startedAt: string;
}

function readSimState(): SimState | null {
  try {
    return JSON.parse(fs.readFileSync(SIM_STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeSimState(state: SimState): void {
  fs.mkdirSync(path.dirname(SIM_STATE_FILE), { recursive: true });
  fs.writeFileSync(SIM_STATE_FILE, JSON.stringify(state, null, 2));
}

function clearSimState(): void {
  try { fs.unlinkSync(SIM_STATE_FILE); } catch {}
}

export async function handleSimCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  shutdown?: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
): Promise<string> {
  const sub = args[0];
  if (!sub || !['start', 'stop', 'status'].includes(sub)) {
    throw new Error('Usage: browse sim start [--platform ios|android] [--device <name>] | stop | status');
  }

  if (sub === 'status') {
    const state = readSimState();
    if (!state) return 'No simulator/emulator running.';

    // Health check
    try {
      const resp = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(2000) });
      const health = await resp.json() as any;
      return `Platform: ${state.platform}\nDevice: ${state.device || 'default'}\nPort: ${state.port}\nStatus: ${health?.data?.status || health?.status || 'unknown'}\nStarted: ${state.startedAt}`;
    } catch {
      clearSimState();
      return 'Simulator runner not responding. State cleared.';
    }
  }

  if (sub === 'stop') {
    const state = readSimState();
    if (!state) return 'No simulator/emulator running.';

    if (state.platform === 'ios') {
      const { execSync } = await import('child_process');
      try { execSync('pkill -f "xcodebuild.*BrowseRunner"', { stdio: 'ignore' }); } catch {}
      // Optionally shutdown the simulator
      if (state.device) {
        try { execSync(`xcrun simctl shutdown "${state.device}"`, { stdio: 'ignore' }); } catch {}
      }
    } else if (state.platform === 'android') {
      const { execSync } = await import('child_process');
      try { execSync('adb shell am force-stop io.ulpi.browse.driver', { stdio: 'ignore' }); } catch {}
    }

    clearSimState();
    return `${state.platform} simulator stopped.`;
  }

  // sub === 'start'
  const subArgs = args.slice(1);
  let platform = 'ios'; // default
  let device: string | undefined;

  for (let i = 0; i < subArgs.length; i++) {
    if (subArgs[i] === '--platform' && subArgs[i + 1]) {
      platform = subArgs[++i];
    } else if (subArgs[i] === '--device' && subArgs[i + 1]) {
      device = subArgs[++i];
    }
  }

  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Usage: browse sim start --platform ios|android [--device <name>]');
  }

  // Check if already running
  const existing = readSimState();
  if (existing) {
    try {
      const resp = await fetch(`http://127.0.0.1:${existing.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return `${existing.platform} simulator already running on port ${existing.port}.`;
    } catch {
      clearSimState();
    }
  }

  if (platform === 'ios') {
    return startIOS(device);
  } else {
    return startAndroid(device);
  }
}

async function startIOS(device?: string): Promise<string> {
  const { listSimulators, resolveSimulator, bootSimulator } = await import('../../app/ios/controller');
  const { spawn } = await import('child_process');
  const port = 9820;

  // Resolve simulator
  let udid: string;
  let simName: string;
  if (device) {
    const resolved = await resolveSimulator(device);
    udid = resolved.udid;
    simName = resolved.name;
  } else {
    // Auto-select: first available iPhone
    const sims = await listSimulators();
    const allSims = Object.values(sims).flat();
    const iphone = allSims.find(s => s.isAvailable && s.name.includes('iPhone'));
    if (!iphone) throw new Error('No available iPhone simulator found. Run: xcrun simctl list devices');
    udid = iphone.udid;
    simName = iphone.name;
  }

  // Boot
  console.error(`[browse] Booting ${simName}...`);
  await bootSimulator(udid).catch(() => {}); // already booted is OK

  // Build runner if needed
  const runnerDir = path.resolve(__dirname, '../../../browse-ios-runner');
  if (!fs.existsSync(path.join(runnerDir, 'BrowseRunner.xcodeproj'))) {
    console.error('[browse] Generating Xcode project...');
    const { execSync } = await import('child_process');
    execSync('xcodegen generate --spec project.yml', { cwd: runnerDir, stdio: 'pipe' });
  }

  // Start xcodebuild test in background
  console.error('[browse] Starting iOS runner...');
  const proc = spawn('xcodebuild', [
    'test', '-project', 'BrowseRunner.xcodeproj', '-scheme', 'BrowseRunnerApp',
    '-sdk', 'iphonesimulator', '-destination', `id=${udid}`,
    '-derivedDataPath', '.build',
    'CODE_SIGN_IDENTITY=', 'CODE_SIGNING_ALLOWED=NO',
  ], {
    cwd: runnerDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  proc.unref();
  if (proc.stderr) (proc.stderr as any).unref();

  // Wait for health
  const deadline = Date.now() + 60000; // 60s timeout
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        writeSimState({ platform: 'ios', device: simName, port, pid: proc.pid, startedAt: new Date().toISOString() });
        return `iOS simulator ready: ${simName} (port ${port})`;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }

  throw new Error(`iOS runner failed to start within 60s. Check: xcodebuild logs in browse-ios-runner/.build/`);
}

async function startAndroid(device?: string): Promise<string> {
  const { execSync } = await import('child_process');
  const port = 9821;

  // Check adb
  try {
    execSync('adb version', { stdio: 'pipe' });
  } catch {
    throw new Error('adb not found. Install Android SDK platform-tools.');
  }

  // Find device
  let serial: string;
  if (device) {
    serial = device;
  } else {
    const output = execSync('adb devices', { encoding: 'utf-8' });
    const devices = output.split('\n').slice(1).filter(l => l.includes('device')).map(l => l.split('\t')[0]);
    if (devices.length === 0) throw new Error('No Android devices/emulators found. Start one first.');
    if (devices.length > 1) throw new Error(`Multiple devices: ${devices.join(', ')}. Use --device <serial>.`);
    serial = devices[0];
  }

  writeSimState({ platform: 'android', device: serial, port, startedAt: new Date().toISOString() });
  return `Android emulator ready: ${serial} (port ${port})`;
}
