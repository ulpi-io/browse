/**
 * Integration tests for v1.5 features
 *
 * Covers:
 *   - Network body capture (request/response headers + bodies)
 *   - request command (index lookup, URL pattern, error cases)
 *   - api command (GET, POST, session cookies)
 *   - Guarded writes (--if-exists, --if-empty, --if-unchecked)
 *   - HAR with bodies
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { formatAsHar } from '../src/network/har';
import * as fs from 'fs';

// ─── Network body capture ──────────────────────────────────────

describe('Network body capture', () => {
  beforeAll(async () => {
    bm.setCaptureNetworkBodies(true);
  });

  afterAll(() => {
    bm.setCaptureNetworkBodies(false);
  });

  test('POST request body captured', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    // Clear the network buffer so we only see the fetch request
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
    }, baseUrl);

    // Wait for requestfinished event to populate body
    await new Promise(resolve => setTimeout(resolve, 500));

    const nb = buffers.networkBuffer;
    const postEntry = nb.find(e => e.url.includes('/api/echo') && e.method === 'POST');
    expect(postEntry).toBeDefined();
    expect(postEntry!.requestBody).toContain('"hello"');
    expect(postEntry!.requestBody).toContain('"world"');
  });

  test('GET response body captured', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/data');
    }, baseUrl);

    await new Promise(resolve => setTimeout(resolve, 500));

    const nb = buffers.networkBuffer;
    const getEntry = nb.find(e => e.url.includes('/api/data'));
    expect(getEntry).toBeDefined();
    expect(getEntry!.responseBody).toBeDefined();
    expect(getEntry!.responseBody).toContain('"items"');
    expect(getEntry!.responseBody).toContain('"total":3');
  });

  test('Binary response stored as [binary N bytes]', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/binary');
    }, baseUrl);

    await new Promise(resolve => setTimeout(resolve, 500));

    const nb = buffers.networkBuffer;
    const binEntry = nb.find(e => e.url.includes('/api/binary'));
    expect(binEntry).toBeDefined();
    expect(binEntry!.responseBody).toMatch(/^\[binary \d+ bytes\]$/);
  });

  test('Body truncation', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    // Post a large body (300KB) — the response is JSON (text), so response body will be captured
    // The request body itself is the large one
    await bm.getPage().evaluate(async (url: string) => {
      const largeBody = 'x'.repeat(300 * 1024);
      await fetch(url + '/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: largeBody }),
      });
    }, baseUrl);

    await new Promise(resolve => setTimeout(resolve, 500));

    const nb = buffers.networkBuffer;
    const entry = nb.find(e => e.url.includes('/api/echo') && e.method === 'POST');
    expect(entry).toBeDefined();
    // The response body should be truncated since the echo endpoint returns the body as JSON
    // and 300KB+ of JSON will exceed the default 256KB body limit
    expect(entry!.responseBody).toContain('...(truncated at');
  });

  test('Request headers captured', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'test-value' },
        body: '{"a":1}',
      });
    }, baseUrl);

    await new Promise(resolve => setTimeout(resolve, 500));

    const nb = buffers.networkBuffer;
    const entry = nb.find(e => e.url.includes('/api/echo') && e.method === 'POST');
    expect(entry).toBeDefined();
    expect(entry!.requestHeaders).toBeDefined();
    expect(entry!.requestHeaders!['content-type']).toBe('application/json');
    expect(entry!.requestHeaders!['x-custom']).toBe('test-value');
  });
});

// ─── request command ──────────────────────────────────────────

describe('request command', () => {
  test('request by index', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    // Enable body capture for request command tests
    bm.setCaptureNetworkBodies(true);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleReadCommand('request', ['0'], bm);
    // First entry should be the navigation to basic.html
    expect(result).toContain('GET');
    expect(result).toContain('/basic.html');
    bm.setCaptureNetworkBodies(false);
  });

  test('request by URL pattern', async () => {
    bm.setCaptureNetworkBodies(true);
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleReadCommand('request', ['basic.html'], bm);
    expect(result).toContain('GET');
    expect(result).toContain('basic.html');
    bm.setCaptureNetworkBodies(false);
  });

  test('request with no entries', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    const result = await handleReadCommand('request', ['0'], bm);
    expect(result).toContain('No network entries');
  });

  test('request index out of range', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleReadCommand('request', ['999'], bm);
    expect(result).toContain('No request at index 999');
    expect(result).toContain('Buffer has');
  });

  test('request no match', async () => {
    const buffers = bm.getBuffers();
    buffers.networkBuffer.length = 0;

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await handleReadCommand('request', ['nonexistent-url-pattern'], bm);
    expect(result).toContain("No request matching 'nonexistent-url-pattern'");
    expect(result).toContain('Recent:');
  });
});

// ─── api command ──────────────────────────────────────────────

describe('api command', () => {
  const shutdown = async () => {};

  test('api GET returns JSON', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const result = await handleMetaCommand('api', ['GET', baseUrl + '/api/data'], bm, shutdown);
    expect(result).toContain('200');
    expect(result).toContain('"items"');
    expect(result).toContain('"total": 3');
  });

  test('api POST with body', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    const result = await handleMetaCommand('api', [
      'POST', baseUrl + '/api/echo',
      '--body', '{"test":1}',
    ], bm, shutdown);
    expect(result).toContain('200');
    expect(result).toContain('"echo"');
    // The echo endpoint returns the body as a string value, so it's escaped in JSON
    expect(result).toContain('test');
  });

  test('api with session cookies', async () => {
    // Set a cookie first
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await handleWriteCommand('cookie', ['testcookie=testvalue'], bm);

    // The api command runs fetch in the page context, which includes cookies
    const result = await handleMetaCommand('api', ['GET', baseUrl + '/api/data'], bm, shutdown);
    expect(result).toContain('200');
    // Verify the request succeeded (cookies are sent automatically by fetch within same origin)
    expect(result).toContain('"items"');
  });
});

// ─── Guarded writes ───────────────────────────────────────────

describe('Guarded writes', () => {
  test('click --if-exists skips missing element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('click', ['#nonexistent-element', '--if-exists'], bm);
    expect(result).toContain('SKIP');
    expect(result).toContain('element not found');
  });

  test('fill --if-empty skips non-empty field', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // The #value-input has value="prefilled"
    const result = await handleWriteCommand('fill', ['#value-input', 'new-value', '--if-empty'], bm);
    expect(result).toContain('SKIP');
    expect(result).toContain('already has value');
    expect(result).toContain('prefilled');
  });

  test('fill --if-empty fills empty field', async () => {
    await handleWriteCommand('goto', [baseUrl + '/forms.html'], bm);
    // The #email input is empty by default
    const result = await handleWriteCommand('fill', ['#email', 'test@example.com', '--if-empty'], bm);
    expect(result).toContain('Filled');
    expect(result).not.toContain('SKIP');
  });

  test('check --if-unchecked skips checked checkbox', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // First check the checkbox
    await handleWriteCommand('check', ['#cb1'], bm);
    // Now try to check it with --if-unchecked — should skip
    const result = await handleWriteCommand('check', ['#cb1', '--if-unchecked'], bm);
    expect(result).toContain('SKIP');
    expect(result).toContain('already checked');
  });

  test('check --if-unchecked checks unchecked checkbox', async () => {
    await handleWriteCommand('goto', [baseUrl + '/interactions.html'], bm);
    // The #cb1 starts unchecked
    const result = await handleWriteCommand('check', ['#cb1', '--if-unchecked'], bm);
    expect(result).toContain('Checked');
    expect(result).not.toContain('SKIP');
  });

  test('hover --if-exists skips missing element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('hover', ['#does-not-exist', '--if-exists'], bm);
    expect(result).toContain('SKIP');
    expect(result).toContain('element not found');
  });

  test('focus --if-exists skips missing element', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleWriteCommand('focus', ['#does-not-exist', '--if-exists'], bm);
    expect(result).toContain('SKIP');
    expect(result).toContain('element not found');
  });
});

// ─── HAR with bodies ──────────────────────────────────────────

describe('HAR with bodies', () => {
  test('HAR includes request and response bodies when captured', async () => {
    bm.setCaptureNetworkBodies(true);

    // Start HAR recording
    const shutdown = async () => {};
    await handleMetaCommand('har', ['start'], bm, shutdown);

    // Navigate and make a POST request
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    await bm.getPage().evaluate(async (url: string) => {
      await fetch(url + '/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ har: 'test' }),
      });
    }, baseUrl);

    // Wait for response bodies to be captured
    await new Promise(resolve => setTimeout(resolve, 500));

    // Stop HAR and write to file
    const harPath = '/tmp/browse-v15-har-test.har';
    const result = await handleMetaCommand('har', ['stop', harPath], bm, shutdown);
    expect(result).toContain('HAR saved');

    // Parse and verify HAR content
    const har = JSON.parse(fs.readFileSync(harPath, 'utf-8'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries.length).toBeGreaterThan(0);

    // Find the POST entry
    const postEntry = har.log.entries.find(
      (e: any) => e.request.method === 'POST' && e.request.url.includes('/api/echo')
    );
    expect(postEntry).toBeDefined();

    // Verify request body in HAR (postData.text)
    expect(postEntry.request.postData).toBeDefined();
    expect(postEntry.request.postData.text).toContain('"har"');
    expect(postEntry.request.postData.text).toContain('"test"');

    // Verify response body in HAR (response.content.text)
    expect(postEntry.response.content.text).toBeDefined();
    expect(postEntry.response.content.text).toContain('"echo"');

    // Clean up
    fs.unlinkSync(harPath);
    bm.setCaptureNetworkBodies(false);
  });

  test('HAR entries without body capture have no postData/content.text', () => {
    // Simulate entries without bodies (body capture off)
    const entries = [
      { timestamp: 1000, method: 'POST', url: 'https://example.com/api', status: 201, duration: 80, size: 100 },
    ];

    const har = formatAsHar(entries, 500) as any;
    const entry = har.log.entries[0];
    expect(entry.request.postData).toBeUndefined();
    expect(entry.response.content.text).toBeUndefined();
  });
});
