/**
 * Android emulator management — find SDK, create AVDs, start emulators.
 *
 * Handles the full bootstrap chain:
 *   1. Find or install Android SDK command-line tools
 *   2. Install a system image if none exists
 *   3. Create an AVD if none exists
 *   4. Start the emulator
 *   5. Wait for boot
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_AVD_NAME = 'browse_default';

/** Ensure JAVA_HOME is set for child processes. Homebrew openjdk needs this. */
export function ensureJavaHome(): void {
  if (process.env.JAVA_HOME) return;
  const brewJdk = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
  if (fs.existsSync(brewJdk)) {
    process.env.JAVA_HOME = brewJdk;
    process.env.PATH = `${brewJdk}/bin:${process.env.PATH}`;
    return;
  }
  // Intel Mac
  const intelJdk = '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
  if (fs.existsSync(intelJdk)) {
    process.env.JAVA_HOME = intelJdk;
    process.env.PATH = `${intelJdk}/bin:${process.env.PATH}`;
  }
}
const DEFAULT_API_LEVEL = '35';
const DEFAULT_SYSTEM_IMAGE = `system-images;android-${DEFAULT_API_LEVEL};google_apis;arm64-v8a`;

type Log = (msg: string) => void;

// ─── SDK Resolution ─────────────────────────────────────────────

/** Common Android SDK locations by platform */
function sdkCandidates(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') {
    return [
      process.env.ANDROID_HOME || '',
      process.env.ANDROID_SDK_ROOT || '',
      path.join(home, 'Library/Android/sdk'),
      '/opt/homebrew/share/android-commandlinetools',
    ].filter(Boolean);
  }
  return [
    process.env.ANDROID_HOME || '',
    process.env.ANDROID_SDK_ROOT || '',
    path.join(home, 'Android/Sdk'),
    '/usr/lib/android-sdk',
  ].filter(Boolean);
}

/** Find the Android SDK root directory, or null if not found */
export function findSdkRoot(): string | null {
  for (const dir of sdkCandidates()) {
    // SDK root should have at least one of: cmdline-tools, platform-tools, emulator
    if (fs.existsSync(path.join(dir, 'cmdline-tools')) ||
        fs.existsSync(path.join(dir, 'platform-tools')) ||
        fs.existsSync(path.join(dir, 'emulator'))) {
      return dir;
    }
  }
  return null;
}

