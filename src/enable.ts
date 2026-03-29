/**
 * Platform enablement — downloads and builds native drivers.
 *
 * `browse enable android|ios|macos|all`
 *
 * Each platform installs dependencies and builds its native driver
 * so that `sim start` and `--app` commands work without delay.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_enable = path.dirname(fileURLToPath(import.meta.url));

type Log = (msg: string) => void;

const log: Log = (msg) => process.stderr.write(`[browse] ${msg}\n`);

// ─── Android ────────────────────────────────────────────────────

async function enableAndroid(): Promise<void> {
  log('Enabling Android...');

  const { ensureAndroidBridge, AdbNotFoundError, installAdb } = await import('./app/android/bridge');

  // 1. adb
  try {
    await ensureAndroidBridge();
    log('adb: already available');
  } catch (err) {
    if (err instanceof AdbNotFoundError) {
      const ok = await installAdb(log);
      if (!ok) throw new Error('Failed to install adb');
    }
    // "No booted device" is fine — we just need adb installed
  }

  // 2. Java + SDK + emulator + system image + AVD
  const { ensureEmulator } = await import('./app/android/emulator');
  try {
    // This installs everything but doesn't start the emulator — we just need the setup
    // We'll catch the "no device" error since we're not starting one
    await ensureEmulator(log, false);
  } catch {
    // Expected — no device to connect to, but all components are installed
  }

  // 3. Build driver APK
  const driverDir = path.resolve(__dirname_enable, '../browse-android');
  const apkPath = path.join(driverDir, 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');

  if (!fs.existsSync(apkPath) && fs.existsSync(path.join(driverDir, 'gradlew'))) {
    const { findSdkRoot, ensureJavaHome } = await import('./app/android/emulator');
    ensureJavaHome();
    const sdkRoot = findSdkRoot();
    if (sdkRoot) process.env.ANDROID_HOME = sdkRoot;

    log('Building Android driver APK...');
    try {
      execSync('./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon', {
        cwd: driverDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
      });
      log('Android driver APK built.');
    } catch (err: any) {
      log(`APK build failed: ${err.message?.split('\n')[0]}`);
    }
  } else if (fs.existsSync(apkPath)) {
    log('Android driver APK: already built');
  }

  log('Android enabled.');
}

// ─── iOS ────────────────────────────────────────────────────────

async function enableIOS(): Promise<void> {
  log('Enabling iOS...');

  if (process.platform !== 'darwin') {
    throw new Error('iOS requires macOS with Xcode installed.');
  }

  // Check Xcode
  try {
    execSync('xcodebuild -version', { stdio: 'pipe', timeout: 10_000 });
    log('Xcode: available');
  } catch {
    throw new Error('Xcode not found. Install from the App Store or: xcode-select --install');
  }

  // Check xcodegen
  try {
    execSync('which xcodegen', { stdio: 'pipe', timeout: 5_000 });
    log('xcodegen: available');
  } catch {
    log('Installing xcodegen...');
    try {
      execSync('brew install xcodegen', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    } catch {
      throw new Error('xcodegen not found. Install: brew install xcodegen');
    }
  }

  // Build iOS runner
  const runnerDir = path.resolve(__dirname_enable, '../browse-ios-runner');
  if (fs.existsSync(path.join(runnerDir, 'project.yml'))) {
    // Generate Xcode project if needed
    if (!fs.existsSync(path.join(runnerDir, 'BrowseRunner.xcodeproj', 'project.pbxproj'))) {
      log('Generating Xcode project...');
      execSync('xcodegen generate --spec project.yml', { cwd: runnerDir, stdio: 'pipe' });
    }

    // Resolve a simulator for the build
    const { resolveSimulator } = await import('./app/ios/controller');
    let udid: string;
    try {
      const sim = await resolveSimulator();
      udid = sim.udid;
    } catch {
      log('No iOS Simulator found. Skipping pre-build (will build on first sim start).');
      log('iOS enabled (source ready).');
      return;
    }

    log('Building iOS runner...');
    execSync(
      `xcodebuild build-for-testing -project BrowseRunner.xcodeproj -scheme BrowseRunnerApp -sdk iphonesimulator -destination "id=${udid}" -derivedDataPath .build CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO -quiet`,
      { cwd: runnerDir, stdio: 'pipe', timeout: 120_000 },
    );
    log('iOS runner built.');
  }

  log('iOS enabled.');
}

// ─── macOS ──────────────────────────────────────────────────────

async function enableMacOS(): Promise<void> {
  log('Enabling macOS...');

  if (process.platform !== 'darwin') {
    throw new Error('macOS app automation requires macOS.');
  }

  // Build browse-ax
  const axDir = path.resolve(__dirname_enable, '../browse-ax');
  const axBin = path.join(axDir, '.build/release/browse-ax');

  if (fs.existsSync(path.join(axDir, 'Package.swift'))) {
    if (fs.existsSync(axBin)) {
      log('browse-ax: already built');
    } else {
      log('Building browse-ax...');
      execSync('swift build -c release', { cwd: axDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      log('browse-ax built.');
    }
  } else {
    throw new Error('browse-ax source not found.');
  }

  log('macOS enabled.');
}

// ─── Entry point ────────────────────────────────────────────────

export async function handleEnable(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase();

  if (!platform || platform === '--help') {
    console.log('Usage: browse enable android|ios|macos|all');
    console.log('');
    console.log('Downloads dependencies and builds native drivers for each platform.');
    console.log('Run once — everything is cached for future use.');
    return;
  }

  const platforms = platform === 'all' ? ['android', 'ios', 'macos'] : [platform];

  for (const p of platforms) {
    try {
      switch (p) {
        case 'android': await enableAndroid(); break;
        case 'ios': await enableIOS(); break;
        case 'macos': await enableMacOS(); break;
        default:
          console.error(`Unknown platform: '${p}'. Use android, ios, macos, or all.`);
          process.exit(1);
      }
    } catch (err: any) {
      console.error(`[browse] ${p} enable failed: ${err.message}`);
      process.exit(1);
    }
    console.log('');
  }
}
