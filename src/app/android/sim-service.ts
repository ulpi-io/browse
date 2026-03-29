/**
 * Android device/emulator lifecycle service — shared between CLI and command layer.
 *
 * Mirrors the iOS sim-service pattern: state persistence, health checking,
 * start/stop lifecycle, and target app management.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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
      return existing;
    }
    log('Cleaning up stale driver...');
    await stop();
  }

  // Find device
  log('Finding Android device...');
  const { ensureAndroidBridge, createAndroidBridge } = await import('./bridge');
  const serial = await ensureAndroidBridge(opts.device);

  // Get device name
  let deviceName = serial;
  try {
    deviceName = execSync(`adb -s ${serial} shell getprop ro.product.model`, {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || serial;
  } catch {}

  const targetApp = opts.app || 'com.android.settings';
  log(`Starting driver for ${targetApp}...`);
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
