/**
 * iOS runner RPC protocol — TypeScript types matching the Swift runner's JSON API.
 *
 * The browse-ios-runner is a tiny SwiftUI app that runs inside the iOS Simulator,
 * hosts an HTTP server, and exposes the accessibility tree + actions via JSON RPC.
 * This file defines the wire format between the host-side Node.js bridge and the
 * in-simulator runner.
 *
 * Design:
 *   - Runner listens on a fixed port inside the simulator (forwarded via simctl).
 *   - Requests are JSON POST to /<endpoint>.
 *   - Responses are JSON with a consistent { success, data?, error? } envelope.
 *   - The raw tree format maps 1:1 to XCUIElement attributes.
 */

// ─── Raw iOS Tree Nodes ─────────────────────────────────────────

/** A single node in the iOS accessibility tree as returned by the runner. */
export interface RawIOSNode {
  /** XCUIElement.elementType raw value (e.g. "button", "textField", "staticText") */
  elementType: string;
  /** XCUIElement.identifier (accessibilityIdentifier) */
  identifier: string;
  /** XCUIElement.label (accessibilityLabel) */
  label: string;
  /** XCUIElement.value as string (accessibilityValue) */
  value: string;
  /** XCUIElement.placeholderValue */
  placeholderValue: string;
  /** Bounding frame in screen coordinates */
  frame: { x: number; y: number; width: number; height: number };
  /** Whether the element is enabled */
  isEnabled: boolean;
  /** Whether the element is selected */
  isSelected: boolean;
  /** Whether the element has keyboard focus */
  hasFocus: boolean;
  /** Available trait names (e.g. ["button", "staticText", "header"]) */
  traits: string[];
  /** Child elements */
  children: RawIOSNode[];
}

// ─── iOS State ──────────────────────────────────────────────────

/** Lightweight state snapshot from the runner. */
export interface IOSState {
  /** Bundle identifier of the target app under test */
  bundleId: string;
  /** Currently visible view controller title or navigation bar title */
  screenTitle: string;
  /** Total element count in the tree */
  elementCount: number;
  /** Whether an alert/sheet is currently presented */
  alertPresent: boolean;
  /** Whether the keyboard is visible */
  keyboardVisible: boolean;
  /** Device orientation */
  orientation: 'portrait' | 'landscape';
  /** Status bar time string (for screenshot context) */
  statusBarTime: string;
}

// ─── RPC Response Envelope ──────────────────────────────────────

/** Standard JSON response from the runner's HTTP server. */
export interface RunnerResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─── Runner Protocol ────────────────────────────────────────────

/**
 * The RPC contract exposed by the browse-ios-runner HTTP server.
 *
 * Each method maps to a POST endpoint:
 *   tree()          -> POST /tree
 *   action()        -> POST /action     { path, actionName }
 *   setValue()       -> POST /set-value  { path, value }
 *   type()          -> POST /type       { text }
 *   press()         -> POST /press      { key }
 *   screenshot()    -> POST /screenshot { outputPath }
 *   state()         -> POST /state
 */
export interface IOSRunnerProtocol {
  /** Get the full accessibility tree of the target app. */
  tree(): Promise<RawIOSNode>;

  /** Perform an action on a node at the given tree path. */
  action(path: number[], actionName: string): Promise<{ success: boolean; error?: string }>;

  /** Set the value of an editable element at the given tree path. */
  setValue(path: number[], value: string): Promise<{ success: boolean; error?: string }>;

  /** Type text using the software keyboard (element must have focus). */
  type(text: string): Promise<{ success: boolean; error?: string }>;

  /** Press a hardware key (e.g. "home", "volumeUp", "return"). */
  press(key: string): Promise<{ success: boolean; error?: string }>;

  /** Capture a screenshot and save it to the specified output path on the host. */
  screenshot(outputPath: string): Promise<{ success: boolean; error?: string }>;

  /** Get lightweight state for action-context probes. */
  state(): Promise<IOSState>;
}

// ─── Tree Normalization ─────────────────────────────────────────

/**
 * Map iOS elementType strings to browse-normalized AX role names.
 * This bridges the gap between XCUIElement.ElementType and the
 * macOS-style AX roles used in the shared AppNode contract.
 */
export const IOS_ROLE_MAP: Record<string, string> = {
  // Interactive
  button: 'AXButton',
  textField: 'AXTextField',
  secureTextField: 'AXTextField',
  textView: 'AXTextArea',
  switch: 'AXSwitch',
  toggle: 'AXToggle',
  slider: 'AXSlider',
  stepper: 'AXIncrementor',
  picker: 'AXPopUpButton',
  segmentedControl: 'AXRadioGroup',
  link: 'AXLink',
  menuItem: 'AXMenuItem',
  tab: 'AXTab',
  tabBar: 'AXTabGroup',

  // Display
  staticText: 'AXStaticText',
  image: 'AXImage',
  icon: 'AXImage',
  activityIndicator: 'AXProgressIndicator',
  progressIndicator: 'AXProgressIndicator',

  // Layout / Containers
  cell: 'AXCell',
  table: 'AXTable',
  collectionView: 'AXGrid',
  scrollView: 'AXScrollArea',
  navigationBar: 'AXToolbar',
  toolbar: 'AXToolbar',
  group: 'AXGroup',
  window: 'AXWindow',
  alert: 'AXDialog',
  sheet: 'AXSheet',
  popover: 'AXPopover',

  // Misc
  webView: 'AXWebArea',
  map: 'AXGroup',
  other: 'AXGroup',
  application: 'AXApplication',
};

/**
 * Convert a RawIOSNode elementType to the normalized AX role used by browse.
 * Falls back to "AXGroup" for unrecognized types.
 */
export function normalizeIOSRole(elementType: string): string {
  return IOS_ROLE_MAP[elementType] ?? 'AXGroup';
}
