/**
 * Android device/emulator lifecycle service — shared between CLI and command layer.
 *
 * Mirrors the iOS sim-service pattern: state persistence, health checking,
 * start/stop lifecycle, and target app management.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRIVER_PORT = 7779;

// ─── State ─────────────────────────────────────────────────────

export interface AndroidServiceState {
  platform: string;
  device: string;
  serial: string;
  app: string;
  port: number;
  startedAt: string;
}

function resolveStateDir(): string {
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
  return path.join(resolveStateDir(), 'android-state.json');
}

export function readState(): AndroidServiceState | null {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8')); } catch { return null; }
}

function writeState(state: AndroidServiceState): void {
  const dir = path.dirname(stateFilePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}

function clearState(): void {
  try { fs.unlinkSync(stateFilePath()); } catch {}
}

// ─── Health ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function checkHealth(port: number = DRIVER_PORT): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch { return false; }
}

// ─── Status ────────────────────────────────────────────────────

export async function status(): Promise<{ running: boolean; state: AndroidServiceState | null; healthy: boolean }> {
  const state = readState();
  if (!state) return { running: false, state: null, healthy: false };
  const healthy = await checkHealth(state.port);
  if (!healthy) { clearState(); return { running: false, state, healthy: false }; }
  return { running: true, state, healthy: true };
}

// ─── Stop ──────────────────────────────────────────────────────

export async function stop(): Promise<string> {
  const state = readState();
  if (!state) return 'No Android device/emulator running.';

  const { ensureAndroidBridge } = await import('./bridge');
  try {
    // Kill driver instrumentation
    execSync(`adb -s ${state.serial} shell am force-stop io.ulpi.browse.driver.test`, { stdio: 'pipe', timeout: 5000 });
    execSync(`adb -s ${state.serial} shell am force-stop io.ulpi.browse.driver`, { stdio: 'pipe', timeout: 5000 });
    // Remove port forwarding
    execSync(`adb -s ${state.serial} forward --remove tcp:${state.port}`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    // Best-effort cleanup
  }

  clearState();
  return `Android stopped (${state.device}).`;
}

// ─── Start ─────────────────────────────────────────────────────

export interface StartOptions {
  device?: string;
  app?: string;
  visible?: boolean;
  log?: (msg: string) => void;
}

export async function startAndroid(opts: StartOptions = {}): Promise<AndroidServiceState> {
  const log = opts.log || ((msg: string) => process.stderr.write(`[browse] ${msg}\n`));
  const port = DRIVER_PORT;

  // Check if already running
  const existing = readState();
  if (existing) {
    const healthy = await checkHealth(existing.port);
    if (healthy) {
      // Switch target app if different
      if (opts.app && existing.app !== opts.app) {
        log(`Switching to ${opts.app}...`);
        // Must restart driver with new target package — Android instrumentation
        // is scoped to a package at launch time (unlike iOS /configure)
        await stop();
        // Fall through to full start with new app
      } else {
        return existing;
      }
    }
    log('Cleaning up stale driver...');
    await stop();
  }

  // Find device — auto-install adb if missing, auto-start emulator if no device
  log('Finding Android device...');
  const { ensureAndroidBridge, createAndroidBridge, AdbNotFoundError, installAdb } = await import('./bridge');
  let serial: string;
  try {
    serial = await ensureAndroidBridge(opts.device);
  } catch (err: any) {
    if (err instanceof AdbNotFoundError) {
      log('adb not found. Attempting to install...');
      const installed = await installAdb(log);
      if (!installed) throw err;
      // Retry — may still fail if no device
      try {
        serial = await ensureAndroidBridge(opts.device);
      } catch (retryErr: any) {
        if (retryErr.message?.includes('No booted Android device')) {
          const { ensureEmulator } = await import('./emulator');
          serial = await ensureEmulator(log, opts.visible);
        } else {
          throw retryErr;
        }
      }
    } else if (err.message?.includes('No booted Android device')) {
      // adb exists but no device — start emulator
      const { ensureEmulator } = await import('./emulator');
      serial = await ensureEmulator(log, opts.visible);
    } else {
      throw err;
    }
  }

  // Get device name
  let deviceName = serial;
  try {
    deviceName = execSync(`adb -s ${serial} shell getprop ro.product.model`, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || serial;
  } catch {}

  // Build driver APK if not found
  const driverApkDir = path.resolve(__dirname, '../../../browse-android');
  const apkPath = path.join(driverApkDir, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
  if (!fs.existsSync(apkPath) && fs.existsSync(path.join(driverApkDir, 'gradlew'))) {
    log('Building Android driver APK...');
    try {
      // Ensure JAVA_HOME and ANDROID_HOME are set for gradle
      const { findSdkRoot, ensureJavaHome } = await import('./emulator');
      ensureJavaHome();
      if (!process.env.ANDROID_HOME) {
        const sdkRoot = findSdkRoot();
        if (sdkRoot) process.env.ANDROID_HOME = sdkRoot;
      }
      execSync('./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --stacktrace', {
        cwd: driverApkDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
      });
      log('APK built.');
    } catch (err: any) {
      const stdout = err.stdout?.toString() || '';
      const stderr = err.stderr?.toString() || '';
      const combined = stdout + '\n' + stderr;
      // Find meaningful error lines (skip stack traces)
      const lines = combined.split('\n');
      const errorLines = lines.filter((l: string) =>
        !l.startsWith('\tat ') && !l.startsWith('	at ') &&
        (l.includes('error') || l.includes('Error') || l.includes('FAILURE') ||
         l.includes('Could not') || l.includes('wrong') || l.includes('Cannot') ||
         l.includes('SDK') || l.includes('missing'))
      );
      log(`APK build failed:\n${errorLines.slice(0, 10).join('\n') || lines.slice(0, 15).join('\n')}`);
    }
  }

  const targetApp = opts.app || 'com.android.settings';

  // Launch the target app before starting the driver
  log(`Launching ${targetApp}...`);
  try {
    execSync(`adb -s ${serial} shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${targetApp}`, {
      stdio: 'pipe', timeout: 10_000,
    });
  } catch {
    // Fallback for apps without standard launcher activity
    try {
      execSync(`adb -s ${serial} shell monkey -p ${targetApp} -c android.intent.category.LAUNCHER 1`, {
        stdio: 'pipe', timeout: 10_000,
      });
    } catch {}
  }
  await sleep(2000);

  log('Starting driver...');
  await createAndroidBridge(serial, targetApp);

  const state: AndroidServiceState = {
    platform: 'android',
    device: deviceName,
    serial,
    app: targetApp,
    port,
    startedAt: new Date().toISOString(),
  };
  writeState(state);
  return state;
}
