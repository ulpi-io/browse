/**
 * App automation contract types — normalized node/state structures owned by browse.
 *
 * These types define the boundary between browse (host-side Node.js) and
 * platform-specific bridges (macOS AX, future Android/iOS).
 *
 * Design: browse owns ref assignment, snapshot formatting, and command semantics.
 * Bridges provide raw tree data in this normalized format.
 */

/** A single node in the app accessibility/UI tree */
export interface AppNode {
  /** Stable path within the tree (array of child indices) */
  path: number[];
  /** Accessibility role (e.g. "AXButton", "AXTextField", "AXStaticText") */
  role: string;
  /** Primary label/title */
  label: string;
  /** Current value (for text fields, sliders, etc.) */
  value?: string;
  /** Bounding frame in window coordinates */
  frame: { x: number; y: number; width: number; height: number };
  /** Whether the element is enabled for interaction */
  enabled: boolean;
  /** Whether the element has keyboard focus */
  focused: boolean;
  /** Whether the element is selected */
  selected: boolean;
  /** Whether the element accepts text input */
  editable: boolean;
  /** Available actions (e.g. ["AXPress", "AXShowMenu"]) */
  actions: string[];
  /** Child nodes */
  children: AppNode[];
}

/** Lightweight app state for action-context probes */
export interface AppState {
  /** Title of the target window */
  windowTitle: string;
  /** Path of the currently focused element */
  focusedPath: number[] | null;
  /** Total element count in the tree */
  elementCount: number;
  /** Number of windows for the target app */
  windowCount: number;
  /** App name */
  appName: string;
  /** Optional settled/screen-stable hint */
  settled?: boolean;
}

/** Result of a bridge action */
export interface BridgeResult {
  success: boolean;
  error?: string;
}

/** Raw bridge protocol — what platform bridges must implement */
export interface AppBridgeProtocol {
  /** Get the accessibility tree for the target app/window */
  tree(): Promise<AppNode>;
  /** Perform an action on a node (e.g. AXPress) */
  action(path: number[], actionName: string): Promise<BridgeResult>;
  /** Set value on an editable node */
  setValue(path: number[], value: string): Promise<BridgeResult>;
  /** Type text using the focused element */
  type(text: string): Promise<BridgeResult>;
  /** Press a key using the focused element */
  press(key: string): Promise<BridgeResult>;
  /** Capture screenshot of the target window */
  screenshot(outputPath: string): Promise<BridgeResult>;
  /** Get lightweight state for action-context */
  state(): Promise<AppState>;
}
