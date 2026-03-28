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

function waitForResponse(id: number, timeoutMs = 30000): Promise<any> {
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

    // Wait for process to be ready — Chromium launch can take 5-10s under load
    await new Promise(r => setTimeout(r, 8000));
    await initialize();
  }, 60000);

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

  test('browse_provider list returns result', async () => {
    const result = await callTool('browse_provider', { action: 'list' });
    expect(result.isError).toBeFalsy();
    // Should return provider list (may be empty)
    expect(result.content[0].text).toBeDefined();
  });

  test('tool definitions include browse_provider', async () => {
    const tools = await listTools();
    const providerTool = tools.find((t: any) => t.name === 'browse_provider');
    expect(providerTool).toBeTruthy();
    expect(providerTool.description).toContain('cloud');
  });

  describe('Action Context in MCP', () => {
    test('write command includes context line on navigation', async () => {
      // First navigate somewhere
      const gotoId = nextId();
      sendMessage({
        jsonrpc: '2.0',
        id: gotoId,
        method: 'tools/call',
        params: { name: 'browse_goto', arguments: { url: baseUrl + '/basic.html' } },
      });
      const gotoResp = await waitForResponse(gotoId);
      expect(gotoResp.result).toBeDefined();

      // Now navigate to a different page — should include context delta
      const navId = nextId();
      sendMessage({
        jsonrpc: '2.0',
        id: navId,
        method: 'tools/call',
        params: { name: 'browse_goto', arguments: { url: baseUrl + '/forms.html' } },
      });
      const navResp = await waitForResponse(navId);
      expect(navResp.result).toBeDefined();
      const text = navResp.result.content[0].text;
      expect(text).toContain('[context]');
      expect(text).toContain('/forms.html');
    });

    test('read command does not include context line', async () => {
      const readId = nextId();
      sendMessage({
        jsonrpc: '2.0',
        id: readId,
        method: 'tools/call',
        params: { name: 'browse_text', arguments: {} },
      });
      const readResp = await waitForResponse(readId);
      expect(readResp.result).toBeDefined();
      const text = readResp.result.content[0].text;
      expect(text).not.toContain('[context]');
    });

    test('write command without state change has no context line', async () => {
      // Click something that doesn't cause navigation or title change
      // First go to forms page
      const gotoId = nextId();
      sendMessage({
        jsonrpc: '2.0',
        id: gotoId,
        method: 'tools/call',
        params: { name: 'browse_goto', arguments: { url: baseUrl + '/forms.html' } },
      });
      await waitForResponse(gotoId);

      // Fill a text field — no URL/title change expected
      const fillId = nextId();
      sendMessage({
        jsonrpc: '2.0',
        id: fillId,
        method: 'tools/call',
        params: { name: 'browse_fill', arguments: { selector: '#name', value: 'test' } },
      });
      const fillResp = await waitForResponse(fillId);
      expect(fillResp.result).toBeDefined();
      const text = fillResp.result.content[0].text;
      // Context may include settled signal even without URL/title change
      // Verify no URL or title change is reported
      expect(text).not.toContain('→ /');
      expect(text).not.toContain('title:');
    });
  });

  describe('Snapshot Context Levels in MCP', () => {
    test('set context delta changes MCP context level', async () => {
      const result = await callTool('browse_set', { subcommand: 'context', value: 'delta' });
      expect(result.content[0].text).toContain('delta');
      expect(result.isError).toBeFalsy();
    });

    test('write command in delta mode includes snapshot-delta after DOM change', async () => {
      // Navigate to dynamic fixture and take initial snapshot
      await callTool('browse_goto', { url: baseUrl + '/dynamic.html' });
      await callTool('browse_snapshot', { interactive: true });

      // Click "Add Item" button — adds a new button to the DOM
      const result = await callTool('browse_click', { selector: 'button:has-text("Add Item")' });
      const text = result.content[0].text;

      // Should include snapshot delta (context line only appears when page state changes)
      expect(text).toContain('[snapshot-delta]');
      // Delta should show added elements with refs
      expect(text).toMatch(/\+ @e\d+/);
    });

    test('set context full returns full snapshot after write', async () => {
      await callTool('browse_set', { subcommand: 'context', value: 'full' });
      await callTool('browse_goto', { url: baseUrl + '/basic.html' });

      // Click a link — should return full snapshot
      const snap = await callTool('browse_snapshot', { interactive: true });
      const refMatch = snap.content[0].text.match(/@e\d+/);
      expect(refMatch).toBeTruthy();

      const result = await callTool('browse_click', { selector: refMatch![0] });
      const text = result.content[0].text;
      expect(text).toContain('[snapshot]');
      expect(text).toMatch(/@e\d+/);
    });

    test('read command never includes snapshot context', async () => {
      // Context is still 'full' from previous test
      const result = await callTool('browse_text');
      const text = result.content[0].text;
      expect(text).not.toContain('[snapshot-delta]');
      expect(text).not.toContain('[snapshot]');
    });

    test('browse_snapshot (meta) does not include context', async () => {
      // Navigate to a page with content first
      await callTool('browse_goto', { url: baseUrl + '/basic.html' });
      const result = await callTool('browse_snapshot', { interactive: true });
      const text = result.content[0].text;
      // Snapshot is a meta command — should NOT have [context] or [snapshot-delta]
      expect(text).not.toContain('[context]');
      expect(text).not.toContain('[snapshot-delta]');
    });

    test('set context state restores default behavior', async () => {
      await callTool('browse_set', { subcommand: 'context', value: 'state' });
      await callTool('browse_goto', { url: baseUrl + '/basic.html' });

      // Navigate — should only have [context] line, no snapshot
      const result = await callTool('browse_goto', { url: baseUrl + '/forms.html' });
      const text = result.content[0].text;
      expect(text).toContain('[context]');
      expect(text).not.toContain('[snapshot-delta]');
      expect(text).not.toContain('[snapshot]');
    });
  });
});
