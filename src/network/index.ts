/**
 * Network domain — buffers, HAR export, and network types.
 */

export {
  type LogEntry,
  type NetworkEntry,
  SessionBuffers,
  consoleBuffer,
  networkBuffer,
  consoleTotalAdded,
  networkTotalAdded,
  addConsoleEntry,
  addNetworkEntry,
} from './buffers';

export {
  type HarRecording,
  formatAsHar,
} from './har';
