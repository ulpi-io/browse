/**
 * Integration tests for v2.0 app automation — TASK-034
 *
 * Uses a mock bridge (no real macOS app needed) to verify:
 *   - assignRefs assigns @refs to interactive nodes
 *   - extractText extracts visible text from tree
 *   - AppManager.snapshot returns formatted text with refs
 *   - AppManager.tap resolves ref and calls bridge action
 *   - AppManager.fill resolves ref and calls bridge setValue
 *   - Stale ref throws with refresh guidance
 *   - Unsupported app command rejected (capability gating)
 *   - Runtime contract: tree, action, set-value, type, press, screenshot, state
 */

import { describe, test, expect, vi } from 'vitest';
import { AppManager } from '../src/app/manager';
import { assignRefs, extractText } from '../src/app/normalize';
import { requireCapability, UnsupportedCapabilityError } from '../src/automation/target';
import type { AppNode, AppBridgeProtocol, AppState, BridgeResult } from '../src/app/types';

// ─── Helpers ─────────────────────────────────────────────────────

/** Build a minimal AppNode with sensible defaults */
function node(overrides: Partial<AppNode> & { role: string }): AppNode {
  return {
    path: [0],
    role: overrides.role,
    label: overrides.label ?? '',
    value: overrides.value,
    frame: overrides.frame ?? { x: 0, y: 0, width: 100, height: 30 },
    enabled: overrides.enabled ?? true,
    focused: overrides.focused ?? false,
    selected: overrides.selected ?? false,
    editable: overrides.editable ?? false,
    actions: overrides.actions ?? [],
    children: overrides.children ?? [],
  };
}

/** Create a mock bridge that returns a fixed tree and tracks calls */
function createMockBridge(tree: AppNode): AppBridgeProtocol & {
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

    async tree(): Promise<AppNode> {
      return tree;
    },
    async action(path: number[], actionName: string): Promise<BridgeResult> {
      bridge.actionCalls.push({ path, actionName });
      return { success: true };
    },
    async setValue(path: number[], value: string): Promise<BridgeResult> {
      bridge.setValueCalls.push({ path, value });
      return { success: true };
    },
    async type(text: string): Promise<BridgeResult> {
      bridge.typeCalls.push(text);
      return { success: true };
    },
    async press(key: string): Promise<BridgeResult> {
      bridge.pressCalls.push(key);
      return { success: true };
    },
    async screenshot(outputPath: string): Promise<BridgeResult> {
      bridge.screenshotCalls.push(outputPath);
      return { success: true };
    },
    async state(): Promise<AppState> {
      return {
        windowTitle: 'Test Window',
        focusedPath: null,
        elementCount: 5,
        windowCount: 1,
        appName: 'TestApp',
        settled: true,
      };
    },
  };
  return bridge;
}

// ─── Sample tree used across multiple tests ─────────────────────

function sampleTree(): AppNode {
  return node({
    role: 'AXWindow',
    label: 'Main Window',
    path: [],
    children: [
      node({
        role: 'AXButton',
        label: 'Submit',
        path: [0],
        actions: ['AXPress'],
      }),
      node({
        role: 'AXTextField',
        label: 'Email',
        path: [1],
        editable: true,
        actions: ['AXSetValue'],
      }),
      node({
        role: 'AXStaticText',
        label: 'Welcome to the app',
        path: [2],
      }),
      node({
        role: 'AXCheckBox',
        label: 'Remember me',
        path: [3],
        actions: ['AXPress'],
      }),
      node({
        role: 'AXGroup',
        label: '',
        path: [4],
        children: [
          node({
            role: 'AXStaticText',
            label: 'Nested text',
            path: [4, 0],
          }),
        ],
      }),
    ],
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe('assignRefs assigns @refs to interactive nodes', () => {
  test('all interactive and text nodes get refs', () => {
    const tree = sampleTree();
    const { refMap, text } = assignRefs(tree, false);

    // Non-interactive mode: all named/non-group nodes get refs
    expect(refMap.size).toBeGreaterThanOrEqual(5);

    // Each interactive node should be in the ref map
    const refs = [...refMap.values()];
    const roles = refs.map(r => r.role);
    expect(roles).toContain('AXButton');
    expect(roles).toContain('AXTextField');
    expect(roles).toContain('AXCheckBox');

    // The text output should have @e references
    expect(text).toContain('@e');
    expect(text).toContain('[button]');
    expect(text).toContain('"Submit"');
  });

  test('interactive mode only assigns refs to interactive elements', () => {
    const tree = sampleTree();
    const { refMap } = assignRefs(tree, true);

    // In interactive mode, only elements with interactive roles, actions, or editable get refs
    const roles = [...refMap.values()].map(r => r.role);
    expect(roles).toContain('AXButton');
    expect(roles).toContain('AXTextField');
    expect(roles).toContain('AXCheckBox');
  });
});

describe('extractText extracts visible text from tree', () => {
  test('concatenates text from text-bearing nodes', () => {
    const tree = sampleTree();
    const text = extractText(tree);

    expect(text).toContain('Welcome to the app');
    expect(text).toContain('Nested text');
    // AXTextField with no value and label "Email" is a text role
    expect(text).toContain('Email');
  });

  test('returns empty for a tree with no text nodes', () => {
    const tree = node({
      role: 'AXGroup',
      label: '',
      path: [],
      children: [
        node({ role: 'AXGroup', label: '', path: [0] }),
      ],
    });

    const text = extractText(tree);
    expect(text).toBe('');
  });
});

describe('AppManager.snapshot returns formatted text with refs', () => {
  test('snapshot builds refs and returns formatted output', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    const output = await mgr.snapshot(true);

    // Output should contain at least some @ref lines
    expect(output).toContain('@e');
    expect(output).toContain('[button]');
    expect(output).toContain('"Submit"');

    // After snapshot, refs should be resolvable
    const resolved = mgr.resolveRef('@e1');
    expect(resolved).toBeDefined();
    expect(resolved.role).toBeTruthy();
  });
});

describe('AppManager.tap resolves ref and calls bridge action', () => {
  test('tap calls bridge.action with correct path', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    // Build refs first
    await mgr.snapshot(false);

    // Find the button ref
    const buttonRef = findRefByRole(mgr, 'AXButton');
    expect(buttonRef).toBeTruthy();

    const result = await mgr.tap(buttonRef!);
    expect(result).toContain('Tapped');
    expect(result).toContain(buttonRef!);
    expect(bridge.actionCalls.length).toBe(1);
    expect(bridge.actionCalls[0].actionName).toBe('AXPress');
  });
});

describe('AppManager.fill resolves ref and calls bridge setValue', () => {
  test('fill calls bridge.setValue with correct path and value', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    await mgr.snapshot(false);

    // Find the text field ref
    const fieldRef = findRefByRole(mgr, 'AXTextField');
    expect(fieldRef).toBeTruthy();

    const result = await mgr.fill(fieldRef!, 'test@example.com');
    expect(result).toContain('Filled');
    expect(result).toContain('test@example.com');
    expect(bridge.setValueCalls.length).toBe(1);
    expect(bridge.setValueCalls[0].value).toBe('test@example.com');
  });
});

