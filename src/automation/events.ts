/**
 * Command lifecycle hook contracts.
 *
 * Used by the executor pipeline (TASK-003) to centralize cross-cutting
 * concerns: context capture, recording, error shaping.
 *
 * Design constraints:
 *   - No imports from server, session, transport, or Playwright.
 *   - Hooks are pure contracts — implementations live in the executor.
 *   - BeforeCommandHook can abort execution (e.g. policy denial).
 *   - AfterCommandHook can enrich the result (e.g. action context).
 *   - CommandErrorHook can transform error messages (e.g. AI-friendly rewriting).
 */

// ─── Command Category ────────────────────────────────────────────

/** Command category for routing and lifecycle decisions */
export type CommandCategory = 'read' | 'write' | 'meta';

// ─── Event Payloads ──────────────────────────────────────────────

/** Immutable event payload shared by all lifecycle hooks */
export interface CommandEvent {
  /** Command name (e.g. 'goto', 'click', 'snapshot') */
  readonly command: string;
  /** Command arguments */
  readonly args: readonly string[];
  /** Resolved command category */
  readonly category: CommandCategory;
}

/** Payload for after-command hooks — includes execution result and timing */
export interface AfterCommandEvent extends CommandEvent {
  /** Raw command result before enrichment */
  readonly result: string;
  /** Wall-clock execution duration in milliseconds */
  readonly durationMs: number;
  /** The resolved command spec (for checking skipRecording, pageContent, etc.) */
  readonly spec?: import('./command').CommandSpec;
}

/** Payload for error hooks — includes the thrown error */
export interface CommandErrorEvent extends CommandEvent {
  /** The error thrown during command execution */
  readonly error: Error;
}

// ─── Hook Signatures ─────────────────────────────────────────────

/**
 * Invoked before command execution.
 * Return void to proceed, or return an abort signal to short-circuit
 * execution with a predetermined result (e.g. policy denial message).
 */
export type BeforeCommandHook = (
  event: CommandEvent,
) => Promise<void | { abort: true; result: string }>;

/**
 * Invoked after successful command execution.
 * Receives the result and returns an optionally enriched version
 * (e.g. with action context appended).
 */
export type AfterCommandHook = (
  event: AfterCommandEvent,
) => Promise<string>;

/**
 * Invoked when command execution throws.
 * Returns a transformed error message (e.g. AI-friendly rewriting).
 */
export type CommandErrorHook = (
  event: CommandErrorEvent,
) => Promise<string>;

// ─── Lifecycle Collection ────────────────────────────────────────

/**
 * Lifecycle hook collection for the executor pipeline.
 *
 * All arrays are optional. When present, hooks execute in order:
 *   - before: first abort wins, remaining hooks are skipped
 *   - after: each receives the previous hook's output (pipeline)
 *   - onError: each receives the previous hook's output (pipeline)
 */
export interface CommandLifecycle {
  before?: BeforeCommandHook[];
  after?: AfterCommandHook[];
  onError?: CommandErrorHook[];
}
