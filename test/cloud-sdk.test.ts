/**
 * Tests for the SDK types and transports.
 *
 * Validates BrowseSession structural contract, CloudTransport error handling,
 * and LocalTransport failure paths — all without needing a running server.
 */

import { describe, test, expect } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { BrowseSession, type Transport } from '../src/sdk/session';
import { BrowseClient } from '../src/sdk/client';
import { LocalTransport } from '../src/sdk/transports/local';
import { CloudTransport, CloudApiError } from '../src/sdk/transports/cloud';

// ─── SDK Types: BrowseSession ──────────────────────────────────

describe('SDK Types - BrowseSession', () => {
  test('BrowseSession has typed navigation methods', () => {
    // Structural check: BrowseSession prototype has the expected methods
    const proto = BrowseSession.prototype;
    expect(typeof proto.goto).toBe('function');
    expect(typeof proto.back).toBe('function');
    expect(typeof proto.forward).toBe('function');
    expect(typeof proto.reload).toBe('function');
  });

  test('BrowseSession has typed content extraction methods', () => {
    const proto = BrowseSession.prototype;
    expect(typeof proto.text).toBe('function');
    expect(typeof proto.html).toBe('function');
    expect(typeof proto.links).toBe('function');
    expect(typeof proto.forms).toBe('function');
    expect(typeof proto.snapshot).toBe('function');
    expect(typeof proto.accessibility).toBe('function');
  });

  test('BrowseSession has typed interaction methods', () => {
    const proto = BrowseSession.prototype;
    expect(typeof proto.click).toBe('function');
    expect(typeof proto.dblclick).toBe('function');
    expect(typeof proto.fill).toBe('function');
    expect(typeof proto.select).toBe('function');
    expect(typeof proto.hover).toBe('function');
    expect(typeof proto.focus).toBe('function');
    expect(typeof proto.check).toBe('function');
    expect(typeof proto.uncheck).toBe('function');
    expect(typeof proto.type).toBe('function');
    expect(typeof proto.press).toBe('function');
  });

  test('BrowseSession has typed meta methods', () => {
    const proto = BrowseSession.prototype;
    expect(typeof proto.screenshot).toBe('function');
    expect(typeof proto.pdf).toBe('function');
    expect(typeof proto.tabs).toBe('function');
    expect(typeof proto.tab).toBe('function');
    expect(typeof proto.newtab).toBe('function');
    expect(typeof proto.closetab).toBe('function');
    expect(typeof proto.url).toBe('function');
    expect(typeof proto.close).toBe('function');
  });

  test('BrowseSession delegates to transport.execute()', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const mockTransport: Transport = {
      execute: async (command, args) => {
        calls.push({ command, args });
        return `result:${command}`;
      },
      close: async () => {},
    };

    const session = new BrowseSession(mockTransport, 'test-session');

    const result = await session.goto('https://example.com');
    expect(result).toBe('result:goto');
    expect(calls[0]).toEqual({ command: 'goto', args: ['https://example.com'] });

    await session.click('#btn');
    expect(calls[1]).toEqual({ command: 'click', args: ['#btn'] });

    await session.fill('#input', 'hello');
    expect(calls[2]).toEqual({ command: 'fill', args: ['#input', 'hello'] });

    await session.text();
    expect(calls[3]).toEqual({ command: 'text', args: [] });
  });

  test('BrowseSession.snapshot passes flags correctly', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const mockTransport: Transport = {
      execute: async (command, args) => {
        calls.push({ command, args });
        return '';
      },
      close: async () => {},
    };

    const session = new BrowseSession(mockTransport);

    await session.snapshot({ interactive: true });
    expect(calls[0].args).toEqual(['-i']);

    await session.snapshot({ interactive: true, clickable: true, depth: 3, selector: '#main' });
    expect(calls[1].args).toEqual(['-i', '-C', '-d', '3', '-s', '#main']);

    await session.snapshot();
    expect(calls[2].args).toEqual([]);
  });

  test('BrowseSession stores sessionId', () => {
    const mockTransport: Transport = {
      execute: async () => '',
      close: async () => {},
    };

    const sessionWithId = new BrowseSession(mockTransport, 'my-session');
    expect(sessionWithId.sessionId).toBe('my-session');

    const sessionWithout = new BrowseSession(mockTransport);
    expect(sessionWithout.sessionId).toBeUndefined();
  });
});

