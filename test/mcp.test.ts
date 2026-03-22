/**
 * Integration tests for MCP server mode.
 *
 * Spawns the MCP server as a child process, sends JSON-RPC messages
 * via stdin, and verifies responses on stdout.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { startTestServer } from './test-server';

let mcpProcess: ChildProcess;
let baseUrl: string;
let testServer: any;
let requestId = 0;

function nextId() { return ++requestId; }

function sendMessage(msg: any): void {
  mcpProcess.stdin!.write(JSON.stringify(msg) + '\n');
}

function waitForResponse(id: number, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for response id=${id}`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            cleanup();
            resolve(msg);
          }
        } catch {}
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      mcpProcess.stdout!.removeListener('data', onData);
    }

    mcpProcess.stdout!.on('data', onData);
  });
}

async function initialize(): Promise<void> {
  const id = nextId();
  sendMessage({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });
  await waitForResponse(id);
  sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  // Small delay for server to process notification
  await new Promise(r => setTimeout(r, 500));
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const id = nextId();
  sendMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const response = await waitForResponse(id);
  return response.result;
}

async function listTools(): Promise<any[]> {
  const id = nextId();
  sendMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  });
  const response = await waitForResponse(id);
  return response.result.tools;
}

describe('MCP Server', () => {
  beforeAll(async () => {
    // Start test fixture server
    const ts = await startTestServer(0);
    testServer = ts;
    baseUrl = ts.url;

    // Spawn MCP server
    const cliPath = path.resolve(__dirname, '..', 'src', 'cli.ts');
    mcpProcess = spawn('npx', ['tsx', cliPath, '--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.resolve(__dirname, '..'),
    });

    // Wait for process to start
    await new Promise(r => setTimeout(r, 2000));
    await initialize();
  }, 30000);

  afterAll(async () => {
    if (mcpProcess && !mcpProcess.killed) {
      mcpProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      if (!mcpProcess.killed) mcpProcess.kill('SIGKILL');
    }
    if (testServer) testServer.server.close();
  }, 15000);

  test('tools/list returns array of tools', async () => {
    const tools = await listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(50);
  });

  test('every tool has name, description, and inputSchema', async () => {
    const tools = await listTools();
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.name.startsWith('browse_')).toBe(true);
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('browse_goto navigates to URL', async () => {
    const result = await callTool('browse_goto', { url: baseUrl + '/basic.html' });
    expect(result.content[0].text).toContain('Navigated to');
    expect(result.content[0].text).toContain('200');
    expect(result.isError).toBeFalsy();
  });

  test('browse_text returns page content', async () => {
    const result = await callTool('browse_text');
    expect(result.content[0].text).toContain('Hello');
    expect(result.isError).toBeFalsy();
  });

  test('browse_snapshot returns refs', async () => {
    const result = await callTool('browse_snapshot', { interactive: true });
    expect(result.content[0].text).toContain('@e');
    expect(result.isError).toBeFalsy();
  });

  test('browse_click with ref works', async () => {
    // First get a snapshot to populate refs
    await callTool('browse_goto', { url: baseUrl + '/basic.html' });
    const snap = await callTool('browse_snapshot', { interactive: true });
    // Find a ref in the output
    const refMatch = snap.content[0].text.match(/@e\d+/);
    expect(refMatch).toBeTruthy();

    // Click the ref — should not error (may or may not navigate)
    const result = await callTool('browse_click', { selector: refMatch![0] });
    expect(result.isError).toBeFalsy();
  });

  test('browse_js evaluates expression', async () => {
    await callTool('browse_goto', { url: baseUrl + '/basic.html' });
    const result = await callTool('browse_js', { expression: 'document.title' });
    expect(result.content[0].text).toBeTruthy();
    expect(result.isError).toBeFalsy();
  });

  test('browse_url returns current URL', async () => {
    const result = await callTool('browse_url');
    expect(result.content[0].text).toContain('basic.html');
    expect(result.isError).toBeFalsy();
  });

  test('invalid tool returns error', async () => {
    const id = nextId();
    sendMessage({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'browse_nonexistent', arguments: {} },
    });
    const response = await waitForResponse(id);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Unknown');
  });

  test('missing required param returns error', async () => {
    // browse_goto requires url
    const result = await callTool('browse_goto', {});
    // Should either error or the handler should throw
    // The mapToolCallToCommand will pass undefined as url
    // The command handler should throw with usage error
    expect(result.isError).toBe(true);
  });

  test('browse_screenshot returns file path', async () => {
    await callTool('browse_goto', { url: baseUrl + '/basic.html' });
    const result = await callTool('browse_screenshot');
    expect(result.content[0].text).toContain('Screenshot saved');
    expect(result.isError).toBeFalsy();
  });

  test('browse_count returns number', async () => {
    await callTool('browse_goto', { url: baseUrl + '/basic.html' });
    const result = await callTool('browse_count', { selector: 'a' });
    const count = parseInt(result.content[0].text, 10);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(result.isError).toBeFalsy();
  });
});
