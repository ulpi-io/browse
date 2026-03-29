/**
 * iOS Simulator lifecycle controller — boot, install, launch, permissions.
 *
 * Wraps `xcrun simctl` for simulator management. This module handles the
 * simulator side of things (boot, app lifecycle) while the bridge handles
 * communication with the in-simulator runner via HTTP.
 *
 * Separation of concerns:
 *   controller.ts — simulator lifecycle (boot, install, launch, permissions)
 *   bridge.ts     — HTTP communication with the runner app
 *   manager.ts    — AppManager integration (commands, refs, snapshot)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────

export interface SimulatorInfo {
  /** Simulator UDID */
  udid: string;
  /** Simulator name (e.g. "iPhone 16 Pro") */
  name: string;
  /** Current state: "Shutdown", "Booted", etc. */
  state: string;
  /** iOS runtime version (e.g. "com.apple.CoreSimulator.SimRuntime.iOS-18-0") */
  runtime: string;
  /** Whether this simulator is available */
  isAvailable: boolean;
}

export interface SimulatorDeviceList {
  [runtime: string]: Array<{
    udid: string;
    name: string;
    state: string;
    isAvailable: boolean;
  }>;
}

// ─── Utility ────────────────────────────────────────────────────

/**
 * Run an xcrun simctl command and return stdout.
 * Throws with a helpful message on failure.
 */
async function simctl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', ...args], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB for device list JSON
    });
    return stdout.trim();
  } catch (err: any) {
    const stderr = err.stderr?.trim() || '';
    const message = stderr || err.message || 'Unknown simctl error';
    throw new Error(`simctl ${args[0]} failed: ${message}`);
  }
}

// ─── Simulator Discovery ────────────────────────────────────────

/**
 * List all available iOS simulators.
 * Optionally filter by name or runtime substring.
 */
export async function listSimulators(filter?: string): Promise<SimulatorInfo[]> {
  const raw = await simctl('list', 'devices', '--json');
  const parsed = JSON.parse(raw) as { devices: SimulatorDeviceList };
  const results: SimulatorInfo[] = [];

  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    for (const device of devices) {
      if (!device.isAvailable) continue;
      const info: SimulatorInfo = {
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtime,
        isAvailable: device.isAvailable,
      };
      if (!filter || info.name.toLowerCase().includes(filter.toLowerCase()) ||
          info.runtime.toLowerCase().includes(filter.toLowerCase())) {
        results.push(info);
      }
    }
  }

  return results;
}

/**
 * Find a booted simulator, or the first available one.
 * If udid is provided, returns that specific simulator.
 */
export async function resolveSimulator(identifier?: string): Promise<SimulatorInfo> {
  const all = await listSimulators();

  if (identifier) {
    // Try UDID first, then name match
    const byUdid = all.find(s => s.udid === identifier);
    if (byUdid) return byUdid;
    const byName = all.filter(s => s.name === identifier && s.isAvailable);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      // Prefer booted, then first
      const booted = byName.find(s => s.state === 'Booted');
      if (booted) return booted;
      return byName[0];
    }
    // Fuzzy: contains match
    const fuzzy = all.filter(s => s.name.includes(identifier) && s.isAvailable);
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) return fuzzy.find(s => s.state === 'Booted') || fuzzy[0];
    throw new Error(`Simulator '${identifier}' not found. Run: xcrun simctl list devices available`);
  }

  // Prefer a booted simulator
  const booted = all.find(s => s.state === 'Booted');
  if (booted) return booted;

  // Fall back to the first available
  if (all.length === 0) {
    throw new Error(
      'No iOS Simulators available. Create one with:\n' +
      '  xcrun simctl create "iPhone 16 Pro" "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"',
    );
  }

  return all[0];
}

// ─── Simulator Lifecycle ────────────────────────────────────────

/**
 * Boot a simulator if not already booted.
 * No-op if the simulator is already in "Booted" state.
 */
export async function bootSimulator(udid: string): Promise<void> {
  const sims = await listSimulators();
  const sim = sims.find(s => s.udid === udid);
  if (sim?.state === 'Booted') return; // Already booted

  await simctl('boot', udid);

  // Wait for the simulator to finish booting (up to 30s)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await listSimulators();
    const updated = current.find(s => s.udid === udid);
    if (updated?.state === 'Booted') return;
    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error(`Simulator ${udid} did not boot within 30 seconds`);
}

/**
 * Shutdown a simulator.
 */
export async function shutdownSimulator(udid: string): Promise<void> {
  await simctl('shutdown', udid);
}

// ─── App Lifecycle ──────────────────────────────────────────────

/**
 * Install an app bundle into the simulator.
 * @param udid - Simulator UDID
 * @param appPath - Path to the .app bundle
 */
export async function installApp(udid: string, appPath: string): Promise<void> {
  await simctl('install', udid, appPath);
}

/**
 * Uninstall an app from the simulator.
 * @param udid - Simulator UDID
 * @param bundleId - App bundle identifier
 */
export async function uninstallApp(udid: string, bundleId: string): Promise<void> {
  await simctl('uninstall', udid, bundleId);
}

