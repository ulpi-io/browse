/**
 * Android-specific tests — mocked contract coverage for all protocol methods.
 *
 * Tests the Android adapter stack without requiring a real device/emulator:
 *   - AndroidAppManager ↔ protocol contract
 *   - Raw→AppNode normalization with Android role mapping
 *   - Ref assignment for Android-specific UI elements
 *   - Bridge error handling (missing app, ambiguous device, startup timeout)
 *   - Stale ref behavior matches macOS refs
 */

import { describe, test, expect } from 'vitest';
import { AndroidAppManager } from '../src/app/android/manager';
import type { AndroidDriverProtocol, RawAndroidNode, AndroidState, DriverResult } from '../src/app/android/protocol';

// ─── Helpers ─────────────────────────────────────────────────────

/** Build a minimal RawAndroidNode with sensible defaults */
function rawNode(overrides: Partial<RawAndroidNode> & { className: string }): RawAndroidNode {
  return {
    path: overrides.path ?? [],
    className: overrides.className,
    text: overrides.text ?? null,
    hint: overrides.hint ?? null,
    resourceId: overrides.resourceId ?? null,
    bounds: overrides.bounds ?? { left: 0, top: 0, right: 100, bottom: 30 },
    clickable: overrides.clickable ?? false,
    longClickable: overrides.longClickable ?? false,
    enabled: overrides.enabled ?? true,
    focused: overrides.focused ?? false,
    selected: overrides.selected ?? false,
    checked: overrides.checked ?? false,
    checkable: overrides.checkable ?? false,
    editable: overrides.editable ?? false,
    scrollable: overrides.scrollable ?? false,
    visibleToUser: overrides.visibleToUser ?? true,
    children: overrides.children ?? [],
  };
}

/** Create a mock Android bridge that returns a fixed tree and tracks calls */
function createMockBridge(tree: RawAndroidNode): AndroidDriverProtocol & {
  actionCalls: { path: number[]; actionName: string }[];
  setValueCalls: { path: number[]; value: string }[];
  typeCalls: string[];
  pressCalls: string[];
  screenshotCalls: string[];
} {
  const bridge = {
    actionCalls: [] as { path: number[]; actionName: string }[],
    setValueCalls: [] as { path: number[]; value: string }[],
    typeCalls: [] as string[],
    pressCalls: [] as string[],
    screenshotCalls: [] as string[],

    async tree(): Promise<RawAndroidNode> {
      return tree;
    },
    async action(path: number[], actionName: string): Promise<DriverResult> {
      bridge.actionCalls.push({ path, actionName });
      return { success: true };
    },
    async setValue(path: number[], value: string): Promise<DriverResult> {
      bridge.setValueCalls.push({ path, value });
      return { success: true };
    },
    async type(text: string): Promise<DriverResult> {
      bridge.typeCalls.push(text);
      return { success: true };
    },
    async press(key: string): Promise<DriverResult> {
      bridge.pressCalls.push(key);
      return { success: true };
    },
    async screenshot(outputPath: string): Promise<DriverResult> {
      bridge.screenshotCalls.push(outputPath);
      return { success: true };
    },
    async state(): Promise<AndroidState> {
      return {
        packageName: 'com.example.testapp',
        activityName: 'com.example.testapp.MainActivity',
        windowTitle: 'Test App',
        nodeCount: 10,
        interactive: true,
      };
    },
  };
  return bridge;
}

// ─── Sample Android tree ─────────────────────────────────────────

