/**
 * App tree normalization — converts raw bridge output to browse-owned structures.
 *
 * Assigns @refs host-side, extracts visible text, and prepares snapshot output.
 * The bridge provides raw tree data; browse owns refs, formatting, and semantics.
 */

import type { AppNode } from './types';

/** Ref entry for app nodes */
export interface AppRef {
  path: number[];
  role: string;
  label: string;
}

/**
 * Assign @refs to interactive nodes in the app tree.
 * Returns a Map<refId, AppRef> and the formatted snapshot text.
 */
export function assignRefs(
  root: AppNode,
  interactive = false,
): { refMap: Map<string, AppRef>; text: string } {
  const refMap = new Map<string, AppRef>();
  const lines: string[] = [];
  let refCounter = 1;

  function isInteractive(node: AppNode): boolean {
    const interactiveRoles = new Set([
      'AXButton', 'AXTextField', 'AXTextArea', 'AXCheckBox', 'AXRadioButton',
      'AXPopUpButton', 'AXComboBox', 'AXSlider', 'AXLink', 'AXMenuItem',
      'AXTab', 'AXToolbar', 'AXMenuButton', 'AXToggle', 'AXSwitch',
      'AXIncrementor', 'AXColorWell', 'AXDisclosureTriangle',
    ]);
    return interactiveRoles.has(node.role) || node.actions.length > 0 || node.editable;
  }

  function walk(node: AppNode, depth: number): void {
    const shouldRef = !interactive || isInteractive(node);
    const label = node.label || node.value || '';
    const refId = `@e${refCounter}`;

    if (shouldRef && (label || node.role !== 'AXGroup')) {
      refMap.set(refId, { path: node.path, role: node.role, label });
      const roleName = node.role.replace(/^AX/, '').toLowerCase();
      const displayLabel = label ? ` "${label}"` : '';
      lines.push(`${refId} [${roleName}]${displayLabel}`);
      refCounter++;
    }

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return { refMap, text: lines.join('\n') };
}

/**
 * Extract visible text from the app tree.
 * Concatenates labels and values of text-bearing nodes.
 */
export function extractText(root: AppNode): string {
  const texts: string[] = [];

  function walk(node: AppNode): void {
    const textRoles = new Set(['AXStaticText', 'AXTextField', 'AXTextArea', 'AXHeading']);
    if (textRoles.has(node.role)) {
      const text = node.value || node.label;
      if (text) texts.push(text);
    } else if (node.label && node.children.length === 0) {
      // Leaf node with a label — likely visible text
      texts.push(node.label);
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return texts.join('\n');
}
