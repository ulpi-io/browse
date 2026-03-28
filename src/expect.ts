/**
 * Expect condition parser and checker — shared by `expect` meta command
 * and `wait --request` write command.
 *
 * Parses declarative conditions from CLI args and checks them against
 * the current page state and session buffers.
 */

import type { Page } from 'playwright';
import type { BrowserTarget } from './browser/target';
import type { SessionBuffers, NetworkEntry } from './network/buffers';

// ─── Types ──────────────────────────────────────────────────────

export type ConditionType = 'url' | 'text' | 'visible' | 'hidden' | 'count' | 'request';
export type Comparator = 'eq' | 'gt' | 'lt';

export interface ExpectCondition {
  type: ConditionType;
  value: string;
  comparator?: Comparator;
  threshold?: number;
  /** For --request: expected HTTP status code */
  status?: number;
}

export interface CheckResult {
  passed: boolean;
  description: string;
  actual: string;
}

// ─── Arg Parser ─────────────────────────────────────────────────

/**
 * Parse expect CLI args into structured conditions and timeout.
 *
 * Supported flags:
 *   --url "/path"              URL contains check
 *   --text "Some text"         Text visibility check
 *   --visible ".selector"      Element visibility check
 *   --hidden ".selector"       Element hidden check
 *   --count ".selector"        Element count (requires --eq, --gt, or --lt)
 *   --request "POST /api"      Network buffer search (method + URL pattern)
 *   --status 200               Expected status code (requires --request)
 *   --eq N / --gt N / --lt N   Comparator for --count
 *   --timeout ms               Polling timeout (default 3000)
 *   --verbose                  Verbose output on success
 */
export function parseExpectArgs(args: string[]): {
  conditions: ExpectCondition[];
  timeout: number;
  verbose: boolean;
} {
  const conditions: ExpectCondition[] = [];
  let timeout = 3000;
  let verbose = false;

  // Pending state for multi-flag conditions
  let pendingCount: { value: string } | null = null;
  let pendingRequest: { value: string } | null = null;
  let pendingComparator: Comparator | null = null;
  let pendingThreshold: number | null = null;
  let pendingStatus: number | null = null;

  const flushCount = () => {
    if (pendingCount) {
      if (pendingComparator == null || pendingThreshold == null) {
        throw new Error(`--count "${pendingCount.value}" requires a comparator (--eq, --gt, or --lt) with a number`);
      }
      conditions.push({
        type: 'count',
        value: pendingCount.value,
        comparator: pendingComparator,
        threshold: pendingThreshold,
      });
      pendingCount = null;
      pendingComparator = null;
      pendingThreshold = null;
    }
  };

  const flushRequest = () => {
    if (pendingRequest) {
      conditions.push({
        type: 'request',
        value: pendingRequest.value,
        status: pendingStatus ?? undefined,
      });
      pendingRequest = null;
      pendingStatus = null;
    }
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--url': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--url requires a value (e.g. --url "/checkout")');
        conditions.push({ type: 'url', value: val });
        break;
      }

      case '--text': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--text requires a value (e.g. --text "Order confirmed")');
        conditions.push({ type: 'text', value: val });
        break;
      }

      case '--visible': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--visible requires a selector (e.g. --visible ".banner")');
        conditions.push({ type: 'visible', value: val });
        break;
      }

      case '--hidden': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--hidden requires a selector (e.g. --hidden ".modal")');
        conditions.push({ type: 'hidden', value: val });
        break;
      }

      case '--count': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--count requires a selector (e.g. --count ".item" --eq 3)');
        pendingCount = { value: val };
        break;
      }

      case '--request': {
        flushCount();
        flushRequest();
        const val = args[++i];
        if (!val) throw new Error('--request requires a value (e.g. --request "POST /api")');
        pendingRequest = { value: val };
        break;
      }

      case '--status': {
        if (!pendingRequest) {
          throw new Error('--status requires a preceding --request (e.g. --request "POST /api" --status 200)');
        }
        const val = args[++i];
        if (!val || isNaN(parseInt(val, 10))) throw new Error('--status requires a number (e.g. --status 200)');
        pendingStatus = parseInt(val, 10);
        break;
      }

      case '--eq': {
        if (!pendingCount) throw new Error('--eq requires a preceding --count');
        const val = args[++i];
        if (!val || isNaN(parseInt(val, 10))) throw new Error('--eq requires a number');
        pendingComparator = 'eq';
        pendingThreshold = parseInt(val, 10);
        break;
      }

      case '--gt': {
        if (!pendingCount) throw new Error('--gt requires a preceding --count');
        const val = args[++i];
        if (!val || isNaN(parseInt(val, 10))) throw new Error('--gt requires a number');
        pendingComparator = 'gt';
        pendingThreshold = parseInt(val, 10);
        break;
      }

      case '--lt': {
        if (!pendingCount) throw new Error('--lt requires a preceding --count');
        const val = args[++i];
        if (!val || isNaN(parseInt(val, 10))) throw new Error('--lt requires a number');
        pendingComparator = 'lt';
        pendingThreshold = parseInt(val, 10);
        break;
      }

      case '--timeout': {
        const val = args[++i];
        if (!val || isNaN(parseInt(val, 10))) throw new Error('--timeout requires a number in milliseconds');
        timeout = parseInt(val, 10);
        break;
      }

      case '--verbose': {
        verbose = true;
        break;
      }

      default:
        throw new Error(`Unknown expect flag: ${arg}. Use --url, --text, --visible, --hidden, --count, --request, --status, --eq, --gt, --lt, --timeout, --verbose`);
    }
  }

  // Flush any pending multi-flag conditions
  flushCount();
  flushRequest();

  if (conditions.length === 0) {
    throw new Error('Usage: browse expect <conditions>\n  --url "/path"  --text "text"  --visible ".sel"  --hidden ".sel"\n  --count ".sel" --eq|--gt|--lt N  --request "METHOD /path" [--status N]\n  [--timeout ms] [--verbose]');
  }

  return { conditions, timeout, verbose };
}

