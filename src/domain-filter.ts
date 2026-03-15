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
    // Non-HTTP(S) URLs are always allowed
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
}
