/**
 * Tiny HTTP server for test fixtures
 * Serves HTML files from test/fixtures/ on a random available port
 */

import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { fileURLToPath } from 'url';

const __dirname_test = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname_test, 'fixtures');

export async function startTestServer(port: number = 0): Promise<{ server: http.Server; url: string; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1`);

    // POST /api/echo — returns request body as JSON response
    if (url.pathname === '/api/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echo: body, method: req.method }));
      });
      return;
    }

    // GET /api/data — returns known JSON payload
    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [1, 2, 3], total: 3 }));
      return;
    }

    // GET /api/binary — returns binary response
    if (url.pathname === '/api/binary') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
      return;
    }

    // Special route: downloadable file with Content-Disposition
    if (url.pathname === '/download/test.txt') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="test.txt"',
      });
      res.end('test file content');
      return;
    }

    let filePath = url.pathname === '/' ? '/basic.html' : url.pathname;
    filePath = filePath.replace(/^\//, '');
    const fullPath = path.join(FIXTURES_DIR, filePath);

    if (!fs.existsSync(fullPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const ext = path.extname(fullPath);
    const contentType = ext === '.html' ? 'text/html' : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });

  const assignedPort = await new Promise<number>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
    server.on('error', reject);
  });

  const serverUrl = `http://127.0.0.1:${assignedPort}`;
  return { server, url: serverUrl, port: assignedPort };
}
