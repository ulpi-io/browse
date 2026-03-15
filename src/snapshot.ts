/**
 * Snapshot command — accessibility tree with ref-based element selection
 *
 * Architecture (Locator map — no DOM mutation):
 *   1. page.locator(scope).ariaSnapshot() → YAML-like accessibility tree
 *   2. Parse tree, assign refs @e1, @e2, ...
 *   3. Build Playwright Locator for each ref (getByRole + nth)
 *   4. Store Map<string, Locator> on BrowserManager
 *   5. Return compact text output with refs prepended
 *
 * Cursor-interactive detection (-C flag):
 *   After the normal ARIA snapshot, scans the DOM for elements that are
 *   clickable but invisible to the accessibility tree — divs with
 *   cursor:pointer, onclick, tabindex, role, or data-action attributes.
 *   These get refs and locators just like ARIA elements, so "click @e15"
 *   works seamlessly.
 *
 * Later: "click @e3" → look up Locator → locator.click()
 */

import type { Page, Locator } from 'playwright';
import type { BrowserManager } from './browser-manager';

// Roles considered "interactive" for the -i flag
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab',
  'treeitem',
]);

interface SnapshotOptions {
  interactive?: boolean;  // -i: only interactive elements
  compact?: boolean;      // -c: remove empty structural elements
  depth?: number;         // -d N: limit tree depth
  selector?: string;      // -s SEL: scope to CSS selector
  cursor?: boolean;       // -C: detect cursor-interactive elements (divs with cursor:pointer, onclick, tabindex)
}

interface ParsedNode {
  indent: number;
  role: string;
  name: string | null;
  props: string;      // e.g., "[level=1]"
  children: string;   // inline text content after ":"
  rawLine: string;
}

/** Info returned from the in-page DOM scan for cursor-interactive elements */
interface CursorElement {
  tag: string;
  id: string;
  className: string;
  text: string;
  reason: string;          // "cursor:pointer" | "onclick" | "tabindex" | "role" | "data-action"
  cssSelector: string;     // best-effort unique CSS selector for building Locator
  selectorIndex: number;   // element's index among all matches of cssSelector in the DOM
}

/**
 * Parse CLI args into SnapshotOptions
 */
export function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const opts: SnapshotOptions = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-i':
      case '--interactive':
        opts.interactive = true;
        break;
      case '-c':
      case '--compact':
        opts.compact = true;
        break;
      case '-C':
      case '--cursor':
        opts.cursor = true;
        break;
      case '-d':
      case '--depth':
        opts.depth = parseInt(args[++i], 10);
        if (isNaN(opts.depth!)) throw new Error('Usage: snapshot -d <number>');
        break;
      case '-s':
      case '--selector':
        opts.selector = args[++i];
        if (!opts.selector) throw new Error('Usage: snapshot -s <selector>');
        break;
      default:
        throw new Error(`Unknown snapshot flag: ${args[i]}`);
    }
  }
  return opts;
}

/**
 * Parse one line of ariaSnapshot output.
 *
 * Format examples:
 *   - heading "Test" [level=1]
 *   - link "Link A":
 *     - /url: /a
 *   - textbox "Name"
 *   - paragraph: Some text
 *   - combobox "Role":
 */
function parseLine(line: string): ParsedNode | null {
  // Match: (indent)(- )(role)( "name")?( [props])?(: inline)?
  const match = line.match(/^(\s*)-\s+(\w+)(?:\s+"([^"]*)")?(?:\s+(\[.*?\]))?\s*(?::\s*(.*))?$/);
  if (!match) {
    // Skip metadata lines like "- /url: /a"
    return null;
  }
  return {
    indent: match[1].length,
    role: match[2],
    name: match[3] ?? null,
    props: match[4] || '',
    children: match[5]?.trim() || '',
    rawLine: line,
  };
}

/**
 * Native interactive tags that are already captured by the accessibility tree.
 * We skip these in the cursor-interactive scan to avoid duplicates.
 */
