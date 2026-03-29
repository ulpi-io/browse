/**
 * iOS app manager — extends the shared AppManager with iOS-specific lifecycle.
 *
 * Provides the same command surface as macOS/Android managers while wrapping
 * iOS Simulator lifecycle (boot, install, launch) and runner communication.
 *
 * The AppManager base class handles:
 *   - Ref assignment via assignRefs()
 *   - Text extraction via extractText()
 *   - Snapshot formatting
 *   - Action dispatch through AppBridgeProtocol
 *
 * This manager adds:
 *   - Simulator boot + runner launch on connect()
 *   - Deep link navigation via simctl openurl
 *   - Permission management
 *   - Clean teardown (terminate runner, optionally shutdown simulator)
 */

import type { AppBridgeProtocol, AppState } from '../types';
import type { AutomationTarget, TargetCapabilities } from '../../automation/target';
import { assignRefs, extractText, type AppRef } from '../normalize';
import { ensureIOSBridge, ensureRunnerApp, createIOSBridge } from './bridge';
import {
  terminateApp,
  openURL as simctlOpenURL,
  grantPermission,
  revokePermission,
  type SimulatorPermission,
} from './controller';

/** Runner bundle ID — must match the Xcode project. */
const RUNNER_BUNDLE_ID = 'io.ulpi.browse-ios-runner';

export class IOSAppManager implements AutomationTarget {
  readonly targetType = 'app';
  private bridge: AppBridgeProtocol | null = null;
  private refMap = new Map<string, AppRef>();
  private lastSnapshot: string | null = null;
  private udid: string;
  private bundleId: string;
  private port: number;
  private connected = false;

  constructor(udid: string, bundleId: string, port: number) {
    this.udid = udid;
    this.bundleId = bundleId;
    this.port = port;
  }

  // ─── AutomationTarget contract ────────────────────────────────

  getCapabilities(): TargetCapabilities {
    return {
      navigation: true, // Deep links via simctl openurl
      tabs: false,
      refs: true,
      screenshots: true,
      javascript: false,
      deviceEmulation: false,
      frames: false,
    };
  }

  getCurrentLocation(): string {
    return `app://${this.bundleId}`;
  }

  isReady(): boolean {
    return this.connected && this.bridge !== null;
  }

