/**
 * Command registry — shared between HTTP server and MCP server.
 *
 * Exports command sets (READ/WRITE/META) and AI-friendly error rewriting.
 */

export const READ_COMMANDS = new Set([
  'text', 'html', 'links', 'forms', 'accessibility',
  'js', 'eval', 'css', 'attrs', 'element-state', 'dialog',
  'console', 'network', 'cookies', 'storage', 'perf', 'devices',
  'value', 'count', 'clipboard',
  'box', 'errors',
]);

export const WRITE_COMMANDS = new Set([
  'goto', 'back', 'forward', 'reload',
  'click', 'dblclick', 'fill', 'select', 'hover', 'focus', 'check', 'uncheck',
  'type', 'press', 'scroll', 'wait',
  'viewport', 'cookie', 'header', 'useragent',
  'upload', 'dialog-accept', 'dialog-dismiss', 'emulate',
  'drag', 'keydown', 'keyup',
  'highlight', 'download', 'route', 'offline',
  'rightclick', 'tap', 'swipe', 'mouse', 'keyboard',
  'scrollinto', 'scrollintoview', 'set',
]);

export const META_COMMANDS = new Set([
  'tabs', 'tab', 'newtab', 'closetab',
  'status', 'stop', 'restart',
  'screenshot', 'pdf', 'responsive',
  'chain', 'diff',
  'url', 'snapshot', 'snapshot-diff', 'screenshot-diff',
  'sessions', 'session-close',
  'frame', 'state', 'find',
  'auth', 'har', 'video', 'inspect', 'record', 'cookie-import',
  'doctor', 'upgrade', 'handoff', 'resume', 'profile',
  'react-devtools',
]);

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
