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
import { fileURLToPath } from 'url';

const __filename_bridge = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_bridge);
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
const DRIVER_HEALTH_TIMEOUT_MS = 15_000;
const DRIVER_HEALTH_POLL_MS = 250;
const INSTRUMENTATION_MAX_RETRIES = 2;

/** Path to the prebuilt driver APK — checks multiple locations */
function resolveDriverApkPath(): string {
  const candidates = [
    // 1. Local dev build
    path.resolve(__dirname, '../../../browse-android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'),
    // 2. Installed alongside source (bin/ at project root)
    path.resolve(__dirname, '../../bin/browse-android.apk'),
    // 3. Bundled build (dist/browse.cjs → ../bin/)
    path.resolve(__dirname, '../bin/browse-android.apk'),
    // 4. Same directory as binary
    path.resolve(__dirname, 'browse-android.apk'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 5. Lazy download location
  const lazyPath = path.join(
    process.env.BROWSE_LOCAL_DIR || path.join(process.cwd(), '.browse'),
    'bin', 'browse-android.apk',
  );
  if (fs.existsSync(lazyPath)) return lazyPath;

  throw new Error(
    'browse-android APK not found. Run: browse enable android\n' +
    'Or build manually: cd browse-android && ./gradlew :app:assembleDebugAndroidTest',
  );
}

/** Path to the base app APK (needed alongside the test APK) */
function resolveAppApkPath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../browse-android/app/build/outputs/apk/debug/app-debug.apk'),
    path.resolve(__dirname, '../../bin/browse-android-app.apk'),
    path.resolve(__dirname, '../bin/browse-android-app.apk'),
    path.resolve(__dirname, 'browse-android-app.apk'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ─── adb helpers ─────────────────────────────────────────────────

function adbExec(serial: string, ...args: string[]): string {
  return execSync(['adb', '-s', serial, ...args].join(' '), {
    encoding: 'utf-8',
    timeout: 30_000,
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
    execSync('adb version', { stdio: 'ignore', timeout: 5_000 });
  } catch {
    throw new AdbNotFoundError();
  }

  // 2. Find device
  return resolveDevice(serial);
}

/**
 * Attempt to install Android platform-tools automatically.
 * On macOS, uses Homebrew. Returns true if install succeeded.
 */
export async function installAdb(log?: (msg: string) => void): Promise<boolean> {
  const print = log || ((msg: string) => process.stderr.write(`[browse] ${msg}\n`));

  if (process.platform === 'darwin') {
    // Check for Homebrew
    try {
      execSync('brew --version', { stdio: 'ignore', timeout: 5_000 });
    } catch {
      print('Homebrew not found. Install it first: https://brew.sh');
      print('Then run: brew install android-platform-tools');
      return false;
    }

    print('Installing Android platform-tools via Homebrew...');
    try {
      execSync('brew install android-platform-tools', {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      // Verify it worked
      execSync('adb version', { stdio: 'ignore', timeout: 5_000 });
      print('adb installed successfully.');
      return true;
    } catch (err: any) {
      print(`Homebrew install failed: ${err.message}`);
      return false;
    }
  }

  // Linux — direct download
  print('Install Android platform-tools:');
  print('  curl -LO https://dl.google.com/android/repository/platform-tools-latest-linux.zip');
  print('  unzip platform-tools-latest-linux.zip');
  print('  export PATH="$PWD/platform-tools:$PATH"');
  return false;
}

/** Sentinel error so sim-service can catch it and offer install */
export class AdbNotFoundError extends Error {
  constructor() {
    super(
      'adb not found. Install Android SDK platform-tools and add to PATH.\n' +
      'https://developer.android.com/tools/releases/platform-tools',
    );
    this.name = 'AdbNotFoundError';
  }
}

/**
 * Resolve which device serial to use.
 * If `serial` is provided, verify it is connected.
 * Otherwise, pick the single booted device/emulator.
 */
function resolveDevice(serial?: string): string {
  const output = execSync('adb devices', { encoding: 'utf-8', timeout: 5_000 });
  const lines = output
    .split('\n')
    .slice(1) // skip "List of devices attached" header
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('*'));

  const booted = lines
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0].trim());

  if (booted.length === 0) {
    // Check if devices exist but aren't "device" state
    const others = lines.filter((l) => !l.endsWith('\tdevice'));
    if (others.length > 0) {
      const states = others.map((l) => l.replace('\t', ' (') + ')').join(', ');
      throw new Error(
        `Android devices found but not ready: ${states}\n` +
        'Wait for the device to finish booting, or check USB debugging authorization.',
      );
    }
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
      'Specify which device to use with: --device <serial>',
    );
  }

  return booted[0];
}

// ─── Public: bridge factory ───────────────────────────────────────

/**
 * Create an Android bridge protocol for a target package.
 *
 * Steps:
 *   1. Verify target app is installed on device
 *   2. Install the driver APK (if not already installed)
 *   3. Kill any stale driver instrumentation
 *   4. Start the instrumentation service on-device
 *   5. Forward port 7779 to localhost
 *   6. Wait for /health to respond
 *   7. Return the AndroidDriverProtocol implementation
 */
export async function createAndroidBridge(
  serial: string,
  packageName: string,
): Promise<AndroidDriverProtocol> {
  // Verify target app is installed
  verifyAppInstalled(serial, packageName);

  // Install driver APK
  const apkPath = resolveDriverApkPath();
  installDriverApk(serial, apkPath);

  // Kill any stale instrumentation from a previous session
  killStaleInstrumentation(serial);

  // Forward port first (before instrumentation, so it's ready when server starts)
  forwardPort(serial, DRIVER_PORT);

  // Start instrumentation with retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= INSTRUMENTATION_MAX_RETRIES; attempt++) {
    try {
      startInstrumentation(serial, packageName);
      await waitForHealth(DRIVER_PORT, DRIVER_HEALTH_TIMEOUT_MS, DRIVER_HEALTH_POLL_MS);
      return buildProtocol(serial, DRIVER_PORT);
    } catch (err: any) {
      lastError = err;
      if (attempt < INSTRUMENTATION_MAX_RETRIES) {
        // Kill and retry
        killStaleInstrumentation(serial);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  // Clean up forwarding on failure
  cleanupForward(serial, DRIVER_PORT);
  throw lastError ?? new Error('Failed to start Android driver');
}

// ─── Setup helpers ────────────────────────────────────────────────

function verifyAppInstalled(serial: string, packageName: string): void {
  const result = adbExecSafe(serial, 'shell', 'pm', 'list', 'packages', packageName);
  if (!result || !result.includes(`package:${packageName}`)) {
    throw new Error(
      `App '${packageName}' is not installed on device ${serial}.\n` +
      `Install it first, e.g.: adb -s ${serial} install path/to/app.apk`,
    );
  }
}

function installDriverApk(serial: string, apkPath: string): void {
  // Validate the APK file exists and isn't empty
  try {
    const stat = fs.statSync(apkPath);
    if (stat.size < 1024) {
      throw new Error(`APK file appears corrupt (${stat.size} bytes): ${apkPath}`);
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`APK file not found: ${apkPath}`);
    }
    throw err;
  }

  // Check if both base and test packages are already installed
  const installedBase = adbExecSafe(serial, 'shell', 'pm', 'list', 'packages', DRIVER_PACKAGE);
  const installedTest = adbExecSafe(serial, 'shell', 'pm', 'list', 'packages', DRIVER_TEST_PACKAGE);
  if (installedBase?.includes(`package:${DRIVER_PACKAGE}`) && installedTest?.includes(DRIVER_TEST_PACKAGE)) {
    return; // Both installed — skip reinstall for speed
  }

  // Install both the app and test APK
  // Need the app APK for the instrumentation target
  const appApkPath = resolveAppApkPath() || apkPath.replace('-androidTest', '');
  if (fs.existsSync(appApkPath)) {
    try {
      adbExec(serial, 'install', '-t', '-r', `"${appApkPath}"`);
    } catch {
      // App APK install failed — may already be installed, continue
    }
  }

  try {
    // -t allows test APKs
    adbExec(serial, 'install', '-t', '-r', `"${apkPath}"`);
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('INSTALL_FAILED_ALREADY_EXISTS')) return;
    throw new Error(
      `Failed to install browse-android driver APK: ${msg}\n` +
      `APK path: ${apkPath}\n` +
      'Ensure the device has enough storage and USB debugging is enabled.',
    );
  }
}

function killStaleInstrumentation(serial: string): void {
  // Kill any running browse driver instrumentation
  adbExecSafe(serial, 'shell', 'am', 'force-stop', DRIVER_TEST_PACKAGE);
  adbExecSafe(serial, 'shell', 'am', 'force-stop', DRIVER_PACKAGE);
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
    throw new Error(
      `adb port forwarding failed: ${err.message}\n` +
      `Ensure no other process is using port ${port}.`,
    );
  }
}

function cleanupForward(serial: string, port: number): void {
  adbExecSafe(serial, 'forward', '--remove', `tcp:${port}`);
}

async function waitForHealth(port: number, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err: any) {
      lastError = err.code || err.message || 'connection failed';
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Android driver did not become ready within ${timeoutMs}ms (last: ${lastError}).\n` +
    'Troubleshooting:\n' +
    '  1. Check logcat: adb logcat -s BrowseDriver\n' +
    '  2. Verify port forwarding: adb forward --list\n' +
    '  3. Ensure target app is in foreground\n' +
    '  4. Try: browse doctor --platform android',
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