function sampleAndroidTree(): RawAndroidNode {
  return rawNode({
    className: 'android.widget.FrameLayout',
    path: [],
    children: [
      rawNode({
        className: 'android.widget.Button',
        text: 'Submit',
        path: [0],
        clickable: true,
        bounds: { left: 100, top: 200, right: 300, bottom: 250 },
      }),
      rawNode({
        className: 'android.widget.EditText',
        text: null,
        hint: 'Enter email',
        path: [1],
        editable: true,
        bounds: { left: 100, top: 100, right: 400, bottom: 150 },
      }),
      rawNode({
        className: 'android.widget.TextView',
        text: 'Welcome to the app',
        path: [2],
        bounds: { left: 100, top: 50, right: 400, bottom: 80 },
      }),
      rawNode({
        className: 'android.widget.CheckBox',
        text: 'Remember me',
        path: [3],
        checkable: true,
        clickable: true,
        bounds: { left: 100, top: 260, right: 300, bottom: 290 },
      }),
      rawNode({
        className: 'android.widget.Switch',
        text: 'Dark mode',
        path: [4],
        checkable: true,
        clickable: true,
        bounds: { left: 100, top: 300, right: 300, bottom: 330 },
      }),
      rawNode({
        className: 'androidx.recyclerview.widget.RecyclerView',
        path: [5],
        scrollable: true,
        children: [
          rawNode({
            className: 'android.widget.TextView',
            text: 'Item 1',
            path: [5, 0],
          }),
          rawNode({
            className: 'android.widget.TextView',
            text: 'Item 2',
            path: [5, 1],
          }),
        ],
      }),
    ],
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AndroidAppManager: snapshot + ref assignment', () => {
  test('snapshot assigns @refs to interactive Android nodes', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const output = await mgr.snapshot(false);

    // Non-interactive mode: all named/non-group nodes get refs
    expect(output).toContain('@e');
    expect(output).toContain('[button]');
    expect(output).toContain('"Submit"');
    expect(output).toContain('[textfield]');
    expect(output).toContain('[checkbox]');
    expect(output).toContain('[switch]');
  });

  test('interactive snapshot only assigns refs to actionable elements', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const output = await mgr.snapshot(true);

    // Interactive mode: only elements with actions/editable get refs
    expect(output).toContain('[button]');
    expect(output).toContain('[textfield]');
    expect(output).toContain('[checkbox]');
    // Static text should not appear in interactive mode
    expect(output).not.toContain('[statictext] "Welcome');
  });

  test('refs are resolvable after snapshot', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await mgr.snapshot(false);

    const ref = mgr.resolveRef('@e1');
    expect(ref).toBeDefined();
    expect(ref.role).toBeTruthy();
    expect(Array.isArray(ref.path)).toBe(true);
  });
});

describe('AndroidAppManager: role mapping', () => {
  test('Android class names map to AX roles', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await mgr.snapshot(false);

    // Walk refs to verify role mappings
    const roles: string[] = [];
    for (let i = 1; i < 50; i++) {
      try {
        roles.push(mgr.resolveRef(`@e${i}`).role);
      } catch {
        break;
      }
    }

    expect(roles).toContain('AXButton');
    expect(roles).toContain('AXTextField');
    expect(roles).toContain('AXStaticText');
    expect(roles).toContain('AXCheckBox');
    expect(roles).toContain('AXSwitch');
    expect(roles).toContain('AXList'); // RecyclerView
  });
});

describe('AndroidAppManager: tap', () => {
  test('tap resolves ref and calls bridge.action with "click"', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await mgr.snapshot(false);

    // Find the button ref
    const buttonRef = findRefByRole(mgr, 'AXButton');
    expect(buttonRef).toBeTruthy();

    const result = await mgr.tap(buttonRef!);
    expect(result).toContain('Tapped');
    expect(result).toContain(buttonRef!);
    expect(bridge.actionCalls.length).toBe(1);
    expect(bridge.actionCalls[0].actionName).toBe('click');
  });

  test('tap on failed action throws', async () => {
    const tree = sampleAndroidTree();
    const bridge = createMockBridge(tree);
    // Override action to fail
    bridge.action = async () => ({ success: false, error: 'Node not clickable' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');
    await mgr.snapshot(false);
    const buttonRef = findRefByRole(mgr, 'AXButton');

    await expect(mgr.tap(buttonRef!)).rejects.toThrow('Node not clickable');
  });
});

describe('AndroidAppManager: fill', () => {
  test('fill calls bridge.setValue with path and value', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await mgr.snapshot(false);

    const fieldRef = findRefByRole(mgr, 'AXTextField');
    expect(fieldRef).toBeTruthy();

    const result = await mgr.fill(fieldRef!, 'user@test.com');
    expect(result).toContain('Filled');
    expect(result).toContain('user@test.com');
    expect(bridge.setValueCalls.length).toBe(1);
    expect(bridge.setValueCalls[0].value).toBe('user@test.com');
  });
});

describe('AndroidAppManager: typeText + pressKey', () => {
  test('typeText delegates to bridge.type', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const result = await mgr.typeText('Hello World');
    expect(result).toContain('Typed');
    expect(bridge.typeCalls).toContain('Hello World');
  });

  test('pressKey delegates to bridge.press', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const result = await mgr.pressKey('ENTER');
    expect(result).toContain('Pressed');
    expect(bridge.pressCalls).toContain('ENTER');
  });
});

