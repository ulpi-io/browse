/**
 * Command registry — single source of truth for all browse commands.
 *
 * Replaces hand-maintained READ/WRITE/META sets with typed CommandSpec
 * registrations. Server routing, MCP exposure, CLI help, and future
 * plugin registration all derive from this registry.
 */

import { CommandRegistry, type CommandSpec } from './command';
import type { CommandCategory } from './events';

// ─── Singleton Registry ──────────────────────────────────────────

export const registry = new CommandRegistry();

// ─── Compact helpers ─────────────────────────────────────────────

const r = (name: string, description: string, opts?: Partial<Omit<CommandSpec, 'name' | 'category' | 'description'>>): CommandSpec =>
  ({ name, category: 'read', description, ...opts });

const w = (name: string, description: string, opts?: Partial<Omit<CommandSpec, 'name' | 'category' | 'description'>>): CommandSpec =>
  ({ name, category: 'write', description, ...opts });

const m = (name: string, description: string, opts?: Partial<Omit<CommandSpec, 'name' | 'category' | 'description'>>): CommandSpec =>
  ({ name, category: 'meta', description, ...opts });

// ─── Read Commands ───────────────────────────────────────────────

registry.registerAll([
  r('text',           'Extract visible text from page',                     { safeToRetry: true, pageContent: true, mcp: {
    description: 'Extract all visible text from the current page. Uses a TreeWalker that skips hidden elements, scripts, and styles. Returns clean text with one line per text node. Use this as the primary way to read page content.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('html',           'Get HTML source or element innerHTML',               { usage: '[sel]', safeToRetry: true, pageContent: true, mcp: {
    description: 'Get the full HTML source of the current page, or the innerHTML of a specific element. Use for inspecting raw markup or extracting structured data. Returns the full page HTML when no selector is given, or the inner HTML of the matched element.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e3") to get innerHTML of a specific element. Omit for full page HTML.' } } },
    argDecode: (p) => p.selector ? [String(p.selector)] : [],
  } }),
  r('links',          'List all links on page',                             { safeToRetry: true, pageContent: true, mcp: {
    description: 'List all links on the current page. Returns each link as "text -> href" on its own line. Use to discover navigation options or find specific URLs.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('forms',          'Extract form structures as JSON',                    { safeToRetry: true, pageContent: true, mcp: {
    description: 'Extract all form structures from the current page as JSON. Returns form action, method, and all input/select/textarea fields with their types, names, and current values. Use to understand form layout before filling.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('accessibility',  'Raw ARIA accessibility tree',                        { safeToRetry: true, pageContent: true, mcp: {
    description: 'Get the raw ARIA accessibility tree of the current page. Returns the Playwright ariaSnapshot() output. For a more useful version with clickable @refs, use browse_snapshot instead.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('js',             'Evaluate JavaScript expression',                     { usage: '<expr>', pageContent: true, mcp: {
    description: 'Evaluate a JavaScript expression in the page context and return the result. Use for extracting data, checking variables, or running computations in the browser. Returns stringified result (objects as JSON).',
    inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'JavaScript expression to evaluate in the page context.' } }, required: ['expression'] },
    argDecode: (p) => [String(p.expression)],
  } }),
  r('eval',           'Evaluate JavaScript file',                           { usage: '<file>', pageContent: true, mcp: {
    description: 'Evaluate a JavaScript file in the page context. Reads the file from disk and runs its contents. Returns the result of the last expression.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to a JavaScript file to evaluate.' } }, required: ['file'] },
    argDecode: (p) => [String(p.file)],
  } }),
  r('css',            'Get computed CSS property',                          { usage: '<sel> <prop>', safeToRetry: true, mcp: {
    description: 'Get the computed CSS property value of an element. Use to check styles like color, display, font-size, etc. Returns the computed value string.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the element.' }, property: { type: 'string', description: 'CSS property name (e.g. "color", "display", "font-size").' } }, required: ['selector', 'property'] },
    argDecode: (p) => [String(p.selector), String(p.property)],
  } }),
  r('attrs',          'Get element attributes as JSON',                     { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Get all HTML attributes of an element as a JSON object. Use to inspect data attributes, ARIA roles, classes, etc. Returns { attrName: value } pairs.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the element.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('element-state',  'Element visibility, enabled, checked state',         { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Get the full state of an element: visible, enabled, checked, editable, focused, tag, type, value, and bounding box. Returns JSON. Use to verify element state before interacting.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the element.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('dialog',         'Last dialog info',                                   { safeToRetry: true, mcp: {
    description: 'Get info about the last browser dialog (alert, confirm, prompt). Returns JSON with type, message, and defaultValue. Returns "(no dialog detected)" if no dialog has appeared.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('console',        'Console log buffer',                                 { usage: '[--clear]', safeToRetry: true, pageContent: true, skipRecording: true, mcp: {
    description: 'Read the browser console log buffer. Returns timestamped entries with level (log, warn, error, info). Use --clear to empty the buffer after reading.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'Clear the console buffer after reading.' } } },
    argDecode: (p) => p.clear ? ['--clear'] : [],
  } }),
  r('network',        'Network request buffer',                             { usage: '[--clear]', safeToRetry: true, pageContent: true, skipRecording: true, mcp: {
    description: 'Read the network request log buffer. Returns each request with method, URL, status, duration, and size. Use --clear to empty the buffer after reading.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'Clear the network buffer after reading.' } } },
    argDecode: (p) => p.clear ? ['--clear'] : [],
  } }),
  r('cookies',        'Browser cookies as JSON',                            { safeToRetry: true, mcp: {
    description: 'Get all browser cookies as a JSON array. Each cookie includes name, value, domain, path, expires, secure, httpOnly, and sameSite.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('storage',        'localStorage/sessionStorage',                        { usage: '[set <k> <v>]', mcp: {
    description: 'Get localStorage and sessionStorage contents as JSON. Can also set a localStorage key/value pair.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Set to "set" to store a value. Omit to read all storage.', enum: ['set'] }, key: { type: 'string', description: 'Storage key (required when action is "set").' }, value: { type: 'string', description: 'Storage value (used with action "set", defaults to empty string).' } } },
    argDecode: (p) => {
      if (p.action === 'set') return ['set', String(p.key), String(p.value ?? '')];
      return [];
    },
  } }),
  r('perf',           'Navigation timing metrics',                          { safeToRetry: true, mcp: {
    description: 'Get page performance timing metrics: DNS lookup, TCP connect, SSL, TTFB, download, DOM parse, DOM ready, and total load time in milliseconds.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  r('devices',        'List available device names',                        { usage: '[filter]', safeToRetry: true, mcp: {
    description: 'List available device names for emulation. Includes iPhones, Pixels, iPads, and all Playwright built-in devices. Optionally filter by name.',
    inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Filter device names (case-insensitive substring match).' } } },
    argDecode: (p) => p.filter ? [String(p.filter)] : [],
  } }),
  r('value',          'Get input/select element value',                     { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Get the current value of an input, select, or textarea element. Returns the value string. Use to verify form field contents after filling.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the input element.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('count',          'Count elements matching selector',                   { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Count the number of elements matching a selector. Returns a number. Use to verify list lengths, check if elements exist, or count search results.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to count matches for.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('clipboard',      'Read or write clipboard',                            { usage: '[write <text>]', mcp: {
    description: 'Read or write the browser clipboard. Without action, reads the clipboard text. With action "write", sets the clipboard to the given text.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Set to "write" to write text to clipboard. Omit to read.', enum: ['write'] }, text: { type: 'string', description: 'Text to write to clipboard (required when action is "write").' } } },
    argDecode: (p) => {
      if (p.action === 'write') return ['write', String(p.text)];
      return [];
    },
  } }),
  r('box',            'Element bounding box',                               { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Get the bounding box (x, y, width, height) of an element as JSON. Coordinates are in pixels relative to the viewport. Use to determine element position for mouse operations.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the element.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('errors',         'Console errors buffer',                              { usage: '[--clear]', safeToRetry: true, mcp: {
    description: 'Get only error-level entries from the console buffer. Filters out log/warn/info. Use --clear to remove error entries from the buffer.',
    inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'Clear error entries from the buffer.' } } },
    argDecode: (p) => p.clear ? ['--clear'] : [],
  } }),
  r('layout',         'Computed layout properties for an element',          { usage: '<sel>', safeToRetry: true, mcp: {
    description: 'Get computed layout properties for an element and its positioning ancestors: display, position, z-index, box dimensions, margin, padding, overflow, font, color+background with contrast ratio. Supports @ref selectors.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the element.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  r('request',        'Inspect a single network entry in detail',          { usage: '<index|url-pattern>', safeToRetry: true, mcp: {
    description: 'Inspect a single network entry with full details: headers, bodies, timing. Search by buffer index (numeric) or URL pattern match (most recent match). Requires --network-bodies for body content.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Buffer index (e.g. "3") or URL pattern (e.g. "/api/cart").' } }, required: ['query'] },
    argDecode: (p) => [String(p.query)],
  } }),
  r('images',         'List page images with src, alt, and dimensions',   { usage: '[selector] [--limit N] [--inline]', safeToRetry: true, pageContent: true, mcp: {
    description: 'List <img> elements on the page with src, alt text, and dimensions. Optional selector to scope. --limit N caps results (default 100). --inline includes base64 data URL for same-origin images.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to scope image search' }, limit: { type: 'number', description: 'Maximum images to return (default 100)' }, inline: { type: 'boolean', description: 'Include base64 data URLs for same-origin images' } } },
    argDecode: (p: Record<string, unknown>) => {
      const args: string[] = [];
      if (p.selector) args.push(String(p.selector));
      if (p.limit) args.push('--limit', String(p.limit));
      if (p.inline) args.push('--inline');
      return args;
    },
  } }),
]);

