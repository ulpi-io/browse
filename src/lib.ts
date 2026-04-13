/**
 * Library entry point — public API for @ulpi/browse consumers.
 *
 * browse_cloud and other packages import from '@ulpi/browse' which
 * resolves to dist/lib.mjs (runtime) + dist/types/lib.d.ts (types).
 *
 * This file re-exports the ~25 symbols that cloud (and future consumers) need.
 * It is intentionally narrow — only export what external packages actually use.
 */

// ─── Session ────────────────────────────────────────────────────
export { SessionManager } from './session/manager';
export type { Session, RecordedStep } from './session/manager';

export { createBrowserTargetFactory } from './session/target-factory';
export type {
  SessionTargetFactory,
  CreatedTarget,
  TargetCreateOptions,
} from './session/target-factory';

export {
  saveSessionState,
  loadSessionState,
  hasPersistedState,
  freezeSession,
  resumeSession,
  hasFrozenManifest,
  loadFrozenManifest,
} from './session/persist';
export type { FrozenSessionManifest } from './session/persist';

// ─── Concurrency ────────────────────────────────────────────────
export { ConcurrencyLimiter, ConcurrencyLimitError, withUserLimit } from './session/concurrency';

// ─── Automation ─────────────────────────────────────────────────
export { executeCommand } from './automation/executor';
export type { ExecuteOptions, ExecuteResult } from './automation/executor';

export { registry, ensureDefinitionsRegistered } from './automation/registry';

// ─── Engine ─────────────────────────────────────────────────────
export { getRuntime } from './engine/resolver';
export type { BrowserRuntime } from './engine/resolver';

// ─── Network / Buffers ──────────────────────────────────────────
export { SessionBuffers } from './network/buffers';
export type { LogEntry, NetworkEntry } from './network/buffers';

// ─── Constants ──────────────────────────────────────────────────
export { DEFAULTS, CLOUD_DEFAULTS } from './constants';

// ─── Browser ───────────────────────────────────────────────────
export { BrowserManager } from './browser/manager';

// ─── Commands (test-only) ───────────────────────────────────────
export { handleWriteCommand } from './commands/write';
