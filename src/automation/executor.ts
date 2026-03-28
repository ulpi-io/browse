/**
 * Command executor pipeline — single execution path for all commands.
 *
 * Centralizes:
 *   - Command lookup via registry (definition or spec)
 *   - Lifecycle hooks (before/after/onError)
 *   - Action context enrichment for write commands
 *   - Recording hooks
 *   - Error shaping
 *
 * Used by both HTTP server and MCP server.
 * Future flow/retry/watch execution (v2.1) and plugins (v2.2) will also use this.
 */

import type { CommandSpec, CommandDefinition, CommandContext } from './command';
import type { CommandLifecycle, CommandEvent, AfterCommandEvent, CommandErrorEvent } from './events';
import { registry, ensureDefinitionsRegistered } from './registry';

/** Options passed to executeCommand by the transport layer */
export interface ExecuteOptions {
  /** Lifecycle hooks to apply (transport-specific) */
  lifecycle?: CommandLifecycle;
  /**
   * Legacy handler for commands not yet migrated to CommandDefinition.
   * Once all commands are definition-backed, this will be removed.
   */
  legacyHandler?: (command: string, args: string[], spec: CommandSpec) => Promise<string>;
  /** Execution context for definition-backed commands */
  context?: CommandContext;
}

/** Result of command execution */
export interface ExecuteResult {
  /** Final command output (after lifecycle enrichment) */
  output: string;
  /** The resolved command spec */
  spec: CommandSpec;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Execute a command through the shared pipeline.
 *
 * Resolution order:
 *   1. If the command has a registered CommandDefinition with execute(), use it
 *   2. If a legacyHandler is provided in opts, use it (temporary migration path)
 *   3. Otherwise throw
 */
export async function executeCommand(
  command: string,
  args: string[],
  handler: ((command: string, args: string[], spec: CommandSpec) => Promise<string>) | null,
  opts?: ExecuteOptions,
): Promise<ExecuteResult> {
  // Ensure definitions are registered on first call
  await ensureDefinitionsRegistered();

  const spec = registry.get(command);
  if (!spec) {
    throw new Error(`Unknown command: ${command}`);
  }

  const event: CommandEvent = {
    command,
    args,
    category: spec.category,
  };

  // ─── Before hooks ──────────────────────────────────────
  if (opts?.lifecycle?.before) {
    for (const hook of opts.lifecycle.before) {
      const result = await hook(event);
      if (result && 'abort' in result && result.abort) {
        return {
          output: result.result,
          spec,
          durationMs: 0,
        };
      }
    }
  }

  // ─── Execute ───────────────────────────────────────────
  const start = Date.now();
  let output: string;

  try {
    // Prefer definition-backed execution
    const definition = registry.getDefinition(command);
    if (definition && opts?.context) {
      output = await definition.execute({ ...opts.context, args });
    } else if (handler) {
      // Legacy path — transport-provided handler
      output = await handler(command, args, spec);
    } else {
      throw new Error(`Command '${command}' has no registered execute function and no legacy handler was provided`);
    }
  } catch (err: any) {
    const durationMs = Date.now() - start;

    // ─── Error hooks ───────────────────────────────────
    if (opts?.lifecycle?.onError) {
      const errorEvent: CommandErrorEvent = { ...event, error: err };
      let errorMsg = err.message;
      for (const hook of opts.lifecycle.onError) {
        errorMsg = await hook({ ...errorEvent, error: new Error(errorMsg) });
      }
      const enrichedError = new Error(errorMsg);
      enrichedError.name = err.name;
      throw enrichedError;
    }
    throw err;
  }

  const durationMs = Date.now() - start;

  // ─── After hooks ───────────────────────────────────────
  if (opts?.lifecycle?.after) {
    const afterEvent: AfterCommandEvent = { ...event, result: output, durationMs, spec };
    for (const hook of opts.lifecycle.after) {
      output = await hook({ ...afterEvent, result: output });
    }
  }

  return { output, spec, durationMs };
}
