/**
 * Automation target contracts — target-neutral automation abstractions.
 *
 * BrowserManager is the first implementation (TASK-004).
 * Future targets: AppManager (v2.0), FlowTarget (v2.1), plugins (v2.2).
 *
 * Design constraints:
 *   - No imports from browser-manager, session-manager, or Playwright types.
 *   - Keep the core contract minimal — an AppManager for native mobile
 *     must be able to implement AutomationTarget without faking browser APIs.
 *   - Domain-specific behavior lives behind capability interfaces that
 *     implementations opt into and consumers narrow to at runtime.
 */

// ─── Capability Flags ────────────────────────────────────────────

/** Runtime capability query — each flag maps to a capability interface. */
export interface TargetCapabilities {
  /** Navigate to URLs or deep links */
  navigation: boolean;
  /** Multiple tabs or windows */
  tabs: boolean;
  /** @ref selector resolution from accessibility snapshots */
  refs: boolean;
  /** Screenshot and PDF capture */
  screenshots: boolean;
  /** In-context JavaScript evaluation */
  javascript: boolean;
  /** Device profile emulation (viewport, UA, touch) */
  deviceEmulation: boolean;
  /** Sub-frame or sub-container targeting */
  frames: boolean;
}

// ─── Unsupported Capability ──────────────────────────────────────

/**
 * Thrown when a command requires a capability that the current
 * automation target does not support.
 *
 * Command handlers throw this instead of type-casting or branching
 * on concrete manager types. The executor pipeline catches it and
 * returns a clear error to the caller.
 */
export class UnsupportedCapabilityError extends Error {
  readonly capability: keyof TargetCapabilities;
  readonly targetType: string;

  constructor(capability: keyof TargetCapabilities, targetType: string) {
    super(
      `Command requires '${capability}' which '${targetType}' does not support. ` +
      `This command is only available for targets with '${capability}' capability.`,
    );
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
    this.targetType = targetType;
  }
}

// ─── Core Contract ───────────────────────────────────────────────

/**
 * AutomationTarget — the minimal target-neutral automation contract.
 *
 * Every automation backend implements this surface. It covers identity,
 * capability discovery, location, health, and cleanup — nothing more.
 *
 * Browser-specific APIs (page, context, locators) are accessed through
 * capability interfaces that BrowserManager also implements. Consumers
 * check getCapabilities() and narrow via requireCapability() before
 * calling capability-specific methods.
 */
export interface AutomationTarget {
  /** Identifies the target kind (e.g. 'browser', 'app') */
  readonly targetType: string;

  /** Runtime capability query */
  getCapabilities(): TargetCapabilities;

  /** Current location — URL for browser, screen for app, step for flow */
  getCurrentLocation(): string;

  /** Whether the target is connected and operational */
  isReady(): boolean;

  /** Release all resources */
  close(): Promise<void>;
}

// ─── Capability Guards ───────────────────────────────────────────

/**
 * Assert that a target supports a capability.
 * Throws UnsupportedCapabilityError if it does not.
 */
export function requireCapability(
  target: AutomationTarget,
  capability: keyof TargetCapabilities,
): void {
  if (!target.getCapabilities()[capability]) {
    throw new UnsupportedCapabilityError(capability, target.targetType);
  }
}

/**
 * Check whether a target supports a capability (no throw).
 */
export function hasCapability(
  target: AutomationTarget,
  capability: keyof TargetCapabilities,
): boolean {
  return target.getCapabilities()[capability];
}
