/**
 * Android driver RPC protocol — matches the on-device instrumentation service.
 *
 * The driver is an Android instrumentation test that exposes a JSON-over-HTTP
 * API on port 7779 (device-side, forwarded via `adb forward`).
 *
 * Design: browse owns all semantics above this layer. The driver just exposes
 * raw AccessibilityNodeInfo trees and performs UiAutomator actions.
 */

// ─── Raw node (driver-side serialisation) ────────────────────────

/**
 * A single accessibility node as serialised by the on-device driver.
 * Mirrors android.view.accessibility.AccessibilityNodeInfo fields.
 */
export interface RawAndroidNode {
  /** Child-index path from root — stable within a single tree snapshot */
  path: number[];
  /** View class name (e.g. "android.widget.Button", "android.widget.EditText") */
  className: string;
  /** Content description or text content */
  text: string | null;
  /** Hint text for editable fields */
  hint: string | null;
  /** Resource ID (e.g. "com.example.app:id/submit_button") */
  resourceId: string | null;
  /** Bounding rectangle in screen coordinates */
  bounds: { left: number; top: number; right: number; bottom: number };
  /** Whether the node is clickable */
  clickable: boolean;
  /** Whether the node is long-clickable */
  longClickable: boolean;
  /** Whether the node is enabled */
  enabled: boolean;
  /** Whether the node is focused */
  focused: boolean;
  /** Whether the node is selected */
  selected: boolean;
  /** Whether the node is checked (for checkboxes/radio buttons/toggles) */
  checked: boolean;
  /** Whether the node is checkable */
  checkable: boolean;
  /** Whether the node accepts text input */
  editable: boolean;
  /** Whether the node is scrollable */
  scrollable: boolean;
  /** Whether the node is visible on screen */
  visibleToUser: boolean;
  /** Child nodes */
  children: RawAndroidNode[];
}

// ─── Lightweight state ───────────────────────────────────────────

/**
 * Lightweight Android app state for action-context probes.
 * Returned by the /state endpoint — fast, no full tree traversal.
 */
export interface AndroidState {
  /** Package name of the foreground app */
  packageName: string;
  /** Activity class name currently in the foreground */
  activityName: string;
  /** Content description or title of the focused window */
  windowTitle: string | null;
  /** Total node count in the accessibility tree */
  nodeCount: number;
  /** Whether the screen is on and interactive */
  interactive: boolean;
}

// ─── Driver RPC protocol ─────────────────────────────────────────

/**
 * Android driver RPC protocol — matches the on-device instrumentation service.
 *
 * Implemented by `AndroidBridge` in `bridge.ts`. Each method maps to one
 * HTTP call to the on-device driver (via `adb forward` + localhost).
 */
export interface AndroidDriverProtocol {
  /**
   * Retrieve the full accessibility tree for the target package.
   * The driver scopes the tree to windows owned by `targetPackage`.
   */
  tree(): Promise<RawAndroidNode>;

  /**
   * Perform an accessibility action on a node identified by its path.
   * Supported actions: "click", "longClick", "focus", "clearFocus",
   * "select", "clearSelection", "scrollForward", "scrollBackward",
   * "expand", "collapse".
   */
  action(path: number[], actionName: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Set the text value of an editable node (EditText).
   * Uses AccessibilityNodeInfo.ACTION_SET_TEXT.
   */
  setValue(path: number[], value: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Type text into the currently focused element via UiAutomator keyboard injection.
   * Equivalent to UiDevice.getInstance().typeText(text).
   */
  type(text: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Press a named key via UiDevice.pressKeyCode().
   * Supported keys: ENTER, RETURN, BACK, HOME, DPAD_UP, DPAD_DOWN, DPAD_LEFT,
   * DPAD_RIGHT, TAB, SPACE, DEL, BACKSPACE, FORWARD_DEL, DELETE, ESCAPE, ESC,
   * MENU, SEARCH, VOLUME_UP, VOLUME_DOWN, CAMERA, POWER.
   */
  press(key: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Capture a screenshot and save it to `outputPath` on the host filesystem.
   * The driver saves a PNG to a temp file on-device, then the bridge pulls it
   * via `adb pull` to `outputPath`.
   */
  screenshot(outputPath: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Return lightweight app state for action-context probes.
   * Fast path — no full tree traversal.
   */
  state(): Promise<AndroidState>;
}

// ─── Wire types ──────────────────────────────────────────────────

/** Body sent to POST /action */
export interface ActionRequest {
  path: number[];
  action: string;
}

/** Body sent to POST /setValue */
export interface SetValueRequest {
  path: number[];
  value: string;
}

/** Body sent to POST /type */
export interface TypeRequest {
  text: string;
}

/** Body sent to POST /press */
export interface PressRequest {
  key: string;
}

/** Body sent to POST /screenshot */
export interface ScreenshotRequest {
  /** On-device temp path — bridge pulls this file via adb pull */
  outputPath: string;
}

/** Generic driver response for action/setValue/type/press/screenshot */
export interface DriverResult {
  success: boolean;
  error?: string;
}
