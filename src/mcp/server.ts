/**
 * MCP (Model Context Protocol) server for @ulpi/browse.
 *
 * Exposes all browse commands as MCP tools over stdio transport.
 * Each tool call maps to a browse command executed against a local
 * BrowserTarget instance (no HTTP server needed).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SessionBuffers } from '../network/buffers';
import { rewriteError } from '../automation/registry';
import { getToolDefinitions, mapToolCallToCommand } from './tools/index';
import { prepareWriteContext, finalizeWriteContext } from '../automation/action-context';
import { executeCommand } from '../automation/executor';
import { createBrowserTargetFactory } from '../session/target-factory';
import type { BrowserTarget } from '../browser/target';
import type { ContextLevel, WriteContextCapture } from '../types';

/**
 * Start the MCP server.
 *
 * Launches a headless Chromium browser, registers all browse commands as
 * MCP tools, and communicates over stdio using the MCP protocol.
 *
 * @param jsonMode - When true, wraps results as { success, data, command } JSON.
 */
/** MCP-level context level — default to 'state' (always-on for MCP write commands). */
let mcpContextLevel: ContextLevel = 'state';

export async function startMcpServer(jsonMode: boolean): Promise<void> {
  // ─── Browser Setup ──────────────────────────────────────────────
  const { getRuntime } = await import('../engine/resolver');
  const runtime = await getRuntime(process.env.BROWSE_RUNTIME);
  const buffers = new SessionBuffers();

  let browser: import('playwright').Browser;
  if (runtime.browser) {
    // Process runtime (e.g. lightpanda) — browser already connected
    browser = runtime.browser;
  } else {
    // Library runtime (playwright, rebrowser) — launch Chromium
    const chromium = runtime.chromium;
    browser = await chromium.launch({ headless: process.env.BROWSE_HEADED !== '1' });
  }

  const factory = createBrowserTargetFactory(browser);
  const ct = await factory.create(buffers, false);
  const bm = ct.target as BrowserTarget;

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
      let writeCapture: WriteContextCapture | null = null;

      const lifecycle: import('../automation/events').CommandLifecycle = {
          before: [async (event) => {
            // Write context capture
            if (event.category === 'write') {
              writeCapture = await prepareWriteContext(mcpContextLevel, bm, buffers);
            }
          }],
          after: [async (event) => {
            let res = event.result;
            // Write context finalization
            if (event.category === 'write') {
              if (writeCapture) {
                res = await finalizeWriteContext(writeCapture, bm, buffers, res, event.command);
                writeCapture = null;
              }
              // Detect `set context` command
              if (event.command === 'set' && event.args[0] === 'context') {
                const val = (event.args[1] as string)?.toLowerCase();
                mcpContextLevel = val === 'on' || val === 'state' ? 'state'
                  : val === 'delta' ? 'delta'
                  : val === 'full' ? 'full'
                  : val === 'off' ? 'off'
                  : mcpContextLevel;
              }
            }
            return res;
          }],
          onError: [async (event) => rewriteError(event.error.message)],
      };

      const { output: result, spec } = await executeCommand(command, args, {
        context: {
          args,
          target: bm,
          buffers,
          shutdown: async () => { await cleanup(); },
          lifecycle,
        },
        lifecycle,
      });

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
      // Error already rewritten by onError hook
      const friendlyError = err.message;

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