const NATIVE_INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'option', 'details', 'summary',
]);

/**
 * Scan the DOM for elements that look clickable/interactive but were missed
 * by the accessibility tree. Runs inside page.evaluate().
 *
 * Detection heuristics:
 *   - cursor: pointer computed style
 *   - onclick attribute (or any on* event attribute)
 *   - tabindex attribute (explicitly set)
 *   - role attribute matching interactive roles
 *   - data-action, data-click, or similar data attributes
 *
 * Exclusions:
 *   - Native interactive tags (a, button, input, select, textarea, option)
 *   - Hidden or zero-size elements
 *   - Elements already covered by ARIA roles
 */
async function findCursorInteractiveElements(
  page: Page,
  scopeSelector?: string,
): Promise<CursorElement[]> {
  const interactiveRolesList = [...INTERACTIVE_ROLES];
  const nativeTagsList = [...NATIVE_INTERACTIVE_TAGS];

  return await page.evaluate(
    ({ scopeSel, interactiveRoles, nativeTags }) => {
      const root = scopeSel
        ? document.querySelector(scopeSel) || document.body
        : document.body;

      const nativeSet = new Set(nativeTags);
      const interactiveSet = new Set(interactiveRoles);
      const results: Array<{
        tag: string;
        id: string;
        className: string;
        text: string;
        reason: string;
        cssSelector: string;
        selectorIndex: number;
      }> = [];

      // Build a set of elements already in the accessibility tree by checking
      // native interactive tags — these will already have ARIA roles
      const allElements = root.querySelectorAll('*');

      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i] as HTMLElement;
        const tag = el.tagName.toLowerCase();

        // Skip native interactive elements — ARIA already captures these
        if (nativeSet.has(tag)) continue;

        // Skip hidden or zero-size elements
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        // Detect reasons this element might be interactive
        let reason = '';

        // Check for role attribute matching interactive roles
        const roleAttr = el.getAttribute('role');
        if (roleAttr && interactiveSet.has(roleAttr)) {
          // Elements with explicit interactive ARIA roles ARE captured by ariaSnapshot
          // Skip these to avoid duplicates
          continue;
        }

        // Check for onclick or other event handler attributes
        if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup') || el.hasAttribute('ontouchstart')) {
          reason = 'onclick';
        }

        // Check for tabindex (explicitly set, not inherited)
        if (!reason && el.hasAttribute('tabindex')) {
          const tabindex = el.getAttribute('tabindex');
          // tabindex="-1" is programmatic focus only, still worth flagging
          reason = 'tabindex';
        }

        // Check for data-action, data-click, or similar interaction attributes
        if (!reason) {
          for (const attr of el.attributes) {
            if (attr.name === 'data-action' || attr.name === 'data-click' ||
                attr.name === 'data-handler' || attr.name === 'data-toggle' ||
                attr.name === 'data-dismiss' || attr.name === 'data-target' ||
                attr.name === 'data-bs-toggle' || attr.name === 'data-bs-dismiss') {
              reason = attr.name;
              break;
            }
          }
        }

        // Check for cursor: pointer computed style (most common signal)
        if (!reason && style.cursor === 'pointer') {
          reason = 'cursor:pointer';
        }

        if (!reason) continue;

        // Extract visible text (first 60 chars)
        const text = (el.textContent || '').trim().slice(0, 60).replace(/\s+/g, ' ');

        // Build a best-effort CSS selector for locator construction.
        // Strategy: find nearest ancestor with an ID and anchor from there.
        let cssSelector = '';
        if (el.id) {
          cssSelector = `#${CSS.escape(el.id)}`;
        } else {
          // Build the element's own selector: tag.class1.class2:nth-of-type(N)
          let sel = tag;
          if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\s+/).slice(0, 3);
            for (const cls of classes) {
              if (cls) sel += `.${CSS.escape(cls)}`;
            }
          }
          // Add nth-of-type to disambiguate among siblings
          const parent = el.parentElement;
          if (parent) {
            const siblings = parent.querySelectorAll(`:scope > ${tag}`);
            if (siblings.length > 1) {
              let nth = 1;
              for (let s = 0; s < siblings.length; s++) {
                if (siblings[s] === el) { nth = s + 1; break; }
              }
              sel += `:nth-of-type(${nth})`;
            }
          }

          // Walk up to find nearest ancestor with an ID (max 5 levels).
          // When scoped, skip ancestors outside the scope root to avoid
          // generating selectors that reference IDs the scoped locator can't reach.
          let ancestor: HTMLElement | null = el.parentElement;
          let anchor = '';
          let depth = 0;
          while (ancestor && ancestor !== document.body && depth < 5) {
            if (ancestor.id) {
              // If scoped, only use this anchor if it's inside the scope root
              if (!scopeSel || root.contains(ancestor)) {
                anchor = `#${CSS.escape(ancestor.id)}`;
              }
              break;
            }
            ancestor = ancestor.parentElement;
            depth++;
          }

          // Anchor from ID'd ancestor for uniqueness, or fall back to element selector alone
          cssSelector = anchor ? `${anchor} ${sel}` : sel;
        }

        // Compute the element's actual index among all DOM matches of cssSelector.
        // When scoped, query against the scope root so nth() aligns with
        // Playwright's page.locator(scope).locator(cssSelector).
        let selectorIndex = 0;
        try {
          const queryRoot = scopeSel ? root : document.body;
          const allMatches = queryRoot.querySelectorAll(cssSelector);
          for (let m = 0; m < allMatches.length; m++) {
            if (allMatches[m] === el) { selectorIndex = m; break; }
          }
        } catch {}

        results.push({
          tag,
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className.trim() : '',
          text,
          reason,
          cssSelector,
          selectorIndex,
        });
      }

      return results;
    },
    {
      scopeSel: scopeSelector || null,
      interactiveRoles: interactiveRolesList,
      nativeTags: nativeTagsList,
    },
  );
}

