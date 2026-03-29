/**
 * macOS AX bridge — spawns browse-ax CLI and communicates via JSON stdio.
 *
 * The bridge is a thin adapter: it spawns the Swift binary, sends commands,
 * and parses JSON responses. browse owns all semantics above this layer.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { AppNode, AppState, BridgeResult, AppBridgeProtocol } from '../types';

const __filename_bridge = fileURLToPath(import.meta.url);
const __dirname_bridge = path.dirname(__filename_bridge);

/**
 * Resolve the browse-ax binary path.
 * Checks: local build, installed binary, lazy download location.
 */
export function resolveBridgePath(): string {
  // 1. Local dev build
  const localBuild = path.resolve(__dirname_bridge, '../../../browse-ax/.build/release/browse-ax');
  if (fs.existsSync(localBuild)) return localBuild;

  const localDebug = path.resolve(__dirname_bridge, '../../../browse-ax/.build/debug/browse-ax');
  if (fs.existsSync(localDebug)) return localDebug;

  // 2. Installed alongside package
  const installed = path.resolve(__dirname_bridge, '../../bin/browse-ax');
  if (fs.existsSync(installed)) return installed;

  // 3. Lazy download location
  const lazyPath = path.join(
    process.env.BROWSE_LOCAL_DIR || path.join(process.cwd(), '.browse'),
    'bin', 'browse-ax',
  );
  if (fs.existsSync(lazyPath)) return lazyPath;

  throw new Error(
    'browse-ax binary not found. Build it with: cd browse-ax && swift build -c release\n' +
    'Or run: browse doctor --platform macos',
  );
}

/**
 * Ensure the macOS AX bridge binary is available.
 * Returns the path to the binary.
 */
export async function ensureMacOSBridge(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('App automation requires macOS (uses Accessibility API)');
  }
  return resolveBridgePath();
}

/**
 * Execute a browse-ax command and parse JSON output.
 */
async function execBridge(bridgePath: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bridgePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();

      if (code !== 0) {
        try {
          const err = JSON.parse(stderr || stdout);
          reject(new Error(err.error || `Bridge exited with code ${code}`));
        } catch {
          reject(new Error(stderr || `Bridge exited with code ${code}`));
        }
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid bridge output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

/**
 * Create a macOS AX bridge protocol implementation for a given PID.
 */
export function createMacOSBridge(bridgePath: string, pid: number): AppBridgeProtocol {
  const base = ['--pid', String(pid)];

  return {
    async tree(): Promise<AppNode> {
      return execBridge(bridgePath, [...base, 'tree']);
    },
    async action(nodePath: number[], actionName: string): Promise<BridgeResult> {
      return execBridge(bridgePath, [...base, 'action', JSON.stringify(nodePath), actionName]);
    },
    async setValue(nodePath: number[], value: string): Promise<BridgeResult> {
      return execBridge(bridgePath, [...base, 'set-value', JSON.stringify(nodePath), value]);
    },
    async type(text: string): Promise<BridgeResult> {
      return execBridge(bridgePath, [...base, 'type', text]);
    },
    async press(key: string): Promise<BridgeResult> {
      return execBridge(bridgePath, [...base, 'press', key]);
    },
    async screenshot(outputPath: string): Promise<BridgeResult> {
      return execBridge(bridgePath, [...base, 'screenshot', outputPath]);
    },
    async state(): Promise<AppState> {
      return execBridge(bridgePath, [...base, 'state']);
    },
  };
}
