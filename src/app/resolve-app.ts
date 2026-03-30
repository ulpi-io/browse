/**
 * App resolution — detects file paths vs identifiers and handles installation.
 *
 * When --app receives a file path (.app, .ipa, .apk), this module:
 *   1. Installs the app into the simulator/emulator
 *   2. Extracts the bundle ID / package name
 *   3. Returns the resolved identifier for the rest of the pipeline
 *
 * When --app receives an identifier (com.example.app), it passes through unchanged.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type Log = (msg: string) => void;

// ─── Detection ──────────────────────────────────────────────────

/**
 * Check if a value looks like a file path to an app bundle.
 * .ipa and .apk are unambiguous. .app only triggers if the path exists on disk
 * (avoids clash with bundle IDs like com.foo.app).
 */
export function isAppFilePath(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.endsWith('.ipa') || lower.endsWith('.apk')) return true;
  if (lower.endsWith('.app') && fs.existsSync(value)) return true;
  return false;
}

// ─── iOS ────────────────────────────────────────────────────────

/**
 * Resolve an iOS --app argument.
 * If it's a file path (.app or .ipa), install it and return the bundle ID.
 * If it's already a bundle ID, return as-is.
 */
export async function resolveIOSApp(
  appArg: string,
  udid: string,
  log: Log,
): Promise<string> {
  if (!isAppFilePath(appArg)) return appArg;

  const absPath = path.resolve(appArg);

  if (appArg.toLowerCase().endsWith('.ipa')) {
    return resolveIPA(absPath, udid, log);
  }

  // .app bundle
  if (!fs.existsSync(absPath)) {
    throw new Error(`App bundle not found: ${absPath}`);
  }

  const bundleId = extractBundleId(absPath);
  log(`Installing ${path.basename(absPath)} (${bundleId})...`);

  const { installApp } = await import('./ios/controller');
  await installApp(udid, absPath);

  return bundleId;
}

/**
 * Extract CFBundleIdentifier from an .app bundle's Info.plist.
 * Uses macOS built-in plutil to convert plist to JSON.
 */
function extractBundleId(appPath: string): string {
  const plistPath = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Info.plist not found in ${appPath}. Is this a valid iOS app bundle?`);
  }

  try {
    const json = execSync(`plutil -convert json -o - "${plistPath}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const parsed = JSON.parse(json);
    const bundleId = parsed.CFBundleIdentifier;
    if (!bundleId) {
      throw new Error(`CFBundleIdentifier not found in ${plistPath}`);
    }
    return bundleId;
  } catch (err: any) {
    if (err.message?.includes('CFBundleIdentifier')) throw err;
    throw new Error(`Failed to read bundle ID from ${plistPath}: ${err.message}`);
  }
}

/**
 * Handle .ipa files — unzip, find the .app, extract bundle ID, install.
 */
async function resolveIPA(ipaPath: string, udid: string, log: Log): Promise<string> {
  if (!fs.existsSync(ipaPath)) {
    throw new Error(`IPA file not found: ${ipaPath}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-ipa-'));

  try {
    // Extract .ipa (it's a zip)
    execSync(`unzip -o -q "${ipaPath}" -d "${tmpDir}"`, { timeout: 30000 });

    // Find the .app inside Payload/
    const payloadDir = path.join(tmpDir, 'Payload');
    if (!fs.existsSync(payloadDir)) {
      throw new Error(`No Payload directory in ${ipaPath}. Is this a valid .ipa file?`);
    }

    const appDirs = fs.readdirSync(payloadDir).filter(f => f.endsWith('.app'));
    if (appDirs.length === 0) {
      throw new Error(`No .app bundle found in ${ipaPath}/Payload/`);
    }

    const appPath = path.join(payloadDir, appDirs[0]);
    const bundleId = extractBundleId(appPath);

    log(`Installing ${appDirs[0]} (${bundleId}) from IPA...`);
    const { installApp } = await import('./ios/controller');
    await installApp(udid, appPath);

    return bundleId;
  } finally {
    // Cleanup temp directory
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Android ────────────────────────────────────────────────────

/**
 * Resolve an Android --app argument.
 * If it's a file path (.apk), install it and return the package name.
 * If it's already a package name, return as-is.
 */
export async function resolveAndroidApp(
  appArg: string,
  serial: string,
  log: Log,
): Promise<string> {
  if (!isAppFilePath(appArg)) return appArg;

  const absPath = path.resolve(appArg);
  if (!fs.existsSync(absPath)) {
    throw new Error(`APK file not found: ${absPath}`);
  }

  // Extract package name from APK
  const packageName = extractPackageName(absPath);
  log(`Installing ${path.basename(absPath)} (${packageName})...`);

  // Install
  try {
    execSync(`adb -s ${serial} install -r -t "${absPath}"`, {
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch (err: any) {
    throw new Error(`Failed to install APK: ${err.message?.split('\n')[0]}`);
  }

  return packageName;
}

/**
 * Extract package name from an APK file.
 * Tries aapt2 (preferred), then aapt (v1), from Android SDK build-tools.
 */
function extractPackageName(apkPath: string): string {
  // Try aapt2 / aapt from SDK build-tools
  const aaptBins = findAaptBinaries();

  for (const aapt of aaptBins) {
    try {
      const output = execSync(`"${aapt}" dump badging "${apkPath}"`, {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const match = output.match(/package:\s*name='([^']+)'/);
      if (match) return match[1];
    } catch {
      continue;
    }
  }

  throw new Error(
    `Cannot determine package name from ${path.basename(apkPath)}.\n` +
    'Install Android build-tools (browse enable android) or provide the package name directly:\n' +
    '  browse sim start --platform android --app com.example.myapp',
  );
}

/**
 * Find aapt2 / aapt binaries in the Android SDK build-tools.
 */
function findAaptBinaries(): string[] {
  const bins: string[] = [];

  // Check PATH first
  try {
    execSync('which aapt2', { stdio: 'pipe', timeout: 3000 });
    bins.push('aapt2');
  } catch {}
  try {
    execSync('which aapt', { stdio: 'pipe', timeout: 3000 });
    bins.push('aapt');
  } catch {}

  // Check SDK build-tools directories
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library/Android/sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    path.join(os.homedir(), 'Android/Sdk'),
  ].filter(Boolean) as string[];

  for (const sdk of sdkRoots) {
    const btDir = path.join(sdk, 'build-tools');
    if (!fs.existsSync(btDir)) continue;

    // Get the latest build-tools version
    const versions = fs.readdirSync(btDir).sort().reverse();
    for (const ver of versions) {
      const aapt2 = path.join(btDir, ver, 'aapt2');
      const aapt = path.join(btDir, ver, 'aapt');
      if (fs.existsSync(aapt2)) bins.push(aapt2);
      if (fs.existsSync(aapt)) bins.push(aapt);
      break; // only need the latest version
    }
  }

  return bins;
}
