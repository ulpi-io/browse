/**
 * iOS bridge — communicates with the browse-ios-runner app via HTTP.
 *
 * The runner is a SwiftUI app installed in the iOS Simulator that:
 *   1. Hosts an HTTP server on a fixed port (BROWSE_RUNNER_PORT, default 9820)
 *   2. Uses XCTest/Accessibility APIs to traverse the UI tree
 *   3. Performs actions (tap, type, swipe) via XCUIElement
 *   4. Returns JSON responses matching the protocol.ts types
 *
 * The bridge on the host side:
 *   - Ensures Xcode CLI tools are available
 *   - Boots the simulator if needed
 *   - Installs and launches the runner app
 *   - Creates an AppBridgeProtocol that translates runner responses
 *     to the normalized AppNode/AppState format used by browse
 *
 * Port forwarding: simctl's networking stack makes localhost ports inside
 * the simulator accessible on the host's localhost (no explicit forwarding needed).
 */

import type { AppNode, AppState, BridgeResult, AppBridgeProtocol } from '../types';
import type { RawIOSNode, IOSState, RunnerResponse } from './protocol';
import { normalizeIOSRole } from './protocol';
import {
  checkXcodeTools,
  resolveSimulator,
  bootSimulator,
  screenshotSimulator,
} from './controller';

/** Default port the runner app listens on inside the simulator. */
const DEFAULT_RUNNER_PORT = 9820;

/** Runner bundle ID — the browse-ios-runner app. */
const RUNNER_BUNDLE_ID = 'io.ulpi.browse-ios-runner';

// ─── Preflight Checks ───────────────────────────────────────────

/**
 * Ensure the iOS bridge prerequisites are met:
 *   1. macOS host (simulators only run on macOS)
 *   2. Xcode CLI tools installed
 *   3. At least one simulator available
 *
 * Returns the resolved simulator UDID.
 */
export async function ensureIOSBridge(udid?: string): Promise<{
  udid: string;
  name: string;
  port: number;
}> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'iOS Simulator automation requires macOS.\n' +
      'For real iOS devices, use a macOS host or Xcode Cloud.',
    );
  }

  await checkXcodeTools();

  const sim = await resolveSimulator(udid);

  // Boot if needed
  if (sim.state !== 'Booted') {
    await bootSimulator(sim.udid);
  }

  const port = parseInt(process.env.BROWSE_RUNNER_PORT || '', 10) || DEFAULT_RUNNER_PORT;

  return { udid: sim.udid, name: sim.name, port };
}

// ─── Runner Management ──────────────────────────────────────────

/**
 * Ensure the runner is available — delegates to the shared sim-service.
 * This is the single entry point for runner lifecycle, whether called from
 * sim start, target factory, or direct bridge usage.
 */
export async function ensureRunnerApp(
  udid: string,
  targetBundleId: string,
  port: number,
): Promise<void> {
  const { checkHealth, startIOS } = await import('./sim-service');

  // If runner is already healthy, just reconfigure the target
  if (await checkHealth(port)) {
    await configureRunnerTarget(port, targetBundleId);
    return;
  }

  // Runner not running — start through the shared service
  await startIOS({ app: targetBundleId });
}

// ─── Tree Conversion ────────────────────────────────────────────

/**
 * Convert a RawIOSNode tree to the normalized AppNode format.
 * Assigns path indices depth-first for tree addressing.
 */
function convertTree(raw: RawIOSNode, parentPath: number[] = [], index = 0): AppNode {
  const currentPath = [...parentPath, index];

  // Determine if the node is editable based on element type
  const editableTypes = new Set(['textField', 'secureTextField', 'textView', 'searchField']);
  const editable = editableTypes.has(raw.elementType);

  // Map iOS actions from traits
  const actions: string[] = [];
  if (raw.traits.includes('button') || raw.elementType === 'button') {
    actions.push('AXPress');
  }
  if (editable) {
    actions.push('AXSetValue');
  }
  if (raw.traits.includes('link')) {
    actions.push('AXPress');
  }

  return {
    path: currentPath,
    role: normalizeIOSRole(raw.elementType),
    label: raw.label || raw.identifier || '',
    value: raw.value || undefined,
    frame: raw.frame,
    enabled: raw.isEnabled,
    focused: raw.hasFocus,
    selected: raw.isSelected,
    editable,
    actions,
    children: raw.children.map((child, i) => convertTree(child, currentPath, i)),
  };
}

/**
 * Convert an IOSState to the normalized AppState format.
 */
function convertState(raw: IOSState, bundleId: string): AppState {
  return {
    windowTitle: raw.screenTitle,
    focusedPath: null, // iOS does not expose a single focused path easily
    elementCount: raw.elementCount,
    windowCount: 1, // iOS apps have a single window
    appName: bundleId,
    settled: !raw.alertPresent, // Treat alert presence as "not settled"
  };
}

// ─── HTTP Client ────────────────────────────────────────────────

/**
 * Send a request to the runner's HTTP server and parse the response.
 */
async function runnerRequest<T>(
  port: number,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const options: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, options);
  } catch (err: any) {
    throw new Error(
      `Failed to connect to browse-ios-runner on port ${port}: ${err.message}\n` +
      'Is the runner app running in the simulator?',
    );
  }

  const json = (await resp.json()) as RunnerResponse<T>;

  if (!json.success) {
    throw new Error(json.error || `Runner error on ${endpoint}`);
  }

  return json.data as T;
}

// ─── Bridge Factory ─────────────────────────────────────────────

/**
 * Create an iOS bridge that implements AppBridgeProtocol.
 *
 * @param udid - Simulator UDID (for screenshot fallback via simctl)
 * @param bundleId - Target app bundle identifier
 * @param port - Runner HTTP port (default 9820)
 */
export function createIOSBridge(
  udid: string,
  bundleId: string,
  port: number = DEFAULT_RUNNER_PORT,
): AppBridgeProtocol {
  return {
    async tree(): Promise<AppNode> {
      const raw = await runnerRequest<RawIOSNode>(port, '/tree');
      return convertTree(raw);
    },

    async action(path: number[], actionName: string): Promise<BridgeResult> {
      return runnerRequest<BridgeResult>(port, '/action', { path, actionName });
    },

    async setValue(path: number[], value: string): Promise<BridgeResult> {
      return runnerRequest<BridgeResult>(port, '/set-value', { path, value });
    },

    async type(text: string): Promise<BridgeResult> {
      return runnerRequest<BridgeResult>(port, '/type', { text });
    },

    async press(key: string): Promise<BridgeResult> {
      return runnerRequest<BridgeResult>(port, '/press', { key });
    },

    async screenshot(outputPath: string): Promise<BridgeResult> {
      // Try runner-side screenshot first (app window only)
      try {
        return await runnerRequest<BridgeResult>(port, '/screenshot', { outputPath });
      } catch {
        // Fallback to simctl screenshot (full simulator screen)
        try {
          await screenshotSimulator(udid, outputPath);
          return { success: true };
        } catch (err: any) {
          return { success: false, error: `Screenshot failed: ${err.message}` };
        }
      }
    },

    async state(): Promise<AppState> {
      const raw = await runnerRequest<IOSState>(port, '/state');
      return convertState(raw, bundleId);
    },
  };
}

/**
 * Reconfigure a running runner's target app at runtime.
 * Used by sim-service when switching targets without restarting the runner.
 */
export async function configureRunnerTarget(port: number, bundleId: string): Promise<void> {
  await runnerRequest<{ configured: string }>(port, '/configure', { targetBundleId: bundleId });
}