// ─── Write Commands ──────────────────────────────────────────────

registry.registerAll([
  w('goto',            'Navigate to URL',                                   { usage: '<url>', mcp: {
    description: 'Navigate to a URL. Waits for DOMContentLoaded. Returns the HTTP status code. This is the primary way to open web pages. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to navigate to (e.g. "https://example.com").' } }, required: ['url'] },
    argDecode: (p) => [String(p.url)],
  } }),
  w('back',            'Browser back',                                      { mcp: {
    description: 'Navigate back in browser history (like clicking the back button). Returns the new URL. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  w('forward',         'Browser forward',                                   { mcp: {
    description: 'Navigate forward in browser history (like clicking the forward button). Returns the new URL. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  w('reload',          'Reload page',                                       { mcp: {
    description: 'Reload the current page. Waits for DOMContentLoaded. Returns the current URL. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  w('click',           'Click element',                                     { usage: '<sel> [--if-exists] [--if-visible]', mcp: {
    description: 'Click an element on the page. Supports CSS selectors and @ref identifiers from snapshot. When context is set to delta/full, response includes ARIA snapshot changes with clickable @refs.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e3") to click.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('dblclick',        'Double-click element',                              { usage: '<sel>', mcp: {
    description: 'Double-click an element. Use for elements that require double-click activation (text selection, list items, etc.). May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to double-click.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('rightclick',      'Right-click element',                               { usage: '<sel>', mcp: {
    description: 'Right-click (context click) an element. Use to trigger context menus. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to right-click.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('fill',            'Fill input field',                                  { usage: '<sel> <val> [--if-empty]', mcp: {
    description: 'Fill an input field with text. Clears existing content first, then types the value. Works with text inputs, textareas, and contenteditable elements. Use browse_snapshot to find the input ref first. May include a [context] line if the fill action triggers state changes.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the input element.' }, value: { type: 'string', description: 'Text value to fill into the input.' } }, required: ['selector', 'value'] },
    argDecode: (p) => [String(p.selector), String(p.value)],
  } }),
  w('select',          'Select dropdown option',                            { usage: '<sel> <val>', mcp: {
    description: 'Select an option in a dropdown/select element by value or label. Use browse_forms to see available options first. May include a [context] line if the selection triggers state changes.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the select element.' }, value: { type: 'string', description: 'Option value or visible text to select.' } }, required: ['selector', 'value'] },
    argDecode: (p) => [String(p.selector), String(p.value)],
  } }),
  w('hover',           'Hover element',                                     { usage: '<sel> [--if-exists] [--if-visible]', mcp: {
    description: 'Hover over an element. Triggers mouseover/mouseenter events. Use to reveal tooltips, dropdown menus, or hover-activated content. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to hover over.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('focus',           'Focus element',                                     { usage: '<sel> [--if-exists] [--if-visible]', mcp: {
    description: 'Focus an element. Use to bring keyboard focus to an input or interactive element before typing.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to focus.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('check',           'Check checkbox',                                    { usage: '<sel> [--if-unchecked]', mcp: {
    description: 'Check a checkbox or radio button. Ensures the element becomes checked. No-op if already checked. May include a [context] line if the action triggers state changes.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the checkbox/radio.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('uncheck',         'Uncheck checkbox',                                  { usage: '<sel>', mcp: {
    description: 'Uncheck a checkbox. Ensures the element becomes unchecked. No-op if already unchecked. May include a [context] line if the action triggers state changes.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the checkbox.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('tap',             'Tap element (touch)',                                { usage: '<sel> [--if-exists] [--if-visible]', mcp: {
    description: 'Tap an element (touch event). Requires a touch-enabled context — use browse_emulate with a mobile device first. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to tap.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('type',            'Type text via keyboard',                            { usage: '<text>', mcp: {
    description: 'Type text via the keyboard into the focused element. Does NOT clear existing content (unlike fill). Use for search boxes with autocomplete. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to type via keyboard.' } }, required: ['text'] },
    argDecode: (p) => [String(p.text)],
  } }),
  w('press',           'Press key (Enter, Tab, etc.)',                       { usage: '<key>', mcp: {
    description: 'Press a single key on the keyboard. Use for Enter, Tab, Escape, ArrowDown, etc. Supports key combinations like "Control+A". May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "Control+A").' } }, required: ['key'] },
    argDecode: (p) => [String(p.key)],
  } }),
  w('keydown',         'Key down event',                                    { usage: '<key>', mcp: {
    description: 'Press a key down (without releasing). Use with browse_keyup for hold-and-release patterns like Shift+click.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key to press down (e.g. "Shift", "Control", "Alt").' } }, required: ['key'] },
    argDecode: (p) => [String(p.key)],
  } }),
  w('keyup',           'Key up event',                                      { usage: '<key>', mcp: {
    description: 'Release a key that was pressed down. Use after browse_keydown to complete a hold-and-release pattern.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key to release (e.g. "Shift", "Control", "Alt").' } }, required: ['key'] },
    argDecode: (p) => [String(p.key)],
  } }),
  w('keyboard',        'Keyboard action (inserttext)',                       { usage: 'inserttext <text>', mcp: {
    description: 'Low-level keyboard operations. Currently supports insertText which inserts text without triggering key events (useful for IME-like input).',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Keyboard action.', enum: ['inserttext'] }, text: { type: 'string', description: 'Text to insert (required for inserttext).' } }, required: ['action', 'text'] },
    argDecode: (p) => [String(p.action), String(p.text)],
  } }),
  w('scroll',          'Scroll element or direction',                       { usage: '[sel|up|down]', mcp: {
    description: 'Scroll the page or an element into view. Use "up"/"down" for viewport scrolling, "bottom" to scroll to page end, or a selector to scroll that element into view.',
    inputSchema: { type: 'object', properties: { target: { type: 'string', description: '"up", "down", "bottom", or a CSS selector/@ref to scroll into view. Omit to scroll to bottom.' } } },
    argDecode: (p) => p.target ? [String(p.target)] : [],
  } }),
  w('scrollinto',      'Scroll element into view',                          { usage: '<sel>', mcp: {
    description: 'Scroll an element into view if it is not already visible. Alias for scroll with a selector. Use before clicking elements that might be off-screen.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to scroll into view.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('scrollintoview',  'Scroll element into view (alias)',                  { usage: '<sel>', mcp: {
    description: 'Scroll an element into view. Alias for scrollinto.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref of the element to scroll into view.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('swipe',           'Swipe gesture',                                     { usage: '<up|down|left|right> [px]', mcp: {
    description: 'Perform a swipe gesture from the center of the viewport. Dispatches touch events. Use for carousels, pull-to-refresh, or swipe-to-dismiss. May include a [context] line showing state changes.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', description: 'Swipe direction.', enum: ['up', 'down', 'left', 'right'] }, distance: { type: 'number', description: 'Swipe distance in pixels (default: 70% of viewport).' } }, required: ['direction'] },
    argDecode: (p) => {
      const args = [String(p.direction)];
      if (p.distance != null) args.push(String(p.distance));
      return args;
    },
  } }),
  w('mouse',           'Mouse action (move, down, up, wheel)',              { usage: '<action> <args...>', mcp: {
    description: 'Low-level mouse operations: move to coordinates, mouse button down/up, wheel scroll, or click at coordinates. Use for precise positioning, drag operations, or hover states.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Mouse action to perform.', enum: ['move', 'down', 'up', 'wheel', 'click'] }, x: { type: 'number', description: 'X coordinate (required for move and click).' }, y: { type: 'number', description: 'Y coordinate (required for move and click).' }, button: { type: 'string', description: 'Mouse button for down/up/click (default: "left").', enum: ['left', 'right', 'middle'] }, dy: { type: 'number', description: 'Vertical scroll amount for wheel (positive = down).' }, dx: { type: 'number', description: 'Horizontal scroll amount for wheel (default: 0).' } }, required: ['action'] },
    argDecode: (p) => {
      const act = String(p.action);
      const args = [act];
      if (act === 'move' || act === 'click') {
        args.push(String(p.x), String(p.y));
        if (act === 'click' && p.button) args.push(String(p.button));
      } else if (act === 'down' || act === 'up') {
        if (p.button) args.push(String(p.button));
      } else if (act === 'wheel') {
        args.push(String(p.dy));
        if (p.dx != null) args.push(String(p.dx));
      }
      return args;
    },
  } }),
  w('wait',            'Wait for element/URL/network/request',               { usage: '<sel|ms|--url|--network-idle|--request>', mcp: {
    description: 'Wait for various conditions: element visibility, URL match, text appearance, JS expression, network idle, network request match, or a fixed time. Use to synchronize with page loading or async operations.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to wait for. Mutually exclusive with other wait modes.' }, state: { type: 'string', description: 'Wait for element state (used with selector).', enum: ['visible', 'hidden', 'attached', 'detached'] }, timeout: { type: 'number', description: 'Timeout in milliseconds (default: 15000).' }, url: { type: 'string', description: 'URL pattern to wait for (e.g. "**/success*").' }, text: { type: 'string', description: 'Wait for this text to appear in the page body.' }, fn: { type: 'string', description: 'JavaScript expression to wait for (must become truthy).' }, load: { type: 'string', description: 'Wait for load state.', enum: ['load', 'domcontentloaded', 'networkidle'] }, network_idle: { type: 'boolean', description: 'Wait for network to settle (no pending requests).' }, request: { type: 'string', description: 'Wait for a matching network request (e.g. "POST /api/order"). Polls network buffer.' }, status: { type: 'number', description: 'Expected HTTP status code (use with request).' }, ms: { type: 'number', description: 'Wait for a fixed number of milliseconds.' }, download: { type: 'boolean', description: 'Wait for a download to complete.' }, download_path: { type: 'string', description: 'Save downloaded file to this path (used with download).' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.network_idle) {
        args.push('--network-idle');
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.request) {
        args.push('--request', String(p.request));
        if (p.status != null) args.push('--status', String(p.status));
        if (p.timeout) args.push('--timeout', String(p.timeout));
      } else if (p.url) {
        args.push('--url', String(p.url));
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.text) {
        args.push('--text', String(p.text));
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.fn) {
        args.push('--fn', String(p.fn));
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.load) {
        args.push('--load', String(p.load));
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.download) {
        args.push('--download');
        if (p.download_path) args.push(String(p.download_path));
        if (p.timeout) args.push(String(p.timeout));
      } else if (p.ms) {
        args.push(String(p.ms));
      } else if (p.selector) {
        args.push(String(p.selector));
        if (p.state) { args.push('--state', String(p.state)); }
        if (p.timeout) args.push(String(p.timeout));
      }
      return args;
    },
  } }),
  w('viewport',        'Set viewport size',                                 { usage: '<WxH>', mcp: {
    description: 'Set the browser viewport size. Use for responsive testing or to match specific device dimensions. Format: WxH (e.g. "375x812").',
    inputSchema: { type: 'object', properties: { size: { type: 'string', description: 'Viewport size as "WxH" (e.g. "375x812", "1920x1080").' } }, required: ['size'] },
    argDecode: (p) => [String(p.size)],
  } }),
  w('cookie',          'Set cookie',                                        { usage: '<n>=<v>', mcp: {
    description: 'Manage browser cookies. Set a single cookie, clear all cookies, set with options (domain, secure, expires, sameSite), or export/import cookies to/from a JSON file.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Cookie action.', enum: ['set', 'clear', 'export', 'import'] }, name: { type: 'string', description: 'Cookie name (required for "set").' }, value: { type: 'string', description: 'Cookie value (required for "set").' }, domain: { type: 'string', description: 'Cookie domain (optional for "set", defaults to current page domain).' }, secure: { type: 'boolean', description: 'Set the Secure flag (optional for "set").' }, expires: { type: 'number', description: 'Cookie expiration as Unix timestamp (optional for "set").' }, sameSite: { type: 'string', description: 'SameSite attribute.', enum: ['Strict', 'Lax', 'None'] }, path: { type: 'string', description: 'Cookie path (optional for "set", defaults to "/").' }, file: { type: 'string', description: 'File path for export/import operations.' }, name_value: { type: 'string', description: 'Legacy format: "name=value" to set a cookie quickly.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.action === 'clear') {
        args.push('clear');
      } else if (p.action === 'export') {
        args.push('export', String(p.file));
      } else if (p.action === 'import') {
        args.push('import', String(p.file));
      } else if (p.action === 'set') {
        args.push('set', String(p.name), String(p.value));
        if (p.domain) { args.push('--domain', String(p.domain)); }
        if (p.secure) { args.push('--secure'); }
        if (p.expires != null) { args.push('--expires', String(p.expires)); }
        if (p.sameSite) { args.push('--sameSite', String(p.sameSite)); }
        if (p.path) { args.push('--path', String(p.path)); }
      } else if (p.name_value) {
        args.push(String(p.name_value));
      } else {
        if (p.name && p.value) {
          args.push(`${p.name}=${p.value}`);
        }
      }
      return args;
    },
  } }),
  w('header',          'Set extra HTTP header',                             { usage: '<n>:<v>', mcp: {
    description: 'Set an extra HTTP header that will be sent with every subsequent request. Use for API keys, auth tokens, or custom headers.',
    inputSchema: { type: 'object', properties: { header: { type: 'string', description: 'Header in "Name:Value" format (e.g. "Authorization:Bearer token123").' } }, required: ['header'] },
    argDecode: (p) => [String(p.header)],
  } }),
  w('useragent',       'Set user agent',                                    { usage: '<str>', mcp: {
    description: 'Set the browser User-Agent string. Recreates the browser context (preserves cookies and tabs, but resets localStorage). For full device emulation, use browse_emulate instead.',
    inputSchema: { type: 'object', properties: { useragent: { type: 'string', description: 'The User-Agent string to set.' } }, required: ['useragent'] },
    argDecode: (p) => [String(p.useragent)],
  } }),
  w('upload',          'Upload files to input',                             { usage: '<sel> <files...>', mcp: {
    description: 'Upload files to a file input element. Supports multiple files. The files must exist on the local filesystem.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the file input element.' }, files: { type: 'string', description: 'Space-separated file paths to upload.' } }, required: ['selector', 'files'] },
    argDecode: (p) => {
      const files = String(p.files).split(/\s+/);
      return [String(p.selector), ...files];
    },
  } }),
  w('dialog-accept',   'Accept next dialog',                                { usage: '[text]', mcp: {
    description: 'Set the browser to automatically accept the next dialog (alert, confirm, prompt). Optionally provide text for prompt dialogs. Call before the action that triggers the dialog.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to enter in a prompt dialog (optional).' } } },
    argDecode: (p) => p.text ? [String(p.text)] : [],
  } }),
  w('dialog-dismiss',  'Dismiss next dialog',                               { mcp: {
    description: 'Set the browser to automatically dismiss the next dialog (click Cancel/No). Call before the action that triggers the dialog.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  w('emulate',         'Emulate device or reset',                           { usage: '<device>|reset', mcp: {
    description: 'Emulate a mobile device or reset to desktop. Sets viewport, user agent, device scale factor, touch, and mobile flags. Use "reset" to return to 1920x1080 desktop. Preserves cookies and tabs.',
    inputSchema: { type: 'object', properties: { device: { type: 'string', description: 'Device name (e.g. "iPhone 15", "Pixel 7", "iPad Pro 11") or "reset" for desktop. Run browse_devices to see all options.' } }, required: ['device'] },
    argDecode: (p) => [String(p.device)],
  } }),
  w('drag',            'Drag from source to target',                        { usage: '<src> <tgt>', mcp: {
    description: 'Drag an element from source to target. Both support CSS selectors and @refs. May include a [context] line showing state changes after the action.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'CSS selector or @ref for the element to drag.' }, target: { type: 'string', description: 'CSS selector or @ref for the drop target.' } }, required: ['source', 'target'] },
    argDecode: (p) => [String(p.source), String(p.target)],
  } }),
  w('highlight',       'Highlight element with overlay',                    { usage: '<sel>', mcp: {
    description: 'Add a visual highlight (red outline) to an element. Use for debugging or visual verification. The highlight persists until the page is reloaded.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref to highlight.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  w('download',        'Download file by clicking element',                 { usage: '<sel> [path]', mcp: {
    description: 'Click an element that triggers a download and save the file. Returns the saved file path.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector or @ref for the download trigger element.' }, path: { type: 'string', description: 'File path to save the download to (defaults to suggested filename).' } }, required: ['selector'] },
    argDecode: (p) => {
      const args = [String(p.selector)];
      if (p.path) args.push(String(p.path));
      return args;
    },
  } }),
  w('route',           'Intercept network requests',                        { usage: '<pattern> block|fulfill', mcp: {
    description: 'Intercept network requests matching a URL pattern. Block requests (abort them) or fulfill them with a custom response. Use "clear" to remove all routes.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'URL pattern to match (e.g. "**/*.png", "**/api/*") or "clear" to remove all routes.' }, action: { type: 'string', description: 'What to do with matching requests.', enum: ['block', 'fulfill'] }, status: { type: 'number', description: 'HTTP status code for fulfill (default: 200).' }, body: { type: 'string', description: 'Response body for fulfill (default: empty).' } }, required: ['pattern'] },
    argDecode: (p) => {
      const args = [String(p.pattern)];
      if (p.pattern !== 'clear') {
        if (p.action) args.push(String(p.action));
        if (p.action === 'fulfill') {
          if (p.status != null) args.push(String(p.status));
          if (p.body) args.push(String(p.body));
        }
      }
      return args;
    },
  } }),
  w('offline',         'Toggle offline mode',                               { usage: '[on|off]', mcp: {
    description: 'Toggle offline mode, simulating network disconnection. Use "on"/"off" to set explicitly, or omit to toggle.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', description: '"on" to enable offline, "off" to disable, omit to toggle.', enum: ['on', 'off'] } } },
    argDecode: (p) => p.mode ? [String(p.mode)] : [],
  } }),
  w('set',             'Change settings (context, geo, media)',             { usage: '<key> <value>', mcp: {
    description: 'Configure browser settings: geolocation, color scheme, or context level (state/delta/full).',
    inputSchema: { type: 'object', properties: { subcommand: { type: 'string', description: 'Setting to configure.', enum: ['geo', 'media', 'context'] }, lat: { type: 'number', description: 'Latitude for geolocation (required for "geo").' }, lng: { type: 'number', description: 'Longitude for geolocation (required for "geo").' }, scheme: { type: 'string', description: 'Color scheme for media (required for "media").', enum: ['dark', 'light', 'no-preference'] }, value: { type: 'string', description: 'Context level (required for "context").', enum: ['off', 'state', 'delta', 'full'] } }, required: ['subcommand'] },
    argDecode: (p) => {
      const sub = String(p.subcommand);
      const args = [sub];
      if (sub === 'geo') {
        args.push(String(p.lat), String(p.lng));
      } else if (sub === 'media') {
        args.push(String(p.scheme));
      } else if (sub === 'context') {
        if (p.value) args.push(String(p.value));
      }
      return args;
    },
  } }),
  w('initscript',      'Manage init scripts',                               { usage: 'set <code>|clear|show', mcp: {
    description: 'Inject JavaScript that runs before every page load (via context.addInitScript). Useful for mocking APIs, injecting polyfills, or setting up performance observers. Scripts persist across navigations and survive device emulation.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Operation to perform.', enum: ['set', 'show', 'clear'] }, code: { type: 'string', description: 'JavaScript code to inject (required for "set").' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.action === 'set' && p.code) args.push(String(p.code));
      return args;
    },
  } }),
]);

