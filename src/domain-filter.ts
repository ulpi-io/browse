/**
 * Domain filter — blocks navigation and sub-resource requests outside an allowlist.
 *
 * Supports:
 *   - Exact domain: "example.com" matches only example.com
 *   - Wildcard: "*.example.com" matches example.com AND any subdomain
 *   - Case-insensitive matching
 */

export class DomainFilter {
  private domains: string[];

  constructor(domains: string[]) {
    this.domains = domains.map(d => d.toLowerCase());
  }

  /**
   * Check if a URL's domain is in the allowlist.
   * Returns true if allowed, false if blocked.
   * Non-HTTP URLs (about:blank, data:, etc.) are always allowed.
   */
  isAllowed(url: string): boolean {
    // Block file:// and javascript: URLs — security risk
    if (url.startsWith('file://') || url.startsWith('javascript:')) {
      return false;
    }
    // Non-HTTP(S) URLs (about:blank, data:, blob:) are always allowed
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return true;
    }

    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return false; // Invalid URL = blocked
    }

    for (const pattern of this.domains) {
      if (pattern.startsWith('*.')) {
        // Wildcard: *.example.com matches example.com itself AND any subdomain
        const base = pattern.slice(2); // "example.com"
        if (hostname === base || hostname.endsWith('.' + base)) {
          return true;
        }
      } else {
        // Exact match
        if (hostname === pattern) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get a human-readable error message for a blocked URL.
   */
  blockedMessage(url: string): string {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {}
    return `Domain "${hostname}" is not in the allowed list: ${this.domains.join(', ')}`;
  }

  /**
   * Generate a JS init script that wraps WebSocket, EventSource, and
   * navigator.sendBeacon with domain checks. Playwright's context.route()
   * only covers HTTP — these JS-level APIs bypass it entirely.
   *
   * Injected via context.addInitScript() so it runs before any page JS.
   */
  generateInitScript(): string {
    const domainsJson = JSON.stringify(this.domains);
    return `(function() {
  const __allowedDomains = ${domainsJson};

  function __isAllowed(url) {
    if (!url) return true;
    var str = String(url);
    // Normalize ws/wss to http/https for URL parsing
    if (str.startsWith('ws://')) str = 'http://' + str.slice(5);
    else if (str.startsWith('wss://')) str = 'https://' + str.slice(6);
    // Block file:// and javascript: URLs
    if (str.startsWith('file://') || str.startsWith('javascript:')) return false;
    // Non-HTTP(S) always allowed (data:, blob:, about:)
    if (!str.startsWith('http://') && !str.startsWith('https://')) return true;
    var hostname;
    try { hostname = new URL(str).hostname.toLowerCase(); } catch(e) { return false; }
    for (var i = 0; i < __allowedDomains.length; i++) {
      var pattern = __allowedDomains[i];
      if (pattern.startsWith('*.')) {
        var base = pattern.slice(2);
        if (hostname === base || hostname.endsWith('.' + base)) return true;
      } else {
        if (hostname === pattern) return true;
      }
    }
    return false;
  }

  // Wrap WebSocket
  var OrigWebSocket = window.WebSocket;
  if (OrigWebSocket) {
    window.WebSocket = function(url, protocols) {
      if (!__isAllowed(url)) throw new Error('WebSocket blocked by domain filter: ' + url);
      if (protocols !== undefined) return new OrigWebSocket(url, protocols);
      return new OrigWebSocket(url);
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  }

  // Wrap EventSource
  var OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    window.EventSource = function(url, opts) {
      if (!__isAllowed(url)) throw new Error('EventSource blocked by domain filter: ' + url);
      if (opts !== undefined) return new OrigEventSource(url, opts);
      return new OrigEventSource(url);
    };
    window.EventSource.prototype = OrigEventSource.prototype;
  }

  // Wrap navigator.sendBeacon
  if (navigator.sendBeacon) {
    var origSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(url, data) {
      if (!__isAllowed(url)) return false;
      return origSendBeacon(url, data);
    };
  }
})();`;
  }
}