/**
 * Launch an app in the simulator.
 * @param udid - Simulator UDID
 * @param bundleId - App bundle identifier
 * @param env - Optional environment variables to set
 */
export async function launchApp(
  udid: string,
  bundleId: string,
  env?: Record<string, string>,
): Promise<void> {
  const args: string[] = ['launch', udid, bundleId];

  // Set environment variables via simctl launch --environment
  if (env && Object.keys(env).length > 0) {
    for (const [key, value] of Object.entries(env)) {
      args.push(`SIMCTL_CHILD_${key}=${value}`);
    }
  }

  await simctl(...args);
}

/**
 * Terminate a running app in the simulator.
 */
export async function terminateApp(udid: string, bundleId: string): Promise<void> {
  try {
    await simctl('terminate', udid, bundleId);
  } catch {
    // App may not be running — that's fine
  }
}

/**
 * Check if an app is installed in the simulator.
 */
export async function isAppInstalled(udid: string, bundleId: string): Promise<boolean> {
  try {
    await simctl('get_app_container', udid, bundleId);
    return true;
  } catch {
    return false;
  }
}

// ─── Permissions ────────────────────────────────────────────────

/** Supported permission types for simctl privacy. */
export type SimulatorPermission =
  | 'all'
  | 'calendar'
  | 'contacts-limited'
  | 'contacts'
  | 'location'
  | 'location-always'
  | 'photos-add'
  | 'photos'
  | 'media-library'
  | 'microphone'
  | 'motion'
  | 'reminders'
  | 'siri';

/**
 * Grant a permission to an app in the simulator.
 * Uses `xcrun simctl privacy <udid> grant <permission> <bundleId>`.
 */
export async function grantPermission(
  udid: string,
  bundleId: string,
  permission: SimulatorPermission,
): Promise<void> {
  await simctl('privacy', udid, 'grant', permission, bundleId);
}

/**
 * Revoke a permission from an app in the simulator.
 */
export async function revokePermission(
  udid: string,
  bundleId: string,
  permission: SimulatorPermission,
): Promise<void> {
  await simctl('privacy', udid, 'revoke', permission, bundleId);
}

/**
 * Reset all permissions for an app in the simulator.
 */
export async function resetPermissions(udid: string, bundleId: string): Promise<void> {
  await simctl('privacy', udid, 'reset', 'all', bundleId);
}

// ─── Utilities ──────────────────────────────────────────────────

/**
 * Take a screenshot of the simulator screen using simctl.
 * This is the host-side screenshot (captures the entire simulator screen).
 */
export async function screenshotSimulator(udid: string, outputPath: string): Promise<void> {
  await simctl('io', udid, 'screenshot', outputPath);
}

/**
 * Get the data directory for an app in the simulator.
 */
export async function getAppContainer(
  udid: string,
  bundleId: string,
  container: 'app' | 'data' | 'groups' = 'data',
): Promise<string> {
  return simctl('get_app_container', udid, bundleId, container);
}

/**
 * Open a URL in the simulator (for deep links).
 */
export async function openURL(udid: string, url: string): Promise<void> {
  await simctl('openurl', udid, url);
}

/**
 * Add media files (photos, videos) to the simulator.
 */
export async function addMedia(udid: string, ...paths: string[]): Promise<void> {
  await simctl('addmedia', udid, ...paths);
}

/**
 * Set the simulator status bar overrides (for clean screenshots).
 */
export async function setStatusBar(
  udid: string,
  overrides: {
    time?: string;
    batteryLevel?: number;
    batteryState?: 'charging' | 'charged' | 'discharging';
    cellularBars?: number;
    wifiBars?: number;
    operatorName?: string;
  },
): Promise<void> {
  const args: string[] = ['status_bar', udid, 'override'];

  if (overrides.time) args.push('--time', overrides.time);
  if (overrides.batteryLevel !== undefined) args.push('--batteryLevel', String(overrides.batteryLevel));
  if (overrides.batteryState) args.push('--batteryState', overrides.batteryState);
  if (overrides.cellularBars !== undefined) args.push('--cellularBars', String(overrides.cellularBars));
  if (overrides.wifiBars !== undefined) args.push('--wifiBars', String(overrides.wifiBars));
  if (overrides.operatorName) args.push('--operatorName', overrides.operatorName);

  await simctl(...args);
}

/**
 * Clear status bar overrides.
 */
export async function clearStatusBar(udid: string): Promise<void> {
  await simctl('status_bar', udid, 'clear');
}

/**
 * Check that Xcode CLI tools are installed and simctl is available.
 * Throws with a helpful message if not.
 */
export async function checkXcodeTools(): Promise<void> {
  try {
    await execFileAsync('xcrun', ['--version'], { timeout: 5_000 });
  } catch {
    throw new Error(
      'Xcode Command Line Tools not found.\n' +
      'Install with: xcode-select --install\n' +
      'Or install Xcode from the Mac App Store.',
    );
  }

  try {
    await execFileAsync('xcrun', ['simctl', 'help'], { timeout: 5_000 });
  } catch {
    throw new Error(
      'simctl not available. Ensure Xcode is installed and selected:\n' +
      '  sudo xcode-select -s /Applications/Xcode.app',
    );
  }
}