// ─── Meta Commands ───────────────────────────────────────────────

registry.registerAll([
  m('tabs',             'List all tabs',                                    { safeToRetry: true, mcp: {
    description: 'List all open browser tabs with their IDs, titles, and URLs. The active tab is marked with an arrow. Use tab IDs with browse_tab to switch.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('tab',              'Switch to tab',                                    { usage: '<id>', mcp: {
    description: 'Switch to a specific browser tab by its ID. Get tab IDs from browse_tabs.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Tab ID to switch to.' } }, required: ['id'] },
    argDecode: (p) => [String(p.id)],
  } }),
  m('newtab',           'Open new tab',                                     { usage: '[url]', mcp: {
    description: 'Open a new browser tab, optionally navigating to a URL. Returns the new tab ID.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open in the new tab (optional).' } } },
    argDecode: (p) => p.url ? [String(p.url)] : [],
  } }),
  m('closetab',         'Close tab',                                        { usage: '[id]', mcp: {
    description: 'Close a browser tab by ID. If no ID is given, closes the current tab.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Tab ID to close (optional, defaults to current tab).' } } },
    argDecode: (p) => p.id != null ? [String(p.id)] : [],
  } }),
  m('status',           'Server health report',                             { safeToRetry: true, skipRecording: true, mcp: {
    description: 'Get server health status including current URL, number of tabs, PID, uptime, and active sessions.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('url',              'Current page URL',                                 { safeToRetry: true, mcp: {
    description: 'Get the current page URL. Quick way to check where the browser is.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('stop',             'Stop server',                                      { skipRecording: true, mcp: {
    description: 'Stop the browse server. The server will shut down after a brief delay.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('restart',          'Restart server',                                   { skipRecording: true, mcp: {
    description: 'Restart the browse server. Useful after configuration changes or to reset browser state.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('screenshot',       'Full-page screenshot',                             { usage: '[sel|@ref] [path] [--full]', mcp: {
    description: 'Take a screenshot of the current page. Supports full-page capture, element-specific screenshots, region clipping, and annotated screenshots with numbered interactive elements.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to save the screenshot (default: .browse/browse-screenshot.png).' }, full: { type: 'boolean', description: 'Capture the full scrollable page (not just the viewport).' }, selector: { type: 'string', description: 'CSS selector or @ref to screenshot a specific element.' }, clip: { type: 'string', description: 'Clip region as "x,y,width,height" (cannot combine with --full or selector).' }, annotate: { type: 'boolean', description: 'Add numbered badges to interactive elements with a legend.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.annotate) args.push('--annotate');
      if (p.full) args.push('--full');
      if (p.clip) { args.push('--clip', String(p.clip)); }
      if (p.selector) args.push(String(p.selector));
      if (p.path) args.push(String(p.path));
      return args;
    },
  } }),
  m('pdf',              'Save page as PDF',                                 { usage: '[path]', mcp: {
    description: 'Save the current page as a PDF file. Uses A4 format.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to save the PDF (default: .browse/browse-page.pdf).' } } },
    argDecode: (p) => p.path ? [String(p.path)] : [],
  } }),
  m('responsive',       'Multi-viewport screenshots',                       { usage: '[prefix]', mcp: {
    description: 'Take screenshots at mobile (375x812), tablet (768x1024), and desktop (1920x1080) viewports. Saves three PNG files with -mobile, -tablet, -desktop suffixes.',
    inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'File path prefix for the screenshots (default: .browse/browse-responsive).' } } },
    argDecode: (p) => p.prefix ? [String(p.prefix)] : [],
  } }),
  m('chain',            'Execute command sequence (stdin JSON)',             { skipRecording: true, mcp: {
    description: 'Execute a sequence of commands in order. Pass a JSON array of command arrays. Each command is [name, ...args]. Results are returned for each step. Failed steps show errors without stopping the chain.',
    inputSchema: { type: 'object', properties: { commands: { type: 'string', description: 'JSON array of commands, e.g. [["goto","https://example.com"],["text"],["click","@e3"]]' } }, required: ['commands'] },
    argDecode: (p) => [String(p.commands)],
  } }),
  m('diff',             'Text diff between two pages',                      { usage: '<url1> <url2>', mcp: {
    description: 'Compare the visible text of two URLs using a unified diff format. Opens each URL in a temporary tab, extracts text, and shows additions/removals.',
    inputSchema: { type: 'object', properties: { url1: { type: 'string', description: 'First URL to compare.' }, url2: { type: 'string', description: 'Second URL to compare.' } }, required: ['url1', 'url2'] },
    argDecode: (p) => [String(p.url1), String(p.url2)],
  } }),
  m('snapshot',         'Accessibility tree with @refs',                    { usage: '[-i] [-f] [-V] [-c] [-C] [-d N] [-s sel] [--offset N] [--max-chars N] [--serp]', safeToRetry: true, pageContent: true, mcp: {
    description: 'Get the accessibility tree of the current page with @ref identifiers for each element. Use -i for interactive elements only (the most common usage). Refs like @e1, @e2 can be used with click, fill, and other commands. This is the primary way to understand page structure and find elements to interact with.',
    inputSchema: { type: 'object', properties: { interactive: { type: 'boolean', description: 'Show only interactive elements (buttons, links, inputs, etc.). This is the most commonly used mode.' }, compact: { type: 'boolean', description: 'Remove empty structural elements from the tree.' }, cursor: { type: 'boolean', description: 'Include cursor-interactive elements (divs with onclick, cursor:pointer, etc.) that are not in the ARIA tree.' }, depth: { type: 'number', description: 'Limit the tree depth (e.g. 3 = only top 3 levels).' }, selector: { type: 'string', description: 'CSS selector to scope the snapshot to a subtree.' }, viewport: { type: 'boolean', description: 'Only include elements visible in the current viewport.' }, full: { type: 'boolean', description: 'Show full indented ARIA tree with props and children (overrides the default terse flat list when -i is used).' }, offset: { type: 'number', description: 'Character offset for snapshot windowing. Use to paginate through large snapshots.' }, maxChars: { type: 'number', description: 'Maximum characters to return (default: 80000). Large snapshots are truncated with pagination hints.' }, serp: { type: 'boolean', description: 'Enable Google SERP fast-path extraction. When on a Google search results page, extracts results via DOM instead of ARIA snapshot for ~2x speed.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.interactive) args.push('-i');
      if (p.compact) args.push('-c');
      if (p.cursor) args.push('-C');
      if (p.viewport) args.push('-V');
      if (p.full) args.push('-f');
      if (p.depth != null) { args.push('-d', String(p.depth)); }
      if (p.selector) { args.push('-s', String(p.selector)); }
      if (p.offset != null) { args.push('--offset', String(p.offset)); }
      if (p.maxChars != null) { args.push('--max-chars', String(p.maxChars)); }
      if (p.serp) args.push('--serp');
      return args;
    },
  } }),
  m('snapshot-diff',    'Diff current vs last snapshot',                    { safeToRetry: true, skipRecording: true, mcp: {
    description: 'Compare the current page accessibility snapshot with the previous one. Shows additions and removals in unified diff format. Run browse_snapshot first to establish a baseline.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('screenshot-diff',  'Pixel-diff two screenshots',                       { usage: '<baseline> [current]', skipRecording: true, mcp: {
    description: 'Pixel-diff two screenshots. Compares a baseline image with the current page (or another image). Returns mismatch percentage and PASS/FAIL result. Saves a diff image on failure.',
    inputSchema: { type: 'object', properties: { baseline: { type: 'string', description: 'Path to the baseline screenshot PNG file.' }, current: { type: 'string', description: 'Path to the current screenshot (optional — takes a live screenshot if omitted).' }, threshold: { type: 'number', description: 'Mismatch percentage threshold for PASS/FAIL (default: 0.1).' }, full: { type: 'boolean', description: 'Use full-page screenshot for the current image.' } }, required: ['baseline'] },
    argDecode: (p) => {
      const args = [String(p.baseline)];
      if (p.current) args.push(String(p.current));
      if (p.threshold != null) { args.push('--threshold', String(p.threshold)); }
      if (p.full) args.push('--full');
      return args;
    },
  } }),
  m('sessions',         'List active sessions',                             { safeToRetry: true, skipRecording: true, mcp: {
    description: 'List all active browser sessions. Shows session ID, number of tabs, current URL, and idle time.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('session-close',    'Close a session',                                  { usage: '<id>', skipRecording: true, mcp: {
    description: 'Close a specific session by ID. Flushes buffers before closing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Session ID to close.' } }, required: ['id'] },
    argDecode: (p) => [String(p.id)],
  } }),
  m('frame',            'Target iframe or main page',                       { usage: '<sel>|main', safeToRetry: true, mcp: {
    description: 'Switch to an iframe context or return to the main page. All subsequent commands will execute within the targeted frame until you switch back with "main".',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector for the iframe, or "main"/"top" to return to the main page.' } }, required: ['selector'] },
    argDecode: (p) => [String(p.selector)],
  } }),
  m('state',            'Save/restore page state',                          { usage: 'save|load|list|show|clean [name]', mcp: {
    description: 'Save or restore page state (cookies, localStorage). Use save/load to persist and restore state across sessions. Use list to see saved states, show to inspect one.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'State operation.', enum: ['save', 'load', 'list', 'show', 'clean'] }, name: { type: 'string', description: 'State name (default: "default").' }, older_than: { type: 'number', description: 'For "clean" action: delete states older than this many days (default: 7).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.name) args.push(String(p.name));
      if (p.action === 'clean' && p.older_than != null) {
        args.push('--older-than', String(p.older_than));
      }
      return args;
    },
  } }),
  m('find',             'Find elements by role/text/label',                 { usage: 'role|text|label|placeholder|testid <query>', safeToRetry: true, mcp: {
    description: 'Find elements using semantic locators: by role, text, label, placeholder, test ID, alt text, title, or positional (first/last/nth). Returns match count and first match text.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Locator type.', enum: ['role', 'text', 'label', 'placeholder', 'testid', 'alt', 'title', 'first', 'last', 'nth'] }, query: { type: 'string', description: 'Search query or selector.' }, name: { type: 'string', description: 'For role: accessible name to match (optional). For nth: the CSS selector.' } }, required: ['type', 'query'] },
    argDecode: (p) => {
      const args = [String(p.type), String(p.query)];
      if (p.name) args.push(String(p.name));
      return args;
    },
  } }),
  m('auth',             'Credential vault operations',                      { usage: 'save|login|list|delete <args>', mcp: {
    description: 'Manage encrypted credentials for auto-login. Save credentials with URL and selectors, auto-login to saved sites, list or delete stored credentials.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Auth operation.', enum: ['save', 'login', 'list', 'delete'] }, name: { type: 'string', description: 'Credential name (required for save/login/delete).' }, url: { type: 'string', description: 'Login page URL (required for save).' }, username: { type: 'string', description: 'Username (required for save).' }, password: { type: 'string', description: 'Password (required for save).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.name) args.push(String(p.name));
      if (p.action === 'save') {
        if (p.url) args.push(String(p.url));
        if (p.username) args.push(String(p.username));
        if (p.password) args.push(String(p.password));
      }
      return args;
    },
  } }),
  m('har',              'HAR recording (start/stop)',                        { usage: 'start|stop [path]', mcp: {
    description: 'Record HTTP traffic in HAR (HTTP Archive) format. Start recording, then stop to save the HAR file. Use for debugging network issues or analyzing API calls.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'HAR operation.', enum: ['start', 'stop'] }, path: { type: 'string', description: 'File path to save the HAR file (used with "stop", default: .browse/browse-recording.har).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.action === 'stop' && p.path) args.push(String(p.path));
      return args;
    },
  } }),
  m('video',            'Video recording',                                  { usage: 'start [dir]|stop|status', mcp: {
    description: 'Record video of browser actions. Start recording to a directory, check status, or stop and save. Videos are saved as WebM files.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Video operation.', enum: ['start', 'stop', 'status'] }, dir: { type: 'string', description: 'Output directory for video files (used with "start").' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.action === 'start' && p.dir) args.push(String(p.dir));
      return args;
    },
  } }),
  m('inspect',          'DevTools inspect',                                 { mcp: {
    description: 'Get Chrome DevTools debugging URLs. Requires BROWSE_DEBUG_PORT environment variable to be set. Returns DevTools frontend URL, page info, and WebSocket URL.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('record',           'Record/export interactions',                       { usage: 'start|stop|status|export', safeToRetry: true, skipRecording: true, mcp: {
    description: 'Record a sequence of browse commands for later replay. Start recording, execute commands, then stop and export as browse chain JSON, Chrome DevTools Recorder replay JSON, Playwright Test script, or flow YAML. The "playwright" format generates a complete @playwright/test file with proper assertions. The "flow" format produces YAML compatible with `flow <file>` and `flow run <name>`.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Record operation.', enum: ['start', 'stop', 'status', 'export'] }, format: { type: 'string', description: 'Export format (used with "export"). "browse" = chain JSON, "replay" = Chrome DevTools Recorder, "playwright" = Playwright Test script, "flow" = YAML flow file.', enum: ['browse', 'replay', 'playwright', 'flow'] }, path: { type: 'string', description: 'File path to save export (used with "export", optional — prints to stdout if omitted).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.action === 'export') {
        if (p.format) args.push(String(p.format));
        if (p.path) args.push(String(p.path));
      }
      return args;
    },
  } }),
  m('cookie-import',    'Import cookies from browser',                      { usage: '--list|<browser> [--domain <d>]', safeToRetry: true, skipRecording: true, mcp: {
    description: 'Import cookies from an installed Chromium browser (Chrome, Arc, Brave, Edge) into the browse session. Use --list to see available browsers.',
    inputSchema: { type: 'object', properties: { browser: { type: 'string', description: 'Browser name (e.g. "chrome", "arc", "brave", "edge") or omit with list=true to list browsers.' }, domain: { type: 'string', description: 'Domain to import cookies for (optional — imports all if omitted).' }, profile: { type: 'string', description: 'Browser profile name (optional).' }, list: { type: 'boolean', description: 'List installed browsers instead of importing.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.list) {
        args.push('--list');
      } else {
        if (p.browser) args.push(String(p.browser));
        if (p.domain) { args.push('--domain', String(p.domain)); }
        if (p.profile) { args.push('--profile', String(p.profile)); }
      }
      return args;
    },
  } }),
  m('doctor',           'System diagnostics',                               { safeToRetry: true, mcp: {
    description: 'Run diagnostics. Checks Node version, Playwright installation, Chromium availability, and server status.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('upgrade',          'Check for updates',                                { safeToRetry: true, mcp: {
    description: 'Upgrade @ulpi/browse to the latest version via npm.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('handoff',          'Session handoff to another agent',                  { usage: '[reason]', mcp: {
    description: 'Hand off the browser to the user for visual inspection. Opens a headed browser window for manual interaction. Use browse_resume to return to headless mode.',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'Message to display to the user explaining what to inspect.' } } },
    argDecode: (p) => p.message ? [String(p.message)] : [],
  } }),
  m('resume',           'Resume from handoff',                              { mcp: {
    description: 'Resume headless operation after a browse_handoff. Returns the current URL and a fresh snapshot.',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('profile',          'Profile management',                               { usage: 'list|delete|clean', mcp: {
    description: 'Manage persistent browser profiles. List profiles, delete a profile, or clean up old profiles.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Profile operation.', enum: ['list', 'delete', 'clean'] }, name: { type: 'string', description: 'Profile name (required for "delete").' }, older_than: { type: 'number', description: 'For "clean": delete profiles older than this many days (default: 7).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.action === 'delete' && p.name) args.push(String(p.name));
      if (p.action === 'clean' && p.older_than != null) {
        args.push('--older-than', String(p.older_than));
      }
      return args;
    },
  } }),
  m('react-devtools',   'React DevTools integration',                       { usage: 'enable|disable|tree|props|...', safeToRetry: true, mcp: {
    description: 'Inspect React components. Enable the React DevTools hook, view the component tree, get component props/state, check for suspense boundaries, errors, hydration issues, renders, owners, and context.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'DevTools operation.', enum: ['enable', 'disable', 'tree', 'props', 'suspense', 'errors', 'profiler', 'hydration', 'renders', 'owners', 'context'] }, selector: { type: 'string', description: 'CSS selector or @ref (required for props, owners, context).' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.selector) args.push(String(p.selector));
      return args;
    },
  } }),
  m('provider',         'Cloud provider management',                        { usage: 'save|list|delete <name> [api-key]', safeToRetry: true, mcp: {
    description: 'Manage cloud browser providers (Browserless, Browserbase). Save API keys, list configured providers, or delete credentials. Use "save" to store a provider API key, then set BROWSE_CDP_URL to connect via CDP.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Operation to perform.', enum: ['save', 'list', 'delete'] }, name: { type: 'string', description: 'Provider name (e.g. "browserless", "browserbase"). Required for save and delete.' }, api_key: { type: 'string', description: 'API key for the provider. Required for save.' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.name) args.push(String(p.name));
      if (p.api_key) args.push(String(p.api_key));
      return args;
    },
  } }),
  m('coverage',         'JS/CSS code coverage',                             { usage: 'start|stop', safeToRetry: true, mcp: {
    description: 'Collect JS and CSS code coverage. Start collection, navigate/interact with the page, then stop to see per-file used/unused bytes sorted by wasted bytes descending.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Coverage operation.', enum: ['start', 'stop'] } }, required: ['action'] },
    argDecode: (p) => [String(p.action)],
  } }),
  m('detect',           'Detect frameworks, CDN, SaaS',                     { safeToRetry: true, mcp: {
    description: 'Detect the technology stack of the current page. Returns frameworks (React, Vue, Angular, Next.js, Laravel, WordPress, Magento, etc. — 108 total with version, build mode, config depth), SaaS platforms (Shopify, Wix, Squarespace, etc. — 55 total with app enumeration and constraints), infrastructure (CDN, protocol, compression, caching, Service Worker), DOM complexity, and third-party inventory (88 known domains classified by category).',
    inputSchema: { type: 'object', properties: {} },
    argDecode: () => [],
  } }),
  m('perf-audit',       'Performance audit',                                { usage: '[url] [--json] [--budget lcp:2500,cls:0.1,tbt:300]', mcp: {
    description: 'Run a full performance audit on the current page (or a URL). Returns Core Web Vitals (LCP, CLS, TBT, FCP, TTFB, INP), LCP critical path reconstruction, layout shift attribution, long task script attribution, resource breakdown, render-blocking detection, image audit, font audit, DOM complexity, tech stack detection (108 frameworks, 55 SaaS platforms), third-party impact analysis, JS/CSS coverage, and prioritized recommendations. The page is reloaded as part of the audit. Use the budget parameter to enforce performance thresholds — fails with a pass/fail table if any metric exceeds its budget.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to audit. If provided, navigates there first. If omitted, audits the current page.' }, no_coverage: { type: 'boolean', description: 'Skip JS/CSS coverage collection (faster audit).' }, no_detect: { type: 'boolean', description: 'Skip framework/SaaS/infrastructure detection.' }, json: { type: 'boolean', description: 'Return structured JSON instead of formatted text.' }, budget: { type: 'string', description: 'Performance budget thresholds as comma-separated key:value pairs (e.g. "lcp:2500,cls:0.1,tbt:300"). Supported keys: lcp, cls, tbt, fcp, ttfb, inp. Metrics that were not measured are skipped. If any measured metric exceeds its threshold, an error is thrown with a pass/fail table.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.url) args.push(String(p.url));
      if (p.no_coverage) args.push('--no-coverage');
      if (p.no_detect) args.push('--no-detect');
      if (p.json) args.push('--json');
      if (p.budget) args.push('--budget', String(p.budget));
      return args;
    },
  } }),
  m('api',              'Run fetch() in page context with cookies/auth',    { usage: '<method> <url> [--body <json>] [--header <k:v>]', mcp: {
    description: 'Run a fetch() request inside the page context, inheriting cookies and authentication. Returns status, headers, and parsed body. Useful for API testing without leaving the current page.',
    inputSchema: { type: 'object', properties: { method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, etc.).' }, url: { type: 'string', description: 'API URL to request.' }, body: { type: 'string', description: 'Request body (JSON string). Content-Type defaults to application/json.' }, headers: { type: 'string', description: 'Custom headers as "Key: Value" (one per --header flag).' } }, required: ['method', 'url'] },
    argDecode: (p) => {
      const args = [String(p.method), String(p.url)];
      if (p.body) args.push('--body', String(p.body));
      if (p.headers) args.push('--header', String(p.headers));
      return args;
    },
  } }),
  m('expect',            'Assert page conditions',                          { usage: '--url|--text|--visible|--hidden|--count|--request [--timeout ms]', safeToRetry: true, mcp: {
    description: 'Assert one or more page conditions. Polls until all conditions pass or timeout expires. Conditions: --url (URL contains), --text (text visible), --visible (element visible), --hidden (element hidden), --count with --eq/--gt/--lt (element count), --request with optional --status (network request match). Returns "OK" on success, throws with per-condition FAIL details on timeout. Use --timeout 0 for a single check without polling.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Assert URL contains this string (e.g. "/checkout").' }, text: { type: 'string', description: 'Assert this text is visible on the page.' }, visible: { type: 'string', description: 'CSS selector or @ref that must be visible.' }, hidden: { type: 'string', description: 'CSS selector or @ref that must be hidden.' }, count_selector: { type: 'string', description: 'CSS selector to count elements for.' }, count_eq: { type: 'number', description: 'Assert element count equals this number (use with count_selector).' }, count_gt: { type: 'number', description: 'Assert element count is greater than this (use with count_selector).' }, count_lt: { type: 'number', description: 'Assert element count is less than this (use with count_selector).' }, request: { type: 'string', description: 'Match a network request (e.g. "POST /api/order").' }, status: { type: 'number', description: 'Expected HTTP status code (use with request).' }, timeout: { type: 'number', description: 'Timeout in milliseconds (default 3000). Use 0 for single check.' }, verbose: { type: 'boolean', description: 'Show per-condition PASS details on success.' } } },
    argDecode: (p) => {
      const args: string[] = [];
      if (p.url) args.push('--url', String(p.url));
      if (p.text) args.push('--text', String(p.text));
      if (p.visible) args.push('--visible', String(p.visible));
      if (p.hidden) args.push('--hidden', String(p.hidden));
      if (p.count_selector) {
        args.push('--count', String(p.count_selector));
        if (p.count_eq != null) args.push('--eq', String(p.count_eq));
        else if (p.count_gt != null) args.push('--gt', String(p.count_gt));
        else if (p.count_lt != null) args.push('--lt', String(p.count_lt));
      }
      if (p.request) {
        args.push('--request', String(p.request));
        if (p.status != null) args.push('--status', String(p.status));
      }
      if (p.timeout != null) args.push('--timeout', String(p.timeout));
      if (p.verbose) args.push('--verbose');
      return args;
    },
  } }),
  m('visual',           'Visual layout analysis + anomaly detection',       { safeToRetry: true, mcp: {
    description: 'Analyze the visual layout of the current page. Detects landmarks (header, nav, main, footer), contrast failures, element overlap, horizontal overflow, viewport bleed, and clipped content. Returns a structured report with viewport info, landmark tree, and issue list with severity.',
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'Return raw JSON instead of formatted text.' } } },
    argDecode: (p) => p.json ? ['--json'] : [],
  } }),
  m('a11y-audit',       'WCAG 2.1 AA accessibility audit',                 { safeToRetry: true, mcp: {
    description: 'Run an automated WCAG 2.1 AA accessibility audit. Checks: contrast ratios, missing alt text, inputs without labels, heading hierarchy, touch target sizes, generic link text, missing lang attribute. Returns score (0-100) + categorized findings.',
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'Return raw JSON instead of formatted text.' } } },
    argDecode: (p) => p.json ? ['--json'] : [],
  } }),
  m('sim',              'Simulator/emulator lifecycle',                     { usage: 'start|stop|status [--platform ios|android] [--device <name>] [--app <id-or-path>]', mcp: {
    description: 'Manage iOS simulator or Android emulator lifecycle. Start boots the simulator/emulator, optionally installs an app from a file path (.app/.ipa/.apk), and launches the browse runner. Stop kills the runner and optionally shuts down the device. Status shows the current runner health.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'Lifecycle action.', enum: ['start', 'stop', 'status'] }, platform: { type: 'string', description: 'Target platform.', enum: ['ios', 'android'] }, device: { type: 'string', description: 'Device name, UDID, or serial.' }, app: { type: 'string', description: 'Bundle ID, package name, or path to .app/.ipa/.apk file to install and test.' } }, required: ['action'] },
    argDecode: (p) => {
      const args = [String(p.action)];
      if (p.platform) args.push('--platform', String(p.platform));
      if (p.device) args.push('--device', String(p.device));
      if (p.app) args.push('--app', String(p.app));
      return args;
    },
  } }),
]);