describe('Stale ref throws with refresh guidance', () => {
  test('throws error with guidance to run snapshot', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    // No snapshot taken — refMap is empty
    expect(() => mgr.resolveRef('@e1')).toThrow(/not found/);
    expect(() => mgr.resolveRef('@e1')).toThrow(/snapshot/i);
  });

  test('cleared refMap after close throws stale ref error', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    await mgr.snapshot(false);
    // Verify refs work
    expect(() => mgr.resolveRef('@e1')).not.toThrow();

    // Close clears the ref map
    await mgr.close();

    expect(() => mgr.resolveRef('@e1')).toThrow(/not found/);
    expect(() => mgr.resolveRef('@e1')).toThrow(/snapshot/i);
  });
});

describe('Unsupported app command rejected', () => {
  test('capabilities report no navigation, no tabs, no javascript', () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    const caps = mgr.getCapabilities();
    expect(caps.navigation).toBe(false);
    expect(caps.tabs).toBe(false);
    expect(caps.javascript).toBe(false);
    expect(caps.deviceEmulation).toBe(false);
    expect(caps.frames).toBe(false);
    // App supports refs and screenshots
    expect(caps.refs).toBe(true);
    expect(caps.screenshots).toBe(true);
  });

  test('UnsupportedCapabilityError for unsupported capability', () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    expect(() => requireCapability(mgr, 'javascript')).toThrow(/javascript/);
    expect(() => requireCapability(mgr, 'navigation')).toThrow(/navigation/);
    expect(() => requireCapability(mgr, 'tabs')).toThrow(/tabs/);
  });
});

describe('Runtime contract: bridge implements all required methods', () => {
  test('mock bridge implements tree, action, set-value, type, press, screenshot, state', async () => {
    const bridge = createMockBridge(sampleTree());

    // tree
    const tree = await bridge.tree();
    expect(tree).toBeDefined();
    expect(tree.role).toBe('AXWindow');

    // action
    const actionResult = await bridge.action([0], 'AXPress');
    expect(actionResult.success).toBe(true);

    // set-value
    const setResult = await bridge.setValue([1], 'test');
    expect(setResult.success).toBe(true);

    // type
    const typeResult = await bridge.type('hello');
    expect(typeResult.success).toBe(true);

    // press
    const pressResult = await bridge.press('Return');
    expect(pressResult.success).toBe(true);

    // screenshot
    const ssResult = await bridge.screenshot('/tmp/test.png');
    expect(ssResult.success).toBe(true);

    // state
    const state = await bridge.state();
    expect(state.windowTitle).toBe('Test Window');
    expect(state.appName).toBe('TestApp');
    expect(typeof state.elementCount).toBe('number');
    expect(typeof state.windowCount).toBe('number');
  });

  test('AppManager integrates with bridge for typeText and pressKey', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    const typeResult = await mgr.typeText('Hello');
    expect(typeResult).toContain('Typed');
    expect(bridge.typeCalls).toContain('Hello');

    const pressResult = await mgr.pressKey('Return');
    expect(pressResult).toContain('Pressed');
    expect(bridge.pressCalls).toContain('Return');
  });

  test('AppManager.screenshot delegates to bridge', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    const result = await mgr.screenshot('/tmp/app-screenshot.png');
    expect(result).toContain('Screenshot saved');
    expect(bridge.screenshotCalls).toContain('/tmp/app-screenshot.png');
  });

  test('AppManager.getState returns bridge state', async () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    const state = await mgr.getState();
    expect(state.windowTitle).toBe('Test Window');
    expect(state.appName).toBe('TestApp');
    expect(state.elementCount).toBe(5);
  });

  test('AppManager reports target type and location', () => {
    const bridge = createMockBridge(sampleTree());
    const mgr = new AppManager(bridge, 'TestApp');

    expect(mgr.targetType).toBe('app');
    expect(mgr.getCurrentLocation()).toBe('app://TestApp');
    expect(mgr.isReady()).toBe(true);
  });
});

// ─── Utility ────────────────────────────────────────────────────

/** Find the first @ref that maps to a given role */
function findRefByRole(mgr: AppManager, role: string): string | null {
  // Iterate @e1, @e2, ... until we find the role or exhaust
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