// ─── SDK: BrowseClient ─────────────────────────────────────────

describe('SDK - BrowseClient', () => {
  test('connect requires both endpoint and apiKey for cloud transport', async () => {
    await expect(
      BrowseClient.connect({ endpoint: 'http://localhost:9999' }),
    ).rejects.toThrow('both endpoint and apiKey');

    await expect(
      BrowseClient.connect({ apiKey: 'brw_test' }),
    ).rejects.toThrow('both endpoint and apiKey');
  });

  test('connect with cloud params throws connection error when server is not running', async () => {
    // Use a port that is very unlikely to have anything running
    await expect(
      BrowseClient.connect({
        endpoint: 'http://127.0.0.1:19999',
        apiKey: 'brw_0000000000000000000000000000test',
        timeout: 2000,
      }),
    ).rejects.toThrow(/not reachable|connection refused|ECONNREFUSED/i);
  });
});

// ─── SDK: CloudTransport ───────────────────────────────────────

describe('SDK - CloudTransport', () => {
  test('constructor parses endpoint URL correctly', () => {
    const transport = new CloudTransport({
      endpoint: 'http://localhost:8400/',
      apiKey: 'brw_test',
    });
    expect(transport.sessionId).toBeUndefined();
  });

  test('connect throws connection error for unreachable server', async () => {
    const transport = new CloudTransport({
      endpoint: 'http://127.0.0.1:19998',
      apiKey: 'brw_0000000000000000000000000000dead',
      timeout: 2000,
    });

    await expect(transport.connect()).rejects.toThrow(/not reachable|connection refused/i);
  });

  test('execute without connect auto-connects (and fails for unreachable)', async () => {
    const transport = new CloudTransport({
      endpoint: 'http://127.0.0.1:19997',
      apiKey: 'brw_0000000000000000000000000000dead',
      timeout: 2000,
    });

    await expect(transport.execute('text', [])).rejects.toThrow(/not reachable|connection refused/i);
  });

  test('CloudApiError has statusCode property', () => {
    const err = new CloudApiError(403, 'Forbidden');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Forbidden');
    expect(err.name).toBe('CloudApiError');
    expect(err instanceof Error).toBe(true);
  });

  test('close resets state without throwing', async () => {
    const transport = new CloudTransport({
      endpoint: 'http://127.0.0.1:19996',
      apiKey: 'brw_test',
    });
    // close() is best-effort, should not throw even when never connected
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

// ─── SDK: LocalTransport ───────────────────────────────────────

describe('SDK - LocalTransport', () => {
  test('connect throws when state file does not exist', async () => {
    const nonExistentPath = path.join(os.tmpdir(), `nonexistent-state-${Date.now()}.json`);
    const transport = new LocalTransport({ stateFile: nonExistentPath });

    await expect(transport.connect()).rejects.toThrow(/not running|no state file/i);
  });

  test('connect throws for corrupt state file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-local-transport-test-'));
    const stateFile = path.join(tmpDir, 'browse-server.json');

    try {
      fs.writeFileSync(stateFile, 'not valid JSON!!!');
      const transport = new LocalTransport({ stateFile });
      await expect(transport.connect()).rejects.toThrow(/corrupt/i);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('connect throws for state file missing port or token', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-local-transport-test-'));
    const stateFile = path.join(tmpDir, 'browse-server.json');

    try {
      fs.writeFileSync(stateFile, JSON.stringify({ pid: 1234 }));
      const transport = new LocalTransport({ stateFile });
      await expect(transport.connect()).rejects.toThrow(/missing port or token/i);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('execute throws ECONNREFUSED when server is not actually running', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-local-transport-test-'));
    const stateFile = path.join(tmpDir, 'browse-server.json');

    try {
      // Valid state file pointing to a port with nothing listening
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          pid: 999999,
          port: 19995,
          token: 'test-token-abc',
          startedAt: new Date().toISOString(),
          serverPath: '/dev/null',
        }),
      );

      const transport = new LocalTransport({ stateFile, timeout: 2000 });
      await transport.connect();
      await expect(transport.execute('text', [])).rejects.toThrow(/not reachable|connection refused/i);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('close resets connected state', async () => {
    const transport = new LocalTransport({});
    // close() should not throw even when never connected
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