/**
 * Take an accessibility snapshot and build the ref map.
 */
export async function handleSnapshot(
  args: string[],
  bm: BrowserManager
): Promise<string> {
  const opts = parseSnapshotArgs(args);
  const page = bm.getPage();

  // Get accessibility tree via ariaSnapshot
  let rootLocator: Locator;
  if (opts.selector) {
    rootLocator = page.locator(opts.selector);
    const count = await rootLocator.count();
    if (count === 0) throw new Error(`Selector not found: ${opts.selector}`);
  } else {
    rootLocator = page.locator('body');
  }

  const ariaText = await rootLocator.ariaSnapshot();
  if (!ariaText || ariaText.trim().length === 0) {
    bm.setRefMap(new Map());
    // If -C is active, still scan for cursor-interactive even with empty ARIA
    if (opts.cursor) {
      const result = await appendCursorElements(page, opts, [], new Map(), 1, bm);
      bm.setLastSnapshot(result, args);
      return result;
    }
    bm.setLastSnapshot('(no accessible elements found)', args);
    return '(no accessible elements found)';
  }

  // Parse the ariaSnapshot output
  const lines = ariaText.split('\n');
  const refMap = new Map<string, Locator>();
  const output: string[] = [];
  let refCounter = 1;

  // Track role+name occurrences for nth() disambiguation
  const roleNameCounts = new Map<string, number>();
  const roleNameSeen = new Map<string, number>();

  // First pass: count role+name pairs for disambiguation
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;
    const key = `${node.role}:${node.name || ''}`;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
  }

  // Second pass: assign refs and build locators
  for (const line of lines) {
    const node = parseLine(line);
    if (!node) continue;

    const depth = Math.floor(node.indent / 2);
    const isInteractive = INTERACTIVE_ROLES.has(node.role);

    // Always advance the seen counter for every parsed node, regardless of
    // filtering. nth() indices must match the full (unfiltered) tree so that
    // locators point to the correct element even when siblings are filtered out.
    const key = `${node.role}:${node.name || ''}`;
    const seenIndex = roleNameSeen.get(key) || 0;
    roleNameSeen.set(key, seenIndex + 1);
    const totalCount = roleNameCounts.get(key) || 1;

    // Depth filter
    if (opts.depth !== undefined && depth > opts.depth) continue;

    // Interactive filter
    if (opts.interactive && !isInteractive) continue;

    // Compact filter: skip elements with no name and no inline content that aren't interactive
    if (opts.compact && !isInteractive && !node.name && !node.children) continue;

    // Assign ref
    const ref = `e${refCounter++}`;
    const indent = '  '.repeat(depth);

    let locator: Locator;
    if (opts.selector) {
      locator = page.locator(opts.selector).getByRole(node.role as any, {
        name: node.name || undefined,
      });
    } else {
      locator = page.getByRole(node.role as any, {
        name: node.name || undefined,
      });
    }

    // Disambiguate with nth() if multiple elements share role+name
    if (totalCount > 1) {
      locator = locator.nth(seenIndex);
    }

    refMap.set(ref, locator);

    // Format output line
    let outputLine = `${indent}@${ref} [${node.role}]`;
    if (node.name) outputLine += ` "${node.name}"`;
    if (node.props) outputLine += ` ${node.props}`;
    if (node.children) outputLine += `: ${node.children}`;

    output.push(outputLine);
  }

  // Cursor-interactive detection: supplement ARIA tree with DOM-level scan
  if (opts.cursor) {
    const result = await appendCursorElements(page, opts, output, refMap, refCounter, bm);
    bm.setLastSnapshot(result, args);
    return result;
  }

  // Store ref map and rendered snapshot on BrowserManager
  bm.setRefMap(refMap);

  if (output.length === 0) {
    bm.setLastSnapshot('(no interactive elements found)', args);
    return '(no interactive elements found)';
  }

  const rendered = output.join('\n');
  bm.setLastSnapshot(rendered, args);
  return rendered;
}

