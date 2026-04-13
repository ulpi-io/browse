/**
 * Shared buffers and types — extracted to break circular dependency
 * between server.ts and browser-manager.ts
 */

import { DEFAULTS } from '../constants';

export interface LogEntry {
  timestamp: number;
  level: string;
  text: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
  /** Request headers (populated when body capture is enabled) */
  requestHeaders?: Record<string, string>;
  /** Request body — POST/PUT/PATCH only (populated when body capture is enabled) */
  requestBody?: string;
  /** Response headers (populated when body capture is enabled) */
  responseHeaders?: Record<string, string>;
  /** Response body — text-like content types only, capped at NETWORK_BODY_LIMIT (populated when body capture is enabled) */
  responseBody?: string;
}

/**
 * Per-session buffer container.
 * Each session (or parallel agent) gets its own instance so buffers
 * don't bleed across concurrent operations.
 */
export class SessionBuffers {
  consoleBuffer: LogEntry[] = [];
  networkBuffer: NetworkEntry[] = [];
  consoleTotalAdded = 0;
  networkTotalAdded = 0;
  // Flush cursors — used by server.ts flush logic
  lastConsoleFlushed = 0;
  lastNetworkFlushed = 0;
  // Running counters — used by action-context.ts for O(1) state capture
  consoleErrorCount = 0;
  networkPendingCount = 0;

  // Optional streaming callbacks — used by cloud WebSocket to push events
  onConsoleEntry?: (entry: LogEntry) => void;
  onNetworkEntry?: (entry: NetworkEntry) => void;

  addConsoleEntry(entry: LogEntry) {
    if (this.consoleBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
      const evicted = this.consoleBuffer.shift()!;
      if (evicted.level === 'error') this.consoleErrorCount--;
    }
    this.consoleBuffer.push(entry);
    this.consoleTotalAdded++;
    if (entry.level === 'error') this.consoleErrorCount++;
    this.onConsoleEntry?.(entry);
  }

  addNetworkEntry(entry: NetworkEntry) {
    if (this.networkBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
      const evicted = this.networkBuffer.shift()!;
      if (evicted.status == null) this.networkPendingCount--;
    }
    this.networkBuffer.push(entry);
    this.networkTotalAdded++;
    if (entry.status == null) this.networkPendingCount++;
    this.onNetworkEntry?.(entry);
  }

  /** Called when a network entry gets its status (response arrived). */
  resolveNetworkEntry() {
    if (this.networkPendingCount > 0) this.networkPendingCount--;
  }
}

// ─── Default (singleton) buffers — backward compatibility ────────────
// Existing code that imports consoleBuffer, networkBuffer, addConsoleEntry,
// addNetworkEntry, consoleTotalAdded, networkTotalAdded continues to work
// unchanged against these module-level exports.

export const consoleBuffer: LogEntry[] = [];
export const networkBuffer: NetworkEntry[] = [];

// Total entries ever added — used by server.ts flush logic as a cursor
// that keeps advancing even after the ring buffer wraps.
export let consoleTotalAdded = 0;
export let networkTotalAdded = 0;

export function addConsoleEntry(entry: LogEntry) {
  if (consoleBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
    consoleBuffer.shift();
  }
  consoleBuffer.push(entry);
  consoleTotalAdded++;
}

export function addNetworkEntry(entry: NetworkEntry) {
  if (networkBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
    networkBuffer.shift();
  }
  networkBuffer.push(entry);
  networkTotalAdded++;
}