  async close(): Promise<void> {
    // Terminate the runner app (not the target app — that's the user's choice)
    try {
      await terminateApp(this.udid, RUNNER_BUNDLE_ID);
    } catch {
      // Runner may already be terminated
    }
    this.bridge = null;
    this.connected = false;
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Connect to the iOS Simulator and start the runner.
   * Call this before any bridge operations.
   */
  async connect(): Promise<void> {
    // Ensure simulator is booted
    await ensureIOSBridge(this.udid);

    // Ensure runner is installed and launched
    await ensureRunnerApp(this.udid, this.bundleId, this.port);

    // Create the bridge
    this.bridge = createIOSBridge(this.udid, this.bundleId, this.port);
    this.connected = true;
  }

  // ─── App-specific methods (same surface as macOS AppManager) ──

  /** Get the app tree and assign refs. */
  async snapshot(interactive = false): Promise<string> {
    this.requireBridge();
    const tree = await this.bridge!.tree();
    const { refMap, text } = assignRefs(tree, interactive);
    this.refMap = refMap;
    this.lastSnapshot = text;
    return text;
  }

  /** Extract visible text from the app. */
  async text(): Promise<string> {
    this.requireBridge();
    const tree = await this.bridge!.tree();
    return extractText(tree);
  }

  /** Resolve a @ref to a node path. */
  resolveRef(ref: string): { path: number[]; role: string; label: string } {
    const entry = this.refMap.get(ref);
    if (!entry) {
      throw new Error(`Ref ${ref} not found. Run 'snapshot' to refresh.`);
    }
    return entry;
  }

  /** Tap (press) an element by ref. */
  async tap(ref: string): Promise<string> {
    this.requireBridge();
    const { path, label } = this.resolveRef(ref);
    const result = await this.bridge!.action(path, 'AXPress');
    if (!result.success) throw new Error(result.error || 'Tap failed');
    return `Tapped ${ref}${label ? ` "${label}"` : ''}`;
  }

  /** Fill a text field by ref. */
  async fill(ref: string, value: string): Promise<string> {
    this.requireBridge();
    const { path } = this.resolveRef(ref);
    const result = await this.bridge!.setValue(path, value);
    if (!result.success) throw new Error(result.error || 'Fill failed');
    return `Filled ${ref} with "${value}"`;
  }

  /** Type text using the focused element. */
  async typeText(text: string): Promise<string> {
    this.requireBridge();
    const result = await this.bridge!.type(text);
    if (!result.success) throw new Error(result.error || 'Type failed');
    return `Typed "${text}"`;
  }

  /** Swipe on an element or screen in a direction. */
  async swipe(direction: string, ref?: string): Promise<string> {
    this.requireBridge();
    const actionName = `swipe${direction.charAt(0).toUpperCase()}${direction.slice(1).toLowerCase()}`;
    if (ref) {
      const { path, label } = this.resolveRef(ref);
      const result = await this.bridge!.action(path, actionName);
      if (!result.success) throw new Error(result.error || `Swipe ${direction} failed`);
      return `Swiped ${direction} on ${ref}${label ? ` "${label}"` : ''}`;
    }
    // No ref — swipe on the root element (whole screen)
    const result = await this.bridge!.action([0], actionName);
    if (!result.success) throw new Error(result.error || `Swipe ${direction} failed`);
    return `Swiped ${direction}`;
  }

  /** Press a key. */
  async pressKey(key: string): Promise<string> {
    this.requireBridge();
    const result = await this.bridge!.press(key);
    if (!result.success) throw new Error(result.error || 'Press failed');
    return `Pressed ${key}`;
  }

  /** Take a screenshot. */
  async screenshot(outputPath: string): Promise<string> {
    this.requireBridge();
    const result = await this.bridge!.screenshot(outputPath);
    if (!result.success) throw new Error(result.error || 'Screenshot failed');
    return `Screenshot saved: ${outputPath}`;
  }

  /** Get lightweight state for action-context. */
  async getState(): Promise<AppState> {
    this.requireBridge();
    return this.bridge!.state();
  }

  /** Get the last snapshot text. */
  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  /** Get the bundle ID. */
  getBundleId(): string {
    return this.bundleId;
  }

  /** Get the simulator UDID. */
  getUDID(): string {
    return this.udid;
  }

  /**
   * Reconfigure this manager to target a different app without restarting the runner.
   * Called by the server when --app changes within the shared iOS session.
   */
  reconfigureTarget(newBundleId: string): void {
    this.bundleId = newBundleId;
    // Recreate the bridge pointing to the new target
    this.bridge = createIOSBridge(this.udid, newBundleId, this.port);
    // Clear stale refs from the old app
    this.refMap.clear();
    this.lastSnapshot = null;
  }

  // ─── iOS-specific methods ─────────────────────────────────────

  /**
   * Open a deep link URL in the simulator.
   * The target app must be registered to handle the URL scheme.
   */
  async openDeepLink(url: string): Promise<string> {
    await simctlOpenURL(this.udid, url);
    return `Opened deep link: ${url}`;
  }

  /**
   * Grant a permission to the target app.
   */
  async grantPermission(permission: SimulatorPermission): Promise<string> {
    await grantPermission(this.udid, this.bundleId, permission);
    return `Granted ${permission} permission to ${this.bundleId}`;
  }

  /**
   * Revoke a permission from the target app.
   */
  async revokePermission(permission: SimulatorPermission): Promise<string> {
    await revokePermission(this.udid, this.bundleId, permission);
    return `Revoked ${permission} permission from ${this.bundleId}`;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private requireBridge(): void {
    if (!this.bridge || !this.connected) {
      throw new Error('iOS bridge not connected. Call connect() first.');
    }
  }
}

/**
 * Factory function to create and connect an IOSAppManager.
 * Handles the full lifecycle: resolve simulator, boot, launch runner, create bridge.
 */
export async function createIOSAppManager(
  bundleId: string,
  udid?: string,
): Promise<IOSAppManager> {
  const bridge = await ensureIOSBridge(udid);
  const manager = new IOSAppManager(bridge.udid, bundleId, bridge.port);
  await manager.connect();
  return manager;
}