/**
 * Scan DOM for cursor-interactive elements, assign refs, append to output.
 * Called when -C flag is active.
 */
async function appendCursorElements(
  page: Page,
  opts: SnapshotOptions,
  output: string[],
  refMap: Map<string, Locator>,
  refCounter: number,
  bm: BrowserManager,
): Promise<string> {
  const cursorElements = await findCursorInteractiveElements(page, opts.selector);

  if (cursorElements.length > 0) {
    output.push('');
    output.push('[cursor-interactive]');

    for (const elem of cursorElements) {
      const ref = `e${refCounter++}`;

      // Build Playwright locator via CSS selector.
      // Use nth(selectorIndex) — the actual index among all DOM matches —
      // instead of a seen-counter which can misalign when non-cursor siblings
      // share the same selector.
      let baseLocator: Locator;
      if (opts.selector) {
        baseLocator = page.locator(opts.selector).locator(elem.cssSelector);
      } else {
        baseLocator = page.locator(elem.cssSelector);
      }
      const locator = baseLocator.nth(elem.selectorIndex);

      refMap.set(ref, locator);

      // Format: @e15 [div.cursor] "Add to cart" (cursor:pointer)
      const tagDisplay = elem.tag + (elem.className ? '.' + elem.className.split(/\s+/)[0] : '');
      let outputLine = `@${ref} [${tagDisplay}]`;
      if (elem.text) outputLine += ` "${elem.text}"`;
      outputLine += ` (${elem.reason})`;

      output.push(outputLine);
    }
  }

  // Store ref map on BrowserManager
  bm.setRefMap(refMap);

  if (output.length === 0) {
    return '(no interactive elements found)';
  }

  return output.join('\n');
}
