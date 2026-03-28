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

import type { CommandSpec, CommandContext } from './command';
import type { CommandLifecycle, CommandEvent, AfterCommandEvent, CommandErrorEvent } from './events';
import { registry, ensureDefinitionsRegistered } from './registry';

/** Options passed to executeCommand by the transport layer */
export interface ExecuteOptions {
  /** Lifecycle hooks to apply (transport-specific) */
  lifecycle?: CommandLifecycle;
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
 * Looks up the command's registered CommandDefinition and calls its execute().
 * If no definition exists, throws.
 */
export async function executeCommand(
  command: string,
  args: string[],
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
    const definition = registry.getDefinition(command);
    if (!definition) {
      throw new Error(`Command '${command}' has no registered execute function`);
    }
    if (!opts?.context) {
      throw new Error(`Command '${command}' requires an execution context`);
    }
    output = await definition.execute({ ...opts.context, args });
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