// ─── MCP-Only Virtual Tools ─────────────────────────────────────
// These are MCP tool expansions that map to subcommands of existing
// commands (e.g. perf-audit save/compare/list/delete). They exist
// as separate tools in MCP but route to the same command handler
// via mapToolCallToCommand.

registry.registerAll([
  m('perf-audit-save',     'Save performance audit report',                  { mcp: {
    description: 'Run a performance audit and save the report to .browse/audits/ for later comparison.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name for the saved report. Auto-generated from URL + timestamp if omitted.' }, url: { type: 'string', description: 'URL to audit. If omitted, audits the current page.' }, no_coverage: { type: 'boolean', description: 'Skip JS/CSS coverage collection (faster audit).' }, no_detect: { type: 'boolean', description: 'Skip framework/SaaS/infrastructure detection.' }, budget: { type: 'string', description: 'Performance budget thresholds as comma-separated key:value pairs (e.g. "lcp:2500,cls:0.1,tbt:300"). Supported keys: lcp, cls, tbt, fcp, ttfb, inp. Metrics that were not measured are skipped. If any measured metric exceeds its threshold, an error is thrown with a pass/fail table.' } } },
    commandName: 'perf-audit',
    argDecode: (p) => {
      const args: string[] = ['save'];
      if (p.name) args.push(String(p.name));
      if (p.url) args.push(String(p.url));
      if (p.no_coverage) args.push('--no-coverage');
      if (p.no_detect) args.push('--no-detect');
      if (p.budget) args.push('--budget', String(p.budget));
      return args;
    },
  } }),
  m('perf-audit-compare',  'Compare performance audit reports',              { mcp: {
    description: 'Compare a saved audit report against the current page or another saved report. Shows regressions and improvements.',
    inputSchema: { type: 'object', properties: { baseline: { type: 'string', description: 'Name of the saved baseline audit report.' }, current: { type: 'string', description: 'Name of a second saved report to compare against. If omitted, runs a live audit for comparison.' }, no_coverage: { type: 'boolean', description: 'Skip JS/CSS coverage collection when running a live audit.' }, no_detect: { type: 'boolean', description: 'Skip framework/SaaS/infrastructure detection when running a live audit.' }, json: { type: 'boolean', description: 'Return structured JSON instead of formatted text.' } }, required: ['baseline'] },
    commandName: 'perf-audit',
    argDecode: (p) => {
      const args: string[] = ['compare', String(p.baseline)];
      if (p.current) args.push(String(p.current));
      if (p.no_coverage) args.push('--no-coverage');
      if (p.no_detect) args.push('--no-detect');
      if (p.json) args.push('--json');
      return args;
    },
  } }),
  m('perf-audit-list',     'List saved performance audit reports',           { mcp: {
    description: 'List all saved performance audit reports in .browse/audits/.',
    inputSchema: { type: 'object', properties: {} },
    commandName: 'perf-audit',
    argDecode: () => ['list'],
  } }),
  m('perf-audit-delete',   'Delete saved performance audit report',          { mcp: {
    description: 'Delete a saved performance audit report from .browse/audits/.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name of the saved audit report to delete.' } }, required: ['name'] },
    commandName: 'perf-audit',
    argDecode: (p) => ['delete', String(p.name)],
  } }),

  // ─── Workflow Commands (v2.1) ─────────────────────────────────

  m('flow',              'Execute, save, run, or list YAML flows',          { usage: '<file.yaml> | save <name> | run <name> | list', skipRecording: true, mcp: {
    description: [
      'Manage and execute YAML flow files containing sequences of browse commands.',
      '',
      'Subcommands:',
      '  flow <file.yaml>   — Execute a flow file from disk',
      '  flow save <name>   — Save the current recording as a named flow in .browse/flows/<name>.yaml',
      '  flow run <name>    — Execute a previously saved flow by name',
      '  flow list          — List all saved flows in .browse/flows/',
      '',
      'Each step in a flow is executed in order. On failure, execution stops and reports the failed step.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          description: 'Subcommand: omit (or set to the file path) to run a file, "save" to save recording, "run" to execute saved flow, "list" to show saved flows.',
          enum: ['file', 'save', 'run', 'list'],
        },
        file: { type: 'string', description: 'Path to a YAML flow file (used when subcommand is "file" / omitted).' },
        name: { type: 'string', description: 'Flow name for save/run subcommands (alphanumeric, hyphens, underscores).' },
      },
    },
    argDecode: (p) => {
      if (!p.subcommand || p.subcommand === 'file') {
        if (!p.file) throw new Error('file is required when subcommand is not save/run/list');
        return [String(p.file)];
      }
      if (p.subcommand === 'list') return ['list'];
      if (!p.name) throw new Error('name is required for flow save/run');
      return [String(p.subcommand), String(p.name)];
    },
  } }),
  m('retry',             'Retry command with backoff until condition met',  { usage: '"<cmd>" --until <cond> [--max N] [--backoff]', skipRecording: true, targetSupport: 'browser', mcp: {
    description: 'Retry a browse command until a condition is satisfied. Supports exponential backoff (100ms, 200ms, 400ms...). The condition uses the same syntax as browse_expect (--url, --text, --visible, --hidden, --count). Useful for dismissing transient overlays, waiting for async updates, or polling for state changes.',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string', description: 'The browse command to retry (e.g. "click .dismiss").' },
      until: { type: 'string', description: 'Condition to check after each attempt, using expect syntax (e.g. "--hidden .modal").' },
      max: { type: 'number', description: 'Maximum number of retry attempts (default: 3).' },
      backoff: { type: 'boolean', description: 'Enable exponential backoff between attempts (100ms, 200ms, 400ms...).' },
    }, required: ['command', 'until'] },
    argDecode: (p) => {
      const args = [String(p.command), '--until', ...String(p.until).split(/\s+/)];
      if (p.max != null) args.push('--max', String(p.max));
      if (p.backoff) args.push('--backoff');
      return args;
    },
  } }),
  m('watch',             'Watch for DOM changes on an element',             { usage: '"<sel>" [--on-change "<cmd>"] [--timeout ms]', skipRecording: true, targetSupport: 'browser', mcp: {
    description: 'Watch a DOM element for mutations (child changes, text changes, attribute changes) using MutationObserver. Optionally execute a callback command when a change is detected. Times out after 30s by default.',
    inputSchema: { type: 'object', properties: {
      selector: { type: 'string', description: 'CSS selector of the element to watch for changes.' },
      on_change: { type: 'string', description: 'Browse command to execute when a change is detected (e.g. "text" to read page text).' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000).' },
    }, required: ['selector'] },
    argDecode: (p) => {
      const args = [String(p.selector)];
      if (p.on_change) args.push('--on-change', String(p.on_change));
      if (p.timeout != null) args.push('--timeout', String(p.timeout));
      return args;
    },
  } }),
]);

