/**
 * Shared buffers and types — extracted to break circular dependency
 * between server.ts and browser-manager.ts
 */

import { DEFAULTS } from './constants';

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

  addConsoleEntry(entry: LogEntry) {
    if (this.consoleBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
      this.consoleBuffer.shift();
    }
    this.consoleBuffer.push(entry);
    this.consoleTotalAdded++;
  }

  addNetworkEntry(entry: NetworkEntry) {
    if (this.networkBuffer.length >= DEFAULTS.BUFFER_HIGH_WATER_MARK) {
      this.networkBuffer.shift();
    }
    this.networkBuffer.push(entry);
    this.networkTotalAdded++;
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
