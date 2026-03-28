/**
 * MCP domain — public entrypoint.
 *
 * Exports the MCP server launcher and tool definition helpers.
 * Internal implementation lives in server.ts and tools/.
 */

export { startMcpServer } from './server';
export { getToolDefinitions, mapToolCallToCommand } from './tools/index';
export type { ToolDefinition, ToolProperty } from './tools/index';