// ─── Condition Checker ──────────────────────────────────────────

/**
 * Check all conditions against the current page state and buffers.
 * Returns one CheckResult per condition.
 */
export async function checkConditions(
  conditions: ExpectCondition[],
  page: Page,
  bm: BrowserTarget,
  buffers?: SessionBuffers,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const cond of conditions) {
    switch (cond.type) {
      case 'url': {
        const currentUrl = page.url();
        const passed = currentUrl.includes(cond.value);
        results.push({
          passed,
          description: `URL contains "${cond.value}"`,
          actual: currentUrl,
        });
        break;
      }

      case 'text': {
        let visible = false;
        try {
          visible = await page.getByText(cond.value).first().isVisible({ timeout: 100 });
        } catch {
          // Element not found or timeout — treat as not visible
        }
        results.push({
          passed: visible,
          description: `Text "${cond.value}" is visible`,
          actual: visible ? 'visible' : 'not found',
        });
        break;
      }

      case 'visible': {
        let visible = false;
        try {
          const resolved = bm.resolveRef(cond.value);
          const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
          visible = await locator.first().isVisible({ timeout: 100 });
        } catch {
          // Element not found
        }
        results.push({
          passed: visible,
          description: `"${cond.value}" is visible`,
          actual: visible ? 'visible' : 'not visible',
        });
        break;
      }

      case 'hidden': {
        let hidden = true;
        try {
          const resolved = bm.resolveRef(cond.value);
          const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
          const count = await locator.count();
          if (count === 0) {
            hidden = true;
          } else {
            hidden = await locator.first().isHidden({ timeout: 100 });
          }
        } catch {
          // Element not found — treat as hidden
          hidden = true;
        }
        results.push({
          passed: hidden,
          description: `"${cond.value}" is hidden`,
          actual: hidden ? 'hidden' : 'visible',
        });
        break;
      }

      case 'count': {
        let count = 0;
        try {
          const resolved = bm.resolveRef(cond.value);
          const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
          count = await locator.count();
        } catch {
          // Selector error
        }
        const cmp = cond.comparator!;
        const threshold = cond.threshold!;
        let passed = false;
        if (cmp === 'eq') passed = count === threshold;
        else if (cmp === 'gt') passed = count > threshold;
        else if (cmp === 'lt') passed = count < threshold;

        const op = cmp === 'eq' ? '==' : cmp === 'gt' ? '>' : '<';
        results.push({
          passed,
          description: `count("${cond.value}") ${op} ${threshold}`,
          actual: String(count),
        });
        break;
      }

      case 'request': {
        const match = matchNetworkRequest(cond, buffers);
        results.push({
          passed: match.found,
          description: `Request matching "${cond.value}"${cond.status != null ? ` with status ${cond.status}` : ''}`,
          actual: match.description,
        });
        break;
      }
    }
  }

  return results;
}

// ─── Network Request Matcher ────────────────────────────────────

/**
 * Search network buffer for a request matching "METHOD /url-pattern".
 * Reused by both `expect --request` and `wait --request`.
 */
export function matchNetworkRequest(
  cond: Pick<ExpectCondition, 'value' | 'status'>,
  buffers?: SessionBuffers,
): { found: boolean; description: string; entry?: NetworkEntry } {
  if (!buffers) {
    return { found: false, description: 'no network buffer available' };
  }

  const { method, pattern } = parseRequestValue(cond.value);

  // Search from newest to oldest for the most recent match
  for (let i = buffers.networkBuffer.length - 1; i >= 0; i--) {
    const entry = buffers.networkBuffer[i];

    // Match method (if specified)
    if (method && entry.method.toUpperCase() !== method) continue;

    // Match URL pattern (substring match)
    if (!entry.url.includes(pattern)) continue;

    // Match status (if specified)
    if (cond.status != null) {
      if (entry.status == null) continue; // Request still pending
      if (entry.status !== cond.status) continue;
    } else {
      // No status filter — but request must be completed
      if (entry.status == null) continue;
    }

    const duration = entry.duration != null ? ` (${entry.duration}ms)` : '';
    return {
      found: true,
      description: `${entry.method} ${entry.url} -> ${entry.status}${duration}`,
      entry,
    };
  }

  // Find the closest partial match for a helpful error message
  const partialMatches: string[] = [];
  for (let i = buffers.networkBuffer.length - 1; i >= 0; i--) {
    const entry = buffers.networkBuffer[i];
    const methodMatch = !method || entry.method.toUpperCase() === method;
    const urlMatch = entry.url.includes(pattern);
    if (methodMatch || urlMatch) {
      const status = entry.status != null ? String(entry.status) : 'pending';
      partialMatches.push(`${entry.method} ${entry.url} -> ${status}`);
      if (partialMatches.length >= 3) break;
    }
  }

  const desc = partialMatches.length > 0
    ? `no match (closest: ${partialMatches[0]})`
    : 'no matching requests in buffer';

  return { found: false, description: desc };
}

/**
 * Parse a request value like "POST /api/order" into method and URL pattern.
 * If no method prefix, matches any method.
 */
export function parseRequestValue(value: string): { method: string | null; pattern: string } {
  const parts = value.trim().split(/\s+/);
  const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

  if (parts.length >= 2 && HTTP_METHODS.has(parts[0].toUpperCase())) {
    return { method: parts[0].toUpperCase(), pattern: parts.slice(1).join(' ') };
  }

  return { method: null, pattern: value };
}