// ─── Backward-Compatible Exports ─────────────────────────────────
// These derived sets replace hand-maintained duplicated sets.
// Consumers should migrate to registry.get() / registry.byCategory().

export const READ_COMMANDS = registry.categorySet('read');
export const WRITE_COMMANDS = registry.categorySet('write');
export const META_COMMANDS = registry.categorySet('meta');

/** Commands safe to auto-retry after server restart */
export const SAFE_TO_RETRY = new Set(
  registry.all().filter(s => s.safeToRetry).map(s => s.name),
);

/** Commands excluded from recording */
export const RECORDING_SKIP = new Set(
  registry.all().filter(s => s.skipRecording).map(s => s.name),
);

/** Commands returning page content (for --content-boundaries) */
export const PAGE_CONTENT_COMMANDS = new Set(
  registry.all().filter(s => s.pageContent).map(s => s.name),
);

// ─── Error Rewriting ─────────────────────────────────────────────

/**
 * Rewrite Playwright error messages into actionable hints for AI agents.
 * Raw errors like "locator.click: Timeout 5000ms exceeded" are unhelpful.
 */
export function rewriteError(msg: string): string {
  if (msg.includes('strict mode violation')) {
    const countMatch = msg.match(/resolved to (\d+) elements/);
    return `Multiple elements matched (${countMatch?.[1] || 'several'}). Use a more specific selector or run 'snapshot -i' to find exact refs.`;
  }
  if (msg.includes('Timeout') && msg.includes('exceeded')) {
    const timeMatch = msg.match(/Timeout (\d+)ms/);
    return `Element not found within ${timeMatch?.[1] || '?'}ms. The element may not exist, be hidden, or the page is still loading. Try 'wait <selector>' first, or check with 'snapshot -i'.`;
  }
  if (msg.includes('waiting for locator') || msg.includes('waiting for selector')) {
    return `Element not found on the page. Run 'snapshot -i' to see available elements, or check the current URL with 'url'.`;
  }
  if (msg.includes('not an HTMLInputElement') || msg.includes('not an input')) {
    return `Cannot fill this element — it's not an input field. Use 'click' instead, or run 'snapshot -i' to find the correct input.`;
  }
  if (msg.includes('Element is not visible')) {
    return `Element exists but is hidden (display:none or visibility:hidden). Try scrolling to it with 'scroll <selector>' or wait for it with 'wait <selector>'.`;
  }
  if (msg.includes('Element is outside of the viewport')) {
    return `Element is off-screen. Scroll to it first with 'scroll <selector>'.`;
  }
  if (msg.includes('intercepts pointer events')) {
    return `Another element is covering the target (e.g., a modal, overlay, or cookie banner). Close the overlay first or use 'js' to click directly.`;
  }
  if (msg.includes('Frame was detached') || msg.includes('frame was detached')) {
    return `The iframe was removed or navigated away. Run 'frame main' to return to the main page, then re-navigate.`;
  }
  if (msg.includes('Target closed') || msg.includes('target closed')) {
    return `The page or tab was closed. Use 'tabs' to list open tabs, or 'goto' to navigate to a new page.`;
  }
  if (msg.includes('net::ERR_')) {
    const errMatch = msg.match(/(net::\w+)/);
    return `Network error: ${errMatch?.[1] || 'connection failed'}. Check the URL and ensure the site is reachable.`;
  }
  return msg;
}