/** Find the sdkmanager binary */
function findSdkManager(sdkRoot: string): string | null {
  const paths = [
    path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'),
    path.join(sdkRoot, 'cmdline-tools/bin/sdkmanager'),
    // Homebrew installs cmdline-tools directly
    path.join(sdkRoot, 'bin/sdkmanager'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Find the avdmanager binary */
function findAvdManager(sdkRoot: string): string | null {
  const paths = [
    path.join(sdkRoot, 'cmdline-tools/latest/bin/avdmanager'),
    path.join(sdkRoot, 'cmdline-tools/bin/avdmanager'),
    path.join(sdkRoot, 'bin/avdmanager'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Find the emulator binary */
function findEmulator(sdkRoot: string): string | null {
  const paths = [
    path.join(sdkRoot, 'emulator/emulator'),
    path.join(sdkRoot, 'tools/emulator'),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  // Also check PATH
  try {
    execSync('which emulator', { stdio: 'pipe', timeout: 3000 });
    return 'emulator';
  } catch {
    return null;
  }
}

// ─── SDK Installation ───────────────────────────────────────────

/** Install Android SDK cmdline-tools via Homebrew (macOS) */
export async function installSdk(log: Log): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      execSync('brew --version', { stdio: 'ignore', timeout: 5000 });
    } catch {
      log('Homebrew not found. Install Android Studio manually:');
      log('  https://developer.android.com/studio');
      return null;
    }

    log('Installing Android SDK command-line tools via Homebrew...');
    try {
      execSync('brew install --cask android-commandlinetools', {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
      });
    } catch (err: any) {
      // May already be installed
      if (!err.message?.includes('already installed')) {
        log(`Install failed: ${err.message}`);
        return null;
      }
    }

    // Find SDK root after install
    const sdkRoot = findSdkRoot();
    if (!sdkRoot) {
      log('SDK install succeeded but could not find SDK root.');
      return null;
    }
    log(`SDK found: ${sdkRoot}`);
    return sdkRoot;
  }

  log('Install Android SDK:');
  log('  https://developer.android.com/studio#command-line-tools-only');
  return null;
}

// ─── System Image & AVD ─────────────────────────────────────────

/** Check if a system image is installed */
function hasSystemImage(sdkRoot: string): boolean {
  const imgDir = path.join(sdkRoot, 'system-images', `android-${DEFAULT_API_LEVEL}`, 'google_apis', 'arm64-v8a');
  return fs.existsSync(imgDir);
}

/** Install the default system image using sdkmanager */
export function installSystemImage(sdkManager: string, log: Log): boolean {
  log(`Installing system image (API ${DEFAULT_API_LEVEL})... this may take a few minutes`);
  try {
    execSync(`yes | "${sdkManager}" --install "${DEFAULT_SYSTEM_IMAGE}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000,
      shell: '/bin/bash',
    });
    return true;
  } catch (err: any) {
    // Check if already installed
    if (err.message?.includes('already installed') || err.message?.includes('100%')) return true;
    log(`System image install failed: ${err.message}`);
    return false;
  }
}

/** List existing AVDs */
function listAvds(avdManager: string): string[] {
  try {
    const output = execSync(`"${avdManager}" list avd -c`, {
      encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Create the default AVD */
export function createAvd(sdkRoot: string, avdManager: string, log: Log): boolean {
  log(`Creating AVD '${DEFAULT_AVD_NAME}'...`);
  try {
    execSync(
      `echo no | "${avdManager}" create avd -n ${DEFAULT_AVD_NAME} -k "${DEFAULT_SYSTEM_IMAGE}" --force`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000, shell: '/bin/bash' },
    );
    return true;
  } catch (err: any) {
    log(`AVD creation failed: ${err.message}`);
    return false;
  }
}

// ─── Emulator Start ─────────────────────────────────────────────

/** Start an emulator with the given AVD name */
export function startEmulator(emulatorBin: string, avdName: string, log: Log): void {
  log(`Starting emulator '${avdName}'...`);
  const proc = spawn(emulatorBin, [
    '-avd', avdName,
    '-no-audio',
    '-no-window',
    '-gpu', 'swiftshader_indirect',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
}

/** Wait for emulator to boot and appear in adb devices */
export async function waitForBoot(log: Log, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  log('Waiting for emulator to boot...');

  while (Date.now() < deadline) {
    try {
      const output = execSync('adb devices', { encoding: 'utf-8', timeout: 5000 });
      const lines = output.split('\n').slice(1).filter(l => l.includes('\tdevice'));
      const emulator = lines.find(l => l.startsWith('emulator-'));
      if (emulator) {
        const serial = emulator.split('\t')[0].trim();
        // Wait for boot animation to finish
        try {
          const bootAnim = execSync(`adb -s ${serial} shell getprop init.svc.bootanim`, {
            encoding: 'utf-8', timeout: 5000,
          }).trim();
          if (bootAnim === 'stopped') {
            return serial;
          }
        } catch {}
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Emulator did not boot within ${timeoutMs / 1000}s`);
}

// ─── Orchestration ──────────────────────────────────────────────

/**
 * Ensure an Android emulator is running and return its serial.
 * Handles the full chain: SDK → system image → AVD → emulator → boot.
 */
export async function ensureEmulator(log: Log): Promise<string> {
  // 0. Ensure Java is available (required by sdkmanager)
  ensureJavaHome();
  const hasJava = () => { try { execSync('java -version', { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } };

  if (!hasJava()) {
    if (process.platform === 'darwin') {
      try { execSync('brew --version', { stdio: 'ignore', timeout: 5000 }); } catch {
        throw new Error('Java is required for Android SDK.\nInstall Homebrew (https://brew.sh) then: brew install --cask temurin');
      }
      log('Installing Java (required by Android SDK)...');
      // Try openjdk first (formula, no cask quarantine), then temurin
      const javaFormulas = ['openjdk', 'temurin'];
      for (const formula of javaFormulas) {
        try {
          const cmd = formula === 'openjdk' ? `brew install ${formula}` : `brew install --cask ${formula}`;
          execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
        } catch {
          // May exit non-zero even on success
        }
        // openjdk needs to be symlinked for system java
        if (formula === 'openjdk') {
          try {
            execSync('sudo ln -sfn /opt/homebrew/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk', {
              stdio: 'ignore', timeout: 10_000,
            });
          } catch {
            // May need explicit PATH instead — set JAVA_HOME
            const jdkPath = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
            if (fs.existsSync(jdkPath)) {
              process.env.JAVA_HOME = jdkPath;
              process.env.PATH = `${jdkPath}/bin:${process.env.PATH}`;
            }
          }
        }
        if (hasJava()) break;
      }
      if (!hasJava()) {
        throw new Error('Java install did not succeed. Run manually:\n  brew install openjdk');
      }
      ensureJavaHome();
      log('Java installed.');
    } else {
      throw new Error('Java is required for Android SDK. Install a JDK (e.g. OpenJDK 17).');
    }
  }

  // 1. Find SDK
  let sdkRoot = findSdkRoot();
  if (!sdkRoot) {
    sdkRoot = await installSdk(log);
    if (!sdkRoot) {
      throw new Error(
        'Android SDK not found and could not be installed.\n' +
        'Install Android Studio: https://developer.android.com/studio',
      );
    }
  }

  // 2. Find emulator binary
  let emulatorBin = findEmulator(sdkRoot);

  // 3. Find sdkmanager and avdmanager
  const sdkManager = findSdkManager(sdkRoot);
  const avdManager = findAvdManager(sdkRoot);

  // 4. Accept licenses and install emulator component if missing
  if (sdkManager) {
    // Accept all SDK licenses first (required before any install)
    try {
      execSync(`yes | "${sdkManager}" --licenses`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000, shell: '/bin/bash',
      });
    } catch {
      // May fail if already accepted — that's fine
    }
  }

  if (!emulatorBin && sdkManager) {
    log('Installing Android emulator...');
    try {
      execSync(`"${sdkManager}" --install "emulator" "platform-tools" "platforms;android-${DEFAULT_API_LEVEL}"`, {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 300_000,
      });
      emulatorBin = findEmulator(sdkRoot);
    } catch (err: any) {
      log(`Emulator install output: ${err.message?.slice(0, 200)}`);
    }
  }

  if (!emulatorBin) {
    throw new Error(
      'Android emulator not found. Install via Android Studio or:\n' +
      `  sdkmanager --install "emulator" "platforms;android-${DEFAULT_API_LEVEL}"`,
    );
  }

  // 5. Ensure system image
  if (!hasSystemImage(sdkRoot) && sdkManager) {
    if (!installSystemImage(sdkManager, log)) {
      throw new Error(`Failed to install system image. Run manually:\n  ${sdkManager} --install "${DEFAULT_SYSTEM_IMAGE}"`);
    }
  }

  // 6. Ensure AVD exists
  if (avdManager) {
    const avds = listAvds(avdManager);
    if (!avds.includes(DEFAULT_AVD_NAME)) {
      if (!createAvd(sdkRoot, avdManager, log)) {
        throw new Error('Failed to create AVD. Check system image installation.');
      }
    }
  }

  // 7. Start emulator
  startEmulator(emulatorBin, DEFAULT_AVD_NAME, log);

  // 8. Wait for boot
  return waitForBoot(log);
}