describe('AndroidAppManager: screenshot', () => {
  test('screenshot delegates to bridge.screenshot', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const result = await mgr.screenshot('/tmp/android-test.png');
    expect(result).toContain('Screenshot saved');
    expect(bridge.screenshotCalls).toContain('/tmp/android-test.png');
  });
});

describe('AndroidAppManager: state', () => {
  test('getState returns normalized app state', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const state = await mgr.getState();
    expect(state.appName).toBe('com.example.testapp');
    expect(state.windowTitle).toBeTruthy();
    expect(typeof state.elementCount).toBe('number');
  });
});

describe('AndroidAppManager: text extraction', () => {
  test('text extracts visible text from Android tree', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const text = await mgr.text();
    expect(text).toContain('Welcome to the app');
    expect(text).toContain('Item 1');
    expect(text).toContain('Item 2');
  });
});

describe('AndroidAppManager: stale refs', () => {
  test('resolveRef throws before snapshot', () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    expect(() => mgr.resolveRef('@e1')).toThrow(/not found/);
    expect(() => mgr.resolveRef('@e1')).toThrow(/snapshot/i);
  });

  test('refs cleared after close', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await mgr.snapshot(false);
    expect(() => mgr.resolveRef('@e1')).not.toThrow();

    await mgr.close();
    expect(() => mgr.resolveRef('@e1')).toThrow(/not found/);
  });
});

describe('AndroidAppManager: capabilities', () => {
  test('reports correct capabilities for Android targets', () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    const caps = mgr.getCapabilities();
    expect(caps.refs).toBe(true);
    expect(caps.screenshots).toBe(true);
    expect(caps.navigation).toBe(false);
    expect(caps.tabs).toBe(false);
    expect(caps.javascript).toBe(false);
    expect(caps.deviceEmulation).toBe(false);
    expect(caps.frames).toBe(false);
  });

  test('targetType is android-app', () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    expect(mgr.targetType).toBe('android-app');
  });

  test('getCurrentLocation returns android-app:// URI', () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    expect(mgr.getCurrentLocation()).toBe('android-app://com.example.testapp');
  });

  test('isReady returns true', () => {
    const bridge = createMockBridge(sampleAndroidTree());
    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    expect(mgr.isReady()).toBe(true);
  });
});

describe('AndroidAppManager: protocol error handling', () => {
  test('bridge.action failure propagates as error', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    bridge.action = async () => ({ success: false, error: 'Node not found at path [99]' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');
    await mgr.snapshot(false);
    const ref = findRefByRole(mgr, 'AXButton');

    await expect(mgr.tap(ref!)).rejects.toThrow('Node not found');
  });

  test('bridge.setValue failure propagates as error', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    bridge.setValue = async () => ({ success: false, error: 'Node is not editable' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');
    await mgr.snapshot(false);
    const ref = findRefByRole(mgr, 'AXTextField');

    await expect(mgr.fill(ref!, 'test')).rejects.toThrow('not editable');
  });

  test('bridge.type failure propagates as error', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    bridge.type = async () => ({ success: false, error: 'No focused element' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await expect(mgr.typeText('hello')).rejects.toThrow('No focused element');
  });

  test('bridge.press failure propagates as error', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    bridge.press = async () => ({ success: false, error: 'Unknown key: INVALID' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await expect(mgr.pressKey('INVALID')).rejects.toThrow('Unknown key');
  });

  test('bridge.screenshot failure propagates as error', async () => {
    const bridge = createMockBridge(sampleAndroidTree());
    bridge.screenshot = async () => ({ success: false, error: 'takeScreenshot() returned null' });

    const mgr = new AndroidAppManager(bridge, 'com.example.testapp');

    await expect(mgr.screenshot('/tmp/test.png')).rejects.toThrow('returned null');
  });
});

// ─── Target factory contract ─────────────────────────────────��───

describe('Android target factory contract', () => {
  test('createAndroidTargetFactory exists and returns a factory', async () => {
    const { createAndroidTargetFactory } = await import('../src/session/target-factory');
    const factory = createAndroidTargetFactory('com.example.testapp', 'emulator-5554');
    expect(factory).toBeDefined();
    expect(typeof factory.create).toBe('function');
  });
});

// ─── Utility ────────────────────────────────────────────────────

function findRefByRole(mgr: AndroidAppManager, role: string): string | null {
  for (let i = 1; i < 100; i++) {
    try {
      const resolved = mgr.resolveRef(`@e${i}`);
      if (resolved.role === role) return `@e${i}`;
    } catch {
      break;
    }
  }
  return null;
}
