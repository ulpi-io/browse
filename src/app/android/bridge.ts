/**
 * Android host bridge — spawns the on-device driver and communicates via HTTP.
 *
 * Flow:
 *   1. ensureAndroidBridge() — checks adb, finds a booted emulator/device
 *   2. createAndroidBridge(serial, packageName) — installs APK (if needed),
 *      starts instrumentation via `adb shell am instrument`, forwards port
 *   3. AndroidDriverProtocol methods — thin HTTP wrappers to the on-device service
 *
 * The driver APK exposes a JSON-over-HTTP API on port 7779 (device-side).
 * The bridge forwards that port to localhost via `adb forward`.
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  AndroidDriverProtocol,
  RawAndroidNode,
  AndroidState,
  ActionRequest,
  SetValueRequest,
  TypeRequest,
  PressRequest,
  ScreenshotRequest,
  DriverResult,
} from './protocol';

// ─── Constants ───────────────────────────────────────────────────

const DRIVER_PACKAGE = 'io.ulpi.browse.driver';
const DRIVER_TEST_PACKAGE = `${DRIVER_PACKAGE}.test`;
const DRIVER_RUNNER = 'androidx.test.runner.AndroidJUnitRunner';
const DRIVER_PORT = 7779;
const DRIVER_HEALTH_TIMEOUT_MS = 10_000;
const DRIVER_HEALTH_POLL_MS = 250;

/** Path to the prebuilt driver APK, relative to this file */
function resolveDriverApkPath(): string {
  // 1. Pre-built alongside source (CI or local build)
  const localBuild = path.resolve(
    __dirname,
    '../../../browse-android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
  );
  if (fs.existsSync(localBuild)) return localBuild;

  // 2. Installed alongside package
  const installed = path.resolve(__dirname, '../../bin/browse-android.apk');
  if (fs.existsSync(installed)) return installed;

  // 3. Lazy download location
  const lazyPath = path.join(
    process.env.BROWSE_LOCAL_DIR || path.join(process.cwd(), '.browse'),
    'bin', 'browse-android.apk',
  );
  if (fs.existsSync(lazyPath)) return lazyPath;

  throw new Error(
    'browse-android APK not found. Build it with:\n' +
    '  cd browse-android && ./gradlew :app:assembleDebugAndroidTest\n' +
    'Or run: browse doctor --platform android',
  );
}

// ─── adb helpers ─────────────────────────────────────────────────

function adbExec(serial: string, ...args: string[]): string {
  return execSync(['adb', '-s', serial, ...args].join(' '), {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function adbExecSafe(serial: string, ...args: string[]): string | null {
  try {
    return adbExec(serial, ...args);
  } catch {
    return null;
  }
}

// ─── Public: environment check ───────────────────────────────────

/**
 * Check for adb availability and a booted device/emulator.
 * Returns the device serial to use.
 */
export async function ensureAndroidBridge(serial?: string): Promise<string> {
  // 1. adb must be on PATH
  try {
    execSync('adb version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'adb not found. Install Android SDK platform-tools and add to PATH.\n' +
      'https://developer.android.com/tools/releases/platform-tools',
    );
  }

  // 2. Find device
  const resolved = resolveDevice(serial);
  return resolved;
}

/**
 * Resolve which device serial to use.
 * If `serial` is provided, verify it is connected.
 * Otherwise, pick the single booted device/emulator.
 */
function resolveDevice(serial?: string): string {
  const output = execSync('adb devices', { encoding: 'utf-8' });
  const lines = output
    .split('\n')
    .slice(1) // skip "List of devices attached" header
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('*'));

  const booted = lines
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0].trim());

  if (booted.length === 0) {
    throw new Error(
      'No booted Android device or emulator found.\n' +
      'Start an emulator (Android Studio) or connect a device with USB debugging.',
    );
  }

  if (serial) {
    if (!booted.includes(serial)) {
      throw new Error(
        `Device '${serial}' is not connected or not in "device" state.\n` +
        `Connected devices: ${booted.join(', ')}`,
      );
    }
    return serial;
  }

  if (booted.length > 1) {
    throw new Error(
      `Multiple Android devices connected: ${booted.join(', ')}.\n` +
      'Pass a serial explicitly: createAndroidBridge(serial, packageName)',
    );
  }

  return booted[0];
}

// ─── Public: bridge factory ───────────────────────────────────────

