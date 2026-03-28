/**
 * App automation manager — implements AutomationTarget for native app targets.
 *
 * Spawns a platform bridge (macOS AX, future Android/iOS), normalizes the tree,
 * assigns refs host-side, and provides the same command surface as BrowserManager.
 */

import type { AutomationTarget, TargetCapabilities } from '../automation/target';
import type { AppBridgeProtocol, AppNode, AppState } from './types';
import { assignRefs, extractText, type AppRef } from './normalize';

export class AppManager implements AutomationTarget {
  readonly targetType = 'app';
  private bridge: AppBridgeProtocol;
  private refMap = new Map<string, AppRef>();
  private lastSnapshot: string | null = null;
  private lastTree: AppNode | null = null;
  private appName: string;

  constructor(bridge: AppBridgeProtocol, appName: string) {
    this.bridge = bridge;
    this.appName = appName;
  }

  getCapabilities(): TargetCapabilities {
    return {
      navigation: false,
      tabs: false,
      refs: true,
      screenshots: true,
      javascript: false,
      deviceEmulation: false,
      frames: false,
    };
  }

  getCurrentLocation(): string {
    return `app://${this.appName}`;
  }

  isReady(): boolean {
    return true; // Bridge is stateless — always ready if process exists
  }

  async close(): Promise<void> {
    // Bridge is process-based — nothing to close
    this.refMap.clear();
    this.lastSnapshot = null;
    this.lastTree = null;
  }

  // ─── App-specific methods ──────────────────────────────

  /** Get the app tree and assign refs */
  async snapshot(interactive = false): Promise<string> {
    this.lastTree = await this.bridge.tree();
    const { refMap, text } = assignRefs(this.lastTree, interactive);
    this.refMap = refMap;
    this.lastSnapshot = text;
    return text;
  }

  /** Extract visible text from the app */
  async text(): Promise<string> {
    const tree = await this.bridge.tree();
    return extractText(tree);
  }

  /** Resolve a @ref to a node path */
  resolveRef(ref: string): { path: number[]; role: string; label: string } {
    const entry = this.refMap.get(ref);
    if (!entry) {
      throw new Error(`Ref ${ref} not found. Run 'snapshot' to refresh.`);
    }
    return entry;
  }

  /** Tap (press) an element by ref */
  async tap(ref: string): Promise<string> {
    const { path, label } = this.resolveRef(ref);
    const result = await this.bridge.action(path, 'AXPress');
    if (!result.success) throw new Error(result.error || 'Tap failed');
    return `Tapped ${ref}${label ? ` "${label}"` : ''}`;
  }

  /** Fill a text field by ref */
  async fill(ref: string, value: string): Promise<string> {
    const { path } = this.resolveRef(ref);
    const result = await this.bridge.setValue(path, value);
    if (!result.success) throw new Error(result.error || 'Fill failed');
    return `Filled ${ref} with "${value}"`;
  }

  /** Type text using the focused element */
  async typeText(text: string): Promise<string> {
    const result = await this.bridge.type(text);
    if (!result.success) throw new Error(result.error || 'Type failed');
    return `Typed "${text}"`;
  }

  /** Press a key */
  async pressKey(key: string): Promise<string> {
    const result = await this.bridge.press(key);
    if (!result.success) throw new Error(result.error || 'Press failed');
    return `Pressed ${key}`;
  }

  /** Take a screenshot */
  async screenshot(outputPath: string): Promise<string> {
    const result = await this.bridge.screenshot(outputPath);
    if (!result.success) throw new Error(result.error || 'Screenshot failed');
    return `Screenshot saved: ${outputPath}`;
  }

  /** Get lightweight state for action-context */
  async getState(): Promise<AppState> {
    return this.bridge.state();
  }

  /** Get the last snapshot text */
  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  /** Get the app name */
  getAppName(): string {
    return this.appName;
  }
}
