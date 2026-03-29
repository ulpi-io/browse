/**
 * Platform enablement — verifies pre-built native drivers, builds from source if missing.
 *
 * `browse enable android|ios|macos|all`
 *
 * Pre-built binaries ship in bin/ with the npm package. If they're missing
 * (e.g. building from source), this command installs deps and builds them.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_enable = path.dirname(fileURLToPath(import.meta.url));

type Log = (msg: string) => void;
const log: Log = (msg) => process.stderr.write(`[browse] ${msg}\n`);

/** Check multiple candidate paths, return first that exists */
function findPath(candidates: string[]): string | null {
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ─── Android ────────────────────────────────────────────────────

async function enableAndroid(): Promise<void> {
  log('Enabling Android...');

  // Check if APK already ships pre-built
  const prebuiltApk = findPath([
    path.resolve(__dirname_enable, '../bin/browse-android.apk'),
    path.resolve(__dirname_enable, '../../bin/browse-android.apk'),
    path.resolve(__dirname_enable, 'browse-android.apk'),
  ]);
  if (prebuiltApk) {
    log(`Driver APK: ${prebuiltApk}`);
    log('Android ready (pre-built).');
    return;
  }

  // Not pre-built — need to build from source
  log('Pre-built APK not found, building from source...');

  const { ensureJavaHome, findSdkRoot, installSdk, createAvd } = await import('./app/android/emulator');
  const { installAdb } = await import('./app/android/bridge');

  // adb
  try {
    execSync('adb version', { stdio: 'ignore', timeout: 5_000 });
    log('adb: available');
  } catch {
    log('Installing adb...');
    await installAdb(log);
  }

  // Java
  ensureJavaHome();
  const hasJava = () => { try { execSync('java -version', { stdio: 'ignore', timeout: 5_000 }); return true; } catch { return false; } };
  if (!hasJava() && process.platform === 'darwin') {
    log('Installing Java (JDK 21)...');
    try { execSync('brew install openjdk@21', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }); } catch {}
    ensureJavaHome();
  }
  if (!hasJava()) throw new Error('Java not found. Install: brew install openjdk@21');
  log('Java: available');

  // SDK
  let sdkRoot = findSdkRoot();
  if (!sdkRoot) sdkRoot = await installSdk(log);
  if (!sdkRoot) throw new Error('Android SDK not found.');
  log(`SDK: ${sdkRoot}`);

  // SDK components
  const sdkMgr = findPath([
    path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'),
    path.join(sdkRoot, 'bin/sdkmanager'),
  ]);
  if (sdkMgr) {
    try { execSync(`yes | "${sdkMgr}" --licenses`, { stdio: 'ignore', timeout: 60_000, shell: '/bin/bash' }); } catch {}
    for (const comp of ['emulator', 'platform-tools', 'platforms;android-35', 'build-tools;35.0.0', 'system-images;android-35;google_apis;arm64-v8a']) {
      try { execSync(`"${sdkMgr}" --install "${comp}"`, { stdio: 'ignore', timeout: 300_000 }); } catch {}
    }
    log('SDK components: installed');
  }

  // AVD
  const avdMgr = findPath([
    path.join(sdkRoot, 'cmdline-tools/latest/bin/avdmanager'),
    path.join(sdkRoot, 'bin/avdmanager'),
  ]);
  if (avdMgr) {
    try {
      const avds = execSync(`"${avdMgr}" list avd -c`, { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!avds.includes('browse_default')) {
        createAvd(sdkRoot, avdMgr, log);
      } else {
        log('AVD: browse_default exists');
      }
    } catch {}
  }

  // Build APK
  const driverDir = findPath([
    path.resolve(__dirname_enable, '../browse-android'),
    path.resolve(__dirname_enable, '../../browse-android'),
  ].filter(d => fs.existsSync(path.join(d, 'gradlew'))));

  if (driverDir) {
    if (!process.env.ANDROID_HOME) process.env.ANDROID_HOME = sdkRoot;
    log('Building Android driver APK...');
    try {
      execSync('./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon', {
        cwd: driverDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
      });
      log('APK built.');
    } catch (err: any) {
      log(`APK build failed: ${err.message?.split('\n')[0]}`);
    }
  }

  log('Android enabled.');
}

// ─── iOS ────────────────────────────────────────────────────────

async function enableIOS(): Promise<void> {
  log('Enabling iOS...');

  if (process.platform !== 'darwin') throw new Error('iOS requires macOS with Xcode.');

  // Check Xcode
  try {
    execSync('xcodebuild -version', { stdio: 'pipe', timeout: 10_000 });
    log('Xcode: available');
  } catch {
    throw new Error('Xcode not found. Install from the App Store.');
  }

  // xcodegen
  try {
    execSync('which xcodegen', { stdio: 'pipe', timeout: 5_000 });
  } catch {
    log('Installing xcodegen...');
    try { execSync('brew install xcodegen', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); } catch {
      throw new Error('xcodegen not found. Install: brew install xcodegen');
    }
  }
  log('xcodegen: available');

  // Find runner source
  const runnerDir = findPath([
    path.resolve(__dirname_enable, '../browse-ios-runner'),
    path.resolve(__dirname_enable, '../../browse-ios-runner'),
    path.resolve(__dirname_enable, '../bin/browse-ios-runner'),
  ].filter(d => fs.existsSync(path.join(d, 'project.yml'))));

  if (!runnerDir) {
    throw new Error('iOS runner source not found. Reinstall: npm install -g @ulpi/browse');
  }

  // Generate Xcode project if needed
  if (!fs.existsSync(path.join(runnerDir, 'BrowseRunner.xcodeproj', 'project.pbxproj'))) {
    log('Generating Xcode project...');
    execSync('xcodegen generate --spec project.yml', { cwd: runnerDir, stdio: 'pipe' });
  }

  // Pre-build
  const { resolveSimulator } = await import('./app/ios/controller');
  try {
    const sim = await resolveSimulator();
    log('Building iOS runner...');
    execSync(
      `xcodebuild build-for-testing -project BrowseRunner.xcodeproj -scheme BrowseRunnerApp -sdk iphonesimulator -destination "id=${sim.udid}" -derivedDataPath .build CODE_SIGN_IDENTITY="" CODE_SIGNING_ALLOWED=NO -quiet`,
      { cwd: runnerDir, stdio: 'pipe', timeout: 120_000 },
    );
    log('iOS runner built.');
  } catch {
    log('No simulator found. Runner will build on first sim start.');
  }

  log('iOS enabled.');
}

// ─── macOS ──────────────────────────────────────────────────────

async function enableMacOS(): Promise<void> {
  log('Enabling macOS...');

  if (process.platform !== 'darwin') throw new Error('macOS app automation requires macOS.');

  // Check if browse-ax already available (pre-built in bin/)
  const { resolveBridgePath } = await import('./app/macos/bridge');
  try {
    const existing = resolveBridgePath();
    log(`browse-ax: ${existing}`);
    log('macOS enabled.');
    return;
  } catch {}

  // Build from source
  const axDir = findPath([
    path.resolve(__dirname_enable, '../browse-ax'),
    path.resolve(__dirname_enable, '../../browse-ax'),
  ].filter(d => fs.existsSync(path.join(d, 'Package.swift'))));

  if (axDir) {
    log('Building browse-ax...');
    execSync('swift build -c release', { cwd: axDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    log('browse-ax built.');
  } else {
    throw new Error('browse-ax not found. Reinstall: npm install -g @ulpi/browse');
  }

  log('macOS enabled.');
}

// ─── Entry point ────────────────────────────────────────────────

export async function handleEnable(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase();

  if (!platform || platform === '--help') {
    console.log('Usage: browse enable android|ios|macos|all');
    console.log('');
    console.log('Verifies native drivers are ready. Pre-built binaries ship with npm install.');
    console.log('If missing (building from source), installs dependencies and builds them.');
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
