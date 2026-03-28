/**
 * MCP tool definitions registry — derives tool definitions from the
 * command registry's MCP metadata. No hand-maintained tool arrays.
 */

import { registry } from '../../automation/registry';

// ─── Tool Definition Types ─────────────────────────────────────────

export interface ToolProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Returns all MCP tool definitions for browse commands.
 * Derived from registry — commands with `mcp` metadata are exposed as tools.
 */
export function getToolDefinitions(): ToolDefinition[] {
  return registry.all()
    .filter(s => s.mcp)
    .map(s => ({
      name: 'browse_' + s.name.replace(/-/g, '_'),
      description: s.mcp!.description,
      inputSchema: s.mcp!.inputSchema as ToolDefinition['inputSchema'],
    }));
}

/**
 * Map an MCP tool call to a browse command + args array.
 *
 * Looks up the command definition (preferred) or spec in the registry and uses
 * its argDecode function to convert MCP params into CLI args. Virtual tools
 * (e.g. perf-audit-save) use `mcp.commandName` to route to the actual handler.
 */
export function mapToolCallToCommand(
  toolName: string,
  params: Record<string, unknown>
): { command: string; args: string[] } {
  // Strip "browse_" prefix and convert underscores back to hyphens
  const rawCommand = toolName.replace(/^browse_/, '').replace(/_/g, '-');

  // Look up the command spec in the registry
  const spec = registry.get(rawCommand);
  if (!spec?.mcp) {
    throw new Error(`Unknown MCP tool: ${toolName}`);
  }

  // Prefer definition's mcpArgDecode, fall back to spec's mcp.argDecode
  const def = registry.getDefinition(rawCommand);
  const argDecode = def?.mcpArgDecode ?? spec.mcp.argDecode;

  // Use the resolved argDecode, or fall back to collecting string param values
  const args = argDecode
    ? argDecode(params)
    : Object.values(params).filter(v => v != null).map(v => String(v));

  // Virtual tools may route to a different command name
  const command = spec.mcp.commandName || rawCommand;

  return { command, args };
}
