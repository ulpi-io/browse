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
