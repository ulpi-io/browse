/**
 * Android app automation manager — wraps the Android bridge with the shared
 * app normalization layer and exposes the same command surface as macOS AppManager.
 *
 * Converts RawAndroidNode trees to AppNode (browse-owned format), assigns @refs
 * host-side, and delegates commands to the on-device driver via AndroidDriverProtocol.
 */

import type { AutomationTarget, TargetCapabilities } from '../../automation/target';
import type { AndroidDriverProtocol, RawAndroidNode, AndroidState } from './protocol';
import type { AppNode, AppState } from '../types';
import { assignRefs, extractText, type AppRef } from '../normalize';

// ─── Raw → AppNode normalization ──────────────────────────────────

/**
 * Normalise a RawAndroidNode tree into the browse-owned AppNode format.
 * Maps Android class names to AX-style role names for ref/text extraction.
 */
function normalizeNode(raw: RawAndroidNode, path: number[] = []): AppNode {
  return {
    path,
    role: androidRole(raw.className),
    label: raw.text ?? raw.hint ?? '',
    value: raw.editable ? (raw.text ?? '') : undefined,
    frame: {
      x: raw.bounds.left,
      y: raw.bounds.top,
      width: raw.bounds.right - raw.bounds.left,
      height: raw.bounds.bottom - raw.bounds.top,
    },
    enabled: raw.enabled,
    focused: raw.focused,
    selected: raw.selected,
    editable: raw.editable,
    actions: deriveActions(raw),
    children: raw.children.map((child, i) => normalizeNode(child, [...path, i])),
  };
}

/**
 * Map an Android class name to an AX-style role name.
 * Keeps the same naming convention as the macOS bridge so that the shared
 * normalize.ts helpers work identically across platforms.
 */
function androidRole(className: string): string {
  const simple = className.split('.').pop() ?? className;
  const roleMap: Record<string, string> = {
    Button: 'AXButton',
    ImageButton: 'AXButton',
    FloatingActionButton: 'AXButton',
    EditText: 'AXTextField',
    AutoCompleteTextView: 'AXTextField',
    MultiAutoCompleteTextView: 'AXTextArea',
    CheckBox: 'AXCheckBox',
    RadioButton: 'AXRadioButton',
    Switch: 'AXSwitch',
    ToggleButton: 'AXToggle',
    Spinner: 'AXPopUpButton',
    SeekBar: 'AXSlider',
    TextView: 'AXStaticText',
    ImageView: 'AXImage',
    ListView: 'AXList',
    RecyclerView: 'AXList',
    ScrollView: 'AXScrollArea',
    HorizontalScrollView: 'AXScrollArea',
    ViewPager: 'AXScrollArea',
    ToolBar: 'AXToolbar',
    TabLayout: 'AXTabGroup',
    TabItem: 'AXTab',
    ProgressBar: 'AXProgressIndicator',
    LinearLayout: 'AXGroup',
    RelativeLayout: 'AXGroup',
    FrameLayout: 'AXGroup',
    ConstraintLayout: 'AXGroup',
    CoordinatorLayout: 'AXGroup',
    AppBarLayout: 'AXGroup',
    CollapsingToolbarLayout: 'AXGroup',
    DrawerLayout: 'AXGroup',
    NavigationView: 'AXGroup',
    BottomNavigationView: 'AXGroup',
    ViewGroup: 'AXGroup',
    View: 'AXGroup',
  };
  return roleMap[simple] ?? `AXAndroid:${simple}`;
}

/**
 * Derive an actions array from Android accessibility flags.
 * Maps to AX-style action names so ref assignment uses the same logic.
 */
function deriveActions(raw: RawAndroidNode): string[] {
  const actions: string[] = [];
  if (raw.clickable) actions.push('AXPress');
  if (raw.longClickable) actions.push('AXShowMenu');
  if (raw.editable) actions.push('AXSetValue');
  if (raw.checkable) actions.push('AXToggle');
  if (raw.scrollable) actions.push('AXScroll');
  return actions;
}

