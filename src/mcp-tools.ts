/**
 * MCP tool definitions for all browse commands.
 *
 * Exports:
 *   getToolDefinitions() — array of MCP tool definitions
 *   mapToolCallToCommand(toolName, params) — maps MCP tool call to { command, args }
 */

// ─── Tool Definition Type ─────────────────────────────────────────

interface ToolProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

// ─── Tool Definitions ──────────────────────────────────────────────

const TOOL_DEFINITIONS: ToolDefinition[] = [

  // ════════════════════════════════════════════════════════════════
  // READ COMMANDS
  // ════════════════════════════════════════════════════════════════

  {
    name: 'browse_text',
    description: 'Extract all visible text from the current page. Uses a TreeWalker that skips hidden elements, scripts, and styles. Returns clean text with one line per text node. Use this as the primary way to read page content.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_html',
    description: 'Get the full HTML source of the current page, or the innerHTML of a specific element. Use for inspecting raw markup or extracting structured data. Returns the full page HTML when no selector is given, or the inner HTML of the matched element.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e3") to get innerHTML of a specific element. Omit for full page HTML.' },
      },
    },
  },
  {
    name: 'browse_links',
    description: 'List all links on the current page. Returns each link as "text -> href" on its own line. Use to discover navigation options or find specific URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_forms',
    description: 'Extract all form structures from the current page as JSON. Returns form action, method, and all input/select/textarea fields with their types, names, and current values. Use to understand form layout before filling.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_accessibility',
    description: 'Get the raw ARIA accessibility tree of the current page. Returns the Playwright ariaSnapshot() output. For a more useful version with clickable @refs, use browse_snapshot instead.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_js',
    description: 'Evaluate a JavaScript expression in the page context and return the result. Use for extracting data, checking variables, or running computations in the browser. Returns stringified result (objects as JSON).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate in the page context.' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browse_eval',
    description: 'Evaluate a JavaScript file in the page context. Reads the file from disk and runs its contents. Returns the result of the last expression.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to a JavaScript file to evaluate.' },
      },
      required: ['file'],
    },
  },
  {
    name: 'browse_css',
    description: 'Get the computed CSS property value of an element. Use to check styles like color, display, font-size, etc. Returns the computed value string.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the element.' },
        property: { type: 'string', description: 'CSS property name (e.g. "color", "display", "font-size").' },
      },
      required: ['selector', 'property'],
    },
  },
  {
    name: 'browse_attrs',
    description: 'Get all HTML attributes of an element as a JSON object. Use to inspect data attributes, ARIA roles, classes, etc. Returns { attrName: value } pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the element.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_element_state',
    description: 'Get the full state of an element: visible, enabled, checked, editable, focused, tag, type, value, and bounding box. Returns JSON. Use to verify element state before interacting.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the element.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_dialog',
    description: 'Get info about the last browser dialog (alert, confirm, prompt). Returns JSON with type, message, and defaultValue. Returns "(no dialog detected)" if no dialog has appeared.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_console',
    description: 'Read the browser console log buffer. Returns timestamped entries with level (log, warn, error, info). Use --clear to empty the buffer after reading.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear the console buffer after reading.' },
      },
    },
  },
  {
    name: 'browse_network',
    description: 'Read the network request log buffer. Returns each request with method, URL, status, duration, and size. Use --clear to empty the buffer after reading.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear the network buffer after reading.' },
      },
    },
  },
  {
    name: 'browse_cookies',
    description: 'Get all browser cookies as a JSON array. Each cookie includes name, value, domain, path, expires, secure, httpOnly, and sameSite.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_storage',
    description: 'Get localStorage and sessionStorage contents as JSON. Can also set a localStorage key/value pair.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Set to "set" to store a value. Omit to read all storage.', enum: ['set'] },
        key: { type: 'string', description: 'Storage key (required when action is "set").' },
        value: { type: 'string', description: 'Storage value (used with action "set", defaults to empty string).' },
      },
    },
  },
  {
    name: 'browse_perf',
    description: 'Get page performance timing metrics: DNS lookup, TCP connect, SSL, TTFB, download, DOM parse, DOM ready, and total load time in milliseconds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_devices',
    description: 'List available device names for emulation. Includes iPhones, Pixels, iPads, and all Playwright built-in devices. Optionally filter by name.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter device names (case-insensitive substring match).' },
      },
    },
  },
  {
    name: 'browse_value',
    description: 'Get the current value of an input, select, or textarea element. Returns the value string. Use to verify form field contents after filling.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the input element.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_count',
    description: 'Count the number of elements matching a selector. Returns a number. Use to verify list lengths, check if elements exist, or count search results.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to count matches for.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_clipboard',
    description: 'Read or write the browser clipboard. Without action, reads the clipboard text. With action "write", sets the clipboard to the given text.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Set to "write" to write text to clipboard. Omit to read.', enum: ['write'] },
        text: { type: 'string', description: 'Text to write to clipboard (required when action is "write").' },
      },
    },
  },
  {
    name: 'browse_box',
    description: 'Get the bounding box (x, y, width, height) of an element as JSON. Coordinates are in pixels relative to the viewport. Use to determine element position for mouse operations.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the element.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_errors',
    description: 'Get only error-level entries from the console buffer. Filters out log/warn/info. Use --clear to remove error entries from the buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear error entries from the buffer.' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════
  // WRITE COMMANDS
  // ════════════════════════════════════════════════════════════════

  {
    name: 'browse_goto',
    description: 'Navigate to a URL. Waits for DOMContentLoaded. Returns the HTTP status code. This is the primary way to open web pages.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to (e.g. "https://example.com").' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browse_back',
    description: 'Navigate back in browser history (like clicking the back button). Returns the new URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_forward',
    description: 'Navigate forward in browser history (like clicking the forward button). Returns the new URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_reload',
    description: 'Reload the current page. Waits for DOMContentLoaded. Returns the current URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_click',
    description: 'Click an element on the page. Supports CSS selectors and @ref identifiers from snapshot. Waits for the element to be actionable, then clicks it. Use browse_snapshot first to find element refs.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e3") to click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_dblclick',
    description: 'Double-click an element. Use for elements that require double-click activation (text selection, list items, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to double-click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_fill',
    description: 'Fill an input field with text. Clears existing content first, then types the value. Works with text inputs, textareas, and contenteditable elements. Use browse_snapshot to find the input ref first.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the input element.' },
        value: { type: 'string', description: 'Text value to fill into the input.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browse_select',
    description: 'Select an option in a dropdown/select element by value or label. Use browse_forms to see available options first.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the select element.' },
        value: { type: 'string', description: 'Option value or visible text to select.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browse_hover',
    description: 'Hover over an element. Triggers mouseover/mouseenter events. Use to reveal tooltips, dropdown menus, or hover-activated content.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to hover over.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_focus',
    description: 'Focus an element. Use to bring keyboard focus to an input or interactive element before typing.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to focus.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_check',
    description: 'Check a checkbox or radio button. Ensures the element becomes checked. No-op if already checked.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the checkbox/radio.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_uncheck',
    description: 'Uncheck a checkbox. Ensures the element becomes unchecked. No-op if already unchecked.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the checkbox.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_type',
    description: 'Type text via the keyboard into the currently focused element. Does NOT clear existing content (unlike fill). Use for character-by-character input, e.g. search boxes with autocomplete.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type via keyboard.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browse_press',
    description: 'Press a single key on the keyboard. Use for Enter, Tab, Escape, ArrowDown, etc. Supports key combinations like "Control+A", "Shift+Tab".',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "Control+A").' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browse_keydown',
    description: 'Press a key down (without releasing). Use with browse_keyup for hold-and-release patterns like Shift+click.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press down (e.g. "Shift", "Control", "Alt").' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browse_keyup',
    description: 'Release a key that was pressed down. Use after browse_keydown to complete a hold-and-release pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to release (e.g. "Shift", "Control", "Alt").' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browse_scroll',
    description: 'Scroll the page or an element into view. Use "up"/"down" for viewport scrolling, "bottom" to scroll to page end, or a selector to scroll that element into view.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '"up", "down", "bottom", or a CSS selector/@ref to scroll into view. Omit to scroll to bottom.' },
      },
    },
  },
  {
    name: 'browse_wait',
    description: 'Wait for various conditions: element visibility, URL match, text appearance, JS expression, network idle, or a fixed time. Use to synchronize with page loading or async operations.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to wait for. Mutually exclusive with other wait modes.' },
        state: { type: 'string', description: 'Wait for element state (used with selector).', enum: ['visible', 'hidden', 'attached', 'detached'] },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 15000).' },
        url: { type: 'string', description: 'URL pattern to wait for (e.g. "**/success*").' },
        text: { type: 'string', description: 'Wait for this text to appear in the page body.' },
        fn: { type: 'string', description: 'JavaScript expression to wait for (must become truthy).' },
        load: { type: 'string', description: 'Wait for load state.', enum: ['load', 'domcontentloaded', 'networkidle'] },
        network_idle: { type: 'boolean', description: 'Wait for network to settle (no pending requests).' },
        ms: { type: 'number', description: 'Wait for a fixed number of milliseconds.' },
        download: { type: 'boolean', description: 'Wait for a download to complete.' },
        download_path: { type: 'string', description: 'Save downloaded file to this path (used with download).' },
      },
    },
  },
  {
    name: 'browse_viewport',
    description: 'Set the browser viewport size. Use for responsive testing or to match specific device dimensions. Format: WxH (e.g. "375x812").',
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'string', description: 'Viewport size as "WxH" (e.g. "375x812", "1920x1080").' },
      },
      required: ['size'],
    },
  },
  {
    name: 'browse_cookie',
    description: 'Manage browser cookies. Set a single cookie, clear all cookies, set with options (domain, secure, expires, sameSite), or export/import cookies to/from a JSON file.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Cookie action.', enum: ['set', 'clear', 'export', 'import'] },
        name: { type: 'string', description: 'Cookie name (required for "set").' },
        value: { type: 'string', description: 'Cookie value (required for "set").' },
        domain: { type: 'string', description: 'Cookie domain (optional for "set", defaults to current page domain).' },
        secure: { type: 'boolean', description: 'Set the Secure flag (optional for "set").' },
        expires: { type: 'number', description: 'Cookie expiration as Unix timestamp (optional for "set").' },
        sameSite: { type: 'string', description: 'SameSite attribute.', enum: ['Strict', 'Lax', 'None'] },
        path: { type: 'string', description: 'Cookie path (optional for "set", defaults to "/").' },
        file: { type: 'string', description: 'File path for export/import operations.' },
        name_value: { type: 'string', description: 'Legacy format: "name=value" to set a cookie quickly.' },
      },
    },
  },
  {
    name: 'browse_header',
    description: 'Set an extra HTTP header that will be sent with every subsequent request. Use for API keys, auth tokens, or custom headers.',
    inputSchema: {
      type: 'object',
      properties: {
        header: { type: 'string', description: 'Header in "Name:Value" format (e.g. "Authorization:Bearer token123").' },
      },
      required: ['header'],
    },
  },
  {
    name: 'browse_useragent',
    description: 'Set the browser User-Agent string. Recreates the browser context (preserves cookies and tabs, but resets localStorage). For full device emulation, use browse_emulate instead.',
    inputSchema: {
      type: 'object',
      properties: {
        useragent: { type: 'string', description: 'The User-Agent string to set.' },
      },
      required: ['useragent'],
    },
  },
  {
    name: 'browse_upload',
    description: 'Upload files to a file input element. Supports multiple files. The files must exist on the local filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the file input element.' },
        files: { type: 'string', description: 'Space-separated file paths to upload.' },
      },
      required: ['selector', 'files'],
    },
  },
  {
    name: 'browse_dialog_accept',
    description: 'Set the browser to automatically accept the next dialog (alert, confirm, prompt). Optionally provide text for prompt dialogs. Call before the action that triggers the dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to enter in a prompt dialog (optional).' },
      },
    },
  },
  {
    name: 'browse_dialog_dismiss',
    description: 'Set the browser to automatically dismiss the next dialog (click Cancel/No). Call before the action that triggers the dialog.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_emulate',
    description: 'Emulate a mobile device or reset to desktop. Sets viewport, user agent, device scale factor, touch, and mobile flags. Use "reset" to return to 1920x1080 desktop. Preserves cookies and tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device name (e.g. "iPhone 15", "Pixel 7", "iPad Pro 11") or "reset" for desktop. Run browse_devices to see all options.' },
      },
      required: ['device'],
    },
  },
  {
    name: 'browse_drag',
    description: 'Drag an element from source to target. Both support CSS selectors and @refs.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'CSS selector or @ref for the element to drag.' },
        target: { type: 'string', description: 'CSS selector or @ref for the drop target.' },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'browse_highlight',
    description: 'Add a visual highlight (red outline) to an element. Use for debugging or visual verification. The highlight persists until the page is reloaded.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to highlight.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_download',
    description: 'Click an element that triggers a download and save the file. Returns the saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref for the download trigger element.' },
        path: { type: 'string', description: 'File path to save the download to (defaults to suggested filename).' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_route',
    description: 'Intercept network requests matching a URL pattern. Block requests (abort them) or fulfill them with a custom response. Use "clear" to remove all routes.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'URL pattern to match (e.g. "**/*.png", "**/api/*") or "clear" to remove all routes.' },
        action: { type: 'string', description: 'What to do with matching requests.', enum: ['block', 'fulfill'] },
        status: { type: 'number', description: 'HTTP status code for fulfill (default: 200).' },
        body: { type: 'string', description: 'Response body for fulfill (default: empty).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'browse_offline',
    description: 'Toggle offline mode, simulating network disconnection. Use "on"/"off" to set explicitly, or omit to toggle.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"on" to enable offline, "off" to disable, omit to toggle.', enum: ['on', 'off'] },
      },
    },
  },
  {
    name: 'browse_rightclick',
    description: 'Right-click (context click) an element. Use to trigger context menus.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to right-click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_tap',
    description: 'Tap an element (touch event). Requires a touch-enabled context — use browse_emulate with a mobile device first. Use instead of click for mobile testing.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to tap.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_swipe',
    description: 'Perform a swipe gesture from the center of the viewport. Dispatches touch events. Use for mobile carousels, pull-to-refresh, or swipe-to-dismiss.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'Swipe direction.', enum: ['up', 'down', 'left', 'right'] },
        distance: { type: 'number', description: 'Swipe distance in pixels (default: 70% of viewport).' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browse_mouse',
    description: 'Low-level mouse operations: move to coordinates, mouse button down/up, wheel scroll, or click at coordinates. Use for precise positioning, drag operations, or hover states.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Mouse action to perform.', enum: ['move', 'down', 'up', 'wheel', 'click'] },
        x: { type: 'number', description: 'X coordinate (required for move and click).' },
        y: { type: 'number', description: 'Y coordinate (required for move and click).' },
        button: { type: 'string', description: 'Mouse button for down/up/click (default: "left").', enum: ['left', 'right', 'middle'] },
        dy: { type: 'number', description: 'Vertical scroll amount for wheel (positive = down).' },
        dx: { type: 'number', description: 'Horizontal scroll amount for wheel (default: 0).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_keyboard',
    description: 'Low-level keyboard operations. Currently supports insertText which inserts text without triggering key events (useful for IME-like input).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Keyboard action.', enum: ['inserttext'] },
        text: { type: 'string', description: 'Text to insert (required for inserttext).' },
      },
      required: ['action', 'text'],
    },
  },
  {
    name: 'browse_scrollinto',
    description: 'Scroll an element into view if it is not already visible. Alias for scroll with a selector. Use before clicking elements that might be off-screen.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref to scroll into view.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_set',
    description: 'Configure browser settings: geolocation coordinates or color scheme (dark/light mode).',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: { type: 'string', description: 'Setting to configure.', enum: ['geo', 'media'] },
        lat: { type: 'number', description: 'Latitude for geolocation (required for "geo").' },
        lng: { type: 'number', description: 'Longitude for geolocation (required for "geo").' },
        scheme: { type: 'string', description: 'Color scheme for media (required for "media").', enum: ['dark', 'light', 'no-preference'] },
      },
      required: ['subcommand'],
    },
  },

  // ════════════════════════════════════════════════════════════════
  // META COMMANDS
  // ════════════════════════════════════════════════════════════════

  {
    name: 'browse_tabs',
    description: 'List all open browser tabs with their IDs, titles, and URLs. The active tab is marked with an arrow. Use tab IDs with browse_tab to switch.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_tab',
    description: 'Switch to a specific browser tab by its ID. Get tab IDs from browse_tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Tab ID to switch to.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browse_newtab',
    description: 'Open a new browser tab, optionally navigating to a URL. Returns the new tab ID.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open in the new tab (optional).' },
      },
    },
  },
  {
    name: 'browse_closetab',
    description: 'Close a browser tab by ID. If no ID is given, closes the current tab.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Tab ID to close (optional, defaults to current tab).' },
      },
    },
  },
  {
    name: 'browse_status',
    description: 'Get server health status including current URL, number of tabs, PID, uptime, and active sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_url',
    description: 'Get the current page URL. Quick way to check where the browser is.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_stop',
    description: 'Stop the browse server. The server will shut down after a brief delay.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_restart',
    description: 'Restart the browse server. Useful after configuration changes or to reset browser state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_screenshot',
    description: 'Take a screenshot of the current page. Supports full-page capture, element-specific screenshots, region clipping, and annotated screenshots with numbered interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to save the screenshot (default: .browse/browse-screenshot.png).' },
        full: { type: 'boolean', description: 'Capture the full scrollable page (not just the viewport).' },
        selector: { type: 'string', description: 'CSS selector or @ref to screenshot a specific element.' },
        clip: { type: 'string', description: 'Clip region as "x,y,width,height" (cannot combine with --full or selector).' },
        annotate: { type: 'boolean', description: 'Add numbered badges to interactive elements with a legend.' },
      },
    },
  },
  {
    name: 'browse_pdf',
    description: 'Save the current page as a PDF file. Uses A4 format.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to save the PDF (default: .browse/browse-page.pdf).' },
      },
    },
  },
  {
    name: 'browse_responsive',
    description: 'Take screenshots at mobile (375x812), tablet (768x1024), and desktop (1920x1080) viewports. Saves three PNG files with -mobile, -tablet, -desktop suffixes.',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'File path prefix for the screenshots (default: .browse/browse-responsive).' },
      },
    },
  },
  {
    name: 'browse_chain',
    description: 'Execute a sequence of commands in order. Pass a JSON array of command arrays. Each command is [name, ...args]. Results are returned for each step. Failed steps show errors without stopping the chain.',
    inputSchema: {
      type: 'object',
      properties: {
        commands: { type: 'string', description: 'JSON array of commands, e.g. [["goto","https://example.com"],["text"],["click","@e3"]]' },
      },
      required: ['commands'],
    },
  },
  {
    name: 'browse_diff',
    description: 'Compare the visible text of two URLs using a unified diff format. Opens each URL in a temporary tab, extracts text, and shows additions/removals.',
    inputSchema: {
      type: 'object',
      properties: {
        url1: { type: 'string', description: 'First URL to compare.' },
        url2: { type: 'string', description: 'Second URL to compare.' },
      },
      required: ['url1', 'url2'],
    },
  },
  {
    name: 'browse_snapshot',
    description: 'Get the accessibility tree of the current page with @ref identifiers for each element. Use -i for interactive elements only (the most common usage). Refs like @e1, @e2 can be used with click, fill, and other commands. This is the primary way to understand page structure and find elements to interact with.',
    inputSchema: {
      type: 'object',
      properties: {
        interactive: { type: 'boolean', description: 'Show only interactive elements (buttons, links, inputs, etc.). This is the most commonly used mode.' },
        compact: { type: 'boolean', description: 'Remove empty structural elements from the tree.' },
        cursor: { type: 'boolean', description: 'Include cursor-interactive elements (divs with onclick, cursor:pointer, etc.) that are not in the ARIA tree.' },
        depth: { type: 'number', description: 'Limit the tree depth (e.g. 3 = only top 3 levels).' },
        selector: { type: 'string', description: 'CSS selector to scope the snapshot to a subtree.' },
        viewport: { type: 'boolean', description: 'Only include elements visible in the current viewport.' },
        full: { type: 'boolean', description: 'Show full indented ARIA tree with props and children (overrides the default terse flat list when -i is used).' },
      },
    },
  },
  {
    name: 'browse_snapshot_diff',
    description: 'Compare the current page accessibility snapshot with the previous one. Shows additions and removals in unified diff format. Run browse_snapshot first to establish a baseline.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_screenshot_diff',
    description: 'Pixel-diff two screenshots. Compares a baseline image with the current page (or another image). Returns mismatch percentage and PASS/FAIL result. Saves a diff image on failure.',
    inputSchema: {
      type: 'object',
      properties: {
        baseline: { type: 'string', description: 'Path to the baseline screenshot PNG file.' },
        current: { type: 'string', description: 'Path to the current screenshot (optional — takes a live screenshot if omitted).' },
        threshold: { type: 'number', description: 'Mismatch percentage threshold for PASS/FAIL (default: 0.1).' },
        full: { type: 'boolean', description: 'Use full-page screenshot for the current image.' },
      },
      required: ['baseline'],
    },
  },
  {
    name: 'browse_sessions',
    description: 'List all active browser sessions. Shows session ID, number of tabs, current URL, and idle time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_session_close',
    description: 'Close a specific session by ID. Flushes buffers before closing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID to close.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'browse_frame',
    description: 'Switch to an iframe context or return to the main page. All subsequent commands will execute within the targeted frame until you switch back with "main".',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for the iframe, or "main"/"top" to return to the main page.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browse_state',
    description: 'Save or restore page state (cookies, localStorage). Use save/load to persist and restore state across sessions. Use list to see saved states, show to inspect one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'State operation.', enum: ['save', 'load', 'list', 'show', 'clean'] },
        name: { type: 'string', description: 'State name (default: "default").' },
        older_than: { type: 'number', description: 'For "clean" action: delete states older than this many days (default: 7).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_find',
    description: 'Find elements using semantic locators: by role, text, label, placeholder, test ID, alt text, title, or positional (first/last/nth). Returns match count and first match text.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Locator type.', enum: ['role', 'text', 'label', 'placeholder', 'testid', 'alt', 'title', 'first', 'last', 'nth'] },
        query: { type: 'string', description: 'Search query or selector.' },
        name: { type: 'string', description: 'For role: accessible name to match (optional). For nth: the CSS selector.' },
      },
      required: ['type', 'query'],
    },
  },
  {
    name: 'browse_auth',
    description: 'Manage encrypted credentials for auto-login. Save credentials with URL and selectors, auto-login to saved sites, list or delete stored credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Auth operation.', enum: ['save', 'login', 'list', 'delete'] },
        name: { type: 'string', description: 'Credential name (required for save/login/delete).' },
        url: { type: 'string', description: 'Login page URL (required for save).' },
        username: { type: 'string', description: 'Username (required for save).' },
        password: { type: 'string', description: 'Password (required for save).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_har',
    description: 'Record HTTP traffic in HAR (HTTP Archive) format. Start recording, then stop to save the HAR file. Use for debugging network issues or analyzing API calls.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'HAR operation.', enum: ['start', 'stop'] },
        path: { type: 'string', description: 'File path to save the HAR file (used with "stop", default: .browse/browse-recording.har).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_video',
    description: 'Record video of browser actions. Start recording to a directory, check status, or stop and save. Videos are saved as WebM files.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Video operation.', enum: ['start', 'stop', 'status'] },
        dir: { type: 'string', description: 'Output directory for video files (used with "start").' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_inspect',
    description: 'Get Chrome DevTools debugging URLs. Requires BROWSE_DEBUG_PORT environment variable to be set. Returns DevTools frontend URL, page info, and WebSocket URL.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_record',
    description: 'Record a sequence of browse commands for later replay. Start recording, execute commands, then stop and export as browse chain JSON or Playwright script.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Record operation.', enum: ['start', 'stop', 'status', 'export'] },
        format: { type: 'string', description: 'Export format (used with "export").', enum: ['browse', 'replay'] },
        path: { type: 'string', description: 'File path to save export (used with "export", optional — prints to stdout if omitted).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_cookie_import',
    description: 'Import cookies from an installed Chromium browser (Chrome, Arc, Brave, Edge) into the browse session. Use --list to see available browsers.',
    inputSchema: {
      type: 'object',
      properties: {
        browser: { type: 'string', description: 'Browser name (e.g. "chrome", "arc", "brave", "edge") or omit with list=true to list browsers.' },
        domain: { type: 'string', description: 'Domain to import cookies for (optional — imports all if omitted).' },
        profile: { type: 'string', description: 'Browser profile name (optional).' },
        list: { type: 'boolean', description: 'List installed browsers instead of importing.' },
      },
    },
  },
  {
    name: 'browse_doctor',
    description: 'Run diagnostics. Checks Node version, Playwright installation, Chromium availability, and server status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_upgrade',
    description: 'Upgrade @ulpi/browse to the latest version via npm.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_handoff',
    description: 'Hand off the browser to the user for visual inspection. Opens a headed browser window for manual interaction. Use browse_resume to return to headless mode.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to display to the user explaining what to inspect.' },
      },
    },
  },
  {
    name: 'browse_resume',
    description: 'Resume headless operation after a browse_handoff. Returns the current URL and a fresh snapshot.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_profile',
    description: 'Manage persistent browser profiles. List profiles, delete a profile, or clean up old profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Profile operation.', enum: ['list', 'delete', 'clean'] },
        name: { type: 'string', description: 'Profile name (required for "delete").' },
        older_than: { type: 'number', description: 'For "clean": delete profiles older than this many days (default: 7).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_react_devtools',
    description: 'Inspect React components. Enable the React DevTools hook, view the component tree, get component props/state, check for suspense boundaries, errors, hydration issues, renders, owners, and context.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'DevTools operation.', enum: ['enable', 'disable', 'tree', 'props', 'suspense', 'errors', 'profiler', 'hydration', 'renders', 'owners', 'context'] },
        selector: { type: 'string', description: 'CSS selector or @ref (required for props, owners, context).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_provider',
    description: 'Manage cloud browser providers (Browserless, Browserbase). Save API keys, list configured providers, or delete credentials. Use "save" to store a provider API key, then set BROWSE_CDP_URL to connect via CDP.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Operation to perform.', enum: ['save', 'list', 'delete'] },
        name: { type: 'string', description: 'Provider name (e.g. "browserless", "browserbase"). Required for save and delete.' },
        api_key: { type: 'string', description: 'API key for the provider. Required for save.' },
      },
      required: ['action'],
    },
  },
];