// ─── CLI Help Generation ─────────────────────────────────────────

/** Category display labels for the help output */
const CATEGORY_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  meta: 'Meta',
};

/**
 * Generate CLI help text derived from the command registry.
 * Commands are grouped by category (read, write, meta).
 * This is the single source of truth for the --help output.
 */
export function generateHelp(): string {
  const lines: string[] = [
    'browse — Fast headless browser for AI coding agents',
    '',
    'Usage: browse [options] <command> [args...]',
    '',
  ];

  for (const category of ['read', 'write', 'meta'] as const) {
    const specs = registry.byCategory(category)
      .filter(s => !s.mcp?.commandName);  // skip virtual MCP-only aliases
    if (specs.length === 0) continue;

    const label = `${CATEGORY_LABELS[category]}:`.padEnd(16);
    const entries = specs.map(s => s.usage ? `${s.name} ${s.usage}` : s.name);

    // Group entries into lines of ~80 chars, joined with " | "
    const grouped: string[] = [];
    let current = '';
    for (const entry of entries) {
      const sep = current ? ' | ' : '';
      if (current && (current.length + sep.length + entry.length) > 72) {
        grouped.push(current);
        current = entry;
      } else {
        current += sep + entry;
      }
    }
    if (current) grouped.push(current);

    for (let i = 0; i < grouped.length; i++) {
      lines.push(i === 0 ? `${label}${grouped[i]}` : `                ${grouped[i]}`);
    }
  }

  lines.push('');
  lines.push('Options:');
  lines.push('  --session <id>           Named session (isolates tabs, refs, cookies)');
  lines.push('  --profile <name>         Persistent browser profile (own Chromium, full state persistence)');
  lines.push('  --app <name>             Target a native application (macOS, uses Accessibility API)');
  lines.push('  --json                   Wrap output as {success, data, command}');
  lines.push('  --content-boundaries     Wrap page content in nonce-delimited markers');
  lines.push('  --context [state|delta|full]  Action context (state=changes, delta=ARIA diff, full=snapshot)');
  lines.push('  --allowed-domains <d,d>  Block navigation/resources outside allowlist');
  lines.push('  --headed                 Run browser in headed (visible) mode');
  lines.push('  --chrome                 Launch system Chrome (uses your profile, cookies, extensions)');
  lines.push('  --max-output <n>         Truncate output to N characters');
  lines.push('  --state <path>           Load state file (cookies/storage) before first command');
  lines.push('  --connect                Auto-discover and connect to running Chrome');
  lines.push('  --cdp <port>             Connect to Chrome on specific debugging port');
  lines.push('  --provider <name>        Cloud browser provider (browserless, browserbase)');
  lines.push('  --runtime <name>         Browser engine (playwright, rebrowser, lightpanda)');
  lines.push('  --mcp                    Run as MCP server (for Cursor, Windsurf, Cline)');
  lines.push('  --mcp --json             MCP server with JSON-wrapped responses');
  lines.push('');
  lines.push('Snapshot flags:');
  lines.push('  -i            Interactive elements only (terse flat list by default)');
  lines.push('  -f            Full — indented tree with props and children (use with -i)');
  lines.push('  -V            Viewport — only elements visible in current viewport');
  lines.push('  -c            Compact — remove empty structural elements');
  lines.push('  -C            Cursor-interactive — detect divs with cursor:pointer,');
  lines.push('                onclick, tabindex, data-action (missed by ARIA tree)');
  lines.push('  -d N          Limit tree depth to N levels');
  lines.push('  -s <sel>      Scope to CSS selector');
  lines.push('');
  lines.push('Refs:           After \'snapshot\', use @e1, @e2... as selectors:');
  lines.push('                click @e3 | fill @e4 "value" | hover @e1');

  return lines.join('\n');
}

// ─── Command Definition Registration ─────────────────────────────
// Command modules own their definitions — the registry delegates
// registration to each module's register*Definitions() export.

let definitionsRegistered = false;

/**
 * Lazily register all command definitions.
 * Called once on first executeCommand() invocation.
 * Uses dynamic imports to avoid circular dependency issues at module load time.
 */
export async function ensureDefinitionsRegistered(): Promise<void> {
  if (definitionsRegistered) return;
  definitionsRegistered = true;

  const { registerReadDefinitions } = await import('../commands/read');
  const { registerWriteDefinitions } = await import('../commands/write');
  const { registerMetaDefinitions } = await import('../commands/meta');

  registerReadDefinitions(registry);
  registerWriteDefinitions(registry);
  registerMetaDefinitions(registry);
}

// Re-export types for consumers
export type { CommandSpec, CommandRegistry, CommandDefinition } from './command';
export type { CommandCategory } from './events';