// ─── AndroidAppManager ────────────────────────────────────────────

/**
 * Android app automation manager.
 *
 * Implements the same public surface as macOS AppManager so that commands.ts
 * and the server can treat both platforms identically.
 */
export class AndroidAppManager implements AutomationTarget {
  readonly targetType = 'android-app';

  private bridge: AndroidDriverProtocol;
  private packageName: string;
  private refMap = new Map<string, AppRef>();
  private lastSnapshot: string | null = null;
  private lastTree: AppNode | null = null;

  constructor(bridge: AndroidDriverProtocol, packageName: string) {
    this.bridge = bridge;
    this.packageName = packageName;
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
    return `android-app://${this.packageName}`;
  }

  isReady(): boolean {
    return true; // Bridge is HTTP — always ready if the driver is running
  }

  async close(): Promise<void> {
    this.refMap.clear();
    this.lastSnapshot = null;
    this.lastTree = null;
  }

  // ─── App-specific methods ──────────────────────────────────────

  /** Get the app tree and assign @refs */
  async snapshot(interactive = false): Promise<string> {
    const raw = await this.bridge.tree();
    this.lastTree = normalizeNode(raw);
    const { refMap, text } = assignRefs(this.lastTree, interactive);
    this.refMap = refMap;
    this.lastSnapshot = text;
    return text;
  }

  /** Extract visible text from the app */
  async text(): Promise<string> {
    const raw = await this.bridge.tree();
    return extractText(normalizeNode(raw));
  }

  /** Resolve a @ref to a node path */
  resolveRef(ref: string): { path: number[]; role: string; label: string } {
    const entry = this.refMap.get(ref);
    if (!entry) {
      throw new Error(`Ref ${ref} not found. Run 'snapshot' to refresh.`);
    }
    return entry;
  }

  /** Tap (click) an element by ref */
  async tap(ref: string): Promise<string> {
    const { path, label } = this.resolveRef(ref);
    const result = await this.bridge.action(path, 'click');
    if (!result.success) throw new Error(result.error ?? 'Tap failed');
    return `Tapped ${ref}${label ? ` "${label}"` : ''}`;
  }

  /** Fill a text field by ref */
  async fill(ref: string, value: string): Promise<string> {
    const { path } = this.resolveRef(ref);
    const result = await this.bridge.setValue(path, value);
    if (!result.success) throw new Error(result.error ?? 'Fill failed');
    return `Filled ${ref} with "${value}"`;
  }

  /** Type text into the currently focused element */
  async typeText(text: string): Promise<string> {
    const result = await this.bridge.type(text);
    if (!result.success) throw new Error(result.error ?? 'Type failed');
    return `Typed "${text}"`;
  }

  /** Press a named key */
  async pressKey(key: string): Promise<string> {
    const result = await this.bridge.press(key);
    if (!result.success) throw new Error(result.error ?? 'Press failed');
    return `Pressed ${key}`;
  }

  /** Take a screenshot and save it to the host filesystem */
  async screenshot(outputPath: string): Promise<string> {
    const result = await this.bridge.screenshot(outputPath);
    if (!result.success) throw new Error(result.error ?? 'Screenshot failed');
    return `Screenshot saved: ${outputPath}`;
  }

  /** Get lightweight state for action-context probes */
  async getState(): Promise<AppState> {
    const s: AndroidState = await this.bridge.state();
    return {
      appName: s.packageName,
      windowTitle: s.windowTitle ?? s.activityName,
      focusedPath: null,
      elementCount: s.nodeCount,
      windowCount: 1,
      settled: s.interactive,
    };
  }

  /** Get the last snapshot text */
  getLastSnapshot(): string | null {
    return this.lastSnapshot;
  }

  /** Get the package name */
  getPackageName(): string {
    return this.packageName;
  }
}