// ─── Public API ────────────────────────────────────────────────────

/**
 * Returns all MCP tool definitions for browse commands.
 */
export function getToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

/**
 * Map an MCP tool call to a browse command + args array.
 */
export function mapToolCallToCommand(
  toolName: string,
  params: Record<string, unknown>
): { command: string; args: string[] } {
  // Strip "browse_" prefix and convert underscores back to hyphens
  const rawCommand = toolName.replace(/^browse_/, '').replace(/_/g, '-');

  switch (rawCommand) {
    // ─── READ ──────────────────────────────────────────
    case 'text':
    case 'links':
    case 'forms':
    case 'accessibility':
    case 'dialog':
    case 'cookies':
    case 'perf':
      return { command: rawCommand, args: [] };

    case 'html': {
      const args: string[] = [];
      if (params.selector) args.push(String(params.selector));
      return { command: 'html', args };
    }

    case 'js':
      return { command: 'js', args: [String(params.expression)] };

    case 'eval':
      return { command: 'eval', args: [String(params.file)] };

    case 'css':
      return { command: 'css', args: [String(params.selector), String(params.property)] };

    case 'attrs':
    case 'element-state':
    case 'value':
    case 'count':
    case 'box':
      return { command: rawCommand, args: [String(params.selector)] };

    case 'console': {
      const args: string[] = [];
      if (params.clear) args.push('--clear');
      return { command: 'console', args };
    }

    case 'network': {
      const args: string[] = [];
      if (params.clear) args.push('--clear');
      return { command: 'network', args };
    }

    case 'storage': {
      if (params.action === 'set') {
        return { command: 'storage', args: ['set', String(params.key), String(params.value ?? '')] };
      }
      return { command: 'storage', args: [] };
    }

    case 'devices': {
      const args: string[] = [];
      if (params.filter) args.push(String(params.filter));
      return { command: 'devices', args };
    }

    case 'clipboard': {
      if (params.action === 'write') {
        return { command: 'clipboard', args: ['write', String(params.text)] };
      }
      return { command: 'clipboard', args: [] };
    }

    case 'errors': {
      const args: string[] = [];
      if (params.clear) args.push('--clear');
      return { command: 'errors', args };
    }

    // ─── WRITE ──────────────────────────────────────────
    case 'goto':
      return { command: 'goto', args: [String(params.url)] };

    case 'back':
    case 'forward':
    case 'reload':
    case 'dialog-dismiss':
      return { command: rawCommand, args: [] };

    case 'click':
    case 'dblclick':
    case 'hover':
    case 'focus':
    case 'check':
    case 'uncheck':
    case 'rightclick':
    case 'tap':
    case 'highlight':
    case 'scrollinto':
    case 'scrollintoview':
      return { command: rawCommand, args: [String(params.selector)] };

    case 'fill':
      return { command: 'fill', args: [String(params.selector), String(params.value)] };

    case 'select':
      return { command: 'select', args: [String(params.selector), String(params.value)] };

    case 'type':
      return { command: 'type', args: [String(params.text)] };

    case 'press':
      return { command: 'press', args: [String(params.key)] };

    case 'keydown':
      return { command: 'keydown', args: [String(params.key)] };

    case 'keyup':
      return { command: 'keyup', args: [String(params.key)] };

    case 'scroll': {
      const args: string[] = [];
      if (params.target) args.push(String(params.target));
      return { command: 'scroll', args };
    }

    case 'wait': {
      const args: string[] = [];
      if (params.network_idle) {
        args.push('--network-idle');
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.url) {
        args.push('--url', String(params.url));
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.text) {
        args.push('--text', String(params.text));
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.fn) {
        args.push('--fn', String(params.fn));
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.load) {
        args.push('--load', String(params.load));
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.download) {
        args.push('--download');
        if (params.download_path) args.push(String(params.download_path));
        if (params.timeout) args.push(String(params.timeout));
      } else if (params.ms) {
        args.push(String(params.ms));
      } else if (params.selector) {
        args.push(String(params.selector));
        if (params.state) { args.push('--state', String(params.state)); }
        if (params.timeout) args.push(String(params.timeout));
      }
      return { command: 'wait', args };
    }

    case 'viewport':
      return { command: 'viewport', args: [String(params.size)] };

    case 'cookie': {
      const args: string[] = [];
      if (params.action === 'clear') {
        args.push('clear');
      } else if (params.action === 'export') {
        args.push('export', String(params.file));
      } else if (params.action === 'import') {
        args.push('import', String(params.file));
      } else if (params.action === 'set') {
        args.push('set', String(params.name), String(params.value));
        if (params.domain) { args.push('--domain', String(params.domain)); }
        if (params.secure) { args.push('--secure'); }
        if (params.expires != null) { args.push('--expires', String(params.expires)); }
        if (params.sameSite) { args.push('--sameSite', String(params.sameSite)); }
        if (params.path) { args.push('--path', String(params.path)); }
      } else if (params.name_value) {
        args.push(String(params.name_value));
      } else {
        // Fallback: construct name=value
        if (params.name && params.value) {
          args.push(`${params.name}=${params.value}`);
        }
      }
      return { command: 'cookie', args };
    }

    case 'header':
      return { command: 'header', args: [String(params.header)] };

    case 'useragent':
      return { command: 'useragent', args: [String(params.useragent)] };

    case 'upload': {
      const files = String(params.files).split(/\s+/);
      return { command: 'upload', args: [String(params.selector), ...files] };
    }

    case 'dialog-accept': {
      const args: string[] = [];
      if (params.text) args.push(String(params.text));
      return { command: 'dialog-accept', args };
    }

    case 'emulate':
      return { command: 'emulate', args: [String(params.device)] };

    case 'drag':
      return { command: 'drag', args: [String(params.source), String(params.target)] };

    case 'download': {
      const args = [String(params.selector)];
      if (params.path) args.push(String(params.path));
      return { command: 'download', args };
    }

    case 'route': {
      const args = [String(params.pattern)];
      if (params.pattern !== 'clear') {
        if (params.action) args.push(String(params.action));
        if (params.action === 'fulfill') {
          if (params.status != null) args.push(String(params.status));
          if (params.body) args.push(String(params.body));
        }
      }
      return { command: 'route', args };
    }

    case 'offline': {
      const args: string[] = [];
      if (params.mode) args.push(String(params.mode));
      return { command: 'offline', args };
    }

    case 'swipe': {
      const args = [String(params.direction)];
      if (params.distance != null) args.push(String(params.distance));
      return { command: 'swipe', args };
    }

    case 'mouse': {
      const args = [String(params.action)];
      const act = String(params.action);
      if (act === 'move' || act === 'click') {
        args.push(String(params.x), String(params.y));
        if (act === 'click' && params.button) args.push(String(params.button));
      } else if (act === 'down' || act === 'up') {
        if (params.button) args.push(String(params.button));
      } else if (act === 'wheel') {
        args.push(String(params.dy));
        if (params.dx != null) args.push(String(params.dx));
      }
      return { command: 'mouse', args };
    }

    case 'keyboard':
      return { command: 'keyboard', args: [String(params.action), String(params.text)] };

    case 'set': {
      const sub = String(params.subcommand);
      const args = [sub];
      if (sub === 'geo') {
        args.push(String(params.lat), String(params.lng));
      } else if (sub === 'media') {
        args.push(String(params.scheme));
      }
      return { command: 'set', args };
    }

    // ─── META ──────────────────────────────────────────
    case 'tabs':
    case 'status':
    case 'url':
    case 'stop':
    case 'restart':
    case 'snapshot-diff':
    case 'sessions':
    case 'inspect':
    case 'doctor':
    case 'upgrade':
    case 'resume':
      return { command: rawCommand, args: [] };

    case 'tab':
      return { command: 'tab', args: [String(params.id)] };

    case 'newtab': {
      const args: string[] = [];
      if (params.url) args.push(String(params.url));
      return { command: 'newtab', args };
    }

    case 'closetab': {
      const args: string[] = [];
      if (params.id != null) args.push(String(params.id));
      return { command: 'closetab', args };
    }

    case 'screenshot': {
      const args: string[] = [];
      if (params.annotate) args.push('--annotate');
      if (params.full) args.push('--full');
      if (params.clip) { args.push('--clip', String(params.clip)); }
      if (params.selector) args.push(String(params.selector));
      if (params.path) args.push(String(params.path));
      return { command: 'screenshot', args };
    }

    case 'pdf': {
      const args: string[] = [];
      if (params.path) args.push(String(params.path));
      return { command: 'pdf', args };
    }

    case 'responsive': {
      const args: string[] = [];
      if (params.prefix) args.push(String(params.prefix));
      return { command: 'responsive', args };
    }

    case 'chain':
      return { command: 'chain', args: [String(params.commands)] };

    case 'diff':
      return { command: 'diff', args: [String(params.url1), String(params.url2)] };

    case 'snapshot': {
      const args: string[] = [];
      if (params.interactive) args.push('-i');
      if (params.compact) args.push('-c');
      if (params.cursor) args.push('-C');
      if (params.viewport) args.push('-V');
      if (params.full) args.push('-f');
      if (params.depth != null) { args.push('-d', String(params.depth)); }
      if (params.selector) { args.push('-s', String(params.selector)); }
      return { command: 'snapshot', args };
    }

    case 'screenshot-diff': {
      const args = [String(params.baseline)];
      if (params.current) args.push(String(params.current));
      if (params.threshold != null) { args.push('--threshold', String(params.threshold)); }
      if (params.full) args.push('--full');
      return { command: 'screenshot-diff', args };
    }

    case 'session-close':
      return { command: 'session-close', args: [String(params.id)] };

    case 'frame':
      return { command: 'frame', args: [String(params.selector)] };

    case 'state': {
      const args = [String(params.action)];
      if (params.name) args.push(String(params.name));
      if (params.action === 'clean' && params.older_than != null) {
        args.push('--older-than', String(params.older_than));
      }
      return { command: 'state', args };
    }

    case 'find': {
      const args = [String(params.type), String(params.query)];
      if (params.name) args.push(String(params.name));
      return { command: 'find', args };
    }

    case 'auth': {
      const args = [String(params.action)];
      if (params.name) args.push(String(params.name));
      if (params.action === 'save') {
        if (params.url) args.push(String(params.url));
        if (params.username) args.push(String(params.username));
        if (params.password) args.push(String(params.password));
      }
      return { command: 'auth', args };
    }

    case 'har': {
      const args = [String(params.action)];
      if (params.action === 'stop' && params.path) args.push(String(params.path));
      return { command: 'har', args };
    }

    case 'video': {
      const args = [String(params.action)];
      if (params.action === 'start' && params.dir) args.push(String(params.dir));
      return { command: 'video', args };
    }

    case 'record': {
      const args = [String(params.action)];
      if (params.action === 'export') {
        if (params.format) args.push(String(params.format));
        if (params.path) args.push(String(params.path));
      }
      return { command: 'record', args };
    }

    case 'cookie-import': {
      const args: string[] = [];
      if (params.list) {
        args.push('--list');
      } else {
        if (params.browser) args.push(String(params.browser));
        if (params.domain) { args.push('--domain', String(params.domain)); }
        if (params.profile) { args.push('--profile', String(params.profile)); }
      }
      return { command: 'cookie-import', args };
    }

    case 'handoff': {
      const args: string[] = [];
      if (params.message) args.push(String(params.message));
      return { command: 'handoff', args };
    }

    case 'profile': {
      const args = [String(params.action)];
      if (params.action === 'delete' && params.name) args.push(String(params.name));
      if (params.action === 'clean' && params.older_than != null) {
        args.push('--older-than', String(params.older_than));
      }
      return { command: 'profile', args };
    }

    case 'react-devtools': {
      const args = [String(params.action)];
      if (params.selector) args.push(String(params.selector));
      return { command: 'react-devtools', args };
    }

    case 'provider': {
      const args = [String(params.action)];
      if (params.name) args.push(String(params.name));
      if (params.api_key) args.push(String(params.api_key));
      return { command: 'provider', args };
    }

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}
