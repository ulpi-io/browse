/**
 * MCP (Model Context Protocol) server for @ulpi/browse.
 *
 * Exposes all browse commands as MCP tools over stdio transport.
 * Each tool call maps to a browse command executed against a local
 * BrowserManager instance (no HTTP server needed).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserManager } from './browser-manager';
import { SessionBuffers } from './buffers';
import { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS, rewriteError } from './command-registry';
import { handleReadCommand } from './commands/read';
import { handleWriteCommand } from './commands/write';
import { handleMetaCommand } from './commands/meta';
import { getToolDefinitions, mapToolCallToCommand } from './mcp-tools';

/**
 * Start the MCP server.
 *
 * Launches a headless Chromium browser, registers all browse commands as
 * MCP tools, and communicates over stdio using the MCP protocol.
 *
 * @param jsonMode - When true, wraps results as { success, data, command } JSON.
 */
export async function startMcpServer(jsonMode: boolean): Promise<void> {
  // ─── Browser Setup ──────────────────────────────────────────────
  const buffers = new SessionBuffers();
  const bm = new BrowserManager(buffers);
  await bm.launch();

  // ─── MCP Server ─────────────────────────────────────────────────
  const server = new Server(
    { name: 'browse', version: '1.1.1' },
    { capabilities: { tools: {} } }
  );

  // ─── List Tools ─────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getToolDefinitions() };
  });

  // ─── Call Tool ──────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>;

    let command: string;
    let args: string[];
    try {
      ({ command, args } = mapToolCallToCommand(toolName, toolArgs));
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }

    try {
      let result: string;

      if (READ_COMMANDS.has(command)) {
        result = await handleReadCommand(command, args, bm, buffers);
      } else if (WRITE_COMMANDS.has(command)) {
        result = await handleWriteCommand(command, args, bm);
      } else if (META_COMMANDS.has(command)) {
        result = await handleMetaCommand(
          command, args, bm,
          async () => { await cleanup(); }
        );
      } else {
        return {
          content: [{ type: 'text' as const, text: `Unknown command: ${command}` }],
          isError: true,
        };
      }

      // Snapshot commands: return structured refs alongside text content
      if (command === 'snapshot') {
        const refs: Record<string, { role: string; name: string }> = {};
        for (const line of result.split('\n')) {
          const match = line.match(/^(@e\d+)\s+\[(\w+)\]\s+"?([^"]*)"?/);
          if (match) {
            refs[match[1]] = { role: match[2], name: match[3] };
          }
        }

        return {
          content: [
            { type: 'text' as const, text: jsonMode ? JSON.stringify({ success: true, data: result, command }) : result },
            {
              type: 'resource' as const,
              resource: {
                uri: 'browse://refs',
                mimeType: 'application/json',
                text: JSON.stringify(refs),
              },
            },
          ],
        };
      }

      if (jsonMode) {
        const wrapped = JSON.stringify({ success: true, data: result, command });
        return {
          content: [{ type: 'text' as const, text: wrapped }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (err: any) {
      const friendlyError = rewriteError(err.message);

      if (jsonMode) {
        const wrapped = JSON.stringify({ success: false, error: friendlyError, command });
        return {
          content: [{ type: 'text' as const, text: wrapped }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: friendlyError }],
        isError: true,
      };
    }
  });

  // ─── Cleanup ────────────────────────────────────────────────────
  let isShuttingDown = false;

  async function cleanup() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await bm.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // ─── Connect ────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