/**
 * Create an Android bridge protocol for a target package.
 *
 * Steps:
 *   1. Install the driver APK (if not already installed / version differs)
 *   2. Start the instrumentation service on-device
 *   3. Forward port 7779 to localhost
 *   4. Wait for /health to respond
 *   5. Return the AndroidDriverProtocol implementation
 */
export async function createAndroidBridge(
  serial: string,
  packageName: string,
): Promise<AndroidDriverProtocol> {
  // Install driver APK
  const apkPath = resolveDriverApkPath();
  installDriverApk(serial, apkPath);

  // Start instrumentation (fire-and-forget — stays running until killed)
  startInstrumentation(serial, packageName);

  // Forward port
  forwardPort(serial, DRIVER_PORT);

  // Wait for the driver to be ready
  await waitForHealth(DRIVER_PORT, DRIVER_HEALTH_TIMEOUT_MS, DRIVER_HEALTH_POLL_MS);

  return buildProtocol(serial, DRIVER_PORT);
}

// ─── Setup helpers ────────────────────────────────────────────────

function installDriverApk(serial: string, apkPath: string): void {
  // Check if already installed
  const installed = adbExecSafe(serial, 'shell', 'pm', 'list', 'packages', DRIVER_TEST_PACKAGE);
  if (installed && installed.includes(DRIVER_TEST_PACKAGE)) {
    return; // Already installed — skip reinstall for speed
  }

  try {
    // -t allows test APKs
    adbExec(serial, 'install', '-t', '-r', `"${apkPath}"`);
  } catch (err: any) {
    throw new Error(
      `Failed to install browse-android driver APK: ${err.message}\n` +
      `APK path: ${apkPath}`,
    );
  }
}

function startInstrumentation(serial: string, targetPackage: string): void {
  // Spawned detached — instrumentation runs until the test process is killed
  const proc = spawn(
    'adb',
    [
      '-s', serial,
      'shell', 'am', 'instrument',
      '-w',
      '-e', 'targetPackage', targetPackage,
      `${DRIVER_TEST_PACKAGE}/${DRIVER_RUNNER}`,
    ],
    { stdio: 'ignore', detached: true },
  );
  proc.unref();
}

function forwardPort(serial: string, port: number): void {
  try {
    adbExec(serial, 'forward', `tcp:${port}`, `tcp:${port}`);
  } catch (err: any) {
    throw new Error(`adb forward failed: ${err.message}`);
  }
}

async function waitForHealth(port: number, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Android driver did not become ready within ${timeoutMs}ms.\n` +
    'Check adb logcat for errors: adb logcat -s BrowseDriver',
  );
}

// ─── HTTP transport ───────────────────────────────────────────────

async function driverGet<T>(port: number, endpoint: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Driver ${endpoint} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

async function driverPost<T>(port: number, endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Driver ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Protocol implementation ──────────────────────────────────────

function buildProtocol(serial: string, port: number): AndroidDriverProtocol {
  return {
    async tree(): Promise<RawAndroidNode> {
      return driverPost<RawAndroidNode>(port, '/tree', {});
    },

    async action(nodePath: number[], actionName: string): Promise<DriverResult> {
      const body: ActionRequest = { path: nodePath, action: actionName };
      return driverPost<DriverResult>(port, '/action', body);
    },

    async setValue(nodePath: number[], value: string): Promise<DriverResult> {
      const body: SetValueRequest = { path: nodePath, value };
      return driverPost<DriverResult>(port, '/setValue', body);
    },

    async type(text: string): Promise<DriverResult> {
      const body: TypeRequest = { text };
      return driverPost<DriverResult>(port, '/type', body);
    },

    async press(key: string): Promise<DriverResult> {
      const body: PressRequest = { key };
      return driverPost<DriverResult>(port, '/press', body);
    },

    async screenshot(outputPath: string): Promise<DriverResult> {
      // Ask driver to capture to a device-side temp file, then pull it
      const deviceTmp = `/data/local/tmp/browse_screenshot_${Date.now()}.png`;
      const body: ScreenshotRequest = { outputPath: deviceTmp };
      const result = await driverPost<DriverResult>(port, '/screenshot', body);
      if (!result.success) return result;

      // Pull the file from device to host
      try {
        adbExec(serial, 'pull', deviceTmp, `"${outputPath}"`);
        adbExecSafe(serial, 'shell', 'rm', deviceTmp);
      } catch (err: any) {
        return { success: false, error: `adb pull failed: ${err.message}` };
      }
      return { success: true };
    },

    async state(): Promise<AndroidState> {
      return driverGet<AndroidState>(port, '/state');
    },
  };
}
