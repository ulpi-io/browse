/**
 * CommandSpec — the single source of truth for command identity and metadata.
 *
 * Every command in the system is described by a CommandSpec. The registry
 * derives category sets, CLI help, MCP tool definitions, and future plugin
 * registration from these specs. No hand-maintained duplicated sets.
 */

import type { CommandCategory } from './events';

// ─── MCP Tool Metadata ───────────────────────────────────────────

/** MCP tool schema for commands exposed via Model Context Protocol */
export interface McpToolSpec {
  /** Tool description shown to LLMs */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * Decode MCP tool params into CLI args array.
   * If omitted, the default decoder collects string param values positionally.
   */
  argDecode?: (params: Record<string, unknown>) => string[];
  /**
   * Override the command name routed to by the MCP dispatcher.
   * Used by virtual tools (e.g. 'perf-audit-save' routes to 'perf-audit').
   * If omitted, the MCP tool name (after prefix/underscore conversion) is used.
   */
  commandName?: string;
}

// ─── Command Spec ────────────────────────────────────────────────

export interface CommandSpec {
  /** Command name (e.g. 'goto', 'click', 'snapshot') */
  name: string;
  /** Routing category */
  category: CommandCategory;
  /** Short description for CLI help */
  description: string;
  /** Argument format for CLI help (e.g. '<url>', '<sel> <val>') */
  usage?: string;

  // ─── Behavioral flags ───────────────────────────────────
  /** Skip action context enrichment on this write command */
  skipContext?: boolean;
  /** Skip recording this command in record sessions */
  skipRecording?: boolean;
  /** Safe to auto-retry after server restart (read-only / idempotent) */
  safeToRetry?: boolean;
  /** Returns page-derived content (for --content-boundaries wrapping) */
  pageContent?: boolean;

  // ─── MCP ────────────────────────────────────────────────
  /** MCP tool metadata. Omit for commands not exposed via MCP. */
  mcp?: McpToolSpec;
}

// ─── Execution Context ───────────────────────────────────────────

/** Context passed to command execute functions by the executor */
export interface CommandContext {
  /** Command arguments from the caller */
  args: string[];
  /** The session's automation target */
  target: import('../automation/target').AutomationTarget;
  /** Per-session buffers (console, network) */
  buffers: import('../network/buffers').SessionBuffers;
  /** Domain filter for the session (may be null) */
  domainFilter?: import('../security/domain-filter').DomainFilter | null;
  /** Session reference for commands that need session-level state */
  session?: unknown;
  /** Shutdown callback for server-control commands */
  shutdown?: () => Promise<void> | void;
  /** Session manager reference for multi-session commands */
  sessionManager?: unknown;
}

// ─── Command Definition ──────────────────────────────────────────

/**
 * CommandDefinition — executable command registration.
 *
 * This is the durable shape for built-in commands now and plugin commands later.
 * It combines metadata (CommandSpec) with execution logic and optional MCP
 * arg-decoding so the registry owns both discovery and dispatch.
 */
export interface CommandDefinition {
  /** Command metadata (category, description, usage, behavioral flags, MCP schema) */
  spec: CommandSpec;
  /** Execute the command. Returns the result string. */
  execute: (ctx: CommandContext) => Promise<string>;
  /**
   * Optional MCP arg-decoding: transforms MCP tool params into CLI args.
   * If omitted, the default decoder is used (simple positional mapping).
   */
  mcpArgDecode?: (params: Record<string, unknown>) => string[];
}

// ─── Command Registry ────────────────────────────────────────────

/**
 * Typed command registry — single authoritative source for command metadata.
 *
 * Server routing, MCP tool definitions, CLI help, and future plugin
 * registration all derive from this registry instead of maintaining
 * separate hand-edited sets.
 */
export class CommandRegistry {
  private specs = new Map<string, CommandSpec>();
  private definitions = new Map<string, CommandDefinition>();

  /** Register a metadata-only command spec. */
  register(spec: CommandSpec): void {
    if (this.specs.has(spec.name)) {
      throw new Error(`Duplicate command registration: '${spec.name}'`);
    }
    this.specs.set(spec.name, spec);
  }

  /** Register multiple metadata-only command specs. */
  registerAll(specs: CommandSpec[]): void {
    for (const spec of specs) this.register(spec);
  }

  /** Register an executable command definition (spec + execute + optional MCP arg-decode). */
  define(def: CommandDefinition): void {
    if (this.specs.has(def.spec.name)) {
      // Upgrade existing spec to a full definition
      this.specs.set(def.spec.name, def.spec);
    } else {
      this.specs.set(def.spec.name, def.spec);
    }
    this.definitions.set(def.spec.name, def);
  }

  /** Register multiple executable command definitions. */
  defineAll(defs: CommandDefinition[]): void {
    for (const def of defs) this.define(def);
  }

  /** Look up a command spec by name. */
  get(name: string): CommandSpec | undefined {
    return this.specs.get(name);
  }

  /** Look up a command definition by name. Returns undefined if spec-only (not yet migrated). */
  getDefinition(name: string): CommandDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Check if a command is registered. */
  has(name: string): boolean {
    return this.specs.has(name);
  }

  /** Check if a command has a full definition (not just metadata). */
  hasDefined(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Get the category of a command. */
  getCategory(name: string): CommandCategory | undefined {
    return this.specs.get(name)?.category;
  }

  /** Get all specs in a category. */
  byCategory(category: CommandCategory): CommandSpec[] {
    return [...this.specs.values()].filter(s => s.category === category);
  }

  /** Get command names in a category as a Set (backward-compatible). */
  categorySet(category: CommandCategory): Set<string> {
    return new Set(this.byCategory(category).map(s => s.name));
  }

  /** Get all registered specs. */
  all(): CommandSpec[] {
    return [...this.specs.values()];
  }

  /** Get all registered command definitions. */
  allDefinitions(): CommandDefinition[] {
    return [...this.definitions.values()];
  }

  /** Get all registered command names. */
  names(): string[] {
    return [...this.specs.keys()];
  }

  /** Number of registered commands. */
  get size(): number {
    return this.specs.size;
  }

  /** Number of commands with full definitions. */
  get definedCount(): number {
    return this.definitions.size;
  }
}
